import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { listenHttp } from './fixtures/safe-listen.mjs';

// MCP-boundary proof for the engine-supply diagnostics (SPEC #74). The search module tests the pool
// selection in isolation; this file checks that a *configured* pool actually shapes the outgoing
// SearXNG query and that `engine_pool` / `failure_classes` are forwarded to the MCP caller — while an
// unconfigured gateway still grows no pool keys.

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const SEARCH_BODY = {
  results: [{ title: 'Detailed report', url: 'https://publisher.example/2026/10/09/report', content: 'The full story.', engine: 'yandex' }],
  number_of_results: 1,
  unresponsive_engines: [['quark', '暂停服务: 验证码']],
};

function classify(error) {
  const codes = ['EADDRINUSE', 'EADDRNOTAVAIL', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOENT', 'EACCES', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'WAG_TEST_SAFE_LISTEN_INVALID_OPTIONS', 'WAG_TEST_SAFE_LISTEN_EXHAUSTED'];
  let cause = 'unknown'; let code = 'unknown';
  for (let depth = 0; error && depth <= 2; depth++) {
    if (error.message === 'bad port') cause = 'bad_port';
    if (codes.includes(error.code)) code = error.code;
    if (depth < 2) error = error.cause;
  }
  return { cause, code };
}

const boundedCount = value => Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : null;
const boundedPort = value => Number.isInteger(value) && value > 0 && value <= 65535 ? value : null;

async function listen(server, options = {}) {
  return (await listenHttp(server, options)).port;
}

async function gatewayFixture(t, env = {}, options = {}) {
  const requests = []; const servers = []; const sockets = new Set();
  const ports = { backend: null, gateway: null };
  const attempts = { backend: 0, gateway: 0 };
  const role = ['backend', 'gateway'].includes(options.role) ? options.role : 'fixture';
  let stage = 'initialize'; let firstPort = null; let forbiddenCloses = 0;
  let toolAttempts = 0; let backendFetchAttempts = options.observeBackend ? 0 : null;
  let mcpConnected = 0; let toolOutcome = 'unknown';
  let connectionCause = 'unknown'; let connectionCode = 'unknown';
  let child; let exited; let childClosed = false; let client; let transport; let closing;
  const diagnostics = error => {
    const classification = classify(error);
    if (classification.cause !== 'unknown') connectionCause = classification.cause;
    if (classification.code !== 'unknown') connectionCode = classification.code;
    return JSON.stringify({ ports: { backend: boundedPort(ports.backend), gateway: boundedPort(ports.gateway) }, role, stage,
      first_port: boundedPort(firstPort), backend_listen_attempts: boundedCount(attempts.backend), gateway_listen_attempts: boundedCount(attempts.gateway),
      forbidden_closes: boundedCount(forbiddenCloses), mcp_tool_attempts: boundedCount(toolAttempts), backend_received: boundedCount(requests.length),
      backend_fetch_attempts: boundedCount(backendFetchAttempts), mcp_connected: mcpConnected, tool_outcome: toolOutcome,
      connection_cause: connectionCause, connection_code: connectionCode });
  };
  const failure = error => {
    const safe = new Error(diagnostics(error));
    safe.stack = `Error: ${safe.message}`;
    return safe;
  };
  const close = server => !server?.listening ? Promise.resolve() : new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const cleanup = () => closing ??= (async () => {
    let error;
    const attempt = async action => { try { await action(); } catch (cause) { error ??= cause; } };
    await attempt(() => client?.close());
    await attempt(() => transport?.close());
    await attempt(async () => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill();
      await exited;
    });
    const closed = [...sockets].map(socket => new Promise(resolve => { socket.once('close', resolve); socket.destroy(); }));
    await Promise.all(servers.map(server => attempt(async () => {
      try { await close(server); } catch (cause) {
        // A throwing fixture close hook must not leave the owned listener alive.
        if (server.listening) await new Promise((resolve, reject) => http.Server.prototype.close.call(server, error => error ? reject(error) : resolve()));
        throw cause;
      }
    })));
    await Promise.all(closed);
    if (error) { stage = 'cleanup'; throw failure(error); }
  })();
  // Install the one idempotent hook before any acquisition, including partial initialization.
  t.after(cleanup);
  const fail = async error => {
    diagnostics(error);
    try { await cleanup(); } catch (cleanupError) { return cleanupError; }
    return failure();
  };
  const own = server => {
    servers.push(server);
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    return server;
  };
  const bind = async (server, bindRole) => {
    stage = `${bindRole}_bind`;
    const listenOptions = options.listenOptions?.[bindRole] ?? {};
    const injected = listenOptions.listen ?? ((server, options) => server.listen(options));
    return listen(server, { ...listenOptions, listen: (server, bindOptions) => {
      // A failed fixed-port first bind is setup failure, never permission to fall back to port 0.
      if (bindRole === role && attempts[bindRole] > 0 && firstPort === null) throw new Error();
      attempts[bindRole]++;
      if (bindRole === role && attempts[bindRole] === 1) {
        server.once('error', error => diagnostics(error));
        server.once('listening', () => { firstPort = server.address().port; ports[bindRole] = firstPort; });
        server.once('close', () => { forbiddenCloses++; });
      }
      injected(server, bindOptions);
    } });
  };
  try {
    options.observe?.({ servers, sockets, ports, cleanup, resources: () => ({ child, childClosed, client, transport }) });
    options.initialize?.();
    const upstream = own(http.createServer((req, res) => {
      const url = new URL(req.url, 'http://searxng.test');
      if (url.pathname !== '/search') { res.writeHead(404).end('unexpected fixture path'); return; }
      requests.push(url);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(SEARCH_BODY));
    }));
    const upstreamPort = ports.backend = await bind(upstream, 'backend');
    const reservation = own(http.createServer());
    const gatewayPort = ports.gateway = await bind(reservation, 'gateway');
    stage = 'reservation_release';
    await close(reservation);

    const token = crypto.randomUUID();
    let args = [path.join(moduleDir, 'server.mjs')];
    if (options.observeBackend) {
      // A transparent native-Fetch observer for role evidence only. No input, payload or raw error
      // crosses IPC; the original response/error is returned/thrown unchanged in the real child.
      const source = `
        const classify = ${classify.toString()};
        const nativeFetch = globalThis.fetch;
        const report = facts => new Promise(resolve => process.send(facts, () => resolve()));
        globalThis.fetch = async (...args) => {
          const observed = typeof args[0] === 'string' && args[0].startsWith(${JSON.stringify(`http://127.0.0.1:${upstreamPort}/search?`)});
          if (observed) await report({ kind: 'backend_fetch' });
          try { return await nativeFetch(...args); } catch (error) {
            if (observed) await report({ kind: 'backend_failure', ...classify(error) });
            throw error;
          }
        };
        await import(${JSON.stringify(pathToFileURL(path.join(moduleDir, 'server.mjs')).href)});
      `;
      args = ['--input-type=module', '--eval', source];
    }
    stage = 'startup';
    child = (options.launch ?? spawn)(process.execPath, args, {
      cwd: moduleDir,
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        GATEWAY_TOKEN: token, CRAWL4AI_TOKEN: '',
        GATEWAY_BIND_HOST: '127.0.0.1', GATEWAY_HOST: '127.0.0.1', GATEWAY_ALLOWED_HOSTS: '127.0.0.1',
        GATEWAY_PORT: String(gatewayPort), GATEWAY_TOKEN_RATE_LIMIT: '1000', SEARXNG_URL: `http://127.0.0.1:${upstreamPort}`,
        WAG_SEARCH_ENGINE_POOL_GENERAL: '', WAG_SEARCH_ENGINE_POOL_NEWS: '', WAG_SEARCH_ENGINE_POOL_STRICT: '', ...env,
      },
      stdio: options.observeBackend ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    });
    exited = new Promise(resolve => child.once('close', () => { childClosed = true; resolve(); }));
    child.on('error', error => diagnostics(error));
    child.on('message', message => {
      if (message?.kind === 'backend_fetch') backendFetchAttempts++;
      if (message?.kind === 'backend_failure') {
        if (message.cause === 'bad_port') connectionCause = 'bad_port';
        if (classify({ code: message.code }).code !== 'unknown') connectionCode = message.code;
      }
    });
    await new Promise((resolve, reject) => {
      const marker = 'web-access-gateway listening'; let prefix = ''; let settled = false;
      const timer = setTimeout(() => finish(new Error()), 10000);
      const finish = error => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        child.off('error', onError); child.off('close', onClose);
        error ? reject(error) : resolve();
      };
      const onError = error => finish(error);
      const onClose = () => finish(new Error());
      child.once('error', onError); child.once('close', onClose);
      child.stdout.on('data', chunk => {
        // Retain only a bounded known-marker prefix; both pipes are drained without storing logs.
        for (const character of chunk.toString()) {
          prefix += character;
          while (prefix && !marker.startsWith(prefix)) prefix = prefix.slice(1);
          if (prefix === marker) { prefix = ''; finish(); }
        }
      });
      child.stderr.on('data', () => {});
    });
    stage = 'connect';
    client = new Client({ name: 'search-engine-pool-contract-test', version: '1.0.0' });
    transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    mcpConnected = 1;
    const search = async args => {
      stage = 'tool'; toolAttempts++;
      try {
        await options.beforeTool?.({ child, exited });
        const result = await client.callTool({ name: 'web_search', arguments: args });
        toolOutcome = result.isError === true ? 'error' : 'success';
        return result;
      } catch (error) { throw await fail(error); }
    };
    return { search, requests, diagnostics, cleanup, fail, ports, servers, sockets,
      resources: () => ({ child, childClosed, client, transport }) };
  } catch (error) { throw await fail(error); }
}

