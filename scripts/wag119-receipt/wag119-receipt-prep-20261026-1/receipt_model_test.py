"""Literal public-interface examples; no real metadata or host invocation."""
import unittest

import receipt_model as model


def snapshot():
    return {'st_dev': 2, 'st_ino': 101, 'st_size': 105816,
            'st_mtime_ns': 900, 'st_nlink': 2, 'st_mode': 33206,
            'st_file_attributes': 32}


class IdentityTests(unittest.TestCase):
    def test_mode_and_attribute_differences_are_warnings_not_identity_changes(self):
        before = snapshot()
        opened = dict(before, st_mode=33279, st_file_attributes=0)
        result = model.compare_tool_identity(before, opened)
        self.assertEqual(result, {
            'equal': True, 'changes': {},
            'warnings': {'st_mode': {'before': 33206, 'opened': 33279},
                         'st_file_attributes': {'before': 32, 'opened': 0}}})
        self.assertEqual(before, snapshot())

    def test_dev_ino_or_size_difference_remains_an_identity_change(self):
        for field in ('st_dev', 'st_ino', 'st_size'):
            with self.subTest(field=field):
                opened = snapshot()
                opened[field] += 1
                self.assertEqual(model.compare_tool_identity(snapshot(), opened), {
                    'equal': False,
                    'changes': {field: {'before': snapshot()[field], 'opened': opened[field]}},
                    'warnings': {}})


def receipt():
    return {
        'stdout': b'WAG119_RECEIPT_V2|HOST|OK\n',
        'stderr': b'WAG119_RECEIPT_V2|CHANNEL|STDERR\n',
        'actual_exit': 0, 'start_ns': 100, 'end_ns': 1000000100,
        'drain_complete': True, 'timed_out': False, 'overflow': False,
        'file_validation_complete': True, 'publication_complete': True,
        'identity_checks': [
            {'tool': tool, 'phase': phase, 'before': snapshot(), 'opened': snapshot()}
            for tool in ('PYTHON', 'POWERSHELL')
            for phase in ('PATH_TO_OPEN', 'WITHIN_OPEN', 'PATH_AFTER_CLOSE')],
    }


class ReceiptTests(unittest.TestCase):
    def test_prehost_difference_rejects_any_host_or_contradictory_stream_evidence(self):
        for field, value in (('stdout', b'WAG119_RECEIPT_V2|HOST|OK\n'),
                             ('stderr', b'x' * 1025), ('stderr', 'untrusted'),
                             ('actual_exit', 0), ('drain_complete', True)):
            raw = receipt()
            raw.update(stdout=None, stderr=None, actual_exit=None, drain_complete=False)
            raw['identity_checks'] = raw['identity_checks'][:1]
            raw['identity_checks'][0]['opened']['st_file_attributes'] = 0
            raw[field] = value
            with self.subTest(field=field, value_type=type(value).__name__):
                self.assertEqual(model.assess_host_receipt(raw)['result'], 'UNKNOWN_OR_INCOMPLETE')

    def test_changed_retained_object_cannot_be_hidden_by_another_local_difference(self):
        raw = receipt()
        raw.update(stdout=None, stderr=None, actual_exit=None, drain_complete=False)
        raw['identity_checks'] = raw['identity_checks'][:2]
        check = raw['identity_checks'][1]
        check['before']['st_ino'] = 202
        check['opened']['st_ino'] = 202
        check['opened']['st_size'] = 1
        self.assertEqual(model.assess_host_receipt(raw)['result'], 'UNKNOWN_OR_INCOMPLETE')

    def test_shared_dict_reference_cannot_hide_followup_after_first_difference(self):
        raw = receipt()
        raw.update(stdout=None, stderr=None, actual_exit=None, drain_complete=False)
        check = raw['identity_checks'][0]
        check['opened']['st_mode'] = 1
        raw['identity_checks'] = [check, check]
        self.assertEqual(model.assess_host_receipt(raw)['result'], 'UNKNOWN_OR_INCOMPLETE')

    def test_first_identity_difference_is_retained_before_host_can_start(self):
        raw = receipt()
        raw.update(stdout=None, stderr=None, actual_exit=None, drain_complete=False)
        raw['identity_checks'] = raw['identity_checks'][:1]
        raw['identity_checks'][0]['opened']['st_size'] = 1
        result = model.assess_host_receipt(raw)
        self.assertEqual(result['result'], 'BLOCKED_IDENTITY_DIFFERENCE')
        self.assertEqual(result['tool'], 'PYTHON')
        self.assertEqual(result['phase'], 'PATH_TO_OPEN')
        self.assertEqual(result['changes'], {
            'st_size': {'before': 105816, 'opened': 1}})
        self.assertFalse(result['execution_authority'])

    def test_complete_separate_evidence_is_only_new_observation_not_authority(self):
        self.assertTrue(callable(getattr(model, 'assess_host_receipt', None)))
        result = model.assess_host_receipt(receipt())
        self.assertEqual(result, {'result': 'NEW_HOST_RECEIPT_OBSERVED',
                                  'execution_authority': False})


