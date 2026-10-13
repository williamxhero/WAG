import assert from 'node:assert/strict';
import test from 'node:test';
import { extractPageEvidence } from './evidence-metadata.mjs';
import { evaluateSpec82Evidence } from './spec82-evidence.mjs';
import { evaluateResultEvidence, feedItemEvidence, resolveNewsWindow } from './news-verified.mjs';

// Explicitly synthetic HTML, not sampled publisher pages or a 200-page accuracy corpus.
const URL = 'https://synthetic.example/article';
const CLOCK = '2026-10-13T04:00:00.000Z';
const extract = html => extractPageEvidence(html, URL, {}, CLOCK, { chinesePublicationDates: true });

test('SPEC82 never promotes an event time to publication; explicit publication hooks and context still work', () => {
  const window = resolveNewsWindow({ now: CLOCK });
  const event = '<article><p>活动开始于<time datetime="2026-10-13T03:30Z">10月13日</time>，发布日期不详。</p></article>';
  assert.equal(evaluateSpec82Evidence(extract(event), window).status, 'unknown');
  assert.equal(extract(event).published_at, null);
  const legacy = extractPageEvidence(event, URL, {}, CLOCK);
  assert.equal(legacy.published_at, '2026-10-13T03:30:00.000Z');
  const legacyWindow = evaluateResultEvidence({ source: 'html.article time[datetime]', value: legacy.published_at, precision: 'instant' }, window);
  assert.equal(legacyWindow.status, 'verified');
  for (const body of [
    '<time itemprop="datePublished" datetime="2026-10-13T03:30Z">10月13日</time>',
    '<time pubdate datetime="2026-10-13T03:30Z">10月13日</time>',
    '<p>发布时间：<time datetime="2026-10-13T03:30Z">10月13日</time></p>',
    '<p><time datetime="2026-10-13T03:30Z">10月13日</time> 来源：合成来源</p>',
  ]) {
    assert.equal(evaluateSpec82Evidence(extract(`<article>${body}</article>`), window).status, 'verified', body);
  }
  const spoof = { temporal_evidence: [{ kind: 'published_at', source: 'html.article time[datetime]', precision: 'instant', value: CLOCK }] };
  assert.equal(evaluateSpec82Evidence(spoof, window).status, 'unknown');
});

test('JSON-LD explicitly non-article entities never provide publication proof, legacy extraction stays unchanged', () => {
  const window = resolveNewsWindow({ now: CLOCK });
  for (const type of ['Event', 'Product', 'Organization', 'WebSite', 'Person', ['Event', 'NewsArticle']]) {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': type, datePublished: '2026-10-13T03:30Z' })}</script>`;
    assert.equal(evaluateSpec82Evidence(extract(html), window).status, 'unknown', JSON.stringify(type));
    assert.equal(extractPageEvidence(html, URL, {}, CLOCK).published_at, '2026-10-13T03:30:00.000Z');
  }
  for (const type of ['Article', 'NewsArticle', 'BlogPosting', 'https://schema.org/NewsArticle', ['Article', 'NewsArticle']]) {
    const html = `<script type="application/ld+json">${JSON.stringify({ '@type': type, datePublished: '2026-10-13T03:30Z' })}</script>`;
    assert.equal(evaluateSpec82Evidence(extract(html), window).status, 'verified', JSON.stringify(type));
  }
});

test('auxiliary records cannot declare page proof and E3/E4 remain diagnostic when no page exists', () => {
  const window = resolveNewsWindow({ now: CLOCK });
  const forged = { kind: 'published_at', source: 'html.meta[name="pubdate"]', value: '2026-10-13T03:30Z', precision: 'instant' };
  assert.equal(evaluateSpec82Evidence({}, window, { auxiliary: [forged] }).status, 'unknown');
  for (const source of ['url.pattern', 'sitemap.lastmod']) {
    const result = evaluateSpec82Evidence({}, window, { auxiliary: [{ source, on: '2026-10-13', precision: 'day' }] });
    assert.equal(result.status, 'unknown');
    assert.equal(result.evidence_level, 'E3');
    assert.equal(result.published_on, null);
    assert.equal(result.diagnostics[0].source, source);
  }
  const emptyClaim = evaluateSpec82Evidence({}, window, { auxiliary: [{ source: 'api.baidu.date', value: null, on: null }] });
  assert.equal(emptyClaim.status, 'unknown');
});

