// SPEC #78 stage D: fixed-origin GDELT discovery — candidate recall only.
//
// GDELT is a *discovery* source, never an evidence source. It proposes candidate article URLs that
// still have to be read and page-verified before anything may become `verified` (see the trust model
// in news-verified.mjs, which classifies every `gdelt*` source as discovery-only). Two properties
// are therefore non-negotiable here and encoded as code, not comments:
//
//   1. The request target is fixed. The origin, path, mode, format and sort are module constants; no
//      caller can supply an endpoint, host, scheme or extra request parameter, so this module cannot
//      be pointed at an arbitrary origin. Callers may only influence the search `query`, a bounded
//      `maxrecords`, and a `timespan` preselection hint derived from the resolved window.
//   2. The GDELT `seendate` is used only to preselect/order the candidate list. It is returned as a
//      separate `seen_at` discovery field and is never promoted to publication evidence; the page
//      reader decides that later.
//
// The transport is injected (the gateway passes its SSRF-checked `fetchPublic`), so this module
// performs no I/O of its own and is exercised offline against fixed fixtures.

export const GDELT_SOURCE = 'gdelt';
export const GDELT_ORIGIN = 'https://api.gdeltproject.org';
export const GDELT_PATH = '/api/v2/doc/doc';
export const GDELT_MODE = 'artlist';
export const GDELT_FORMAT = 'json';
export const GDELT_SORT = 'datedesc';

