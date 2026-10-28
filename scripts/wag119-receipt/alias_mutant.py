"""Run the pure receipt suite against a deliberately weakened identity criterion.

This is a test-only mutation gate. It must fail closed when the source mutation
no longer matches the current receipt_model.py expression: a false green gate
is worse than a red gate after a source refactor.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).absolute().parent
MODEL_DIR = ROOT / 'wag119-receipt-prep-20261026-1'
MODEL = MODEL_DIR / 'receipt_model.py'
TEST_RUNNER = ROOT / 'run_tests.py'

CURRENT_IDENTITY_EXPRESSION = (
    "IDENTITY_FIELDS = ('st_dev', 'st_ino', 'st_size')"
)
ALIAS_MUTATION = (
    "IDENTITY_FIELDS = ('st_dev', 'st_ino', 'st_size', 'st_mode')"
)


def main():
    source = MODEL.read_text(encoding='utf-8')
    if source.count(CURRENT_IDENTITY_EXPRESSION) != 1:
        raise SystemExit('alias mutation did not match exactly one current expression')
    mutated = source.replace(CURRENT_IDENTITY_EXPRESSION, ALIAS_MUTATION, 1)

    with tempfile.TemporaryDirectory(prefix='wag119-alias-mutant-') as raw:
        temp_root = Path(raw)
        temp_receipt = temp_root / 'wag119-receipt'
        shutil.copytree(ROOT, temp_receipt)
        temp_model = temp_receipt / MODEL_DIR.name / MODEL.name
        temp_model.write_text(mutated, encoding='utf-8', newline='')
        completed = subprocess.run(
            [sys.executable, '-I', '-S', '-B', str(temp_receipt / TEST_RUNNER.name)],
            cwd=temp_receipt,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )

    if completed.returncode == 0:
        print(completed.stdout, end='')
        raise SystemExit('alias mutant survived: pure tests are not guarding identity')
    print('alias-mutant: mutation matched current expression and was rejected')
    print(completed.stdout, end='')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
