import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { classifyLowQualityResult, extractPageEvidence, filterLowQualityResults, normalizeSearchResult, normalizeSearchResults, normalizeUrlForDedup, prependPublishedEvidence, publisherPublicationInstant, timeRangeCompliance } from './evidence-metadata.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(moduleDir, 'fixtures', 'page-evidence');
const TODAY_HEADER = { date: 'Fri, 09 Oct 2026 00:00:00 GMT' };
const RETRIEVED_AT = '2026-10-09T01:00:00.000Z';
const fixture = name => fs.readFileSync(path.join(fixturesDir, name), 'utf8');

test('page evidence keeps publisher time separate from retrieval and response time', () => {
  const html = `<!doctype html><html><head>
    <meta property="article:published_time" content="2026-09-27T12:30:00+08:00">
    <meta property="og:site_name" content="Example Publisher">
    <link rel="canonical" href="/story">
  </head><body><article>News</article></body></html>`;
  const evidence = extractPageEvidence(html, 'https://example.com/story?tracking=1',
    { date: 'Mon, 28 Sep 2026 00:00:00 GMT' }, '2026-09-28T01:00:00.000Z');

  assert.equal(evidence.published_at, '2026-09-27T04:30:00.000Z');
  assert.equal(evidence.retrieved_at, '2026-09-28T01:00:00.000Z');
  assert.equal(evidence.source.url, 'https://example.com/story?tracking=1');
  assert.equal(evidence.source.host, 'example.com');
  assert.equal(evidence.source.canonical_url, 'https://example.com/story');
  assert.equal(evidence.source.site_name, 'Example Publisher');
  assert.equal(evidence.temporal_evidence.find(item => item.kind === 'published_at').source,
    'html.meta[property="article:published_time"]');
  assert.match(prependPublishedEvidence('News', evidence), /WAG publisher timestamp: 2026-09-27T04:30:00.000Z/);
});

test('page evidence omits a missing publisher canonical URL', () => {
  const evidence = extractPageEvidence('<html><body>News</body></html>', 'https://example.org/news');
  assert.equal(Object.hasOwn(evidence.source, 'canonical_url'), false);
  assert.equal(JSON.stringify(evidence).includes('/undefined'), false);
  assert.equal(evidence.source.url, 'https://example.org/news');
});

test('page evidence omits empty and invalid publisher canonical attributes', () => {
  const links = [
    '<link rel="canonical">',
    '<link rel="canonical" href="">',
    '<link rel="canonical" href="   ">',
    '<link rel="canonical" href="https://[invalid">',
    '<link rel="canonical" href="http://">',
    '<link rel="canonical" href="javascript:alert(1)">',
    '<link rel="canonical" href="data:text/html,News">',
    '<link rel="canonical" href="ftp://example.org/story">',
  ];
  for (const link of links) {
    const evidence = extractPageEvidence(`<html><head>${link}</head><body>News</body></html>`, 'https://final.example.org/articles/news');
    assert.equal(Object.hasOwn(evidence.source, 'canonical_url'), false, link);
    assert.equal(JSON.stringify(evidence).includes('/undefined'), false, link);
    assert.equal(evidence.source.url, 'https://final.example.org/articles/news');
    assert.equal(evidence.source.host, 'final.example.org');
  }
});

test('page evidence resolves publisher canonical URLs against the final response URL', () => {
  const cases = [
    ['../declared?edition=1', 'https://final.example.org/declared?edition=1'],
    ['/declared', 'https://final.example.org/declared'],
    ['//publisher.example.org/declared', 'https://publisher.example.org/declared'],
    ['  https://publisher.example.org/declared  ', 'https://publisher.example.org/declared'],
    ['http://publisher.example.org/declared', 'http://publisher.example.org/declared'],
  ];
  for (const [href, expected] of cases) {
    const evidence = extractPageEvidence(`<html><head><link rel="canonical" href="${href}"></head></html>`, 'https://final.example.org/articles/news?tracking=1');
    assert.equal(evidence.source.canonical_url, expected, href);
    assert.equal(evidence.source.url, 'https://final.example.org/articles/news?tracking=1');
    assert.equal(evidence.source.host, 'final.example.org');
  }
});

