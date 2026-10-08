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

function temporalValue(value) {
  const raw = text(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { value: null, on: raw, precision: 'day' };
  const normalized = timestamp(raw);
  return normalized ? { value: normalized, on: normalized.slice(0, 10), precision: 'instant' } : null;
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

function declaredDate(document, jsonLd, kind) {
  const selectors = kind === 'published_at' ? [
    ['meta[property="article:published_time"]'],
    ['meta[property="og:published_time"]'],
    ['meta[name="datePublished"]'],
    ['meta[itemprop="datePublished"]'],
    ['meta[name="publishdate"]'],
    ['meta[name="pubdate"]'],
    ['article time[datetime]', 'datetime'],
  ] : [
    ['meta[property="article:modified_time"]'],
    ['meta[property="og:updated_time"]'],
    ['meta[name="dateModified"]'],
    ['meta[itemprop="dateModified"]'],
  ];
  const meta = firstMeta(document, selectors);
  const normalized = temporalValue(meta?.value);
  if (normalized) return { ...normalized, source: `html.${meta.selector}` };
  const property = kind === 'published_at' ? 'datePublished' : 'dateModified';
  for (let index = 0; index < jsonLd.length; index++) {
    const normalizedJson = temporalValue(jsonLd[index]?.[property]);
    if (normalizedJson) return { ...normalizedJson, source: `html.jsonld[${index}].${property}` };
  }
  return null;
}

export function extractPageEvidence(html, finalUrl, headers = {}, retrievedAt = new Date().toISOString()) {
  const dom = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;
  const jsonLd = jsonLdValues(document);
  const published = declaredDate(document, jsonLd, 'published_at');
  const declaredModified = declaredDate(document, jsonLd, 'modified_at');
  const headerModified = timestamp(headers['last-modified']);
  const modified = declaredModified ?? (headerModified ? { value: headerModified, source: 'http.header.last-modified' } : null);
  const responseDate = timestamp(headers.date);
  const canonical = firstMeta(document, [['link[rel~="canonical"]', 'href']]);
  const canonicalUrl = safeUrl(canonical?.value, finalUrl);
  const site = firstMeta(document, [['meta[property="og:site_name"]'], ['meta[name="application-name"]']]);
  const authorMeta = firstMeta(document, [['meta[name="author"]'], ['meta[property="article:author"]']]);
  const jsonAuthor = jsonLd.map(value => authorName(value.author)).find(Boolean) ?? '';
  const temporalEvidence = [];
  if (published) temporalEvidence.push({ kind: 'published_at', value: published.value, on: published.on, precision: published.precision, source: published.source });
  if (modified) temporalEvidence.push({ kind: 'modified_at', ...modified });
  if (responseDate) temporalEvidence.push({ kind: 'response_date', value: responseDate, source: 'http.header.date' });
  temporalEvidence.push({ kind: 'retrieved_at', value: retrievedAt, source: 'gateway.clock' });
  return {
    published_at: published?.value ?? null,
    published_on: published?.on ?? null,
    precision: published?.precision ?? null,
    modified_at: modified?.value ?? null,
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

export function prependPublishedEvidence(markdown, evidence) {
  if (!evidence?.published_at && !evidence?.published_on) return markdown;
  const record = evidence.temporal_evidence.find(item => item.kind === 'published_at');
  const value = evidence.published_at ?? evidence.published_on;
  const label = evidence.published_at ? 'timestamp' : 'date';
  return `> WAG publisher ${label}: ${value} (precision: ${record?.precision ?? 'unknown'}; metadata source: ${record?.source ?? 'unknown'})\n\n${markdown}`;
}
