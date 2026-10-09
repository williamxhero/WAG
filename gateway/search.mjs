import { filterLowQualityResults, normalizeSearchResults, strictTimeRangeCompliance, timeRangeCompliance } from './evidence-metadata.mjs';

const searchParameters = ['categories', 'engines', 'language'];

export function buildSearchParams(input, { relaxed = false } = {}) {
  const params = new URLSearchParams({ q: input.query, format: 'json' });
  for (const key of searchParameters) if (input[key]) params.set(key, input[key]);
  if (!relaxed && input.time_range) params.set('time_range', input.time_range);
  if (input.page) params.set('pageno', String(input.page));
  return params;
}

function searchError(message, kind, extra = {}) {
  const error = new Error(message);
  error.kind = kind;
  Object.assign(error, extra);
  return error;
}

// Result-quality filtering is on by default so callers see the intended behavior without extra
// wiring; it can be turned off per call (qualityFilter: false) or globally via the environment for
// operators who want the raw engine output.
function qualityFilterDefault() {
  const raw = String(process.env.WAG_SEARCH_QUALITY_FILTER ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw);
}

function countReasons(filtered) {
  const reasons = {};
  for (const item of filtered) reasons[item.reason] = (reasons[item.reason] ?? 0) + 1;
  return reasons;
}

async function requestSearch({ baseUrl, input, fetchImpl, signal, relaxed }) {
  const params = buildSearchParams(input, { relaxed });
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/search?${params}`, { signal });
  if (!response.ok) {
    throw searchError(`SearXNG returned ${response.status}`, 'search_backend_status', { httpStatus: response.status });
  }
  return response.json();
}

export async function searchSearxng({ baseUrl, input, fetchImpl = globalThis.fetch, signal, qualityFilter, timeWindowStrict } = {}) {
  const stages_ms = {};
  const firstStarted = Date.now();
  const firstBody = await requestSearch({ baseUrl, input, fetchImpl, signal, relaxed: false });
  stages_ms.search_ms = Date.now() - firstStarted;

  const strictWindow = Boolean(timeWindowStrict);
  const requestedTimeRange = input.time_range ?? null;
  let body = firstBody;
  let attempts = 1;
  const emptyFirst = !Array.isArray(firstBody.results) || firstBody.results.length === 0;
  // Strict opt-in: when a caller pins a time window and asks for strict handling, an empty first
  // response is a real answer about that window — the filter is never silently dropped to retry.
  const mayRelax = !(strictWindow && requestedTimeRange);
  if (emptyFirst && mayRelax) {
    const retryStarted = Date.now();
    body = await requestSearch({
      baseUrl,
      input: { ...input, time_range: undefined },
      fetchImpl,
      signal,
      relaxed: true,
    });
    stages_ms.search_retry_ms = Date.now() - retryStarted;
    attempts = 2;
  }

  const retrievedAt = new Date().toISOString();
  const normalized = normalizeSearchResults(body.results, retrievedAt, 20);
  const filterEnabled = qualityFilter === undefined ? qualityFilterDefault() : Boolean(qualityFilter);
  const { results: filteredResults, filtered } = filterLowQualityResults(normalized, { enabled: filterEnabled });

  // Temporal honesty: when the caller pinned a time window we must say whether the results can be
  // proven to fall inside it, including when the relaxed retry silently dropped the filter. Strict
  // mode additionally refuses to count unknown / URL-inferred / timezone-less evidence as fresh.
  let results = filteredResults;
  let temporalFields = {};
  const timeRange = input.time_range ?? null;
  if (timeRange) {
    const classify = strictWindow ? strictTimeRangeCompliance : timeRangeCompliance;
    results = filteredResults.map(result => ({ ...result, time_range_status: classify(result, timeRange, retrievedAt) }));
    const applied = attempts === 1;
    const outside = results.filter(result => result.time_range_status === 'outside').length;
    const unverified = results.filter(result => result.time_range_status === 'unverified').length;
    const enforced = applied && results.length > 0 && outside === 0 && unverified === 0;
    temporalFields = {
      time_range: timeRange,
      time_range_applied: applied,
      time_range_enforced: enforced,
      time_range_note: !applied
        ? `Requested time_range '${timeRange}', but the empty-result retry dropped it; returned results are not proven within the window.`
        : results.length === 0
          ? strictWindow
            ? `Requested strict time_range '${timeRange}'; no results were returned and the filter was not relaxed.`
            : `Requested time_range '${timeRange}'; no results were returned.`
          : outside > 0 || unverified > 0
            ? `Requested time_range '${timeRange}'; ${outside} result(s) fall outside the window${unverified > 0 ? ` and ${unverified} are not proven within it` : ''}.`
            : null,
    };
  }
  if (strictWindow) temporalFields.time_window_strict = true;

  return {
    results,
    number_of_results: body.number_of_results ?? results.length,
    stages_ms,
    attempts,
    filtered_out: filtered.length,
    filtered_reasons: countReasons(filtered),
    ...temporalFields,
    ...(Object.prototype.hasOwnProperty.call(body, 'unresponsive_engines')
      ? { unresponsive_engines: body.unresponsive_engines }
      : {}),
  };
}
