import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`gateway did not start: ${output}`)), 10000);
    const onExit = code => {
      clearTimeout(timer);
      reject(new Error(`gateway exited during startup (${code}): ${output}`));
    };
    child.once('exit', onExit);
    child.stderr.on('data', chunk => { output += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      if (!output.includes('web-access-gateway listening')) return;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve();
    });
  });
}

test('web_read preserves canonical evidence and final URLs through offline redirects', { timeout: 30000 }, async t => {
  const port = await unusedPort();
  const fixtureToken = 'offline-read-fixture-authorization-only';
  const child = spawn(process.execPath, [
    '--import', new URL('./fixtures/read-origin.mjs', import.meta.url).href,
    fileURLToPath(new URL('./server.mjs', import.meta.url)),
  ], {
    env: {
      ...process.env,
      GATEWAY_TOKEN: fixtureToken,
      CRAWL4AI_TOKEN: '',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_BIND_HOST: '127.0.0.1',
      GATEWAY_ALLOWED_HOSTS: '127.0.0.1',
      GATEWAY_PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill(); await exited; });
  await waitForListening(child);
  const client = new Client({ name: 'offline-read-fixture', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${fixtureToken}` } },
  }));

  const cases = [
    ['missing', null],
    ['attribute', null],
    ['empty', null],
    ['whitespace', null],
    ['malformed', null],
    ['scheme', null],
    ['relative', 'http://final.example.test/declared?edition=1'],
    ['absolute', 'https://canonical.example.test/declared'],
  ];
  for (const render of ['never', 'always']) {
    for (const [slug, canonicalUrl] of cases) {
      await t.test(`${render} read retains ${slug} publisher canonical evidence`, async () => {
        const result = await client.callTool({ name: 'web_read', arguments: {
          url: `http://reader.example.test/start/${slug}`, render, output: 'markdown',
        } });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const payload = result.structuredContent;
        assert.equal(payload.url, `http://final.example.test/articles/${slug}?tracking=1`);
        assert.equal(payload.source.url, payload.url);
        assert.equal(payload.source.host, 'final.example.test');
        assert.equal(payload.renderer, render === 'never' ? 'lightweight' : 'crawl4ai');
        assert.equal(Object.hasOwn(payload.source, 'canonical_url'), canonicalUrl !== null);
        if (canonicalUrl !== null) assert.equal(payload.source.canonical_url, canonicalUrl);
        assert.equal(JSON.stringify(result).includes('/undefined'), false);
        assert.equal(payload.published_at, null);
        assert.equal(payload.published_on, null);
        assert.equal(payload.temporal_evidence.some(item => item.kind === 'published_at'), false);
        assert.equal(payload.temporal_evidence.find(item => item.kind === 'response_date').value, '2026-09-28T00:00:00.000Z');
        assert.equal(payload.temporal_evidence.find(item => item.kind === 'retrieved_at').value, payload.retrieved_at);
        assert.equal(JSON.parse(result.content[0].text).source.canonical_url, canonicalUrl ?? undefined);
        assert.match(payload.markdown, /fixture article/);
        assert.doesNotMatch(payload.markdown, /WAG publisher/);
      });
    }
  }
});
