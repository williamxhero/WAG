import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createPersistentBudgetLedger, createBudgetedProviderSearch } from './provider-budget.mjs';
import { createProviderAdapter } from './provider-adapters.mjs';
import { createBudgetLedger } from './provider-contract.mjs';

const NOW = Date.parse('2026-10-13T04:00:00Z');
function database(t) {
  const directory = mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : tmpdir(), 'wag-budget-'));
  const databasePath = path.join(directory, 'budget.sqlite');
  const ledgers = [];
  t.after(() => {
    for (const ledger of ledgers) ledger.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { databasePath, open(options = {}) {
    const ledger = createPersistentBudgetLedger({ databasePath, now: () => NOW, ...options });
    ledgers.push(ledger);
    return ledger;
  } };
}

test('committed reservations survive close/reopen and another ledger instance', t => {
  const fixture = database(t);
  const first = fixture.open({ initialize: true });
  assert.deepEqual(first.reserve('aliyun'), { allowed: true, dayCalls: 1, providerMonthlyCents: 1, globalMonthlyCents: 1 });
  first.close();
  const reopened = fixture.open();
  assert.equal(reopened.snapshot().providers.aliyun.monthlyCalls, 1);
  const second = fixture.open();
  assert.deepEqual(second.reserve('tencent'), { allowed: true, dayCalls: 1, providerMonthlyCents: 2, globalMonthlyCents: 3 });
  assert.equal(reopened.snapshot().globalMonthlyCents, 3);
});

test('daily caps persist while UTC day rollover preserves month spend', t => {
  let now = NOW;
  const ledger = database(t).open({ initialize: true, now: () => now });
  for (const [name, cap] of [['baidu', 100], ['aliyun', 20], ['tencent', 12]]) {
    for (let i = 0; i < cap; i++) assert.equal(ledger.reserve(name).allowed, true);
    assert.deepEqual(ledger.reserve(name), { allowed: false, reason: 'budget_exhausted' });
  }
  assert.equal(ledger.snapshot().globalMonthlyCents, 44);
  now = Date.parse('2026-10-14T00:00:00Z');
  assert.deepEqual(ledger.reserve('tencent'), { allowed: true, dayCalls: 1, providerMonthlyCents: 26, globalMonthlyCents: 46 });
});

test('paid provider/global monthly limits and conservative costs cannot be bypassed by reopening', t => {
  const fixture = database(t);
  let now = NOW;
  const ledger = fixture.open({ initialize: true, now: () => now });
  assert.equal(ledger.reserve('aliyun', 500).allowed, true);
  assert.deepEqual(ledger.reserve('aliyun'), { allowed: false, reason: 'budget_exhausted' });
  assert.equal(ledger.reserve('tencent', 500).allowed, true);
  assert.equal(ledger.snapshot().globalMonthlyCents, 1000);
  const reopened = fixture.open();
  assert.deepEqual(reopened.reserve('aliyun'), { allowed: false, reason: 'budget_exhausted' });
  assert.deepEqual(ledger.reserve('other'), { allowed: false, reason: 'provider_unconfigured' });
  for (const [name, bad] of [['aliyun', 0], ['tencent', 1], ['baidu', 1], ['aliyun', -1], ['aliyun', 0.8], ['aliyun', NaN], ['aliyun', null]]) {
    assert.throws(() => ledger.reserve(name, bad), TypeError);
  }
  now = Date.parse('2026-11-01T00:00:00Z');
  assert.equal(ledger.reserve('aliyun').allowed, true);
  assert.equal(ledger.snapshot().globalMonthlyCents, 1);
  assert.equal(ledger.snapshot().providers.aliyun.monthlyCalls, 1);
  const smaller = database(t).open({ initialize: true, globalMonthlyCents: 3 });
  assert.equal(smaller.reserve('tencent').allowed, true);
  assert.deepEqual(smaller.reserve('tencent'), { allowed: false, reason: 'budget_exhausted' });
});

test('clock rollback fails closed across instances and never reopens historical quota', t => {
  const fixture = database(t);
  let now = NOW;
  const ledger = fixture.open({ initialize: true, now: () => now });
  ledger.reserve('aliyun', 500);
  now = Date.parse('2026-11-01T00:00:00Z');
  ledger.reserve('aliyun');
  now = NOW;
  assert.throws(() => ledger.reserve('aliyun'), { kind: 'budget_clock_regression' });
  assert.throws(() => fixture.open().reserve('tencent'), { kind: 'budget_clock_regression' });
  now = NaN;
  assert.throws(() => ledger.snapshot(), TypeError);
});

test('missing/corrupt storage and repeated initialization never silently start a fresh quota', t => {
  const fixture = database(t);
  assert.throws(() => fixture.open(), { kind: 'budget_storage_error' });
  assert.throws(() => fixture.open({ databasePath: ':memory:', initialize: true }), TypeError);
  writeFileSync(fixture.databasePath, 'not a SQLite budget');
  assert.throws(() => fixture.open(), { kind: 'budget_storage_error' });
  assert.throws(() => fixture.open({ initialize: true }), { kind: 'budget_storage_error' });
});

test('lock and commit errors reject reservations without returning permission or resetting usage', t => {
  const fixture = database(t);
  const ledger = fixture.open({ initialize: true, busyTimeoutMs: 5 });
  ledger.reserve('aliyun');
  const lock = new DatabaseSync(fixture.databasePath);
  try {
    lock.exec('BEGIN IMMEDIATE');
    assert.throws(() => ledger.reserve('aliyun'), { kind: 'budget_storage_error' });
    lock.exec('ROLLBACK');
  } finally { lock.close(); }
  assert.equal(ledger.snapshot().globalMonthlyCents, 1);
  const faulty = fixture.open({ openDatabase(filename) {
    const db = new DatabaseSync(filename);
    return { exec(sql) { if (sql === 'COMMIT') throw new Error('synthetic commit I/O fault'); return db.exec(sql); },
      prepare: sql => db.prepare(sql), close: () => db.close() };
  } });
  assert.throws(() => faulty.reserve('aliyun'), { kind: 'budget_storage_error' });
  assert.equal(ledger.snapshot().globalMonthlyCents, 1);
});

test('budgeted dispatch requires persistent storage, skips disabled providers, reserves before calls and caches before charging', async t => {
  const fixture = database(t);
  let now = NOW;
  const budget = fixture.open({ initialize: true, now: () => now });
  let calls = 0;
  const provider = createProviderAdapter({ name: 'aliyun', enabled: true, transport: async () => {
    calls++;
    assert.equal(fixture.open({ now: () => now }).snapshot().providers.aliyun.dailyCalls, calls);
    return { status: 200, body: JSON.stringify({ pageItems: [{ title: 'synthetic', link: 'https://example.cn', publishedTime: '2026-10-13' }] }) };
  } });
  assert.throws(() => createBudgetedProviderSearch({ providers: [provider], budget: createBudgetLedger() }), TypeError);
  const search = createBudgetedProviderSearch({ providers: [createProviderAdapter({ name: 'tencent' }), provider], budget, now: () => now });
  const first = await search({ query: ' 政策 ', mode: 'strict', timeWindow: 'day' });
  assert.deepEqual(first.attempts.map(x => x.status), ['provider_unconfigured', 'success']);
  const cached = await search({ query: '政策', mode: 'strict', timeWindow: 'day' });
  assert.equal(cached.attempts[1].status, 'cache_hit');
  assert.equal(calls, 1);
  assert.equal(budget.snapshot().globalMonthlyCents, 1);
  now += 3600000;
  await search({ query: '政策', mode: 'strict', timeWindow: 'day' });
  assert.equal(calls, 2);
  assert.equal(budget.snapshot().globalMonthlyCents, 2);
});

test('failed and empty dispatch attempts remain charged and storage failure never invokes transport', async t => {
  const fixture = database(t);
  const budget = fixture.open({ initialize: true });
  const providers = [
    createProviderAdapter({ name: 'aliyun', enabled: true, transport: async () => { throw new Error('synthetic transport failure'); } }),
    createProviderAdapter({ name: 'tencent', enabled: true, transport: async () => ({ status: 200, body: JSON.stringify({ Response: { Version: 'lite', Pages: [] } }) }) }),
  ];
  const search = createBudgetedProviderSearch({ providers, budget, now: () => NOW });
  assert.deepEqual((await search('政策')).attempts.map(x => x.status), ['transport_error', 'empty']);
  assert.equal(budget.snapshot().globalMonthlyCents, 3);
  assert.deepEqual((await search('政策')).attempts.map(x => x.status), ['transport_error', 'cache_hit']);
  assert.equal(budget.snapshot().globalMonthlyCents, 4);
  const lock = new DatabaseSync(fixture.databasePath);
  try {
    lock.exec('BEGIN IMMEDIATE');
    const never = createBudgetedProviderSearch({ providers: [createProviderAdapter({ name: 'aliyun', enabled: true, transport: () => assert.fail('storage failure must not dispatch') })], budget });
    await assert.rejects(never('another query'), { kind: 'budget_storage_error' });
    lock.exec('ROLLBACK');
  } finally { lock.close(); }
  assert.equal(budget.snapshot().globalMonthlyCents, 4);
});

const moduleUrl = new URL('./provider-budget.mjs', import.meta.url).href;
function worker(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`budget worker exit ${code}: ${errors}`)));
  });
}

