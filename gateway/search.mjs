import { filterLowQualityResults, normalizeSearchResults, normalizeUrlForDedup, strictTimeRangeCompliance, timeRangeCompliance } from './evidence-metadata.mjs';

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

// ---------------------------------------------------------------------------------------------
// Opt-in news mode (SPEC issue #72)
//
// News mode is an explicit, opt-in *reordering* for news-category searches. It never drops or adds a
// result (recall is unchanged) and never touches the shared quality filter, the dedup normalizer or
// the normal-mode output. Its signals are explainable heuristics, not proof of relevance: a rule
// firing only says "this URL looks more or less like a directly usable news content page".
// ---------------------------------------------------------------------------------------------

const NEWS_CATEGORY = /(?:^|[\s,])(?:news)(?:$|[\s,])/i;

// Auto opt-in: a caller that already asked SearXNG for the `news` category gets the news ranking.
export function isNewsCategory(categories) {
  return typeof categories === 'string' && NEWS_CATEGORY.test(categories);
}

// Query tokens without a tokenizer: latin/number runs are kept whole, and each CJK run is expanded
// into overlapping bigrams (Chinese has no word spaces). No alias dictionary is used, so a page whose
// title only carries a *different-language* name for the entity will not match.
export function newsQueryTerms(query) {
  const terms = new Set();
  const lower = String(query ?? '').toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9][a-z0-9.+#_-]*/g)) terms.add(match[0]);
  for (const run of lower.match(/[\u3400-\u9fff]+/g) ?? []) {
    if (run.length === 1) { terms.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i++) terms.add(run.slice(i, i + 2));
  }
  return terms;
}

function resultUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

const NEWS_INDEX_BASENAME = /^(?:index|default|home)\.[a-z0-9]{1,6}$/i;
const NEWS_WRAPPER_SEGMENT = /^(?:link|links|redirect|out|go|goto|jump|blm|video-page|url)$/i;
const NEWS_REDIRECT_PARAM = /^(?:url|u|target|redirect|redirect_uri|link|to|goto|r)$/i;
const NEWS_NAVIGATIONAL_SNIPPET = /^\s*link to /i;

