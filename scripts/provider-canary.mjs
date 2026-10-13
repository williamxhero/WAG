#!/usr/bin/env node
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const PROVIDERS = ['baidu', 'aliyun', 'tencent'];
const STATUSES = new Set(['success', 'empty', 'cache_hit', 'provider_unconfigured', 'provider_configuration_error',
  'budget_storage_error', 'budget_clock_regression', 'budget_exhausted', 'authentication', 'rate_limited',
  'upstream_error', 'invalid_response', 'transport_error', 'timeout', 'response_too_large',
  'provider_version_mismatch', 'provider_capacity_exhausted']);

export async function loadRuntimeModule() {
  for (const relative of ['../gateway/provider-routing.mjs', '../runtime/gateway/provider-routing.mjs']) {
    const url = new URL(relative, import.meta.url);
    try { await access(url); } catch { continue; }
    return import(url.href);
  }
  throw new Error('runtime_unavailable');
}

async function loadDiagnosticProjector() {
  for (const relative of ['../gateway/provider-contract.mjs', '../runtime/gateway/provider-contract.mjs']) {
    const url = new URL(relative, import.meta.url);
    try { await access(url); } catch { continue; }
    const module = await import(url.href);
    if (typeof module.projectProviderDiagnostic === 'function') return module.projectProviderDiagnostic;
  }
  throw new Error('diagnostics_unavailable');
}

function parse(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--confirm-send') {
      if (values.confirm) throw new Error('invalid_arguments');
      values.confirm = true;
    } else if (['--provider', '--query', '--mode', '--time-window'].includes(arg)) {
      if (Object.hasOwn(values, arg) || i + 1 === args.length || args[i + 1].startsWith('--')) throw new Error('invalid_arguments');
      values[arg] = args[++i];
    } else throw new Error('invalid_arguments');
  }
  const provider = values['--provider'];
  const query = values['--query'];
  const mode = values['--mode'] ?? 'general';
  const timeWindow = values['--time-window'] ?? null;
  if (!values.confirm || !PROVIDERS.includes(provider) || typeof query !== 'string' || !query.trim() || query.length > 500 ||
      /[\x00-\x1f\x7f]/.test(query) || !['general', 'news', 'strict'].includes(mode) ||
      ![null, 'day', 'week', 'month', 'year'].includes(timeWindow)) throw new Error('invalid_arguments');
  return { provider, query, mode, timeWindow };
}

function safeBudget(snapshot) {
  if (!snapshot || typeof snapshot.month !== 'string' || !/^\d{4}-\d{2}$/.test(snapshot.month) ||
      !Number.isSafeInteger(snapshot.globalMonthlyCents) || snapshot.globalMonthlyCents < 0) return null;
  const providers = {};
  for (const name of PROVIDERS) {
    const usage = snapshot.providers?.[name];
    if (!usage) continue;
    if (!['dailyCalls', 'monthlyCalls', 'monthlyCents'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return null;
    providers[name] = { dailyCalls: usage.dailyCalls, monthlyCalls: usage.monthlyCalls, monthlyCents: usage.monthlyCents };
  }
  return { month: snapshot.month, globalMonthlyCents: snapshot.globalMonthlyCents, providers };
}

// The factory seam is for offline tests. CLI arguments cannot select credentials, paths or endpoints.
export async function runProviderCanary(args, { runtimeFactory, initializeBudget } = {}) {
  if (args.length === 2 && args.includes('--initialize-budget') && args.includes('--confirm-initialize')) {
    try {
      const initialize = initializeBudget ?? (await loadRuntimeModule()).initializeSearchProviderBudget;
      const budget = safeBudget(initialize());
      return { provider: null, status: 'initialized', resultcount: 0, e4counts: { claimed: 0, unknown: 0 }, posterior_version: null, spend_cents: 0, budget };
    } catch { return { provider: null, status: 'budget_storage_error', resultcount: 0, e4counts: { claimed: 0, unknown: 0 }, posterior_version: null, spend_cents: null, budget: null }; }
  }
  let input;
  try { input = parse(args); } catch { return { provider: null, status: 'invalid_arguments', resultcount: 0, e4counts: { claimed: 0, unknown: 0 }, posterior_version: null, spend_cents: null, budget: null }; }
  let runtime;
  try {
    const factory = runtimeFactory ?? (await loadRuntimeModule()).createSearchProviderRuntime;
    runtime = factory();
    const before = safeBudget(runtime.snapshot());
    const response = await runtime.dispatch({ ...input, signal: AbortSignal.timeout(10000) });
    const status = STATUSES.has(response.attempts?.[0]?.status) ? response.attempts[0].status : 'invalid_response';
    const budget = safeBudget(response.provider_budget);
    const spend = before && budget && before.month === budget.month ? budget.globalMonthlyCents - before.globalMonthlyCents : null;
    const items = response.results ?? [];
    const claimed = items.filter(item => typeof item.claimed_date === 'string' && item.claimed_date.trim()).length;
    const attempt = response.attempts?.[0];
    const projectDiagnostic = input.provider === 'tencent' ? await loadDiagnosticProjector() : null;
    const diagnostic = projectDiagnostic ? projectDiagnostic(attempt?.diagnostic) : null;
    return { provider: input.provider, status, resultcount: items.length, e4counts: { claimed, unknown: items.length - claimed },
      posterior_version: ['lite', 'standard', 'flagship'].includes(response.posterior_version) ? response.posterior_version : null,
      ...(diagnostic ? { diagnostic } : {}),
      spend_cents: Number.isSafeInteger(spend) && spend >= 0 ? spend : null, budget };
  } catch { return { provider: input.provider, status: 'budget_storage_error', resultcount: 0, e4counts: { claimed: 0, unknown: 0 }, posterior_version: null, spend_cents: null, budget: null }; }
  finally {
    try { runtime?.close(); }
    catch { return { provider: input.provider, status: 'budget_storage_error', resultcount: 0, e4counts: { claimed: 0, unknown: 0 }, posterior_version: null, spend_cents: null, budget: null }; }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  // Node 22 announces experimental SQLite on stderr. Do not expose unbounded warning text.
  process.removeAllListeners('warning');
  process.on('warning', warning => {
    if (warning.name !== 'ExperimentalWarning') process.stderr.write('{"status":"runtime_warning"}\n');
  });
  const result = await runProviderCanary(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = ['success', 'empty', 'cache_hit', 'initialized'].includes(result.status) ? 0 : 1;
}
