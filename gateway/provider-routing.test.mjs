import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPageEvidence } from './evidence-metadata.mjs';
import { searchSearxng } from './search.mjs';
import { createProviderRouting, createSearchProviderRuntime, loadProviderCredentials } from './provider-routing.mjs';
import { createPersistentBudgetLedger } from './provider-budget.mjs';
import { createProviderAdapter } from './provider-adapters.mjs';
import { createProviderHttpTransport } from './provider-http-transport.mjs';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, rm, writeFile, chmod, mkdir, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const recall = [{ title: 'Publisher report', url: 'https://publisher.example/articles/report', content: 'A substantive publisher report.', publishedDate: '2026-10-13T10:00:00Z', engine: 'fixture' }];
const fetchRecall = async () => ({ ok: true, json: async () => ({ results: recall }) });

test('Tencent runtime preserves only projected diagnostics and leaves E4 results unverified', async t => {
  const { budget, databasePath } = await ledgerFixture(t);
  const runtime = createSearchProviderRuntime({ env: { WAG_SEARCH_TENCENT_ENABLED: '1', WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: '1',
    TENCENTCLOUD_SECRET_ID: 'dummy-id', TENCENTCLOUD_SECRET_KEY: 'dummy-key' }, databasePath, now: () => NOW,
    request: (url, options, callback) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        assert.equal(budget.snapshot().providers.tencent.monthlyCents, 3);
        const res = Readable.from([JSON.stringify({ Response: { Version: 'lite', Pages: [JSON.stringify({ title: 'Synthetic', url: 'https://example.test/a', date: '2026-10-13' })] } })]);
        res.statusCode = 200;
        res.headers = {};
        queueMicrotask(() => callback(res));
      };
      return req;
    } });
  try {
    const result = await runtime.dispatch({ provider: 'tencent', query: 'synthetic' });
    assert.equal(result.attempts[0].status, 'success');
    assert.deepEqual(result.attempts[0].diagnostic, { stage: 'complete', auth_success: true, page_count: 1, parsed_page_count: 1, result_count: 1 });
    assert.equal(result.posterior_version, 'lite');
    assert.equal(result.results[0].date_status, 'claimed');
    assert.equal(budget.snapshot().providers.tencent.monthlyCents, 3);
    const hit = await runtime.dispatch({ provider: 'tencent', query: 'synthetic' });
    assert.equal(hit.attempts[0].status, 'cache_hit');
    assert.equal(Object.hasOwn(hit.attempts[0], 'diagnostic'), false);
  } finally { runtime.close(); }
});

test('provider runtime uses explicit environment controls and ignores obsolete WSA credentials', async () => {
  const runtime = createSearchProviderRuntime({ env: { WAG_SEARCH_BAIDU_ENABLED: '1', APPBUILDER_API_KEY: 'dummy-key', WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: '1', TENCENTCLOUD_WSA_APIKEY: 'obsolete' }, databasePath: path.join(tmpdir(), 'missing-provider-budget.sqlite') });
  assert.equal(runtime.active, true);
  assert.equal(runtime.evidencePolicy, 'spec78_legacy');
  runtime.close();
});

test('invalid typed provider controls fail closed with a configuration diagnostic before ledger access', async () => {
  for (const controls of [{ WAG_SEARCH_PAGE_MAX_CANDIDATES: '21' }, { WAG_SEARCH_PAGE_TIMEOUT_MS: '10001' }, { WAG_SEARCH_BAIDU_ENABLED: 'yes' }, { WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: 'true' }, { WAG_SEARCH_EVIDENCE_POLICY: 'invalid' }]) {
    const runtime = createSearchProviderRuntime({ env: { WAG_SEARCH_BAIDU_ENABLED: '1', APPBUILDER_API_KEY: 'dummy-key', WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: '1', ...controls },
      databasePath: path.join(tmpdir(), 'definitely-missing-controls.sqlite'), secretPath: path.join(tmpdir(), 'never-read-controls.env') });
    try {
      assert.equal((await runtime.dispatch({ provider: 'baidu', query: 'report' })).attempts[0].status, 'provider_configuration_error');
      assert.equal(runtime.snapshot(), null);
    } finally { runtime.close(); }
  }
});

