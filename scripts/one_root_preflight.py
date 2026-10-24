"""#119 preparation only. Native execution requires separate parent approval.

No runtime verification was performed by the author. A candidate is not PASS:
stdout durability and external acceptance cannot be certified by this process.
"""
import argparse
import json
import os
import sys
import time


class Fault(Exception):
    def __init__(self, code=0):
        self.code = int(code) & 0xFFFFFFFF


class Deadline(Fault):
    pass


class Budget:
    def __init__(self, clock):
        self.clock = clock
        self.t0 = clock()
        self.deadline = self.t0 + 60.0

    def check(self, reserve=0.0):
        if self.deadline - self.clock() <= reserve:
            raise Deadline()

    def milliseconds(self, cap=60000):
        value = min(cap, int((self.deadline - self.clock()) * 1000))
        if value <= 0:
            raise Deadline()
        return value


def run_state(factory, clock=time.monotonic, *, diagnostics=False):
    """factory(budget) permits pure fake testing without constructing Native."""
    budget = Budget(clock)
    report = {
        "result": "UNKNOWN", "phase": "SETUP", "winerror": 0,
        "candidate": False, "ownership": False, "actual_exit": False,
        "natural_exit": False, "terminate_requested": False,
        "terminate_succeeded": False, "resource_seconds": 0.0,
        "samplecount": 0, "handle_close_failures": 0,
        "cleanup_failures": 0, "deadline_overrun": False,
        "evidence_complete": False,
        "creation_filetime": 0, "created_pid": 0, "created_tid": 0,
    }
    observation = None
    if diagnostics:
        observation = {
            "stage": "not_observed", "reason": "not_observed",
            "snapshot": {
                "root_wait_result": None, "job_total": None,
                "job_active": None, "job_assigned": None, "job_listed": None,
            },
            "root_pid": None, "root_in_job": None,
            "job_ids": None, "job_ids_capacity": None,
            "job_ids_truncated": None,
            "root_pid_in_job_ids": None,
        }
        report["observation_diagnostics"] = observation
    backend = None
    completed = False

    def step(name, *args, reserve=0.0):
        budget.check(reserve)
        value = getattr(backend, name)(*args)
        budget.check()
        return value

    def observe(name, *, reserve=0.0):
        if observation is not None and name == "reset_ready":
            observation["stage"] = "reset_ready"
        try:
            return step(name, reserve=reserve)
        except Deadline:
            # Expiry is not an API failure, even though Deadline is a Fault.
            raise
        except Fault:
            if observation is not None:
                observation["reason"] = "api_failure"
            raise

    try:
        budget.check(6.0)
        backend = factory(budget)
        if observation is not None:
            backend.observation_diagnostics = observation
        budget.check()
        step("prepare", reserve=6.0)
        report["phase"] = "CREATE"
        step("create", budget.milliseconds(), reserve=6.0)
        report["phase"] = "IDENTITY"
        if not step("identity", reserve=6.0):
            raise Fault()
        report["ownership"] = True
        report.update(step("birth_evidence"))
        report["phase"] = "RESUME"
        if step("resume", reserve=6.0) != 1:
            raise Fault()
        report["phase"] = "READY"
        ready = step("wait_ready", budget.milliseconds())
        if ready == 258:
            raise Deadline()
        if ready != 0:
            raise Fault()
        if not step("alive"):
            raise Fault()
        step("go", reserve=6.0)
        report["phase"] = "EXIT"
        exited = step("wait_root", budget.milliseconds())
        if exited == 258:
            raise Deadline()
        if exited != 0:
            raise Fault()
        report["actual_exit"] = True
        if step("exit_code") != 0:
            raise Fault()
        report["natural_exit"] = True
        report["phase"] = "OBSERVE"
        observe("reset_ready", reserve=6.0)
        if not observe("sample"):
            raise Fault()
        # Query time before the first valid sample is not resource observation.
        observation_start = clock()
        report["samplecount"] = 1
        budget.check(6.0)
        # The exited child cannot set READY again. Waiting on it is observation
        # pacing, not a retry, compensating sleep, or waiting on a signaled root.
        while True:
            before = clock()
            if step("pace", budget.milliseconds(100)) != 258:
                raise Fault()
            if clock() <= before:
                raise Fault()
            if not observe("sample"):
                raise Fault()
            report["samplecount"] += 1
            report["resource_seconds"] = clock() - observation_start
            if report["resource_seconds"] >= 6.0:
                # Start/end alone do not prove the required intervening sample.
                if report["samplecount"] < 3:
                    raise Fault()
                break
            if report["samplecount"] >= 128:
                raise Fault()
        completed = True
    except Deadline as error:
        report["result"] = "TIMEOUT"
        report["winerror"] = error.code
    except Fault as error:
        report["winerror"] = error.code
    except Exception:
        # Never persist arbitrary exception text, command lines, or paths.
        report["winerror"] = 0
        if observation is not None and report["phase"] == "OBSERVE":
            observation["reason"] = "unclassified_exception"
    finally:
        if backend is not None:
            try:
                backend.cleanup(report)
            except Exception:
                report["cleanup_failures"] += 1
        report["deadline_overrun"] = clock() >= budget.deadline
        if report["deadline_overrun"]:
            report["result"] = "TIMEOUT"
        report["candidate"] = bool(
            completed and report["result"] != "TIMEOUT"
            and not report["terminate_requested"]
            and not report["cleanup_failures"]
            and not report["handle_close_failures"]
        )
    return report, budget


