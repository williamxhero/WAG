import { normalizeProviderResult, projectProviderDiagnostic, providerCacheKey, providerCacheTtlMs } from './provider-contract.mjs';

function failure(kind, diagnostic = null) {
  const safeDiagnostic = projectProviderDiagnostic(diagnostic);
  return Object.assign(new Error(`Provider search failed: ${kind}`), { kind,
    ...(safeDiagnostic ? { diagnostic: safeDiagnostic } : {}) });
}

function resultWithDiagnostic(items, diagnostic) {
  Object.defineProperty(items, 'diagnostic', { value: projectProviderDiagnostic(diagnostic), enumerable: false });
  return items;
}

function valueType(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
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
  maxResponseBytes = 256 * 1024, maxResults = 10, timeoutMs = 5000, tencentCostPolicy } = {}) {
  if (!['baidu', 'aliyun', 'tencent'].includes(name)) throw new TypeError('unknown provider');
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1024 * 1024) throw new TypeError('invalid response byte limit');
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) throw new TypeError('invalid result limit');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('invalid provider timeout');
  if (site !== null && (name !== 'tencent' || typeof site !== 'string' || !/^[a-z0-9.-]+$/i.test(site))) throw new TypeError('invalid provider site');
  if (tencentCostPolicy !== undefined && (name !== 'tencent' || !Object.isFrozen(tencentCostPolicy) ||
      tencentCostPolicy.transport !== transport || !Object.isFrozen(transport) || tencentCostPolicy.version !== 'documented-max' ||
      !Number.isSafeInteger(transport?.estimatedCostCents) || transport.estimatedCostCents < 3 ||
      tencentCostPolicy.costCents !== transport.estimatedCostCents)) throw new TypeError('invalid Tencent cost binding');
  let posteriorVersion = null;
  let lastDiagnostic = null;
  return Object.freeze({
    name,
    get posteriorVersion() { return posteriorVersion; },
    get diagnostic() { return lastDiagnostic; },
    get enabled() { return enabled === true && typeof transport === 'function'; },
    cacheIdentity(input) {
      const value = inputQuery(input);
      return { key: JSON.stringify([name, site, maxResults, value.key]), ttlMs: providerCacheTtlMs(value.mode, value.timeWindow) };
    },
    async search(input) {
      posteriorVersion = null;
      lastDiagnostic = null;
      const { query, timeWindow } = inputQuery(input);
      if (enabled !== true || typeof transport !== 'function') throw failure('provider_unconfigured');
      const tencentDiagnostic = name === 'tencent';
      const diagnoseFailure = (kind, diagnostic) => {
        if (tencentDiagnostic) lastDiagnostic = projectProviderDiagnostic({ ...diagnostic, kind });
        throw failure(kind, tencentDiagnostic ? lastDiagnostic : null);
      };
      let stage = tencentDiagnostic ? 'transport' : null;
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
          const diagnostic = tencentDiagnostic ? { stage: 'transport', kind: 'timeout', auth_success: null } : null;
          lastDiagnostic = projectProviderDiagnostic(diagnostic);
          reject(failure('timeout', lastDiagnostic));
          controller.abort();
        }, timeoutMs);
      });
      let response;
      try {
        const pending = Promise.resolve().then(() => transport({ endpoint, api, body, maxResponseBytes, signal: controller.signal }))
          .catch(error => {
            const safeKinds = new Set(['authentication', 'invalid_response', 'provider_version_mismatch', 'rate_limited',
              'response_too_large', 'timeout', 'transport_error', 'upstream_error']);
            const kind = safeKinds.has(error?.kind) ? error.kind : 'transport_error';
            const diagnostic = tencentDiagnostic ? { stage: 'transport', kind, auth_success: null } : null;
            lastDiagnostic = projectProviderDiagnostic(diagnostic);
            throw failure('transport_error', lastDiagnostic);
          });
        response = await Promise.race([pending, deadline]);
      } finally { clearTimeout(timer); }
      const fail = (kind, diagnostic = null) => diagnoseFailure(kind, diagnostic ?? { stage: stage ?? 'transport', auth_success: null });
      if (!Number.isInteger(response?.status) || typeof response.body !== 'string') fail('invalid_response');
      if (Buffer.byteLength(response.body, 'utf8') > maxResponseBytes) fail('response_too_large');
      if (response.status === 401 || response.status === 403) fail('authentication', tencentDiagnostic ? { stage: 'transport', auth_success: false } : null);
      if (response.status === 429) fail('rate_limited');
      if (response.status < 200 || response.status >= 300) fail('upstream_error');
      let data;
      try { data = JSON.parse(response.body); } catch { fail('invalid_response', tencentDiagnostic ? { stage: 'response_json', response_type: 'string', auth_success: null } : null); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid_response', tencentDiagnostic ? { stage: 'response_json', response_type: valueType(data), auth_success: null } : null);
      if (tencentDiagnostic) stage = 'response_envelope';
      if (name === 'tencent' && (!data.Response || typeof data.Response !== 'object' || Array.isArray(data.Response))) {
        fail('invalid_response', { stage: 'response_envelope', envelope_type: valueType(data.Response), auth_success: null });
      }
      if (name === 'tencent' && Object.hasOwn(data.Response ?? {}, 'Error')) {
        if (typeof data.Response.Error?.Code !== 'string' || !data.Response.Error.Code) {
          fail('invalid_response', { stage: 'response_envelope', envelope_type: 'object', auth_success: null });
        }
        const code = data.Response.Error.Code;
        const kind = /Unauthorized|Auth|AccessKey/i.test(code) ? 'authentication' : /Limit|Throttl/i.test(code) ? 'rate_limited' : 'upstream_error';
        fail(kind, { stage: 'response_envelope', envelope_type: 'object', auth_success: kind === 'authentication' ? false : null });
      }
      const code = data.Response?.Error?.Code ?? data.code ?? data.Code;
      if (code != null) {
        const kind = /Unauthorized|Auth|AccessKey/i.test(String(code)) ? 'authentication' : /Limit|Throttl/i.test(String(code)) ? 'rate_limited' : 'upstream_error';
        fail(kind);
      }
      if (tencentDiagnostic) stage = 'version_validation';
      let version;
      if (name === 'tencent') {
        version = data.Response?.Version;
        if (tencentCostPolicy ? !['lite', 'standard', 'flagship'].includes(version) || response.tencentVersion !== version : version !== 'lite') {
          fail('provider_version_mismatch', { stage: 'version_validation', envelope_type: 'object', version_type: valueType(version), auth_success: null });
        }
      }
      if (tencentDiagnostic) stage = 'pages_array';
      let items = name === 'baidu' ? data.references : name === 'aliyun' ? data.pageItems : data.Response?.Pages;
      if (!Array.isArray(items)) fail('invalid_response', tencentDiagnostic ? { stage: 'pages_array', pages_type: valueType(items), auth_success: null } : null);
      const pageCount = items.length;
      let parsedPageCount = 0;
      if (tencentDiagnostic) stage = 'page_json';
      try {
        if (name === 'tencent') {
          const pages = [];
          for (const item of items) {
            if (typeof item !== 'string') throw Object.assign(new TypeError(), { stage: 'pages_array', pageType: valueType(item) });
            try { pages.push(JSON.parse(item)); parsedPageCount++; }
            catch { throw Object.assign(new TypeError(), { stage: 'page_json', pageType: 'string' }); }
          }
          items = pages;
        }
        if (tencentDiagnostic) stage = 'record_validation';
        const normalized = items.map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) throw Object.assign(new TypeError(), { recordType: valueType(item) });
          const date = name === 'aliyun' ? item.publishedTime : item.date;
          if (date != null && typeof date !== 'string') throw Object.assign(new TypeError(), { recordType: valueType(item) });
          return normalizeProviderResult({
            title: item.title,
            url: name === 'aliyun' ? item.link : item.url,
            snippet: name === 'baidu' ? item.content : name === 'tencent' ? item.passage : item.snippet,
            source: name === 'baidu' ? item.website : name === 'tencent' ? item.site : item.hostname,
            claimed_date: date?.trim() || null,
          }, name);
        }).slice(0, maxResults);
        if (tencentDiagnostic) {
          lastDiagnostic = projectProviderDiagnostic({ stage: 'complete', auth_success: true, page_count: pageCount,
            parsed_page_count: parsedPageCount, result_count: normalized.length });
          posteriorVersion = version;
          return resultWithDiagnostic(normalized, lastDiagnostic);
        }
        return normalized;
      } catch (error) {
        if (tencentDiagnostic) {
          const stageName = error.stage === 'pages_array' ? 'pages_array' : error.stage === 'page_json' ? 'page_json' : 'record_validation';
          const diagnostic = { stage: stageName, auth_success: null, page_count: pageCount,
            ...(stageName === 'page_json' ? { page_type: error.pageType ?? 'undefined', parsed_page_count: parsedPageCount } : {}),
            ...(stageName === 'pages_array' ? { page_type: error.pageType ?? 'undefined' } : {}),
            ...(stageName === 'record_validation' ? { record_type: error.recordType ?? 'object', parsed_page_count: parsedPageCount } : {}) };
          lastDiagnostic = projectProviderDiagnostic({ ...diagnostic, kind: 'invalid_response' });
          throw failure('invalid_response', lastDiagnostic);
        }
        throw failure('invalid_response');
      }
    },
  });
}