test('runtime loads only missing allowlisted credentials from a private nonexecuting dummy file', async t => {
  const { budget, databasePath } = await ledgerFixture(t);
  const secretPath = path.join(path.dirname(databasePath), 'dummy-providers.env');
  await writeFile(secretPath, 'APPBUILDER_API_KEY="dummy-file-key"\nIQS_API_KEY=dummy-iqs\nWAG_SEARCH_TENCENT_ENABLED=1\nTENCENTCLOUD_WSA_APIKEY=unused\n', { mode: 0o600 });
  const calls = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => {
      calls.push(options.headers.Authorization);
      const res = Readable.from(['{"references":[]}']);
      res.statusCode = 200;
      res.headers = {};
      queueMicrotask(() => callback(res));
    };
    return req;
  };
  const runtime = createSearchProviderRuntime({ env: { WAG_SEARCH_BAIDU_ENABLED: '1', WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: '1' }, databasePath, secretPath, now: () => NOW, request });
  try {
    const result = await runtime.dispatch({ provider: 'baidu', query: 'synthetic' });
    assert.equal(result.attempts[0].status, 'empty');
    assert.deepEqual(calls, ['Bearer dummy-file-key']);
    assert.equal((await runtime.dispatch({ provider: 'tencent', query: 'synthetic' })).attempts[0].status, 'provider_unconfigured');
    assert.equal(budget.snapshot().providers.baidu.dailyCalls, 1);
  } finally { runtime.close(); }
});

test('private dummy credential loader bounds and rejects malformed, expanded, oversized and multiply-linked files', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wag-secrets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = path.join(root, 'secrets');
  await mkdir(parent, { mode: 0o750 });
  const filename = path.join(parent, 'dummy.env');
  await writeFile(filename, 'APPBUILDER_API_KEY=dummy\n', { mode: 0o600 });
  assert.equal(loadProviderCredentials(filename).APPBUILDER_API_KEY, 'dummy', 'Linux 0750 parent and 0600 file are supported');
  for (const text of ['APPBUILDER_API_KEY=first\nAPPBUILDER_API_KEY=second\n', 'APPBUILDER_API_KEY=$(command)\n', 'export APPBUILDER_API_KEY=dummy\n', 'APPBUILDER_API_KEY="missing\n', 'APPBUILDER_API_KEY=' + 'x'.repeat(17000)]) {
    await writeFile(filename, text);
    assert.throws(() => loadProviderCredentials(filename));
  }
  await writeFile(filename, 'APPBUILDER_API_KEY=dummy\n');
  const alias = path.join(parent, 'alias.env');
  await link(filename, alias);
  assert.throws(() => loadProviderCredentials(filename));
  await rm(alias);
  if (process.platform !== 'win32') {
    for (const mode of [0o777, 0o770, 0o702]) {
      await chmod(parent, mode);
      assert.throws(() => loadProviderCredentials(filename));
    }
    await chmod(parent, 0o750);
    await chmod(filename, 0o640);
    assert.throws(() => loadProviderCredentials(filename));
    await chmod(filename, 0o600);
    await symlink(filename, alias);
    assert.throws(() => loadProviderCredentials(alias));
  } else t.diagnostic('Unix mode/owner/symlink branches require the final Linux CI run; parser and hardlink rejection ran locally.');
});

test('explicit environment credentials take precedence and disabled providers never require a secret file', async t => {
  const { databasePath } = await ledgerFixture(t);
  const secretPath = path.join(path.dirname(databasePath), 'missing-secrets.env');
  for (const env of [{}, { WAG_SEARCH_BAIDU_ENABLED: '1', WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: '1', APPBUILDER_API_KEY: 'dummy-explicit' }]) {
    const runtime = createSearchProviderRuntime({ env, databasePath, secretPath, now: () => NOW });
    try { assert.equal(runtime.active ? runtime.snapshot()?.globalMonthlyCents : null, runtime.active ? 0 : null); }
    finally { runtime.close(); }
  }
});

