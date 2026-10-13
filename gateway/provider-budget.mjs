import { DatabaseSync } from 'node:sqlite';
import { closeSync, lstatSync, openSync } from 'node:fs';
import path from 'node:path';
import { cacheEntryIsFresh, normalizeProviderResult, DEFAULT_PROVIDER_LIMITS, DEFAULT_GLOBAL_MONTHLY_CENTS } from './provider-contract.mjs';

const COST_CENTS = Object.freeze({ baidu: 0, aliyun: 1, tencent: 2 });
function budgetError(kind = 'budget_storage_error') {
  return Object.assign(new Error(`Provider budget failed: ${kind}`), { kind });
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw budgetError();
  return value;
}

// One canonical, private, local DB outside replaceable releases. Initialization is explicit and
// exclusive; reopening a missing/damaged ledger must never create new allowance.
export function createPersistentBudgetLedger({ databasePath, initialize = false, now = Date.now,
  globalMonthlyCents = DEFAULT_GLOBAL_MONTHLY_CENTS, busyTimeoutMs = 1000,
  openDatabase = filename => new DatabaseSync(filename) } = {}) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) throw new TypeError('budget requires an absolute database path');
  if (!Number.isSafeInteger(globalMonthlyCents) || globalMonthlyCents < 0 || globalMonthlyCents > DEFAULT_GLOBAL_MONTHLY_CENTS) throw new TypeError('invalid global budget cap');
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 5000) throw new TypeError('invalid SQLite lock timeout');
  if (typeof now !== 'function' || typeof openDatabase !== 'function') throw new TypeError('invalid budget dependencies');
  let db;
  let identity;
  let closed = false;
  try {
    if (initialize) closeSync(openSync(databasePath, 'wx', 0o600));
    identity = lstatSync(databasePath);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) throw budgetError();
    db = openDatabase(databasePath);
    // Install the bounded wait before any pragma that may read a locked schema.
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA synchronous=FULL`);
    if (initialize) db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE daily_usage (provider TEXT NOT NULL, day TEXT NOT NULL, calls INTEGER NOT NULL CHECK(calls>=0), PRIMARY KEY(provider,day)) STRICT;
      CREATE TABLE monthly_usage (provider TEXT NOT NULL, month TEXT NOT NULL, calls INTEGER NOT NULL CHECK(calls>=0), cents INTEGER NOT NULL CHECK(cents>=0), PRIMARY KEY(provider,month)) STRICT;
      CREATE TABLE budget_clock (id INTEGER PRIMARY KEY CHECK(id=1), highwater INTEGER NOT NULL CHECK(highwater>=0)) STRICT;
      INSERT INTO budget_clock VALUES(1,0);
      PRAGMA user_version=1;
      COMMIT;
    `);
    if (db.prepare('PRAGMA user_version').get().user_version !== 1 || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw budgetError();
    integer(db.prepare('SELECT highwater FROM budget_clock WHERE id=1').get()?.highwater);
  } catch {
    try { db?.close(); } catch { /* Keep the original fail-closed result. */ }
    throw budgetError();
  }
  function clock() {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !Number.isFinite(new Date(timestamp).getTime())) throw new TypeError('invalid budget clock');
    const day = new Date(timestamp).toISOString().slice(0, 10);
    return { timestamp, day, month: day.slice(0, 7) };
  }
  function transact(begin, period, job) {
    let active = false;
    try {
      const current = lstatSync(databasePath);
      if (closed || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino) throw budgetError();
      db.exec(begin);
      active = true;
      const highwater = integer(db.prepare('SELECT highwater FROM budget_clock WHERE id=1').get()?.highwater);
      // A backward wall clock freezes dispatch rather than reopening a previously consumed period.
      if (period.timestamp < highwater) throw budgetError('budget_clock_regression');
      const result = job();
      db.exec('COMMIT');
      active = false;
      return result;
    } catch (error) {
      if (active) { try { db.exec('ROLLBACK'); } catch { /* Never authorize after an ambiguous commit. */ } }
      if (error.kind === 'budget_clock_regression') throw error;
      throw budgetError();
    }
  }
  function usage({ day, month }) {
    const providers = {};
    let globalMonthlyCents = 0;
    // quick_check cannot detect a missing counter row. Reconcile retained daily totals before
    // authorizing anything, including an unrelated provider in the same month.
    const dailyTotals = new Map();
    for (const row of db.prepare('SELECT * FROM daily_usage WHERE substr(day,1,7)=?').all(month)) {
      if (!Object.hasOwn(COST_CENTS, row.provider)) throw budgetError();
      const calls = integer(row.calls);
      if (calls === 0 || calls > DEFAULT_PROVIDER_LIMITS[row.provider].dailyCalls) throw budgetError();
      dailyTotals.set(row.provider, integer((dailyTotals.get(row.provider) ?? 0) + calls));
    }
    for (const row of db.prepare('SELECT * FROM monthly_usage WHERE month=?').all(month)) {
      if (!Object.hasOwn(COST_CENTS, row.provider)) throw budgetError();
      const monthlyCents = integer(row.cents);
      const monthlyCalls = integer(row.calls);
      const dailyCalls = integer(db.prepare('SELECT calls FROM daily_usage WHERE provider=? AND day=?').get(row.provider, day)?.calls ?? 0);
      if (monthlyCalls === 0 || monthlyCalls !== dailyTotals.get(row.provider) || monthlyCents > DEFAULT_PROVIDER_LIMITS[row.provider].monthlyCents || dailyCalls > DEFAULT_PROVIDER_LIMITS[row.provider].dailyCalls || monthlyCents < COST_CENTS[row.provider] * monthlyCalls) throw budgetError();
      dailyTotals.delete(row.provider);
      globalMonthlyCents = integer(globalMonthlyCents + monthlyCents);
      providers[row.provider] = { day, month, dailyCalls, monthlyCalls, monthlyCents };
    }
    if (dailyTotals.size || globalMonthlyCents > DEFAULT_GLOBAL_MONTHLY_CENTS) throw budgetError();
    return { month, globalMonthlyCents, providers };
  }
  return Object.freeze({
    kind: 'persistent_sqlite',
    reserve(provider, estimatedCents) {
      if (typeof provider !== 'string' || !provider.trim()) throw new TypeError('invalid provider');
      provider = provider.trim();
      if (!Object.hasOwn(COST_CENTS, provider)) return { allowed: false, reason: 'provider_unconfigured' };
      if (estimatedCents === undefined) estimatedCents = COST_CENTS[provider];
      if (!Number.isSafeInteger(estimatedCents) || estimatedCents < COST_CENTS[provider] || (provider === 'baidu' && estimatedCents !== 0)) throw new TypeError('invalid conservative cost estimate');
      const period = clock();
      return transact('BEGIN IMMEDIATE', period, () => {
        const before = usage(period);
        const current = before.providers[provider] ?? { dailyCalls: 0, monthlyCents: 0 };
        const cap = DEFAULT_PROVIDER_LIMITS[provider];
        db.prepare('UPDATE budget_clock SET highwater=? WHERE id=1').run(period.timestamp);
        if (current.dailyCalls >= cap.dailyCalls || estimatedCents > cap.monthlyCents - current.monthlyCents || estimatedCents > globalMonthlyCents - before.globalMonthlyCents) {
          return { allowed: false, reason: 'budget_exhausted' };
        }
        db.prepare('INSERT INTO daily_usage VALUES(?,?,1) ON CONFLICT(provider,day) DO UPDATE SET calls=calls+1').run(provider, period.day);
        db.prepare('INSERT INTO monthly_usage VALUES(?,?,1,?) ON CONFLICT(provider,month) DO UPDATE SET calls=calls+1,cents=cents+excluded.cents').run(provider, period.month, estimatedCents);
        return { allowed: true, dayCalls: current.dailyCalls + 1, providerMonthlyCents: current.monthlyCents + estimatedCents, globalMonthlyCents: before.globalMonthlyCents + estimatedCents };
      });
    },
    snapshot() {
      const period = clock();
      return transact('BEGIN', period, () => usage(period));
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}

const PROVIDER_FAILURES = new Set(['provider_unconfigured', 'authentication', 'rate_limited', 'upstream_error',
  'invalid_response', 'transport_error', 'timeout', 'response_too_large', 'provider_version_mismatch']);

// Opt-in integration only. Never reuse the offline memory ledger for durable dispatch. Cache loss
// on restart may reduce availability, but the shared on-disk allowance is not reset or refunded.
export function createBudgetedProviderSearch({ providers, budget, now = Date.now, maxCacheEntries = 100,
  estimateCostCents } = {}) {
  if (budget?.kind !== 'persistent_sqlite' || typeof budget.reserve !== 'function') throw new TypeError('persistent budget ledger required');
  if (!Array.isArray(providers) || providers.some(provider => !provider || !Object.hasOwn(COST_CENTS, provider.name) ||
      typeof provider.search !== 'function' || typeof provider.cacheIdentity !== 'function')) throw new TypeError('provider adapters required');
  if (!Number.isInteger(maxCacheEntries) || maxCacheEntries < 1 || maxCacheEntries > 1000 || typeof now !== 'function' ||
      (estimateCostCents !== undefined && typeof estimateCostCents !== 'function')) throw new TypeError('invalid dispatch options');
  const ordered = [...providers];
  const cache = new Map();
  return async input => {
    const attempts = [];
    for (const provider of ordered) {
      if (provider.enabled === false) {
        attempts.push({ provider: provider.name, status: 'provider_unconfigured' });
        continue;
      }
      const { key, ttlMs } = provider.cacheIdentity(input); // Validate before reserving anything.
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new TypeError('invalid cache clock');
      const cached = cache.get(key);
      if (cacheEntryIsFresh(cached, timestamp)) {
        attempts.push({ provider: provider.name, status: 'cache_hit' });
        if (cached.results.length) return { results: [...cached.results], attempts };
        continue;
      }
      cache.delete(key);
      // Storage/configuration failures escape. Only upstream failures may trigger fallback.
      const reservation = budget.reserve(provider.name, estimateCostCents?.(provider.name));
      if (!reservation.allowed) {
        attempts.push({ provider: provider.name, status: reservation.reason });
        continue;
      }
      let results;
      try {
        const items = await provider.search(input);
        if (!Array.isArray(items)) throw budgetError('invalid_response');
        results = Object.freeze(items.map(item => normalizeProviderResult(item, provider.name)));
      } catch (error) {
        attempts.push({ provider: provider.name, status: PROVIDER_FAILURES.has(error.kind) ? error.kind : 'invalid_response' });
        continue;
      }
      if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value);
      cache.set(key, { createdAt: timestamp, ttlMs, results });
      attempts.push({ provider: provider.name, status: results.length ? 'success' : 'empty' });
      if (results.length) return { results: [...results], attempts };
    }
    return { results: [], attempts };
  };
}
