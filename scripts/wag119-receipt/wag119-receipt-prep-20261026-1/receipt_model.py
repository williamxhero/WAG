"""Pure receipt seams. No filesystem, process adapter, execution or admission."""


def host_payload():
    """Return new literal text only; no execution adapter or launch permission."""
    return ('[Console]::Out.WriteLine("WAG119_RECEIPT_V2|HOST|OK"); '
            '[Console]::Out.Flush(); '
            '[Console]::Error.WriteLine("WAG119_RECEIPT_V2|CHANNEL|STDERR"); '
            '[Console]::Error.Flush(); exit 0')


FIELDS = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_nlink',
          'st_mode', 'st_file_attributes')
IDENTITY_FIELDS = ('st_dev', 'st_ino', 'st_size')
WARNING_FIELDS = ('st_mtime_ns', 'st_nlink', 'st_mode', 'st_file_attributes')


def _snapshot_valid(value):
    return (type(value) is dict and set(value) == set(FIELDS)
            and all(type(value[name]) is int
                    and (-(2 ** 63) if name == 'st_mtime_ns' else 0)
                    <= value[name] < 2 ** 128 for name in FIELDS))


def compare_tool_identity(before, opened):
    """Compare stable identity and retain non-blocking metadata warnings."""
    if not _snapshot_valid(before) or not _snapshot_valid(opened):
        return None
    changes = {name: {'before': before[name], 'opened': opened[name]}
               for name in IDENTITY_FIELDS if before[name] != opened[name]}
    warnings = {name: {'before': before[name], 'opened': opened[name]}
                for name in WARNING_FIELDS if before[name] != opened[name]}
    return {'equal': not changes, 'changes': changes, 'warnings': warnings}


RECEIPT_FIELDS = {'stdout', 'stderr', 'actual_exit', 'start_ns', 'end_ns',
                  'drain_complete', 'timed_out', 'overflow', 'identity_checks',
                  'file_validation_complete', 'publication_complete'}
CHECK_ORDER = tuple((tool, phase) for tool in ('PYTHON', 'POWERSHELL')
                    for phase in ('PATH_TO_OPEN', 'WITHIN_OPEN', 'PATH_AFTER_CLOSE'))


def _unknown():
    return {'result': 'UNKNOWN_OR_INCOMPLETE', 'execution_authority': False}


def assess_host_receipt(receipt):
    """Validate supplied evidence only; this cannot certify its OS provenance."""
    if type(receipt) is not dict or set(receipt) != RECEIPT_FIELDS:
        return _unknown()
    for name in ('start_ns', 'end_ns'):
        if type(receipt[name]) is not int or not 0 <= receipt[name] < 2 ** 63:
            return _unknown()
    elapsed = receipt['end_ns'] - receipt['start_ns']
    if not 0 <= elapsed < 30000000000:
        return _unknown()
    for name in ('drain_complete', 'timed_out', 'overflow',
                 'file_validation_complete', 'publication_complete'):
        if type(receipt[name]) is not bool:
            return _unknown()
    if receipt['timed_out'] or receipt['overflow'] or not receipt['publication_complete']:
        return _unknown()
    checks = receipt['identity_checks']
    if type(checks) is not list or not 1 <= len(checks) <= len(CHECK_ORDER):
        return _unknown()
    baselines = {}
    for position, (check, expected) in enumerate(zip(checks, CHECK_ORDER)):
        if (type(check) is not dict or set(check) != {'tool', 'phase', 'before', 'opened'}
                or (check['tool'], check['phase']) != expected):
            return _unknown()
        comparison = compare_tool_identity(check['before'], check['opened'])
        if comparison is None:
            return _unknown()
        if expected[0] in baselines and not compare_tool_identity(
                baselines[expected[0]], check['before'])['equal']:
            return _unknown()
        if not comparison['equal']:
            # These comparisons precede launch; supplied host data contradicts stop.
            if (position != len(checks) - 1 or receipt['stdout'] is not None
                    or receipt['stderr'] is not None or receipt['actual_exit'] is not None
                    or receipt['drain_complete']):
                return _unknown()
            return {'result': 'BLOCKED_IDENTITY_DIFFERENCE', 'tool': expected[0],
                    'phase': expected[1], 'changes': comparison['changes'],
                    'execution_authority': False}
        baselines[expected[0]] = check['before']
    if (len(checks) != len(CHECK_ORDER) or not receipt['drain_complete']
            or not receipt['file_validation_complete']):
        return _unknown()
    stdout, stderr = receipt['stdout'], receipt['stderr']
    if type(stdout) is not bytes or type(stderr) is not bytes:
        return _unknown()
    if len(stdout) > 1024 or len(stderr) > 1024 or len(stdout) + len(stderr) > 2048:
        return _unknown()
    if (stdout not in (b'WAG119_RECEIPT_V2|HOST|OK\n', b'WAG119_RECEIPT_V2|HOST|OK\r\n')
            or stderr not in (b'WAG119_RECEIPT_V2|CHANNEL|STDERR\n',
                              b'WAG119_RECEIPT_V2|CHANNEL|STDERR\r\n')
            or type(receipt['actual_exit']) is not int or receipt['actual_exit'] != 0):
        return _unknown()
    return {'result': 'NEW_HOST_RECEIPT_OBSERVED', 'execution_authority': False}
