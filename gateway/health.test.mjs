import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createReadiness } from './readiness.mjs';
import { waitForListening } from './test-fixtures/wait-for-listening.mjs';

const token = 'offline-gateway-token-'.repeat(3);
const crawlToken = 'offline-crawler-secret-'.repeat(3);
const validSearch = { results: [{ title: 'Example', url: 'https://example.com/', content: 'An example result' }] };

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function gatewayFixture(t, { search = validSearch, searchTiming, searchDelayMs = 0, crawler = { ok: true, initialized: true, lifecycle: 'ready' }, proxyHang = false, requestTimeoutMs = 8000, env = {} } = {}) {
  const counts = { search: 0, crawler: 0, crawl: 0 };
  const backend = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/search')) {
      counts.search++;
      if (searchTiming !== undefined) res.setHeader('server-timing', searchTiming);
      if (!searchDelayMs) return res.end(JSON.stringify(search));
      const timer = setTimeout(() => res.end(JSON.stringify(search)), searchDelayMs);
      res.once('close', () => clearTimeout(timer));
      return;
    }
    if (req.url === '/crawl') { counts.crawl++; res.statusCode = 500; return res.end('{}'); }
    if (req.url === '/readyz' || req.url === '/healthz') { counts.crawler++; return res.end(JSON.stringify(crawler)); }
    res.statusCode = 405; res.end('{}');
  });
  const backendUrl = await listen(backend);
  const proxy = http.createServer();
  const proxySockets = new Set();
  const proxyState = { active: 0, closed: 0 };
  proxy.on('connect', (_req, socket) => {
    proxySockets.add(socket); proxyState.active++;
    socket.once('close', () => { proxySockets.delete(socket); proxyState.active--; proxyState.closed++; });
    socket.on('end', () => socket.destroy());
    socket.resume();
    if (!proxyHang) socket.end('HTTP/1.1 503 Offline fixture\r\nConnection: close\r\n\r\n');
  });
  const proxyUrl = await listen(proxy);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wag-health-'));
  const preload = path.join(directory, 'dns-fixture.mjs');
  // Only the isolated child resolves the fixed public connectivity probe offline.
  await writeFile(preload, `import dns from 'node:dns/promises';\nconst original = dns.lookup;\ndns.lookup = (host, options) => host === 'example.com' ? Promise.resolve([{address:'93.184.216.34',family:4}]) : original(host, options);\n`);
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(import.meta.dirname, 'server.mjs')], {
    env: { ...process.env, GATEWAY_HOST: '127.0.0.1', GATEWAY_BIND_HOST: '127.0.0.1', GATEWAY_ALLOWED_HOSTS: '127.0.0.1', GATEWAY_PORT: String(port), GATEWAY_TOKEN: token, GATEWAY_ALLOW_ANONYMOUS: undefined, CRAWL4AI_TOKEN: crawlToken, CRAWL4AI_URL: backendUrl, SEARXNG_URL: backendUrl, PLAYWRIGHT_MCP_URL: `${backendUrl}/mcp`, EGRESS_PROXY: proxyUrl, GATEWAY_PROBE_TIMEOUT_MS: undefined, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    child.kill(); await exited;
    backend.closeAllConnections(); proxy.closeAllConnections();
    for (const socket of proxySockets) socket.destroy();
    await Promise.all([new Promise(resolve => backend.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
    assert.ok(!logs.includes(token) && !logs.includes(crawlToken), 'gateway logs must not contain tokens');
  });
  const base = `http://127.0.0.1:${port}`;
  const request = (route, authenticated = true) => fetch(`${base}${route}`, { headers: authenticated ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(requestTimeoutMs) });
  await waitForListening(child);
  return { base, request, counts, proxyState, logs: () => logs };
}

test('gateway accepts a completed zero-hit search with partially blocked engines', async t => {
  const { request } = await gatewayFixture(t, {
    search: { results: [], unresponsive_engines: [['google', 'CAPTCHA'], ['brave', 'rate limited']] },
    searchTiming: 'total;dur=8000, render;dur=1, total_0_bing;dur=200, load_0_bing;dur=199',
  });
  const response = await request('/readyz');
  assert.equal(response.status, 503); // Only the offline public-egress fixture fails.
  const search = (await response.json()).dependencies.find(item => item.name === 'searxng');
  assert.equal(search.ok, true);
  assert.equal(search.result_count, 0);
  assert.equal(search.responsive_engine_count, 1);
  assert.deepEqual(search.unresponsive_engines, [['google', 'CAPTCHA'], ['brave', 'rate limited']]);
});

test('gateway rejects empty search without evidence of a completed engine even with HTTP 200', async t => {
  const fixture = await gatewayFixture(t, { search: { results: [], unresponsive_engines: [['bing', 'timeout']] } });
  const response = await fixture.request('/readyz');
  const readiness = await response.json();
  const search = readiness.dependencies.find(item => item.name === 'searxng');
  assert.equal(search.ok, false);
  assert.equal(search.error.kind, 'search_empty');
  assert.deepEqual(search.unresponsive_engines, [['bing', 'timeout']]);
});

test('gateway liveness is authenticated and does not evaluate dependencies', async t => {
  const { request, counts } = await gatewayFixture(t);
  assert.equal((await request('/healthz', false)).status, 401);
  assert.equal((await request('/readyz', false)).status, 401);
  for (let i = 0; i < 3; i++) assert.equal((await request('/healthz')).status, 200);
  assert.deepEqual(counts, { search: 0, crawler: 0, crawl: 0 });
  const first = await (await request('/readyz')).json();
  const second = await (await request('/readyz')).json();
  assert.equal(first.checked_at, second.checked_at);
  assert.equal(first.core_ok, true);
  assert.equal(first.status, 'degraded'); // Only the offline public-egress fixture fails.
  assert.deepEqual(counts, { search: 1, crawler: 1, crawl: 0 });
});

test('default and explicit authenticated modes retain token validation and authorization', async t => {
  for (const flag of [undefined, '0']) {
    await t.test(flag === undefined ? 'unset' : flag, async t => {
      for (const value of [undefined, 'short']) {
        await t.test(value === undefined ? 'missing token' : 'short token', async t => {
          await assert.rejects(gatewayFixture(t, { env: { GATEWAY_ALLOW_ANONYMOUS: flag, GATEWAY_TOKEN: value } }), /GATEWAY_TOKEN must be at least 32 characters/);
        });
      }
      const { base, request, logs } = await gatewayFixture(t, { env: { GATEWAY_ALLOW_ANONYMOUS: flag } });
      assert.equal((await request('/readyz', false)).status, 401);
      const wrong = await fetch(`${base}/healthz`, { headers: { authorization: 'Bearer wrong' }, signal: AbortSignal.timeout(8000) });
      assert.equal(wrong.status, 401);
      assert.equal((await request('/healthz')).status, 200);
      assert.ok(!logs().includes('WITHOUT authentication'));
    });
  }
});

test('gateway rejects anonymous flag values other than unset, 0 or 1', async t => {
  for (const value of ['', 'true', '2']) {
    await t.test(JSON.stringify(value), async t => {
      await assert.rejects(gatewayFixture(t, { env: { GATEWAY_ALLOW_ANONYMOUS: value } }), /GATEWAY_ALLOW_ANONYMOUS must be unset, 0 or 1/);
    });
  }
});

test('anonymous gateway starts without a token and serves unauthenticated readiness', async t => {
  const { request } = await gatewayFixture(t, { env: { GATEWAY_ALLOW_ANONYMOUS: '1', GATEWAY_TOKEN: undefined } });
  const response = await request('/readyz', false);
  assert.equal(response.status, 503); // The offline egress fixture makes readiness degraded.
  const readiness = await response.json();
  assert.equal(readiness.core_ok, true);
  assert.equal(readiness.status, 'degraded');
});

test('anonymous gateway accepts empty and short tokens but rejects incorrect authorization', async t => {
  for (const value of [undefined, '', 'short', token]) {
    await t.test(value === undefined ? 'missing token' : value === '' ? 'empty token' : value === token ? 'valid token' : 'short token', async t => {
      const { base, request } = await gatewayFixture(t, { env: { GATEWAY_ALLOW_ANONYMOUS: '1', GATEWAY_TOKEN: value } });
      assert.equal((await request('/healthz', false)).status, 200);
      for (const authorization of ['Bearer wrong', 'Basic wrong', 'Bearer', '']) {
        const response = await fetch(`${base}/healthz`, { headers: { authorization }, signal: AbortSignal.timeout(8000) });
        assert.equal(response.status, 401, JSON.stringify(authorization));
        assert.deepEqual(await response.json(), { error: 'unauthorized' });
      }
      if (value) {
        const response = await fetch(`${base}/healthz`, { headers: { authorization: `Bearer ${value}` }, signal: AbortSignal.timeout(8000) });
        assert.equal(response.status, 200);
      }
    });
  }
});

test('anonymous gateway rate limits the client address even with changing forwarding or authorization headers', async t => {
  for (const value of [undefined, token]) {
    await t.test(value === undefined ? 'missing token' : 'configured token', async t => {
      const { base } = await gatewayFixture(t, { env: { GATEWAY_ALLOW_ANONYMOUS: '1', GATEWAY_TOKEN: value, GATEWAY_TOKEN_RATE_LIMIT: '2', GATEWAY_TOKEN_RATE_WINDOW_MS: '60000' } });
      const request = headers => fetch(`${base}/healthz`, { headers, signal: AbortSignal.timeout(8000) });
      assert.equal((await request({ authorization: 'Bearer wrong' })).status, 401);
      assert.equal((await request({ 'x-forwarded-for': '192.0.2.1' })).status, 200);
      assert.equal((await request({ 'x-forwarded-for': '192.0.2.2', ...(value ? { authorization: `Bearer ${value}` } : {}) })).status, 200);
      const response = await request({ 'x-forwarded-for': '192.0.2.3' });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get('retry-after'), '60');
      assert.deepEqual(await response.json(), { error: 'rate limit exceeded', blocked_reason: 'token_rate_limit' });
      assert.equal((await request({ authorization: 'Bearer wrong' })).status, 401);
      const otherClientStatus = await new Promise((resolve, reject) => {
        http.get(`${base}/healthz`, { localAddress: '127.0.0.2', agent: false, timeout: 8000 }, response => {
          response.resume();
          response.once('end', () => resolve(response.statusCode));
        }).on('error', reject).on('timeout', function () { this.destroy(new Error('client request timed out')); });
      });
      assert.equal(otherClientStatus, 200, 'a different client address retains its own quota');
    });
  }
});

test('anonymous gateway emits exactly one prominent startup warning', async t => {
  const { request, logs } = await gatewayFixture(t, { env: { GATEWAY_ALLOW_ANONYMOUS: '1' } });
  await request('/healthz', false);
  await request('/healthz', false);
  const warnings = logs().split('\n').filter(line => line.includes('WITHOUT authentication'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /WARNING.*GATEWAY_ALLOW_ANONYMOUS=1/);
});

test('gateway rejects invalid readiness probe deadlines at startup', async t => {
  for (const value of ['', ' ', '0', '-1', '1.5', 'NaN', 'Infinity', 'invalid', '9007199254740992']) {
    await t.test(JSON.stringify(value), async t => {
      await assert.rejects(gatewayFixture(t, { env: { GATEWAY_PROBE_TIMEOUT_MS: value } }), /GATEWAY_PROBE_TIMEOUT_MS must be a positive safe integer/);
    });
  }
});

test('gateway default readiness deadline allows SearXNG to finish beyond the overlay engine timeout', async t => {
  const { request } = await gatewayFixture(t, { searchDelayMs: 8200, requestTimeoutMs: 15000 });
  const response = await request('/readyz');
  assert.equal(response.status, 503); // Only the offline public-egress fixture fails.
  const readiness = await response.json();
  const search = readiness.dependencies.find(item => item.name === 'searxng');
  assert.equal(search.ok, true);
  assert.equal(search.result_count, 1);
  assert.ok(search.duration_ms >= 8200);
  assert.equal(readiness.core_ok, true);
});

test('gateway configurable readiness deadline still rejects slow SearXNG', async t => {
  const { request } = await gatewayFixture(t, { searchDelayMs: 300, env: { GATEWAY_PROBE_TIMEOUT_MS: '80' } });
  const started = performance.now();
  const response = await request('/readyz');
  assert.equal(response.status, 503);
  const search = (await response.json()).dependencies.find(item => item.name === 'searxng');
  assert.equal(search.ok, false);
  assert.equal(search.error.kind, 'dependency_timeout');
  assert.ok(search.duration_ms >= 80);
  assert.ok(performance.now() - started < 1000);
});

test('gateway SearXNG probe succeeds within an explicitly raised deadline', async t => {
  const { request } = await gatewayFixture(t, { searchDelayMs: 300, env: { GATEWAY_PROBE_TIMEOUT_MS: '1000' } });
  const search = (await (await request('/readyz')).json()).dependencies.find(item => item.name === 'searxng');
  assert.equal(search.ok, true);
  assert.equal(search.result_count, 1);
});

test('gateway readiness aborts a stalled CONNECT at its bounded deadline and caches the outcome', async t => {
  const { request, counts, proxyState } = await gatewayFixture(t, { proxyHang: true, env: { GATEWAY_PROBE_TIMEOUT_MS: '5000' } });
  const started = performance.now();
  const readiness = await (await request('/readyz')).json();
  assert.ok(performance.now() - started < 7000);
  assert.equal(readiness.status, 'degraded');
  assert.equal(readiness.dependencies.find(item => item.name === 'egress_proxy').error.kind, 'dependency_timeout');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(proxyState.active, 0, 'deadline destroys the pending CONNECT socket');
  assert.equal(proxyState.closed, 1);
  assert.equal((await (await request('/readyz')).json()).checked_at, readiness.checked_at);
  assert.deepEqual(counts, { search: 1, crawler: 1, crawl: 0 });
});

test('gateway rejects live but uninitialized crawling', async t => {
  const { request } = await gatewayFixture(t, { crawler: { ok: false, initialized: false, lifecycle: 'starting' } });
  const readiness = await (await request('/readyz')).json();
  assert.equal(readiness.core_ok, false);
  assert.equal(readiness.status, 'failed');
  assert.equal(readiness.dependencies.find(item => item.name === 'crawl4ai').error.kind, 'crawler_uninitialized');
});

async function readinessFixture(t, options = {}) {
  let state = { search: validSearch, crawler: { ok: true, initialized: true, lifecycle: 'ready' }, ...options.state };
  const counts = { search: 0, crawler: 0, playwright: 0, egress: 0 };
  const sockets = new Set();
  const backend = http.createServer((req, res) => {
    const name = req.url.startsWith('/search') ? 'search' : req.url === '/readyz' ? 'crawler' : 'playwright';
    counts[name]++;
    if (state[`${name}Hang`]) return;
    if (name === 'crawler') assert.equal(req.headers.authorization, `Bearer ${crawlToken}`);
    res.statusCode = state[`${name}Status`] ?? (name === 'playwright' ? 405 : 200);
    res.setHeader('content-type', 'application/json');
    if (name === 'search' && state.searchTiming !== undefined) res.setHeader('server-timing', state.searchTiming);
    if (state[`${name}Disconnect`]) return req.socket.destroy();
    res.end(state[`${name}Raw`] ?? JSON.stringify(state[name] ?? {}));
  });
  backend.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const url = await listen(backend);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => backend.close(resolve)); });
  const read = createReadiness({
    searxUrl: url, crawlUrl: url, crawlToken, playwrightUrl: `${url}/mcp`, secrets: [token, 'offline-extra-secret'],
    egressProbe: async signal => { counts.egress++; if (state.egressError) throw state.egressError; if (state.egressHang) return new Promise(() => {}); assert.equal(signal.aborted, false); return { http_status: 200 }; },
    ...options.config,
  });
  return { read, counts, set: change => { state = { ...state, ...change }; } };
}

