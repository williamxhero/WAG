"""Preparation only. Manual flags are not runtime authorization.

Single outer writer; no deletion, overwrite, retry or process/PID management.
A receipt is usable ONLY with this wrapper's exit 0: a late/failed final fsync
cannot be retracted from an immutable file. External capture must retain status.
"""
import argparse
from contextlib import ExitStack
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time

SOURCES = ('descendant_capture.py', 'descendant_preflight.py', 'one_root_preflight.py')


class CaptureFault(Exception):
    def __init__(self, reason):
        self.reason = reason


def summary(result, reason):
    if result not in ('NOT_RUN', 'REJECTED', 'CAPTURED_CANDIDATE') or reason not in (
            'GATE', 'GIT', 'SOURCE_STATE', 'INTERPRETER', 'BINDING', 'DIRECTORY', 'SETUP_IO',
            'TIMEOUT', 'ENVIRONMENT', 'EXIT', 'CAPTURE_IO', 'RUNNER', 'UNSTABLE',
            'STDERR', 'REPORT', 'RECEIPT_IO', 'OK', 'INTERNAL'):
        result, reason = 'REJECTED', 'INTERNAL'
    return {'result': result, 'reason': reason, 'evidence_complete': False}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def strict_json(text):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise CaptureFault('REPORT')
            result[key] = value
        return result
    def constant(unused):
        raise CaptureFault('REPORT')
    return json.loads(text, object_pairs_hook=pairs, parse_constant=constant)


def valid_binding(value):
    try:
        hexdigest = lambda text, sizes: type(text) is str and len(text) in sizes and bool(re.fullmatch('[0-9a-f]+', text))
        return (set(value) == {'version', 'commit', 'tree', 'sources', 'interpreter', 'internal_seconds', 'external_seconds'}
                and type(value['version']) is int and value['version'] == 1
                and type(value['internal_seconds']) is int and value['internal_seconds'] == 60
                and type(value['external_seconds']) is int and value['external_seconds'] == 90
                and hexdigest(value['commit'], (40, 64)) and hexdigest(value['tree'], (40, 64))
                and set(value['sources']) == set(SOURCES)
                and all(set(v) == {'sha256', 'blob'} and hexdigest(v['sha256'], (64,))
                        and hexdigest(v['blob'], (40, 64)) for v in value['sources'].values())
                and set(value['interpreter']) == {'path', 'physical_path', 'sha256'}
                and all(type(value['interpreter'][key]) is str and Path(value['interpreter'][key]).is_absolute()
                        for key in ('path', 'physical_path'))
                and hexdigest(value['interpreter']['sha256'], (64,)))
    except Exception:
        return False


def snapshot(root, runner, remaining):
    def git(*args):
        try:
            result = runner(['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', str(root), *args], capture_output=True,
                            check=False, timeout=remaining(), env={'SystemRoot': os.environ.get('SystemRoot', '')})
        except subprocess.TimeoutExpired:
            raise CaptureFault('TIMEOUT') from None
        if result.returncode != 0 or result.stderr:
            raise CaptureFault('GIT')
        return result.stdout.decode('ascii').strip()
    paths = ['scripts/' + name for name in SOURCES]
    commit, tree = git('rev-parse', '--verify', 'HEAD'), git('rev-parse', '--verify', 'HEAD^{tree}')
    if git('status', '--porcelain=v1', '--untracked-files=all', '--', *paths):
        raise CaptureFault('SOURCE_STATE')
    records = git('ls-tree', '--full-tree', 'HEAD', '--', *paths).splitlines()
    blobs = {}
    for record in records:
        fields, path = record.split('\t')
        mode, kind, blob = fields.split()
        if mode not in ('100644', '100755') or kind != 'blob' or path not in paths or path in blobs:
            raise CaptureFault('SOURCE_STATE')
        blobs[path] = blob
    if set(blobs) != set(paths):
        raise CaptureFault('SOURCE_STATE')
    executable = Path(sys.executable)
    if not executable.is_absolute() or executable.name.lower() not in ('python.exe', 'pythonw.exe', 'python3.exe'):
        raise CaptureFault('INTERPRETER')
    physical = executable.resolve(strict=True)
    value = {'version': 1, 'commit': commit, 'tree': tree, 'internal_seconds': 60, 'external_seconds': 90,
             'sources': {name: {'sha256': digest((root / 'scripts' / name).read_bytes()), 'blob': blobs['scripts/' + name]} for name in SOURCES},
             'interpreter': {'path': sys.executable, 'physical_path': str(physical), 'sha256': digest(physical.read_bytes())}}
    if not valid_binding(value):
        raise CaptureFault('GIT')
    return value