test('response date and search retrieval time are never presented as publication time', () => {
  const retrievedAt = '2026-09-28T01:00:00.000Z';
  const page = extractPageEvidence('<html><body>News</body></html>', 'https://example.org/news',
    { date: 'Mon, 28 Sep 2026 00:00:00 GMT' }, retrievedAt);
  assert.equal(page.published_at, null);
  assert.equal(prependPublishedEvidence('News', page), 'News');
  assert.ok(page.temporal_evidence.some(item => item.kind === 'response_date'));

  const result = normalizeSearchResult({ title: 'News', url: 'https://example.org/news', content: 'Summary', engine: 'test' }, retrievedAt);
  assert.equal(result.published_at, null);
  assert.equal(result.retrieved_at, retrievedAt);
  assert.equal(result.source.host, 'example.org');
  assert.equal(result.source.search_engine, 'test');
  assert.deepEqual(result.temporal_evidence.map(item => item.kind), ['retrieved_at']);
});

test('date-only publisher metadata is retained with day precision', () => {
  const html = '<html><head><meta name="datePublished" content="2026-09-28"></head><body>公告</body></html>';
  const evidence = extractPageEvidence(html, 'https://example.gov.cn/notice', {}, '2026-09-28T02:00:00.000Z');
  assert.equal(evidence.published_at, null);
  assert.equal(evidence.published_on, '2026-09-28');
  assert.equal(evidence.precision, 'day');
  assert.equal(evidence.temporal_evidence.find(item => item.kind === 'published_at').precision, 'day');
  assert.match(prependPublishedEvidence('公告', evidence), /publisher date: 2026-09-28/);
});

test('search result dates use publisher metadata before URL evidence', () => {
  const result = normalizeSearchResult({
    title: 'News',
    url: 'https://example.org/2026/10/02/news',
    content: 'Summary',
    publishedDate: '2026-09-30',
  }, '2026-10-03T00:00:00.000Z');
  assert.equal(result.published_at, null);
  assert.equal(result.published_on, '2026-09-30');
  assert.equal(result.precision, 'day');
  assert.equal(result.temporal_evidence[0].source, 'searxng.result.publishedDate');
  assert.equal(result.temporal_evidence.some(item => item.source === 'url.pattern'), false);
});

test('search result URL dates cover slash, compact, and dashed paths', () => {
  const retrievedAt = '2026-10-03T00:00:00.000Z';
  const cases = [
    ['https://example.org/2026/10/02/story', '2026-10-02', 'day'],
    ['https://example.org/archive/20261003/story', '2026-10-03', 'day'],
    ['https://example.org/news/2026-10-04/story', '2026-10-04', 'day'],
    ['https://example.org/archive/2026/10/story', '2026-10', 'month'],
  ];
  for (const [url, publishedOn, precision] of cases) {
    const result = normalizeSearchResult({ title: 'News', url, content: 'Summary' }, retrievedAt);
    assert.equal(result.published_on, publishedOn, url);
    assert.equal(result.precision, precision, url);
    assert.deepEqual(result.temporal_evidence[0], { kind: 'published_on', value: null, on: publishedOn, precision, source: 'url.pattern' });
  }
});

test('search results deduplicate normalized URLs and retain the fuller record', () => {
  assert.equal(normalizeUrlForDedup('HTTPS://example.org:443/story?utm_source=news#fragment'), 'https://example.org/story');
  const results = normalizeSearchResults([
    { title: 'Short', url: 'https://example.org/story#top', content: 'Short' },
    { title: 'Full story', url: 'https://example.org/story?utm_source=news', content: 'A much longer summary with more details.' },
  ], '2026-10-03T00:00:00.000Z');
  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Full story');
  assert.match(results[0].content, /more details/);
});

test('URL dates cover CMS compact forms and query parameters without faking publisher time', () => {
  const retrievedAt = '2026-10-08T00:00:00.000Z';
  const cases = [
    ['https://m.21jingji.com/article/20260722/herald/abc.html', '2026-07-22'],
    ['https://www.news.cn/news/t20260722_1234.htm', '2026-07-22'],
    ['https://example.org/p/2026-07-22/story', '2026-07-22'],
    ['https://example.org/article?id=77&date=2026-07-22', '2026-07-22'],
    ['https://example.org/article?pubdate=20260722', '2026-07-22'],
  ];
  for (const [url, publishedOn] of cases) {
    const result = normalizeSearchResult({ title: 'News', url, content: 'Summary' }, retrievedAt);
    assert.equal(result.published_on, publishedOn, url);
    assert.equal(result.precision, 'day', url);
    // URL-derived dates must never masquerade as publisher metadata.
    assert.equal(result.published_at, null, url);
    assert.equal(result.temporal_evidence[0].source, 'url.pattern', url);
  }
});