async function contract(t, env, options, check) {
  const gateway = await gatewayFixture(t, env, options);
  try { await check(gateway); } catch (error) { throw await gateway.fail(error); }
  return gateway;
}

function noPoolAssertions(result, requests, diagnostics) {
  assert.notEqual(result.isError, true, diagnostics());
  const payload = result.structuredContent;

  assert.equal(requests.at(-1).searchParams.has('engines'), false);
  assert.equal(Object.hasOwn(payload, 'engine_pool'), false);
  assert.equal(Object.hasOwn(payload, 'cooldown_engines'), false);
  // failure_classes is driven by the backend's own diagnostics, independent of pooling.
  assert.deepEqual(payload.failure_classes, { captcha: 1 });
}

test('a configured pool shapes the upstream query and forwards engine_pool/failure_classes over MCP', { timeout: 30000 }, async t => {
  await contract(t, { WAG_SEARCH_ENGINE_POOL_GENERAL: 'yandex,quark' }, {}, async ({ search, requests, diagnostics }) => {
    const result = await search({ query: 'report' });
    assert.notEqual(result.isError, true, diagnostics());
    const payload = result.structuredContent;

    assert.equal(requests.at(-1).searchParams.get('engines'), 'yandex,quark');
    assert.deepEqual(payload.engine_pool, { layer: 'general', engines: ['yandex', 'quark'], source: 'config' });
    assert.deepEqual(payload.unresponsive_engines, [['quark', '暂停服务: 验证码']]);
    assert.deepEqual(payload.failure_classes, { captcha: 1 });
    assert.equal(Object.hasOwn(payload, 'cooldown_engines'), false, 'captcha does not add a WAG-side cooldown');

    // text and structured MCP payloads agree.
    assert.deepEqual(JSON.parse(result.content[0].text), payload);
  });
});

