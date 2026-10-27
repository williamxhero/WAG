"""Run the SPEC #119 receipt-harness unit tests with the pinned interpreter.

    python -I -S -B scripts/wag119-receipt/run_tests.py

The adapters import each other by bare module name (`import receipt_model`),
and the model lives in a sibling directory, so both directories are placed on
sys.path explicitly. This mirrors how the diagnostic payload loaded them under
`python -I`, where the current directory is not on sys.path.

These are byte-exact source checks: `receipt_model` and `metadata_adapter` are
frozen by SHA-256 in the harness, so `.gitattributes` pins this tree to LF.
Windows-only: `host_adapter` imports `_winapi` and starts real Win32 handles
only through its explicit port, never at import.
"""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).absolute().parent
MODEL = ROOT / 'wag119-receipt-prep-20261026-1'
ADAPTER = ROOT / 'wag119-receipt-adapter-prep-20261026-1'
MODULES = ('receipt_model_test', 'metadata_adapter_test',
           'host_adapter_test', 'receipt_driver_test')


def main():
    sys.path[:0] = [str(ADAPTER), str(MODEL)]
    suite = unittest.TestSuite()
    for name in MODULES:
        suite.addTests(unittest.defaultTestLoader.loadTestsFromName(name))
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())