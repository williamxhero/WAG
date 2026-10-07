import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchParams, searchSearxng } from './search.mjs';

async function searchFixture(bodies, input = { query: 'example' }) {
  const requests = [];
  const result = await searchSearxng({
    baseUrl: 'http://searxng.test/',
    input,
    fetchImpl: async url => {
      requests.push(new URL(url));
      assert.notEqual(bodies.length, 0, 'search must not make an extra attempt');
      return { ok: true, json: async () => bodies.shift() };
    },
  });
  assert.equal(bodies.length, 0);
  return { result, requests };
}

test('search parameters preserve filters and map page to SearXNG pageno', () => {
  const params = buildSearchParams({
    query: 'gold price',
    categories: 'news',
    engines: 'google,bing',
    language: 'en',
    time_range: 'day',
    page: 2,
  });
  assert.equal(params.get('q'), 'gold price');
  assert.equal(params.get('categories'), 'news');
  assert.equal(params.get('engines'), 'google,bing');
  assert.equal(params.get('language'), 'en');
  assert.equal(params.get('time_range'), 'day');
  assert.equal(params.get('pageno'), '2');

  const relaxed = buildSearchParams({ query: 'gold price', time_range: 'day' }, { relaxed: true });
  assert.equal(relaxed.has('time_range'), false);
});

test('empty search retries once without time range and exposes unresponsive engines', async () => {
  const requests = [];
  const bodies = [
    { results: [], number_of_results: 0, unresponsive_engines: [['google', 'timeout']] },
    { results: [{ title: 'Gold', url: 'https://example.com/2026/10/02/gold', content: 'Summary', engine: 'bing' }], number_of_results: 1, unresponsive_engines: [['brave', 'blocked']] },
  ];
  const result = await searchSearxng({
    baseUrl: 'http://searxng.test/',
    input: { query: 'gold price', time_range: 'day' },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => bodies.shift() };
    },
  });

  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /time_range=day/);
  assert.doesNotMatch(requests[1].url, /time_range=/);
  assert.equal(result.attempts, 2);
  assert.equal(result.number_of_results, 1);
  assert.deepEqual(result.unresponsive_engines, [['brave', 'blocked']]);
  assert.equal(result.results[0].published_on, '2026-10-02');
  assert.equal(result.results[0].precision, 'day');
  assert.equal(typeof result.stages_ms.search_retry_ms, 'number');
});

test('non-empty search does not retry and forwards unresponsive engines', async () => {
  let calls = 0;
  const result = await searchSearxng({
    baseUrl: 'http://searxng.test',
    input: { query: 'example' },
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => ({ results: [{ title: 'One', url: 'https://example.com/one', content: 'Text' }], unresponsive_engines: [] }) };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.unresponsive_engines, []);
  assert.equal(result.stages_ms.search_retry_ms, undefined);
});

test('fallback diagnostics do not inherit failures when the selected response omits them', async () => {
  const bodies = [
    { results: [], unresponsive_engines: [['google', 'timeout']] },
    { results: [{ title: 'Selected', url: 'https://example.com/selected', content: 'Selected evidence' }] },
  ];
  const result = await searchSearxng({
    baseUrl: 'http://searxng.test',
    input: { query: 'example' },
    fetchImpl: async () => ({ ok: true, json: async () => bodies.shift() }),
  });

  assert.equal(result.attempts, 2);
  assert.equal(result.results[0].title, 'Selected');
  assert.equal(Object.hasOwn(result, 'unresponsive_engines'), false);
});

test('backend HTTP errors retain a typed search error', async () => {
  await assert.rejects(
    searchSearxng({
      baseUrl: 'http://searxng.test',
      input: { query: 'example' },
      fetchImpl: async () => ({ ok: false, status: 503 }),
    }),
    error => error.kind === 'search_backend_status' && error.httpStatus === 503,
  );
});

test('normal selected engine failures and backend result count are preserved', async () => {
  const { result, requests } = await searchFixture([{
    results: [{ title: 'Gold', url: 'https://example.com/gold', content: 'Evidence', engine: 'bing' }],
    number_of_results: 42,
    unresponsive_engines: [['google', 'timeout'], ['brave', 'blocked']],
  }]);
  assert.equal(requests.length, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.number_of_results, 42);
  assert.deepEqual(result.unresponsive_engines, [['google', 'timeout'], ['brave', 'blocked']]);
});

test('normal selected response may omit engine diagnostics', async () => {
  const { result } = await searchFixture([{
    results: [{ title: 'Gold', url: 'https://example.com/gold', content: 'Evidence' }],
  }]);
  assert.equal(result.number_of_results, 1);
  assert.equal(Object.hasOwn(result, 'unresponsive_engines'), false);
});

test('an empty selected diagnostic array clears discarded engine failures', async () => {
  const { result } = await searchFixture([
    { results: [], unresponsive_engines: [['google', 'timeout']] },
    { results: [{ title: 'Gold', url: 'https://example.com/gold', content: 'Evidence' }], unresponsive_engines: [] },
  ]);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.unresponsive_engines, []);
});

