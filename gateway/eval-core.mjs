export const REPORT_VERSION = 1;

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
  const timedOut = cases.filter(item => item.error?.kind === 'timeout').length;
  return {
    total_cases: total,
    passed_cases: passed,
    failed_cases: total - passed,
    success_rate_pct: ratio(passed, total),
    quality_rate_pct: ratio(qualityPassed, total),
    timeout_rate_pct: ratio(timedOut, total),
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

export function normalizeReport(raw, fileName = '') {
  if (raw?.schema_version === REPORT_VERSION && Array.isArray(raw.cases)) return raw;
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
    started_at: raw?.at ?? null,
    completed_at: raw?.at ?? null,
    status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed',
    legacy: true,
    summary: summarizeCases(cases),
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
  };
}

export function safeArtifactId(value) {
  return typeof value === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}\/[0-9a-f-]+\.(png|pdf)$/.test(value);
}

export function isEvaluationReportFileName(value) {
  return typeof value === 'string'
    && /^(?:smoke|release)-\d{8}T\d{6}(?:\d{3})?Z\.json$/.test(value);
}
