import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter, once, getEventListeners } from 'node:events';
import { Readable } from 'node:stream';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPersistentBudgetLedger, createBudgetedProviderSearch } from './provider-budget.mjs';
import { createProviderHttpTransport, signTencentRequest } from './provider-http-transport.mjs';
import { createProviderAdapter } from './provider-adapters.mjs';

const endpoints = {
  baidu: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
  aliyun: 'https://cloud-iqs.aliyuncs.com/search/unified',
  tencent: 'https://wsa.tencentcloudapi.com/',
};
const bodies = {
  baidu: { messages: [{ role: 'user', content: '合成政策' }], search_source: 'baidu_search_v2', resource_type_filter: [{ type: 'web', top_k: 10 }] },
  aliyun: { query: '合成政策', engineType: 'CNLiteBasic', timeRange: 'NoLimit', advancedParams: { numResults: '10' }, contents: { mainText: false, markdownText: false, summary: false } },
  tencent: { Query: '合成政策', Site: 'mp.weixin.qq.com', Freshness: 'd1' },
};
const options = name => ({ name, credentials: name === 'tencent' ? { secretId: 'dummy-secret-id', secretKey: 'dummy-secret-key' } : { apiKey: 'dummy-key' },
  tariff: name === 'baidu' ? { confirmed: true, freeQuotaOnly: true } : { confirmed: true, version: name === 'aliyun' ? 'CNLiteBasic' : 'lite', costCents: name === 'aliyun' ? 1 : 2 },
  now: () => 1551113065000 });
const input = (name, extra = {}) => ({ endpoint: endpoints[name], body: bodies[name],
  ...(name === 'tencent' ? { api: { action: 'SearchPro', version: '2025-05-08' } } : {}), maxResponseBytes: 262144, signal: new AbortController().signal, ...extra });

function mockRequest({ status = 200, headers = {}, chunks = ['{}'], error, hang = false } = {}) {
  const calls = [];
  const request = (url, config, callback) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = payload => {
      calls.push({ url, config, payload, req });
      queueMicrotask(() => {
        if (error) return req.emit('error', error);
        if (hang || req.destroyed) return;
        const res = Readable.from(chunks);
        res.statusCode = status;
        res.headers = headers;
        calls.at(-1).res = res;
        callback(res);
      });
    };
    return req;
  };
  return { request, calls };
}

const scratchRoot = tmpdir();
async function scratch(t) {
  const directory = await mkdtemp(path.join(scratchRoot, 'wag-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function certificate(t, hostname = 'qianfan.baidubce.com') {
  const directory = await scratch(t);
  const key = path.join(directory, 'dummy-key.pem');
  const cert = path.join(directory, 'dummy-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert,
    '-subj', `/CN=${hostname}`, '-addext', `subjectAltName=DNS:${hostname}`], { stdio: 'ignore' });
  return { key: await readFile(key), cert: await readFile(cert) };
}
async function tlsFixture(t, identity, respond) {
  const sockets = new Set();
  const calls = [];
  const server = https.createServer(identity, (req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { calls.push({ headers: req.headers, url: req.url, body }); respond(req, res); });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('tlsClientError', () => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    const closed = new Promise(resolve => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
  });
  return {
    calls,
    request(trust = true) {
      // Keep provider hostname/SNI/default checkServerIdentity. Only TCP destination and
      // trust root change in this trusted test seam; no DNS or provider network requests.
      return (url, options, callback) => https.request(url, { ...options, port: server.address().port, autoSelectFamily: false,
        lookup: (host, config, callback) => callback(null, '127.0.0.1', 4), ...(trust ? { ca: identity.cert } : {}) }, callback);
    },
    async drained() {
      const deadline = Date.now() + 2000;
      while (sockets.size && Date.now() < deadline) await delay(10);
      assert.equal(sockets.size, 0, 'client must close sockets without fixture cleanup');
    },
  };
}

test('real loopback TLS accepts trusted provider identity and rejects untrusted or wrong hostname', { timeout: 15000 }, async t => {
  const fixture = await tlsFixture(t, await certificate(t), (req, res) => res.end('{}'));
  const transport = createProviderHttpTransport({ ...options('baidu'), request: fixture.request() });
  assert.deepEqual(await transport(input('baidu')), { status: 200, body: '{}' });
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].headers.host, 'qianfan.baidubce.com');
  assert.equal(fixture.calls[0].url, '/v2/ai_search/web_search');
  assert.equal(fixture.calls[0].body, JSON.stringify(bodies.baidu));
  await assert.rejects(createProviderHttpTransport({ ...options('baidu'), request: fixture.request(false) })(input('baidu')), { kind: 'transport_error' });
  assert.equal(fixture.calls.length, 1, 'untrusted TLS cannot send HTTP');
  await fixture.drained();
  const wrong = await tlsFixture(t, await certificate(t, 'wrong.test'), (req, res) => res.end('{}'));
  await assert.rejects(createProviderHttpTransport({ ...options('baidu'), request: wrong.request() })(input('baidu')), { kind: 'transport_error' });
  assert.equal(wrong.calls.length, 0, 'trusted certificate with wrong hostname cannot send HTTP');
  await wrong.drained();
});