test('a strict pool only asks time_range engines over MCP', { timeout: 30000 }, async t => {
  await contract(t, { WAG_SEARCH_ENGINE_POOL_STRICT: 'yandex,bing,quark,naver' }, {}, async ({ search, requests, diagnostics }) => {
    const result = await search({ query: '英伟达', time_range: 'day' });
    assert.notEqual(result.isError, true, diagnostics());
    const payload = result.structuredContent;

    assert.equal(requests.at(-1).searchParams.get('engines'), 'quark,naver');
    assert.equal(payload.engine_pool.layer, 'strict');
    assert.deepEqual(payload.engine_pool.rejected, ['yandex', 'bing']);
  });
});

test('a gateway with no pool configured forwards no pool keys', { timeout: 30000 }, async t => {
  await contract(t, {}, {}, async ({ search, requests, diagnostics }) => {
    const result = await search({ query: 'report' });
    noPoolAssertions(result, requests, diagnostics);
  });
});

for (const role of ['backend', 'gateway']) {
  test(`engine-pool fixture closes forbidden ${role === 'gateway' ? 'gateway reservation' : role} before real MCP search`, { timeout: 30000 }, async t => {
    let firstServer; let firstPort; let closed = false; let attempts = 0;
    const gateway = await contract(t, {}, { role, observeBackend: true, listenOptions: { [role]: { listen: (server, options) => {
      if (attempts === 0) {
        firstServer = server;
        server.once('listening', () => { firstPort = server.address().port; });
        server.once('close', () => { closed = true; });
      } else assert.equal(closed, true, 'first forbidden listener must complete close before rebind');
      server.listen({ ...options, port: attempts++ === 0 ? 1719 : options.port });
    } } } }, async ({ search, requests, diagnostics }) => {
      const result = await search({ query: 'report' });
      noPoolAssertions(result, requests, diagnostics);
      assert.equal(requests.length, 1, diagnostics());
      assert.equal(JSON.parse(diagnostics()).mcp_tool_attempts, 1, diagnostics());
      assert.equal(JSON.parse(diagnostics()).backend_fetch_attempts, 1, diagnostics());
      const snapshot = new Error(diagnostics()); snapshot.stack = `Error: ${snapshot.message}`;
      safeFailure(snapshot, { stage: 'tool', tools: 1, received: 1, connected: 1, fetches: 1 });
      t.diagnostic(diagnostics());
    });
    assert.equal(firstPort, 1719, gateway.diagnostics());
    assert.notEqual(gateway.ports[role], 1719, gateway.diagnostics());
    assert.ok(attempts >= 2 && attempts <= 25, gateway.diagnostics());
    assert.equal(closed, true, gateway.diagnostics());
    await gateway.cleanup();
    assert.equal(firstServer.listening, false, gateway.diagnostics());
    assertClosed(gateway);
  });
}

