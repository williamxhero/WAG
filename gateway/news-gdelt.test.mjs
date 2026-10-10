import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGdeltUrl,
  discoverGdeltCandidates,
  gdeltSeenInstant,
  gdeltTimespan,
  GDELT_LIMITS,
  GDELT_ORIGIN,
  GDELT_PATH,
  parseGdeltResponse,
  preselectGdeltCandidates,
} from './news-gdelt.mjs';
import { evaluateResultEvidence, resolveNewsWindow, sourceKindFromRaw } from './news-verified.mjs';

// Dedicated tests for the SPEC #78 stage D fixed-origin GDELT discovery. Every case runs against
// fixed in-file fixtures and a mock transport — nothing here touches the network by default. The
// RED→GREEN gate is the fixed-request contract: if a caller could inject an endpoint/host or an extra
// request parameter, or if a GDELT `seendate` could be promoted to publication evidence, an assertion
// below would fail.
//
// A single low-frequency, read-only live sample runs only when WAG_GDELT_LIVE=1 is set explicitly.

const WINDOW_NOW = '2026-10-10T02:00:00.000Z';
const WINDOW = { start: '2026-10-09T02:00:00.000Z', end: WINDOW_NOW, window: 'rolling_24h', window_timezone: 'UTC' };
const FRESH = '2026-10-10T01:00:00.000Z';

// GDELT DOC 2.0 shape: an `articles` array of `{ url, title, seendate, domain }`.
const GDELT_BODY = JSON.stringify({
  articles: [
    { url: 'https://news.one.example/story-a', title: 'Story A', seendate: '20261010T010000Z', domain: 'news.one.example' },
    { url: 'https://news.two.example/story-b', title: 'Story B', seendate: '20261010T013000Z', domain: 'news.two.example' },
    // Duplicate URL (must be collapsed) and a non-HTTP entry (must be dropped, never echoed).
    { url: 'https://news.one.example/story-a', title: 'Story A dup', seendate: '20261010T010000Z', domain: 'news.one.example' },
    { url: 'javascript:alert(1)', title: 'nope', seendate: '20261010T010000Z', domain: 'evil.example' },
    { url: 'ftp://files.example/x', title: 'nope', seendate: '20261010T010000Z', domain: 'files.example' },
    // Dated before the window start: preselected away, never read.
    { url: 'https://old.example/story-z', title: 'Old', seendate: '20260901T000000Z', domain: 'old.example' },
  ],
});

function mockTransport(response) {
  const calls = [];
  const transport = async (url, options) => {
    calls.push({ url, signal: options?.signal });
    if (response instanceof Error) throw response;
    return response;
  };
  transport.calls = calls;
  return transport;
}

test('the GDELT request target is fixed: origin, path and parameters cannot be injected by the caller', () => {
  const url = buildGdeltUrl({ query: 'openai funding', maxRecords: 10, timespan: '24h' });
  const parsed = new URL(url);
  assert.equal(parsed.origin, GDELT_ORIGIN);
  assert.equal(parsed.pathname, GDELT_PATH);
  assert.equal(parsed.searchParams.get('mode'), 'artlist');
  assert.equal(parsed.searchParams.get('format'), 'json');
  assert.equal(parsed.searchParams.get('sort'), 'datedesc');
  assert.equal(parsed.searchParams.get('maxrecords'), '10');
  assert.equal(parsed.searchParams.get('timespan'), '24h');
  assert.equal(parsed.searchParams.get('query'), 'openai funding');

  // A query that tries to smuggle extra request parameters stays a single, percent-encoded value.
  const injected = new URL(buildGdeltUrl({ query: 'a&mode=event&format=xml', maxRecords: 5 }));
  assert.equal(injected.searchParams.get('mode'), 'artlist', 'mode cannot be overridden');
  assert.equal(injected.searchParams.get('format'), 'json');
  assert.equal(injected.searchParams.get('query'), 'a&mode=event&format=xml');

  // No argument can point the request elsewhere.
  assert.equal(buildGdeltUrl({ query: 'x', endpoint: 'https://evil.example/', host: 'evil.example', mode: 'event' }).startsWith(`${GDELT_ORIGIN}${GDELT_PATH}?`), true);
  // maxRecords is bounded and defaults.
  assert.equal(new URL(buildGdeltUrl({ query: 'x', maxRecords: 99999 })).searchParams.get('maxrecords'), String(GDELT_LIMITS.maxRecordsCap));
  assert.equal(new URL(buildGdeltUrl({ query: 'x' })).searchParams.get('maxrecords'), String(GDELT_LIMITS.defaultMaxRecords));
  // An invalid timespan hint is dropped, not forwarded.
  assert.equal(new URL(buildGdeltUrl({ query: 'x', timespan: 'forever' })).searchParams.has('timespan'), false);
  // An overlong query is hard-truncated, never forwarded unbounded.
  assert.equal(new URL(buildGdeltUrl({ query: 'a'.repeat(500) })).searchParams.get('query').length, GDELT_LIMITS.maxQueryChars);
});

