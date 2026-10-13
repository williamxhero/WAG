import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import { listenHttp, reserveHttpPort, SafeListenError } from './fixtures/safe-listen.mjs';

function close(server) {
  server.closeAllConnections();
  return new Promise((resolve, reject) => server.close(error => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
}

class ServerDouble extends EventEmitter {
  listening = false;
  port = null;
  closes = 0;
  listen({ port }) { this.port = port; this.listening = true; queueMicrotask(() => this.emit('listening')); }
  address() { return this.listening ? { port: this.port } : null; }
  close(callback) {
    this.closes++;
    queueMicrotask(() => { this.listening = false; this.emit('close'); callback(); });
  }
}

async function rawGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    }).on('error', reject);
  });
}

test('complete Fetch forbidden list is filtered with bounded close/rebind', async () => {
  const ports = [1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080];
  for (const port of ports) {
    await assert.rejects(fetch(`http://127.0.0.1:${port}`), error => error.cause?.message === 'bad port');
    const server = new ServerDouble();
    let attempts = 0;
    const result = await listenHttp(server, { maxAttempts: 2, listen: (server, options) => server.listen({ ...options, port: attempts++ === 0 ? port : 18080 }) });
    assert.equal(attempts, 2, String(port));
    assert.equal(server.closes, 1);
    assert.equal(result.port, 18080);
    await new Promise(resolve => server.close(resolve));
  }
  for (const port of [80, 443, 1718, 1721, 2048, 2050, 10079, 10081, 65535]) {
    const server = new ServerDouble();
    const result = await listenHttp(server, { maxAttempts: 1, listen: (server, options) => server.listen({ ...options, port }) });
    assert.equal(result.port, port);
    assert.equal(server.closes, 0);
    await new Promise(resolve => server.close(resolve));
  }
});

test('default retries stop at 25 and mixed exhaustion reports the last reason', async () => {
  const server = new ServerDouble();
  let attempts = 0;
  await assert.rejects(listenHttp(server, { listen: server => { attempts++; server.listen({ port: 2049 }); } }),
    error => error.code === 'WAG_TEST_SAFE_LISTEN_EXHAUSTED' && error.attempts === 25);
  assert.equal(attempts, 25);
  assert.equal(server.closes, 25);
  let mixed = 0;
  await assert.rejects(listenHttp(server, { maxAttempts: 2, listen: server => {
    if (++mixed === 1) return server.listen({ port: 1719 });
    throw Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
  } }), error => error.reason === 'address_in_use' && error.attempts === 2);
});

test('close errors propagate without rebinding or changing caller listeners', async () => {
  const server = new ServerDouble();
  const cause = Object.assign(new Error('close failed'), { code: 'FIXTURE_CLOSE_FAILED' });
  server.close = callback => { server.listening = false; callback(cause); };
  let attempts = 0;
  await assert.rejects(listenHttp(server, { listen: server => { attempts++; server.listen({ port: 1719 }); } }), error => error === cause);
  assert.equal(attempts, 1);
  for (const event of ['error', 'listening', 'close']) assert.equal(server.listenerCount(event), 0);
});

test('real invalid bind address fails once and leaves no listener', async () => {
  const server = http.createServer();
  let attempts = 0;
  await assert.rejects(listenHttp(server, { host: '192.0.2.123', listen: (server, options) => { attempts++; return server.listen(options); } }), { code: 'EADDRNOTAVAIL' });
  assert.equal(attempts, 1);
  assert.equal(server.listening, false);
  assert.equal(server.listenerCount('error'), 0);
});