test('enabled providers serve empty legacy recall without switching the global evidence policy or reading pages', async t => {
  const { budget } = await ledgerFixture(t);
  const calls = [];
  const router = createProviderRouting({ now: () => NOW, providers: [providerFixture('baidu', budget, calls, [recall[0].url])], budget, estimateCostCents: () => 0 });
  const result = await searchSearxng({ baseUrl: 'http://searxng.test', input: { query: 'report' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }), now: () => NOW, providerRouting: { active: true, search: input => router.search(input) },
    verifyPage: () => { throw new Error('ordinary legacy search must not read pages'); } });
  assert.equal(result.results.length, 1);
  assert.equal(result.evidence_policy, 'spec78_legacy');
  assert.equal(result.results[0].policy, 'spec78_legacy');
  assert.equal(result.results[0].state, 'claimed');
  assert.equal(result.page_verification.read_attempts, 0);
  assert.equal(calls.length, 1);
});

test('page-only verified news honors source selection and reports honest verification and result counts', async () => {
  let reads = 0;
  const read = candidate => { reads++; return publisherPage(candidate); };
  const options = { baseUrl: 'http://searxng.test', fetchImpl: fetchRecall, now: () => NOW, evidencePolicy: 'spec82_page_only', verifyPage: read };
  const feeds = await searchSearxng({ ...options, input: { query: 'report', news_mode: 'verified', news_source: 'feeds' } });
  assert.deepEqual(feeds.results, [], 'SearXNG recall is not a configured feed source');
  assert.equal(reads, 0);
  assert.equal(feeds.news_verification.source_failures[0].code, 'catalog_empty');
  const page = await searchSearxng({ ...options, input: { query: 'report', news_mode: 'verified' } });
  assert.equal(page.results.length, 1);
  assert.equal(page.number_of_results, 1);
  assert.equal(page.news_verification.verified_count, 1);
  assert.equal(page.news_verification.distinct_publishers, 1);
  assert.equal(page.news_verification.status, 'partial');
  assert.equal(page.news_verification.render, 'never');
  assert.equal(page.results[0].news_evidence.status, 'verified');
});

test('SPEC82 strict search rejects search/API dates without publisher PAGE proof', async () => {
  let reads = 0;
  const result = await searchSearxng({ baseUrl: 'http://searxng.test', input: { query: 'report', time_range: 'day' },
    fetchImpl: fetchRecall, now: () => NOW, timeWindowStrict: true, evidencePolicy: 'spec82_page_only',
    verifyPage: async candidate => {
      reads++;
      return extractPageEvidence('<article>Undated report</article>', candidate.url, {}, new Date(NOW).toISOString(), { chinesePublicationDates: true });
    } });
  assert.deepEqual(result.results, [], 'E4 search dates cannot leak into strict results');
  assert.equal(reads, 1);
  assert.equal(result.evidence_policy, 'spec82_page_only');
  assert.equal(result.page_verification.verified_count, 0);
});

async function ledgerFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'wag-routing-'));
  const databasePath = path.join(root, 'budget.sqlite');
  const budget = createPersistentBudgetLedger({ databasePath, initialize: true, now: () => NOW });
  t.after(() => { budget.close(); return rm(root, { recursive: true, force: true }); });
  return { budget, databasePath };
}

function providerFixture(name, budget, calls, urls, { delayMs = 0, onSend } = {}) {
  const transport = createProviderHttpTransport({ name, credentials: { apiKey: 'dummy-key' }, now: () => NOW,
    tariff: name === 'baidu' ? { confirmed: true, freeQuotaOnly: true } : { confirmed: true, version: 'CNLiteBasic', costCents: 1 },
    request: (url, options, callback) => {
      const request = new EventEmitter();
      request.destroy = () => {};
      request.end = payload => {
        calls.push({ name, body: JSON.parse(payload), usage: budget.snapshot() });
        const done = onSend?.();
        const items = urls.map(url => ({ title: 'Publisher report', url, link: url, content: 'Report', snippet: 'Report', date: '2026-10-13T10:00:00Z', publishedTime: '2026-10-13T10:00:00Z' }));
        const response = Readable.from([JSON.stringify(name === 'baidu' ? { references: items } : { pageItems: items })]);
        response.statusCode = 200;
        response.headers = {};
        const reply = () => { done?.(); callback(response); };
        if (delayMs) setTimeout(reply, delayMs); else queueMicrotask(reply);
      };
      return request;
    } });
  return createProviderAdapter({ name, transport, enabled: true });
}

