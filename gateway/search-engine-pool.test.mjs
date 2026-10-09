import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngineHealth } from './engine-health.mjs';
import { searchSearxng, selectEngineLayer } from './search.mjs';

// A fixture that records every outgoing request URL and replays queued bodies, mirroring the
// conventions of gateway/search.test.mjs.
async function searchFixture(bodies, { input = { query: 'example' }, engineHealth = createEngineHealth(), ...options } = {}) {
  const requests = [];
  const result = await searchSearxng({
    baseUrl: 'http://searxng.test/',
    input,
    engineHealth,
    fetchImpl: async url => {
      requests.push(new URL(url));
      assert.notEqual(bodies.length, 0, 'search must not make an extra attempt');
      return { ok: true, json: async () => bodies.shift() };
    },
    ...options,
  });
  assert.equal(bodies.length, 0, 'every fixture response must be consumed');
  return { result, requests };
}

const ONE_RESULT = { results: [{ title: 'One', url: 'https://example.org/one', content: 'Text', engine: 'yandex' }] };
const EMPTY_POOLS = { general: [], news: [], strict: [] };

test('selectEngineLayer prefers strict for a time window, then news, then general', () => {
  assert.equal(selectEngineLayer({ query: 'x', time_range: 'day' }), 'strict');
  assert.equal(selectEngineLayer({ query: 'x', time_range: 'day', categories: 'news' }), 'strict');
  assert.equal(selectEngineLayer({ query: 'x', categories: 'news' }), 'news');
  assert.equal(selectEngineLayer({ query: 'x' }), 'general');
});

test('an unconfigured deployment sends no engines parameter and grows no pool keys (compatibility)', async () => {
  const { result, requests } = await searchFixture([ONE_RESULT], { input: { query: 'gold & 银价', categories: 'news', engines: 'google,bing', language: 'zh-CN', time_range: 'year', page: 3 }, enginePools: EMPTY_POOLS });
  assert.deepEqual(Object.fromEntries(requests[0].searchParams), {
    q: 'gold & 银价', format: 'json', categories: 'news', engines: 'google,bing', language: 'zh-CN', time_range: 'year', pageno: '3',
  });
  assert.equal(Object.hasOwn(result, 'engine_pool'), false);
  assert.equal(Object.hasOwn(result, 'failure_classes'), false);
  assert.equal(Object.hasOwn(result, 'cooldown_engines'), false);
});

test('a configured general pool is applied to the outgoing query and reported', async () => {
  const { result, requests } = await searchFixture([ONE_RESULT], {
    input: { query: 'gold price' },
    enginePools: { ...EMPTY_POOLS, general: ['yandex', 'quark', 'naver'] },
  });
  assert.equal(requests[0].searchParams.get('engines'), 'yandex,quark,naver');
  assert.deepEqual(result.engine_pool, { layer: 'general', engines: ['yandex', 'quark', 'naver'], source: 'config' });
});

test('a time-range query uses the strict layer and rejects non-time_range engines', async () => {
  const { result, requests } = await searchFixture([ONE_RESULT], {
    input: { query: '英伟达', time_range: 'day' },
    enginePools: { ...EMPTY_POOLS, strict: ['yandex', 'bing', 'quark', 'naver'] },
  });
  assert.equal(requests[0].searchParams.get('engines'), 'quark,naver');
  assert.equal(result.engine_pool.layer, 'strict');
  assert.deepEqual(result.engine_pool.rejected, ['yandex', 'bing'], 'engines SearXNG would silently skip are never asked');
});

test('a caller-supplied engines list always wins over a configured pool', async () => {
  const { result, requests } = await searchFixture([ONE_RESULT], {
    input: { query: 'gold price', engines: 'google' },
    enginePools: { ...EMPTY_POOLS, general: ['yandex', 'quark'] },
  });
  assert.equal(requests[0].searchParams.get('engines'), 'google');
  assert.equal(Object.hasOwn(result, 'engine_pool'), false);
});

test('failure_classes are reported alongside unresponsive engines', async () => {
  const { result } = await searchFixture([
    { results: [{ title: 'One', url: 'https://example.org/one', content: 'Text', engine: 'yandex' }], unresponsive_engines: [['quark', '暂停服务: 验证码'], ['bing', '暂停服务: 超时']] },
  ], { enginePools: EMPTY_POOLS });
  assert.deepEqual(result.unresponsive_engines, [['quark', '暂停服务: 验证码'], ['bing', '暂停服务: 超时']]);
  assert.deepEqual(result.failure_classes, { captcha: 1, timeout: 1 });
});

test('an engine that just failed is not asked again inside its cooldown, and the cooldown is reported', async () => {
  const clock = { t: 1000 };
  const engineHealth = createEngineHealth({ cooldownMs: 30000, stateTtlMs: 90000, now: () => clock.t });
  const enginePools = { ...EMPTY_POOLS, general: ['quark', 'yandex'] };
  const now = () => clock.t;

  // First search: quark reports a local-cooldown class, yandex answers.
  const first = await searchFixture([
    { results: [{ title: 'One', url: 'https://example.org/one', content: 'Text', engine: 'yandex' }], unresponsive_engines: [['quark', '超时']] },
  ], { input: { query: 'gold price' }, enginePools, engineHealth, now });
  assert.deepEqual(first.result.engine_pool.engines, ['quark', 'yandex']);
  assert.equal(first.requests[0].searchParams.get('engines'), 'quark,yandex');
  assert.deepEqual(first.result.failure_classes, { timeout: 1 });

  // Second search, still inside the cooldown: quark is dropped from the query and listed as cooling.
  const second = await searchFixture([ONE_RESULT], { input: { query: 'gold price' }, enginePools, engineHealth, now });
  assert.equal(second.requests[0].searchParams.get('engines'), 'yandex');
  assert.deepEqual(second.result.engine_pool.engines, ['yandex']);
  assert.deepEqual(second.result.engine_pool.cooling, ['quark']);
  assert.deepEqual(second.result.cooldown_engines.map(item => item.engine), ['quark']);

  // After the cooldown the engine is half-open: asked again so a success can clear its state.
  clock.t += 30000;
  const third = await searchFixture([ONE_RESULT], { input: { query: 'gold price' }, enginePools, engineHealth, now });
  assert.equal(third.requests[0].searchParams.get('engines'), 'quark,yandex');
  assert.deepEqual(third.result.engine_pool.engines, ['quark', 'yandex']);
});

test('a relaxed retry keeps the pooled engines and still drops only the time window', async () => {
  const { requests } = await searchFixture([
    { results: [] },
    { results: [{ title: 'One', url: 'https://example.org/one', content: 'Text', engine: 'naver' }] },
  ], {
    input: { query: '英伟达', time_range: 'day' },
    enginePools: { ...EMPTY_POOLS, strict: ['quark', 'naver'] },
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].searchParams.get('engines'), 'quark,naver');
  assert.equal(requests[0].searchParams.get('time_range'), 'day');
  assert.equal(requests[1].searchParams.get('engines'), 'quark,naver');
  assert.equal(requests[1].searchParams.has('time_range'), false);
});
