import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as z from 'zod/v4';
import { extractPageEvidence, prependPublishedEvidence } from './evidence-metadata.mjs';
import { searchSearxng } from './search.mjs';
import { enginePoolConfig, validateStrictPool } from './engine-health.mjs';
import { createArtifactStore } from './artifact-store.mjs';
import { createReadiness, DEFAULT_PROBE_TIMEOUT_MS } from './readiness.mjs';
import { isPublicAddress as classifyPublicAddress } from '../proxy/public-address.mjs';
import { isEvaluationReportFileName, normalizeReport, publicRunSummary, safeArtifactId } from './eval-core.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const cfg = Object.freeze({
  host: process.env.GATEWAY_HOST ?? 'yosef-server',
  bindHost: process.env.GATEWAY_BIND_HOST ?? process.env.GATEWAY_HOST ?? 'yosef-server',
  port: Number(process.env.GATEWAY_PORT ?? 8930),
  token: process.env.GATEWAY_TOKEN ?? '',
  allowAnonymous: process.env.GATEWAY_ALLOW_ANONYMOUS === '1',
  crawlUrl: process.env.CRAWL4AI_URL ?? 'http://127.0.0.1:11235',
  crawlToken: process.env.CRAWL4AI_TOKEN ?? '',
  searxUrl: process.env.SEARXNG_URL ?? 'http://yosef-server:8801',
  probeTimeoutMs: Number(process.env.GATEWAY_PROBE_TIMEOUT_MS ?? DEFAULT_PROBE_TIMEOUT_MS),
  playwrightUrl: process.env.PLAYWRIGHT_MCP_URL ?? 'http://localhost:8931/mcp',
  artifactDir: process.env.ARTIFACT_DIR ?? '/data/web-access-gateway/artifacts',
  browserOutputDir: process.env.PLAYWRIGHT_OUTPUT_DIR ?? '/data/web-access-gateway/data/playwright/output',
  artifactBase: process.env.ARTIFACT_BASE_URL ?? process.env.ARTIFACT_BASE ?? 'http://yosef-server:8930',
  reportDir: process.env.EVAL_REPORT_DIR ?? '/data/web-access-gateway/reports',
  egressProxy: process.env.EGRESS_PROXY ?? 'http://127.0.0.1:7895',
  tokenRateLimit: Number(process.env.GATEWAY_TOKEN_RATE_LIMIT ?? 120),
  tokenRateWindowMs: Number(process.env.GATEWAY_TOKEN_RATE_WINDOW_MS ?? 60000),
  hostConcurrency: Number(process.env.GATEWAY_HOST_CONCURRENCY ?? 4),
  crawlResponseMaxBytes: Number(process.env.CRAWL4AI_RESPONSE_MAX_BYTES ?? 80 * 1024 * 1024),
  artifactMaxBytes: Number(process.env.ARTIFACT_MAX_BYTES ?? 25 * 1024 * 1024),
  artifactQuotaBytes: Number(process.env.ARTIFACT_QUOTA_BYTES ?? 1024 * 1024 * 1024),
  dashboardDir: path.join(moduleDir, 'public'),
  allowedHosts: (process.env.GATEWAY_ALLOWED_HOSTS ?? 'yosef-server').split(',').map(v => v.trim()),
});

// Public, browser-consistent request identity for lightweight reads. Many public
// sites reject clients that do not look like a browser (401/403); these headers
// let an ordinary read look like a normal browsing session. This is deliberately
// a real browser user agent, never a claimed search-engine crawler or a cookie.
const READ_REQUEST_HEADERS = Object.freeze({
  'User-Agent': process.env.GATEWAY_READ_USER_AGENT ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': process.env.GATEWAY_READ_ACCEPT_LANGUAGE ?? 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
});
// Responses in these classes usually mean the origin mistook our client for a
// bot; the read path retries them through the renderer unless render is pinned.
const BOT_CHALLENGE_STATUSES = new Set([401, 403, 406, 429]);
const RESPONSE_BODY_LIMIT = 5 * 1024 * 1024;

if (!['0', '1'].includes(process.env.GATEWAY_ALLOW_ANONYMOUS ?? '0')) throw new Error('GATEWAY_ALLOW_ANONYMOUS must be unset, 0 or 1');
if (!cfg.allowAnonymous && cfg.token.length < 32) throw new Error('GATEWAY_TOKEN must be at least 32 characters');
if (!Number.isSafeInteger(cfg.crawlResponseMaxBytes) || cfg.crawlResponseMaxBytes <= 0) throw new Error('CRAWL4AI_RESPONSE_MAX_BYTES must be a positive safe integer');
if (!Number.isSafeInteger(cfg.artifactMaxBytes) || cfg.artifactMaxBytes <= 0) throw new Error('ARTIFACT_MAX_BYTES must be a positive safe integer');
if (!Number.isSafeInteger(cfg.probeTimeoutMs) || cfg.probeTimeoutMs <= 0) throw new Error('GATEWAY_PROBE_TIMEOUT_MS must be a positive safe integer');

const browserSessions = new Map();
const renderSlots = { active: 0, limit: 2 };
const browserSlots = { active: 0, limit: 2 };
const requestSlots = { active: 0, limit: Number(process.env.GATEWAY_REQUEST_CONCURRENCY ?? 16) };
const hostSlots = new Map();
const tokenRequests = new Map();
const artifactStore = createArtifactStore({ root: cfg.artifactDir,
  maxBytes: cfg.artifactMaxBytes, quotaBytes: cfg.artifactQuotaBytes });