export const GDELT_LIMITS = Object.freeze({
  maxRecordsCap: 250,
  defaultMaxRecords: 25,
  maxQueryChars: 256,
  maxBytes: 2 * 1024 * 1024,
  // GDELT is frequently slow (tens of seconds under load), so the in-band deadline is a bounded
  // fraction of the search budget: a slow GDELT fails closed as a `timeout` source_failure and never
  // stalls the recall path. The opt-in live sample below uses a longer deadline.
  timeoutMs: 8000,
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function httpUrl(value) {
  try {
    const url = new URL(text(value));
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function boundRecords(value) {
  if (!Number.isInteger(value) || value <= 0) return GDELT_LIMITS.defaultMaxRecords;
  return Math.min(value, GDELT_LIMITS.maxRecordsCap);
}

// GDELT caps a free-text query at ~250 characters; collapse whitespace and hard-truncate so an
// overlong caller query cannot grow the request or smuggle extra syntax past the bound.
function boundQuery(query) {
  return text(query).replace(/\s+/g, ' ').slice(0, GDELT_LIMITS.maxQueryChars);
}

// The fixed request URL. Origin/path/mode/format/sort are constants; only the query, a bounded
// `maxrecords` and an optional `timespan` hint vary. Built manually so the query is percent-encoded
// as `%20` (GDELT does not accept a form-encoded `+` for spaces).
export function buildGdeltUrl({ query, maxRecords, timespan } = {}) {
  const records = boundRecords(maxRecords);
  const hint = typeof timespan === 'string' && /^\d{1,3}(?:h|d)$/.test(timespan) ? timespan : '';
  return `${GDELT_ORIGIN}${GDELT_PATH}?query=${encodeURIComponent(boundQuery(query))}&mode=${GDELT_MODE}&format=${GDELT_FORMAT}&sort=${GDELT_SORT}&maxrecords=${records}${hint ? `&timespan=${hint}` : ''}`;
}

// Preselection hint for the window, in GDELT's `<n>h` / `<n>d` form. Deriving it from the resolved
// window keeps GDELT time a *prefilter* only: the window check that actually matters still runs on
// the page-declared date after the page is read.
export function gdeltTimespan(window) {
  const start = Date.parse(window?.start ?? '');
  const end = Date.parse(window?.end ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const hours = Math.max(1, Math.ceil((end - start) / 3_600_000));
  return hours <= 168 ? `${hours}h` : `${Math.ceil(hours / 24)}d`;
}

// GDELT `seendate` is compact UTC, e.g. `20261010T020000Z`. It is a discovery timestamp: returned as
// `seen_at` for ordering/preselection and never as a publication date.
export function gdeltSeenInstant(value) {
  const raw = text(value);
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(raw);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Parses the GDELT DOC JSON envelope into raw candidate records. Malformed JSON, a non-array
// `articles` field and an over-budget payload are reported as failures rather than an empty success.
// Non-HTTP article URLs are dropped (never echoed into a candidate that a reader might then fetch).
export function parseGdeltResponse(body) {
  const raw = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : '';
  if (Buffer.byteLength(raw, 'utf8') > GDELT_LIMITS.maxBytes) return { ok: false, code: 'payload_limit', candidates: [] };
  if (raw.trim() === '') return { ok: false, code: 'invalid_response', candidates: [] };
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'invalid_response', candidates: [] };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, code: 'invalid_response', candidates: [] };
  if ('articles' in payload && !Array.isArray(payload.articles)) return { ok: false, code: 'invalid_response', candidates: [] };

  const seen = new Set();
  const candidates = [];
  for (const article of Array.isArray(payload.articles) ? payload.articles : []) {
    const url = httpUrl(article?.url);
    if (!url) continue;
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const seenAt = gdeltSeenInstant(article?.seendate);
    candidates.push({
      url: url.href,
      title: text(article?.title) || null,
      domain: text(article?.domain).toLowerCase() || url.hostname.toLowerCase(),
      seen_at: seenAt,
      seen_on: seenAt ? seenAt.slice(0, 10) : null,
    });
  }
  return { ok: true, code: null, candidates };
}

// Preselection: drop candidates GDELT itself dated before the window start and order the rest
// newest-first. A candidate with an unparseable/absent `seendate` is kept (we have no proof it is
// old, and the page reader is still the authority); ordering is stable for equal/missing dates.
export function preselectGdeltCandidates(candidates, window) {
  const start = Date.parse(window?.start ?? '');
  const list = Array.isArray(candidates) ? candidates : [];
  const kept = list.filter(candidate => {
    if (!Number.isFinite(start)) return true;
    const seen = Date.parse(candidate?.seen_at ?? '');
    return !Number.isFinite(seen) || seen >= start;
  });
  return kept
    .map((candidate, index) => ({ candidate, index }))
    .sort((a, b) => (Date.parse(b.candidate?.seen_at ?? '') || 0) - (Date.parse(a.candidate?.seen_at ?? '') || 0) || a.index - b.index)
    .map(item => item.candidate);
}

function sourceFailure(code) {
  return { source: GDELT_SOURCE, code, retryable: false };
}

// Maps a transport error to a bounded, token-shaped GDELT source-failure code. The upstream message
// and URL are never echoed: only a known kind becomes a code, everything else is `gdelt_unavailable`.
function classifyTransportError(error) {
  const name = text(error?.name);
  if (name === 'AbortError' || name === 'TimeoutError') return 'timeout';
  switch (text(error?.kind)) {
    case 'ssrf_blocked': return 'ssrf_blocked';
    case 'dns_error': return 'dns_failed';
    case 'redirect_limit': return 'redirect_blocked';
    case 'egress_timeout':
    case 'upstream_timeout': return 'timeout';
    case 'response_too_large': return 'payload_limit';
    case 'upstream_http_status': return error?.httpStatus === 429 ? 'rate_limited' : 'http_error';
    default: return 'gdelt_unavailable';
  }
}

// One discovery round. Returns `{ ok: true, candidates }` or `{ ok: false, source_failure }`; it never
// throws, so a GDELT outage is a single, separate `source_failure` entry the caller can record
// without disturbing the recall path. `transport(url, { signal })` must resolve to
// `{ status, body }` (body Buffer or string) or throw; the gateway passes its SSRF-checked fetch.
export async function discoverGdeltCandidates({ query, maxRecords, window, transport, signal, timeoutMs = GDELT_LIMITS.timeoutMs } = {}) {
  if (typeof transport !== 'function') return { ok: false, source_failure: sourceFailure('gdelt_unavailable') };
  if (boundQuery(query) === '') return { ok: false, source_failure: sourceFailure('invalid_query') };

  const url = buildGdeltUrl({ query, maxRecords, timespan: gdeltTimespan(window) });
  const budget = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : GDELT_LIMITS.timeoutMs;
  const timeout = AbortSignal.timeout(budget);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response;
  try {
    response = await transport(url, { signal: combined });
  } catch (error) {
    return { ok: false, source_failure: sourceFailure(classifyTransportError(error)) };
  }
  const status = Number.isInteger(response?.status) ? response.status : null;
  if (status !== null && (status < 200 || status >= 300)) {
    return { ok: false, source_failure: sourceFailure(status === 429 ? 'rate_limited' : 'http_error') };
  }
  const parsed = parseGdeltResponse(response?.body);
  if (!parsed.ok) return { ok: false, source_failure: sourceFailure(parsed.code) };
  return { ok: true, candidates: preselectGdeltCandidates(parsed.candidates, window) };
}