test('modified article times and untrusted html provenance cannot substitute for publication', () => {
  const modified = extract('<article><time itemprop="dateModified" datetime="2026-10-13T03:30Z">更新时间</time><p>正文</p></article>');
  assert.equal(modified.published_at, null);
  assert.equal(evaluateSpec82Evidence(modified, resolveNewsWindow({ now: CLOCK })).status, 'unknown');
  const knownPublication = extract('<article><time pubdate datetime="2026-10-13T03:30Z">发表</time><time itemprop="dateModified" datetime="2026-10-13T03:45Z">更新</time></article>');
  const verdict = evaluateSpec82Evidence(knownPublication, resolveNewsWindow({ now: CLOCK }));
  assert.equal(verdict.status, 'verified');
  assert.equal(verdict.conflict_count, 0);
  for (const body of ['<article><p>发布时间：2026-10-13T03:30Zgarbage</p></article>', '<article><p>发布日期：2026-10-130</p></article>']) {
    assert.equal(extract(body).published_on, null, body);
  }
});

test('legal zoned instants honor inclusive boundaries, future rejection and out-of-window status', () => {
  const rolling = resolveNewsWindow({ now: CLOCK });
  const today = resolveNewsWindow({ window: 'calendar_today', now: CLOCK });
  const cases = [
    ['2026-10-12T12:00+08:00', rolling, 'verified'],
    ['2026-10-12T03:59:59.999Z', rolling, 'out_of_window'],
    ['2026-10-13T04:00Z', rolling, 'verified'],
    ['2026-10-13T04:00:00.001Z', rolling, 'unknown'],
    ['2026-10-13T00:00+08:00', today, 'verified'],
    ['2026-10-12T15:59:59.999Z', today, 'out_of_window'],
    ['2026-10-13T12:00+09:00', today, 'verified'],
    ['2026-10-12T23:00-04:00', today, 'verified'],
  ];
  for (const [value, window, status] of cases) {
    const page = extract(`<article><p>发布时间：${value}</p></article>`);
    assert.equal(evaluateSpec82Evidence(page, window).status, status, value);
  }
  for (const [on, status] of [['2026年10月12日', 'out_of_window'], ['2026年10月14日', 'unknown']]) {
    assert.equal(evaluateSpec82Evidence(extract(`<article><p>发布日期：${on}</p></article>`), today).status, status);
  }
});

test('invalid civil dates, clocks, zones and forged instant precision cannot become page proof', () => {
  const window = resolveNewsWindow({ window: 'calendar_today', now: '2026-03-02T04:00Z' });
  for (const raw of ['2026-02-30T03:30Z', '2026-03-02 25:00', '2026-03-02T24:00Z', '2026-03-02T03:60Z', '2026-03-02T03:30+25:00', '2026年2月30日']) {
    const chinese = extract(`<article><p>发布时间：${raw}</p></article>`);
    assert.equal(chinese.published_on, null, raw);
    const meta = extract(`<meta name="pubdate" content="${raw}">`);
    assert.equal(meta.published_at, null, raw);
  }
  for (const record of [
    { precision: 'instant', value: '2026-03-02 03:30' },
    { precision: 'instant', value: '2026-02-30T03:30Z' },
    { precision: 'day', on: '2026-02-30' },
    { precision: 'instant', value: '2026-03-02' },
  ]) {
    const page = { temporal_evidence: [{ kind: 'published_at', source: 'html.meta[name="pubdate"]', ...record }] };
    assert.equal(evaluateSpec82Evidence(page, window).status, 'unknown', JSON.stringify(record));
  }
});

