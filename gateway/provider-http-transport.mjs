import https from 'node:https';
import { createHash, createHmac } from 'node:crypto';
import { TextDecoder } from 'node:util';

const ENDPOINTS = Object.freeze({
  baidu: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
  aliyun: 'https://cloud-iqs.aliyuncs.com/search/unified',
  tencent: 'https://wsa.tencentcloudapi.com/',
});
const CONTENT_TYPE = 'application/json';
function failure(kind) {
  return Object.assign(new Error(`Provider HTTP failed: ${kind}`), { kind });
}
function credential(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value);
}
function fields(value, allowed) {
  return value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).every(key => allowed.includes(key));
}
function query(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 500; }
function resultCount(value) { return Number.isInteger(value) && value >= 1 && value <= 50; }
function validBody(name, body) {
  if (name === 'baidu') return fields(body, ['messages', 'search_source', 'resource_type_filter', 'search_recency_filter']) &&
    body.search_source === 'baidu_search_v2' && Array.isArray(body.messages) && body.messages.length === 1 &&
    fields(body.messages[0], ['role', 'content']) && body.messages[0].role === 'user' && query(body.messages[0].content) &&
    Array.isArray(body.resource_type_filter) && body.resource_type_filter.length === 1 &&
    fields(body.resource_type_filter[0], ['type', 'top_k']) && body.resource_type_filter[0].type === 'web' && resultCount(body.resource_type_filter[0].top_k) &&
    (body.search_recency_filter === undefined || ['week', 'month', 'year'].includes(body.search_recency_filter));
  if (name === 'aliyun') return fields(body, ['query', 'engineType', 'timeRange', 'advancedParams', 'contents']) && query(body.query) &&
    body.engineType === 'CNLiteBasic' && ['NoLimit', 'OneDay', 'OneWeek', 'OneMonth', 'OneYear'].includes(body.timeRange) &&
    fields(body.advancedParams, ['numResults']) && typeof body.advancedParams.numResults === 'string' &&
    /^(?:[1-9]|[1-4][0-9]|50)$/.test(body.advancedParams.numResults) &&
    fields(body.contents, ['mainText', 'markdownText', 'summary']) &&
    body.contents.mainText === false && body.contents.markdownText === false && body.contents.summary === false;
  return fields(body, ['Query', 'Site', 'Freshness']) && query(body.Query) &&
    (body.Site === undefined || (typeof body.Site === 'string' && body.Site.length <= 253 && /^[a-z0-9.-]+$/i.test(body.Site))) &&
    (body.Freshness === undefined || ['d1', 'd7', 'm1', 'y1'].includes(body.Freshness));
}