// The explainable per-result score. Positive signals promote a directly usable content page; negative
// signals demote navigational wrappers, empty snippets and undated pages. The returned `reasons` are
// the explanation surfaced by `searchSearxng` under `news_ranking`.
export function scoreNewsRelevance(result, query) {
  const reasons = [];
  let score = 0;
  const url = resultUrl(result?.url);
  const segments = (url?.pathname ?? '').split('/').filter(Boolean);
  const root = segments.length === 0 || (segments.length === 1 && NEWS_INDEX_BASENAME.test(segments[0]));
  if (root) { score -= 5; reasons.push('navigational_root'); }
  else if (segments.length >= 2) { score += 1; reasons.push('article_path'); }

  const hasRedirectParam = url
    ? [...url.searchParams.keys()].some(key => NEWS_REDIRECT_PARAM.test(key) && /^https?:\/\//i.test(url.searchParams.get(key) ?? ''))
    : false;
  const wrapperSegment = segments.some(segment => NEWS_WRAPPER_SEGMENT.test(segment));
  if (hasRedirectParam || wrapperSegment) { score -= 3; reasons.push('redirect_wrapper'); }

  const content = String(result?.content ?? '');
  if (content === '') { score -= 4; reasons.push('empty_snippet'); }
  else if (NEWS_NAVIGATIONAL_SNIPPET.test(content)) { score -= 4; reasons.push('navigational_snippet'); }

  const evidence = Array.isArray(result?.temporal_evidence) ? result.temporal_evidence : [];
  const hasInstant = evidence.some(item => item.kind === 'published_at' && item.value);
  if (hasInstant) { score += 3; reasons.push('publisher_instant'); }
  else if (result?.published_on) { score += 1; reasons.push('dated'); }
  else { score -= 1; reasons.push('undated'); }

  const terms = newsQueryTerms(query);
  if (terms.size > 0) {
    const title = String(result?.title ?? '').toLowerCase();
    const body = content.toLowerCase();
    let titleHits = 0;
    let snippetHits = 0;
    for (const term of terms) {
      if (title.includes(term)) titleHits++;
      else if (body.includes(term)) snippetHits++;
    }
    if (titleHits > 0) { score += Math.min(titleHits, 3) * 2; reasons.push('title_match'); }
    else if (snippetHits > 0) { score += 1; reasons.push('snippet_match'); }
    else { score -= 1; reasons.push('no_query_match'); }
  }
  return { score, reasons };
}

// Stable reorder: higher score first, original engine order preserved for ties. Every input result is
// returned exactly once, so a news-mode search keeps the same recall as the same normal-mode search.
export function rankNewsResults(results, query) {
  const list = Array.isArray(results) ? results : [];
  return list
    .map((result, index) => ({ result, index, ...scoreNewsRelevance(result, query) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(item => item.result);
}

function summarizeNewsRanking(before, ranked, query) {
  const reasons = {};
  let moved = 0;
  let demoted = 0;
  let promoted = 0;
  for (let index = 0; index < before.length; index++) if (before[index] !== ranked[index]) moved++;
  for (const result of before) {
    const { score, reasons: resultReasons } = scoreNewsRelevance(result, query);
    if (score < 0) demoted++;
    else if (score > 0) promoted++;
    for (const reason of resultReasons) reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { applied: true, total: before.length, moved, demoted, promoted, reasons };
}

// Multi-source dedup evidence: the shared normalizer collapses duplicate URLs before ranking, so this
// records how many raw results were merged and which URLs arrived from more than one engine. The
// engines are preserved here instead of being silently dropped with the merged duplicate.
export function summarizeSourceEvidence(rawResults) {
  const groups = new Map();
  let total = 0;
  for (const item of Array.isArray(rawResults) ? rawResults : []) {
    const url = typeof item?.url === 'string' ? item.url : '';
    if (!url) continue;
    total++;
    const key = normalizeUrlForDedup(url);
    if (!groups.has(key)) groups.set(key, { url: key, engines: new Set() });
    if (item.engine) groups.get(key).engines.add(item.engine);
  }
  const multi = [...groups.values()].filter(group => group.engines.size > 1);
  return {
    raw_results: total,
    unique_urls: groups.size,
    merged: total - groups.size,
    multi_source: multi.length,
    sources: multi.map(group => ({ url: group.url, engines: [...group.engines].sort() })),
  };
}

async function requestSearch({ baseUrl, input, fetchImpl, signal, relaxed }) {
  const params = buildSearchParams(input, { relaxed });
  const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/search?${params}`, { signal });
  if (!response.ok) {
    throw searchError(`SearXNG returned ${response.status}`, 'search_backend_status', { httpStatus: response.status });
  }
  return response.json();
}

export async function searchSearxng({ baseUrl, input, fetchImpl = globalThis.fetch, signal, qualityFilter, timeWindowStrict, newsMode } = {}) {
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

  // Opt-in news mode: an explicit `newsMode` option wins; otherwise a caller that already requested
  // the SearXNG `news` category opts in. It only reorders the already-filtered, already-deduped set,
  // so recall is unchanged and normal-mode output stays byte-for-byte compatible.
  const newsEnabled = newsMode === undefined ? isNewsCategory(input.categories) : Boolean(newsMode);
  const ranked = newsEnabled ? rankNewsResults(results, input.query) : null;

  return {
    results: ranked ?? results,
    number_of_results: body.number_of_results ?? results.length,
    stages_ms,
    attempts,
    filtered_out: filtered.length,
    filtered_reasons: countReasons(filtered),
    ...temporalFields,
    ...(newsEnabled
      ? {
          news_mode: true,
          news_ranking: summarizeNewsRanking(results, ranked, input.query),
          dedup: summarizeSourceEvidence(body.results),
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'unresponsive_engines')
      ? { unresponsive_engines: body.unresponsive_engines }
      : {}),
  };
}
