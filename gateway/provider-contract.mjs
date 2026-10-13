const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * DAY_MS;

export const DEFAULT_PROVIDER_LIMITS = Object.freeze({
  baidu: Object.freeze({ dailyCalls: 100, monthlyCents: 0 }),
  aliyun: Object.freeze({ dailyCalls: 20, monthlyCents: 500 }),
  tencent: Object.freeze({ dailyCalls: 12, monthlyCents: 500 }),
});

export const DEFAULT_GLOBAL_MONTHLY_CENTS = 1000;

export function normalizeProviderResult(item, provider) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw new TypeError('provider result must be an object');
  }
  if (typeof provider !== 'string' || !provider.trim()) {
    throw new TypeError('provider must be a non-empty string');
  }
  if (typeof item.title !== 'string' || typeof item.url !== 'string') {
    throw new TypeError('provider result requires string title and url');
  }
  let url;
  try {
    url = new URL(item.url);
  } catch {
    throw new TypeError('provider result url must be absolute HTTP(S)');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TypeError('provider result url must be absolute HTTP(S)');
  }
  if (item.snippet != null && typeof item.snippet !== 'string') {
    throw new TypeError('provider result snippet must be a string when present');
  }
  if (item.source != null && typeof item.source !== 'string') {
    throw new TypeError('provider result source must be a string when present');
  }
  if (item.claimed_date != null && typeof item.claimed_date !== 'string') {
    throw new TypeError('provider result claimed_date must be a string when present');
  }
  return Object.freeze({
    title: item.title,
    url: url.href,
    snippet: item.snippet ?? '',
    source: item.source ?? url.hostname,
    claimed_date: item.claimed_date ?? null,
    provider: provider.trim(),
    date_status: item.claimed_date ? 'claimed' : 'unknown',
  });
}

export function classifyClaimedDate(claimedDate) {
  return typeof claimedDate === 'string' && claimedDate.trim() ? 'claimed' : 'unknown';
}

export function providerCacheKey({ query, mode = 'general', timeWindow = null }) {
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('query must be non-empty');
  if (typeof mode !== 'string' || !mode.trim()) throw new TypeError('mode must be non-empty');
  return JSON.stringify([query.trim().normalize('NFKC').replace(/\s+/gu, ' '), mode.trim(), timeWindow]);
}

export function providerCacheTtlMs(mode, timeWindow = null) {
  if (mode === 'strict' && timeWindow === 'day') return 60 * 60 * 1000;
  if (mode === 'news') return 2 * 60 * 60 * 1000;
  return DAY_MS;
}

export function cacheEntryIsFresh(entry, now = Date.now()) {
  return Boolean(entry && Number.isFinite(entry.createdAt) && Number.isFinite(entry.ttlMs) &&
    entry.createdAt <= now && now < entry.createdAt + entry.ttlMs);
}

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

function utcMonth(now) {
  return new Date(now).toISOString().slice(0, 7);
}

function cents(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer number of cents`);
  return value;
}

function requiresPaidEstimate(provider) {
  return provider === 'aliyun' || provider === 'tencent';
}

export function createBudgetLedger({
  limits = DEFAULT_PROVIDER_LIMITS,
  globalMonthlyCents = DEFAULT_GLOBAL_MONTHLY_CENTS,
  now = () => Date.now(),
} = {}) {
  const globalCap = cents(globalMonthlyCents, 'globalMonthlyCents');
  const usage = new Map();
  let globalMonth = null;
  let globalSpent = 0;

  function period(provider, timestamp) {
    const day = utcDay(timestamp);
    const month = utcMonth(timestamp);
    let state = usage.get(provider);
    if (!state) {
      state = { day, month, dailyCalls: 0, monthlyCents: 0 };
      usage.set(provider, state);
    }
    if (state.day !== day) {
      state.day = day;
      state.dailyCalls = 0;
    }
    if (state.month !== month) {
      state.month = month;
      state.monthlyCents = 0;
    }
    if (globalMonth !== month) {
      globalMonth = month;
      globalSpent = 0;
    }
    return state;
  }

  return Object.freeze({
    reserve(provider, estimatedCents) {
      if (typeof provider !== 'string' || !provider.trim()) throw new TypeError('provider must be non-empty');
      const name = provider.trim();
      const cost = cents(estimatedCents ?? (requiresPaidEstimate(name) ? undefined : 0), 'estimatedCents');
      if (requiresPaidEstimate(name) && cost === 0) {
        throw new TypeError('paid providers require a positive estimatedCents reservation');
      }
      const limit = limits[name];
      if (!limit) return { allowed: false, reason: 'provider_unconfigured' };
      const timestamp = now();
      if (!Number.isFinite(timestamp)) throw new TypeError('budget clock must return a finite timestamp');
      const state = period(name, timestamp);
      const dailyCap = limit.dailyCalls ?? Infinity;
      const providerCap = cents(limit.monthlyCents, `${name}.monthlyCents`);
      if (state.dailyCalls + 1 > dailyCap || state.monthlyCents + cost > providerCap || globalSpent + cost > globalCap) {
        return { allowed: false, reason: 'budget_exhausted' };
      }
      state.dailyCalls += 1;
      state.monthlyCents += cost;
      globalSpent += cost;
      return { allowed: true, dayCalls: state.dailyCalls, providerMonthlyCents: state.monthlyCents, globalMonthlyCents: globalSpent };
    },
    snapshot() {
      const timestamp = now();
      if (!Number.isFinite(timestamp)) throw new TypeError('budget clock must return a finite timestamp');
      period('', timestamp);
      return Object.freeze({
        month: globalMonth,
        globalMonthlyCents: globalSpent,
        providers: Object.freeze(Object.fromEntries([...usage].filter(([name]) => name).map(([name, state]) => [name, Object.freeze({ ...state })]))),
      });
    },
  });
}

export async function runOrderedFallback({ providers, query, budget, estimateCostCents }) {
  if (!Array.isArray(providers) || !budget || typeof budget.reserve !== 'function') {
    throw new TypeError('providers and a budget ledger are required');
  }
  if (estimateCostCents !== undefined && typeof estimateCostCents !== 'function') {
    throw new TypeError('estimateCostCents must be a function when provided');
  }
  const attempts = [];
  for (const provider of providers) {
    if (!provider || typeof provider.name !== 'string' || typeof provider.search !== 'function') {
      throw new TypeError('each provider requires a name and search function');
    }
    if (provider.enabled === false) {
      attempts.push({ provider: provider.name, status: 'provider_unconfigured' });
      continue;
    }
    const name = provider.name.trim();
    const estimate = estimateCostCents?.(name);
    if (requiresPaidEstimate(name) && (estimate == null || estimate === 0)) {
      attempts.push({ provider: provider.name, status: 'cost_estimate_required' });
      continue;
    }
    // Configuration/clock errors are explicit; only search failures trigger fallback.
    const reservation = budget.reserve(provider.name, estimate);
    if (!reservation.allowed) {
      attempts.push({ provider: provider.name, status: reservation.reason });
      continue;
    }
    try {
      const results = await provider.search(query);
      if (!Array.isArray(results)) throw new TypeError('provider search must return an array');
      const normalized = results.map(item => normalizeProviderResult(item, provider.name));
      attempts.push({ provider: provider.name, status: normalized.length ? 'success' : 'empty' });
      if (normalized.length) return { results: normalized, attempts };
    } catch {
      attempts.push({ provider: provider.name, status: 'error' });
    }
  }
  return { results: [], attempts };
}
