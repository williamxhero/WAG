"""Preparation only: AST/in-memory compilation and a fake kernel, never native."""
import ast
import ctypes
from contextlib import ExitStack, contextmanager
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
ROOT = Path(__file__).parent
SOURCE = (ROOT / 'descendant_preflight.py').read_text(encoding='utf-8')
TREE = ast.parse(SOURCE)


@contextmanager
def forbidden_boundaries():
    def forbidden(*args, **kwargs):
        raise AssertionError('Real DLL/process/network/delete boundary forbidden')
    class Loader:
        def __getattr__(self, name):
            return forbidden()
    with ExitStack() as stack:
        for name in ('WinDLL', 'CDLL', 'PyDLL', 'OleDLL'):
            stack.enter_context(patch.object(ctypes, name, side_effect=forbidden, create=True))
        for name in ('windll', 'cdll', 'pydll', 'oledll'):
            stack.enter_context(patch.object(ctypes, name, Loader(), create=True))
        for owner, names in ((subprocess, ('Popen', 'run', 'call', 'check_call', 'check_output')),
                             (os, ('system', 'popen', 'kill', 'getpid', 'startfile', 'unlink', 'remove', 'rmdir')),
                             (shutil, ('rmtree',)), (socket, ('socket', 'create_connection'))):
            for name in names:
                stack.enter_context(patch.object(owner, name, side_effect=forbidden, create=True))
        yield


def load_candidate():
    # Review both modules before executing definitions. No CLI/role is invoked.
    baseline = (ROOT / 'one_root_preflight.py').read_text(encoding='utf-8')
    for text in (baseline, SOURCE):
        tree = ast.parse(text)
        for node in tree.body:
            assert isinstance(node, (ast.Import, ast.ImportFrom, ast.FunctionDef,
                                     ast.ClassDef, ast.If, ast.Assign, ast.Expr))
            if isinstance(node, ast.If):
                assert ast.unparse(node.test) == "__name__ == '__main__'"
            if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
                assert not node.decorator_list
        compile(tree, '<reviewed-preparation>', 'exec')
    module = types.ModuleType('descendant_preparation_test')
    module.__file__ = str(ROOT / 'descendant_preflight.py')
    with forbidden_boundaries():
        exec(compile(TREE, module.__file__, 'exec'), module.__dict__)
    return module


module = load_candidate()


class Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class PreparationTests(unittest.TestCase):
    def test_import_and_default_do_not_construct_native(self):
        output = io.StringIO()
        with patch.object(module, 'Native', side_effect=AssertionError('native forbidden')):
            with patch.object(sys, 'stdout', output):
                self.assertEqual(module.main([]), 0)
        self.assertEqual(json.loads(output.getvalue()), {
            'result': 'NOT_RUN', 'candidate': False, 'evidence_complete': False})

    def test_manual_gates_are_nonempty_and_parser_errors_do_not_echo_input(self):
        cases = (['--execute-descendant'],
                 ['--execute-descendant', '--preparation-reviewed'],
                 ['--execute-descendant', '--preparation-reviewed', '--execution-authorization', ''],
                 ['--execute-descendant', '--preparation-reviewed', '--execution-authorization', '   '],
                 ['--preparation-reviewed', '--execution-authorization', 'secret credential'],
                 ['--execute-descendant', '--preparation-reviewed', '--execution-authorization'],
                 ['--unknown-secret-credential'], ['--help'])
        for arguments in cases:
            output, errors = io.StringIO(), io.StringIO()
            with self.subTest(arguments=arguments):
                with patch.object(module, 'Native', side_effect=AssertionError('native forbidden')):
                    with patch.object(sys, 'stdout', output), patch.object(sys, 'stderr', errors):
                        self.assertEqual(module.main(arguments), 2)
                self.assertEqual(errors.getvalue(), '')
                self.assertEqual(json.loads(output.getvalue()), {
                    'result': 'NOT_RUN', 'candidate': False, 'evidence_complete': False})

    def test_absolute_budget_never_resets_deadline(self):
        clock = Clock()
        budget = module.absolute_budget('150000000000', clock)
        self.assertEqual(budget.deadline, 150)
        clock.now = 149.9999
        with self.assertRaises(module.Deadline):
            budget.milliseconds()
        for value in ('0', '-1', '+150000000000', '1e10', 'NaN', ' 150000000000',
                      '0150000000000', '211000000000'):
            with self.subTest(value=value), self.assertRaises(module.Fault):
                module.absolute_budget(value, clock)


    def test_deadline_wire_value_is_not_rounded_again_between_roles(self):
        clock = Clock()
        text = '150000000001'
        budget = module.absolute_budget(text, clock)
        self.assertEqual(budget.deadline_ns, 150000000001)
        self.assertEqual(budget.deadline_ns, int(text))

    def test_report_sink_failure_and_late_output_cannot_claim_completion(self):
        clock = Clock()
        budget = module.Budget(clock)
        report = module.new_report()
        report['candidate'] = True
        class Sink:
            def __init__(self, failure=None, late=False):
                self.text, self.failure, self.late = '', failure, late
            def write(self, text):
                if self.failure == 'write':
                    raise OSError('secret path')
                self.text += text
                if self.late:
                    clock.now = budget.deadline + 1
            def flush(self):
                if self.failure == 'flush':
                    raise OSError('secret path')
        for failure in ('write', 'flush'):
            sink = Sink(failure)
            self.assertEqual(module.emit_report(report, budget, sink), 4)
            self.assertNotIn('secret', sink.text)
        sink = Sink(late=True)
        self.assertEqual(module.emit_report(report, budget, sink), 3)
        self.assertEqual(report['result'], 'TIMEOUT')
        self.assertFalse(report['candidate'])
        self.assertFalse(report['evidence_complete'])
        output = io.StringIO()
        self.assertEqual(module.emit_report(report, budget, output), 3)
        self.assertEqual(json.loads(output.getvalue())['result'], 'TIMEOUT')

    def test_flush_failure_preserves_raw_true_line_but_returns_failure(self):
        report = module.new_report()
        report['candidate'] = True
        class Sink(io.StringIO):
            def flush(self):
                raise OSError('private failure')
        sink = Sink()
        self.assertEqual(module.emit_report(report, module.Budget(Clock()), sink), 4)
        self.assertTrue(json.loads(sink.getvalue())['candidate'])
        self.assertFalse(report['candidate'])
        self.assertFalse(json.loads(sink.getvalue())['evidence_complete'])

    def test_payload_validates_numeric_receipt_and_sample_whitelists(self):
        report = module.new_report()
        report['root_creation_filetime'] = 134373011448073053
        self.assertEqual(json.loads(module.safe_payload(report))['root_creation_filetime'],
                         134373011448073053)
        for value in ('private', True, -1, 1 << 64):
            bad = dict(report, root_creation_filetime=value)
            with self.subTest(value=value), self.assertRaises(module.Fault):
                module.safe_payload(bad)
        good = {'offset_seconds': 0.0, 'job_total': 2, 'job_active': 0,
                'job_assigned': 0, 'job_listed': 0,
                'root_wait_result': 0, 'leaf_wait_result': 0}
        for sample in (dict(good, secret='private'), dict(good, job_total=True),
                       dict(good, offset_seconds=float('nan')), 'private'):
            bad = dict(report, job_samples=[sample], samplecount=1)
            with self.subTest(sample=sample), self.assertRaises(module.Fault):
                module.safe_payload(bad)
        with self.assertRaises(module.Fault):
            module.safe_payload(dict(report, job_samples=[good], samplecount=0))
        with self.assertRaises(module.Fault):
            module.safe_payload(dict(report, job_samples=[good] * 129, samplecount=129))

    def test_payload_refuses_unknown_fields_types_and_free_text(self):
        for key, value in (('result', 'PASS'), ('phase', 'secret'), ('winerror', 'secret'),
                           ('candidate', 1), ('samplecount', -1), ('resource_seconds', float('nan')),
                           ('evidence_complete', True), ('extra', 'secret')):
            report = module.new_report()
            report[key] = value
            with self.subTest(key=key), self.assertRaises(module.Fault):
                module.safe_payload(report)