test('real TLS bounds chunked bytes, headers, compression, redirects and truncated bodies', { timeout: 15000 }, async t => {
  const identity = await certificate(t);
  for (const [respond, expected, maxResponseBytes = 8] of [
    [(req, res) => { res.write(Buffer.from([0xe4])); res.end(Buffer.from([0xb8, 0xad])); }, null, 3],
    [(req, res) => { res.write('12345'); res.end('6789'); }, 'response_too_large'],
    [(req, res) => res.writeHead(200, { 'Content-Length': '100' }).end('private'), 'response_too_large'],
    [(req, res) => res.writeHead(200, { 'X-Private': 'x'.repeat(17000) }).end('{}'), 'transport_error'],
    [(req, res) => res.writeHead(200, { 'Content-Encoding': 'gzip' }).end('private'), 'unsupported_encoding'],
    [(req, res) => res.writeHead(302, { Location: 'https://private.test/dummy-key' }).end('private'), 'redirect_blocked'],
    [(req, res) => { res.writeHead(200, { 'Content-Length': '8' }); res.write('123'); setImmediate(() => res.destroy()); }, 'transport_error'],
    [(req, res) => res.end(Buffer.from([255])), 'invalid_response'],
  ]) {
    const fixture = await tlsFixture(t, identity, respond);
    const transport = createProviderHttpTransport({ ...options('baidu'), request: fixture.request() });
    const signal = new AbortController().signal;
    if (expected) await assert.rejects(transport(input('baidu', { maxResponseBytes, signal })), error => {
      assert.equal(error.kind, expected);
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(error.stack + JSON.stringify(error), /private|dummy-key|Authorization/);
      return true;
    });
    else assert.equal((await transport(input('baidu', { maxResponseBytes, signal }))).body, '中');
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].headers['accept-encoding'], 'identity');
    assert.equal(getEventListeners(signal, 'abort').length, 0);
    await fixture.drained();
  }
  const denied = await tlsFixture(t, identity, (req, res) => res.writeHead(401).write('private'));
  assert.deepEqual(await createProviderHttpTransport({ ...options('baidu'), request: denied.request() })(input('baidu')), { status: 401, body: '' });
  await denied.drained();
});

test('real TLS total deadline stops slow trickle and abort closes an active response', { timeout: 15000 }, async t => {
  const identity = await certificate(t);
  const slow = await tlsFixture(t, identity, (req, res) => {
    res.write('x');
    const timer = setInterval(() => res.write('x'), 20);
    res.once('close', () => clearInterval(timer));
  });
  const signal = new AbortController().signal;
  await assert.rejects(createProviderHttpTransport({ ...options('baidu'), request: slow.request(), timeoutMs: 150 })(input('baidu', { signal })), { kind: 'timeout' });
  assert.equal(slow.calls.length, 1);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  await slow.drained();
  const controller = new AbortController();
  const received = new EventEmitter();
  const active = await tlsFixture(t, identity, (req, res) => { res.write('{}'); received.emit('response'); });
  const started = once(received, 'response');
  const pending = createProviderHttpTransport({ ...options('baidu'), request: active.request() })(input('baidu', { signal: controller.signal }));
  const rejected = assert.rejects(pending, { kind: 'aborted' });
  await started;
  controller.abort(new Error('private dummy-key abort reason'));
  await rejected;
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await active.drained();
});

const golden = 'TC3-HMAC-SHA256 Credential=dummy-secret-id/2019-02-25/wsa/tc3_request, SignedHeaders=content-type;host, Signature=7bf4126047eaf16a06f5328e1da13bad97087219cea0de4863e069ebed9f27d1';
test('TC3 fixed dummy golden matches independent Python/official SDK canonical algorithm', () => {
  const headers = signTencentRequest({ secretId: 'dummy-secret-id', secretKey: 'dummy-secret-key', timestamp: 1551113065, payload: JSON.stringify(bodies.tencent) });
  assert.equal(headers.Authorization, golden);
  assert.equal(headers['X-TC-Action'], 'SearchPro');
  assert.equal(headers['X-TC-Version'], '2025-05-08');
  assert.equal(headers['X-TC-Timestamp'], '1551113065');
  assert.equal(headers.Host, 'wsa.tencentcloudapi.com');
  assert.notEqual(signTencentRequest({ secretId: 'dummy-secret-id', secretKey: 'dummy-secret-key', timestamp: 1551113065, payload: '{}' }).Authorization, golden);
});

