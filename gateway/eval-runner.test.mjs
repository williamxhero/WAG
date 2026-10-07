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

async function runEvaluator(t, fixture, overrides = {}, nodeArgs = [], expectedCode = 1, suite = 'smoke', offline = false) {
  const started = performance.now();
  const child = spawn(process.execPath, [...nodeArgs, path.join(moduleDir, 'eval-runner.mjs'), suite, ...(offline ? ['--offline'] : [])], {
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
  assert.equal(code, expectedCode, `unexpected evaluator exit: ${stdout}\n${stderr}`);
  assert.doesNotMatch(stderr, /termination guard expired/, 'abort/cleanup should permit natural exit without the last-resort guard');
  assert.ok(performance.now() - started < externalBoundMs);
  const names = await fs.readdir(path.join(fixture.root, 'reports')).catch(() => []);
  const reportName = names.find(name => name.endsWith('.json'));
  const report = reportName ? JSON.parse(await fs.readFile(path.join(fixture.root, 'reports', reportName), 'utf8')) : null;
  return { report, stderr, stdout };
}

async function passingFixture(t, handler) {
  const retrievedAt = '2026-10-07T00:00:00Z';
  const page = url => ({ url, source: { url, host: new URL(url).host }, retrieved_at: retrievedAt, temporal_evidence: [{ kind: 'retrieved_at', value: retrievedAt, source: 'gateway.clock' }], http_status: 200, content_type: 'text/html', bytes: 100, content_hash: 'a'.repeat(64), title: 'Example Domain', markdown: 'Quotes to Scrape. A controlled offline page with enough evidence text for extraction quality.' });
  const f = await fixture(t, (request, response, message) => {
    if (handler?.(request, response, message) === true) return true;
    if (message?.method !== 'tools/call') return false;
    const { name, arguments: args } = message.params;
    let payload; let isError = false;
    if (name === 'web_search') payload = { results: [page('https://searxng.org/')] };
    else if (name === 'web_browser') {
      payload = args.actions[0].type === 'close' ? { closed: true } : { ...page('https://example.com/'), session_id: 'happy-browser', outputs: [{ content: [{ type: 'text', text: '- link "fixture" [ref=e1]' }] }] };
    } else if (args.url.startsWith('http://127.0.0.1') || args.url.includes('redirect-to?url=')) {
      isError = true;
      payload = { blocked_reason: 'non_public_address', error: { kind: 'ssrf_blocked', message: 'non_public_address' } };
    } else if (['screenshot', 'pdf'].includes(args.output)) {
      payload = { artifact: { id: `2026-10-07/123e4567-e89b-12d3-a456-426614174000.${args.output === 'pdf' ? 'pdf' : 'png'}`, bytes: 200 } };
    } else payload = page(args.url);
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError } }));
    return true;
  });
  return f;
}

test('completed offline smoke retains a passed report and releases owned sessions', async t => {
  const f = await passingFixture(t);
  const { report, stderr } = await runEvaluator(t, f, {}, [], 0);
  assert.equal(report?.status, 'passed');
  assert.equal(report?.lifecycle?.completed, true);
  assert.deepEqual(report?.lifecycle?.cleanup_errors, []);
  assert.equal(stderr, '');
  assert.ok(f.requests.some(request => request.method === 'DELETE'));
});

test('offline release refuses missing controlled-timeout samples and cannot certify public connectivity', async t => {
  const f = await passingFixture(t);
  const { report } = await runEvaluator(t, f, {}, [], 1, 'release', true);
  assert.equal(report.status, 'failed');
  assert.equal(report.acceptance_scope, 'deterministic_offline');
  assert.deepEqual(report.deferred_checks, ['live_public_connectivity', 'provenance_matched_live_rollout']);
  assert.equal(report.lifecycle.completed, false);
  assert.match(report.lifecycle.error.message, /controlled timeout/);
});

test('offline release rejects public sample URLs before sending any tool requests', async t => {
  const f = await passingFixture(t);
  const samples = JSON.parse(await fs.readFile(path.join(moduleDir, '../eval/samples.json'), 'utf8'));
  const file = path.join(f.root, 'offline-samples.json');
  await fs.writeFile(file, JSON.stringify({ ...samples, timeout: { url: 'http://deadline.fixture.test/stall' } }));
  const { report } = await runEvaluator(t, f, { WAG_EVAL_SAMPLES: file }, [], 1, 'release', true);
  assert.match(report.lifecycle.error.message, /controlled fixture URLs/);
  assert.equal(f.requests.filter(request => request.message?.method === 'tools/call').length, 0);
});

