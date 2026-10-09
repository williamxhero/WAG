import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyEnginePool,
  classifyFailureReason,
  createEngineHealth,
  enginePoolConfig,
  failureClasses,
  parseEngineList,
  supportsTimeRange,
  validateStrictPool,
  DEFAULT_ENGINE_COOLDOWN_MS,
  DEFAULT_ENGINE_STATE_TTL_MS,
} from './engine-health.mjs';

// Every raw form the SPEC #74 sampling matrix observed must map to a stable class — no dependence on
// Chinese prose downstream. The table is the acceptance list, not a sample.
const REASON_TABLE = [
  ['暂停服务: 验证码', 'captcha'],
  ['验证码', 'captcha'],
  ['暂停服务: 超时', 'timeout'],
  ['超时', 'timeout'],
  ['请求过于频繁', 'rate_limited'],
  ['服务器 API 错误', 'upstream_error'],
  ['意外崩溃', 'crash'],
  ['拒绝访问', 'forbidden'],
];

test('classifyFailureReason covers every observed raw reason', () => {
  for (const [raw, expected] of REASON_TABLE) assert.equal(classifyFailureReason(raw), expected, raw);
});

test('classifyFailureReason is stable for empty, unknown and English fixture reasons', () => {
  assert.equal(classifyFailureReason(''), 'unknown');
  assert.equal(classifyFailureReason(undefined), 'unknown');
  assert.equal(classifyFailureReason('some brand new failure'), 'unknown');
  assert.equal(classifyFailureReason('timeout'), 'timeout');
  assert.equal(classifyFailureReason('captcha'), 'captcha');
  assert.equal(classifyFailureReason('blocked'), 'forbidden');
});

test('failureClasses counts one response\u2019s unresponsive engines by class', () => {
  assert.deepEqual(failureClasses([['quark', '暂停服务: 验证码'], ['quark', '暂停服务: 验证码'], ['bing', '暂停服务: 超时'], ['chinaso news', '服务器 API 错误']]), {
    captcha: 2, timeout: 1, upstream_error: 1,
  });
  assert.deepEqual(failureClasses([]), {});
  assert.deepEqual(failureClasses(undefined), {});
  // A malformed entry is ignored, never crash the search.
  assert.deepEqual(failureClasses([['ok'], 'nonsense', ['x', '意外崩溃']]), { crash: 1 });
});

test('parseEngineList trims, drops empties, collapses duplicates and keeps order', () => {
  assert.deepEqual(parseEngineList(' yandex, quark ,,yandex, naver '), ['yandex', 'quark', 'naver']);
  assert.deepEqual(parseEngineList(''), []);
  assert.deepEqual(parseEngineList(undefined), []);
});

test('enginePoolConfig defaults every pool to empty with bounded cooldown defaults', () => {
  const config = enginePoolConfig({});
  assert.deepEqual(config.pools, { general: [], news: [], strict: [] });
  assert.equal(config.cooldownMs, DEFAULT_ENGINE_COOLDOWN_MS);
  assert.equal(config.stateTtlMs, DEFAULT_ENGINE_STATE_TTL_MS);
});

test('enginePoolConfig reads and clamps the opt-in pools', () => {
  const config = enginePoolConfig({
    WAG_SEARCH_ENGINE_POOL_GENERAL: 'yandex,quark,naver',
    WAG_SEARCH_ENGINE_POOL_STRICT: 'quark,naver',
    WAG_SEARCH_ENGINE_COOLDOWN_MS: '45000',
    WAG_SEARCH_ENGINE_STATE_TTL_MS: '-5',
  });
  assert.deepEqual(config.pools.general, ['yandex', 'quark', 'naver']);
  assert.deepEqual(config.pools.strict, ['quark', 'naver']);
  assert.equal(config.cooldownMs, 45000);
  assert.equal(config.stateTtlMs, DEFAULT_ENGINE_STATE_TTL_MS, 'a non-positive TTL falls back to the bounded default');
});

test('the strict layer rejects engines that cannot honour a time window', () => {
  assert.equal(supportsTimeRange('quark'), true);
  assert.equal(supportsTimeRange('naver'), true);
  assert.equal(supportsTimeRange('chinaso news'), true);
  assert.equal(supportsTimeRange('yandex'), false);
  assert.equal(supportsTimeRange('bing'), false);
  assert.equal(supportsTimeRange('mystery engine'), false, 'unknown engines are treated as unsupported');

  assert.deepEqual(validateStrictPool(['yandex', 'quark', 'bing', 'naver']), { engines: ['quark', 'naver'], rejected: ['yandex', 'bing'] });
});

