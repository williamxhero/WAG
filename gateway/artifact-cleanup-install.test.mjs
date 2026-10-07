import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function bashPath(value) { return value.replaceAll('\\', '/'); }

test('offline installer links authoritative cleanup units and enables the daily timer', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-cleanup-install-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, 'release');
  const units = path.join(tmp, 'units');
  const bin = path.join(tmp, 'bin');
  await fs.mkdir(path.join(root, 'systemd'), { recursive: true });
  await fs.mkdir(bin);
  for (const unit of ['web-access-artifact-cleanup.service', 'web-access-artifact-cleanup.timer']) {
    await fs.copyFile(path.join(repository, 'systemd', unit), path.join(root, 'systemd', unit));
  }
  const log = path.join(tmp, 'systemctl.log');
  await fs.writeFile(path.join(bin, 'systemctl'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$MOCK_SYSTEMCTL_LOG"\n', { mode: 0o755 });
  const result = spawnSync('bash', [bashPath(path.join(repository, 'scripts/install-artifact-cleanup.sh'))], {
    encoding: 'utf8', env: { ...process.env, WAG_ROOT: bashPath(root), WAG_SYSTEMD_DIR: bashPath(units),
      MOCK_SYSTEMCTL_LOG: bashPath(log), PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(log, 'utf8'), 'daemon-reload\nenable --now web-access-artifact-cleanup.timer\n');
  for (const unit of ['web-access-artifact-cleanup.service', 'web-access-artifact-cleanup.timer']) {
    assert.equal(await fs.readFile(path.join(units, unit), 'utf8'), await fs.readFile(path.join(repository, 'systemd', unit), 'utf8'));
  }
  const timer = await fs.readFile(path.join(units, 'web-access-artifact-cleanup.timer'), 'utf8');
  assert.match(timer, /^OnCalendar=daily$/m);
  assert.match(timer, /^Persistent=true$/m);
  const service = await fs.readFile(path.join(units, 'web-access-artifact-cleanup.service'), 'utf8');
  assert.match(service, /^ExecStart=\/data\/web-access-gateway\/scripts\/cleanup-artifacts.sh$/m);
  assert.match(await fs.readFile(path.join(repository, 'scripts/bootstrap.sh'), 'utf8'), /"\$ROOT\/scripts\/install-artifact-cleanup.sh"/);
  // Deployment now delegates to the transaction CLI; retain the invariant that
  // both installation paths reuse the authoritative cleanup installer.
  assert.match(await fs.readFile(path.join(repository, 'scripts/deploy.sh'), 'utf8'), /exec python3 "\$SCRIPT_DIR\/release.py"/);
  const transaction = await fs.readFile(path.join(repository, 'scripts/release.py'), 'utf8');
  assert.match(transaction, /run\(\["bash", root \/ "scripts\/install-artifact-cleanup.sh"\], "artifact cleanup installation", env=env\)/);
  assert.match(transaction, /WAG_ROOT=str\(root\), WAG_SYSTEMD_DIR=str\(unit_dir\)/);
});

test('the scheduled cleanup command uses configured ARTIFACT_DIR and leaves reports untouched', async t => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-cleanup-command-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const runtime = path.join(tmp, 'runtime', 'gateway');
  await fs.mkdir(runtime, { recursive: true });
  for (const module of ['artifact-store.mjs', 'cleanup-artifacts.mjs']) {
    await fs.copyFile(path.join(repository, 'gateway', module), path.join(runtime, module));
  }
  const root = path.join(tmp, 'custom-artifacts');
  await fs.mkdir(path.join(root, 'playwright'), { recursive: true });
  const old = path.join(root, 'playwright', 'old.png');
  const recent = path.join(root, 'playwright', 'recent.pdf');
  await fs.writeFile(old, 'old');
  await fs.writeFile(recent, 'recent');
  const expired = new Date(Date.now() - 604810000);
  await fs.utimes(old, expired, expired);
  const report = path.join(tmp, 'reports', 'old.html');
  await fs.mkdir(path.dirname(report));
  await fs.writeFile(report, 'report');
  await fs.utimes(report, expired, expired);
  const result = spawnSync('bash', [bashPath(path.join(repository, 'scripts/cleanup-artifacts.sh'))], {
    encoding: 'utf8', env: { ...process.env, WAG_ROOT: bashPath(tmp), NODE_BIN: bashPath(process.execPath), ARTIFACT_DIR: root },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { deleted: 1, reclaimedBytes: 3, usageBytes: 6 });
  await assert.rejects(fs.access(old), { code: 'ENOENT' });
  assert.equal(await fs.readFile(recent, 'utf8'), 'recent');
  assert.equal(await fs.readFile(report, 'utf8'), 'report');
});