test('readiness rejects malformed search and results without usable HTTP evidence', async t => {
  for (const search of [null, {}, { results: 'invalid' }, { results: [] }, { results: [], unresponsive_engines: 'invalid' }, { results: [null, {}, { url: 'javascript:alert(1)', title: 'Bad', content: 'Bad' }] }, { results: [{ url: 'https://example.com/', title: 42, content: 'Bad title type' }] }]) {
    const { read } = await readinessFixture(t, { state: { search } });
    const readiness = await read();
    assert.equal(readiness.ok, false);
    assert.equal(readiness.core_ok, true);
    assert.equal(readiness.dependencies.find(item => item.name === 'searxng').ok, false);
  }
  const { read } = await readinessFixture(t, { state: { searchRaw: '<html>not JSON</html>' } });
  assert.equal((await read()).dependencies[0].error.kind, 'dependency_invalid_data');
});

test('readiness repeatedly accepts zero hits only with positive completed-engine evidence', async t => {
  const { read, counts } = await readinessFixture(t, {
    state: {
      search: { results: [], unresponsive_engines: [['google', 'CAPTCHA'], ['brave', 'rate limited']] },
      searchTiming: 'total;dur=8000, render;dur=1, total_0_bing;dur=0, total_1_bing;dur=1, total_2_other_engine name;dur=1.25',
    },
    config: { cacheMs: 0 },
  });
  for (let i = 0; i < 6; i++) {
    const readiness = await read();
    assert.equal(readiness.ok, true);
    assert.equal(readiness.status, 'passed');
    assert.equal(readiness.dependencies[0].result_count, 0);
    assert.equal(readiness.dependencies[0].responsive_engine_count, 2);
  }
  assert.equal(counts.search, 6, 'each probe evaluated a fresh response');
});

