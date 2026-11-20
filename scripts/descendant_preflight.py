"""#119 synthetic descendant PREPARATION ONLY; native execution is a separate gate.

Fixed supervisor -> root -> leaf; no arbitrary executable, command or PID input.
A candidate remains UNKNOWN, not PASS. External durable capture is not provided
here. No API is loaded at import, and even successful containment/close is not a
promise of kernel hard completion. The CLI flags are not authenticated authority.
"""
import argparse
import json
import math
import os
import sys
import time
import types


def _baseline():
    # -I excludes the script directory. Load this exact sibling, without PATH,
    # sys.path changes, import hooks, or writing a bytecode cache.
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'one_root_preflight.py')
    module = types.ModuleType('_wag_one_root_preparation')
    module.__file__ = path
    with open(path, encoding='utf-8') as source:
        exec(compile(source.read(), path, 'exec'), module.__dict__)
    return module


base = _baseline()
Budget, Fault, Deadline = base.Budget, base.Fault, base.Deadline


def number(text, maximum):
    if (not isinstance(text, str) or not text or not text.isascii()
            or not text.isdecimal() or text[0] == '0' or len(text) > 20):
        raise Fault()
    value = int(text)
    if not 0 < value < maximum:
        raise Fault()
    return value


def absolute_budget(text, clock=time.monotonic):
    deadline_ns = number(text, 1 << 63)
    deadline = deadline_ns / 1_000_000_000
    budget = Budget.__new__(Budget)
    budget.deadline_ns = deadline_ns
    budget.clock, budget.t0, budget.deadline = clock, clock(), deadline
    # Consumption only: an internal role may never acquire a fresh 60 seconds.
    if not 0 < deadline - budget.t0 <= 60.0:
        raise Deadline()
    budget.check()
    return budget


def new_report():
    return {
        'result': 'UNKNOWN', 'phase': 'SETUP', 'winerror': 0,
        'candidate': False, 'evidence_complete': False,
        'root_owned': False, 'leaf_owned': False, 'transfer_ack': False,
        'root_pid': 0, 'root_tid': 0, 'root_creation_filetime': 0,
        'leaf_pid': 0, 'leaf_tid': 0, 'leaf_creation_filetime': 0,
        'job_samples': [],
        'root_force_requested': False, 'root_force_succeeded': False,
        'root_actual_exit': False, 'leaf_actual_exit': False,
        'leaf_natural_exit': False, 'control_observed': False,
        'abort_requested': False, 'job_terminate_succeeded': False,
        'containment_zero': False, 'resource_seconds': 0.0, 'samplecount': 0,
        'cleanup_failures': 0, 'handle_close_failures': 0,
        'view_release_failures': 0, 'attribute_release_failures': 0,
        'deadline_overrun': False,
    }


