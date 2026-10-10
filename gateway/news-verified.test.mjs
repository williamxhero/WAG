import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregatePublisherEvidence,
  classifyEvidenceSource,
  classifyVerifiedWindow,
  evaluateResultEvidence,
  evaluateVerifiedStatus,
  feedItemEvidence,
  normalizeNewsMode,
  normalizeVerifiedParams,
  resolveNewsControls,
  resolveNewsWindow,
  sourceKindFromRaw,
  VERIFIED_DEFAULTS,
} from './news-verified.mjs';

// Dedicated tests for the SPEC #78 stage A offline core: news_mode normalisation, verified parameter
// bounds, window/timezone resolution (injected clock) and publisher/feed evidence classification.
// These are pure-function tests — nothing here reads a page, a feed or a search engine.
//
// Several assertions are the RED→GREEN gate for the stage: if the window check were dropped, or a
// discovery-only source (SearXNG / URL / HTTP Date / retrieved_at / GDELT) were allowed to fill
// `verified`, or the feed `updated`/`lastBuildDate` were treated as a publication date, the
// corresponding assertion below would fail.

const CLOCK = '2026-10-09T04:00:00.000Z'; // 2026-10-09 12:00 Asia/Kuala_Lumpur

test('news_mode normalises the boolean/union input and rejects unknown values', () => {
  assert.equal(normalizeNewsMode(undefined), 'off');
  assert.equal(normalizeNewsMode(null), 'off');
  assert.equal(normalizeNewsMode(false), 'off');
  assert.equal(normalizeNewsMode('off'), 'off');
  assert.equal(normalizeNewsMode(true), 'ranked');
  assert.equal(normalizeNewsMode('ranked'), 'ranked');
  assert.equal(normalizeNewsMode('verified'), 'verified');
  for (const bad of ['Verified', 'yes', 'on', 1, 0, {}, [], 'true']) {
    assert.throws(() => normalizeNewsMode(bad), error => error.kind === 'invalid_news_mode', `should reject ${JSON.stringify(bad)}`);
  }
});

test('verified params take the whitelisted defaults and reject out-of-range values', () => {
  assert.deepEqual(normalizeVerifiedParams({}), { ...VERIFIED_DEFAULTS });
  assert.deepEqual(normalizeVerifiedParams({ news_source: 'hybrid', news_window: 'calendar_today', news_min_sources: 4, news_max_reads: 0, news_render: 'auto' }), {
    news_source: 'hybrid', news_window: 'calendar_today', news_min_sources: 4, news_max_reads: 0, news_render: 'auto',
  });
  const invalid = [
    { news_source: 'rss' },
    { news_window: 'last_7d' },
    { news_min_sources: 0 },
    { news_min_sources: 5 },
    { news_min_sources: 2.5 },
    { news_max_reads: -1 },
    { news_max_reads: 9 },
    { news_render: 'always' },
  ];
  for (const input of invalid) {
    assert.throws(() => normalizeVerifiedParams(input), error => error.kind === 'invalid_news_param', `should reject ${JSON.stringify(input)}`);
  }
});

test('control resolution only validates params for verified and ignores them elsewhere', () => {
  assert.deepEqual(resolveNewsControls({}), { mode: 'off', params: null, ignored_controls: [] });
  const ranked = resolveNewsControls({ news_mode: true, news_window: 'calendar_today', news_min_sources: 3 });
  assert.equal(ranked.mode, 'ranked');
  assert.equal(ranked.params, null);
  assert.deepEqual(ranked.ignored_controls, ['news_window', 'news_min_sources']);
  const verified = resolveNewsControls({ news_mode: 'verified', news_source: 'feeds' });
  assert.equal(verified.mode, 'verified');
  assert.deepEqual(verified.ignored_controls, []);
  assert.equal(verified.params.news_source, 'feeds');
  assert.equal(verified.params.news_window, 'rolling_24h');
});