const publisherPage = (candidate, finalUrl = candidate.url, redirectValidated = false) => {
  if (typeof finalUrl !== 'string') finalUrl = candidate.url;
  return { ...extractPageEvidence('<meta property="article:published_time" content="2026-10-13T10:00:00Z"><article>Publisher report</article>', finalUrl, {}, new Date(NOW).toISOString(), { chinesePublicationDates: true }),
    requested_url: candidate.url, final_url: finalUrl, redirect_validated: redirectValidated };
};

test('strict page proof is bound to the requested URL unless the trusted reader records a validated redirect', async () => {
  const mismatched = await searchSearxng({ baseUrl: 'http://searxng.test', input: { query: 'report', time_range: 'day' },
    fetchImpl: fetchRecall, now: () => NOW, timeWindowStrict: true, evidencePolicy: 'spec82_page_only',
    verifyPage: candidate => publisherPage(candidate, 'https://other.example/unrelated') });
  assert.deepEqual(mismatched.results, []);
  assert.equal(mismatched.page_verification.verified_count, 0);
  const redirected = await searchSearxng({ baseUrl: 'http://searxng.test', input: { query: 'report', time_range: 'day' },
    fetchImpl: fetchRecall, now: () => NOW, timeWindowStrict: true, evidencePolicy: 'spec82_page_only',
    verifyPage: candidate => publisherPage(candidate, 'https://publisher.example/final-report', true) });
  assert.equal(redirected.results.length, 1);
  assert.equal(redirected.results[0].final_url, 'https://publisher.example/final-report');
  assert.equal(redirected.results[0].spec82_evidence.evidence_url, 'https://publisher.example/final-report');
});

test('unbound embedded article dates and mismatched canonical identities cannot verify or suppress fallback', async t => {
  const { budget } = await ledgerFixture(t);
  const calls = [];
  const router = createProviderRouting({ now: () => NOW, budget, estimateCostCents: name => name === 'baidu' ? 0 : 1,
    providers: [providerFixture('baidu', budget, calls, ['https://publisher.example/baidu-own']),
      providerFixture('aliyun', budget, calls, ['https://publisher.example/ali-own'])] });
  const variants = [{ url: 'https://publisher.example/other' }, { '@id': 'https://publisher.example/other#article' },
    { mainEntityOfPage: { '@id': 'https://publisher.example/other' } }];
  const candidates = variants.map((identity, index) => ({ ...recall[0], url: `https://publisher.example/current-${index}` }));
  const result = await router.search({ input: { query: 'identity report', time_range: 'day' }, results: candidates, strict: true,
    verifyPage: candidate => {
      const index = candidates.findIndex(item => item.url === candidate.url);
      if (index < 0) return publisherPage(candidate);
      const entity = { '@type': 'NewsArticle', ...variants[index], datePublished: '2026-10-13T10:00:00Z' };
      return extractPageEvidence(`<script type="application/ld+json">${JSON.stringify(entity)}</script><article>Undated current report</article>`,
        candidate.url, {}, new Date(NOW).toISOString(), { chinesePublicationDates: true });
    } });
  assert.deepEqual(result.results.map(item => item.url).sort(), ['https://publisher.example/ali-own', 'https://publisher.example/baidu-own']);
  assert.deepEqual(calls.map(item => item.name), ['baidu', 'aliyun']);
  assert.equal(result.page_verification.verified_count, 2);
  const canonical = await createProviderRouting({ now: () => NOW }).search({ input: { query: 'canonical report', time_range: 'day' }, results: recall, strict: true,
    verifyPage: candidate => extractPageEvidence('<link rel="canonical" href="https://publisher.example/other"><meta property="article:published_time" content="2026-10-13T10:00:00Z">',
      candidate.url, {}, new Date(NOW).toISOString(), { chinesePublicationDates: true }) });
  assert.deepEqual(canonical.results, []);
});