test('matches existing adapter seam, sends one auth header, verifies TLS, no retry', async () => {
  for (const name of Object.keys(endpoints)) {
    const mock = mockRequest();
    const transport = createProviderHttpTransport({ ...options(name), request: mock.request });
    assert.deepEqual(await transport(input(name)), { status: 200, body: '{}' });
    assert.equal(mock.calls.length, 1);
    const { url, config, payload } = mock.calls[0];
    assert.equal(url.href, endpoints[name]);
    assert.equal(payload, JSON.stringify(bodies[name]));
    assert.equal(config.rejectUnauthorized, true);
    assert.equal(config.agent, false);
    assert.equal(config.method, 'POST');
    assert.equal(config.maxHeaderSize, 16384);
    assert.equal(config.headers['Accept-Encoding'], 'identity');
    assert.equal(config.headers['Content-Length'], Buffer.byteLength(payload));
    assert.equal(config.headers['X-Appbuilder-Authorization'], undefined);
    assert.equal(config.headers.Authorization, name === 'tencent' ? golden : 'Bearer dummy-key');
    assert.equal(transport.estimatedCostCents, name === 'baidu' ? 0 : name === 'aliyun' ? 1 : 2);
  }
});

test('configuration and request feature/endpoint validation fail closed before send', async () => {
  for (const name of Object.keys(endpoints)) {
    const mock = mockRequest();
    for (const extra of [{ credentials: {} }, { tariff: undefined }, { tariff: { confirmed: false } }, { timeoutMs: 0 }, { maxRequestBytes: 0 }, { endpoint: 'https://evil.test' }]) {
      assert.throws(() => createProviderHttpTransport({ ...options(name), request: mock.request, ...extra }));
    }
    const transport = createProviderHttpTransport({ ...options(name), request: mock.request });
    for (const extra of [{ endpoint: endpoints[name] + '?x=1' }, { endpoint: 'http://127.0.0.1/' }, { endpoint: 'https://evil.test/' }, { headers: { Authorization: 'private' } }, { maxResponseBytes: Infinity }, { signal: {} }, { body: { ...bodies[name], extra: 'private' } }, { api: { action: 'Other', version: '2025-05-08' } }]) {
      await assert.rejects(transport(input(name, extra)), { kind: 'invalid_transport_request' });
    }
    assert.equal(mock.calls.length, 0);
  }
  for (const credentials of [{ apiKey: 'private\r\nInjected: x' }, { apiKey: ' x ' }, { apiKey: '' }]) assert.throws(() => createProviderHttpTransport({ ...options('baidu'), credentials }));
  for (const tariff of [{ confirmed: true, version: 'standard', costCents: 2 }, { confirmed: true, version: 'flagship', costCents: 100 }, { confirmed: true, version: 'lite', costCents: 0 }]) assert.throws(() => createProviderHttpTransport({ ...options('tencent'), tariff }));
  const mock = mockRequest();
  const ali = createProviderHttpTransport({ ...options('aliyun'), request: mock.request });
  for (const body of [{ ...bodies.aliyun, engineType: 'CNAuto' }, { ...bodies.aliyun, contents: { ...bodies.aliyun.contents, summary: true } }]) await assert.rejects(ali(input('aliyun', { body })), { kind: 'invalid_transport_request' });
  assert.equal(mock.calls.length, 0);
});

