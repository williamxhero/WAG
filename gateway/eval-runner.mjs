import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dimensionSummaries, evaluateGates, isEvaluationReportFileName, latestSnapshotText, REPORT_VERSION, safeArtifactId, summarizeCases, toolSummaries } from './eval-core.mjs';
import { evaluateCase } from './eval-case.mjs';

const root = process.env.WAG_ROOT ?? '/data/web-access-gateway';
const suite = process.argv[2] === 'release' ? 'release' : 'smoke';
const startedAt = new Date();
const stamp = startedAt.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
const runId = `${suite}-${stamp}`;
const reportDirectory = path.join(root, 'reports');
const samplePath = process.env.WAG_EVAL_SAMPLES ?? path.join(root, 'eval', 'samples.json');
const gatewayUrl = process.env.GATEWAY_EVAL_URL ?? `http://yosef-server:${process.env.GATEWAY_PORT ?? '8930'}/mcp`;
const token = process.env.GATEWAY_TOKEN ?? '';
// Gateway operations allow 30s egress and 90s rendering/queueing; retain a
// bounded 5s evaluator overhead rather than relying on the SDK's defaults.
const connectionBudgetMs = 30000 + 5000;
const operationBudgetMs = 30000 + 90000 + 5000;
const cleanupBudgetMs = 1000;
const reportBudgetMs = 1000;
const defaultDeadlineMs = connectionBudgetMs + ((suite === 'release' ? 15 : 11) * operationBudgetMs + 2 * operationBudgetMs) * 3;
const now = () => performance.now();
const lifecycle = createLifecycle();

function deadlineError(label) {
  return Object.assign(new Error(`${label} deadline exceeded`), { kind: 'lifecycle_timeout' });
}
function createLifecycle() {
  const configured = Number(process.env.WAG_EVAL_DEADLINE_MS ?? defaultDeadlineMs);
  const budgetMs = Number.isSafeInteger(configured) && configured > 0 && configured <= defaultDeadlineMs ? configured : defaultDeadlineMs;
  const controller = new AbortController();
  const connections = [];
  const browserSessions = new Set();
  const timer = setTimeout(() => controller.abort(deadlineError('evaluation')), budgetMs);
  // Abort/close normally lets Node exit naturally. Non-cancellable native I/O
  // or a broken transport must not hold a scheduled evaluator open forever.
  // This unref'ed last resort never keeps an otherwise cleaned-up run alive.
  setTimeout(() => {
    console.error('Evaluation termination guard expired after bounded cleanup/report attempts');
    process.exit(1);
  }, budgetMs + cleanupBudgetMs + reportBudgetMs + 250).unref();
  return {
    budgetMs, controller, connections, browserSessions, networkSignal: controller.signal,
    async run(label, operation, timeoutMs = operationBudgetMs, signal = controller.signal) {
      signal?.throwIfAborted();
      const scope = new AbortController();
      const abort = () => scope.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => scope.abort(deadlineError(label)), timeoutMs);
      let rejectAbort;
      const aborted = new Promise((_, reject) => {
        rejectAbort = () => reject(scope.signal.reason);
        scope.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      try { return await Promise.race([Promise.resolve().then(() => { scope.signal.throwIfAborted(); return operation(scope.signal); }), aborted]); }
      finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        scope.signal.removeEventListener('abort', rejectAbort);
      }
    },
    stop() { clearTimeout(timer); controller.abort(deadlineError('evaluation finished')); },
  };
}
const elapsed = started => Math.round(now() - started);
const exec = (command, args) => new Promise(resolve => execFile(command, args, { timeout: 5000, signal: lifecycle.controller.signal }, (error, stdout) => resolve(error ? '' : stdout.trim())));

