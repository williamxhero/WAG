import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const scripts = path.resolve(import.meta.dirname, '../scripts');
const bash = process.env.BASH_PATH ?? (process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git/bin/bash.exe') : 'bash');
const gatewayToken = 'offline-shell-gateway-secret-'.repeat(2);
const crawlerToken = 'offline-shell-crawler-secret-'.repeat(2);
const posix = value => value.replaceAll('\\', '/').replace(/^([a-z]):/i, (_, drive) => `/${drive.toLowerCase()}`);

async function fixture(t, { gatewayEnv, realGateway = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wag-shell-health-'));
  await Promise.all(['scripts', 'bin', 'secrets'].map(name => mkdir(path.join(root, name))));
  // Exercise the old script too during the initial red cycle.
  const source = (await readFile(path.join(scripts, 'healthcheck.sh'), 'utf8')).replace('ROOT=/data/web-access-gateway', `ROOT="${posix(root)}"`);
  await writeFile(path.join(root, 'scripts/healthcheck.sh'), source);
  await copyFile(path.join(scripts, 'healthcheck-diagnostics.py'), path.join(root, 'scripts/healthcheck-diagnostics.py')).catch(error => { if (error.code !== 'ENOENT') throw error; });
  await writeFile(path.join(root, 'secrets/gateway.env'), gatewayEnv ?? `GATEWAY_HOST=fixture.test\nGATEWAY_PORT=8930\nGATEWAY_TOKEN=${gatewayToken}\nCRAWL4AI_TOKEN=${crawlerToken}\nOTHER_API_KEY=offline-other-secret\n`);
  await writeFile(path.join(root, 'bin/systemctl'), `#!/usr/bin/env bash\nif [[ "$FIXTURE_MODE" == hang ]]; then exec sleep 30; fi\nif [[ "$1" == show ]]; then printf '0\\n'; fi\n`);
  await writeFile(path.join(root, 'bin/curl'), `#!/usr/bin/env bash
original=("$@")
output=''; writeout=false; url=''
while (($#)); do
  case "$1" in --output) output="$2"; shift;; --write-out) writeout=true; shift;; --max-time|-H|--proxy) shift;; http*) url="$1";; esac
  shift
done
if [[ "$FIXTURE_REAL_GATEWAY" == 1 && "$url" == *":$GATEWAY_PORT/"* ]]; then
  exec "$FIXTURE_REAL_CURL" --noproxy '*' "\${original[@]}"
fi
status=200
body='{"ok":true,"status":"ok"}'
case "$url" in
  */mcp) status=405; body='{}';;
  */readyz)
    body='{"ok":true,"core_ok":true,"public_connectivity_ok":true,"status":"passed","dependencies":[]}'
    case "$FIXTURE_MODE" in
      core) status=503; body='{"ok":false,"core_ok":false,"public_connectivity_ok":true,"status":"failed","dependencies":[{"name":"crawl4ai","scope":"core","ok":false,"error":{"kind":"crawler_uninitialized","message":"crawler starting"}}]}';;
      public) status=503; body='{"ok":false,"core_ok":true,"public_connectivity_ok":false,"status":"degraded","dependencies":[{"name":"searxng","scope":"public_connectivity","ok":false,"error":{"kind":"search_empty","message":"engine timeout"}}]}';;
      malformed) body='<html>invalid readiness</html>';;
    esac;;
  */search*) body='{"results":[{"url":"https://example.com/","title":"Example","content":"Example"}]}'
    if [[ "$FIXTURE_MODE" == empty ]]; then body='{"results":[],"unresponsive_engines":[["bing","timeout"]]}'; fi;;
esac
if [[ "$FIXTURE_MODE" == curl-timeout && "$url" == */healthz ]]; then
  printf 'curl: (28) timeout %s %s offline-other-secret https://user:password@engine.test/?token=unknown-token Authorization: Bearer unknown-header-secret\\n' "$GATEWAY_TOKEN" "$CRAWL4AI_TOKEN" >&2
  exit 28
fi
if [[ "$FIXTURE_MODE" == http-error && "$url" == */healthz ]]; then status=503; body='{"detail":"backend init failed","token":"unknown-json-secret","Authorization":"Basic unknown-basic-secret"}'; fi
if [[ "$FIXTURE_MODE" == curl-6 && "$url" == */healthz ]]; then printf 'curl: DNS resolution failed\\n' >&2; exit 6; fi
if [[ "$FIXTURE_MODE" == curl-60 && "$url" == */healthz ]]; then printf 'curl: TLS certificate verification failed\\n' >&2; exit 60; fi
if [[ -n "$output" ]]; then printf '%s' "$body" > "$output"; else printf '%s' "$body"; fi
if [[ "$writeout" == true ]]; then printf '%s' "$status"; fi
`);
  await writeFile(path.join(root, 'shell-env'), `export PATH="${posix(root)}/bin:$PATH"\n`);
  await Promise.all(['curl', 'systemctl'].map(name => chmod(path.join(root, 'bin', name), 0o755)));
  t.after(() => rm(root, { recursive: true, force: true }));
  return async (mode, args = [], extra = {}) => {
    const environment = { ...process.env };
    delete environment.MSYS_NO_PATHCONV;
    delete environment.MSYS2_ARG_CONV_EXCL;
    const child = spawn(bash, [...(extra.trace ? ['-x'] : []), posix(path.join(root, 'scripts/healthcheck.sh')), ...args], {
      env: { ...environment, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH}`, WAG_ROOT: posix(root), TMPDIR: posix(root), BASH_ENV: posix(path.join(root, 'shell-env')), FIXTURE_MODE: mode, FIXTURE_REAL_GATEWAY: realGateway ? '1' : '0', FIXTURE_REAL_CURL: process.platform === 'win32' ? posix(path.join(process.env.SystemRoot, 'System32/curl.exe')) : '/usr/bin/curl', WAG_HEALTHCHECK_TIMEOUT_SECONDS: extra.deadline ?? '45' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const guard = setTimeout(() => child.kill(), 12000);
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    clearTimeout(guard);
    assert.ok(!(await readdir(root)).some(name => name.startsWith('tmp.')), 'healthcheck removes captured diagnostic files on all terminal paths');
    return { ...result, stdout, stderr, lines: (stdout + stderr).split(/\r?\n/).filter(line => line.startsWith('{')).map(line => JSON.parse(line)) };
  };
}

test('shell probes the local bind independently of the default logical Host, including wildcards and overrides', async t => {
  const template = (await readFile(path.resolve(scripts, '../config/gateway.env.template'), 'utf8')).replaceAll('\r\n', '\n');
  for (const [bind, listenHost, override] of [
    ['127.0.0.1', '127.0.0.1'], ['0.0.0.0', '127.0.0.1'],
    ['::1', '::1'], ['::', '::1'], ['[::1]', '::1'],
    ['not-a-local-listener.fixture.test', '127.0.0.1', '127.0.0.1'],
  ]) {
    await t.test(`${bind}${override ? ' with explicit probe override' : ''}`, async t => {
      const seen = [];
      const server = http.createServer((req, res) => {
        seen.push({ path: req.url, host: req.headers.host });
        res.setHeader('content-type', 'application/json');
        if (req.headers.host !== `yosef-server:${server.address().port}`) { res.writeHead(403); res.end('{}'); return; }
        res.end(JSON.stringify({ ok: true, core_ok: true, public_connectivity_ok: true, dependencies: [] }));
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, listenHost, resolve); });
      t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
      const port = server.address().port;
      const gatewayEnv = template.replace(/^GATEWAY_PORT=.*$/m, `GATEWAY_PORT=${port}`)
        .replace(/^GATEWAY_BIND_HOST=.*$/m, `GATEWAY_BIND_HOST=${bind}`)
        .replace(/^GATEWAY_TOKEN=.*$/m, `GATEWAY_TOKEN=${gatewayToken}`) +
        (override ? `\nGATEWAY_HEALTHCHECK_HOST=${override}\n` : '\n');
      const run = await fixture(t, { gatewayEnv, realGateway: true });
      const result = await run('healthy', ['--core-only']);
      assert.equal(result.code, 0, JSON.stringify(result));
      assert.deepEqual(seen, [{ path: '/healthz', host: `yosef-server:${port}` }, { path: '/readyz', host: `yosef-server:${port}` }]);
    });
  }
});

test('shell core-only rejects an uninitialized crawler rather than merely live processes', async t => {
  const run = await fixture(t);
  const result = await run('core', ['--core-only']);
  assert.equal(result.code, 1, JSON.stringify(result));
  assert.ok(result.lines.some(line => JSON.stringify(line).includes('crawler_uninitialized')), JSON.stringify(result));
});

test('shell preserves healthy core versus degraded public deployment outcomes', async t => {
  const run = await fixture(t);
  assert.equal((await run('healthy', ['--core-only'])).code, 0);
  assert.equal((await run('healthy')).code, 0);
  const core = await run('public', ['--core-only']);
  assert.equal(core.code, 0, core.stderr);
  assert.equal(core.lines.find(line => line.layer === 'gateway-ready').public_connectivity_ok, false);
  const full = await run('public');
  assert.equal(full.code, 1);
  assert.equal(full.lines.find(line => line.layer === 'gateway-ready').error.kind, 'public_connectivity');
  const empty = await run('empty');
  assert.equal(empty.code, 1);
  assert.equal(empty.lines.find(line => line.layer === 'public-search').error.kind, 'search_empty');
  assert.deepEqual(empty.lines.find(line => line.layer === 'public-search').unresponsive_engines, [['bing', 'timeout']]);
});

test('shell preserves curl categories and redacts diagnostics even under inherited tracing', async t => {
  const run = await fixture(t);
  const result = await run('curl-timeout', ['--core-only'], { trace: true });
  assert.equal(result.code, 1);
  const gateway = result.lines.find(line => line.layer === 'gateway');
  assert.equal(gateway.exit_code, 28);
  assert.equal(gateway.error.kind, 'curl_timeout');
  assert.match(gateway.error.message, /timeout/);
  for (const secret of [gatewayToken, crawlerToken, 'offline-other-secret', 'user:password', 'unknown-token', 'unknown-header-secret']) assert.ok(!(result.stdout + result.stderr).includes(secret), secret);
  const backend = await run('http-error');
  const backendDiagnostic = backend.lines.find(line => line.layer === 'gateway');
  assert.equal(backendDiagnostic.http_status, 503);
  assert.equal(backendDiagnostic.error.kind, 'dependency_http_status');
  assert.match(backendDiagnostic.error.message, /backend init failed/);
  assert.ok(!(backend.stdout + backend.stderr).includes('unknown-json-secret'));
  assert.ok(!(backend.stdout + backend.stderr).includes('unknown-basic-secret'));
  for (const [mode, kind] of [['curl-6', 'curl_dns'], ['curl-60', 'curl_tls']]) {
    const response = await run(mode);
    assert.equal(response.lines.find(line => line.layer === 'gateway').error.kind, kind);
  }
});

test('shell fails safely on malformed readiness and bounds a hung command overall', async t => {
  const run = await fixture(t);
  const invalid = await run('malformed', ['--core-only']);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.lines.find(line => line.layer === 'gateway-ready').error.kind, 'dependency_invalid_data');
  const started = performance.now();
  const hung = await run('hang', ['--core-only'], { deadline: '2' });
  assert.equal(hung.code, 124, JSON.stringify(hung));
  assert.ok(performance.now() - started < 6000, 'healthcheck must exit itself, not rely on the external test guard');
  assert.equal(hung.lines.find(line => line.layer === 'healthcheck').error.kind, 'healthcheck_timeout');
});
