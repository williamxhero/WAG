export const REPORT_VERSION = 1;

export const DEADLINE_KINDS = Object.freeze(['timeout', 'upstream_timeout', 'egress_timeout']);

export function deadlineKind(error, seen = new Set()) {
  if (!error || typeof error !== 'object' || seen.has(error)) return null;
  seen.add(error);
  if (DEADLINE_KINDS.includes(error.kind)) return error.kind;
  for (const nested of [error.cause, error.error, error.payload]) {
    const kind = deadlineKind(nested, seen);
    if (kind) return kind;
  }
  return null;
}

export function latestSnapshotText(outputs) {
  const snapshot = outputs?.at(-1);
  return (snapshot?.content ?? [])
    .filter(item => item.type === 'text')
    .map(item => item.text)
    .join('\n');
}

export function classifyTransientFailure(error) {
  return /ECONNRESET|ERR_CONNECTION_(?:CLOSED|RESET)|\b50[234]\b|temporar(?:y|ily)|timed?\s*out/i.test(String(error?.message ?? error ?? ''));
}

export async function runWithRetries(operation, options = {}) {
  const maximumAttempts = options.maximumAttempts ?? 3;
  const delayMs = options.delayMs ?? 250;
  const shouldRetryError = options.shouldRetryError ?? classifyTransientFailure;
  const shouldRetryResult = options.shouldRetryResult ?? (() => false);
  let firstError = null;
  for (let attempts = 1; attempts <= maximumAttempts; attempts++) {
    try {
      const result = await operation(attempts);
      if (attempts < maximumAttempts && shouldRetryResult(result)) {
        firstError ??= options.resultError?.(result) ?? 'transient result failure';
      } else {
        return { ...result, attempts, degraded: attempts > 1, ...(firstError ? { first_error: firstError } : {}) };
      }
    } catch (error) {
      firstError ??= String(error?.message ?? error);
      if (attempts === maximumAttempts || !shouldRetryError(error)) {
        error.attempts = attempts;
        error.first_error = firstError;
        throw error;
      }
    }
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  throw new Error('retry loop exhausted');
}

export function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * quantile));
  return sorted[index];
}

export function latencySummary(values) {
  const valid = values.filter(Number.isFinite);
  return {
    count: valid.length,
    p50_ms: percentile(valid, 0.5),
    p95_ms: percentile(valid, 0.95),
    p99_ms: percentile(valid, 0.99),
  };
}

export function ratio(numerator, denominator) {
  return denominator ? Number((numerator / denominator * 100).toFixed(2)) : null;
}

export function summarizeCases(cases) {
  const total = cases.length;
  const passed = cases.filter(item => item.status === 'passed').length;
  const qualityPassed = cases.filter(item => item.quality?.passed === true).length;
  const availability = cases.filter(item => (item.expectation ?? 'availability') === 'availability');
  const timedOut = availability.filter(item => deadlineKind(item.error) !== null).length;
  const expected = cases.filter(item => (item.expectation ?? 'availability') !== 'availability');
  const availabilityPassed = availability.filter(item => item.status === 'passed').length;
  const expectedPassed = expected.filter(item => item.status === 'passed').length;
  return {
    total_cases: total,
    passed_cases: passed,
    failed_cases: total - passed,
    success_rate_pct: ratio(passed, total),
    quality_rate_pct: ratio(qualityPassed, total),
    timeout_cases: timedOut,
    timeout_eligible_cases: availability.length,
    timeout_rate_pct: ratio(timedOut, availability.length),
    availability_coverage: availability.length ? 'measured' : 'empty',
    availability_total_cases: availability.length,
    availability_passed_cases: availabilityPassed,
    availability_success_rate_pct: ratio(availabilityPassed, availability.length),
    expected_outcomes_total: expected.length,
    expected_outcomes_passed: expectedPassed,
    expected_outcomes_failed: expected.length - expectedPassed,
    expected_outcome_rate_pct: ratio(expectedPassed, expected.length),
    first_valid_result: latencySummary(cases.map(item => item.first_valid_result_ms)),
    total_latency: latencySummary(cases.map(item => item.total_ms)),
  };
}

