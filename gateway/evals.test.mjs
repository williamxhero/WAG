import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'offline-viewer-fixture-token-not-a-secret-19';
const REJECTED_TOKEN = 'offline-rejected-fixture-token-not-a-secret';
const RUN_ID = 'release-20261007T120000Z';
const IMAGE_ID = '2026-10-07/123e4567-e89b-12d3-a456-426614174000.png';
const PDF_ID = '2026-10-07/123e4567-e89b-12d3-a456-426614174001.pdf';
const report = {
  schema_version: 1, id: RUN_ID, suite: 'release', status: 'passed',
  completed_at: '2026-10-07T12:00:00Z',
  summary: { success_rate_pct: 100, quality_rate_pct: 100, timeout_rate_pct: 0 },
  cases: [
    { id: 'screenshot', name: 'Protected screenshot', tool: 'web_read', status: 'passed', artifact: 'screen.png' },
    { id: 'pdf', name: 'Protected PDF', tool: 'web_read', status: 'passed', artifact: 'page.pdf' },
  ],
  artifacts: [
    { name: 'screen.png', type: 'image/png', artifact_id: IMAGE_ID },
    { name: 'page.pdf', type: 'application/pdf', artifact_id: PDF_ID },
  ],
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wag-evals-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reports = path.join(root, 'reports'), artifacts = path.join(root, 'artifacts');
  await fs.mkdir(reports);
  await fs.mkdir(path.join(artifacts, '2026-10-07'), { recursive: true });
  await fs.writeFile(path.join(reports, `${RUN_ID}.json`), JSON.stringify(report));
  await fs.writeFile(path.join(reports, 'smoke-20260828T010939Z.json'), JSON.stringify({
    suite: 'smoke', at: '2026-08-28T01:09:39Z', health: { ok: true }, private_proxy_status: 403,
  }));
  await fs.writeFile(path.join(artifacts, IMAGE_ID), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jO1sAAAAASUVORK5CYII=', 'base64'));
  await fs.writeFile(path.join(artifacts, PDF_ID), '%PDF-1.4\n%%EOF\n');
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  // Express deliberately refuses sendFile paths under dot-directories, including
  // isolated .claude/worktrees. Run an exact source copy outside that boundary.
  const gateway = path.join(root, 'gateway');
  await fs.cp(moduleDir, gateway, { recursive: true, filter: source => path.basename(source) !== 'node_modules' });
  await fs.symlink(path.join(moduleDir, 'node_modules'), path.join(gateway, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const child = spawn(process.execPath, [path.join(gateway, 'server.mjs')], {
    env: { ...process.env, GATEWAY_HOST: '127.0.0.1', GATEWAY_BIND_HOST: '127.0.0.1',
      GATEWAY_ALLOWED_HOSTS: '127.0.0.1', GATEWAY_PORT: String(port), GATEWAY_TOKEN: TOKEN,
      CRAWL4AI_TOKEN: 'offline-unused', EVAL_REPORT_DIR: reports, ARTIFACT_DIR: artifacts,
      SEARXNG_URL: 'http://127.0.0.1:1', CRAWL4AI_URL: 'http://127.0.0.1:1',
      PLAYWRIGHT_MCP_URL: 'http://127.0.0.1:1/mcp', EGRESS_PROXY: 'http://127.0.0.1:1',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk; });
  child.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
    for (const token of [TOKEN, REJECTED_TOKEN]) assert.ok(!logs.includes(token), 'server logs must not contain credentials');
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fixture gateway did not start: ${logs}`)), 5000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('web-access-gateway listening')) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`fixture gateway exited: ${code}; ${logs}`)); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  return { base: `http://127.0.0.1:${port}`, reports, artifacts };
}

async function waitFor(predicate, label) {
  const until = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function viewer(t, f, intercept = (_url, _options, send) => send()) {
  const html = await (await fetch(`${f.base}/evals`)).text();
  const source = await (await fetch(`${f.base}/evals/static/evals.js`)).text();
  const errors = [];
  const virtualConsole = new VirtualConsole();
  for (const event of ['error', 'warn', 'log', 'jsdomError']) virtualConsole.on(event, (...args) => errors.push(args.join(' ')));
  const dom = new JSDOM(html, { url: `${f.base}/evals`, runScripts: 'outside-only', virtualConsole });
  t.after(() => dom.window.close());
  const { window } = dom;
  // Pair the fetch adapter with its own platform AbortSignal implementation.
  window.AbortController = AbortController;
  const requests = [], activeURLs = new Map(), revoked = [];
  window.fetch = (url, options = {}) => {
    requests.push({ url: String(url), options });
    return intercept(String(url), options, () => fetch(new URL(url, f.base), options));
  };
  window.URL.createObjectURL = blob => {
    const url = `blob:${f.base}/fixture-${activeURLs.size + revoked.length}`;
    activeURLs.set(url, blob);
    return url;
  };
  window.URL.revokeObjectURL = url => { revoked.push(url); activeURLs.delete(url); };
  const intervals = [];
  window.setInterval = (callback, milliseconds) => { intervals.push({ callback, milliseconds, cleared: false }); return intervals.length; };
  window.clearInterval = id => { intervals[id - 1].cleared = true; };
  window.eval(source);
  const $ = selector => window.document.querySelector(selector);
  const submit = token => {
    assert.ok($('#token-form'), 'public shell must offer explicit token entry');
    $('#token').value = token;
    $('#token-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  };
  return { window, $, submit, requests, activeURLs, revoked, intervals, errors };
}

test('viewer recovers from 401 and clears protected data on credential replacement and clearing', async t => {
  const f = await fixture(t), ui = await viewer(t, f);
  assert.equal(ui.requests.length, 0, 'public shell does not query protected APIs without explicit entry');
  ui.intervals[0].callback();
  assert.equal(ui.requests.length, 0);
  ui.submit(REJECTED_TOKEN);
  await waitFor(() => ui.$('#auth-status').textContent.includes('401'), 'recoverable authentication feedback');
  noProtectedContent(ui);
  assert.ok(ui.$('#auth-status').textContent.includes('替换 Token'));
  assert.equal(ui.$('#token').value, '');
  ui.submit(TOKEN);
  await waitFor(() => ui.activeURLs.size === 2 && !ui.$('#content').hidden, '401 recovery');
  const oldURLs = [...ui.activeURLs.keys()];
  ui.submit(REJECTED_TOKEN);
  noProtectedContent(ui);
  assert.ok(oldURLs.every(url => ui.revoked.includes(url)));
  await waitFor(() => ui.$('#auth-status').textContent.includes('401'), 'replacement rejection');
  noProtectedContent(ui);
  ui.submit(TOKEN);
  await waitFor(() => ui.activeURLs.size === 2 && !ui.$('#content').hidden, 'second recovery');
  const lists = ui.requests.filter(request => request.url === '/api/evals').length;
  ui.intervals[0].callback();
  await waitFor(() => ui.requests.filter(request => request.url === '/api/evals').length === lists + 1 && !ui.$('#content').hidden, 'automatic authenticated refresh');
  ui.$('#clear-token').click();
  noProtectedContent(ui);
  assert.equal(ui.$('#refresh').disabled, true);
  const requests = ui.requests.length;
  ui.intervals[0].callback();
  assert.equal(ui.requests.length, requests, 'cleared credentials cannot issue periodic requests');
  for (const token of [TOKEN, REJECTED_TOKEN]) {
    assert.ok(!ui.window.document.documentElement.outerHTML.includes(token));
    assert.ok(ui.requests.every(request => !request.url.includes(token)));
  }
  assert.equal(ui.window.localStorage.length, 0);
  assert.equal(ui.window.sessionStorage.length, 0);
  assert.equal(ui.window.document.cookie, '');
  assert.deepEqual(ui.errors, []);
});

test('expired or missing artifacts leave a readable report with recoverable artifact feedback', async t => {
  const f = await fixture(t), ui = await viewer(t, f);
  ui.submit(TOKEN);
  await waitFor(() => ui.activeURLs.size === 2, 'initial artifacts');
  const urls = [...ui.activeURLs.keys()];
  await fs.rm(path.join(f.artifacts, IMAGE_ID));
  await fs.rm(path.join(f.artifacts, PDF_ID));
  assert.equal((await fetch(`${f.base}/api/evals/${RUN_ID}/artifacts/screen.png`, auth)).status, 404);
  assert.equal((await fetch(`${f.base}/api/evals/${RUN_ID}/artifacts/page.pdf`, auth)).status, 404);
  assert.equal((await fetch(`${f.base}/api/evals/${RUN_ID}/artifacts/missing.pdf`, auth)).status, 404);
  ui.$('#refresh').click();
  await waitFor(() => !ui.$('#content').hidden, 'report with expired artifacts');
  assert.equal(ui.$('#cases').children.length, 2);
  assert.equal(ui.window.document.querySelectorAll('.artifact img, .artifact iframe, .artifact a').length, 0);
  assert.equal([...ui.window.document.querySelectorAll('.artifact')].filter(node => node.textContent.includes('不存在或已过期')).length, 2);
  assert.equal(ui.activeURLs.size, 0);
  assert.ok(urls.every(url => ui.revoked.includes(url)));
  assert.deepEqual(ui.errors, []);
});

test('401 during detail or artifact access clears all protected content and permits recovery', async t => {
  const f = await fixture(t);
  for (const route of [`/api/evals/${RUN_ID}`, `/api/evals/${RUN_ID}/artifacts/page.pdf`]) {
    await t.test(route, async t => {
      let expired = false;
      const ui = await viewer(t, f, (url, options, send) => expired && url === route
        ? fetch(f.base + url, { ...options, headers: { Authorization: `Bearer ${REJECTED_TOKEN}` } }) : send());
      ui.submit(TOKEN);
      await waitFor(() => ui.activeURLs.size === 2 && !ui.$('#content').hidden, 'initial report');
      expired = true;
      ui.$('#refresh').click();
      await waitFor(() => ui.$('#auth-status').textContent.includes('401'), 'expired request feedback');
      noProtectedContent(ui);
      expired = false;
      ui.submit(TOKEN);
      await waitFor(() => ui.activeURLs.size === 2 && !ui.$('#content').hidden, 'recovered report');
      assert.deepEqual(ui.errors, []);
    });
  }
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('late list, detail and blob bodies cannot restore cleared or replaced protected content', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  for (const [route, body, action] of [
    ['/api/evals', 'json', 'replace-rejected'],
    [`/api/evals/${RUN_ID}`, 'json', 'clear'],
    [`/api/evals/${RUN_ID}/artifacts/page.pdf`, 'blob', 'replace-valid'],
  ]) {
    await t.test(`${body}: ${action}`, async t => {
      const arrived = deferred(), release = deferred(), returned = deferred();
      let paused = false;
      const ui = await viewer(t, f, async (url, _options, send) => {
        if (url !== route || paused) return send();
        paused = true;
        const response = await send(), value = await response[body]();
        return { ok: response.ok, status: response.status, [body]: async () => {
          arrived.resolve();
          await release.promise;
          returned.resolve();
          return value;
        } };
      });
      t.after(() => release.resolve());
      ui.submit(TOKEN);
      await arrived.promise;
      const oldRequest = ui.requests.find(request => request.url === route);
      if (action === 'clear') ui.$('#clear-token').click();
      else ui.submit(action === 'replace-valid' ? TOKEN : REJECTED_TOKEN);
      noProtectedContent(ui);
      assert.ok(oldRequest.options.signal.aborted, 'old requests are actively cancelled');
      if (action === 'replace-valid') await waitFor(() => ui.activeURLs.size === 2 && !ui.$('#content').hidden, 'replacement view');
      if (action === 'replace-rejected') await waitFor(() => ui.$('#auth-status').textContent.includes('401'), 'replacement 401');
      release.resolve();
      await returned.promise;
      await new Promise(resolve => setImmediate(resolve));
      if (action === 'replace-valid') {
        assert.equal(ui.activeURLs.size, 2, 'a late old blob cannot leak another URL');
        assert.ok(!ui.$('#content').hidden);
      } else noProtectedContent(ui);
      assert.deepEqual(ui.errors, []);
    });
  }
});

test('page disposal clears credentials/content, revokes blobs and stops automatic refresh', async t => {
  const f = await fixture(t), ui = await viewer(t, f);
  ui.submit(TOKEN);
  await waitFor(() => ui.activeURLs.size === 2 && !ui.$('#content').hidden, 'initial report');
  ui.window.dispatchEvent(new ui.window.Event('pagehide'));
  noProtectedContent(ui);
  assert.equal(ui.revoked.length, 2);
  assert.ok(ui.intervals[0].cleared);
  const before = ui.requests.length;
  ui.intervals[0].callback();
  assert.equal(ui.requests.length, before);
  assert.ok(!ui.window.document.documentElement.outerHTML.includes(TOKEN));
  assert.deepEqual(ui.errors, []);
});

test('restoring a disposed shell requires token re-entry and resumes authenticated refresh', async t => {
  const f = await fixture(t), ui = await viewer(t, f);
  ui.submit(TOKEN);
  await waitFor(() => !ui.$('#content').hidden, 'initial report');
  ui.window.dispatchEvent(new ui.window.Event('pagehide'));
  ui.window.dispatchEvent(new ui.window.Event('pageshow'));
  noProtectedContent(ui);
  assert.equal(ui.intervals.length, 2, 'restoration starts a new refresh timer');
  const requests = ui.requests.length;
  ui.intervals[1].callback();
  assert.equal(ui.requests.length, requests, 'restoration does not restore old credentials');
  ui.submit(TOKEN);
  await waitFor(() => !ui.$('#content').hidden, 'explicit re-entry after restoration');
  ui.intervals[1].callback();
  await waitFor(() => ui.requests.length > requests + 4 && !ui.$('#content').hidden, 'resumed authenticated refresh');
  assert.deepEqual(ui.errors, []);
});

const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

function noProtectedContent(ui) {
  assert.ok(ui.$('#content').hidden);
  for (const id of ['latest-meta', 'kpis', 'trend', 'runs', 'detail-meta', 'tools', 'cases']) {
    assert.equal(ui.$(`#${id}`).textContent, '', `${id} must be cleared, not merely hidden`);
  }
  assert.equal(ui.$('#cases').children.length, 0);
  assert.equal(ui.activeURLs.size, 0);
}

test('evaluation shell is public while report and artifact APIs require Bearer authentication', async t => {
  const f = await fixture(t);
  for (const route of ['/evals', '/evals/static/evals.js', '/evals/static/evals.css']) {
    assert.equal((await fetch(f.base + route)).status, 200);
  }
  for (const route of ['/api/evals', `/api/evals/${RUN_ID}`, `/api/evals/${RUN_ID}/artifacts/screen.png`, `/api/evals/${RUN_ID}/artifacts/page.pdf`, `/artifacts/${IMAGE_ID}`, `/artifacts/${PDF_ID}`]) {
    assert.equal((await fetch(f.base + route)).status, 401);
    assert.equal((await fetch(`${f.base}${route}?token=${TOKEN}`)).status, 401, 'URL credentials do not authenticate');
    assert.equal((await fetch(f.base + route, { headers: { Authorization: `Bearer ${REJECTED_TOKEN}` } })).status, 401);
    const response = await fetch(f.base + route, auth);
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(TOKEN), 'API payloads do not echo credentials');
  }
});

test('viewer enters memory-only credentials and authenticates list, detail and refresh requests', async t => {
  const f = await fixture(t), ui = await viewer(t, f);
  assert.ok(ui.$('#content').hidden);
  ui.submit(TOKEN);
  try {
    await waitFor(() => !ui.$('#content').hidden && ui.$('#cases').textContent.includes('Protected screenshot'), 'authenticated report');
  } catch (error) {
    assert.fail(`${error.message}; status=${ui.$('#auth-status').textContent}; requests=${ui.requests.map(request => request.url)}; browser=${ui.errors}`);
  }
  assert.equal(ui.$('#token').type, 'password');
  assert.equal(ui.$('#token').value, '', 'submitted credentials leave the input immediately');
  ui.$('#refresh').click();
  await waitFor(() => ui.requests.filter(request => request.url === '/api/evals').length === 2 && !ui.$('#content').hidden, 'manual refresh');
  assert.ok(ui.requests.some(request => request.url === `/api/evals/${RUN_ID}`));
  for (const { url, options } of ui.requests) {
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.cache, 'no-store');
    assert.equal(options.credentials, 'omit');
    assert.ok(!url.includes(TOKEN));
  }
  assert.equal(ui.window.document.cookie, '');
  assert.equal(ui.window.localStorage.length, 0);
  assert.equal(ui.window.sessionStorage.length, 0);
  assert.ok(!ui.window.document.documentElement.outerHTML.includes(TOKEN));
  assert.deepEqual(ui.errors, []);
});

test('authenticated images and PDFs use blob views/downloads and release old object URLs', async t => {
  const f = await fixture(t), ui = await viewer(t, f);
  ui.submit(TOKEN);
  await waitFor(() => ui.activeURLs.size === 2, 'authenticated image and PDF blobs');
  const image = ui.$('.artifact img'), pdf = ui.$('.artifact iframe');
  assert.equal(ui.activeURLs.get(image.src).type, 'image/png');
  assert.equal(ui.activeURLs.get(pdf.src).type, 'application/pdf');
  assert.ok(ui.activeURLs.get(image.src).size > 0);
  assert.equal(await ui.activeURLs.get(pdf.src).text(), '%PDF-1.4\n%%EOF\n');
  for (const link of ui.window.document.querySelectorAll('.artifact a')) {
    assert.ok(ui.activeURLs.has(link.href));
    assert.ok(link.download || link.rel.includes('noopener'));
  }
  assert.deepEqual([...ui.window.document.querySelectorAll('.artifact a[download]')].map(link => link.download), ['screen.png', 'page.pdf']);
  assert.ok(!ui.$('#cases').innerHTML.includes('/api/evals/'));
  const firstURLs = [...ui.activeURLs.keys()];
  ui.$('#refresh').click();
  assert.equal(ui.activeURLs.size, 0, 'refresh immediately revokes old URLs');
  await waitFor(() => ui.activeURLs.size === 2, 'refreshed artifact blobs');
  assert.ok(firstURLs.every(url => ui.revoked.includes(url)));
  ui.$('[data-run="smoke-20260828T010939Z"]').click();
  assert.equal(ui.activeURLs.size, 0, 'selecting another report disposes old artifacts');
  await waitFor(() => !ui.$('#content').hidden && ui.$('#detail-meta').textContent.includes('兼容模式'), 'historical report');
  assert.equal(ui.$('#cases').children.length, 2);
  assert.ok(ui.$('#cases').textContent.includes('Gateway health'));
  assert.ok(ui.$('#cases').textContent.includes('Private target proxy block'));
  assert.ok(ui.$('#latest-meta').textContent.includes('兼容旧格式'));
  ui.$(`#runs [data-run="${RUN_ID}"]`).click();
  await waitFor(() => ui.activeURLs.size === 2, 'return to artifact report');
  ui.$('#clear-token').click();
  noProtectedContent(ui);
  assert.equal(ui.revoked.length, 6);
  for (const { url, options } of ui.requests) {
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.ok(!url.includes(TOKEN));
  }
  assert.deepEqual(ui.errors, []);
});
