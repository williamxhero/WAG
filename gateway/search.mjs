import { normalizeSearchResults } from './evidence-metadata.mjs';

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

async function requestSearch({ baseUrl, input, fetchImpl, signal, relaxed }) {
  const params = buildSearchParams(input, { relaxed });
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/search?${params}`, { signal });
  if (!response.ok) {
    throw searchError(`SearXNG returned ${response.status}`, 'search_backend_status', { httpStatus: response.status });
  }
  return response.json();
}

export async function searchSearxng({ baseUrl, input, fetchImpl = globalThis.fetch, signal } = {}) {
  const stages_ms = {};
  const firstStarted = Date.now();
  const firstBody = await requestSearch({ baseUrl, input, fetchImpl, signal, relaxed: false });
  stages_ms.search_ms = Date.now() - firstStarted;

  let body = firstBody;
  let attempts = 1;
  if (!Array.isArray(firstBody.results) || firstBody.results.length === 0) {
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
  const results = normalizeSearchResults(body.results, retrievedAt, 20);
  return {
    results,
    number_of_results: body.number_of_results ?? results.length,
    stages_ms,
    attempts,
    ...(Object.prototype.hasOwnProperty.call(body, 'unresponsive_engines')
      ? { unresponsive_engines: body.unresponsive_engines }
      : {}),
  };
}
