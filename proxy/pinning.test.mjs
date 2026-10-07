import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const serverFile = new URL('./server.mjs', import.meta.url);
const dnsFixture = new URL('./fixtures/dns.mjs', import.meta.url);

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function startProxy(t, upstream, extraEnv = {}) {
  const sockets = new Set();
  upstream.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  const upstreamPort = await listen(upstream);
  t.after(() => { for (const socket of sockets) socket.destroy(); upstream.close(); });
  const reservation = net.createServer();
  const proxyPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['--import', dnsFixture.href, fileURLToPath(serverFile)], {
    env: { ...process.env, EGRESS_PROXY_HOST: '127.0.0.1', EGRESS_PROXY_PORT: String(proxyPort), EGRESS_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => child.kill());
  const lookups = [];
  child.on('message', message => lookups.push(message));
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start')), 3000);
    let output = '';
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`proxy exited ${code}: ${output}`)); });
    child.stdout.on('data', chunk => {
      output += chunk;
      for (const line of output.split('\n')) {
        if (!line.includes('egress_proxy_listening')) continue;
        clearTimeout(timer);
        resolve(JSON.parse(line).port);
      }
    });
  });
  return { port, lookups };
}

function recordingUpstream(onConnect = socket => socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')) {
  const requests = [];
  const server = net.createServer(socket => {
    let header = '';
    const receive = chunk => {
      header += chunk.toString('latin1');
      if (!header.includes('\r\n\r\n')) return;
      socket.off('data', receive);
      requests.push(header);
      onConnect(socket, header, requests.length);
    };
    socket.on('data', receive);
  });
  return { server, requests };
}

async function connect(t, port, authority) {
  const socket = net.connect(port, '127.0.0.1');
  t.after(() => socket.destroy());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('CONNECT timed out')); }, 3000);
    let header = '';
    const receive = chunk => {
      header += chunk.toString('latin1');
      const end = header.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(timer);
      socket.off('data', receive);
      resolve({ socket, status: Number(header.split(' ')[1]), header });
    };
    socket.once('error', error => { clearTimeout(timer); reject(error); });
    socket.on('data', receive);
    socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  });
}

test('CONNECT formats checked IPv4 and IPv6 destinations, including numeric authorities', { timeout: 10000 }, async t => {
  const upstream = recordingUpstream();
  const proxy = await startProxy(t, upstream.server);
  for (const [input, expected] of [
    ['navigation.test:80', '8.8.8.8:80'],
    ['ipv6.test:443', '[2606:4700:4700::1111]:443'],
    ['8.8.4.4:443', '8.8.4.4:443'],
    ['[2606:4700:4700::1001]:80', '[2606:4700:4700::1001]:80'],
    ['[::ffff:8.8.8.8]:443', '[::ffff:808:808]:443'],
  ]) {
    const result = await connect(t, proxy.port, input);
    assert.equal(result.status, 200, input);
    assert.equal(upstream.requests.at(-1).split('\r\n')[0], `CONNECT ${expected} HTTP/1.1`);
    assert.equal(upstream.requests.at(-1).split('\r\n')[1], `Host: ${expected}`);
  }
  assert.deepEqual(proxy.lookups.map(value => value.name), ['navigation.test', 'ipv6.test']);
});

test('CONNECT rejects forbidden or malformed answers and ambiguous authorities without upstream traffic', { timeout: 10000 }, async t => {
  const upstream = recordingUpstream();
  const proxy = await startProxy(t, upstream.server);
  for (const authority of [
    'mixed.test:443', 'expanded-private.test:443', 'discard.test:443', 'expanded-doc.test:443', 'invalid-answer.test:443',
    '127.0.0.1:80', '2130706433:443', '0x7f000001:443', '[::1]:443', '[0:0:0:0:0:0:0:1]:443', '[::ffff:127.0.0.1]:443', '[2001:db8::1]:443',
    'navigation.test:8080', 'navigation.test:443:80', '2606:4700:4700::1111:443',
    'user@navigation.test:443', 'https://navigation.test:443', 'navigation.test:443/path', '[navigation.test]:443',
  ]) {
    assert.equal((await connect(t, proxy.port, authority)).status, 403, authority);
  }
  assert.equal(upstream.requests.length, 0);
});

