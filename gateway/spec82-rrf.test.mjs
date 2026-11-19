import test from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion } from './spec82-rrf.mjs';

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

test('worked scores use distinct-source credit and original ranks before canonical deduplication', () => {
  const firstA = { url: 'https://EXAMPLE.com:443/a?utm_source=x#first', score: -100 };
  const duplicateA = { url: 'https://example.com/a#later', score: 999999 };
  const firstB = { url: 'https://example.com/b' };
  const secondB = { url: 'https://example.com/b?fbclid=tracking' };
  const secondA = { url: 'https://example.com/a?gclid=tracking' };
  const secondC = { url: 'https://example.com/c' };
  assert.deepEqual(reciprocalRankFusion([
    { source: 'beta', results: [secondB, secondA, secondC] },
    { source: 'alpha', results: [firstA, duplicateA, firstB] },
  ]), [
    {
      url: 'https://example.com/a', score: 1 / 61 + 1 / 62,
      contributions: [
        { source: 'alpha', rank: 1, score: 1 / 61, result: firstA },
        { source: 'beta', rank: 2, score: 1 / 62, result: secondA },
      ],
    },
    {
      url: 'https://example.com/b', score: 1 / 63 + 1 / 61,
      contributions: [
        { source: 'alpha', rank: 3, score: 1 / 63, result: firstB },
        { source: 'beta', rank: 1, score: 1 / 61, result: secondB },
      ],
    },
    {
      url: 'https://example.com/c', score: 1 / 63,
      contributions: [{ source: 'beta', rank: 3, score: 1 / 63, result: secondC }],
    },
  ]);
});

test('canonical identity uses the shared query rules without conflating HTTP and HTTPS', () => {
  const original = { url: 'https://EXAMPLE.com:443/item?z=2&utm_campaign=x&a=1&FBCLID=x&GCLID=x#one' };
  const duplicate = { url: 'https://example.com/item?a=1&z=2#two' };
  const http = { url: 'http://EXAMPLE.com:80/item?z=2&a=1' };
  const output = reciprocalRankFusion([{ source: 's', results: [original, duplicate, http] }]);
  assert.deepEqual(output, [
    {
      url: 'https://example.com/item?a=1&z=2', score: 1 / 61,
      contributions: [{ source: 's', rank: 1, score: 1 / 61, result: original }],
    },
    {
      url: 'http://example.com/item?a=1&z=2', score: 1 / 63,
      contributions: [{ source: 's', rank: 3, score: 1 / 63, result: http }],
    },
  ]);
  assert.strictEqual(output[0].contributions[0].result, original);
});

test('source permutations preserve contribution order and bit-exact summation', () => {
  const sources = [
    { source: 'a', results: [{ url: 'https://example.com/shared' }] },
    { source: '😀', results: [{ url: 'https://example.com/f0' }, { url: 'https://example.com/shared' }] },
    { source: 'Z', results: [{ url: 'https://example.com/f1' }, { url: 'https://example.com/f2' }, { url: 'https://example.com/shared' }] },
    { source: 'ä', results: [{ url: 'https://example.com/f3' }, { url: 'https://example.com/f4' }, { url: 'https://example.com/f5' }, { url: 'https://example.com/shared' }] },
  ];
  const expected = reciprocalRankFusion(sources);
  const shared = expected[0];
  assert.equal(shared.url, 'https://example.com/shared');
  assert.deepEqual(shared.contributions.map(({ source, rank }) => [source, rank]), [
    ['Z', 3], ['a', 1], ['ä', 4], ['😀', 2],
  ]);
  assert.equal(shared.score, 1 / 63 + 1 / 61 + 1 / 64 + 1 / 62);
  assert.deepEqual(reciprocalRankFusion([...sources].reverse()), expected);
  assert.deepEqual(reciprocalRankFusion([sources[2], sources[0], sources[3], sources[1]]), expected);
});

test('exact score ties use canonical URL code-unit ordering, including before limiting', () => {
  const sources = [
    { source: 'z', results: [{ url: 'https://example.com/b#fragment' }] },
    { source: 'a', results: [{ url: 'https://example.com/Z?utm_source=x' }] },
    { source: 'B', results: [{ url: 'https://example.com/a' }] },
  ];
  const output = reciprocalRankFusion(sources);
  assert.deepEqual(output.map(row => row.url), [
    'https://example.com/Z', 'https://example.com/a', 'https://example.com/b',
  ]);
  assert.ok(output.every(row => row.score === 1 / 61));
  assert.deepEqual(reciprocalRankFusion(sources, { limit: 1 }), [output[0]]);
  assert.deepEqual(reciprocalRankFusion([...sources].reverse()), output);
});

