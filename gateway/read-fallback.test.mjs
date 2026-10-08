import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const token = 'offline-read-fallback-fixture-only-not-live-0000';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

// This host's dynamic port range can include ports undici refuses to fetch
// ("bad port"), which would make the gateway's own Crawl4AI fetch flaky. Re-roll
// until we hold a port both node core and undici accept.
const UNDICI_BAD_PORTS = new Set([0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
async function usablePort() {
  for (let attempt = 0; attempt < 25; attempt++) {
    const server = http.createServer();
    const port = await listen(server);
    await new Promise(resolve => server.close(resolve));
    if (!UNDICI_BAD_PORTS.has(port)) return port;
  }
  throw new Error('could not allocate a proxyable port');
}

function reply(socket, spec) {
  const payload = Buffer.from(spec.body ?? '', 'utf8');
  const headers = { ...(spec.headers ?? {}) };
  let body = payload;
  if (spec.gzip) { body = zlib.gzipSync(payload); headers['content-encoding'] = 'gzip'; }
  headers['content-length'] = String(body.length);
  headers['connection'] = 'close';
  const headerText = Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
  socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 ${spec.status} ${spec.statusText ?? 'Status'}\r\n${headerText}\r\n\r\n`, 'latin1'), body]));
}

function parseHead(buffer) {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
  const headers = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { rest: buffer.subarray(end + 4), requestLine: lines[0], headers };
}

async function fixture(t, { dns } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-read-fallback-'));
  const artifactDir = path.join(root, 'artifacts');
  await fs.mkdir(artifactDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // The pinned CONNECT target never leaves this fixture: record the identity the
  // gateway presents, then answer with the configured origin response.
  let originResponse = { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<article>identity</article>' };
  const received = [];
  const proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    socket.on('error', () => {});
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let buffer = Buffer.alloc(0);
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseHead(buffer);
      if (!parsed) return;
      socket.removeListener('data', onData);
      received.push({ authority: req.url, requestLine: parsed.requestLine, headers: parsed.headers });
      const spec = typeof originResponse === 'function' ? originResponse(req.url, parsed.headers) : originResponse;
      reply(socket, spec);
    };
    socket.on('data', onData);
  });

  let crawlResponse = { status: 200, body: JSON.stringify({ results: [{ markdown: 'Rendered markdown body.', status_code: 200 }] }) };
  const crawlRequests = [];
  const crawler = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      crawlRequests.push({ path: req.url, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(crawlResponse.status, { 'content-type': 'application/json' });
      res.end(crawlResponse.body);
    });
  });

  const proxyPort = await usablePort();
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPort, '127.0.0.1', resolve); });
  const crawlerPort = await usablePort();
  await new Promise((resolve, reject) => { crawler.once('error', reject); crawler.listen(crawlerPort, '127.0.0.1', resolve); });
  const sockets = new Set();
  for (const server of [proxy, crawler]) {
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  }

  const gatewayPort = await usablePort();

  // Substitute external DNS only; CONNECT pinning and extraction stay production code.
  const preload = path.join(root, 'offline.mjs');
  await fs.writeFile(preload, `
    import dns from 'node:dns/promises';
    import net from 'node:net';
    const configured = JSON.parse(process.env.WAG_FIXTURE_DNS ?? '{}');
    const calls = new Map();
    dns.lookup = async name => {
      const call = (calls.get(name) ?? 0) + 1;
      calls.set(name, call);
      const sets = configured[name] ?? [['8.8.8.8']];
      const chosen = sets[Math.min(call - 1, sets.length - 1)];
      return chosen.map(address => ({ address, family: net.isIP(address) }));
    };
  `);
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(moduleDir, 'server.mjs')], {
    cwd: moduleDir,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      GATEWAY_TOKEN: token, GATEWAY_HOST: '127.0.0.1', GATEWAY_BIND_HOST: '127.0.0.1',
      GATEWAY_ALLOWED_HOSTS: '127.0.0.1', GATEWAY_PORT: String(gatewayPort),
      CRAWL4AI_URL: `http://127.0.0.1:${crawlerPort}`, CRAWL4AI_TOKEN: token,
      EGRESS_PROXY: `http://127.0.0.1:${proxyPort}`, ARTIFACT_DIR: artifactDir,
      EVAL_REPORT_DIR: path.join(root, 'reports'),
      WAG_FIXTURE_DNS: JSON.stringify(dns ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway startup timed out: ${logs}`)), 10000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('listening on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`gateway exited ${code}: ${logs}`)); });
  });

  const client = new Client({ name: 'offline-read-fallback', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  t.after(() => client.close());

  return {
    received,
    crawlRequests,
    setOrigin(value) { originResponse = value; },
    setCrawl(value) { crawlResponse = value; },
    async read(url, render = 'auto', output = 'markdown') {
      const result = await client.callTool({ name: 'web_read', arguments: { url, render, output } }, undefined, { timeout: 8000 });
      return { result, payload: result.structuredContent ?? JSON.parse(result.content[0].text) };
    },
  };
}

const longArticle = length => `<html><head><title>Identity page</title></head><body><article>${'evidence '.repeat(length)}</article></body></html>`;

test('lightweight reads send a browser request identity instead of a gateway user agent', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  gateway.setOrigin({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: longArticle(150) });
  const { result, payload } = await gateway.read('http://identity.example.test/article', 'never');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(payload.renderer, 'lightweight');
  assert.equal(gateway.received.length, 1);
  const [request] = gateway.received;
  assert.equal(request.authority, '8.8.8.8:80');
  assert.match(request.headers['user-agent'], /^Mozilla\/5\.0 .*Chrome\//);
  assert.doesNotMatch(request.headers['user-agent'], /WebAccessGateway|bot|crawl|spider/i);
  assert.match(request.headers['accept'], /text\/html/);
  assert.match(request.headers['accept-language'], /en-US/);
  assert.match(request.headers['accept-encoding'], /gzip/);
  assert.equal(request.headers['host'], 'identity.example.test');
});

test('lightweight reads decompress a gzip response and hash the decoded bytes', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  const body = '<html><head><title>Compressed</title></head><body><article>Compressed public article body.</article></body></html>';
  gateway.setOrigin({ status: 200, gzip: true, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
  const { result, payload } = await gateway.read('http://compressed.example.test/article', 'never');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(payload.renderer, 'lightweight');
  assert.equal(payload.title, 'Compressed');
  assert.match(payload.markdown, /Compressed public article body/);
  assert.equal(payload.bytes, Buffer.byteLength(body));
  assert.equal(payload.content_hash, crypto.createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'));
});

test('an oversized compressed response is rejected as too large rather than decoded', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  const body = `<html><body><article>${'a'.repeat(6 * 1024 * 1024)}</article></body></html>`;
  gateway.setOrigin({ status: 200, gzip: true, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
  const { result, payload } = await gateway.read('http://oversize.example.test/article', 'never');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(payload.error.kind, 'response_too_large');
});

test('auto reads fall back to the renderer on bot-challenge statuses and keep complete evidence', { timeout: 30000 }, async t => {
  const cases = [
    [403, 'upstream_forbidden'], [401, 'upstream_http_error'],
    [406, 'upstream_http_error'], [429, 'upstream_rate_limited'],
  ];
  for (const [status, reason] of cases) {
    await t.test(`HTTP ${status} falls back with reason ${reason}`, async t => {
      const gateway = await fixture(t);
      gateway.setOrigin({ status, headers: { 'content-type': 'text/html' }, body: '<html><body>blocked</body></html>' });
      gateway.setCrawl({ status: 200, body: JSON.stringify({ results: [{ markdown: '# Rendered\n\nRecovered public article body.', status_code: 200 }] }) });
      const { result, payload } = await gateway.read('http://blocked.example.test/article', 'auto');
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(payload.renderer, 'crawl4ai');
      assert.equal(payload.url, 'http://blocked.example.test/article');
      assert.equal(typeof payload.trace_id, 'string');
      assert.deepEqual(payload.render_fallback, {
        occurred: true, from: 'lightweight', to: 'crawl4ai',
        reason, http_status: status, url: 'http://blocked.example.test/article',
      });
      // Final result evidence: renderer status, decoded Markdown, and the contract fields.
      assert.equal(payload.http_status, 200);
      assert.match(payload.markdown, /Recovered public article body/);
      assert.equal(payload.source.url, payload.url);
      assert.equal(payload.source.host, 'blocked.example.test');
      assert.equal(typeof payload.retrieved_at, 'string');
      assert.ok(payload.temporal_evidence.some(item => item.kind === 'retrieved_at'));
      assert.equal(payload.blocked_reason, null);
      assert.match(payload.content_hash, /^[a-f0-9]{64}$/);
      assert.equal(payload.bytes, Buffer.byteLength('# Rendered\n\nRecovered public article body.'));
      // The renderer received the validated final URL, not something invented.
      assert.equal(gateway.crawlRequests.length, 1);
      assert.deepEqual(JSON.parse(gateway.crawlRequests[0].body).urls, ['http://blocked.example.test/article']);
    });
  }
});

test('a fallback whose renderer also fails still reports renderer, fallback cause and final status', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  gateway.setOrigin({ status: 403, headers: { 'content-type': 'text/html' }, body: 'forbidden' });
  gateway.setCrawl({ status: 502, body: 'renderer backend unavailable' });
  const { result, payload } = await gateway.read('http://blocked.example.test/article', 'auto');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(payload.error.kind, 'render_backend_status');
  assert.equal(typeof payload.trace_id, 'string');
  assert.equal(payload.renderer, 'crawl4ai');
  assert.equal(payload.render_fallback.from, 'lightweight');
  assert.equal(payload.render_fallback.reason, 'upstream_forbidden');
  assert.equal(payload.render_fallback.http_status, 403);
  assert.equal(payload.http_status, 502);
  assert.equal(payload.blocked_reason, 'render_fallback_failed');
  assert.equal(gateway.crawlRequests.length, 1);
});

test('render: never stays authoritative and never falls back to the renderer', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  gateway.setOrigin({ status: 403, headers: { 'content-type': 'text/html' }, body: 'forbidden' });
  const { result, payload } = await gateway.read('http://blocked.example.test/article', 'never');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(payload.error.kind, 'upstream_http_status');
  assert.equal(payload.http_status, 403);
  assert.equal(payload.blocked_reason, 'upstream_forbidden');
  assert.equal(Object.hasOwn(payload, 'render_fallback'), false);
  assert.equal(Object.hasOwn(payload, 'renderer'), false);
  assert.equal(gateway.crawlRequests.length, 0);
});

test('auto reads do not fall back for non-bot-challenge failures', { timeout: 20000 }, async t => {
  for (const [status, reason] of [[404, 'upstream_http_error'], [500, 'upstream_server_error']]) {
    await t.test(`HTTP ${status} does not fall back`, async t => {
      const gateway = await fixture(t);
      gateway.setOrigin({ status, headers: { 'content-type': 'text/html' }, body: 'unavailable' });
      const { result, payload } = await gateway.read('http://broken.example.test/article', 'auto');
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(payload.http_status, status);
      assert.equal(payload.blocked_reason, reason);
      assert.equal(Object.hasOwn(payload, 'render_fallback'), false);
      assert.equal(gateway.crawlRequests.length, 0);
    });
  }
});

test('a fallback target that stops being public is blocked before the renderer is asked', { timeout: 20000 }, async t => {
  const gateway = await fixture(t, { dns: { 'rebind.example.test': [['8.8.8.8'], ['127.0.0.1']] } });
  gateway.setOrigin({ status: 403, headers: { 'content-type': 'text/html' }, body: 'forbidden' });
  const { result, payload } = await gateway.read('http://rebind.example.test/article', 'auto');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(payload.error.kind, 'ssrf_blocked');
  assert.equal(payload.blocked_reason, 'non_public_address');
  assert.equal(gateway.received.length, 1, 'only the initially checked, still-public attempt connects');
  assert.equal(gateway.crawlRequests.length, 0, 'the renderer must never receive a non-public target');
});

test('a fallback whose renderer still observes a block reports the final status, not a challenge page', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  gateway.setOrigin({ status: 403, headers: { 'content-type': 'text/html' }, body: 'forbidden' });
  gateway.setCrawl({ status: 200, body: JSON.stringify({ results: [{ markdown: 'Please enable JS and disable any ad blocker', status_code: 401 }] }) });
  const { result, payload } = await gateway.read('http://blocked.example.test/article', 'auto');
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.equal(payload.error.kind, 'upstream_http_status');
  assert.equal(payload.http_status, 401);
  assert.equal(payload.blocked_reason, 'upstream_http_error');
  assert.equal(payload.renderer, 'crawl4ai');
  assert.equal(payload.render_fallback.http_status, 403);
  assert.equal(payload.render_fallback.reason, 'upstream_forbidden');
  assert.equal(JSON.stringify(payload).includes('enable JS'), false, 'a challenge page is not returned as content');
});

test('render: always still renders and keeps evidence from the lightweight read', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  gateway.setOrigin({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: longArticle(150) });
  gateway.setCrawl({ status: 200, body: JSON.stringify({ results: [{ markdown: 'Directly rendered body.', status_code: 200 }] }) });
  const { result, payload } = await gateway.read('http://direct.example.test/article', 'always');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(payload.renderer, 'crawl4ai');
  assert.equal(payload.http_status, 200);
  assert.equal(Object.hasOwn(payload, 'render_fallback'), false);
  assert.match(payload.markdown, /Directly rendered body/);
  assert.equal(gateway.received.length, 1);
  assert.equal(gateway.crawlRequests.length, 1);
});