test('applyEnginePool is a no-op for an unconfigured layer', () => {
  assert.equal(applyEnginePool({ layer: 'general', pools: { general: [] }, health: createEngineHealth() }), null);
  assert.equal(applyEnginePool({ layer: 'strict', pools: {}, health: createEngineHealth() }), null);
});

test('applyEnginePool selects, validates and reports the layer', () => {
  const general = applyEnginePool({ layer: 'general', pools: { general: ['yandex', 'quark'] }, health: createEngineHealth() });
  assert.deepEqual(general.engines, ['yandex', 'quark']);
  assert.equal(general.source, 'config');
  assert.deepEqual(general.rejected, []);

  const strict = applyEnginePool({ layer: 'strict', pools: { strict: ['yandex', 'quark', 'naver'] }, health: createEngineHealth() });
  assert.deepEqual(strict.engines, ['quark', 'naver'], 'yandex is dropped from the strict layer');
  assert.deepEqual(strict.rejected, ['yandex']);
});

test('applyEnginePool never asks an engine inside its cooldown', () => {
  const clock = { t: 1000 };
  const health = createEngineHealth({ cooldownMs: 30000, stateTtlMs: 90000, now: () => clock.t });
  health.recordFailure('quark', '超时', clock.t);

  const pool = applyEnginePool({ layer: 'general', pools: { general: ['quark', 'yandex'] }, health, now: () => clock.t });
  assert.deepEqual(pool.engines, ['yandex']);
  assert.deepEqual(pool.cooling, ['quark']);
});

test('a locally-cooled engine is skipped until its cooldown expires, then allowed half-open', () => {
  const clock = { t: 0 };
  const health = createEngineHealth({ cooldownMs: 30000, stateTtlMs: 90000, now: () => clock.t });

  health.recordFailure('quark', '超时', clock.t);
  assert.equal(health.shouldSkip('quark', clock.t), true);
  assert.equal(health.shouldSkip('quark', clock.t + 29999), true);
  assert.equal(health.shouldSkip('quark', clock.t + 30000), false, 'half-open once the cooldown expires');

  // A repeated failure before recovery extends the cooldown (bounded), instead of a flat retry.
  health.recordFailure('quark', '超时', 1000);
  assert.equal(health.shouldSkip('quark', 1000 + 59999), true, 'second failure doubles the cooldown');
  assert.equal(health.shouldSkip('quark', 1000 + 60000), false);

  // A success on the half-open attempt clears the state entirely.
  health.recordSuccess('quark');
  assert.equal(health.shouldSkip('quark', 1000), false);
});

test('the local cooldown is capped and only applies to classes without a SearXNG suspension', () => {
  const clock = { t: 0 };
  const health = createEngineHealth({ cooldownMs: 30000, stateTtlMs: 90000, now: () => clock.t });

  // captcha / rate_limited / forbidden carry their own `suspended_time`; WAG must not double up.
  for (const raw of ['暂停服务: 验证码', '请求过于频繁', '拒绝访问']) health.recordFailure('quark', raw, clock.t);
  assert.equal(health.shouldSkip('quark', clock.t), false, 'not locally cooled');

  // timeout / upstream_error / crash are the ones that need the local cooldown, capped at the TTL.
  for (let i = 0; i < 5; i++) health.recordFailure('bing', '超时', clock.t);
  assert.deepEqual(health.snapshot(clock.t).cooldown_engines.map(item => item.engine), ['bing']);
  assert.equal(health.shouldSkip('bing', clock.t + 90000 - 1), true);
  assert.equal(health.shouldSkip('bing', clock.t + 90000), false, 'cooldown never exceeds the state TTL');
});

test('snapshot reports only currently-cooling engines', () => {
  const clock = { t: 0 };
  const health = createEngineHealth({ cooldownMs: 30000, stateTtlMs: 90000, now: () => clock.t });
  health.recordFailure('quark', '超时', clock.t);
  health.recordFailure('bing', '服务器 API 错误', clock.t);
  assert.deepEqual(
    health.snapshot(clock.t).cooldown_engines.map(item => [item.engine, item.failure_class]).sort(),
    [['bing', 'upstream_error'], ['quark', 'timeout']],
  );
  assert.deepEqual(health.snapshot(clock.t + 90000).cooldown_engines, []);
});
