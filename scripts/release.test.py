"""Release browser probe guards; real dependencies/cache require WAG_PROBE_REAL=1."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

SOURCE = Path(__file__).with_name("release.py")


def browser_probe():
    # Inspect the real Linux release module without importing fcntl on Windows.
    module = ast.parse(SOURCE.read_text())
    assignment = next(node for node in module.body if isinstance(node, ast.Assign)
                      and any(isinstance(target, ast.Name) and target.id == "BROWSER_PROBE"
                              for target in node.targets))
    return ast.literal_eval(assignment.value), module


def browser_cache():
    configured = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if configured == "0":
        package = importlib.util.find_spec("playwright")
        if package is None:
            return None
        return Path(package.origin).parent / "driver/package/.local-browsers"
    if configured:
        return Path(configured)
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData/Local")) / "ms-playwright"
    if sys.platform == "darwin":
        return Path.home() / "Library/Caches/ms-playwright"
    return Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "ms-playwright"


class BrowserProbeTests(unittest.TestCase):
    def test_prerequisites_uses_the_guarded_probe(self):
        _, module = browser_probe()
        prerequisites = next(node for node in module.body if isinstance(node, ast.FunctionDef)
                             and node.name == "prerequisites")
        command = next(node for node in ast.walk(prerequisites) if isinstance(node, ast.Call)
                       and isinstance(node.func, ast.Name) and node.func.id == "run"
                       and len(node.args) > 1 and isinstance(node.args[1], ast.Constant)
                       and node.args[1].value == "crawler/browser imports")
        self.assertEqual(command.args[0].elts[-2].value, "-c")
        self.assertIsInstance(command.args[0].elts[-1], ast.Name)
        self.assertEqual(command.args[0].elts[-1].id, "BROWSER_PROBE")

    def test_sync_drivers_use_separate_non_nested_contexts(self):
        source, _ = browser_probe()
        module = ast.parse(source)
        contexts = [node for node in ast.walk(module) if isinstance(node, ast.With)]
        self.assertEqual(len(contexts), 2, "both sync drivers need separate with statements")
        self.assertTrue(all(len(node.items) == 1 for node in contexts),
                        "never combine sync drivers in a single with statement")
        self.assertTrue(all(node in module.body for node in contexts),
                        "exit the first sync context before entering the second")
        self.assertEqual([node.items[0].context_expr.func.id for node in contexts],
                         ["sync_playwright", "patch"])

    @unittest.skipUnless(os.environ.get("WAG_PROBE_REAL") == "1",
                         "real browser probe requires explicit opt-in WAG_PROBE_REAL=1")
    def test_real_probe_exits_zero_and_reports_existing_executables(self):
        cache = browser_cache()
        if cache is None or not cache.is_dir() or not any(cache.glob("chromium-*")):
            self.skipTest(f"no Chromium browser cache available at {cache}")
        source, _ = browser_probe()
        env = dict(os.environ, PLAYWRIGHT_SKIP_BROWSER_GC="1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1")
        result = subprocess.run([sys.executable, "-c", source], env=env,
                                capture_output=True, text=True, timeout=120)
        # Successful sync-driver teardown can emit stderr noise; exit/JSON are the contract.
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        paths = json.loads(result.stdout.strip())
        self.assertIsInstance(paths, list)
        self.assertEqual(len(paths), 2)
        for path in paths:
            self.assertIsInstance(path, str)
            self.assertTrue(Path(path).is_file(), f"browser executable missing: {path}")


if __name__ == "__main__":
    unittest.main()