test('readiness rejects dead-but-200 and all-unresponsive searches despite timing headers', async t => {
  for (const state of [
    { searchRaw: '' },
    { searchRaw: 'not JSON' },
    { search: {} },
    { search: { results: [] } },
    { search: { results: [], unresponsive_engines: null } },
    { search: { results: [], unresponsive_engines: [[]] } },
    { search: { results: [], unresponsive_engines: [['bing']] } },
    { search: { results: [], unresponsive_engines: [[42, 'timeout']] } },
    { search: { results: [], unresponsive_engines: [] }, searchTiming: undefined },
    { search: { results: [], unresponsive_engines: [] }, searchTiming: 'total;dur=1, render;dur=1, load_0_bing;dur=1' },
    { search: { results: [], unresponsive_engines: [] }, searchTiming: 'total_0_bing;dur=NaN, total_1_google;dur=-1, total_2_brave;dur=Infinity' },
    { search: { results: [], unresponsive_engines: [['bing', 'timeout', true], ['google', 'CAPTCHA']] }, searchTiming: 'total_0_bing;dur=1, total_1_google;dur=2' },
    { search: { results: [{ ...validSearch.results[0], engine: 'bing' }], unresponsive_engines: [['bing', 'timeout']] } },
    { search: { results: [{ url: 'javascript:alert(1)', title: 'Bad' }], unresponsive_engines: [] } },
  ]) {
    const { read } = await readinessFixture(t, { state: { searchTiming: 'total_0_bing;dur=1', ...state } });
    const readiness = await read();
    assert.equal(readiness.ok, false, JSON.stringify(state));
    assert.equal(readiness.dependencies[0].ok, false);
  }
});