test('rolling_24h resolves on a UTC baseline from the injected clock', () => {
  const window = resolveNewsWindow({ window: 'rolling_24h', now: CLOCK });
  assert.equal(window.window, 'rolling_24h');
  assert.equal(window.window_timezone, 'UTC');
  assert.equal(window.evaluated_at, CLOCK);
  assert.equal(window.start, '2026-10-08T04:00:00.000Z');
  assert.equal(window.end, CLOCK);
  assert.equal(window.window_date, null);
});

test('calendar_today resolves the Asia/Kuala_Lumpur civil day from the injected clock', () => {
  const window = resolveNewsWindow({ window: 'calendar_today', now: CLOCK });
  assert.equal(window.window, 'calendar_today');
  assert.equal(window.window_timezone, 'Asia/Kuala_Lumpur');
  assert.equal(window.evaluated_at, CLOCK);
  // KL midnight 2026-10-09 == 2026-10-08T16:00:00Z (fixed +08:00, no DST).
  assert.equal(window.start, '2026-10-08T16:00:00.000Z');
  assert.equal(window.window_date, '2026-10-09');
});

test('raw evidence sources map to kinds and only page/feed-item kinds are eligible', () => {
  assert.equal(sourceKindFromRaw('html.meta[property="article:published_time"]'), 'page_publisher');
  assert.equal(sourceKindFromRaw('html.jsonld[0].datePublished'), 'page_publisher');
  assert.equal(sourceKindFromRaw('feed.item.published'), 'feed_item');
  assert.equal(sourceKindFromRaw('feed.item.pubDate'), 'feed_item');
  assert.equal(sourceKindFromRaw('feed.lastBuildDate'), 'feed_freshness');
  assert.equal(sourceKindFromRaw('feed.updated'), 'feed_freshness');
  assert.equal(sourceKindFromRaw('searxng.result.publishedDate'), 'searxng');
  assert.equal(sourceKindFromRaw('url.pattern'), 'url_pattern');
  assert.equal(sourceKindFromRaw('gateway.clock'), 'retrieved_at');
  assert.equal(sourceKindFromRaw('http.header.date'), 'http_date');
  assert.equal(sourceKindFromRaw('http.header.last-modified'), 'http_date');
  assert.equal(sourceKindFromRaw('gdelt.event'), 'gdelt');
  for (const eligible of ['page_publisher', 'feed_item']) {
    assert.equal(classifyEvidenceSource({ source_kind: eligible }).verified_eligible, true, eligible);
  }
  for (const kind of ['searxng', 'url_pattern', 'http_date', 'retrieved_at', 'gdelt', 'feed_freshness', 'none', 'unknown']) {
    assert.equal(classifyEvidenceSource({ source_kind: kind }).verified_eligible, false, kind);
  }
});

test('rolling_24h only verifies a publisher instant inside the window', () => {
  const window = resolveNewsWindow({ window: 'rolling_24h', now: CLOCK });
  const at = (value) => classifyVerifiedWindow({ source_kind: 'page_publisher', precision: 'instant', value }, window);
  assert.equal(at('2026-10-09T03:30:00.000Z'), 'verified');
  assert.equal(at('2026-10-08T04:00:00.000Z'), 'verified'); // exactly on the boundary
  assert.equal(at('2026-10-08T03:59:59.000Z'), 'stale');
  assert.equal(at('2026-10-10T00:00:00.000Z'), 'unknown'); // future / clock skew
  // Day precision, timezone-less and discovery sources never verify in a rolling window.
  assert.equal(classifyVerifiedWindow({ source_kind: 'page_publisher', precision: 'day', on: '2026-10-09' }, window), 'unknown');
  assert.equal(classifyVerifiedWindow({ source_kind: 'page_publisher', precision: 'unknown-timezone', on: '2026-10-09' }, window), 'unknown');
  assert.equal(classifyVerifiedWindow({ source_kind: 'feed_freshness', precision: 'instant', value: '2026-10-09T03:30:00.000Z' }, window), 'unknown');
});