class Native:
    def __init__(self, budget):
        # Construction binds functions only; acquisition starts in prepare().
        # Thus a constructor failure cannot orphan a newly created handle.
        self.budget = budget
        self.handles = []
        self.attributes_initialized = False
        self.attribute_buffer = self.job_array = self.inherit_array = None
        self.process = self.thread = self.job = None
        self.root_in_job = None
        budget.check()
        if os.name != "nt":
            raise Fault()
        self._bind()
        budget.check()

    def _bind(self):
        import ctypes as c
        self.c = c
        U32, U64, SIZE, HANDLE = c.c_uint32, c.c_uint64, c.c_size_t, c.c_void_p
        BOOL, PTR, WCHAR = c.c_int32, c.c_void_p, c.c_wchar_p
        self.U32, self.HANDLE = U32, HANDLE

        class FileTime(c.Structure):
            _fields_ = [("low", U32), ("high", U32)]

        class BasicLimit(c.Structure):
            _fields_ = [
                ("process_time", c.c_int64), ("job_time", c.c_int64),
                ("flags", U32), ("minimum", SIZE), ("maximum", SIZE),
                ("active_limit", U32), ("affinity", SIZE),
                ("priority", U32), ("scheduling", U32),
            ]

        class IOCounters(c.Structure):
            _fields_ = [(name, U64) for name in
                        ("read_ops", "write_ops", "other_ops",
                         "read_bytes", "write_bytes", "other_bytes")]

        class ExtendedLimit(c.Structure):
            _fields_ = [
                ("basic", BasicLimit), ("io", IOCounters),
                ("process_memory", SIZE), ("job_memory", SIZE),
                ("peak_process", SIZE), ("peak_job", SIZE),
            ]

        class Accounting(c.Structure):
            _fields_ = [
                ("user", c.c_int64), ("kernel", c.c_int64),
                ("period_user", c.c_int64), ("period_kernel", c.c_int64),
                ("faults", U32), ("total", U32),
                ("active", U32), ("terminated", U32),
            ]

        class PidList(c.Structure):
            _fields_ = [("assigned", U32), ("listed", U32),
                        ("ids", SIZE * 1)]

        class StartupInfo(c.Structure):
            _fields_ = [
                ("cb", U32), ("reserved", WCHAR), ("desktop", WCHAR),
                ("title", WCHAR), ("x", U32), ("y", U32),
                ("width", U32), ("height", U32), ("chars_x", U32),
                ("chars_y", U32), ("fill", U32), ("flags", U32),
                ("show", c.c_uint16), ("reserved_size", c.c_uint16),
                ("reserved_bytes", c.POINTER(c.c_ubyte)),
                ("stdin", HANDLE), ("stdout", HANDLE), ("stderr", HANDLE),
            ]

        class StartupEx(c.Structure):
            _fields_ = [("startup", StartupInfo), ("attributes", PTR)]

        class ProcessInfo(c.Structure):
            _fields_ = [("process", HANDLE), ("thread", HANDLE),
                        ("pid", U32), ("tid", U32)]

        self.FileTime, self.ExtendedLimit = FileTime, ExtendedLimit
        self.Accounting, self.PidList = Accounting, PidList
        self.StartupEx, self.ProcessInfo = StartupEx, ProcessInfo
        self.k = c.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ([PTR, WCHAR], HANDLE),
            "SetInformationJobObject": ([HANDLE, c.c_int, PTR, U32], BOOL),
            "QueryInformationJobObject":
                ([HANDLE, c.c_int, PTR, U32, c.POINTER(U32)], BOOL),
            "CreateEventW": ([PTR, BOOL, BOOL, WCHAR], HANDLE),
            "GetHandleInformation": ([HANDLE, c.POINTER(U32)], BOOL),
            "GetCurrentProcess": ([], HANDLE),
            "DuplicateHandle":
                ([HANDLE, HANDLE, HANDLE, c.POINTER(HANDLE), U32, BOOL, U32], BOOL),
            "InitializeProcThreadAttributeList":
                ([PTR, U32, U32, c.POINTER(SIZE)], BOOL),
            "UpdateProcThreadAttribute":
                ([PTR, U32, SIZE, PTR, SIZE, PTR, PTR], BOOL),
            "DeleteProcThreadAttributeList": ([PTR], None),
            "CreateProcessW":
                ([WCHAR, c.POINTER(c.c_wchar), PTR, PTR, BOOL, U32,
                  PTR, WCHAR, c.POINTER(StartupEx), c.POINTER(ProcessInfo)], BOOL),
            "GetProcessId": ([HANDLE], U32),
            "GetThreadId": ([HANDLE], U32),
            "GetProcessIdOfThread": ([HANDLE], U32),
            "GetProcessTimes":
                ([HANDLE] + [c.POINTER(FileTime)] * 4, BOOL),
            "IsProcessInJob": ([HANDLE, HANDLE, c.POINTER(BOOL)], BOOL),
            "WaitForSingleObject": ([HANDLE, U32], U32),
            "ResumeThread": ([HANDLE], U32),
            "SetEvent": ([HANDLE], BOOL), "ResetEvent": ([HANDLE], BOOL),
            "GetExitCodeProcess": ([HANDLE, c.POINTER(U32)], BOOL),
            "TerminateProcess": ([HANDLE, U32], BOOL),
            "CloseHandle": ([HANDLE], BOOL),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.k, name)
            function.argtypes, function.restype = args, result

    def call(self, name, *args, checked=True, register=None, failed=None):
        self.budget.check()
        result = getattr(self.k, name)(*args)
        error = self.c.get_last_error()
        # Acquisition must be registered before a late return can time out.
        if result and register is not None:
            register(result)
        if failed is not None and result == failed:
            raise Fault(error)
        self.budget.check()
        if checked and not result:
            raise Fault(error)
        return result

    def noninherit(self, handle, expected=False):
        flags = self.U32()
        self.call("GetHandleInformation", handle, self.c.byref(flags))
        if bool(flags.value & 1) != expected:
            raise Fault()

    def new_handle(self, name, *args):
        return self.call(name, *args, register=self.handles.append)

    def prepare(self):
        c = self.c
        self.job = self.new_handle("CreateJobObjectW", None, None)
        self.noninherit(self.job)
        limits = self.ExtendedLimit()
        limits.basic.flags = 0x2000  # KILL_ON_JOB_CLOSE; no breakaway.
        self.call("SetInformationJobObject", self.job, 9,
                  c.byref(limits), c.sizeof(limits))
        readback = self.ExtendedLimit()
        self.call("QueryInformationJobObject", self.job, 9,
                  c.byref(readback), c.sizeof(readback), None)
        if readback.basic.flags != 0x2000:
            raise Fault()
        self.ready = self.new_handle("CreateEventW", None, True, False, None)
        self.go_event = self.new_handle("CreateEventW", None, True, False, None)
        self.noninherit(self.ready)
        self.noninherit(self.go_event)
        pseudo = self.call("GetCurrentProcess")
        children = []
        for original, access in ((self.ready, 2), (self.go_event, 0x100000)):
            duplicate = self.HANDLE()
            self.call(
                "DuplicateHandle", pseudo, original, pseudo, c.byref(duplicate),
                access, True, 0,
                register=lambda result, h=duplicate: self.handles.append(h.value),
            )
            children.append(duplicate.value)
            self.noninherit(duplicate.value, True)
        size = c.c_size_t()
        result = self.call("InitializeProcThreadAttributeList", None, 2, 0,
                           c.byref(size), checked=False)
        if result or not size.value or c.get_last_error() != 122:
            raise Fault()
        self.attribute_buffer = c.create_string_buffer(size.value)
        self.call(
            "InitializeProcThreadAttributeList", self.attribute_buffer, 2, 0,
            c.byref(size),
            register=lambda result: setattr(self, "attributes_initialized", True),
        )
        # lpValue arrays remain alive until DeleteProcThreadAttributeList.
        self.job_array = (self.HANDLE * 1)(self.job)
        self.inherit_array = (self.HANDLE * 2)(*children)
        for attribute, value in ((0x2000D, self.job_array),
                                 (0x20002, self.inherit_array)):
            self.call("UpdateProcThreadAttribute", self.attribute_buffer, 0,
                      attribute, value, c.sizeof(value), None, None)

    def create(self, timeout_ms):
        import subprocess
        c = self.c
        executable = sys.executable
        if not os.path.isabs(executable) or os.path.basename(executable).lower() in (
                "py.exe", "pyw.exe", "python", "py", "pymanager.exe"):
            raise Fault()
        script = os.path.abspath(__file__)
        system_root = os.environ.get("SystemRoot", "")
        if not os.path.isabs(system_root):
            raise Fault()
        command = c.create_unicode_buffer(subprocess.list2cmdline([
            executable, "-I", "-S", "-B", script, "--child",
            str(self.inherit_array[0]), str(self.inherit_array[1]),
            str(timeout_ms),
        ]))
        environment = c.create_unicode_buffer("SystemRoot=" + system_root + "\0\0")
        startup, info = self.StartupEx(), self.ProcessInfo()
        startup.startup.cb = c.sizeof(startup)
        startup.startup.flags = 0x100  # USESTDHANDLES; all three remain NULL.
        startup.attributes = c.cast(self.attribute_buffer, c.c_void_p)
        self.info = info

        def register(result):
            self.process, self.thread = info.process, info.thread
            self.handles.extend((info.process, info.thread))

        self.call("CreateProcessW", executable, command, None, None, True,
                  0x00080000 | 0x00000004 | 0x00000400 | 0x08000000,
                  environment, None, c.byref(startup), c.byref(info),
                  register=register)

    def identity(self):
        c = self.c
        for handle in (self.job, self.ready, self.go_event,
                       self.process, self.thread):
            self.noninherit(handle)
        births = []
        for unused in range(2):
            if (self.call("GetProcessId", self.process) != self.info.pid
                    or self.call("GetThreadId", self.thread) != self.info.tid
                    or self.call("GetProcessIdOfThread", self.thread) != self.info.pid):
                return False
            times = [self.FileTime() for index in range(4)]
            self.call("GetProcessTimes", self.process,
                      *(c.byref(value) for value in times))
            births.append((times[0].high << 32) | times[0].low)
            member = c.c_int32()
            self.call("IsProcessInJob", self.process, self.job, c.byref(member))
            self.root_in_job = bool(member.value)
            if not self.root_in_job or not self.alive():
                return False
        valid = births[0] != 0 and births[0] == births[1]
        if valid:
            self.verified_birth = births[0]
        return valid

    def birth_evidence(self):
        return {"creation_filetime": self.verified_birth,
                "created_pid": self.info.pid, "created_tid": self.info.tid}

    def alive(self):
        return self.wait_root(0) == 258

    def resume(self):
        return self.call("ResumeThread", self.thread, checked=False)

    def wait_root(self, milliseconds):
        return self.call("WaitForSingleObject", self.process, milliseconds,
                         checked=False, failed=0xFFFFFFFF)

    def wait_ready(self, milliseconds):
        return self.call("WaitForSingleObject", self.ready, milliseconds,
                         checked=False, failed=0xFFFFFFFF)

    def go(self):
        self.call("SetEvent", self.go_event)

    def reset_ready(self):
        self.call("ResetEvent", self.ready)

    def pace(self, milliseconds):
        return self.wait_ready(milliseconds)

    def exit_code(self):
        value = self.U32()
        self.call("GetExitCodeProcess", self.process, self.c.byref(value))
        return value.value

    def sample(self):
        observation = getattr(self, "observation_diagnostics", None)
        if observation is not None:
            # A later failed sample must not reuse an earlier sample's values.
            observation["snapshot"] = {
                "root_wait_result": None, "job_total": None,
                "job_active": None, "job_assigned": None, "job_listed": None,
            }
            observation["root_pid"] = None
            observation["root_in_job"] = getattr(self, "root_in_job", None)
            observation["job_ids"] = None
            observation["job_ids_capacity"] = None
            observation["job_ids_truncated"] = None
            observation["root_pid_in_job_ids"] = None
            info = getattr(self, "info", None)
            if info is not None:
                observation["root_pid"] = int(info.pid)
            observation["stage"] = "query_accounting"
            observation["reason"] = "not_observed"
        accounting, inventory = self.Accounting(), self.PidList()
        for kind, value in ((1, accounting), (3, inventory)):
            if observation is not None:
                observation["stage"] = ("query_accounting" if kind == 1
                                        else "query_inventory")
            self.call("QueryInformationJobObject", self.job, kind,
                      self.c.byref(value), self.c.sizeof(value), None)
            if observation is not None:
                snapshot = observation["snapshot"]
                if kind == 1:
                    snapshot["job_total"] = accounting.total
                    snapshot["job_active"] = accounting.active
                else:
                    snapshot["job_assigned"] = inventory.assigned
                    snapshot["job_listed"] = inventory.listed
                    ids = getattr(inventory, "ids", ())
                    capacity = len(ids)
                    listed = max(0, min(int(inventory.listed), capacity))
                    observation["job_ids_capacity"] = capacity
                    observation["job_ids_truncated"] = int(inventory.listed) > capacity
                    observation["job_ids"] = [int(ids[index]) for index in range(listed)]
                    root_pid = observation["root_pid"]
                    if root_pid is not None:
                        observation["root_pid_in_job_ids"] = (
                            root_pid in observation["job_ids"])
        if observation is not None:
            observation["stage"] = "wait_root"
        waited = self.wait_root(0)
        if observation is not None:
            observation["snapshot"]["root_wait_result"] = waited
            observation["stage"] = "predicate"
            if waited != 0:
                reason = "root_not_signaled"
            elif accounting.total != 1:
                reason = "job_total_not_one"
            elif accounting.active != 0:
                reason = "job_active_not_zero"
            elif inventory.assigned != 0:
                reason = "job_assigned_not_zero"
            elif inventory.listed != 0:
                reason = "job_listed_not_zero"
            else:
                reason = "ok"
            observation["reason"] = reason
        return (waited == 0 and accounting.total == 1
                and accounting.active == 0 and inventory.assigned == 0
                and inventory.listed == 0)

    def cleanup(self, report):
        def failure(close=False, code=None):
            code = (self.c.get_last_error() if code is None else code) & 0xFFFFFFFF
            if not report["winerror"]:
                report["winerror"] = code
            report["cleanup_failures"] += 1
            if close:
                report["handle_close_failures"] += 1

        try:
            if self.process and not report["actual_exit"]:
                report["terminate_requested"] = True
                try:
                    report["terminate_succeeded"] = bool(
                        self.k.TerminateProcess(self.process, 90))
                    if not report["terminate_succeeded"]:
                        failure()
                    remaining = int(
                        (self.budget.deadline - self.budget.clock()) * 1000)
                    if remaining > 0:
                        waited = self.k.WaitForSingleObject(
                            self.process, min(remaining, 60000))
                        error = self.c.get_last_error()
                        report["actual_exit"] = waited == 0
                        if waited == 0xFFFFFFFF:
                            failure(code=error)
                except Exception:
                    failure()
        finally:
            if self.attributes_initialized:
                try:
                    self.k.DeleteProcThreadAttributeList(self.attribute_buffer)
                    self.attributes_initialized = False
                    self.attribute_buffer = self.job_array = self.inherit_array = None
                except Exception:
                    failure()
            for handle in reversed(self.handles):
                try:
                    if not self.k.CloseHandle(handle):
                        failure(True)
                except Exception:
                    failure(True)
            self.handles.clear()


