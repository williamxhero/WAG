import { JSDOM } from 'jsdom';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function timestamp(value) {
  let raw = text(value);
  if (!raw) return null;
  const compact = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z|[+-]\d{2}:?\d{2})$/i.exec(raw);
  if (compact) {
    const [, year, month, day, hour, minute, second = '00'] = compact;
    const zone = compact[7].toUpperCase() === 'Z' ? 'Z' : compact[7].replace(/([+-]\d{2}):?(\d{2})/, '$1:$2');
    raw = `${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`;
  }
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) && !/\b(?:GMT|UTC)\b/i.test(raw)) return null;
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

// A civil (calendar) date, optionally month-only, valid in the proleptic Gregorian calendar.
function civilDate(value) {
  const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, day == null ? 1 : Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1) return null;
  if (day != null && date.getUTCDate() !== Number(day)) return null;
  return value;
}

// A declared publisher time. `precision` is the granularity the publisher gave: `instant` (a
// timezone-bearing moment, carried in `value`), `day`, `month`, or `unknown-timezone` (a
// time-of-day with no offset — the civil date is real but the exact UTC moment is not, so `value`
// stays null and it can never be promoted to a verified instant). Month support and unanchored
// support are opt-in so the search-result path keeps its previous behaviour.
function temporalValue(value, options = {}) {
  const raw = text(value);
  if (!raw) return null;
  if (options.month && /^\d{4}-\d{2}$/.test(raw) && civilDate(raw)) return { value: null, on: raw, precision: 'month' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw) && civilDate(raw)) return { value: null, on: raw, precision: 'day' };
  const normalized = timestamp(raw);
  if (normalized) return { value: normalized, on: normalized.slice(0, 10), precision: 'instant' };
  if (options.unanchored) {
    const match = /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.exec(raw);
    const on = match && civilDate(match[1]);
    if (on) return { value: null, on, precision: 'unknown-timezone' };
  }
  return null;
}

function parseHttpUrl(value, base) {
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

function safeUrl(value, base) {
  const raw = text(value);
  return raw ? parseHttpUrl(raw, base)?.href ?? null : null;
}

export function normalizeUrlForDedup(value) {
  const url = parseHttpUrl(value);
  if (!url) return text(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_[^]+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
  return url.href;
}

function firstMeta(document, selectors) {
  for (const [selector, attribute = 'content'] of selectors) {
    const value = text(document.querySelector(selector)?.getAttribute(attribute));
    if (value) return { value, selector };
  }
  return null;
}

function jsonLdValues(document) {
  const values = [];
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    values.push(value);
    if (value['@graph']) visit(value['@graph']);
  };
  for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { visit(JSON.parse(node.textContent)); } catch { /* Invalid publisher JSON-LD is not evidence. */ }
  }
  return values;
}

function authorName(value) {
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map(authorName).filter(Boolean).join(', ');
  return value && typeof value === 'object' ? text(value.name) : '';
}

// Ordered by trust: a publisher's own article meta / JSON-LD / article time first. A bare `<time>`
// is only read when it sits inside an <article> or carries an explicit date hook, so page-header and
// recommendation clocks are never mistaken for a publication date. The search-result path is
// unaffected because it calls temporalValue without these options.
const PAGE_TEMPORAL_OPTIONS = { month: true, unanchored: true };

// Strict opt-in validation before the shared parser: Date.parse can roll an invalid civil day into
// the next month or accept 24:00. Keep that permissive legacy behaviour out of SPEC82 page proof.
export function normalizePagePublicationDate(value) {
  const raw = text(value);
  if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(raw)) return temporalValue(raw, PAGE_TEMPORAL_OPTIONS);
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(raw);
  if (!match || !civilDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) return null;
  return temporalValue(raw, PAGE_TEMPORAL_OPTIONS);
}