test('fallback preserves query, explicit engines, categories, language and page', async () => {
  const { result, requests } = await searchFixture([
    { results: [] },
    { results: [{ title: 'Gold', url: 'https://example.com/gold', content: 'Evidence' }], number_of_results: 42 },
  ], { query: 'gold & 银价', categories: 'news', engines: 'google,bing', language: 'zh-CN', time_range: 'year', page: 3 });
  assert.deepEqual(requests.map(url => url.pathname), ['/search', '/search']);
  assert.deepEqual(Object.fromEntries(requests[0].searchParams), {
    q: 'gold & 银价', format: 'json', categories: 'news', engines: 'google,bing', language: 'zh-CN', time_range: 'year', pageno: '3',
  });
  assert.deepEqual(Object.fromEntries(requests[1].searchParams), {
    q: 'gold & 银价', format: 'json', categories: 'news', engines: 'google,bing', language: 'zh-CN', pageno: '3',
  });
  assert.equal(result.number_of_results, 42);
  assert.equal(typeof result.stages_ms.search_ms, 'number');
  assert.equal(typeof result.stages_ms.search_retry_ms, 'number');
});

test('two empty searches stop after one fallback and retain selected diagnostics', async () => {
  const { result, requests } = await searchFixture([
    { results: [], unresponsive_engines: [['google', 'timeout']] },
    { results: [], unresponsive_engines: [['bing', 'blocked']] },
  ]);
  assert.equal(requests.length, 2);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.results, []);
  assert.equal(result.number_of_results, 0);
  assert.deepEqual(result.unresponsive_engines, [['bing', 'blocked']]);
});

test('search deduplicates URL evidence before applying the 20-result cap', async () => {
  const { result, requests } = await searchFixture([{
    results: [
      { title: 'Short', url: 'https://example.com/0?utm_source=search#snippet', content: 'Short' },
      ...Array.from({ length: 23 }, (_, index) => ({ title: `Result ${index}`, url: `https://example.com/${index}`, content: 'Fuller evidence from the publisher', engine: 'bing' })),
    ],
    number_of_results: 123,
  }]);
  assert.equal(requests.length, 1);
  assert.equal(result.results.length, 20);
  assert.equal(result.number_of_results, 123);
  assert.equal(result.results[0].url, 'https://example.com/0');
  assert.equal(result.results[0].title, 'Result 0');
  assert.equal(result.results.at(-1).url, 'https://example.com/19');
  assert.equal(result.results[0].source.host, 'example.com');
  assert.equal(result.results[0].retrieved_at, result.results[0].temporal_evidence.at(-1).value);
});

for (const results of [undefined, null, { unexpected: true }]) {
  test(`a malformed ${results === undefined ? 'missing' : results === null ? 'null' : 'object'} results field triggers the existing fallback`, async () => {
    const { result, requests } = await searchFixture([
      { results, unresponsive_engines: [['google', 'timeout']] },
      { results: [{ title: 'Selected', url: 'https://example.com/selected', content: 'Selected evidence' }], unresponsive_engines: [] },
    ]);
    assert.equal(requests.length, 2);
    assert.equal(result.results[0].title, 'Selected');
    assert.deepEqual(result.unresponsive_engines, []);
  });
}

test('malformed selected results normalize to an empty list without another retry', async () => {
  const { result } = await searchFixture([
    { results: [] },
    { results: { unexpected: true }, unresponsive_engines: [['bing', 'blocked']] },
  ]);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.results, []);
  assert.equal(result.number_of_results, 0);
  assert.deepEqual(result.unresponsive_engines, [['bing', 'blocked']]);
});

test('invalid backend JSON fails rather than falling back to apparent success', async () => {
  const parseError = new SyntaxError('invalid backend JSON');
  let calls = 0;
  await assert.rejects(searchSearxng({
    baseUrl: 'http://searxng.test',
    input: { query: 'example' },
    fetchImpl: async () => {
      calls++;
      return { ok: true, json: async () => { throw parseError; } };
    },
  }), error => error === parseError);
  assert.equal(calls, 1);
});

test('a failed fallback retains its HTTP error instead of returning the discarded empty response', async () => {
  let calls = 0;
  await assert.rejects(searchSearxng({
    baseUrl: 'http://searxng.test',
    input: { query: 'example' },
    fetchImpl: async () => ++calls === 1
      ? { ok: true, json: async () => ({ results: [] }) }
      : { ok: false, status: 503 },
  }), error => error.kind === 'search_backend_status' && error.httpStatus === 503);
  assert.equal(calls, 2);
});

test('initial search and fallback share one caller deadline and cancellation', async () => {
  const controller = new AbortController();
  const deadline = new Error('shared search deadline');
  const signals = [];
  await assert.rejects(searchSearxng({
    baseUrl: 'http://searxng.test',
    input: { query: 'example', time_range: 'day' },
    signal: controller.signal,
    fetchImpl: async (_url, { signal }) => {
      signals.push(signal);
      if (signals.length === 1) return { ok: true, json: async () => ({ results: [] }) };
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        controller.abort(deadline);
      });
    },
  }), error => error === deadline);
  assert.deepEqual(signals, [controller.signal, controller.signal]);
});