test('Tencent documented-max requires confirmed integer three-cent bound and freezes the estimate', () => {
  const mock = mockRequest();
  const tariff = { confirmed: true, version: 'documented-max', costCents: 3 };
  const transport = createProviderHttpTransport({ ...options('tencent'), tariff, request: mock.request });
  assert.equal(transport.estimatedCostCents, 3);
  tariff.costCents = 2;
  tariff.version = 'lite';
  assert.equal(transport.estimatedCostCents, 3);
  assert.equal(Object.isFrozen(transport), true);
  assert.throws(() => { transport.estimatedCostCents = 2; }, TypeError);
  assert.equal(createProviderHttpTransport({ ...options('tencent'), tariff: { confirmed: true, version: 'documented-max', costCents: 4 } }).estimatedCostCents, 4);
  assert.equal(createProviderHttpTransport(options('tencent')).estimatedCostCents, 2);
  for (const extra of [{ costCents: 2 }, { costCents: 0 }, { costCents: 3.1 }, { costCents: Infinity }, { costCents: Number.MAX_SAFE_INTEGER + 1 }, { confirmed: false }, { confirmed: 'true' }, { version: 'unknown' }, { version: 'standard' }, { extra: true }]) {
    assert.throws(() => createProviderHttpTransport({ ...options('tencent'), request: mock.request,
      tariff: { confirmed: true, version: 'documented-max', costCents: 3, ...extra } }), { kind: 'unconfirmed_tariff' });
  }
  for (const name of ['baidu', 'aliyun']) assert.throws(() => createProviderHttpTransport({ ...options(name), request: mock.request,
    tariff: { confirmed: true, version: 'documented-max', costCents: 3 } }), { kind: 'unconfirmed_tariff' });
  assert.equal(mock.calls.length, 0);
});

test('documented-max returns only a bounded posterior Tencent version without selecting it on the wire', async () => {
  for (const version of ['lite', 'standard', 'flagship']) {
    const body = JSON.stringify({ Response: { Version: version, Pages: [] } });
    const mock = mockRequest({ chunks: [body] });
    const tariff = { confirmed: true, version: 'documented-max', costCents: 3 };
    const transport = createProviderHttpTransport({ ...options('tencent'), tariff, request: mock.request });
    tariff.version = 'lite'; // Caller mutation cannot change the captured diagnostic policy.
    assert.deepEqual(await transport(input('tencent')), { status: 200, body, tencentVersion: version });
    assert.equal(transport.estimatedCostCents, 3);
    assert.deepEqual(JSON.parse(mock.calls[0].payload), bodies.tencent);
    assert.equal(mock.calls[0].config.headers.Authorization, golden);
    assert.equal(mock.calls.length, 1);
  }
});

test('documented-max preserves Tencent API error classification without diagnosing a nonexistent result version', async () => {
  for (const [code, kind] of [['AuthFailure.SecretIdNotFound', 'authentication'], ['RequestLimitExceeded', 'rate_limited'], ['InternalError', 'upstream_error']]) {
    const body = JSON.stringify({ Response: { Error: { Code: code, Message: 'private dummy-secret-key' } } });
    const mock = mockRequest({ chunks: [body] });
    const transport = createProviderHttpTransport({ ...options('tencent'), request: mock.request,
      tariff: { confirmed: true, version: 'documented-max', costCents: 3 } });
    assert.deepEqual(await transport(input('tencent')), { status: 200, body });
    await assert.rejects(createProviderAdapter({ name: 'tencent', enabled: true, transport }).search('政策'), error =>
      error.kind === kind && error.cause === undefined && !String(error.stack).includes('private'));
    assert.equal(mock.calls.length, 2, 'each explicit invocation sends once; no retry');
  }
});

test('documented-max rejects unknown or malformed result versions and retains every Tencent request guard', async () => {
  for (const version of ['unknown-private-tier', '', 'Lite', null, 3, [], { lite: true }, 'x'.repeat(4096), undefined]) {
    const mock = mockRequest({ chunks: [JSON.stringify({ Response: { Version: version, Pages: [] } })] });
    const signal = new AbortController().signal;
    await assert.rejects(createProviderHttpTransport({ ...options('tencent'), request: mock.request,
      tariff: { confirmed: true, version: 'documented-max', costCents: 3 } })(input('tencent', { signal })), error => {
      assert.equal(error.kind, 'provider_version_mismatch');
      assert.equal(error.cause, undefined);
      assert.doesNotMatch(String(error.stack), /unknown-private-tier|dummy-secret|\{"lite"/);
      return true;
    });
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0].req.destroyed, true);
    assert.equal(mock.calls[0].res.destroyed, true);
    assert.equal(getEventListeners(signal, 'abort').length, 0);
  }
  for (const body of ['not-json-private', '{', JSON.stringify({ Response: { Error: {} } }), JSON.stringify({ Response: { Error: { Code: null } } })]) {
    const mock = mockRequest({ chunks: [body] });
    await assert.rejects(createProviderHttpTransport({ ...options('tencent'), request: mock.request,
      tariff: { confirmed: true, version: 'documented-max', costCents: 3 } })(input('tencent')), { kind: 'invalid_response' });
    assert.equal(mock.calls.length, 1);
  }
  const mock = mockRequest();
  const transport = createProviderHttpTransport({ ...options('tencent'), request: mock.request,
    tariff: { confirmed: true, version: 'documented-max', costCents: 3 } });
  for (const extra of [{ Cnt: 10 }, { Mode: 'standard' }, { Version: 'lite' }, { Freshness: 'd2' }, { Site: 'https://example.cn' }, { Query: ' ' }]) {
    await assert.rejects(transport(input('tencent', { body: { ...bodies.tencent, ...extra } })), { kind: 'invalid_transport_request' });
  }
  const body = structuredClone(bodies.tencent);
  Object.defineProperty(body, 'toJSON', { value: () => ({ ...bodies.tencent, Cnt: 10 }) });
  await assert.rejects(transport(input('tencent', { body })), { kind: 'invalid_transport_request' });
  assert.equal(mock.calls.length, 0, 'tariff approval never enables additional billed features');
  for (const status of [401, 403, 429, 503]) {
    const denied = mockRequest({ status, chunks: ['private'] });
    assert.deepEqual(await createProviderHttpTransport({ ...options('tencent'), request: denied.request,
      tariff: { confirmed: true, version: 'documented-max', costCents: 3 } })(input('tencent')), { status, body: '' });
    assert.equal(denied.calls.length, 1);
  }
});

