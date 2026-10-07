import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { evaluateCase } from './eval-case.mjs';
import { DEADLINE_KINDS, summarizeCases } from './eval-core.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = 'http://deadline.fixture.test';
const timeoutDefinition = {
  id: 'read-timeout', name: 'Controlled origin exceeds gateway deadline',
  category: 'timeout', expectation: 'expected_timeout', tool: 'web_read',
  expected_outcome: { kinds: DEADLINE_KINDS },
};

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function fixture(t) {
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const received = [];
  let stalls = 0;
  const origin = http.createServer((req, res) => {
    received.push({ path: req.url, host: req.headers.host });
    if (req.url === '/stall') {
      stalls++;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.write('<html><body>');
      // Keep sending data so only the absolute read deadline can end the read.
      const interval = setInterval(() => res.write('still waiting '), 40);
      res.once('close', () => { clearInterval(interval); stalls--; });
      return;
    }
    if (req.url === '/refused') { req.socket.destroy(); return; }
    if (req.url === '/redirect-private') {
      res.writeHead(302, { location: 'http://127.0.0.1/' }); res.end(); return;
    }
    res.writeHead(200, { 'content-type': req.url === '/json' ? 'application/json' : req.url === '/unsupported' ? 'image/png' : 'text/html' });
    res.end(req.url === '/json' ? '{"ok":true}' : req.url === '/unsupported' ? 'not html' : '<html><head><title>Fixture ready</title></head><body><h1>Gateway recovered</h1><p>A valid offline page after the stalled read.</p></body></html>');
  });
  origin.on('connection', track);
  const originPort = await listen(origin);
  const proxy = http.createServer();
  proxy.on('connection', track);
  proxy.on('connect', (req, downstream, head) => {
    assert.ok(['deadline.fixture.test:80', '93.184.216.34:80'].includes(req.url), `unexpected fixture authority ${req.url}`);
    const upstream = net.connect(originPort, '127.0.0.1');
    track(upstream);
    upstream.once('connect', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      downstream.pipe(upstream); upstream.pipe(downstream);
    });
    downstream.on('error', () => upstream.destroy());
    upstream.on('error', () => downstream.destroy());
    downstream.once('close', () => upstream.destroy());
    upstream.once('close', () => downstream.destroy());
  });
  const proxyPort = await listen(proxy);
  const reservation = net.createServer();
  const gatewayPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  // Synthetic fixture authentication only; never read live credentials.
  const authentication = 'offline-fixture-only-not-a-live-credential-0000000000';
  const child = spawn(process.execPath, ['--import', new URL('./test-fixtures/read-deadline-import.mjs', import.meta.url).href, path.join(directory, 'server.mjs')], {
    cwd: directory,
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      GATEWAY_HOST: '127.0.0.1', GATEWAY_BIND_HOST: '127.0.0.1',
      GATEWAY_ALLOWED_HOSTS: '127.0.0.1', GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TOKEN: authentication, EGRESS_PROXY: `http://127.0.0.1:${proxyPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  let client; let transport;
  t.after(async () => {
    await client?.close().catch(() => {});
    await transport?.close().catch(() => {});
    const exited = once(child, 'exit');
    if (child.exitCode === null) { child.kill(); await exited; }
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, proxy].map(server => new Promise(resolve => server.close(resolve))));
  });
  const startup = performance.now();
  while (!logs.includes('web-access-gateway listening')) {
    assert.equal(child.exitCode, null, logs);
    assert.ok(performance.now() - startup < 5000, `gateway fixture startup exceeded bound: ${logs}`);
    await delay(20);
  }
  client = new Client({ name: 'offline-timeout-fixture', version: '1.0.0' });
  transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${authentication}` } } });
  await client.connect(transport);
  const read = async url => {
    const started = performance.now();
    const result = await client.callTool({ name: 'web_read', arguments: { url, render: 'never', output: 'markdown' } }, undefined, { timeout: 3000 });
    return { payload: result.structuredContent ?? JSON.parse(result.content[0].text), isError: result.isError, total_ms: Math.round(performance.now() - started) };
  };
  return { read, received, activeStalls: () => stalls, logs: () => logs };
}

test('real gateway deadline reaches a stalled origin, tears down, and allows a subsequent read', { timeout: 15000 }, async t => {
  const gateway = await fixture(t);
  const record = await evaluateCase({ ...timeoutDefinition, run: () => gateway.read(`${fixtureUrl}/stall`) });
  assert.equal(gateway.received.filter(item => item.path === '/stall').length, 1, gateway.logs());
  assert.equal(gateway.received[0].host, 'deadline.fixture.test');
  assert.equal(record.status, 'passed', JSON.stringify(record));
  assert.equal(record.quality.passed, true);
  assert.equal(record.error.kind, 'egress_timeout');
  assert.ok(record.total_ms >= 300 && record.total_ms < 2000, `elapsed ${record.total_ms}ms`);
  const teardown = performance.now();
  while (gateway.activeStalls() && performance.now() - teardown < 1000) await delay(20);
  assert.equal(gateway.activeStalls(), 0, 'gateway must close the stalled origin connection');
  const valid = await evaluateCase({ id: 'recovered-read', tool: 'web_read', run: () => gateway.read(`${fixtureUrl}/valid`), quality: payload => ({ passed: payload.title === 'Fixture ready' && payload.markdown.includes('Gateway recovered') }) });
  assert.equal(valid.status, 'passed', JSON.stringify(valid));
  const summary = summarizeCases([record, valid]);
  assert.equal(summary.success_rate_pct, 100);
  assert.equal(summary.quality_rate_pct, 100);
  assert.equal(summary.expected_outcomes_passed, 1);
  assert.equal(summary.timeout_eligible_cases, 1);
  assert.equal(summary.timeout_rate_pct, 0);
});

test('real gateway success and unsupported responses cannot satisfy timeout proof', { timeout: 15000 }, async t => {
  const gateway = await fixture(t);
  for (const endpoint of ['/valid', '/json', '/unsupported', '/refused']) {
    const record = await evaluateCase({ ...timeoutDefinition, run: () => gateway.read(`${fixtureUrl}${endpoint}`) });
    assert.equal(record.status, 'failed');
    assert.equal(record.quality.passed, false);
    assert.equal(record.error.kind, endpoint === '/valid' ? 'unexpected_outcome' : endpoint === '/refused' ? 'upstream_network' : 'unsupported_content_type');
    assert.ok(gateway.received.some(item => item.path === endpoint));
  }
});

test('isolated fixture leaves gateway protocol, credential, port, private and redirect policy enforced', { timeout: 15000 }, async t => {
  const gateway = await fixture(t);
  for (const [url, reason] of [
    ['http://127.0.0.1/', 'non_public_address'],
    ['ftp://deadline.fixture.test/', 'unsupported_url'],
    ['http://user:password@deadline.fixture.test/', 'unsupported_url'],
    ['http://deadline.fixture.test:8080/', 'unsupported_port'],
    [`${fixtureUrl}/redirect-private`, 'non_public_address'],
  ]) {
    const record = await evaluateCase({ id: 'security', expectation: 'expected_security', expected_outcome: { kinds: ['ssrf_blocked'], blocked_reason: reason }, run: () => gateway.read(url) });
    assert.equal(record.status, 'passed', JSON.stringify(record));
  }
  assert.deepEqual(gateway.received.map(item => item.path), ['/redirect-private']);
});