const PUBLISHED_AT_SELECTORS = [
  ['meta[property="article:published_time" i]'],
  ['meta[property="og:published_time" i]'],
  ['meta[property="og:article:published_time" i]'],
  ['meta[property="article:published" i]'],
  ['meta[property="rnews:datePublished" i]'],
  ['meta[name="datePublished" i]'],
  ['meta[itemprop="datePublished" i]'],
  ['meta[name="publishdate" i]'],
  ['meta[name="publish_date" i]'],
  ['meta[name="pubdate" i]'],
  ['meta[name="pub_date" i]'],
  ['meta[name="parsely-pub-date" i]'],
  ['meta[name="sailthru.date" i]'],
  ['meta[name="DC.date" i]'],
  ['meta[name="dc.date" i]'],
  ['meta[name="dc.date.issued" i]'],
  ['meta[name="dcterms.date" i]'],
  ['meta[name="article.published" i]'],
  ['meta[property="bt:pubdate" i]'],
  ['time[itemprop="datePublished" i]', 'datetime'],
  ['time[pubdate]', 'datetime'],
  ['article time[datetime]', 'datetime'],
];
// SPEC82 is narrower than the legacy extractor: creation/upload and generic page dates are not
// publication proof. Reuse the actual selector vocabulary, never promote an arbitrary html.* label.
export function pagePublicationEvidenceLevel(source) {
  if (/^html\.jsonld\[\d+\]\.datePublished$/.test(source ?? '')) return 'E1';
  if (['html.chinese.publication_label', 'html.chinese.source_adjacent'].includes(source)) return 'E2';
  for (const [selector] of PUBLISHED_AT_SELECTORS) {
    if (['meta[name="DC.date" i]', 'meta[name="dc.date" i]', 'meta[name="dcterms.date" i]', 'article time[datetime]'].includes(selector)) continue;
    if (source === `html.${selector.replace(/ i\]$/, ']')}`) return selector.startsWith('meta') ? 'E1' : 'E2';
  }
  return null;
}

const MODIFIED_AT_SELECTORS = [
  ['meta[property="article:modified_time" i]'],
  ['meta[property="og:updated_time" i]'],
  ['meta[property="article:modified" i]'],
  ['meta[name="dateModified" i]'],
  ['meta[itemprop="dateModified" i]'],
  ['meta[name="lastmod" i]'],
  ['time[itemprop="dateModified" i]', 'datetime'],
];
// dateCreated / uploadDate are fallbacks, only consulted when datePublished is absent.
const PUBLISHED_AT_JSONLD = ['datePublished', 'dateCreated', 'uploadDate'];
const MODIFIED_AT_JSONLD = ['dateModified'];

// Every publisher-declared date for one kind, in trust order. Keeping the whole list (instead of only
// the first hit) lets the caller record conflicting declarations and lets a lower-priority source win
// when a higher-priority element is present but unparseable.
function contextualPublicationTimeSource(node) {
  const block = node.parentElement?.closest(PUBLICATION_BLOCKS);
  if (!block?.closest('article, main')) return null;
  const before = node.ownerDocument.createRange();
  before.setStart(block, 0);
  before.setEndBefore(node);
  const after = node.ownerDocument.createRange();
  after.setStartAfter(node);
  after.setEnd(block, block.childNodes.length);
  if (/(?:发布时间|发布日期)\s*[：:]\s*$/.test(before.toString())) return 'html.chinese.publication_label';
  if (/^\s*来源\s*[：:]/.test(after.toString()) || /来源\s*[：:]\s*[^\s：:]{1,40}\s+$/.test(before.toString())) return 'html.chinese.source_adjacent';
  return null;
}

