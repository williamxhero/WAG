import { normalizeUrlForDedup } from './evidence-metadata.mjs';

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Source IDs identify caller-supplied lists, not independently verified publishers.
export function reciprocalRankFusion(sources, options = {}) {
  if (!isRecord(options)) throw new TypeError('options must be an object');
  if (Reflect.ownKeys(options).some(key => key !== 'limit')) {
    throw new TypeError('only the limit option is supported');
  }
  const suppliedLimit = Object.hasOwn(options, 'limit') ? options.limit : undefined;
  const limit = suppliedLimit === undefined ? 20 : suppliedLimit;
  if (!Number.isInteger(limit) || limit < 0 || limit > 20) {
    throw new RangeError('limit must be an integer from 0 to 20');
  }
  if (!Array.isArray(sources)) throw new TypeError('sources must be an array');

  const sourceIds = new Set();
  const byUrl = new Map();
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
    if (!Object.hasOwn(sources, sourceIndex)) throw new TypeError('sources must not be sparse');
    const block = sources[sourceIndex];
    if (!isRecord(block)) throw new TypeError('each source block must be an object');
    const { source, results } = block;
    if (typeof source !== 'string' || !source || source.trim() !== source) {
      throw new TypeError('source must be a nonempty string without surrounding whitespace');
    }
    if (sourceIds.has(source)) throw new TypeError('source IDs must be unique');
    sourceIds.add(source);
    if (!Array.isArray(results)) throw new TypeError('results must be an array');

    const seenUrls = new Set();
    for (let index = 0; index < results.length; index++) {
      if (!Object.hasOwn(results, index)) throw new TypeError('results must not be sparse');
      const result = results[index];
      if (!isRecord(result)) throw new TypeError('each result must be an object');
      if (typeof result.url !== 'string' || !result.url) {
        throw new TypeError('result.url must be a nonempty absolute HTTP/HTTPS URL string');
      }
      let parsed;
      try {
        parsed = new URL(result.url);
      } catch {
        throw new TypeError('result.url must be an absolute HTTP/HTTPS URL');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new TypeError('result.url must use HTTP or HTTPS');
      }
      const url = normalizeUrlForDedup(result.url);
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      // Ranks belong to the original list, including positions occupied by duplicates.
      const rank = index + 1;
      const contribution = { source, rank, score: 1 / (60 + rank), result };
      if (!byUrl.has(url)) byUrl.set(url, []);
      byUrl.get(url).push(contribution);
    }
  }

  const fused = [];
  for (const [url, contributions] of byUrl) {
    contributions.sort((left, right) => compareText(left.source, right.source));
    // Sum in the same code-unit order regardless of source-block input order.
    let score = 0;
    for (const contribution of contributions) score += contribution.score;
    fused.push({ url, score, contributions });
  }
  fused.sort((left, right) => right.score - left.score || compareText(left.url, right.url));
  return fused.slice(0, limit);
}
