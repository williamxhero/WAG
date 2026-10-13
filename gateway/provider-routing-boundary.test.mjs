import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function fixture(t, env = {}) {
  const recalled = [{ title: 'Local fixture report', url: 'http://127.0.0.1:7777/articles/report', content: 'A synthetic fixture report, not production supply.', publishedDate: new Date().toISOString(), engine: 'offline' }];
  const queries = [];
  const upstream = http.createServer((req, res) => {
    queries.push(new URL(req.url, 'http://searxng.test'));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ results: recalled, number_of_results: 1 }));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => { upstream.closeAllConnections(); return new Promise(resolve => upstream.close(resolve)); });
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const token = 'dummy-offline-provider-routing-token-00000000';
  const child = spawn(process.execPath, [path.join(moduleDir, 'server.mjs')], {
    cwd: moduleDir, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      GATEWAY_TOKEN: token, GATEWAY_HOST: '127.0.0.1', GATEWAY_BIND_HOST: '127.0.0.1', GATEWAY_ALLOWED_HOSTS: '127.0.0.1',
      GATEWAY_PORT: String(port), SEARXNG_URL: `http://127.0.0.1:${upstreamPort}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
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
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return { client, queries, search: args => client.callTool({ name: 'web_search', arguments: args }) };
}

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

test('explicitly enabled provider with missing durable ledger fails closed while free search works', { timeout: 20000 }, async t => {
  const { search } = await fixture(t, { WAG_SEARCH_EVIDENCE_POLICY: 'spec82_page_only', WAG_SEARCH_BAIDU_ENABLED: '1',
    WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: '1', APPBUILDER_API_KEY: 'dummy-key' });
  const strict = await search({ query: 'report', time_range: 'day', time_window_strict: true });
  assert.notEqual(strict.isError, true, JSON.stringify(strict));
  assert.deepEqual(strict.structuredContent.results, []);
  assert.deepEqual(strict.structuredContent.provider_attempts[0], { provider: 'baidu', status: 'budget_storage_error' });
  assert.equal(strict.structuredContent.provider_budget, null, 'unknown budget is not fabricated zero');
  const free = await search({ query: 'report' });
  assert.equal(free.structuredContent.results.length, 1);
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
