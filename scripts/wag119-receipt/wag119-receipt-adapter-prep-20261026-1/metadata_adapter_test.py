"""Public metadata seam, literal facts only."""
import unittest
import metadata_adapter as metadata


def leaf(size=105816):
    return dict(st_dev=2, st_ino=101, st_size=size, st_mtime_ns=900,
                st_nlink=2, st_mode=33206, st_file_attributes=32)


class Deadline:
    def check(self):
        pass


class MetadataPort:
    def __init__(self):
        self.calls = []
        self.changed = True
        self.identity_changed = False
    def lstat(self, label):
        self.calls.append(('lstat', label))
        if label.startswith('A'):
            return dict(leaf(), st_mode=16877, st_nlink=1)
        return leaf(105816 if label == 'PYTHON' else 495616)
    def open(self, label):
        self.calls.append(('open', label))
        return label
    def fstat(self, handle):
        self.calls.append(('fstat', handle))
        raw = leaf(105816 if handle == 'PYTHON' else 495616)
        if self.identity_changed and handle == 'PYTHON':
            raw['st_ino'] += 1
        return dict(raw, st_mode=33279, st_file_attributes=0) if self.changed else raw
    def close(self, handle):
        self.calls.append(('close', handle))


class MetadataTests(unittest.TestCase):
    def test_fixed_metadata_adapter_retains_each_original_fd_without_real_stats(self):
        from types import SimpleNamespace
        class Facts:
            O_RDONLY, O_BINARY, O_NOINHERIT = 0, 8, 16
            def __init__(self):
                self.handles = {}
                self.stats = []
                self.closed = []
                self.opens = []
            def info(self, path):
                size = next((size for target, size in metadata.TOOLS.values() if target == path), None)
                return SimpleNamespace(**(leaf(size) if size is not None else dict(leaf(), st_mode=16877, st_nlink=1)))
            def lstat(self, path):
                self.stats.append(('path', path))
                return self.info(path)
            def open(self, path, flags):
                fd = len(self.opens) + 10
                self.opens.append((path, flags))
                self.handles[fd] = path
                return fd
            def fstat(self, fd):
                self.stats.append(('fd', fd))
                return self.info(self.handles[fd])
            def close(self, fd):
                del self.handles[fd]
                self.closed.append(fd)
        api = Facts()
        result = metadata.observe_tool_identities(metadata.FixedMetadataPort(api), Deadline())
        self.assertEqual(result['result'], 'IDENTITIES_OBSERVED')
        self.assertEqual([fd for kind, fd in api.stats if kind == 'fd'], [10, 10, 11, 11])
        self.assertEqual(api.closed, [10, 11])
        self.assertEqual([flags for _, flags in api.opens], [24, 24])
        self.assertEqual(len(api.stats), 32)
        self.assertEqual(api.handles, {})

    def test_identity_differences_stop_but_metadata_warnings_do_not(self):
        for field in ('st_dev', 'st_ino', 'st_size'):
            with self.subTest(field=field):
                class DifferencePort(MetadataPort):
                    def fstat(self, handle):
                        value = super().fstat(handle)
                        if handle == 'PYTHON' and self.calls.count(('fstat', handle)) == 1:
                            value[field] += 1
                        return value
                port = DifferencePort()
                port.changed = False
                result = metadata.observe_tool_identities(port, Deadline())
                self.assertEqual(result['result'], 'BLOCKED_IDENTITY_DIFFERENCE')
                self.assertEqual(result['difference']['phase'], 'PATH_TO_OPEN')
                self.assertEqual(set(result['difference']['changes']), {field})
                self.assertEqual(len(result['checks'][-1]['opened']), 7)
                self.assertNotIn(('open', 'POWERSHELL'), port.calls)

        # st_nlink is a file-validity gate (tools must have one link), not an identity warning.
        for field in ('st_mtime_ns', 'st_mode', 'st_file_attributes'):
            with self.subTest(field=field):
                class WarningPort(MetadataPort):
                    def fstat(self, handle):
                        value = super().fstat(handle)
                        if handle == 'PYTHON' and self.calls.count(('fstat', handle)) == 1:
                            value[field] += 1
                        return value
                port = WarningPort()
                port.changed = False
                result = metadata.observe_tool_identities(port, Deadline())
                self.assertEqual(result['result'], 'IDENTITIES_OBSERVED')
                self.assertTrue(result['file_validation_complete'])

    def test_invalid_facts_ancestor_changes_and_acquisition_errors_fail_closed(self):
        for invalid in ({}, dict(leaf(), st_size=True), dict(leaf(), extra=1),
                        dict(leaf(), st_mode=0), dict(leaf(), st_file_attributes=1024)):
            class InvalidPort(MetadataPort):
                def lstat(self, label):
                    self.calls.append(('lstat', label))
                    return invalid
            port = InvalidPort()
            result = metadata.observe_tool_identities(port, Deadline())
            self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
            self.assertFalse(any(c[0] == 'open' for c in port.calls))
        class AncestorChanged(MetadataPort):
            def lstat(self, label):
                value = super().lstat(label)
                if label == 'A00' and self.calls.count(('lstat', label)) == 2:
                    value['st_ino'] += 1
                return value
        port = AncestorChanged()
        port.changed = False
        result = metadata.observe_tool_identities(port, Deadline())
        self.assertEqual(result['result'], 'BLOCKED_IDENTITY_DIFFERENCE')
        self.assertEqual(result['difference']['tool'], 'A00')
        self.assertEqual(len(result['snapshots']), 21)
        for failure in ('open', 'fstat'):
            port = MetadataPort()
            port.changed = False
            def fail(label):
                port.calls.append((failure, label))
                raise OSError('sensitive')
            setattr(port, failure, fail)
            result = metadata.observe_tool_identities(port, Deadline())
            self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
            self.assertEqual(port.calls.count(('close', 'PYTHON')), int(failure == 'fstat'))
            self.assertNotIn('sensitive', repr(result))

    def test_close_failure_is_explicit_and_never_retried_or_followed_by_stat(self):
        class UncertainPort(MetadataPort):
            def close(self, handle):
                super().close(handle)
                raise OSError('not recorded')
        port = UncertainPort()
        port.changed = False
        result = metadata.observe_tool_identities(port, Deadline())
        self.assertEqual(result['result'], 'UNKNOWN_OR_INCOMPLETE')
        self.assertIn('CLOSE_UNCERTAIN', result['errors'])
        self.assertEqual(port.calls.count(('close', 'PYTHON')), 1)
        self.assertEqual(port.calls[-1], ('close', 'PYTHON'))

    def test_complete_observation_has_exactly_six_pairs_32_snapshots_two_opens(self):
        port = MetadataPort()
        port.changed = False
        result = metadata.observe_tool_identities(port, Deadline())
        self.assertEqual(result['result'], 'IDENTITIES_OBSERVED')
        self.assertEqual(len(result['snapshots']), 32)
        self.assertEqual([(c['tool'], c['phase']) for c in result['checks']], [
            ('PYTHON', 'PATH_TO_OPEN'), ('PYTHON', 'WITHIN_OPEN'), ('PYTHON', 'PATH_AFTER_CLOSE'),
            ('POWERSHELL', 'PATH_TO_OPEN'), ('POWERSHELL', 'WITHIN_OPEN'), ('POWERSHELL', 'PATH_AFTER_CLOSE')])
        self.assertEqual([c for c in port.calls if c[0] == 'open'],
                         [('open', 'PYTHON'), ('open', 'POWERSHELL')])
        self.assertEqual([c for c in port.calls if c[0] == 'close'],
                         [('close', 'PYTHON'), ('close', 'POWERSHELL')])
        self.assertTrue(result['file_validation_complete'])

    def test_mode_and_attributes_difference_does_not_stop_or_launch_extra_work(self):
        port = MetadataPort()
        result = metadata.observe_tool_identities(port, Deadline())
        self.assertIsInstance(result, dict)
        self.assertEqual(result['result'], 'IDENTITIES_OBSERVED')
        self.assertEqual(result['checks'][0]['before']['st_mode'], 33206)
        self.assertEqual(result['checks'][0]['opened']['st_mode'], 33279)
        self.assertEqual(port.calls.count(('open', 'PYTHON')), 1)
        self.assertEqual(port.calls.count(('open', 'POWERSHELL')), 1)
