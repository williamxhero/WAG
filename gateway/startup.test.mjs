import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { waitForListening } from './test-fixtures/wait-for-listening.mjs';

function childFixture(t, script) {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill(); await exited;
  });
  return child;
}

test('gateway startup recognizes a banner split across stdout chunks', async t => {
  const child = childFixture(t, `process.stdout.write('web-access-gateway lis');
setTimeout(() => process.stdout.write('tening\\n'), 30); setInterval(() => {}, 1000);`);
  await waitForListening(child, { timeoutMs: 500 });
});

test('gateway startup reports premature exit diagnostics and a bounded missing banner', async t => {
  const failed = childFixture(t, `console.error('controlled startup failure'); process.exit(7);`);
  await assert.rejects(waitForListening(failed), /7.*controlled startup failure|controlled startup failure.*7/s);
  const stalled = childFixture(t, `setInterval(() => {}, 1000);`);
  const started = performance.now();
  await assert.rejects(waitForListening(stalled, { timeoutMs: 50 }), /did not start/);
  assert.ok(performance.now() - started < 500);
});