test('validates the serialized body before signing or sending paid feature changes', async () => {
  const mock = mockRequest();
  const transport = createProviderHttpTransport({ ...options('aliyun'), request: mock.request });
  const body = structuredClone(bodies.aliyun);
  Object.defineProperty(body, 'toJSON', { value: () => ({ ...bodies.aliyun, contents: { ...bodies.aliyun.contents, summary: true } }) });
  await assert.rejects(transport(input('aliyun', { body })), { kind: 'invalid_transport_request' });
  assert.equal(mock.calls.length, 0);
});

test('bounds request/response bytes including chunked UTF8 and rejects all compressed bodies', async () => {
  const mock = mockRequest();
  const small = createProviderHttpTransport({ ...options('baidu'), request: mock.request, maxRequestBytes: 16 });
  await assert.rejects(small(input('baidu')), { kind: 'request_too_large' });
  assert.equal(mock.calls.length, 0);
  for (const reply of [
    { chunks: [Buffer.from('中'), Buffer.from('文')], expected: 'response_too_large' },
    { headers: { 'content-length': '6' }, expected: 'response_too_large' },
    { headers: { 'content-encoding': 'gzip' }, expected: 'unsupported_encoding' },
    { headers: { 'content-encoding': 'br' }, expected: 'unsupported_encoding' },
    { chunks: [Buffer.from([255])], expected: 'invalid_response' },
  ]) {
    const mocked = mockRequest(reply);
    const transport = createProviderHttpTransport({ ...options('baidu'), request: mocked.request });
    await assert.rejects(transport(input('baidu', { maxResponseBytes: 5 })), { kind: reply.expected });
    assert.equal(mocked.calls.length, 1);
    assert.equal(mocked.calls[0].req.destroyed, true);
  }
  const unicode = mockRequest({ chunks: [Buffer.from([0xe4]), Buffer.from([0xb8, 0xad])] });
  assert.equal((await createProviderHttpTransport({ ...options('baidu'), request: unicode.request })(input('baidu', { maxResponseBytes: 3 }))).body, '中');
});

test('redirect, network errors and HTTP failure bodies never leak or retry', async () => {
  for (const status of [301, 302, 307, 308]) {
    const mock = mockRequest({ status, headers: { location: 'https://evil.test/private' }, chunks: ['private-secret'] });
    await assert.rejects(createProviderHttpTransport({ ...options('aliyun'), request: mock.request })(input('aliyun')), error => error.kind === 'redirect_blocked' && !JSON.stringify(error).includes('private'));
    assert.equal(mock.calls.length, 1);
  }
  for (const status of [401, 403, 429, 503]) {
    const mock = mockRequest({ status, chunks: ['private-secret'] });
    assert.deepEqual(await createProviderHttpTransport({ ...options('aliyun'), request: mock.request })(input('aliyun')), { status, body: '' });
    assert.equal(mock.calls.length, 1);
  }
  const mock = mockRequest({ error: new Error('private-secret Authorization raw-response') });
  await assert.rejects(createProviderHttpTransport({ ...options('aliyun'), request: mock.request })(input('aliyun')), error => error.kind === 'transport_error' && !String(error.stack).includes('private') && error.cause === undefined);
});

