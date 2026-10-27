"""Fixed host observation. Real Windows resources are never acquired at import."""

RUNTIME_ROOT = 'D:/WILL/TOOLS/web_access_gateway_proj/.worktrees/119-crawler-teardown/reports/wag119-receipt-observation-20261026-1'


class FixedHostPort:
    """Lazy native adapter; supplied API is only a pure-test dependency seam."""
    def __init__(self, api=None, startup_factory=None, deadline=None):
        self.api, self.startup_factory, self.deadline = api, startup_factory, deadline
        self.created = False
        self.attempted = False
        self.owned = []
        self.errors = []
        self.readers = {}
        self.process = None
    def acquire(self, handles):
        self.owned.extend(handles)
        self.deadline.check()
        return handles
    def release(self, handle):
        self.owned.remove(handle)
        try:
            self.api.CloseHandle(handle)
        except Exception:
            self.errors.append('CLOSE_UNCERTAIN')
            raise
    def launch(self):
        if self.attempted:
            raise ValueError()
        self.attempted = True
        self.deadline.check()
        import subprocess
        import receipt_model
        if self.api is None:
            import _winapi
            self.api = _winapi
        if self.startup_factory is None:
            self.startup_factory = subprocess.STARTUPINFO
        stdin_read, stdin_write = self.acquire(self.api.CreatePipe(None, 0))
        out_read, out_write = self.acquire(self.api.CreatePipe(None, 0))
        err_read, err_write = self.acquire(self.api.CreatePipe(None, 0))
        self.readers = dict(stdout=out_read, stderr=err_read)
        child = []
        for handle in (stdin_read, out_write, err_write):
            self.deadline.check()
            current = self.api.GetCurrentProcess()
            self.deadline.check()
            duplicate, = self.acquire((self.api.DuplicateHandle(current, handle, current, 0, 1, 2),))
            child.append(duplicate)
        startup = self.startup_factory()
        startup.dwFlags = 0x100
        startup.hStdInput, startup.hStdOutput, startup.hStdError = child
        startup.lpAttributeList = {'handle_list': child}
        executable = 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
        command = subprocess.list2cmdline([executable, '-NoProfile', '-NonInteractive',
                                          '-Command', receipt_model.host_payload()])
        environment = dict(SystemRoot='C:/Windows', WINDIR='C:/Windows',
                           PSModulePath='C:/Windows/System32/WindowsPowerShell/v1.0/Modules',
                           TEMP=RUNTIME_ROOT, TMP=RUNTIME_ROOT)
        self.deadline.check()
        hp, ht, _, _ = self.api.CreateProcess(executable, command, None, None, 1,
                                             0x08000000, environment, RUNTIME_ROOT, startup)
        self.created = True
        self.process = hp
        self.acquire((hp, ht))
        for handle in (stdin_read, stdin_write, out_write, err_write, *child, ht):
            self.deadline.check()
            self.release(handle)
            self.deadline.check()
    def peek(self, channel):
        self.deadline.check()
        try:
            available, _ = self.api.PeekNamedPipe(self.readers[channel], 0)
            return available
        except OSError as error:
            if error.winerror == 109:
                return None
            raise
    def read(self, channel, count):
        if type(count) is not int or not 0 < count <= 1024:
            raise ValueError()
        self.deadline.check()
        data, error = self.api.ReadFile(self.readers[channel], count)
        if error != 0:
            raise ValueError()
        return data
    def wait(self, milliseconds):
        if type(milliseconds) is not int or not 0 <= milliseconds <= 10:
            raise ValueError()
        self.deadline.check()
        try:
            return self.api.WaitForSingleObject(self.process, milliseconds)
        except OSError:
            # CPython raises on WAIT_FAILED rather than returning that DWORD.
            return 0xffffffff
    def exit_code(self):
        self.deadline.check()
        return self.api.GetExitCodeProcess(self.process)
    def close(self):
        # A failed close may already have released the numeric value: never retry it.
        for handle in tuple(reversed(self.owned)):
            try:
                self.release(handle)
            except Exception:
                pass
        return list(self.errors)


def observe_fixed_host(port, deadline):
    result = dict(result='UNKNOWN_OR_INCOMPLETE', stdout=None, stderr=None,
                  actual_exit=None, drain_complete=False, errors=[])
    streams = {'stdout': bytearray(), 'stderr': bytearray()}
    eof = set()
    try:
        deadline.check()
        port.launch()
        for _ in range(4096):
            deadline.check()
            for channel in streams:
                if channel in eof:
                    continue
                available = port.peek(channel)
                deadline.check()
                if available is not None and (type(available) is not int or available < 0):
                    result['errors'].append('PIPE_INVALID')
                    raise ValueError()
                if available is None:
                    eof.add(channel)
                elif available:
                    remaining = min(1024 - len(streams[channel]),
                                    2048 - sum(map(len, streams.values())))
                    if available > remaining:
                        result['errors'].append('OUTPUT_LIMIT')
                        raise ValueError()
                    data = port.read(channel, min(available, remaining))
                    if type(data) is not bytes or not 0 < len(data) <= min(available, remaining):
                        result['errors'].append('PIPE_INVALID')
                        raise ValueError()
                    streams[channel].extend(data)
                    deadline.check()
            if result['actual_exit'] is None:
                state = port.wait(deadline.wait_ms())
                deadline.check()
                if type(state) is not int or state not in (0, 258):
                    result['errors'].append('WAIT_FAILED' if state == 0xffffffff else 'WAIT_INVALID')
                    raise ValueError()
                if state == 0:
                    code = port.exit_code()
                    if type(code) is not int or not 0 <= code <= 0xffffffff:
                        result['errors'].append('EXIT_INVALID')
                        raise ValueError()
                    result['actual_exit'] = code
                    deadline.check()
            if len(eof) == 2 and result['actual_exit'] is not None:
                result['drain_complete'] = True
                allowed = {'stdout': b'WAG119_RECEIPT_V2|HOST|OK',
                           'stderr': b'WAG119_RECEIPT_V2|CHANNEL|STDERR'}
                if any(bytes(streams[name]) not in (marker + b'\n', marker + b'\r\n')
                       for name, marker in allowed.items()):
                    result['errors'].append('OUTPUT_REDACTED')
                elif result['actual_exit'] != 0:
                    result['errors'].append('HOST_NONZERO')
                else:
                    result.update(result='HOST_OBSERVED',
                                  **{name: bytes(value) for name, value in streams.items()})
                break
        else:
            result['errors'].append('CALL_LIMIT')
    except Exception as error:
        result['errors'].append('TIME_BUDGET' if isinstance(error, TimeoutError) else 'OTHER_REDACTED')
    finally:
        try:
            if port.close():
                result['errors'].append('CLOSE_UNCERTAIN')
        except Exception:
            result['errors'].append('CLOSE_UNCERTAIN')
        try:
            deadline.check()
        except Exception:
            result['errors'].append('TIME_BUDGET')
        if result['errors']:
            result.update(result='UNKNOWN_OR_INCOMPLETE', stdout=None, stderr=None)
    return result
