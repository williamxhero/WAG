import assert from 'node:assert/strict';
import test from 'node:test';
import { classifySubmissionTime, evaluateNewsQuality } from './news-quality.mjs';

const WINDOW = { start: '2026-10-08T00:00:00Z', end: '2026-10-09T00:00:00Z' };

function read(record) {
  return { ok: true, ...record };
}

// Fixed candidate set drawn from the issue #64 evidence package. Labels are manual annotations used
// offline; nothing here claims an online automatic relevance judgment.
const CANDIDATES = [
  { url: 'https://www.ajudaily.com/view/20241128080617057', label: 'relevant' }, // 2024-11-28 old article
  { url: 'https://www.pingwest.com/a/255024', label: 'relevant' }, // 2021-12-14, date-only
  { url: 'https://docs.searxng.org/', label: 'relevant' }, // English relevant positive, no time
  { url: 'https://news.qq.com/rain/a/20261008A068NG00/', label: 'relevant' }, // fresh, within window
  { url: 'http://map.baidu.com/', label: 'negative' }, // map entry, not a news story
  { url: 'https://pcgpower.com/', label: 'negative' }, // company homepage, not global news
  { url: 'https://www.ndrc.gov.cn/example', label: 'relevant' }, // blocked / unreadable
];

const READS = {
  'https://www.ajudaily.com/view/20241128080617057': read({
    published_at: '2024-11-28T10:35:33.000Z',
    published_on: '2024-11-28',
    precision: 'instant',
    temporal_evidence: [
      { kind: 'published_at', value: '2024-11-28T10:35:33.000Z', on: '2024-11-28', precision: 'instant', source: 'html.meta[property="article:published_time"]' },
      // The response header carries "today" but must never be promoted to the article date.
      { kind: 'response_date', value: '2026-10-09T00:00:00.000Z', source: 'http.header.date' },
      { kind: 'retrieved_at', value: '2026-10-09T00:00:01.000Z', source: 'gateway.clock' },
    ],
  }),
  'https://www.pingwest.com/a/255024': read({
    published_at: null,
    published_on: '2021-12-14',
    precision: 'day',
    temporal_evidence: [
      { kind: 'published_at', value: null, on: '2021-12-14', precision: 'day', source: 'searxng.result.publishedDate' },
      { kind: 'retrieved_at', value: '2026-10-09T00:00:01.000Z', source: 'gateway.clock' },
    ],
  }),
  'https://docs.searxng.org/': read({
    published_at: null,
    published_on: null,
    temporal_evidence: [{ kind: 'retrieved_at', value: '2026-10-09T00:00:01.000Z', source: 'gateway.clock' }],
  }),
  'https://news.qq.com/rain/a/20261008A068NG00/': read({
    published_at: '2026-10-08T21:30:00.000Z',
    published_on: '2026-10-08',
    precision: 'instant',
    temporal_evidence: [{ kind: 'published_at', value: '2026-10-08T21:30:00.000Z', on: '2026-10-08', precision: 'instant', source: 'html.meta[property="article:published_time"]' }],
  }),
  'http://map.baidu.com/': read({ published_at: null, published_on: null, temporal_evidence: [] }),
  'https://pcgpower.com/': read({ published_at: null, published_on: null, temporal_evidence: [] }),
  'https://www.ndrc.gov.cn/example': { ok: false, error: 'private/internal address blocked' },
};

function report(overrides = {}) {
  return evaluateNewsQuality({
    query: '全球 市场 最新 新闻',
    language: 'zh-CN',
    time_range: 'day',
    window: WINDOW,
    candidates: CANDIDATES,
    reads: READS,
    ...overrides,
  });
}

