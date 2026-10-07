"""Release CLI acceptance seam; every host/dependency command is a temp-root stub."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wag-release-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.source = self.base / "source"
        self.root = self.base / "target"
        self.units = self.base / "units"
        self.bin = self.base / "bin"
        self.effects = self.base / "effects"
        self.bin.mkdir()
        self.root.mkdir()
        self.units.mkdir()
        files = subprocess.check_output(["git", "-C", str(SOURCE), "ls-files"], text=True).splitlines()
        # Include the candidate implementation before it has been committed.
        files += ["scripts/release.py"] if (SOURCE / "scripts/release.py").exists() else []
        for name in set(files):
            file = SOURCE / name
            if file.is_file():
                dest = self.source / name
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(file, dest)
        for folder, package, version in (("gateway", "express", "5.1.0"),
                                          ("runtime/playwright-mcp", "@playwright/mcp", "0.0.79")):
            manifest = {"name": "fixture", "version": "1.0.0", "dependencies": {package: version}}
            (self.source / folder / "package.json").write_text(json.dumps(manifest))
            lock = {"lockfileVersion": 3, "packages": {"": manifest,
                    "node_modules/" + package: {"version": version}}}
            (self.source / folder / "package-lock.json").write_text(json.dumps(lock))
        (self.source / "config/crawl4ai-requirements.lock").write_text("Crawl4AI==0.9.2\nfastapi==0.141.1\nuvicorn==0.52.4\nplaywright==1.62.0\n")
        # The fixture has a reviewed revision, without touching the working repo.
        subprocess.run(["git", "init", "-q", str(self.source)], check=True)
        subprocess.run(["git", "-C", str(self.source), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.source), "-c", "user.name=Fixture", "-c",
                        "user.email=fixture@example.invalid", "commit", "-qm", "Fixture\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>"], check=True)
        self.stub("systemctl", '''printf 'service %s\n' "$*" >> "$TEST_EFFECTS"
case "$1" in
  is-active) printf 'inactive\n'; exit 3;;
  is-enabled) printf 'disabled\n'; exit 1;;
esac
if [[ "${FAIL_SERVICE:-}" == 1 && "$1" == restart ]]; then exit 9; fi
if [[ "${FAIL_RESTORE:-}" == 1 && "$1" == stop ]]; then printf 'dummy-sensitive-output' >&2; exit 9; fi
# systemctl disable can remove the top-level link as well as wants links.
if [[ "$1" == disable ]]; then rm -f -- "$TEST_UNIT_DIR/$2"; fi''')
        self.stub("install", '''for arg in "$@"; do
  if [[ "$arg" == /* && "$arg" != "$TEST_BASE/"* ]]; then exit 91; fi
done
exec /usr/bin/install "$@"''')
        self.stub("npm", '''printf 'npm %s\n' "$*" >> "$TEST_EFFECTS"
[[ "${FAIL_INSTALL:-}" != 1 ]] || exit 9
exec /usr/bin/python3 "$TEST_NPM" "$@"''')
        npm_helper = self.base / "npm.py"
        npm_helper.write_text('''import json, pathlib, sys
args = sys.argv[1:]
if args == ['--version']:
    print('10.9.0'); sys.exit()
assert args[0] == 'ci' and '--omit=dev' in args and '--ignore-scripts' in args
root = pathlib.Path(args[args.index('--prefix') + 1])
for name, item in json.loads((root / 'package-lock.json').read_text())['packages'].items():
    if not name: continue
    file = root / name / 'package.json'
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(json.dumps({'name': name.split('node_modules/')[-1], 'version': item['version']}))
''')
        self.stub("fixture-python", '''if [[ "$*" == '--version' ]]; then printf 'Python 3.12.3\n'; exit; fi
[[ "$1" == -m && "$2" == venv ]] || exit 91
mkdir -p "$3/bin"
cp "$TEST_BIN/pip" "$3/bin/pip"
cp "$TEST_BIN/venv-python" "$3/bin/python"''')
        self.stub("pip", '''printf 'pip %s\n' "$*" >> "$TEST_EFFECTS"
case "$1" in
 install) [[ "$*" == *--no-deps* && "$*" == *--requirement* && "${FAIL_PIP:-}" != 1 ]];;
 check) exit 0;;
 list) printf '[{"name":"Crawl4AI","version":"0.9.2"},{"name":"fastapi","version":"0.141.1"},{"name":"uvicorn","version":"0.52.4"},{"name":"playwright","version":"1.62.0"}]\n';;
 *) exit 91;;
esac''')
        self.stub("venv-python", '''if [[ "$*" == '--version' ]]; then printf 'Python 3.12.3\n'; else printf '["%s"]\n' "$TEST_BROWSER"; fi''')
        self.stub("health", '''printf 'health %s\n' "$*" >> "$TEST_EFFECTS"
if [[ "$*" == --core-only ]]; then
  if [[ "${INTERRUPT:-}" == 1 ]]; then kill -TERM "$PPID"; exit 9; fi
  if [[ "${CRASH:-}" == 1 ]]; then kill -KILL "$PPID"; exit 9; fi
  if [[ "${INTERRUPT_ONCE:-}" == 1 && ! -f "$TEST_EFFECTS.interrupted" ]]; then touch "$TEST_EFFECTS.interrupted"; kill -TERM "$PPID"; exit 0; fi
  if [[ "${FAIL_CORE:-}" == 1 ]]; then printf '%s\n' '{"layer":"gateway-ready","ok":false,"error":{"kind":"core_failure","message":"dummy-sensitive-output"},"authorization":"dummy-sensitive-output"}' >&2; exit 1; fi
else [[ "${FAIL_PUBLIC:-}" != 1 ]]; fi''')
        node = self.root / "runtime/node/bin/node"
        node.parent.mkdir(parents=True)
        node.write_text('#!/usr/bin/env bash\nif [[ "$*" == --version ]]; then printf "v22.23.2\\n"; fi\n')
        node.chmod(0o755)
        browser = self.root / "runtime/playwright-browsers/chromium-1237/chrome-linux64/chrome"
        browser.parent.mkdir(parents=True)
        browser.write_text('#!/usr/bin/env bash\nprintf "Chromium 148.0.0\\n"\n')
        browser.chmod(0o755)
        secrets = self.root / "secrets"
        secrets.mkdir()
        (secrets / "gateway.env").write_text("GATEWAY_BIND_HOST=127.0.0.1\nGATEWAY_TOKEN=dummy-preserve-credential\n")
        (secrets / "crawl4ai.env").write_text("CRAWL4AI_TOKEN=dummy-preserve-credential\n")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("WAG_", "GATEWAY_", "CRAWL4AI_"))}
        self.env.update(PATH=str(self.bin) + os.pathsep + os.environ["PATH"],
                        WAG_RELEASE_NPM=str(self.bin / "npm"), WAG_RELEASE_PYTHON=str(self.bin / "fixture-python"),
                        WAG_RELEASE_HEALTHCHECK=str(self.bin / "health"),
                        TEST_BASE=str(self.base), TEST_EFFECTS=str(self.effects), TEST_NPM=str(npm_helper), TEST_BIN=str(self.bin),
                        TEST_BROWSER=str(browser), TEST_UNIT_DIR=str(self.units), WAG_RELEASE_ATTEMPTS="2", WAG_RELEASE_DELAY="0")

    def stub(self, name, body):
        file = self.bin / name
        file.write_text("#!/usr/bin/env bash\nset -euo pipefail\n" + body + "\n", newline="\n")
        file.chmod(0o755)

    def command(self, *args, **env):
        return subprocess.run(["bash", str(SOURCE / "scripts/deploy.sh"), *map(str, args)],
                              env={**self.env, **env}, capture_output=True, text=True, timeout=30)

    def prepare(self, **env):
        result = self.command("prepare", self.source, "--target", self.root, "--units", self.units, **env)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return Path(json.loads(result.stdout)["transaction"])

    def test_prepare_stages_reviewed_production_inventory_without_activation(self):
        tx = self.prepare()
        candidate = tx / "candidate"
        for name in ("runtime/gateway/search.mjs", "runtime/gateway/public/evals.html",
                     "runtime/gateway/eval-runner.mjs", "runtime/crawl4ai-service/app.py",
                     "runtime/proxy/server.mjs", "runtime/playwright-mcp/package-lock.json",
                     "eval/samples.json", "scripts/searxng-apply-overlay.sh",
                     "systemd/web-access-artifact-cleanup.timer"):
            self.assertTrue((candidate / name).is_file(), name)
        self.assertFalse((candidate / "runtime/gateway/search.test.mjs").exists())
        self.assertFalse((candidate / "runtime/gateway/fixtures").exists())
        self.assertFalse((self.root / "runtime/gateway/server.mjs").exists())
        effects = self.effects.read_text()
        self.assertIn("npm ci", effects)
        self.assertIn("--requirement", effects)
        self.assertNotIn("service restart", effects)
        self.assertEqual(json.loads((tx / "state.json").read_text())["status"], "prepared")

    def snapshot(self):
        result = {}
        for base, prefix in ((self.root, "root"), (self.units, "units")):
            for file in base.rglob("*"):
                rel = file.relative_to(base)
                if rel.parts[0] == "releases" or rel.name.startswith(".release-"):
                    continue
                if file.is_symlink():
                    result[prefix + "/" + str(rel)] = ("link", os.readlink(file))
                elif file.is_file():
                    result[prefix + "/" + str(rel)] = ("file", file.read_bytes(), file.stat().st_mode & 0o777)
                elif file.is_dir():
                    result[prefix + "/" + str(rel)] = ("directory",)
        return result

    def previous_runtime(self):
        for name, content in {"runtime/gateway/server.mjs": "// previous runtime\n",
                              "runtime/gateway/obsolete.mjs": "// obsolete owned code\n",
                              "runtime/gateway/obsolete.test.mjs": "// previously shipped test\n",
                              "runtime/gateway/reports/keep.json": "retained report",
                              "runtime/gateway/operator.env": "DUMMY_SECRET=keep",
                              "config/playwright.env": "HTTP_PROXY=http://dummy:dummy@127.0.0.1:7895\nCUSTOM=keep\n",
                              "config/operator.conf": "keep unrelated config",
                              "artifacts/keep.pdf": "keep artifact",
                              "scripts/obsolete.sh": "#!/bin/bash\n",
                              "scripts/operator.conf": "keep unrelated config"}.items():
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(content)
        (self.units / "web-access-gateway.service").symlink_to("/dummy/previous-unit")
        (self.units / "unrelated.service").write_text("keep unrelated unit")

    def test_activation_synchronizes_owned_files_and_abort_restores_exact_absence(self):
        self.previous_runtime()
        before = self.snapshot()
        tx = self.prepare()
        result = self.command("activate", tx)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.root / "runtime/gateway/obsolete.mjs").exists())
        self.assertFalse((self.root / "runtime/gateway/obsolete.test.mjs").exists())
        self.assertFalse((self.root / "scripts/obsolete.sh").exists())
        for name in ("runtime/gateway/operator.env", "runtime/gateway/reports/keep.json",
                     "config/operator.conf", "artifacts/keep.pdf", "scripts/operator.conf"):
            self.assertEqual(self.snapshot()["root/" + name], before["root/" + name])
        self.assertEqual((self.root / "config/playwright.env").read_bytes(), before["root/config/playwright.env"][1])
        for unit in (SOURCE / "systemd").glob("web-access-*.*"):
            self.assertEqual((self.root / "systemd" / unit.name).read_bytes(), unit.read_bytes())
            self.assertEqual(os.readlink(self.units / unit.name), str(self.root / "systemd" / unit.name))
        self.assertEqual(json.loads((tx / "state.json").read_text())["status"], "activated")
        self.assertIn("web-access-artifact-cleanup.timer", self.effects.read_text())
        result = self.command("abort", tx)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.snapshot(), before)

    def test_readiness_and_interruption_abort_but_public_degradation_can_commit(self):
        self.previous_runtime()
        before = self.snapshot()
        for failure in ({"FAIL_CORE": "1"}, {"INTERRUPT": "1"}, {"INTERRUPT_ONCE": "1"}, {"FAIL_SERVICE": "1"}):
            with self.subTest(failure=failure):
                tx = self.prepare()
                result = self.command("activate", tx, **failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(), before)
                state = json.loads((tx / "state.json").read_text())
                self.assertEqual(state["status"], "restored")
                if "FAIL_CORE" in failure:
                    self.assertEqual(state["readiness_diagnostics"][-1]["error"]["kind"], "core_failure")
                    self.assertNotIn("dummy-sensitive-output", json.dumps(state))
                self.assertNotIn("dummy-preserve-credential", result.stdout + result.stderr)
        tx = self.prepare()
        result = self.command("activate", tx, FAIL_PUBLIC="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["public_readiness"], "degraded")
        self.assertEqual(self.command("commit", tx).returncode, 0)
        self.assertEqual(self.command("restore", tx).returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.command("restore", tx).returncode, 0, "restore is idempotent")

    def test_dependency_failures_leave_runtime_untouched_and_clear_staging(self):
        self.previous_runtime()
        before = self.snapshot()
        for failure in ({"FAIL_INSTALL": "1"}, {"FAIL_PIP": "1"}):
            result = self.command("prepare", self.source, "--target", self.root, "--units", self.units, **failure)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(before, self.snapshot())
            self.assertEqual(list((self.root / "releases").iterdir()), [])
            self.assertFalse((self.root / ".release-pending").exists())

    def test_provenance_is_deterministic_and_does_not_hash_env_or_report_data(self):
        tx = self.prepare()
        first = (tx / "provenance.json").read_bytes()
        self.assertEqual(self.command("abort", tx).returncode, 0)
        secret = self.root / "secrets/gateway.env"
        secret.write_text(secret.read_text().replace("dummy-preserve-credential", "different-dummy-credential"))
        tx = self.prepare()
        second = (tx / "provenance.json").read_bytes()
        self.assertEqual(first, second)
        provenance = json.loads(second)
        self.assertIn("express", str(provenance["versions"]["node_packages"]))
        self.assertNotIn("credential", second.decode())
        self.assertNotIn("config/playwright.env", provenance["inventory"])
        self.assertEqual(self.command("abort", tx).returncode, 0)

    def test_tampered_candidate_is_aborted_before_services_change(self):
        before = self.snapshot()
        tx = self.prepare()
        (tx / "candidate/runtime/gateway/search.mjs").write_text("// mixed candidate")
        result = self.command("activate", tx)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(json.loads((tx / "state.json").read_text())["status"], "restored")
        self.assertNotIn("service stop", self.effects.read_text())

    def test_crashed_activation_keeps_journal_for_explicit_abort(self):
        self.previous_runtime()
        before = self.snapshot()
        tx = self.prepare()
        result = self.command("activate", tx, CRASH="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads((tx / "state.json").read_text())["status"], "activating")
        self.assertNotEqual(self.command("prepare", self.source, "--target", self.root, "--units", self.units).returncode, 0)
        self.assertEqual(self.command("abort", tx).returncode, 0)
        self.assertEqual(before, self.snapshot())

    def test_commit_rejects_dependency_drift_and_restores_previous_runtime(self):
        self.previous_runtime()
        before = self.snapshot()
        tx = self.prepare()
        self.assertEqual(self.command("activate", tx).returncode, 0)
        package = tx / "candidate/runtime/gateway/node_modules/express/package.json"
        package.write_text('{"name":"express","version":"0.0.0"}')
        result = self.command("commit", tx)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(json.loads((tx / "state.json").read_text())["status"], "restored")

    def test_failed_committed_restore_reports_sanitized_evidence_and_can_retry(self):
        self.previous_runtime()
        before = self.snapshot()
        tx = self.prepare()
        self.assertEqual(self.command("activate", tx).returncode, 0)
        self.assertEqual(self.command("commit", tx).returncode, 0)
        result = self.command("restore", tx, FAIL_RESTORE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("dummy-sensitive-output", result.stdout + result.stderr)
        state = json.loads((tx / "state.json").read_text())
        self.assertEqual(state["status"], "restore_failed")
        self.assertEqual(state["restore_errors"], ["service_stop"])
        self.assertEqual(self.command("restore", tx).returncode, 0)
        self.assertEqual(before, self.snapshot())

    def test_missing_browser_prerequisite_cannot_activate_or_leave_staging(self):
        Path(self.env["TEST_BROWSER"]).unlink()
        before = self.snapshot()
        result = self.command("prepare", self.source, "--target", self.root, "--units", self.units)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("browser", result.stderr)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(list((self.root / "releases").iterdir()), [])
        self.assertNotIn("service ", self.effects.read_text())

    def test_new_tracked_helpers_are_included_but_new_test_artifacts_are_not(self):
        for name in ("gateway/future-helper.mjs", "scripts/future-helper.py", "gateway/future-helper.test.mjs",
                     "gateway/fixtures/future-helper.mjs"):
            file = self.source / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text("# fixture\n" if file.suffix == ".py" else "// fixture\n")
        subprocess.run(["git", "-C", str(self.source), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.source), "-c", "user.name=Fixture", "-c",
                        "user.email=fixture@example.invalid", "commit", "-qm", "Future helpers\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>"], check=True)
        tx = self.prepare()
        entries = json.loads((tx / "provenance.json").read_text())["inventory"]
        self.assertIn("runtime/gateway/future-helper.mjs", entries)
        self.assertIn("scripts/future-helper.py", entries)
        self.assertNotIn("runtime/gateway/future-helper.test.mjs", entries)
        self.assertNotIn("runtime/gateway/fixtures/future-helper.mjs", entries)


if __name__ == "__main__":
    unittest.main()