def run_state(factory, clock=time.monotonic):
    """The same state machine drives Native and pure fake backends, once only."""
    budget = Budget(clock)
    # All command lines carry precisely this absolute deadline (rounded down).
    budget.deadline_ns = int(budget.deadline * 1_000_000_000)
    budget.deadline = budget.deadline_ns / 1_000_000_000
    report, backend = new_report(), None

    def step(name, *args, reserve=0.0):
        budget.check(reserve)
        result = getattr(backend, name)(*args)
        budget.check()
        return result

    def require(value):
        if not value:
            raise Fault()

    def waited(value):
        if value == 258:
            raise Deadline()
        if value != 0:
            raise Fault()

    try:
        budget.check(6.0)
        backend = factory(budget)
        budget.check()
        step('prepare', reserve=6.0)
        report['phase'] = 'CREATE_ROOT'
        step('create_root', reserve=6.0)
        report['phase'] = 'IDENTITY_ROOT'
        require(step('identity_root', reserve=6.0))
        report.update(step('root_evidence', reserve=6.0))
        report['root_owned'] = True
        report['phase'] = 'RESUME_ROOT'
        require(step('resume_root', reserve=6.0) == 1)
        report['phase'] = 'PUBLISH'
        waited(step('wait_publish', budget.milliseconds()))
        report['phase'] = 'TRANSFER'
        step('transfer', reserve=6.0)
        report['phase'] = 'IDENTITY_LEAF'
        require(step('identity_leaf', reserve=6.0))
        report.update(step('leaf_evidence', reserve=6.0))
        report['leaf_owned'] = True
        report['phase'] = 'ACK'
        step('acknowledge', reserve=6.0)
        report['transfer_ack'] = True
        require(step('alive_root'))
        report['phase'] = 'RESUME_LEAF'
        require(step('resume_leaf', reserve=6.0) == 1)
        report['phase'] = 'READY_LEAF'
        waited(step('wait_leaf_ready', budget.milliseconds()))
        require(step('alive_leaf'))
        require(step('alive_root'))
        report['phase'] = 'FORCE_ROOT'
        step('force_root', report, reserve=6.0)
        waited(step('wait_root', budget.milliseconds()))
        report['root_actual_exit'] = True
        require(step('root_exit_code') == 91)
        # A root exit receipt is deliberately not a descendant exit receipt.
        require(step('alive_leaf'))
        report['phase'] = 'GO_LEAF'
        step('go_leaf', reserve=6.0)
        report['phase'] = 'EXIT_LEAF'
        waited(step('wait_leaf', budget.milliseconds()))
        report['leaf_actual_exit'] = True
        require(step('leaf_exit_code') == 0)
        report['leaf_natural_exit'] = True
        report['phase'] = 'OBSERVE'
        require(step('sample', reserve=6.0))
        snapshot = step('sample_evidence')
        start = clock()  # Exclude all time spent acquiring the first sample.
        report['job_samples'].append(dict(snapshot, offset_seconds=0.0))
        report['samplecount'] = 1
        budget.check(6.0)
        while True:
            before = clock()
            require(step('pace', budget.milliseconds(100)) == 258)
            require(clock() > before)
            require(step('sample'))
            snapshot = step('sample_evidence')
            report['resource_seconds'] = clock() - start
            report['job_samples'].append(dict(snapshot, offset_seconds=report['resource_seconds']))
            report['samplecount'] += 1
            if report['resource_seconds'] >= 6.0:
                require(report['samplecount'] >= 3)
                break
            require(report['samplecount'] < 128)
        report['control_observed'] = True
    except Deadline as error:
        report['result'], report['winerror'] = 'TIMEOUT', error.code
    except Fault as error:
        report['winerror'] = error.code
    except Exception:
        # Never serialize exceptions, command lines, environment or auth text.
        pass
    finally:
        if backend is not None:
            try:
                backend.cleanup(report)
            except Exception:
                report['cleanup_failures'] += 1
        report['deadline_overrun'] = clock() >= budget.deadline
        if report['deadline_overrun']:
            report['result'] = 'TIMEOUT'
        report['candidate'] = bool(
            report['control_observed'] and report['result'] != 'TIMEOUT'
            and not report['abort_requested'] and not report['cleanup_failures'])
    return report, budget