test('URL date enrichment rejects invalid or unrelated digit runs', () => {
  const retrievedAt = '2026-10-08T00:00:00.000Z';
  for (const url of [
    'https://example.org/bad/20261340/story',
    'https://example.org/bad/20260230/story',
    'https://example.org/order/12345678',
    'https://example.org/article?id=98765432',
  ]) {
    const result = normalizeSearchResult({ title: 'News', url, content: 'Summary' }, retrievedAt);
    assert.equal(result.published_on, null, url);
    assert.equal(result.temporal_evidence.some(item => item.source === 'url.pattern'), false, url);
  }
});

test('error pages are classified with a countable reason', () => {
  const cases = [
    ['http_error_page', { title: '403 - Operations too frequent', url: 'https://www.moomoo.com/403', content: '', source: { host: 'www.moomoo.com' } }],
    ['http_error_page', { title: '404 Not Found', url: 'https://example.org/missing', content: '' }],
    ['http_error_page', { title: 'Access Denied', url: 'https://example.org/a', content: '' }],
    ['error_endpoint', { title: 'moomoo', url: 'https://www.moomoo.com/403', content: 'ok' }],
    ['empty_result', { title: 'z9xx.com', url: 'https://z9xx.com', content: '', source: { host: 'z9xx.com' } }],
    ['empty_result', { title: '', url: 'https://example.org/', content: '', source: { host: 'example.org' } }],
  ];
  for (const [reason, result] of cases) assert.equal(classifyLowQualityResult(result), reason, `${result.url} :: ${result.title}`);
});

test('error-page detection never drops a genuine headline that merely starts with a status code', () => {
  const result = {
    title: '404 Not Found: how the web handles missing pages',
    url: 'https://blog.example.org/404-not-found',
    content: 'A long article body that a real publisher produced.',
    source: { host: 'blog.example.org' },
  };
  assert.equal(classifyLowQualityResult(result), null);
});

test('filterLowQualityResults reports counts and can be disabled', () => {
  const results = [
    { title: 'Real', url: 'https://example.org/real', content: 'body', source: { host: 'example.org' } },
    { title: '403 - Operations too frequent', url: 'https://www.moomoo.com/403', content: '', source: { host: 'www.moomoo.com' } },
    { title: '404 Not Found', url: 'https://example.org/missing', content: '', source: { host: 'example.org' } },
  ];
  const filtered = filterLowQualityResults(results);
  assert.deepEqual(filtered.results.map(result => result.title), ['Real']);
  assert.deepEqual(filtered.filtered, [
    { url: 'https://www.moomoo.com/403', reason: 'http_error_page' },
    { url: 'https://example.org/missing', reason: 'http_error_page' },
  ]);

  const disabled = filterLowQualityResults(results, { enabled: false });
  assert.equal(disabled.results.length, 3);
  assert.deepEqual(disabled.filtered, []);
});

test('time range compliance distinguishes within, outside, and unverified evidence', () => {
  const retrievedAt = '2026-10-08T12:00:00.000Z';
  const dated = value => ({ temporal_evidence: [{ kind: 'published_at', value, on: value.slice(0, 10), precision: 'instant', source: 'test' }] });
  assert.equal(timeRangeCompliance(dated('2026-10-08T06:00:00.000Z'), 'day', retrievedAt), 'within');
  assert.equal(timeRangeCompliance(dated('2026-08-12T00:00:00.000Z'), 'day', retrievedAt), 'outside');
  assert.equal(timeRangeCompliance(dated('2026-02-10T00:00:00.000Z'), 'year', retrievedAt), 'within');
  // A result with no date evidence can never be proven inside the window.
  assert.equal(timeRangeCompliance({ temporal_evidence: [{ kind: 'retrieved_at', value: retrievedAt, source: 'gateway.clock' }] }, 'day', retrievedAt), 'unverified');
  // A month-precision URL date cannot prove a day window but can prove a year window.
  const month = normalizeSearchResult({ title: 'News', url: 'https://example.org/archive/2026/10/story', content: 's' }, retrievedAt);
  assert.equal(month.precision, 'month');
  assert.equal(timeRangeCompliance(month, 'day', retrievedAt), 'unverified');
  assert.equal(timeRangeCompliance(month, 'year', retrievedAt), 'within');
});