test('readiness reports a disconnected SearXNG as unhealthy within the configurable deadline', async t => {
  const { read } = await readinessFixture(t, { state: { searchDisconnect: true }, config: { probeTimeoutMs: 500 } });
  const started = performance.now();
  const search = (await read()).dependencies[0];
  assert.equal(search.ok, false);
  assert.equal(search.error.kind, 'dependency_error');
  assert.ok(performance.now() - started < 1000);
});

test('readiness preserves sanitized backend and engine failure diagnostics', async t => {
  const detail = `engine timeout ${token} ${crawlToken} offline-extra-secret https://user:password@engine.test/search?api_key=unknown#secret Authorization: Bearer unknown-header-secret`;
  const { read } = await readinessFixture(t, { state: { searchStatus: 502, searchRaw: detail, crawlerStatus: 503, crawlerRaw: '{"detail":"crawler starting"}' } });
  const readiness = await read();
  const serialized = JSON.stringify(readiness);
  for (const secret of [token, crawlToken, 'offline-extra-secret', 'user:password', 'api_key=unknown', 'unknown-header-secret']) assert.ok(!serialized.includes(secret), secret);
  assert.equal(readiness.dependencies[0].error.kind, 'dependency_http_status');
  assert.equal(readiness.dependencies[0].error.http_status, 502);
  assert.match(readiness.dependencies[0].error.message, /engine timeout/);
  assert.match(readiness.dependencies[1].error.message, /crawler starting/);
  const engines = await readinessFixture(t, { state: { search: { ...validSearch, unresponsive_engines: [['bing', `timeout Bearer unknown-engine-secret ${crawlToken}`]] } } });
  const result = await engines.read();
  assert.equal(result.ok, true);
  assert.match(result.dependencies[0].unresponsive_engines[0][1], /timeout/);
  assert.ok(!JSON.stringify(result).includes('unknown-engine-secret'));
});

