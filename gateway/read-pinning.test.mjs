import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function freePort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function child(t, file, env, ready) {
  const processChild = spawn(process.execPath, ['--import', new URL('./test-fixtures/read-pinning-import.mjs', import.meta.url).href, fileURLToPath(file)], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(async () => {
    if (processChild.exitCode === null && processChild.signalCode === null) {
      const exited = once(processChild, 'exit');
      processChild.kill();
      await exited;
    }
  });
  const lookups = [];
  processChild.on('message', message => lookups.push(message));
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`fixture startup timed out: ${output}`)), 5000);
    processChild.once('error', error => { clearTimeout(timer); reject(error); });
    processChild.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture exited ${code}: ${output}`)); });
    processChild.stderr.on('data', chunk => { output += chunk; });
    processChild.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes(ready)) { clearTimeout(timer); resolve(); }
    });
  });
  return { lookups };
}
async function certificate(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-read-pinning-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=tls.test', '-addext', 'subjectAltName=DNS:tls.test,DNS:redirect.test,IP:8.8.4.4,IP:2606:4700:4700::1001'], { stdio: 'ignore' });
  return { key: await fs.readFile(keyFile), cert: await fs.readFile(certFile), certFile };
}
async function fixture(t, { answers = {}, rejectAuthorities = [], respond, identity, trust = true } = {}) {
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  };
  const received = [];
  const handler = (req, res) => {
    received.push({ host: req.headers.host, path: req.url });
    if (respond) return respond(req, res);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>Pinned fixture</title></head><body><article>Legitimate offline article.</article></body></html>');
  };
  const origin = http.createServer(handler);
  origin.on('connection', track);
  const originPort = await listen(origin);
  const secureOrigin = identity ? https.createServer(identity, handler) : null;
  const servernames = [];
  secureOrigin?.on('connection', track);
  secureOrigin?.on('secureConnection', socket => servernames.push(socket.servername));
  const securePort = secureOrigin ? await listen(secureOrigin) : null;
  const authorities = [];
  const activeTunnels = new Set();
  const upstream = http.createServer();
  upstream.on('connection', track);
  upstream.on('connect', (req, downstream, head) => {
    authorities.push(req.url);
    activeTunnels.add(downstream);
    downstream.once('close', () => activeTunnels.delete(downstream));
    if (rejectAuthorities.includes(req.url)) return downstream.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    // Only the recording fixture maps synthetic checked IPs to a local origin.
    const socket = net.connect(req.url.endsWith(':443') && securePort ? securePort : originPort, '127.0.0.1');
    track(socket);
    socket.once('connect', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.write(head);
      downstream.pipe(socket); socket.pipe(downstream);
    });
    downstream.once('close', () => socket.destroy());
    socket.once('close', () => downstream.destroy());
  });
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, upstream, secureOrigin].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
  });
  const proxyPort = await freePort();
  const proxy = await child(t, new URL('../proxy/server.mjs', import.meta.url), {
    EGRESS_PROXY_HOST: '127.0.0.1', EGRESS_PROXY_PORT: String(proxyPort),
    EGRESS_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
    // A fresh hostname lookup at the proxy would see a forbidden changed answer.
    WAG_FIXTURE_DNS: JSON.stringify(Object.fromEntries(Object.keys(answers).map(name => [name, [['127.0.0.1']]]))),
  }, 'egress_proxy_listening');
  const gatewayPort = await freePort();
  const token = 'offline-pinning-fixture-only-not-live-00000000';
  const gateway = await child(t, new URL('./server.mjs', import.meta.url), {
    GATEWAY_TOKEN: token, GATEWAY_HOST: '127.0.0.1', GATEWAY_BIND_HOST: '127.0.0.1',
    GATEWAY_ALLOWED_HOSTS: '127.0.0.1', GATEWAY_PORT: String(gatewayPort),
    EGRESS_PROXY: `http://127.0.0.1:${proxyPort}`, WAG_FIXTURE_DNS: JSON.stringify(answers),
    ...(identity && trust ? { NODE_EXTRA_CA_CERTS: identity.certFile } : {}),
  }, 'web-access-gateway listening');
  const client = new Client({ name: 'offline-pinning', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  const read = url => client.callTool({ name: 'web_read', arguments: { url, render: 'never', output: 'markdown' } }, undefined, { timeout: 5000 });
  const assertReleased = async () => {
    const deadline = performance.now() + 1000;
    while (activeTunnels.size && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(activeTunnels.size, 0, 'all forwarded tunnels must close after terminal reads');
  };
  return { read, authorities, received, servernames, gateway, proxy, assertReleased };
}

test('every redirect is checked and pinned anew while final evidence keeps the logical URL', { timeout: 15000 }, async t => {
  const identity = await certificate(t);
  const f = await fixture(t, { identity, answers: {
    'start.test': [['8.8.8.8']], 'redirect.test': [['2606:4700:4700::1111']],
  }, respond(req, res) {
    if (req.url === '/start') return res.writeHead(302, { location: 'https://redirect.test/articles/final?edition=2' }).end();
    if (req.url === '/articles/final?edition=2') return res.writeHead(307, { location: './published?edition=2' }).end();
    res.writeHead(200, { 'content-type': 'text/html', date: 'Mon, 28 Sep 2026 00:00:00 GMT' });
    res.end('<html><head><title>Final article</title><link rel="canonical" href="/publisher-declared"></head><body><article>Redirected evidence.</article></body></html>');
  } });
  const result = await f.read('http://start.test/start');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  const payload = result.structuredContent;
  assert.equal(payload.url, 'https://redirect.test/articles/published?edition=2');
  assert.equal(payload.source.url, payload.url);
  assert.equal(payload.source.host, 'redirect.test');
  assert.equal(payload.source.canonical_url, 'https://redirect.test/publisher-declared');
  assert.equal(payload.published_at, null);
  assert.match(payload.markdown, /Redirected evidence/);
  assert.deepEqual(f.authorities, ['8.8.8.8:80', '[2606:4700:4700::1111]:443', '[2606:4700:4700::1111]:443']);
  assert.deepEqual(f.received.map(request => request.host), ['start.test', 'redirect.test', 'redirect.test']);
  assert.deepEqual(f.servernames, ['redirect.test', 'redirect.test']);
  assert.deepEqual(f.gateway.lookups, [{ name: 'start.test', call: 1 }, { name: 'redirect.test', call: 1 }, { name: 'redirect.test', call: 2 }]);
  assert.deepEqual(f.proxy.lookups, []);
  await f.assertReleased();
});

test('redirects retain protocol, credential, port, public-address and count protections', { timeout: 15000 }, async t => {
  const f = await fixture(t, { answers: {
    'start.test': [['8.8.8.8']], 'mixed.test': [['1.1.1.1', '127.0.0.1']],
    'rebind.test': [['9.9.9.9'], ['127.0.0.1']],
  }, respond(req, res) {
    const targets = {
      '/protocol': 'ftp://start.test/private', '/credentials': 'http://user:password@start.test/private',
      '/port': 'http://start.test:8080/private', '/private': 'http://127.0.0.1/private',
      '/ipv6-private': 'http://[::1]/private', '/mixed': 'http://mixed.test/private',
      '/same-host': '/private', '/loop': '/loop',
    };
    if (targets[req.url]) return res.writeHead(302, { location: targets[req.url] }).end();
    res.writeHead(200, { 'content-type': 'text/html' }).end('<article>Recovered valid evidence.</article>');
  } });
  for (const [path, reason] of [
    ['/protocol', 'unsupported_url'], ['/credentials', 'unsupported_url'], ['/port', 'unsupported_port'],
    ['/private', 'non_public_address'], ['/ipv6-private', 'non_public_address'], ['/mixed', 'non_public_address'],
  ]) {
    const before = f.authorities.length;
    const result = await f.read(`http://start.test${path}`);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.error.kind, 'ssrf_blocked');
    assert.equal(result.structuredContent.blocked_reason, reason);
    assert.equal(f.authorities.length, before + 1, 'the rejected redirect must not connect');
    await f.assertReleased();
  }
  const before = f.authorities.length;
  const sameHost = await f.read('http://rebind.test/same-host');
  assert.equal(sameHost.structuredContent.error.kind, 'ssrf_blocked');
  assert.equal(f.authorities.length, before + 1);
  assert.deepEqual(f.gateway.lookups.filter(value => value.name === 'rebind.test'), [{ name: 'rebind.test', call: 1 }, { name: 'rebind.test', call: 2 }]);
  const beforeLoop = f.authorities.length;
  const loop = await f.read('http://start.test/loop');
  assert.equal(loop.structuredContent.error.kind, 'redirect_limit');
  assert.equal(f.authorities.length, beforeLoop + 6);
  await f.assertReleased();
  assert.notEqual((await f.read('http://start.test/recovered')).isError, true);
  assert.equal(f.received.at(-1).path, '/recovered');
  assert.deepEqual(f.proxy.lookups, []);
});

test('exhausted CONNECT retries close cleanly without a fresh lookup or replaying downstream failures', { timeout: 15000 }, async t => {
  const f = await fixture(t, {
    answers: { 'exhaust.test': [['8.8.8.8', '1.1.1.1'], ['127.0.0.1']], 'valid.test': [['9.9.9.9', '8.8.4.4']] },
    rejectAuthorities: ['8.8.8.8:80', '1.1.1.1:80'],
    respond(req, res) {
      if (req.url === '/error') return res.writeHead(503).end('origin failed');
      res.writeHead(200, { 'content-type': 'text/html' }).end('<article>Recovered valid evidence.</article>');
    },
  });
  const rejected = await f.read('http://exhaust.test/article');
  assert.equal(rejected.isError, true);
  assert.equal(rejected.structuredContent.error.kind, 'egress_connect');
  assert.deepEqual(f.authorities, ['8.8.8.8:80', '1.1.1.1:80']);
  assert.deepEqual(f.gateway.lookups, [{ name: 'exhaust.test', call: 1 }]);
  assert.deepEqual(f.received, []);
  await f.assertReleased();
  const failure = await f.read('http://valid.test/error');
  assert.equal(failure.structuredContent.error.kind, 'upstream_http_status');
  assert.deepEqual(f.authorities, ['8.8.8.8:80', '1.1.1.1:80', '9.9.9.9:80']);
  await f.assertReleased();
  assert.notEqual((await f.read('http://valid.test/recovered')).isError, true);
});

test('untrusted HTTPS certificates fail without an HTTP request and subsequent HTTP reads recover', { timeout: 15000 }, async t => {
  const identity = await certificate(t);
  const f = await fixture(t, { identity, trust: false, answers: { 'tls.test': [['8.8.8.8', '1.1.1.1']] } });
  const result = await f.read('https://tls.test/private');
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.kind, 'tls_error');
  assert.match(result.structuredContent.error.message, /self.signed|certificate/i);
  assert.deepEqual(f.received, []);
  assert.deepEqual(f.authorities, ['8.8.8.8:443'], 'TLS failures must not retry another checked IP');
  await f.assertReleased();
  assert.notEqual((await f.read('http://tls.test/recovered')).isError, true);
  await f.assertReleased();
});