test('calendar_today accepts a same-day instant or day but never fabricates one', () => {
  const window = resolveNewsWindow({ window: 'calendar_today', now: CLOCK });
  const ev = (record) => classifyVerifiedWindow({ source_kind: 'page_publisher', ...record }, window);
  assert.equal(ev({ precision: 'instant', value: '2026-10-09T03:30:00.000Z' }), 'verified');
  assert.equal(ev({ precision: 'instant', value: '2026-10-08T17:00:00.000Z' }), 'verified'); // 2026-10-09 01:00 KL
  assert.equal(ev({ precision: 'instant', value: '2026-10-08T15:00:00.000Z' }), 'stale'); // 2026-10-08 23:00 KL
  assert.equal(ev({ precision: 'day', on: '2026-10-09' }), 'verified');
  assert.equal(ev({ precision: 'day', on: '2026-10-08' }), 'stale');
  assert.equal(ev({ precision: 'day', on: '2026-10-10' }), 'unknown'); // future day
  assert.equal(ev({ precision: 'month', on: '2026-10' }), 'unknown');
  assert.equal(ev({ precision: 'unknown-timezone', on: '2026-10-09' }), 'unknown');
});

test('discovery-only sources can never produce a verified evidence record', () => {
  const window = resolveNewsWindow({ window: 'calendar_today', now: CLOCK });
  const negatives = [
    { source: 'searxng.result.publishedDate', precision: 'instant', value: '2026-10-09T03:30:00.000Z' },
    { source: 'url.pattern', precision: 'day', on: '2026-10-09' },
    { source: 'http.header.date', precision: 'instant', value: '2026-10-09T03:30:00.000Z' },
    { source: 'http.header.last-modified', precision: 'instant', value: '2026-10-09T03:30:00.000Z' },
    { source: 'gateway.clock', precision: 'instant', value: '2026-10-09T03:30:00.000Z' },
    { source: 'gdelt.event', precision: 'instant', value: '2026-10-09T03:30:00.000Z' },
    { source: 'page.today', precision: 'day', on: '2026-10-09' },
  ];
  for (const record of negatives) {
    const evidence = evaluateResultEvidence(record, window, { checked_at: CLOCK });
    assert.equal(evidence.status, 'unknown', JSON.stringify(record));
    assert.equal(evidence.verified_eligible, false, JSON.stringify(record));
    assert.equal(evidence.published_at, null, JSON.stringify(record));
  }
  // A page-declared field carrying relative text ("today") is unparseable and never verifies.
  const todayText = evaluateResultEvidence(
    { source: 'html.meta[property="article:published_time"]', precision: 'instant', value: 'today', evidence_url: 'https://news.example/story' },
    window,
    { checked_at: CLOCK },
  );
  assert.equal(todayText.status, 'unknown');
  // The one source that may: a page-declared instant on the window day.
  const positive = evaluateResultEvidence(
    { source: 'html.meta[property="article:published_time"]', precision: 'instant', value: '2026-10-09T03:30:00.000Z', evidence_url: 'https://news.example/story' },
    window,
    { checked_at: CLOCK },
  );
  assert.equal(positive.status, 'verified');
  assert.equal(positive.source_kind, 'page_publisher');
  assert.equal(positive.published_at, '2026-10-09T03:30:00.000Z');
});