test('classifySubmissionTime only trusts a publisher instant inside an explicit window', () => {
  const bounds = { start: Date.parse(WINDOW.start), end: Date.parse(WINDOW.end) };
  const publisher = { temporal_evidence: [{ kind: 'published_at', value: '2026-10-08T12:00:00.000Z', source: 'html.meta[x]' }] };
  assert.equal(classifySubmissionTime(publisher, bounds), 'within');
  assert.equal(classifySubmissionTime({ temporal_evidence: [{ kind: 'published_at', value: '2024-11-28T00:00:00.000Z', source: 'html.meta[x]' }] }, bounds), 'outside');
  assert.equal(classifySubmissionTime({ temporal_evidence: [{ kind: 'published_at', value: '2026-10-10T00:00:00.000Z', source: 'html.meta[x]' }] }, bounds), 'unverified');
  assert.equal(classifySubmissionTime({ temporal_evidence: [{ kind: 'published_on', value: null, on: '2026-10-08', precision: 'day', source: 'url.pattern' }] }, bounds), 'unverified');
  assert.equal(classifySubmissionTime({ temporal_evidence: [{ kind: 'published_at', value: null, on: '2026-10-08', precision: 'day', source: 'searxng.result.publishedDate' }] }, bounds), 'unverified');
  assert.equal(classifySubmissionTime({ temporal_evidence: [] }, bounds), 'unverified');
  assert.equal(classifySubmissionTime(publisher, null), 'unverified');
});

test('quality report classifies every fixed candidate against the full denominator', () => {
  const result = report();
  assert.equal(result.denominator, CANDIDATES.length);
  assert.equal(result.relevant, 5);
  assert.equal(result.time_verified, 1);
  assert.equal(result.both_satisfied, 1);
  assert.equal(result.irrelevant, 2);
  assert.equal(result.stale, 1);
  assert.equal(result.unknown, 2);
  assert.equal(result.read_failure, 1);
  assert.equal(result.entries.length, CANDIDATES.length);
  const byUrl = Object.fromEntries(result.entries.map(entry => [entry.url, entry]));
  assert.equal(byUrl['https://www.ajudaily.com/view/20241128080617057'].category, 'stale');
  assert.equal(byUrl['https://www.pingwest.com/a/255024'].category, 'unknown');
  assert.equal(byUrl['https://docs.searxng.org/'].category, 'unknown');
  assert.equal(byUrl['https://news.qq.com/rain/a/20261008A068NG00/'].category, 'both_satisfied');
  assert.equal(byUrl['http://map.baidu.com/'].category, 'irrelevant');
  assert.equal(byUrl['https://www.ndrc.gov.cn/example'].category, 'read_failure');
});

test('the denominator is the fixed candidate set, so hits cannot stand in for failures', () => {
  const result = report();
  const accounted = result.both_satisfied + result.irrelevant + result.stale + result.unknown + result.read_failure;
  assert.equal(accounted, result.denominator);
  assert.deepEqual(result.failures.map(item => item.url).sort(), [
    'https://docs.searxng.org/',
    'https://www.ndrc.gov.cn/example',
    'https://www.pingwest.com/a/255024',
  ]);
});

test('the gate fails honestly when failures or unknowns exceed the stated allowance', () => {
  const lenient = report({ require: { maxReadFailure: 1, maxUnknown: 2, minBothSatisfied: 1 } });
  assert.equal(lenient.gate.passed, true);

  const strictGate = report({ require: { maxReadFailure: 0, maxUnknown: 0, minBothSatisfied: 1 } });
  assert.equal(strictGate.gate.passed, false);
  assert.equal(strictGate.gate.reasons.length, 2);
  assert.match(strictGate.gate.reasons.join(' '), /read failure/);
  assert.match(strictGate.gate.reasons.join(' '), /unverified time/);
});

test('the gate refuses to pass when no candidate satisfies both relevance and freshness', () => {
  const result = report({ require: { maxReadFailure: 1, maxUnknown: 2, minBothSatisfied: 5 } });
  assert.equal(result.gate.passed, false);
  assert.match(result.gate.reasons.join(' '), /below the required 5/);
});

test('an empty candidate set never passes by default', () => {
  const result = evaluateNewsQuality({ window: WINDOW, candidates: [], reads: {} });
  assert.equal(result.denominator, 0);
  assert.equal(result.gate.passed, false);
  assert.match(result.gate.reasons.join(' '), /no candidates/);
});