test('lightweight reads fail closed for egress transports that cannot enforce numeric CONNECT pinning', { timeout: 10000 }, async () => {
  for (const proxy of ['https://127.0.0.1:7895', 'socks5://127.0.0.1:7895', 'http://user:password@127.0.0.1:7895']) {
    const processChild = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        GATEWAY_TOKEN: 'offline-pinning-fixture-only-not-live-00000000', GATEWAY_BIND_HOST: '127.0.0.1', GATEWAY_PORT: '0', EGRESS_PROXY: proxy },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    processChild.stderr.on('data', chunk => { diagnostics += chunk; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { processChild.kill(); reject(new Error(`unsupported transport started: ${proxy}`)); }, 2500);
      processChild.once('exit', value => { clearTimeout(timer); resolve(value); });
      processChild.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.notEqual(code, 0);
    assert.match(diagnostics, /cannot enforce address pinning/);
    assert.equal(diagnostics.includes('user:password'), false);
  }
});

test('mixed, empty, malformed and forbidden DNS answer sets are rejected before CONNECT', { timeout: 15000 }, async t => {
  const f = await fixture(t, { answers: {
    'mixed.test': [['8.8.8.8', '127.0.0.1']],
    'empty.test': [[]],
    'malformed.test': [['not:an:ip']],
    'expanded.test': [['0:0:0:0:0:0:0:1']],
    'mapped.test': [['::ffff:7f00:1']],
    'docs.test': [['2001:0db8:0:0:0:0:0:1']],
    'valid.test': [['1.1.1.1']],
  } });
  for (const name of ['mixed', 'empty', 'malformed', 'expanded', 'mapped', 'docs']) {
    const result = await f.read(`http://${name}.test/private`);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.kind, 'ssrf_blocked', JSON.stringify(result));
    assert.equal(result.structuredContent.blocked_reason, 'non_public_address');
  }
  assert.deepEqual(f.authorities, []);
  assert.deepEqual(f.received, []);
  assert.deepEqual(f.proxy.lookups, []);
  assert.notEqual((await f.read('http://valid.test/recovered')).isError, true);
});

