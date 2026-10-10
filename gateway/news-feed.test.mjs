import assert from 'node:assert/strict';
import test from 'node:test';
import { FEED_LIMITS, parseFeedDate, parseNewsFeed } from './news-feed.mjs';
import { evaluateResultEvidence, feedItemEvidence, resolveNewsWindow } from './news-verified.mjs';

// Dedicated tests for the SPEC #78 stage A offline RSS/Atom parser. Fixed, in-file XML fixtures keep
// the suite self-contained and deterministic (no disk fixtures, no network).
//
// RED→GREEN gate: if the parser treated the Atom `updated` timestamp or the RSS channel
// `lastBuildDate` as an item publication date, the `published`/`updated` and `pubDate`/`lastBuildDate`
// separation assertions below would fail; if it accepted a DTD, the `unsafe_xml` assertion would fail.

const ATOM_FEED = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom</title>
  <updated>2026-10-09T05:00:00Z</updated>
  <entry>
    <title>Published story</title>
    <link rel="alternate" href="https://news.one.example/story"/>
    <published>2026-10-09T03:30:00Z</published>
    <updated>2026-10-09T03:45:00Z</updated>
  </entry>
  <entry>
    <title>Updated only</title>
    <link href="https://news.two.example/update"/>
    <updated>2026-10-09T02:00:00Z</updated>
  </entry>
</feed>`;

const RSS_FEED = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>Example RSS</title>
    <link>https://rss.example/</link>
    <lastBuildDate>Fri, 09 Oct 2026 06:00:00 GMT</lastBuildDate>
    <item>
      <title>RSS story</title>
      <link>https://rss.one.example/a</link>
      <pubDate>Fri, 09 Oct 2026 03:30:00 GMT</pubDate>
    </item>
    <item>
      <title>No date</title>
      <link>https://rss.two.example/b</link>
    </item>
  </channel>
</rss>`;

const RDF_FEED = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel><title>RDF feed</title></channel>
  <item rdf:about="https://rdf.one.example/a">
    <title>RDF story</title>
    <dc:date>2026-10-09T03:30:00Z</dc:date>
  </item>
