"""Memory-only preparation tests. Never run the capture CLI or any child."""
import ast
from contextlib import ExitStack, contextmanager
import ctypes
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent
SOURCE = (ROOT / 'descendant_capture.py').read_text(encoding='utf-8')
TREE = ast.parse(SOURCE)


@contextmanager
def forbidden_boundaries():
    def forbidden(*args, **kwargs):
        raise AssertionError('Real subprocess/native/network/delete forbidden')
    with ExitStack() as stack:
        for owner, names in ((subprocess, ('run', 'Popen', 'call', 'check_output', 'check_call')),
                             (ctypes, ('WinDLL', 'CDLL', 'PyDLL', 'OleDLL')),
                             (socket, ('socket', 'create_connection')),
                             (os, ('system', 'popen', 'kill', 'getpid', 'unlink', 'remove', 'rmdir', 'fsync')),
                             (shutil, ('rmtree',))):
            for name in names:
                stack.enter_context(patch.object(owner, name, side_effect=forbidden, create=True))
        yield


module = types.ModuleType('capture_preparation_tests')
module.__file__ = str(ROOT / 'descendant_capture.py')
assert all(isinstance(n, (ast.Import, ast.ImportFrom, ast.FunctionDef, ast.ClassDef,
                          ast.Assign, ast.Expr, ast.If)) for n in TREE.body)
for node in TREE.body:
    if isinstance(node, ast.If):
        assert ast.unparse(node.test) == "__name__ == '__main__'"
with forbidden_boundaries():
    exec(compile(TREE, module.__file__, 'exec'), module.__dict__)


class GateTests(unittest.TestCase):
    def test_default_and_incomplete_gates_do_nothing(self):
        for arguments in ([], ['--capture-descendant'],
                          ['--capture-descendant', '--preparation-reviewed'],
                          ['--capture-descendant', '--preparation-reviewed', '--execution-authorization', 'secret'],
                          ['--unknown-secret'], ['--help']):
            output = io.StringIO()
            with self.subTest(arguments=arguments):
                with patch.object(Path, 'mkdir', side_effect=AssertionError('mkdir forbidden')):
                    with patch.object(Path, 'open', side_effect=AssertionError('open forbidden')):
                        self.assertEqual(module.dispatch(arguments, output), 2 if arguments else 0)
            self.assertEqual(json.loads(output.getvalue()), {'result': 'NOT_RUN', 'reason': 'GATE', 'evidence_complete': False})


class Clock:
    def __init__(self): self.now = 0.0
    def __call__(self): return self.now


def valid_report():
    # Independent acceptance fixture, not imported from the candidate module.
    return {
        'result': 'UNKNOWN', 'phase': 'OBSERVE', 'winerror': 0,
        'candidate': True, 'evidence_complete': False,
        'root_owned': True, 'leaf_owned': True, 'transfer_ack': True,
        'root_force_requested': True, 'root_force_succeeded': True,
        'root_actual_exit': True, 'leaf_actual_exit': True,
        'leaf_natural_exit': True, 'control_observed': True,
        'abort_requested': False, 'job_terminate_succeeded': False,
        'containment_zero': False, 'resource_seconds': 6.0, 'samplecount': 3,
        'cleanup_failures': 0, 'handle_close_failures': 0,
        'view_release_failures': 0, 'attribute_release_failures': 0,
        'deadline_overrun': False, 'root_pid': 100, 'root_tid': 101,
        'root_creation_filetime': 0x123456789ABC, 'leaf_pid': 200, 'leaf_tid': 201,
        'leaf_creation_filetime': 0x23456789ABCD,
        'job_samples': [
            {'offset_seconds': offset, 'job_total': 2, 'job_active': 0,
             'job_assigned': 0, 'job_listed': 0, 'root_wait_result': 0, 'leaf_wait_result': 0}
            for offset in (0.0, 3.0, 6.0)],
    }


def encode(report):
    return json.dumps(report, separators=(',', ':')).encode('utf-8') + b'\n'


