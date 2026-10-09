import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildCandidateReadRecord, buildSearchEvidenceRecord, checkUtf8Echo, PROBE_READ_HARD_CAP, selectCandidateReads, summarizeProbe } from './search-quality-probe.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

test('checkUtf8Echo detects mangled CJK query echoes', () => {
  assert.equal(checkUtf8Echo('全球 市场 最新 新闻', '全球 市场 最新 新闻'), true);
  assert.equal(checkUtf8Echo('全球 市场 最新 新闻', 'å…¨çƒ å¸‚åœº'), false);
  assert.equal(checkUtf8Echo('x', undefined), false);
  assert.equal(checkUtf8Echo(null, 'x'), false);
});

test('buildSearchEvidenceRecord preserves full temporal evidence, not only published_at', () => {
  const params = { query: '全球 市场 最新 新闻', language: 'zh-CN', time_range: 'day', time_window_strict: true };
  const record = buildSearchEvidenceRecord({
    traceId: 'trace-1',
    params,
    response: {
      trace_id: 'trace-1',
      query: '全球 市场 最新 新闻',
      number_of_results: 2,
      time_range: 'day',
      time_range_applied: true,
      time_range_enforced: false,
      time_range_note: 'note',
      time_window_strict: true,
      filtered_out: 1,
      filtered_reasons: { http_error_page: 1 },
      results: [
        {
          title: 'News', url: 'https://example.org/a', engine: 'quark', category: 'news',
          published_at: '2026-10-08T05:58:00.000Z', published_on: '2026-10-08', precision: 'instant',
          retrieved_at: '2026-10-09T00:00:01.000Z', time_range_status: 'within',
          source: { url: 'https://example.org/a', host: 'example.org', search_engine: 'quark' },
          temporal_evidence: [{ kind: 'published_at', value: '2026-10-08T05:58:00.000Z', on: '2026-10-08', precision: 'instant', source: 'searxng.result.publishedDate' }],
        },
        { title: 'Undated', url: 'https://example.org/b', engine: 'yandex', published_at: null, published_on: null, temporal_evidence: [{ kind: 'retrieved_at', value: '2026-10-09T00:00:01.000Z', source: 'gateway.clock' }] },
      ],
    },
  });
  assert.equal(record.trace_id, 'trace-1');
  assert.deepEqual(record.params, params);
  assert.equal(record.query_echo_ok, true);
  assert.equal(record.time_window_strict, true);
  assert.equal(record.results[0].engine, 'quark');
  assert.equal(record.results[0].published_on, '2026-10-08');
  assert.equal(record.results[0].time_range_status, 'within');
  assert.equal(record.results[0].temporal_evidence[0].source, 'searxng.result.publishedDate');
  assert.equal(record.results[1].engine, 'yandex');
  assert.equal(record.results[1].temporal_evidence[0].source, 'gateway.clock');
});

test('summarizeProbe counts complete denominators and echo mismatches', () => {
  const searches = [
    { query_echo_ok: true, results: [
      { temporal_evidence: [{ kind: 'published_at', value: '2026-10-08T00:00:00.000Z' }], published_on: '2026-10-08', time_range_status: 'within' },
      { temporal_evidence: [{ kind: 'retrieved_at', value: '2026-10-09T00:00:00.000Z' }], published_on: null, time_range_status: 'unverified' },
    ] },
    { query_echo_ok: false, results: [{ temporal_evidence: [], published_on: '2020-01-01', time_range_status: 'outside' }] },
  ];
  const summary = summarizeProbe(searches, []);
  assert.equal(summary.searches, 2);
  assert.equal(summary.results_total, 3);
  assert.equal(summary.results_with_publisher_instant, 1);
  assert.equal(summary.results_with_published_on, 2);
  assert.equal(summary.results_time_range_within, 1);
  assert.equal(summary.results_time_range_outside, 1);
  assert.equal(summary.results_time_range_unverified, 1);
  assert.equal(summary.query_echo_mismatches, 1);
});