class Native(base.Native):
    def __init__(self, budget):
        # Bind only. All acquired resources have a ledger before a late check.
        self.budget = budget
        if not hasattr(budget, 'deadline_ns'):
            budget.deadline_ns = int(budget.deadline * 1_000_000_000)
            budget.deadline = budget.deadline_ns / 1_000_000_000
        self.handles, self.views = [], []
        self.attributes_initialized = False
        self.attribute_buffer = self.job_array = self.inherit_array = None
        self.process = self.thread = self.job = None
        self.leaf_process = self.leaf_thread = None
        self.snapshot = None
        self.root_resumed = self.leaf_resumed = self.acknowledged = False
        self.role = 'supervisor'
        self.preserve_sources = False
        self.source_slots = ()
        budget.check()
        if os.name != 'nt':
            raise Fault()
        self._bind()
        budget.check()

    def _bind(self):
        # Reuse the reviewed fixed-width Windows structures and call wrapper.
        super()._bind()
        c, H, U = self.c, self.HANDLE, self.U32

        class PidList(c.Structure):
            _fields_ = [('assigned', U), ('listed', U), ('ids', c.c_size_t * 2)]

        class Transfer(c.Structure):
            _fields_ = [
                ('version', U), ('size', U), ('published', U), ('reserved', U),
                ('process_slot', c.c_uint64), ('thread_slot', c.c_uint64),
                ('pid', U), ('tid', U), ('birth', c.c_uint64),
            ]

        self.PidList, self.Transfer = PidList, Transfer
        signatures = {
            'CreateFileMappingW': ([H, c.c_void_p, U, U, U, c.c_wchar_p], H),
            'MapViewOfFile': ([H, U, U, U, c.c_size_t], c.c_void_p),
            'UnmapViewOfFile': ([c.c_void_p], c.c_int32),
            'SetHandleInformation': ([H, U, U], c.c_int32),
            'TerminateJobObject': ([H, U], c.c_int32),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.k, name)
            function.argtypes, function.restype = args, result

    def acquire(self, name, *args, target=None):
        def register(value):
            self.handles.append(value)
            if target is not None:
                setattr(self, target, value)
        return self.call(name, *args, register=register)

    def duplicate(self, source_process, source, access, inherit=False):
        value = self.HANDLE()

        def register(unused):
            self.handles.append(value.value)
        self.call('DuplicateHandle', source_process, source,
                  self.call('GetCurrentProcess'), self.c.byref(value),
                  access, inherit, 0, register=register)
        self.noninherit(value.value, inherit)
        return value.value

    def map_view(self, mapping, access):
        return self.call('MapViewOfFile', mapping, access, 0, 0,
                         self.c.sizeof(self.Transfer), register=self.views.append)

    def attributes(self, inherited, job=None):
        c = self.c
        count = 1 + int(job is not None)
        size = c.c_size_t()
        result = self.call('InitializeProcThreadAttributeList', None, count, 0,
                           c.byref(size), checked=False)
        if result or not 0 < size.value <= 65536 or c.get_last_error() != 122:
            raise Fault()
        self.attribute_buffer = c.create_string_buffer(size.value)
        self.call('InitializeProcThreadAttributeList', self.attribute_buffer,
                  count, 0, c.byref(size), register=lambda unused:
                  setattr(self, 'attributes_initialized', True))
        self.inherit_array = (self.HANDLE * len(inherited))(*inherited)
        self.call('UpdateProcThreadAttribute', self.attribute_buffer, 0,
                  0x20002, self.inherit_array, c.sizeof(self.inherit_array), None, None)
        if job is not None:
            self.job_array = (self.HANDLE * 1)(job)
            self.call('UpdateProcThreadAttribute', self.attribute_buffer, 0,
                      0x2000D, self.job_array, c.sizeof(self.job_array), None, None)

    def prepare(self):
        c = self.c
        self.acquire('CreateJobObjectW', None, None, target='job')
        self.noninherit(self.job)
        limits = self.ExtendedLimit()
        limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE, neither breakaway bit.
        self.call('SetInformationJobObject', self.job, 9,
                  c.byref(limits), c.sizeof(limits))
        readback = self.ExtendedLimit()
        self.call('QueryInformationJobObject', self.job, 9,
                  c.byref(readback), c.sizeof(readback), None)
        if readback.basic.flags != 0x2000:
            raise Fault()
        self.acquire('CreateFileMappingW', self.HANDLE(-1), None, 4, 0,
                     c.sizeof(self.Transfer), None, target='mapping')
        self.noninherit(self.mapping)
        self.view = self.map_view(self.mapping, 4)  # Supervisor is read-only.
        for name in ('published', 'ack', 'leaf_ready', 'leaf_go', 'pacer'):
            self.acquire('CreateEventW', None, True, False, None, target=name)
            self.noninherit(getattr(self, name))
        pseudo = self.call('GetCurrentProcess')
        # Only these five endpoints cross into root. No job/process/thread.
        inherited = [self.duplicate(pseudo, handle, access, True)
                     for handle, access in (
                         (self.mapping, 6), (self.published, 2),
                         (self.ack, 0x100000), (self.leaf_ready, 2),
                         (self.leaf_go, 0x100000))]
        self.attributes(inherited, self.job)

    def create_fixed(self, role, handles):
        import subprocess
        c = self.c
        if role not in ('--root', '--leaf'):
            raise Fault()
        executable = sys.executable
        if (not os.path.isabs(executable) or os.path.basename(executable).lower()
                not in ('python.exe', 'pythonw.exe', 'python3.exe')):
            raise Fault()
        system_root = os.environ.get('SystemRoot', '')
        if not os.path.isabs(system_root) or '\0' in system_root:
            raise Fault()
        deadline = str(self.budget.deadline_ns)
        command = c.create_unicode_buffer(subprocess.list2cmdline([
            executable, '-I', '-S', '-B', os.path.abspath(__file__), role,
            *(str(value) for value in handles), deadline]))
        environment = c.create_unicode_buffer('SystemRoot=' + system_root + '\0\0')
        startup, info = self.StartupEx(), self.ProcessInfo()
        startup.startup.cb = c.sizeof(startup)
        startup.startup.flags = 0x100  # USESTDHANDLES, all three NULL.
        startup.attributes = c.cast(self.attribute_buffer, c.c_void_p)
        self.info = info

        def register(unused):
            self.process, self.thread = info.process, info.thread
            self.handles.extend((info.process, info.thread))
            if self.role == 'root':
                # Set before a deadline check can unwind creation.
                self.source_slots = (info.process, info.thread)
                self.preserve_sources = True
        self.call('CreateProcessW', executable, command, None, None, True,
                  0x00080000 | 0x00000004 | 0x00000400 | 0x00000008,
                  environment, None, c.byref(startup), c.byref(info), register=register)
        self.noninherit(self.process)
        self.noninherit(self.thread)

    def create_root(self):
        self.create_fixed('--root', list(self.inherit_array))

    def birth(self, process):
        times = [self.FileTime() for unused in range(4)]
        self.call('GetProcessTimes', process,
                  *(self.c.byref(value) for value in times))
        return times[0].low | (times[0].high << 32)

    def wait(self, handle, milliseconds):
        return self.call('WaitForSingleObject', handle, milliseconds,
                         checked=False, failed=0xFFFFFFFF)

    def pair_identity(self, process, thread, pid, tid, birth=None, job=None):
        if not process or not thread or process == thread or not pid or not tid:
            return False
        self.noninherit(process)
        self.noninherit(thread)
        births = []
        for unused in range(2):
            if (self.call('GetProcessId', process) != pid
                    or self.call('GetThreadId', thread) != tid
                    or self.call('GetProcessIdOfThread', thread) != pid):
                return False
            births.append(self.birth(process))
            member = self.c.c_int32()
            self.call('IsProcessInJob', process, job, self.c.byref(member))
            if (not member.value or self.wait(process, 0) != 258
                    or self.wait(thread, 0) != 258):
                return False
        valid = bool(births[0] and births[0] == births[1]
                     and (birth is None or births[0] == birth))
        if valid:
            self.verified_birth = births[0]
        return valid

    def identity_root(self):
        for handle in (self.job, self.mapping, self.published, self.ack,
                       self.leaf_ready, self.leaf_go, self.pacer):
            self.noninherit(handle)
        valid = self.pair_identity(self.process, self.thread,
                                   self.info.pid, self.info.tid, job=self.job)
        if valid:
            self.root_birth = self.verified_birth
        return valid

    def root_evidence(self):
        return {'root_pid': self.info.pid, 'root_tid': self.info.tid,
                'root_creation_filetime': self.root_birth}

    def resume_root(self):
        if self.root_resumed:
            raise Fault()
        self.root_resumed = True  # Includes a failed/late call: never retry.
        return self.call('ResumeThread', self.thread, checked=False)

    def resume_leaf(self):
        if self.leaf_resumed or not self.acknowledged:
            raise Fault()
        self.leaf_resumed = True
        return self.call('ResumeThread', self.leaf_thread, checked=False)

    def wait_publish(self, milliseconds):
        return self.wait(self.published, milliseconds)

    def read_snapshot(self):
        self.budget.check()
        snapshot = self.c.string_at(self.view, self.c.sizeof(self.Transfer))
        self.budget.check()
        value = self.Transfer.from_buffer_copy(snapshot)
        maximum = (1 << (self.c.sizeof(self.HANDLE) * 8)) - 1
        if (value.version != 1 or value.size != self.c.sizeof(self.Transfer)
                or value.published != 1 or value.reserved != 0
                or not 0 < value.process_slot < maximum
                or not 0 < value.thread_slot < maximum
                or value.process_slot == value.thread_slot
                or value.process_slot in self.inherit_array
                or value.thread_slot in self.inherit_array
                or not value.pid or value.pid == self.info.pid
                or not value.tid or not value.birth):
            raise Fault()
        return snapshot, value

    def transfer(self):
        if self.snapshot is not None or not self.alive_root():
            raise Fault()
        self.snapshot, self.metadata = self.read_snapshot()
        # Source is the ORIGINAL root creation handle, never a PID lookup.
        self.leaf_process = self.duplicate(self.process, self.metadata.process_slot,
                                           0x101000)
        self.leaf_thread = self.duplicate(self.process, self.metadata.thread_slot,
                                          0x100802)

    def identity_leaf(self):
        value = self.metadata
        valid = self.pair_identity(self.leaf_process, self.leaf_thread,
                                   value.pid, value.tid, value.birth, self.job)
        if valid:
            self.leaf_birth = self.verified_birth
        return valid

    def leaf_evidence(self):
        return {'leaf_pid': self.metadata.pid, 'leaf_tid': self.metadata.tid,
                'leaf_creation_filetime': self.leaf_birth}

    def acknowledge(self):
        snapshot, unused = self.read_snapshot()
        if snapshot != self.snapshot or not self.alive_root():
            raise Fault()
        self.call('SetEvent', self.ack,
                  register=lambda unused: setattr(self, 'acknowledged', True))

    def wait_root(self, milliseconds):
        return self.wait(self.process, milliseconds)

    def wait_leaf(self, milliseconds):
        return self.wait(self.leaf_process, milliseconds)

    def alive_root(self):
        return self.wait_root(0) == 258

    def alive_leaf(self):
        return self.wait_leaf(0) == 258

    def wait_leaf_ready(self, milliseconds):
        return self.wait(self.leaf_ready, milliseconds)

    def force_root(self, report):
        report['root_force_requested'] = True
        self.call('TerminateProcess', self.process, 91,
                  register=lambda unused: report.__setitem__('root_force_succeeded', True))

    def exit_code_for(self, process):
        value = self.U32()
        self.call('GetExitCodeProcess', process, self.c.byref(value))
        return value.value

    def root_exit_code(self):
        return self.exit_code_for(self.process)

    def leaf_exit_code(self):
        return self.exit_code_for(self.leaf_process)

    def go_leaf(self):
        self.call('SetEvent', self.leaf_go)

    def pace(self, milliseconds):
        return self.wait(self.pacer, milliseconds)

    def job_snapshot(self):
        accounting, inventory = self.Accounting(), self.PidList()
        for kind, value in ((1, accounting), (3, inventory)):
            self.call('QueryInformationJobObject', self.job, kind,
                  self.c.byref(value), self.c.sizeof(value), None)
        if (inventory.listed > len(inventory.ids) or inventory.assigned > 2
                or inventory.assigned != inventory.listed
                or accounting.total > 2 or accounting.active > 2):
            raise Fault()
        return (accounting.total, accounting.active,
                inventory.assigned, inventory.listed)

    def sample(self):
        total, active, assigned, listed = self.job_snapshot()
        root_wait, leaf_wait = self.wait_root(0), self.wait_leaf(0)
        self.last_sample = {
            'job_total': total, 'job_active': active,
            'job_assigned': assigned, 'job_listed': listed,
            'root_wait_result': root_wait, 'leaf_wait_result': leaf_wait,
        }
        return ((total, active, assigned, listed) == (2, 0, 0, 0)
                and root_wait == 0 and leaf_wait == 0)

    def sample_evidence(self):
        return dict(self.last_sample)

    def contain(self, report, failure):
        # Expiry stops normal stages, not a containment REQUEST. No fresh budget.
        report['abort_requested'] = True
        try:
            report['job_terminate_succeeded'] = bool(self.k.TerminateJobObject(self.job, 92))
            if not report['job_terminate_succeeded']:
                failure()
            for handle, key in ((self.process, 'root_actual_exit'),
                                (self.leaf_process, 'leaf_actual_exit')):
                remaining = int((self.budget.deadline - self.budget.clock()) * 1000)
                if handle and remaining > 0:
                    value = self.k.WaitForSingleObject(handle, min(remaining, 60000))
                    if value == 0:
                        report[key] = True
                    elif value == 258:
                        report['result'] = 'TIMEOUT'
                    elif value == 0xFFFFFFFF:
                        failure()
                    else:
                        failure(code=0)
            # Exclusive Job inventory covers even an unknown, untransferred leaf.
            for unused in range(128):
                self.budget.check()
                values = self.job_snapshot()
                if values[1:] == (0, 0, 0):
                    report['containment_zero'] = True
                    return
                before = self.budget.clock()
                value = self.wait(self.pacer, self.budget.milliseconds(100))
                if value != 258 or self.budget.clock() <= before:
                    raise Fault()
            failure(code=0)
        except Deadline:
            # A last-handle close is only fallback containment, not a receipt.
            report['result'] = 'TIMEOUT'
        except Fault as error:
            failure(code=error.code)
        except Exception:
            failure(code=0)

    def cleanup(self, report):
        def failure(kind=None, code=None):
            if code is None:
                code = self.c.get_last_error()
            if not report['winerror']:
                report['winerror'] = int(code) & 0xFFFFFFFF
            report['cleanup_failures'] += 1
            if kind is not None:
                report[kind] += 1
        try:
            if self.role == 'supervisor' and self.job and self.process and not report['control_observed']:
                self.contain(report, failure)
        finally:
            if self.attributes_initialized:
                try:
                    self.k.DeleteProcThreadAttributeList(self.attribute_buffer)
                except Exception:
                    failure('attribute_release_failures', code=0)
                self.attributes_initialized = False
                self.attribute_buffer = self.job_array = self.inherit_array = None
            for view in reversed(self.views):
                try:
                    if not self.k.UnmapViewOfFile(view):
                        failure('view_release_failures')
                except Exception:
                    failure('view_release_failures', code=0)
            self.views.clear()
            # Job remains retained through all containment queries and waits.
            ordered = [h for h in reversed(self.handles) if h != self.job]
            if self.job in self.handles:
                ordered.append(self.job)
            for handle in ordered:
                if self.preserve_sources and handle in self.source_slots:
                    # Unacked root must exit with these slots unchanged. Closing
                    # or reusing them before death would race DuplicateHandle.
                    continue
                try:
                    if not self.k.CloseHandle(handle):
                        failure('handle_close_failures')
                except Exception:
                    failure('handle_close_failures', code=0)
            self.handles.clear()

    def adopt(self, role, handles):
        self.role = role
        self.handles.extend(handles)  # Ownership registered before late checks.
        for handle in handles:
            self.call('SetHandleInformation', handle, 1, 0)
            self.noninherit(handle)

    def root_protocol(self, handles):
        self.adopt('root', handles)
        self.mapping, self.published, self.ack, self.leaf_ready, self.leaf_go = handles
        self.view = self.map_view(self.mapping, 6)
        pseudo = self.call('GetCurrentProcess')
        inherited = [self.duplicate(pseudo, handle, access, True)
                     for handle, access in ((self.leaf_ready, 2), (self.leaf_go, 0x100000))]
        # Exactly HANDLE_LIST, no JOB_LIST or parent-process attribute. The
        # actual root invokes CreateProcess; no breakaway and no leaf resume.
        self.attributes(inherited)
        self.create_fixed('--leaf', inherited)
        if not self.pair_identity(self.process, self.thread,
                                  self.info.pid, self.info.tid):
            raise Fault()
        birth = self.birth(self.process)
        if not birth:
            raise Fault()
        value = self.Transfer.from_address(self.view)
        if any(self.c.string_at(self.view, self.c.sizeof(self.Transfer))):
            raise Fault()
        value.version, value.size = 1, self.c.sizeof(self.Transfer)
        value.process_slot, value.thread_slot = self.source_slots
        value.pid, value.tid, value.birth = self.info.pid, self.info.tid, birth
        value.reserved, value.published = 0, 1
        self.budget.check()
        self.call('SetEvent', self.published)
        waited = self.wait(self.ack, self.budget.milliseconds())
        if waited == 258:
            raise Deadline()
        if waited != 0:
            raise Fault()
        self.acknowledged, self.preserve_sources = True, False
        # Root stays alive until supervisor's retained-handle force. If leaf
        # exits or D expires instead, leave this role; never wait indefinitely.
        waited = self.wait(self.process, self.budget.milliseconds())
        if waited == 258:
            raise Deadline()
        raise Fault()

    def leaf_protocol(self, handles):
        self.adopt('leaf', handles)
        ready, go = handles
        self.call('SetEvent', ready)
        waited = self.wait(go, self.budget.milliseconds())
        if waited == 258:
            raise Deadline()
        if waited != 0:
            raise Fault()