def accepted(raw):
    try:
        line = raw[:-2] if raw.endswith(b'\r\n') else raw[:-1]
        if not raw.endswith(b'\n') or raw.count(b'\n') != 1 or b'\r' in line or not line.startswith(b'{'):
            return None
        value = strict_json(line.decode('utf-8'))
        # Reject even trailing whitespace: preserve exactly one actual raw line.
        if json.JSONDecoder().raw_decode(line.decode('utf-8'))[1] != len(line.decode('utf-8')):
            return None
        true = ('candidate', 'root_owned', 'leaf_owned', 'transfer_ack', 'root_force_requested',
                'root_force_succeeded', 'root_actual_exit', 'leaf_actual_exit', 'leaf_natural_exit', 'control_observed')
        false = ('evidence_complete', 'abort_requested', 'job_terminate_succeeded', 'containment_zero', 'deadline_overrun')
        zero = ('winerror', 'cleanup_failures', 'handle_close_failures', 'view_release_failures', 'attribute_release_failures')
        ids = ('root_pid', 'root_tid', 'leaf_pid', 'leaf_tid')
        births = ('root_creation_filetime', 'leaf_creation_filetime')
        keys = set(true + false + zero + ids + births) | {'result', 'phase', 'resource_seconds', 'samplecount', 'job_samples'}
        finite = lambda x: type(x) in (int, float) and math.isfinite(x)
        if (set(value) != keys or value['result'] != 'UNKNOWN' or value['phase'] != 'OBSERVE'
                or not all(value[k] is True for k in true) or not all(value[k] is False for k in false)
                or not all(type(value[k]) is int and value[k] == 0 for k in zero)
                or not all(type(value[k]) is int and 0 < value[k] <= 0xFFFFFFFF for k in ids)
                or not all(type(value[k]) is int and 0 < value[k] <= 0xFFFFFFFFFFFFFFFF for k in births)
                or value['root_pid'] == value['leaf_pid']
                or not finite(value['resource_seconds']) or not 6 <= value['resource_seconds'] <= 60
                or type(value['samplecount']) is not int or not 3 <= value['samplecount'] <= 128
                or type(value['job_samples']) is not list or len(value['job_samples']) != value['samplecount']):
            return None
        previous = 0
        expected = {'job_total': 2, 'job_active': 0, 'job_assigned': 0, 'job_listed': 0,
                    'root_wait_result': 0, 'leaf_wait_result': 0}
        for index, sample in enumerate(value['job_samples']):
            if (set(sample) != set(expected) | {'offset_seconds'}
                    or not all(type(sample[k]) is int and sample[k] == v for k, v in expected.items())
                    or not finite(sample['offset_seconds'])
                    or (index > 0 and sample['offset_seconds'] <= previous)
                    or (index == 0 and sample['offset_seconds'] != 0)):
                return None
            previous = sample['offset_seconds']
        return value if previous >= 6 and previous == value['resource_seconds'] else None
    except Exception:
        return None