test('three validated redirect aliases count one final article and ordinary fallback continues', async t => {
  const { budget } = await ledgerFixture(t);
  const calls = [];
  const baidu = providerFixture('baidu', budget, calls, ['https://publisher.example/extra']);
  const router = createProviderRouting({ now: () => NOW, providers: [baidu], budget, estimateCostCents: () => 0 });
  const aliases = Array.from({ length: 3 }, (_, index) => ({ ...recall[0], url: `https://publisher.example/alias/${index}` }));
  const result = await searchSearxng({ baseUrl: 'http://searxng.test', input: { query: 'report', time_range: 'day' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: aliases }) }), now: () => NOW,
    timeWindowStrict: true, evidencePolicy: 'spec82_page_only', providerRouting: router,
    verifyPage: candidate => publisherPage(candidate, candidate.url.includes('/alias/') ? 'https://publisher.example/final' : candidate.url, true) });
  assert.equal(calls.length, 1, 'one final publisher article does not satisfy strict three');
  assert.equal(result.page_verification.verified_count, 2);
  assert.equal(result.results.length, 2);
  const final = result.results.find(item => item.url === 'https://publisher.example/final');
  assert.equal(final.final_url, final.spec82_evidence.evidence_url);
  assert.equal(final.requested_urls.length, 3);
  assert.ok(result.page_verification.read_attempts <= 20);
});

test('strict small recall fuses Baidu then Ali with durable reserve-before-send and canonical caches', async t => {
  const { budget } = await ledgerFixture(t);
  const calls = [];
  const baidu = providerFixture('baidu', budget, calls, ['https://publisher.example/articles/baidu']);
  const aliyun = providerFixture('aliyun', budget, calls, ['https://publisher.example/articles/ali', recall[0].url]);
  const router = createProviderRouting({ now: () => NOW, providers: [baidu, aliyun], budget, estimateCostCents: name => name === 'baidu' ? 0 : 1 });
  const search = () => searchSearxng({ baseUrl: 'http://searxng.test', input: { query: 'report', time_range: 'day' }, fetchImpl: fetchRecall,
    now: () => NOW, timeWindowStrict: true, evidencePolicy: 'spec82_page_only', providerRouting: router, verifyPage: publisherPage });
  const result = await search();
  assert.equal(result.results.length, 3);
  assert.deepEqual(calls.map(item => item.name), ['baidu', 'aliyun']);
  assert.equal(calls[0].usage.providers.baidu.dailyCalls, 1);
  assert.equal(calls[1].usage.providers.aliyun.monthlyCents, 1);
  assert.ok(result.results.every(item => item.state === 'verified' && ['E1', 'E2'].includes(item.date_level)));
  assert.deepEqual(result.results[0].providers, ['searxng', 'aliyun']);
  const cached = await search();
  assert.equal(calls.length, 2, 'canonical cache hits must not charge or send again');
  assert.deepEqual(cached.provider_attempts.map(item => item.status), ['cache_hit', 'cache_hit']);
  assert.equal(budget.snapshot().globalMonthlyCents, 1);
});