const getReadiness = createReadiness({
  searxUrl: cfg.searxUrl, crawlUrl: cfg.crawlUrl, crawlToken: cfg.crawlToken, playwrightUrl: cfg.playwrightUrl,
  probeTimeoutMs: cfg.probeTimeoutMs,
  secrets: Object.entries(process.env).filter(([key]) => /token|secret|password|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key/i.test(key)).map(([, value]) => value),
  egressProbe: async signal => {
    const { url, records } = await resolvePublicUrl('https://example.com/');
    signal.throwIfAborted();
    const response = await requestOnce(url, records, signal);
    return { http_status: response.status };
  },
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tokenEqual = value => {
  const supplied = Buffer.from(value ?? '');
  const expected = Buffer.from(cfg.token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
};
function rejectError(message, kind, extra = {}) {
  const error = new Error(message);
  error.kind = kind;
  Object.assign(error, extra);
  return error;
}
// Stable blocked_reason categories shared by the lightweight origin read and the
// renderer's observed status so a fallback that is still blocked reports the same
// kind of reason as a direct failure.
function blockedReasonForStatus(status) {
  return status === 403 ? 'upstream_forbidden' : status === 429 ? 'upstream_rate_limited' : status >= 500 ? 'upstream_server_error' : 'upstream_http_error';
}
// A bot challenge the renderer (a real browser) could plausibly answer. Only the
// origin's own HTTP response qualifies: a status synthesized by the local egress
// proxy (`egress_proxy_status`) is this gateway's own rate limit, and re-fetching
// the same URL through the same saturated proxy would only amplify the overload
// (issue #51 D2 self-harm).
function isOriginBotChallenge(error) {
  return error?.kind === 'upstream_http_status' && BOT_CHALLENGE_STATUSES.has(error.httpStatus);
}
const requireToken = (req, res, next) => {
  const authorization = req.get('authorization');
  const anonymous = cfg.allowAnonymous && authorization === undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
  if (!anonymous && (!match || !tokenEqual(match[1]))) return res.status(401).json({ error: 'unauthorized' });
  const key = cfg.allowAnonymous ? req.socket.remoteAddress : crypto.createHash('sha256').update(match[1]).digest('hex').slice(0, 16);
  const now = Date.now();
  if (cfg.allowAnonymous) {
    // Unlike the single token bucket, inactive client addresses can accumulate.
    for (const [client, requests] of tokenRequests) {
      if (!requests.length || requests.at(-1) <= now - cfg.tokenRateWindowMs) tokenRequests.delete(client);
    }
  }
  const recent = (tokenRequests.get(key) ?? []).filter(value => value > now - cfg.tokenRateWindowMs);
  if (recent.length >= cfg.tokenRateLimit) {
    tokenRequests.set(key, recent);
    res.set('retry-after', String(Math.ceil(cfg.tokenRateWindowMs / 1000)));
    return res.status(429).json({ error: 'rate limit exceeded', blocked_reason: 'token_rate_limit' });
  }
  recent.push(now);
  tokenRequests.set(key, recent);
  next();
};

function isPublicIPv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = octets;
  return !(a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 ||
    a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 0 && c === 0 ||
    a === 192 && b === 0 && c === 2 || a === 192 && b === 88 && c === 99 || a === 192 && b === 168 ||
    a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0 && c === 113 ||
    a >= 224);
}
const isPublicAddress = address => classifyPublicAddress(address, isPublicIPv4);
async function resolvePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw rejectError('invalid URL', 'invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw rejectError('only public HTTP/HTTPS URLs are allowed', 'ssrf_blocked', { blockedReason: 'unsupported_url' });
  if (url.port && !['80', '443'].includes(url.port)) throw rejectError('only ports 80 and 443 are allowed', 'ssrf_blocked', { blockedReason: 'unsupported_port' });
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(hostname);
  let records;
  try { records = family ? [{ address: hostname, family }] : await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch (error) { throw rejectError(`hostname could not be resolved: ${error.message}`, 'dns_error', { cause: error }); }
  if (!records.length || records.some(record => !isPublicAddress(record.address))) throw rejectError('non-public targets are blocked', 'ssrf_blocked', { blockedReason: 'non_public_address', host: url.hostname });
  return { url, records };
}
const proxyUrl = new URL(cfg.egressProxy);
if (proxyUrl.protocol !== 'http:' || proxyUrl.username || proxyUrl.password) {
  throw new Error('EGRESS_PROXY must be an unauthenticated HTTP CONNECT proxy; other transports cannot enforce address pinning');
}
// Decode Content-Encoding for the raw http.request path (Node's fetch already
// decodes, but the pinned CONNECT transport does not). The output is bounded so
// a small compressed payload cannot expand past the read budget.
function decodeContentEncoding(buffer, encoding) {
  if (!encoding) return buffer;
  const codings = encoding.split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  let output = buffer;
  for (const coding of codings.reverse()) {
    if (coding === 'identity') continue;
    try {
      if (coding === 'gzip' || coding === 'x-gzip') output = zlib.gunzipSync(output, { maxOutputLength: RESPONSE_BODY_LIMIT });
      else if (coding === 'br') output = zlib.brotliDecompressSync(output, { maxOutputLength: RESPONSE_BODY_LIMIT });
      else if (coding === 'deflate') {
        try { output = zlib.inflateSync(output, { maxOutputLength: RESPONSE_BODY_LIMIT }); }
        catch { output = zlib.inflateRawSync(output, { maxOutputLength: RESPONSE_BODY_LIMIT }); }
      } else throw rejectError(`unsupported content-encoding: ${coding}`, 'upstream_encoding');
    } catch (error) {
      if (error?.kind) throw error;
      if (error?.code === 'ERR_BUFFER_TOO_LARGE') throw rejectError('decompressed response exceeds 5 MiB', 'response_too_large');
      throw rejectError(`could not decode ${coding} response: ${error.message}`, 'upstream_decode_error');
    }
  }
  return output;
}
function requestOnce(url, records, signal) {
  const timeoutMs = 30000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let downstreamRequest;
    let tunnelSocket;
    let connect;
    let nextAddress = 0;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      // CONNECT hands ownership of its socket to the downstream request. Closing
      // only the CONNECT request leaves an active origin running past deadline.
      downstreamRequest?.destroy();
      tunnelSocket?.destroy();
      connect?.destroy();
      error ? reject(error) : resolve(value);
    };
    const deadline = setTimeout(() => complete(rejectError('egress request timed out', 'egress_timeout')), timeoutMs);
    const onAbort = () => complete(signal.reason ?? rejectError('dependency probe timed out', 'dependency_timeout'));
    const complete = (error, value) => { clearTimeout(deadline); signal?.removeEventListener('abort', onAbort); finish(error, value); };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    const attempt = () => {
      if (settled) return;
      const address = records[nextAddress++].address;
      const authority = `${net.isIP(address) === 6 ? `[${address}]` : address}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`;
      const connection = connect = http.request({ host: proxyUrl.hostname, port: proxyUrl.port || 80, method: 'CONNECT', path: authority, timeout: timeoutMs });
      let handedOff = false;
      let failed = false;
      const retry = error => {
        if (settled || failed) return;
        failed = true;
        connection.destroy();
        // Do not replay a downstream GET or retry TLS/policy failures. All
        // pre-tunnel retries share the deadline and this checked DNS answer set.
        if (!handedOff && nextAddress < records.length) attempt(); else complete(error);
      };
      connection.once('error', error => retry(rejectError(error.message, 'egress_connect', { cause: error })));
      connection.once('timeout', () => {
        if (!failed) complete(rejectError('egress proxy connection timed out', 'egress_timeout'));
      });
      connection.once('connect', (response, socket, head) => {
        if (settled || failed || signal?.aborted) { socket.destroy(); return; }
        connection.setTimeout(0);
        if (response.statusCode < 200 || response.statusCode >= 300) {
          socket.destroy();
          const error = rejectError(`egress proxy returned ${response.statusCode}`, 'egress_proxy_status', {
            httpStatus: response.statusCode,
            retryAfter: response.headers['retry-after'] ?? null,
            blockedReason: response.statusCode === 403 ? 'egress_proxy_blocked' : response.statusCode === 429 ? 'egress_proxy_rate_limited' : null,
          });
          return response.statusCode >= 500 ? retry(error) : complete(error);
        }
        handedOff = true;
        tunnelSocket = socket;
        if (head.length) socket.unshift(head);
        const transport = url.protocol === 'https:' ? https : http;
        const sendRequest = requestSocket => {
          // agent:false creates a fresh Agent that ignores the per-request
          // createConnection option, opening a connection outside the tunnel.
          const agent = new transport.Agent({ keepAlive: false });
          agent.createConnection = () => requestSocket;
          const request = downstreamRequest = transport.request({
            protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port || undefined, path: `${url.pathname}${url.search}`,
            method: 'GET', agent,
            headers: { 'Host': url.host, ...READ_REQUEST_HEADERS, 'Connection': 'close' },
            timeout: timeoutMs,
          }, page => {
            const parts = [];
            let total = 0;
            page.on('data', chunk => {
              total += chunk.length;
              if (total <= 5 * 1024 * 1024) parts.push(chunk);
              else {
                const error = rejectError('response exceeds 5 MiB', 'response_too_large');
                complete(error);
                request.destroy();
              }
            });
            page.once('error', error => complete(rejectError(error.message, 'upstream_network', { cause: error })));
            page.on('end', () => {
              let body;
              try { body = decodeContentEncoding(Buffer.concat(parts), page.headers['content-encoding']); }
              catch (error) { complete(error); request.destroy(); return; }
              const result = { status: page.statusCode ?? 0, headers: page.headers, body };
              if (result.status < 200 || result.status >= 400) {
                const error = rejectError(`upstream returned HTTP ${result.status}`, 'upstream_http_status', {
                  httpStatus: result.status,
                  retryAfter: result.headers['retry-after'] ?? null,
                  contentType: result.headers['content-type'] ?? null,
                  bytes: result.body.length,
                  contentHash: crypto.createHash('sha256').update(result.body).digest('hex'),
                  blockedReason: blockedReasonForStatus(result.status),
                });
                complete(error);
                request.destroy();
                return;
              }
              complete(null, result);
              request.destroy();
            });
          });
          request.once('timeout', () => complete(rejectError('upstream request timed out', 'upstream_timeout')));
          request.once('error', error => complete(rejectError(error.message, 'upstream_network', { cause: error })));
          request.end();
        };
        if (url.protocol === 'https:') {
          const hostname = url.hostname.replace(/^\[|\]$/g, '');
          // The tunnel's numeric destination is not the website's TLS identity.
          // IP URLs use IP SAN verification, without sending an invalid IP SNI.
          const secure = tunnelSocket = tls.connect({ socket, host: hostname, servername: net.isIP(hostname) ? undefined : hostname, rejectUnauthorized: true,
            // Node 22's IDNA-based checkServerIdentity can treat IPv6 as a DNS
            // name. X509.checkIP verifies the IP SAN without that conversion.
            checkServerIdentity: net.isIP(hostname) === 6 ? (_name, cert) => {
              if (!new crypto.X509Certificate(cert.raw).checkIP(hostname)) return Object.assign(new Error(`certificate does not match IP ${hostname}`), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
            } : tls.checkServerIdentity,
          });
          secure.once('secureConnect', () => sendRequest(secure));
          secure.once('error', error => complete(rejectError(error.message, 'tls_error', { cause: error })));
        } else {
          sendRequest(socket);
        }
      });
      connection.end();
    };
    attempt();
  });
}
async function withHostSlot(host, job) {
  const state = hostSlots.get(host) ?? { active: 0 };
  if (state.active >= cfg.hostConcurrency) throw rejectError(`host concurrency limit reached for ${host}`, 'host_concurrency_limit', { host });
  state.active++;
  hostSlots.set(host, state);
  try { return await job(); } finally { state.active--; if (!state.active) hostSlots.delete(host); }
}
async function fetchPublic(raw) {
  let current = raw;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const { url, records } = await resolvePublicUrl(current);
    let response;
    try {
      response = await withHostSlot(url.hostname.toLowerCase(), () => requestOnce(url, records));
    } catch (error) {
      // Keep the already checked URL that produced the failure so the read path
      // can hand a validated target to the renderer when it falls back.
      if (error && typeof error === 'object' && !error.finalUrl) error.finalUrl = url.href;
      throw error;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location) throw rejectError(`upstream returned redirect ${response.status} without a location`, 'redirect_without_location', { httpStatus: response.status });
      current = new URL(response.headers.location, url).href;
      continue;
    }
    return { ...response, finalUrl: url.href, contentType: response.headers['content-type'] ?? '', bytes: response.body.length, contentHash: crypto.createHash('sha256').update(response.body).digest('hex') };
  }
  throw rejectError('too many redirects', 'redirect_limit');
}
function trimText(text, maximum = 40000) { return text.length > maximum ? `${text.slice(0, maximum)}\n\n[truncated]` : text; }
function textResult(value) {
  return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}