function articleJsonLdType(value) {
  if (value == null) return true; // Untyped datePublished remains supported; no entity claim to contradict.
  const types = Array.isArray(value) ? value : [value];
  return types.length > 0 && types.every(type => typeof type === 'string' && ['Article', 'NewsArticle', 'BlogPosting'].includes(type.replace(/^https?:\/\/schema\.org\//, '')));
}

function declaredCandidates(document, jsonLd, kind, { all = false } = {}) {
  const published = kind === 'published_at';
  const selectors = published ? PUBLISHED_AT_SELECTORS : MODIFIED_AT_SELECTORS;
  const properties = published ? PUBLISHED_AT_JSONLD : MODIFIED_AT_JSONLD;
  const candidates = [];
  const seenNodes = new Set();
  for (const [selector, attribute = 'content'] of selectors) {
    const nodes = all ? document.querySelectorAll(selector) : [document.querySelector(selector)];
    for (const node of nodes) {
      if (all && seenNodes.has(node)) continue;
      if (all && published && node?.matches('time[itemprop="dateModified" i]')) continue;
      let source = `html.${selector.replace(/ i\]$/, ']')}`;
      if (all && published && selector === 'article time[datetime]') {
        source = contextualPublicationTimeSource(node);
        if (!source) continue;
      }
      const value = text(node?.getAttribute(attribute));
      if (!value) continue;
      const normalized = all ? normalizePagePublicationDate(value) : temporalValue(value, PAGE_TEMPORAL_OPTIONS);
      // Keep legacy source labels stable. Opt-in scanning records every declaration, but does not
      // count the same <time> twice when two selectors match it.
      if (normalized) {
        candidates.push({ ...normalized, source, ...(all ? { raw: value } : {}) });
        seenNodes.add(node);
      }
    }
  }
  for (let index = 0; index < jsonLd.length; index++) {
    if (all && published && !articleJsonLdType(jsonLd[index]?.['@type'])) continue;
    for (const property of properties) {
      const normalized = all ? normalizePagePublicationDate(jsonLd[index]?.[property]) : temporalValue(jsonLd[index]?.[property], PAGE_TEMPORAL_OPTIONS);
      if (normalized) {
        candidates.push({ ...normalized, source: `html.jsonld[${index}].${property}`, ...(all ? { raw: text(jsonLd[index][property]) } : {}) });
        break;
      }
    }
  }
  return candidates;
}

// Distinct dates other than the primary one that the page also declares. They are surfaced as
// evidence, never merged into the primary date and never silently discarded.
function declaredConflicts(candidates) {
  const primary = candidates[0] ?? null;
  const keyFor = candidate => candidate.value ?? (candidate.precision === 'unknown-timezone' && candidate.raw ? candidate.raw : candidate.on);
  const primaryKey = primary ? keyFor(primary) : null;
  const conflicts = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const key = keyFor(candidate);
    if (key === primaryKey || seen.has(key)) continue;
    seen.add(key);
    conflicts.push({ kind: 'published_at', ...candidate });
  }
  return conflicts;
}

// Opt-in only: do not let clocks or dates in peripheral page regions become article evidence.
function removePublicationNoise(document) {
  for (const node of document.querySelectorAll('aside, footer, nav, [hidden], [aria-hidden="true"], script:not([type="application/ld+json"]), style, template')) node.remove();
  for (const node of document.querySelectorAll('[class], [id], [role]')) {
    const hook = `${node.id} ${node.className} ${node.getAttribute('role') ?? ''}`;
    if (/sidebar|comment|recommend|related|today|侧栏|评论|推荐|今日/i.test(hook)) node.remove();
  }
  for (const heading of document.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
    if (/今日|今天|相关推荐|评论/.test(heading.textContent)) heading.closest('section, aside, div')?.remove();
  }
}

const PUBLICATION_BLOCKS = 'p, div, li, header, section, article, main';
const CHINESE_DATE = String.raw`(?:\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\d{4}-\d{2}-\d{2})(?:[T\s]+\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?)?(?![\dA-Za-z:+.\-]|\s+\d)`;

function chinesePublicationCandidates(document) {
  const candidates = [];
  for (const node of document.querySelectorAll(PUBLICATION_BLOCKS)) {
    if (!node.closest('article, main') || node.querySelector(PUBLICATION_BLOCKS)) continue;
    // Inline markup is transparent; block boundaries are not, so another column's source label
    // cannot lend provenance to an unrelated date. Broad date-only body scans are deliberately absent.
    const content = text(node.textContent).replace(/\s+/g, ' ');
    const patterns = [
      ['publication_label', new RegExp(`(?:发布时间|发布日期)\\s*[：:]\\s*(${CHINESE_DATE})`, 'g')],
      ['source_adjacent', new RegExp(`(${CHINESE_DATE})\\s*[|｜]?\\s*来源\\s*[：:]`, 'g')],
      ['source_adjacent', new RegExp(`来源\\s*[：:]\\s*[^\\s：:]{1,40}\\s+(${CHINESE_DATE})`, 'g')],
    ];
    for (const [rule, pattern] of patterns) {
      for (const match of content.matchAll(pattern)) {
        const raw = match[1].replace(/(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/, (_, year, month, day) => `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`).replace(/\s+(Z|[+-]\d{2}:?\d{2})$/i, '$1');
        const normalized = normalizePagePublicationDate(raw);
        if (normalized) candidates.push({ ...normalized, source: `html.chinese.${rule}`, raw });
      }
    }
  }
  return candidates;
}

export function extractPageEvidence(html, finalUrl, headers = {}, retrievedAt = new Date().toISOString(), { chinesePublicationDates = false } = {}) {
  const dom = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;
  if (chinesePublicationDates) removePublicationNoise(document);
  const jsonLd = jsonLdValues(document);
  const publishedCandidates = declaredCandidates(document, jsonLd, 'published_at', { all: chinesePublicationDates });
  if (chinesePublicationDates) publishedCandidates.push(...chinesePublicationCandidates(document));
  const published = publishedCandidates[0] ?? null;
  const conflicts = declaredConflicts(publishedCandidates);
  const declaredModified = declaredCandidates(document, jsonLd, 'modified_at')[0] ?? null;
  const headerModified = timestamp(headers['last-modified']);
  const modified = declaredModified ?? (headerModified ? { value: headerModified, source: 'http.header.last-modified' } : null);
  const responseDate = timestamp(headers.date);
  const canonical = firstMeta(document, [['link[rel~="canonical"]', 'href']]);
  const canonicalUrl = safeUrl(canonical?.value, finalUrl);
  const site = firstMeta(document, [['meta[property="og:site_name"]'], ['meta[name="application-name"]']]);
  const authorMeta = firstMeta(document, [['meta[name="author"]'], ['meta[property="article:author"]']]);
  const jsonAuthor = jsonLd.map(value => authorName(value.author)).find(Boolean) ?? '';
  const temporalEvidence = [];
  if (published) temporalEvidence.push({ kind: 'published_at', value: published.value, on: published.on, precision: published.precision, source: published.source, ...(conflicts.length ? { conflict: true } : {}) });
  if (modified) temporalEvidence.push({ kind: 'modified_at', ...modified });
  if (responseDate) temporalEvidence.push({ kind: 'response_date', value: responseDate, source: 'http.header.date' });
  temporalEvidence.push({ kind: 'retrieved_at', value: retrievedAt, source: 'gateway.clock' });
  return {
    published_at: published?.value ?? null,
    published_on: published?.on ?? null,
    precision: published?.precision ?? null,
    modified_at: modified?.value ?? null,
    // Other dates the page declares besides the primary one. Recorded, never silently overwritten.
    conflicts,
    ...(chinesePublicationDates ? { publication_candidates: publishedCandidates.map(candidate => ({ kind: 'published_at', ...candidate })) } : {}),
    retrieved_at: retrievedAt,
    source: {
      url: finalUrl,
      host: new URL(finalUrl).hostname.toLowerCase(),
      ...(canonicalUrl ? { canonical_url: canonicalUrl } : {}),
      site_name: site?.value ?? null,
      author: authorMeta?.value || jsonAuthor || null,
    },
    temporal_evidence: temporalEvidence,
  };
}

function validUrlDate(year, month, day = null) {
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, day == null ? 1 : Number(day)));
  if (date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || (day != null && date.getUTCDate() !== Number(day))) return null;
  return {
    on: day == null ? `${year}-${month}` : `${year}-${month}-${day}`,
    precision: day == null ? 'month' : 'day',
    value: null,
    source: 'url.pattern',
  };
}

const URL_DATE_PARAM_KEYS = /^(?:date|pubdate|publishdate|publisheddate|publish_date|published_at|newsdate|dt)$/i;

function urlQueryDate(searchParams) {
  for (const [key, raw] of searchParams) {
    if (!URL_DATE_PARAM_KEYS.test(key)) continue;
    const match = /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})$/.exec(text(raw));
    const normalized = match && validUrlDate(match[1], match[2], match[3]);
    if (normalized) return normalized;
  }
  return null;
}

