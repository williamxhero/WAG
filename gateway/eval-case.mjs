import { deadlineKind, runWithRetries } from './eval-core.mjs';

export function evaluationErrorInfo(error, sanitizeMessage = message => message) {
  const payload = error?.payload ?? error;
  const detail = payload?.error ?? error;
  // Sanitization must see the whole credential before a diagnostic is bounded.
  const message = sanitizeMessage(String(detail?.message ?? error?.message ?? error ?? 'unknown failure'));
  return {
    kind: deadlineKind(error) ?? detail?.kind ?? 'request',
    message: message.slice(0, 500),
    ...(payload?.http_status != null || error?.httpStatus != null ? { http_status: payload?.http_status ?? error.httpStatus } : {}),
    ...(payload?.blocked_reason != null || error?.blockedReason != null ? { blocked_reason: payload?.blocked_reason ?? error.blockedReason } : {}),
  };
}

const qualityResult = checks => ({ passed: checks.every(check => check.passed), checks });

function expectedQuality(expected, error) {
  const declared = Boolean(expected && (expected.kinds?.length || expected.http_status != null));
  return qualityResult([
    { name: 'expected-outcome-declared', passed: declared },
    { name: 'expected-error-observed', passed: Boolean(error) },
    ...(expected?.kinds ? [{ name: 'expected-error-kind', passed: Boolean(error && expected.kinds.includes(error.kind)) }] : []),
    ...(expected?.http_status != null ? [{ name: 'expected-http-status', passed: error?.http_status === expected.http_status }] : []),
    ...(expected?.blocked_reason != null ? [{ name: 'expected-blocked-reason', passed: error?.blocked_reason === expected.blocked_reason }] : []),
  ]);
}

// Shared by the command evaluator and offline gateway fixtures. A negative case
// is evaluated once, whether the boundary returns a typed error or throws it.
export async function evaluateCase(definition) {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const negative = (definition.expectation ?? 'availability') !== 'availability';
  const errorInfo = error => evaluationErrorInfo(error, definition.sanitizeMessage);
  const base = {
    id: definition.id, name: definition.name, category: definition.category,
    dimension: definition.dimension ?? 'core', expectation: definition.expectation ?? 'availability',
    ...(definition.expected_outcome ? { expected_outcome: definition.expected_outcome } : {}),
    tool: definition.tool,
  };
  try {
    const attempted = await runWithRetries(async () => {
      let outcome; let error;
      try {
        outcome = await definition.run();
        const httpStatus = outcome.payload?.http_status ?? outcome.payload?.status;
        if (outcome.payload?.error || outcome.isError === true || Number(httpStatus) >= 400) {
          error = errorInfo({ ...outcome.payload, ...(httpStatus != null ? { http_status: httpStatus } : {}) });
        }
      } catch (caught) {
        if (!negative) throw caught;
        error = errorInfo(caught);
        outcome = { payload: caught.payload ?? {}, total_ms: elapsed() };
      }
      if (error && !negative) throw Object.assign(new Error(error.message), { ...error });
      const quality = negative ? expectedQuality(definition.expected_outcome, error)
        : definition.quality ? definition.quality(outcome.payload, outcome)
          : qualityResult([{ name: 'request-completed', passed: true }]);
      return { outcome, quality, error };
    }, {
      maximumAttempts: negative ? 1 : definition.retry ? 3 : 1,
      shouldRetryResult: result => definition.retryQuality === true && !result.quality.passed,
      resultError: () => 'transient quality assertion failed',
    });
    const { outcome, quality, error } = attempted;
    const status = quality.passed ? 'passed' : 'failed';
    return {
      ...base, status, attempts: attempted.attempts, degraded: attempted.degraded,
      attempt_outcomes: attempted.attempt_outcomes,
      ...(attempted.first_error ? { first_error: attempted.first_error } : {}),
      total_ms: outcome.total_ms ?? elapsed(),
      first_valid_result_ms: negative && status !== 'passed' ? null : outcome.first_valid_result_ms ?? outcome.total_ms ?? elapsed(),
      stages_ms: outcome.stages_ms ?? {}, quality,
      ...(outcome.metrics ? { metrics: outcome.metrics } : {}),
      ...(outcome.artifact ? { artifact: outcome.artifact } : {}),
      ...(error ? { error } : status === 'failed' ? { error: { kind: negative ? 'unexpected_outcome' : 'quality', message: negative ? 'expected outcome was not observed' : 'quality assertion failed' } } : {}),
    };
  } catch (error) {
    return {
      ...base, status: 'failed', attempts: error.attempts ?? 1,
      attempt_outcomes: error.attempt_outcomes,
      ...(error.first_error ? { first_error: error.first_error } : {}),
      total_ms: elapsed(), first_valid_result_ms: null, stages_ms: {},
      quality: qualityResult([{ name: 'request-completed', passed: false }]),
      error: errorInfo(error),
    };
  }
}