test('limit is applied after aggregation, not to each source list', () => {
  const a = { url: 'https://example.com/a' };
  const b = { url: 'https://example.com/b' };
  const sharedA = { url: 'https://example.com/shared#A' };
  const sharedB = { url: 'https://example.com/shared#B' };
  assert.deepEqual(reciprocalRankFusion([
    { source: 'a', results: [a, sharedA] },
    { source: 'b', results: [b, sharedB] },
  ], { limit: 1 }), [{
    url: 'https://example.com/shared', score: 1 / 62 + 1 / 62,
    contributions: [
      { source: 'a', rank: 2, score: 1 / 62, result: sharedA },
      { source: 'b', rank: 2, score: 1 / 62, result: sharedB },
    ],
  }]);
});

test('default and explicit limits cover zero through twenty', () => {
  const results = Array.from({ length: 25 }, (_, index) => ({ url: `https://example.com/${index}` }));
  const sources = [{ source: 's', results }];
  const expected = results.slice(0, 20).map((result, index) => ({
    url: result.url, score: 1 / (61 + index),
    contributions: [{ source: 's', rank: index + 1, score: 1 / (61 + index), result }],
  }));
  assert.deepEqual(reciprocalRankFusion(sources), expected);
  assert.deepEqual(reciprocalRankFusion(sources, undefined), expected);
  assert.deepEqual(reciprocalRankFusion(sources, { limit: undefined }), expected);
  assert.deepEqual(reciprocalRankFusion(sources, Object.create({ limit: 0 })), expected);
  for (let limit = 0; limit <= 20; limit++) {
    assert.deepEqual(reciprocalRankFusion(sources, { limit }), expected.slice(0, limit));
  }
});

test('invalid limits throw RangeError rather than coercing values', () => {
  for (const limit of [-1, 21, 0.5, NaN, Infinity, -Infinity, null, true, false, '2', 2n, Symbol('limit'), {}, []]) {
    assert.throws(() => reciprocalRankFusion([], { limit }), RangeError);
  }
});

test('options reject invalid containers and all unknown own keys', () => {
  for (const options of [null, [], 1, 'options', true, () => {}, Symbol('options')]) {
    assert.throws(() => reciprocalRankFusion([], options), TypeError);
  }
  for (const options of [{ k: 60 }, { limit: 0, other: true }, { [Symbol('unknown')]: 1 }, Object.defineProperty({}, 'hidden', { value: 1 })]) {
    assert.throws(() => reciprocalRankFusion([], options), TypeError);
  }
});

test('empty inputs and empty source lists are valid', () => {
  assert.deepEqual(reciprocalRankFusion([]), []);
  assert.deepEqual(reciprocalRankFusion([{ source: 'empty', results: [] }]), []);
  assert.deepEqual(reciprocalRankFusion([{ source: 'a', results: [] }, { source: 'b', results: [] }], { limit: 0 }), []);
});

test('invalid source containers, blocks, IDs and result lists throw TypeError', () => {
  for (const sources of [undefined, null, {}, 'sources', 1, () => {}, Array(1)]) {
    assert.throws(() => reciprocalRankFusion(sources), TypeError);
  }
  for (const block of [null, undefined, [], 'block', 1, () => {}, {}, { source: 's' }]) {
    assert.throws(() => reciprocalRankFusion([block]), TypeError);
  }
  for (const source of ['', ' ', '\ts', 's\n', ' s', null, undefined, 1, {}, Symbol('id')]) {
    assert.throws(() => reciprocalRankFusion([{ source, results: [] }]), TypeError);
  }
  for (const results of [null, undefined, {}, 'results', 1, () => {}, Array(1)]) {
    assert.throws(() => reciprocalRankFusion([{ source: 's', results }]), TypeError);
  }
});