test('long E4-only free recall leaves bounded publisher-read shares for real provider candidates', async t => {
  const { budget } = await ledgerFixture(t);
  const calls = [];
  const free = Array.from({ length: 20 }, (_, index) => ({ ...recall[0], url: `https://publisher.example/free/${index}` }));
  const baidu = providerFixture('baidu', budget, calls, ['https://publisher.example/paid/a', free[0].url]);
  const aliyun = providerFixture('aliyun', budget, calls, ['https://publisher.example/paid/b', 'https://publisher.example/paid/c', 'https://publisher.example/paid/a']);
  const router = createProviderRouting({ now: () => NOW, providers: [baidu, aliyun], budget, estimateCostCents: name => name === 'baidu' ? 0 : 1 });
  const reads = [];
  const result = await searchSearxng({ baseUrl: 'http://searxng.test', input: { query: 'report', time_range: 'day' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: free }) }), now: () => NOW,
    timeWindowStrict: true, evidencePolicy: 'spec82_page_only', providerRouting: router, verifyPage: candidate => {
      reads.push(candidate.url);
      return candidate.url.includes('/paid/') ? publisherPage(candidate)
        : extractPageEvidence('<article>Undated free report</article>', candidate.url, {}, new Date(NOW).toISOString(), { chinesePublicationDates: true });
    } });
  assert.equal(result.results.length, 3, 'valid fallback must not be discarded after charging');
  assert.deepEqual(calls.map(item => item.name), ['baidu', 'aliyun']);
  assert.ok(reads.length <= 20);
  assert.equal(new Set(reads).size, reads.length, 'URL duplicates use one publisher read');
  assert.deepEqual(result.results.find(item => item.url.endsWith('/paid/a')).providers, ['baidu', 'aliyun']);
});

test('overdue PAGE deadline stops microtask-queued reads before delayed abort timers run', async t => {
  const { budget } = await ledgerFixture(t);
  const calls = [];
  const router = createProviderRouting({ now: () => NOW, providers: [providerFixture('baidu', budget, calls, ['https://publisher.example/paid'])],
    budget, estimateCostCents: () => 0, pageTimeoutMs: 20 });
  let reads = 0;
  let ready;
  let resolveFirst;
  const twoStarted = new Promise(resolve => { ready = resolve; });
  const operation = router.search({ input: { query: 'report', time_range: 'day' }, strict: true,
    results: Array.from({ length: 6 }, (_, index) => ({ ...recall[0], url: `https://publisher.example/overdue/${index}` })),
    verifyPage: (candidate, { signal }) => new Promise((resolve, reject) => {
      reads++;
      if (reads === 1) resolveFirst = () => resolve(publisherPage(candidate));
      if (reads === 2) ready();
      signal.addEventListener('abort', () => reject(new Error('offline abort')), { once: true });
    }) });
  await twoStarted;
  const until = performance.now() + 50;
  while (performance.now() < until) { /* Deliberately delay timer delivery, not the absolute deadline. */ }
  resolveFirst();
  const result = await operation;
  assert.equal(reads, 2, 'overdue deadline must be checked before another read is queued');
  assert.deepEqual(result.results, [], 'proof completing after the deadline is unusable');
  assert.equal(calls.length, 0, 'overdue PAGE work must not admit provider spending');
});

test('page work uses concurrency two and cancellation stops queued reads and unusable paid fallback', async t => {
  const { budget } = await ledgerFixture(t);
  const calls = [];
  const baidu = providerFixture('baidu', budget, calls, ['https://publisher.example/paid/a']);
  const router = createProviderRouting({ now: () => NOW, providers: [baidu], budget, estimateCostCents: () => 0, pageTimeoutMs: 30 });
  let active = 0;
  let maximum = 0;
  let reads = 0;
  let aborted = 0;
  const many = Array.from({ length: 20 }, (_, index) => ({ ...recall[0], url: `https://publisher.example/slow/${index}` }));
  const started = Date.now();
  const result = await searchSearxng({ baseUrl: 'http://searxng.test', input: { query: 'report', time_range: 'day' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ results: many }) }), now: () => NOW, signal: new AbortController().signal,
    timeWindowStrict: true, evidencePolicy: 'spec82_page_only', providerRouting: router, verifyPage: (candidate, { signal }) => {
      reads++;
      active++;
      maximum = Math.max(maximum, active);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { active--; resolve(publisherPage(candidate)); }, 100);
        signal.addEventListener('abort', () => { clearTimeout(timer); active--; aborted++; reject(new Error('offline abort')); }, { once: true });
      });
    } });
  assert.equal(maximum, 2);
  assert.equal(reads, 2, 'deadline stops queued publisher reads');
  assert.equal(aborted, 2);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(result.results, []);
  assert.equal(calls.length, 0, 'do not charge providers after verification time is exhausted');
  assert.ok(result.provider_attempts.some(item => item.status === 'verification_budget_exhausted'));
  assert.equal(budget.snapshot().providers.baidu, undefined);
});