// --- SPEC issue #73: publisher date extraction on fixed page HTML fixtures ---------------------------------

test('fixed page fixtures: a publisher date wins over the page-header today and recommendation times', () => {
  const evidence = extractPageEvidence(
    fixture('old-article-today-header.html'),
    'https://www.ajudaily.com/view/20241128080617057',
    TODAY_HEADER,
    RETRIEVED_AT,
  );
  assert.equal(evidence.published_at, '2024-11-28T01:35:33.000Z');
  assert.equal(evidence.published_on, '2024-11-28');
  assert.equal(evidence.precision, 'instant');
  assert.equal(evidence.temporal_evidence.find(item => item.kind === 'published_at').source,
    'html.meta[property="article:published_time"]');
  // The page-header "today" clock and the HTTP Date header stay out of the publication date.
  assert.notEqual(evidence.published_at.slice(0, 10), '2026-10-09');
});

test('fixed page fixtures: no publisher date means no publication date, even with a today header', () => {
  const evidence = extractPageEvidence(fixture('today-header-only.html'), 'https://pcgpower.com/', TODAY_HEADER, RETRIEVED_AT);
  assert.equal(evidence.published_at, null);
  assert.equal(evidence.published_on, null);
  assert.equal(evidence.precision, null);
  assert.equal(evidence.temporal_evidence.some(item => item.kind === 'published_at'), false);
  assert.ok(evidence.temporal_evidence.some(item => item.kind === 'response_date'));
  assert.equal(prependPublishedEvidence('Company homepage', evidence), 'Company homepage');
});

