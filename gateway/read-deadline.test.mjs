import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { PassThrough } from 'node:stream';
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

async function fixture(t, { listenOptions = {}, launch = spawn } = {}) {
  const sockets = new Set();
  const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
  const received = [];
  const ports = { origin: null, proxy: null, gateway: null };
  let toolAttempts = 0; let connectionCause = 'unknown'; let connectionCode = 'unknown';
  const codes = new Set(['EADDRINUSE', 'EADDRNOTAVAIL', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'WAG_TEST_SAFE_LISTEN_INVALID_OPTIONS', 'WAG_TEST_SAFE_LISTEN_EXHAUSTED']);
  const diagnostics = error => {
    if (error) {
      connectionCause = 'unknown'; connectionCode = 'unknown';
      for (let depth = 0; error && depth <= 2; depth++) {
        if (error.message === 'bad port') connectionCause = 'bad_port';
        if (codes.has(error.code)) connectionCode = error.code;
        if (depth < 2) error = error.cause;
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
  let origin; let proxy; let reservation; let child; let exited; let client; let transport; let closing; let startupFailure;
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
    child = launch(process.execPath, ['--import', new URL('./test-fixtures/read-deadline-import.mjs', import.meta.url).href, path.join(directory, 'server.mjs')], {
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
    child.on('error', error => { startupFailure = failure(error); });
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
    throw startupFailure ?? failure(error);
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
  assert.ok(record.total_ms >= 300 && record.total_ms < 2000, gateway.logs());
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

async function checkFixturePort(port) {
  const availability = net.createServer();
  try {
    const listening = once(availability, 'listening');
    availability.listen(port, '127.0.0.1');
    await listening;
  } catch {
    throw new Error(`SETUP BLOCKED: fixed fixture port ${port} unavailable`);
  } finally {
    if (availability.listening) await new Promise(resolve => availability.close(resolve));
  }
}

for (const role of ['origin', 'proxy', 'gateway']) {
  test(`fixture rejects a forbidden ${role} binding before real MCP deadline and recovery`, { timeout: 15000 }, async t => {
    await checkFixturePort(1719);
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

const sentinel = 'synthetic-private-header-body-environment-token-credential-path';

function safeFailure(error, code, toolAttempts = 0, originRequests = 0) {
  assert.ok(!error.message.includes(sentinel), 'diagnostics must discard synthetic private data');
  assert.ok(!error.stack.includes(sentinel), 'stack must discard synthetic private data');
  assert.ok(error.cause === undefined, 'raw causes must not escape the fixture');
  assert.ok(Buffer.byteLength(error.message) <= 512, 'diagnostics must fit the fixed byte bound');
  let facts;
  try { facts = JSON.parse(error.message); } catch { assert.fail('failure must be a safe operational snapshot'); }
  assert.deepEqual(Object.keys(facts).sort(), ['connection_cause', 'connection_code', 'mcp_tool_attempts', 'origin_requests', 'ports']);
  assert.deepEqual(Object.keys(facts.ports).sort(), ['gateway', 'origin', 'proxy']);
  for (const port of Object.values(facts.ports)) assert.ok(port === null || Number.isInteger(port) && port > 0 && port <= 65535);
  for (const value of [facts.connection_cause, facts.connection_code]) assert.ok(/^[a-zA-Z0-9_]{1,64}$/.test(value));
  assert.equal(facts.connection_code, code);
  assert.equal(facts.mcp_tool_attempts, toolAttempts);
  assert.equal(facts.origin_requests, originRequests);
  assert.equal(error.stack, `Error: ${error.message}`);
  return true;
}

for (const failedRole of ['origin', 'proxy', 'gateway']) {
  test(`fixture cleans partial initialization and redacts ${failedRole} bind failure`, { timeout: 15000 }, async () => {
    const hooks = []; const servers = [];
    const cause = Object.assign(new Error(sentinel), { code: 'EADDRNOTAVAIL', cause: new Error(sentinel) });
    const listenOptions = Object.fromEntries(['origin', 'proxy', 'gateway'].map(role => [role, { listen: (server, options) => {
      if (!servers.includes(server)) servers.push(server);
      if (role === failedRole) throw cause;
      server.listen(options);
    } }]));
    try {
      await assert.rejects(fixture({ after: hook => hooks.push(hook) }, { listenOptions }), error => safeFailure(error, 'EADDRNOTAVAIL'));
    } finally {
      for (const hook of hooks) await hook();
    }
    assert.equal(hooks.length, 1);
    assert.equal(servers.length, ['origin', 'proxy', 'gateway'].indexOf(failedRole) + 1);
    for (const server of servers) assert.equal(server.listening, false);
  });
}

test('fixture closes every forbidden attempt and partial setup on helper exhaustion', { timeout: 15000 }, async () => {
  await checkFixturePort(1719);
  const hooks = []; const servers = [];
  let attempts = 0; let closes = 0;
  const listenOptions = {
    origin: { listen: (server, options) => { if (!servers.includes(server)) servers.push(server); server.listen(options); } },
    proxy: { maxAttempts: 3, listen: (server, options) => {
      if (attempts === 0) { if (!servers.includes(server)) servers.push(server); server.on('close', () => { closes++; }); }
      assert.equal(closes, attempts);
      attempts++;
      server.listen({ ...options, port: 1719 });
    } },
  };
  try {
    await assert.rejects(fixture({ after: hook => hooks.push(hook) }, { listenOptions }), error => safeFailure(error, 'WAG_TEST_SAFE_LISTEN_EXHAUSTED'));
  } finally {
    for (const hook of hooks) await hook();
  }
  assert.equal(attempts, 3);
  assert.equal(closes, 3);
  for (const server of servers) assert.equal(server.listening, false);
});

test('fixture startup failure discards child stderr and closes allocated listeners', { timeout: 15000 }, async t => {
  const servers = []; let child;
  const capture = (server, options) => { if (!servers.includes(server)) servers.push(server); server.listen(options); };
  await assert.rejects(fixture(t, {
    listenOptions: { origin: { listen: capture }, proxy: { listen: capture }, gateway: { listen: capture } },
    // A real child fails before readiness; no occupied-port race or production patch.
    launch: (executable, _args, options) => child = spawn(executable, ['--input-type=module', '--eval', `process.stdout.write(${JSON.stringify(sentinel)}); process.stderr.write(${JSON.stringify(sentinel)}); process.exitCode = 2;`], options),
  }), error => safeFailure(error, 'unknown'));
  assert.equal(child.exitCode, 2);
  for (const server of servers) assert.equal(server.listening, false);
});

test('fixture tool failure reports attempts without exposing arguments after cleanup', { timeout: 15000 }, async t => {
  const gateway = await fixture(t);
  await gateway.cleanup();
  await assert.rejects(gateway.read(`http://${sentinel}:${sentinel}@deadline.fixture.test/${sentinel}`), error => safeFailure(error, 'unknown', 1, 0));
  assert.equal(gateway.received.length, 0);
});

test('fixture cleanup failure is redacted after all owned listeners close', { timeout: 15000 }, async () => {
  const hooks = []; const servers = [];
  const capture = (server, options) => { if (!servers.includes(server)) servers.push(server); server.listen(options); };
  try {
    const gateway = await fixture({ after: hook => hooks.push(hook) }, { listenOptions: {
      origin: { listen: capture }, proxy: { listen: capture }, gateway: { listen: capture },
    } });
    const valid = await gateway.read(`${fixtureUrl}/valid`);
    assert.equal(valid.payload.title, 'Fixture ready');
    const close = servers[0].close.bind(servers[0]);
    servers[0].close = callback => close(() => callback(Object.assign(new Error(sentinel), { code: 'EACCES' })));
    await assert.rejects(gateway.cleanup(), error => safeFailure(error, 'EACCES', 1, 1));
    for (const server of servers) assert.equal(server.listening, false);
  } finally {
    // The injected, already-verified cleanup failure remains in the idempotent promise.
    for (const hook of hooks) await hook().catch(() => {});
  }
});

test('fixture MCP connect rejection reaches real POST and redacts dependency data', { timeout: 15000 }, async () => {
  const hooks = []; const servers = []; const requests = [];
  let child; let gatewayPort;
  const capture = (server, options) => { if (!servers.includes(server)) servers.push(server); server.listen(options); };
  try {
    await assert.rejects(fixture({ after: hook => hooks.push(hook) }, {
      listenOptions: { origin: { listen: capture }, proxy: { listen: capture }, gateway: { listen: capture } },
      launch: (executable, _args, options) => {
        gatewayPort = Number(options.env.GATEWAY_PORT);
        // Observe a real rejected MCP POST over IPC, never retain headers or body.
        const source = `
          import http from 'node:http';
          const sentinel = ${JSON.stringify(sentinel)};
          const server = http.createServer((req, res) => {
            process.send({ mcpPost: req.method === 'POST' && req.url === '/mcp', status: 503 }, () => {
              res.writeHead(503, { 'content-type': 'text/plain', 'x-fixture-private': sentinel });
              res.end(sentinel);
            });
          });
          server.listen(Number(process.env.GATEWAY_PORT), '127.0.0.1', () => {
            process.stderr.write(sentinel);
            process.stdout.write('web-access-gateway listening\\n');
          });
        `;
        child = spawn(executable, ['--input-type=module', '--eval', source], { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        child.on('message', message => requests.push(message));
        return child;
      },
    }), error => {
      safeFailure(error, 'unknown', 0, 0);
      assert.equal(JSON.parse(error.message).connection_cause, 'unknown');
      return true;
    });
  } finally {
    for (const hook of hooks) await hook();
  }
  assert.deepEqual(requests, [{ mcpPost: true, status: 503 }]);
  assert.equal(hooks.length, 1);
  assert.equal(servers.length, 3);
  for (const server of servers) assert.equal(server.listening, false);
  assert.ok(child.exitCode !== null || child.signalCode !== null, 'rejected MCP child must terminate');
  assert.equal(child.connected, false);
  assert.equal(child.stdout.destroyed, true);
  assert.equal(child.stderr.destroyed, true);
  await checkFixturePort(gatewayPort);
});

test('fixture diagnostics stop after two causes without reading deeper getters', { timeout: 15000 }, async () => {
  for (const { codes, expected } of [
    { codes: ['EPIPE', 'EACCES', 'ECONNRESET'], expected: 'ECONNRESET' },
    { codes: [sentinel, sentinel, sentinel], expected: 'unknown' },
  ]) {
    const reads = []; const hooks = []; const servers = [];
    const chain = codes.map(code => Object.assign(new Error(sentinel), { code }));
    const hidden = Object.assign(new Error('bad port'), { code: 'ETIMEDOUT' });
    for (let level = 0; level < chain.length; level++) {
      Object.defineProperty(chain[level], 'cause', { get() {
        reads.push(level + 1);
        return chain[level + 1] ?? hidden;
      } });
    }
    try {
      await assert.rejects(fixture({ after: hook => hooks.push(hook) }, { listenOptions: {
        origin: { listen: server => { servers.push(server); throw chain[0]; } },
      } }), error => {
        safeFailure(error, expected, 0, 0);
        assert.equal(JSON.parse(error.message).connection_cause, 'unknown');
        return true;
      });
    } finally {
      for (const hook of hooks) await hook();
    }
    assert.deepEqual(reads, [1, 2], 'diagnostics must not access the third cause getter');
    assert.equal(hooks.length, 1);
    assert.equal(servers.length, 1);
    assert.equal(servers[0].listening, false);
  }
});

for (const [code, expected] of [['ENOENT', 'ENOENT'], ['EACCES', 'EACCES'], [sentinel, 'unknown']]) {
  test(`fixture synthetic startup error preserves ${expected} without leaking child data`, { timeout: 15000 }, async () => {
    const hooks = []; const servers = []; const reads = [];
    const chain = [code, sentinel, sentinel].map(code => Object.assign(new Error(sentinel), { code }));
    const hidden = Object.assign(new Error('bad port'), { code: 'ETIMEDOUT' });
    for (let level = 0; level < chain.length; level++) {
      Object.defineProperty(chain[level], 'cause', { get() {
        reads.push(level + 1);
        return chain[level + 1] ?? hidden;
      } });
    }
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    });
    const capture = (server, options) => { if (!servers.includes(server)) servers.push(server); server.listen(options); };
    try {
      await assert.rejects(fixture({ after: hook => hooks.push(hook) }, {
        listenOptions: { origin: { listen: capture }, proxy: { listen: capture }, gateway: { listen: capture } },
        // Exercise the existing launch boundary without creating an OS child process.
        launch: () => {
          queueMicrotask(() => {
            child.stdout.write(sentinel); child.stderr.write(sentinel);
            child.emit('error', chain[0]);
            child.exitCode = -2;
            child.stdout.destroy(); child.stderr.destroy();
            child.emit('close', -2, null);
          });
          return child;
        },
      }), error => {
        safeFailure(error, expected, 0, 0);
        assert.equal(JSON.parse(error.message).connection_cause, 'unknown');
        return true;
      });
    } finally {
      for (const hook of hooks) await hook();
    }
    assert.deepEqual(reads, [1, 2], 'startup diagnostics must stop before the third cause getter');
    assert.equal(hooks.length, 1);
    assert.equal(servers.length, 3);
    for (const server of servers) assert.equal(server.listening, false);
    assert.equal(child.exitCode, -2);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
  });
}