// Fixed WSA POST scope; no general-purpose caller-controlled endpoint/service signing.
export function signTencentRequest({ secretId, secretKey, timestamp, payload } = {}) {
  if (!credential(secretId) || !/^[a-zA-Z0-9_-]+$/.test(secretId) || !credential(secretKey) ||
      !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 253402300799 ||
      typeof payload !== 'string' || Buffer.byteLength(payload) > 65536) throw failure('invalid_transport_configuration');
  const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
  const mac = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest();
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/wsa/tc3_request`;
  const signedHeaders = 'content-type;host';
  const canonical = `POST\n/\n\ncontent-type:${CONTENT_TYPE}\nhost:wsa.tencentcloudapi.com\n\n${signedHeaders}\n${hash(payload)}`;
  const toSign = `TC3-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(canonical)}`;
  const key = mac(mac(mac(`TC3${secretKey}`, date), 'wsa'), 'tc3_request');
  const signature = createHmac('sha256', key).update(toSign, 'utf8').digest('hex');
  return {
    Host: 'wsa.tencentcloudapi.com', 'Content-Type': CONTENT_TYPE,
    'X-TC-Action': 'SearchPro', 'X-TC-Version': '2025-05-08', 'X-TC-Timestamp': String(timestamp),
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

// request is a trusted offline-test dependency, not an endpoint/config escape hatch.
// No environment reads, proxy/global-agent reuse, retries, logging or automatic enablement.
export function createProviderHttpTransport(config = {}) {
  if (!fields(config, ['name', 'credentials', 'tariff', 'timeoutMs', 'maxRequestBytes', 'request', 'now'])) throw failure('invalid_transport_configuration');
  const { name, credentials, tariff, timeoutMs = 5000, maxRequestBytes = 16384, request = https.request, now = Date.now } = config;
  if (!Object.hasOwn(ENDPOINTS, name) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 ||
      !Number.isInteger(maxRequestBytes) || maxRequestBytes < 1 || maxRequestBytes > 65536 ||
      typeof request !== 'function' || typeof now !== 'function') throw failure('invalid_transport_configuration');
  const paid = name !== 'baidu';
  const documentedMax = name === 'tencent' && tariff?.version === 'documented-max';
  const minimumCost = name === 'aliyun' ? 1 : documentedMax ? 3 : 2;
  if (!fields(tariff, paid ? ['confirmed', 'version', 'costCents'] : ['confirmed', 'freeQuotaOnly']) || tariff.confirmed !== true ||
      (paid ? tariff.version !== (name === 'aliyun' ? 'CNLiteBasic' : documentedMax ? 'documented-max' : 'lite') || !Number.isSafeInteger(tariff.costCents) || tariff.costCents < minimumCost : tariff.freeQuotaOnly !== true)) {
    throw failure('unconfirmed_tariff');
  }
  const cost = paid ? tariff.costCents : 0;
  if (!fields(credentials, name === 'tencent' ? ['secretId', 'secretKey'] : ['apiKey']) ||
      (name === 'tencent' ? !credential(credentials.secretId) || !/^[a-zA-Z0-9_-]+$/.test(credentials.secretId) || !credential(credentials.secretKey) : !credential(credentials.apiKey))) throw failure('invalid_transport_configuration');
  // Copy only validated primitive values; caller mutation cannot change the authentication or cost.
  const auth = name === 'tencent' ? { secretId: credentials.secretId, secretKey: credentials.secretKey } : `Bearer ${credentials.apiKey}`;
  const transport = async input => {
    let payload;
    let headers;
    try {
      if (!fields(input, ['endpoint', 'api', 'body', 'maxResponseBytes', 'signal']) || input.endpoint !== ENDPOINTS[name] ||
          !Number.isInteger(input.maxResponseBytes) || input.maxResponseBytes < 1 || input.maxResponseBytes > 1048576 ||
          !(input.signal instanceof AbortSignal) || !validBody(name, input.body) ||
          (name === 'tencent' ? !fields(input.api, ['action', 'version']) || input.api.action !== 'SearchPro' || input.api.version !== '2025-05-08' : input.api !== undefined)) throw failure('invalid_transport_request');
      payload = JSON.stringify(input.body);
      if (Buffer.byteLength(payload) > maxRequestBytes) throw failure('request_too_large');
      // toJSON/getters may change a validated object; guard the actual wire payload too.
      if (!validBody(name, JSON.parse(payload))) throw failure('invalid_transport_request');
      headers = { Host: new URL(ENDPOINTS[name]).hostname, 'Content-Type': CONTENT_TYPE, Authorization: auth };
      if (name === 'tencent') {
        const time = now();
        if (!Number.isSafeInteger(time) || time < 0) throw failure('invalid_transport_configuration');
        headers = signTencentRequest({ ...auth, timestamp: Math.floor(time / 1000), payload });
      }
    } catch (error) {
      const kind = ['invalid_transport_request', 'request_too_large', 'invalid_transport_configuration'].includes(error?.kind) ? error.kind : 'invalid_transport_request';
      throw failure(kind);
    }
    const { signal, maxResponseBytes } = input;
    if (signal.aborted) throw failure('aborted');
    headers['Accept-Encoding'] = 'identity';
    headers['Content-Length'] = Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
      let req;
      let res;
      let timer;
      let done = false;
      const finish = (kind, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (kind) { res?.destroy(); req?.destroy(); reject(failure(kind)); }
        else resolve(value);
      };
      const abort = () => finish('aborted');
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => finish('timeout'), timeoutMs);
      try {
        req = request(new URL(ENDPOINTS[name]), { method: 'POST', headers, agent: false, rejectUnauthorized: true, maxHeaderSize: 16384 }, incoming => {
          res = incoming;
          res.on('error', () => finish('transport_error'));
          if (done) { res.destroy(); return; }
          const status = res.statusCode;
          if (!Number.isInteger(status) || status < 100 || status > 599) return finish('invalid_response');
          if (status >= 300 && status < 400) return finish('redirect_blocked');
          // Errors are classified by the adapter using status only; never buffer their private bodies.
          if (status < 200 || status >= 300) {
            finish(null, { status, body: '' });
            res.destroy(); req.destroy();
            return;
          }
          const encoding = res.headers['content-encoding'];
          if (encoding !== undefined && encoding !== 'identity') return finish('unsupported_encoding');
          const length = res.headers['content-length'];
          if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length))) return finish('invalid_response');
          if (length !== undefined && Number(length) > maxResponseBytes) return finish('response_too_large');
          const chunks = [];
          let bytes = 0;
          res.on('data', chunk => {
            if (done) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > maxResponseBytes) return finish('response_too_large');
            chunks.push(buffer);
          });
          res.on('aborted', () => finish('transport_error'));
          res.on('end', () => {
            if (done) return;
            try {
              const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
              if (documentedMax) {
                const response = JSON.parse(body)?.Response;
                // API error envelopes have no result version; preserve adapter classification.
                if (response && Object.hasOwn(response, 'Error')) {
                  if (typeof response.Error?.Code !== 'string' || !response.Error.Code) return finish('invalid_response');
                  return finish(null, { status, body });
                }
                const tencentVersion = response?.Version;
                if (!['lite', 'standard', 'flagship'].includes(tencentVersion)) return finish('provider_version_mismatch');
                finish(null, { status, body, tencentVersion });
              } else finish(null, { status, body });
            } catch { finish('invalid_response'); }
          });
          res.on('close', () => { if (!done) finish('transport_error'); });
        });
        req.on('error', () => finish('transport_error'));
        if (done) { req.destroy(); return; }
        req.end(payload);
      } catch { finish('transport_error'); }
    });
  };
  Object.defineProperty(transport, 'estimatedCostCents', { value: cost, enumerable: true });
  return Object.freeze(transport);
}
