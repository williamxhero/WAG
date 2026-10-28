"""Public run_once seam: in-memory file facts, no filesystem or host effects."""
import json
import unittest
from types import SimpleNamespace
from pathlib import Path
from publication import FixedFilePort
import receipt_driver as driver
from metadata_adapter_test import MetadataPort
from host_adapter_test import HostPort, OUT, ERR


class Files:
    def __init__(self):
        self.calls = []
        self.data = {}
    def prepare_root(self):
        self.calls.append(('prepare_root',))
    def create(self, name):
        self.calls.append(('create', name))
        if name in self.data:
            raise FileExistsError()
        self.data[name] = b''
        return name
    def write(self, handle, data):
        self.calls.append(('write', handle))
        self.data[handle] += data
        return len(data)
    def flush(self, handle):
        self.calls.append(('flush', handle))
    def sync(self, handle):
        self.calls.append(('sync', handle))
    def close(self, handle):
        self.calls.append(('close', handle))
    def readback(self, name, limit):
        self.calls.append(('readback', name))
        return self.data[name][:limit]


class Ports:
    def __init__(self):
        self.used = False
        self.files = Files()
        self.metadata = MetadataPort()
        self.metadata.changed = False
        self.host = HostPort()
        self.host_admitted = True  # Test input, NOT runtime permission or byte attestation.
        self.clock = lambda: 100


class FileFacts:
    O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_BINARY, O_NOINHERIT = 0, 1, 2, 4, 8, 16
    def __init__(self):
        self.data = {}
        self.handles = {}
        self.closed = []
        self.opens = []
        self.directories = []
        self.next_fd = 10
    def mkdir(self, path):
        self.directories.append(str(path))
    def info(self, path):
        name = str(path)
        regular = name in self.data
        return SimpleNamespace(st_dev=1, st_ino=100 + (list(self.data).index(name) if regular else 0),
                               st_size=len(self.data[name]) if regular else 0, st_mtime_ns=100,
                               st_nlink=1, st_mode=33206 if regular else 16877, st_file_attributes=32)
    def lstat(self, path):
        return self.info(path)
    def fstat(self, fd):
        return self.info(self.handles[fd])
    def open(self, path, flags, mode=0o777):
        name = str(path)
        self.opens.append((name, flags))
        if flags & self.O_EXCL:
            if name in self.data:
                raise FileExistsError()
            self.data[name] = b''
        elif name not in self.data:
            raise FileNotFoundError()
        fd = self.next_fd
        self.next_fd += 1
        self.handles[fd] = name
        return fd
    def write(self, fd, data):
        self.data[self.handles[fd]] += data
        return len(data)
    def fsync(self, fd):
        pass
    def read(self, fd, count):
        return self.data[self.handles[fd]][:count]
    def close(self, fd):
        if fd not in self.handles:
            raise AssertionError()
        del self.handles[fd]
        self.closed.append(fd)


