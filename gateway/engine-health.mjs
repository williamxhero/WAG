// Engine supply governance (SPEC issue #74).
//
// SearXNG already carries most of the circuit-breaker behaviour this repository needs: each engine
// owns a `suspended_time` and reports `暂停服务: 验证码` / `暂停服务: 超时` while it is suspended, so a
// failed engine is *not* re-triggered on every request. WAG's minimal job is the rest:
//
//   1. Normalize the raw SearXNG failure strings into a stable enum so cooldown decisions and reports
//      stop depending on Chinese prose.
//   2. Layer the searchable engines into explicit, opt-in pools (general / news / strict) so a
//      `time_range` query only ever asks engines that can actually honour the window — SearXNG
//      silently skips `time_range_support=false` engines, which is what made strict day searches
//      return zero results.
//   3. Add a *bounded, in-memory* local cooldown for the failure classes that arrive *without* a
//      SearXNG `suspended_time` (`timeout` / `upstream_error` / `crash`), so those are not retried on
//      every single request. Nothing is persisted: a process restart forgets everything, which is
//      intentional — WAG never fakes a durable supply state.
//
// Everything in this file is a pure function or a small state machine so it can be unit-tested
// without a real CAPTCHA, a live SearXNG, or shared proxy access.

export const FAILURE_CLASSES = ['captcha', 'timeout', 'rate_limited', 'upstream_error', 'crash', 'forbidden', 'unknown'];

// Raw-reason matchers taken from the SPEC #74 sampling matrix (the exact strings the live engines
// returned), plus their English equivalents for the fixture/HTTP layer. Order matters only in that
// the more specific classes are checked before the generic ones.
const CAPTCHA = /验证码|captcha/i;
const TIMEOUT = /超时|timed?\s*out|timeout/i;
const RATE_LIMITED = /频繁|too many requests|rate[\s_-]?limit/i;
const UPSTREAM_ERROR = /服务器\s*API\s*错误|(?:server|upstream)[\s_-]*(?:api[\s_-]*)?error|bad gateway|service unavailable/i;
const CRASH = /崩溃|crash|panic/i;
const FORBIDDEN = /拒绝访问|forbidden|access denied|blocked/i;

// Map a raw SearXNG failure reason (for example `暂停服务: 验证码`) to a stable class. Anything we do
// not recognize is `unknown` — never silently folded into a class we would act on.
export function classifyFailureReason(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return 'unknown';
  if (CAPTCHA.test(text)) return 'captcha';
  if (TIMEOUT.test(text)) return 'timeout';
  if (RATE_LIMITED.test(text)) return 'rate_limited';
  if (UPSTREAM_ERROR.test(text)) return 'upstream_error';
  if (CRASH.test(text)) return 'crash';
  if (FORBIDDEN.test(text)) return 'forbidden';
  return 'unknown';
}

// Failure counts by class for one response's `unresponsive_engines` list ([engine, reason] pairs).
export function failureClasses(unresponsiveEngines) {
  const counts = {};
  if (!Array.isArray(unresponsiveEngines)) return counts;
  for (const item of unresponsiveEngines) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const failureClass = classifyFailureReason(item[1] ?? '');
    counts[failureClass] = (counts[failureClass] ?? 0) + 1;
  }
  return counts;
}

// `time_range_support` snapshot read from the live `GET /config` (SPEC #74 §1.2). An engine that is
// not listed is treated as *unsupported*: a strict pool must never include an engine SearXNG would
// silently skip, so unknown engines are rejected with the rest rather than trusted.
const TIME_RANGE_SUPPORT = new Map([
  ['quark', true],
  ['chinaso news', true],
  ['baidu images', true],
  ['quark images', true],
  ['naver', true],
  ['yandex', false],
  ['bing', false],
  ['mwmbl', false],
  ['duckduckgo news', false],
]);

export function supportsTimeRange(engine) {
  return TIME_RANGE_SUPPORT.get(String(engine ?? '').trim().toLowerCase()) === true;
}

// Split a strict-layer pool into the engines that can honour a time window and the ones that cannot.
// The rejected engines are surfaced (never silently dropped) so an operator sees why their config
// thinned out in the startup log and in the `engine_pool` diagnostic.
export function validateStrictPool(engines) {
  const kept = [];
  const rejected = [];
  for (const engine of Array.isArray(engines) ? engines : []) {
    (supportsTimeRange(engine) ? kept : rejected).push(engine);
  }
  return { engines: kept, rejected };
}

export const DEFAULT_ENGINE_COOLDOWN_MS = 30000;
export const DEFAULT_ENGINE_STATE_TTL_MS = 90000;

