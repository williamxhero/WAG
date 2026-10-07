import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start')), 3000);
    child.stdout.on('data', chunk => {
      if (!chunk.toString().includes('egress_proxy_listening')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', code => reject(new Error(`proxy exited during startup: ${code}`)));
  });
}

function waitForOutput(child, marker) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.stdout.removeListener('data', receive); reject(new Error(`missing child output: ${marker}`)); }, 2000);
    const receive = chunk => {
      if (!chunk.toString().includes(marker)) return;
      clearTimeout(timer);
      child.stdout.removeListener('data', receive);
      resolve();
    };
    child.stdout.on('data', receive);
  });
}

function connectRequest(port, authority = '8.8.8.8:443') {
  const socket = net.connect(port, '127.0.0.1');
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  return socket;
}

function request(port, authority = '8.8.8.8:443') {
  const socket = connectRequest(port, authority);
  socket.on('error', () => {});
  const closed = new Promise(resolve => socket.once('close', resolve));
  const response = new Promise(resolve => {
    let headers = '';
    socket.setTimeout(2000, () => socket.destroy());
    socket.on('data', chunk => {
      headers += chunk.toString('latin1');
      if (!headers.includes('\r\n\r\n')) return;
      socket.setTimeout(0);
      resolve(headers);
    });
    socket.once('close', () => resolve(headers));
  });
  return { socket, closed, response };
}

