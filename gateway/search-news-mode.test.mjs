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

// ---------------------------------------------------------------------------------------------
// SPEC #78 stage C P0 regressions: recall/read accounting, fail-closed source diagnostics,
// read_failure vs unread, and the news_render=auto posture.
// ---------------------------------------------------------------------------------------------

const WINDOW_NOW = '2026-10-10T02:00:00.000Z';
const FRESH = '2026-10-10T01:00:00.000Z';
const STALE = '2026-10-08T01:00:00.000Z';

function candidateBody(count) {
  return {
    results: Array.from({ length: count }, (_, index) => ({
      title: `Report ${index + 1}`,
      url: `https://publisher${index + 1}.example/2026/10/10/report-${index + 1}`,
      content: `The full story number ${index + 1}.`,
      engine: 'yandex',
      category: 'news',
    })),
    number_of_results: count,
  };
}

// A page fixture carrying a publisher-declared instant, i.e. the only evidence that may verify.
function publishedPage(url, value) {
  return {
    source: { url, host: new URL(url).hostname },
    temporal_evidence: [{ kind: 'published_at', value, on: value.slice(0, 10), precision: 'instant', source: 'html.meta[property="article:published_time"]' }],
  };
}

test('verified mode reports the full recall set, the bounded read attempts and returns only verified results', async () => {
  const body = candidateBody(5);
  const readOrder = [];
  // Four of the five candidates fit the read budget: two fresh, one stale, one with no publisher date.
  const plan = [FRESH, FRESH, STALE, null];
  const verifyPage = async candidate => {
    readOrder.push(candidate.url);
    const value = plan[readOrder.length - 1];
    return value ? publishedPage(candidate.url, value) : { source: { url: candidate.url }, temporal_evidence: [] };
  };

  const result = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_min_sources: 1, news_max_reads: 4 }, { verifyPage, now: WINDOW_NOW });
  const summary = result.news_verification;

  // candidate_count is the full recall set — never the news_max_reads-truncated attempt count.
  assert.equal(summary.candidate_count, 5);
  assert.equal(summary.read_attempts, 4);
  assert.equal(summary.unread_count, 1, 'the candidate the budget never reached is unread');
  assert.equal(readOrder.length, 4);
  assert.equal(summary.verified_count, 2);
  assert.equal(summary.stale_count, 1);
  assert.equal(summary.unknown_count, 1, 'a page with no publisher date is unknown, not unread');
  assert.equal(summary.read_failure_count, 0);
  assert.equal(summary.status, 'verified');

  // SPEC #78 §5.8: only verified results are returned; stale/unknown/unread are counts.
  assert.equal(result.results.length, 2);
  for (const item of result.results) {
    assert.equal(item.news_evidence.status, 'verified');
    assert.equal(item.news_evidence.published_at, FRESH);
  }
  const returned = new Set(result.results.map(item => item.url));
  assert.deepEqual(returned, new Set(body.results.slice(0, 2).map(item => item.url)));

  // Zero reads is a legitimate budget: the whole recall set is unread, nothing is judged date-less.
  const noReads = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_max_reads: 0 }, { verifyPage, now: WINDOW_NOW });
  assert.equal(noReads.news_verification.candidate_count, 5);
  assert.equal(noReads.news_verification.read_attempts, 0);
  assert.equal(noReads.news_verification.unread_count, 5);
  assert.equal(noReads.news_verification.status, 'no_verified_result');
  assert.deepEqual(noReads.results, []);
});