async function samplesWithThresholds(f, thresholds) {
  const samples = JSON.parse(await fs.readFile(path.join(moduleDir, '../eval/samples.json'), 'utf8'));
  const sampleFile = path.join(f.root, 'gate-samples.json');
  await fs.writeFile(sampleFile, JSON.stringify({ ...samples, thresholds }));
  return { WAG_EVAL_SAMPLES: sampleFile };
}

function toolError(response, message, kind = 'fixture') {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ error: { kind, message: 'offline gate fixture failure' } }) }], isError: true } }));
  return true;
}

test('connectivity-only command exits nonzero even when configured gates permit degradation', async t => {
  const f = await passingFixture(t, (_request, response, message) => message?.params?.name === 'web_search' ? toolError(response, message) : false);
  const config = await samplesWithThresholds(f, { success_rate_pct: 90, quality_rate_pct: 90 });
  const { report } = await runEvaluator(t, f, config);
  assert.equal(report.status, 'degraded');
  assert.deepEqual(report.failing_gates, []);
  assert.deepEqual(report.reasons, [{ gate: 'connectivity', reason: 'non_passing_cases', case_ids: ['search-public'] }]);
  assert.equal(report.thresholds.success_rate_pct, 90);
});

test('a recovered connectivity deadline still breaches the configured command timeout gate', async t => {
  let searchCalls = 0;
  const f = await passingFixture(t, (_request, response, message) => {
    if (message?.params?.name !== 'web_search' || ++searchCalls !== 1) return false;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: { kind: 'egress_timeout', message: 'origin timed out' } }) }] } }));
    return true;
  });
  const { report } = await runEvaluator(t, f, await samplesWithThresholds(f, { timeout_rate_pct: 2 }));
  const recovered = report.cases.find(item => item.id === 'search-public');
  assert.equal(recovered.status, 'passed');
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.first_error, 'origin timed out');
  assert.equal(recovered.attempt_outcomes[0].error.kind, 'egress_timeout');
  assert.equal(report.summary.success_rate_pct, 100);
  assert.equal(report.summary.timeout_cases, 1);
  assert.equal(report.gates.timeout_rate_pct.value, 12.5);
  assert.deepEqual(report.failing_gates, ['timeout_rate_pct']);
});

test('release command rejects concurrency based on a failed static-read baseline', async t => {
  let staticReads = 0;
  const f = await passingFixture(t, (_request, response, message) => {
    const args = message?.params?.arguments;
    if (message?.params?.name === 'web_read' && args.render === 'never' && args.url === 'https://example.com/') {
      staticReads++;
      if (staticReads === 1) return toolError(response, message);
    }
    return false;
  });
  const config = await samplesWithThresholds(f, { success_rate_pct: 0, quality_rate_pct: 0, concurrency_degradation_pct: 100000 });
  const { report } = await runEvaluator(t, f, config, [], 1, 'release');
  assert.equal(report.status, 'failed');
  assert.equal(report.gates.concurrency_degradation_pct.reason, 'invalid_baseline');
  assert.equal(report.cases.find(item => item.id === 'concurrency-two').status, 'failed');
  assert.equal(report.cases.find(item => item.id === 'concurrency-two').error.kind, 'invalid_baseline');
});

for (const [name, thresholds, failureKind, expectedGate] of [
  ['default smoke success', undefined, 'fixture', 'success_rate_pct'],
  ['independent quality', { success_rate_pct: 0, quality_rate_pct: 100 }, 'fixture', 'quality_rate_pct'],
  ['operational timeout', { success_rate_pct: 0, quality_rate_pct: 0, timeout_rate_pct: 2 }, 'egress_timeout', 'timeout_rate_pct'],
  ['invalid required threshold', { quality_rate_pct: null }, null, 'quality_rate_pct'],
]) test(`command fails ${name} gate with retained reasons`, async t => {
  const f = await passingFixture(t, (_request, response, message) => failureKind && message?.params?.name === 'web_search' ? toolError(response, message, failureKind) : false);
  const config = thresholds ? await samplesWithThresholds(f, thresholds) : {};
  const { report } = await runEvaluator(t, f, config);
  assert.equal(report.status, 'failed');
  assert.ok(report.failing_gates.includes(expectedGate));
  assert.ok(report.reasons.some(item => item.gate === expectedGate));
  assert.equal(report.lifecycle.completed, true);
});

