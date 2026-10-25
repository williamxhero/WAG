import path from 'node:path';
import { performance } from 'node:perf_hooks';

const errorCodes = new Set(['EBUSY', 'EACCES', 'EPERM', 'ENOENT', 'ESRCH']);
const signals = new Set(['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGBREAK', 'SIGABRT']);
const pid = value => Number.isInteger(value) && value > 0 && value <= 0xffffffff;
const errorCode = error => errorCodes.has(error?.code) ? error.code : 'UNKNOWN';
const termination = (code, signal) => ({
  exit_code: Number.isInteger(code) && code >= -0x80000000 && code <= 0xffffffff ? code : null,
  signal: signal == null ? null : signals.has(signal) ? signal : 'UNKNOWN',
});

export function tracePathOutside(file, directory) {
  if (!path.isAbsolute(file) || !path.isAbsolute(directory)) throw new Error('absolute trace paths required');
  const relative = path.relative(directory, file);
  if (relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))) {
    throw new Error('trace must be outside crawler cwd');
  }
  return path.resolve(file);
}

export function createCrawlerTeardownObserver({ directory, python, parentPid, emit, onFailure, now = () => performance.now() }) {
  if (!path.isAbsolute(directory) || !path.isAbsolute(python) || !pid(parentPid)
      || typeof emit !== 'function' || typeof onFailure !== 'function') {
    throw new Error('invalid crawler observation configuration');
  }
  const start = now();
  if (!Number.isFinite(start)) throw new Error('invalid observation clock');
  let sequence = 0;
  let elapsed = 0;
  let failure = null;
  let attached = false;
  let exited = false;
  let closed = false;
  let killRequested = false;
  let removalStarted = false;
  let removalOutcome = null;
  let removalError = null;

  function fail(code) {
    if (failure) return;
    failure = code;
    try { onFailure(code); } catch {}
  }

  function record(event, fields = {}) {
    if (failure) return;
    let offset;
    try { offset = now() - start; } catch { fail('CLOCK'); return; }
    if (!Number.isFinite(offset) || offset < elapsed) { fail('CLOCK'); return; }
    elapsed = offset;
    try {
      emit({ schema: 'wag119.crawler-teardown/v1', sequence: ++sequence,
        event, elapsed_ms: offset, evidence_complete: false, ...fields });
    } catch { fail('EVIDENCE_IO'); }
  }

  return {
    attach(child) {
      if (attached) { fail('PROTOCOL'); return; }
      attached = true;
      const childPid = pid(child.pid) ? child.pid : null;
      child.once('exit', (code, signal) => {
        exited = true;
        record('exit', { pid: childPid, ...termination(code, signal) });
      });
      child.once('close', (code, signal) => {
        closed = true;
        record('close', { pid: childPid, ...termination(code, signal) });
      });
      child.once('error', error => record('child_error', { pid: childPid, error_code: errorCode(error) }));
      if (childPid === null) { fail('METADATA'); return; }
      record('spawn', { pid: childPid, parent_pid: parentPid, python_executable: python, cwd: directory });
    },
    killRequested() {
      if (!attached || killRequested) { fail('PROTOCOL'); return; }
      killRequested = true;
      record('kill_requested');
    },
    killResult(accepted) {
      if (!killRequested || typeof accepted !== 'boolean') { fail('PROTOCOL'); return; }
      record('kill_result', { accepted });
    },
    killFailed(error) { record('kill_failed', { error_code: errorCode(error) }); },
    removalStarted() {
      if (!attached || removalStarted) { fail('PROTOCOL'); return; }
      removalStarted = true;
      record('rm_started');
    },
    removalSucceeded() {
      if (!removalStarted || removalOutcome) { fail('PROTOCOL'); return; }
      removalOutcome = 'success';
      record('rm_succeeded');
    },
    removalFailed(error) {
      if (!removalStarted || removalOutcome) { fail('PROTOCOL'); return; }
      removalOutcome = 'failure';
      removalError = errorCode(error);
      record('rm_failed', { error_code: removalError });
    },
    assertHealthy() {
      if (failure) throw Object.assign(new Error('crawler teardown observation failed'), { code: 'WAG119_EVIDENCE' });
    },
    snapshot() {
      return {
        classification: failure ? 'UNKNOWN' : removalOutcome === 'success' ? 'NOT_REPRODUCED'
          : removalError === 'EBUSY' ? 'EBUSY_OBSERVED' : 'UNKNOWN',
        error_code: failure, direct_child_exit_observed: exited, direct_child_close_observed: closed,
        removal_started: removalStarted, removal_completed: removalOutcome !== null,
        evidence_complete: false, descendant_exit_proven: false, ownership_proven: false,
      };
    },
  };
}

export async function teardownCrawler(child, directory, { remove, observer }) {
  if (child.exitCode === null && child.signalCode === null) {
    observer?.killRequested();
    await new Promise((resolve, reject) => {
      child.once('exit', resolve);
      try {
        const accepted = child.kill();
        observer?.killResult(accepted);
      }
      catch (error) { observer?.killFailed(error); reject(error); }
    });
  }
  observer?.assertHealthy();
  observer?.removalStarted();
  observer?.assertHealthy();
  try { await remove(directory, { recursive: true, force: true }); }
  catch (error) { observer?.removalFailed(error); throw error; }
  observer?.removalSucceeded();
  observer?.assertHealthy();
}