function urlDate(value) {
  const url = parseHttpUrl(value);
  if (!url) return null;
  const pathname = url.pathname;
  const patterns = [
    /(?:^|\/)(\d{4})-(\d{2})-(\d{2})(?=$|[\/_-])/,
    /(?:^|\/)(\d{4})\/(\d{2})\/(\d{2})(?=$|[\/_-])/,
    /(?:^|\/)(\d{4})(\d{2})(\d{2})(?=$|[\/_-])/,
    // CMS-style compact dates such as `t20260722_` or `content_20260722.htm`.
    /(?:^|[\/_.-]|[a-z])_?(\d{4})(\d{2})(\d{2})(?=$|[\/_.-])/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(pathname);
    const normalized = match && validUrlDate(match[1], match[2], match[3]);
    if (normalized) return normalized;
  }
  const monthMatch = /(?:^|\/)(\d{4})[-/](\d{2})(?=$|\/)/.exec(pathname);
  const month = monthMatch ? validUrlDate(monthMatch[1], monthMatch[2]) : null;
  return month ?? urlQueryDate(url.searchParams);
}

export function normalizeSearchResult(item, retrievedAt = new Date().toISOString()) {
  const url = text(item?.url);
  const candidates = [
    ['publishedDate', item?.publishedDate],
    ['pubdate', item?.pubdate],
    ['published_at', item?.published_at],
  ];
  let published = null;
  for (const [field, value] of candidates) {
    const normalized = temporalValue(value);
    if (normalized) { published = { ...normalized, source: `searxng.result.${field}` }; break; }
  }
  const pathPublished = published ? null : urlDate(url);
  const source = {
    url,
    host: parseHttpUrl(url)?.hostname.toLowerCase() ?? '',
    search_engine: text(item?.engine) || null,
  };
  const temporalEvidence = [];
  if (published) temporalEvidence.push({ kind: 'published_at', value: published.value, on: published.on, precision: published.precision, source: published.source });
  else if (pathPublished) temporalEvidence.push({ kind: 'published_on', value: null, on: pathPublished.on, precision: pathPublished.precision, source: pathPublished.source });
  temporalEvidence.push({ kind: 'retrieved_at', value: retrievedAt, source: 'gateway.clock' });
  const prefix = published
    ? `[WAG publisher ${published.value ? 'timestamp' : 'date'}: ${published.value ?? published.on}; metadata source: ${published.source}]\n`
    : '';
  return {
    title: item?.title,
    url,
    content: `${prefix}${text(item?.content)}`,
    engine: item?.engine,
    category: item?.category,
    published_at: published?.value ?? null,
    published_on: published?.on ?? pathPublished?.on ?? null,
    precision: published?.precision ?? pathPublished?.precision ?? null,
    retrieved_at: retrievedAt,
    source,
    temporal_evidence: temporalEvidence,
  };
}