export function toolSummaries(cases) {
  const groups = new Map();
  for (const item of cases) {
    const group = groups.get(item.tool) ?? [];
    group.push(item);
    groups.set(item.tool, group);
  }
  return Object.fromEntries([...groups].map(([tool, items]) => [tool, summarizeCases(items)]));
}

export function dimensionSummaries(cases) {
  const groups = new Map();
  for (const item of cases) {
    const dimension = item.dimension ?? 'core';
    const group = groups.get(dimension) ?? [];
    group.push(item);
    groups.set(dimension, group);
  }
  return Object.fromEntries([...groups].map(([dimension, items]) => [dimension, summarizeCases(items)]));
}

export function defaultThresholds(suite) {
  return suite === 'release'
    ? { success_rate_pct: 95, quality_rate_pct: 95, timeout_rate_pct: 2, concurrency_degradation_pct: 50 }
    : { success_rate_pct: 100, quality_rate_pct: 100 };
}

export function evaluateGates(cases, options = {}) {
  const thresholds = { ...defaultThresholds(options.suite), ...options.thresholds };
  const summary = summarizeCases(cases);
  const coreFailures = cases.filter(item => (item.dimension ?? 'core') === 'core' && item.status !== 'passed');
  const connectivityFailures = cases.filter(item => item.dimension === 'connectivity' && item.status !== 'passed');
  const expectedIds = options.expected_case_ids;
  const complete = options.complete !== false && (!expectedIds || (cases.length === expectedIds.length
    && new Set(cases.map(item => item.id)).size === cases.length && expectedIds.every(id => cases.some(item => item.id === id))));
  const validCases = cases.every(item => ['passed', 'failed'].includes(item.status)
    && typeof item.quality?.passed === 'boolean' && ['core', 'connectivity'].includes(item.dimension ?? 'core'));
  const gates = {
    completion: { passed: complete, reason: complete ? null : 'incomplete_suite' },
    eligible_cases: { passed: summary.timeout_eligible_cases > 0, reason: summary.timeout_eligible_cases > 0 ? null : 'empty_availability_suite' },
    case_measurements: { passed: validCases, reason: validCases ? null : 'invalid_case_measurement' },
    core_cases: { passed: coreFailures.length === 0, reason: coreFailures.length ? 'non_passing_cases' : null, case_ids: coreFailures.map(item => item.id) },
  };
  // Compare unrounded measurements: display rounding must not certify a breach.
  function rateGate(name, numerator, denominator, comparison = 'minimum') {
    const value = denominator > 0 ? numerator / denominator * 100 : null;
    const threshold = thresholds[name];
    const validThreshold = Number.isFinite(threshold) && threshold >= 0 && threshold <= 100;
    const met = comparison === 'minimum' ? value >= threshold : value <= threshold;
    gates[name] = {
      passed: Number.isFinite(value) && validThreshold && met,
      value, threshold, comparison,
      reason: !validThreshold ? 'invalid_threshold' : !Number.isFinite(value) ? 'missing_measurement' : !met ? comparison === 'minimum' ? 'below_minimum' : 'above_maximum' : null,
    };
  }
  rateGate('success_rate_pct', summary.passed_cases, cases.length);
  rateGate('quality_rate_pct', cases.filter(item => item.quality?.passed === true).length, cases.length);
  if (Object.hasOwn(thresholds, 'timeout_rate_pct')) rateGate('timeout_rate_pct', summary.timeout_cases, summary.timeout_eligible_cases, 'maximum');
  if (Object.hasOwn(thresholds, 'concurrency_degradation_pct')) {
    const concurrent = cases.find(item => item.id === 'concurrency-two');
    const baseline = cases.find(item => item.id === 'read-static');
    const value = concurrent?.metrics?.degradation_pct;
    const threshold = thresholds.concurrency_degradation_pct;
    const validThreshold = Number.isFinite(threshold) && threshold >= 0;
    const validBaseline = Number.isFinite(concurrent?.metrics?.baseline_ms) && concurrent.metrics.baseline_ms > 0
      && (!baseline || (baseline.status === 'passed' && Number.isFinite(baseline.total_ms) && baseline.total_ms > 0));
    const measured = concurrent?.status === 'passed' && validBaseline && Number.isFinite(value) && value >= -100;
    gates.concurrency_degradation_pct = {
      passed: validThreshold && measured && value <= threshold,
      value: Number.isFinite(value) ? value : null, threshold, comparison: 'maximum',
      reason: !validThreshold ? 'invalid_threshold' : !validBaseline ? 'invalid_baseline' : !measured ? 'missing_measurement' : value > threshold ? 'above_maximum' : null,
    };
  }
  const failing_gates = Object.keys(gates).filter(name => !gates[name].passed);
  const reasons = failing_gates.map(gate => ({ gate, reason: gates[gate].reason, ...(gates[gate].case_ids ? { case_ids: gates[gate].case_ids } : {}) }));
  if (connectivityFailures.length) reasons.push({ gate: 'connectivity', reason: 'non_passing_cases', case_ids: connectivityFailures.map(item => item.id) });
  return { status: failing_gates.length ? 'failed' : connectivityFailures.length ? 'degraded' : 'passed', thresholds, gates, failing_gates, reasons };
}

