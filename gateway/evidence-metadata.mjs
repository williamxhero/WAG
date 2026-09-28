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

function safeUrl(value, base) {
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
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
      canonical_url: safeUrl(canonical?.value, finalUrl),
      site_name: site?.value ?? null,
      author: authorMeta?.value || jsonAuthor || null,
    },
    temporal_evidence: temporalEvidence,
  };
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
    const normalized = timestamp(value);
    if (normalized) { published = { ...normalized, source: `searxng.result.${field}` }; break; }
  }
  const source = {
    url,
    host: null,
    search_engine: text(item?.engine) || null,
  };
  source.host = safeUrl(url) ? new URL(url).hostname.toLowerCase() : null;
  const temporalEvidence = [];
  if (published) temporalEvidence.push({ kind: 'published_at', value: published.value, on: published.on, precision: published.precision, source: published.source });
  temporalEvidence.push({ kind: 'retrieved_at', value: retrievedAt, source: 'gateway.clock' });
  const prefix = published ? `[WAG publisher timestamp: ${published.value}; metadata source: ${published.source}]\n` : '';
  return {
    title: item?.title,
    url,
    content: `${prefix}${text(item?.content)}`,
    engine: item?.engine,
    category: item?.category,
    published_at: published?.value ?? null,
    published_on: published?.on ?? null,
    precision: published?.precision ?? null,
    retrieved_at: retrievedAt,
    source,
    temporal_evidence: temporalEvidence,
  };
}

export function prependPublishedEvidence(markdown, evidence) {
  if (!evidence?.published_at && !evidence?.published_on) return markdown;
  const record = evidence.temporal_evidence.find(item => item.kind === 'published_at');
  const value = evidence.published_at ?? evidence.published_on;
  const label = evidence.published_at ? 'timestamp' : 'date';
  return `> WAG publisher ${label}: ${value} (precision: ${record?.precision ?? 'unknown'}; metadata source: ${record?.source ?? 'unknown'})\n\n${markdown}`;
}