test('CONNECT fallback retries use only the once-checked answer set', { timeout: 10000 }, async t => {
  const upstream = recordingUpstream((socket, _header, attempt) => {
    socket.end(attempt === 1 ? 'HTTP/1.1 502 Bad Gateway\r\n\r\n' : 'HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  const proxy = await startProxy(t, upstream.server);
  assert.equal((await connect(t, proxy.port, 'retry.test:443')).status, 200);
  assert.deepEqual(upstream.requests.map(header => header.split('\r\n')[0]), [
    'CONNECT 8.8.8.8:443 HTTP/1.1', 'CONNECT 1.1.1.1:443 HTTP/1.1',
  ]);
  assert.deepEqual(proxy.lookups.map(value => value.name), ['retry.test']);
});

async function certificate(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-pinning-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const keyFile = path.join(directory, 'key.pem');
  const certFile = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=navigation.test', '-addext', 'subjectAltName=DNS:navigation.test,DNS:redirect.test,DNS:asset.test'], { stdio: 'ignore' });
  return { key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) };
}

function bridgeToOrigin(port) {
  return socket => {
    const origin = net.connect(port, '127.0.0.1');
    origin.on('error', () => socket.destroy());
    socket.once('close', () => origin.destroy());
    origin.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.pipe(origin);
      origin.pipe(socket);
    });
  };
}

async function exchange(socket, request) {
  return new Promise((resolve, reject) => {
    let response = '';
    socket.on('data', chunk => { response += chunk; });
    socket.once('error', reject);
    socket.once('end', () => resolve(response));
    socket.write(request);
  });
}

test('numeric pinning preserves HTTP Host and end-to-end TLS SNI and certificate checks', { timeout: 15000 }, async t => {
  const identity = await certificate(t);
  const hosts = [];
  const origin = https.createServer(identity, (req, res) => {
    hosts.push(req.headers.host);
    res.end('verified identity');
  });
  const servernames = [];
  origin.on('secureConnection', socket => servernames.push(socket.servername));
  const originPort = await listen(origin);
  t.after(() => { origin.closeAllConnections(); origin.close(); });
  const upstream = recordingUpstream(bridgeToOrigin(originPort));
  const proxy = await startProxy(t, upstream.server);
  const tunnel = await connect(t, proxy.port, 'navigation.test:443');
  const secure = tls.connect({ socket: tunnel.socket, servername: 'navigation.test', ca: identity.cert, rejectUnauthorized: true });
  const response = await exchange(secure, 'GET / HTTP/1.1\r\nHost: navigation.test\r\nConnection: close\r\n\r\n');
  assert.match(response, /verified identity/);
  assert.equal(secure.authorized, true);
  assert.deepEqual(hosts, ['navigation.test']);
  assert.deepEqual(servernames, ['navigation.test']);
  assert.match(upstream.requests[0], /^CONNECT 8\.8\.8\.8:443 /);

  const wrong = await connect(t, proxy.port, 'navigation.test:443');
  const mismatch = tls.connect({ socket: wrong.socket, servername: 'wrong.test', ca: identity.cert, rejectUnauthorized: true });
  await assert.rejects(new Promise((resolve, reject) => { mismatch.once('secureConnect', resolve); mismatch.once('error', reject); }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
  const untrusted = await connect(t, proxy.port, 'navigation.test:443');
  const noTrust = tls.connect({ socket: untrusted.socket, servername: 'navigation.test', rejectUnauthorized: true });
  await assert.rejects(new Promise((resolve, reject) => { noTrust.once('secureConnect', resolve); noTrust.once('error', reject); }), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });

  const plainHosts = [];
  const plain = http.createServer((req, res) => { plainHosts.push(req.headers.host); res.end('plain identity'); });
  const plainPort = await listen(plain);
  t.after(() => { plain.closeAllConnections(); plain.close(); });
  const plainUpstream = recordingUpstream(bridgeToOrigin(plainPort));
  const plainProxy = await startProxy(t, plainUpstream.server);
  const plainTunnel = await connect(t, plainProxy.port, 'navigation.test:80');
  assert.match(await exchange(plainTunnel.socket, 'GET / HTTP/1.1\r\nHost: navigation.test\r\nConnection: close\r\n\r\n'), /plain identity/);
  assert.deepEqual(plainHosts, ['navigation.test']);
  assert.match(plainUpstream.requests[0], /^CONNECT 8\.8\.8\.8:80 /);
});

test('ordinary absolute HTTP proxy requests remain fail-closed, including credentials and forbidden destinations', { timeout: 10000 }, async t => {
  const upstream = recordingUpstream();
  const proxy = await startProxy(t, upstream.server);
  const request = url => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: proxy.port, path: url }, response => { response.resume(); resolve(response.statusCode); }).once('error', reject);
  });
  assert.equal(await request('http://navigation.test/'), 501);
  assert.equal(await request('http://user:password@navigation.test/'), 403);
  assert.equal(await request('http://blocked.test/'), 403);
  assert.equal(await request('http://navigation.test:8080/'), 403);
  assert.equal(upstream.requests.length, 0, 'no ordinary HTTP request is forwarded unchecked');
});

