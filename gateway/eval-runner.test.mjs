import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// The injected execution deadline is 5s, followed by at most 1s cleanup and
// 1s report publication. The 9s external bound adds 2s scheduling tolerance;
// killing the evaluator is a test failure, never the normal termination path.
const externalBoundMs = 9000;

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-eval-lifecycle-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = [];
  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    const message = text ? JSON.parse(text) : null;
    requests.push({ method: request.method, url: request.url, message });
    if (handler?.(request, response, message) === true) return;
    if (request.method === 'DELETE') { response.writeHead(200).end(); return; }
    if (request.url !== '/mcp') {
      const status = request.headers.authorization ? 200 : 401;
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, dependencies: [] }));
      return;
    }
    if (request.method === 'GET') { response.writeHead(405).end(); return; }
    if (!message?.id && message?.id !== 0) { response.writeHead(202).end(); return; }
    const result = message.method === 'initialize'
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'offline-fixture', version: '1' } }
      : { content: [{ type: 'text', text: JSON.stringify({ error: { kind: 'fixture', message: 'offline fixture case failure' } }) }], isError: true };
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  return { root, url, requests, sockets, server };
}

async function runEvaluator(t, fixture, overrides = {}, nodeArgs = []) {
  const started = performance.now();
  const child = spawn(process.execPath, [...nodeArgs, path.join(moduleDir, 'eval-runner.mjs'), 'smoke'], {
    cwd: moduleDir,
    env: { ...process.env, WAG_ROOT: fixture.root, WAG_EVAL_SAMPLES: path.join(moduleDir, '../eval/samples.json'), GATEWAY_EVAL_URL: fixture.url, GATEWAY_TOKEN: 'offline-test-credential-not-a-secret'.repeat(2), WAG_EVAL_DEADLINE_MS: '5000', ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = ''; let stderr = ''; let killed = false;
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const timer = setTimeout(() => { killed = true; child.kill(); }, externalBoundMs);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }).finally(() => clearTimeout(timer));
  assert.equal(killed, false, `evaluator required external termination: ${stderr}`);
  assert.equal(code, 1, `non-passing evaluator must exit 1: ${stdout}\n${stderr}`);
  assert.doesNotMatch(stderr, /termination guard expired/, 'abort/cleanup should permit natural exit without the last-resort guard');
  assert.ok(performance.now() - started < externalBoundMs);
  const names = await fs.readdir(path.join(fixture.root, 'reports')).catch(() => []);
  const reportName = names.find(name => name.endsWith('.json'));
  const report = reportName ? JSON.parse(await fs.readFile(path.join(fixture.root, 'reports', reportName), 'utf8')) : null;
  return { report, stderr, stdout };
}

test('unreachable gateway publishes a failed startup report and exits without hanging', async t => {
  const f = await fixture(t);
  await new Promise(resolve => f.server.close(resolve));
  const { report, stderr } = await runEvaluator(t, f);
  assert.equal(report?.status, 'failed');
  assert.equal(report?.lifecycle?.completed, false);
  assert.match(report?.lifecycle?.error?.message ?? '', /fetch failed|ECONNREFUSED/i);
  assert.ok(stderr.length > 0);
});

test('stalled initialization honors the five-second lifecycle deadline', async t => {
  const f = await fixture(t, (_request, _response, message) => message?.method === 'initialize');
  const { report } = await runEvaluator(t, f);
  assert.equal(report?.status, 'failed');
  assert.equal(report?.lifecycle?.completed, false);
  assert.equal(report?.lifecycle?.error?.kind, 'lifecycle_timeout');
  assert.equal(report?.lifecycle?.deadline_ms, 5000);
  assert.equal(f.requests.filter(request => request.message?.method === 'tools/call').length, 0);
});

test('failed initialization terminates an MCP session allocated before validation failed', async t => {
  const f = await fixture(t, (_request, response, message) => {
    if (message?.method !== 'initialize') return false;
    response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'partial-mcp' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 'unsupported', capabilities: {}, serverInfo: { name: 'offline', version: '1' } } }));
    return true;
  });
  const { report } = await runEvaluator(t, f);
  assert.equal(report?.status, 'failed');
  assert.equal(report?.lifecycle?.completed, false);
  assert.match(report?.lifecycle?.error?.message ?? '', /not supported/);
  assert.ok(f.requests.some(request => request.method === 'DELETE'));
});

