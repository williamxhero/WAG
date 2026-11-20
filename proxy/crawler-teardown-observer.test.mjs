import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test from 'node:test';
import { createCrawlerTeardownObserver, teardownCrawler, tracePathOutside } from './fixtures/crawler-teardown-observer.mjs';

const directory = path.resolve('owned-crawler-cwd');
const python = path.resolve('selected-python.exe');

function childFixture(operations = []) {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, exitCode: null, signalCode: null });
  child.kill = () => {
    operations.push('kill');
    queueMicrotask(() => {
      child.exitCode = 0;
      operations.push('exit');
      child.emit('exit', 0, null);
    });
    return true;
  };
  return child;
}

function observation(child, changes = {}) {
  const records = [];
  const faults = [];
  let clock = 100;
  const observer = createCrawlerTeardownObserver({
    directory, python, parentPid: 77,
    now: () => clock++, emit: record => records.push(record),
    onFailure: code => faults.push(code), ...changes,
  });
  observer.attach(child);
  return { observer, records, faults };
}

test('original teardown kills and waits for direct exit, removes once without waiting for close', async () => {
  const operations = [];
  const child = childFixture(operations);
  const { observer, records } = observation(child);
  let calls = 0;
  await teardownCrawler(child, directory, {
    observer,
    remove: async (value, options) => {
      calls++;
      assert.equal(value, directory);
      assert.deepEqual(options, { recursive: true, force: true });
      assert.equal(observer.snapshot().direct_child_exit_observed, true);
      assert.equal(observer.snapshot().direct_child_close_observed, false);
      operations.push('rm');
    },
  });
  assert.deepEqual(operations, ['kill', 'exit', 'rm']);
  assert.equal(calls, 1);
  assert.deepEqual(records.map(value => value.event), [
    'spawn', 'kill_requested', 'kill_result', 'exit', 'rm_started', 'rm_succeeded',
  ]);
  child.emit('close', 0, null);
  assert.equal(records.at(-1).event, 'close');
  assert.equal(observer.snapshot().classification, 'NOT_REPRODUCED');
  assert.equal(observer.snapshot().evidence_complete, false);
  assert.equal(observer.snapshot().descendant_exit_proven, false);
  assert.equal(observer.snapshot().ownership_proven, false);
});

test('original removal failure is retained and rethrown without retry or after-close repair', async () => {
  const child = childFixture();
  const { observer, records } = observation(child);
  const failure = Object.assign(new Error('private directory text'), { code: 'EBUSY' });
  let calls = 0;
  await assert.rejects(teardownCrawler(child, directory, {
    observer, remove: async () => { calls++; throw failure; },
  }), error => error === failure);
  child.emit('close', 0, null);
  assert.equal(calls, 1);
  assert.equal(records.find(value => value.event === 'rm_failed').error_code, 'EBUSY');
  assert.equal(observer.snapshot().classification, 'EBUSY_OBSERVED');
  assert.doesNotMatch(JSON.stringify(records), /private directory text/);
});

test('ordinary live-child teardown still kills when diagnostics are disabled', async () => {
  const operations = [];
  const child = childFixture(operations);
  const finished = teardownCrawler(child, directory, {
    remove: async () => { operations.push('rm'); },
  });
  assert.deepEqual(operations, ['kill']);
  await finished;
  assert.deepEqual(operations, ['kill', 'exit', 'rm']);
});

test('ordinary teardown needs no observer and does not kill an already-exited child', async () => {
  const child = childFixture();
  child.exitCode = 0;
  child.kill = () => { throw new Error('unexpected kill'); };
  let calls = 0;
  await teardownCrawler(child, directory, {
    remove: async (value, options) => {
      calls++;
      assert.equal(value, directory);
      assert.deepEqual(options, { recursive: true, force: true });
    },
  });
  assert.equal(calls, 1);
});