export function evaluationStatus(cases, options) {
  if (options) return evaluateGates(cases, options).status;
  if (!cases.some(item => (item.expectation ?? 'availability') === 'availability')) return 'failed';
  if (cases.some(item => (item.dimension ?? 'core') === 'core' && item.status !== 'passed')) return 'failed';
  if (cases.some(item => item.dimension === 'connectivity' && item.status !== 'passed')) return 'degraded';
  return 'passed';
}

function reportThresholds(raw) {
  return {
    thresholds: { ...defaultThresholds(raw?.suite), ...raw?.thresholds },
    thresholds_source: raw?.thresholds_source ?? (raw?.thresholds ? 'report' : 'legacy_defaults'),
  };
}

export function normalizeReport(raw, fileName = '') {
  if (raw?.schema_version === REPORT_VERSION && Array.isArray(raw.cases)) {
    return { ...raw, ...reportThresholds(raw), dimensions: raw.dimensions ?? dimensionSummaries(raw.cases) };
  }
  const health = raw?.health ?? {};
  const blocked = String(raw?.private_proxy_status ?? '') === '403';
  const cases = [
    { id: 'legacy-health', name: 'Gateway health', tool: 'health', status: health.ok ? 'passed' : 'failed', quality: { passed: health.ok === true }, total_ms: null, first_valid_result_ms: null },
    { id: 'legacy-private-proxy', name: 'Private target proxy block', tool: 'security', status: blocked ? 'passed' : 'failed', quality: { passed: blocked }, total_ms: null, first_valid_result_ms: null },
  ];
  return {
    schema_version: 0,
    id: fileName.replace(/\.json$/, '') || 'legacy-report',
    suite: raw?.suite ?? 'unknown',
    ...reportThresholds(raw),
    started_at: raw?.at ?? null,
    completed_at: raw?.at ?? null,
    status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed',
    legacy: true,
    summary: summarizeCases(cases),
    dimensions: dimensionSummaries(cases),
    tools: toolSummaries(cases),
    cases,
    artifacts: [],
  };
}

export function publicRunSummary(report) {
  const normalized = normalizeReport(report);
  return {
    id: normalized.id,
    schema_version: normalized.schema_version,
    suite: normalized.suite,
    status: normalized.status,
    started_at: normalized.started_at,
    completed_at: normalized.completed_at,
    duration_ms: normalized.duration_ms ?? null,
    legacy: normalized.legacy === true,
    summary: normalized.summary,
    dimensions: normalized.dimensions,
    thresholds: normalized.thresholds,
    thresholds_source: normalized.thresholds_source,
    ...(normalized.gates ? { gates: normalized.gates } : {}),
    ...(normalized.failing_gates ? { failing_gates: normalized.failing_gates } : {}),
    ...(normalized.reasons ? { reasons: normalized.reasons } : {}),
  };
}

export function safeArtifactId(value) {
  return typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}\/[0-9a-f-]+\.(png|pdf)$/.test(value);
}

export function isEvaluationReportFileName(value) {
  return typeof value === 'string'
    && /^(?:smoke|release)-\d{8}T\d{6}(?:\d{3})?Z\.json$/.test(value);
}