test('HTTPS reads preserve Host, DNS SNI and certificate identity for logical names and numeric IP URLs', { timeout: 15000 }, async t => {
  const identity = await certificate(t);
  const f = await fixture(t, { identity, answers: { 'tls.test': [['8.8.8.8']], 'mismatch.test': [['8.8.8.8']] } });
  for (const url of ['https://tls.test/article', 'https://8.8.4.4/article', 'https://[2606:4700:4700::1001]/article']) {
    const result = await f.read(url);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.url, url);
    assert.equal(f.received.at(-1).host, new URL(url).host);
  }
  assert.deepEqual(f.authorities, ['8.8.8.8:443', '8.8.4.4:443', '[2606:4700:4700::1001]:443']);
  assert.deepEqual(f.servernames, ['tls.test', false, false]);
  const mismatch = await f.read('https://mismatch.test/private');
  assert.equal(mismatch.isError, true);
  assert.equal(mismatch.structuredContent.error.kind, 'tls_error');
  assert.match(mismatch.structuredContent.error.message, /altnames|certificate/i);
  assert.equal(f.received.some(request => request.host === 'mismatch.test'), false);
  const wrongIP = await f.read('https://[2606:4700:4700::1111]/private');
  assert.equal(wrongIP.isError, true);
  assert.equal(wrongIP.structuredContent.error.kind, 'tls_error');
  await f.assertReleased();
  const recovered = await f.read('https://tls.test/recovered');
  assert.notEqual(recovered.isError, true, JSON.stringify(recovered));
  assert.equal(f.received.at(-1).path, '/recovered');
});