test('invalid result entries and URLs throw TypeError even beyond a requested limit', () => {
  const valid = { url: 'https://example.com/valid' };
  const invalidEntries = [null, undefined, [], 'result', 1, () => {}, {}, { url: '' }, { url: null }, { url: 123 }, { url: new URL('https://example.com/') }];
  for (const result of invalidEntries) {
    assert.throws(() => reciprocalRankFusion([{ source: 's', results: [result] }]), TypeError);
    assert.throws(() => reciprocalRankFusion([{ source: 's', results: [valid, result] }], { limit: 1 }), TypeError);
    assert.throws(() => reciprocalRankFusion([{ source: 's', results: [valid, result] }], { limit: 0 }), TypeError);
  }
  for (const url of [' ', '/relative', '//example.com/path', 'example.com', 'https://', 'https://[bad', 'https://example.com:bad/', 'ftp://example.com/file', 'file:///tmp/file', 'javascript:alert(1)', 'data:text/plain,x']) {
    assert.throws(() => reciprocalRankFusion([{ source: 's', results: [{ url }] }]), TypeError);
  }
  assert.throws(() => reciprocalRankFusion([{ source: 's', results: [valid, , valid] }], { limit: 0 }), TypeError);
  assert.throws(() => reciprocalRankFusion([{ source: 's', results: [] }, , { source: 't', results: [] }], { limit: 0 }), TypeError);
});

test('duplicate source IDs are rejected even for empty lists and limit zero', () => {
  for (const limit of [0, 20]) {
    assert.throws(() => reciprocalRankFusion([
      { source: 'same', results: [] }, { source: 'same', results: [] },
    ], { limit }), TypeError);
    assert.throws(() => reciprocalRankFusion([
      { source: 'same', results: [{ url: 'https://example.com/a' }] },
      { source: 'same', results: [{ url: 'https://example.com/a' }] },
    ], { limit }), TypeError);
  }
  const output = reciprocalRankFusion(['a', 'A', '__proto__', 'constructor'].map(source => ({
    source, results: [{ url: 'https://example.com/a' }],
  })));
  assert.deepEqual(output[0].contributions.map(item => item.source), ['A', '__proto__', 'a', 'constructor']);
  assert.equal(output[0].score, 1 / 61 + 1 / 61 + 1 / 61 + 1 / 61);
});

test('frozen inputs retain original per-source evidence without merged or borrowed proof', () => {
  const weak = {
    url: 'https://EXAMPLE.com:443/story?utm_source=weak#original',
    published_at: null, verified: false, evidence_level: 'E3', score: 999999,
    temporal_evidence: [{ source: 'url.pattern', on: '2026-01-01', value: null }],
  };
  const laterDuplicate = {
    url: 'https://example.com/story#duplicate', published_at: '2026-02-01T00:00:00Z',
    verified: true, evidence_level: 'E1', title: 'must not be borrowed',
  };
  const other = {
    url: 'https://example.com/story?fbclid=other', published_on: '2025-12-01',
    verified: false, evidence_level: 'E4',
    temporal_evidence: [{ source: 'http.header.date', value: '2026-03-01T00:00:00Z' }],
  };
  const sources = deepFreeze([
    { source: 'z', results: [other], verified: true, k: 1 },
    { source: 'a', results: [weak, laterDuplicate], published_at: 'ignored' },
  ]);
  const options = deepFreeze({ limit: 20 });
  const before = JSON.stringify(sources);
  const output = reciprocalRankFusion(sources, options);
  assert.equal(JSON.stringify(sources), before);
  assert.deepEqual(output, [{
    url: 'https://example.com/story', score: 1 / 61 + 1 / 61,
    contributions: [
      { source: 'a', rank: 1, score: 1 / 61, result: weak },
      { source: 'z', rank: 1, score: 1 / 61, result: other },
    ],
  }]);
  assert.strictEqual(output[0].contributions[0].result, weak);
  assert.strictEqual(output[0].contributions[1].result, other);
  assert.strictEqual(output[0].contributions[0].result.temporal_evidence, weak.temporal_evidence);
  assert.equal(weak.url, 'https://EXAMPLE.com:443/story?utm_source=weak#original');
  assert.equal(weak.published_at, null);
  assert.equal(weak.verified, false);
  assert.equal(other.verified, false);
  assert.deepEqual(Object.keys(output[0]), ['url', 'score', 'contributions']);
  for (const contribution of output[0].contributions) {
    assert.deepEqual(Object.keys(contribution), ['source', 'rank', 'score', 'result']);
  }
  const again = reciprocalRankFusion(sources, options);
  assert.deepEqual(again, output);
  assert.notStrictEqual(again, output);
  assert.notStrictEqual(again[0], output[0]);
  assert.notStrictEqual(again[0].contributions, output[0].contributions);
  assert.notStrictEqual(again[0].contributions[0], output[0].contributions[0]);
  assert.strictEqual(again[0].contributions[0].result, weak);
});