class MemoryFile(io.BytesIO):
    def __init__(self, fs, path):
        super().__init__()
        self.fs, self.path = fs, path
        self.fd = len(fs.fds) + 10
        fs.fds[self.fd] = path

    def write(self, data):
        self.fs.effect(self.path, 'write')
        if (self.path.name, 'partial') in self.fs.effects:
            super().write(data[:-1])
            return len(data) - 1
        return super().write(data)

    def flush(self):
        self.fs.effect(self.path, 'flush')
        return super().flush()

    def fileno(self):
        return self.fd

    def close(self):
        if not self.closed:
            self.fs.data[self.path] = self.getvalue()
            super().close()
            self.fs.effect(self.path, 'close')


class MemoryFS:
    def __init__(self, clock):
        self.clock, self.data, self.dirs = clock, {}, set()
        self.opens, self.mkdirs, self.fds, self.synced = [], [], {}, []
        self.effects = {}

    def effect(self, path, operation):
        effect = self.effects.get((path.name, operation))
        if effect == 'late':
            self.clock.now = 91
        elif effect:
            raise OSError('secret credential path')

    def open(self, path, mode='r', *args, **kwargs):
        self.opens.append((path, mode))
        self.effect(path, 'open')
        if mode != 'xb':
            raise AssertionError('Only exclusive binary writers are allowed')
        if path in self.data:
            raise FileExistsError('existing immutable artifact')
        self.data[path] = b''
        return MemoryFile(self, path)

    def mkdir(self, path, *args, **kwargs):
        self.mkdirs.append((path, args, kwargs))
        if kwargs != {'exist_ok': False} or args:
            raise AssertionError('No parent creation/overwrite')
        if path in self.dirs:
            raise FileExistsError('existing capture')
        if path.parent not in self.dirs:
            raise FileNotFoundError('missing parent')
        self.dirs.add(path)

    def read(self, path):
        self.effect(path, 'read')
        if path not in self.data:
            raise FileNotFoundError('missing fake file')
        return self.data[path]

    def sync(self, fd):
        path = self.fds[fd]
        self.synced.append(path)
        self.effect(path, 'fsync')


class FakeGit:
    def __init__(self, fs, root):
        self.fs, self.root, self.calls = fs, root, []
        self.commit, self.tree = 'a' * 40, 'b' * 40
        self.blobs = {name: str(index + 1) * 40 for index, name in enumerate(module.SOURCES)}
        self.dirty, self.stderr, self.status, self.timeout = b'', b'', 0, False
        self.after = None

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        if len(self.calls) == 5 and self.after:
            self.after()
        assert command[:6] == ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', str(self.root)]
        assert kwargs['capture_output'] is True and kwargs['check'] is False
        assert 0 < kwargs['timeout'] <= 90
        assert set(kwargs['env']) == {'SystemRoot'}
        if self.timeout:
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])
        args = command[6:]
        paths = ['scripts/' + name for name in module.SOURCES]
        if args == ['rev-parse', '--verify', 'HEAD']:
            stdout = self.commit.encode() + b'\n'
        elif args == ['rev-parse', '--verify', 'HEAD^{tree}']:
            stdout = self.tree.encode() + b'\n'
        elif args == ['status', '--porcelain=v1', '--untracked-files=all', '--', *paths]:
            stdout = self.dirty
        elif args == ['ls-tree', '--full-tree', 'HEAD', '--', *paths]:
            stdout = ''.join('100644 blob ' + self.blobs[name] + '\tscripts/' + name + '\n'
                             for name in module.SOURCES if name in self.blobs).encode()
        else:
            raise AssertionError('Only fixed read-only Git inspection is allowed')
        return types.SimpleNamespace(returncode=self.status, stdout=stdout, stderr=self.stderr)


