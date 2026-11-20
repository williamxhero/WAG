"""Host public seam exercised with event inputs, never a real Windows port."""
import unittest
import host_adapter as host

OUT = b'WAG119_RECEIPT_V2|HOST|OK\n'
ERR = b'WAG119_RECEIPT_V2|CHANNEL|STDERR\r\n'


class Deadline:
    def check(self):
        pass
    def wait_ms(self):
        return 1


class HostPort:
    def __init__(self):
        self.calls = []
        self.data = {'stdout': OUT, 'stderr': ERR}
        self.code = 0
        self.wait_state = 0
        self.created = False
    def launch(self):
        self.calls.append(('launch',))
        self.created = True
    def peek(self, channel):
        self.calls.append(('peek', channel))
        return len(self.data[channel]) if self.data[channel] else None
    def read(self, channel, count):
        self.calls.append(('read', channel, count))
        data = self.data[channel][:count]
        self.data[channel] = self.data[channel][count:]
        return data
    def wait(self, milliseconds):
        self.calls.append(('wait', milliseconds))
        return self.wait_state
    def exit_code(self):
        self.calls.append(('exit_code',))
        return self.code
    def close(self):
        self.calls.append(('close',))
        return []


class WindowsFacts:
    def __init__(self):
        self.next_handle = 10
        self.acquired = []
        self.closed = []
        self.launches = []
        self.waits = []
        self.streams = {12: OUT, 14: ERR}
    def acquire(self):
        value = self.next_handle
        self.next_handle += 1
        self.acquired.append(value)
        return value
    def CreatePipe(self, attributes, size):
        return self.acquire(), self.acquire()
    def GetCurrentProcess(self):
        return -1
    def DuplicateHandle(self, source_process, source, target_process, access, inherit, options):
        if (source_process, target_process, access, inherit, options) != (-1, -1, 0, 1, 2):
            raise AssertionError()
        return self.acquire()
    def CreateProcess(self, *args):
        self.launches.append(args)
        return self.acquire(), self.acquire(), 123, 456
    def CloseHandle(self, handle):
        if handle in self.closed:
            raise AssertionError()
        self.closed.append(handle)
    def PeekNamedPipe(self, handle, size):
        if self.streams[handle]:
            return len(self.streams[handle]), 0
        error = OSError()
        error.winerror = 109
        raise error
    def ReadFile(self, handle, count):
        data = self.streams[handle][:count]
        self.streams[handle] = self.streams[handle][count:]
        return data, 0
    def WaitForSingleObject(self, handle, milliseconds):
        self.waits.append(handle)
        return 0
    def GetExitCodeProcess(self, handle):
        if handle != self.waits[-1]:
            raise AssertionError()
        return 0


class Startup:
    pass