test('readiness coalesces stalled probes, caches bounded failures and recovers after expiry', async t => {
  let clock = 1000;
  const { read, counts, set } = await readinessFixture(t, { state: { searchHang: true, crawlerHang: true, playwrightHang: true, egressHang: true }, config: { now: () => clock, probeTimeoutMs: 80 } });
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: 8 }, () => read()));
  assert.ok(performance.now() - started < 1000, 'parallel probes have one bounded deadline');
  assert.equal(results[0].status, 'failed');
  for (const dependency of results[0].dependencies) assert.equal(dependency.error.kind, 'dependency_timeout');
  assert.ok(results.every(result => result === results[0]));
  assert.deepEqual(counts, { search: 1, crawler: 1, playwright: 1, egress: 1 });
  set({ searchHang: false, crawlerHang: false, playwrightHang: false, egressHang: false });
  clock = 10999;
  assert.equal(await read(), results[0]);
  clock = 11000;
  const recovered = await read();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.status, 'passed');
  assert.deepEqual(counts, { search: 2, crawler: 2, playwright: 2, egress: 2 });
});

test('readiness never echoes quoted authorization or credential fields from backend errors', async t => {
  const { read } = await readinessFixture(t, { state: { searchStatus: 401, searchRaw: '{"detail":"backend auth failure","token":"unknown-json-secret","Authorization":"Basic unknown-basic-secret"}' } });
  const value = JSON.stringify(await read());
  assert.ok(!value.includes('unknown-json-secret'));
  assert.ok(!value.includes('unknown-basic-secret'));
  assert.match(value, /backend auth failure/);
});

