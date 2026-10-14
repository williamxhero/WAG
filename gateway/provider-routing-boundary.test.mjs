import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { listenHttp } from './fixtures/safe-listen.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
async function listen(server, options = {}) {
  const { port } = await listenHttp(server, options);
  return port;
}

async function fixture(t, env = {}, injection = null, options = {}) {
  injection ??= await diagnosticInjection(t);
  const recalled = [{ title: 'Local fixture report', url: 'http://127.0.0.1:7777/articles/report', content: 'A synthetic fixture report, not production supply.', publishedDate: new Date().toISOString(), engine: 'offline' }];
  const queries = [];
  const upstream = http.createServer((req, res) => {
    queries.push(new URL(req.url, 'http://searxng.test'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: recalled, number_of_results: 1 }));
  });
  const upstreamPort = await listen(upstream, options);
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const reservation = http.createServer();
  const port = await listen(reservation, options);
  await new Promise(resolve => reservation.close(resolve));
  const token = 'dummy-offline-provider-routing-token-00000000';
  const serverPath = path.join(moduleDir, 'server.mjs');
  const childArgs = injection ? ['--import', pathToFileURL(injection.bootstrap).href, serverPath] : [serverPath];
  const child = spawn(process.execPath, childArgs, {
    cwd: moduleDir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      TMP: process.env.TMP, TEMP: process.env.TEMP, TMPDIR: process.env.TMPDIR,
      GATEWAY_TOKEN: token, GATEWAY_HOST: '127.0.0.1', GATEWAY_BIND_HOST: '127.0.0.1', GATEWAY_ALLOWED_HOSTS: '127.0.0.1',
      GATEWAY_PORT: String(port), SEARXNG_URL: `http://127.0.0.1:${upstreamPort}`, ...injection?.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  await new Promise((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${logs}`)), 10000);
    child.stdout.on('data', chunk => { logs += chunk; if (logs.includes('listening on')) { clearTimeout(timer); resolve(); } });
    child.stderr.on('data', chunk => { logs += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`startup exit ${code}: ${logs}`)); });
  });
  const client = new Client({ name: 'offline-provider-route', version: '1.0.0' });
  t.after(() => client.close());
  if (injection) t.after(injection.cleanup);
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return { client, queries, search: args => client.callTool({ name: 'web_search', arguments: args }) };
}

async function diagnosticInjection(t, { poison = false, respond = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'wag-mcp-diagnostic-'));
  await mkdir(path.join(root, 'secrets'));
  const bootstrap = path.join(root, 'register-loader.mjs');
  const loader = path.join(root, 'loader.mjs');
  const runtimeWrapper = path.join(root, 'runtime-wrapper.mjs');
  const adapterWrapper = path.join(root, 'adapter-wrapper.mjs');
  const serverPath = path.join(moduleDir, 'server.mjs');
  const routingPath = path.join(moduleDir, 'provider-routing.mjs');
  const adapterPath = path.join(moduleDir, 'provider-adapters.mjs');
  await writeFile(bootstrap, `import { register } from 'node:module';\nregister(process.env.WAG_TEST_LOADER_URL, import.meta.url);\n`);
  await writeFile(loader, `export async function resolve(specifier, context, nextResolve) {
    if (specifier === './provider-routing.mjs' && context.parentURL === process.env.WAG_TEST_SERVER_URL) {
      return { url: process.env.WAG_TEST_RUNTIME_WRAPPER_URL, shortCircuit: true };
    }
    if (process.env.WAG_TEST_POISON === '1' && specifier === './provider-adapters.mjs' &&
        context.parentURL === process.env.WAG_TEST_ROUTING_URL) {
      return { url: process.env.WAG_TEST_ADAPTER_WRAPPER_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }\n`);
  await writeFile(runtimeWrapper, `import { appendFileSync } from 'node:fs';
import { createSearchProviderRuntime as createRuntime } from ${JSON.stringify(pathToFileURL(routingPath).href)};
import { createPersistentBudgetLedger } from ${JSON.stringify(pathToFileURL(path.join(moduleDir, 'provider-budget.mjs')).href)};
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
export function createSearchProviderRuntime() {
  const databasePath = process.env.WAG_TEST_DATABASE;
  if (process.env.WAG_TEST_INITIALIZE_DATABASE === '1') createPersistentBudgetLedger({ databasePath, initialize: true }).close();
  return createRuntime({ env: process.env, databasePath, secretPath: process.env.WAG_TEST_SECRET_PATH,
    request: (url, options, callback) => {
      appendFileSync(process.env.WAG_TEST_REQUEST_MARKER, 'request-called\\n');
      if (process.env.WAG_TEST_REQUEST_MODE !== 'respond') throw new Error('synthetic request denied');
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = () => {
        const body = JSON.stringify({ Response: { Version: 'lite', Pages: [JSON.stringify({ title: 'Synthetic Tencent page',
          url: 'https://127.0.0.1:7777/private-article', date: '2026-10-14', passage: 'Synthetic passage', site: 'fixture' })] } });
        const res = Readable.from([body]);
        res.statusCode = 200;
        res.headers = {};
        queueMicrotask(() => callback(res));
      };
      return req;
    } });
}\n`);
  await writeFile(adapterWrapper, `import { createProviderAdapter as createAdapter } from ${JSON.stringify(pathToFileURL(adapterPath).href)};
export function createProviderAdapter(options) {
  const adapter = createAdapter(options);
  return Object.freeze({ name: adapter.name, get enabled() { return adapter.enabled; },
    get posteriorVersion() { return adapter.posteriorVersion; }, cacheIdentity: input => adapter.cacheIdentity(input),
    async search(input) {
      const items = await adapter.search(input);
      if (adapter.name !== 'tencent' || process.env.WAG_TEST_POISON !== '1') return items;
      const copy = [...items];
      Object.defineProperty(copy, 'diagnostic', { value: { stage: 'complete', auth_success: true,
        page_count: 1, parsed_page_count: 1, result_count: 1, body: 'poison-response-body-sentinel', title: 'poison-title-sentinel' } });
      return copy;
    } });
}\n`);
  return { bootstrap, cleanup: () => rm(root, { recursive: true, force: true }),
    databasePath: path.join(root, 'provider-budget.sqlite'), requestMarker: path.join(root, 'request-marker.log'),
    env: { WAG_TEST_LOADER_URL: pathToFileURL(loader).href,
      WAG_TEST_RUNTIME_WRAPPER_URL: pathToFileURL(runtimeWrapper).href,
      WAG_TEST_ADAPTER_WRAPPER_URL: pathToFileURL(adapterWrapper).href,
      WAG_TEST_SERVER_URL: pathToFileURL(serverPath).href,
      WAG_TEST_ROUTING_URL: pathToFileURL(routingPath).href,
      WAG_TEST_POISON: poison ? '1' : '0', WAG_TEST_REQUEST_MODE: respond ? 'respond' : 'deny',
      WAG_TEST_INITIALIZE_DATABASE: respond ? '1' : '0', WAG_TEST_DATABASE: path.join(root, 'provider-budget.sqlite'),
      WAG_TEST_SECRET_PATH: path.join(root, 'secrets', 'providers.env'), WAG_TEST_REQUEST_MARKER: path.join(root, 'request-marker.log'),
      ...(respond ? { WAG_SEARCH_TENCENT_ENABLED: '1', WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: '1',
        TENCENTCLOUD_SECRET_ID: 'dummy-id', TENCENTCLOUD_SECRET_KEY: 'dummy-key' } : {}) } };
}

test('MCP emits only complete Tencent diagnostics and never promotes provider dates beyond E4', { timeout: 20000 }, async t => {
  const injection = await diagnosticInjection(t, { respond: true });
  const { search } = await fixture(t, { WAG_SEARCH_EVIDENCE_POLICY: 'spec82_page_only' }, injection);
  const result = await search({ query: '微信文章 report', time_range: 'day', time_window_strict: true });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = result.structuredContent;
  const attempt = payload.provider_attempts.find(item => item.provider === 'tencent');
  assert.deepEqual(attempt?.diagnostic, { stage: 'complete', auth_success: true, page_count: 1, parsed_page_count: 1, result_count: 1 }, JSON.stringify(payload));
  assert.deepEqual(payload.provider_attempts.filter(item => item.diagnostic).map(item => item.provider), ['tencent']);
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
  assert.deepEqual(payload.results, [], 'Tencent E4 date is not strict publisher PAGE evidence');
  assert.equal(payload.page_verification.verified_count, 0);
  assert.doesNotMatch(JSON.stringify(result), /dummy-id|dummy-key|poison|Synthetic Tencent page|Synthetic passage/);
});

test('MCP drops a poisoned Tencent diagnostic before structured and text serialization', { timeout: 20000 }, async t => {
  const injection = await diagnosticInjection(t, { poison: true, respond: true });
  const { search } = await fixture(t, { WAG_SEARCH_EVIDENCE_POLICY: 'spec82_page_only' }, injection);
  const result = await search({ query: '微信文章 report', time_range: 'day', time_window_strict: true });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = result.structuredContent;
  const attempt = payload.provider_attempts.find(item => item.provider === 'tencent');
  assert.equal(attempt?.status, 'success', JSON.stringify(payload));
  assert.equal(Object.hasOwn(attempt, 'diagnostic'), false);
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
  assert.deepEqual(payload.results, [], 'poisoned diagnostic cannot promote E4 to verified');
  assert.doesNotMatch(JSON.stringify(result), /poison-response-body-sentinel|poison-title-sentinel|dummy-id|dummy-key|Synthetic Tencent page|Synthetic passage/);
});

test('existing MCP web_search applies explicit page-only policy, rejects E4 and keeps SSRF closed', { timeout: 20000 }, async t => {
  const { search, queries, client } = await fixture(t, { WAG_SEARCH_EVIDENCE_POLICY: 'spec82_page_only' });
  const result = await search({ query: 'report', time_range: 'day', time_window_strict: true });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = result.structuredContent;
  assert.deepEqual(payload.results, [], 'private candidate and E4 cannot be strict verified');
  assert.equal(payload.evidence_policy, 'spec82_page_only');
  assert.equal(payload.page_verification.verified_count, 0);
  assert.ok(payload.provider_attempts.every(item => item.status === 'provider_unconfigured'));
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
  assert.equal(queries.length, 1);
  assert.equal(queries[0].searchParams.has('evidence_policy'), false);
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['web_browser', 'web_read', 'web_search']);
});

test('explicitly enabled provider with missing scratch ledger fails closed without sends while free search works', { timeout: 20000 }, async t => {
  const injection = await diagnosticInjection(t);
  const { search } = await fixture(t, { WAG_SEARCH_EVIDENCE_POLICY: 'spec82_page_only', WAG_SEARCH_BAIDU_ENABLED: '1',
    WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: '1', APPBUILDER_API_KEY: 'dummy-key' }, injection);
  const strict = await search({ query: 'report', time_range: 'day', time_window_strict: true });
  assert.notEqual(strict.isError, true, JSON.stringify(strict));
  assert.deepEqual(strict.structuredContent.results, []);
  assert.deepEqual(strict.structuredContent.provider_attempts[0], { provider: 'baidu', status: 'budget_storage_error' });
  assert.equal(strict.structuredContent.provider_budget, null, 'unknown budget is not fabricated zero');
  const free = await search({ query: 'report' });
  assert.equal(free.structuredContent.results.length, 1);
  await assert.rejects(stat(injection.databasePath), error => error.code === 'ENOENT');
  await assert.rejects(stat(injection.requestMarker), error => error.code === 'ENOENT');
});

test('page-only general recall does not wait for pages or trigger ordinary providers', { timeout: 20000 }, async t => {
  const { search } = await fixture(t, { WAG_SEARCH_EVIDENCE_POLICY: 'spec82_page_only' });
  const result = await search({ query: 'report', news_mode: 'ranked' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.results.length, 1);
  assert.equal(result.structuredContent.results[0].state, 'claimed');
  assert.equal(result.structuredContent.results[0].date_level, 'E4');
  assert.equal(result.structuredContent.page_verification.read_attempts, 0);
  assert.deepEqual(result.structuredContent.provider_attempts, []);
});

test('Fetch-safe provider fixture filters both allocations before real MCP search', { timeout: 20000 }, async t => {
  const close = async server => {
    if (!server.listening) return;
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  };
  let rawRequests = 0;
  const raw = http.createServer((_req, res) => { rawRequests++; res.end('offline port control'); });
  t.after(() => close(raw));
  const bindRaw = async port => {
    const listening = once(raw, 'listening');
    raw.listen(port, '127.0.0.1');
    await listening;
  };
  let forbidden = 1719;
  try { await bindRaw(forbidden); } catch (firstError) {
    if (firstError.code !== 'EADDRINUSE') throw firstError;
    t.diagnostic(`1719 unavailable: ${firstError.stack}`);
    forbidden = 2049;
    try { await bindRaw(forbidden); } catch (secondError) {
      throw new AggregateError([firstError, secondError], 'Forbidden-port controls unavailable; no skip');
    }
  }
  const rawUrl = new URL(`http://127.0.0.1:${forbidden}/mcp`);
  const rawStatus = await new Promise((resolve, reject) => {
    http.get(rawUrl, { agent: false }, response => {
      response.on('error', reject);
      response.once('end', () => resolve(response.statusCode));
      response.resume();
    }).on('error', reject);
  });
  assert.equal(rawStatus, 200);
  assert.equal(rawRequests, 1);
  await assert.rejects(fetch(rawUrl), error => error.cause?.message === 'bad port');
  const rawClient = new Client({ name: 'offline-forbidden-port-control', version: '1.0.0' });
  t.after(() => rawClient.close());
  await assert.rejects(rawClient.connect(new StreamableHTTPClientTransport(rawUrl)), error => error.cause?.message === 'bad port');
  assert.equal(rawRequests, 1, 'native Fetch and SDK sent zero requests beyond the raw HTTP control');
  t.diagnostic(`forbidden=${forbidden} raw_http=${rawStatus} fetch_cause=bad port sdk_cause=bad port fetch_sdk_requests=${rawRequests - 1}`);
  await rawClient.close();
  await close(raw);

  const allocations = [];
  const options = { listen: (server, bindOptions) => {
    let state = allocations.find(item => item.server === server);
    if (!state) {
      state = { server, attempts: 0, closes: 0, ports: [], requests: [] };
      allocations.push(state);
      t.after(() => close(server));
      server.on('close', () => { state.closes++; });
      server.on('listening', () => { state.ports.push(server.address().port); });
      server.on('request', () => { state.requests.push(server.address().port); });
    }
    assert.equal(server.listening, false);
    assert.equal(state.closes, state.ports.length, 'each published listener closes before rebind');
    assert.equal(state.requests.length, 0, 'port selection sends no HTTP requests');
    for (const other of allocations) {
      if (other.server.listening) assert.notEqual(other.server.address().port, forbidden, 'allocations never share a live forbidden listener');
    }
    server.listen({ ...bindOptions, port: state.attempts++ === 0 ? forbidden : 0 });
  } };
  const adapter = http.createServer((_req, res) => res.end('safe adapter'));
  t.after(() => close(adapter));
  const adapterPort = await listen(adapter, options);
  t.diagnostic(`adapter_port=${adapterPort} selection_requests=${allocations[0].requests.length}`);
  let response;
  try { response = await fetch(`http://127.0.0.1:${adapterPort}`); } catch (error) {
    t.diagnostic(`adapter_fetch_cause=${error.cause?.message} adapter_requests=${allocations[0].requests.length}`);
    throw error;
  }
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'safe adapter');
  assert.deepEqual(allocations[0].requests, [adapterPort]);
  assert.equal(allocations[0].ports[0], forbidden);
  assert.notEqual(adapterPort, forbidden);
  assert.ok(allocations[0].attempts >= 2 && allocations[0].attempts <= 25);
  assert.equal(allocations[0].closes, allocations[0].ports.length - 1);
  await close(adapter);
  assert.equal(allocations[0].closes, allocations[0].ports.length);

  const injection = await diagnosticInjection(t);
  t.after(injection.cleanup);
  const { search, queries } = await fixture(t, { WAG_SEARCH_EVIDENCE_POLICY: 'spec82_page_only' }, injection, options);
  assert.equal(allocations.length, 3, 'adapter plus distinct upstream and reservation used the same hook');
  const [, upstream, reservation] = allocations;
  for (const state of [upstream, reservation]) {
    assert.equal(state.ports[0], forbidden);
    assert.notEqual(state.ports.at(-1), forbidden);
    assert.ok(state.attempts >= 2 && state.attempts <= 25);
    assert.deepEqual(state.requests, []);
  }
  assert.equal(upstream.server.listening, true);
  assert.equal(upstream.closes, upstream.ports.length - 1);
  assert.equal(reservation.server.listening, false, 'reservation released before the child SDK connected');
  assert.equal(reservation.closes, reservation.ports.length);
  const probe = new Client({ name: 'offline-reserved-port-probe', version: '1.0.0' });
  t.after(() => probe.close());
  await probe.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${reservation.ports.at(-1)}/mcp`), {
    requestInit: { headers: { authorization: 'Bearer dummy-offline-provider-routing-token-00000000' } },
  }));
  assert.deepEqual((await probe.listTools()).tools.map(tool => tool.name).sort(), ['web_browser', 'web_read', 'web_search']);
  await probe.close();
  const result = await search({ query: 'report', news_mode: 'ranked' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.results.length, 1);
  assert.equal(result.structuredContent.results[0].state, 'claimed');
  assert.equal(result.structuredContent.results[0].date_level, 'E4');
  assert.deepEqual(result.structuredContent.provider_attempts, []);
  assert.equal(queries.length, 1);
  assert.deepEqual(upstream.requests, [upstream.ports.at(-1)]);
  assert.deepEqual(reservation.requests, []);
  await assert.rejects(stat(injection.databasePath), error => error.code === 'ENOENT');
  await assert.rejects(stat(injection.requestMarker), error => error.code === 'ENOENT');
  t.diagnostic(`upstream_port=${upstream.ports.at(-1)} upstream_attempts=${upstream.attempts} reservation_port=${reservation.ports.at(-1)} reservation_attempts=${reservation.attempts} sdk_connected=true search_requests=${queries.length} provider_sends=0`);
});