test('spawn metadata and event sequence remain explicitly observational', () => {
  const child = childFixture();
  const { observer, records } = observation(child);
  child.emit('exit', 0, null);
  assert.deepEqual(records[0], {
    schema: 'wag119.crawler-teardown/v1', sequence: 1, event: 'spawn',
    elapsed_ms: 1, evidence_complete: false, pid: 123,
    parent_pid: 77, python_executable: python, cwd: directory,
  });
  assert.equal(records[1].sequence, 2);
  assert.equal(records[1].event, 'exit');
  assert.equal(observer.snapshot().direct_child_close_observed, false);
  assert.equal(observer.snapshot().classification, 'UNKNOWN');
  assert.equal(observer.snapshot().ownership_proven, false);
});

test('kill exceptions retain original rejection and do not attempt removal', async () => {
  const child = childFixture();
  const failure = Object.assign(new Error('private kill failure'), { code: 'EACCES' });
  child.kill = () => { throw failure; };
  const { observer, records } = observation(child);
  await assert.rejects(teardownCrawler(child, directory, {
    observer, remove: async () => { assert.fail('unexpected rm'); },
  }), error => error === failure);
  assert.equal(records.at(-1).event, 'kill_failed');
  assert.equal(records.at(-1).error_code, 'EACCES');
  assert.doesNotMatch(JSON.stringify(records), /private kill failure/);
  assert.equal(observer.snapshot().removal_started, false);
});

test('a rejected kill does not cause retry or skip the original exit wait', async () => {
  const child = childFixture();
  let calls = 0;
  let removed = false;
  child.kill = () => { calls++; return false; };
  const { observer, records } = observation(child);
  const finished = teardownCrawler(child, directory, {
    observer, remove: async () => { removed = true; },
  });
  await Promise.resolve();
  assert.equal(removed, false);
  assert.equal(calls, 1);
  child.exitCode = 0;
  child.emit('exit', 0, null);
  await finished;
  assert.equal(removed, true);
  assert.equal(calls, 1);
  assert.equal(records.find(value => value.event === 'kill_result').accepted, false);
});

test('evidence failure does not prevent parent kill/wait but preserves cwd before rm', async () => {
  const operations = [];
  const child = childFixture(operations);
  const { observer, faults } = observation(child, {
    emit: record => { if (record.event === 'kill_requested') throw new Error('private evidence path'); },
  });
  await assert.rejects(teardownCrawler(child, directory, {
    observer, remove: async () => { assert.fail('rm after evidence failure'); },
  }), { code: 'WAG119_EVIDENCE' });
  assert.deepEqual(operations, ['kill', 'exit']);
  assert.deepEqual(faults, ['EVIDENCE_IO']);
  assert.equal(observer.snapshot().classification, 'UNKNOWN');
  assert.equal(observer.snapshot().removal_completed, false);
});

test('failed rm-start publication never claims that removal completed', async () => {
  const child = childFixture();
  const { observer } = observation(child, {
    emit: record => { if (record.event === 'rm_started') throw new Error('private'); },
  });
  await assert.rejects(teardownCrawler(child, directory, {
    observer, remove: async () => { assert.fail('rm after evidence failure'); },
  }), { code: 'WAG119_EVIDENCE' });
  assert.equal(observer.snapshot().removal_started, true);
  assert.equal(observer.snapshot().removal_completed, false);
});

test('failed failure-publication never replaces the original EBUSY error', async () => {
  const child = childFixture();
  const original = Object.assign(new Error('private'), { code: 'EBUSY' });
  const { observer, faults } = observation(child, {
    emit: record => { if (record.event === 'rm_failed') throw new Error('logger failed'); },
  });
  let calls = 0;
  await assert.rejects(teardownCrawler(child, directory, {
    observer, remove: async () => { calls++; throw original; },
  }), error => error === original);
  assert.equal(calls, 1);
  assert.deepEqual(faults, ['EVIDENCE_IO']);
  assert.equal(observer.snapshot().classification, 'UNKNOWN');
});