function parseToolResult(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  try { return JSON.parse(text); } catch { return { raw_text: text }; }
}
function errorInfo(error) {
  let message = String(error?.message ?? error ?? 'unknown failure');
  if (token) message = message.replaceAll(token, '[redacted]');
  message = message.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [redacted]').replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[redacted]@');
  return { kind: error?.kind ?? (/timeout|timed out|abort/i.test(message) ? 'timeout' : /unauthorized|401/i.test(message) ? 'authentication' : 'request'), message: message.slice(0, 500) };
}
function assertQuality(checks) {
  const normalized = checks.map(check => ({ ...check, passed: Boolean(check.passed) }));
  return { passed: normalized.every(check => check.passed), checks: normalized };
}
function evidenceChecks(value) {
  const retrieved = value?.temporal_evidence?.find(item => item.kind === 'retrieved_at');
  const published = value?.temporal_evidence?.find(item => item.kind === 'published_at');
  return [
    { name: 'source-url-and-host', passed: value?.source?.url === value?.url && Boolean(value?.source?.host) },
    { name: 'retrieval-provenance', passed: Boolean(value?.retrieved_at) && retrieved?.value === value.retrieved_at && retrieved?.source === 'gateway.clock' },
    { name: 'publication-provenance', passed: (!value?.published_at && !value?.published_on) || (published?.on === (value.published_on ?? value.published_at?.slice(0, 10)) && !['gateway.clock', 'http.header.date'].includes(published?.source) && String(value?.markdown ?? '').includes(value.published_at ?? value.published_on)) },
    { name: 'response-metadata', passed: value?.http_status >= 200 && value?.http_status < 300 && Boolean(value?.content_type) && Number(value?.bytes) > 0 && /^[a-f0-9]{64}$/.test(value?.content_hash ?? '') },
  ];
}
function artifactFrom(payload, name, caseId) {
  const candidate = payload?.artifact ?? payload?.outputs?.flatMap(item => [item?.artifact]).find(Boolean);
  if (!candidate || !safeArtifactId(candidate.id)) return null;
  return { name: `${caseId}-${name}`, artifact_id: candidate.id, bytes: candidate.bytes ?? null, type: name === 'pdf' ? 'application/pdf' : 'image/png' };
}
async function resourceSnapshot() {
  const services = ['web-access-gateway.service', 'web-access-playwright.service', 'web-access-crawl4ai.service', 'web-access-egress-proxy.service'];
  const records = await Promise.all(services.map(async service => {
    const output = await exec('systemctl', ['show', service, '--property=MemoryCurrent,CPUUsageNSec,TasksCurrent,NRestarts', '--value']);
    const [memory, cpu, tasks, restarts] = output.split('\n');
    return { service, memory_bytes: Number(memory) || null, cpu_usage_ns: Number(cpu) || null, tasks: Number(tasks) || null, restarts: Number(restarts) || 0 };
  }));
  return Object.fromEntries(records.map(record => [record.service, record]));
}
function peakResources(samples) {
  const peak = {};
  for (const sample of samples) for (const [service, values] of Object.entries(sample)) {
    const current = peak[service] ?? { service, memory_bytes: null, cpu_usage_ns: null, tasks: null };
    peak[service] = {
      service,
      memory_bytes: Math.max(current.memory_bytes ?? 0, values.memory_bytes ?? 0) || null,
      cpu_usage_ns: Math.max(current.cpu_usage_ns ?? 0, values.cpu_usage_ns ?? 0) || null,
      tasks: Math.max(current.tasks ?? 0, values.tasks ?? 0) || null,
      restarts: Math.max(current.restarts ?? 0, values.restarts ?? 0),
    };
  }
  return peak;
}
async function pruneExpiredReports(directory) {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  await Promise.all(entries.filter(entry => entry.isFile() && isEvaluationReportFileName(entry.name)).map(async entry => {
    const target = path.join(directory, entry.name);
    const stat = await fs.stat(target);
    if (stat.mtimeMs < cutoff) await fs.unlink(target);
  }));
}
async function createClient() {
  const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([init.signal, lifecycle.networkSignal].filter(Boolean)) }),
  });
  const client = new Client({ name: 'web-access-gateway-evaluator', version: '1.0.0' });
  // Own the pair before initialization, so failed/partial connects are closed.
  lifecycle.connections.push({ client, transport });
  await lifecycle.run('gateway connection', signal => client.connect(transport, { signal, timeout: connectionBudgetMs }), connectionBudgetMs);
  return { client, transport };
}
async function terminateMcpSession(transport, signal) {
  if (!transport.sessionId) return;
  // The SDK closes its transport when initialize validation fails. Use a
  // cleanup-only transport so that its already-aborted signal cannot prevent
  // terminating a server session allocated by a partial initialization.
  const cleanupTransport = new StreamableHTTPClientTransport(new URL(gatewayUrl), {
    sessionId: transport.sessionId,
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([signal, init.signal].filter(Boolean)) }),
  });
  if (transport.protocolVersion) cleanupTransport.setProtocolVersion(transport.protocolVersion);
  try { await cleanupTransport.start(); await cleanupTransport.terminateSession(); }
  finally { await cleanupTransport.close(); }
}
function fetchEvaluation(url, init = {}) {
  lifecycle.controller.signal.throwIfAborted();
  return fetch(url, { ...init, signal: AbortSignal.any([lifecycle.controller.signal, AbortSignal.timeout(10000)]) });
}
async function requestTool(client, name, args, signal = lifecycle.controller.signal, timeoutMs = operationBudgetMs) {
  return lifecycle.run(`tool ${name}`, requestSignal => client.callTool({ name, arguments: args }, undefined, { signal: requestSignal, timeout: timeoutMs }), timeoutMs, signal);
}
async function closeBrowserSession(client, sessionId, signal = lifecycle.controller.signal, timeoutMs = cleanupBudgetMs) {
  const closed = await callTool(client, 'web_browser', { session_id: sessionId, actions: [{ type: 'close' }] }, signal, timeoutMs);
  if (closed.payload.closed !== true) throw new Error('browser session close was not acknowledged');
  lifecycle.browserSessions.delete(sessionId);
  return closed;
}
async function callTool(client, name, args, signal = lifecycle.controller.signal, timeoutMs = operationBudgetMs) {
  const start = now();
  const result = await requestTool(client, name, args, signal, timeoutMs);
  const totalMs = elapsed(start);
  const payload = parseToolResult(result);
  // A failed browser action can still expose the session it allocated.
  if (name === 'web_browser' && typeof payload.session_id === 'string') lifecycle.browserSessions.add(payload.session_id);
  if (result.isError) {
    const error = new Error(payload.error?.message ?? payload.raw_text ?? 'MCP tool returned an error');
    error.payload = payload;
    error.kind = payload.error?.kind;
    error.httpStatus = payload.http_status;
    throw error;
  }
  const telemetry = payload.telemetry ?? {};
  return { payload, total_ms: totalMs, first_valid_result_ms: telemetry.first_valid_result_ms ?? totalMs, stages_ms: { mcp_round_trip_ms: totalMs, ...(telemetry.stages_ms ?? {}) } };
}
async function runCase(cases, artifacts, definition) {
  lifecycle.controller.signal.throwIfAborted();
  const record = await evaluateCase({
    ...definition,
    run: async () => {
      lifecycle.controller.signal.throwIfAborted();
      const outcome = await lifecycle.run(`case ${definition.id}`, () => definition.run(), definition.category === 'browser' ? 3 * operationBudgetMs : operationBudgetMs);
      lifecycle.controller.signal.throwIfAborted();
      return outcome;
    },
  });
  // The outcome evaluator records failures; lifecycle cancellation must still
  // stop the command rather than allowing later cases or a partial pass.
  lifecycle.controller.signal.throwIfAborted();
  if (record.error) record.error.message = errorInfo(record.error).message;
  if (record.first_error) record.first_error = errorInfo(record.first_error).message;
  if (record.artifact) { artifacts.push(record.artifact); record.artifact = record.artifact.name; }
  cases.push(record);
}
async function main() {
  const cases = []; const artifacts = []; const resourceSamples = [];
  let resourceStart = {}; let resourceEnd = {}; let resourceTimer;
  let completed = false; let failure; let thresholds;
  const expectedCaseIds = ['search-public', 'read-static', 'read-rendered', 'browser-snapshot-click', 'read-screenshot', 'read-pdf', 'gateway-health', 'gateway-ready', 'eval-api-auth', 'auth-required', 'ssrf-loopback', ...(suite === 'release' ? ['concurrency-two', 'ssrf-redirect'] : [])];
  const cleanupErrors = [];
  try {
    await lifecycle.run('evaluation', async () => {
      if (token.length < 32) throw new Error('GATEWAY_TOKEN is required for evaluation');
      const samples = JSON.parse(await fs.readFile(samplePath, { encoding: 'utf8', signal: lifecycle.controller.signal }));
      if (Object.hasOwn(samples, 'thresholds') && (!samples.thresholds || typeof samples.thresholds !== 'object' || Array.isArray(samples.thresholds))) throw new Error('evaluation thresholds must be an object');
      thresholds = samples.thresholds;
      lifecycle.controller.signal.throwIfAborted();
      resourceStart = await resourceSnapshot(); resourceSamples.push(resourceStart);
      lifecycle.controller.signal.throwIfAborted();
      let polling = false;
      resourceTimer = setInterval(() => {
        if (polling || lifecycle.controller.signal.aborted) return;
        polling = true;
        resourceSnapshot().then(snapshot => resourceSamples.push(snapshot)).catch(() => {}).finally(() => { polling = false; });
      }, 1000);
      const { client } = await createClient();
    await runCase(cases, artifacts, { id: 'search-public', name: 'Public search returns results', category: 'search', dimension: 'connectivity', retry: true, retryQuality: true, tool: 'web_search', run: () => callTool(client, 'web_search', { query: samples.search.query }), quality: payload => assertQuality([{ name: 'has-results', passed: Array.isArray(payload.results) && payload.results.length > 0 }, { name: 'expected-domain', passed: (payload.results ?? []).some(item => String(item.url ?? '').includes(samples.search.expected_domain)) }, { name: 'search-provenance', passed: (payload.results ?? []).length > 0 && payload.results.every(item => item.source?.url === item.url && Boolean(item.source?.host) && Boolean(item.retrieved_at) && item.temporal_evidence?.some(record => record.kind === 'retrieved_at' && record.value === item.retrieved_at && record.source === 'gateway.clock')) }]) });
    await runCase(cases, artifacts, { id: 'read-static', name: 'Static page extraction', category: 'read', dimension: 'connectivity', retry: true, tool: 'web_read', run: () => callTool(client, 'web_read', { url: samples.static.url, render: 'never', output: 'markdown' }), quality: payload => assertQuality([{ name: 'expected-title', passed: String(payload.title ?? '').includes(samples.static.expected_text) }, { name: 'minimum-body', passed: String(payload.markdown ?? '').length >= 40 }, ...evidenceChecks(payload)]) });
    await runCase(cases, artifacts, { id: 'read-rendered', name: 'JavaScript-rendered page extraction', category: 'render', dimension: 'connectivity', retry: true, tool: 'web_read', run: () => callTool(client, 'web_read', { url: samples.render.url, render: 'always', output: 'markdown' }), quality: payload => assertQuality([{ name: 'expected-text', passed: String(payload.markdown ?? '').includes(samples.render.expected_text) }, ...evidenceChecks(payload)]) });
    await runCase(cases, artifacts, { id: 'browser-snapshot-click', name: 'Browser snapshot and safe link click', category: 'browser', dimension: 'connectivity', retry: true, tool: 'web_browser', run: async () => {
      const initial = await callTool(client, 'web_browser', { actions: [{ type: 'navigate', url: samples.browser.url }, { type: 'snapshot' }] });
      const sessionId = initial.payload.session_id;
      if (sessionId) lifecycle.browserSessions.add(sessionId);
      try {
        const snapshot = latestSnapshotText(initial.payload.outputs);
        const ref = /\blink\b[^\n]*\[ref=([^\]]+)\]/i.exec(snapshot)?.[1]
          ?? /\[ref=([^\]]+)\][^\n]*\blink\b/i.exec(snapshot)?.[1];
        if (!ref || !sessionId) throw new Error('browser snapshot did not expose a link reference');
        const clicked = await callTool(client, 'web_browser', { session_id: sessionId, actions: [{ type: 'click', ref, element: 'link' }, { type: 'snapshot' }] });
        const closed = await closeBrowserSession(client, sessionId);
        return { payload: { initial: initial.payload, clicked: clicked.payload, closed: closed.payload.closed === true }, total_ms: initial.total_ms + clicked.total_ms + closed.total_ms, first_valid_result_ms: initial.first_valid_result_ms, stages_ms: { navigate_snapshot_ms: initial.total_ms, click_snapshot_ms: clicked.total_ms, close_ms: closed.total_ms } };
      } finally {
        if (sessionId && lifecycle.browserSessions.has(sessionId) && !lifecycle.controller.signal.aborted) {
          await closeBrowserSession(client, sessionId).catch(error => cleanupErrors.push(errorInfo(error)));
        }
      }
    }, quality: payload => assertQuality([{ name: 'snapshot-and-click-completed', passed: payload.clicked?.outputs?.length > 0 }, { name: 'browser-evidence', passed: Boolean(payload.initial?.url && payload.initial?.source?.host && payload.initial?.retrieved_at && payload.initial?.temporal_evidence?.some(record => record.kind === 'retrieved_at')) }, { name: 'session-closed', passed: payload.closed === true }]) });
    for (const output of ['screenshot', 'pdf']) await runCase(cases, artifacts, { id: `read-${output}`, name: `Rendered ${output}`, category: 'artifact', dimension: 'connectivity', retry: true, tool: 'web_read', run: async () => { const result = await callTool(client, 'web_read', { url: samples.static.url, render: 'always', output }); const artifact = artifactFrom(result.payload, output, `read-${output}`); if (!artifact) throw new Error(`missing ${output} artifact`); return { ...result, artifact }; }, quality: (_payload, outcome) => assertQuality([{ name: 'non-empty-artifact', passed: Number(outcome.artifact?.bytes) > 100 }]) });
    await runCase(cases, artifacts, { id: 'gateway-health', name: 'Authenticated gateway health', category: 'health', tool: 'health', run: async () => { const start = now(); const response = await fetchEvaluation(gatewayUrl.replace('/mcp', '/healthz'), { headers: { authorization: `Bearer ${token}` } }); const totalMs = elapsed(start); return { payload: { status: response.status }, total_ms: totalMs, first_valid_result_ms: totalMs, stages_ms: { http_ms: totalMs } }; }, quality: payload => assertQuality([{ name: 'returns-200', passed: payload.status === 200 }]) });
    await runCase(cases, artifacts, { id: 'gateway-ready', name: 'Dependency readiness', category: 'health', tool: 'ready', run: async () => { const start = now(); const response = await fetchEvaluation(gatewayUrl.replace('/mcp', '/readyz'), { headers: { authorization: `Bearer ${token}` } }); const body = await response.json(); const totalMs = elapsed(start); return { payload: { status: response.status, body }, total_ms: totalMs, first_valid_result_ms: totalMs, stages_ms: { http_ms: totalMs } }; }, quality: payload => assertQuality([{ name: 'returns-200', passed: payload.status === 200 }, { name: 'all-dependencies-ready', passed: payload.body?.ok === true && (payload.body.dependencies ?? []).every(item => item.ok === true) }]) });
    await runCase(cases, artifacts, { id: 'eval-api-auth', name: 'Evaluation API rejects missing token', category: 'security', expectation: 'expected_security', expected_outcome: { http_status: 401 }, tool: 'authentication', run: async () => { const start = now(); const response = await fetchEvaluation(gatewayUrl.replace('/mcp', '/api/evals')); const totalMs = elapsed(start); return { payload: { status: response.status }, total_ms: totalMs, first_valid_result_ms: totalMs, stages_ms: { http_ms: totalMs } }; } });
    await runCase(cases, artifacts, { id: 'auth-required', name: 'Health endpoint rejects missing token', category: 'security', expectation: 'expected_security', expected_outcome: { http_status: 401 }, tool: 'authentication', run: async () => { const start = now(); const response = await fetchEvaluation(gatewayUrl.replace('/mcp', '/healthz')); const totalMs = elapsed(start); return { payload: { status: response.status }, total_ms: totalMs, first_valid_result_ms: totalMs, stages_ms: { http_ms: totalMs } }; } });
    await runCase(cases, artifacts, { id: 'ssrf-loopback', name: 'Loopback URL is rejected', category: 'security', expectation: 'expected_security', expected_outcome: { kinds: ['ssrf_blocked'], blocked_reason: 'non_public_address' }, tool: 'web_read', run: () => callTool(client, 'web_read', { url: samples.security.loopback_url, render: 'never', output: 'markdown' }) });
    if (suite === 'release') {
      const baseline = cases.find(item => item.id === 'read-static');
      await runCase(cases, artifacts, { id: 'concurrency-two', name: 'Two concurrent reads', category: 'concurrency', tool: 'web_read', run: async () => {
        if (baseline?.status !== 'passed' || !Number.isFinite(baseline.total_ms) || baseline.total_ms <= 0) throw Object.assign(new Error('concurrency requires a successful measured static-read baseline'), { kind: 'invalid_baseline' });
        const start = now();
        const [a, b] = await Promise.all([callTool(client, 'web_read', { url: samples.static.url, render: 'never', output: 'markdown' }), callTool(client, 'web_read', { url: samples.static.url, render: 'never', output: 'markdown' })]);
        const totalMs = elapsed(start);
        const degradation = (Math.max(a.total_ms, b.total_ms) / baseline.total_ms - 1) * 100;
        return { payload: { both_completed: true }, metrics: { degradation_pct: degradation, baseline_ms: baseline.total_ms, queue_ms: Math.max(0, totalMs - Math.max(a.total_ms, b.total_ms)) }, total_ms: totalMs, first_valid_result_ms: Math.min(a.first_valid_result_ms, b.first_valid_result_ms), stages_ms: { parallel_wall_ms: totalMs, request_a_ms: a.total_ms, request_b_ms: b.total_ms } };
      }, quality: payload => assertQuality([{ name: 'both-completed', passed: payload.both_completed === true }]) });
      await runCase(cases, artifacts, { id: 'ssrf-redirect', name: 'Private redirect target is rejected', category: 'security', expectation: 'expected_security', expected_outcome: { kinds: ['ssrf_blocked'], blocked_reason: 'non_public_address' }, tool: 'web_read', run: () => callTool(client, 'web_read', { url: samples.security.redirect_to_loopback_url, render: 'never', output: 'markdown' }) });
      // Deadline proof is the offline controlled-origin gateway fixture, not a
      // public delay endpoint whose JSON response can fail on content type.
    }
      lifecycle.controller.signal.throwIfAborted();
      resourceEnd = await resourceSnapshot(); resourceSamples.push(resourceEnd);
      lifecycle.controller.signal.throwIfAborted();
      completed = true;
    }, lifecycle.budgetMs);
  } catch (error) {
    failure = errorInfo(error);
    console.error(`Evaluation failed: ${failure.kind}: ${failure.message}`);
  } finally {
    clearInterval(resourceTimer);
    lifecycle.stop();
    await lifecycle.run('cleanup', async signal => {
      lifecycle.networkSignal = signal;
      try {
        const client = lifecycle.connections[0]?.client;
        // Reserve half of cleanup for MCP termination even if browser close stalls.
        if (client) await Promise.all([...lifecycle.browserSessions].map(sessionId => closeBrowserSession(client, sessionId, signal, cleanupBudgetMs / 2).catch(error => cleanupErrors.push(errorInfo(error)))));
        signal.throwIfAborted();
        await Promise.all(lifecycle.connections.map(({ transport }) => terminateMcpSession(transport, signal).catch(error => cleanupErrors.push(errorInfo(error)))));
      } finally {
        await Promise.all(lifecycle.connections.flatMap(({ client, transport }) => [
          client.close().catch(error => cleanupErrors.push(errorInfo(error))),
          transport.close().catch(error => cleanupErrors.push(errorInfo(error))),
        ]));
      }
    }, cleanupBudgetMs, null).catch(error => cleanupErrors.push(errorInfo(error)));
  }
  const completedAt = new Date(); const summary = summarizeCases(cases);
  const policy = evaluateGates(cases, { suite, thresholds, complete: completed && !failure && cleanupErrors.length === 0, expected_case_ids: expectedCaseIds });
  const proxyRestartsStart = resourceStart['web-access-egress-proxy.service']?.restarts ?? 0;
  const proxyRestartsEnd = resourceEnd['web-access-egress-proxy.service']?.restarts ?? 0;
  const report = { schema_version: REPORT_VERSION, id: runId, suite, started_at: startedAt.toISOString(), completed_at: completedAt.toISOString(), duration_ms: completedAt - startedAt, ...policy, thresholds_source: 'report', lifecycle: { completed, deadline_ms: lifecycle.budgetMs, cleanup_tolerance_ms: cleanupBudgetMs, report_tolerance_ms: reportBudgetMs, ...(failure ? { error: failure } : {}), cleanup_errors: cleanupErrors }, summary, dimensions: dimensionSummaries(cases), tools: toolSummaries(cases), cases, artifacts, resources: { start: resourceStart, end: resourceEnd, peak: peakResources(resourceSamples), sample_count: resourceSamples.length, proxy_restart_increase: Math.max(0, proxyRestartsEnd - proxyRestartsStart) } };
  if (report.status !== 'passed') process.exitCode = 1;
  const reportPath = path.join(reportDirectory, `${runId}.json`); const temporaryPath = `${reportPath}.${crypto.randomUUID()}.tmp`;
  try {
    await lifecycle.run('report publication', async signal => {
      await fs.mkdir(reportDirectory, { recursive: true, mode: 0o750 });
      signal.throwIfAborted();
      await pruneExpiredReports(reportDirectory);
      signal.throwIfAborted();
      await fs.writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o640, signal });
      signal.throwIfAborted();
      await fs.chmod(temporaryPath, 0o644);
      signal.throwIfAborted();
      await fs.rename(temporaryPath, reportPath);
    }, reportBudgetMs - 250, null);
    console.log(reportPath);
  } catch (error) {
    process.exitCode = 1;
    const diagnostic = errorInfo(error);
    console.error(`Report publication failed: ${diagnostic.kind}: ${diagnostic.message}`);
    await lifecycle.run('temporary report cleanup', () => fs.unlink(temporaryPath).catch(() => {}), 250, null).catch(() => {});
  }
}
main().catch(error => { lifecycle.stop(); const diagnostic = errorInfo(error); console.error(`Evaluation failed: ${diagnostic.kind}: ${diagnostic.message}`); process.exitCode = 1; });
