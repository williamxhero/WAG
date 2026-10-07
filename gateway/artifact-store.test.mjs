import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createArtifactStore } from './artifact-store.mjs';

const now = Date.parse('2026-10-07T12:00:00Z');
const week = 604800000;
const owned = '2026-09-30/00000000-0000-4000-8000-000000000001.png';
async function tree(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-artifact-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'artifacts');
  await fs.mkdir(root);
  const put = async (name, age, bytes = 3) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.alloc(bytes));
    await fs.utimes(file, new Date(now - age), new Date(now - age));
    return file;
  };
  return { root, directory, put };
}

test('cleanup expires completed owned artifacts at exactly seven elapsed days, not calendar days', async t => {
  const { root, put } = await tree(t);
  await put(owned, week);
  await put('playwright/screenshot.png', week + 1);
  const recent = await put('playwright/recent.pdf', week - 1);
  const store = createArtifactStore({ root, clock: () => now });
  assert.deepEqual(await store.cleanup(), { deleted: 2, reclaimedBytes: 6, usageBytes: 3 });
  await assert.rejects(fs.access(path.join(root, owned)), { code: 'ENOENT' });
  assert.equal((await fs.stat(recent)).size, 3);
});

test('cleanup preserves unknown, temporary and in-progress files and directories', async t => {
  const { root, put } = await tree(t);
  const kept = ['unowned.png', '2026-09-30/notes.html', `${owned}.tmp`,
    'playwright/screenshot.tmp.png', 'playwright/.hidden.png', 'playwright/active.part.pdf',
    'playwright/tmp/page.html', 'playwright/in-progress/page.png', 'reports/report.html'];
  for (const file of kept) await put(file, week + 1000);
  await put('crawl4ai/completed.html', week);
  const activeDir = path.join(root, 'playwright', 'empty-active');
  await fs.mkdir(activeDir);
  const store = createArtifactStore({ root, clock: () => now });
  assert.deepEqual(await store.cleanup(), { deleted: 1, reclaimedBytes: 3, usageBytes: kept.length * 3 });
  for (const file of kept) await fs.access(path.join(root, file));
  assert.equal((await fs.stat(activeDir)).isDirectory(), true);
});

