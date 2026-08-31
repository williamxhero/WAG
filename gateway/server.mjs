import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import TurndownService from 'turndown';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as z from 'zod/v4';
import { isEvaluationReportFileName, normalizeReport, publicRunSummary, safeArtifactId } from './eval-core.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const cfg = Object.freeze({
  host: process.env.GATEWAY_HOST ?? 'yosef-server',
  bindHost: process.env.GATEWAY_BIND_HOST ?? process.env.GATEWAY_HOST ?? 'yosef-server',
  port: Number(process.env.GATEWAY_PORT ?? 8930),
  token: process.env.GATEWAY_TOKEN ?? '',
  crawlUrl: process.env.CRAWL4AI_URL ?? 'http://127.0.0.1:11235',
  crawlToken: process.env.CRAWL4AI_TOKEN ?? '',
  searxUrl: process.env.SEARXNG_URL ?? 'http://yosef-server:8801',
  playwrightUrl: process.env.PLAYWRIGHT_MCP_URL ?? 'http://localhost:8931/mcp',
  artifactDir: process.env.ARTIFACT_DIR ?? '/data/web-access-gateway/artifacts',
  artifactBase: process.env.ARTIFACT_BASE_URL ?? process.env.ARTIFACT_BASE ?? 'http://yosef-server:8930',
  reportDir: process.env.EVAL_REPORT_DIR ?? '/data/web-access-gateway/reports',
  dashboardDir: path.join(moduleDir, 'public'),
  allowedHosts: (process.env.GATEWAY_ALLOWED_HOSTS ?? 'yosef-server').split(',').map(v => v.trim()),
});

if (cfg.token.length < 32) throw new Error('GATEWAY_TOKEN must be at least 32 characters');

