import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderAdapter } from './provider-adapters.mjs';
import { createBudgetLedger, runOrderedFallback } from './provider-contract.mjs';

test('legacy string fallback skips disabled adapters without spending and accepts enabled adapters', async () => {
  const budget = createBudgetLedger();
  const result = await runOrderedFallback({ budget, query: '政策', estimateCostCents: name => name === 'baidu' ? 0 : 1,
    providers: [createProviderAdapter({ name: 'aliyun' }), createProviderAdapter({ name: 'baidu', enabled: true, transport: async () => response(fixtures.baidu) })] });
  assert.equal(result.attempts[0].status, 'provider_unconfigured');
  assert.equal(result.results[0].provider, 'baidu');
  assert.equal(budget.snapshot().globalMonthlyCents, 0);
  assert.equal(budget.snapshot().providers.aliyun, undefined);
});

// Synthetic official-shaped responses, not captures or evidence of real provider supply.
const fixtures = {
  baidu: { request_id: 'synthetic', references: [{ title: '合成政策', url: 'https://example.cn/a', content: '合成摘要', website: '合成来源', date: '2026-10-13' }] },
  aliyun: { requestId: 'synthetic', pageItems: [{ title: '合成政策', link: 'https://example.cn/a', snippet: '合成摘要', hostname: '合成来源', publishedTime: '2026-10-13' }] },
  tencent: { Response: { RequestId: 'synthetic', Version: 'lite', Pages: [JSON.stringify({ title: '合成政策', url: 'https://example.cn/a', passage: '合成摘要', site: '合成来源', date: '2026-10-13' })] } },
};
const response = value => ({ status: 200, body: JSON.stringify(value) });
const adapterFor = (name, transport, options = {}) => createProviderAdapter({ name, enabled: true, transport, ...options });

test('rejects error/malformed envelopes and classifies failures without leaking upstream text', async () => {
  const cases = [
    ['baidu', response({ code: 216003, message: 'private error', references: [] }), 'upstream_error'],
    ['aliyun', response({ code: 'Retrieval.Arrears', message: 'private error', pageItems: [] }), 'upstream_error'],
    ['tencent', response({ Response: { Error: { Code: 'UnauthorizedOperation', Message: 'private error' }, Pages: [] } }), 'authentication'],
    ['tencent', response({ Response: { Version: 'flagship', Pages: [] } }), 'provider_version_mismatch'],
    ...[{}, 'bad', { Message: 'failure' }, null].map(Error => ['tencent', response({ Response: { Version: 'lite', Pages: [], Error } }), 'invalid_response']),
    ['baidu', response({}), 'invalid_response'],
    ['aliyun', response({ pageItems: {} }), 'invalid_response'],
    ['tencent', response({ Response: { Version: 'lite', Pages: [{}] } }), 'invalid_response'],
    ['tencent', response({ Response: { Version: 'lite', Pages: ['invalid JSON'] } }), 'invalid_response'],
    ['baidu', { status: 200, body: '{' }, 'invalid_response'],
    ['baidu', { status: 401, body: 'private error' }, 'authentication'],
    ['aliyun', { status: 429, body: 'private error' }, 'rate_limited'],
    ['tencent', { status: 503, body: 'private error' }, 'upstream_error'],
  ];
  for (const [name, reply, kind] of cases) {
    await assert.rejects(adapterFor(name, async () => reply).search({ query: '政策' }), error => error.kind === kind && !error.message.includes('private'));
  }
  await assert.rejects(adapterFor('baidu', async () => { throw new Error('private transport'); }).search({ query: '政策' }), { kind: 'transport_error' });
});

