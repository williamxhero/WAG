import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// MCP-boundary proof for the engine-supply diagnostics (SPEC #74). The search module tests the pool
// selection in isolation; this file checks that a *configured* pool actually shapes the outgoing
// SearXNG query and that `engine_pool` / `failure_classes` are forwarded to the MCP caller — while an
// unconfigured gateway still grows no pool keys.

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const SEARCH_BODY = {
  results: [{ title: 'Detailed report', url: 'https://publisher.example/2026/10/09/report', content: 'The full story.', engine: 'yandex' }],
  number_of_results: 1,
  unresponsive_engines: [['quark', '暂停服务: 验证码']],
};

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function gatewayFixture(t, env = {}) {
  const requests = [];
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://searxng.test');
    if (url.pathname !== '/search') { res.writeHead(404).end('unexpected fixture path'); return; }
    requests.push(url);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(SEARCH_BODY));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));

  const reservation = http.createServer();
  const gatewayPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));

  const token = crypto.randomUUID();
  const child = spawn(process.execPath, [path.join(moduleDir, 'server.mjs')], {
    cwd: moduleDir,
    env: {
      ...process.env,
      GATEWAY_TOKEN: token,
      CRAWL4AI_TOKEN: '',
      GATEWAY_BIND_HOST: '127.0.0.1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_ALLOWED_HOSTS: '127.0.0.1',
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TOKEN_RATE_LIMIT: '1000',
      SEARXNG_URL: `http://127.0.0.1:${upstreamPort}`,
      // Isolate the opt-in pools from any ambient configuration in the parent process.
      WAG_SEARCH_ENGINE_POOL_GENERAL: '',
      WAG_SEARCH_ENGINE_POOL_NEWS: '',
      WAG_SEARCH_ENGINE_POOL_STRICT: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`gateway startup timed out: ${output}`)), 10000);
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('web-access-gateway listening')) finish();
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => finish(new Error(`gateway exited during startup (${code}): ${output}`)));
  });

  const client = new Client({ name: 'search-engine-pool-contract-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  return { search: args => client.callTool({ name: 'web_search', arguments: args }), requests };
}

test('a configured pool shapes the upstream query and forwards engine_pool/failure_classes over MCP', { timeout: 30000 }, async t => {
  const { search, requests } = await gatewayFixture(t, { WAG_SEARCH_ENGINE_POOL_GENERAL: 'yandex,quark' });
  const result = await search({ query: 'report' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = result.structuredContent;

  assert.equal(requests.at(-1).searchParams.get('engines'), 'yandex,quark');
  assert.deepEqual(payload.engine_pool, { layer: 'general', engines: ['yandex', 'quark'], source: 'config' });
  assert.deepEqual(payload.unresponsive_engines, [['quark', '暂停服务: 验证码']]);
  assert.deepEqual(payload.failure_classes, { captcha: 1 });
  assert.equal(Object.hasOwn(payload, 'cooldown_engines'), false, 'captcha does not add a WAG-side cooldown');

  // text and structured MCP payloads agree.
  assert.deepEqual(JSON.parse(result.content[0].text), payload);
});

test('a strict pool only asks time_range engines over MCP', { timeout: 30000 }, async t => {
  const { search, requests } = await gatewayFixture(t, { WAG_SEARCH_ENGINE_POOL_STRICT: 'yandex,bing,quark,naver' });
  const result = await search({ query: '英伟达', time_range: 'day' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = result.structuredContent;

  assert.equal(requests.at(-1).searchParams.get('engines'), 'quark,naver');
  assert.equal(payload.engine_pool.layer, 'strict');
  assert.deepEqual(payload.engine_pool.rejected, ['yandex', 'bing']);
});

test('a gateway with no pool configured forwards no pool keys', { timeout: 30000 }, async t => {
  const { search, requests } = await gatewayFixture(t);
  const result = await search({ query: 'report' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = result.structuredContent;

  assert.equal(requests.at(-1).searchParams.has('engines'), false);
  assert.equal(Object.hasOwn(payload, 'engine_pool'), false);
  assert.equal(Object.hasOwn(payload, 'cooldown_engines'), false);
  // failure_classes is driven by the backend's own diagnostics, independent of pooling.
  assert.deepEqual(payload.failure_classes, { captcha: 1 });
});
