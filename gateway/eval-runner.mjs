import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { dimensionSummaries, evaluationStatus, isEvaluationReportFileName, latestSnapshotText, REPORT_VERSION, safeArtifactId, summarizeCases, toolSummaries } from './eval-core.mjs';
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
if (token.length < 32) throw new Error('GATEWAY_TOKEN is required for evaluation');

const now = () => performance.now();
const elapsed = started => Math.round(now() - started);
const exec = (command, args) => new Promise(resolve => execFile(command, args, { timeout: 5000 }, (error, stdout) => resolve(error ? '' : stdout.trim())));

function parseToolResult(result) {
  if (result.structuredContent) return result.structuredContent;
  const text = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  try { return JSON.parse(text); } catch { return { raw_text: text }; }
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
  const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'web-access-gateway-evaluator', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}
async function callTool(client, name, args) {
  const start = now();
  const result = await client.callTool({ name, arguments: args });
  const totalMs = elapsed(start);
  const payload = parseToolResult(result);
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
  const record = await evaluateCase(definition);
  if (record.artifact) { artifacts.push(record.artifact); record.artifact = record.artifact.name; }
  cases.push(record);
}
async function main() {
  const samples = JSON.parse(await fs.readFile(samplePath, 'utf8'));
  const cases = []; const artifacts = []; const resourceStart = await resourceSnapshot(); const resourceSamples = [resourceStart];
  const resourceTimer = setInterval(() => resourceSnapshot().then(snapshot => resourceSamples.push(snapshot)).catch(() => {}), 1000);
  const { client, transport } = await createClient();
  try {
    await runCase(cases, artifacts, { id: 'search-public', name: 'Public search returns results', category: 'search', dimension: 'connectivity', retry: true, retryQuality: true, tool: 'web_search', run: () => callTool(client, 'web_search', { query: samples.search.query }), quality: payload => assertQuality([{ name: 'has-results', passed: Array.isArray(payload.results) && payload.results.length > 0 }, { name: 'expected-domain', passed: (payload.results ?? []).some(item => String(item.url ?? '').includes(samples.search.expected_domain)) }, { name: 'search-provenance', passed: (payload.results ?? []).length > 0 && payload.results.every(item => item.source?.url === item.url && Boolean(item.source?.host) && Boolean(item.retrieved_at) && item.temporal_evidence?.some(record => record.kind === 'retrieved_at' && record.value === item.retrieved_at && record.source === 'gateway.clock')) }]) });
    await runCase(cases, artifacts, { id: 'read-static', name: 'Static page extraction', category: 'read', dimension: 'connectivity', retry: true, tool: 'web_read', run: () => callTool(client, 'web_read', { url: samples.static.url, render: 'never', output: 'markdown' }), quality: payload => assertQuality([{ name: 'expected-title', passed: String(payload.title ?? '').includes(samples.static.expected_text) }, { name: 'minimum-body', passed: String(payload.markdown ?? '').length >= 40 }, ...evidenceChecks(payload)]) });
    await runCase(cases, artifacts, { id: 'read-rendered', name: 'JavaScript-rendered page extraction', category: 'render', dimension: 'connectivity', retry: true, tool: 'web_read', run: () => callTool(client, 'web_read', { url: samples.render.url, render: 'always', output: 'markdown' }), quality: payload => assertQuality([{ name: 'expected-text', passed: String(payload.markdown ?? '').includes(samples.render.expected_text) }, ...evidenceChecks(payload)]) });
    await runCase(cases, artifacts, { id: 'browser-snapshot-click', name: 'Browser snapshot and safe link click', category: 'browser', dimension: 'connectivity', retry: true, tool: 'web_browser', run: async () => {
      const initial = await callTool(client, 'web_browser', { actions: [{ type: 'navigate', url: samples.browser.url }, { type: 'snapshot' }] });
      const snapshot = latestSnapshotText(initial.payload.outputs);
      const ref = /\blink\b[^\n]*\[ref=([^\]]+)\]/i.exec(snapshot)?.[1]
        ?? /\[ref=([^\]]+)\][^\n]*\blink\b/i.exec(snapshot)?.[1];
      if (!ref || !initial.payload.session_id) throw new Error('browser snapshot did not expose a link reference');
      const clicked = await callTool(client, 'web_browser', { session_id: initial.payload.session_id, actions: [{ type: 'click', ref, element: 'link' }, { type: 'snapshot' }] });
      const closed = await callTool(client, 'web_browser', { session_id: initial.payload.session_id, actions: [{ type: 'close' }] });
      return { payload: { initial: initial.payload, clicked: clicked.payload, closed: closed.payload.closed === true }, total_ms: initial.total_ms + clicked.total_ms + closed.total_ms, first_valid_result_ms: initial.first_valid_result_ms, stages_ms: { navigate_snapshot_ms: initial.total_ms, click_snapshot_ms: clicked.total_ms, close_ms: closed.total_ms } };
    }, quality: payload => assertQuality([{ name: 'snapshot-and-click-completed', passed: payload.clicked?.outputs?.length > 0 }, { name: 'browser-evidence', passed: Boolean(payload.initial?.url && payload.initial?.source?.host && payload.initial?.retrieved_at && payload.initial?.temporal_evidence?.some(record => record.kind === 'retrieved_at')) }, { name: 'session-closed', passed: payload.closed === true }]) });
    for (const output of ['screenshot', 'pdf']) await runCase(cases, artifacts, { id: `read-${output}`, name: `Rendered ${output}`, category: 'artifact', dimension: 'connectivity', retry: true, tool: 'web_read', run: async () => { const result = await callTool(client, 'web_read', { url: samples.static.url, render: 'always', output }); const artifact = artifactFrom(result.payload, output, `read-${output}`); if (!artifact) throw new Error(`missing ${output} artifact`); return { ...result, artifact }; }, quality: (_payload, outcome) => assertQuality([{ name: 'non-empty-artifact', passed: Number(outcome.artifact?.bytes) > 100 }]) });
    await runCase(cases, artifacts, { id: 'gateway-health', name: 'Authenticated gateway health', category: 'health', tool: 'health', run: async () => { const start = now(); const response = await fetch(gatewayUrl.replace('/mcp', '/healthz'), { headers: { authorization: `Bearer ${token}` } }); const totalMs = elapsed(start); return { payload: { status: response.status }, total_ms: totalMs, first_valid_result_ms: totalMs, stages_ms: { http_ms: totalMs } }; }, quality: payload => assertQuality([{ name: 'returns-200', passed: payload.status === 200 }]) });
    await runCase(cases, artifacts, { id: 'gateway-ready', name: 'Dependency readiness', category: 'health', tool: 'ready', run: async () => { const start = now(); const response = await fetch(gatewayUrl.replace('/mcp', '/readyz'), { headers: { authorization: `Bearer ${token}` } }); const body = await response.json(); const totalMs = elapsed(start); return { payload: { status: response.status, body }, total_ms: totalMs, first_valid_result_ms: totalMs, stages_ms: { http_ms: totalMs } }; }, quality: payload => assertQuality([{ name: 'returns-200', passed: payload.status === 200 }, { name: 'all-dependencies-ready', passed: payload.body?.ok === true && (payload.body.dependencies ?? []).every(item => item.ok === true) }]) });
    await runCase(cases, artifacts, { id: 'eval-api-auth', name: 'Evaluation API rejects missing token', category: 'security', expectation: 'expected_security', expected_outcome: { http_status: 401 }, tool: 'authentication', run: async () => { const start = now(); const response = await fetch(gatewayUrl.replace('/mcp', '/api/evals')); const totalMs = elapsed(start); return { payload: { status: response.status }, total_ms: totalMs, first_valid_result_ms: totalMs, stages_ms: { http_ms: totalMs } }; } });
    await runCase(cases, artifacts, { id: 'auth-required', name: 'Health endpoint rejects missing token', category: 'security', expectation: 'expected_security', expected_outcome: { http_status: 401 }, tool: 'authentication', run: async () => { const start = now(); const response = await fetch(gatewayUrl.replace('/mcp', '/healthz')); const totalMs = elapsed(start); return { payload: { status: response.status }, total_ms: totalMs, first_valid_result_ms: totalMs, stages_ms: { http_ms: totalMs } }; } });
    await runCase(cases, artifacts, { id: 'ssrf-loopback', name: 'Loopback URL is rejected', category: 'security', expectation: 'expected_security', expected_outcome: { kinds: ['ssrf_blocked'], blocked_reason: 'non_public_address' }, tool: 'web_read', run: () => callTool(client, 'web_read', { url: samples.security.loopback_url, render: 'never', output: 'markdown' }) });
    if (suite === 'release') {
      const baseline = cases.find(item => item.id === 'read-static')?.total_ms ?? 1;
      await runCase(cases, artifacts, { id: 'concurrency-two', name: 'Two concurrent reads', category: 'concurrency', tool: 'web_read', run: async () => { const start = now(); const [a, b] = await Promise.all([callTool(client, 'web_read', { url: samples.static.url, render: 'never', output: 'markdown' }), callTool(client, 'web_read', { url: samples.static.url, render: 'never', output: 'markdown' })]); const totalMs = elapsed(start); const degradation = Math.round((Math.max(a.total_ms, b.total_ms) / baseline - 1) * 100); return { payload: { both_completed: true, degradation_pct: degradation }, metrics: { degradation_pct: degradation, queue_ms: Math.max(0, totalMs - Math.max(a.total_ms, b.total_ms)) }, total_ms: totalMs, first_valid_result_ms: Math.min(a.first_valid_result_ms, b.first_valid_result_ms), stages_ms: { parallel_wall_ms: totalMs, request_a_ms: a.total_ms, request_b_ms: b.total_ms } }; }, quality: payload => assertQuality([{ name: 'both-completed', passed: payload.both_completed === true }, { name: 'degradation-limit', passed: payload.degradation_pct <= 50 }]) });
      await runCase(cases, artifacts, { id: 'ssrf-redirect', name: 'Private redirect target is rejected', category: 'security', expectation: 'expected_security', expected_outcome: { kinds: ['ssrf_blocked'], blocked_reason: 'non_public_address' }, tool: 'web_read', run: () => callTool(client, 'web_read', { url: samples.security.redirect_to_loopback_url, render: 'never', output: 'markdown' }) });
      // Deadline proof is the offline controlled-origin gateway fixture, not a
      // public delay endpoint whose JSON response can fail on content type.
    }
  } finally { clearInterval(resourceTimer); await client.close().catch(() => {}); await transport.close().catch(() => {}); }
  const completedAt = new Date(); const summary = summarizeCases(cases);
  const resourceEnd = await resourceSnapshot(); resourceSamples.push(resourceEnd);
  const status = evaluationStatus(cases);
  const proxyRestartsStart = resourceStart['web-access-egress-proxy.service']?.restarts ?? 0;
  const proxyRestartsEnd = resourceEnd['web-access-egress-proxy.service']?.restarts ?? 0;
  const report = { schema_version: REPORT_VERSION, id: runId, suite, started_at: startedAt.toISOString(), completed_at: completedAt.toISOString(), duration_ms: completedAt - startedAt, status, thresholds: suite === 'smoke' ? { success_rate_pct: 100, quality_rate_pct: 100 } : { success_rate_pct: 95, quality_rate_pct: 95, timeout_rate_pct: 2, concurrency_degradation_pct: 50 }, summary, dimensions: dimensionSummaries(cases), tools: toolSummaries(cases), cases, artifacts, resources: { start: resourceStart, end: resourceEnd, peak: peakResources(resourceSamples), sample_count: resourceSamples.length, proxy_restart_increase: Math.max(0, proxyRestartsEnd - proxyRestartsStart) } };
  await fs.mkdir(reportDirectory, { recursive: true, mode: 0o750 });
  await pruneExpiredReports(reportDirectory);
  const reportPath = path.join(reportDirectory, `${runId}.json`); const temporaryPath = `${reportPath}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o640 });
  await fs.chmod(temporaryPath, 0o644);
  await fs.rename(temporaryPath, reportPath);
  console.log(reportPath); if (report.status === 'failed') process.exitCode = 1;
}
main().catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
