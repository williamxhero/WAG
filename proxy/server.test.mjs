import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function unusedPort() {
  const server = net.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('proxy did not start')), 3000);
    child.stdout.on('data', chunk => {
      if (!chunk.toString().includes('egress_proxy_listening')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('exit', code => reject(new Error(`proxy exited during startup: ${code}`)));
  });
}

function connectRequest(port) {
  const socket = net.connect(port, '127.0.0.1');
  socket.write('CONNECT 8.8.8.8:443 HTTP/1.1\r\nHost: 8.8.8.8:443\r\n\r\n');
  return socket;
}

test('a stalled or reset tunnel does not terminate the proxy process', async t => {
  const upstream = net.createServer();
  const upstreamPort = await listen(upstream);
  const proxyPort = await unusedPort();
  const child = spawn(process.execPath, [path.join(moduleDir, 'server.mjs')], {
    env: {
      ...process.env,
      EGRESS_PROXY_PORT: String(proxyPort),
      EGRESS_UPSTREAM: `http://127.0.0.1:${upstreamPort}`,
      EGRESS_CONNECT_TIMEOUT_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  t.after(() => upstream.close());
  await waitForListening(child);

  const stalled = connectRequest(proxyPort);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stalled tunnel was not closed')), 1000);
    stalled.once('close', () => { clearTimeout(timer); resolve(); });
    stalled.once('error', () => {});
  });
  assert.equal(child.exitCode, null);

  const reset = connectRequest(proxyPort);
  reset.on('error', () => {});
  reset.destroy();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null);

  const subsequent = connectRequest(proxyPort);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('subsequent tunnel was not accepted')), 1000);
    subsequent.once('close', () => { clearTimeout(timer); resolve(); });
    subsequent.once('error', () => {});
  });
  assert.equal(child.exitCode, null);
});