test('cleanup never follows directory symlinks, root aliases, file symlinks or hard links', async t => {
  const { root, directory, put } = await tree(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  const sentinel = path.join(outside, 'keep.png');
  await fs.writeFile(sentinel, 'outside');
  await fs.utimes(sentinel, new Date(now - week), new Date(now - week));
  await fs.symlink(outside, path.join(root, 'playwright'), 'junction');
  await put(owned, week);
  await fs.mkdir(path.join(root, 'crawl4ai'));
  // Junctions work without elevated privileges on Windows; Linux CI also tests file links.
  if (process.platform !== 'win32') await fs.symlink(sentinel, path.join(root, 'crawl4ai', 'linked.png'));
  await fs.link(sentinel, path.join(root, 'crawl4ai', 'hardlinked.png'));
  const alias = path.join(directory, 'alias');
  await fs.symlink(root, alias, 'junction');
  const store = createArtifactStore({ root, clock: () => now });
  const result = await store.cleanup();
  assert.equal(result.deleted, 1);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside');
  await fs.access(path.join(root, 'crawl4ai', 'hardlinked.png'));
  await assert.rejects(createArtifactStore({ root: alias, clock: () => now }).cleanup(), { kind: 'artifact_root_unsafe' });
});

test('admission reconciles external Playwright additions and deletions without restarting', async t => {
  const { root, put } = await tree(t);
  const store = createArtifactStore({ root, clock: () => now, maxBytes: 4, quotaBytes: 10 });
  const first = await store.save(Buffer.from('abc'), 'png');
  assert.equal(first.bytes, 3);
  const external = await put('playwright/external.pdf', 0, 8);
  await assert.rejects(store.save(Buffer.from('def'), 'pdf'), { kind: 'artifact_quota_exceeded' });
  await fs.unlink(external);
  const second = await store.save(Buffer.from('def'), 'pdf');
  assert.equal(await store.reconcile(), 6);
  assert.equal(await fs.readFile(path.join(root, second.id), 'utf8'), 'def');
  await assert.rejects(store.save(Buffer.alloc(5), 'png'), { kind: 'artifact_too_large' });
  assert.equal(await store.reconcile(), 6);
});

if (process.platform === 'linux') {
  test('cleanup anchors Linux directory traversal when a directory is replaced by an outside symlink', async t => {
    const { root, directory, put } = await tree(t);
    await put('playwright/old.png', week);
    const outside = path.join(directory, 'outside');
    await fs.mkdir(outside);
    const sentinel = path.join(outside, 'old.png');
    await fs.writeFile(sentinel, 'outside');
    await fs.utimes(sentinel, new Date(now - week), new Date(now - week));
    let replaced = false;
    const store = createArtifactStore({ root, clock: () => now, io: {
      ...fs,
      async readdir(current, ...args) {
        const entries = await fs.readdir(current, ...args);
        if (!replaced && entries.some(entry => entry.name === 'old.png')) {
          replaced = true;
          await fs.rename(path.join(root, 'playwright'), path.join(root, 'original'));
          await fs.symlink(outside, path.join(root, 'playwright'));
        }
        return entries;
      },
    } });
    assert.equal((await store.cleanup()).deleted, 1);
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'outside');
    await assert.rejects(fs.access(path.join(root, 'original', 'old.png')), { code: 'ENOENT' });
  });
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('an independent cleanup overlaps a partial write safely and capacity recovers in the same writer', async t => {
  const { root, put } = await tree(t);
  await put(owned, week, 8);
  const writing = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const store = createArtifactStore({ root, clock: () => now, quotaBytes: 10, io: {
    ...fs,
    async writeFile(file, content, options) {
      await fs.writeFile(file, content, options);
      await fs.utimes(file, new Date(now - week), new Date(now - week));
      writing.resolve(file);
      await release.promise;
    },
  } });
  const first = store.save(Buffer.from('ab'), 'png');
  const temporary = await writing.promise;
  assert.equal((await fs.readdir(path.dirname(temporary))).filter(name => name.endsWith('.png')).length, 0);
  const cleaner = createArtifactStore({ root, clock: () => now });
  assert.deepEqual(await cleaner.cleanup(), { deleted: 1, reclaimedBytes: 8, usageBytes: 2 });
  await fs.access(temporary);
  const second = store.save(Buffer.from('cde'), 'pdf');
  release.resolve();
  const published = await first;
  await second;
  assert.equal(await store.reconcile(), 5);
  assert.equal((await fs.stat(path.join(root, published.id))).mtimeMs, now);
  assert.equal((await cleaner.cleanup()).deleted, 0);
});

test('concurrent quota admissions are serialized and an expired artifact frees capacity', async t => {
  const { root } = await tree(t);
  const store = createArtifactStore({ root, clock: () => now, quotaBytes: 5 });
  const results = await Promise.allSettled([store.save(Buffer.from('abc'), 'png'), store.save(Buffer.from('def'), 'pdf')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.kind, 'artifact_quota_exceeded');
  await fs.utimes(path.join(root, results[0].value.id), new Date(now - week), new Date(now - week));
  const cleanup = store.cleanup();
  const save = store.save(Buffer.from('defgh'), 'pdf');
  assert.deepEqual(await cleanup, { deleted: 1, reclaimedBytes: 3, usageBytes: 0 });
  assert.equal((await save).bytes, 5);
  assert.equal(await store.reconcile(), 5);
});

test('failed partial writes and failed publication leave no residue or quota reservation', async t => {
  const { root } = await tree(t);
  let failWrite = true;
  let failRename = true;
  const store = createArtifactStore({ root, clock: () => now, quotaBytes: 3, io: {
    ...fs,
    async writeFile(...args) {
      await fs.writeFile(...args);
      if (failWrite) { failWrite = false; throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); }
    },
    async rename(...args) {
      if (failRename) { failRename = false; throw Object.assign(new Error('publication failed'), { code: 'EIO' }); }
      return fs.rename(...args);
    },
  } });
  await assert.rejects(store.save(Buffer.from('abc'), 'png'), { code: 'ENOSPC' });
  assert.equal(await store.reconcile(), 0);
  await assert.rejects(store.save(Buffer.from('abc'), 'png'), { code: 'EIO' });
  assert.equal(await store.reconcile(), 0);
  assert.equal((await store.save(Buffer.from('abc'), 'png')).bytes, 3);
  assert.equal(await store.reconcile(), 3);
  const names = await fs.readdir(path.join(root, '2026-10-07'));
  assert.equal(names.length, 1);
  assert.equal(names[0].endsWith('.png'), true);
});

test('writes reject aliased publication directories and preserve outside files', async t => {
  const { root, directory } = await tree(t);
  const outside = path.join(directory, 'outside');
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, '2026-10-07'), 'junction');
  const store = createArtifactStore({ root, clock: () => now });
  await assert.rejects(store.save(Buffer.from('abc'), 'png'), { kind: 'artifact_root_unsafe' });
  assert.deepEqual(await fs.readdir(outside), []);
  await assert.rejects(store.save(Buffer.alloc(25 * 1024 * 1024 + 1), 'png'), { kind: 'artifact_too_large' });
  assert.equal(await store.reconcile(), 0);
});

test('the default one-GiB storage cap includes external sparse files and releases space after deletion', async t => {
  const { root, put } = await tree(t);
  const external = await put('playwright/large.pdf', 0, 0);
  // Sparse length tests the real filesystem accounting without writing one GiB of data.
  await fs.truncate(external, 1073741824);
  const store = createArtifactStore({ root, clock: () => now });
  await assert.rejects(store.save(Buffer.from('x'), 'png'), { kind: 'artifact_quota_exceeded' });
  await fs.unlink(external);
  assert.equal((await store.save(Buffer.from('x'), 'png')).bytes, 1);
  assert.equal(await store.reconcile(), 1);
});

test('quota scans fail closed on filesystem errors rather than treating unreadable data as free space', async t => {
  const { root, put } = await tree(t);
  await put('playwright/external.png', 0, 8);
  let fail = true;
  const store = createArtifactStore({ root, quotaBytes: 10, io: {
    ...fs,
    async readdir(...args) {
      if (fail) throw Object.assign(new Error('unreadable'), { code: 'EACCES' });
      return fs.readdir(...args);
    },
  } });
  await assert.rejects(store.save(Buffer.from('abc'), 'png'), { code: 'EACCES' });
  fail = false;
  await assert.rejects(store.save(Buffer.from('abc'), 'png'), { kind: 'artifact_quota_exceeded' });
  assert.equal(await store.reconcile(), 8);
});