test('readiness accepts normalized title-only evidence and retains engine details on backend errors', async t => {
  const titleOnly = await readinessFixture(t, { state: { search: { results: [{ url: 'https://example.com/', title: 'Example' }] } } });
  assert.equal((await titleOnly.read()).ok, true);
  const backendError = await readinessFixture(t, { state: { searchStatus: 503, search: { unresponsive_engines: [['bing', `timeout ${crawlToken}`]], error: 'engines unavailable' } } });
  const search = (await backendError.read()).dependencies[0];
  assert.equal(search.error.kind, 'dependency_http_status');
  assert.match(search.unresponsive_engines[0][1], /timeout/);
  assert.ok(!JSON.stringify(search).includes(crawlToken));
});

test('readiness bounds oversized dependency responses and preserves transport categories', async t => {
  const oversized = await readinessFixture(t, { state: { searchRaw: 'x'.repeat(65537) } });
  assert.equal((await oversized.read()).dependencies[0].error.kind, 'dependency_response_too_large');
  const network = await readinessFixture(t, { state: { egressError: Object.assign(new Error('proxy refused'), { kind: 'egress_connect', cause: { code: 'ECONNREFUSED' } }) } });
  const readiness = await network.read();
  assert.equal(readiness.status, 'degraded');
  assert.equal(readiness.dependencies[3].error.kind, 'egress_connect');
  assert.equal(readiness.dependencies[3].error.code, 'ECONNREFUSED');
});
