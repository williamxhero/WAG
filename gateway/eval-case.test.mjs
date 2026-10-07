import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCase } from './eval-case.mjs';

test('security negatives require the precise reason or HTTP rejection on both error paths', async () => {
  for (const thrown of [false, true]) {
    for (const reason of ['non_public_address', 'unsupported_port']) {
      const record = await evaluateCase({
        id: 'private', expectation: 'expected_security',
        expected_outcome: { kinds: ['ssrf_blocked'], blocked_reason: 'non_public_address' },
        run: async () => {
          if (thrown) throw Object.assign(new Error('blocked'), { kind: 'ssrf_blocked', blockedReason: reason });
          return { payload: { error: { kind: 'ssrf_blocked' }, blocked_reason: reason } };
        },
      });
      assert.equal(record.status, reason === 'non_public_address' ? 'passed' : 'failed');
      assert.equal(record.quality.passed, reason === 'non_public_address');
    }
    const auth = await evaluateCase({
      id: 'auth', expectation: 'expected_security', expected_outcome: { http_status: 401 },
      run: async () => {
        if (thrown) throw Object.assign(new Error('unauthorized'), { httpStatus: 401 });
        return { payload: { status: 401 } };
      },
    });
    assert.equal(auth.status, 'passed');
    for (const status of [200, 403, 500]) {
      const wrongStatus = await evaluateCase({
        expectation: 'expected_security', expected_outcome: { http_status: 401 },
        run: async () => {
          if (thrown) throw Object.assign(new Error('wrong rejection'), { httpStatus: status });
          return { payload: { status } };
        },
      });
      assert.equal(wrongStatus.status, 'failed');
      assert.equal(wrongStatus.quality.passed, false);
    }
  }
});

test('timeout proof rejects success, unrelated errors, and undeclared negatives', async () => {
  for (const payload of [{ ok: true }, { value: { json: true } }, { error: { kind: 'unsupported_content_type' } }, { error: { kind: 'egress_connect' } }, { error: { kind: 'not_a_timeout' } }]) {
    const record = await evaluateCase({ ...timeoutCase, run: async () => ({ payload }) });
    assert.equal(record.status, 'failed');
    assert.equal(record.quality.passed, false);
  }
  for (const kind of ['unsupported_content_type', 'egress_connect', 'dependency_timeout']) {
    const record = await evaluateCase({ ...timeoutCase, run: async () => { throw Object.assign(new Error('timeout words do not prove a deadline'), { kind }); } });
    assert.equal(record.status, 'failed');
  }
  const undeclared = await evaluateCase({ expectation: 'expected_timeout', run: async () => ({ payload: { error: { kind: 'timeout' } } }) });
  assert.equal(undeclared.status, 'failed');
});

test('a wrapped typed deadline remains visible on both error paths', async () => {
  for (const thrown of [false, true]) {
    const cause = Object.assign(new Error('origin deadline'), { kind: 'upstream_timeout' });
    const wrapper = Object.assign(new Error('read failed', { cause }), { kind: 'request' });
    const record = await evaluateCase({ ...timeoutCase, run: async () => {
      if (thrown) throw wrapper;
      return { payload: { error: wrapper } };
    } });
    assert.equal(record.status, 'passed');
    assert.equal(record.error.kind, 'upstream_timeout');
    assert.equal(record.error.message, 'read failed');
  }
});

test('availability retries retain attempt evidence and expected negatives never retry into success', async () => {
  let attempts = 0;
  const recovered = await evaluateCase({ id: 'retry', dimension: 'connectivity', retry: true, run: async () => {
    if (++attempts === 1) throw new Error('read ECONNRESET');
    return { payload: { ok: true }, total_ms: 12, first_valid_result_ms: 10, metrics: { bytes: 4 } };
  } });
  assert.equal(recovered.status, 'passed');
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.degraded, true);
  assert.equal(recovered.first_error, 'read ECONNRESET');
  assert.equal(recovered.first_valid_result_ms, 10);
  assert.deepEqual(recovered.metrics, { bytes: 4 });
  attempts = 0;
  const negative = await evaluateCase({ ...timeoutCase, retry: true, retryQuality: true, run: async () => {
    attempts++;
    throw Object.assign(new Error('read ECONNRESET'), { kind: 'upstream_network' });
  } });
  assert.equal(negative.status, 'failed');
  assert.equal(negative.attempts, 1);
  assert.equal(attempts, 1);
});

test('availability quality retries and persistent deadline failures preserve existing conventions', async () => {
  let attempts = 0;
  const quality = await evaluateCase({ retry: true, retryQuality: true,
    run: async () => ({ payload: { ok: ++attempts > 1 } }),
    quality: payload => ({ passed: payload.ok }),
  });
  assert.equal(quality.status, 'passed');
  assert.equal(quality.attempts, 2);
  assert.equal(quality.first_error, 'transient quality assertion failed');
  const failure = await evaluateCase({ run: async () => { throw Object.assign(new Error('origin failed', { cause: { kind: 'egress_timeout' } }), { kind: 'request' }); } });
  assert.equal(failure.status, 'failed');
  assert.equal(failure.quality.passed, false);
  assert.equal(failure.error.kind, 'egress_timeout');
});

const timeoutCase = {
  id: 'controlled-timeout', name: 'Controlled read deadline', tool: 'web_read',
  expectation: 'expected_timeout',
  expected_outcome: { kinds: ['timeout', 'upstream_timeout', 'egress_timeout'] },
};

test('a declared deadline succeeds on returned and thrown typed errors', async () => {
  for (const kind of ['timeout', 'upstream_timeout', 'egress_timeout']) {
    for (const thrown of [false, true]) {
      const record = await evaluateCase({ ...timeoutCase, run: async () => {
        if (thrown) throw Object.assign(new Error('deadline reached'), { kind });
        return { payload: { error: { kind, message: 'deadline reached' } }, total_ms: 20 };
      } });
      assert.equal(record.status, 'passed');
      assert.equal(record.quality.passed, true);
      assert.equal(record.error.kind, kind);
      assert.equal(record.attempts, 1);
    }
  }
});
