import { normalizeSearchResults } from './evidence-metadata.mjs';

export const DEFAULT_PROBE_TIMEOUT_MS = 10000;

function failure(kind, message, extra = {}) {
  return Object.assign(new Error(message), { kind, ...extra });
}

export function sanitizeDiagnostic(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]');
  return text
    .replace(/\b(?:authorization|proxy-authorization)["']?\s*[:=]\s*[^\r\n]+/gi, '[redacted header]')
    .replace(/\bBearer\s+[^\s,"'<>]+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
      try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href; }
      catch { return '[redacted URL]'; }
    })
    .replace(/\b([\w-]*(?:token|secret|password|api[_-]?key|credential|private[_-]?key|access[_-]?key)[\w-]*)["']?\s*[:=]\s*["']?[^\s,;"']+/gi, '$1=[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 240);
}

function engineDetails(value, secrets) {
  if (!Array.isArray(value)) return undefined;
  return value.slice(0, 20).map(item => Array.isArray(item)
    ? item.slice(0, 2).map(part => sanitizeDiagnostic(part, secrets))
    : sanitizeDiagnostic(item, secrets));
}

async function responseText(response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 64 * 1024) throw failure('dependency_response_too_large', 'Dependency probe response exceeds 64 KiB');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

async function probeJson(url, options, label) {
  const response = await fetch(url, options);
  const text = await responseText(response);
  let body;
  try { body = JSON.parse(text); } catch { /* Non-JSON error bodies still carry a useful HTTP diagnostic. */ }
  if (!response.ok) throw failure('dependency_http_status', `${label} returned HTTP ${response.status}: ${text}`, { httpStatus: response.status, engines: body?.unresponsive_engines });
  if (body === undefined) throw failure('dependency_invalid_data', `${label} returned invalid JSON`, { httpStatus: response.status });
  return { body, http_status: response.status };
}

// The only injected operation is the existing public-egress transport boundary.
// Deadlines include DNS, connection establishment and response-body consumption.
export function createReadiness({ searxUrl, crawlUrl, crawlToken, playwrightUrl, egressProbe, secrets = [], cacheMs = 10000, probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS, now = Date.now }) {
  let cached;
  let checkedAt = 0;
  let inFlight;
  const redact = value => sanitizeDiagnostic(value, [crawlToken, ...secrets]);
  async function probe(name, scope, operation) {
    const started = now();
    const controller = new AbortController();
    let timer;
    try {
      const detail = await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise((_, reject) => { timer = setTimeout(() => { const error = failure('dependency_timeout', `${name} probe deadline exceeded`); controller.abort(error); reject(error); }, probeTimeoutMs); }),
      ]);
      return { name, scope, ok: true, duration_ms: now() - started, ...detail };
    } catch (error) {
      return {
        name, scope, ok: false, duration_ms: now() - started,
        ...(error.engines !== undefined ? { unresponsive_engines: engineDetails(error.engines, [crawlToken, ...secrets]) } : {}),
        error: { kind: controller.signal.aborted ? 'dependency_timeout' : error.kind ?? 'dependency_error', message: redact(error.message ?? error),
          ...(error.httpStatus ? { http_status: error.httpStatus } : {}),
          ...(error.cause?.code || error.code ? { code: redact(error.cause?.code ?? error.code) } : {}) },
      };
    } finally { clearTimeout(timer); }
  }
  async function check() {
    const dependencies = await Promise.all([
      probe('searxng', 'public_connectivity', async signal => {
        const { body, http_status } = await probeJson(`${searxUrl.replace(/\/+$/, '')}/search?q=readyz&format=json`, { signal }, 'SearXNG');
        if (!body || typeof body !== 'object' || !Array.isArray(body.results)) throw failure('dependency_invalid_data', 'SearXNG response must contain a results array', { httpStatus: http_status, engines: body?.unresponsive_engines });
        const items = body.results.filter(item => {
          if (typeof item?.url !== 'string' || (item.title != null && typeof item.title !== 'string') || (item.content != null && typeof item.content !== 'string')) return false;
          try {
            const url = new URL(item.url);
            return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && Boolean(item.title?.trim() || item.content?.trim());
          } catch { return false; }
        });
        const results = normalizeSearchResults(items);
        if (!results.length) throw failure('search_empty', 'SearXNG returned no usable normalized results', { httpStatus: http_status, engines: body.unresponsive_engines });
        return { http_status, result_count: results.length, ...(body.unresponsive_engines !== undefined ? { unresponsive_engines: engineDetails(body.unresponsive_engines, [crawlToken, ...secrets]) } : {}) };
      }),
      probe('crawl4ai', 'core', async signal => {
        const { body, http_status } = await probeJson(`${crawlUrl.replace(/\/+$/, '')}/readyz`, { headers: { authorization: `Bearer ${crawlToken}` }, signal }, 'Crawl4AI');
        if (body?.ok !== true || body?.initialized !== true || body?.lifecycle !== 'ready') throw failure('crawler_uninitialized', 'Crawl4AI lifecycle is not ready', { httpStatus: http_status });
        return { http_status, initialized: true, lifecycle: 'ready' };
      }),
      probe('playwright', 'core', async signal => {
        const response = await fetch(playwrightUrl, { signal });
        await response.body?.cancel();
        if (![200, 400, 405, 406].includes(response.status)) throw failure('dependency_http_status', `Playwright returned HTTP ${response.status}`, { httpStatus: response.status });
        return { http_status: response.status };
      }),
      probe('egress_proxy', 'public_connectivity', egressProbe),
    ]);
    const core_ok = dependencies.filter(item => item.scope === 'core').every(item => item.ok);
    const public_connectivity_ok = dependencies.filter(item => item.scope === 'public_connectivity').every(item => item.ok);
    return { checked_at: new Date(now()).toISOString(), ok: core_ok && public_connectivity_ok, core_ok, public_connectivity_ok, status: !core_ok ? 'failed' : public_connectivity_ok ? 'passed' : 'degraded', dependencies };
  }
  return async function getReadiness() {
    if (inFlight) return inFlight;
    if (cached && now() - checkedAt < cacheMs) return cached;
    inFlight = check().then(value => { cached = value; checkedAt = now(); return value; }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