class FakeChild:
    def __init__(self, clock):
        self.clock, self.calls = clock, []
        self.stdout, self.stderr, self.status = encode(valid_report()), b'', 2
        self.timeout, self.error, self.delay = False, None, 0

    def __call__(self, command, **kwargs):
        self.calls.append((command, kwargs))
        kwargs['stdout'].write(self.stdout)
        kwargs['stderr'].write(self.stderr)
        self.clock.now += self.delay
        if self.timeout:
            raise subprocess.TimeoutExpired(command, 90)
        if self.error:
            raise self.error
        return types.SimpleNamespace(returncode=self.status)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.fs = MemoryFS(self.clock)
        self.root = Path(module.__file__).parents[1]
        self.parent = Path('C:/CaptureParent' if os.name == 'nt' else '/capture-parent')
        self.system_root = 'C:/Windows' if os.name == 'nt' else '/windows'
        self.directory = self.parent / 'new-capture'
        self.fs.dirs.add(self.parent)
        # valid_binding checks paths using the test host's pathlib semantics.
        # Keep the fake interpreter absolute on both Windows and POSIX CI.
        self.executable = ('C:/Frozen/python.exe' if os.name == 'nt'
                           else '/frozen/python.exe')
        for name in module.SOURCES:
            self.fs.data[self.root / 'scripts' / name] = ('reviewed ' + name).encode()
        self.fs.data[Path(self.executable)] = b'frozen interpreter image'
        self.git = FakeGit(self.fs, self.root)
        self.child = FakeChild(self.clock)
        self.binding = {
            'version': 1, 'commit': 'a' * 40, 'tree': 'b' * 40,
            'internal_seconds': 60, 'external_seconds': 90,
            'sources': {name: {'sha256': hashlib.sha256(self.fs.data[self.root / 'scripts' / name]).hexdigest(),
                               'blob': self.git.blobs[name]} for name in module.SOURCES},
            'interpreter': {'path': self.executable,
                            'physical_path': str(Path(self.executable)),
                            'sha256': hashlib.sha256(b'frozen interpreter image').hexdigest()},
        }
        stack = ExitStack()
        self.addCleanup(stack.close)
        fs = self.fs
        for name, function in (
                ('open', lambda path, *args, **kwargs: fs.open(path, *args, **kwargs)),
                ('mkdir', lambda path, *args, **kwargs: fs.mkdir(path, *args, **kwargs)),
                ('read_bytes', lambda path: fs.read(path)),
                ('resolve', lambda path, *args, **kwargs: path),
                ('is_dir', lambda path: path in fs.dirs),
                ('is_file', lambda path: path in fs.data),
                ('exists', lambda path: path in fs.data or path in fs.dirs)):
            stack.enter_context(patch.object(Path, name, function))
        stack.enter_context(patch.object(sys, 'executable', self.executable))
        stack.enter_context(patch.dict(os.environ, {'SystemRoot': self.system_root, 'PRIVATE_CREDENTIAL': 'never pass'}, clear=True))

    def run_capture(self):
        answer, code = module.capture(self.binding, self.parent, 'new-capture', runner=self.child,
                                      git_runner=self.git, clock=self.clock, sync=self.fs.sync)
        self.assertLessEqual(len(self.child.calls), 1)
        self.assertNotIn('secret', json.dumps(answer))
        self.assertFalse(answer['evidence_complete'])
        return answer, code

    def receipt(self):
        return json.loads(self.fs.data[self.directory / 'receipt.json'])

    def assert_rejected(self, reason, code=3):
        answer, actual = self.run_capture()
        self.assertEqual((answer['result'], answer['reason'], actual), ('REJECTED', reason, code))
        return self.receipt()

    def test_valid_single_invocation_preserves_and_hashes_actual_raw_bytes(self):
        report = valid_report()
        # Deliberately not canonical JSON; the wrapper must never rewrite it.
        self.child.stdout = json.dumps(report, separators=(', ', ': ')).encode() + b'\r\n'
        answer, code = self.run_capture()
        self.assertEqual((answer['result'], code), ('CAPTURED_CANDIDATE', 0))
        receipt = self.receipt()
        self.assertEqual(receipt['before'], self.binding)
        self.assertEqual(receipt['after'], self.binding)
        self.assertEqual(receipt['control'], report)
        self.assertTrue(receipt['launch_attempted'])
        self.assertTrue(receipt['requires_exit_zero'])
        self.assertFalse(receipt['evidence_complete'])
        for key, data in (('stdout', self.child.stdout), ('stderr', b'')):
            self.assertEqual(self.fs.data[self.directory / (key + '.bin')], data)
            self.assertEqual(receipt['raw'][key], {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'durable': True})
        self.assertEqual([path.name for path in self.fs.synced], ['stdout.bin', 'stderr.bin', 'receipt.json'])
        self.assertEqual([path.name for path, mode in self.fs.opens], ['stdout.bin', 'stderr.bin', 'receipt.json'])
        self.assertTrue(all(mode == 'xb' for path, mode in self.fs.opens))
        command, options = self.child.calls[0]
        self.assertEqual(command, [self.executable, '-I', '-S', '-B', str(self.root / 'scripts' / 'descendant_preflight.py'),
                                   '--execute-descendant', '--preparation-reviewed', '--execution-authorization', 'capture-manual-gate'])
        self.assertEqual(options['cwd'], str(self.directory))
        self.assertEqual(options['env'], {'SystemRoot': self.system_root})
        self.assertEqual(options['timeout'], 90)
        self.assertEqual(options['stdin'], subprocess.DEVNULL)
        self.assertIs(options['check'], False)
        self.assertNotIn('PRIVATE_CREDENTIAL', self.fs.data[self.directory / 'receipt.json'].decode())

    def test_launch_timeout_consumes_remaining_shared_external_budget(self):
        git = self.git
        def slow_git(command, **kwargs):
            if not git.calls:
                self.clock.now += 30
            return git(command, **kwargs)
        self.git = slow_git
        answer, code = self.run_capture()
        self.assertEqual((answer['result'], code), ('CAPTURED_CANDIDATE', 0))
        self.assertEqual(self.child.calls[0][1]['timeout'], 60)

    def test_expired_prelaunch_budget_cannot_start_candidate(self):
        git = self.git
        def expired_git(command, **kwargs):
            self.clock.now = 91
            return git(command, **kwargs)
        self.git = expired_git
        answer, code = self.run_capture()
        self.assertEqual((answer['reason'], code), ('TIMEOUT', 2))
        self.assertFalse(self.child.calls)
        self.assertFalse(self.fs.mkdirs)

    def test_binding_mismatch_for_each_frozen_identity_never_creates_or_launches(self):
        for target in ('commit', 'tree', *module.SOURCES, 'interpreter', 'blob', 'physical_path'):
            with self.subTest(target=target):
                self.setUp()
                if target in ('commit', 'tree'):
                    self.binding[target] = 'c' * 40
                elif target in module.SOURCES:
                    self.binding['sources'][target]['sha256'] = 'f' * 64
                elif target == 'blob':
                    self.binding['sources']['descendant_capture.py']['blob'] = 'f' * 40
                else:
                    key = 'physical_path' if target == 'physical_path' else 'sha256'
                    self.binding['interpreter'][key] = (str(Path(self.executable).parent / 'different.exe')
                                                        if key == 'physical_path' else 'f' * 64)
                answer, code = self.run_capture()
                self.assertEqual((answer['reason'], code), ('BINDING', 2))
                self.assertFalse(self.child.calls)
                self.assertFalse(self.fs.mkdirs)
                self.assertFalse(self.fs.opens)

    def test_dirty_untracked_missing_or_unreadable_sources_are_prelaunch_rejections(self):
        for kind in ('dirty', 'untracked', 'missing_blob', 'git_error', 'git_stderr', 'bad_interpreter'):
            with self.subTest(kind=kind):
                self.setUp()
                if kind == 'dirty': self.git.dirty = b' M scripts/descendant_preflight.py\n'
                elif kind == 'untracked': self.git.dirty = b'?? scripts/descendant_capture.py\n'
                elif kind == 'missing_blob': del self.git.blobs['descendant_capture.py']
                elif kind == 'git_error': self.git.status = 128
                elif kind == 'git_stderr': self.git.stderr = b'secret credential diagnostic'
                else: sys.executable = 'py.exe'
                answer, code = self.run_capture()
                self.assertEqual(answer['result'], 'REJECTED')
                self.assertEqual(code, 2)
                self.assertFalse(self.child.calls)
                self.assertFalse(self.fs.mkdirs)

    def test_git_timeout_is_distinct_and_never_launches_or_creates(self):
        self.git.timeout = True
        answer, code = self.run_capture()
        self.assertEqual((answer['reason'], code), ('TIMEOUT', 2))
        self.assertFalse(self.child.calls)
        self.assertFalse(self.fs.mkdirs)
        self.assertFalse(self.fs.opens)

    def test_existing_directory_is_never_overwritten_or_retried(self):
        self.fs.dirs.add(self.directory)
        old = self.directory / 'receipt.json'
        self.fs.data[old] = b'original immutable bytes'
        answer, code = self.run_capture()
        self.assertEqual((answer['reason'], code), ('DIRECTORY', 2))
        self.assertEqual(self.fs.data[old], b'original immutable bytes')
        self.assertEqual(len(self.fs.mkdirs), 1)
        self.assertFalse(self.fs.opens)
        self.assertFalse(self.child.calls)

    def test_missing_parent_or_escaping_name_cannot_create_directory(self):
        self.fs.dirs.clear()
        answer, code = self.run_capture()
        self.assertEqual((answer['reason'], code), ('DIRECTORY', 2))
        self.assertFalse(self.fs.mkdirs)
        self.fs.dirs.add(self.parent)
        answer, code = module.capture(self.binding, self.parent, '../escape', runner=self.child,
                                      git_runner=self.git, clock=self.clock, sync=self.fs.sync)
        self.assertEqual((answer['reason'], code), ('DIRECTORY', 2))
        self.assertFalse(self.child.calls)

    def test_false_candidate_and_every_control_failure_are_rejected(self):
        values = {'candidate': False, 'result': 'PASS', 'phase': 'READY_LEAF', 'evidence_complete': True,
                  'root_owned': False, 'leaf_owned': False, 'transfer_ack': False,
                  'root_force_requested': False, 'root_force_succeeded': False, 'root_actual_exit': False,
                  'leaf_actual_exit': False, 'leaf_natural_exit': False, 'control_observed': False,
                  'abort_requested': True, 'job_terminate_succeeded': True, 'containment_zero': True,
                  'resource_seconds': 5.99, 'samplecount': 2, 'deadline_overrun': True,
                  'winerror': 5, 'cleanup_failures': 1, 'handle_close_failures': 1,
                  'view_release_failures': 1, 'attribute_release_failures': 1,
                  'root_pid': 0, 'leaf_pid': 100, 'root_tid': 0, 'leaf_tid': 1 << 32,
                  'root_creation_filetime': 0, 'leaf_creation_filetime': 1 << 64}
        for key, value in values.items():
            with self.subTest(key=key):
                self.setUp()
                report = valid_report()
                report[key] = value
                self.child.stdout = encode(report)
                self.assert_rejected('REPORT')

    def test_duplicate_offsets_or_duration_above_internal_budget_are_rejected(self):
        for offsets in ((0.0, 0.0, 6.0), (0.0, 500.0, 1000.0)):
            with self.subTest(offsets=offsets):
                self.setUp()
                report = valid_report()
                report['resource_seconds'] = offsets[-1]
                for sample, offset in zip(report['job_samples'], offsets):
                    sample['offset_seconds'] = offset
                self.child.stdout = encode(report)
                self.assert_rejected('REPORT')

    def test_dispatch_late_or_partial_output_cannot_return_ready(self):
        binding_path = self.parent / 'expected.json'
        self.fs.data[binding_path] = json.dumps(self.binding).encode()
        args = ['--capture-descendant', '--preparation-reviewed', '--execution-authorization', 'manual',
                '--expected-binding', str(binding_path), '--capture-parent', str(self.parent),
                '--capture-name', 'new-capture']
        clock = self.clock
        class Sink(io.StringIO):
            def __init__(self, kind):
                super().__init__()
                self.kind = kind
            def write(self, text):
                super().write(text)
                return len(text) - 1 if self.kind == 'partial' else len(text)
            def flush(self):
                if self.kind == 'late':
                    clock.now = 91
        for kind, expected in (('late', 3), ('partial', 4)):
            clock.now = 0
            output = Sink(kind)
            with patch.object(module, 'capture', return_value=(module.summary('CAPTURED_CANDIDATE', 'OK'), 0)):
                with patch.object(module.time, 'monotonic', clock):
                    self.assertEqual(module.dispatch(args, output), expected)

    def test_audit_samples_require_actual_exact_zero_receipts_and_six_seconds(self):
        for problem in ('total', 'active', 'assigned', 'listed', 'root_wait', 'leaf_wait',
                        'first_offset', 'decreasing', 'end_mismatch', 'extra_key', 'missing_key',
                        'count_mismatch', 'sample_cap', 'bool_counter', 'nan_offset'):
            with self.subTest(problem=problem):
                self.setUp()
                report = valid_report()
                sample = report['job_samples'][1]
                changes = {'total': ('job_total', 3), 'active': ('job_active', 1),
                           'assigned': ('job_assigned', 1), 'listed': ('job_listed', 1),
                           'root_wait': ('root_wait_result', 258), 'leaf_wait': ('leaf_wait_result', 258),
                           'bool_counter': ('job_total', True), 'nan_offset': ('offset_seconds', float('nan'))}
                if problem in changes:
                    key, value = changes[problem]
                    sample[key] = value
                elif problem == 'first_offset': report['job_samples'][0]['offset_seconds'] = 0.1
                elif problem == 'decreasing': sample['offset_seconds'] = 7
                elif problem == 'end_mismatch': report['resource_seconds'] = 6.1
                elif problem == 'extra_key': sample['secret'] = 'credential'
                elif problem == 'missing_key': del sample['job_listed']
                elif problem == 'count_mismatch': report['samplecount'] = 4
                else: report['samplecount'] = 129
                self.child.stdout = encode(report)
                self.assert_rejected('REPORT')

    def test_malformed_trailing_multiobject_duplicate_nonfinite_and_extra_keys(self):
        raw = encode(valid_report())
        for payload in (b'', b'{}\n', b'secret exception text\n', raw + raw, raw + b'trailing',
                        raw[:-1] + b' \n', b' ' + raw, raw + b'\n', raw[:-1],
                        raw.replace(b'"candidate":true', b'"candidate":true,"candidate":true'),
                        raw.replace(b'"resource_seconds":6.0', b'"resource_seconds":NaN'),
                        raw[:-2] + b',"secret":"credential"}\n'):
            with self.subTest(payload=payload[:20]):
                self.setUp()
                self.child.stdout = payload
                self.assert_rejected('REPORT')

    def test_child_status_four_with_true_line_and_nonempty_stderr_are_rejected(self):
        for status in (0, 1, 3, 4, -1, None, True):
            with self.subTest(status=status):
                self.setUp()
                self.child.status = status
                receipt = self.assert_rejected('EXIT')
                self.assertEqual(self.fs.data[self.directory / 'stdout.bin'], self.child.stdout)
                self.assertEqual(receipt['result'], 'REJECTED')
        self.setUp()
        self.child.stderr = b'secret error text\n'
        receipt = self.assert_rejected('STDERR')
        self.assertEqual(receipt['raw']['stderr']['sha256'], hashlib.sha256(self.child.stderr).hexdigest())

    def test_timeout_or_launch_exception_retains_raw_and_never_retries(self):
        for kind in ('timeout', 'exception', 'write_error'):
            with self.subTest(kind=kind):
                self.setUp()
                if kind == 'timeout': self.child.timeout = True
                elif kind == 'exception': self.child.error = RuntimeError('secret credential')
                else: self.child.error = OSError('secret credential')
                self.assert_rejected({'timeout': 'TIMEOUT', 'exception': 'RUNNER', 'write_error': 'CAPTURE_IO'}[kind])
                self.assertEqual(len(self.child.calls), 1)
                self.assertEqual(self.fs.data[self.directory / 'stdout.bin'], self.child.stdout)

    def test_after_source_interpreter_blob_commit_tree_or_dirty_change_rejects(self):
        for kind in (*module.SOURCES, 'interpreter', 'physical_path', 'blob', 'commit', 'tree', 'dirty'):
            with self.subTest(kind=kind):
                self.setUp()
                def change():
                    if kind in module.SOURCES:
                        self.fs.data[self.root / 'scripts' / kind] += b' changed'
                    elif kind == 'interpreter': self.fs.data[Path(self.executable)] += b' changed'
                    elif kind == 'physical_path': sys.executable = str(Path(self.executable).parent / 'Different.exe')
                    elif kind == 'blob': self.git.blobs['descendant_capture.py'] = 'f' * 40
                    elif kind in ('commit', 'tree'): setattr(self.git, kind, 'f' * 40)
                    else: self.git.dirty = b' M scripts/one_root_preflight.py\n'
                self.git.after = change
                receipt = self.assert_rejected('UNSTABLE')
                self.assertEqual(receipt['before'], self.binding)
                self.assertEqual(len(self.child.calls), 1)

    def test_stdout_stderr_flush_fsync_close_or_write_failures_reject(self):
        for name in ('stdout.bin', 'stderr.bin'):
            for operation in ('write', 'flush', 'fsync', 'close'):
                with self.subTest(name=name, operation=operation):
                    self.setUp()
                    self.fs.effects[(name, operation)] = 'fail'
                    self.assert_rejected('CAPTURE_IO')
                    self.assertEqual(len(self.child.calls), 1)
                    self.assertIn(self.directory / 'stdout.bin', self.fs.data)
                    self.assertIn(self.directory / 'stderr.bin', self.fs.data)
                    self.assertEqual(sum(path.name == 'receipt.json' for path, mode in self.fs.opens), 1)

    def test_each_preopen_failure_prevents_child_and_still_has_one_final_receipt_attempt(self):
        for name in ('stdout.bin', 'stderr.bin'):
            with self.subTest(name=name):
                self.setUp()
                self.fs.effects[(name, 'open')] = 'fail'
                receipt = self.assert_rejected('CAPTURE_IO')
                self.assertFalse(receipt['launch_attempted'])
                self.assertFalse(self.child.calls)
                self.assertEqual(sum(path.name == 'receipt.json' for path, mode in self.fs.opens), 1)

    def test_receipt_write_flush_fsync_close_partial_or_existing_file_cannot_claim_ready(self):
        for operation in ('open', 'write', 'flush', 'fsync', 'close', 'partial', 'existing'):
            with self.subTest(operation=operation):
                self.setUp()
                if operation == 'existing':
                    self.fs.data[self.directory / 'receipt.json'] = b'prior bytes'
                else:
                    self.fs.effects[('receipt.json', operation)] = 'fail'
                answer, code = self.run_capture()
                self.assertEqual((answer['result'], answer['reason'], code), ('REJECTED', 'RECEIPT_IO', 4))
                self.assertEqual(sum(path.name == 'receipt.json' for path, mode in self.fs.opens), 1)
                self.assertEqual(self.fs.data[self.directory / 'stdout.bin'], self.child.stdout)
                if operation == 'existing':
                    self.assertEqual(self.fs.data[self.directory / 'receipt.json'], b'prior bytes')

    def test_late_capture_or_receipt_fsync_is_not_capture_ready(self):
        for operation in ('child', 'receipt'):
            with self.subTest(operation=operation):
                self.setUp()
                if operation == 'child': self.child.delay = 91
                else: self.fs.effects[('receipt.json', 'fsync')] = 'late'
                answer, code = self.run_capture()
                self.assertEqual((answer['result'], answer['reason'], code), ('REJECTED', 'TIMEOUT', 3))
                self.assertEqual(len(self.child.calls), 1)
                self.assertTrue(self.receipt()['requires_exit_zero'])

    def test_read_failure_never_substitutes_empty_raw_hash(self):
        self.fs.effects[('stdout.bin', 'read')] = 'fail'
        receipt = self.assert_rejected('CAPTURE_IO')
        self.assertIsNone(receipt['raw']['stdout']['sha256'])
        self.assertIsNone(receipt['raw']['stdout']['bytes'])
        self.assertEqual(receipt['raw']['stderr']['sha256'], hashlib.sha256(b'').hexdigest())

    def test_binding_gate_missing_or_malformed_is_not_run_and_unexpected_capture_error_is_rejected(self):
        binding_path = self.parent / 'expected.json'
        arguments = ['--capture-descendant', '--preparation-reviewed', '--execution-authorization', 'secret credential',
                     '--expected-binding', str(binding_path), '--capture-parent', str(self.parent), '--capture-name', 'new-capture']
        for data in (None, b'{}', b'not json'):
            with self.subTest(data=data):
                if data is not None:
                    self.fs.data[binding_path] = data
                output = io.StringIO()
                self.assertEqual(module.dispatch(arguments, output), 2)
                self.assertEqual(json.loads(output.getvalue())['result'], 'NOT_RUN')
                self.assertFalse(self.fs.mkdirs)
                self.assertFalse(self.git.calls)
                self.assertFalse(self.child.calls)
        self.fs.data[binding_path] = json.dumps(self.binding).encode()
        output = io.StringIO()
        with patch.object(module, 'capture', side_effect=RuntimeError('secret credential')):
            self.assertEqual(module.dispatch(arguments, output), 4)
        self.assertEqual(json.loads(output.getvalue()), {'result': 'REJECTED', 'reason': 'INTERNAL', 'evidence_complete': False})

    def test_fixed_source_surface_has_no_process_manager_or_deletion_apis(self):
        calls = [node for node in ast.walk(TREE) if isinstance(node, ast.Call)]
        names = {node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id
                 for node in calls if isinstance(node.func, (ast.Attribute, ast.Name))}
        self.assertFalse(names & {'Popen', 'kill', 'terminate', 'OpenProcess', 'OpenThread',
                                 'WinDLL', 'CDLL', 'unlink', 'remove', 'rmdir', 'rmtree', 'socket'})
        self.assertEqual(sum(isinstance(node.func, ast.Attribute) and node.func.attr == 'mkdir' for node in calls), 1)
        self.assertEqual(SOURCE.count("directory / 'receipt.json'"), 1)
        self.assertLessEqual(len(SOURCE.splitlines()), 330)
        for node in TREE.body:
            if isinstance(node, ast.Assign):
                self.assertEqual(ast.literal_eval(node.value),
                                 ('descendant_capture.py', 'descendant_preflight.py', 'one_root_preflight.py'))

    def test_binding_schema_freezes_limits_and_all_dependencies(self):
        for key, value in (('internal_seconds', 61), ('external_seconds', 91), ('version', True),
                           ('commit', 'not a hash'), ('extra', 'credential')):
            invalid = json.loads(json.dumps(self.binding))
            invalid[key] = value
            self.assertFalse(module.valid_binding(invalid))
        invalid = json.loads(json.dumps(self.binding))
        del invalid['sources']['one_root_preflight.py']
        self.assertFalse(module.valid_binding(invalid))
        self.assertEqual(module.summary('REJECTED', 'secret credential')['reason'], 'INTERNAL')


if __name__ == '__main__':
    with forbidden_boundaries():
        unittest.main(verbosity=2)