def child(arguments):
    """Internal benign role; no output, descendants, or general command input."""
    handles = []
    kernel = None
    result = 94
    try:
        if os.name != "nt" or len(arguments) != 3:
            return result
        values = [int(value) for value in arguments]
        ready, go, milliseconds = values
        if ready <= 0 or go <= 0 or ready == go or not 1 <= milliseconds <= 60000:
            return result
        import ctypes as c
        maximum = (1 << (c.sizeof(c.c_void_p) * 8)) - 1
        if ready >= maximum or go >= maximum:
            return result
        kernel = c.WinDLL("kernel32", use_last_error=True)
        for name, args, restype in (
            ("SetEvent", [c.c_void_p], c.c_int32),
            ("WaitForSingleObject", [c.c_void_p, c.c_uint32], c.c_uint32),
            ("CloseHandle", [c.c_void_p], c.c_int32),
        ):
            function = getattr(kernel, name)
            function.argtypes, function.restype = args, restype
        handles = [ready, go]
        if kernel.SetEvent(ready):
            result = 0 if kernel.WaitForSingleObject(go, milliseconds) == 0 else 95
    except Exception:
        result = 94
    finally:
        for handle in handles:
            try:
                if not kernel.CloseHandle(handle):
                    result = 96
            except Exception:
                result = 96
    return result