const sentinel = 'synthetic-private-message-stack-cause-header-body-env-token-path-child-output';

function privateError(code = sentinel, cause) {
  return Object.assign(new Error(sentinel), { code, cause, stack: sentinel,
    headers: { authorization: sentinel }, body: sentinel, env: sentinel, token: sentinel, path: sentinel });
}

function safeFailure(error, { stage, code = 'unknown', cause = 'unknown', tools = 0, received = 0, connected = 0, fetches = null } = {}) {
  assert.ok(!error.message.includes(sentinel), 'message must discard synthetic private data');
  assert.ok(!error.stack.includes(sentinel), 'stack must discard synthetic private data');
  assert.ok(error.cause === undefined, 'raw causes must not escape');
  assert.ok(Buffer.byteLength(error.message, 'utf8') <= 512, 'snapshot exceeds byte bound');
  assert.ok(Buffer.byteLength(error.stack, 'utf8') <= 512, 'safe stack exceeds byte bound');
  assert.equal(error.stack, `Error: ${error.message}`);
  let facts;
  try { facts = JSON.parse(error.message); } catch { assert.fail('failure must be fixed-schema JSON'); }
  assert.deepEqual(Object.keys(facts).sort(), ['backend_fetch_attempts', 'backend_listen_attempts', 'backend_received', 'connection_cause', 'connection_code', 'first_port', 'forbidden_closes', 'gateway_listen_attempts', 'mcp_connected', 'mcp_tool_attempts', 'ports', 'role', 'stage', 'tool_outcome']);
  assert.deepEqual(Object.keys(facts.ports).sort(), ['backend', 'gateway']);
  for (const port of [...Object.values(facts.ports), facts.first_port]) assert.ok(port === null || Number.isInteger(port) && port >= 1 && port <= 65535);
  for (const key of ['backend_fetch_attempts', 'backend_listen_attempts', 'backend_received', 'forbidden_closes', 'gateway_listen_attempts', 'mcp_connected', 'mcp_tool_attempts']) {
    assert.ok(facts[key] === null || Number.isInteger(facts[key]) && facts[key] >= 0 && facts[key] <= 1000000);
  }
  assert.ok(['fixture', 'backend', 'gateway'].includes(facts.role));
  assert.ok(['initialize', 'backend_bind', 'gateway_bind', 'reservation_release', 'startup', 'connect', 'tool', 'cleanup'].includes(facts.stage));
  assert.ok(['unknown', 'success', 'error'].includes(facts.tool_outcome));
  assert.equal(facts.stage, stage);
  assert.ok((Array.isArray(code) ? code : [code]).includes(facts.connection_code), 'connection code must match the declared native failure boundary');
  assert.equal(facts.connection_cause, cause);
  assert.equal(facts.mcp_tool_attempts, tools);
  assert.equal(facts.backend_received, received);
  assert.equal(facts.mcp_connected, connected);
  assert.equal(facts.backend_fetch_attempts, fetches, 'unobserved backend Fetch attempts must be missing, not zero');
  return true;
}

