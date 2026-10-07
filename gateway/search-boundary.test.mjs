import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { waitForListening } from './test-fixtures/wait-for-listening.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('web_search preserves the selected SearXNG contract through HTTP/MCP', { timeout: 15000 }, async t => {
  const responses = [];
  const requests = [];
  const backend = http.createServer((req, res) => {
    requests.push(new URL(req.url, 'http://searxng.test'));
    const response = responses.shift();
    res.writeHead(response?.status ?? 500, { 'content-type': 'application/json' });
    res.end(response ? response.raw ?? JSON.stringify(response.body) : JSON.stringify({ error: 'unexpected search request' }));
  });
  const backendPort = await listen(backend);
  t.after(() => new Promise(resolve => {
    backend.closeAllConnections();
    backend.close(resolve);
  }));
  const gatewayPort = await unusedPort();
  // Generated only for this isolated child; no live credentials or host services.
  const token = crypto.randomBytes(32).toString('hex');
  const localBackend = `http://127.0.0.1:${backendPort}`;
  const child = spawn(process.execPath, [path.join(moduleDir, 'server.mjs')], {
    env: {
      ...process.env,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_BIND_HOST: '127.0.0.1',
      GATEWAY_ALLOWED_HOSTS: '127.0.0.1',
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TOKEN: token,
      GATEWAY_TOKEN_RATE_LIMIT: '1000',
      SEARXNG_URL: localBackend,
      CRAWL4AI_URL: localBackend,
      CRAWL4AI_TOKEN: '',
      PLAYWRIGHT_MCP_URL: `${localBackend}/mcp`,
      EGRESS_PROXY: localBackend,
      ARTIFACT_BASE_URL: `http://127.0.0.1:${gatewayPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume();
  child.stderr.resume();
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  });
  await waitForListening(child);
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'offline-search-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport, { timeout: 3000 });

  async function search(bodies, input = { query: 'gold & 银价' }) {
    assert.equal(responses.length, 0, 'the previous search consumed its fixture');
    requests.length = 0;
    responses.push(...bodies.map(body => ({ status: 200, body })));
    const result = await client.callTool({ name: 'web_search', arguments: input }, undefined, { timeout: 3000 });
    assert.equal(result.isError, undefined);
    assert.equal(responses.length, 0, 'search consumes only the selected attempts');
    const value = result.structuredContent;
    assert.deepEqual(JSON.parse(result.content[0].text), value, 'text and structured MCP payloads agree');
    assert.equal(value.query, input.query);
    assert.match(value.trace_id, /^[0-9a-f-]{36}$/);
    assert.equal(typeof value.telemetry.first_valid_result_ms, 'number');
    assert.equal(typeof value.telemetry.stages_ms.search_ms, 'number');
    assert.equal(Object.hasOwn(value.telemetry.stages_ms, 'search_retry_ms'), bodies.length === 2);
    return value;
  }

  const selected = { title: 'Selected evidence', url: 'https://example.com/2026/10/02/gold', content: 'Summary', engine: 'bing', category: 'news' };
  const input = { query: 'gold & 银价', categories: 'news', engines: 'google,bing', language: 'zh-CN', time_range: 'month', page: 3 };
  const forwarding = { q: 'gold & 银价', format: 'json', categories: 'news', engines: 'google,bing', language: 'zh-CN', time_range: 'month', pageno: '3' };

  await t.test('normal response retains filters, evidence fields and partial engine failures', async () => {
    const value = await search([{ results: [selected], number_of_results: 42, unresponsive_engines: [['google', 'timeout']] }], input);
    assert.deepEqual(requests.map(url => url.pathname), ['/search']);
    assert.deepEqual(Object.fromEntries(requests[0].searchParams), forwarding);
    assert.equal(value.number_of_results, 42);
    assert.deepEqual(value.unresponsive_engines, [['google', 'timeout']]);
    assert.equal(value.results[0].published_on, '2026-10-02');
    assert.equal(value.results[0].precision, 'day');
    assert.deepEqual(value.results[0].source, { url: selected.url, host: 'example.com', search_engine: 'bing' });
    assert.equal(value.results[0].retrieved_at, value.results[0].temporal_evidence.at(-1).value);
  });

  await t.test('fallback removes only the time filter and exposes only the selected failures', async () => {
    const value = await search([
      { results: [], number_of_results: 0, unresponsive_engines: [['google', 'timeout']] },
      { results: [selected], number_of_results: 42, unresponsive_engines: [['brave', 'blocked']] },
    ], input);
    assert.deepEqual(Object.fromEntries(requests[0].searchParams), forwarding);
    assert.deepEqual(Object.fromEntries(requests[1].searchParams), { q: 'gold & 银价', format: 'json', categories: 'news', engines: 'google,bing', language: 'zh-CN', pageno: '3' });
    assert.equal(value.number_of_results, 42);
    assert.deepEqual(value.unresponsive_engines, [['brave', 'blocked']]);
    assert.equal(value.results[0].title, 'Selected evidence');
  });

  for (const fallback of [false, true]) {
    for (const diagnostics of ['empty', 'omitted']) {
      await t.test(`${fallback ? 'fallback' : 'normal'} selected ${diagnostics} diagnostics remain ${diagnostics}`, async () => {
        const body = { results: [selected], ...(diagnostics === 'empty' ? { unresponsive_engines: [] } : {}) };
        const bodies = fallback ? [{ results: [], unresponsive_engines: [['google', 'timeout']] }, body] : [body];
        const value = await search(bodies);
        assert.equal(value.number_of_results, 1);
        if (diagnostics === 'empty') assert.deepEqual(value.unresponsive_engines, []);
        else assert.equal(Object.hasOwn(value, 'unresponsive_engines'), false);
      });
    }
  }

  await t.test('two empty responses remain empty after a single fallback', async () => {
    const value = await search([
      { results: [], unresponsive_engines: [['google', 'timeout']] },
      { results: [], unresponsive_engines: [['bing', 'blocked']] },
    ]);
    assert.deepEqual(value.results, []);
    assert.equal(value.number_of_results, 0);
    assert.deepEqual(value.unresponsive_engines, [['bing', 'blocked']]);
    assert.equal(requests.length, 2);
  });

  await t.test('URL duplicates retain the fuller evidence before the 20-result cap', async () => {
    const results = [
      { title: 'Short', url: 'https://example.com/0?utm_source=search#snippet', content: 'Short' },
      ...Array.from({ length: 23 }, (_, index) => ({ title: `Result ${index}`, url: `https://example.com/${index}`, content: 'Fuller evidence from the publisher', engine: 'bing' })),
    ];
    const value = await search([{ results, number_of_results: 123 }]);
    assert.equal(requests.length, 1);
    assert.equal(value.results.length, 20);
    assert.equal(value.number_of_results, 123);
    assert.equal(value.results[0].url, 'https://example.com/0');
    assert.equal(value.results[0].title, 'Result 0');
    assert.equal(value.results.at(-1).url, 'https://example.com/19');
  });

  await t.test('malformed results trigger the existing fallback and normalize to an empty list', async () => {
    const value = await search([
      { results: { unexpected: true }, unresponsive_engines: [['google', 'timeout']] },
      { results: null, unresponsive_engines: [] },
    ]);
    assert.deepEqual(value.results, []);
    assert.equal(value.number_of_results, 0);
    assert.deepEqual(value.unresponsive_engines, []);
    assert.equal(requests.length, 2);
  });

  for (const malformed of [{ status: 503, body: {} }, { status: 200, raw: 'not JSON' }, { status: 200, body: null }]) {
    await t.test(`backend ${malformed.status === 503 ? 'HTTP failure' : malformed.raw ? 'invalid JSON' : 'null body'} is an MCP error, not complete coverage`, async () => {
      responses.push(malformed);
      requests.length = 0;
      const result = await client.callTool({ name: 'web_search', arguments: { query: 'example' } }, undefined, { timeout: 3000 });
      assert.equal(result.isError, true);
      const value = result.structuredContent;
      assert.deepEqual(JSON.parse(result.content[0].text), value);
      assert.equal(typeof value.error.message, 'string');
      assert.equal(Object.hasOwn(value, 'results'), false);
      assert.equal(Object.hasOwn(value, 'unresponsive_engines'), false);
      if (malformed.status === 503) {
        assert.equal(value.error.kind, 'search_backend_status');
        assert.equal(value.http_status, 503);
      }
      assert.equal(requests.length, 1);
      assert.equal(responses.length, 0);
    });
  }
});
