// SPEC #78 stage A: offline verified-news contract, window/timezone, and evidence classification.
//
// This module is deliberately pure and network-free: it normalises the `news_mode` input union, the
// verified-only control parameters, the rolling_24h / calendar_today windows (with an injected clock)
// and the publisher/feed evidence verdicts. Nothing here performs I/O, reads a page, or touches
// SearXNG, feeds, GDELT, the shared proxy or an SSRF path — stage C wires these pure functions into
// the MCP/search layers.
//
// Trust model (the point of this module): only a publisher-declared page date (page meta / JSON-LD /
// article time) or a controlled feed *item* date (Atom `published`, RSS `pubDate`) may ever become
// `verified`. SearXNG result dates, URL date patterns, HTTP `Date`/`Last-Modified`, `retrieved_at`,
// a page's "today" text, GDELT times, feed-level `lastBuildDate`/`updated` freshness and
// timezone-less times are discovery hints only and can never generate `verified`.

const DAY_MS = 86_400_000;
// Asia/Kuala_Lumpur has been a fixed UTC+08:00 offset with no DST since 1982, so the civil day
// boundary is a constant offset and needs no timezone database.
const KL_OFFSET_MS = 8 * 3_600_000;

export const NEWS_MODES = ['off', 'ranked', 'verified'];
export const NEWS_SOURCES = ['searxng', 'feeds', 'gdelt', 'hybrid'];
export const NEWS_WINDOWS = ['rolling_24h', 'calendar_today'];
export const NEWS_RENDERS = ['never', 'auto'];

export const VERIFIED_DEFAULTS = Object.freeze({
  news_source: 'searxng',
  news_window: 'rolling_24h',
  news_min_sources: 2,
  news_max_reads: 6,
  news_render: 'never',
});

// Verified-only control fields. `news_mode` is the mode selector itself; these five are the controls
// the SPEC restricts to the verified branch and that must never reach the SearXNG query string.
export const VERIFIED_CONTROL_FIELDS = Object.freeze([
  'news_source',
  'news_window',
  'news_min_sources',
  'news_max_reads',
  'news_render',
]);

// Evidence source kinds that may become `verified`.
export const VERIFIED_SOURCE_KINDS = Object.freeze(['page_publisher', 'feed_item']);
// Everything else: discovery / diagnostic only. Kept as an explicit, named set so the negative case
// (\"this must never verify\") is data, not a comment.
export const DISCOVERY_SOURCE_KINDS = Object.freeze([
  'searxng',
  'url_pattern',
  'http_date',
  'retrieved_at',
  'page_today',
  'gdelt',
  'feed_freshness',
  'none',
  'unknown',
]);

function contractError(message, kind, extra = {}) {
  const error = new Error(message);
  error.kind = kind;
  Object.assign(error, extra);
  return error;
}

function toMillis(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const parsed = Date.parse(String(now));
  return Number.isFinite(parsed) ? parsed : NaN;
}

// ---------------------------------------------------------------------------------------------
// 1. news_mode input union -> normalised `off | ranked | verified`
// ---------------------------------------------------------------------------------------------

// Accepts the SPEC's input union (`false | true | "ranked" | "verified"`, plus the already-normalised
// `"off"`) and rejects every other value. `true` is the legacy boolean; it maps onto `ranked` so the
// old ranking behaviour is preserved byte-for-byte. Unknown values (or non boolean/string types) are
// rejected here rather than silently defaulted.
export function normalizeNewsMode(value) {
  if (value === undefined || value === null || value === false || value === 'off') return 'off';
  if (value === true || value === 'ranked') return 'ranked';
  if (value === 'verified') return 'verified';
  throw contractError(`Unsupported news_mode value: ${JSON.stringify(value)}`, 'invalid_news_mode', { value });
}

export function isVerifiedMode(mode) {
  return mode === 'verified';
}

function pickEnum(value, allowed, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw contractError(`Invalid ${field}: ${JSON.stringify(value)} (allowed: ${allowed.join(', ')})`, 'invalid_news_param', { field, value });
  }
  return value;
}

