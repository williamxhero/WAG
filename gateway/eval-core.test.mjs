import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyTransientFailure, dimensionSummaries, evaluationStatus, isEvaluationReportFileName, latencySummary, latestSnapshotText, normalizeReport, runWithRetries, safeArtifactId, summarizeCases } from './eval-core.mjs';

test('latestSnapshotText ignores stale refs from earlier browser actions', () => {
  const outputs = [
    { content: [{ type: 'text', text: '- link "stale" [ref=e1]' }] },
    { content: [{ type: 'text', text: '- link "current" [ref=e7]' }] },
  ];
  assert.equal(latestSnapshotText(outputs), '- link "current" [ref=e7]');
});

test('latency summary uses stable nearest-rank percentiles', () => {
  assert.deepEqual(latencySummary([1, 4, 2, 9]), { count: 4, p50_ms: 4, p95_ms: 9, p99_ms: 9 });
});

test('case summary reports success, quality and timeout rates', () => {
  const summary = summarizeCases([
    { status: 'passed', quality: { passed: true }, total_ms: 100, first_valid_result_ms: 50 },
    { status: 'failed', quality: { passed: false }, total_ms: 200, first_valid_result_ms: null, error: { kind: 'timeout' } },
  ]);
  assert.equal(summary.success_rate_pct, 50);
  assert.equal(summary.quality_rate_pct, 50);
  assert.equal(summary.timeout_rate_pct, 50);
});

test('transient failures retry with visible attempt evidence', async () => {
  let calls = 0;
  const result = await runWithRetries(async () => {
    calls++;
    if (calls === 1) throw new Error('read ECONNRESET');
    return { value: 'ok' };
  }, { delayMs: 0 });
  assert.deepEqual(result, { value: 'ok', attempts: 2, degraded: true, first_error: 'read ECONNRESET' });
  assert.equal(classifyTransientFailure(new Error('unauthorized')), false);
});

test('core failures fail a run while connectivity failures degrade it', () => {
  const connectivityOnly = [
    { dimension: 'core', status: 'passed', quality: { passed: true } },
    { dimension: 'connectivity', status: 'failed', quality: { passed: false } },
  ];
  assert.equal(evaluationStatus(connectivityOnly), 'degraded');
  assert.equal(evaluationStatus([{ dimension: 'core', status: 'failed', quality: { passed: false } }]), 'failed');
  assert.equal(dimensionSummaries(connectivityOnly).connectivity.failed_cases, 1);
});

test('legacy smoke report is visible as a compatible report', () => {
  const report = normalizeReport({ suite: 'smoke', at: '2026-08-28T01:09:39Z', health: { ok: true }, private_proxy_status: 403 }, 'smoke-old.json');
  assert.equal(report.legacy, true);
  assert.equal(report.status, 'passed');
});

test('only WAG-owned screenshot and PDF identifiers are accepted', () => {
  assert.equal(safeArtifactId('2026-08-28/123e4567-e89b-12d3-a456-426614174000.png'), true);
  assert.equal(safeArtifactId('../secrets/gateway.env'), false);
});

test('evaluation report filenames accept legacy and current reports only', () => {
  assert.equal(isEvaluationReportFileName('smoke-20260828T013729Z.json'), true);
  assert.equal(isEvaluationReportFileName('release-20260828T013729385Z.json'), true);
  assert.equal(isEvaluationReportFileName('../release-20260828T013729Z.json'), false);
});