test('page evidence aggregation ignores response Date, Last-Modified and retrieved_at', () => {
  const pageEvidence = {
    published_at: '2026-10-09T03:30:00.000Z',
    published_on: '2026-10-09',
    precision: 'instant',
    conflicts: [{ value: '2024-11-28T01:35:33.000Z', source: 'html.jsonld[0].datePublished' }],
    retrieved_at: '2026-10-09T04:00:00.000Z',
    source: { url: 'https://news.example/story', host: 'news.example' },
    temporal_evidence: [
      { kind: 'published_at', value: '2026-10-09T03:30:00.000Z', on: '2026-10-09', precision: 'instant', source: 'html.meta[property="article:published_time"]' },
      { kind: 'response_date', value: '2026-10-09T04:00:00.000Z', source: 'http.header.date' },
      { kind: 'retrieved_at', value: '2026-10-09T04:00:00.000Z', source: 'gateway.clock' },
    ],
  };
  const window = resolveNewsWindow({ window: 'rolling_24h', now: CLOCK });
  const aggregate = aggregatePublisherEvidence(pageEvidence);
  assert.equal(aggregate.source_kind, 'page_publisher');
  assert.equal(aggregate.source, 'html.meta[property="article:published_time"]');
  assert.equal(aggregate.conflict_count, 1);
  assert.equal(aggregate.evidence_url, 'https://news.example/story');
  const aggregateEvidence = evaluateResultEvidence(aggregate, window, { checked_at: CLOCK });
  assert.equal(aggregateEvidence.status, 'verified');
  assert.equal(aggregateEvidence.published_at, '2026-10-09T03:30:00.000Z');

  // A page that only carries HTTP Date / retrieved_at has no publisher evidence at all.
  const headerOnly = aggregatePublisherEvidence(
    {
      published_at: null,
      conflicts: [],
      source: { url: 'https://no-date.example/x', host: 'no-date.example' },
      temporal_evidence: [
        { kind: 'response_date', value: '2026-10-09T04:00:00.000Z', source: 'http.header.date' },
        { kind: 'retrieved_at', value: '2026-10-09T04:00:00.000Z', source: 'gateway.clock' },
      ],
    },
  );
  assert.equal(headerOnly.source_kind, 'none');
  const headerOnlyEvidence = evaluateResultEvidence(headerOnly, window, { checked_at: CLOCK });
  assert.equal(headerOnlyEvidence.status, 'unknown');
  assert.equal(headerOnlyEvidence.published_at, null);
});

test('feed item evidence uses Atom published and never the updated timestamp', () => {
  const window = resolveNewsWindow({ window: 'rolling_24h', now: CLOCK });
  const withPublished = evaluateResultEvidence(
    feedItemEvidence({ link: 'https://news.one.example/a', published: { value: '2026-10-09T03:30:00.000Z', on: '2026-10-09', precision: 'instant', source: 'feed.item.published' }, updated: { value: '2026-10-09T03:45:00.000Z', source: 'feed.item.updated' }, conflicts: 0 }),
    window,
    { checked_at: CLOCK },
  );
  assert.equal(withPublished.source_kind, 'feed_item');
  assert.equal(withPublished.published_at, '2026-10-09T03:30:00.000Z'); // published, not updated
  assert.equal(withPublished.status, 'verified');
  // An entry that only declares `updated` carries no publication evidence.
  const updatedOnly = evaluateResultEvidence(
    feedItemEvidence({ link: 'https://news.two.example/b', published: null, updated: { value: '2026-10-09T02:00:00.000Z', source: 'feed.item.updated' }, conflicts: 0 }),
    window,
  );
  assert.equal(updatedOnly.source_kind, 'none');
  assert.equal(updatedOnly.status, 'unknown');
});