function assertClosed(gateway) {
  for (const server of gateway.servers) assert.equal(server.listening, false, 'owned listener must close');
  assert.equal(gateway.sockets.size, 0, 'owned sockets must finish close');
  const { child, childClosed, client } = gateway.resources();
  if (child) {
    assert.equal(childClosed, true, 'child close, not merely a sent signal, must complete');
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned child must exit');
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    if (child.channel) assert.equal(child.connected, false);
  }
  if (client) assert.ok(client.transport === undefined, 'real SDK client transport must disconnect');
}

function captureFixture() {
  const hooks = []; let gateway;
  return { hooks, context: { after: hook => hooks.push(hook) }, observe: value => { gateway = value; },
    check: async () => {
      assert.equal(hooks.length, 1, 'cleanup must be registered before acquisition');
      for (const hook of hooks) { const first = hook(); assert.equal(hook(), first, 'cleanup must be idempotent'); await first; }
      assertClosed(gateway);
    }, get gateway() { return gateway; } };
}

test('engine-pool fixture lifecycle cleans initialization failure before acquisition', { timeout: 30000 }, async () => {
  const capture = captureFixture();
  await assert.rejects(gatewayFixture(capture.context, {}, { observe: capture.observe, initialize: () => { throw privateError(); } }),
    error => safeFailure(error, { stage: 'initialize' }));
  await capture.check();
  assert.equal(capture.gateway.servers.length, 0);
});