function pickInt(value, min, max, field, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw contractError(`Invalid ${field}: ${JSON.stringify(value)} (integer ${min}..${max})`, 'invalid_news_param', { field, value });
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// 2. verified-only parameter whitelist / boundary validation
// ---------------------------------------------------------------------------------------------

// Validates and fills the verified-only controls. Rejects out-of-range / unknown values instead of
// coercing them, so stage C can fail closed at the MCP boundary. Returns a fresh object (never
// mutates the caller's input).
export function normalizeVerifiedParams(input = {}) {
  return {
    news_source: pickEnum(input.news_source, NEWS_SOURCES, 'news_source', VERIFIED_DEFAULTS.news_source),
    news_window: pickEnum(input.news_window, NEWS_WINDOWS, 'news_window', VERIFIED_DEFAULTS.news_window),
    news_min_sources: pickInt(input.news_min_sources, 1, 4, 'news_min_sources', VERIFIED_DEFAULTS.news_min_sources),
    news_max_reads: pickInt(input.news_max_reads, 0, 8, 'news_max_reads', VERIFIED_DEFAULTS.news_max_reads),
    news_render: pickEnum(input.news_render, NEWS_RENDERS, 'news_render', VERIFIED_DEFAULTS.news_render),
  };
}

// Full control resolution for one search call. `off`/`ranked` return no verified params and list any
// verified control the caller supplied under `ignored_controls`, so those fields are ignored (and,
// in stage C, never forwarded) rather than accepted.
export function resolveNewsControls(input = {}) {
  const mode = normalizeNewsMode(input.news_mode);
  if (mode === 'verified') return { mode, params: normalizeVerifiedParams(input), ignored_controls: [] };
  const ignored = VERIFIED_CONTROL_FIELDS.filter(field => input[field] !== undefined && input[field] !== null);
  return { mode, params: null, ignored_controls: ignored };
}

// ---------------------------------------------------------------------------------------------
// 3. window + timezone resolution (injected clock)
// ---------------------------------------------------------------------------------------------

// Resolves the verified window from an injected clock (ms, Date or ISO string). rolling_24h is
// evaluated on a UTC baseline; calendar_today uses the fixed Asia/Kuala_Lumpur civil day. The
// returned `window_date` is the calendar date used for day-precision comparisons in calendar_today.
export function resolveNewsWindow({ window = 'rolling_24h', now = Date.now() } = {}) {
  const mode = pickEnum(window, NEWS_WINDOWS, 'news_window', VERIFIED_DEFAULTS.news_window);
  const nowMs = toMillis(now);
  if (!Number.isFinite(nowMs)) throw contractError(`Invalid clock: ${String(now)}`, 'invalid_clock', { now });
  const evaluated_at = new Date(nowMs).toISOString();
  if (mode === 'rolling_24h') {
    return {
      window: mode,
      window_timezone: 'UTC',
      evaluated_at,
      start: new Date(nowMs - DAY_MS).toISOString(),
      end: evaluated_at,
      window_date: null,
    };
  }
  const localMs = nowMs + KL_OFFSET_MS;
  const dayStartLocal = Math.floor(localMs / DAY_MS) * DAY_MS;
  return {
    window: mode,
    window_timezone: 'Asia/Kuala_Lumpur',
    evaluated_at,
    start: new Date(dayStartLocal - KL_OFFSET_MS).toISOString(),
    end: evaluated_at,
    window_date: new Date(dayStartLocal).toISOString().slice(0, 10),
  };
}

// ---------------------------------------------------------------------------------------------
// 4. evidence source classification and aggregation
// ---------------------------------------------------------------------------------------------

// Maps a raw temporal `source` label (as produced by extractPageEvidence / the feed parser) onto a
// source kind. Only `html.*` page sources and `feed.item.*` sources are publisher-item evidence.
export function sourceKindFromRaw(source) {
  const raw = String(source ?? '');
  if (/^html\./i.test(raw)) return 'page_publisher';
  if (/^feed\.item\./i.test(raw)) return 'feed_item';
  if (/^feed\./i.test(raw)) return 'feed_freshness';
  if (/^searxng\./i.test(raw)) return 'searxng';
  if (/^url\./i.test(raw)) return 'url_pattern';
  if (/^gateway\.clock$/i.test(raw)) return 'retrieved_at';
  if (/^http\.header\./i.test(raw)) return 'http_date';
  if (/^gdelt/i.test(raw)) return 'gdelt';
  return 'unknown';
}

// Resolves a raw temporal record (or an explicit source_kind) to `{ source_kind, verified_eligible }`.
export function classifyEvidenceSource(record = {}) {
  const sourceKind = record.source_kind ?? sourceKindFromRaw(record.source);
  return { source_kind: sourceKind, verified_eligible: VERIFIED_SOURCE_KINDS.includes(sourceKind) };
}

// The freshness verdict for one *eligible* evidence record. Non-eligible kinds, timezone-less and
// month-only precisions, and future timestamps are always `unknown`; a proven-before-the-window date
// is `stale`. Only a publisher/feed item date inside the window is `verified`.
export function classifyVerifiedWindow(evidence = {}, window = {}) {
  const { source_kind: sourceKind, precision } = evidence;
  if (!VERIFIED_SOURCE_KINDS.includes(sourceKind)) return 'unknown';
  const evaluated = Date.parse(window.evaluated_at);
  const startMs = Date.parse(window.start);
  if (!Number.isFinite(evaluated) || !Number.isFinite(startMs)) return 'unknown';

  if (window.window === 'rolling_24h') {
    if (precision !== 'instant' || !evidence.value) return 'unknown';
    const ms = Date.parse(evidence.value);
    if (!Number.isFinite(ms) || ms > evaluated) return 'unknown';
    return ms >= startMs ? 'verified' : 'stale';
  }
  if (window.window === 'calendar_today') {
    if (precision === 'instant' && evidence.value) {
      const ms = Date.parse(evidence.value);
      if (!Number.isFinite(ms) || ms > evaluated) return 'unknown';
      return ms >= startMs ? 'verified' : 'stale';
    }
    // calendar_today may accept day precision, but a day never becomes a fabricated instant.
    if (precision === 'day' && evidence.on && window.window_date) {
      if (evidence.on > window.window_date) return 'unknown';
      return evidence.on === window.window_date ? 'verified' : 'stale';
    }
    return 'unknown';
  }
  return 'unknown';
}

// Builds the per-result `news_evidence` object. Only a verified-eligible source (page publisher or
// feed item) may populate `published_at`/`published_on`/`precision`; a discovery-only source
// (SearXNG / URL date / HTTP Date / retrieved_at / GDELT) leaves them null and always resolves to
// `unknown`, so a consumer reading `news_evidence.published_at` can never mistake a non-publisher
// time for a publication. The schema fields are always present (nullable).
export function evaluateResultEvidence(record = {}, window = {}, { checked_at = null } = {}) {
  const { source_kind: sourceKind, verified_eligible } = classifyEvidenceSource(record);
  const hasDate = Boolean(record.value || record.on);
  let status = 'unknown';
  if (hasDate && verified_eligible) {
    status = classifyVerifiedWindow({ ...record, source_kind: sourceKind }, window);
  }
  return {
    status,
    source_kind: sourceKind,
    source: record.source ?? null,
    verified_eligible,
    published_at: verified_eligible ? record.value ?? null : null,
    published_on: verified_eligible ? record.on ?? null : null,
    precision: verified_eligible ? record.precision ?? null : null,
    evidence_url: record.evidence_url ?? null,
    checked_at,
    conflict_count: Number.isInteger(record.conflict_count) ? record.conflict_count : 0,
  };
}

// Aggregates a page's publisher evidence (the output shape of extractPageEvidence) into a raw
// evidence record. Response `Date`, `Last-Modified`, `retrieved_at` and the search-result's own URL
// date are ignored: only an `html.*` declared date counts. A page with no publisher date yields
// `source_kind: 'none'`. Pass the result to `evaluateResultEvidence` with the resolved window to get
// the final `news_evidence`.
export function aggregatePublisherEvidence(pageEvidence = {}, { url = null } = {}) {
  const temporal = Array.isArray(pageEvidence?.temporal_evidence) ? pageEvidence.temporal_evidence : [];
  const record = temporal.find(item => item?.kind === 'published_at' && /^html\./i.test(String(item?.source)) && (item.value || item.on)) ?? null;
  const conflicts = Array.isArray(pageEvidence?.conflicts) ? pageEvidence.conflicts.length : 0;
  return {
    source_kind: record ? 'page_publisher' : 'none',
    source: record?.source ?? null,
    value: record?.value ?? null,
    on: record?.on ?? null,
    precision: record?.precision ?? null,
    evidence_url: pageEvidence?.source?.url ?? url ?? null,
    conflict_count: conflicts,
  };
}

// Turns one parsed feed item (see news-feed.mjs) into a raw evidence record. Only the item-level
// `published` field is publication evidence; `updated` is a modification, never a publication date.
export function feedItemEvidence(item = {}) {
  const published = item?.published ?? null;
  return {
    source_kind: published ? 'feed_item' : 'none',
    source: published?.source ?? null,
    value: published?.value ?? null,
    on: published?.on ?? null,
    precision: published?.precision ?? null,
    evidence_url: item?.link ?? null,
    conflict_count: Number.isInteger(item?.conflicts) ? item.conflicts : 0,
  };
}

// ---------------------------------------------------------------------------------------------
// 5. aggregate verified status (verified / partial / no_verified_result)
// ---------------------------------------------------------------------------------------------

function publisherKey(evidence = {}) {
  const raw = String(evidence?.evidence_url ?? '');
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Counts the per-result verdicts and applies the two-part threshold. `distinct_publishers` is
// counted by the *evidence* host (site identity), never by search engine or feed count, so several
// articles from one publisher cannot manufacture source breadth. Zero verified results are
// `no_verified_result`; some-but-below-threshold is `partial`; the threshold is never relaxed.
export function evaluateVerifiedStatus(results = [], { min_sources = VERIFIED_DEFAULTS.news_min_sources } = {}) {
  const list = Array.isArray(results) ? results : [];
  const threshold = Number.isInteger(min_sources) ? min_sources : VERIFIED_DEFAULTS.news_min_sources;
  const counts = { verified: 0, stale: 0, unknown: 0, unread: 0, read_failure: 0, irrelevant: 0 };
  const publishers = new Set();
  for (const item of list) {
    const evidence = item?.news_evidence ?? item ?? {};
    const status = evidence.status;
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
    if (status === 'verified') {
      const key = publisherKey(evidence);
      if (key) publishers.add(key);
    }
  }
  const verified_count = counts.verified;
  const distinct_publishers = publishers.size;
  const status = verified_count === 0
    ? 'no_verified_result'
    : verified_count >= threshold && distinct_publishers >= threshold
      ? 'verified'
      : 'partial';
  return {
    status,
    candidate_count: list.length,
    verified_count,
    distinct_publishers,
    min_sources: threshold,
    counts,
  };
}