test('bounds response bytes and record count, rejects invalid records, preserves empty/null dates', async () => {
  await assert.rejects(adapterFor('baidu', async () => response(fixtures.baidu), { maxResponseBytes: 32 }).search({ query: '政策' }), { kind: 'response_too_large' });
  const many = { references: [...fixtures.baidu.references, ...fixtures.baidu.references] };
  assert.equal((await adapterFor('baidu', async () => response(many), { maxResults: 1 }).search({ query: '政策' })).length, 1);
  for (const item of [null, [], { title: 'bad', url: 'javascript:bad' }, { title: 'bad', url: 'https://example.cn', date: 123 }, { title: 'bad', url: 'https://example.cn', content: {} }]) {
    await assert.rejects(adapterFor('baidu', async () => response({ references: [item] })).search({ query: '政策' }), { kind: 'invalid_response' });
  }
  const result = await adapterFor('baidu', async () => response({ references: [{ title: '合成', url: 'https://example.cn', date: '   ' }] })).search({ query: '政策' });
  assert.equal(result[0].date_status, 'unknown');
  assert.equal(result[0].claimed_date, null);
  assert.deepEqual(await adapterFor('aliyun', async () => response({ pageItems: [] })).search({ query: '政策' }), []);
});

test('builds documented requests and stable provider-separated cache identities', async () => {
  const bodies = {
    baidu: { messages: [{ role: 'user', content: '政策' }], search_source: 'baidu_search_v2', resource_type_filter: [{ type: 'web', top_k: 10 }] },
    aliyun: { query: '政策', engineType: 'CNLiteBasic', timeRange: 'OneDay', advancedParams: { numResults: '10' }, contents: { mainText: false, markdownText: false, summary: false } },
    tencent: { Query: '政策', Site: 'mp.weixin.qq.com', Freshness: 'd1' },
  };
  const keys = new Set();
  for (const name of Object.keys(fixtures)) {
    const adapter = adapterFor(name, async request => {
      assert.deepEqual(request.body, bodies[name]);
      assert.equal(request.headers, undefined); // No auth guesses or secrets.
      assert.equal(request.maxResponseBytes, 262144);
      assert.equal(request.signal instanceof AbortSignal, true);
      if (name === 'tencent') assert.deepEqual(request.api, { action: 'SearchPro', version: '2025-05-08' });
      return response(fixtures[name]);
    }, name === 'tencent' ? { site: 'mp.weixin.qq.com' } : {});
    const input = { query: '  政策  ', mode: 'strict', timeWindow: 'day' };
    await adapter.search(input);
    assert.deepEqual(adapter.cacheIdentity(input), adapter.cacheIdentity({ ...input, query: '政策' }));
    assert.equal(adapter.cacheIdentity(input).ttlMs, 3600000);
    assert.equal(adapter.cacheIdentity({ query: '政策', mode: 'news' }).ttlMs, 7200000);
    assert.equal(adapter.cacheIdentity({ query: '政策' }).ttlMs, 86400000);
    keys.add(adapter.cacheIdentity(input).key);
    for (const invalid of [{ query: '' }, { query: 'x'.repeat(501) }, { query: 'x', mode: 'invalid' }, { query: 'x', timeWindow: {} }]) {
      await assert.rejects(adapter.search(invalid), TypeError);
    }
  }
  assert.equal(keys.size, 3);
  assert.notEqual(adapterFor('tencent', async () => {}, { site: 'mp.weixin.qq.com' }).cacheIdentity({ query: 'x' }).key,
    adapterFor('tencent', async () => {}).cacheIdentity({ query: 'x' }).key);
});

test('deadline aborts even an uncooperative transport and observes late rejection', async () => {
  let signal;
  const adapter = adapterFor('baidu', request => {
    signal = request.signal;
    return new Promise((resolve, reject) => setTimeout(() => reject(new Error('late private error')), 80));
  }, { timeoutMs: 10 });
  await assert.rejects(adapter.search({ query: '政策' }), { kind: 'timeout' });
  assert.equal(signal.aborted, true);
});

for (const name of Object.keys(fixtures)) {
  test(`${name} maps official fields to claimed-only results and remains disabled by default`, async () => {
    let called = false;
    const transport = async () => { called = true; return response(fixtures[name]); };
    await assert.rejects(createProviderAdapter({ name, transport }).search({ query: '政策' }), { kind: 'provider_unconfigured' });
    assert.equal(called, false);
    const adapter = createProviderAdapter({ name, transport, enabled: true });
    assert.deepEqual(await adapter.search({ query: '政策' }), [{
      title: '合成政策', url: 'https://example.cn/a', snippet: '合成摘要', source: '合成来源',
      claimed_date: '2026-10-13', provider: name, date_status: 'claimed',
    }]);
  });
}