test('GDELT seendate converts to a discovery instant only', () => {
  assert.equal(gdeltSeenInstant('20261010T013000Z'), '2026-10-10T01:30:00.000Z');
  assert.equal(gdeltSeenInstant('20261010T013000'), '2026-10-10T01:30:00.000Z');
  assert.equal(gdeltSeenInstant('not-a-date'), null);
  assert.equal(gdeltSeenInstant(''), null);
  // The source label is discovery-only: it can never be a verified evidence source.
  assert.equal(sourceKindFromRaw('gdelt.seendate'), 'gdelt');
});

test('the window is translated into a GDELT preselection timespan hint', () => {
  assert.equal(gdeltTimespan({ start: '2026-10-09T02:00:00.000Z', end: WINDOW_NOW }), '24h');
  assert.equal(gdeltTimespan({ start: '2026-10-08T16:00:00.000Z', end: WINDOW_NOW }), '34h');
  // A long span switches to whole days once it exceeds a week.
  assert.equal(gdeltTimespan({ start: '2026-09-01T00:00:00.000Z', end: '2026-10-10T02:00:00.000Z' }), '40d');
  assert.equal(gdeltTimespan({ start: WINDOW_NOW, end: WINDOW_NOW }), null);
  assert.equal(gdeltTimespan(null), null);
});

test('the response parser keeps only HTTP article URLs, collapses duplicates and dates them', () => {
  const parsed = parseGdeltResponse(GDELT_BODY);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.candidates.length, 3, 'the duplicate and both non-HTTP entries are dropped');
  assert.deepEqual(parsed.candidates.map(candidate => candidate.url).sort(), [
    'https://news.one.example/story-a',
    'https://news.two.example/story-b',
    'https://old.example/story-z',
  ]);
  const first = parsed.candidates.find(candidate => candidate.url === 'https://news.one.example/story-a');
  assert.equal(first.title, 'Story A');
  assert.equal(first.domain, 'news.one.example');
  assert.equal(first.seen_at, '2026-10-10T01:00:00.000Z');
  assert.equal(first.seen_on, '2026-10-10');

  assert.equal(parseGdeltResponse('not json').code, 'invalid_response');
  assert.equal(parseGdeltResponse('').code, 'invalid_response');
  assert.equal(parseGdeltResponse(JSON.stringify({ articles: 'nope' })).code, 'invalid_response');
  assert.equal(parseGdeltResponse(Buffer.from('x'.repeat(GDELT_LIMITS.maxBytes + 1))).code, 'payload_limit');
  // Missing `articles` is an empty result, not a failure (GDELT returns that for no matches).
  assert.deepEqual(parseGdeltResponse(JSON.stringify({})).candidates, []);
});

test('preselection drops candidates GDELT dated before the window and orders the rest newest-first', () => {
  const parsed = parseGdeltResponse(GDELT_BODY);
  const selected = preselectGdeltCandidates(parsed.candidates, WINDOW);
  assert.deepEqual(selected.map(candidate => candidate.url), [
    'https://news.two.example/story-b',
    'https://news.one.example/story-a',
  ], 'the pre-window candidate is removed and the rest are newest-first');
  // A candidate with no parseable seendate is kept (no proof it is old).
  const undated = preselectGdeltCandidates([{ url: 'https://x.example/a', seen_at: null }], WINDOW);
  assert.equal(undated.length, 1);
});

test('discovery returns candidates through a mock transport and never performs its own I/O', async () => {
  const transport = mockTransport({ status: 200, body: GDELT_BODY });
  const result = await discoverGdeltCandidates({ query: 'story', maxRecords: 10, window: WINDOW, transport });
  assert.equal(result.ok, true);
  assert.equal(transport.calls.length, 1);
  assert.equal(transport.calls[0].url.startsWith(`${GDELT_ORIGIN}${GDELT_PATH}?`), true);
  assert.ok(transport.calls[0].signal instanceof AbortSignal, 'a bounded deadline signal is always supplied');
  assert.deepEqual(result.candidates.map(candidate => candidate.url), [
    'https://news.two.example/story-b',
    'https://news.one.example/story-a',
  ]);
});