test('core failure overrides permissive aggregate command thresholds', async t => {
  const f = await passingFixture(t, (request, response) => {
    if (request.url !== '/readyz') return false;
    response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, dependencies: [] }));
    return true;
  });
  const { report } = await runEvaluator(t, f, await samplesWithThresholds(f, { success_rate_pct: 0, quality_rate_pct: 0 }));
  assert.equal(report.status, 'failed');
  assert.ok(report.failing_gates.includes('core_cases'));
  assert.deepEqual(report.gates.core_cases.case_ids, ['gateway-ready']);
});

for (const [threshold, code] of [[100, 0], [99.99, 1]]) test(`release command enforces concurrency boundary ${threshold}% with a controlled clock`, async t => {
  const f = await passingFixture(t);
  const clock = path.join(f.root, 'clock.mjs');
  // Advance elapsed time on real tool-response completion, never on clock reads:
  // Node HTTP instrumentation also reads performance.now(), with OS/timing-dependent
  // frequency. Each solo call takes 10ms; the pair takes 20ms (100% degradation).
  // Real requests, outcomes, gates, report publication and exits remain intact.
  await fs.writeFile(clock, `let tick = 0;
Object.defineProperty(performance, 'now', { value: () => tick });
const fetch = globalThis.fetch;
let baselineObserved = false;
globalThis.fetch = async (url, init) => {
  const response = await fetch(url, init);
  const message = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
  if (message?.method === 'tools/call') tick += 10;
  if (!baselineObserved && message?.method === 'tools/call' && message.params.name === 'web_read'
      && message.params.arguments.render === 'never' && message.params.arguments.url === 'https://example.com/') {
    baselineObserved = true;
    // HTTP instrumentation is also allowed to read the shared performance clock.
    performance.now(); performance.now();
  }
  return response;
};
`);
  const config = await samplesWithThresholds(f, { concurrency_degradation_pct: threshold });
  const { report } = await runEvaluator(t, f, config, ['--import', pathToFileURL(clock).href], code, 'release');
  assert.equal(report.cases.find(item => item.id === 'concurrency-two').metrics.degradation_pct, 100);
  assert.equal(report.gates.concurrency_degradation_pct.passed, code === 0);
  assert.equal(report.status, code === 0 ? 'passed' : 'failed');
});

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

for (const mode of ['stalled', 'failed']) test(`${mode} client close cannot prevent transport teardown or failure reporting`, async t => {
  const f = await fixture(t);
  const preload = path.join(f.root, 'client-close.mjs');
  const sdkClient = pathToFileURL(path.join(moduleDir, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js')).href;
  await fs.writeFile(preload, `import { Client } from ${JSON.stringify(sdkClient)};
Client.prototype.close = async () => { ${mode === 'stalled' ? 'await new Promise(() => {});' : "throw new Error('fixture client close failed');"} };
`);
  const { report } = await runEvaluator(t, f, {}, ['--import', pathToFileURL(preload).href]);
  assert.equal(report?.status, 'failed');
  assert.ok(report?.lifecycle?.cleanup_errors.some(error => mode === 'stalled' ? error.kind === 'lifecycle_timeout' : error.message === 'fixture client close failed'));
  assert.ok(f.requests.some(request => request.method === 'DELETE'));
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

test('case diagnostics redact a credential crossing the truncation boundary before publication', async t => {
  const credential = 'SYNTHETIC_GW_CREDENTIAL_'.padEnd(64, 'z');
  const f = await passingFixture(t, (_request, response, message) => {
    if (message?.params?.name !== 'web_search') return false;
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({
        error: { kind: 'fixture', message: `${'x'.repeat(480)}${credential}` },
      }) }] },
    }));
    return true;
  });
  const { report, stderr } = await runEvaluator(t, f, { GATEWAY_TOKEN: credential });
  const search = report.cases.find(item => item.id === 'search-public');
  assert.equal(search.status, 'failed');
  assert.match(search.error.message, /\[redacted\]/);
  assert.ok(search.error.message.length <= 500);
  assert.ok(!(JSON.stringify(report) + stderr).includes(credential.slice(0, 20)));
});

test('fatal setup failures produce failed reports before connecting', async t => {
  const f = await fixture(t);
  const { report } = await runEvaluator(t, f, { WAG_EVAL_SAMPLES: path.join(f.root, 'missing-samples.json') });
  assert.equal(report?.status, 'failed');
  assert.equal(report?.lifecycle?.completed, false);
  assert.match(report?.lifecycle?.error?.message ?? '', /ENOENT/);
  assert.equal(f.requests.length, 0);
});
