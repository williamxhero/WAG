import { evaluateSpec82Evidence } from './spec82-evidence.mjs';
import { resolveNewsWindow } from './news-verified.mjs';
import { normalizeUrlForDedup, filterLowQualityResults } from './evidence-metadata.mjs';
import { createBudgetedProviderSearch, createPersistentBudgetLedger } from './provider-budget.mjs';
import { createProviderHttpTransport } from './provider-http-transport.mjs';
import { createProviderAdapter } from './provider-adapters.mjs';
import { lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import path from 'node:path';

export const PROVIDER_BUDGET_PATH = '/data/web-access-gateway/data/provider-budget/budget.sqlite';
export const PROVIDER_SECRET_PATH = '/data/web-access-gateway/secrets/search-providers.env';
const NAMES = ['baidu', 'aliyun', 'tencent'];

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('Search deadline exceeded'), { kind: 'timeout' }));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

function privateDirectory(directory) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' &&
      ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) throw new Error('unsafe provider directory');
}

const CREDENTIAL_KEYS = ['APPBUILDER_API_KEY', 'IQS_API_KEY', 'TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'];
const CREDENTIAL_FIELDS = { baidu: ['APPBUILDER_API_KEY'], aliyun: ['IQS_API_KEY'], tencent: ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'] };

export function loadProviderCredentials(filename) {
  const parent = path.dirname(filename);
  const directory = lstatSync(parent);
  if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(parent) !== path.resolve(parent) ||
      (process.platform !== 'win32' && ((directory.mode & 0o022) !== 0 || directory.uid !== process.getuid()))) throw new Error('provider_configuration_error');
  const info = lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384 ||
      (process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid()))) throw new Error('provider_configuration_error');
  let handle;
  let bytes;
  try {
    handle = openSync(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(handle);
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw new Error('provider_configuration_error');
    bytes = Buffer.alloc(16385);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(handle, bytes, offset, bytes.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > 16384) throw new Error('provider_configuration_error');
    bytes = bytes.subarray(0, offset);
  } finally { if (handle !== undefined) closeSync(handle); }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) throw new Error('provider_configuration_error');
    const [, key, raw] = match;
    if (!CREDENTIAL_KEYS.includes(key)) continue;
    if (Object.hasOwn(values, key)) throw new Error('provider_configuration_error');
    const value = raw.startsWith('"') || raw.startsWith("'") ? raw.slice(1, -1) : raw;
    if ((raw.startsWith('"') || raw.startsWith("'")) && raw.at(-1) !== raw[0]) throw new Error('provider_configuration_error');
    if (!/^[\x21-\x7e]{1,4096}$/.test(value) || /[\s$`\\;"']/.test(value)) throw new Error('provider_configuration_error');
    values[key] = value;
  }
  return Object.freeze(values);
}

// Paths and request are trusted test dependencies, never environment/CLI controls.
export function createSearchProviderRuntime({ env = process.env, databasePath = PROVIDER_BUDGET_PATH, secretPath = PROVIDER_SECRET_PATH, now = Date.now, request } = {}) {
  const credentialsEnv = { ...env };
  const needFile = NAMES.filter(name => env[`WAG_SEARCH_${name.toUpperCase()}_ENABLED`] === '1' &&
    CREDENTIAL_FIELDS[name].some(key => !Object.hasOwn(env, key)));
  let fileFailed = false;
  if (needFile.length) {
    try { for (const [key, value] of Object.entries(loadProviderCredentials(secretPath))) if (!Object.hasOwn(env, key)) credentialsEnv[key] = value; }
    catch { fileFailed = true; }
  }
  const evidencePolicy = env.WAG_SEARCH_EVIDENCE_POLICY === 'spec82_page_only' ? 'spec82_page_only' : 'spec78_legacy';
  const unavailable = {};
  const configured = [];
  const costs = {};
  for (const name of NAMES) {
    if (env[`WAG_SEARCH_${name.toUpperCase()}_ENABLED`] !== '1') { unavailable[name] = 'provider_unconfigured'; continue; }
    if (fileFailed && needFile.includes(name)) { unavailable[name] = 'provider_configuration_error'; continue; }
    const credentials = name === 'tencent' ? { secretId: credentialsEnv.TENCENTCLOUD_SECRET_ID, secretKey: credentialsEnv.TENCENTCLOUD_SECRET_KEY }
      : { apiKey: credentialsEnv[name === 'baidu' ? 'APPBUILDER_API_KEY' : 'IQS_API_KEY'] };
    if (Object.values(credentials).some(value => typeof value !== 'string' || !value)) { unavailable[name] = 'provider_unconfigured'; continue; }
    try {
      const tariff = name === 'baidu' ? { confirmed: env.WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED === '1', freeQuotaOnly: true }
        : { confirmed: env.WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED === '1', version: name === 'aliyun' ? 'CNLiteBasic' : 'documented-max', costCents: name === 'aliyun' ? 1 : 3 };
      const nativeTransport = createProviderHttpTransport({ name, credentials, tariff, now, ...(request ? { request } : {}) });
      let currentSignal;
      const transport = Object.freeze(Object.assign(input => nativeTransport({ ...input,
        signal: currentSignal ? AbortSignal.any([input.signal, currentSignal]) : input.signal }), { estimatedCostCents: nativeTransport.estimatedCostCents }));
      costs[name] = transport.estimatedCostCents;
      const adapter = createProviderAdapter({ name, enabled: true, transport, ...(name === 'tencent' ? { site: 'mp.weixin.qq.com',
        tencentCostPolicy: Object.freeze({ transport, version: 'documented-max', costCents: transport.estimatedCostCents }) } : {}) });
      configured.push(Object.freeze({ name, enabled: true, cacheIdentity: input => adapter.cacheIdentity(input),
        get posteriorVersion() { return adapter.posteriorVersion; },
        async search(input) { currentSignal = input.signal; try { return await adapter.search(input); } finally { currentSignal = undefined; } } }));
    } catch { unavailable[name] = 'provider_configuration_error'; }
  }
  let budget;
  if (configured.length) {
    try { privateDirectory(path.dirname(databasePath)); budget = createPersistentBudgetLedger({ databasePath, now }); }
    catch { for (const provider of configured) unavailable[provider.name] = 'budget_storage_error'; }
  }
  const router = createProviderRouting({ providers: budget ? configured : [], budget, now,
    unavailable, estimateCostCents: name => costs[name] });
  return Object.freeze({ evidencePolicy, active: NAMES.some(name => env[`WAG_SEARCH_${name.toUpperCase()}_ENABLED`] === '1'),
    search: input => router.search(input), dispatch: input => router.dispatch(input), close: () => budget?.close() });
}

export function createProviderRouting({ now = Date.now, providers = [], budget, estimateCostCents, unavailable = {},
  maxCandidates = 20, pageTimeoutMs = 10000 } = {}) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 10 || maxCandidates > 20 ||
      !Number.isInteger(pageTimeoutMs) || pageTimeoutMs < 1 || pageTimeoutMs > 10000) throw new TypeError('invalid page limits');
  const costs = Object.fromEntries(providers.map(provider => {
    const cost = estimateCostCents?.(provider.name) ?? { baidu: 0, aliyun: 1 }[provider.name];
    if (provider.enabled !== false && (!Number.isSafeInteger(cost) || cost < ({ baidu: 0, aliyun: 1, tencent: 3 }[provider.name]) ||
        (provider.name === 'baidu' && cost !== 0))) throw new TypeError('invalid frozen provider estimate');
    return [provider.name, cost];
  }));
  Object.freeze(costs);
  const adapters = new Map(providers.map(provider => [provider.name, provider]));
  if (adapters.size !== providers.length) throw new TypeError('duplicate providers');
  const dispatchers = new Map(providers.map(provider => [provider.name,
    createBudgetedProviderSearch({ providers: [provider], budget, now, estimateCostCents: name => costs[name] })]));
  const pageCache = new Map();
  const inFlight = new Map();
  let serial = Promise.resolve();
  function snapshot() { try { return budget?.snapshot() ?? null; } catch { return null; } }
  function emptyResult(provider, status) {
    return { results: [], attempts: [{ provider, status }], posterior_version: null, provider_budget: snapshot() };
  }
  function createFlight(key, provider, input) {
    const controller = new AbortController();
    const entry = { controller, waiters: new Set(), started: false, operation: null };
    const dispatcher = dispatchers.get(provider);
    entry.operation = serial.then(async () => {
      if (entry.waiters.size === 0) return emptyResult(provider, 'timeout');
      entry.started = true;
      try {
        const result = await dispatcher({ ...input, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        const version = adapters.get(provider).posteriorVersion;
        return { ...result, posterior_version: result.attempts.some(item => item.status === 'success') &&
          ['lite', 'standard', 'flagship'].includes(version) ? version : null, provider_budget: snapshot() };
      } catch (error) { return emptyResult(provider, error.kind === 'budget_clock_regression' ? error.kind : 'budget_storage_error'); }
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, entry);
    serial = entry.operation.then(() => {}, () => {});
    return entry;
  }
  function waitForFlight(entry, callerSignal, provider) {
    if (callerSignal?.aborted) return Promise.resolve(emptyResult(provider, 'timeout'));
    const waiter = { aborted: false };
    entry.waiters.add(waiter);
    return new Promise(resolve => {
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        entry.waiters.delete(waiter);
        callerSignal?.removeEventListener('abort', abort);
        resolve(value);
      };
      const abort = () => {
        waiter.aborted = true;
        entry.waiters.delete(waiter);
        if (entry.waiters.size === 0) entry.controller.abort();
        finish(emptyResult(provider, 'timeout'));
      };
      callerSignal?.addEventListener('abort', abort, { once: true });
      entry.operation.then(result => finish(result), () => finish(emptyResult(provider, 'transport_error')));
    });
  }
  async function dispatchOne({ provider, signal: callerSignal, ...input }) {
    const dispatcher = dispatchers.get(provider);
    if (!dispatcher) return emptyResult(provider, unavailable[provider] ?? 'provider_unconfigured');
    if (callerSignal?.aborted) return emptyResult(provider, 'timeout');
    const key = adapters.get(provider).cacheIdentity(input).key;
    let entry = inFlight.get(key);
    if (!entry) {
      if (inFlight.size >= 64) return emptyResult(provider, 'provider_capacity_exhausted');
      entry = createFlight(key, provider, input);
    }
    return waitForFlight(entry, callerSignal, provider);
  }
  return Object.freeze({
    dispatch: dispatchOne,
    async search({ input, results, signal: callerSignal, verifyPage, strict = false }) {
      const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
      const checkedAt = new Date(now()).toISOString();
      const window = resolveNewsWindow({ window: input.news_window ?? 'rolling_24h', now: now() });
      const days = { week: 7, month: 31, year: 366 }[input.time_range];
      if (days) {
        window.window = 'rolling_24h';
        window.window_timezone = 'UTC';
        window.window_date = null;
        window.start = new Date(now() - days * 86400000).toISOString();
      }
      const candidates = new Map();
      const evaluated = new Map();
      const attempts = [];
      let reads = 0;
      let pageRemainingMs = pageTimeoutMs;
      const pageLimit = strict ? Math.min(maxCandidates, input.news_max_reads ?? maxCandidates) : 20;
      const readFailures = [];
      const bindingFailures = [];
      const wechat = /公众号|微信文章|微信公众号|\bwechat\b|mp\.weixin\.qq\.com/i.test(input.query);
      function merge(items, provider, limit = 20) {
        for (const item of items) {
          const key = normalizeUrlForDedup(item.url);
          const existing = candidates.get(key);
          if (existing) {
            if (!existing.providers.includes(provider)) existing.providers.push(provider);
          } else if (candidates.size < limit) {
            candidates.set(key, { ...item, provider, providers: [provider] });
          }
        }
      }
      async function evaluate() {
        const pending = [...candidates].filter(([key]) => !evaluated.has(key));
        const controller = new AbortController();
        const pageSignal = AbortSignal.any([signal, controller.signal]);
        function pageBinding(page, candidate) {
          const requested = candidate.url;
          const sourceUrl = page?.source?.url;
          const finalUrl = page?.final_url ?? sourceUrl;
          if (typeof sourceUrl !== 'string' || typeof finalUrl !== 'string' ||
              !/^https?:\/\//i.test(sourceUrl) || !/^https?:\/\//i.test(finalUrl) || sourceUrl !== finalUrl ||
              (normalizeUrlForDedup(finalUrl) !== normalizeUrlForDedup(requested) &&
                !(page?.redirect_validated === true && page?.requested_url &&
                  normalizeUrlForDedup(page.requested_url) === normalizeUrlForDedup(requested)))) {
            bindingFailures.push({ url: requested, code: 'page_identity_mismatch' });
            return null;
          }
          return { page, finalUrl };
        }
        const started = Date.now();
        const timer = setTimeout(() => controller.abort(), Math.max(1, pageRemainingMs));
        let index = 0;
        async function worker() {
          while (index < pending.length) {
            const [key, candidate] = pending[index++];
            let page = {};
            let failed = false;
            if (strict && typeof verifyPage === 'function' && !pageSignal.aborted && pageRemainingMs > 0) {
              const cacheKey = JSON.stringify([key, input.news_render ?? 'never']);
              const cached = pageCache.get(cacheKey);
              if (cached && cached.at <= now() && now() - cached.at < 7 * 86400000) page = cached.page;
              else if (reads < pageLimit) {
                pageCache.delete(cacheKey);
                reads++;
                try {
                  page = await abortable(() => verifyPage(candidate, { signal: pageSignal, render: input.news_render ?? 'never' }), pageSignal);
                  if (!pageBinding(page, candidate)) page = {};
                  if (!pageSignal.aborted && page.source?.url && Buffer.byteLength(JSON.stringify(page)) <= 262144) {
                    if (pageCache.size >= 100) pageCache.delete(pageCache.keys().next().value);
                    pageCache.set(cacheKey, { page: JSON.parse(JSON.stringify(page)), at: now() });
                  }
                } catch {
                  page = {};
                  failed = true;
                  readFailures.push({ url: candidate.url, error_kind: pageSignal.aborted ? 'timeout' : 'read_error', error_code: null });
                }
              }
            }
            const evidence = evaluateSpec82Evidence(page, window, { auxiliary: candidate.temporal_evidence, checked_at: checkedAt });
            evaluated.set(key, { ...candidate, content: candidate.content.replace(/^\[WAG publisher [^\n]*\]\n/, ''),
              ...(page.source?.url ? { final_url: page.final_url ?? page.source.url, source: { ...candidate.source, ...page.source } } : {}),
              date_level: evidence.evidence_level, state: failed ? 'read_failure' : evidence.status,
              policy: 'spec82_page_only', spec82_evidence: evidence, published_at: evidence.published_at,
              published_on: evidence.published_on, precision: evidence.precision,
              ...(input.time_range ? { time_range_status: evidence.status === 'verified' ? 'within' : evidence.status === 'out_of_window' ? 'outside' : 'unverified' } : {}) });
          }
        }
        try { await Promise.all([worker(), worker()]); }
        finally { clearTimeout(timer); if (strict) pageRemainingMs = Math.max(0, pageRemainingMs - (Date.now() - started)); }
      }
      function fusedResults() {
        const unique = new Map();
        for (const item of evaluated.values()) {
          const key = normalizeUrlForDedup(item.final_url ?? item.url);
          const previous = unique.get(key);
          if (!previous) {
            unique.set(key, { ...item, url: item.final_url ?? item.url,
              requested_urls: [item.url], providers: [...item.providers] });
          } else {
            if (!previous.requested_urls.includes(item.url)) previous.requested_urls.push(item.url);
            previous.providers = [...new Set([...previous.providers, ...item.providers])];
            if (previous.published_at !== item.published_at || previous.published_on !== item.published_on || previous.state !== item.state) {
              previous.state = 'unknown';
              previous.published_at = null;
              previous.published_on = null;
              previous.precision = null;
              previous.spec82_evidence = { ...previous.spec82_evidence, status: 'unknown', reason: 'conflicting_evidence' };
            }
          }
        }
        return [...unique.values()];
      }
      const verifiedCount = () => fusedResults().filter(item => item.state === 'verified').length;
      async function dispatch(name) {
        if (signal?.aborted) { attempts.push({ provider: name, status: 'timeout' }); return; }
        const dispatcher = dispatchers.get(name);
        if (!dispatcher) { attempts.push({ provider: name, status: unavailable[name] ?? 'provider_unconfigured' }); return; }
        if (candidates.size >= pageLimit || (strict && (pageRemainingMs <= 0 || typeof verifyPage !== 'function'))) {
          attempts.push({ provider: name, status: 'verification_budget_exhausted' }); return;
        }
        const response = await dispatchOne({ provider: name, query: input.query,
          mode: strict ? 'strict' : input.news_mode ? 'news' : 'general', timeWindow: input.time_range ?? (strict ? 'day' : null), signal });
        attempts.push(...response.attempts.map(item => ({ ...item, ...(response.posterior_version ? { posterior_version: response.posterior_version } : {}) })));
        const items = response.results.map(item => ({ title: item.title, url: item.url, content: item.snippet,
          engine: null, category: null, retrieved_at: checkedAt, source: { url: item.url, host: new URL(item.url).hostname, search_engine: null },
          temporal_evidence: [...(item.claimed_date ? [{ kind: 'published_at', value: item.claimed_date, precision: 'instant', source: `provider.${name}.claimed_date` }] : []),
            { kind: 'retrieved_at', value: checkedAt, source: 'gateway.clock' }] }));
        const share = strict && name !== 'tencent'
          ? Math.max(0, pageLimit - (name === 'baidu' ? Math.ceil(pageLimit / 4) : 0) - (wechat ? 2 : 0)) : pageLimit;
        merge(filterLowQualityResults(items).results, name, share);
        await evaluate();
      }
      // Leave verification capacity for paid candidates before reserving their quota.
      merge(results, 'searxng', strict || wechat ? Math.floor(pageLimit / 2) : pageLimit);
      await evaluate();
      if (candidates.size === 0 || (strict && verifiedCount() < 3)) await dispatch('baidu');
      if (strict && verifiedCount() < 3) await dispatch('aliyun');
      if (wechat) await dispatch('tencent');
      const all = fusedResults();
      let providerBudget = null;
      try { providerBudget = budget?.snapshot() ?? null; } catch { /* Unknown is not zero. */ }
      return { provider_budget: providerBudget, results: strict ? all.filter(item => item.state === 'verified') : all, evidence_policy: 'spec82_page_only', provider_attempts: attempts,
        page_verification: { candidate_count: candidates.size, read_attempts: reads, verified_count: verifiedCount(), read_failures: readFailures, binding_failures: bindingFailures } };
    },
  });
}