test('real TLS adapters use the transport estimate in durable dispatch, cache skips and failures never refund', { timeout: 20000 }, async t => {
  const now = () => Date.parse('2026-10-13T04:00:00Z');
  for (const name of Object.keys(endpoints)) {
    const directory = await mkdtemp(path.join(scratchRoot, 'wag-http-budget-'));
    const databasePath = path.join(directory, 'budget.sqlite');
    const budget = createPersistentBudgetLedger({ databasePath, initialize: true, now });
    const observer = createPersistentBudgetLedger({ databasePath, now });
    t.after(async () => { observer.close(); budget.close(); await rm(directory, { recursive: true, force: true }); });
    const item = { title: '合成政策', url: 'https://example.cn/a', link: 'https://example.cn/a', date: '2026-10-13', publishedTime: '2026-10-13' };
    const reply = name === 'baidu' ? { references: [item] } : name === 'aliyun' ? { pageItems: [item] } : { Response: { Version: 'lite', Pages: [JSON.stringify(item)] } };
    let mode = 'success';
    const fixture = await tlsFixture(t, await certificate(t, new URL(endpoints[name]).hostname), (req, res) => {
      if (mode === 'failure') return res.writeHead(503).end('private dummy-key upstream');
      if (mode === 'empty') return res.end(JSON.stringify(name === 'baidu' ? { references: [] } : name === 'aliyun' ? { pageItems: [] } : { Response: { Version: 'lite', Pages: [] } }));
      res.end(JSON.stringify(reply));
    });
    const observations = [];
    const send = fixture.request();
    const config = options(name);
    if (name !== 'baidu') config.tariff.costCents = 200; // Deliberately above both known floors.
    const transport = createProviderHttpTransport({ ...config, request: (...args) => { observations.push(observer.snapshot()); return send(...args); } });
    const adapter = createProviderAdapter({ name, enabled: true, transport, ...(name === 'tencent' ? { site: 'mp.weixin.qq.com' } : {}) });
    const estimate = name === 'baidu' ? 0 : transport.estimatedCostCents + 50; // Same OR higher, never floor fallback.
    const search = createBudgetedProviderSearch({ providers: [adapter], budget, now,
      estimateCostCents: provider => { assert.equal(provider, name); return Math.max(transport.estimatedCostCents, estimate); } });
    const first = await search({ query: '政策', mode: 'strict', timeWindow: 'day' });
    assert.equal(first.attempts[0].status, 'success');
    assert.equal(first.results[0].date_status, 'claimed', 'E4 is not page-verified');
    assert.equal((await search({ query: ' 政策 ', mode: 'strict', timeWindow: 'day' })).attempts[0].status, 'cache_hit');
    assert.equal(fixture.calls.length, 1);
    assert.equal(observations[0].providers[name].dailyCalls, 1, 'committed before request creation');
    assert.equal(observations[0].globalMonthlyCents, estimate);
    mode = 'failure';
    assert.equal((await search({ query: '不同查询' })).attempts[0].status, 'upstream_error');
    assert.equal(fixture.calls.length, 2, 'failure is sent once');
    assert.equal(observations[1].globalMonthlyCents, estimate * 2);
    assert.equal(budget.snapshot().providers[name].dailyCalls, 2);
    assert.equal(budget.snapshot().globalMonthlyCents, estimate * 2);
    mode = 'empty';
    if (name !== 'baidu') {
      assert.equal((await search({ query: '预算已满' })).attempts[0].status, 'budget_exhausted');
      assert.equal(fixture.calls.length, 2, 'monthly exhausted dispatch never reaches network');
    } else {
      assert.equal((await search({ query: '空结果' })).attempts[0].status, 'empty');
      assert.equal((await search({ query: '空结果' })).attempts[0].status, 'cache_hit');
      assert.equal(budget.snapshot().providers.baidu.dailyCalls, 3);
      assert.equal(fixture.calls.length, 3);
    }
    await fixture.drained();
    budget.close();
    const reopened = createPersistentBudgetLedger({ databasePath, now });
    try { assert.equal(reopened.snapshot().globalMonthlyCents, estimate * 2); } finally { reopened.close(); }
  }
});