class DriverTests(unittest.TestCase):
    def test_fixed_file_adapter_closes_acquired_descriptors_once_on_each_fault(self):
        for stage in ('lstat', 'fstat', 'open', 'write', 'fsync', 'read', 'close'):
            with self.subTest(stage=stage):
                ports = Ports()
                api = FileFacts()
                original = getattr(api, stage)
                calls = []
                def fail(*args):
                    calls.append(stage)
                    if stage == 'close':
                        original(*args)
                    raise OSError('private')
                setattr(api, stage, fail)
                ports.files = FixedFilePort(api)
                result = driver.run_once(ports)
                self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
                self.assertFalse(result['publication_complete'])
                self.assertEqual(api.handles, {})
                self.assertEqual(len(api.closed), len(set(api.closed)))
                self.assertTrue(calls)
                self.assertEqual(ports.host.calls, [])

    def test_source_loading_time_cannot_be_erased_by_starting_a_new_deadline(self):
        ports = Ports()
        ports.start_ns = 100
        ports.clock = lambda: 30000000100
        result = driver.run_once(ports)
        self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
        self.assertIn('TIME_BUDGET', result['errors'])
        self.assertEqual(ports.files.calls, [])
        self.assertEqual(ports.metadata.calls, [])
        self.assertEqual(ports.host.calls, [])
        self.assertTrue(ports.used)

    def test_native_port_uses_the_same_deadline_as_metadata_and_publication(self):
        from host_adapter import FixedHostPort
        from host_adapter_test import WindowsFacts, Startup
        api = WindowsFacts()
        ports = Ports()
        ports.host = FixedHostPort(api=api, startup_factory=Startup)
        result = driver.run_once(ports)
        self.assertEqual(result['result'], 'NEW_HOST_RECEIPT_OBSERVED')
        self.assertIs(ports.host.deadline, ports.files.deadline)
        self.assertEqual(len(api.launches), 1)

    def test_fixed_file_adapter_exclusive_unbuffered_write_and_bounded_readback(self):
        ports = Ports()
        api = FileFacts()
        ports.files = FixedFilePort(api)
        result = driver.run_once(ports)
        self.assertEqual(result['result'], 'NEW_HOST_RECEIPT_OBSERVED')
        self.assertEqual(len(api.directories), 1)
        self.assertEqual(len(api.opens), 8)
        self.assertEqual(len(api.closed), 8)
        self.assertEqual(api.handles, {})
        self.assertEqual({Path(p).name for p in api.data},
                         {'attempt.json', 'observation.json', 'stdout.bin', 'stderr.bin'})

    def test_identity_stop_and_byte_trust_gate_never_launch_host(self):
        ports = Ports()
        ports.metadata.identity_changed = True
        result = driver.run_once(ports)
        self.assertEqual(result['host_launch'], 'NOT_RUN')
        self.assertEqual(ports.host.calls, [])
        self.assertEqual(result['result'], 'BLOCKED_IDENTITY_DIFFERENCE')
        self.assertTrue(result['publication_complete'])
        self.assertNotIn('stdout.bin', ports.files.data)
        self.assertEqual(json.loads(ports.files.data['attempt.json'])['maximum_host_launches'], 1)

        ports = Ports()
        ports.host_admitted = False
        result = driver.run_once(ports)
        self.assertEqual(result['host_launch'], 'NOT_RUN')
        self.assertEqual(ports.host.calls, [])
        self.assertEqual(result['result'], 'BLOCKED_TOOL_BYTE_TRUST')
        self.assertTrue(result['publication_complete'])
        self.assertNotIn('stdout.bin', ports.files.data)
        self.assertEqual(json.loads(ports.files.data['attempt.json'])['maximum_host_launches'], 0)

    def test_each_publication_failure_latches_without_rewrite_or_second_session(self):
        for stage in ('prepare_root', 'create', 'write', 'flush', 'sync', 'close', 'readback'):
            for filename in ('attempt.json', 'observation.json', 'stdout.bin', 'stderr.bin'):
                with self.subTest(stage=stage, filename=filename):
                    ports = Ports()
                    original = getattr(ports.files, stage)
                    def fail(*args):
                        if stage == 'prepare_root' or args[0] == filename:
                            ports.files.calls.append((stage, filename))
                            raise OSError('private error')
                        return original(*args)
                    setattr(ports.files, stage, fail)
                    result = driver.run_once(ports)
                    self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
                    self.assertFalse(result['publication_complete'])
                    self.assertNotIn('private error', repr(result))
                    self.assertEqual(driver.run_once(ports)['result'], 'SESSION_ALREADY_CONSUMED')
                    closes = [c[1] for c in ports.files.calls if c[0] == 'close']
                    self.assertEqual(len(closes), len(set(closes)))
                    creates = [c[1] for c in ports.files.calls if c[0] == 'create']
                    self.assertEqual(len(creates), len(set(creates)))
                    if filename == 'attempt.json' or stage == 'prepare_root':
                        self.assertEqual(ports.host.calls, [])

    def test_collision_partial_write_bad_readback_and_late_publication_cannot_pass(self):
        for mode in ('collision', 'short', 'readback', 'late'):
            ports = Ports()
            if mode == 'collision':
                ports.files.data['attempt.json'] = b'old evidence'
            elif mode == 'short':
                ports.files.write = lambda handle, data: 0
            elif mode == 'readback':
                ports.files.readback = lambda name, limit: b'corrupt'
            else:
                ports.clock = lambda: 30000000100 if ('readback', 'stderr.bin') in ports.files.calls else 100
            result = driver.run_once(ports)
            self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
            self.assertFalse(result['publication_complete'])
            if mode == 'collision':
                self.assertEqual(ports.files.data['attempt.json'], b'old evidence')
            self.assertEqual(driver.run_once(ports)['result'], 'SESSION_ALREADY_CONSUMED')

    def test_mode_and_attribute_difference_does_not_block_host_receipt(self):
        ports = Ports()
        ports.metadata.changed = True
        result = driver.run_once(ports)
        self.assertEqual(result['result'], 'NEW_HOST_RECEIPT_OBSERVED')
        self.assertEqual(result['host_launch'], 'CREATED')
        self.assertEqual(ports.host.calls.count(('launch',)), 1)

    def test_one_session_publishes_real_supplied_bytes_before_in_memory_acceptance(self):
        ports = Ports()
        result = driver.run_once(ports)
        self.assertEqual(result['assessment']['result'], 'NEW_HOST_RECEIPT_OBSERVED')
        self.assertFalse(result['assessment']['execution_authority'])
        self.assertTrue(result['publication_complete'])
        self.assertEqual(ports.files.data['stdout.bin'], OUT)
        self.assertEqual(ports.files.data['stderr.bin'], ERR)
        raw = json.loads(ports.files.data['observation.json'])
        self.assertNotIn('publication_complete', raw)
        self.assertNotIn('end_ns', raw)
        self.assertEqual(raw['host']['actual_exit'], 0)
        self.assertEqual(ports.files.calls[-1], ('readback', 'stderr.bin'))
        before = list(ports.files.calls)
        self.assertEqual(driver.run_once(ports)['result'], 'SESSION_ALREADY_CONSUMED')
        self.assertEqual(ports.files.calls, before)
        self.assertEqual(ports.host.calls.count(('launch',)), 1)