test('fixed page fixtures: article time and JSON-LD datePublished are extracted', () => {
  const body = extractPageEvidence(fixture('body-time.html'), 'https://example.org/news/body', {}, RETRIEVED_AT);
  assert.equal(body.published_at, '2026-10-08T13:30:00.000Z');
  assert.equal(body.precision, 'instant');
  assert.match(body.temporal_evidence.find(item => item.kind === 'published_at').source, /time\[/);

  const jsonld = extractPageEvidence(fixture('jsonld-newsarticle.html'), 'https://example.org/news/jsonld', {}, RETRIEVED_AT);
  assert.equal(jsonld.published_at, '2026-10-08T09:00:00.000Z');
  assert.equal(jsonld.temporal_evidence.find(item => item.kind === 'published_at').source, 'html.jsonld[0].datePublished');
  assert.equal(jsonld.temporal_evidence.find(item => item.kind === 'modified_at').value, '2026-10-08T10:00:00.000Z');
});

test('fixed page fixtures: day and month precision are preserved without faking a UTC instant', () => {
  const day = extractPageEvidence(fixture('date-published-day.html'), 'https://example.gov.cn/notice', {}, RETRIEVED_AT);
  assert.equal(day.published_at, null);
  assert.equal(day.published_on, '2026-09-28');
  assert.equal(day.precision, 'day');

  const month = extractPageEvidence(fixture('monthly-archive.html'), 'https://example.org/archive/2026/10', {}, RETRIEVED_AT);
  assert.equal(month.published_at, null);
  assert.equal(month.published_on, '2026-10');
  assert.equal(month.precision, 'month');
});

test('fixed page fixtures: a timezone-less publisher time keeps its civil date but never a UTC instant', () => {
  const evidence = extractPageEvidence(fixture('unknown-timezone.html'), 'https://example.org/no-tz', {}, RETRIEVED_AT);
  assert.equal(evidence.published_at, null);
  assert.equal(evidence.published_on, '2026-10-08');
  assert.equal(evidence.precision, 'unknown-timezone');
  const record = evidence.temporal_evidence.find(item => item.kind === 'published_at');
  assert.equal(record.value, null);
  assert.equal(record.on, '2026-10-08');
  // Downstream strict freshness must never promote an unanchored time to a verified instant.
  assert.equal(publisherPublicationInstant(evidence), null);
});

test('fixed page fixtures: conflicting publisher dates are recorded, not silently overwritten', () => {
  const evidence = extractPageEvidence(fixture('conflict-meta-jsonld.html'), 'https://example.org/conflict', {}, RETRIEVED_AT);
  assert.equal(evidence.published_at, '2026-10-08T10:00:00.000Z');
  const primary = evidence.temporal_evidence.find(item => item.kind === 'published_at');
  assert.equal(primary.source, 'html.meta[property="article:published_time"]');
  assert.equal(primary.conflict, true);
  assert.equal(evidence.conflicts.length, 1);
  assert.equal(evidence.conflicts[0].value, '2024-11-28T01:35:33.000Z');
  assert.equal(evidence.conflicts[0].source, 'html.jsonld[0].datePublished');
});

test('additional publisher meta selectors and JSON-LD fallbacks are extracted', () => {
  const cases = [
    ['<meta property="og:article:published_time" content="2026-10-08T09:00:00Z">', 'html.meta[property="og:article:published_time"]'],
    ['<meta name="parsely-pub-date" content="2026-10-08T09:00:00Z">', 'html.meta[name="parsely-pub-date"]'],
    ['<meta name="DC.date" content="2026-10-08T09:00:00Z">', 'html.meta[name="DC.date"]'],
    ['<meta name="sailthru.date" content="2026-10-08T09:00:00Z">', 'html.meta[name="sailthru.date"]'],
  ];
  for (const [meta, source] of cases) {
    const evidence = extractPageEvidence(`<html><head>${meta}</head><body><article>body</article></body></html>`, 'https://example.org/a', {}, RETRIEVED_AT);
    assert.equal(evidence.published_at, '2026-10-08T09:00:00.000Z', meta);
    assert.equal(evidence.temporal_evidence.find(item => item.kind === 'published_at').source, source, meta);
  }
  const created = extractPageEvidence('<html><head><script type="application/ld+json">{"@type":"Article","dateCreated":"2026-10-08T09:00:00Z"}</script></head><body><article>b</article></body></html>', 'https://example.org/b', {}, RETRIEVED_AT);
  assert.equal(created.published_at, '2026-10-08T09:00:00.000Z');
  assert.equal(created.temporal_evidence.find(item => item.kind === 'published_at').source, 'html.jsonld[0].dateCreated');
});

test('publisher date meta is matched case-insensitively on the attribute value', () => {
  const upper = extractPageEvidence('<html><head><meta name="PUBDATE" content="2026-10-08T09:00:00Z"></head><body><article>b</article></body></html>', 'https://example.org/u', {}, RETRIEVED_AT);
  assert.equal(upper.published_at, '2026-10-08T09:00:00.000Z');
  assert.equal(upper.temporal_evidence.find(item => item.kind === 'published_at').source, 'html.meta[name="pubdate"]');

  const mixed = extractPageEvidence('<html><head><meta property="Article:Published_Time" content="2026-10-08T09:00:00Z"></head><body><article>b</article></body></html>', 'https://example.org/m', {}, RETRIEVED_AT);
  assert.equal(mixed.published_at, '2026-10-08T09:00:00.000Z');
  assert.equal(mixed.temporal_evidence.find(item => item.kind === 'published_at').source, 'html.meta[property="article:published_time"]');
});

test('a generic <time> outside an article is never promoted to a publication date', () => {
  const html = '<html><body><div class="recommendations"><time datetime="2026-10-09T08:00:00Z">8:00</time></div><p>no article here</p></body></html>';
  const evidence = extractPageEvidence(html, 'https://example.org/recs', {}, RETRIEVED_AT);
  assert.equal(evidence.published_at, null);
  assert.equal(evidence.temporal_evidence.some(item => item.kind === 'published_at'), false);
});

test('publisher date extraction coverage over the fixed page fixture set (fixed denominator)', () => {
  const names = fs.readdirSync(fixturesDir).filter(name => name.endsWith('.html')).sort();
  const dated = [];
  const undated = [];
  for (const name of names) {
    const evidence = extractPageEvidence(fixture(name), `https://example.org/${name}`, TODAY_HEADER, RETRIEVED_AT);
    (evidence.published_at || evidence.published_on ? dated : undated).push(name);
  }
  // The denominator is every fixture page; nothing is dropped to make a count look complete.
  assert.equal(names.length, 8);
  // The only page without a publisher date is the one that declares none; a today header is not a date.
  assert.deepEqual(undated, ['today-header-only.html']);
  assert.equal(dated.length, 7);
  // The two pages the pre-#73 extractor dropped (timezone-less / month-only) now yield a date.
  assert.ok(dated.includes('unknown-timezone.html'));
  assert.ok(dated.includes('monthly-archive.html'));
});
