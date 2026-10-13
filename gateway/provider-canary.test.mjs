import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { mkdtemp, rm, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createSearchProviderRuntime } from './provider-routing.mjs';
import { createPersistentBudgetLedger } from './provider-budget.mjs';
import { runProviderCanary } from '../scripts/provider-canary.mjs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/provider-canary.mjs', import.meta.url));
const dummyEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };

test('canary executable selects one disabled provider and emits only sanitized diagnostics', () => {
  const child = spawnSync(process.execPath, [script, '--provider', 'baidu', '--query', 'private-query-do-not-print', '--confirm-send'], { env: dummyEnv, encoding: 'utf8' });
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.provider, 'baidu');
  assert.equal(result.status, 'provider_unconfigured');
  assert.equal(result.resultcount, 0);
  assert.equal(result.budget, null);
  assert.equal(child.stdout.includes('private-query'), false);
  assert.equal(child.status, 1);
});

test('canary cleanup failures return a safe failure without printing private messages or inventing spend', async t => {
  const args = ['--provider', 'baidu', '--query', 'private-query', '--confirm-send'];
  const source = `export function createSearchProviderRuntime() { return { snapshot: () => null, dispatch: async () => ({ results: [], attempts: [{status: 'empty'}] }), close: () => { throw Error('dummy-private-close-message'); } }; }`;
  const runtimeFactory = () => ({ snapshot: () => null, dispatch: async () => ({ results: [], attempts: [{ status: 'empty' }] }), close: () => { throw Error('dummy-private-close-message'); } });
  const result = await runProviderCanary(args, { runtimeFactory });
  assert.equal(result.status, 'budget_storage_error');
  assert.equal(result.spend_cents, null);
  const root = await mkdtemp(path.join(tmpdir(), 'wag-canary-close-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'runtime', 'gateway'), { recursive: true });
  const deployed = path.join(root, 'scripts', 'provider-canary.mjs');
  await copyFile(script, deployed);
  await writeFile(path.join(root, 'runtime', 'gateway', 'provider-routing.mjs'), source);
  const child = spawnSync(process.execPath, [deployed, ...args], { env: dummyEnv, encoding: 'utf8' });
  assert.equal(child.stderr, '');
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).status, 'budget_storage_error');
  assert.equal(/private|Error|stack|\.mjs/.test(child.stdout), false);
});

test('Tencent canary uses the real fixed-site transport and reserves three cents before its only send', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wag-canary-'));
  const databasePath = path.join(root, 'budget.sqlite');
  const now = () => Date.parse('2026-10-13T12:00:00Z');
  const budget = createPersistentBudgetLedger({ databasePath, initialize: true, now });
  t.after(() => { budget.close(); return rm(root, { recursive: true, force: true }); });
  const calls = [];
  const runtimeFactory = () => createSearchProviderRuntime({ databasePath, now,
    env: { WAG_SEARCH_TENCENT_ENABLED: '1', WAG_SEARCH_PROVIDER_TARIFF_CONFIRMED: '1', TENCENTCLOUD_SECRET_ID: 'dummy-id', TENCENTCLOUD_SECRET_KEY: 'dummy-key' },
    request: (url, options, callback) => {
      const req = new EventEmitter();
      req.destroy = () => {};
      req.end = payload => {
        calls.push({ body: JSON.parse(payload), usage: budget.snapshot() });
        const res = Readable.from([JSON.stringify({ Response: { Version: 'standard', Pages: [JSON.stringify({ title: 'Secret title', url: 'https://mp.weixin.qq.com/s/private', passage: 'Private passage', date: '2026-10-13' })] } })]);
        res.statusCode = 200;
        res.headers = {};
        queueMicrotask(() => callback(res));
      };
      return req;
    } });
  const result = await runProviderCanary(['--provider', 'tencent', '--query', 'Private query', '--confirm-send'], { runtimeFactory });
  assert.equal(result.status, 'success');
  assert.equal(result.posterior_version, 'standard');
  assert.equal(result.resultcount, 1);
  assert.deepEqual(result.e4counts, { claimed: 1, unknown: 0 });
  assert.equal(result.spend_cents, 3);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { Query: 'Private query', Site: 'mp.weixin.qq.com' });
  assert.equal(calls[0].usage.providers.tencent.monthlyCents, 3);
  assert.equal(/Private|Secret|weixin|dummy/.test(JSON.stringify(result)), false);
});

test('explicit ledger initialization is exclusive and zero-network, and never resets an existing ledger', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'wag-canary-init-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'budget.sqlite');
  let constructed = 0;
  const runtimeFactory = () => { constructed++; throw new Error('network runtime must not be constructed'); };
  const module = await import('./provider-routing.mjs');
  const initializeBudget = () => module.initializeSearchProviderBudget({ databasePath });
  const result = await runProviderCanary(['--initialize-budget', '--confirm-initialize'], { runtimeFactory, initializeBudget });
  assert.equal(result.status, 'initialized');
  assert.equal(result.spend_cents, 0);
  assert.equal(constructed, 0);
  const budget = createPersistentBudgetLedger({ databasePath });
  assert.equal(budget.reserve('tencent', 3).allowed, true);
  budget.close();
  const refused = await runProviderCanary(['--initialize-budget', '--confirm-initialize'], { runtimeFactory, initializeBudget });
  assert.equal(refused.status, 'budget_storage_error');
  const reopened = createPersistentBudgetLedger({ databasePath });
  assert.equal(reopened.snapshot().providers.tencent.monthlyCents, 3);
  reopened.close();
  assert.equal(constructed, 0);
});

test('invalid canary arguments do not construct a runtime or accept path, credential or endpoint controls', async () => {
  for (const args of [[], ['--provider', 'baidu', '--query', 'x'], ['--provider', 'baidu', '--query', 'x', '--confirm-send', '--endpoint', 'https://evil.example'],
    ['--provider', 'baidu', '--query', 'x', '--confirm-send', '--database-path', '/data/test'], ['--provider', 'baidu', '--query', 'x', '--confirm-send', '--provider', 'aliyun']]) {
    let constructed = 0;
    const result = await runProviderCanary(args, { runtimeFactory: () => { constructed++; throw new Error('should not run'); } });
    assert.equal(result.status, 'invalid_arguments');
    assert.equal(constructed, 0);
  }
});