class HostTests(unittest.TestCase):
    def test_uncertain_close_redacts_port_labels_and_withholds_stream_publication(self):
        port = HostPort()
        port.close = lambda: ['private error from port']
        result = host.observe_fixed_host(port, Deadline())
        self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
        self.assertEqual(result['errors'], ['CLOSE_UNCERTAIN'])
        self.assertIsNone(result['stdout'])
        self.assertIsNone(result['stderr'])
        self.assertEqual(result['actual_exit'], 0)

    def test_native_wait_exception_is_wait_failure_not_timeout(self):
        api = WindowsFacts()
        def failed_wait(*args):
            error = OSError('not logged')
            error.winerror = 6
            raise error
        api.WaitForSingleObject = failed_wait
        result = host.observe_fixed_host(host.FixedHostPort(api, Startup, Deadline()), Deadline())
        self.assertIn('WAIT_FAILED', result['errors'])
        self.assertIsNone(result['actual_exit'])
        self.assertEqual(sorted(api.closed), sorted(api.acquired))

    def test_windows_acquisition_failure_and_late_handle_are_all_closed_once(self):
        for failure in range(1, 5):
            with self.subTest(acquisition=failure):
                api = WindowsFacts()
                calls = []
                original_pipe, original_create = api.CreatePipe, api.CreateProcess
                def pipe(*args):
                    calls.append('pipe')
                    if len(calls) == failure:
                        raise OSError()
                    return original_pipe(*args)
                def create(*args):
                    calls.append('create')
                    if len(calls) == failure:
                        raise OSError()
                    return original_create(*args)
                api.CreatePipe, api.CreateProcess = pipe, create
                result = host.observe_fixed_host(
                    host.FixedHostPort(api, Startup, Deadline()), Deadline())
                self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
                self.assertEqual(sorted(api.closed), sorted(api.acquired))
        api = WindowsFacts()
        class Late(Deadline):
            def check(self):
                if len(api.acquired) >= 11:
                    raise TimeoutError()
        result = host.observe_fixed_host(host.FixedHostPort(api, Startup, Late()), Late())
        self.assertIn('TIME_BUDGET', result['errors'])
        self.assertEqual(sorted(api.closed), sorted(api.acquired))
        self.assertEqual(len(api.launches), 1)
        api = WindowsFacts()
        original_close = api.CloseHandle
        def uncertain(handle):
            original_close(handle)
            raise OSError()
        api.CloseHandle = uncertain
        result = host.observe_fixed_host(host.FixedHostPort(api, Startup, Deadline()), Deadline())
        self.assertIn('CLOSE_UNCERTAIN', result['errors'])
        self.assertEqual(sorted(api.closed), sorted(api.acquired))

    def test_fixed_windows_port_uses_only_creation_handle_and_three_inherited_ends(self):
        api = WindowsFacts()
        port = host.FixedHostPort(api=api, startup_factory=Startup, deadline=Deadline())
        result = host.observe_fixed_host(port, Deadline())
        self.assertEqual(result['result'], 'HOST_OBSERVED')
        self.assertEqual(len(api.launches), 1)
        executable, command, pa, ta, inherit, flags, environment, cwd, startup = api.launches[0]
        self.assertEqual(executable, 'C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
        self.assertIn('-NoProfile -NonInteractive -Command ', command)
        self.assertNotIn('cmd.exe', command)
        self.assertEqual((pa, ta, inherit, flags), (None, None, 1, 0x08000000))
        self.assertEqual(set(environment), {'SystemRoot', 'WINDIR', 'PSModulePath', 'TEMP', 'TMP'})
        self.assertEqual(cwd, host.RUNTIME_ROOT)
        self.assertEqual(startup.lpAttributeList['handle_list'],
                         [startup.hStdInput, startup.hStdOutput, startup.hStdError])
        self.assertEqual(len(set(startup.lpAttributeList['handle_list'])), 3)
        self.assertEqual(sorted(api.closed), sorted(api.acquired))
        self.assertEqual(api.waits, [19])

    def test_fragments_timeout_eof_and_exit_are_distinct_observations(self):
        class FragmentPort(HostPort):
            def peek(self, channel):
                self.calls.append(('peek', channel))
                return min(1, len(self.data[channel])) if self.data[channel] else None
        port = FragmentPort()
        result = host.observe_fixed_host(port, Deadline())
        self.assertEqual((result['stdout'], result['stderr']), (OUT, ERR))
        self.assertEqual(port.calls.count(('exit_code',)), 1)
        class NoEof(HostPort):
            def peek(self, channel):
                return len(self.data[channel])
        port = NoEof()
        result = host.observe_fixed_host(port, Deadline())
        self.assertEqual(result['actual_exit'], 0)
        self.assertFalse(result['drain_complete'])
        self.assertIn('CALL_LIMIT', result['errors'])
        port = HostPort()
        port.wait_state = 258
        result = host.observe_fixed_host(port, Deadline())
        self.assertIsNone(result['actual_exit'])
        self.assertNotIn(('exit_code',), port.calls)
        self.assertFalse(result['drain_complete'])
        self.assertIn('CALL_LIMIT', result['errors'])

    def test_acquisition_and_close_errors_never_retry_or_leak_exception_text(self):
        for failing in ('launch', 'peek', 'read', 'wait', 'exit_code', 'close'):
            with self.subTest(failing=failing):
                port = HostPort()
                def fail(*args):
                    port.calls.append((failing,))
                    raise OSError('sensitive exception text')
                setattr(port, failing, fail)
                result = host.observe_fixed_host(port, Deadline())
                self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
                self.assertEqual(port.calls.count(('close',)), 1)
                self.assertNotIn('sensitive', repr(result))

    def test_invalid_pipe_facts_cannot_trigger_a_read_or_expose_data(self):
        for available in (-1, True, 1.5, 'secret'):
            with self.subTest(kind=type(available).__name__):
                class InvalidPort(HostPort):
                    def peek(self, channel):
                        self.calls.append(('peek', channel))
                        return available
                port = InvalidPort()
                result = host.observe_fixed_host(port, Deadline())
                self.assertIn('PIPE_INVALID', result['errors'])
                self.assertFalse(any(c[0] == 'read' for c in port.calls))
                self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
        class OversizedRead(HostPort):
            def read(self, channel, count):
                return b'x' * (count + 1)
        result = host.observe_fixed_host(OversizedRead(), Deadline())
        self.assertIn('PIPE_INVALID', result['errors'])
        self.assertIsNone(result['stdout'])

    def test_late_native_return_stops_next_operation_but_closes_once(self):
        for late in ('launch', 'peek', 'read', 'wait', 'exit_code', 'close'):
            with self.subTest(late=late):
                port = HostPort()
                class LateDeadline(Deadline):
                    def check(self):
                        if any(c[0] == late for c in port.calls):
                            raise TimeoutError()
                result = host.observe_fixed_host(port, LateDeadline())
                self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
                self.assertIn('TIME_BUDGET', result['errors'])
                index = next(i for i, c in enumerate(port.calls) if c[0] == late)
                self.assertTrue(all(c[0] == 'close' for c in port.calls[index + 1:]))
                self.assertEqual(port.calls.count(('close',)), 1)

    def test_only_exact_marker_bytes_are_exposed_and_exit_is_a_real_dword(self):
        for output, code, expected in ((b'sensitive-unexpected\n', 0, 'OUTPUT_REDACTED'),
                                       (OUT + b'\n', 0, 'OUTPUT_REDACTED'),
                                       (OUT, True, 'EXIT_INVALID'), (OUT, -1, 'EXIT_INVALID'),
                                       (OUT, None, 'EXIT_INVALID'), (OUT, 2**32, 'EXIT_INVALID'),
                                       (OUT, 0xc0000005, 'HOST_NONZERO')):
            with self.subTest(code=code, expected=expected):
                port = HostPort()
                port.data['stdout'], port.code = output, code
                result = host.observe_fixed_host(port, Deadline())
                self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
                self.assertIn(expected, result['errors'])
                self.assertIsNone(result['stdout'])
                self.assertIsNone(result['stderr'])
                self.assertEqual(result['actual_exit'], code if expected == 'HOST_NONZERO' else
                                 (0 if expected == 'OUTPUT_REDACTED' else None))

    def test_failed_or_unknown_wait_is_not_timeout_and_never_reads_exit(self):
        for state in (0xffffffff, 7, True, None):
            with self.subTest(state=state):
                port = HostPort()
                port.wait_state = state
                result = host.observe_fixed_host(port, Deadline())
                self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
                self.assertIn('WAIT_FAILED' if state == 0xffffffff else 'WAIT_INVALID', result['errors'])
                self.assertIsNone(result['actual_exit'])
                self.assertEqual(sum(c[0] == 'wait' for c in port.calls), 1)
                self.assertNotIn(('exit_code',), port.calls)

    def test_output_overflow_stops_before_read_and_never_returns_unexpected_bytes(self):
        port = HostPort()
        port.data['stdout'] = b'x' * 1025
        result = host.observe_fixed_host(port, Deadline())
        self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
        self.assertIn('OUTPUT_LIMIT', result['errors'])
        self.assertFalse(any(c[0] == 'read' for c in port.calls))
        self.assertIsNone(result['stdout'])
        self.assertIsNone(result['stderr'])
        self.assertEqual(port.calls.count(('close',)), 1)

    def test_separate_exact_bytes_actual_exit_and_drain_from_one_launch(self):
        port = HostPort()
        result = host.observe_fixed_host(port, Deadline())
        self.assertIsInstance(result, dict)
        self.assertEqual(result['result'], 'HOST_OBSERVED')
        self.assertEqual(result['stdout'], OUT)
        self.assertEqual(result['stderr'], ERR)
        self.assertEqual(result['actual_exit'], 0)
        self.assertTrue(result['drain_complete'])
        self.assertEqual(port.calls.count(('launch',)), 1)
        self.assertEqual(port.calls[-1], ('close',))