test('failed browser click closes the acquired browser and MCP sessions', async t => {
  const f = await fixture(t, (_request, response, message) => {
    if (message?.params?.name !== 'web_browser' || message.params.arguments.session_id) return false;
    const payload = { session_id: 'owned-browser', outputs: [{ content: [{ type: 'text', text: '- link "fixture" [ref=e1]' }] }] };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }));
    return true;
  });
  const { report } = await runEvaluator(t, f);
  assert.equal(report?.cases.find(item => item.id === 'browser-snapshot-click')?.status, 'failed');
  assert.ok(f.requests.some(request => request.message?.params?.arguments?.session_id === 'owned-browser' && request.message.params.arguments.actions?.[0]?.type === 'close'), 'browser session was not closed after click failed');
  assert.ok(f.requests.some(request => request.method === 'DELETE'), 'MCP session was not terminated');
});

test('browser error payloads retain partially initialized sessions for cleanup', async t => {
  const f = await fixture(t, (_request, response, message) => {
    if (message?.params?.name !== 'web_browser') return false;
    const args = message.params.arguments;
    const closing = args.actions[0].type === 'close';
    const payload = closing ? { closed: true } : { session_id: 'partial-browser', error: { kind: 'fixture', message: 'snapshot failed after session allocation' } };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: !closing } }));
    return true;
  });
  const { report } = await runEvaluator(t, f);
  assert.equal(report?.cases.find(item => item.id === 'browser-snapshot-click')?.status, 'failed');
  assert.ok(f.requests.some(request => request.message?.params?.arguments?.session_id === 'partial-browser' && request.message.params.arguments.actions?.[0]?.type === 'close'));
});

test('stalled HTTP response body is aborted within the lifecycle deadline', async t => {
  const f = await fixture(t, (request, response) => {
    if (request.url !== '/readyz') return false;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"ok":');
    return true;
  });
  const { report } = await runEvaluator(t, f);
  assert.equal(report?.status, 'failed');
  assert.equal(report?.lifecycle?.completed, false);
  assert.equal(report?.lifecycle?.error?.kind, 'lifecycle_timeout');
  assert.ok(f.requests.some(request => request.url === '/readyz'));
});

test('stalled MCP case stops execution instead of reporting a partial run as passed', async t => {
  const f = await fixture(t, (_request, _response, message) => message?.method === 'tools/call');
  const { report } = await runEvaluator(t, f);
  assert.equal(report?.status, 'failed');
  assert.equal(report?.lifecycle?.completed, false);
  assert.equal(report?.lifecycle?.error?.kind, 'lifecycle_timeout');
  assert.equal(f.requests.filter(request => request.message?.method === 'tools/call').length, 1);
});

test('browser deadline still closes its owned session during bounded cleanup', async t => {
  const f = await fixture(t, (_request, response, message) => {
    if (message?.params?.name !== 'web_browser') return false;
    const args = message.params.arguments;
    if (args.actions[0].type === 'click') return true;
    const payload = args.actions[0].type === 'close' ? { closed: true } : { session_id: 'stalled-browser', outputs: [{ content: [{ type: 'text', text: '- link "fixture" [ref=e1]' }] }] };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } }));
    return true;
  });
  const { report } = await runEvaluator(t, f);
  assert.equal(report?.status, 'failed');
  assert.equal(report?.lifecycle?.completed, false);
  assert.ok(f.requests.some(request => request.message?.params?.arguments?.session_id === 'stalled-browser' && request.message.params.arguments.actions?.[0]?.type === 'close'));
  assert.deepEqual(report?.lifecycle?.cleanup_errors, []);
});

