import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isNewsCategory, newsQueryTerms, rankNewsResults, scoreNewsRelevance, searchSearxng } from './search.mjs';

// Dedicated tests for the opt-in news-mode explainable ranking + result dedup (SPEC issue #72).
// Normal (non-news) search behavior is asserted to stay compatible by `search.test.mjs`; these tests
// cover the opt-in mode only. The signals are explainable heuristics, never a claim of true relevance.

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function fixtureSearch(body, input, options = {}) {
  return searchSearxng({
    baseUrl: 'http://searxng.test/',
    input,
    ...options,
    fetchImpl: async () => ({ ok: true, json: async () => body }),
  });
}

function normalized(overrides = {}) {
  const url = overrides.url ?? 'https://example.org/a/b';
  return {
    title: 'Generic title',
    url,
    content: 'A substantive snippet.',
    engine: 'yandex',
    category: 'general',
    published_at: null,
    published_on: null,
    precision: null,
    retrieved_at: '2026-10-09T00:00:00.000Z',
    source: { url, host: 'example.org', search_engine: 'yandex' },
    temporal_evidence: [{ kind: 'retrieved_at', value: '2026-10-09T00:00:00.000Z', source: 'gateway.clock' }],
    ...overrides,
  };
}

const NAVIGATIONAL_ROOT = normalized({
  title: 'Example', url: 'https://navigational.example/', content: 'Welcome to our website.',
  source: { url: 'https://navigational.example/', host: 'navigational.example', search_engine: 'yandex' },
});

test('news mode opts in from an explicit flag or a news category and stays off otherwise', () => {
  assert.equal(isNewsCategory('news'), true);
  assert.equal(isNewsCategory('general,news'), true);
  assert.equal(isNewsCategory('news,general'), true);
  assert.equal(isNewsCategory('general'), false);
  assert.equal(isNewsCategory('newspaper'), false);
  assert.equal(isNewsCategory(undefined), false);
});

test('news query terms split latin words and CJK bigrams without a dictionary', () => {
  const latin = newsQueryTerms('OpenAI GPT-4 release');
  for (const term of ['openai', 'gpt-4', 'release']) assert.equal(latin.has(term), true, term);
  const cjk = newsQueryTerms('英伟达 财报');
  for (const term of ['英伟', '伟达', '财报']) assert.equal(cjk.has(term), true, term);
  assert.equal(cjk.has('英伟达'), false);
});

test('news relevance scoring explains navigational, empty, redirect, date and query signals', () => {
  const root = scoreNewsRelevance(NAVIGATIONAL_ROOT, 'anything');
  assert.ok(root.reasons.includes('navigational_root'));
  assert.ok(root.score < 0);

  const article = scoreNewsRelevance(normalized({
    url: 'https://publisher.example/2026/10/09/story',
    title: 'Market update',
    temporal_evidence: [
      { kind: 'published_at', value: '2026-10-09T01:00:00.000Z', on: '2026-10-09', precision: 'instant', source: 'searxng.result.publishedDate' },
      { kind: 'retrieved_at', value: '2026-10-09T02:00:00.000Z', source: 'gateway.clock' },
    ],
  }), 'market');
  assert.ok(article.reasons.includes('article_path'));
  assert.ok(article.reasons.includes('publisher_instant'));
  assert.ok(article.score > 0);

  const empty = scoreNewsRelevance(normalized({ content: '' }), 'x');
  assert.ok(empty.reasons.includes('empty_snippet'));

  const redirect = scoreNewsRelevance(normalized({
    url: 'https://aggregator.example/link?url=https%3A%2F%2Fpublisher.example%2Fstory',
    content: 'A snippet',
  }), 'x');
  assert.ok(redirect.reasons.includes('redirect_wrapper'));

  const navigationalSnippet = scoreNewsRelevance(normalized({ url: 'https://social.example/openai/', content: 'Link to social.example' }), 'openai');
  assert.ok(navigationalSnippet.reasons.includes('navigational_snippet'));

  const titleMatch = scoreNewsRelevance(normalized({ title: '英伟达财报速递', url: 'https://p.example/news/1' }), '英伟达 财报');
  assert.ok(titleMatch.reasons.includes('title_match'));

  const undated = scoreNewsRelevance(normalized({ url: 'https://p.example/news/1' }), 'zzzq');
  assert.ok(undated.reasons.includes('undated'));
});

test('rankNewsResults is a stable reorder that never drops or adds a result', () => {
  const first = normalized({ url: 'https://a.example/one', title: 'Alpha' });
  const second = normalized({ url: 'https://b.example/two', title: 'Beta' });
  const ranked = rankNewsResults([NAVIGATIONAL_ROOT, first, second], 'query');
  assert.equal(ranked.length, 3);
  assert.deepEqual(ranked.map(item => item.url).sort(), [NAVIGATIONAL_ROOT, first, second].map(item => item.url).sort());
  assert.equal(ranked.at(-1).url, NAVIGATIONAL_ROOT.url, 'navigational root is demoted to the tail');
  // Equal-scoring results keep their original relative order (stable sort).
  assert.deepEqual(ranked.slice(0, 2).map(item => item.url), [first.url, second.url]);
});