function errorResult(traceId, error) {
  const payload = {
    trace_id: traceId,
    error: { kind: error.kind ?? 'request', message: String(error.message ?? error).slice(0, 500) },
    ...(error.httpStatus ? { http_status: error.httpStatus } : {}),
    ...(error.contentType ? { content_type: error.contentType } : {}),
    ...(error.bytes != null ? { bytes: error.bytes } : {}),
    ...(error.contentHash ? { content_hash: error.contentHash } : {}),
    ...(error.blockedReason ? { blocked_reason: error.blockedReason } : {}),
    ...(error.host ? { target_host: error.host } : {}),
    ...(error.retryAfter ? { retry_after: error.retryAfter } : {}),
    ...(error.renderer ? { renderer: error.renderer } : {}),
    ...(error.renderFallback ? { render_fallback: error.renderFallback } : {}),
  };
  return { isError: true, structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}
function audit(tool, traceId, started, outcome, details = {}) {
  console.log(JSON.stringify({ trace_id: traceId, tool, duration_ms: Date.now() - started, outcome, ...details }));
}
async function executeTool(tool, traceId, operation, defaultHost = null) {
  const started = Date.now();
  try {
    const result = await withSlot(requestSlots, operation);
    const value = result.structuredContent ?? {};
    audit(tool, traceId, started, 'ok', {
      target_host: value.source?.host ?? value.target_host ?? (value.url ? new URL(value.url).hostname : null) ?? defaultHost,
      http_status: value.http_status ?? null,
      stages_ms: value.telemetry?.stages_ms ?? {},
    });
    return result;
  } catch (error) {
    audit(tool, traceId, started, 'error', { target_host: error.host ?? defaultHost, http_status: error.httpStatus ?? null, error_kind: error.kind ?? 'request', blocked_reason: error.blockedReason ?? null });
    return errorResult(traceId, error);
  }
}
function detectCharset(htmlBuffer, contentType = '') {
  const header = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  if (header) return header.toLowerCase();
  if (htmlBuffer[0] === 0xef && htmlBuffer[1] === 0xbb && htmlBuffer[2] === 0xbf) return 'utf-8';
  const prefix = htmlBuffer.subarray(0, Math.min(htmlBuffer.length, 16384)).toString('latin1');
  return /<meta[^>]+charset\s*=\s*["']?\s*([^\s"'>/]+)/i.exec(prefix)?.[1]?.toLowerCase()
    ?? /<meta[^>]+content\s*=\s*["'][^"']*charset\s*=\s*([^\s"';]+)/i.exec(prefix)?.[1]?.toLowerCase()
    ?? 'utf-8';
}
function decodePageBody(body, contentType) {
  const declared = detectCharset(body, contentType);
  const candidates = [declared, 'utf-8', 'gb18030'].filter((value, index, values) => value && values.indexOf(value) === index);
  for (const charset of candidates) {
    try {
      const decoded = new TextDecoder(charset, { fatal: false }).decode(body);
      const replacementCount = (decoded.match(/�/g) ?? []).length;
      if (charset !== 'utf-8' || replacementCount < Math.max(2, decoded.length / 1000)) return { text: decoded.replace(/^\uFEFF/, ''), charset };
    } catch { /* Try the next compatible decoder. */ }
  }
  return { text: new TextDecoder('utf-8').decode(body).replace(/^\uFEFF/, ''), charset: 'utf-8' };
}
function lightExtract(html, finalUrl) {
  const dom = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;
  for (const node of document.querySelectorAll('script,style,noscript,svg,nav,footer,aside,iframe')) node.remove();
  const main = document.querySelector('article, main, [role="main"]') ?? document.body;
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(main?.innerHTML ?? '');
  return { title: document.title?.trim() ?? '', markdown: markdown.replace(/\n{3,}/g, '\n\n').trim() };
}
function fetchedMetadata(fetched) {
  return {
    http_status: fetched.status,
    content_type: fetched.contentType || null,
    bytes: fetched.bytes,
    content_hash: fetched.contentHash,
    blocked_reason: null,
  };
}
// Metadata for a read whose only successful response came from the renderer
// (the lightweight origin read never returned usable content). Never invent an
// upstream figure: report the renderer's observed status and the Markdown it gave.
function renderedMetadata(rendered) {
  const status = Number.isInteger(rendered?.result?.status_code) ? rendered.result.status_code : null;
  const markdown = rendered?.markdown ?? '';
  return {
    // A renderer that reports no integer `status_code` has no upstream HTTP
    // figure to report. Omit the key instead of emitting `null`: the output
    // schema declares `http_status: z.number().optional()`, and a null value
    // fails output validation, turning the whole read into an MCP -32602
    // protocol error that hides `blocked_reason` / `render_fallback` from the
    // caller (issue #51 D1). `errorResult()` omits the key the same way.
    ...(status == null ? {} : { http_status: status }),
    content_type: 'text/markdown',
    bytes: Buffer.byteLength(markdown, 'utf8'),
    content_hash: crypto.createHash('sha256').update(markdown, 'utf8').digest('hex'),
    blocked_reason: null,
  };
}
// Publisher evidence for a renderer-only read. Prefer the renderer's own HTML so
// canonical/published metadata is preserved; otherwise emit the contract's
// required fields with explicit nulls rather than dropping them.
function evidenceFromRendered(rendered, finalUrl) {
  const html = rendered?.result?.html;
  if (typeof html === 'string' && html) return extractPageEvidence(html, finalUrl, {});
  const retrievedAt = new Date().toISOString();
  return {
    published_at: null,
    published_on: null,
    precision: null,
    modified_at: null,
    retrieved_at: retrievedAt,
    source: { url: finalUrl, host: new URL(finalUrl).hostname.toLowerCase(), site_name: null, author: null },
    temporal_evidence: [{ kind: 'retrieved_at', value: retrievedAt, source: 'gateway.clock' }],
  };
}
async function withSlot(pool, job) {
  const started = Date.now();
  while (pool.active >= pool.limit) { if (Date.now() - started > 30000) throw rejectError('service is busy; retry shortly', 'capacity_exhausted'); await sleep(100); }
  pool.active++;
  try { return await job(); } finally { pool.active--; }
}
async function readCrawlResponse(response, controller) {
  const reader = response.body?.getReader();
  if (!reader) throw rejectError('Crawl4AI returned an empty response', 'render_invalid_response');
  const parts = [];
  let total = 0;
  try {
    // Content-Length is not authoritative (and may describe compressed bytes).
    // Count the entire JSON byte stream before allocating a string or parsing.
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cfg.crawlResponseMaxBytes) {
        const error = rejectError(`Crawl4AI response exceeds ${cfg.crawlResponseMaxBytes} bytes`, 'response_too_large');
        controller.abort(error);
        await reader.cancel(error).catch(() => {});
        throw error;
      }
      parts.push(value);
    }
    return Buffer.concat(parts, total);
  } finally {
    reader.releaseLock();
  }
}
async function callCrawl4ai(url, output) {
  return withSlot(renderSlots, async () => {
    const controller = new AbortController();
    const response = await fetch(`${cfg.crawlUrl}/crawl`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.crawlToken}` },
      body: JSON.stringify({ urls: [url], browser_config: { type: 'BrowserConfig', params: { headless: true } }, crawler_config: { type: 'CrawlerRunConfig', params: { cache_mode: 'bypass', screenshot: output === 'screenshot', pdf: output === 'pdf' } } }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(90000)]),
    });
    const body = await readCrawlResponse(response, controller);
    if (!response.ok) throw rejectError(`Crawl4AI returned ${response.status}: ${body.subarray(0, 500).toString('utf8')}`, 'render_backend_status', { httpStatus: response.status });
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
    catch { throw rejectError('Crawl4AI returned invalid JSON', 'render_invalid_response'); }
    if (!payload || typeof payload !== 'object' || ('results' in payload && !Array.isArray(payload.results))) throw rejectError('Crawl4AI returned an invalid result envelope', 'render_invalid_response');
    const result = 'results' in payload ? payload.results[0] : Array.isArray(payload) ? payload[0] : payload;
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw rejectError('Crawl4AI returned an invalid result', 'render_invalid_response');
    const text = result.markdown?.raw_markdown ?? result.markdown ?? result.fit_markdown ?? '';
    if (typeof text !== 'string') throw rejectError('Crawl4AI returned invalid Markdown', 'render_invalid_response');
    if (Buffer.byteLength(text, 'utf8') > 5 * 1024 * 1024) throw rejectError('Crawl4AI Markdown exceeds 5 MiB', 'markdown_too_large');
    // Validate both fields, including an unrequested artifact, before any
    // decode or publication. Only the requested artifact is later decoded.
    validateArtifactEncoding(result.screenshot);
    validateArtifactEncoding(result.pdf);
    return { result, markdown: text };
  });
}
function validateArtifactEncoding(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw rejectError('artifact must be base64 text', 'artifact_invalid');
  const maximumEncoded = 4 * Math.ceil(cfg.artifactMaxBytes / 3);
  // Bound the original field before stripping a bounded data-URL header.
  if (value.length > maximumEncoded + 256) throw rejectError(`encoded artifact exceeds ${maximumEncoded} characters`, 'artifact_too_large');
  let encoded = value;
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    if (comma < 0 || comma > 255 || !/^data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,$/i.test(value.slice(0, comma + 1))) throw rejectError('invalid artifact data URL', 'artifact_invalid');
    encoded = value.slice(comma + 1);
  }
  if (encoded.length > maximumEncoded) throw rejectError(`encoded artifact exceeds ${maximumEncoded} characters`, 'artifact_too_large');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const decodedBytes = Math.floor(encoded.length * 3 / 4) - padding;
  if (decodedBytes > cfg.artifactMaxBytes) throw rejectError(`artifact exceeds ${cfg.artifactMaxBytes} bytes`, 'artifact_too_large');
  if (!encoded || encoded.length % 4 === 1 || (padding && encoded.length % 4 !== 0) || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw rejectError('invalid artifact base64', 'artifact_invalid');
  // Node's decoder accepts noncanonical padding bits and discards invalid
  // characters. Validate instead of letting that permissiveness hide damage.
  const remainder = (encoded.length - padding) % 4;
  const tail = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.indexOf(encoded[encoded.length - padding - 1]);
  if ((remainder === 2 && (tail & 15) !== 0) || (remainder === 3 && (tail & 3) !== 0)) throw rejectError('invalid artifact base64 padding bits', 'artifact_invalid');
  return encoded;
}
async function publishArtifact(content, extension) {
  const artifact = await artifactStore.save(content, extension);
  return { ...artifact, url: `${cfg.artifactBase}/artifacts/${encodeURIComponent(artifact.id)}` };
}
async function saveArtifact(value, extension) {
  const encoded = validateArtifactEncoding(value);
  if (encoded == null) return null;
  return publishArtifact(Buffer.from(encoded, 'base64'), extension);
}
async function browserScreenshot(session) {
  // The SDK always writes screenshots to disk. Its eviction is neither atomic
  // nor shared with crawler artifacts, so it must never write in retained storage.
  const overlaps = (left, right) => left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
  const configured = path.resolve(cfg.browserOutputDir);
  const retained = path.resolve(cfg.artifactDir);
  if (overlaps(configured, retained)) throw rejectError('browser staging must be outside retained artifacts', 'artifact_invalid');
  await fs.mkdir(configured, { recursive: true, mode: 0o700 });
  const stagingRoot = await fs.realpath(configured);
  const artifactRoot = await fs.realpath(retained).catch(error => { if (error.code === 'ENOENT') return retained; throw error; });
  if (overlaps(stagingRoot, artifactRoot)) throw rejectError('browser staging must be outside retained artifacts', 'artifact_invalid');
  const staging = await fs.mkdtemp(path.join(stagingRoot, 'gateway-screenshot-'));
  const filename = path.join(staging, 'screenshot.png');
  try {
    // An explicit filename suppresses the SDK inline image. Read the original
    // staged bytes rather than relying on a potentially resized image response.
    const output = await playwrightCall(session, 'browser_take_screenshot', { fullPage: true, filename });
    if (output.isError) throw rejectError('browser screenshot failed', 'artifact_missing');
    await browserLocation(session);
    const handle = await fs.open(filename, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let content;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw rejectError('invalid staged browser artifact', 'artifact_invalid');
      if (info.size > cfg.artifactMaxBytes) throw rejectError('artifact exceeds decoded size limit', 'artifact_too_large');
      content = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < content.length) {
        const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
        if (!bytesRead) throw rejectError('incomplete staged browser artifact', 'artifact_invalid');
        offset += bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead) throw rejectError('staged browser artifact changed', 'artifact_invalid');
    } finally { await handle.close(); }
    const artifact = await publishArtifact(content, 'png');
    return { content: [{ type: 'text', text: 'Screenshot captured' }], artifact };
  } catch (error) {
    // Stop the SDK before removing our owned staging directory on failure.
    await session.client.close().catch(() => {});
    throw error;
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}
async function createBrowserSession() {
  const transport = new StreamableHTTPClientTransport(new URL(cfg.playwrightUrl));
  const client = new Client({ name: 'web-access-gateway', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, created: Date.now(), expires: Date.now() + 15 * 60 * 1000, snapshot: '', url: null };
}
async function playwrightCall(session, name, args) {
  return session.client.callTool({ name, arguments: args });
}
async function browserLocation(session) {
  const result = await playwrightCall(session, 'browser_evaluate', { function: '() => window.location.href' });
  const raw = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('').trim();
  const candidates = [];
  const collect = value => {
    if (typeof value === 'string') candidates.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(raw);
  try { collect(JSON.parse(raw)); } catch { /* Playwright may return plain text rather than JSON. */ }
  for (const candidate of candidates) {
    const match = /https?:\/\/[^\s"'<>`]+/i.exec(candidate);
    if (!match) continue;
    const value = match[0].replace(/[),.;]+$/, '');
    await resolvePublicUrl(value).catch(() => { throw rejectError('browser navigated to a blocked target', 'ssrf_blocked', { blockedReason: 'browser_private_target', host: new URL(value).hostname }); });
    session.url = value;
    return value;
  }
  if (session.url) return session.url;
  throw rejectError('browser location is unavailable', 'browser_location_unavailable');
}
function browserEvidence(session, retrievedAt = new Date().toISOString()) {
  if (!session.url) return {};
  const source = { url: session.url, host: new URL(session.url).hostname.toLowerCase() };
  return { url: session.url, retrieved_at: retrievedAt, source, temporal_evidence: [{ kind: 'retrieved_at', value: retrievedAt, source: 'gateway.clock' }] };
}
async function browserAction(session, action) {
  const type = action.type;
  if (type === 'navigate') {
    const fetched = await fetchPublic(action.url);
    const output = await playwrightCall(session, 'browser_navigate', { url: fetched.finalUrl });
    session.url = fetched.finalUrl;
    await browserLocation(session);
    return output;
  }
  if (type === 'click') {
    if (!action.ref) throw rejectError('click requires a snapshot link reference', 'browser_target_unverified', { blockedReason: 'missing_link_reference' });
    const text = session.snapshot;
    const escaped = action.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = text.split('\n').find(value => new RegExp(`\\[ref=${escaped}\\]`).test(value));
    if (!line || !/\blink\b/i.test(line)) throw new Error('click is limited to a link in the latest accessibility snapshot');
    const label = /\blink\s+"([^"]+)"/i.exec(line)?.[1];
    if (!label) throw rejectError('click target has no verifiable link label', 'browser_target_unverified', { blockedReason: 'missing_link_label' });
    const linkProbe = await playwrightCall(session, 'browser_evaluate', { function: `() => [...document.querySelectorAll('a[href]')].filter(node => (node.innerText || node.textContent || '').trim() === ${JSON.stringify(label)}).map(node => node.href)` });
    const rawTargets = (linkProbe.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('').trim();
    let targets;
    try {
      const start = rawTargets.indexOf('[');
      const end = rawTargets.lastIndexOf(']');
      targets = JSON.parse(start >= 0 && end > start ? rawTargets.slice(start, end + 1) : rawTargets);
    } catch {
      targets = [...rawTargets.matchAll(/https?:\/\/[^\s"'<>`\],]+/gi)].map(match => match[0]);
    }
    if (!targets?.length) {
      throw rejectError('click target could not be resolved before navigation', 'browser_target_unverified', { blockedReason: 'link_target_unresolved' });
    }
    if (!Array.isArray(targets) || targets.length !== 1) throw rejectError('click target is ambiguous or unavailable', 'browser_target_unverified', { blockedReason: 'link_target_ambiguous' });
    const target = await resolvePublicUrl(targets[0]);
    if (action.url && new URL(action.url).href !== target.url.href) throw rejectError('declared click target does not match page link', 'browser_target_mismatch', { blockedReason: 'browser_target_mismatch', host: target.url.hostname });
    const output = await playwrightCall(session, 'browser_click', { ref: action.ref, element: action.element ?? 'link' });
    await browserLocation(session);
    if (action.url && session.url !== action.url) throw rejectError('clicked link did not match the declared target', 'browser_target_mismatch', { blockedReason: 'browser_target_mismatch', host: new URL(session.url).hostname });
    return output;
  }
  if (type === 'wait') {
    const seconds = (action.ms ?? 1000) / 1000;
    // Playwright MCP 0.0.79 expects seconds but rejects zero via a truthiness guard.
    const output = seconds === 0
      ? { content: [{ type: 'text', text: 'Waited for 0 seconds' }] }
      : await playwrightCall(session, 'browser_wait_for', { time: seconds });
    await browserLocation(session);
    return output;
  }
  if (type === 'scroll') { const output = await playwrightCall(session, 'browser_evaluate', { function: `() => window.scrollBy(0, ${Math.max(-3000, Math.min(3000, Number(action.pixels ?? 600)))})` }); await browserLocation(session); return output; }
  if (type === 'snapshot') { const output = await playwrightCall(session, 'browser_snapshot', {}); await browserLocation(session); return output; }
  if (type === 'screenshot') return browserScreenshot(session);
  throw new Error(`unsupported browser action: ${type}`);
}
const temporalEvidenceSchema = z.object({ kind: z.string(), value: z.string().nullable().optional(), on: z.string().nullable().optional(), precision: z.string().nullable().optional(), source: z.string() });
const sourceSchema = z.object({ url: z.string(), host: z.string(), canonical_url: z.string().nullable().optional(), site_name: z.string().nullable().optional(), author: z.string().nullable().optional(), search_engine: z.string().nullable().optional() });
const telemetrySchema = z.object({ first_valid_result_ms: z.number().optional(), stages_ms: z.record(z.string(), z.number()).optional() }).passthrough();
const searchOutputSchema = z.object({ trace_id: z.string(), query: z.string(), number_of_results: z.number(), results: z.array(z.object({ title: z.string().nullable().optional(), url: z.string(), content: z.string(), engine: z.string().nullable().optional(), category: z.string().nullable().optional(), published_at: z.string().nullable().optional(), published_on: z.string().nullable().optional(), precision: z.string().nullable().optional(), retrieved_at: z.string(), time_range_status: z.string().optional(), source: sourceSchema, temporal_evidence: z.array(temporalEvidenceSchema) })), time_range: z.string().nullable().optional(), time_range_applied: z.boolean().optional(), time_range_enforced: z.boolean().optional(), time_range_note: z.string().nullable().optional(), time_window_strict: z.boolean().optional(), filtered_out: z.number().optional(), filtered_reasons: z.record(z.string(), z.number()).optional(), unresponsive_engines: z.unknown().optional(), engine_pool: z.object({ layer: z.string(), engines: z.array(z.string()), source: z.string() }).passthrough().optional(), failure_classes: z.record(z.string(), z.number()).optional(), cooldown_engines: z.array(z.object({ engine: z.string(), reason: z.string(), failure_class: z.string(), until_ms: z.number() }).passthrough()).optional(), news_mode: z.boolean().optional(), news_ranking: z.object({ applied: z.boolean(), total: z.number(), moved: z.number(), demoted: z.number(), promoted: z.number(), reasons: z.record(z.string(), z.number()) }).passthrough().optional(), dedup: z.object({ raw_results: z.number(), unique_urls: z.number(), merged: z.number(), multi_source: z.number(), sources: z.array(z.object({ url: z.string(), engines: z.array(z.string()) })) }).passthrough().optional(), telemetry: telemetrySchema }).passthrough();
const readOutputSchema = z.object({ trace_id: z.string(), url: z.string().optional(), renderer: z.string().optional(), title: z.string().optional(), markdown: z.string().optional(), http_status: z.number().optional(), content_type: z.string().nullable().optional(), bytes: z.number().optional(), content_hash: z.string().optional(), charset: z.string().optional(), published_at: z.string().nullable().optional(), published_on: z.string().nullable().optional(), precision: z.string().nullable().optional(), retrieved_at: z.string().optional(), source: sourceSchema.optional(), temporal_evidence: z.array(temporalEvidenceSchema).optional(), artifact: z.record(z.string(), z.unknown()).optional(), expires_after_days: z.number().optional(), blocked_reason: z.string().nullable().optional(), telemetry: telemetrySchema.optional() }).passthrough();
const browserOutputSchema = z.object({ trace_id: z.string(), session_id: z.string().optional(), expires_in_seconds: z.number().optional(), url: z.string().optional(), retrieved_at: z.string().optional(), source: sourceSchema.optional(), temporal_evidence: z.array(temporalEvidenceSchema).optional(), outputs: z.array(z.record(z.string(), z.unknown())).optional(), closed: z.boolean().optional(), telemetry: telemetrySchema }).passthrough();
function getServer() {
  const server = new McpServer({ name: 'web-access-gateway', version: '1.0.0' });
  server.registerTool('web_search', { description: 'Search public web pages through the local SearXNG instance.', inputSchema: { query: z.string().min(1).max(500), categories: z.string().optional(), engines: z.string().optional(), language: z.string().optional(), time_range: z.enum(['day', 'month', 'year']).optional(), time_window_strict: z.boolean().optional(), news_mode: z.boolean().optional(), page: z.number().int().min(1).max(10).optional() }, outputSchema: searchOutputSchema }, async input => {
    const trace_id = crypto.randomUUID(); const started = Date.now();
    return executeTool('web_search', trace_id, async () => {
      // Opt-in news mode (SPEC #72): an explicit `news_mode` flag wins; otherwise the search module
      // auto-opts-in when `categories` contains `news`. Only the named control is forwarded (never
      // the raw input), so no extra caller field reaches the SearXNG query string.
      const search = await searchSearxng({ baseUrl: cfg.searxUrl, input, signal: AbortSignal.timeout(30000), timeWindowStrict: input.time_window_strict, newsMode: input.news_mode });
      const duration_ms = Date.now() - started;
      // Search-module diagnostics that callers rely on for temporal honesty and news mode; forwarded
      // only when the module actually produced them so compatibility responses keep their previous
      // shape (a normal search never grows a `news_mode`/`news_ranking`/`dedup` key).
      const diagnostics = {};
      for (const key of ['time_range', 'time_range_applied', 'time_range_enforced', 'time_range_note', 'time_window_strict', 'filtered_out', 'filtered_reasons', 'engine_pool', 'failure_classes', 'cooldown_engines', 'news_mode', 'news_ranking', 'dedup']) {
        if (Object.prototype.hasOwnProperty.call(search, key)) diagnostics[key] = search[key];
      }
      return textResult({
        trace_id,
        telemetry: { first_valid_result_ms: duration_ms, stages_ms: search.stages_ms },
        query: input.query,
        number_of_results: search.number_of_results,
        results: search.results,
        ...diagnostics,
        ...(Object.prototype.hasOwnProperty.call(search, 'unresponsive_engines')
          ? { unresponsive_engines: search.unresponsive_engines }
          : {}),
      });
    }, new URL(cfg.searxUrl).hostname);
  });
  server.registerTool('web_read', { description: 'Read a public URL as clean Markdown. Uses lightweight extraction first and Crawl4AI rendering when needed.', inputSchema: { url: z.string().url(), render: z.enum(['auto', 'never', 'always']).default('auto'), output: z.enum(['markdown', 'screenshot', 'pdf']).default('markdown') }, outputSchema: readOutputSchema }, async input => {
    const trace_id = crypto.randomUUID(); const started = Date.now(); const stages_ms = {};
    return executeTool('web_read', trace_id, async () => {
      let fetched;
      let light;
      let renderFallback = null;
      if (input.render !== 'always') {
        const fetchStarted = Date.now();
        try {
          fetched = await fetchPublic(input.url);
        } catch (error) {
          // A public page that answers our lightweight client with a bot-challenge
          // status (401/406), a block (403) or throttling (429) is retried through
          // the renderer, which presents a real browser. An explicit
          // `render: never` stays authoritative and never falls back, and a status
          // the local egress proxy synthesized is never treated as an origin
          // challenge (see isOriginBotChallenge).
          if (input.render === 'auto' && isOriginBotChallenge(error)) {
            renderFallback = {
              occurred: true, from: 'lightweight', to: 'crawl4ai',
              reason: error.blockedReason ?? 'upstream_http_status',
              http_status: error.httpStatus,
              url: error.finalUrl ?? input.url,
            };
          } else throw error;
        }
        stages_ms.fetch_ms = Date.now() - fetchStarted;
        if (fetched) {
          const type = fetched.contentType;
          const decoded = decodePageBody(fetched.body, type);
          if (!type.toLowerCase().includes('html') && input.output === 'markdown') throw rejectError(`unsupported content type: ${type}`, 'unsupported_content_type', { httpStatus: fetched.status });
          const extractStarted = Date.now();
          light = lightExtract(decoded.text, fetched.finalUrl);
          stages_ms.extract_ms = Date.now() - extractStarted;
          if (input.render === 'never' || (light.markdown.length >= 700 && input.output === 'markdown')) {
            const evidence = extractPageEvidence(decoded.text, fetched.finalUrl, fetched.headers);
            return textResult({ trace_id, telemetry: { first_valid_result_ms: Date.now() - started, stages_ms }, url: fetched.finalUrl, renderer: 'lightweight', title: light.title, markdown: trimText(prependPublishedEvidence(light.markdown, evidence)), ...fetchedMetadata(fetched), charset: decoded.charset, ...evidence });
          }
        }
      }
      let renderUrl = fetched?.finalUrl ?? renderFallback?.url;
      if (!renderUrl) { const fetchStarted = Date.now(); fetched = await fetchPublic(input.url); stages_ms.fetch_ms = Date.now() - fetchStarted; renderUrl = fetched.finalUrl; }
      // Falling back to the renderer never bypasses address policy: the validated
      // target is re-checked against SSRF rules before the renderer fetches it.
      if (!fetched) renderUrl = (await resolvePublicUrl(renderUrl)).url.href;
      const renderStarted = Date.now();
      let rendered;
      try {
        rendered = await callCrawl4ai(renderUrl, input.output);
      } catch (error) {
        if (renderFallback) {
          error.renderer = 'crawl4ai';
          error.renderFallback = renderFallback;
          if (!error.blockedReason) error.blockedReason = 'render_fallback_failed';
          if (error.httpStatus == null) error.httpStatus = renderFallback.http_status;
        }
        throw error;
      }
      stages_ms.render_ms = Date.now() - renderStarted;
      let charset = 'utf-8';
      let evidence;
      let metadata;
      if (fetched) {
        const decoded = decodePageBody(fetched.body, fetched.contentType);
        charset = decoded.charset;
        evidence = extractPageEvidence(decoded.text, fetched.finalUrl, fetched.headers);
        metadata = fetchedMetadata(fetched);
      } else {
        evidence = evidenceFromRendered(rendered, renderUrl);
        metadata = renderedMetadata(rendered);
      }
      // A renderer that still observes an error status has not recovered the page.
      // Report the block honestly (with any fallback context) instead of returning
      // a challenge page as a successful read.
      if (Number.isInteger(metadata.http_status) && metadata.http_status >= 400) {
        const error = rejectError(`renderer observed HTTP ${metadata.http_status}`, 'upstream_http_status', {
          httpStatus: metadata.http_status, blockedReason: blockedReasonForStatus(metadata.http_status),
        });
        if (renderFallback) { error.renderer = 'crawl4ai'; error.renderFallback = renderFallback; }
        throw error;
      }
      const base = { trace_id, telemetry: { first_valid_result_ms: Date.now() - started, stages_ms }, url: renderUrl, renderer: 'crawl4ai', ...metadata, charset, ...evidence, ...(renderFallback ? { render_fallback: renderFallback } : {}) };
      if (input.output === 'markdown') return textResult({ ...base, markdown: trimText(prependPublishedEvidence(rendered.markdown, evidence)) });
      const saveStarted = Date.now();
      const artifact = await saveArtifact(input.output === 'screenshot' ? rendered.result.screenshot : rendered.result.pdf, input.output === 'screenshot' ? 'png' : 'pdf');
      stages_ms.artifact_save_ms = Date.now() - saveStarted;
      if (!artifact) throw rejectError(`Crawl4AI did not return a ${input.output} artifact`, 'artifact_missing');
      return textResult({ ...base, artifact, expires_after_days: 7 });
    }, new URL(input.url).hostname);
  });
  server.registerTool('web_browser', { description: 'Interact with a public page through the isolated Playwright MCP browser. Sessions expire after 15 minutes and never preserve login state.', inputSchema: { session_id: z.string().uuid().optional(), actions: z.array(z.object({ type: z.enum(['navigate', 'click', 'wait', 'scroll', 'snapshot', 'screenshot', 'close']), url: z.string().url().optional(), ref: z.string().optional(), element: z.string().optional(), ms: z.number().int().min(0).max(10000).optional(), pixels: z.number().int().min(-3000).max(3000).optional() })).min(1).max(8) }, outputSchema: browserOutputSchema }, async input => {
    const trace_id = crypto.randomUUID(); const started = Date.now(); const stages_ms = {};
    return executeTool('web_browser', trace_id, () => withSlot(browserSlots, async () => {
    const now = Date.now();
    for (const [expiredId, value] of browserSessions) {
      if (value.expires < now) { browserSessions.delete(expiredId); await value.client.close().catch(() => {}); }
    }
    const id = input.session_id ?? crypto.randomUUID();
    let session = browserSessions.get(id);
    if (input.actions.some(action => action.type === 'close')) {
      if (!session) throw new Error('browser session is absent or expired');
      browserSessions.delete(id); await session.client.close();
      return textResult({ trace_id, telemetry: { first_valid_result_ms: Date.now() - started, stages_ms: { close_ms: Date.now() - started } }, session_id: id, closed: true });
    }
    if (input.session_id && !session) throw new Error('browser session is absent or expired');
    if (!session) {
      if (browserSessions.size >= 2) throw new Error('browser session limit reached; retry after an existing session expires');
      session = await createBrowserSession();
      browserSessions.set(id, session);
    }
    try {
      const outputs = [];
      for (const action of input.actions) {
        if (action.type === 'navigate' || action.type === 'wait' || action.type === 'scroll') session.snapshot = '';
        const actionStarted = Date.now();
        const output = await browserAction(session, action);
        stages_ms[`browser_${action.type}_ms`] = (stages_ms[`browser_${action.type}_ms`] ?? 0) + Date.now() - actionStarted;
        if (action.type === 'snapshot') session.snapshot = (output.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
        if (action.type === 'snapshot') {
          outputs.push({ ...output, ...browserEvidence(session) });
        } else {
          outputs.push(output);
        }
      }
      const evidence = browserEvidence(session);
      return textResult({ trace_id, telemetry: { first_valid_result_ms: Date.now() - started, stages_ms }, session_id: id, expires_in_seconds: Math.max(0, Math.floor((session.expires - Date.now()) / 1000)), outputs, ...evidence });
    } catch (error) {
      browserSessions.delete(id);
      await session.client.close().catch(() => {});
      throw error;
    }
    }), input.actions.find(action => action.url)?.url ? new URL(input.actions.find(action => action.url).url).hostname : null);
  });
  return server;
}

async function listEvaluationReports() {
  let names = [];
  try { names = await fs.readdir(cfg.reportDir); } catch (error) { if (error.code !== 'ENOENT') console.error(error); }
  const reports = await Promise.all(names.filter(isEvaluationReportFileName).map(async name => {
    try { return normalizeReport(JSON.parse(await fs.readFile(path.join(cfg.reportDir, name), 'utf8')), name); }
    catch (error) { console.error(JSON.stringify({ component: 'eval-dashboard', report: name, error: String(error.message ?? error) })); return null; }
  }));
  return reports.filter(Boolean).sort((a, b) => String(b.completed_at ?? '').localeCompare(String(a.completed_at ?? '')));
}
function noStore(res) { res.set('cache-control', 'no-store'); }
function dashboardAsset(name) { return ['evals.css', 'evals.js'].includes(name) ? path.join(cfg.dashboardDir, name) : null; }

const app = createMcpExpressApp({ host: cfg.bindHost, allowedHosts: cfg.allowedHosts });
app.disable('x-powered-by');
app.use('/api/evals', requireToken);
app.use('/artifacts', requireToken);
app.get('/evals', async (_req, res) => res.sendFile(path.join(cfg.dashboardDir, 'evals.html')));
app.get('/evals/static/:asset', async (req, res) => {
  const file = dashboardAsset(req.params.asset);
  if (!file) return res.status(404).end();
  return res.sendFile(file);
});
app.get('/api/evals', async (_req, res) => {
  noStore(res);
  const reports = await listEvaluationReports();
  return res.json({ generated_at: new Date().toISOString(), total_runs: reports.length, latest: reports[0] ? publicRunSummary(reports[0]) : null, runs: reports.map(publicRunSummary) });
});
app.get('/api/evals/:runId', async (req, res) => {
  noStore(res);
  const report = (await listEvaluationReports()).find(item => item.id === req.params.runId);
  return report ? res.json(report) : res.status(404).json({ error: 'evaluation run not found' });
});
app.get('/api/evals/:runId/artifacts/:name', async (req, res) => {
  const report = (await listEvaluationReports()).find(item => item.id === req.params.runId);
  const artifact = report?.artifacts?.find(item => item.name === req.params.name && safeArtifactId(item.artifact_id));
  if (!artifact) return res.status(404).end();
  const file = path.join(cfg.artifactDir, artifact.artifact_id);
  try { await fs.access(file); noStore(res); return res.sendFile(file); } catch { return res.status(404).end(); }
});
app.use(requireToken);
app.get('/healthz', async (_req, res) => {
  res.json({ ok: true, render_active: renderSlots.active, browser_active: browserSlots.active, request_active: requestSlots.active, artifact_usage_bytes: artifactStore.usageBytes });
});
app.get('/readyz', async (_req, res) => {
  const value = await getReadiness();
  res.status(value.ok ? 200 : 503).json({ ok: value.ok, ...value, render_active: renderSlots.active, browser_active: browserSlots.active });
});
app.get('/artifacts/*path', async (req, res) => {
  const relative = req.params.path.join('/');
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}\/[0-9a-f-]+\.(png|pdf)$/.test(relative)) return res.status(404).end();
  const file = path.join(cfg.artifactDir, relative);
  try { await fs.access(file); return res.sendFile(file); } catch { return res.status(404).end(); }
});
app.post('/mcp', async (req, res) => {
  const server = getServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try { await server.connect(transport); await transport.handleRequest(req, res, req.body); res.on('close', () => { transport.close(); server.close(); }); }
  catch (error) { console.error(error); if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal server error' }, id: null }); }
});
app.all('/mcp', (_req, res) => res.status(405).json({ error: 'method not allowed' }));
app.listen(cfg.port, cfg.bindHost, () => {
  if (cfg.allowAnonymous) console.warn('WARNING: GATEWAY_ALLOW_ANONYMOUS=1 — gateway is running WITHOUT authentication.');
  console.log(`web-access-gateway listening on ${cfg.host}:${cfg.port}`);
  // Startup validation + visibility for the opt-in engine pools (SPEC #74 §2.1): print the resolved
  // layers so the strict layer's `time_range_support` filtering is auditable, and so an all-empty
  // (default) configuration is visibly a no-op.
  const poolConfig = enginePoolConfig();
  const pools = {};
  for (const [layer, engines] of Object.entries(poolConfig.pools)) {
    const validated = layer === 'strict' ? validateStrictPool(engines) : { engines, rejected: [] };
    pools[layer] = { engines: validated.engines, ...(validated.rejected.length ? { rejected: validated.rejected } : {}) };
  }
  console.log(JSON.stringify({ component: 'search-engine-pool', pools, cooldown_ms: poolConfig.cooldownMs, state_ttl_ms: poolConfig.stateTtlMs }));
});