def role_arguments(arguments, count, clock=time.monotonic):
    if len(arguments) != count + 1:
        raise Fault()
    import ctypes as c
    maximum = (1 << (c.sizeof(c.c_void_p) * 8)) - 1
    handles = [number(value, maximum) for value in arguments[:count]]
    if len(set(handles)) != count:
        raise Fault()
    return handles, absolute_budget(arguments[-1], clock)


def internal_role(role, arguments):
    native, report, result = None, new_report(), 94
    try:
        if os.name != 'nt':
            return result
        handles, budget = role_arguments(arguments, 5 if role == '--root' else 2)
        native = Native(budget)
        if role == '--root':
            native.root_protocol(handles)
        elif role == '--leaf':
            native.leaf_protocol(handles)
        else:
            raise Fault()
        budget.check()
        result = 0
    except Deadline:
        result = 95
    except Exception:
        pass
    finally:
        if native is not None:
            try:
                native.cleanup(report)
            except Exception:
                report['cleanup_failures'] += 1
            if report['cleanup_failures']:
                result = 96
            elif native.budget.clock() >= native.budget.deadline:
                result = 95
    # For an unacked root, immediate role exit lets process death release the
    # retained slots. There must be no further work after this return in main.
    return result


def safe_payload(report):
    # Refuse injected keys/types/strings even from an erroneous test backend.
    template = new_report()
    if set(report) != set(template):
        raise Fault()
    if report['result'] not in ('UNKNOWN', 'TIMEOUT'):
        raise Fault()
    if report['phase'] not in ('SETUP', 'CREATE_ROOT', 'IDENTITY_ROOT', 'RESUME_ROOT',
                              'PUBLISH', 'TRANSFER', 'IDENTITY_LEAF', 'ACK',
                              'RESUME_LEAF', 'READY_LEAF', 'FORCE_ROOT', 'GO_LEAF',
                              'EXIT_LEAF', 'OBSERVE'):
        raise Fault()
    for key, default in template.items():
        value = report[key]
        if isinstance(default, bool):
            if type(value) is not bool:
                raise Fault()
        elif isinstance(default, int):
            maximum = (1 << 64) - 1 if key.endswith('_creation_filetime') else 0xFFFFFFFF
            if type(value) is not int or not 0 <= value <= maximum:
                raise Fault()
        elif isinstance(default, float):
            if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
                raise Fault()
        elif isinstance(default, list):
            if type(value) is not list or len(value) > 128:
                raise Fault()
            fields = {'offset_seconds', 'job_total', 'job_active', 'job_assigned',
                      'job_listed', 'root_wait_result', 'leaf_wait_result'}
            for sample in value:
                if type(sample) is not dict or set(sample) != fields:
                    raise Fault()
                offset = sample['offset_seconds']
                if type(offset) not in (int, float) or not math.isfinite(offset) or offset < 0:
                    raise Fault()
                for field in fields - {'offset_seconds'}:
                    if type(sample[field]) is not int or not 0 <= sample[field] <= 0xFFFFFFFF:
                        raise Fault()
    if len(report['job_samples']) != report['samplecount']:
        raise Fault()
    if report['evidence_complete']:
        raise Fault()
    return json.dumps(report, separators=(',', ':'), allow_nan=False)