test('late close evidence failure invalidates observation without another removal', async () => {
  const child = childFixture();
  const { observer, faults } = observation(child, {
    emit: record => { if (record.event === 'close') throw new Error('private'); },
  });
  let calls = 0;
  await teardownCrawler(child, directory, { observer, remove: async () => { calls++; } });
  assert.equal(observer.snapshot().classification, 'NOT_REPRODUCED');
  assert.doesNotThrow(() => child.emit('close', 0, null));
  assert.equal(calls, 1);
  assert.deepEqual(faults, ['EVIDENCE_IO']);
  assert.equal(observer.snapshot().classification, 'UNKNOWN');
  assert.throws(() => observer.assertHealthy(), { code: 'WAG119_EVIDENCE' });
});

test('nonmonotonic or nonfinite clocks fail without interrupting parent exit', async () => {
  for (const invalid of [99, NaN, Infinity]) {
    let clock = 100;
    const operations = [];
    const child = childFixture(operations);
    const { observer, faults } = observation(child, { now: () => clock });
    clock = invalid;
    await assert.rejects(teardownCrawler(child, directory, {
      observer, remove: async () => { assert.fail('rm after clock failure'); },
    }), { code: 'WAG119_EVIDENCE' });
    assert.deepEqual(operations, ['kill', 'exit']);
    assert.deepEqual(faults, ['CLOCK']);
  }
});

test('callback errors remain latched even if the failure callback throws', async () => {
  const child = childFixture();
  const { observer } = observation(child, {
    emit: () => { throw new Error('private'); },
    onFailure: () => { throw new Error('private'); },
  });
  assert.doesNotThrow(() => child.emit('close', 0, null));
  await assert.rejects(teardownCrawler(child, directory, {
    observer, remove: async () => { assert.fail('unexpected rm'); },
  }), { code: 'WAG119_EVIDENCE' });
  assert.equal(observer.snapshot().error_code, 'EVIDENCE_IO');
});

test('one observer cannot authorize a second original removal', async () => {
  const child = childFixture();
  const { observer, faults } = observation(child);
  let calls = 0;
  const options = { observer, remove: async () => { calls++; } };
  await teardownCrawler(child, directory, options);
  await assert.rejects(teardownCrawler(child, directory, options), { code: 'WAG119_EVIDENCE' });
  assert.equal(calls, 1);
  assert.deepEqual(faults, ['PROTOCOL']);
});

test('unknown errors and signals never copy free text into records', async () => {
  const child = childFixture();
  const { observer, records } = observation(child);
  child.emit('error', Object.assign(new Error('private message'), { code: 'secret-code' }));
  child.emit('close', 1e20, 'private-signal');
  const original = Object.assign(new Error('private directory'), { code: 'private-code' });
  await assert.rejects(teardownCrawler(child, directory, {
    observer, remove: async () => { throw original; },
  }), error => error === original);
  assert.equal(records.find(value => value.event === 'child_error').error_code, 'UNKNOWN');
  assert.equal(records.find(value => value.event === 'close').signal, 'UNKNOWN');
  assert.equal(records.find(value => value.event === 'close').exit_code, null);
  assert.doesNotMatch(JSON.stringify(records), /private|secret/);
  assert.equal(observer.snapshot().classification, 'UNKNOWN');
});

test('missing PID metadata stays unknown and never prevents existing child cleanup', async () => {
  const child = childFixture();
  child.pid = undefined;
  const { observer, faults } = observation(child);
  assert.doesNotThrow(() => child.emit('error', new Error('private')));
  await assert.rejects(teardownCrawler(child, directory, {
    observer, remove: async () => { assert.fail('unexpected rm'); },
  }), { code: 'WAG119_EVIDENCE' });
  assert.deepEqual(faults, ['METADATA']);
  assert.equal(child.exitCode, 0);
  assert.equal(observer.snapshot().ownership_proven, false);
});

test('trace evidence must use an absolute path outside the crawler cwd', () => {
  for (const value of ['relative.jsonl', directory, path.join(directory, 'trace.jsonl')]) {
    assert.throws(() => tracePathOutside(value, directory));
  }
  const sibling = path.resolve('owned-crawler-cwd-evidence', 'trace.jsonl');
  assert.equal(tracePathOutside(sibling, directory), sibling);
});