</rdf:RDF>`;

test('Atom published and updated stay separate fields; feed updated is diagnostic', () => {
  const feed = parseNewsFeed(ATOM_FEED);
  assert.equal(feed.ok, true);
  assert.equal(feed.format, 'atom');
  assert.equal(feed.feed.updated.value, '2026-10-09T05:00:00.000Z');
  assert.equal(feed.feed.updated.diagnostic, true);
  assert.equal(feed.feed.last_build, null);
  assert.equal(feed.items.length, 2);

  const [first, second] = feed.items;
  assert.equal(first.published.value, '2026-10-09T03:30:00.000Z');
  assert.equal(first.published.source, 'feed.item.published');
  assert.equal(first.updated.value, '2026-10-09T03:45:00.000Z');
  assert.equal(first.updated.source, 'feed.item.updated');
  assert.notEqual(first.published.value, first.updated.value);
  assert.equal(first.link, 'https://news.one.example/story');
  assert.equal(first.date_missing, false);

  assert.equal(second.published, null); // `updated` alone is not a publication date
  assert.equal(second.date_missing, true);
});

test('RSS item pubDate is publication evidence and lastBuildDate stays feed-level', () => {
  const feed = parseNewsFeed(RSS_FEED);
  assert.equal(feed.ok, true);
  assert.equal(feed.format, 'rss');
  assert.equal(feed.feed.last_build.value, '2026-10-09T06:00:00.000Z');
  assert.equal(feed.feed.last_build.source, 'feed.lastBuildDate');
  assert.equal(feed.feed.last_build.diagnostic, true);

  const [first, second] = feed.items;
  assert.equal(first.published.value, '2026-10-09T03:30:00.000Z');
  assert.equal(first.published.source, 'feed.item.pubDate');
  assert.notEqual(first.published.value, feed.feed.last_build.value); // never conflated
  assert.equal(first.link, 'https://rss.one.example/a');
  assert.equal(second.date_missing, true);
  assert.equal(second.published, null);
});

test('RSS 1.0 (RDF) items read dc:date as the publication field', () => {
  const feed = parseNewsFeed(RDF_FEED);
  assert.equal(feed.ok, true);
  assert.equal(feed.format, 'rss');
  assert.equal(feed.items[0].published.value, '2026-10-09T03:30:00.000Z');
  assert.equal(feed.items[0].published.source, 'feed.item.date');
  assert.equal(feed.items[0].link, 'https://rdf.one.example/a');
});

test('feed date parsing keeps precision and never invents a UTC instant', () => {
  assert.deepEqual(parseFeedDate('Fri, 09 Oct 2026 03:30:00 GMT'), { value: '2026-10-09T03:30:00.000Z', on: '2026-10-09', precision: 'instant' });
  assert.deepEqual(parseFeedDate('2026-10-09T11:30:00+08:00'), { value: '2026-10-09T03:30:00.000Z', on: '2026-10-09', precision: 'instant' });
  assert.deepEqual(parseFeedDate('2026-10-09'), { value: null, on: '2026-10-09', precision: 'day' });
  assert.deepEqual(parseFeedDate('2026-10'), { value: null, on: '2026-10', precision: 'month' });
  assert.deepEqual(parseFeedDate('2026-10-09 03:30:00'), { value: null, on: '2026-10-09', precision: 'unknown-timezone' });
  assert.deepEqual(parseFeedDate('Fri, 09 Oct 2026 03:30:00'), { value: null, on: '2026-10-09', precision: 'unknown-timezone' });
  assert.equal(parseFeedDate('today'), null);
  assert.equal(parseFeedDate(''), null);
});

test('a timezone-less or day-only RSS date can never verify a rolling window', () => {
  const feed = parseNewsFeed(`<?xml version="1.0"?><rss version="2.0"><channel><item><title>a</title><pubDate>2026-10-09 03:30:00</pubDate></item><item><title>b</title><pubDate>2026-10-09</pubDate></item></channel></rss>`);
  assert.equal(feed.items[0].published.precision, 'unknown-timezone');
  assert.equal(feed.items[0].published.value, null);
  const window = resolveNewsWindow({ window: 'rolling_24h', now: '2026-10-09T04:00:00.000Z' });
  assert.equal(evaluateResultEvidence(feedItemEvidence(feed.items[0]), window).status, 'unknown');
  assert.equal(evaluateResultEvidence(feedItemEvidence(feed.items[1]), window).status, 'unknown');
});

test('conflicting duplicate dates are recorded, not last-write-wins', () => {
  const feed = parseNewsFeed(`<?xml version="1.0"?><rss version="2.0"><channel><item><title>c</title><pubDate>Fri, 09 Oct 2026 03:30:00 GMT</pubDate><pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate></item></channel></rss>`);
  assert.equal(feed.items[0].conflicts, 1);
  assert.equal(feed.items[0].published.value, '2026-10-09T03:30:00.000Z'); // primary, not the last duplicate
});

test('the parser bounds size, nesting, element count and item count', () => {
  assert.equal(parseNewsFeed('').error, 'empty');
  assert.equal(parseNewsFeed(RSS_FEED, { maxBytes: 16 }).error, 'feed_too_large');
  assert.equal(parseNewsFeed('<?xml version="1.0"?><!DOCTYPE rss SYSTEM "http://evil.example/x.dtd"><rss/>').error, 'unsafe_xml');
  assert.equal(parseNewsFeed('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x "y">]><r>&x;</r>').error, 'unsafe_xml');
  assert.equal(parseNewsFeed('<rss><channel><item></channel></rss>').error, 'malformed_xml');
  assert.equal(parseNewsFeed('<html><body>not a feed</body></html>').error, 'unsupported_feed');
  assert.equal(parseNewsFeed(RSS_FEED, { maxDepth: 3 }).error, 'too_deep');
  assert.equal(parseNewsFeed(RSS_FEED, { maxElements: 4 }).error, 'too_many_elements');

  const many = `<?xml version="1.0"?><rss version="2.0"><channel>${Array.from({ length: 3 }, (_, i) => `<item><title>${i}</title><pubDate>Fri, 09 Oct 2026 03:30:00 GMT</pubDate></item>`).join('')}</channel></rss>`;
  const bounded = parseNewsFeed(many, { maxItems: 2 });
  assert.equal(bounded.ok, true);
  assert.equal(bounded.limited, true);
  assert.equal(bounded.items.length, 2);
  assert.equal(FEED_LIMITS.maxItems, 100);
});

test('a bounded feed pipeline verifies only item-level publisher dates', () => {
  const window = resolveNewsWindow({ window: 'calendar_today', now: '2026-10-09T04:00:00.000Z' });
  const feed = parseNewsFeed(RSS_FEED);
  const evidence = feed.items.map(item => evaluateResultEvidence(feedItemEvidence(item), window, { checked_at: window.evaluated_at }));
  assert.equal(evidence[0].status, 'verified');
  assert.equal(evidence[1].status, 'unknown'); // no item date at all
});