test('one absolute search deadline includes free recall and clips the remaining publisher work', async () => {
  const started = Date.now();
  let aborted = 0;
  const result = await searchSearxng({ baseUrl: 'http://searxng.test', input: { query: 'report', time_range: 'day' },
    evidencePolicy: 'spec82_page_only', timeWindowStrict: true, now: () => NOW, searchTimeoutMs: 100,
    fetchImpl: async () => { await new Promise(resolve => setTimeout(resolve, 60)); return { ok: true, json: async () => ({ results: recall }) }; },
    verifyPage: (candidate, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(publisherPage(candidate)), 200);
      signal.addEventListener('abort', () => { aborted++; clearTimeout(timer); reject(new Error('fixture abort')); }, { once: true });
    }) });
  assert.equal(aborted, 1);
  assert.deepEqual(result.results, []);
  assert.ok(Date.now() - started < 220, 'publisher work cannot receive a fresh deadline after free recall');
});

test('elapsed caller deadline prevents queued provider reservation and send without waiting for abort delivery', async t => {
  const { budget } = await ledgerFixture(t);
  const calls = [];
  let sent;
  const firstSent = new Promise(resolve => { sent = resolve; });
  const router = createProviderRouting({ now: () => NOW, budget, estimateCostCents: () => 0,
    providers: [providerFixture('baidu', budget, calls, [recall[0].url], { delayMs: 100, onSend: () => sent() })] });
  const first = router.dispatch({ provider: 'baidu', query: 'first' });
  await firstSent;
  const controller = new AbortController();
  const queued = router.dispatch({ provider: 'baidu', query: 'overdue', signal: controller.signal, deadlineAt: performance.now() + 20 });
  const until = performance.now() + 50;
  while (performance.now() < until) { /* Delay timer delivery while the send stays queued. */ }
  await first;
  const result = await queued;
  assert.equal(result.attempts[0].status, 'timeout');
  assert.equal(calls.length, 1);
  assert.equal(budget.snapshot().providers.baidu.dailyCalls, 1);
  assert.equal(controller.signal.aborted, false);
});

test('concurrent searches serialize provider sends and single-flight identical canonical dispatches', async t => {
  const { budget } = await ledgerFixture(t);
  const calls = [];
  let active = 0;
  let maximum = 0;
  const baidu = providerFixture('baidu', budget, calls, ['https://publisher.example/article'], { delayMs: 20,
    onSend: () => { active++; maximum = Math.max(maximum, active); return () => { active--; }; } });
  const router = createProviderRouting({ now: () => NOW, providers: [baidu], budget, estimateCostCents: () => 0 });
  const search = query => router.search({ input: { query }, results: [], strict: false });
  await Promise.all([search('first'), search('second'), search('  first  ')]);
  assert.equal(maximum, 1, 'all provider sends in the router instance are serial');
  assert.equal(calls.length, 2, 'identical canonical requests share their pending dispatch');
  assert.equal(budget.snapshot().providers.baidu.dailyCalls, 2);
});

async function controlledRuntime(t) {
  const { budget, databasePath } = await ledgerFixture(t);
  const calls = [];
  let sent;
  const runtime = createSearchProviderRuntime({ env: { WAG_SEARCH_BAIDU_ENABLED: '1', APPBUILDER_API_KEY: 'dummy-key', WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: '1' }, databasePath, now: () => NOW,
    request: (url, options, callback) => {
      const req = new EventEmitter();
      req.destroyed = false;
      req.destroy = () => { req.destroyed = true; };
      req.end = payload => {
        const call = { query: JSON.parse(payload).messages[0].content, req, release() {
          const res = Readable.from(['{"references":[]}']);
          res.statusCode = 200;
          res.headers = {};
          callback(res);
        } };
        calls.push(call);
        sent?.();
      };
      return req;
    } });
  return { runtime, budget, calls, whenSent: () => calls.length ? Promise.resolve() : new Promise(resolve => { sent = resolve; }) };
}

