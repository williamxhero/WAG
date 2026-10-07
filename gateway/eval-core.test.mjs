import assert from 'node:assert/strict';
import test from 'node:test';
import { deadlineKind, classifyTransientFailure, dimensionSummaries, evaluateGates, evaluationStatus, isEvaluationReportFileName, latencySummary, latestSnapshotText, normalizeReport, runWithRetries, safeArtifactId, summarizeCases } from './eval-core.mjs';

test('deadline taxonomy is exact and preserves underlying typed causes', () => {
  for (const kind of ['timeout', 'upstream_timeout', 'egress_timeout']) {
    assert.equal(deadlineKind({ kind }), kind);
    assert.equal(deadlineKind({ kind: 'request', cause: { kind } }), kind);
    assert.equal(deadlineKind({ payload: { error: { kind } } }), kind);
    assert.equal(deadlineKind({ error: { kind: 'quality', cause: { kind } } }), kind);
  }
  for (const kind of ['dependency_timeout', 'TimeoutError', 'upstream_timeouts', 'not_timeout', 'abort']) {
    assert.equal(deadlineKind({ kind, message: 'timeout timed out abort' }), null);
  }
  const cycle = { kind: 'request' }; cycle.cause = cycle;
  assert.equal(deadlineKind(cycle), null);
});

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

test('operational deadlines count only availability, with explicit eligible denominator', () => {
  const cases = [
    { status: 'passed', quality: { passed: true } },
    ...['timeout', 'upstream_timeout', 'egress_timeout'].map(kind => ({ status: 'failed', quality: { passed: false }, error: { kind } })),
    { status: 'failed', quality: { passed: false }, error: { kind: 'request', cause: { kind: 'upstream_timeout' } } },
    { status: 'failed', quality: { passed: false }, error: { kind: 'dependency_timeout' } },
    { status: 'passed', quality: { passed: true }, expectation: 'expected_timeout', error: { kind: 'egress_timeout' } },
    { status: 'passed', quality: { passed: true }, expectation: 'expected_security', error: { kind: 'ssrf_blocked' } },
    { status: 'failed', quality: { passed: false }, expectation: 'expected_security', error: { kind: 'upstream_timeout' } },
  ];
  const summary = summarizeCases(cases);
  assert.equal(summary.timeout_cases, 4);
  assert.equal(summary.timeout_eligible_cases, 6);
  assert.equal(summary.timeout_rate_pct, 66.67);
  assert.equal(summary.expected_outcomes_total, 3);
  assert.equal(summary.expected_outcomes_passed, 2);
  assert.equal(summary.expected_outcomes_failed, 1);
  assert.equal(summary.success_rate_pct, 33.33);
  assert.equal(summary.quality_rate_pct, 33.33);
});

