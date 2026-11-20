"""Fixed metadata observation. No real port is constructed at import time."""
import receipt_model as model

ANCESTORS = ('C:/', 'C:/Users', 'C:/Users/will', 'C:/Users/will/AppData',
             'C:/Users/will/AppData/Local', 'C:/Users/will/AppData/Local/Programs',
             'C:/Users/will/AppData/Local/Programs/Python',
             'C:/Users/will/AppData/Local/Programs/Python/Python313',
             'C:/Windows', 'C:/Windows/System32',
             'C:/Windows/System32/WindowsPowerShell',
             'C:/Windows/System32/WindowsPowerShell/v1.0')
TOOLS = {'PYTHON': ('C:/Users/will/AppData/Local/Programs/Python/Python313/python.exe', 105816),
         'POWERSHELL': ('C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe', 495616)}


class InvalidObservation(Exception):
    pass


class StopDifference(Exception):
    pass


def observe_tool_identities(port, deadline):
    result = dict(result='UNKNOWN_OR_INCOMPLETE', checks=[], snapshots=[],
                  difference=None, errors=[], file_validation_complete=False)
    acquired = None
    def snapshot(label, kind, handle=None):
        deadline.check()
        value = port.fstat(handle) if handle is not None else port.lstat(label)
        if model.compare_tool_identity(value, value) is None:
            raise InvalidObservation()
        value = dict(value)
        result['snapshots'].append(dict(label=label, kind=kind, value=value))
        deadline.check()
        return value
    def valid(value, directory=False, size=None):
        expected = 0o040000 if directory else 0o100000
        if value['st_mode'] & 0o170000 != expected or value['st_file_attributes'] & 1024:
            raise InvalidObservation()
        if size is not None and (value['st_size'] != size or value['st_nlink'] != 2):
            raise InvalidObservation()
    def compare(label, phase, before, opened, leaf=True):
        comparison = model.compare_tool_identity(before, opened)
        if leaf:
            result['checks'].append(dict(tool=label, phase=phase, before=before, opened=opened))
        if not comparison['equal']:
            result['difference'] = dict(tool=label, phase=phase, changes=comparison['changes'])
            result['result'] = 'BLOCKED_IDENTITY_DIFFERENCE'
            raise StopDifference()
    try:
        ancestors = []
        for index in range(12):
            value = snapshot('A%02d' % index, 'BEFORE')
            valid(value, directory=True)
            ancestors.append(value)
        for label, (_, size) in TOOLS.items():
            before = snapshot(label, 'BEFORE')
            valid(before, size=size)
            deadline.check()
            acquired = port.open(label)
            opened = snapshot(label, 'OPENED', acquired)
            compare(label, 'PATH_TO_OPEN', before, opened)
            valid(opened, size=size)
            during = snapshot(label, 'DURING', acquired)
            compare(label, 'WITHIN_OPEN', opened, during)
            valid(during, size=size)
            handle, acquired = acquired, None
            try:
                port.close(handle)
            except Exception:
                result['errors'].append('CLOSE_UNCERTAIN')
                raise
            after = snapshot(label, 'AFTER')
            compare(label, 'PATH_AFTER_CLOSE', before, after)
            valid(after, size=size)
        for index, before in enumerate(ancestors):
            label = 'A%02d' % index
            after = snapshot(label, 'AFTER')
            compare(label, 'ANCESTOR_AFTER', before, after, leaf=False)
            valid(after, directory=True)
        result.update(result='IDENTITIES_OBSERVED', file_validation_complete=True)
    except StopDifference:
        pass
    except Exception as error:
        result['errors'].append('TIME_BUDGET' if isinstance(error, TimeoutError) else 'OTHER_REDACTED')
    finally:
        if acquired is not None:
            handle, acquired = acquired, None
            try:
                port.close(handle)
            except Exception:
                result['errors'].append('CLOSE_UNCERTAIN')
        try:
            deadline.check()
        except Exception:
            result['errors'].append('TIME_BUDGET')
        if result['errors']:
            result.update(result='UNKNOWN_OR_INCOMPLETE', file_validation_complete=False)
    return result


class FixedMetadataPort:
    """Real metadata only; integers/fds have no implicit destructor close retry."""
    def __init__(self, api=None):
        import os
        self.os = os if api is None else api
        self.paths = dict(('A%02d' % i, p) for i, p in enumerate(ANCESTORS))
        self.paths.update((label, item[0]) for label, item in TOOLS.items())
        self.owned = set()
        self.opens = set()
        self.count = 0
    def values(self, info):
        # No default for missing Windows attributes, no conversion of bool/string.
        return {name: getattr(info, name) for name in model.FIELDS}
    def lstat(self, label):
        if label not in self.paths or self.count >= 32:
            raise InvalidObservation()
        self.count += 1
        return self.values(self.os.lstat(self.paths[label]))
    def open(self, label):
        if label not in TOOLS or label in self.opens:
            raise InvalidObservation()
        self.opens.add(label)
        fd = self.os.open(self.paths[label], self.os.O_RDONLY | self.os.O_BINARY | self.os.O_NOINHERIT)
        self.owned.add(fd)
        return fd
    def fstat(self, fd):
        if fd not in self.owned or self.count >= 32:
            raise InvalidObservation()
        self.count += 1
        return self.values(self.os.fstat(fd))
    def close(self, fd):
        self.owned.remove(fd)
        self.os.close(fd)