test('supplemental sources keep an independent source_failures list that no budget can drop or overwrite', async () => {
  const body = candidateBody(3);
  let calls = 0;
  const verifyPage = async candidate => { calls++; return publishedPage(candidate.url, FRESH); };

  // news_max_reads=0 must not silently discard the fail-closed diagnostic of an unwired catalog.
  const feeds = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'feeds', news_max_reads: 0 }, { verifyPage, now: WINDOW_NOW });
  assert.deepEqual(feeds.news_verification.source_failures, [{ source: 'feeds', code: 'catalog_empty', retryable: false }]);
  assert.equal(feeds.news_verification.read_attempts, 0);
  assert.equal(feeds.news_verification.candidate_count, 3);
  assert.equal(feeds.news_verification.unread_count, 3);
  assert.equal(feeds.news_verification.status, 'no_verified_result');
  assert.deepEqual(feeds.news_verification.read_failures, []);
  assert.deepEqual(feeds.results, []);

  const gdelt = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'gdelt', news_max_reads: 0 }, { verifyPage, now: WINDOW_NOW });
  assert.deepEqual(gdelt.news_verification.source_failures, [{ source: 'gdelt', code: 'gdelt_unavailable', retryable: false }]);

  // hybrid reports both supplemental sources: the second failure must not overwrite the first.
  const hybrid = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'hybrid', news_max_reads: 0 }, { verifyPage, now: WINDOW_NOW });
  assert.deepEqual(hybrid.news_verification.source_failures, [
    { source: 'feeds', code: 'catalog_empty', retryable: false },
    { source: 'gdelt', code: 'gdelt_unavailable', retryable: false },
  ]);
  assert.equal(hybrid.news_verification.read_attempts, 0);
  assert.equal(calls, 0, 'a source with no wired candidate catalog never reads pages');

  // With a budget, hybrid still verifies its SearXNG recall: a missing supplemental source is a
  // diagnostic, not a reason to hide results the recall path can actually prove.
  const hybridRead = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'hybrid', news_min_sources: 1, news_max_reads: 1 }, { verifyPage, now: WINDOW_NOW });
  assert.equal(hybridRead.news_verification.source_failures.length, 2);
  assert.equal(hybridRead.news_verification.read_attempts, 1);
  assert.equal(hybridRead.news_verification.verified_count, 1);
  assert.equal(hybridRead.results.length, 1);
  assert.equal(calls, 1);

  // A verified request with no reachable candidate reader fails closed as well.
  const noReader = await fixtureSearch(body, { query: 'report', news_mode: 'verified' });
  assert.equal(noReader.news_verification.read_attempts, 0);
  assert.deepEqual(noReader.news_verification.source_failures, [{ source: 'read', code: 'verify_unavailable', retryable: false }]);
  assert.deepEqual(noReader.results, []);
});

test('verified mode separates an attempted read failure from the unread budget and keeps only a safe error kind', async () => {
  const body = candidateBody(4);
  const attempted = [];
  const verifyPage = async candidate => {
    attempted.push(candidate.url);
    if (attempted.length === 1) throw Object.assign(new Error(`BACKEND-TOKEN-SECRET for ${candidate.url}`), { kind: 'blocked_by_robots', code: 'robot_challenge' });
    return { source: { url: candidate.url }, temporal_evidence: [] };
  };

  const result = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_max_reads: 2 }, { verifyPage, now: WINDOW_NOW });
  const summary = result.news_verification;
  assert.equal(summary.read_attempts, 2);
  assert.equal(summary.read_failure_count, 1, 'an attempted read that failed is a read_failure');
  assert.equal(summary.unknown_count, 1);
  assert.equal(summary.unread_count, 2, 'the budget tail stays unread instead of being blamed on the page');
  assert.equal(summary.status, 'no_verified_result');
  assert.deepEqual(result.results, []);
  assert.deepEqual(summary.read_failures, [{ url: body.results[0].url, error_kind: 'blocked_by_robots', error_code: 'robot_challenge' }]);
  assert.equal(JSON.stringify(summary).includes('BACKEND-TOKEN-SECRET'), false, 'an upstream message never reaches the response');

  // A non-token-shaped kind is replaced rather than echoed (no path traversal or message leak).
  const unsafe = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_max_reads: 1 }, {
    verifyPage: async () => { throw Object.assign(new Error('secret body'), { kind: '../../etc/passwd' }); },
    now: WINDOW_NOW,
  });
  assert.deepEqual(unsafe.news_verification.read_failures, [{ url: body.results[0].url, error_kind: 'read_error', error_code: null }]);
  assert.equal(unsafe.news_verification.read_failure_count, 1);
  assert.equal(JSON.stringify(unsafe).includes('secret body'), false);
});