test('real TLS documented-max reserves first three cents, diagnoses versions and retains spend across adapter rejection', { timeout: 15000 }, async t => {
  const now = () => Date.parse('2026-10-13T04:00:00Z');
  const directory = await mkdtemp(path.join(scratchRoot, 'wag-http-budget-'));
  const databasePath = path.join(directory, 'budget.sqlite');
  const budget = createPersistentBudgetLedger({ databasePath, initialize: true, now });
  const observer = createPersistentBudgetLedger({ databasePath, now });
  t.after(async () => { observer.close(); budget.close(); await rm(directory, { recursive: true, force: true }); });
  let version = 'lite';
  const item = { title: '合成政策', url: 'https://example.cn/a', date: '2026-10-13' };
  const fixture = await tlsFixture(t, await certificate(t, 'wsa.tencentcloudapi.com'), (req, res) =>
    res.end(JSON.stringify({ Response: { Version: version, Pages: [JSON.stringify(item)] } })));
  const observations = [];
  const replies = [];
  const failures = [];
  const send = fixture.request();
  const transport = createProviderHttpTransport({ ...options('tencent'),
    tariff: { confirmed: true, version: 'documented-max', costCents: 3 },
    request: (...args) => { observations.push(observer.snapshot()); return send(...args); } });
  const adapter = createProviderAdapter({ name: 'tencent', enabled: true, site: 'mp.weixin.qq.com', transport: async value => {
    try { const reply = await transport(value); replies.push(reply); return reply; }
    catch (error) { failures.push(error); throw error; }
  } });
  const search = createBudgetedProviderSearch({ providers: [adapter], budget, now,
    estimateCostCents: name => { assert.equal(name, 'tencent'); return transport.estimatedCostCents; } });
  const first = await search({ query: '政策', mode: 'strict', timeWindow: 'day' });
  assert.equal(first.attempts[0].status, 'success');
  assert.equal(first.results[0].date_status, 'claimed');
  assert.equal(observations[0].providers.tencent.dailyCalls, 1);
  assert.equal(observations[0].providers.tencent.monthlyCents, 3, 'first committed reservation is three, not default two');
  assert.equal(observations[0].globalMonthlyCents, 3, 'separate ledger observes commit BEFORE HTTPS request creation');
  assert.equal(replies[0].tencentVersion, 'lite');
  assert.equal((await search({ query: ' 政策 ', mode: 'strict', timeWindow: 'day' })).attempts[0].status, 'cache_hit');
  assert.equal(fixture.calls.length, 1);
  assert.equal(budget.snapshot().globalMonthlyCents, 3);
  for (const known of ['standard', 'flagship']) {
    version = known;
    const result = await search({ query: `诊断${known}` });
    assert.equal(result.attempts[0].status, 'provider_version_mismatch', 'UNCHANGED adapter still rejects known nonlite results');
    assert.deepEqual(result.results, []);
    assert.equal(replies.at(-1).tencentVersion, known, 'transport accepts the documented version, not integrated result support');
    assert.equal(budget.snapshot().globalMonthlyCents, fixture.calls.length * 3);
  }
  version = 'unknown-private-tier';
  assert.equal((await search({ query: '未知版本' })).attempts[0].status, 'transport_error');
  assert.equal(failures.at(-1).kind, 'provider_version_mismatch');
  assert.doesNotMatch(String(failures.at(-1).stack), /unknown-private-tier|dummy-secret/);
  assert.equal(fixture.calls.length, 4, 'no retry on posterior failure');
  assert.equal(budget.snapshot().globalMonthlyCents, 12, 'unknown version consumed reservation; never refund');
  assert.equal((await search({ query: '未知版本' })).attempts[0].status, 'transport_error');
  assert.equal(fixture.calls.length, 5, 'failures are not cached');
  version = 'lite';
  for (let index = 5; index < 12; index++) assert.equal((await search({ query: `填满日限额${index}` })).attempts[0].status, 'success');
  assert.equal((await search({ query: '日限额已满' })).attempts[0].status, 'budget_exhausted');
  assert.equal(fixture.calls.length, 12, '12/day cap rejects before networking');
  assert.equal(observations.length, 12);
  for (const [index, snapshot] of observations.entries()) assert.equal(snapshot.globalMonthlyCents, (index + 1) * 3);
  assert.equal(budget.snapshot().providers.tencent.monthlyCents, 36);
  assert.equal((await search({ query: '政策', mode: 'strict', timeWindow: 'day' })).attempts[0].status, 'cache_hit', 'cache precedes exhausted budget');
  assert.equal(fixture.calls.length, 12);
  for (const [index, call] of fixture.calls.entries()) {
    const body = JSON.parse(call.body);
    assert.deepEqual(Object.keys(body).sort(), index === 0 ? ['Freshness', 'Query', 'Site'] : ['Query', 'Site']);
    assert.equal(body.Site, 'mp.weixin.qq.com');
    if (index === 0) assert.equal(body.Freshness, 'd1');
    assert.match(call.headers.authorization, /^TC3-HMAC-SHA256 /);
    assert.equal(call.headers['x-tc-action'], 'SearchPro');
  }
  await fixture.drained();
  budget.close();
  const reopened = createPersistentBudgetLedger({ databasePath, now });
  try { assert.equal(reopened.snapshot().globalMonthlyCents, 36); } finally { reopened.close(); }
});

