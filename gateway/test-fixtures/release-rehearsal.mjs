// Offline high-level fixture: real gateway, shared CONNECT proxy and evaluator.
// Browser/Crawl4AI backends are protocol stand-ins, not SDK/rendering proof.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const sourceGateway = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const credential = 'offline-release-fixture-only-not-a-live-token-00000000';
const publicUrl = 'http://deadline.fixture.test/';
const html = '<html><head><title>Offline release fixture</title></head><body><main><h1>Offline release fixture</h1><p>Controlled evidence with enough text for real extraction and quality checks.</p><a href="/clicked">fixture link</a></main></body></html>';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}
async function freePort() {
  const reservation = net.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  return port;
}
async function startChild(t, file, env, marker, preload) {
  const child = spawn(process.execPath, ['--import', preload, file], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    assert.ok(!logs.includes(credential), 'fixture logs must not contain credentials');
  });
  const started = performance.now();
  while (!logs.includes(marker)) {
    assert.equal(child.exitCode, null, logs);
    assert.ok(performance.now() - started < 5000, `child startup exceeded bound: ${logs}`);
    await delay(20);
  }
  return child;
}

export async function releaseFixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-release-evaluation-'));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = process.env.WAG_TEST_RELEASE_ROOT ?? temporary;
  const gatewayDir = process.env.WAG_TEST_GATEWAY_DIRECTORY ?? sourceGateway;
  const proxyDir = process.env.WAG_TEST_PROXY_DIRECTORY ?? path.join(sourceGateway, '../proxy');
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket); socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  };
  const received = []; const authorities = []; const browserCalls = []; const browserSessions = new Set();
  let stalls = 0; let crawlCalls = 0; let readyCalls = 0;
  const failure = { search: false, crawler: false };
  const originHandler = (req, res) => {
    received.push({ host: req.headers.host, url: req.url });
    if (req.url === '/stall') {
      stalls++; res.writeHead(200, { 'content-type': 'text/html' }); res.write('<html>');
      const timer = setInterval(() => res.write('still waiting '), 40);
      res.once('close', () => { clearInterval(timer); stalls--; }); return;
    }
    if (req.url === '/redirect-private') { res.writeHead(302, { location: 'http://127.0.0.1/' }).end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }).end(html);
  };
  const keyFile = path.join(temporary, 'key.pem'); const certFile = path.join(temporary, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyFile, '-out', certFile, '-subj', '/CN=example.com', '-addext', 'subjectAltName=DNS:example.com'], { stdio: 'ignore' });
  const origin = http.createServer(originHandler);
  const secureOrigin = https.createServer({ key: await fs.readFile(keyFile), cert: await fs.readFile(certFile) }, originHandler);
  const originPort = await listen(origin); const securePort = await listen(secureOrigin);
  const upstream = http.createServer();
  upstream.on('connect', (req, downstream, head) => {
    authorities.push(req.url);
    assert.ok(['93.184.216.34:80', '93.184.216.34:443'].includes(req.url), `unchecked CONNECT authority: ${req.url}`);
    const socket = net.connect(req.url.endsWith(':443') ? securePort : originPort, '127.0.0.1'); track(socket);
    socket.once('connect', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) socket.write(head);
      downstream.pipe(socket); socket.pipe(downstream);
    });
    downstream.once('close', () => socket.destroy()); socket.once('close', () => downstream.destroy());
  });
  const upstreamPort = await listen(upstream);
  let location = publicUrl;
  const backend = http.createServer(async (req, res) => {
    if (req.url.startsWith('/search')) {
      const readiness = new URL(req.url, 'http://fixture').searchParams.get('q') === 'readyz';
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: failure.search && !readiness ? [] : [{ url: publicUrl, title: 'Offline release fixture', content: 'Controlled search evidence' }], unresponsive_engines: [['fixture-engine', 'controlled partial failure']] })); return;
    }
    if (req.url === '/readyz') {
      readyCalls++;
      res.writeHead(failure.crawler ? 503 : 200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: !failure.crawler, initialized: !failure.crawler, lifecycle: failure.crawler ? 'failed' : 'ready' })); return;
    }
    if (req.url === '/crawl') {
      assert.equal(req.headers.authorization, `Bearer ${credential}`);
      let body = ''; for await (const chunk of req) body += chunk;
      const args = JSON.parse(body); crawlCalls++;
      assert.equal(new URL(args.urls[0]).hostname, 'deadline.fixture.test');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ results: [{ markdown: 'Offline release fixture rendered by the controlled crawler API stand-in.', screenshot: Buffer.alloc(256, 1).toString('base64'), pdf: Buffer.alloc(256, 2).toString('base64') }] })); return;
    }
    if (req.method === 'GET') {
      const session = req.headers['mcp-session-id'];
      if (!browserSessions.has(session)) { res.writeHead(405).end(); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': fixture stream\n\n');
      res.once('close', () => browserSessions.delete(session)); return;
    }
    if (req.method === 'DELETE') { browserSessions.delete(req.headers['mcp-session-id']); res.writeHead(200).end(); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const message = body ? JSON.parse(body) : null;
    if (message?.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') {
      const session = `fixture-browser-${browserSessions.size + 1}`;
      browserSessions.add(session); res.setHeader('mcp-session-id', session);
      result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'offline-browser', version: '1' } };
    } else {
      assert.equal(message.method, 'tools/call');
      const { name, arguments: args } = message.params; browserCalls.push({ name, args });
      let text = 'fixture browser complete';
      if (name === 'browser_navigate') location = args.url;
      if (name === 'browser_click') location = `${publicUrl}clicked`;
      if (name === 'browser_snapshot') text = '- link "fixture link" [ref=e1]';
      if (name === 'browser_evaluate') text = JSON.stringify(args.function.includes('querySelectorAll') ? [`${publicUrl}clicked`] : location);
      result = { content: [{ type: 'text', text }] };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  const backendPort = await listen(backend);
  for (const server of [origin, secureOrigin, upstream, backend]) server.on('connection', track);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([origin, secureOrigin, upstream, backend].map(server => new Promise(resolve => server.close(resolve))));
  });
  // Reuse the existing test-only public DNS/pinning and CI-sized deadline seams.
  // No production flag permits private destinations; both production validators run.
  const preload = path.join(temporary, 'gateway-fixture.mjs');
  await fs.writeFile(preload, `import ${JSON.stringify(new URL('./read-pinning-import.mjs', import.meta.url).href)};\nimport ${JSON.stringify(new URL('./read-deadline-import.mjs', import.meta.url).href)};\n`);
  const proxyPort = await freePort();
  await startChild(t, path.join(proxyDir, 'server.mjs'), { EGRESS_PROXY_HOST: '127.0.0.1', EGRESS_PROXY_PORT: String(proxyPort), EGRESS_UPSTREAM: `http://127.0.0.1:${upstreamPort}`, WAG_FIXTURE_DNS: '{}' }, 'egress_proxy_listening', pathToFileURL(preload).href);
  const gatewayPort = await freePort();
  await startChild(t, path.join(gatewayDir, 'server.mjs'), {
    GATEWAY_TOKEN: credential, CRAWL4AI_TOKEN: credential, GATEWAY_BIND_HOST: '127.0.0.1', GATEWAY_HOST: '127.0.0.1', GATEWAY_ALLOWED_HOSTS: '127.0.0.1', GATEWAY_PORT: String(gatewayPort),
    GATEWAY_TOKEN_RATE_LIMIT: '1000', ARTIFACT_DIR: path.join(temporary, 'artifacts'), WAG_ROOT: root,
    EGRESS_PROXY: `http://127.0.0.1:${proxyPort}`, NODE_EXTRA_CA_CERTS: certFile,
    WAG_FIXTURE_DNS: JSON.stringify({ 'example.com': [['93.184.216.34']] }),
    SEARXNG_URL: `http://127.0.0.1:${backendPort}`, CRAWL4AI_URL: `http://127.0.0.1:${backendPort}`, PLAYWRIGHT_MCP_URL: `http://127.0.0.1:${backendPort}/mcp`,
  }, 'web-access-gateway listening', pathToFileURL(preload).href);
  const samplesFile = path.join(temporary, 'samples.json');
  const samples = { search: { query: 'offline fixture', expected_domain: 'deadline.fixture.test' }, static: { url: publicUrl, expected_text: 'Offline release fixture' }, render: { url: publicUrl, expected_text: 'Offline release fixture' }, browser: { url: publicUrl }, security: { loopback_url: 'http://127.0.0.1/', redirect_to_loopback_url: `${publicUrl}redirect-private` }, timeout: { url: `${publicUrl}stall` }, thresholds: { concurrency_degradation_pct: 100 } };
  const clockFile = path.join(temporary, 'evaluation-clock.mjs');
  // Only measurement is controlled: every tools/call completion advances 10ms.
  // Concurrent pair measures 20ms vs 10ms baseline; clock reads have no effect.
  await fs.writeFile(clockFile, `let tick = 0; Object.defineProperty(performance, 'now', { value: () => tick });\nconst original = globalThis.fetch; globalThis.fetch = async (url, init) => { const response = await original(url, init); const message = typeof init?.body === 'string' ? JSON.parse(init.body) : null; if (message?.method === 'tools/call') tick += 10; return response; };\n`);
  const bin = path.join(temporary, 'bin'); await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'systemctl'), '#!/usr/bin/env bash\n[[ "$1" == show ]] || exit 91\nprintf "1\\n1\\n1\\n0\\n"\n', { mode: 0o755 });
  const base = `http://127.0.0.1:${gatewayPort}`;
  const request = (route, authenticated = true) => fetch(`${base}${route}`, { headers: authenticated ? { authorization: `Bearer ${credential}` } : {}, signal: AbortSignal.timeout(3000) });
  let evaluationNumber = 0;
  async function evaluate(thresholds = {}, expectedCode = 0) {
    await fs.writeFile(samplesFile, JSON.stringify({ ...samples, thresholds: { ...samples.thresholds, ...thresholds } }));
    const wrapper = process.env.WAG_TEST_RELEASE_WRAPPER;
    const command = wrapper ? 'bash' : process.execPath;
    const args = wrapper ? [wrapper, '--offline', root] : ['--import', pathToFileURL(clockFile).href, path.join(gatewayDir, 'eval-runner.mjs'), 'release', '--offline'];
    const child = spawn(command, args, {
      env: { PATH: `${bin}${path.delimiter}${process.env.PATH}`, SystemRoot: process.env.SystemRoot, WAG_ROOT: root, WAG_EVAL_SAMPLES: samplesFile, GATEWAY_EVAL_URL: `${base}/mcp`, GATEWAY_TOKEN: credential, WAG_EVAL_DEADLINE_MS: '10000', ...(wrapper ? { NODE_OPTIONS: `--import=${pathToFileURL(clockFile).href}` } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let killed = false;
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => { killed = true; child.kill(); }, 14000);
    const [code] = await once(child, 'close').finally(() => clearTimeout(timer));
    assert.equal(killed, false, `evaluator required external kill: ${stderr}`);
    assert.equal(code, expectedCode, `${stdout}\n${stderr}`);
    assert.doesNotMatch(stderr, /termination guard expired/);
    const reportFile = stdout.trim().split('\n').at(-1);
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
    if (process.env.WAG_TEST_RELEASE_EVIDENCE) {
      await fs.mkdir(process.env.WAG_TEST_RELEASE_EVIDENCE, { recursive: true });
      await fs.copyFile(reportFile, path.join(process.env.WAG_TEST_RELEASE_EVIDENCE, `evaluation-${++evaluationNumber}.json`));
    }
    assert.equal(report.acceptance_scope, 'deterministic_offline');
    assert.deepEqual(report.deferred_checks, ['live_public_connectivity', 'provenance_matched_live_rollout']);
    assert.equal(report.lifecycle.completed, true);
    assert.deepEqual(report.lifecycle.cleanup_errors, []);
    assert.ok(!JSON.stringify(report).includes(credential), 'report must not retain credentials');
    assert.equal(browserSessions.size, 0, 'evaluator/gateway must terminate browser MCP sessions');
    const until = performance.now() + 1000;
    while (stalls && performance.now() < until) await delay(20);
    assert.equal(stalls, 0, 'deadline must tear down the stalling origin');
    return { report, reportFile };
  }
  return { evaluate, request, failure, received, authorities, browserCalls, counts: () => ({ crawlCalls, readyCalls }), root };
}
