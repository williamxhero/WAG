import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const token = 'offline-crawl-fixture-authorization-only';
const MiB = 1024 * 1024;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function fixture(t, env = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-crawl-'));
  const artifactDir = path.join(root, 'artifacts');
  await fs.mkdir(artifactDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let response = { body: JSON.stringify({ results: [{ markdown: 'valid evidence', screenshot: 'YWJj', pdf: 'ZGVm' }] }) };
  let aborted = false;
  const crawler = http.createServer(async (req, res) => {
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (response.falseLength) res.setHeader('x-fixture-content-length', response.falseLength);
    res.statusCode = response.status ?? 200;
    const body = response.body;
    const chunkSize = response.chunkSize ?? 65536;
    res.on('close', () => { if (!res.writableEnded) aborted = true; });
    try {
      for (let offset = 0; offset < body.length; offset += chunkSize) {
        if (res.destroyed) break;
        if (!res.write(body.slice(offset, offset + chunkSize))) await once(res, 'drain');
        if (response.slow) await new Promise(resolve => setTimeout(resolve, 5));
      }
      if (!res.destroyed) res.end();
    } catch { /* Cancellation is the expected oversize outcome. */ }
  });
  const crawlerPort = await listen(crawler);
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => {
      const html = '<html><title>Offline evidence</title><main>Controlled gateway fixture</main></html>';
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${Buffer.byteLength(html)}\r\nConnection: close\r\n\r\n${html}`);
    });
  });
  for (const server of [crawler, proxy]) {
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  }
  const proxyPort = await listen(proxy);
  const reservation = http.createServer();
  const gatewayPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  // Inject external DNS, CONNECT transport and response metadata only in this child. All
  // body bytes still traverse the real local HTTP stream and MCP gateway.
  const preload = path.join(root, 'offline.mjs');
  await fs.writeFile(preload, `
    import dns from 'node:dns/promises';
    import http from 'node:http';
    dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    // Node ignores options.createConnection with agent:false. Honor the
    // gateway's supplied CONNECT socket without allowing an Internet request.
    const originalRequest = http.request;
    http.request = (options, ...args) => {
      if (options.createConnection) {
        const agent = new http.Agent();
        agent.createConnection = options.createConnection;
        options = { ...options, agent };
      }
      return originalRequest(options, ...args);
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const falseLength = response.headers.get('x-fixture-content-length');
      if (!falseLength) return response;
      const headers = new Headers(response.headers);
      headers.set('content-length', falseLength);
      return new Response(response.body, { status: response.status, headers });
    };
  `);
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, path.join(moduleDir, 'server.mjs')], {
    cwd: moduleDir,
    env: {
      ...process.env, GATEWAY_TOKEN: token, GATEWAY_HOST: '127.0.0.1', GATEWAY_BIND_HOST: '127.0.0.1',
      GATEWAY_ALLOWED_HOSTS: '127.0.0.1', GATEWAY_PORT: String(gatewayPort),
      CRAWL4AI_URL: `http://127.0.0.1:${crawlerPort}`, CRAWL4AI_TOKEN: token,
      EGRESS_PROXY: `http://127.0.0.1:${proxyPort}`, ARTIFACT_DIR: artifactDir,
      ARTIFACT_BASE_URL: `http://127.0.0.1:${gatewayPort}`, EVAL_REPORT_DIR: path.join(root, 'reports'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`gateway startup timed out: ${logs}`)), 10000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('listening on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`gateway exited ${code}: ${logs}`)); });
  });
  const client = new Client({ name: 'offline-crawl-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  t.after(() => client.close());
  return {
    setResponse(value) { response = value; aborted = false; },
    wasAborted: () => aborted,
    async read(output = 'screenshot') {
      return client.callTool({ name: 'web_read', arguments: { url: 'http://evidence.example.org/', render: 'always', output } });
    },
    async assertEmpty() { assert.deepEqual(await fs.readdir(artifactDir), [], 'no partial artifact or temporary file'); },
    async assertRecovery(output = 'screenshot') {
      response = { body: JSON.stringify({ results: [{ markdown: 'valid evidence', screenshot: 'YWJj', pdf: 'ZGVm' }] }) };
      const result = await this.read(output);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      if (output === 'markdown') assert.equal(result.structuredContent.markdown, 'valid evidence');
      else {
        const artifact = result.structuredContent.artifact;
        assert.equal(artifact.bytes, 3);
        const saved = await fetch(artifact.url, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(saved.status, 200);
        assert.equal(await saved.text(), output === 'screenshot' ? 'abc' : 'def');
        assert.equal(artifact.content_type, output === 'screenshot' ? 'image/png' : 'application/pdf');
      }
    },
  };
}

function assertRejection(result, kind) {
  assert.equal(result.isError, true, 'request must return a typed failure');
  assert.equal(result.structuredContent.error.kind, kind);
  assert.ok(result.structuredContent.error.message.length <= 500);
  assert.ok(JSON.stringify(result).length < 2000, 'failure must not echo the input payload');
}

test('gateway accepts separate screenshot and PDF artifacts at the default 25 MiB decoded boundary', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  const encoded = Buffer.alloc(25 * MiB, 97).toString('base64');
  gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: 'valid', screenshot: encoded, pdf: `data:application/pdf;base64,${encoded}` }] }), chunkSize: 65521 });
  for (const output of ['screenshot', 'pdf']) {
    const result = await gateway.read(output);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const artifact = result.structuredContent.artifact;
    assert.equal(artifact.bytes, 26214400);
    const downloaded = await fetch(artifact.url, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(downloaded.status, 200);
    const bytes = new Uint8Array(await downloaded.arrayBuffer());
    assert.equal(bytes.byteLength, 26214400);
    assert.equal(bytes[0], 97);
    assert.equal(bytes[26214399], 97);
    assert.equal(artifact.content_type, output === 'screenshot' ? 'image/png' : 'application/pdf');
  }
});