def main(arguments=None):
    arguments = sys.argv[1:] if arguments is None else arguments
    if arguments and arguments[0] == "--child":
        return child(arguments[1:])
    parser = argparse.ArgumentParser(description="Preparation only; no default native run.")
    parser.add_argument("--execute-one-root", action="store_true")
    parser.add_argument("--preparation-reviewed", action="store_true")
    parser.add_argument("--execution-authorization")
    parser.add_argument("--observe-diagnostics", action="store_true")
    args = parser.parse_args(arguments)
    if not args.execute_one_root:
        print('{"result":"NOT_RUN","candidate":false,"evidence_complete":false}')
        return 0
    if (not args.preparation_reviewed or not args.execution_authorization
            or not args.execution_authorization.strip()):
        print('{"result":"NOT_RUN","candidate":false,"evidence_complete":false}')
        return 2
    # Flags are manual gates, not authenticated authorization. Never log text.
    report, budget = run_state(Native, diagnostics=args.observe_diagnostics)
    try:
        if budget.clock() >= budget.deadline:
            report["result"], report["candidate"] = "TIMEOUT", False
            report["deadline_overrun"] = True
        payload = json.dumps(report, separators=(",", ":"), allow_nan=False)
        if budget.clock() >= budget.deadline:
            report["result"], report["candidate"] = "TIMEOUT", False
            report["deadline_overrun"] = True
            payload = json.dumps(report, separators=(",", ":"), allow_nan=False)
        sys.stdout.write(payload + "\n")
        sys.stdout.flush()
    except Exception:
        return 4
    # Output itself can finish late. No emitted receipt ever claims PASS or
    # durable evidence; external capture and independent acceptance are required.
    return 3 if budget.clock() >= budget.deadline else 2


if __name__ == "__main__":
    raise SystemExit(main())