for (const role of ['backend', 'gateway']) {
  test(`engine-pool fixture lifecycle cleans partial ${role} bind failure`, { timeout: 30000 }, async () => {
    const capture = captureFixture();
    await assert.rejects(gatewayFixture(capture.context, {}, { observe: capture.observe, listenOptions: { [role]: { listen: () => {
      throw privateError('EADDRNOTAVAIL', privateError());
    } } } }), error => safeFailure(error, { stage: `${role}_bind`, code: 'EADDRNOTAVAIL' }));
    await capture.check();
    assert.equal(capture.gateway.servers.length, role === 'backend' ? 1 : 2);
  });

  test(`engine-pool fixture lifecycle closes every forbidden ${role} on helper exhaustion`, { timeout: 30000 }, async () => {
    const capture = captureFixture(); let attempts = 0; let closes = 0;
    await assert.rejects(gatewayFixture(capture.context, {}, { role, observe: capture.observe, listenOptions: { [role]: {
      maxAttempts: 3, listen: (server, options) => {
        if (attempts === 0) server.on('close', () => { closes++; });
        assert.equal(closes, attempts, 'every actual forbidden bind must finish close before retry');
        attempts++; server.listen({ ...options, port: 1719 });
      },
    } } }), error => safeFailure(error, { stage: `${role}_bind`, code: 'WAG_TEST_SAFE_LISTEN_EXHAUSTED' }));
    await capture.check();
    assert.equal(attempts, 3);
    assert.equal(closes, 3);
  });

  test(`engine-pool fixture lifecycle fails busy fixed ${role} without closing its owner`, { timeout: 30000 }, async t => {
    const owner = http.createServer((_req, res) => res.end('owned synthetic listener'));
    t.after(() => new Promise(resolve => { owner.closeAllConnections(); owner.close(resolve); }));
    // No skip or external-owner kill: inability to acquire the test's owner is a setup failure.
    try {
      await new Promise((resolve, reject) => { owner.once('error', reject); owner.listen(1719, '127.0.0.1', resolve); });
    } catch (error) {
      const capture = captureFixture();
      await gatewayFixture(capture.context, {}, { observe: capture.observe, initialize: () => { throw error; } });
    }
    const capture = captureFixture(); let attempts = 0;
    await assert.rejects(gatewayFixture(capture.context, {}, { role, observe: capture.observe, listenOptions: { [role]: {
      listen: (server, options) => { attempts++; server.listen({ ...options, port: 1719 }); },
    } } }), error => safeFailure(error, { stage: `${role}_bind`, code: 'EADDRINUSE' }));
    await capture.check();
    assert.equal(attempts, 1, 'busy fixed port must never fall back or retry until free');
    assert.equal(owner.listening, true, 'fixture must not close another owner');
    await new Promise((resolve, reject) => {
      // Do not reuse the previous test owner's now-closed keep-alive socket at the same port.
      const request = http.get('http://127.0.0.1:1719/', { agent: false }, response => { response.resume(); response.once('end', resolve); });
      request.once('error', reject);
    });
    assert.equal(owner.listening, true);
  });
}

test('engine-pool fixture diagnostics bounds both cause links and never reads deeper getters', { timeout: 30000 }, async () => {
  for (const recognizedDepth of [0, 1, 2, 3, null]) {
    const capture = captureFixture(); const reads = [];
    const chain = [privateError(), privateError(), privateError(), privateError('ETIMEDOUT')];
    if (recognizedDepth !== null) {
      chain[recognizedDepth].message = 'bad port';
      chain[recognizedDepth].code = 'ECONNRESET';
    }
    for (let level = 0; level < 3; level++) Object.defineProperty(chain[level], 'cause', { get() {
      reads.push(level + 1);
      if (level === 2) throw privateError('ETIMEDOUT');
      return chain[level + 1];
    } });
    for (const error of chain) for (const key of ['headers', 'body', 'env', 'token', 'path', 'stack']) {
      Object.defineProperty(error, key, { get() { assert.fail('private diagnostic fields must never be read'); } });
    }
    await assert.rejects(gatewayFixture(capture.context, {}, { observe: capture.observe, initialize: () => { throw chain[0]; } }),
      error => safeFailure(error, { stage: 'initialize', code: recognizedDepth !== null && recognizedDepth <= 2 ? 'ECONNRESET' : 'unknown',
        cause: recognizedDepth !== null && recognizedDepth <= 2 ? 'bad_port' : 'unknown' }));
    await capture.check();
    assert.deepEqual(reads, [1, 2], 'third cause getter must remain unread');
  }
});

test('engine-pool fixture lifecycle drains private child output on startup exit', { timeout: 30000 }, async () => {
  const capture = captureFixture();
  await assert.rejects(gatewayFixture(capture.context, {}, { observe: capture.observe,
    launch: (executable, _args, options) => spawn(executable, ['--input-type=module', '--eval',
      `process.stdout.write(${JSON.stringify(sentinel)}); process.stderr.write(${JSON.stringify(sentinel)}); process.exitCode = 2;`], options),
  }), error => safeFailure(error, { stage: 'startup' }));
  await capture.check();
  assert.equal(capture.gateway.resources().child.exitCode, 2);
});