test('verified status applies the two-part threshold without relaxing it', () => {
  const verifiedAt = url => ({ news_evidence: { status: 'verified', evidence_url: url } });
  const no = evaluateVerifiedStatus([], { min_sources: 2 });
  assert.deepEqual([no.status, no.candidate_count, no.verified_count, no.distinct_publishers], ['no_verified_result', 0, 0, 0]);
  assert.deepEqual([no.read_attempts, no.stale_count, no.unknown_count, no.read_failure_count, no.unread_count, no.irrelevant_count], [0, 0, 0, 0, 0, 0]);

  // Two verified articles from the SAME publisher do not satisfy a two-source threshold.
  const samePublisher = evaluateVerifiedStatus([verifiedAt('https://news.one.example/a'), verifiedAt('https://news.one.example/b')], { min_sources: 2 });
  assert.equal(samePublisher.verified_count, 2);
  assert.equal(samePublisher.distinct_publishers, 1);
  assert.equal(samePublisher.status, 'partial');

  // www. is normalised into the same publisher identity.
  const www = evaluateVerifiedStatus([verifiedAt('https://news.one.example/a'), verifiedAt('https://www.news.one.example/b')], { min_sources: 2 });
  assert.equal(www.distinct_publishers, 1);
  assert.equal(www.status, 'partial');

  const twoPublishers = evaluateVerifiedStatus([verifiedAt('https://news.one.example/a'), verifiedAt('https://news.two.example/b')], { min_sources: 2 });
  assert.equal(twoPublishers.status, 'verified');

  // A mix of stale/unknown never reaches verified and is counted, not hidden.
  const mixed = evaluateVerifiedStatus([
    verifiedAt('https://news.one.example/a'),
    { news_evidence: { status: 'stale', evidence_url: 'https://news.two.example/b' } },
    { news_evidence: { status: 'unknown', evidence_url: 'https://news.three.example/c' } },
  ], { min_sources: 2 });
  assert.equal(mixed.status, 'partial');
  assert.equal(mixed.verified_count, 1);
  assert.equal(mixed.stale_count, 1);
  assert.equal(mixed.unknown_count, 1);
  assert.equal(mixed.read_failure_count, 0);
  assert.equal(mixed.unread_count, 0);

  // min_sources is never relaxed to fit the result set.
  const strict = evaluateVerifiedStatus([verifiedAt('https://news.one.example/a'), verifiedAt('https://news.two.example/b')], { min_sources: 4 });
  assert.equal(strict.status, 'partial');
  assert.equal(strict.min_sources, 4);
});

test('verified status keeps recall accounting separate from the verdict counts', () => {
  // 20 recalled candidates, 6 of them read, 4 of the read pages verified or stale, 2 failed to read:
  // candidate_count is the full recall set, read_attempts the reads actually issued, and the 14
  // candidates the budget never reached stay `unread` instead of being judged as date-less pages.
  const read = status => ({ news_evidence: { status, evidence_url: `https://news.${status}.example/a` } });
  const accounting = evaluateVerifiedStatus(
    [read('verified'), read('verified'), read('stale'), read('unknown'), read('read_failure'), read('read_failure')],
    { min_sources: 2, candidate_count: 20, read_attempts: 6, unread_count: 14 },
  );
  assert.equal(accounting.candidate_count, 20);
  assert.equal(accounting.read_attempts, 6);
  assert.equal(accounting.verified_count, 2);
  assert.equal(accounting.stale_count, 1);
  assert.equal(accounting.unknown_count, 1);
  assert.equal(accounting.read_failure_count, 2);
  assert.equal(accounting.unread_count, 14);
  // Every candidate is accounted for exactly once: the read budget plus the unread tail is the full
  // recall set, and the per-page verdicts add up to the reads that were issued.
  const verdicts = accounting.verified_count + accounting.stale_count + accounting.unknown_count
    + accounting.read_failure_count + accounting.irrelevant_count;
  assert.equal(verdicts, accounting.read_attempts);
  assert.equal(accounting.read_attempts + accounting.unread_count, accounting.candidate_count);

  // A candidate the caller reports as `unread` inside the evaluated list still counts, and a
  // candidate count that does not even cover the evaluated list is never trusted over it.
  const unreadInside = evaluateVerifiedStatus([read('unread'), read('verified')], { candidate_count: 1, read_attempts: 2, unread_count: 3 });
  assert.equal(unreadInside.candidate_count, 2);
  assert.equal(unreadInside.unread_count, 4);
});