test('empty and negative-only suites have no availability measurement and cannot pass', () => {
  for (const cases of [[], [{ expectation: 'expected_timeout', status: 'passed', quality: { passed: true }, error: { kind: 'timeout' } }]]) {
    const summary = summarizeCases(cases);
    assert.equal(summary.timeout_eligible_cases, 0);
    assert.equal(summary.timeout_cases, 0);
    assert.equal(summary.timeout_rate_pct, null);
    assert.equal(summary.availability_success_rate_pct, null);
    assert.equal(summary.availability_coverage, 'empty');
    assert.equal(evaluationStatus(cases), 'failed');
  }
  assert.equal(summarizeCases([]).success_rate_pct, null);
  assert.equal(summarizeCases([]).quality_rate_pct, null);
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

test('configured success gate enforces smoke and release discrete case counts', () => {
  const cases = Array.from({ length: 20 }, (_, index) => ({ id: index === 1 ? 'concurrency-two' : `case-${index}`, dimension: 'connectivity', status: index === 0 ? 'failed' : 'passed', quality: { passed: index !== 0 }, ...(index === 1 ? { metrics: { degradation_pct: 50, baseline_ms: 100 } } : {}) }));
  assert.equal(evaluationStatus(cases, { suite: 'smoke' }), 'failed');
  assert.equal(evaluationStatus(cases, { suite: 'release' }), 'degraded');
  assert.equal(evaluationStatus(cases.slice(0, 19), { suite: 'release' }), 'failed');
});

test('quality rate has an independent inclusive gate', () => {
  const cases = Array.from({ length: 20 }, (_, index) => ({ id: index === 1 ? 'concurrency-two' : `case-${index}`, status: 'passed', quality: { passed: index !== 0 }, ...(index === 1 ? { metrics: { degradation_pct: 50, baseline_ms: 100 } } : {}) }));
  assert.equal(evaluationStatus(cases, { suite: 'release' }), 'passed');
  assert.equal(evaluationStatus(cases, { suite: 'smoke' }), 'failed');
  assert.equal(evaluationStatus(cases.slice(0, 19), { suite: 'release' }), 'failed');
});

test('operational timeout gate passes 2% exactly and rejects a rounded-down breach', () => {
  const cases = Array.from({ length: 50 }, (_, index) => ({ id: index === 1 ? 'concurrency-two' : `case-${index}`, dimension: 'connectivity', status: index === 0 ? 'failed' : 'passed', quality: { passed: index !== 0 }, ...(index === 0 ? { error: { kind: 'egress_timeout' } } : {}), ...(index === 1 ? { metrics: { degradation_pct: 50, baseline_ms: 100 } } : {}) }));
  assert.equal(evaluationStatus(cases, { suite: 'release' }), 'degraded');
  assert.equal(evaluationStatus(cases.slice(0, 49), { suite: 'release' }), 'failed');
  const large = Array.from({ length: 9999 }, (_, index) => ({ status: 'passed', quality: { passed: true }, ...(index < 500 ? { error: { kind: 'timeout' } } : {}) }));
  assert.equal(summarizeCases(large).timeout_rate_pct, 5);
  assert.equal(evaluationStatus(large, { suite: 'smoke', thresholds: { timeout_rate_pct: 5 } }), 'failed');
});

test('concurrency gate has an inclusive boundary and requires a successful measured baseline', () => {
  const baseline = { id: 'read-static', dimension: 'connectivity', status: 'passed', quality: { passed: true }, total_ms: 100 };
  const concurrent = { id: 'concurrency-two', status: 'passed', quality: { passed: true }, metrics: { degradation_pct: 50, baseline_ms: 100 } };
  const status = (metric, base = baseline) => evaluationStatus([base, { ...concurrent, metrics: metric }], { suite: 'release', thresholds: { success_rate_pct: 0, quality_rate_pct: 0 } });
  assert.equal(status(concurrent.metrics), 'passed');
  assert.equal(status({ ...concurrent.metrics, degradation_pct: 50.001 }), 'failed');
  for (const value of [undefined, null, '50', NaN, Infinity]) assert.equal(status({ baseline_ms: 100, degradation_pct: value }), 'failed');
  assert.equal(status(concurrent.metrics, { ...baseline, status: 'failed', quality: { passed: false } }), 'failed');
  assert.equal(status({ degradation_pct: 0 }), 'failed');
});

test('empty, incomplete, and invalid measurements fail even with permissive thresholds', () => {
  const valid = { id: 'one', status: 'passed', quality: { passed: true } };
  const options = { suite: 'smoke', thresholds: { success_rate_pct: 0, quality_rate_pct: 0 } };
  for (const cases of [[], [{ ...valid, expectation: 'expected_timeout' }], [{ ...valid, quality: {} }], [{ ...valid, status: 'running' }]]) {
    assert.equal(evaluationStatus(cases, options), 'failed');
  }
  assert.equal(evaluationStatus([valid], { ...options, complete: false }), 'failed');
  assert.equal(evaluationStatus([valid], { ...options, expected_case_ids: ['one', 'two'] }), 'failed');
  assert.equal(evaluationStatus([valid, valid], { ...options, expected_case_ids: ['one'] }), 'failed');
  for (const name of ['success_rate_pct', 'quality_rate_pct', 'timeout_rate_pct', 'concurrency_degradation_pct']) {
    for (const value of [null, undefined, '95', NaN, Infinity, -1]) {
      const report = evaluateGates([valid], { suite: 'smoke', thresholds: { [name]: value } });
      assert.equal(report.status, 'failed');
      assert.equal(report.gates[name].reason, 'invalid_threshold');
    }
  }
});

test('reports identify core failures and connectivity-only degradation without weakening gates', () => {
  const cases = [
    { id: 'core', status: 'passed', quality: { passed: true } },
    { id: 'public', dimension: 'connectivity', status: 'failed', quality: { passed: false } },
  ];
  const options = { suite: 'smoke', thresholds: { success_rate_pct: 50, quality_rate_pct: 50 } };
  const degraded = evaluateGates(cases, options);
  assert.equal(degraded.status, 'degraded');
  assert.deepEqual(degraded.failing_gates, []);
  assert.deepEqual(degraded.reasons, [{ gate: 'connectivity', reason: 'non_passing_cases', case_ids: ['public'] }]);
  const core = evaluateGates([{ ...cases[0], status: 'failed' }, cases[1]], { ...options, thresholds: { success_rate_pct: 0, quality_rate_pct: 0 } });
  assert.equal(core.status, 'failed');
  assert.ok(core.failing_gates.includes('core_cases'));
  assert.equal(core.gates.core_cases.reason, 'non_passing_cases');
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
