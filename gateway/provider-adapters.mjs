import { normalizeProviderResult, providerCacheKey, providerCacheTtlMs } from './provider-contract.mjs';

function failure(kind) {
  return Object.assign(new Error(`Provider search failed: ${kind}`), { kind });
}

function inputQuery(input = {}) {
  if (typeof input === 'string') input = { query: input };
  const { query, mode = 'general', timeWindow = null } = input;
  const key = providerCacheKey({ query, mode, timeWindow });
  const normalized = JSON.parse(key)[0];
  if (normalized.length > 500 || !['general', 'news', 'strict'].includes(mode) ||
      ![null, 'day', 'week', 'month', 'year'].includes(timeWindow)) throw new TypeError('invalid provider query');
  return { query: normalized, mode, timeWindow, key };
}

export function createProviderAdapter({ name, transport, enabled = false, site = null,
  maxResponseBytes = 256 * 1024, maxResults = 10, timeoutMs = 5000 } = {}) {
  if (!['baidu', 'aliyun', 'tencent'].includes(name)) throw new TypeError('unknown provider');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1024 * 1024) throw new TypeError('invalid response byte limit');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) throw new TypeError('invalid result limit');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('invalid provider timeout');
  if (site !== null && (name !== 'tencent' || typeof site !== 'string' || !/^[a-z0-9.-]+$/i.test(site))) throw new TypeError('invalid provider site');
  return Object.freeze({
    name,
    get enabled() { return enabled === true && typeof transport === 'function'; },
    cacheIdentity(input) {
      const value = inputQuery(input);
      return { key: JSON.stringify([name, site, maxResults, value.key]), ttlMs: providerCacheTtlMs(value.mode, value.timeWindow) };
    },
    async search(input) {
      const { query, timeWindow } = inputQuery(input);
      if (enabled !== true || typeof transport !== 'function') throw failure('provider_unconfigured');
      let body;
      let api;
      let endpoint;
      if (name === 'baidu') {
        endpoint = 'https://qianfan.baidubce.com/v2/ai_search/web_search';
        body = { messages: [{ role: 'user', content: query }], search_source: 'baidu_search_v2', resource_type_filter: [{ type: 'web', top_k: maxResults }] };
        // The docs disagree on auth and pageTime/page_time. Do not guess either. Day is unfiltered.
        if (timeWindow && timeWindow !== 'day') body.search_recency_filter = timeWindow;
      } else if (name === 'aliyun') {
        endpoint = 'https://cloud-iqs.aliyuncs.com/search/unified';
        body = { query, engineType: 'CNLiteBasic', timeRange: { day: 'OneDay', week: 'OneWeek', month: 'OneMonth', year: 'OneYear' }[timeWindow] ?? 'NoLimit',
          advancedParams: { numResults: String(maxResults) }, contents: { mainText: false, markdownText: false, summary: false } };
      } else {
        endpoint = 'https://wsa.tencentcloudapi.com/';
        api = { action: 'SearchPro', version: '2025-05-08' };
        body = { Query: query, ...(site ? { Site: site } : {}),
          ...(timeWindow ? { Freshness: { day: 'd1', week: 'd7', month: 'm1', year: 'y1' }[timeWindow] } : {}) };
        // lite does not support Cnt/Mode; cap locally, and reject other billed account versions.
      }
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          reject(failure('timeout'));
          controller.abort();
        }, timeoutMs);
      });
      let response;
      try {
        const pending = Promise.resolve().then(() => transport({ endpoint, api, body, maxResponseBytes, signal: controller.signal }))
          .catch(() => { throw failure('transport_error'); });
        response = await Promise.race([pending, deadline]);
      } finally { clearTimeout(timer); }
      if (!Number.isInteger(response?.status) || typeof response.body !== 'string') throw failure('invalid_response');
      if (Buffer.byteLength(response.body, 'utf8') > maxResponseBytes) throw failure('response_too_large');
      if (response.status === 401 || response.status === 403) throw failure('authentication');
      if (response.status === 429) throw failure('rate_limited');
      if (response.status < 200 || response.status >= 300) throw failure('upstream_error');
      let data;
      try { data = JSON.parse(response.body); } catch { throw failure('invalid_response'); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw failure('invalid_response');
      if (name === 'tencent' && Object.hasOwn(data.Response ?? {}, 'Error') &&
          (typeof data.Response.Error?.Code !== 'string' || !data.Response.Error.Code)) throw failure('invalid_response');
      const code = data.Response?.Error?.Code ?? data.code ?? data.Code;
      if (code != null) {
        const kind = /Unauthorized|Auth|AccessKey/i.test(String(code)) ? 'authentication' : /Limit|Throttl/i.test(String(code)) ? 'rate_limited' : 'upstream_error';
        throw failure(kind);
      }
      if (name === 'tencent' && data.Response?.Version !== 'lite') throw failure('provider_version_mismatch');
      let items = name === 'baidu' ? data.references : name === 'aliyun' ? data.pageItems : data.Response?.Pages;
      if (!Array.isArray(items)) throw failure('invalid_response');
      try {
        if (name === 'tencent') items = items.map(item => {
          if (typeof item !== 'string') throw new TypeError('Pages must contain strings');
          return JSON.parse(item);
        });
        return items.map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw new TypeError('invalid record');
          const date = name === 'aliyun' ? item.publishedTime : item.date;
          if (date != null && typeof date !== 'string') throw new TypeError('invalid date');
          return normalizeProviderResult({
            title: item.title,
            url: name === 'aliyun' ? item.link : item.url,
            snippet: name === 'baidu' ? item.content : name === 'tencent' ? item.passage : item.snippet,
            source: name === 'baidu' ? item.website : name === 'tencent' ? item.site : item.hostname,
            claimed_date: date?.trim() || null,
          }, name);
        }).slice(0, maxResults);
      } catch { throw failure('invalid_response'); }
    },
  });
}
