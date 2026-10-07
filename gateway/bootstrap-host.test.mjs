import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function request(port, host, token) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/healthz',
      headers: { Host: host, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.setTimeout(2000, () => req.destroy(new Error('local gateway request timed out')));
    req.on('error', reject);
  });
}

test('fresh template serves authenticated loopback and public Host names without allowing arbitrary Hosts', { timeout: 10000 }, async t => {
  const template = await fs.readFile(path.join(moduleDir, '../config/gateway.env.template'), 'utf8');
  const config = Object.fromEntries(template.trim().split(/\r?\n/).map(line => line.split('=')));
  assert.equal(config.GATEWAY_BIND_HOST, '127.0.0.1');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-bootstrap-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reservation = net.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const token = 'dummy-bootstrap-token-not-a-live-credential';
  const child = spawn(process.execPath, [path.join(moduleDir, 'server.mjs')], {
    env: { ...process.env, ...config, GATEWAY_PORT: String(port), GATEWAY_TOKEN: token,
      CRAWL4AI_TOKEN: 'dummy-crawl-token-not-a-live-credential',
      ARTIFACT_DIR: path.join(root, 'artifacts'), EVAL_REPORT_DIR: path.join(root, 'reports') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error('local gateway did not start')), 5000);
    function done(error) {
      clearTimeout(timer);
      child.stdout.off('data', ready);
      child.off('exit', exit);
      child.off('error', done);
      if (error) reject(error); else resolve();
    }
    function ready(chunk) { if (chunk.toString().includes('listening on')) done(); }
    function exit(code) { done(new Error(`local gateway exited during startup: ${code}`)); }
    child.stdout.on('data', ready);
    child.once('exit', exit);
    child.once('error', done);
    child.stderr.resume();
  });
  for (const host of ['127.0.0.1', 'localhost', '[::1]', config.GATEWAY_HOST]) {
    assert.equal(await request(port, `${host}:${port}`, token), 200, host);
  }
  assert.equal(await request(port, `localhost:${port}`), 401, 'loopback still requires authentication');
  assert.equal(await request(port, `untrusted.invalid:${port}`, token), 403, 'Host restriction remains enforced');
});