test('stalled browser close cannot prevent MCP session termination', async t => {
  const f = await fixture(t, (_request, response, message) => {
    if (message?.params?.name !== 'web_browser') return false;
    const args = message.params.arguments;
    if (args.actions[0].type === 'close') return true;
    const payload = args.session_id ? { error: { kind: 'fixture', message: 'click failed' } } : { session_id: 'stalled-close', outputs: [{ content: [{ type: 'text', text: '- link "fixture" [ref=e1]' }] }] };
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: Boolean(args.session_id) } }));
    return true;
  });
  const { report } = await runEvaluator(t, f);
  assert.equal(report?.status, 'failed');
  assert.ok(report?.lifecycle?.cleanup_errors.some(error => error.kind === 'lifecycle_timeout'));
  assert.ok(f.requests.some(request => request.method === 'DELETE'));
});

test('stalled session termination reports cleanup failure without holding the process open', async t => {
  const f = await fixture(t, request => request.method === 'DELETE');
  const { report } = await runEvaluator(t, f);
  assert.equal(report?.status, 'failed');
  assert.ok(report?.lifecycle?.cleanup_errors.some(error => error.kind === 'lifecycle_timeout'));
});

test('failed report destination preserves the original startup diagnostic', async t => {
  const f = await fixture(t);
  await new Promise(resolve => f.server.close(resolve));
  await fs.writeFile(path.join(f.root, 'reports'), 'not a directory');
  const { report, stderr } = await runEvaluator(t, f);
  assert.equal(report, null);
  assert.match(stderr, /Evaluation failed:.*fetch failed|ECONNREFUSED/i);
  assert.match(stderr, /Report publication failed:/);
});

test('stalled report write is bounded and does not mask the startup failure', async t => {
  const f = await fixture(t);
  await new Promise(resolve => f.server.close(resolve));
  const preload = path.join(f.root, 'stall-report.mjs');
  // Inject only the filesystem boundary in this child. No production switch
  // can replace transports, bypass SSRF, or stall report publication.
  await fs.writeFile(preload, `import fs from 'node:fs/promises';
const writeFile = fs.writeFile.bind(fs);
fs.writeFile = (target, ...args) => String(target).endsWith('.tmp') ? new Promise(() => {}) : writeFile(target, ...args);
`);
  const { report, stderr } = await runEvaluator(t, f, {}, ['--import', pathToFileURL(preload).href]);
  assert.equal(report, null);
  assert.match(stderr, /Evaluation failed:.*fetch failed|ECONNREFUSED/i);
  assert.match(stderr, /Report publication failed: lifecycle_timeout/);
  const names = await fs.readdir(path.join(f.root, 'reports'));
  assert.deepEqual(names, []);
});

test('startup diagnostics redact credentials echoed by a failed dependency', async t => {
  const credential = 'offline-diagnostic-credential-not-secret';
  const f = await fixture(t, (request, response, message) => {
    if (message?.method !== 'initialize') return false;
    response.writeHead(500).end(`upstream failed: ${request.headers.authorization}`);
    return true;
  });
  const { report, stderr } = await runEvaluator(t, f, { GATEWAY_TOKEN: credential });
  assert.equal(report?.status, 'failed');
  assert.ok(report?.lifecycle?.error?.message.includes('upstream failed'));
  assert.ok(!JSON.stringify(report).includes(credential));
  assert.ok(!stderr.includes(credential));
});

test('fatal setup failures produce failed reports before connecting', async t => {
  const f = await fixture(t);
  const { report } = await runEvaluator(t, f, { WAG_EVAL_SAMPLES: path.join(f.root, 'missing-samples.json') });
  assert.equal(report?.status, 'failed');
  assert.equal(report?.lifecycle?.completed, false);
  assert.match(report?.lifecycle?.error?.message ?? '', /ENOENT/);
  assert.equal(f.requests.length, 0);
});