test('news_render=auto fails closed instead of silently reading through the lightweight path', async () => {
  const body = candidateBody(3);
  let calls = 0;
  const verifyPage = async candidate => { calls++; return publishedPage(candidate.url, FRESH); };

  const lightweight = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_min_sources: 1, news_max_reads: 3, news_render: 'never' }, { verifyPage, now: WINDOW_NOW });
  assert.equal(lightweight.news_verification.render, 'never');
  assert.equal(lightweight.news_verification.read_attempts, 3);
  assert.equal(lightweight.results.length, 3);
  assert.equal(calls, 3);

  calls = 0;
  const auto = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_min_sources: 1, news_max_reads: 3, news_render: 'auto' }, { verifyPage, now: WINDOW_NOW });
  assert.equal(calls, 0, 'auto is never answered by the lightweight reader it did not ask for');
  assert.equal(auto.news_verification.render, 'auto');
  assert.equal(auto.news_verification.read_attempts, 0);
  assert.equal(auto.news_verification.unread_count, 3);
  assert.equal(auto.news_verification.status, 'no_verified_result');
  assert.deepEqual(auto.results, []);
  assert.ok(
    auto.news_verification.source_failures.some(item => item.source === 'render' && item.code === 'render_auto_unsupported' && item.retryable === false),
    'the unsupported render posture is reported instead of being ignored',
  );
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

// ---------------------------------------------------------------------------------------------
// SPEC #78 stage D: GDELT discovery supplies candidates only — a page still has to prove itself.
// ---------------------------------------------------------------------------------------------

const GDELT_SEEN = '2026-10-10T01:00:00.000Z';

function gdeltCandidate(url, extra = {}) {
  return { url, title: `GDELT ${url}`, domain: new URL(url).hostname.toLowerCase(), seen_at: extra.seen_at ?? GDELT_SEEN, seen_on: (extra.seen_at ?? GDELT_SEEN).slice(0, 10) };
}

// A discovery client stub. Records the invocation payload so the test can prove the resolved window
// is passed through and the search ran exactly once.
function gdeltClient(candidates = [], { failure = null } = {}) {
  const calls = [];
  const discoverGdelt = async payload => {
    calls.push(payload);
    return failure ? { candidates: [], source_failure: failure } : { candidates };
  };
  discoverGdelt.calls = calls;
  return discoverGdelt;
}

test('gdelt-only reads the discovered candidates and never the SearXNG recall', async () => {
  const body = candidateBody(3);
  const discoverGdelt = gdeltClient([gdeltCandidate('https://gdelt.one.example/a'), gdeltCandidate('https://gdelt.two.example/b')]);
  const reads = [];
  // Neither discovered page declares a publisher date: nothing may become verified on GDELT time.
  const verifyPage = async candidate => { reads.push(candidate.url); return { source: { url: candidate.url }, temporal_evidence: [] }; };

  const result = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'gdelt', news_max_reads: 8 }, { verifyPage, now: WINDOW_NOW, discoverGdelt });
  const summary = result.news_verification;

  assert.equal(discoverGdelt.calls.length, 1);
  assert.equal(discoverGdelt.calls[0].query, 'report');
  assert.equal(discoverGdelt.calls[0].window.window, 'rolling_24h');
  assert.deepEqual(summary.source_failures, [], 'a successful discovery reports no source failure');
  // The recall set is the two GDELT candidates only — the three SearXNG results are not GDELT candidates.
  assert.equal(summary.candidate_count, 2);
  assert.equal(summary.read_attempts, 2);
  assert.deepEqual(reads.sort(), ['https://gdelt.one.example/a', 'https://gdelt.two.example/b']);
  assert.equal(summary.unknown_count, 2, 'a page without publisher evidence is unknown, not verified');
  assert.equal(summary.status, 'no_verified_result');
  assert.deepEqual(result.results, []);
});