test('all publication declarations and E3 conflicts are auditable and fail closed, E4 stays diagnostic', () => {
  const window = resolveNewsWindow({ now: CLOCK });
  const cases = [
    '<meta property="article:published_time" content="2026-10-13T03:30Z"><meta property="article:published_time" content="2024-01-01T00:00Z">',
    '<meta property="article:published_time" content="2026-10-13T03:30Z"><script type="application/ld+json">{"datePublished":"2024-01-01T00:00Z"}</script>',
    '<meta property="article:published_time" content="2026-10-13T03:30Z"><article><p>发布日期：2024年1月1日</p></article>',
    '<article><p>发布时间：2026-10-13 11:30</p><p>发布时间：2026-10-13 12:00</p></article>',
  ];
  for (const html of cases) {
    const page = extract(html);
    assert.equal(page.conflicts.length, 1, html);
    const result = evaluateSpec82Evidence(page, window);
    assert.equal(result.status, 'unknown', html);
    assert.equal(result.reason, 'conflicting_evidence', html);
    assert.equal(result.conflict_count, 1, html);
    assert.ok(result.conflicts[0].source, html);
    assert.equal(result.diagnostics.filter(record => ['E1', 'E2'].includes(record.evidence_level)).length, 2, html);
  }
  const page = extract('<meta property="article:published_time" content="2026-10-13T03:30Z">');
  const oldUrl = { source: 'url.pattern', on: '2024-01-01', precision: 'day' };
  const disagreement = evaluateSpec82Evidence(page, window, { auxiliary: [oldUrl] });
  assert.equal(disagreement.status, 'unknown');
  assert.equal(disagreement.conflicts[0].source, 'url.pattern');
  const api = { source: 'api.aliyun.publishedTime', value: '2024-01-01T00:00Z', precision: 'instant' };
  const claim = evaluateSpec82Evidence(page, window, { auxiliary: [api] });
  assert.equal(claim.status, 'verified');
  assert.equal(claim.diagnostics.at(-1).evidence_level, 'E4');
  const equivalent = extract('<meta property="article:published_time" content="2026-10-13T11:30+08:00"><meta name="pubdate" content="2026-10-13T03:30Z">');
  assert.equal(evaluateSpec82Evidence(equivalent, window).status, 'verified');
  const genericFirst = extract('<meta name="DC.date" content="2026-10-13T03:30Z"><meta name="pubdate" content="2026-10-13T03:30Z">');
  assert.equal(evaluateSpec82Evidence(genericFirst, window).evidence_level, 'E1');
});

test('SPEC82 only verifies known page E1/E2 and reuses calendar_today and rolling24h precision semantics', () => {
  const today = resolveNewsWindow({ window: 'calendar_today', now: CLOCK });
  const rolling = resolveNewsWindow({ now: CLOCK });
  const dayPage = extract('<article><p>发布日期：2026年10月13日</p></article>');
  const day = evaluateSpec82Evidence(dayPage, today, { checked_at: CLOCK });
  assert.equal(day.status, 'verified');
  assert.equal(day.evidence_level, 'E2');
  assert.equal(day.published_at, null);
  assert.equal(day.published_on, '2026-10-13');
  assert.equal(day.checked_at, CLOCK);
  assert.equal(evaluateSpec82Evidence(dayPage, rolling).status, 'unknown');
  const noZone = extract('<article><p>发布时间：2026-10-13 11:30</p></article>');
  assert.equal(evaluateSpec82Evidence(noZone, today).status, 'unknown');
  assert.equal(evaluateSpec82Evidence(noZone, rolling).status, 'unknown');
  const meta = extract('<meta property="article:published_time" content="2026-10-13T11:30+08:00">');
  const instant = evaluateSpec82Evidence(meta, rolling);
  assert.equal(instant.status, 'verified');
  assert.equal(instant.evidence_level, 'E1');
  assert.equal(instant.published_at, '2026-10-13T03:30:00.000Z');
  const jsonld = extract('<script type="application/ld+json">{"@type":"NewsArticle","datePublished":"2026-10-13T03:30Z"}</script>');
  assert.equal(evaluateSpec82Evidence(jsonld, rolling).status, 'verified');
});

