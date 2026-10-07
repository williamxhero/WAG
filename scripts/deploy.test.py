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
        files += [name for name in ("scripts/release.py", "scripts/searxng-overlay.py") if (SOURCE / name).exists()]
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
import os, shutil
if os.environ.get('TEST_REAL_GATEWAY_PACKAGES') and root.name == 'gateway':
    shutil.copytree(os.environ['TEST_REAL_GATEWAY_PACKAGES'], root / 'node_modules')
    sys.exit()
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
                        TEST_BROWSER=str(browser), TEST_UNIT_DIR=str(self.units), WAG_RELEASE_ATTEMPTS="2", WAG_RELEASE_DELAY="0",
                        WAG_OVERLAY_ATTEMPTS="1", WAG_OVERLAY_DELAY="0")

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

    def overlay_fixture(self):
        self.settings = self.base / "searxng" / "settings.yml"
        self.settings.parent.mkdir()
        self.settings.write_text('''# Preserve exact bytes on restoration.
server:
  secret_key: dummy-settings-secret
outgoing:
  proxies:
    all://: [http://dummy-user:dummy-password@127.0.0.1:7999]
  unrelated: keep
engines:
  - name: google
    engine: operator-google-backend
    disabled: true
    api_key: dummy-engine-secret
  - name: operator-engine
    engine: custom
    disabled: false
''')
        self.settings.chmod(0o640)
        self.stub("ss", "printf 'LISTEN 0 128 127.0.0.1:8801 0.0.0.0:*\\n'")
        self.stub("curl", '''while [[ "$1" != --output ]]; do shift; done
if [[ "${FAIL_SEARCH_ONCE:-}" == 1 && ! -f "$TEST_EFFECTS.search-failed" ]]; then
  touch "$TEST_EFFECTS.search-failed"
  printf '%s\\n' '{"results":[],"authorization":"dummy-sensitive-output"}' > "$2"
else
  printf '%s\\n' '{"results":[{"url":"https://example.com/","title":"fixture"}],"unresponsive_engines":[]}' > "$2"
fi''')
        self.stub("systemctl", '''printf 'service %s\\n' "$*" >> "$TEST_EFFECTS"
case "$1" in
  is-active) if [[ "$2" == searxng.service && "${OVERLAY_INACTIVE:-}" != 1 ]]; then printf 'active\\n'; else printf 'inactive\\n'; exit 3; fi; exit 0;;
  is-enabled) printf 'disabled\\n'; exit 1;;
esac
if [[ "${FAIL_SERVICE:-}" == 1 && "$1" == restart && "$2" != searxng.service ]]; then exit 9; fi
if [[ "${FAIL_OVERLAY:-}" == 1 && "$1" == restart && "$2" == searxng.service && ! -f "$TEST_EFFECTS.overlay-failed" ]]; then touch "$TEST_EFFECTS.overlay-failed"; printf 'dummy-sensitive-output' >&2; exit 9; fi
if [[ "${INTERRUPT_OVERLAY:-}" == 1 && "$1" == restart && "$2" == searxng.service && ! -f "$TEST_EFFECTS.overlay-interrupted" ]]; then touch "$TEST_EFFECTS.overlay-interrupted"; kill -TERM "$PPID"; exit 9; fi
if [[ "${FAIL_OVERLAY_RESTORE:-}" == 1 && "$1" == restart && "$2" == searxng.service ]]; then printf 'dummy-sensitive-output' >&2; exit 9; fi
if [[ "$1" == disable ]]; then rm -f -- "$TEST_UNIT_DIR/$2"; fi''')

    def prepare_overlay(self):
        result = self.command("prepare", self.source, "--target", self.root, "--units", self.units,
                              "--searxng-settings", self.settings)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return Path(json.loads(result.stdout)["transaction"])

    def test_coordinated_commit_preserves_backend_proxies_and_restores_exact_settings(self):
        import yaml
        self.previous_runtime()
        self.overlay_fixture()
        before, original = self.snapshot(), self.settings.read_bytes()
        metadata = self.settings.stat()
        tx = self.prepare_overlay()
        self.assertEqual(self.settings.read_bytes(), original, "prepare only snapshots")
        self.assertNotIn("service restart", self.effects.read_text())
        result = self.command("activate", tx)
        self.assertEqual(result.returncode, 0, result.stderr)
        effective = yaml.safe_load(self.settings.read_text())
        engines = {e["name"]: e for e in effective["engines"]}
        self.assertFalse(engines["google"]["disabled"])
        self.assertEqual(engines["google"]["engine"], "operator-google-backend")
        self.assertEqual(engines["google"]["api_key"], "dummy-engine-secret")
        self.assertEqual(engines["operator-engine"]["engine"], "custom")
        self.assertEqual(effective["outgoing"]["proxies"]["all://"],
                         ["http://dummy-user:dummy-password@127.0.0.1:7999"])
        self.assertEqual(effective["outgoing"]["unrelated"], "keep")
        self.assertEqual(self.command("commit", tx).returncode, 0)
        provenance = json.loads((tx / "provenance.json").read_text())
        self.assertEqual(len(provenance["searxng"]["effective_digest"]), 64)
        for secret in ("dummy-password", "dummy-settings-secret", "dummy-engine-secret"):
            self.assertNotIn(secret, json.dumps(provenance))
        for name in ("runtime/gateway/search.mjs", "runtime/gateway/evidence-metadata.mjs",
                     "scripts/searxng-overlay.py"):
            self.assertIn(name, provenance["inventory"])
        result = self.command("restore", tx)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.settings.read_bytes(), original)
        restored = self.settings.stat()
        self.assertEqual(restored.st_mode & 0o777, 0o640)
        self.assertEqual((restored.st_uid, restored.st_gid, restored.st_mtime_ns),
                         (metadata.st_uid, metadata.st_gid, metadata.st_mtime_ns))
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(self.command("restore", tx).returncode, 0)

    def test_coordinated_failures_and_interruption_restore_both_sides(self):
        self.previous_runtime()
        self.overlay_fixture()
        before, original = self.snapshot(), self.settings.read_bytes()
        for failure in ({"FAIL_OVERLAY": "1"}, {"FAIL_SEARCH_ONCE": "1"}, {"INTERRUPT_OVERLAY": "1"},
                        {"FAIL_SERVICE": "1"}, {"FAIL_CORE": "1"}, {"INTERRUPT": "1"}, {"INTERRUPT_ONCE": "1"}):
            with self.subTest(failure=failure):
                tx = self.prepare_overlay()
                result = self.command("activate", tx, **failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.settings.read_bytes(), original)
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(json.loads((tx / "state.json").read_text())["status"], "restored")
                self.assertFalse((self.root / ".release-pending").exists())
                self.assertNotIn("dummy-sensitive-output", result.stdout + result.stderr)

    def test_effective_overlay_drift_at_commit_restores_both_sides(self):
        import yaml
        self.previous_runtime()
        self.overlay_fixture()
        before, original = self.snapshot(), self.settings.read_bytes()
        for drift in ("engine", "proxy"):
            with self.subTest(drift=drift):
                tx = self.prepare_overlay()
                self.assertEqual(self.command("activate", tx).returncode, 0)
                value = yaml.safe_load(self.settings.read_text())
                if drift == "engine":
                    value["engines"][0]["disabled"] = True
                else:
                    value["outgoing"]["proxies"]["all://"] = ["http://127.0.0.1:7888"]
                self.settings.write_text(yaml.safe_dump(value))
                result = self.command("commit", tx)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(self.snapshot(), before)
                self.assertEqual(self.settings.read_bytes(), original)
                self.assertEqual(json.loads((tx / "state.json").read_text())["status"], "restored")

    def test_failed_overlay_restore_is_sanitized_retryable_and_restores_runtime(self):
        self.previous_runtime()
        self.overlay_fixture()
        before, original = self.snapshot(), self.settings.read_bytes()
        tx = self.prepare_overlay()
        self.assertEqual(self.command("activate", tx).returncode, 0)
        self.assertEqual(self.command("commit", tx).returncode, 0)
        result = self.command("restore", tx, FAIL_OVERLAY_RESTORE="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("dummy-sensitive-output", result.stdout + result.stderr)
        state = json.loads((tx / "state.json").read_text())
        self.assertEqual(state["status"], "restore_failed")
        self.assertEqual(state["restore_errors"], ["overlay_restore"])
        self.assertEqual(state["overlay_restore_errors"], ["service_restore"])
        self.assertEqual(json.loads(self.command("status", tx).stdout)["overlay_restore_errors"], ["service_restore"])
        self.assertTrue((self.root / ".release-pending").exists())
        self.assertEqual(self.snapshot(), before, "runtime restores even when the overlay service fails")
        self.assertEqual(self.settings.read_bytes(), original)
        self.assertEqual(self.command("restore", tx).returncode, 0)
        self.assertEqual(json.loads((tx / "state.json").read_text())["status"], "restored")
        self.assertFalse((self.root / ".release-pending").exists())

    def test_superseded_restore_cannot_touch_the_overlay(self):
        self.overlay_fixture()
        first = self.prepare_overlay()
        self.assertEqual(self.command("activate", first).returncode, 0)
        self.assertEqual(self.command("commit", first).returncode, 0)
        second = self.prepare_overlay()
        effective = self.settings.read_bytes()
        effects = self.effects.read_bytes()
        self.assertNotEqual(self.command("restore", first).returncode, 0)
        self.assertEqual(self.settings.read_bytes(), effective)
        self.assertEqual(self.effects.read_bytes(), effects)
        self.assertEqual(self.command("abort", second).returncode, 0)
        self.assertEqual(self.command("restore", first).returncode, 0)

    def overlay_command(self, *args, **env):
        return subprocess.run(["python3", str(SOURCE / "scripts/searxng-overlay.py"), *map(str, args)],
                              env={**self.env, **env}, capture_output=True, text=True, timeout=30)

    def test_standalone_overlay_rejects_backup_collisions_and_malformed_inputs(self):
        self.overlay_fixture()
        original = self.settings.read_bytes()
        backup = self.base / "overlay-fixed"
        overlay = SOURCE / "config/searxng/settings-overlay.yml"
        result = self.overlay_command("prepare", self.settings, overlay, "--backup", backup)
        self.assertEqual(result.returncode, 0, result.stderr)
        snapshot = (backup / "settings.yml").read_bytes()
        result = self.overlay_command("prepare", self.settings, overlay, "--backup", backup)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((backup / "settings.yml").read_bytes(), snapshot)
        self.assertEqual(self.settings.read_bytes(), original)
        for malformed in ("server: [dummy-settings-secret", "engines: wrong", "- wrong-root",
                          "engines:\n  - name: google\n  - name: google\n"):
            self.settings.write_text(malformed)
            result = self.overlay_command("prepare", self.settings, overlay, "--backup", self.base / "bad-backup")
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("dummy-settings-secret", result.stdout + result.stderr)
            self.assertFalse((self.base / "bad-backup").exists())
            self.assertEqual(self.settings.read_text(), malformed)
        self.assertNotIn("service restart", self.effects.read_text())

    def test_overlay_prepare_snapshot_cannot_hide_settings_or_staged_merge_drift(self):
        self.overlay_fixture()
        for changed in ("settings", "merged"):
            with self.subTest(changed=changed):
                tx = self.prepare_overlay()
                target = self.settings if changed == "settings" else tx / "searxng/merged.yml"
                target.write_text(target.read_text().replace("dummy-drift-secret", "dummy-merge-secret")
                                  .replace("dummy-settings-secret", "dummy-drift-secret"))
                result = self.command("activate", tx)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("service restart", self.effects.read_text())
                self.assertNotIn("dummy-drift-secret", result.stdout + result.stderr)
                # No mutation happened, so operator edits made since prepare must
                # not be overwritten by aborting a still-prepared overlay.
                if changed == "settings":
                    self.assertIn("dummy-drift-secret", self.settings.read_text())
                self.effects.write_text("")

    def test_complete_offline_rehearsal_runs_provenance_matched_search_and_independent_helper(self):
        self.previous_runtime()
        self.overlay_fixture()
        # Provision separately with npm ci before this deterministic acceptance
        # run. The npm boundary copies that local cache; no network or install
        # hooks are used during the transaction rehearsal.
        packages = SOURCE / "gateway/node_modules"
        self.assertTrue((packages / "jsdom/package.json").is_file(), "provision gateway npm ci first")
        actual_node = os.environ.get("WAG_TEST_NODE") or shutil.which("node")
        self.assertTrue(actual_node, "Node 22 must be provisioned before the offline rehearsal")
        node = self.root / "runtime/node/bin/node"
        node.unlink()
        node.symlink_to(Path(actual_node).resolve())
        for name in ("package.json", "package-lock.json"):
            shutil.copy2(SOURCE / "gateway" / name, self.source / "gateway" / name)
        subprocess.run(["git", "-C", str(self.source), "add", "."], check=True)
        subprocess.run(["git", "-C", str(self.source), "-c", "user.name=Fixture", "-c",
                        "user.email=fixture@example.invalid", "commit", "-qm",
                        "Reviewed gateway locks\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>"], check=True)
        self.env["TEST_REAL_GATEWAY_PACKAGES"] = str(packages)
        before, original = self.snapshot(), self.settings.read_bytes()
        tx = self.prepare_overlay()
        self.assertEqual(self.command("activate", tx).returncode, 0)
        self.assertEqual(self.command("commit", tx).returncode, 0)
        provenance = json.loads((tx / "provenance.json").read_text())
        import hashlib
        tests = []
        for module in ("search", "evidence-metadata"):
            installed = self.root / "runtime/gateway" / (module + ".mjs")
            self.assertEqual(hashlib.sha256(installed.read_bytes()).hexdigest(),
                             provenance["inventory"]["runtime/gateway/" + module + ".mjs"]["sha256"])
            test = self.base / (module + ".test.mjs")
            test.write_text((SOURCE / "gateway" / (module + ".test.mjs")).read_text()
                            .replace("'./" + module + ".mjs'", "'" + installed.as_uri() + "'"))
            tests.append(str(test))
        result = subprocess.run([str(node), "--test", "--test-concurrency=1", *tests],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("fallback diagnostics do not inherit failures", result.stdout)
        self.assertIn("page evidence keeps publisher time separate", result.stdout)
        self.assertEqual(self.command("restore", tx).returncode, 0)
        self.assertEqual(self.settings.read_bytes(), original)
        self.assertEqual(self.snapshot(), before)
        actions = self.effects.read_text().splitlines()
        allowed = {"searxng.service"} | {p.name for p in (SOURCE / "systemd").glob("web-access-*.*")}
        for action in actions:
            if action.startswith("service "):
                for unit in action.split()[2:]:
                    if not unit.startswith("--"):
                        self.assertIn(unit, allowed, "all service actions are scoped to WAG/SearXNG stubs")

    def test_standalone_shell_uses_exclusive_backups_and_restores_failed_apply(self):
        self.overlay_fixture()
        original = self.settings.read_bytes()
        backup_root = self.base / "backups"
        args = ["bash", str(SOURCE / "scripts/searxng-apply-overlay.sh"),
                str(SOURCE / "config/searxng/settings-overlay.yml"), "--settings", str(self.settings),
                "--backup-root", str(backup_root), "--stamp", "fixed"]
        result = subprocess.run(args, env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        effective = self.settings.read_bytes()
        effects = self.effects.read_bytes()
        result = subprocess.run(args, env=self.env, capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.settings.read_bytes(), effective)
        self.assertEqual(self.effects.read_bytes(), effects, "collision must never restore another backup")
        backup = backup_root / "overlay-fixed"
        self.assertEqual((backup / "settings.yml").read_bytes(), original)
        self.assertEqual(self.overlay_command("restore", backup).returncode, 0)
        args[-1] = "failure"
        result = subprocess.run(args, env={**self.env, "FAIL_OVERLAY": "1"},
                                capture_output=True, text=True, timeout=30)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.settings.read_bytes(), original)
        self.assertNotIn("dummy-sensitive-output", result.stdout + result.stderr)

    def test_overlay_digests_ignore_credentials_but_detect_relevant_configuration(self):
        self.overlay_fixture()
        first = self.prepare_overlay()
        provenance = json.loads((first / "provenance.json").read_text())["searxng"]
        self.assertEqual(self.command("abort", first).returncode, 0)
        self.settings.write_text(self.settings.read_text().replace("dummy-password", "different-dummy-password")
                                 .replace("dummy-settings-secret", "different-dummy-settings-secret")
                                 .replace("dummy-engine-secret", "different-dummy-engine-secret"))
        second = self.prepare_overlay()
        self.assertEqual(json.loads((second / "provenance.json").read_text())["searxng"], provenance)
        self.assertEqual(self.command("abort", second).returncode, 0)
        self.settings.write_text(self.settings.read_text().replace(":7999", ":7888"))
        third = self.prepare_overlay()
        changed = json.loads((third / "provenance.json").read_text())["searxng"]
        self.assertNotEqual(changed["effective_digest"], provenance["effective_digest"])
        self.assertNotEqual(changed["outgoing_digest"], provenance["outgoing_digest"])
        self.assertEqual(changed["engines_digest"], provenance["engines_digest"])
        self.assertEqual(self.command("abort", third).returncode, 0)

    def test_coordinated_crash_and_dependency_commit_failure_restore_overlay(self):
        self.previous_runtime()
        self.overlay_fixture()
        before, original = self.snapshot(), self.settings.read_bytes()
        tx = self.prepare_overlay()
        self.assertNotEqual(self.command("activate", tx, CRASH="1").returncode, 0)
        self.assertEqual(json.loads((tx / "state.json").read_text())["status"], "activating")
        self.assertNotEqual(self.settings.read_bytes(), original)
        self.assertEqual(self.command("abort", tx).returncode, 0)
        self.assertEqual(self.settings.read_bytes(), original)
        self.assertEqual(self.snapshot(), before)
        tx = self.prepare_overlay()
        self.assertEqual(self.command("activate", tx).returncode, 0)
        (tx / "candidate/runtime/gateway/node_modules/express/package.json").write_text('{"version":"0.0.0"}')
        self.assertNotEqual(self.command("commit", tx).returncode, 0)
        self.assertEqual(self.settings.read_bytes(), original)
        self.assertEqual(self.snapshot(), before)

    def test_per_engine_proxy_choices_are_preserved_in_effective_verification(self):
        import yaml
        self.overlay_fixture()
        value = yaml.safe_load(self.settings.read_text())
        value["engines"][0]["proxies"] = {"https://": ["socks5://dummy:dummy-password@127.0.0.1:9000"]}
        self.settings.write_text(yaml.safe_dump(value))
        tx = self.prepare_overlay()
        self.assertEqual(self.command("activate", tx).returncode, 0)
        engines = {e["name"]: e for e in yaml.safe_load(self.settings.read_text())["engines"]}
        self.assertEqual(engines["google"]["proxies"], value["engines"][0]["proxies"])
        engines["google"]["proxies"]["https://"] = ["socks5://127.0.0.1:9001"]
        changed = yaml.safe_load(self.settings.read_text())
        changed["engines"] = list(engines.values())
        self.settings.write_text(yaml.safe_dump(changed))
        self.assertNotEqual(self.command("commit", tx).returncode, 0)
        self.assertEqual(yaml.safe_load(self.settings.read_text()), value)

    def test_restore_missing_target_and_failed_snapshot_copy_are_retryable(self):
        self.previous_runtime()
        self.overlay_fixture()
        self.env["OVERLAY_INACTIVE"] = "1"
        before, original = self.snapshot(), self.settings.read_bytes()
        tx = self.prepare_overlay()
        self.assertEqual(self.command("activate", tx).returncode, 0)
        self.assertEqual(self.command("commit", tx).returncode, 0)
        snapshot = tx / "searxng/settings.yml"
        saved = self.base / "saved-snapshot.yml"
        snapshot.rename(saved)
        result = self.command("restore", tx)
        self.assertNotEqual(result.returncode, 0)
        state = json.loads((tx / "state.json").read_text())
        self.assertEqual(state["overlay_restore_errors"], ["snapshot_copy"])
        self.assertEqual(self.snapshot(), before)
        saved.rename(snapshot)
        self.settings.unlink()
        result = self.command("restore", tx)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.settings.read_bytes(), original)
        self.assertIn("service stop searxng.service", self.effects.read_text())
        self.assertEqual(json.loads((tx / "state.json").read_text())["status"], "restored")

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