function searchResultCompleteness(result) {
  return Math.min(text(result.content).length, 4000) +
    (text(result.title) ? 200 : 0) +
    (result.published_at || result.published_on ? 100 : 0) +
    (text(result.engine) ? 20 : 0) +
    (text(result.category) ? 20 : 0) +
    (result.source?.host ? 20 : 0);
}

export function normalizeSearchResults(items, retrievedAt = new Date().toISOString(), limit = 20) {
  const unique = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const result = normalizeSearchResult(item, retrievedAt);
    const key = normalizeUrlForDedup(result.url);
    const previous = unique.get(key);
    if (!previous || searchResultCompleteness(result) > searchResultCompleteness(previous)) unique.set(key, result);
  }
  return [...unique.values()].slice(0, limit);
}

// Titles that are HTTP error banners rather than article titles. Both patterns are anchored to the
// whole title so a genuine headline that merely starts with a status code is never dropped.
const ERROR_PAGE_TITLE_WITH_STATUS = /^\s*(?:error\s+)?\d{3}\s*[-–—:.]?\s*(?:operations? too frequent|too many requests|not found|forbidden|access denied|denied|unauthorized|bad gateway|service unavailable|internal server error|gateway time-?out|request timeout|error)\s*$/i;
const ERROR_PAGE_TITLE_EXACT = /^\s*(?:access denied|403 forbidden|404 not found|not found|forbidden|unauthorized|too many requests|just a moment\.?|attention required!?|enable javascript and cookies to continue|are you a robot\??|verify you are human|checking your browser|service unavailable|bad gateway)\s*$/i;
const ERROR_PAGE_PATH_TOKENS = new Set(['401', '403', '404', '429', '500', '502', '503', 'error', 'denied', 'forbidden', 'blocked', 'captcha', 'challenge', 'unavailable', 'access-denied']);

export function classifyLowQualityResult(result) {
  const title = text(result?.title);
  if (ERROR_PAGE_TITLE_WITH_STATUS.test(title) || ERROR_PAGE_TITLE_EXACT.test(title)) return 'http_error_page';
  const pathname = (parseHttpUrl(result?.url)?.pathname ?? '').replace(/\/+$/, '').toLowerCase();
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 1 && ERROR_PAGE_PATH_TOKENS.has(segments[0])) return 'error_endpoint';
  const host = text(result?.source?.host);
  const bareTitle = !title || (host !== '' && (title.toLowerCase() === host || title.toLowerCase() === `www.${host}`));
  if (bareTitle && !text(result?.content)) return 'empty_result';
  return null;
}

