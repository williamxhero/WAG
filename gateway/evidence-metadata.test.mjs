import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPageEvidence, normalizeSearchResult, prependPublishedEvidence } from './evidence-metadata.mjs';

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
