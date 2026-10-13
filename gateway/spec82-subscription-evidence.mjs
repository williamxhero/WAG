// Offline only: reuse the accepted extractor/evaluator; never fetch or persist HTML.
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { extractPageEvidence, normalizePagePublicationDate, normalizeUrlForDedup } from './evidence-metadata.mjs';
import { evaluateSpec82Evidence } from './spec82-evidence.mjs';
import { resolveNewsWindow } from './news-verified.mjs';

function safeUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search) throw new Error();
  return normalizeUrlForDedup(url.href);
}
function rawDate(value) {
  return typeof value === 'string' && value.length <= 128 && /^[0-9A-Za-z ,:+./年年月日时分秒-]+$/.test(value)
    && /\d{4}/.test(value) && !/secret|token|password|bearer|api.?key/i.test(value) ? value : null;
}
function dateRecord(record) {
  const raw = rawDate(record.raw);
  return Object.fromEntries(Object.entries({
    source: typeof record.source === 'string' && /^(?:html\.|feed\.item\.)[\w.[\]=" -]+$/.test(record.source) ? record.source.slice(0, 160) : null,
    raw, value: record.value ?? null, on: record.on ?? null, precision: record.precision ?? null,
    evidence_level: record.evidence_level ?? null, valid_date: record.valid_date ?? null,
  }).filter(([, value]) => value !== undefined));
}

// This is an identity gate, not another date extractor. A declaration for another article
// cannot lend its proof to the acquired page; uncertainty fails closed for the whole sample.
function mismatchedIdentity(html, finalUrl) {
  const dom = new JSDOM(html, { url: finalUrl });
  try {
    const document = dom.window.document;
    const compare = value => {
      if (value && typeof value === 'object') value = value['@id'] ?? value.url;
      return typeof value === 'string' && safeUrl(new URL(value, finalUrl).href) !== finalUrl;
    };
    for (const node of document.querySelectorAll('link[rel~="canonical"], meta[property="og:url"]')) {
      if (compare(node.getAttribute('href') ?? node.getAttribute('content'))) return true;
    }
    let count = 0;
    const visit = value => {
      if (++count > 1000) throw new Error();
      if (Array.isArray(value)) return value.some(visit);
      if (!value || typeof value !== 'object') return false;
      if (value.datePublished && [value.url, value['@id'], value.mainEntityOfPage].some(compare)) return true;
      return value['@graph'] ? visit(value['@graph']) : false;
    };
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      let value;
      try { value = JSON.parse(node.textContent); } catch { continue; }
      if (visit(value)) return true;
    }
    return false;
  } finally { dom.window.close(); }
}

try {
  const input = readFileSync(0);
  if (input.length > 1100000) throw new Error();
  const request = JSON.parse(input);
  const window = resolveNewsWindow({ now: request.now, window: request.window });
  if (request.operation === 'window') process.stdout.write(JSON.stringify(window));
  else {
    if (request.operation !== 'evaluate' || typeof request.html !== 'string' || Buffer.byteLength(request.html) > 1048576
      || !Number.isFinite(Date.parse(request.retrieved_at))) throw new Error();
    const finalUrl = safeUrl(request.validated_url);
    const matched = safeUrl(request.page_url) === finalUrl && !mismatchedIdentity(request.html, finalUrl);
    const page = extractPageEvidence(request.html, finalUrl, {}, request.retrieved_at, { chinesePublicationDates: true });
    if (!Array.isArray(request.feed_dates ?? []) || (request.feed_dates ?? []).length > 3) throw new Error();
    const auxiliary = (request.feed_dates ?? []).map(record => {
      if (!/^feed\.item\.(pubDate|published|updated)$/.test(record.source)) throw new Error();
      const raw = rawDate(record.raw);
      let parsed = normalizePagePublicationDate(raw);
      // RFC822 feed claims are diagnostics only, never independent page proof.
      if (!parsed && raw && /\b(?:GMT|UTC)\b/.test(raw) && Number.isFinite(Date.parse(raw))) {
        parsed = { value: new Date(raw).toISOString(), precision: 'instant' };
      }
      return { source: record.source, raw, ...parsed };
    });
    const verdict = evaluateSpec82Evidence(page, window, { auxiliary, checked_at: request.retrieved_at });
    const evidence = {
      status: matched ? verdict.status : 'unknown', reason: matched ? verdict.reason : 'mismatched_evidence_url',
      evidence_level: verdict.evidence_level, source: verdict.source,
      published_at: matched ? verdict.published_at : null, published_on: matched ? verdict.published_on : null,
      precision: verdict.precision, evidence_url: finalUrl, checked_at: request.retrieved_at,
      conflict_count: verdict.conflict_count, diagnostics: verdict.diagnostics.slice(0, 64).map(dateRecord),
      conflicts: verdict.conflicts.slice(0, 64).map(dateRecord),
    };
    process.stdout.write(JSON.stringify({ window, classification: evidence.status, evidence,
      raw_fields: (page.publication_candidates ?? []).slice(0, 64).map(dateRecord), feed_dates: auxiliary.map(dateRecord) }));
  }
} catch {
  process.stderr.write('subscription_evidence_invalid\n');
  process.exitCode = 1;
}