class StateBackend:
    """State seam only; separate tests below exercise REAL Native methods."""
    def __init__(self, budget, clock, fail=None, late=None):
        self.budget, self.clock, self.fail, self.late = budget, clock, fail, late
        self.calls, self.closed = [], False

    def action(self, name, value=None):
        self.calls.append(name)
        if self.late == name:
            self.clock.now = self.budget.deadline + 1
        if self.fail == name:
            raise module.Fault(5)
        return value

    def prepare(self): self.action('prepare')
    def create_root(self): self.action('create_root')
    def identity_root(self): return self.action('identity_root', True)
    def root_evidence(self):
        return self.action('root_evidence', {
            'root_pid': 10, 'root_tid': 11, 'root_creation_filetime': 123466})
    def resume_root(self): return self.action('resume_root', 1)
    def wait_publish(self, ms): return self.action('wait_publish', 0)
    def transfer(self): self.action('transfer')
    def identity_leaf(self): return self.action('identity_leaf', True)
    def leaf_evidence(self):
        return self.action('leaf_evidence', {
            'leaf_pid': 20, 'leaf_tid': 21, 'leaf_creation_filetime': 123476})
    def acknowledge(self): self.action('acknowledge')
    def alive_root(self): return self.action('alive_root', True)
    def resume_leaf(self): return self.action('resume_leaf', 1)
    def wait_leaf_ready(self, ms): return self.action('wait_leaf_ready', 0)
    def alive_leaf(self): return self.action('alive_leaf', True)
    def force_root(self, report):
        report['root_force_requested'] = True
        self.action('force_root')
        report['root_force_succeeded'] = True
    def wait_root(self, ms): return self.action('wait_root', 0)
    def root_exit_code(self): return self.action('root_exit_code', 91)
    def go_leaf(self): self.action('go_leaf')
    def wait_leaf(self, ms): return self.action('wait_leaf', 0)
    def leaf_exit_code(self): return self.action('leaf_exit_code', 0)
    def sample(self): return self.action('sample', True)
    def sample_evidence(self):
        return self.action('sample_evidence', {
            'job_total': 2, 'job_active': 0, 'job_assigned': 0, 'job_listed': 0,
            'root_wait_result': 0, 'leaf_wait_result': 0})
    def pace(self, ms):
        self.clock.now += ms / 1000
        return self.action('pace', 258)
    def cleanup(self, report):
        self.closed = True
        if not report['control_observed']:
            report['abort_requested'] = True
        self.action('cleanup')