test('every external failure becomes one classified source_failure instead of a candidate', async () => {
  const cases = [
    [mockTransport(Object.assign(new Error('dns'), { kind: 'dns_error' })), 'dns_failed'],
    [mockTransport(Object.assign(new Error('blocked'), { kind: 'ssrf_blocked' })), 'ssrf_blocked'],
    [mockTransport(Object.assign(new Error('slow'), { name: 'AbortError' })), 'timeout'],
    [mockTransport({ status: 503, body: 'busy' }), 'http_error'],
    [mockTransport({ status: 429, body: 'slow down' }), 'rate_limited'],
    // The gateway transport throws on a non-2xx status rather than returning it: the rate-limit
    // distinction has to survive that shape too.
    [mockTransport(Object.assign(new Error('429'), { kind: 'upstream_http_status', httpStatus: 429 })), 'rate_limited'],
    [mockTransport(Object.assign(new Error('403'), { kind: 'upstream_http_status', httpStatus: 403 })), 'http_error'],
    [mockTransport({ status: 200, body: 'not json' }), 'invalid_response'],
  ];
  for (const [transport, code] of cases) {
    const result = await discoverGdeltCandidates({ query: 'story', window: WINDOW, transport });
    assert.equal(result.ok, false, code);
    assert.equal(result.candidates, undefined);
    assert.deepEqual(result.source_failure, { source: 'gdelt', code, retryable: false });
    assert.equal(Object.hasOwn(result.source_failure, 'message'), false, 'no upstream message is echoed');
  }
  // No transport and an empty query are refused rather than attempted.
  assert.equal((await discoverGdeltCandidates({ query: 'story' })).source_failure.code, 'gdelt_unavailable');
  assert.equal((await discoverGdeltCandidates({ query: '   ', transport: mockTransport({ status: 200, body: GDELT_BODY }) })).source_failure.code, 'invalid_query');
});

test('a GDELT candidate date is discovery-only and can never produce a verified evidence record', () => {
  const window = resolveNewsWindow({ window: 'rolling_24h', now: WINDOW_NOW });
  // A candidate whose only temporal hint is the GDELT seendate resolves to `unknown`, so it never
  // enters a verified result set on the strength of GDELT time alone.
  const evidence = evaluateResultEvidence(
    { source_kind: 'gdelt', source: 'gdelt.seendate', precision: 'instant', value: FRESH, evidence_url: 'https://news.one.example/story-a' },
    window,
    { checked_at: WINDOW_NOW },
  );
  assert.equal(evidence.status, 'unknown');
  assert.equal(evidence.published_at, null);
});

test('live read-only GDELT sample (opt-in via WAG_GDELT_LIVE=1)', { skip: process.env.WAG_GDELT_LIVE !== '1' }, async () => {
  const result = await discoverGdeltCandidates({
    query: 'openai',
    maxRecords: 5,
    // A live sample gets much more headroom than the in-band default (GDELT can take tens of
    // seconds); the gateway's own call keeps the tighter deadline.
    timeoutMs: 30000,
    transport: async (url, { signal }) => {
      // A browser-like UA matches the gateway's own read headers; GDELT throttles unknown clients.
      const response = await fetch(url, { signal, headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' } });
      return { status: response.status, body: await response.text() };
    },
  });

  if (result.ok) {
    // A live success parses real GDELT articles into discovery candidates.
    for (const candidate of result.candidates) {
      assert.match(candidate.url, /^https?:\/\//);
      assert.equal(typeof candidate.domain, 'string');
    }
    return;
  }
  // GDELT enforces "one request every 5 seconds" and is often slow; an outage must surface as one
  // classified `source_failure`, never as a fabricated candidate. This is the real external boundary
  // the module promises, and it is exactly why an opt-in live probe cannot hard-require a 200.
  assert.equal(result.source_failure.source, 'gdelt');
  assert.ok(
    ['timeout', 'rate_limited', 'http_error', 'dns_failed', 'redirect_blocked', 'ssrf_blocked', 'payload_limit', 'invalid_response', 'gdelt_unavailable'].includes(result.source_failure.code),
    `unexpected live failure code: ${JSON.stringify(result.source_failure)}`,
  );
});