test('gateway enforces the default 80 MiB aggregate ceiling even when every evidence field is within its budget', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: 'm'.repeat(5 * MiB), screenshot: Buffer.alloc(25 * MiB, 97).toString('base64'), pdf: Buffer.alloc(25 * MiB, 98).toString('base64'), html: 'h'.repeat(11 * MiB) }] }), chunkSize: 65521 });
  assertRejection(await gateway.read(), 'response_too_large');
  await gateway.assertEmpty();
  await gateway.assertRecovery();
});

test('gateway accepts exact Markdown and aggregate limits and canonical padded, unpadded and data-URL artifacts', { timeout: 20000 }, async t => {
  const gateway = await fixture(t, { CRAWL4AI_RESPONSE_MAX_BYTES: String(6 * MiB), ARTIFACT_MAX_BYTES: '5' });
  gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: 'm'.repeat(5 * MiB), screenshot: 'YWJjZGU=', pdf: 'data:application/pdf;base64,ZGVm' }] }).padEnd(6 * MiB, ' '), chunkSize: 4093 });
  const exact = await gateway.read();
  assert.notEqual(exact.isError, true, JSON.stringify(exact));
  assert.equal(exact.structuredContent.artifact.bytes, 5);
  const saved = await fetch(exact.structuredContent.artifact.url, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(await saved.text(), 'abcde');
  for (const screenshot of ['YQ==', 'YWI=', 'YQ', 'YWI', 'data:image/png;base64,YWJj']) {
    gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: 'valid', screenshot }] }), chunkSize: 5 });
    const result = await gateway.read();
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent.artifact.bytes >= 1);
  }
  await gateway.assertRecovery('pdf');
});

test('gateway retains typed missing-artifact and storage-quota failures without publishing partial files', { timeout: 20000 }, async t => {
  const gateway = await fixture(t, { ARTIFACT_QUOTA_BYTES: '2' });
  gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: 'valid' }] }) });
  assertRejection(await gateway.read(), 'artifact_missing');
  await gateway.assertEmpty();
  await gateway.assertRecovery('markdown');
  gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: 'valid', screenshot: 'YWJj' }] }) });
  assertRejection(await gateway.read(), 'artifact_quota_exceeded');
  await gateway.assertEmpty();
  await gateway.assertRecovery('markdown');
  gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: 'valid', screenshot: 'YWI=' }] }) });
  const admitted = await gateway.read();
  assert.notEqual(admitted.isError, true, JSON.stringify(admitted));
  assert.equal(admitted.structuredContent.artifact.bytes, 2);
});