class StateTests(unittest.TestCase):
    def run_case(self, fail=None, late=None, change=None):
        clock, holders = Clock(), []
        def factory(budget):
            backend = StateBackend(budget, clock, fail, late)
            holders.append(backend)
            if change:
                change(backend)
            return backend
        report, budget = module.run_state(factory, clock)
        self.assertEqual(budget.deadline, 160)
        self.assertTrue(holders[0].closed)
        self.assertFalse(report['evidence_complete'])
        self.assertIn(report['result'], ('UNKNOWN', 'TIMEOUT'))
        return report, holders[0]

    def test_control_is_unknown_not_pass_with_distinct_expected_force(self):
        report, backend = self.run_case()
        self.assertTrue(report['candidate'])
        self.assertTrue(report['root_force_requested'])
        self.assertTrue(report['root_force_succeeded'])
        self.assertTrue(report['root_actual_exit'])
        self.assertTrue(report['leaf_actual_exit'])
        self.assertTrue(report['leaf_natural_exit'])
        self.assertFalse(report['abort_requested'])
        self.assertFalse(report['job_terminate_succeeded'])
        self.assertGreaterEqual(report['resource_seconds'], 6)
        self.assertGreaterEqual(report['samplecount'], 3)
        self.assertEqual(backend.calls.count('resume_root'), 1)
        self.assertEqual(backend.calls.count('resume_leaf'), 1)
        self.assertLess(backend.calls.index('identity_leaf'), backend.calls.index('acknowledge'))
        self.assertLess(backend.calls.index('wait_root'), backend.calls.index('go_leaf'))
        self.assertEqual(backend.calls[backend.calls.index('wait_root') + 2], 'alive_leaf')

    def test_every_failure_stops_normal_stages_and_always_cleans(self):
        stages = ('prepare', 'create_root', 'identity_root', 'root_evidence', 'resume_root',
                  'wait_publish', 'transfer', 'identity_leaf', 'leaf_evidence', 'acknowledge',
                  'alive_root', 'resume_leaf', 'wait_leaf_ready', 'alive_leaf',
                  'force_root', 'wait_root', 'root_exit_code', 'go_leaf',
                  'wait_leaf', 'leaf_exit_code', 'sample', 'sample_evidence', 'pace')
        for stage in stages:
            with self.subTest(stage=stage):
                report, backend = self.run_case(fail=stage)
                self.assertFalse(report['candidate'])
                self.assertEqual(backend.calls[-2:], [stage, 'cleanup'])
                if stage in stages[:stages.index('resume_root')]:
                    self.assertNotIn('resume_root', backend.calls)
                if stage in stages[:stages.index('resume_leaf')]:
                    self.assertNotIn('resume_leaf', backend.calls)
                self.assertTrue(report['abort_requested'])

    def test_every_late_result_times_out_without_next_stage(self):
        stages = ('prepare', 'create_root', 'identity_root', 'root_evidence', 'resume_root',
                  'wait_publish', 'transfer', 'identity_leaf', 'leaf_evidence', 'acknowledge',
                  'alive_root', 'resume_leaf', 'wait_leaf_ready', 'alive_leaf',
                  'force_root', 'wait_root', 'root_exit_code', 'go_leaf',
                  'wait_leaf', 'leaf_exit_code', 'sample', 'sample_evidence', 'pace', 'cleanup')
        for stage in stages:
            with self.subTest(stage=stage):
                report, backend = self.run_case(late=stage)
                self.assertEqual(report['result'], 'TIMEOUT')
                self.assertFalse(report['candidate'])
                if stage != 'cleanup':
                    self.assertEqual(backend.calls[-2:], [stage, 'cleanup'])

    def test_false_identity_does_not_resume_or_ack(self):
        for stage, forbidden in (('identity_root', 'resume_root'), ('identity_leaf', 'acknowledge')):
            def change(backend):
                setattr(backend, stage, lambda: backend.action(stage, False))
            report, backend = self.run_case(change=change)
            self.assertFalse(report['candidate'])
            self.assertNotIn(forbidden, backend.calls)
            self.assertNotIn('resume_leaf', backend.calls)

    def test_abnormal_resume_is_never_retried(self):
        for stage in ('resume_root', 'resume_leaf'):
            for value in (0, 2, 0xFFFFFFFF):
                def change(backend):
                    setattr(backend, stage, lambda: backend.action(stage, value))
                with self.subTest(stage=stage, value=value):
                    report, backend = self.run_case(change=change)
                    self.assertFalse(report['candidate'])
                    self.assertEqual(backend.calls.count(stage), 1)
                    self.assertNotIn('go_leaf', backend.calls)

    def test_wait_failures_and_timeouts_never_mean_actual_exit(self):
        for stage in ('wait_publish', 'wait_leaf_ready', 'wait_root', 'wait_leaf'):
            for value in (258, 128, 0xFFFFFFFF):
                def change(backend):
                    setattr(backend, stage, lambda ms: backend.action(stage, value))
                with self.subTest(stage=stage, value=value):
                    report, backend = self.run_case(change=change)
                    self.assertEqual(report['result'], 'TIMEOUT' if value == 258 else 'UNKNOWN')
                    self.assertFalse(report['leaf_natural_exit'])
                    if stage != 'wait_leaf':
                        self.assertNotIn('go_leaf', backend.calls)

    def test_candidate_preserves_numeric_creation_and_each_job_sample(self):
        report, _ = self.run_case()
        self.assertEqual((report['root_pid'], report['root_tid'], report['root_creation_filetime']),
                         (10, 11, 123466))
        self.assertEqual((report['leaf_pid'], report['leaf_tid'], report['leaf_creation_filetime']),
                         (20, 21, 123476))
        samples = report['job_samples']
        self.assertEqual(len(samples), report['samplecount'])
        self.assertEqual(samples[0]['offset_seconds'], 0.0)
        self.assertEqual(samples[-1]['offset_seconds'], report['resource_seconds'])
        self.assertGreaterEqual(samples[-1]['offset_seconds'], 6)
        for sample in samples:
            self.assertEqual({key: value for key, value in sample.items() if key != 'offset_seconds'}, {
                'job_total': 2, 'job_active': 0, 'job_assigned': 0, 'job_listed': 0,
                'root_wait_result': 0, 'leaf_wait_result': 0,
            })

    def test_early_leaf_and_nonzero_exit_stop_control(self):
        for stage, value in (('alive_leaf', False), ('leaf_exit_code', 95), ('root_exit_code', 0)):
            def change(backend):
                setattr(backend, stage, lambda: backend.action(stage, value))
            report, backend = self.run_case(change=change)
            self.assertFalse(report['candidate'])
            self.assertFalse(report['leaf_natural_exit'])

    def test_observation_minimum_sample_count_cap_and_no_progress(self):
        def no_progress(backend):
            backend.pace = lambda ms: backend.action('pace', 258)
        report, _ = self.run_case(change=no_progress)
        self.assertFalse(report['candidate'])
        def tiny_progress(backend):
            def pace(ms):
                backend.clock.now += 0.001
                return backend.action('pace', 258)
            backend.pace = pace
        report, _ = self.run_case(change=tiny_progress)
        self.assertFalse(report['candidate'])
        self.assertEqual(report['samplecount'], 128)
        def slow_second(backend):
            calls = []
            def sample():
                if calls:
                    backend.clock.now += 6.1
                calls.append(1)
                return backend.action('sample', True)
            backend.sample = sample
        report, _ = self.run_case(change=slow_second)
        self.assertEqual(report['samplecount'], 2)
        self.assertFalse(report['candidate'])

    def test_first_query_time_is_excluded_and_full_six_seconds_reserved(self):
        def change(backend):
            calls = []
            def sample():
                if not calls:
                    backend.clock.now += 20
                calls.append(backend.clock.now)
                return backend.action('sample', True)
            backend.sample = sample
        report, _ = self.run_case(change=change)
        self.assertTrue(report['candidate'])
        self.assertGreaterEqual(report['resource_seconds'], 6)
        def late_first(backend):
            def sample():
                backend.clock.now = 155
                return backend.action('sample', True)
            backend.sample = sample
        report, _ = self.run_case(change=late_first)
        self.assertEqual(report['result'], 'TIMEOUT')
        self.assertEqual(report['samplecount'], 1)

    def test_cleanup_and_arbitrary_error_are_sanitized(self):
        report, _ = self.run_case(fail='cleanup')
        self.assertFalse(report['candidate'])
        self.assertEqual(report['cleanup_failures'], 1)
        def change(backend):
            def fail():
                raise RuntimeError('secret command environment credential')
            backend.transfer = fail
        report, _ = self.run_case(change=change)
        payload = module.safe_payload(report)
        self.assertNotIn('secret', payload)
        self.assertEqual(set(report), set(module.new_report()))


class KernelFunction:
    def __init__(self, kernel, name):
        self.kernel, self.name = kernel, name

    def __call__(self, *args):
        return self.kernel.invoke(self.name, args)