test('engine-pool fixture lifecycle cleans actual ten second startup timeout', { timeout: 30000 }, async () => {
  const capture = captureFixture(); const started = performance.now();
  await assert.rejects(gatewayFixture(capture.context, {}, { observe: capture.observe,
    launch: (executable, _args, options) => spawn(executable, ['--input-type=module', '--eval',
      `process.stdout.write(${JSON.stringify(sentinel)}); process.stderr.write(${JSON.stringify(sentinel)}); setInterval(() => {}, 1000);`], options),
  }), error => safeFailure(error, { stage: 'startup' }));
  assert.ok(performance.now() - started >= 10000, 'startup budget must not be shortened in timeout coverage');
  await capture.check();
});

test('engine-pool fixture lifecycle cleans failed child acquisition', { timeout: 30000 }, async () => {
  const capture = captureFixture();
  await assert.rejects(gatewayFixture(capture.context, {}, { observe: capture.observe,
    launch: (_executable, args, options) => spawn(path.join(moduleDir, sentinel, 'not-an-executable'), args, options),
  }), error => safeFailure(error, { stage: 'startup', code: 'ENOENT' }));
  await capture.check();
});

test('engine-pool fixture lifecycle redacts real rejected MCP initialization headers and body', { timeout: 30000 }, async () => {
  const capture = captureFixture(); const received = [];
  await assert.rejects(gatewayFixture(capture.context, {}, { observe: capture.observe, launch: (executable, _args, options) => {
    const source = `
      import http from 'node:http';
      const server = http.createServer((req, res) => {
        req.resume();
        process.send({ mcpPost: req.method === 'POST' && req.url === '/mcp', status: 503 }, () => {
          res.writeHead(503, { 'content-type': 'text/plain', 'x-private-fixture': ${JSON.stringify(sentinel)} });
          res.end(${JSON.stringify(sentinel)});
        });
      });
      server.listen(Number(process.env.GATEWAY_PORT), '127.0.0.1', () => {
        process.stderr.write(${JSON.stringify(sentinel)});
        process.stdout.write('web-access-gateway listening\\n');
      });
    `;
    const child = spawn(executable, ['--input-type=module', '--eval', source], { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.on('message', message => received.push(message));
    return child;
  } }), error => safeFailure(error, { stage: 'connect' }));
  await capture.check();
  assert.deepEqual(received, [{ mcpPost: true, status: 503 }]);
});

test('engine-pool fixture lifecycle cleans real tool rejection after gateway exit', { timeout: 30000 }, async () => {
  const capture = captureFixture();
  const gateway = await gatewayFixture(capture.context, {}, { observe: capture.observe, beforeTool: async ({ child, exited }) => {
    child.kill(); await exited;
  } });
  await assert.rejects(gateway.search({ query: sentinel }), error => safeFailure(error, {
    stage: 'tool', code: ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE'], tools: 1, connected: 1,
  }));
  await capture.check();
  assert.equal(gateway.requests.length, 0);
});

for (const resource of ['server', 'client']) {
  test(`engine-pool fixture lifecycle attempts all owned cleanup after ${resource} close throws`, { timeout: 30000 }, async () => {
    const capture = captureFixture();
    const gateway = await gatewayFixture(capture.context, {}, { observe: capture.observe });
    const result = await gateway.search({ query: 'report' });
    noPoolAssertions(result, gateway.requests, gateway.diagnostics);
    const { client, transport } = gateway.resources();
    let transportCloses = 0;
    const transportClose = transport.close.bind(transport);
    transport.close = async () => { transportCloses++; await transportClose(); };
    if (resource === 'server') gateway.servers[0].close = () => { throw privateError('EACCES'); };
    else {
      const clientClose = client.close.bind(client);
      client.close = async () => { await clientClose(); throw privateError('EACCES'); };
    }
    const first = gateway.cleanup();
    assert.equal(gateway.cleanup(), first);
    await assert.rejects(first, error => safeFailure(error, { stage: 'cleanup', code: 'EACCES', tools: 1, received: 1, connected: 1 }));
    for (const hook of capture.hooks) await assert.rejects(hook(), error => safeFailure(error, { stage: 'cleanup', code: 'EACCES', tools: 1, received: 1, connected: 1 }));
    assert.ok(transportCloses >= 1, 'transport cleanup must still be attempted');
    assertClosed(capture.gateway);
  });
}
