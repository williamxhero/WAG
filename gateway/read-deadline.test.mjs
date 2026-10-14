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
import { listenHttp } from './fixtures/safe-listen.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = 'http://deadline.fixture.test';
const timeoutDefinition = {
  id: 'read-timeout', name: 'Controlled origin exceeds gateway deadline',
  category: 'timeout', expectation: 'expected_timeout', tool: 'web_read',
  expected_outcome: { kinds: DEADLINE_KINDS },
};

async function listen(server, options = {}) {
  return (await listenHttp(server, options)).port;
}

async function fixture(t, { listenOptions = {} } = {}) {
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const received = [];
  const ports = { origin: null, proxy: null, gateway: null };
  let toolAttempts = 0; let connectionCause = 'unknown'; let connectionCode = 'unknown';
  const codes = new Set(['EADDRINUSE', 'EADDRNOTAVAIL', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'WAG_TEST_SAFE_LISTEN_INVALID_OPTIONS', 'WAG_TEST_SAFE_LISTEN_EXHAUSTED']);
  const diagnostics = error => {
    if (error) {
      connectionCause = 'unknown'; connectionCode = 'unknown';
      for (let depth = 0; error && depth <= 2; depth++, error = error.cause) {
        if (error.message === 'bad port') connectionCause = 'bad_port';
        if (codes.has(error.code)) connectionCode = error.code;
      }
    }
    return JSON.stringify({ ports, connection_cause: connectionCause, connection_code: connectionCode, mcp_tool_attempts: toolAttempts, origin_requests: received.length });
  };
  const failure = error => {
    const safe = new Error(diagnostics(error));
    safe.stack = `Error: ${safe.message}`;
    return safe;
  };
  let stalls = 0;
  let origin; let proxy; let reservation; let child; let exited; let client; let transport; let closing;
  const close = server => !server?.listening ? Promise.resolve() : new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const cleanup = () => closing ??= (async () => {
    let error;
    const attempt = async action => { try { await action(); } catch (cause) { error ??= cause; } };
    await attempt(() => client?.close());
    await attempt(() => transport?.close());
    await attempt(async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, proxy, reservation].map(server => attempt(() => close(server))));
    if (error) throw failure(error);
  })();
  t.after(cleanup);
  try {
    origin = http.createServer((req, res) => {
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
    const originPort = ports.origin = await listen(origin, listenOptions.origin);
    proxy = http.createServer();
    proxy.on('connection', track);
    proxy.on('connect', (req, downstream, head) => {
      assert.ok(['deadline.fixture.test:80', '93.184.216.34:80'].includes(req.url), diagnostics());
      const upstream = net.connect(originPort, '127.0.0.1');
      track(upstream);
      upstream.once('connect', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        downstream.pipe(upstream); upstream.pipe(downstream);
      });
      downstream.on('error', error => { diagnostics(error); upstream.destroy(); });
      upstream.on('error', error => { diagnostics(error); downstream.destroy(); });
      downstream.once('close', () => upstream.destroy());
      upstream.once('close', () => downstream.destroy());
    });
    const proxyPort = ports.proxy = await listen(proxy, listenOptions.proxy);
    reservation = net.createServer();
    const gatewayPort = ports.gateway = await listen(reservation, listenOptions.gateway);
    await close(reservation);
    // Synthetic fixture authentication only; never read live credentials.
    const authentication = 'offline-fixture-only-not-a-live-credential-0000000000';
    child = spawn(process.execPath, ['--import', new URL('./test-fixtures/read-deadline-import.mjs', import.meta.url).href, path.join(directory, 'server.mjs')], {
      cwd: directory,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        GATEWAY_HOST: '127.0.0.1', GATEWAY_BIND_HOST: '127.0.0.1',
        GATEWAY_ALLOWED_HOSTS: '127.0.0.1', GATEWAY_PORT: String(gatewayPort),
        GATEWAY_TOKEN: authentication, EGRESS_PROXY: `http://127.0.0.1:${proxyPort}`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise(resolve => child.once('close', resolve));
    let ready = false; let markerTail = '';
    const marker = 'web-access-gateway listening';
    child.stdout.on('data', chunk => {
      // Retain only the matching marker prefix, never child logs or credentials.
      for (const character of chunk.toString()) {
        markerTail += character;
        while (markerTail && !marker.startsWith(markerTail)) markerTail = markerTail.slice(1);
        if (markerTail === marker) { ready = true; markerTail = ''; }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', error => diagnostics(error));
    const startup = performance.now();
    while (!ready) {
      assert.equal(child.exitCode, null, diagnostics());
      assert.ok(performance.now() - startup < 5000, diagnostics());
      await delay(20);
    }
    client = new Client({ name: 'offline-timeout-fixture', version: '1.0.0' });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), { requestInit: { headers: { authorization: `Bearer ${authentication}` } } });
    await client.connect(transport);
    const read = async url => {
      const started = performance.now();
      toolAttempts++;
      try {
        const result = await client.callTool({ name: 'web_read', arguments: { url, render: 'never', output: 'markdown' } }, undefined, { timeout: 3000 });
        return { payload: result.structuredContent ?? JSON.parse(result.content[0].text), isError: result.isError, total_ms: Math.round(performance.now() - started) };
      } catch (error) { throw failure(error); }
    };
    return { read, received, ports, cleanup, activeStalls: () => stalls, logs: diagnostics };
  } catch (error) {
    await cleanup();
    throw failure(error);
  }
}

test('real gateway deadline reaches a stalled origin, tears down, and allows a subsequent read', { timeout: 15000 }, async t => {
  const gateway = await fixture(t);
  const record = await evaluateCase({ ...timeoutDefinition, run: () => gateway.read(`${fixtureUrl}/stall`) });
  assert.equal(gateway.received.filter(item => item.path === '/stall').length, 1, gateway.logs());
  assert.equal(gateway.received[0].host, 'deadline.fixture.test');
  assert.equal(record.status, 'passed', gateway.logs());
  assert.equal(record.quality.passed, true);
  assert.equal(record.error.kind, 'egress_timeout');
  assert.ok(record.total_ms >= 300 && record.total_ms < 2000, `elapsed ${record.total_ms}ms`);
  const teardown = performance.now();
  while (gateway.activeStalls() && performance.now() - teardown < 1000) await delay(20);
  assert.equal(gateway.activeStalls(), 0, 'gateway must close the stalled origin connection');
  const valid = await evaluateCase({ id: 'recovered-read', tool: 'web_read', run: () => gateway.read(`${fixtureUrl}/valid`), quality: payload => ({ passed: payload.title === 'Fixture ready' && payload.markdown.includes('Gateway recovered') }) });
  assert.equal(valid.status, 'passed', gateway.logs());
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
    assert.equal(record.status, 'passed', gateway.logs());
  }
  assert.deepEqual(gateway.received.map(item => item.path), ['/redirect-private']);
});

for (const role of ['origin', 'proxy', 'gateway']) {
  test(`fixture rejects a forbidden ${role} binding before real MCP deadline and recovery`, { timeout: 15000 }, async t => {
    const availability = net.createServer();
    try {
      const listening = once(availability, 'listening');
      availability.listen(1719, '127.0.0.1');
      await listening;
    } catch {
      throw new Error('SETUP BLOCKED: fixed fixture port 1719 unavailable');
    } finally {
      if (availability.listening) await new Promise(resolve => availability.close(resolve));
    }
    let attempts = 0; let forbiddenClosed = false;
    const gateway = await fixture(t, { listenOptions: { [role]: { listen: (server, options) => {
      if (attempts === 0) server.once('close', () => { forbiddenClosed = true; });
      else assert.equal(forbiddenClosed, true, 'forbidden listener must close before rebind');
      server.listen({ ...options, port: attempts++ === 0 ? 1719 : 0 });
    } } } });
    const valid = await gateway.read(`${fixtureUrl}/valid`);
    assert.equal(valid.payload.title, 'Fixture ready', gateway.logs());
    const record = await evaluateCase({ ...timeoutDefinition, run: () => gateway.read(`${fixtureUrl}/stall`) });
    assert.equal(record.status, 'passed', gateway.logs());
    assert.equal(record.error.kind, 'egress_timeout', gateway.logs());
    assert.ok(record.total_ms >= 300 && record.total_ms < 2000, gateway.logs());
    const teardown = performance.now();
    while (gateway.activeStalls() && performance.now() - teardown < 1000) await delay(20);
    assert.equal(gateway.activeStalls(), 0, gateway.logs());
    const recovered = await gateway.read(`${fixtureUrl}/valid`);
    assert.equal(recovered.payload.title, 'Fixture ready', gateway.logs());
    assert.deepEqual(gateway.received.map(item => item.path), ['/valid', '/stall', '/valid'], gateway.logs());
    assert.equal(JSON.parse(gateway.logs()).mcp_tool_attempts, 3, gateway.logs());
    assert.equal(JSON.parse(gateway.logs()).origin_requests, 3, gateway.logs());
    t.diagnostic(gateway.logs());
    assert.notEqual(gateway.ports[role], 1719, gateway.logs());
    assert.ok(attempts >= 2 && attempts <= 25, gateway.logs());
    assert.equal(forbiddenClosed, true, gateway.logs());
  });
}