class Kernel:
    """A memory-only Win32 boundary. No process, DLL, file or delete APIs run."""
    def __init__(self, clock):
        self.clock, self.functions, self.calls, self.counts = clock, {}, [], {}
        self.handles, self.remote, self.buffers = {}, {}, []
        self.views, self.closed, self.deleted = [], [], []
        self.effects, self.error, self.next_handle = {}, 0, 1000
        self.total, self.job, self.mapping = 0, None, None
        self.events, self.root, self.leaf = [], None, None
        self.auto_publish, self.ack_signaled = False, False
        self.accounting_override, self.inventory_override = None, None
        self.bad_identity, self.resume_result = None, 1

    def __getattr__(self, name):
        return self.functions.setdefault(name, KernelFunction(self, name))

    def acquire(self, kind, inherit=False, obj=None):
        value = self.next_handle
        self.next_handle += 4
        self.handles[value] = {'kind': kind, 'inherit': inherit,
                               'obj': {} if obj is None else obj}
        return value

    def invoke(self, name, args):
        self.calls.append((name, args))
        self.counts[name] = self.counts.get(name, 0) + 1
        effect = self.effects.get((name, self.counts[name]), self.effects.get(name, {}))
        if effect.get('raise'):
            raise RuntimeError('untrusted error secret path')
        if effect.get('fail'):
            self.error = effect.get('error', 6)
            if effect.get('late'):
                self.clock.now = 161
            return 0xFFFFFFFF if name == 'WaitForSingleObject' else 0
        result = self.normal(name, args)
        if effect.get('after'):
            effect['after'](args, result)
        if effect.get('late'):
            self.clock.now = 161
        return result

    def object(self, handle):
        return self.handles[handle]['obj']

    def make_pair(self, pid, tid):
        process = {'pid': pid, 'birth': 123456 + pid, 'alive': True, 'exit': 259}
        thread = {'tid': tid, 'owner': process}
        return process, thread

    def publish(self, native, **changes):
        if self.leaf is None:
            self.leaf, thread = self.make_pair(20, 21)
            self.remote[200] = {'kind': 'process', 'inherit': False, 'obj': self.leaf}
            self.remote[204] = {'kind': 'thread', 'inherit': False, 'obj': thread}
            self.total += 1
        transfer = native.Transfer.from_address(native.view)
        values = {'version': 1, 'size': 48, 'published': 1, 'reserved': 0,
                  'process_slot': 200, 'thread_slot': 204, 'pid': 20,
                  'tid': 21, 'birth': self.leaf['birth']}
        values.update(changes)
        for key, value in values.items():
            setattr(transfer, key, value)

    def normal(self, name, args):
        if name == 'CreateJobObjectW':
            self.job = self.acquire('job')
            return self.job
        if name == 'SetInformationJobObject':
            self.limit = args[2]._obj.basic.flags
            return 1
        if name == 'QueryInformationJobObject':
            value, kind = args[2]._obj, args[1]
            if kind == 9:
                value.basic.flags = self.limit
            elif kind == 1:
                alive = sum(int(p['alive']) for p in (self.root, self.leaf) if p is not None)
                value.total, value.active = self.accounting_override or (self.total, alive)
            elif kind == 3:
                alive = [p['pid'] for p in (self.root, self.leaf) if p and p['alive']]
                assigned, listed = self.inventory_override or (len(alive), len(alive))
                value.assigned, value.listed = assigned, listed
                for index, pid in enumerate(alive[:len(value.ids)]):
                    value.ids[index] = pid
            return 1
        if name == 'CreateFileMappingW':
            buffer = ctypes.create_string_buffer(args[4])
            self.buffers.append(buffer)
            self.mapping = self.acquire('mapping', obj={'buffer': buffer})
            return self.mapping
        if name == 'MapViewOfFile':
            view = ctypes.addressof(self.object(args[0])['buffer'])
            self.views.append(view)
            return view
        if name == 'UnmapViewOfFile':
            self.views.remove(args[0])
            return 1
        if name == 'CreateEventW':
            value = self.acquire('event', obj={'signaled': False, 'index': len(self.events)})
            self.events.append(value)
            return value
        if name == 'GetHandleInformation':
            args[1]._obj.value = int(self.handles[args[0]]['inherit'])
            return 1
        if name == 'SetHandleInformation':
            self.handles[args[0]]['inherit'] = bool(args[2] & 1)
            return 1
        if name == 'GetCurrentProcess':
            return -1
        if name == 'DuplicateHandle':
            source = self.handles.get(args[1]) if args[0] == -1 else self.remote.get(args[1])
            if not source:
                self.error = 6
                return 0
            value = self.acquire(source['kind'], bool(args[5]), source['obj'])
            args[3]._obj.value = value
            return 1
        if name == 'InitializeProcThreadAttributeList':
            if args[0] is None:
                args[3]._obj.value = 128
                self.error = 122
                return 0
            return 1
        if name == 'UpdateProcThreadAttribute':
            return 1
        if name == 'DeleteProcThreadAttributeList':
            self.deleted.append(args[0])
            return None
        if name == 'CreateProcessW':
            info = args[9]._obj
            is_root = '--root' in args[1].value
            process, thread = self.make_pair(10 if is_root else 20, 11 if is_root else 21)
            if is_root:
                self.root = process
            else:
                self.leaf = process
            info.process = self.acquire('process', obj=process)
            info.thread = self.acquire('thread', obj=thread)
            info.pid, info.tid = process['pid'], thread['tid']
            self.total += 1
            return 1
        if name == 'GetProcessId':
            return 99 if self.bad_identity == 'pid' else self.object(args[0])['pid']
        if name == 'GetThreadId':
            return 99 if self.bad_identity == 'tid' else self.object(args[0])['tid']
        if name == 'GetProcessIdOfThread':
            return 99 if self.bad_identity == 'owner' else self.object(args[0])['owner']['pid']
        if name == 'GetProcessTimes':
            birth = self.object(args[0])['birth']
            if self.bad_identity == 'birth':
                birth = 0
            args[1]._obj.low, args[1]._obj.high = birth & 0xFFFFFFFF, birth >> 32
            return 1
        if name == 'IsProcessInJob':
            args[2]._obj.value = int(self.bad_identity != 'job' and args[1] in (None, self.job))
            return 1
        if name == 'WaitForSingleObject':
            handle, ms = args
            entry, obj = self.handles[handle], self.object(handle)
            if entry['kind'] == 'event':
                if self.auto_publish and handle == self.events[0] and not obj['signaled']:
                    self.publish(self.native)
                    obj['signaled'] = True
                if len(self.events) > 2 and obj is self.object(self.events[2]) and self.leaf and self.leaf.get('resumed'):
                    obj['signaled'] = True
                if len(self.events) > 1 and obj is self.object(self.events[1]) and self.ack_signaled:
                    obj['signaled'] = True
                if obj['signaled']:
                    return 0
            else:
                process = obj if entry['kind'] == 'process' else obj['owner']
                if not process['alive']:
                    return 0
                if self.bad_identity == 'alive':
                    return 0
            self.clock.now += ms / 1000
            return 258
        if name == 'ResumeThread':
            self.object(args[0])['owner']['resumed'] = True
            return self.resume_result
        if name == 'SetEvent':
            self.object(args[0])['signaled'] = True
            if len(self.events) >= 4 and self.object(args[0]) is self.object(self.events[3]) and self.leaf:
                self.leaf['alive'], self.leaf['exit'] = False, 0
            return 1
        if name == 'TerminateProcess':
            self.object(args[0])['alive'], self.object(args[0])['exit'] = False, args[1]
            return 1
        if name == 'TerminateJobObject':
            for process in (self.root, self.leaf):
                if process:
                    process['alive'], process['exit'] = False, args[1]
            return 1
        if name == 'GetExitCodeProcess':
            args[1]._obj.value = self.object(args[0])['exit']
            return 1
        if name == 'CloseHandle':
            self.closed.append(args[0])
            del self.handles[args[0]]
            return 1
        raise AssertionError('No fake implementation: ' + name)