test('real TLS documented-max higher bound preserves paid-empty cache, no-refund and 500/1000-cent caps', { timeout: 15000 }, async t => {
  const now = () => Date.parse('2026-10-13T04:00:00Z');
  const directory = await mkdtemp(path.join(scratchRoot, 'wag-http-budget-'));
  const databasePath = path.join(directory, 'budget.sqlite');
  const budget = createPersistentBudgetLedger({ databasePath, initialize: true, now });
  const observer = createPersistentBudgetLedger({ databasePath, now });
  t.after(async () => { observer.close(); budget.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(budget.reserve('aliyun', 500).allowed, true);
  let fail = false;
  const fixture = await tlsFixture(t, await certificate(t, 'wsa.tencentcloudapi.com'), (req, res) => {
    if (fail) return res.writeHead(503).end('private dummy-secret-key');
    res.end(JSON.stringify({ Response: { Version: 'lite', Pages: [] } }));
  });
  const observations = [];
  const send = fixture.request();
  const transport = createProviderHttpTransport({ ...options('tencent'),
    tariff: { confirmed: true, version: 'documented-max', costCents: 250 },
    request: (...args) => { observations.push(observer.snapshot()); return send(...args); } });
  const search = createBudgetedProviderSearch({ providers: [createProviderAdapter({ name: 'tencent', enabled: true, transport })], budget, now,
    estimateCostCents: () => transport.estimatedCostCents });
  assert.equal((await search({ query: '空结果' })).attempts[0].status, 'empty');
  assert.equal(observations[0].providers.tencent.monthlyCents, 250);
  assert.equal(observations[0].globalMonthlyCents, 750, 'higher confirmed estimate committed before TLS send');
  assert.equal((await search({ query: '空结果' })).attempts[0].status, 'cache_hit');
  assert.equal(fixture.calls.length, 1);
  fail = true;
  assert.equal((await search({ query: '失败查询' })).attempts[0].status, 'upstream_error');
  assert.equal(observations[1].providers.tencent.monthlyCents, 500);
  assert.equal(observations[1].globalMonthlyCents, 1000);
  assert.equal(budget.snapshot().globalMonthlyCents, 1000, 'failed send cannot refund either cap');
  assert.equal((await search({ query: '预算已满' })).attempts[0].status, 'budget_exhausted');
  assert.equal((await search({ query: '空结果' })).attempts[0].status, 'cache_hit');
  assert.equal(fixture.calls.length, 2, '500-provider/1000-global caps and cached empty never send');
  await fixture.drained();
  budget.close();
  const reopened = createPersistentBudgetLedger({ databasePath, now });
  try {
    assert.equal(reopened.snapshot().providers.tencent.monthlyCents, 500);
    assert.equal(reopened.snapshot().globalMonthlyCents, 1000);
    assert.equal(reopened.reserve('tencent', transport.estimatedCostCents).allowed, false);
  } finally { reopened.close(); }
});

test('abort during request creation closes the returned request without sending a body', async () => {
  const controller = new AbortController();
  const req = new EventEmitter();
  let sent = false;
  req.destroyed = false;
  req.destroy = () => { req.destroyed = true; };
  req.end = () => { sent = true; };
  const transport = createProviderHttpTransport({ ...options('baidu'), request: () => { controller.abort(); return req; } });
  await assert.rejects(transport(input('baidu', { signal: controller.signal })), { kind: 'aborted' });
  assert.equal(req.destroyed, true);
  assert.equal(sent, false);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('pre-abort, mid-request abort, deadline and synchronous request failure clean up', async () => {
  const mock = mockRequest({ hang: true });
  const controller = new AbortController();
  controller.abort(new Error('private abort reason'));
  const transport = createProviderHttpTransport({ ...options('baidu'), request: mock.request, timeoutMs: 20 });
  await assert.rejects(transport(input('baidu', { signal: controller.signal })), { kind: 'aborted' });
  assert.equal(mock.calls.length, 0);
  const pending = transport(input('baidu'));
  await assert.rejects(pending, { kind: 'timeout' });
  assert.equal(mock.calls[0].req.destroyed, true);
  const active = new AbortController();
  const aborted = transport(input('baidu', { signal: active.signal }));
  active.abort(new Error('private'));
  await assert.rejects(aborted, { kind: 'aborted' });
  assert.equal(mock.calls[1].req.destroyed, true);
  await assert.rejects(createProviderHttpTransport({ ...options('baidu'), request: () => { throw new Error('private'); } })(input('baidu')), { kind: 'transport_error' });
});
