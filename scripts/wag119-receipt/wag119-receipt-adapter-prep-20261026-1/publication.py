"""Bounded publication helpers; no file is opened at import time."""
import json

NAMES = ('attempt.json', 'observation.json', 'stdout.bin', 'stderr.bin')
LIMIT = 16384


class FixedFilePort:
    """Path checks, not a native directory-handle sandbox or immutable binding."""
    def __init__(self, api=None):
        from pathlib import Path
        from host_adapter import RUNTIME_ROOT
        self.root = Path(RUNTIME_ROOT)
        self.api = api
        self.owned = set()
        self.created = set()
        self.deadline = None
        self.root_key = None
    def stat(self, path=None, fd=None, directory=False):
        import receipt_model
        self.deadline.check()
        raw = self.api.lstat(path) if fd is None else self.api.fstat(fd)
        value = {name: getattr(raw, name) for name in receipt_model.FIELDS}
        self.deadline.check()
        if receipt_model.compare_tool_identity(value, value) is None:
            raise ValueError()
        if (value['st_mode'] & 0o170000 != (0o040000 if directory else 0o100000)
                or value['st_file_attributes'] & 1024
                or (not directory and value['st_nlink'] != 1)):
            raise ValueError()
        return value
    def check_root(self):
        value = self.stat(self.root, directory=True)
        key = tuple(value[name] for name in ('st_dev', 'st_ino', 'st_mode', 'st_file_attributes'))
        if self.root_key is not None and key != self.root_key:
            raise ValueError()
        self.root_key = key
    def prepare_root(self):
        if self.api is None:
            import os
            self.api = os
        for path in reversed(self.root.parents):
            self.stat(path, directory=True)
        self.deadline.check()
        self.api.mkdir(self.root)
        self.check_root()
    def create(self, name):
        if name not in NAMES or name in self.created:
            raise ValueError()
        self.created.add(name)
        self.check_root()
        api = self.api
        fd = api.open(self.root / name, api.O_WRONLY | api.O_CREAT | api.O_EXCL
                      | api.O_BINARY | api.O_NOINHERIT, 0o600)
        self.owned.add(fd)
        try:
            self.deadline.check()
            before = self.stat(fd=fd)
            if before != self.stat(self.root / name):
                raise ValueError()
        except Exception:
            self.close(fd)
            raise
        return fd
    def write(self, fd, data):
        if fd not in self.owned or type(data) is not bytes or len(data) > LIMIT:
            raise ValueError()
        return self.api.write(fd, data)
    def flush(self, fd):
        # Naked descriptors use one unbuffered os.write: no Python buffer to flush.
        if fd not in self.owned:
            raise ValueError()
    def sync(self, fd):
        if fd not in self.owned:
            raise ValueError()
        self.api.fsync(fd)
    def close(self, fd):
        self.owned.remove(fd)
        self.api.close(fd)
    def readback(self, name, limit):
        if name not in self.created or limit != LIMIT + 1:
            raise ValueError()
        self.check_root()
        api = self.api
        fd = api.open(self.root / name, api.O_RDONLY | api.O_BINARY | api.O_NOINHERIT)
        self.owned.add(fd)
        try:
            before = self.stat(fd=fd)
            if before['st_size'] > LIMIT:
                raise ValueError()
            self.deadline.check()
            data = api.read(fd, limit)
            if before != self.stat(fd=fd) or before != self.stat(self.root / name):
                raise ValueError()
            return data
        finally:
            self.close(fd)


def encode(value):
    parts = []
    count = 0
    for part in json.JSONEncoder(ensure_ascii=True, allow_nan=False, separators=(',', ':')).iterencode(value):
        data = part.encode('ascii')
        count += len(data)
        if count > LIMIT:
            raise ValueError()
        parts.append(data)
    return b''.join(parts)


class Publisher:
    def __init__(self, port, deadline):
        self.port, self.deadline = port, deadline
        self.port.deadline = deadline
        self.used = set()
    def put(self, name, data):
        if name not in NAMES or name in self.used or type(data) is not bytes or len(data) > LIMIT:
            raise ValueError()
        self.used.add(name)
        handle = None
        try:
            self.deadline.check()
            handle = self.port.create(name)
            self.deadline.check()
            if self.port.write(handle, data) != len(data):
                raise OSError()
            self.deadline.check()
            self.port.flush(handle)
            self.deadline.check()
            self.port.sync(handle)
            self.deadline.check()
        finally:
            if handle is not None:
                owned, handle = handle, None
                self.port.close(owned)
        self.deadline.check()
        if self.port.readback(name, LIMIT + 1) != data:
            raise OSError()
        self.deadline.check()