test('a GDELT candidate verifies only through its page publisher date, never its seendate', async () => {
  const body = candidateBody(2);
  const url = 'https://gdelt.one.example/a';
  const discoverGdelt = gdeltClient([gdeltCandidate(url)]);

  // 1. The page exposes only a GDELT-labelled date: it is discovery-only and cannot verify.
  const gdeltOnly = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'gdelt', news_min_sources: 1, news_max_reads: 1 }, {
    now: WINDOW_NOW,
    discoverGdelt,
    verifyPage: async candidate => ({ source: { url: candidate.url }, temporal_evidence: [{ kind: 'published_at', value: FRESH, on: '2026-10-10', precision: 'instant', source: 'gdelt.seendate' }] }),
  });
  assert.equal(gdeltOnly.news_verification.status, 'no_verified_result');
  assert.deepEqual(gdeltOnly.results, []);

  // 2. A genuine page publisher instant on the same URL does verify.
  const proven = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'gdelt', news_min_sources: 1, news_max_reads: 1 }, {
    now: WINDOW_NOW,
    discoverGdelt,
    verifyPage: async candidate => publishedPage(candidate.url, FRESH),
  });
  assert.equal(proven.news_verification.status, 'verified');
  assert.equal(proven.results.length, 1);
  assert.equal(proven.results[0].url, url);
  assert.equal(proven.results[0].news_evidence.status, 'verified');
  assert.equal(proven.results[0].news_evidence.published_at, FRESH);
});

test('a GDELT source failure is one independent entry and hybrid still verifies the SearXNG recall', async () => {
  const body = candidateBody(2);

  // gdelt-only outage: the failure is recorded, nothing is invented, and zero pages are read.
  let calls = 0;
  const verifyPage = async candidate => { calls++; return publishedPage(candidate.url, FRESH); };
  const outage = gdeltClient([], { failure: { source: 'gdelt', code: 'timeout', retryable: false } });
  const gdelt = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'gdelt', news_min_sources: 1, news_max_reads: 4 }, { verifyPage, now: WINDOW_NOW, discoverGdelt: outage });
  assert.deepEqual(gdelt.news_verification.source_failures, [{ source: 'gdelt', code: 'timeout', retryable: false }]);
  assert.equal(gdelt.news_verification.read_attempts, 0);
  assert.deepEqual(gdelt.results, []);
  assert.equal(calls, 0, 'a failed discovery never reads a page');

  // hybrid: the GDELT failure must not hide or block the SearXNG recall, and stays a single entry.
  const hybrid = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'hybrid', news_min_sources: 1, news_max_reads: 2 }, { verifyPage, now: WINDOW_NOW, discoverGdelt: outage });
  assert.deepEqual(hybrid.news_verification.source_failures, [
    { source: 'feeds', code: 'catalog_empty', retryable: false },
    { source: 'gdelt', code: 'timeout', retryable: false },
  ]);
  assert.equal(hybrid.news_verification.read_attempts, 2);
  assert.equal(hybrid.news_verification.verified_count, 2);
  assert.equal(hybrid.results.length, 2);
  assert.equal(calls, 2);

  // A throwing discovery client is contained as a single fail-closed entry as well.
  const throwing = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'gdelt' }, {
    verifyPage, now: WINDOW_NOW,
    discoverGdelt: async () => { throw new Error('backend down'); },
  });
  assert.deepEqual(throwing.news_verification.source_failures, [{ source: 'gdelt', code: 'gdelt_unavailable', retryable: false }]);
});

test('hybrid appends GDELT candidates after the recall set and dedups URLs the recall already covers', async () => {
  const body = candidateBody(2);
  // One discovered URL is already in the recall (with a tracking param → same normalized URL); the
  // other is genuinely new.
  const discoverGdelt = gdeltClient([
    gdeltCandidate(`${body.results[0].url}?utm_source=gdelt`),
    gdeltCandidate('https://gdelt.extra.example/c'),
  ]);
  const reads = [];
  const verifyPage = async candidate => { reads.push(candidate.url); return publishedPage(candidate.url, FRESH); };

  const result = await fixtureSearch(body, { query: 'report', news_mode: 'verified', news_source: 'hybrid', news_min_sources: 1, news_max_reads: 8 }, { verifyPage, now: WINDOW_NOW, discoverGdelt });
  const summary = result.news_verification;

  // 2 recalled + 1 new = 3 candidates (the duplicate-with-tracking-param is collapsed).
  assert.equal(summary.candidate_count, 3);
  assert.equal(summary.read_attempts, 3);
  assert.equal(summary.verified_count, 3);
  assert.equal(summary.distinct_publishers, 3);
  assert.equal(summary.status, 'verified');
  assert.equal(reads[0], body.results[0].url, 'the recall set is read before the supplemental GDELT candidates');
  assert.equal(reads.at(-1), 'https://gdelt.extra.example/c');
  assert.equal(result.results.length, 3);
});