class NativeTests(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.budget = module.Budget(self.clock)
        self.kernel = Kernel(self.clock)
        self.patchers = [
            patch.object(ctypes, 'WinDLL', return_value=self.kernel, create=True),
            patch.object(ctypes, 'get_last_error', side_effect=lambda: self.kernel.error, create=True),
            patch.object(sys, 'executable', 'C:/Python313/python.exe'),
            patch.dict(module.os.environ, {'SystemRoot': 'C:/Windows'}, clear=True),
        ]
        for patcher in self.patchers:
            patcher.start()
            self.addCleanup(patcher.stop)
        self.native = module.Native(self.budget)
        self.kernel.native = self.native

    def setup_root(self):
        self.native.prepare()
        self.native.create_root()
        self.assertTrue(self.native.identity_root())

    def setup_transfer(self):
        self.setup_root()
        self.kernel.publish(self.native)
        self.native.transfer()

    def clean(self, observed=False):
        report = module.new_report()
        report['control_observed'] = observed
        self.native.cleanup(report)
        return report

    def test_sdk_layout_and_signatures_from_real_binding(self):
        n, k = self.native, self.kernel
        self.assertEqual(ctypes.sizeof(n.Transfer), 48)
        self.assertEqual(n.Transfer.process_slot.offset, 16)
        self.assertEqual(n.Transfer.birth.offset, 40)
        self.assertEqual(ctypes.sizeof(n.PidList), 24 if ctypes.sizeof(n.HANDLE) == 8 else 16)
        self.assertEqual(k.DuplicateHandle.argtypes[3], ctypes.POINTER(ctypes.c_void_p))
        self.assertEqual(k.MapViewOfFile.restype, ctypes.c_void_p)
        self.assertEqual(k.CreateFileMappingW.argtypes[-1], ctypes.c_wchar_p)
        self.assertIsNone(k.DeleteProcThreadAttributeList.restype)

    def test_exact_flags_atomic_job_and_minimal_inheritance(self):
        self.setup_root()
        n, k = self.native, self.kernel
        updates = [a for name, a in k.calls if name == 'UpdateProcThreadAttribute']
        self.assertEqual({a[2] for a in updates}, {0x20002, 0x2000D})
        self.assertEqual(list(n.job_array), [n.job])
        self.assertEqual(len(n.inherit_array), 5)
        self.assertNotIn(n.job, n.inherit_array)
        self.assertNotIn(n.process, n.inherit_array)
        duplicates = [a for name, a in k.calls if name == 'DuplicateHandle']
        self.assertEqual([a[4] for a in duplicates], [6, 2, 0x100000, 2, 0x100000])
        self.assertTrue(all(a[0] == -1 and a[2] == -1 and a[5] and a[6] == 0 for a in duplicates))
        for handle in n.inherit_array:
            self.assertTrue(k.handles[handle]['inherit'])
        for handle in (n.job, n.mapping, n.published, n.ack, n.process, n.thread):
            self.assertFalse(k.handles[handle]['inherit'])
        args = next(a for name, a in k.calls if name == 'CreateProcessW')
        self.assertEqual(args[0], 'C:/Python313/python.exe')
        self.assertTrue(args[4])
        self.assertEqual(args[5], 0x8040C)
        self.assertEqual(args[6][:len('SystemRoot=C:/Windows\0\0')], 'SystemRoot=C:/Windows\0\0')
        self.assertIn('-I -S -B', args[1].value)
        self.assertTrue(args[1].value.endswith('160000000000'))
        startup = args[8]._obj
        self.assertEqual(startup.startup.flags, 0x100)
        self.assertEqual((startup.startup.stdin, startup.startup.stdout, startup.startup.stderr), (None, None, None))
        mapping = next(a for name, a in k.calls if name == 'CreateFileMappingW')
        self.assertEqual(mapping[0].value, ctypes.c_void_p(-1).value)
        self.assertEqual(mapping[2:], (4, 0, 48, None))
        self.clean(True)
        self.assertFalse(k.handles)
        self.assertFalse(k.views)

    def test_duplicate_uses_retained_root_and_registers_each_noninherit(self):
        self.setup_transfer()
        n, k = self.native, self.kernel
        duplicates = [a for name, a in k.calls if name == 'DuplicateHandle'][-2:]
        self.assertEqual([(a[0], a[1], a[2], a[4], a[5], a[6]) for a in duplicates],
                         [(n.process, 200, -1, 0x101000, False, 0),
                          (n.process, 204, -1, 0x100802, False, 0)])
        for handle in (n.leaf_process, n.leaf_thread):
            self.assertIn(handle, n.handles)
            self.assertFalse(k.handles[handle]['inherit'])
        self.assertTrue(n.identity_leaf())
        n.acknowledge()
        self.assertTrue(n.acknowledged)
        self.assertEqual(n.resume_leaf(), 1)
        with self.assertRaises(module.Fault):
            n.resume_leaf()
        self.assertEqual(k.counts['ResumeThread'], 1)
        self.clean()

    def test_real_backend_preserves_handle_verified_numeric_receipts(self):
        self.setup_transfer()
        n, k = self.native, self.kernel
        self.assertTrue(n.identity_leaf())
        self.assertEqual(n.root_evidence(), {
            'root_pid': 10, 'root_tid': 11, 'root_creation_filetime': 123466})
        self.assertEqual(n.leaf_evidence(), {
            'leaf_pid': 20, 'leaf_tid': 21, 'leaf_creation_filetime': 123476})
        k.root['alive'] = k.leaf['alive'] = False
        self.assertTrue(n.sample())
        self.assertEqual(n.sample_evidence(), {
            'job_total': 2, 'job_active': 0, 'job_assigned': 0, 'job_listed': 0,
            'root_wait_result': 0, 'leaf_wait_result': 0})
        self.clean(True)

    def test_reused_live_source_slots_and_cross_job_identity_cannot_ack(self):
        for problem in ('pid', 'thread_owner', 'birth', 'cross_job'):
            with self.subTest(problem=problem):
                self.setUp()
                self.setup_root()
                k, n = self.kernel, self.native
                k.publish(n)
                if problem == 'pid':
                    k.remote[200]['obj'] = dict(k.leaf, pid=999)
                elif problem == 'thread_owner':
                    k.remote[204]['obj'] = {'tid': 21, 'owner': dict(k.leaf, pid=999)}
                elif problem == 'birth':
                    k.remote[200]['obj'] = dict(k.leaf, birth=999)
                n.transfer()
                if problem == 'cross_job':
                    original = k.normal
                    def normal(name, args):
                        if name == 'IsProcessInJob' and args[0] == n.leaf_process:
                            self.assertEqual(args[1], n.job)
                            args[2]._obj.value = 0
                            return 1
                        return original(name, args)
                    k.normal = normal
                self.assertFalse(n.identity_leaf())
                self.assertFalse(n.acknowledged)
                self.assertNotIn('ResumeThread', k.counts)
                self.clean()

    def test_late_and_partial_duplicate_registration_before_checks(self):
        for occurrence in (6, 7):
            with self.subTest(occurrence=occurrence):
                # Fresh pure kernel per subcase, no candidate process runs.
                self.setUp()
                self.setup_root()
                self.kernel.publish(self.native)
                self.kernel.effects[('DuplicateHandle', occurrence)] = {'late': True}
                with self.assertRaises(module.Deadline):
                    self.native.transfer()
                transferred = [h for h in self.native.handles if self.kernel.handles[h]['kind'] in ('process', 'thread')]
                self.assertEqual(len(transferred), occurrence - 3)
                self.assertFalse(self.native.acknowledged)
                self.assertNotIn('ResumeThread', self.kernel.counts)
                report = self.clean()
                self.assertTrue(report['abort_requested'])
                self.assertFalse(report['containment_zero'])
                self.assertFalse(self.kernel.handles)
        self.setUp()
        self.setup_root()
        self.kernel.publish(self.native)
        self.kernel.effects[('DuplicateHandle', 7)] = {'fail': True}
        with self.assertRaises(module.Fault):
            self.native.transfer()
        self.assertIsNotNone(self.native.leaf_process)
        self.assertIn(self.native.leaf_process, self.native.handles)
        report = self.clean()
        self.assertTrue(report['containment_zero'])
        self.assertTrue(report['root_actual_exit'])
        self.assertTrue(report['leaf_actual_exit'])

    def test_invalid_slots_snapshot_change_and_root_death_fail_before_ack(self):
        cases = ({'process_slot': 0}, {'thread_slot': 200}, {'process_slot': (1 << 64) - 1},
                 {'version': 2}, {'published': 0}, {'size': 49}, {'reserved': 1},
                 {'pid': 10}, {'tid': 0}, {'birth': 0}, {'process_slot': 888})
        for changes in cases:
            with self.subTest(changes=changes):
                self.setUp()
                self.setup_root()
                self.kernel.publish(self.native, **changes)
                with self.assertRaises(module.Fault):
                    self.native.transfer()
                self.assertNotIn('ResumeThread', self.kernel.counts)
                self.assertFalse(self.native.acknowledged)
                self.clean()
        for problem in ('slot_changed', 'root_dead', 'slot_alias'):
            with self.subTest(problem=problem):
                self.setUp()
                self.setup_transfer()
                self.assertTrue(self.native.identity_leaf())
                if problem == 'slot_changed':
                    self.kernel.publish(self.native, thread_slot=208)
                elif problem == 'root_dead':
                    self.kernel.root['alive'] = False
                else:
                    self.kernel.publish(self.native, process_slot=self.native.inherit_array[0])
                with self.assertRaises(module.Fault):
                    self.native.acknowledge()
                self.assertFalse(self.native.acknowledged)
                self.assertNotIn('ResumeThread', self.kernel.counts)
                self.clean()

    def test_all_identity_failures_no_resume_at_real_kernel_boundary(self):
        for target in ('root', 'leaf'):
            for problem in ('pid', 'tid', 'owner', 'birth', 'job', 'alive', 'inherit'):
                with self.subTest(target=target, problem=problem):
                    self.setUp()
                    self.native.prepare()
                    self.native.create_root()
                    if target == 'leaf':
                        self.kernel.publish(self.native)
                        self.native.transfer()
                    self.kernel.bad_identity = problem
                    if problem == 'inherit':
                        handle = self.native.process if target == 'root' else self.native.leaf_thread
                        self.kernel.handles[handle]['inherit'] = True
                    try:
                        result = getattr(self.native, 'identity_' + target)()
                    except module.Fault:
                        result = False
                    self.assertFalse(result)
                    self.assertNotIn('ResumeThread', self.kernel.counts)
                    self.clean()
        self.setUp()
        self.setup_root()
        self.kernel.publish(self.native, birth=999)
        self.native.transfer()
        self.assertFalse(self.native.identity_leaf())
        self.clean()

    def test_native_sampler_rejects_extra_accounting_buffers_and_unsignaled_waits(self):
        for total, active, assigned, listed in ((3, 0, 0, 0), (2, 1, 0, 0),
                                               (2, 0, 1, 1), (2, 0, 0, 1),
                                               (2, 0, 3, 3), (1, 0, 0, 0)):
            with self.subTest(values=(total, active, assigned, listed)):
                self.setUp()
                self.setup_transfer()
                self.kernel.root['alive'] = self.kernel.leaf['alive'] = False
                self.kernel.accounting_override = (total, active)
                self.kernel.inventory_override = (assigned, listed)
                try:
                    value = self.native.sample()
                except module.Fault:
                    value = False
                self.assertFalse(value)
                self.clean(True)
        self.setUp()
        self.setup_transfer()
        self.kernel.accounting_override = (2, 0)
        self.kernel.inventory_override = (0, 0)
        self.assertFalse(self.native.sample())
        self.kernel.root['alive'] = self.kernel.leaf['alive'] = False
        self.assertTrue(self.native.sample())
        self.clean(True)

    def test_every_prepare_create_gap_late_or_failed_releases_registered_resources(self):
        self.native.prepare()
        self.native.create_root()
        trace = []
        counts = {}
        for name, args in self.kernel.calls:
            counts[name] = counts.get(name, 0) + 1
            trace.append((name, counts[name]))
        self.clean()
        # Every call boundary, not only the final CreateProcess call. A sizing
        # query is deliberately expected to fail with ERROR_INSUFFICIENT_BUFFER.
        for target in trace:
            for effect in ({'fail': True}, {'late': True}, {'raise': True}):
                with self.subTest(target=target, effect=effect):
                    self.setUp()
                    self.kernel.effects[target] = effect
                    with self.assertRaises((module.Fault, RuntimeError)):
                        self.native.prepare()
                        self.native.create_root()
                    self.clean()
                    self.assertFalse(self.kernel.handles)
                    self.assertFalse(self.kernel.views)
                    self.assertFalse(self.native.attributes_initialized)
                    self.assertFalse(self.native.handles)
                    self.assertFalse(self.native.views)

    def test_release_attempts_continue_after_each_close_unmap_or_delete_failure(self):
        self.setup_transfer()
        handles = list(reversed(self.native.handles))
        self.clean()
        targets = [('CloseHandle', index) for index in range(1, len(handles) + 1)]
        targets += [('UnmapViewOfFile', 1), ('DeleteProcThreadAttributeList', 1)]
        for target in targets:
            for effect in ({'fail': True}, {'raise': True}, {'late': True}):
                if target[0] == 'DeleteProcThreadAttributeList' and effect.get('fail'):
                    continue  # This SDK function is void; only exceptions are observable.
                with self.subTest(target=target, effect=effect):
                    self.setUp()
                    self.setup_transfer()
                    all_handles = set(self.native.handles)
                    self.kernel.effects[target] = effect
                    report = self.clean(True)
                    attempts = [a[0] for name, a in self.kernel.calls if name == 'CloseHandle']
                    self.assertEqual(set(attempts), all_handles)
                    self.assertEqual(len(attempts), len(all_handles))
                    self.assertEqual(attempts[-1], self.kernel.job)
                    self.assertEqual(self.kernel.counts['UnmapViewOfFile'], 1)
                    self.assertEqual(self.kernel.counts['DeleteProcThreadAttributeList'], 1)
                    self.assertFalse(self.native.handles)
                    self.assertFalse(self.native.views)
                    if effect.get('late'):
                        self.assertEqual(report['cleanup_failures'], 0)
                        self.assertGreaterEqual(self.clock.now, self.budget.deadline)
                    else:
                        self.assertEqual(report['cleanup_failures'], 1)
                        key = {'CloseHandle': 'handle_close_failures',
                               'UnmapViewOfFile': 'view_release_failures',
                               'DeleteProcThreadAttributeList': 'attribute_release_failures'}[target[0]]
                        self.assertEqual(report[key], 1)
                        if effect.get('raise'):
                            self.assertEqual(report['winerror'], 0)  # Not stale sizing error 122.

    def test_abort_unknown_leaf_uses_job_not_pid_or_source_close(self):
        self.setup_root()
        self.kernel.publish(self.native)
        report = self.clean()
        self.assertTrue(report['abort_requested'])
        self.assertTrue(report['job_terminate_succeeded'])
        self.assertTrue(report['containment_zero'])
        self.assertTrue(report['root_actual_exit'])
        self.assertFalse(report['leaf_actual_exit'])  # No leaf handle was transferred.
        self.assertFalse(report['leaf_natural_exit'])
        self.assertFalse(report['root_force_requested'])
        names = [name for name, unused in self.kernel.calls]
        self.assertNotIn('TerminateProcess', names)
        self.assertLess(names.index('TerminateJobObject'), names.index('CloseHandle'))
        self.assertFalse(self.kernel.handles)

    def test_expired_abort_requests_containment_without_wait_or_fake_exit_receipt(self):
        self.setup_transfer()
        self.clock.now = self.budget.deadline
        start = len(self.kernel.calls)
        report = self.clean()
        names = [name for name, unused in self.kernel.calls[start:]]
        self.assertIn('TerminateJobObject', names)
        self.assertNotIn('WaitForSingleObject', names)
        self.assertNotIn('QueryInformationJobObject', names)
        self.assertFalse(report['root_actual_exit'])
        self.assertFalse(report['leaf_actual_exit'])
        self.assertFalse(report['containment_zero'])
        self.assertEqual(report['result'], 'TIMEOUT')
        self.assertFalse(self.kernel.handles)

    def test_containment_errors_preserve_first_code_and_do_not_block_releases(self):
        for target in ('TerminateJobObject', 'WaitForSingleObject', 'QueryInformationJobObject'):
            with self.subTest(target=target):
                self.setUp()
                self.setup_transfer()
                self.kernel.effects[target] = {'fail': True, 'error': 87}
                report = self.clean()
                self.assertGreater(report['cleanup_failures'], 0)
                self.assertEqual(report['winerror'], 87)
                self.assertFalse(self.kernel.handles)
                self.assertFalse(self.kernel.views)
                self.assertFalse(report['candidate'])

    def test_abort_wait_timeout_is_recorded_without_treating_job_close_as_receipt(self):
        self.setup_root()
        self.kernel.effects['TerminateJobObject'] = {'fail': True, 'error': 5}
        # Pacer and all queries remain under the original deadline, no reset.
        report = self.clean()
        self.assertEqual(report['result'], 'TIMEOUT')
        self.assertFalse(report['containment_zero'])
        self.assertFalse(report['root_actual_exit'])
        self.assertFalse(self.kernel.handles)
        self.assertLessEqual(self.kernel.counts.get('QueryInformationJobObject', 0), 260)

    def inherited_root_handles(self):
        self.native.prepare()
        inherited = list(self.native.inherit_array)
        # Keep the supervisor resources in the fake kernel; the root receives
        # only these five explicit aliases. A new real Native consumes them.
        root_native = module.Native(self.budget)
        return root_native, inherited

    def test_root_real_protocol_publishes_receipt_without_resuming_leaf(self):
        root, handles = self.inherited_root_handles()
        self.kernel.ack_signaled = True
        with self.assertRaises(module.Deadline):
            root.root_protocol(handles)
        value = root.Transfer.from_address(root.view)
        self.assertEqual((value.version, value.size, value.published), (1, 48, 1))
        self.assertEqual((value.process_slot, value.thread_slot), root.source_slots)
        self.assertEqual((value.pid, value.tid, value.birth), (20, 21, 123476))
        self.assertFalse(root.preserve_sources)
        self.assertTrue(root.acknowledged)
        self.assertNotIn('ResumeThread', self.kernel.counts)
        leaf_create = [a for name, a in self.kernel.calls if name == 'CreateProcessW'][-1]
        self.assertIn('--leaf', leaf_create[1].value)
        self.assertTrue(leaf_create[1].value.endswith('160000000000'))
        self.assertEqual(leaf_create[5], 0x8040C)
        self.assertEqual(len(root.inherit_array), 2)
        for handle in root.inherit_array:
            self.assertEqual(self.kernel.handles[handle]['kind'], 'event')
        latest_updates = [a[2] for name, a in self.kernel.calls if name == 'UpdateProcThreadAttribute'][-1:]
        self.assertEqual(latest_updates, [0x20002])
        report = module.new_report()
        source_slots = root.source_slots
        root.cleanup(report)
        self.assertTrue(all(h in self.kernel.closed for h in source_slots))
        # The same numerical inherited handles exist in separate real tables;
        # remove their supervisor ledger aliases in this single-table fake only.
        self.native.handles = [h for h in self.native.handles if h not in handles]
        self.clean(True)
        self.assertFalse(self.kernel.views)

    def test_unacknowledged_root_does_not_close_or_reuse_source_slots(self):
        for problem in ('timeout', 'publish_failure', 'late_create'):
            with self.subTest(problem=problem):
                self.setUp()
                root, handles = self.inherited_root_handles()
                if problem == 'publish_failure':
                    self.kernel.effects['SetEvent'] = {'fail': True}
                elif problem == 'late_create':
                    self.kernel.effects['CreateProcessW'] = {'late': True}
                with self.assertRaises(module.Fault):
                    root.root_protocol(handles)
                slots = root.source_slots
                self.assertEqual(len(slots), 2)
                self.assertTrue(root.preserve_sources)
                report = module.new_report()
                root.cleanup(report)
                for slot in slots:
                    self.assertIn(slot, self.kernel.handles)
                    self.assertNotIn(slot, self.kernel.closed)
                self.assertFalse(root.views)
                self.assertFalse(root.attributes_initialized)
                self.assertNotIn('ResumeThread', self.kernel.counts)
                self.assertNotIn('TerminateJobObject', self.kernel.counts)
                self.native.handles = [h for h in self.native.handles if h not in handles]
                self.clean(True)

    def test_leaf_real_protocol_uses_only_ready_go_under_absolute_deadline(self):
        for signaled in (False, True):
            with self.subTest(signaled=signaled):
                self.setUp()
                ready = self.kernel.acquire('event', True, {'signaled': False, 'index': 10})
                go = self.kernel.acquire('event', True, {'signaled': signaled, 'index': 11})
                self.clock.now = 150
                self.native.budget = module.absolute_budget('160000000000', self.clock)
                if signaled:
                    self.native.leaf_protocol([ready, go])
                else:
                    with self.assertRaises(module.Deadline):
                        self.native.leaf_protocol([ready, go])
                wait = next(a for name, a in self.kernel.calls if name == 'WaitForSingleObject')
                self.assertEqual(wait, (go, 10000))
                self.assertTrue(self.kernel.object(ready)['signaled'])
                self.assertEqual(self.native.handles, [ready, go])
                self.clean()
                self.assertFalse(self.kernel.handles)
                self.assertNotIn('CreateProcessW', self.kernel.counts)
                self.assertNotIn('ResumeThread', self.kernel.counts)

    def test_role_arguments_strict_fixed_numbers_and_no_deadline_reset(self):
        handles, budget = module.role_arguments(['100', '104', '150000000000'], 2, self.clock)
        self.assertEqual(handles, [100, 104])
        self.assertEqual(budget.deadline, 150)
        self.assertEqual(budget.milliseconds(), 50000)
        for args in ([], ['100', '100', '150000000000'], ['-1', '104', '150000000000'],
                     ['100', '104', 'command'], ['100', '104', '150000000000', 'extra'],
                     ['100', '104', '999999999999999999999999999999'],
                     [str(ctypes.c_void_p(-1).value), '104', '150000000000']):
            with self.subTest(args=args), self.assertRaises(module.Fault):
                module.role_arguments(args, 2, self.clock)

    def test_source_code_forbids_unowned_lookup_or_process_control(self):
        forbidden = ('OpenProcess', 'OpenThread', 'SuspendThread', 'AssignProcessToJobObject',
                     'DUPLICATE_CLOSE_SOURCE', 'kill', 'taskkill', 'Popen', 'system',
                     'unlink', 'rmtree', 'remove', 'CreateRemoteThread')
        calls = [n for n in ast.walk(TREE) if isinstance(n, ast.Call)]
        names = {n.func.attr if isinstance(n.func, ast.Attribute) else n.func.id
                 for n in calls if isinstance(n.func, (ast.Attribute, ast.Name))}
        self.assertFalse(set(forbidden) & names)
        strings = {n.value for n in ast.walk(TREE) if isinstance(n, ast.Constant) and isinstance(n.value, str)}
        self.assertFalse({'OpenProcess', 'OpenThread', 'SuspendThread'} & strings)
        native = next(n for n in TREE.body if isinstance(n, ast.ClassDef) and n.name == 'Native')
        root_method = next(n for n in native.body if isinstance(n, ast.FunctionDef) and n.name == 'root_protocol')
        self.assertNotIn('ResumeThread', ast.unparse(root_method))
        self.assertNotIn('resume_leaf', ast.unparse(root_method))

    def test_all_real_identity_failures_stop_state_machine_before_matching_resume(self):
        for target in ('root', 'leaf'):
            for problem in ('pid', 'tid', 'owner', 'birth', 'job', 'alive', 'inherit'):
                with self.subTest(target=target, problem=problem):
                    self.setUp()
                    self.kernel.auto_publish = True
                    def corrupt(args, result):
                        self.kernel.bad_identity = problem
                        if problem == 'inherit':
                            handle = args[3]._obj.value if target == 'leaf' else args[9]._obj.process
                            self.kernel.handles[handle]['inherit'] = True
                    trigger = ('DuplicateHandle', 7) if target == 'leaf' else ('CreateProcessW', 1)
                    self.kernel.effects[trigger] = {'after': corrupt}
                    report, _ = module.run_state(lambda budget: self.native, self.clock)
                    self.assertFalse(report['candidate'])
                    self.assertFalse(report['transfer_ack'])
                    self.assertEqual(self.kernel.counts.get('ResumeThread', 0), int(target == 'leaf'))
                    self.assertFalse(self.kernel.handles)
                    self.assertFalse(self.kernel.views)

    def test_expected_force_late_is_not_mislabeled_as_abort_process_termination(self):
        self.kernel.auto_publish = True
        self.kernel.effects['TerminateProcess'] = {'late': True}
        report, _ = module.run_state(lambda budget: self.native, self.clock)
        self.assertEqual(report['result'], 'TIMEOUT')
        self.assertTrue(report['root_force_requested'])
        self.assertTrue(report['root_force_succeeded'])
        self.assertTrue(report['abort_requested'])
        self.assertTrue(report['job_terminate_succeeded'])
        self.assertFalse(report['leaf_natural_exit'])
        self.assertEqual(self.kernel.counts['TerminateProcess'], 1)
        self.assertEqual(self.kernel.counts['TerminateJobObject'], 1)
        self.assertFalse(self.kernel.handles)

    def test_root_death_before_transfer_and_during_duplicate_cannot_ack_or_resume_leaf(self):
        for when in ('before', 'during'):
            with self.subTest(when=when):
                self.setUp()
                self.setup_root()
                self.kernel.publish(self.native)
                if when == 'before':
                    self.kernel.root['alive'] = False
                    with self.assertRaises(module.Fault):
                        self.native.transfer()
                    self.assertEqual(self.kernel.counts['DuplicateHandle'], 5)
                else:
                    def die(args, result):
                        self.kernel.root['alive'] = False
                    self.kernel.effects[('DuplicateHandle', 6)] = {'after': die}
                    self.native.transfer()
                    self.assertTrue(self.native.identity_leaf())
                    with self.assertRaises(module.Fault):
                        self.native.acknowledge()
                self.assertFalse(self.native.acknowledged)
                self.assertNotIn('ResumeThread', self.kernel.counts)
                self.clean()

    def test_birth_changes_and_signaled_thread_invalidate_real_pair(self):
        for problem in ('birth_changes', 'thread_exit'):
            with self.subTest(problem=problem):
                self.setUp()
                self.setup_transfer()
                if problem == 'birth_changes':
                    calls = self.kernel.counts.get('GetProcessTimes', 0)
                    def change(args, result):
                        self.kernel.leaf['birth'] += 1
                    self.kernel.effects[('GetProcessTimes', calls + 1)] = {'after': change}
                else:
                    original = self.kernel.normal
                    def wait_thread(name, args):
                        if name == 'WaitForSingleObject' and args[0] == self.native.leaf_thread:
                            return 0
                        return original(name, args)
                    self.kernel.normal = wait_thread
                self.assertFalse(self.native.identity_leaf())
                self.assertNotIn('ResumeThread', self.kernel.counts)
                self.clean()

    def test_job_readback_breakaway_and_query_buffer_failure_fail_closed(self):
        def breakaway(args, result):
            args[2]._obj.basic.flags |= 0x800
        self.kernel.effects[('QueryInformationJobObject', 1)] = {'after': breakaway}
        with self.assertRaises(module.Fault):
            self.native.prepare()
        self.clean()
        self.assertNotIn('CreateProcessW', self.kernel.counts)
        self.setUp()
        self.kernel.auto_publish = True
        # First query reads limits; the next two are the first job sample.
        self.kernel.effects[('QueryInformationJobObject', 3)] = {'fail': True, 'error': 234}
        report, _ = module.run_state(lambda budget: self.native, self.clock)
        self.assertFalse(report['candidate'])
        self.assertEqual(report['winerror'], 234)
        self.assertEqual(report['samplecount'], 0)
        self.assertTrue(report['abort_requested'])
        self.assertFalse(self.kernel.handles)

    def test_root_protocol_all_acquisition_gaps_retain_only_unacknowledged_sources(self):
        root, handles = self.inherited_root_handles()
        start = len(self.kernel.calls)
        self.kernel.ack_signaled = True
        with self.assertRaises(module.Fault):
            root.root_protocol(handles)
        counts = {}
        for name, unused in self.kernel.calls[:start]:
            counts[name] = counts.get(name, 0) + 1
        trace = []
        for name, unused in self.kernel.calls[start:]:
            counts[name] = counts.get(name, 0) + 1
            trace.append((name, counts[name]))
        report = module.new_report()
        root.cleanup(report)
        self.native.handles = [h for h in self.native.handles if h not in handles]
        self.clean(True)
        for target in trace:
            for effect in ({'fail': True}, {'late': True}, {'raise': True}):
                with self.subTest(target=target, effect=effect):
                    self.setUp()
                    root, handles = self.inherited_root_handles()
                    self.kernel.ack_signaled = True
                    self.kernel.effects[target] = effect
                    with self.assertRaises((module.Fault, RuntimeError)):
                        root.root_protocol(handles)
                    preserved = set(root.source_slots) if root.preserve_sources else set()
                    report = module.new_report()
                    root.cleanup(report)
                    self.assertFalse(root.views)
                    self.assertFalse(root.attributes_initialized)
                    self.assertTrue(preserved <= set(self.kernel.handles))
                    self.native.handles = [h for h in self.native.handles if h not in handles]
                    self.clean(True)
                    self.assertEqual(set(self.kernel.handles), preserved)
                    self.assertFalse(self.kernel.views)
                    self.assertNotIn('ResumeThread', self.kernel.counts)

    def test_leaf_adoption_errors_release_all_endpoints_before_late_checks(self):
        for target in (('SetHandleInformation', 1), ('SetHandleInformation', 2),
                       ('GetHandleInformation', 1), ('GetHandleInformation', 2),
                       ('SetEvent', 1), ('WaitForSingleObject', 1)):
            for effect in ({'fail': True}, {'late': True}, {'raise': True}):
                with self.subTest(target=target, effect=effect):
                    self.setUp()
                    ready = self.kernel.acquire('event', True, {'signaled': False})
                    go = self.kernel.acquire('event', True, {'signaled': True})
                    self.kernel.effects[target] = effect
                    with self.assertRaises((module.Fault, RuntimeError)):
                        self.native.leaf_protocol([ready, go])
                    self.clean()
                    self.assertFalse(self.kernel.handles)

    def test_real_backend_state_machine_over_fake_kernel(self):
        self.kernel.auto_publish = True
        def factory(budget):
            self.native.budget = budget
            return self.native
        report, budget = module.run_state(factory, self.clock)
        self.assertTrue(report['candidate'])
        self.assertEqual(report['result'], 'UNKNOWN')
        self.assertFalse(report['evidence_complete'])
        self.assertTrue(report['root_force_succeeded'])
        self.assertFalse(report['abort_requested'])
        self.assertTrue(report['leaf_natural_exit'])
        self.assertGreaterEqual(report['resource_seconds'], 6)
        self.assertGreaterEqual(report['samplecount'], 3)
        self.assertFalse(self.kernel.handles)
        self.assertFalse(self.kernel.views)
        self.assertEqual(self.kernel.counts['ResumeThread'], 2)
        self.assertEqual(self.kernel.closed[-1], self.kernel.job)


if __name__ == '__main__':
    with forbidden_boundaries():
        unittest.main(verbosity=2)
