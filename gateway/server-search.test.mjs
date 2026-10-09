import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// MCP-boundary regression for the opt-in news mode wiring added to server.mjs (SPEC #72 follow-up).
// The search module already tests ranking/dedup in isolation; this file checks that the *tool*
// forwards the caller's news control into `searchSearxng` and forwards the search-result-layer
// fields (`news_mode`/`news_ranking`/`dedup`) back to the MCP caller — and that a normal search
// stays byte-compatible (no new keys). Signals are explainable heuristics, never a claim of truth.

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Fixed SearXNG-shaped response. Two distinct URLs survive normalization; the article URL arrives
// twice (once with a tracking param) so the multi-source dedup evidence is exercised.
const SEARCH_BODY = {
  results: [
    { title: 'Site home', url: 'https://home.example/', content: 'Welcome to our website.', engine: 'yandex', category: 'news' },
    { title: 'Detailed report on the event', url: 'https://publisher.example/2026/10/09/report', content: 'The full story of the event.', engine: 'quark', category: 'news' },
    { title: 'Duplicate copy of the report', url: 'https://publisher.example/2026/10/09/report?utm_source=news', content: 'The full story of the event.', engine: 'yandex', category: 'news' },
  ],
  number_of_results: 3,
};

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function searchFixture(t) {
  const upstream = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://searxng.test');
    if (url.pathname !== '/search') { res.writeHead(404).end('unexpected fixture path'); return; }
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

  const client = new Client({ name: 'search-news-contract-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  const search = args => client.callTool({ name: 'web_search', arguments: args });
  return { client, search };
}

function assertNewsKeys(payload) {
  assert.equal(payload.news_mode, true, 'news_mode must be forwarded to the MCP caller');
  assert.equal(payload.news_ranking.applied, true);
  assert.equal(payload.news_ranking.total, 2);
  assert.ok(payload.news_ranking.moved >= 1, 'the article must be promoted above the navigational root');
  assert.equal(payload.dedup.raw_results, 3);
  assert.equal(payload.dedup.unique_urls, 2);
  assert.equal(payload.dedup.merged, 1);
  assert.equal(payload.dedup.multi_source, 1);
  const merged = payload.dedup.sources.find(item => item.url === 'https://publisher.example/2026/10/09/report');
  assert.deepEqual(merged.engines.sort(), ['quark', 'yandex']);
}

test('web_search auto-opts into news mode for a news category and forwards the news/dedup fields', { timeout: 30000 }, async t => {
  const { search } = await searchFixture(t);
  const result = await search({ query: 'report', categories: 'news' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = result.structuredContent;

  assertNewsKeys(payload);

  // Result set is unchanged in size (recall preserved) but reordered: the article outranks the root.
  assert.equal(payload.results.length, 2);
  assert.equal(payload.results[0].url, 'https://publisher.example/2026/10/09/report');
  assert.equal(payload.results.at(-1).url, 'https://home.example/');
  // category / engine / source survive on every result through the reordering.
  for (const item of payload.results) {
    assert.equal(item.category, 'news');
    assert.ok(item.engine);
    assert.equal(item.source.host, new URL(item.url).hostname);
  }
  // The text channel (not only structuredContent) carries the forwarded fields.
  const textPayload = JSON.parse(result.content[0].text);
  assert.equal(textPayload.news_mode, true);
  assert.equal(Object.hasOwn(textPayload, 'news_ranking'), true);
  assert.equal(Object.hasOwn(textPayload, 'dedup'), true);
});

test('web_search honours an explicit news_mode flag independent of the category', { timeout: 30000 }, async t => {
  const { search } = await searchFixture(t);

  const forced = await search({ query: 'report', news_mode: true });
  assert.notEqual(forced.isError, true, JSON.stringify(forced));
  assertNewsKeys(forced.structuredContent);

  const forcedOff = await search({ query: 'report', categories: 'news', news_mode: false });
  assert.notEqual(forcedOff.isError, true, JSON.stringify(forcedOff));
  assert.equal(Object.hasOwn(forcedOff.structuredContent, 'news_mode'), false);
  assert.equal(Object.hasOwn(forcedOff.structuredContent, 'news_ranking'), false);
  assert.equal(Object.hasOwn(forcedOff.structuredContent, 'dedup'), false);
  assert.equal(forcedOff.structuredContent.results[0].url, 'https://home.example/', 'novelty-off keeps engine order');
});

test('normal web_search stays compatible: no news keys and unchanged engine order', { timeout: 30000 }, async t => {
  const { search } = await searchFixture(t);
  const result = await search({ query: 'report' });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = result.structuredContent;

  assert.equal(Object.hasOwn(payload, 'news_mode'), false);
  assert.equal(Object.hasOwn(payload, 'news_ranking'), false);
  assert.equal(Object.hasOwn(payload, 'dedup'), false);
  assert.equal(payload.results[0].url, 'https://home.example/', 'normal mode keeps engine order');
  // The pre-existing diagnostics shape is untouched.
  assert.equal(typeof payload.filtered_out, 'number');
  assert.equal(typeof payload.trace_id, 'string');
});

test('web_search advertises the news_mode control in its tool schema', { timeout: 30000 }, async t => {
  const { client } = await searchFixture(t);
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'web_search').inputSchema;
  assert.equal(schema.properties.news_mode.type, 'boolean');
  assert.equal(schema.properties.news_mode.optional ?? true, true);
});