class BoundaryTests(unittest.TestCase):
    def assert_unknown(self, raw):
        self.assertEqual(model.assess_host_receipt(raw),
                         {'result': 'UNKNOWN_OR_INCOMPLETE', 'execution_authority': False})

    def test_identity_equality_and_each_field_is_classified(self):
        self.assertEqual(model.compare_tool_identity(snapshot(), snapshot()),
                         {'equal': True, 'changes': {}, 'warnings': {}})
        for field in snapshot():
            with self.subTest(field=field):
                changed = snapshot()
                changed[field] += 1
                result = model.compare_tool_identity(snapshot(), changed)
                if field in model.IDENTITY_FIELDS:
                    self.assertFalse(result['equal'])
                    self.assertEqual(set(result['changes']), {field})
                    self.assertEqual(result['warnings'], {})
                else:
                    self.assertTrue(result['equal'])
                    self.assertEqual(result['changes'], {})
                    self.assertEqual(set(result['warnings']), {field})
        negative_time = dict(snapshot(), st_mtime_ns=-1)
        self.assertTrue(model.compare_tool_identity(negative_time, negative_time)['equal'])

    def test_missing_boolean_extra_and_unbounded_metadata_are_invalid(self):
        for field in snapshot():
            for value in (None, True, False, '0', 0.0, 2 ** 128):
                with self.subTest(field=field, value=value):
                    self.assertIsNone(model.compare_tool_identity(snapshot(), dict(snapshot(), **{field: value})))
            missing = snapshot()
            del missing[field]
            self.assertIsNone(model.compare_tool_identity(missing, snapshot()))
        self.assertIsNone(model.compare_tool_identity(dict(snapshot(), secret='not echoed'), snapshot()))
        self.assertIsNone(model.compare_tool_identity(None, snapshot()))
        self.assertIsNone(model.compare_tool_identity(snapshot(), dict(snapshot(), st_size=-1)))

    def test_both_real_channels_required_no_combined_or_reconstructed_bytes(self):
        for field in ('stdout', 'stderr'):
            for value in (None, '', bytearray(), b'', b'EXTRA\n', b'\xff', b'x' * 1025):
                raw = receipt()
                raw[field] = value
                self.assert_unknown(raw)
        raw = receipt()
        raw['stdout'] += raw['stderr']
        raw['stderr'] = b''
        self.assert_unknown(raw)
        for field in ('stdout', 'stderr'):
            for suffix in (b'\n', b'EXTRA', b'\x00'):
                raw = receipt()
                raw[field] += suffix
                self.assert_unknown(raw)
            raw = receipt()
            raw[field] = raw[field][:-1]
            self.assert_unknown(raw)
        raw = receipt()
        raw['stdout'] = b'\xef\xbb\xbf' + raw['stdout']
        self.assert_unknown(raw)

    def test_actual_exit_integer_zero_is_not_inferred_from_markers(self):
        for value in (None, True, False, '0', 0.0, 125, 1, 4294967295):
            raw = receipt()
            raw['actual_exit'] = value
            self.assert_unknown(raw)

    def test_full_budget_and_latched_error_flags_cannot_be_overridden(self):
        for field in ('start_ns', 'end_ns'):
            for value in (None, True, False, -1, 2 ** 63, 1.0):
                raw = receipt()
                raw[field] = value
                self.assert_unknown(raw)
        for end in (99, 30000000100, 60000000100):
            raw = receipt()
            raw['end_ns'] = end
            self.assert_unknown(raw)
        for field in ('drain_complete', 'file_validation_complete', 'publication_complete'):
            for value in (False, None, 1):
                raw = receipt()
                raw[field] = value
                self.assert_unknown(raw)
        for field in ('timed_out', 'overflow'):
            for value in (True, None, 0):
                raw = receipt()
                raw[field] = value
                self.assert_unknown(raw)

    def test_all_six_comparisons_required_in_exact_order_and_continuous_identity(self):
        for count in range(6):
            raw = receipt()
            raw['identity_checks'] = raw['identity_checks'][:count]
            self.assert_unknown(raw)
        raw = receipt()
        raw['identity_checks'].reverse()
        self.assert_unknown(raw)
        raw = receipt()
        raw['identity_checks'][1]['tool'] = 'UNREVIEWED_PATH'
        self.assert_unknown(raw)
        raw = receipt()
        raw['identity_checks'][1]['before']['st_ino'] = 202
        raw['identity_checks'][1]['opened']['st_ino'] = 202
        self.assert_unknown(raw)
        raw = receipt()
        del raw['end_ns']
        self.assert_unknown(raw)
        raw = receipt()
        raw['environment'] = 'must not echo'
        self.assert_unknown(raw)
        self.assert_unknown(None)

    def test_difference_in_any_pair_is_blocked_and_followup_work_is_rejected(self):
        for index in range(6):
            raw = receipt()
            # All metadata comparisons precede the proposed host launch.
            raw.update(stdout=None, stderr=None, actual_exit=None, drain_complete=False)
            raw['identity_checks'] = raw['identity_checks'][:index + 1]
            raw['identity_checks'][-1]['opened']['st_size'] = 1
            result = model.assess_host_receipt(raw)
            self.assertEqual(result['result'], 'BLOCKED_IDENTITY_DIFFERENCE')
            self.assertEqual(result['changes'], {'st_size': {'before': 105816, 'opened': 1}})
        raw = receipt()
        raw['identity_checks'][0]['opened']['st_mode'] = 1
        self.assertEqual(model.assess_host_receipt(raw)['result'], 'NEW_HOST_RECEIPT_OBSERVED')

    def test_lf_crlf_per_channel_are_exactly_supported(self):
        for stdout_end, stderr_end in ((b'\n', b'\n'), (b'\r\n', b'\n'),
                                       (b'\n', b'\r\n'), (b'\r\n', b'\r\n')):
            raw = receipt()
            raw['stdout'] = b'WAG119_RECEIPT_V2|HOST|OK' + stdout_end
            raw['stderr'] = b'WAG119_RECEIPT_V2|CHANNEL|STDERR' + stderr_end
            self.assertEqual(model.assess_host_receipt(raw)['result'], 'NEW_HOST_RECEIPT_OBSERVED')


class PayloadTests(unittest.TestCase):
    def test_new_payload_is_fixed_text_with_two_separate_channel_markers(self):
        self.assertTrue(callable(getattr(model, 'host_payload', None)))
        expected = ('[Console]::Out.WriteLine("WAG119_RECEIPT_V2|HOST|OK"); '
                    '[Console]::Out.Flush(); '
                    '[Console]::Error.WriteLine("WAG119_RECEIPT_V2|CHANNEL|STDERR"); '
                    '[Console]::Error.Flush(); exit 0')
        self.assertEqual(model.host_payload(), expected)
        with self.assertRaises(TypeError):
            model.host_payload('arbitrary script')


if __name__ == '__main__':
    unittest.main()