test('the probe refuses to run without a gateway token', async () => {
  const child = spawn(process.execPath, [path.join(moduleDir, 'search-quality-probe.mjs')], {
    env: { ...process.env, GATEWAY_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.notEqual(code, 0, 'the probe must exit non-zero without a token');
  assert.match(stderr, /GATEWAY_TOKEN is required/);
});

test('selectCandidateReads bounds the budget, dedupes and keeps the full denominator', () => {
  const candidates = [
    { url: 'https://a/', label: 'relevant' },
    { url: 'https://b/', label: 'relevant' },
    { url: 'https://c/', label: 'negative' },
    { url: 'ftp://d/', label: 'relevant' },
    { url: 'https://a/', label: 'relevant' },
  ];
  const { budget, planned, toRead, unread } = selectCandidateReads(candidates, 2);
  assert.equal(budget, 2);
  assert.equal(planned, 2);
  assert.deepEqual(toRead.map(c => c.url), ['https://a/', 'https://b/']);
  assert.deepEqual(unread.map(c => c.url), ['https://c/', 'ftp://d/', 'https://a/']);
});

test('selectCandidateReads never exceeds the hard cap and reads nothing at a zero budget', () => {
  const many = Array.from({ length: 30 }, (_, index) => ({ url: `https://host/${index}`, label: 'relevant' }));
  assert.equal(selectCandidateReads(many, 999).planned, PROBE_READ_HARD_CAP);
  const none = selectCandidateReads(many, 0);
  assert.equal(none.planned, 0);
  assert.equal(none.unread.length, many.length);
});

test('buildCandidateReadRecord preserves the complete raw payload and never promotes a failure', () => {
  const response = {
    trace_id: 'trace-read',
    url: 'https://a/',
    published_at: '2026-10-08T00:00:00.000Z',
    published_on: '2026-10-08',
    precision: 'instant',
    retrieved_at: '2026-10-09T00:00:00.000Z',
    temporal_evidence: [{ kind: 'published_at', value: '2026-10-08T00:00:00.000Z', source: 'html.meta[x]' }],
    markdown: 'article body',
  };
  const ok = buildCandidateReadRecord({ candidate: { url: 'https://a/', label: 'relevant' }, url: 'https://a/', response });
  assert.equal(ok.read_status, 'read_ok');
  assert.equal(ok.ok, true);
  assert.equal(ok.precision, 'instant');
  assert.equal(ok.raw.markdown, 'article body', 'the full raw MCP payload must be preserved');
  const failed = buildCandidateReadRecord({ candidate: { url: 'https://b/' }, url: 'https://b/', error: new Error('web_read timed out after 20000ms') });
  assert.equal(failed.read_status, 'read_failure');
  assert.equal(failed.ok, false);
  assert.match(failed.error, /timed out/);
  assert.equal(failed.raw, undefined);
});

test('the shipped candidate fixture parses and pins a labelled recent source sample', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(moduleDir, 'fixtures', 'search-quality-candidates.json'), 'utf8'));
  assert.ok(Array.isArray(fixture.candidates) && fixture.candidates.length >= 5);
  assert.ok(fixture.candidates.every(c => /^https?:\/\//.test(c.url) && ['relevant', 'negative'].includes(c.label)));
  assert.ok(fixture.candidates.some(c => c.url.includes('theguardian.com') && /recent source sample/i.test(c.note)));
});

test('the probe still refuses to run without a token even in candidate mode', async () => {
  const child = spawn(process.execPath, [path.join(moduleDir, 'search-quality-probe.mjs')], {
    env: { ...process.env, GATEWAY_TOKEN: '', PROBE_CANDIDATES: path.join(moduleDir, 'fixtures', 'search-quality-candidates.json') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise(resolve => child.once('exit', resolve));
  assert.notEqual(code, 0);
  assert.match(stderr, /GATEWAY_TOKEN is required/);
});
