import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSearchParams, searchSearxng } from './search.mjs';

async function strictSearch(bodies, input, options = {}) {
  const requests = [];
  const result = await searchSearxng({
    baseUrl: 'http://searxng.test/',
    input,
    timeWindowStrict: options.timeWindowStrict,
    fetchImpl: async url => {
      requests.push(new URL(url));
      assert.notEqual(bodies.length, 0, 'search must not make an extra attempt');
      return { ok: true, json: async () => bodies.shift() };
    },
  });
  assert.equal(bodies.length, 0, 'every fixture response must be consumed');
  return { result, requests };
}

test('the strict opt-in never leaks into the SearXNG query string', () => {
  const params = buildSearchParams({ query: '英伟达', time_range: 'day', time_window_strict: true });
  assert.equal(params.get('time_range'), 'day');
  assert.equal(params.has('time_window_strict'), false);
});

test('strict + time_range keeps the filter on an empty result instead of retrying without it', async () => {
  const { result, requests } = await strictSearch(
    [{ results: [], number_of_results: 0, unresponsive_engines: [['quark', 'captcha']] }],
    { query: '全球 市场 最新 新闻', language: 'zh-CN', time_range: 'day' },
    { timeWindowStrict: true },
  );
  assert.equal(requests.length, 1, 'strict mode must not fire the relax-retry');
  assert.match(requests[0].search, /time_range=day/);
  assert.equal(result.attempts, 1);
  assert.deepEqual(result.results, []);
  assert.equal(result.time_range, 'day');
  assert.equal(result.time_range_applied, true);
  assert.equal(result.time_range_enforced, false);
  assert.equal(result.time_window_strict, true);
  assert.match(result.time_range_note, /strict time_range 'day'; no results were returned and the filter was not relaxed/);
});

test('compatible (non-strict) mode still drops the filter and retries on an empty result', async () => {
  const { result, requests } = await strictSearch(
    [
      { results: [], number_of_results: 0 },
      { results: [{ title: 'Fresh', url: 'https://example.org/fresh', content: 'body', engine: 'yandex', publishedDate: new Date(Date.now() - 3_600_000).toISOString() }] },
    ],
    { query: '英伟达', time_range: 'day' },
  );
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(url => url.searchParams.has('time_range')), [true, false]);
  assert.equal(result.time_range_applied, false);
  assert.equal(Object.hasOwn(result, 'time_window_strict'), false);
  assert.match(result.time_range_note, /empty-result retry dropped it/);
});

test('strict freshness only trusts a publisher instant, not URL or timezone-less dates', async () => {
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const { result } = await strictSearch(
    [{
      results: [
        { title: 'Publisher instant', url: 'https://example.org/a', content: 'body', engine: 'yandex', publishedDate: recent },
        { title: 'Old publisher instant', url: 'https://example.org/b', content: 'body', engine: 'yandex', publishedDate: '2024-11-28T10:35:33+09:00' },
        { title: 'URL-only date', url: 'https://example.org/2020/01/02/news', content: 'body', engine: 'yandex' },
        { title: 'Date-only no timezone', url: 'https://example.org/d', content: 'body', engine: 'yandex', publishedDate: '2026-10-08' },
        { title: 'Timezone-less instant', url: 'https://example.org/e', content: 'body', engine: 'yandex', publishedDate: '2026-10-08T05:58:00' },
        { title: 'Future instant', url: 'https://example.org/f', content: 'body', engine: 'yandex', publishedDate: future },
        { title: 'Undated', url: 'https://example.org/g', content: 'body', engine: 'yandex' },
      ],
    }],
    { query: '英伟达', time_range: 'day' },
    { timeWindowStrict: true },
  );
  assert.deepEqual(
    result.results.map(item => item.time_range_status),
    ['within', 'outside', 'unverified', 'unverified', 'unverified', 'unverified', 'unverified'],
  );
  assert.equal(result.time_range_enforced, false);
});

test('strict mode is enforced only when every returned result is publisher-proven within the window', async () => {
  const recent = new Date(Date.now() - 3_600_000).toISOString();
  const { result } = await strictSearch(
    [{ results: [{ title: 'Fresh', url: 'https://example.org/news/fresh', content: 'body', engine: 'yandex', publishedDate: recent }] }],
    { query: '英伟达', time_range: 'day' },
    { timeWindowStrict: true },
  );
  assert.equal(result.time_window_strict, true);
  assert.equal(result.time_range_applied, true);
  assert.equal(result.time_range_enforced, true);
  assert.equal(result.time_range_note, null);
  assert.equal(result.results[0].time_range_status, 'within');
});