const browserSessions = new Map();
const renderSlots = { active: 0, limit: 2 };
const browserSlots = { active: 0, limit: 2 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tokenEqual = value => {
  const supplied = Buffer.from(value ?? '');
  const expected = Buffer.from(cfg.token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
};
const requireToken = (req, res, next) => {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('authorization') ?? '');
  if (!match || !tokenEqual(match[1])) return res.status(401).json({ error: 'unauthorized' });
  next();
};

function isPublicAddress(address) {
  // RFC 1918, loopback, link-local, CGNAT, documentation/benchmark and all
  // IPv6 special-use ranges are deliberately excluded.  DNS answers must all
  // be public: selecting one answer would otherwise permit DNS rebinding.
  if (address.includes(':')) {
    const value = address.toLowerCase().replace(/^::ffff:/, '');
    if (!value.includes(':')) return isPublicAddress(value);
    return !(/^(::|::1|fc|fd|fe[89ab]|2001:db8:|2001:2:|2001:10:|2002:|64:ff9b:1:)/.test(value) ||
      value.startsWith('ff') || value.startsWith('::ffff:'));
  }
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = octets;
  return !(a === 0 || a === 10 || a === 100 && b >= 64 && b <= 127 || a === 127 ||
    a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 0 ||
    a === 192 && b === 0 && c === 2 || a === 192 && b === 88 && c === 99 || a === 192 && b === 168 ||
    a === 198 && (b === 18 || b === 19 || b === 51) || a === 203 && b === 0 && c === 113 ||
    a >= 224);
}
async function resolvePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('invalid URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('only public HTTP/HTTPS URLs are allowed');
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('only ports 80 and 443 are allowed');
  const records = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) throw new Error('non-public targets are blocked');
  return { url, records };
}
function requestOnce(url, records) {
  const transport = url.protocol === 'https:' ? https : http;
  const address = records[0].address;
  return new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: `${url.pathname}${url.search}`,
      method: 'GET', headers: { 'User-Agent': 'WebAccessGateway/1.0', 'Accept': 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'identity' },
      timeout: 30000,
      lookup: (_host, options, callback) => {
        const family = address.includes(':') ? 6 : 4;
        return options?.all ? callback(null, [{ address, family }]) : callback(null, address, family);
      },
    }, response => {
      const parts = [];
      let total = 0;
      response.on('data', chunk => { total += chunk.length; if (total <= 5 * 1024 * 1024) parts.push(chunk); else request.destroy(new Error('response exceeds 5 MiB')); });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(parts) }));
    });
    request.once('timeout', () => request.destroy(new Error('request timed out')));
    request.once('error', reject);
    request.end();
  });
}
async function fetchPublic(raw) {
  let current = raw;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const { url, records } = await resolvePublicUrl(current);
    const response = await requestOnce(url, records);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      current = new URL(response.headers.location, url).href;
      continue;
    }
    return { ...response, finalUrl: url.href };
  }
  throw new Error('too many redirects');
}
function textResult(value) { return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] }; }
function trimText(text, maximum = 40000) { return text.length > maximum ? `${text.slice(0, maximum)}\n\n[truncated]` : text; }
function lightExtract(html, finalUrl) {
  const dom = new JSDOM(html, { url: finalUrl });
  const document = dom.window.document;
  for (const node of document.querySelectorAll('script,style,noscript,svg,nav,footer,aside,iframe')) node.remove();
  const main = document.querySelector('article, main, [role="main"]') ?? document.body;
  const markdown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(main?.innerHTML ?? '');
  return { title: document.title?.trim() ?? '', markdown: markdown.replace(/\n{3,}/g, '\n\n').trim() };
}
async function withSlot(pool, job) {
  const started = Date.now();
  while (pool.active >= pool.limit) { if (Date.now() - started > 30000) throw new Error('service is busy; retry shortly'); await sleep(100); }
  pool.active++;
  try { return await job(); } finally { pool.active--; }
}
async function callCrawl4ai(url, output) {
  return withSlot(renderSlots, async () => {
    const response = await fetch(`${cfg.crawlUrl}/crawl`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.crawlToken}` },
      body: JSON.stringify({ urls: [url], browser_config: { type: 'BrowserConfig', params: { headless: true } }, crawler_config: { type: 'CrawlerRunConfig', params: { cache_mode: 'bypass', screenshot: output === 'screenshot', pdf: output === 'pdf' } } }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`Crawl4AI returned ${response.status}: ${trimText(await response.text(), 500)}`);
    const payload = await response.json();
    const result = payload.results?.[0] ?? payload[0] ?? payload;
    const markdown = result.markdown?.raw_markdown ?? result.markdown ?? result.fit_markdown ?? '';
    return { result, markdown: typeof markdown === 'string' ? markdown : JSON.stringify(markdown) };
  });
}
async function saveArtifact(value, extension) {
  if (typeof value !== 'string' || !value) return null;
  const id = crypto.randomUUID();
  const day = new Date().toISOString().slice(0, 10);
  const relative = path.posix.join(day, `${id}.${extension}`);
  const target = path.join(cfg.artifactDir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
  const content = value.startsWith('data:') ? Buffer.from(value.slice(value.indexOf(',') + 1), 'base64') : Buffer.from(value, 'base64');
  await fs.writeFile(target, content, { mode: 0o640 });
  return { id: relative, url: `${cfg.artifactBase}/artifacts/${encodeURIComponent(relative)}`, bytes: content.length };
}
async function createBrowserSession() {
  const transport = new StreamableHTTPClientTransport(new URL(cfg.playwrightUrl));
  const client = new Client({ name: 'web-access-gateway', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, created: Date.now(), expires: Date.now() + 15 * 60 * 1000, snapshot: '' };
}
async function playwrightCall(session, name, args) {
  return session.client.callTool({ name, arguments: args });
}
async function browserAction(session, action) {
  const type = action.type;
  if (type === 'navigate') {
    const fetched = await fetchPublic(action.url);
    return playwrightCall(session, 'browser_navigate', { url: fetched.finalUrl });
  }
  if (type === 'click') {
    const text = session.snapshot;
    const escaped = action.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = text.split('\n').find(value => new RegExp(`\\[ref=${escaped}\\]`).test(value));
    if (!line || !/\blink\b/i.test(line)) throw new Error('click is limited to a link in the latest accessibility snapshot');
    return playwrightCall(session, 'browser_click', { ref: action.ref, element: action.element ?? 'link' });
  }
  if (type === 'wait') return playwrightCall(session, 'browser_wait_for', { time: action.ms ?? 1000 });
  if (type === 'scroll') return playwrightCall(session, 'browser_evaluate', { function: `() => window.scrollBy(0, ${Math.max(-3000, Math.min(3000, Number(action.pixels ?? 600)))})` });
  if (type === 'snapshot') return playwrightCall(session, 'browser_snapshot', {});
  if (type === 'screenshot') return playwrightCall(session, 'browser_take_screenshot', { fullPage: true });
  throw new Error(`unsupported browser action: ${type}`);
}
function getServer() {
  const server = new McpServer({ name: 'web-access-gateway', version: '1.0.0' });
  server.registerTool('web_search', { description: 'Search public web pages through the local SearXNG instance.', inputSchema: { query: z.string().min(1).max(500), categories: z.string().optional(), engines: z.string().optional(), language: z.string().optional(), time_range: z.enum(['day', 'month', 'year']).optional(), page: z.number().int().min(1).max(10).optional() } }, async input => {
    const trace_id = crypto.randomUUID(); const started = Date.now();
    const params = new URLSearchParams({ q: input.query, format: 'json' });
    for (const key of ['categories', 'engines', 'language', 'time_range']) if (input[key]) params.set(key, input[key]);
    if (input.page) params.set('pageno', String(input.page));
    const response = await fetch(`${cfg.searxUrl}/search?${params}`, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`SearXNG returned ${response.status}`);
    const body = await response.json();
    const results = (body.results ?? []).slice(0, 20).map(item => ({ title: item.title, url: item.url, content: item.content, engine: item.engine, category: item.category }));
    const duration_ms = Date.now() - started;
    console.log(JSON.stringify({ trace_id, tool: 'web_search', duration_ms, outcome: 'ok' }));
    return textResult({ trace_id, telemetry: { first_valid_result_ms: duration_ms, stages_ms: { search_ms: duration_ms } }, query: input.query, number_of_results: body.number_of_results ?? results.length, results });
  });
  server.registerTool('web_read', { description: 'Read a public URL as clean Markdown. Uses lightweight extraction first and Crawl4AI rendering when needed.', inputSchema: { url: z.string().url(), render: z.enum(['auto', 'never', 'always']).default('auto'), output: z.enum(['markdown', 'screenshot', 'pdf']).default('markdown') } }, async input => {
    const trace_id = crypto.randomUUID(); const started = Date.now(); const stages_ms = {};
    let fetched;
    let light;
    if (input.render !== 'always') {
      const fetchStarted = Date.now();
      fetched = await fetchPublic(input.url);
      stages_ms.fetch_ms = Date.now() - fetchStarted;
      const type = fetched.headers['content-type'] ?? '';
      if (!type.includes('html') && input.output === 'markdown') throw new Error(`unsupported content type: ${type}`);
      const extractStarted = Date.now();
      light = lightExtract(fetched.body.toString('utf8'), fetched.finalUrl);
      stages_ms.extract_ms = Date.now() - extractStarted;
      if (input.render === 'never' || (light.markdown.length >= 700 && input.output === 'markdown')) return textResult({ trace_id, telemetry: { first_valid_result_ms: Date.now() - started, stages_ms }, url: fetched.finalUrl, renderer: 'lightweight', title: light.title, markdown: trimText(light.markdown) });
    }
    if (!fetched) { const fetchStarted = Date.now(); fetched = await fetchPublic(input.url); stages_ms.fetch_ms = Date.now() - fetchStarted; }
    const renderStarted = Date.now();
    const rendered = await callCrawl4ai(fetched.finalUrl, input.output);
    stages_ms.render_ms = Date.now() - renderStarted;
    if (input.output === 'markdown') return textResult({ trace_id, telemetry: { first_valid_result_ms: Date.now() - started, stages_ms }, url: fetched.finalUrl, renderer: 'crawl4ai', markdown: trimText(rendered.markdown) });
    const saveStarted = Date.now();
    const artifact = await saveArtifact(input.output === 'screenshot' ? rendered.result.screenshot : rendered.result.pdf, input.output === 'screenshot' ? 'png' : 'pdf');
    stages_ms.artifact_save_ms = Date.now() - saveStarted;
    if (!artifact) throw new Error(`Crawl4AI did not return a ${input.output} artifact`);
    return textResult({ trace_id, telemetry: { first_valid_result_ms: Date.now() - started, stages_ms }, url: fetched.finalUrl, renderer: 'crawl4ai', artifact, expires_after_days: 7 });
  });
  server.registerTool('web_browser', { description: 'Interact with a public page through the isolated Playwright MCP browser. Sessions expire after 15 minutes and never preserve login state.', inputSchema: { session_id: z.string().uuid().optional(), actions: z.array(z.object({ type: z.enum(['navigate', 'click', 'wait', 'scroll', 'snapshot', 'screenshot', 'close']), url: z.string().url().optional(), ref: z.string().optional(), element: z.string().optional(), ms: z.number().int().min(0).max(10000).optional(), pixels: z.number().int().min(-3000).max(3000).optional() })).min(1).max(8) } }, async input => withSlot(browserSlots, async () => {
    const trace_id = crypto.randomUUID(); const started = Date.now(); const stages_ms = {};
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
        if (action.type === 'screenshot') {
          const image = output.content?.find(item => item.type === 'image');
          const artifact = await saveArtifact(image?.data, 'png');
          outputs.push({ content: (output.content ?? []).filter(item => item.type !== 'image'), artifact });
        } else {
          outputs.push(output);
        }
      }
      return textResult({ trace_id, telemetry: { first_valid_result_ms: Date.now() - started, stages_ms }, session_id: id, expires_in_seconds: Math.max(0, Math.floor((session.expires - Date.now()) / 1000)), outputs });
    } catch (error) {
      browserSessions.delete(id);
      await session.client.close().catch(() => {});
      throw error;
    }
  }));
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
  res.json({ ok: true, render_active: renderSlots.active, browser_active: browserSlots.active });
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
app.listen(cfg.port, cfg.bindHost, () => console.log(`web-access-gateway listening on ${cfg.host}:${cfg.port}`));