test('news mode reorders through the search contract without changing the result set', async () => {
  const body = {
    results: [
      { title: 'Site home', url: 'https://home.example/', content: 'Welcome', engine: 'yandex' },
      { title: 'Detailed report', url: 'https://publisher.example/2026/10/09/report', content: 'The full story', engine: 'yandex' },
    ],
    number_of_results: 2,
  };
  const news = await fixtureSearch(body, { query: 'report', categories: 'news' });
  assert.equal(news.news_mode, true);
  assert.equal(news.results[0].url, 'https://publisher.example/2026/10/09/report');
  assert.equal(news.results.at(-1).url, 'https://home.example/');
  assert.equal(news.news_ranking.total, 2);
  assert.equal(typeof news.news_ranking.moved, 'number');

  const normal = await fixtureSearch(body, { query: 'report' });
  assert.equal(Object.hasOwn(normal, 'news_mode'), false);
  assert.equal(normal.results[0].url, 'https://home.example/', 'normal mode keeps engine order');
  assert.deepEqual(
    new Set(news.results.map(item => item.url)),
    new Set(normal.results.map(item => item.url)),
    'news mode must not drop or add results (no recall loss)',
  );

  const forcedOff = await fixtureSearch(body, { query: 'report', categories: 'news' }, { newsMode: false });
  assert.equal(Object.hasOwn(forcedOff, 'news_mode'), false);
});

test('news mode preserves category, engine and source fields on every result', async () => {
  const body = {
    results: [{ title: 'Report', url: 'https://publisher.example/2026/10/09/report', content: 'The full story', engine: 'quark', category: 'news' }],
    number_of_results: 1,
  };
  const news = await fixtureSearch(body, { query: 'report', categories: 'news' });
  const item = news.results[0];
  assert.equal(item.category, 'news');
  assert.equal(item.engine, 'quark');
  assert.equal(item.source.host, 'publisher.example');
  assert.equal(item.source.search_engine, 'quark');
  assert.equal(item.url, 'https://publisher.example/2026/10/09/report');
});

test('news mode keeps the multi-source dedup evidence instead of dropping the extra engine', async () => {
  const body = {
    results: [
      { title: 'Short', url: 'https://publisher.example/story?utm_source=news#top', content: 'Short', engine: 'quark' },
      { title: 'Full story', url: 'https://publisher.example/story', content: 'A much longer and fuller summary of the story.', engine: 'yandex' },
      { title: 'Other', url: 'https://publisher.example/other', content: 'Other body', engine: 'quark' },
    ],
    number_of_results: 3,
  };
  const news = await fixtureSearch(body, { query: 'story', categories: 'news' });
  assert.equal(news.results.length, 2, 'normalized duplicate URLs are merged');
  assert.equal(news.dedup.raw_results, 3);
  assert.equal(news.dedup.unique_urls, 2);
  assert.equal(news.dedup.merged, 1);
  assert.equal(news.dedup.multi_source, 1);
  const merged = news.dedup.sources.find(item => item.url === 'https://publisher.example/story');
  assert.deepEqual(merged.engines, ['quark', 'yandex']);
});

test('ranked and legacy true never invoke page verification, while verified is bounded and serial', async () => {
  const body = { results: [
    { title: 'One', url: 'https://one.example/story', content: 'One', engine: 'a' },
    { title: 'Two', url: 'https://two.example/story', content: 'Two', engine: 'b' },
  ], number_of_results: 2 };
  let calls = 0;
  const verifyPage = async candidate => {
    calls++;
    assert.equal(candidate.url, calls === 1 ? 'https://one.example/story' : 'https://two.example/story');
    return { temporal_evidence: [{ kind: 'published_at', value: '2026-10-10T01:00:00.000Z', precision: 'instant', source: 'html.meta.datePublished' }], source: { url: candidate.url } };
  };
  const ranked = await fixtureSearch(body, { query: 'story', news_mode: 'ranked' }, { verifyPage, newsMode: 'ranked' });
  assert.equal(calls, 0);
  assert.equal(ranked.news_mode, true);
  const legacy = await fixtureSearch(body, { query: 'story', news_mode: true }, { verifyPage, newsMode: true });
  assert.equal(calls, 0);
  assert.equal(legacy.news_mode, true);
  const verified = await fixtureSearch(body, { query: 'story', news_mode: 'verified', news_min_sources: 1, news_max_reads: 1 }, { verifyPage, now: '2026-10-10T02:00:00.000Z' });
  assert.equal(calls, 1);
  assert.equal(verified.news_verification.mode, 'verified');
  assert.equal(verified.news_verification.time_range_is_discovery_hint, true);
  assert.equal(verified.news_verification.status, 'verified');
  assert.equal(verified.results.length, 1);
  assert.equal(verified.results[0].news_evidence.status, 'verified');
});

function precisionAt5(results, labels) {
  const top = results.slice(0, 5);
  if (top.length === 0) return null;
  return top.filter(item => labels.get(item.url) === 'relevant').length / top.length;
}

test('paired real labelled samples: news ranking keeps recall and does not lower Precision@5', async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(moduleDir, 'fixtures', 'news-mode-samples.json'), 'utf8'));
  let beforeSum = 0;
  let afterSum = 0;
  let improved = 0;
  for (const sample of fixture.samples) {
    const labels = new Map(sample.results.map(item => [item.url, item.label]));
    const body = { results: sample.results.map(item => ({ ...item })), number_of_results: sample.results.length };
    const normal = await fixtureSearch(body, { query: sample.query });
    const news = await fixtureSearch(body, { query: sample.query, categories: 'news' });
    const before = precisionAt5(normal.results, labels);
    const after = precisionAt5(news.results, labels);
    assert.deepEqual(
      new Set(news.results.map(item => item.url)),
      new Set(normal.results.map(item => item.url)),
      `${sample.id}: news mode must not change the result set`,
    );
    assert.ok(after >= before, `${sample.id}: Precision@5 regressed (${before} -> ${after})`);
    if (after > before) improved++;
    beforeSum += before;
    afterSum += after;
  }
  assert.ok(improved >= 1, 'at least one labelled sample must improve');
  assert.ok(afterSum > beforeSum, `mean Precision@5 must improve (${beforeSum} -> ${afterSum})`);
});