export function filterLowQualityResults(results, { enabled = true } = {}) {
  const list = Array.isArray(results) ? results : [];
  if (!enabled) return { results: list, filtered: [] };
  const kept = [];
  const filtered = [];
  for (const result of list) {
    const reason = classifyLowQualityResult(result);
    if (reason) filtered.push({ url: result?.url ?? '', reason });
    else kept.push(result);
  }
  return { results: kept, filtered };
}

const TEMPORAL_WINDOW_MS = { hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_678_400_000, year: 31_622_400_000 };

function publishedBounds(result) {
  const evidence = Array.isArray(result?.temporal_evidence) ? result.temporal_evidence : [];
  const instant = evidence.find(item => item.kind === 'published_at' && item.value);
  if (instant) {
    const milliseconds = Date.parse(instant.value);
    return Number.isFinite(milliseconds) ? { start: milliseconds, end: milliseconds } : null;
  }
  // Date-only metadata arrives either as `published_at` (SearXNG date field) or `published_on`
  // (URL pattern); both carry `on` plus a precision and are handled identically here.
  const dated = evidence.find(item => item.on && (item.kind === 'published_at' || item.kind === 'published_on'));
  if (!dated) return null;
  if (dated.precision === 'month') {
    const start = Date.parse(`${dated.on}-01T00:00:00.000Z`);
    if (!Number.isFinite(start)) return null;
    const next = new Date(start);
    next.setUTCMonth(next.getUTCMonth() + 1);
    return { start, end: next.getTime() - 1 };
  }
  const start = Date.parse(`${dated.on}T00:00:00.000Z`);
  return Number.isFinite(start) ? { start, end: start + 86_400_000 - 1 } : null;
}

export function timeRangeCompliance(result, timeRange, retrievedAt = new Date().toISOString()) {
  const windowMs = TEMPORAL_WINDOW_MS[timeRange];
  const retrievedMs = Date.parse(retrievedAt);
  if (!windowMs || !Number.isFinite(retrievedMs)) return 'unverified';
  const bounds = publishedBounds(result);
  if (!bounds) return 'unverified';
  const windowStart = retrievedMs - windowMs;
  if (bounds.end < windowStart) return 'outside';
  if (bounds.start >= windowStart) return 'within';
  return 'unverified';
}

// Strict freshness only trusts a publisher-declared *instant* (article meta/JSON-LD/time, or a
// SeXNG date field that carried a timezone). URL-pattern guesses, the gateway clock, the HTTP
// Date/Last-Modified headers and response dates can never be promoted into strict fresh evidence.
const NON_PUBLISHER_TIME_SOURCES = new Set(['url.pattern', 'gateway.clock', 'http.header.date', 'http.header.last-modified']);

export function publisherPublicationInstant(result) {
  const evidence = Array.isArray(result?.temporal_evidence) ? result.temporal_evidence : [];
  const record = evidence.find(item => item.kind === 'published_at' && item.value && !NON_PUBLISHER_TIME_SOURCES.has(item.source));
  if (!record) return null;
  const milliseconds = Date.parse(record.value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

// Same five verdicts as timeRangeCompliance, but `within` is only returned when a publisher-sourced
// instant is proven inside the window. Unknown, URL-inferred, timezone-less and date-only evidence
// all stay `unverified`; a timestamp ahead of retrieval (clock skew / future date) is `unverified`,
// never silently treated as fresh.
export function strictTimeRangeCompliance(result, timeRange, retrievedAt = new Date().toISOString()) {
  const windowMs = TEMPORAL_WINDOW_MS[timeRange];
  const retrievedMs = Date.parse(retrievedAt);
  if (!windowMs || !Number.isFinite(retrievedMs)) return 'unverified';
  const instant = publisherPublicationInstant(result);
  if (instant === null) return 'unverified';
  if (instant > retrievedMs) return 'unverified';
  return instant >= retrievedMs - windowMs ? 'within' : 'outside';
}

export function prependPublishedEvidence(markdown, evidence) {
  if (!evidence?.published_at && !evidence?.published_on) return markdown;
  const record = evidence.temporal_evidence.find(item => item.kind === 'published_at');
  const value = evidence.published_at ?? evidence.published_on;
  const label = evidence.published_at ? 'timestamp' : 'date';
  return `> WAG publisher ${label}: ${value} (precision: ${record?.precision ?? 'unknown'}; metadata source: ${record?.source ?? 'unknown'})\n\n${markdown}`;
}
