import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cacheEntryIsFresh,
  classifyClaimedDate,
  createBudgetLedger,
  DEFAULT_GLOBAL_MONTHLY_CENTS,
  DEFAULT_PROVIDER_LIMITS,
  normalizeProviderResult,
  providerCacheKey,
  providerCacheTtlMs,
  projectProviderDiagnostic,
  runOrderedFallback,
} from './provider-contract.mjs';

const FIXED_NOW = Date.parse('2026-10-13T04:00:00.000Z');

const fixtures = Object.freeze({
  baidu: [{ title: 'Baidu result', url: 'https://example.cn/news/1', snippet: 'Baidu snippet', source: 'Example', claimed_date: '2026-10-12 09:00:00' }],
  aliyun: [{ title: 'Ali result', url: 'https://example.cn/news/2', snippet: 'Ali snippet', source: 'Example' }],
  tencent: [],
});

test('Tencent diagnostic projector accepts only typed allowlisted fields and rejects poison', () => {
  const valid = { stage: 'record_validation', auth_success: null, page_count: 2, parsed_page_count: 1, record_type: 'object' };
  assert.deepEqual(projectProviderDiagnostic(valid), valid);
  const complete = { stage: 'complete', auth_success: true, page_count: 1, parsed_page_count: 1, result_count: 1 };
  assert.deepEqual(projectProviderDiagnostic(complete), complete);
  for (const diagnostic of [
    { stage: 'complete', auth_success: true, page_count: 0, parsed_page_count: 0, result_count: 1 },
    { stage: 'complete', auth_success: true, page_count: 2, parsed_page_count: 1, result_count: 1 },
    { stage: 'page_json', auth_success: null, page_count: 2, parsed_page_count: 3, page_type: 'string' },
    { stage: 'record_validation', auth_success: null, page_count: 2, parsed_page_count: 1, result_count: 2, record_type: 'object' },
  ]) assert.equal(projectProviderDiagnostic(diagnostic), null);
  for (const diagnostic of [
    { ...valid, body: 'private sentinel' },
    { ...valid, page_count: -1 },
    { ...valid, page_count: 1.5 },
    { ...valid, auth_success: 'true' },
    { ...valid, record_type: 'private sentinel' },
    { ...valid, nested: { key: 'private sentinel' } },
  ]) assert.equal(projectProviderDiagnostic(diagnostic), null);
  assert.equal(projectProviderDiagnostic({ ...valid, stage: 'unknown' }), null);
});