def emit_report(report, budget, output):
    """Single stdout writer, not durable publication. Exit status must be kept."""
    def late():
        if budget.clock() >= budget.deadline:
            report['result'], report['candidate'] = 'TIMEOUT', False
            report['deadline_overrun'] = True
            return True
        return False
    try:
        late()
        payload = safe_payload(report)
        if late():
            payload = safe_payload(report)
        output.write(payload + '\n')
        output.flush()
    except Exception:
        report['candidate'] = False
        return 4
    # An already emitted line cannot be retracted if output itself finishes
    # late. It never claims PASS/durability; external capture must retain code 3.
    return 3 if late() else 2


class QuietParser(argparse.ArgumentParser):
    def error(self, message):
        raise Fault()


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    if arguments and arguments[0] in ('--root', '--leaf'):
        return internal_role(arguments[0], arguments[1:])
    parser = QuietParser(add_help=False, allow_abbrev=False)
    parser.add_argument('--execute-descendant', action='store_true')
    parser.add_argument('--preparation-reviewed', action='store_true')
    parser.add_argument('--execution-authorization')
    try:
        args = parser.parse_args(arguments)
        execute = (args.execute_descendant and args.preparation_reviewed
                   and args.execution_authorization and args.execution_authorization.strip())
    except Exception:
        execute = False
    if not execute:
        try:
            sys.stdout.write('{"result":"NOT_RUN","candidate":false,"evidence_complete":false}\n')
            sys.stdout.flush()
        except Exception:
            return 4
        return 0 if not arguments else 2
    # These switches are manual gates, NOT proof of authorization. The caller
    # must separately freeze the reviewed source identity and single-run budget.
    report, budget = run_state(Native)
    return emit_report(report, budget, sys.stdout)


if __name__ == '__main__':
    raise SystemExit(main())