test('gateway bounds non-success crawler response bodies too', { timeout: 20000 }, async t => {
  const gateway = await fixture(t, { CRAWL4AI_RESPONSE_MAX_BYTES: '1024' });
  gateway.setResponse({ body: 'backend error'.repeat(500), status: 502, chunkSize: 13 });
  assertRejection(await gateway.read(), 'response_too_large');
  await gateway.assertEmpty();
  await gateway.assertRecovery('markdown');
  gateway.setResponse({ body: 'controlled backend failure', status: 502 });
  const failure = await gateway.read();
  assertRejection(failure, 'render_backend_status');
  assert.equal(failure.structuredContent.http_status, 502);
  await gateway.assertEmpty();
  await gateway.assertRecovery();
});

test('gateway rejects malformed crawler JSON and result shapes with bounded errors and recovers', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  for (const body of ['{invalid JSON}', 'null', '[]', '{"results":[null]}', '{"results":{}}', '{"results":"invalid"}', '{"results":[{"markdown":42,"screenshot":"YWJj"}]}', '{"results":[{"markdown":{"raw_markdown":{}},"screenshot":"YWJj"}]}']) {
    gateway.setResponse({ body, chunkSize: 3 });
    assertRejection(await gateway.read(), 'render_invalid_response');
    await gateway.assertEmpty();
    await gateway.assertRecovery('markdown');
  }
});

test('gateway rejects malformed base64 in any artifact without partial publication and recovers', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  for (const malformed of ['not-base64!', 'Y=Q=', 'YQ===', 'Y', 'YQ=', 'YQ-_', 'YQ==\n', 'YR==', 'YWJ=', 'data:image/png,YQ==', 'data:image/png;base64,', 42, {}, []]) {
    gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: 'valid', screenshot: 'YWJj', pdf: malformed }] }), chunkSize: 7 });
    assertRejection(await gateway.read(), 'artifact_invalid');
    await gateway.assertEmpty();
    await gateway.assertRecovery('markdown');
  }
  await gateway.assertRecovery();
});

test('gateway validates both encoded and decoded artifact budgets before publishing either artifact', { timeout: 40000 }, async t => {
  for (const field of ['screenshot', 'pdf']) {
    for (const [budget, value] of [['encoded', 'YWFh'.repeat(8738135)], ['decoded', Buffer.alloc(25 * MiB + 1, 97).toString('base64')]]) {
      await t.test(`${field} ${budget} budget`, async t => {
        const gateway = await fixture(t);
        // Request the other (valid) artifact, so late persistence checks cannot
        // satisfy the requirement to validate the whole payload before saving.
        const output = field === 'pdf' ? 'screenshot' : 'pdf';
        gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: 'valid', screenshot: 'YWJj', pdf: 'ZGVm', [field]: value }] }), chunkSize: 32749 });
        const rejected = await gateway.read(output);
        assertRejection(rejected, 'artifact_too_large');
        assert.match(rejected.structuredContent.error.message, budget === 'encoded' ? /^encoded artifact exceeds/ : /^artifact exceeds/);
        await gateway.assertEmpty();
        await gateway.assertRecovery(output);
      });
    }
  }
});

test('gateway rejects crawled Markdown over 5 MiB before artifact publication and recovers', { timeout: 20000 }, async t => {
  const gateway = await fixture(t);
  // The character count is below 5 MiB; the UTF-8 byte count exceeds it.
  const markdown = '界'.repeat(1747627);
  gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: { raw_markdown: markdown }, screenshot: 'YWJj' }] }), chunkSize: 4093 });
  assertRejection(await gateway.read(), 'markdown_too_large');
  await gateway.assertEmpty();
  await gateway.assertRecovery('markdown');
});

test('gateway aborts fragmented aggregate overflow despite missing or false Content-Length and recovers', { timeout: 20000 }, async t => {
  for (const falseLength of [undefined, '1']) {
    await t.test(falseLength ? 'false length' : 'no length', async t => {
      const gateway = await fixture(t, { CRAWL4AI_RESPONSE_MAX_BYTES: '1024' });
      gateway.setResponse({ body: JSON.stringify({ results: [{ markdown: 'valid', screenshot: 'YWJj', pdf: 'ZGVm', other: 'x'.repeat(40000) }] }), chunkSize: 257, slow: true, falseLength });
      const started = Date.now();
      assertRejection(await gateway.read(), 'response_too_large');
      assert.ok(Date.now() - started < 2000, 'abort before finishing the slow body');
      await gateway.assertEmpty();
      await gateway.assertRecovery();
      assert.equal(gateway.wasAborted(), true, 'upstream stream is cancelled promptly');
    });
  }
});