test('one single-flight waiter abort does not cancel another waiter or a late joiner', async t => {
  const { runtime, budget, calls, whenSent } = await controlledRuntime(t);
  try {
    const firstSignal = new AbortController();
    const first = runtime.dispatch({ provider: 'baidu', query: 'same', signal: firstSignal.signal });
    const second = runtime.dispatch({ provider: 'baidu', query: 'same' });
    await whenSent();
    firstSignal.abort();
    assert.equal((await first).attempts[0].status, 'timeout');
    const late = runtime.dispatch({ provider: 'baidu', query: ' same ' });
    assert.equal(calls[0].req.destroyed, false);
    calls[0].release();
    assert.equal((await second).attempts[0].status, 'empty');
    assert.equal((await late).attempts[0].status, 'empty');
    assert.equal(calls.length, 1);
    assert.equal(budget.snapshot().providers.baidu.dailyCalls, 1);
  } finally { runtime.close(); }
});

test('all canceled queued waiters cannot be resurrected into a charged no-send operation', async t => {
  const { runtime, budget, calls, whenSent } = await controlledRuntime(t);
  try {
    const holding = runtime.dispatch({ provider: 'baidu', query: 'holding' });
    await whenSent();
    const cancel = new AbortController();
    const queued = runtime.dispatch({ provider: 'baidu', query: 'queued', signal: cancel.signal });
    cancel.abort();
    assert.equal((await queued).attempts[0].status, 'timeout');
    const late = runtime.dispatch({ provider: 'baidu', query: 'queued' });
    calls[0].release();
    await holding;
    assert.equal((await late).attempts[0].status, 'timeout');
    assert.equal(calls.length, 1);
    assert.equal(budget.snapshot().providers.baidu.dailyCalls, 1, 'cancel before reservation consumes zero allowance');
  } finally { runtime.close(); }
});

test('all single-flight waiters abort after send destroys the request without refund', async t => {
  const { runtime, budget, calls, whenSent } = await controlledRuntime(t);
  try {
    const a = new AbortController();
    const b = new AbortController();
    const first = runtime.dispatch({ provider: 'baidu', query: 'active', signal: a.signal });
    const second = runtime.dispatch({ provider: 'baidu', query: 'active', signal: b.signal });
    await whenSent();
    a.abort();
    assert.equal(calls[0].req.destroyed, false);
    b.abort();
    assert.equal((await first).attempts[0].status, 'timeout');
    assert.equal((await second).attempts[0].status, 'timeout');
    assert.equal(calls[0].req.destroyed, true);
    assert.equal(calls.length, 1);
    assert.equal(budget.snapshot().providers.baidu.dailyCalls, 1, 'sent calls are never refunded');
  } finally { runtime.close(); }
});

test('bounded page cache re-evaluates current windows and wider strict week uses seven days', async () => {
  let clock = NOW;
  let reads = 0;
  const router = createProviderRouting({ now: () => clock });
  const read = candidate => {
    reads++;
    return extractPageEvidence('<meta property="article:published_time" content="2026-10-10T10:00:00Z"><article>Report</article>', candidate.url, {}, new Date(clock).toISOString(), { chinesePublicationDates: true });
  };
  const search = time_range => searchSearxng({ baseUrl: 'http://searxng.test', input: { query: 'report', time_range },
    fetchImpl: fetchRecall, now: () => clock, timeWindowStrict: true, evidencePolicy: 'spec82_page_only', providerRouting: router, verifyPage: read });
  assert.equal((await search('week')).results.length, 1, 'week is evaluated with a seven-day instant window');
  assert.equal((await search('day')).results.length, 0);
  assert.equal(reads, 1, 'cache holds page evidence, not a window-relative verdict');
  clock += 7 * 86400000 + 1;
  assert.equal((await search('week')).results.length, 0);
  assert.equal(reads, 2, 'seven-day evidence TTL expires');
});