test('unsupported upstream transports fail closed rather than silently using an unpinned fallback', { timeout: 10000 }, async () => {
  for (const transport of ['https://127.0.0.1:7890', 'socks5://127.0.0.1:7890']) {
    const child = spawn(process.execPath, [fileURLToPath(serverFile)], {
      env: { ...process.env, EGRESS_PROXY_HOST: '127.0.0.1', EGRESS_PROXY_PORT: '0', EGRESS_UPSTREAM: transport },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('unsupported upstream started listening')); }, 1000);
      child.once('exit', value => { clearTimeout(timer); resolve(value); });
    });
    assert.notEqual(code, 0);
  }
});

function renderingOrigin(identity) {
  const received = [];
  const origin = https.createServer(identity, (req, res) => {
    received.push(req.headers.host);
    if (req.url === '/start') { res.writeHead(302, { location: 'https://redirect.test/page' }); return res.end(); }
    if (req.url === '/private-redirect') { res.writeHead(302, { location: 'https://blocked.test/private' }); return res.end(); }
    if (req.headers.host === 'asset.test') {
      res.setHeader('content-type', 'application/javascript');
      return res.end('document.body.appendChild(document.createElement("h1")).textContent = "Public asset loaded";');
    }
    res.setHeader('content-type', 'text/html');
    res.end('<html><head><title>Pinned navigation fixture</title></head><body><p>Public rendered page</p><script src="https://asset.test/asset.js"></script><script src="https://blocked.test/private.js"></script></body></html>');
  });
  return { origin, received };
}