async function capacityProxy(t, { env = {}, handshake = socket => socket.write('HTTP/1.1 200 OK\r\n\r\n'), bootstrap = '' } = {}) {
  const sockets = new Set();
  const arrivals = [];
  const waiting = [];
  const upstream = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    let headers = '';
    const readHeaders = chunk => {
      headers += chunk.toString('latin1');
      if (!headers.includes('\r\n\r\n')) return;
      socket.removeListener('data', readHeaders);
      const connection = { socket, authority: /^CONNECT (\S+)/.exec(headers)[1] };
      if (waiting.length) waiting.shift()(connection); else arrivals.push(connection);
      handshake(socket, connection.authority);
      socket.on('data', data => socket.write(data));
    };
    socket.on('data', readHeaders);
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await unusedPort();
  const entry = path.join(moduleDir, 'server.mjs');
  const child = spawn(process.execPath, bootstrap
    ? ['--input-type=module', '--eval', `${bootstrap}\nawait import(${JSON.stringify(new URL('./server.mjs', import.meta.url).href)});`]
    : [entry], {
    env: {
      ...process.env,
      EGRESS_PROXY_HOST: '127.0.0.1',
      EGRESS_PROXY_PORT: String(proxyPort),
      EGRESS_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      EGRESS_CONNECT_TIMEOUT_MS: '1000',
      EGRESS_MAX_HOST_CONCURRENCY: '8',
      EGRESS_MAX_CONNECTIONS: '2',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    const exit = child.exitCode === null && child.signalCode === null
      ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
    child.kill();
    for (const socket of sockets) socket.destroy();
    await Promise.all([exit, new Promise(resolve => upstream.close(resolve))]);
  });
  await waitForListening(child);
  return {
    port: proxyPort, child, upstream, upstreamPort,
    nextTunnel: () => arrivals.length ? Promise.resolve(arrivals.shift())
      : new Promise(resolve => waiting.push(resolve)),
  };
}

test('pending and established tunnels across hosts share a prompt global capacity limit', { timeout: 10000 }, async t => {
  const proxy = await capacityProxy(t, {
    handshake: (socket, authority) => {
      if (authority === '8.8.8.8:443') return;
      socket.write('HTTP/1.1 200 OK\r\n\r\n');
    },
  });
  const pending = request(proxy.port);
  await proxy.nextTunnel();
  const established = request(proxy.port, '1.1.1.1:443');
  assert.match(await established.response, /^HTTP\/1\.1 200/);
  const excess = request(proxy.port, '9.9.9.9:443');
  assert.match(await excess.response, /^HTTP\/1\.1 429 Too Many Requests\r\nRetry-After: 5/);
  await excess.closed;
  assert.equal(pending.socket.destroyed, false, 'rejection must not wait for the pending timeout');
  established.socket.destroy();
  pending.socket.destroy();
  await Promise.all([established.closed, pending.closed]);
  assert.equal(proxy.child.exitCode, null);
});

test('the default global ceiling is 32 even when the per-host ceiling is higher', { timeout: 10000 }, async t => {
  const proxy = await capacityProxy(t, { env: { EGRESS_MAX_CONNECTIONS: undefined, EGRESS_MAX_HOST_CONCURRENCY: '64' } });
  const active = [];
  for (let i = 1; i <= 32; i += 1) {
    const tunnel = request(proxy.port, `8.8.4.${i}:443`);
    assert.match(await tunnel.response, /^HTTP\/1\.1 200/);
    active.push(tunnel);
  }
  const excess = request(proxy.port, '1.1.1.1:443');
  assert.match(await excess.response, /^HTTP\/1\.1 429/);
  await excess.closed;
  for (const tunnel of active) tunnel.socket.end();
  await Promise.all(active.map(tunnel => tunnel.closed));
  const replacement = request(proxy.port, '1.1.1.1:443');
  assert.match(await replacement.response, /^HTTP\/1\.1 200/);
  replacement.socket.end();
  await replacement.closed;
});

test('the per-host ceiling is independent and rejecting one host does not leak global capacity', { timeout: 10000 }, async t => {
  const proxy = await capacityProxy(t, { env: { EGRESS_MAX_HOST_CONCURRENCY: '1' } });
  const first = request(proxy.port);
  assert.match(await first.response, /^HTTP\/1\.1 200/);
  const sameHost = request(proxy.port);
  assert.match(await sameHost.response, /^HTTP\/1\.1 429/);
  await sameHost.closed;
  const otherHost = request(proxy.port, '1.1.1.1:443');
  assert.match(await otherHost.response, /^HTTP\/1\.1 200/);
  const full = request(proxy.port, '9.9.9.9:443');
  assert.match(await full.response, /^HTTP\/1\.1 429/);
  await full.closed;
  first.socket.end();
  await first.closed;
  const replacement = request(proxy.port);
  assert.match(await replacement.response, /^HTTP\/1\.1 200/);
  otherHost.socket.end();
  replacement.socket.end();
  await Promise.all([otherHost.closed, replacement.closed]);
});

for (const terminal of ['normal teardown', 'client reset', 'upstream reset', 'upstream close', 'pending abort', 'pending reset', 'handshake timeout', 'refused handshake', 'oversized handshake']) {
  test(`${terminal} releases exactly one reservation and preserves surviving tunnels`, { timeout: 10000 }, async t => {
    const pending = ['pending abort', 'pending reset', 'handshake timeout', 'refused handshake', 'oversized handshake'].includes(terminal);
    let attempts = 0;
    const proxy = await capacityProxy(t, {
      env: { EGRESS_MAX_HOST_CONCURRENCY: '2' },
      handshake: socket => {
        attempts += 1;
        if (attempts === 2 && pending) {
          if (terminal === 'refused handshake') socket.end('HTTP/1.1 503 Unavailable\r\n\r\n');
          if (terminal === 'oversized handshake') socket.write('x'.repeat(16385));
          return;
        }
        socket.write('HTTP/1.1 200 OK\r\n\r\n');
      },
    });
    const survivor = request(proxy.port);
    assert.match(await survivor.response, /^HTTP\/1\.1 200/);
    await proxy.nextTunnel();
    const started = Date.now();
    const victim = request(proxy.port);
    const remote = await proxy.nextTunnel();
    if (!pending) assert.match(await victim.response, /^HTTP\/1\.1 200/);
    if (terminal === 'normal teardown' || terminal === 'pending abort') victim.socket.end();
    if (terminal === 'client reset' || terminal === 'pending reset') victim.socket.resetAndDestroy();
    if (terminal === 'upstream reset') remote.socket.resetAndDestroy();
    if (terminal === 'upstream close') remote.socket.end();
    await victim.closed;
    assert.ok(Date.now() - started < (terminal === 'handshake timeout' ? 1500 : 700), 'the proxy must close before the client-side safety timeout');
    const replacement = request(proxy.port);
    assert.match(await replacement.response, /^HTTP\/1\.1 200/);
    assert.equal(survivor.socket.destroyed, false);
    const echo = new Promise(resolve => survivor.socket.once('data', resolve));
    survivor.socket.write('surviving tunnel');
    assert.equal((await echo).toString(), 'surviving tunnel');
    const excess = request(proxy.port, '1.1.1.1:443');
    assert.match(await excess.response, /^HTTP\/1\.1 429/, 'multiple terminal events must not release another tunnel’s slot');
    await excess.closed;
    const perHostExcess = request(proxy.port);
    assert.match(await perHostExcess.response, /^HTTP\/1\.1 429/);
    await perHostExcess.closed;
    survivor.socket.end();
    replacement.socket.end();
    await Promise.all([survivor.closed, replacement.closed]);
    assert.equal(proxy.child.exitCode, null);
  });
}

test('failed destination validation releases capacity before later valid requests', { timeout: 10000 }, async t => {
  const proxy = await capacityProxy(t, { env: { EGRESS_MAX_CONNECTIONS: '1', EGRESS_MAX_HOST_CONCURRENCY: '1' } });
  for (const authority of ['127.0.0.1:443', '8.8.8.8:81']) {
    const blocked = request(proxy.port, authority);
    assert.match(await blocked.response, /^HTTP\/1\.1 403/);
    await blocked.closed;
    const valid = request(proxy.port);
    assert.match(await valid.response, /^HTTP\/1\.1 200/);
    valid.socket.end();
    await valid.closed;
  }
  assert.equal(proxy.child.exitCode, null);
});

test('refused upstream TCP connections release capacity without terminating the proxy', { timeout: 10000 }, async t => {
  const proxy = await capacityProxy(t, { env: { EGRESS_MAX_CONNECTIONS: '1', EGRESS_MAX_HOST_CONCURRENCY: '1' } });
  await new Promise(resolve => proxy.upstream.close(resolve));
  const refused = request(proxy.port);
  await refused.closed;
  assert.equal(await refused.response, '');
  await new Promise(resolve => proxy.upstream.listen(proxy.upstreamPort, '127.0.0.1', resolve));
  const valid = request(proxy.port);
  assert.match(await valid.response, /^HTTP\/1\.1 200/);
  valid.socket.end();
  await valid.closed;
  assert.equal(proxy.child.exitCode, null);
});

// Inject only the OS resolver boundary in an isolated child; production policy stays unchanged.
const delayedResolver = `
  import dns from 'node:dns/promises';
  const lookup = dns.lookup;
  dns.lookup = async (name, options) => {
    if (!name.endsWith('.test')) return lookup(name, options);
    console.log('validation_started');
    await new Promise(resolve => setTimeout(resolve, 400));
    console.log('validation_finished');
    if (name === 'blocked.test') throw new Error('fixture lookup failure');
    return [{ address: '8.8.8.8', family: 4 }];
  };
`;

test('pending DNS validation consumes global capacity and failure restores admission', { timeout: 10000 }, async t => {
  const proxy = await capacityProxy(t, { env: { EGRESS_MAX_CONNECTIONS: '1' }, bootstrap: delayedResolver });
  const started = waitForOutput(proxy.child, 'validation_started');
  const pending = request(proxy.port, 'blocked.test:443');
  await started;
  const excess = request(proxy.port, '1.1.1.1:443');
  assert.match(await excess.response, /^HTTP\/1\.1 429/);
  await excess.closed;
  assert.equal(pending.socket.destroyed, false);
  assert.match(await pending.response, /^HTTP\/1\.1 403/);
  await pending.closed;
  const valid = request(proxy.port);
  assert.match(await valid.response, /^HTTP\/1\.1 200/);
  valid.socket.end();
  await valid.closed;
});

test('pending DNS validation also consumes per-host capacity without blocking other hosts', { timeout: 10000 }, async t => {
  const proxy = await capacityProxy(t, { env: { EGRESS_MAX_HOST_CONCURRENCY: '1' }, bootstrap: delayedResolver });
  const started = waitForOutput(proxy.child, 'validation_started');
  const pending = request(proxy.port, 'slow.test:443');
  await started;
  const sameHost = request(proxy.port, 'slow.test:443');
  assert.match(await sameHost.response, /^HTTP\/1\.1 429/);
  await sameHost.closed;
  const otherHost = request(proxy.port, '1.1.1.1:443');
  assert.match(await otherHost.response, /^HTTP\/1\.1 200/);
  assert.match(await pending.response, /^HTTP\/1\.1 200/);
  pending.socket.end();
  otherHost.socket.end();
  await Promise.all([pending.closed, otherHost.closed]);
});

for (const terminal of ['abort', 'timeout']) {
  test(`${terminal} during validation releases capacity and late DNS completion cannot resurrect work`, { timeout: 10000 }, async t => {
    const proxy = await capacityProxy(t, {
      env: { EGRESS_MAX_CONNECTIONS: '1', EGRESS_MAX_HOST_CONCURRENCY: '1', EGRESS_CONNECT_TIMEOUT_MS: '100' },
      bootstrap: delayedResolver,
    });
    const started = waitForOutput(proxy.child, 'validation_started');
    const finished = waitForOutput(proxy.child, 'validation_finished');
    const pending = request(proxy.port, 'slow.test:443');
    await started;
    const before = Date.now();
    if (terminal === 'abort') pending.socket.end();
    await pending.closed;
    assert.ok(Date.now() - before < 300);
    const valid = request(proxy.port);
    assert.match(await valid.response, /^HTTP\/1\.1 200/);
    await finished;
    const excess = request(proxy.port, '1.1.1.1:443');
    assert.match(await excess.response, /^HTTP\/1\.1 429/);
    await excess.closed;
    assert.equal(valid.socket.destroyed, false);
    valid.socket.end();
    await valid.closed;
    const replacement = request(proxy.port, 'slow.test:443');
    // This fresh lookup times out too: it must not inherit a leaked per-host slot.
    assert.equal(await replacement.response, '');
    await replacement.closed;
    assert.equal(proxy.child.exitCode, null);
  });
}

test('aborted over-capacity clients cannot terminate the proxy or release occupied slots', { timeout: 10000 }, async t => {
  const proxy = await capacityProxy(t, { env: { EGRESS_MAX_CONNECTIONS: '1' } });
  const survivor = request(proxy.port);
  assert.match(await survivor.response, /^HTTP\/1\.1 200/);
  for (let i = 0; i < 64; i += 1) {
    const socket = net.connect(proxy.port, '127.0.0.1');
    socket.on('error', () => {});
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.once('connect', () => {
      socket.write('CONNECT 1.1.1.1:443 HTTP/1.1\r\nHost: 1.1.1.1:443\r\n\r\n', () => socket.resetAndDestroy());
    });
    await closed;
  }
  const excess = request(proxy.port, '1.1.1.1:443');
  assert.match(await excess.response, /^HTTP\/1\.1 429/);
  await excess.closed;
  assert.equal(proxy.child.exitCode, null);
  survivor.socket.end();
  await survivor.closed;
  const replacement = request(proxy.port);
  assert.match(await replacement.response, /^HTTP\/1\.1 200/);
  replacement.socket.end();
  await replacement.closed;
});

test('invalid global capacity fails closed at startup', { timeout: 10000 }, async () => {
  for (const limit of ['0', '-1', '1.5', 'NaN', 'Infinity', '9007199254740992']) {
    const child = spawn(process.execPath, [path.join(moduleDir, 'server.mjs')], {
      env: { ...process.env, EGRESS_MAX_CONNECTIONS: limit },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    const code = await new Promise(resolve => child.once('exit', resolve));
    assert.notEqual(code, 0);
    assert.match(error, /EGRESS_MAX_CONNECTIONS must be a positive safe integer/);
  }
});

test('a stalled or reset tunnel does not terminate the proxy process', { timeout: 10000 }, async t => {
  const upstream = net.createServer();
  const upstreamPort = await listen(upstream);
  const proxyPort = await unusedPort();
  const child = spawn(process.execPath, [path.join(moduleDir, 'server.mjs')], {
    env: {
      ...process.env,
      EGRESS_PROXY_PORT: String(proxyPort),
      EGRESS_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      EGRESS_CONNECT_TIMEOUT_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => upstream.close());
  await waitForListening(child);

  const stalled = connectRequest(proxyPort);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stalled tunnel was not closed')), 1000);
    stalled.once('close', () => { clearTimeout(timer); resolve(); });
    stalled.once('error', () => {});
  });
  assert.equal(child.exitCode, null);

  const reset = connectRequest(proxyPort);
  reset.on('error', () => {});
  reset.destroy();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null);

  const subsequent = connectRequest(proxyPort);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subsequent tunnel was not accepted')), 1000);
    subsequent.once('close', () => { clearTimeout(timer); resolve(); });
    subsequent.once('error', () => {});
  });
  assert.equal(child.exitCode, null);
});