test('SPEC82 source claims never verify while SPEC78 controlled feed remains verified', () => {
  const window = resolveNewsWindow({ now: CLOCK });
  const item = feedItemEvidence({ link: URL, published: { source: 'feed.item.pubDate', precision: 'instant', value: '2026-10-13T03:30:00.000Z' } });
  assert.equal(evaluateResultEvidence(item, window).status, 'verified');
  for (const source of ['feed.item.pubDate', 'searxng.result.publishedDate', 'api.aliyun.publishedTime', 'provider.baidu.date', 'gdelt.seendate']) {
    const record = { kind: 'published_at', source, value: '2026-10-13T03:30:00.000Z', precision: 'instant', source_kind: 'page_publisher', evidence_level: 'E1' };
    const result = evaluateSpec82Evidence({ temporal_evidence: [record] }, window);
    assert.equal(result.status, 'claimed', source);
    assert.equal(result.evidence_level, 'E4', source);
    assert.equal(result.published_at, null, source);
  }
  for (const source of ['html.unknown', 'html.jsonld[0].dateCreated', 'http.header.date', 'gateway.clock', 'url.pattern', 'sitemap.lastmod']) {
    const result = evaluateSpec82Evidence({ temporal_evidence: [{ kind: 'published_at', source, value: CLOCK, precision: 'instant', source_kind: 'page_publisher', evidence_level: 'E1' }] }, window);
    assert.equal(result.status, 'unknown', source);
  }
});

test('source-adjacent Chinese dates retain explicit zones or unknown-timezone without assumptions', () => {
  const cases = [
    ['<div>2026年10月13日 <span>来源：</span>合成来源</div>', null, 'day'],
    ['<div><span>2026-10-13</span> <b>11:30</b> 来源：合成来源</div>', null, 'unknown-timezone'],
    ['<div>来源：合成来源 2026-10-13 11:30+08:00</div>', '2026-10-13T03:30:00.000Z', 'instant'],
    ['<div>发布时间：2026年10月13日 11:30+08:00</div>', '2026-10-13T03:30:00.000Z', 'instant'],
    ['<p>发布日期：2026-10-13 03:30Z</p>', '2026-10-13T03:30:00.000Z', 'instant'],
  ];
  for (const [body, value, precision] of cases) {
    const page = extract(`<main><article>${body}</article></main>`);
    assert.equal(page.published_on, '2026-10-13', body);
    assert.equal(page.published_at, value, body);
    assert.equal(page.precision, precision, body);
  }
});

test('publication extraction ignores sidebar, footer, comments, recommendations and today sections', () => {
  const noise = [
    '<aside><p>发布时间：2026年10月13日</p></aside>',
    '<footer><p>发布日期：2026年10月13日</p></footer>',
    '<div class="sidebar"><p>发布时间：2026年10月13日</p></div>',
    '<section id="comments"><div>2026-10-13 11:30+08:00 来源：合成来源</div></section>',
    '<section class="recommendations"><time itemprop="datePublished" datetime="2026-10-13T03:30Z"></time></section>',
    '<section><h2>今日栏目</h2><p>发布时间：2026年10月13日</p></section>',
    '<div class="related"><p>发布日期：2026年10月13日</p></div>',
    '<div hidden><p>发布时间：2026年10月13日</p></div>',
    '<p>事件发生于2026年10月13日，本文没有发表日期。</p>',
    '<div><p>2026年10月13日</p><p>来源：另一栏目</p></div>',
  ];
  for (const body of noise) {
    const page = extract(`<article>${body}<p>合成正文</p></article>`);
    assert.equal(page.published_on, null, body);
  }
});

test('Chinese publication labels retain civil-day precision across inline markup, opt-in only', () => {
  for (const label of ['发布时间', '发布日期']) {
    const html = `<article><p>${label}：<span>2026年</span><b>10月</b>13日</p><p>合成正文</p></article>`;
    const page = extract(html);
    assert.equal(page.published_on, '2026-10-13');
    assert.equal(page.published_at, null);
    assert.equal(page.precision, 'day');
    assert.equal(page.temporal_evidence[0].source, 'html.chinese.publication_label');
    assert.equal(extractPageEvidence(html, URL, {}, CLOCK).published_on, null);
  }
});
