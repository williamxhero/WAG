import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchParams, searchSearxng } from './search.mjs';

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
