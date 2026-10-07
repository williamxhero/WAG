import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const publicLocation = 'https://8.8.8.8/';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function browserFixture(t) {
  const waits = [];
  const sessions = new Map();
  const streams = new Set();
  const failure = { tool: null };
  const app = createMcpExpressApp({ host: '127.0.0.1' });
  app.all('/mcp', async (req, res) => {
    if (req.method === 'GET') {
      streams.add(res);
      res.once('close', () => streams.delete(res));
    }
    if (req.body?.method === 'tools/call' && req.body.params.name === failure.tool) {
      return res.json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32603, message: 'offline upstream failure' } });
    }
    let transport = sessions.get(req.get('mcp-session-id'))?.transport;
    if (!transport && req.method === 'POST') {
      const server = new McpServer({ name: 'offline-playwright', version: '1.0.0' });
      // Locked Playwright MCP accepts fractional seconds. Record rather than sleep.
      server.registerTool('browser_wait_for', { inputSchema: { time: z.number().optional() } }, async ({ time }) => {
        waits.push(time);
        if (!time) return { isError: true, content: [{ type: 'text', text: 'Either time, text or textGone must be provided' }] };
        return { content: [{ type: 'text', text: 'wait complete' }] };
      });
      server.registerTool('browser_evaluate', { inputSchema: { function: z.string() } }, async () => ({
        content: [{ type: 'text', text: JSON.stringify(publicLocation) }],
      }));
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: id => sessions.set(id, { server, transport }),
      });
      await server.connect(transport);
    }
    if (!transport) return res.status(404).end();
    await transport.handleRequest(req, res, req.body);
  });
  const upstream = http.createServer(app);
  const upstreamPort = await listen(upstream);
  t.after(async () => {
    for (const { server } of sessions.values()) await server.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  });

  const reservation = http.createServer();
  const gatewayPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const token = crypto.randomUUID();
  const child = spawn(process.execPath, [path.join(moduleDir, 'server.mjs')], {
    cwd: moduleDir,
    env: {
      ...process.env,
      GATEWAY_TOKEN: token,
      CRAWL4AI_TOKEN: '',
      GATEWAY_BIND_HOST: '127.0.0.1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_ALLOWED_HOSTS: '127.0.0.1',
      GATEWAY_PORT: String(gatewayPort),
      GATEWAY_TOKEN_RATE_LIMIT: '1000',
      PLAYWRIGHT_MCP_URL: `http://127.0.0.1:${upstreamPort}/mcp`,
      SEARXNG_URL: `http://127.0.0.1:${upstreamPort}`,
      CRAWL4AI_URL: `http://127.0.0.1:${upstreamPort}`,
      EGRESS_PROXY: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  });
  await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`gateway startup timed out: ${output}`)), 5000);
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (output.includes('web-access-gateway listening')) finish();
    });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    child.once('exit', code => finish(new Error(`gateway exited during startup (${code}): ${output}`)));
  });
  const client = new Client({ name: 'browser-contract-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  t.after(() => client.close());
  const call = args => client.callTool({ name: 'web_browser', arguments: args });
  const close = session_id => call({ session_id, actions: [{ type: 'close' }] });
  const disconnected = () => new Promise((resolve, reject) => {
    if (!streams.size) return resolve();
    const timer = setTimeout(() => reject(new Error('upstream browser stream was not closed')), 1000);
    for (const stream of streams) stream.once('close', () => {
      if (streams.size) return;
      clearTimeout(timer);
      resolve();
    });
  });
  return { client, waits, call, close, failure, streams, disconnected };
}

test('web_browser forwards 1000 milliseconds as one upstream second', { timeout: 15000 }, async t => {
  const fixture = await browserFixture(t);
  const result = await fixture.call({ actions: [{ type: 'wait', ms: 1000 }] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(fixture.waits, [1]);
  await fixture.close(result.structuredContent.session_id);
});

test('web_browser accepts a zero-millisecond no-op despite the upstream zero guard', { timeout: 15000 }, async t => {
  const fixture = await browserFixture(t);
  const result = await fixture.call({ actions: [{ type: 'wait', ms: 0 }] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(fixture.waits, []);
  assert.equal(result.structuredContent.outputs[0].isError, undefined);
  assert.equal(result.structuredContent.url, publicLocation);
  assert.deepEqual(result.structuredContent.source, { url: publicLocation, host: '8.8.8.8' });
  assert.equal(result.structuredContent.outputs[0].content[0].text, 'Waited for 0 seconds');
  await fixture.close(result.structuredContent.session_id);
});

test('web_browser preserves the default, upper boundary and fractional upstream seconds', { timeout: 15000 }, async t => {
  const fixture = await browserFixture(t);
  const result = await fixture.call({ actions: [
    { type: 'wait' },
    { type: 'wait', ms: 10000 },
    { type: 'wait', ms: 1 },
    { type: 'wait', ms: 250 },
    { type: 'wait', ms: 999 },
    { type: 'wait', ms: 1001 },
    { type: 'wait', ms: 1500 },
    { type: 'wait', ms: 9999 },
  ] });
  assert.equal(result.isError, undefined);
  assert.deepEqual(fixture.waits, [1, 10, 0.001, 0.25, 0.999, 1.001, 1.5, 9.999]);
  assert.equal(result.structuredContent.outputs.length, 8);
  await fixture.close(result.structuredContent.session_id);
});

test('web_browser rejects invalid milliseconds before upstream work without closing a valid session', { timeout: 15000 }, async t => {
  const fixture = await browserFixture(t);
  const opened = await fixture.call({ actions: [{ type: 'wait', ms: 1 }] });
  const session_id = opened.structuredContent.session_id;
  for (const ms of [-1, 10001, 0.5, '1000', null, true, {}, []]) {
    const result = await fixture.call({ session_id, actions: [{ type: 'wait', ms }] });
    assert.equal(result.isError, true, `invalid ms: ${JSON.stringify(ms)}`);
  }
  assert.deepEqual(fixture.waits, [0.001]);
  const valid = await fixture.call({ session_id, actions: [{ type: 'wait', ms: 500 }] });
  assert.equal(valid.isError, undefined);
  assert.deepEqual(fixture.waits, [0.001, 0.5]);
  await fixture.close(session_id);
});

test('web_browser keeps the advertised millisecond, action and scroll ranges', { timeout: 15000 }, async t => {
  const fixture = await browserFixture(t);
  const { tools } = await fixture.client.listTools();
  const { actions } = tools.find(tool => tool.name === 'web_browser').inputSchema.properties;
  assert.deepEqual(actions.items.properties.type.enum, ['navigate', 'click', 'wait', 'scroll', 'snapshot', 'screenshot', 'close']);
  assert.equal(actions.minItems, 1);
  assert.equal(actions.maxItems, 8);
  assert.deepEqual(actions.items.properties.ms, { type: 'integer', minimum: 0, maximum: 10000 });
  assert.deepEqual(actions.items.properties.pixels, { type: 'integer', minimum: -3000, maximum: 3000 });
  const invalid = await fixture.call({ actions: [{ type: 'fill', ms: 1000 }] });
  assert.equal(invalid.isError, true);
  assert.deepEqual(fixture.waits, []);
});

for (const [label, failingTool, ms] of [
  ['upstream wait failure', 'browser_wait_for', 1500],
  ['location failure after a zero-duration no-op', 'browser_evaluate', 0],
]) {
  test(`web_browser closes and removes its session on ${label}`, { timeout: 15000 }, async t => {
    const fixture = await browserFixture(t);
    for (let attempt = 0; attempt < 3; attempt++) {
      const opened = await fixture.call({ actions: [{ type: 'wait', ms: 1 }] });
      assert.equal(opened.isError, undefined);
      const session_id = opened.structuredContent.session_id;
      assert.equal(fixture.streams.size, 1);
      fixture.failure.tool = failingTool;
      const failed = await fixture.call({ session_id, actions: [{ type: 'wait', ms }] });
      assert.equal(failed.isError, true);
      assert.match(failed.structuredContent.error.message, /offline upstream failure/);
      await fixture.disconnected();
      assert.equal(fixture.streams.size, 0);
      fixture.failure.tool = null;
      const stale = await fixture.call({ session_id, actions: [{ type: 'wait', ms: 1000 }] });
      assert.equal(stale.isError, true);
      assert.match(stale.structuredContent.error.message, /absent or expired/);
    }
    const recovered = await fixture.call({ actions: [{ type: 'wait', ms: 1000 }] });
    assert.equal(recovered.isError, undefined);
    assert.deepEqual(fixture.waits, [0.001, 0.001, 0.001, 1]);
    await fixture.close(recovered.structuredContent.session_id);
  });
}