test('real Playwright MCP proxy routing pins navigation, redirects and rendered subrequests', { timeout: 30000 }, async t => {
  const requireGateway = createRequire(new URL('../gateway/package.json', import.meta.url));
  const { Client } = requireGateway('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = requireGateway('@modelcontextprotocol/sdk/client/stdio.js');
  const requireBrowser = createRequire(new URL('../runtime/playwright-mcp/package.json', import.meta.url));
  const { chromium } = requireBrowser('playwright');
  const identity = await certificate(t);
  const { origin, received } = renderingOrigin(identity);
  const originPort = await listen(origin);
  t.after(() => { origin.closeAllConnections(); origin.close(); });
  const upstream = recordingUpstream(bridgeToOrigin(originPort));
  const proxy = await startProxy(t, upstream.server);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-browser-pinning-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const spki = new crypto.X509Certificate(identity.cert).publicKey.export({ type: 'spki', format: 'der' });
  const fingerprint = crypto.createHash('sha256').update(spki).digest('base64');
  const configFile = path.join(directory, 'browser.json');
  // Chromium trusts only this generated fixture key, not arbitrary self-signed
  // certificates. Production flags and TLS validation are not changed.
  await fs.writeFile(configFile, JSON.stringify({ browser: { launchOptions: { args: [`--ignore-certificate-errors-spki-list=${fingerprint}`, '--disable-background-networking', '--disable-quic'] } } }));
  const unit = await fs.readFile(new URL('../systemd/web-access-playwright.service', import.meta.url), 'utf8');
  assert.match(unit, /--proxy-server http:\/\/127\.0\.0\.1:7895/);
  assert.match(unit, /--block-service-workers/);
  assert.doesNotMatch(unit, /--ignore-https-errors|ignore-certificate-errors/);
  const cli = path.join(path.dirname(requireBrowser.resolve('@playwright/mcp')), 'cli.js');
  const transport = new StdioClientTransport({ command: process.execPath, args: [cli, '--headless', '--isolated', '--block-service-workers', '--proxy-server', `http://127.0.0.1:${proxy.port}`, '--executable-path', process.env.WAG_TEST_CHROMIUM_EXECUTABLE || chromium.executablePath(), '--config', configFile, '--output-dir', directory, '--timeout-navigation', '5000'], cwd: fileURLToPath(new URL('../runtime/playwright-mcp/', import.meta.url)), stderr: 'pipe' });
  const client = new Client({ name: 'pinning-fixture', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const navigation = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://navigation.test/start' } });
  assert.notEqual(navigation.isError, true, JSON.stringify(navigation));
  const rendered = await client.callTool({ name: 'browser_evaluate', arguments: { function: '() => document.body.innerText' } });
  assert.match(JSON.stringify(rendered), /Public asset loaded/);
  assert.ok(received.includes('navigation.test'));
  assert.ok(received.includes('redirect.test'));
  assert.ok(received.includes('asset.test'));
  assert.ok(proxy.lookups.some(value => value.name === 'blocked.test'));
  assert.ok(upstream.requests.every(header => /^CONNECT (?:8\.8\.8\.8|1\.1\.1\.1|9\.9\.9\.9):443 HTTP\/1\.1\r\n/.test(header)));
  const blocked = await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://navigation.test/private-redirect' } });
  assert.equal(blocked.isError, true, 'a browser redirect to private DNS cannot establish a tunnel');
  assert.ok(!received.includes('blocked.test'));
});

test('owned crawler API proxy config enforces navigation, redirects and real rendered subrequests', { timeout: 30000 }, async t => {
  const identity = await certificate(t);
  const { origin, received } = renderingOrigin(identity);
  const originPort = await listen(origin);
  t.after(() => { origin.closeAllConnections(); origin.close(); });
  const upstream = recordingUpstream(bridgeToOrigin(originPort));
  const proxy = await startProxy(t, upstream.server);
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-crawler-pinning-'));
  const spki = new crypto.X509Certificate(identity.cert).publicKey.export({ type: 'spki', format: 'der' });
  const child = spawn(process.env.PYTHON || 'python', [fileURLToPath(new URL('./fixtures/crawler.py', import.meta.url))], {
    cwd: directory,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', WAG_FIXTURE_NODE: process.execPath, WAG_FIXTURE_PORT: String(port), WAG_FIXTURE_SPKI: crypto.createHash('sha256').update(spki).digest('base64'), CRAWL4AI_TOKEN: 'offline-crawler-fixture', CRAWL4AI_DATA_DIR: directory, EGRESS_PROXY: `http://127.0.0.1:${proxy.port}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('crawler fixture did not start')), 5000);
    let diagnostics = '';
    child.stderr.on('data', chunk => { diagnostics += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`crawler fixture exited ${code}: ${diagnostics}`)); });
    child.stdout.on('data', chunk => { if (chunk.toString().includes('crawler_fixture_listening')) { clearTimeout(timer); resolve(); } });
  });
  const crawl = url => fetch(`http://127.0.0.1:${port}/crawl`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer offline-crawler-fixture' }, body: JSON.stringify({ urls: [url], browser_config: { proxy_config: { server: 'http://127.0.0.1:1' } } }), signal: AbortSignal.timeout(10000) });
  const safe = await crawl('https://navigation.test/start');
  assert.equal(safe.status, 200, await safe.clone().text());
  assert.match((await safe.json()).results[0].markdown, /Public asset loaded/);
  assert.ok(received.includes('navigation.test'));
  assert.ok(received.includes('redirect.test'));
  assert.ok(received.includes('asset.test'));
  assert.ok(proxy.lookups.some(value => value.name === 'blocked.test'));
  assert.ok(upstream.requests.every(header => /^CONNECT (?:8\.8\.8\.8|1\.1\.1\.1|9\.9\.9\.9):443 HTTP\/1\.1\r\n/.test(header)));
  const blocked = await crawl('https://navigation.test/private-redirect');
  assert.equal(blocked.status, 502, 'the rendered redirect cannot tunnel to private DNS');
  assert.equal((await crawl('https://blocked.test/private')).status, 400, 'top-level policy remains public-only');
  assert.ok(!received.includes('blocked.test'));
});

test('checked-address retries retain one capacity reservation until terminal teardown', { timeout: 10000 }, async t => {
  let retrySocket;
  let retryArrived;
  const arrived = new Promise(resolve => { retryArrived = resolve; });
  const upstream = recordingUpstream((socket, _header, attempt) => {
    if (attempt === 1) return socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    if (attempt === 2) { retrySocket = socket; retryArrived(); return; }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  });
  const proxy = await startProxy(t, upstream.server, { EGRESS_MAX_CONNECTIONS: '1', EGRESS_MAX_HOST_CONCURRENCY: '1' });
  const pending = connect(t, proxy.port, 'retry.test:443');
  await arrived;
  assert.equal((await connect(t, proxy.port, '1.1.1.1:443')).status, 429, 'the checked retry still occupies global capacity');
  retrySocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
  const established = await pending;
  assert.equal(established.status, 200);
  assert.equal((await connect(t, proxy.port, '1.1.1.1:443')).status, 429, 'the established retry holds the same reservation');
  const closed = new Promise(resolve => established.socket.once('close', resolve));
  established.socket.end();
  await closed;
  assert.equal((await connect(t, proxy.port, '8.8.4.4:443')).status, 200, 'terminal teardown restores admission');
  assert.equal((await connect(t, proxy.port, '1.1.1.1:443')).status, 429, 'retry close/error events cannot release another tunnel');
  assert.deepEqual(upstream.requests.map(header => header.split('\r\n')[0]), ['CONNECT 8.8.8.8:443 HTTP/1.1', 'CONNECT 1.1.1.1:443 HTTP/1.1', 'CONNECT 8.8.4.4:443 HTTP/1.1']);
  assert.deepEqual(proxy.lookups.map(value => value.name), ['retry.test']);
});

test('CONNECT pins the checked address rather than delegating a rebinding hostname', { timeout: 10000 }, async t => {
  const upstream = recordingUpstream();
  const proxy = await startProxy(t, upstream.server);
  const first = await connect(t, proxy.port, 'rebind.test:443');
  assert.equal(first.status, 200);
  assert.match(upstream.requests[0], /^CONNECT 8\.8\.8\.8:443 HTTP\/1\.1\r\nHost: 8\.8\.8\.8:443\r\n/);
  assert.equal(proxy.lookups.length, 1);
  const later = await connect(t, proxy.port, 'rebind.test:443');
  assert.equal(later.status, 403);
  assert.equal(upstream.requests.length, 1, 'the later forbidden answer never reaches upstream');
});