test('normalizes provider results to the shared contract and keeps provider dates claimed', () => {
  const result = normalizeProviderResult(fixtures.baidu[0], 'baidu');
  assert.deepEqual(result, {
    title: 'Baidu result',
    url: 'https://example.cn/news/1',
    snippet: 'Baidu snippet',
    source: 'Example',
    claimed_date: '2026-10-12 09:00:00',
    provider: 'baidu',
    date_status: 'claimed',
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(classifyClaimedDate('2026-10-12'), 'claimed');
  assert.equal(classifyClaimedDate(null), 'unknown');
});

test('rejects malformed records and non-http URLs', () => {
  for (const item of [null, [], { title: 'missing url' }, { title: 'bad', url: 'file:///tmp/a' }]) {
    assert.throws(() => normalizeProviderResult(item, 'baidu'), TypeError);
  }
});

test('normalizes cache identity and applies mode-specific TTLs', () => {
  assert.equal(providerCacheKey({ query: '  Ａ  B  ', mode: 'news', timeWindow: 'day' }),
    providerCacheKey({ query: 'A B', mode: 'news', timeWindow: 'day' }));
  assert.notEqual(providerCacheKey({ query: 'A B', mode: 'news', timeWindow: 'day' }),
    providerCacheKey({ query: 'A B', mode: 'strict', timeWindow: 'day' }));
  assert.equal(providerCacheTtlMs('general'), 24 * 60 * 60 * 1000);
  assert.equal(providerCacheTtlMs('news'), 2 * 60 * 60 * 1000);
  assert.equal(providerCacheTtlMs('strict', 'day'), 60 * 60 * 1000);
  assert.equal(cacheEntryIsFresh({ createdAt: 0, ttlMs: 10 }, 9), true);
  assert.equal(cacheEntryIsFresh({ createdAt: 0, ttlMs: 10 }, 10), false);
});

test('enforces Baidu free daily cap and paid provider plus global monthly hard caps', () => {
  let now = FIXED_NOW;
  const budget = createBudgetLedger({
    now: () => now,
    globalMonthlyCents: 1000,
    limits: {
      baidu: { dailyCalls: 100, monthlyCents: 0 },
      aliyun: { dailyCalls: 20, monthlyCents: 500 },
      tencent: { dailyCalls: 12, monthlyCents: 500 },
      other: { dailyCalls: 12, monthlyCents: 500 },
    },
  });
  assert.equal(DEFAULT_PROVIDER_LIMITS.aliyun.monthlyCents, 500);
  assert.equal(DEFAULT_PROVIDER_LIMITS.tencent.monthlyCents, 500);

  for (let i = 0; i < 100; i++) assert.equal(budget.reserve('baidu').allowed, true);
  assert.deepEqual(budget.reserve('baidu'), { allowed: false, reason: 'budget_exhausted' });
  assert.equal(budget.reserve('aliyun', 250).allowed, true);
  assert.deepEqual(budget.reserve('aliyun', 251), { allowed: false, reason: 'budget_exhausted' });
  assert.equal(budget.reserve('tencent', 250).allowed, true);
  assert.equal(budget.reserve('tencent', 250).allowed, true);
  assert.deepEqual(budget.reserve('other', 250), { allowed: true, dayCalls: 1, providerMonthlyCents: 250, globalMonthlyCents: 1000 });
  assert.deepEqual(budget.reserve('other', 1), { allowed: false, reason: 'budget_exhausted' });

  now += 24 * 60 * 60 * 1000;
  assert.equal(budget.reserve('baidu').allowed, true);
  assert.deepEqual(budget.reserve('tencent', 1), { allowed: false, reason: 'budget_exhausted' });
  now = Date.parse('2026-11-01T00:00:00.000Z');
  assert.equal(budget.reserve('aliyun', 500).allowed, true);
  assert.equal(budget.snapshot().globalMonthlyCents, 500);
});

test('fails closed for unknown providers and invalid estimated costs', () => {
  const budget = createBudgetLedger({ now: () => FIXED_NOW });
  assert.deepEqual(budget.reserve('unknown'), { allowed: false, reason: 'provider_unconfigured' });
  assert.throws(() => budget.reserve('aliyun', 0.1), TypeError);
  assert.throws(() => budget.reserve('aliyun', -1), TypeError);
  for (const provider of ['aliyun', 'tencent', ' aliyun ']) {
    for (const estimate of [undefined, null, 0, NaN, Infinity, '1']) {
      assert.throws(() => budget.reserve(provider, estimate), TypeError);
    }
  }
  assert.equal(budget.snapshot().globalMonthlyCents, 0);
});

test('default paid daily caps allow exactly 20/12 calls and reset without clearing monthly spend', () => {
  for (const [provider, cap] of [['aliyun', 20], ['tencent', 12]]) {
    let now = FIXED_NOW;
    const budget = createBudgetLedger({ now: () => now });
    assert.equal(DEFAULT_PROVIDER_LIMITS[provider].dailyCalls, cap);
    for (let i = 1; i <= cap; i++) {
      assert.deepEqual(budget.reserve(provider, 1), {
        allowed: true, dayCalls: i, providerMonthlyCents: i, globalMonthlyCents: i,
      });
    }
    assert.deepEqual(budget.reserve(provider, 1), { allowed: false, reason: 'budget_exhausted' });
    assert.equal(budget.snapshot().globalMonthlyCents, cap);
    now = Date.parse('2026-10-14T00:00:00.000Z');
    assert.deepEqual(budget.reserve(provider, 1), {
      allowed: true, dayCalls: 1, providerMonthlyCents: cap + 1, globalMonthlyCents: cap + 1,
    });
    now = Date.parse('2026-11-01T00:00:00.000Z');
    assert.deepEqual(budget.reserve(provider, 1), {
      allowed: true, dayCalls: 1, providerMonthlyCents: 1, globalMonthlyCents: 1,
    });
  }
});

test('missing or zero paid estimates skip search and reservation, while Baidu remains free', async () => {
  for (const estimateCostCents of [undefined, () => undefined, () => null, () => 0]) {
    const budget = createBudgetLedger({ now: () => FIXED_NOW });
    const called = [];
    const result = await runOrderedFallback({
      budget,
      query: 'q',
      estimateCostCents,
      providers: ['aliyun', 'tencent', 'baidu'].map(name => ({
        name,
        search: async () => { called.push(name); return fixtures.baidu; },
      })),
    });
    assert.deepEqual(called, ['baidu']);
    assert.deepEqual(result.attempts.map(attempt => attempt.status), [
      'cost_estimate_required', 'cost_estimate_required', 'success',
    ]);
    assert.equal(result.results[0].provider, 'baidu');
    assert.equal(budget.snapshot().globalMonthlyCents, 0);
    assert.equal(budget.snapshot().providers.aliyun, undefined);
    assert.equal(budget.snapshot().providers.tencent, undefined);
  }
});

test('explicit paid estimates are charged before a successful search', async () => {
  for (const name of ['aliyun', 'tencent']) {
    const budget = createBudgetLedger({ now: () => FIXED_NOW });
    const result = await runOrderedFallback({
      budget,
      query: 'q',
      estimateCostCents: provider => { assert.equal(provider, name); return 2; },
      providers: [{ name, search: async () => {
        assert.equal(budget.snapshot().globalMonthlyCents, 2);
        return fixtures.aliyun;
      } }],
    });
    assert.equal(result.results[0].provider, name);
    assert.equal(budget.snapshot().providers[name].monthlyCents, 2);
  }
});

test('invalid budget clock rejects fallback explicitly before search or charging', async () => {
  for (const invalid of [NaN, Infinity, 'invalid', 1e20]) {
    let now = invalid;
    let called = false;
    const budget = createBudgetLedger({ now: () => now });
    await assert.rejects(runOrderedFallback({
      budget,
      query: 'q',
      providers: [{ name: 'baidu', search: async () => { called = true; return fixtures.baidu; } }],
    }), invalid === 1e20 ? RangeError : TypeError);
    assert.equal(called, false);
    now = FIXED_NOW;
    assert.equal(budget.snapshot().globalMonthlyCents, 0);
    assert.equal(budget.snapshot().providers.baidu, undefined);
  }
});

test('ordered fallback skips exhausted providers, continues on errors/empty and stops on first results', async () => {
  const budget = createBudgetLedger({
    now: () => FIXED_NOW,
    limits: {
      baidu: { dailyCalls: 100, monthlyCents: 0 },
      aliyun: { dailyCalls: 20, monthlyCents: 500 },
      tencent: { dailyCalls: 12, monthlyCents: 500 },
      local: { dailyCalls: Infinity, monthlyCents: 0 },
    },
  });
  for (let i = 0; i < 100; i++) budget.reserve('baidu');
  const called = [];
  const result = await runOrderedFallback({
    budget,
    query: { text: 'topic' },
    estimateCostCents: name => ['aliyun', 'tencent'].includes(name) ? 1 : 0,
    providers: [
      { name: 'baidu', search: async () => { called.push('baidu'); return fixtures.baidu; } },
      { name: 'aliyun', search: async () => { called.push('aliyun'); return []; } },
      { name: 'tencent', search: async () => { called.push('tencent'); return fixtures.tencent; } },
      { name: 'local', search: async () => { called.push('local'); return [{ title: 'Local', url: 'https://local.test/a' }]; } },
      { name: 'unreached', search: async () => { called.push('unreached'); return []; } },
    ],
  });
  assert.deepEqual(called, ['aliyun', 'tencent', 'local']);
  assert.equal(result.results[0].provider, 'local');
  assert.deepEqual(result.attempts.map(attempt => attempt.status), [
    'budget_exhausted', 'empty', 'empty', 'success',
  ]);
});

test('budget is reserved before search and failed/empty attempts remain charged', async () => {
  const budget = createBudgetLedger({ now: () => FIXED_NOW, globalMonthlyCents: 500 });
  const result = await runOrderedFallback({
    budget,
    query: 'q',
    estimateCostCents: () => 500,
    providers: [
      { name: 'aliyun', search: async () => { throw new Error('offline'); } },
      { name: 'tencent', search: async () => [{ title: 'ok', url: 'https://example.cn/' }] },
    ],
  });
  assert.equal(result.results.length, 0);
  assert.equal(result.attempts[0].status, 'error');
  assert.equal(result.attempts[1].status, 'budget_exhausted');
  assert.equal(budget.snapshot().globalMonthlyCents, 500);
});