test('reopening waits for a short exclusive lock before storage validation', { timeout: 10000 }, async t => {
  const fixture = database(t);
  fixture.open({ initialize: true }).close();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite';
    const db=new DatabaseSync(${JSON.stringify(fixture.databasePath)});
    db.exec('BEGIN EXCLUSIVE'); process.send('locked');
    setTimeout(()=>{db.exec('COMMIT');db.close();process.disconnect();},250);`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('lock fixture failed')));
  });
  await new Promise((resolve, reject) => {
    child.once('message', message => message === 'locked' ? resolve() : reject(new Error('lock not acquired')));
    child.once('error', reject);
  });
  try {
    const reopened = fixture.open({ busyTimeoutMs: 1000 });
    assert.equal(reopened.reserve('aliyun').allowed, true);
  } finally { await exited; }
});

test('separate processes compete atomically for daily and global monthly allowance', { timeout: 20000 }, async t => {
  const fixture = database(t);
  fixture.open({ initialize: true }).close();
  const script = `import {createPersistentBudgetLedger} from ${JSON.stringify(moduleUrl)};
    const ledger=createPersistentBudgetLedger({databasePath:${JSON.stringify(fixture.databasePath)},now:()=>${NOW}});
    let allowed=0; for(let i=0;i<8;i++) if(ledger.reserve('aliyun').allowed) allowed++;
    ledger.close(); console.log(JSON.stringify(allowed));`;
  const totals = await Promise.all([worker(script), worker(script), worker(script), worker(script)]);
  assert.equal(totals.reduce((a, b) => a + b, 0), 20);
  assert.equal(fixture.open().snapshot().globalMonthlyCents, 20);
  const globalFixture = database(t);
  globalFixture.open({ initialize: true }).close();
  const contenders = ['aliyun', 'tencent'].map(name => worker(`import {createPersistentBudgetLedger} from ${JSON.stringify(moduleUrl)};
    const ledger=createPersistentBudgetLedger({databasePath:${JSON.stringify(globalFixture.databasePath)},globalMonthlyCents:500,now:()=>${NOW}});
    console.log(JSON.stringify(ledger.reserve('${name}',500).allowed)); ledger.close();`));
  assert.equal((await Promise.all(contenders)).filter(Boolean).length, 1);
  assert.equal(globalFixture.open().snapshot().globalMonthlyCents, 500);
});

test('a process killed after reservation commit cannot recover spent allowance', { timeout: 10000 }, async t => {
  const fixture = database(t);
  fixture.open({ initialize: true }).close();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {createPersistentBudgetLedger} from ${JSON.stringify(moduleUrl)};
    const ledger=createPersistentBudgetLedger({databasePath:${JSON.stringify(fixture.databasePath)},now:()=>${NOW}});
    ledger.reserve('tencent'); process.send('committed'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    let committed = false;
    child.once('error', reject);
    child.once('message', message => { committed = message === 'committed'; child.kill('SIGKILL'); });
    child.once('exit', () => committed ? resolve() : reject(new Error('worker exited before commit')));
  });
  assert.equal(fixture.open().snapshot().globalMonthlyCents, 2);
});

test('missing daily or monthly counter rows fail closed before any permission escapes', t => {
  for (const table of ['daily_usage', 'monthly_usage']) {
    const fixture = database(t);
    const ledger = fixture.open({ initialize: true });
    for (let i = 0; i < 20; i++) assert.equal(ledger.reserve('aliyun').allowed, true);
    ledger.close();
    const db = new DatabaseSync(fixture.databasePath);
    try { db.exec(`DELETE FROM ${table}`); } finally { db.close(); }
    const reopened = fixture.open();
    assert.throws(() => reopened.reserve('aliyun'), { kind: 'budget_storage_error' });
    assert.throws(() => reopened.reserve('tencent'), { kind: 'budget_storage_error' });
    assert.throws(() => reopened.snapshot(), { kind: 'budget_storage_error' });
  }
});

test('deleted or logically damaged ledgers cannot authorize new reservations', t => {
  const fixture = database(t);
  const ledger = fixture.open({ initialize: true });
  ledger.reserve('aliyun');
  ledger.close();
  unlinkSync(fixture.databasePath);
  assert.throws(() => fixture.open(), { kind: 'budget_storage_error' });
  const damaged = database(t);
  const current = damaged.open({ initialize: true });
  current.reserve('aliyun');
  const db = new DatabaseSync(damaged.databasePath);
  try {
    db.exec('PRAGMA ignore_check_constraints=ON; UPDATE monthly_usage SET cents=-1');
    assert.throws(() => current.reserve('aliyun'), { kind: 'budget_storage_error' });
  } finally { db.close(); }
});