test('independent IPv4, IPv6 and hostname listeners preserve bind and URL semantics', async t => {
  const servers = ['127.0.0.1', '::1', 'localhost'].map(() => http.createServer((_req, res) => res.end('independent')));
  t.after(() => Promise.all(servers.map(close)));
  const results = await Promise.all(servers.map((server, i) => listenHttp(server, { host: ['127.0.0.1', '::1', 'localhost'][i] })));
  assert.match(results[0].url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(results[1].url, /^http:\/\/\[::1\]:\d+$/);
  assert.match(results[2].url, /^http:\/\/localhost:\d+$/);
  assert.equal(servers[0].address().family, 'IPv4');
  assert.equal(servers[1].address().family, 'IPv6');
  for (const { url, port } of results) {
    assert.equal(await (await fetch(url)).text(), 'independent');
    t.diagnostic(`host=${new URL(url).hostname} port=${port}`);
  }
});

test('reservation stays held until idempotent release then permits real HTTP rebind', async t => {
  const reservation = await reserveHttpPort();
  t.after(() => reservation.release());
  const server = http.createServer((_req, res) => res.end('released'));
  t.after(() => close(server));
  const options = { maxAttempts: 1, listen: (server, options) => server.listen({ ...options, port: reservation.port }) };
  await assert.rejects(listenHttp(server, options), error => error.code === 'WAG_TEST_SAFE_LISTEN_EXHAUSTED' && error.reason === 'address_in_use');
  await Promise.all([reservation.release(), reservation.release()]);
  await reservation.release();
  const { url, port } = await listenHttp(server, options);
  assert.equal(port, reservation.port);
  assert.equal(await (await fetch(url)).text(), 'released');
});

test('failed reservation leaves its private server unbound and removes helper listeners', async () => {
  let server;
  const cause = Object.assign(new Error('bad address'), { code: 'EADDRNOTAVAIL' });
  await assert.rejects(reserveHttpPort({ listen: value => { server = value; queueMicrotask(() => server.emit('error', cause)); } }), error => error === cause);
  assert.equal(server.listening, false);
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(server.listenerCount('listening'), 1, 'Node retains its own connection tracking listener');
});

test('listeners and reservations clean up so an isolated process exits naturally', { timeout: 5000 }, async t => {
  const module = new URL('./fixtures/safe-listen.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import http from 'node:http';
    import { listenHttp, reserveHttpPort } from ${JSON.stringify(module)};
    const reservation = await reserveHttpPort();
    await reservation.release(); await reservation.release();
    const server = http.createServer((_req, res) => res.end('clean'));
    const { url, port } = await listenHttp(server);
    if (await (await fetch(url)).text() !== 'clean') throw new Error('missing response');
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    console.log('released_port=' + port);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
  assert.deepEqual(result, { code: 0, signal: null }, stderr);
  assert.match(stdout, /released_port=\d+/);
});

test('occupied real port retries without releasing the other listener', async t => {
  const occupied = http.createServer();
  const server = http.createServer((_req, res) => res.end('retried'));
  t.after(() => Promise.all([close(occupied), close(server)]));
  const held = await listenHttp(occupied);
  let attempts = 0;
  const result = await listenHttp(server, { listen: (server, options) => server.listen({ ...options, port: attempts++ === 0 ? held.port : 0 }) });
  assert.ok(attempts >= 2 && attempts <= 25);
  assert.equal(occupied.listening, true);
  assert.notEqual(result.port, held.port);
  assert.equal(await (await fetch(result.url)).text(), 'retried');
});

test('EADDRINUSE exhaustion has an exact typed bound and removes temporary listeners', async () => {
  for (const synchronous of [false, true]) {
    const server = new ServerDouble();
    const existing = () => {};
    server.on('error', existing);
    server.on('listening', existing);
    let attempts = 0;
    const cause = Object.assign(new Error('occupied'), { code: 'EADDRINUSE' });
    await assert.rejects(listenHttp(server, { maxAttempts: 3, listen: () => {
      attempts++;
      if (synchronous) throw cause;
      queueMicrotask(() => server.emit('error', cause));
    } }), error => error instanceof SafeListenError && error.code === 'WAG_TEST_SAFE_LISTEN_EXHAUSTED'
      && error.reason === 'address_in_use' && error.attempts === 3 && error.cause === cause);
    assert.equal(attempts, 3);
    assert.equal(server.listening, false);
    assert.deepEqual(server.listeners('error'), [existing]);
    assert.deepEqual(server.listeners('listening'), [existing]);
    assert.equal(server.listenerCount('close'), 0);
  }
});

test('forbidden exhaustion closes every attempt, including the last', async () => {
  const server = new ServerDouble();
  let attempts = 0;
  await assert.rejects(listenHttp(server, { maxAttempts: 3, listen: (server, options) => {
    assert.equal(server.listening, false);
    assert.equal(server.closes, attempts++);
    server.listen({ ...options, port: 1719 });
  } }), error => error instanceof SafeListenError && error.code === 'WAG_TEST_SAFE_LISTEN_EXHAUSTED'
    && error.reason === 'forbidden_port' && error.attempts === 3);
  assert.equal(attempts, 3);
  assert.equal(server.closes, 3);
  assert.equal(server.listening, false);
  for (const event of ['error', 'listening', 'close']) assert.equal(server.listenerCount(event), 0);
});

test('invalid options fail before binding without closing an existing listener', async t => {
  for (const options of [{ host: '' }, { host: ' ' }, { host: 42 }, { maxAttempts: 0 }, { maxAttempts: 26 }, { maxAttempts: 1.5 }, { maxAttempts: Infinity }, { listen: null }, null, []]) {
    const server = new ServerDouble();
    let binds = 0;
    await assert.rejects(listenHttp(server, options && !Array.isArray(options) ? { listen: () => { binds++; server.listen({ port: 18080 }); }, ...options } : options),
      error => error instanceof SafeListenError && error.code === 'WAG_TEST_SAFE_LISTEN_INVALID_OPTIONS');
    assert.equal(binds, 0);
    assert.equal(server.closes, 0);
  }
  const server = http.createServer();
  t.after(() => close(server));
  await listenHttp(server);
  await assert.rejects(listenHttp(server), { code: 'WAG_TEST_SAFE_LISTEN_INVALID_OPTIONS' });
  assert.equal(server.listening, true);
  await assert.rejects(listenHttp({}), { code: 'WAG_TEST_SAFE_LISTEN_INVALID_OPTIONS' });
});

test('nonretryable listen errors retain identity and fail on the first attempt', async () => {
  for (const code of ['EADDRNOTAVAIL', 'ENOTFOUND', 'EACCES', 'ERR_INVALID_ARG_VALUE']) {
    for (const synchronous of [false, true]) {
      const server = new ServerDouble();
      const cause = Object.assign(new Error('invalid address'), { code });
      let attempts = 0;
      await assert.rejects(listenHttp(server, { listen: () => {
        attempts++;
        if (synchronous) throw cause;
        queueMicrotask(() => server.emit('error', cause));
      } }), error => error === cause);
      assert.equal(attempts, 1);
      assert.equal(server.listening, false);
      assert.equal(server.listenerCount('error'), 0);
      assert.equal(server.listenerCount('listening'), 0);
    }
  }
});

for (const forbidden of [1719, 2049]) {
  test(`raw HTTP works on ${forbidden} while native fetch is blocked before sending`, async t => {
    let requests = 0;
    const server = http.createServer((_req, res) => { requests++; res.end('fixture'); });
    t.after(() => close(server));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(forbidden, '127.0.0.1', resolve); });
    const url = `http://127.0.0.1:${forbidden}`;
    assert.equal(await rawGet(url), 200);
    assert.equal(requests, 1);
    await assert.rejects(fetch(url), error => error.cause?.message === 'bad port');
    assert.equal(requests, 1, 'fetch never sent a request');
    t.diagnostic(`port=${forbidden} raw=200 fetch=bad_port fetch_requests=0`);
  });

  test(`listenHttp filters ${forbidden} then serves real native fetch`, async t => {
    let attempts = 0; let requests = 0; let closed = 0;
    const server = http.createServer((_req, res) => { requests++; res.end('safe fixture'); });
    server.on('close', () => { closed++; });
    const listeners = { error: server.listenerCount('error'), listening: server.listenerCount('listening') };
    t.after(() => close(server));
    const { port, url } = await listenHttp(server, {
      listen: (server, options) => {
        assert.equal(server.listening, false);
        assert.equal(closed, attempts, 'rebind waits for the forbidden listener to close');
        return server.listen({ ...options, port: attempts++ === 0 ? forbidden : 0 });
      },
    });
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'safe fixture');
    assert.notEqual(port, forbidden);
    assert.ok(attempts >= 2);
    assert.equal(requests, 1);
    assert.equal(server.listenerCount('error'), listeners.error);
    assert.equal(server.listenerCount('listening'), listeners.listening);
    t.diagnostic(`port=${port} forbidden=${forbidden} attempts=${attempts} fetch_requests=${requests}`);
  });
}