// Failure classes that SearXNG reports *without* a `suspended_time`; only these get a local cooldown.
// `captcha` / `rate_limited` / `forbidden` carry their own suspension and are respected, not doubled.
export const LOCALLY_COOLED_CLASSES = new Set(['timeout', 'upstream_error', 'crash']);

// Comma-separated engine list: trimmed, empties dropped, duplicates collapsed, order preserved.
export function parseEngineList(value) {
  const seen = new Set();
  const engines = [];
  for (const raw of String(value ?? '').split(',')) {
    const engine = raw.trim();
    if (!engine || seen.has(engine)) continue;
    seen.add(engine);
    engines.push(engine);
  }
  return engines;
}

function readPositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Read the opt-in pool configuration. Every value defaults to empty (or a bounded default), so an
// unconfigured deployment behaves exactly as before — this is the rollback guarantee.
export function enginePoolConfig(env = process.env) {
  return {
    pools: {
      general: parseEngineList(env.WAG_SEARCH_ENGINE_POOL_GENERAL),
      news: parseEngineList(env.WAG_SEARCH_ENGINE_POOL_NEWS),
      strict: parseEngineList(env.WAG_SEARCH_ENGINE_POOL_STRICT),
    },
    cooldownMs: readPositiveInt(env.WAG_SEARCH_ENGINE_COOLDOWN_MS, DEFAULT_ENGINE_COOLDOWN_MS),
    stateTtlMs: readPositiveInt(env.WAG_SEARCH_ENGINE_STATE_TTL_MS, DEFAULT_ENGINE_STATE_TTL_MS),
  };
}

// Bounded, in-memory engine health state. `cooldownMs` is the first-failure cooldown; each repeated
// failure doubles it up to `stateTtlMs`, so a persistently broken engine backs off instead of being
// retried on every request. Once the cooldown expires the engine is half-open: it is tried again, and
// a success clears its state while another failure extends the cooldown (bounded by `stateTtlMs`).
export function createEngineHealth({ cooldownMs = DEFAULT_ENGINE_COOLDOWN_MS, stateTtlMs = DEFAULT_ENGINE_STATE_TTL_MS, now = () => Date.now() } = {}) {
  const entries = new Map();

  function prune(t) {
    for (const [engine, entry] of entries) {
      if (entry.until <= t && t - entry.updatedAt >= stateTtlMs) entries.delete(engine);
    }
  }

  // True while the engine is inside its cooldown. After the cooldown it is allowed back (half-open).
  function shouldSkip(engine, t = now()) {
    prune(t);
    const entry = entries.get(engine);
    return Boolean(entry && entry.until > t);
  }

  function recordFailure(engine, rawReason, t = now()) {
    if (!engine) return { engine, failureClass: 'unknown', cooled: false };
    const failureClass = classifyFailureReason(rawReason);
    if (!LOCALLY_COOLED_CLASSES.has(failureClass)) return { engine, failureClass, cooled: false };
    const prior = entries.get(engine);
    const failures = prior ? prior.failures + 1 : 1;
    const duration = Math.min(cooldownMs * failures, stateTtlMs);
    const until = t + duration;
    entries.set(engine, { until, failures, reason: String(rawReason ?? ''), failure_class: failureClass, updatedAt: t });
    return { engine, failureClass, cooled: true, failures, until_ms: until };
  }

  function recordSuccess(engine) {
    entries.delete(engine);
  }

  // Diagnostic view of the currently-cooling engines.
  function snapshot(t = now()) {
    prune(t);
    const cooldown_engines = [];
    for (const [engine, entry] of entries) {
      if (entry.until > t) cooldown_engines.push({ engine, reason: entry.reason, failure_class: entry.failure_class, until_ms: entry.until });
    }
    return { cooldown_engines };
  }

  return { shouldSkip, recordFailure, recordSuccess, snapshot };
}

// Apply a configured pool for one layer: validate a strict pool against `time_range_support`, drop
// engines that are currently cooling, and report what was selected. Returns `null` when no pool is
// configured for the layer, so an unconfigured deployment sends no `engines=` parameter at all.
export function applyEnginePool({ layer, pools, health, now = Date.now }) {
  const configured = Array.isArray(pools?.[layer]) ? pools[layer] : [];
  if (configured.length === 0) return null;
  const validated = layer === 'strict' ? validateStrictPool(configured) : { engines: configured, rejected: [] };
  const engines = [];
  const cooling = [];
  for (const engine of validated.engines) {
    if (health?.shouldSkip(engine, now())) cooling.push(engine);
    else engines.push(engine);
  }
  return { layer, engines, configured, rejected: validated.rejected, cooling, source: 'config' };
}