test('numeric IPv4 and IPv6 reads preserve their logical Host without DNS resolution', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const [url, authority, host] of [
    ['http://8.8.4.4/article', '8.8.4.4:80', '8.8.4.4'],
    ['http://[2606:4700:4700::1001]/article', '[2606:4700:4700::1001]:80', '[2606:4700:4700::1001]'],
  ]) {
    const result = await f.read(url);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.equal(result.structuredContent.url, url);
    assert.equal(f.authorities.at(-1), authority);
    assert.equal(f.received.at(-1).host, host);
  }
  assert.deepEqual(f.gateway.lookups, []);
  assert.deepEqual(f.proxy.lookups, []);
});

test('lightweight CONNECT retries stay within the once-checked IPv4/IPv6 answer set', { timeout: 15000 }, async t => {
  const f = await fixture(t, {
    answers: { 'retry.test': [['8.8.8.8', '2606:4700:4700::1111'], ['127.0.0.1']] },
    rejectAuthorities: ['8.8.8.8:80'],
  });
  const result = await f.read('http://retry.test/article');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.deepEqual(f.authorities, ['8.8.8.8:80', '[2606:4700:4700::1111]:80']);
  assert.deepEqual(f.gateway.lookups, [{ name: 'retry.test', call: 1 }]);
  assert.deepEqual(f.proxy.lookups, []);
  assert.deepEqual(f.received, [{ host: 'retry.test', path: '/article' }]);
});

test('lightweight HTTP read uses its checked IP despite a changed proxy DNS answer and retains website identity', { timeout: 15000 }, async t => {
  const f = await fixture(t, { answers: { 'rebind.test': [['8.8.8.8'], ['127.0.0.1']] } });
  const result = await f.read('http://rebind.test/article?edition=1');
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.equal(result.structuredContent.title, 'Pinned fixture');
  assert.match(result.structuredContent.markdown, /Legitimate offline article/);
  assert.equal(result.structuredContent.url, 'http://rebind.test/article?edition=1');
  assert.equal(result.structuredContent.source.url, result.structuredContent.url);
  assert.equal(result.structuredContent.source.host, 'rebind.test');
  assert.deepEqual(f.authorities, ['8.8.8.8:80']);
  assert.deepEqual(f.received, [{ host: 'rebind.test', path: '/article?edition=1' }]);
  assert.deepEqual(f.gateway.lookups, [{ name: 'rebind.test', call: 1 }]);
  assert.deepEqual(f.proxy.lookups, []);
});