def capture(binding, parent, name, *, runner=None, git_runner=None, clock=time.monotonic, sync=None, deadline=None):
    runner, git_runner, sync = runner or subprocess.run, git_runner or subprocess.run, sync or os.fsync
    started = clock()
    deadline = min(deadline, started + 90.0) if deadline is not None else started + 90.0
    def remaining():
        seconds = deadline - clock()
        if seconds <= 0:
            raise CaptureFault('TIMEOUT')
        return min(90.0, seconds)
    root = Path(__file__).resolve().parents[1]
    before = after = control = child_exit = None
    reason, attempted = 'OK', False
    raw = {'stdout': None, 'stderr': None}
    durable = {'stdout': False, 'stderr': False}
    directory = parent / name
    try:
        if not valid_binding(binding):
            return summary('NOT_RUN', 'GATE'), 2
        before = snapshot(root, git_runner, remaining)
        if before != binding:
            raise CaptureFault('BINDING')
        if (not parent.is_absolute() or not parent.is_dir() or not re.fullmatch('[A-Za-z0-9_-]{1,64}', name)):
            raise CaptureFault('DIRECTORY')
        remaining()
        directory.mkdir(exist_ok=False)
    except CaptureFault as error:
        return summary('REJECTED', error.reason), 2
    except FileExistsError:
        return summary('REJECTED', 'DIRECTORY'), 2
    except Exception:
        return summary('REJECTED', 'SETUP_IO'), 2
    try:
        with ExitStack() as stack:
            streams = {key: stack.enter_context((directory / (key + '.bin')).open('xb')) for key in raw}
            remaining()
            system_root = os.environ.get('SystemRoot', '')
            if not Path(system_root).is_absolute() or '\0' in system_root:
                raise CaptureFault('ENVIRONMENT')
            command = [sys.executable, '-I', '-S', '-B', str(root / 'scripts' / 'descendant_preflight.py'),
                       '--execute-descendant', '--preparation-reviewed', '--execution-authorization', 'capture-manual-gate']
            timeout = remaining()
            try:
                attempted = True
                result = runner(command, cwd=str(directory), env={'SystemRoot': system_root}, stdin=subprocess.DEVNULL,
                                stdout=streams['stdout'], stderr=streams['stderr'], timeout=timeout, check=False)
                child_exit = result.returncode
                if type(child_exit) is not int or not -0x80000000 <= child_exit <= 0xFFFFFFFF:
                    child_exit, reason = None, 'EXIT'
            except subprocess.TimeoutExpired:
                reason = 'TIMEOUT'
            except OSError:
                reason = 'CAPTURE_IO'
            except Exception:
                reason = 'RUNNER'
            for key, stream in streams.items():
                try:
                    stream.flush()
                    sync(stream.fileno())
                    durable[key] = True
                except Exception:
                    reason = 'CAPTURE_IO'
    except CaptureFault as error:
        reason = error.reason
    except Exception:
        reason = 'CAPTURE_IO'
    for key in raw:
        try:
            raw[key] = (directory / (key + '.bin')).read_bytes()
        except Exception:
            reason = 'CAPTURE_IO'
    try:
        after = snapshot(root, git_runner, remaining)
        if before != after:
            reason = 'UNSTABLE'
    except CaptureFault as error:
        reason = 'TIMEOUT' if error.reason == 'TIMEOUT' else 'UNSTABLE'
    except Exception:
        reason = 'UNSTABLE'
    if reason == 'OK':
        control = accepted(raw['stdout'])
        reason = 'EXIT' if child_exit != 2 else 'STDERR' if raw['stderr'] else 'REPORT' if control is None else 'OK'
    if clock() >= deadline:
        reason = 'TIMEOUT'
    result = 'CAPTURED_CANDIDATE' if reason == 'OK' and all(durable.values()) else 'REJECTED'
    receipt = dict(summary(result, reason), before=before, after=after, child_exit=child_exit,
                   launch_attempted=attempted, control=control, requires_exit_zero=True,
                   raw={key: {'sha256': digest(data) if data is not None else None,
                              'bytes': len(data) if data is not None else None,
                              'durable': durable[key]} for key, data in raw.items()},
                   elapsed_before_receipt=clock() - started)
    # Exactly one exclusive final writer. Failed/late publication is NOT repaired
    # by overwriting a receipt; retained raw files and nonzero exit are the facts.
    try:
        payload = json.dumps(receipt, separators=(',', ':'), allow_nan=False).encode('utf-8') + b'\n'
        with (directory / 'receipt.json').open('xb') as output:
            if output.write(payload) != len(payload):
                raise CaptureFault('RECEIPT_IO')
            output.flush()
            sync(output.fileno())
    except Exception:
        return summary('REJECTED', 'RECEIPT_IO'), 4
    if clock() >= deadline:
        return summary('REJECTED', 'TIMEOUT'), 3
    return summary(result, reason), 0 if result == 'CAPTURED_CANDIDATE' else 3


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise CaptureFault('GATE')


def dispatch(arguments, output):
    parser = QuietParser(add_help=False, allow_abbrev=False)
    parser.add_argument('--capture-descendant', action='store_true')
    parser.add_argument('--preparation-reviewed', action='store_true')
    for name in ('execution-authorization', 'expected-binding', 'capture-parent', 'capture-name'):
        parser.add_argument('--' + name)
    answer, code = summary('NOT_RUN', 'GATE'), 2 if arguments else 0
    binding, deadline = None, None
    try:
        args = parser.parse_args(arguments)
        if (args.capture_descendant and args.preparation_reviewed and args.execution_authorization
                and args.execution_authorization.strip() and args.expected_binding and args.capture_parent and args.capture_name):
            binding = strict_json(Path(args.expected_binding).read_bytes())
    except Exception:
        pass  # No raw argument, exception, environment or authorization text.
    if binding is not None and valid_binding(binding):
        try:
            deadline = time.monotonic() + 90.0
            answer, code = capture(binding, Path(args.capture_parent), args.capture_name, deadline=deadline)
        except Exception:
            # Capture may already have launched: never rewrite that as NOT_RUN.
            answer, code = summary('REJECTED', 'INTERNAL'), 4
    if code == 0 and deadline is not None and time.monotonic() >= deadline:
        answer, code = summary('REJECTED', 'TIMEOUT'), 3
    try:
        payload = json.dumps(answer, separators=(',', ':')) + '\n'
        if output.write(payload) != len(payload):
            return 4
        output.flush()
    except Exception:
        return 4
    if code == 0 and deadline is not None and time.monotonic() >= deadline:
        return 3
    return code


if __name__ == '__main__':
    raise SystemExit(dispatch(sys.argv[1:], sys.stdout))
