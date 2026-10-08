"""Offline acceptance for the reviewed SearXNG engine set and timeout budget.

Two layers:

* ``OverlayReviewTests`` merges the reviewed overlay into a disposable fixture
  copy of a settings.yml and checks the resulting engine pool, the shared query
  budget and the sanitized provenance projection.  It needs no host access and
  runs everywhere.
* ``OverlayCliTests`` drives the real ``searxng-apply-overlay.sh`` wrapper twice
  over a disposable settings file with stubbed ``systemctl``/``ss``/``curl`` to
  prove the apply step is idempotent.  It skips itself unless the stub directory
  actually shadows those commands, so it can never touch a real service.

Every number asserted here was measured against the live instance and is
recorded in docs/searxng-engine-pool-timeouts-20261008.md.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

import yaml

SOURCE = Path(__file__).resolve().parents[1]
HELPER = SOURCE / "scripts" / "searxng-overlay.py"
WRAPPER = SOURCE / "scripts" / "searxng-apply-overlay.sh"
OVERLAY = SOURCE / "config" / "searxng" / "settings-overlay.yml"

# Engines the reviewed overlay turns on for a default (general) or news query.
ENABLED = {"yandex", "quark", "bing", "chinaso news"}
# Engines the reviewed overlay keeps off, with the measured failure mode that
# justifies it.  google news is listed on purpose: it is not a workaround for
# google in this SearXNG release, it answers 403 from the same retired endpoint.
DISABLED = {
    "google", "google news", "brave", "mojeek", "duckduckgo", "qwant",
    "baidu", "sogou", "360search", "startpage", "crowdview", "mwmbl",
    "naver", "privacywall",
}
BUDGET = 3.0

# A fixture shaped like the live file: unrelated sections, a secret_key, an
# operator backend engine with an api key and an operator proxy map that the
# overlay must never overwrite.
BASE = """\
use_default_settings: true
general:
  instance_name: fixture
server:
  secret_key: dummy-settings-secret
search:
  default_lang: zh-CN
outgoing:
  proxies:
    all://: [http://dummy-user:dummy-password@127.0.0.1:7999]
  unrelated: keep
  request_timeout: 8.0
engines:
  - name: google
    engine: operator-google-backend
    disabled: true
    api_key: dummy-engine-secret
  - name: operator-engine
    engine: custom
    disabled: false
  - name: yandex
    disabled: false
    timeout: 8.0
"""


def load_helper():
    spec = importlib.util.spec_from_file_location("wag_searxng_overlay", HELPER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(HELPER.parent))
    try:
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(HELPER.parent))
    return module


class OverlayReviewTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()
        self.base = yaml.safe_load(BASE)
        self.overlay = yaml.safe_load(OVERLAY.read_text(encoding="utf-8"))
        self.merged = self.helper.merge(self.base, self.overlay)
        self.names = sorted(e["name"] for e in self.overlay["engines"])

    def engines(self, settings):
        return {e["name"]: e for e in settings["engines"]}

    def test_every_declared_engine_is_a_named_mapping(self):
        declared = [e["name"] for e in self.overlay["engines"]]
        self.assertEqual(len(declared), len(set(declared)), "engine names must be unique")
        self.assertTrue(ENABLED | DISABLED <= set(declared), "reviewed pool must be declared in the overlay")
        for engine in self.overlay["engines"]:
            self.assertIsInstance(engine.get("disabled"), bool, engine["name"])

    def test_reviewed_enabled_and_disabled_pool_is_exactly_what_was_measured(self):
        merged = self.engines(self.merged)
        enabled = {name for name in self.names if not merged[name]["disabled"]}
        disabled = {name for name in self.names if merged[name]["disabled"]}
        self.assertEqual(enabled, ENABLED)
        self.assertEqual(disabled, DISABLED)
        # Explicit regression guard: switching google to google news would only
        # trade one 403 engine for another in this SearXNG release.
        self.assertTrue(merged["google news"]["disabled"])

    def test_overlay_re_disables_a_stale_local_setting(self):
        stale = self.helper.merge({"engines": []}, yaml.safe_load(BASE))
        for engine in stale["engines"]:
            if engine["name"] in DISABLED:
                engine["disabled"] = False
        merged = self.engines(self.helper.merge(stale, self.overlay))
        for name in DISABLED:
            self.assertTrue(merged[name]["disabled"], name)

    def test_shared_query_budget_is_pinned_to_three_seconds(self):
        outgoing = self.merged["outgoing"]
        self.assertEqual(outgoing["request_timeout"], BUDGET)
        self.assertEqual(outgoing["max_request_timeout"], BUDGET)
        self.assertLessEqual(outgoing["request_timeout"], outgoing["max_request_timeout"])
        # A budget above the ceiling would be silently clamped; a budget below it
        # would let one engine's `timeout:` raise the whole query again.
        self.assertEqual(outgoing["retries"], 1)
        self.assertIs(outgoing["retry_on_http_error"], False)

    def test_enabled_engine_timeouts_cannot_raise_the_budget(self):
        merged = self.engines(self.merged)
        for name in ENABLED:
            self.assertEqual(merged[name].get("timeout"), BUDGET, name)

    def test_operator_proxy_map_and_unrelated_settings_survive_the_merge(self):
        self.assertEqual(self.merged["outgoing"]["proxies"], self.base["outgoing"]["proxies"])
        self.assertEqual(self.merged["outgoing"]["unrelated"], "keep")
        self.assertEqual(self.merged["search"]["default_lang"], "zh-CN")
        self.assertEqual(self.engines(self.merged)["google"]["engine"], "operator-google-backend")

    def test_projection_covers_the_reviewed_fields_and_hides_secrets(self):
        projection = self.helper.effective(self.merged, self.names)
        self.assertEqual(projection["outgoing"]["request_timeout"], BUDGET)
        self.assertEqual(projection["outgoing"]["max_request_timeout"], BUDGET)
        engines = {e["name"]: e for e in projection["engines"]}
        self.assertEqual(set(engines), set(self.names))
        for name in ENABLED:
            self.assertEqual(engines[name]["disabled"], False, name)
            self.assertEqual(engines[name]["timeout"], BUDGET, name)
            self.assertTrue(engines[name]["categories"], name)
        self.assertEqual(engines["quark"]["categories"], ["general", "news"])
        self.assertEqual(engines["chinaso news"]["categories"], ["news"])
        blob = json.dumps(projection, sort_keys=True)
        for secret in ("dummy-settings-secret", "dummy-engine-secret", "dummy-user", "dummy-password"):
            self.assertNotIn(secret, blob)

    def test_projection_digest_tracks_every_reviewed_field(self):
        baseline = self.helper.provenance(self.helper.effective(self.merged, self.names))
        mutations = {
            "budget": lambda s: s["outgoing"].__setitem__("request_timeout", 8.0),
            "ceiling": lambda s: s["outgoing"].__setitem__("max_request_timeout", 8.0),
            "engine state": lambda s: self.engines(s)["quark"].__setitem__("disabled", True),
            "engine timeout": lambda s: self.engines(s)["bing"].__setitem__("timeout", 5.0),
            "engine categories": lambda s: self.engines(s)["chinaso news"].__setitem__("categories", ["general"]),
        }
        for label, mutate in mutations.items():
            with self.subTest(label):
                drifted = yaml.safe_load(yaml.safe_dump(self.merged, sort_keys=False))
                mutate(drifted)
                self.assertNotEqual(self.helper.provenance(self.helper.effective(drifted, self.names)), baseline)

    def test_invalid_engine_timeout_is_rejected(self):
        for value in ("3.0", True, 0, -1.0, None):
            with self.subTest(value):
                drifted = yaml.safe_load(yaml.safe_dump(self.merged, sort_keys=False))
                self.engines(drifted)["yandex"]["timeout"] = value
                with self.assertRaises(self.helper.ReleaseError):
                    self.helper.effective(drifted, self.names)

    def test_merge_is_idempotent_and_byte_stable(self):
        once = self.helper.merge(self.base, self.overlay)
        twice = self.helper.merge(once, self.overlay)
        self.assertEqual(once, twice, "re-applying the reviewed overlay must be a no-op")
        again = self.helper.merge(self.base, self.overlay)
        dump = lambda value: yaml.safe_dump(value, sort_keys=False, allow_unicode=True)
        self.assertEqual(dump(once), dump(twice))
        self.assertEqual(dump(once), dump(again))
        self.assertEqual(once, self.merged)

    def test_readiness_probe_only_needs_one_answered_engine(self):
        # healthy() only fails on an all-empty response or a cluster of timeouts;
        # the reviewed pool answers from yandex/quark/chinaso news, so the apply
        # gate stays meaningful instead of failing on the disabled engines.
        body = {"results": [{"url": "https://example.com/", "title": "fixture"}],
                "unresponsive_engines": [["bing", "timeout"]]}
        self.assertTrue(body["results"])
        self.assertLess(sum("timeout" in str(e) for e in body["unresponsive_engines"]), 3)


class OverlayCliTests(unittest.TestCase):
    """Apply the reviewed overlay twice over a disposable file, with stubs only."""

    def setUp(self):
        if not sys.platform.startswith("linux"):
            self.skipTest("the overlay CLI relies on Linux chown/fsync semantics")
        if not shutil.which("bash") or not os.path.exists("/usr/bin/env"):
            self.skipTest("bash is required to drive the overlay wrapper")
        self.temp = tempfile.TemporaryDirectory(prefix="wag-overlay-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        if root.resolve() != root:
            self.skipTest("overlay roots must be canonical directories")
        self.bin = root / "bin"
        self.bin.mkdir()
        self.effects = root / "effects"
        self.effects.touch()
        self.stub("systemctl", 'printf "systemctl %s\\n" "$*" >> "$WAG_TEST_EFFECTS"\n'
                               'if [[ "$1" == "is-active" ]]; then printf "active\\n"; fi\nexit 0\n')
        self.stub("ss", "printf 'LISTEN 0 128 127.0.0.1:8801 0.0.0.0:*\\n'\n")
        self.stub("curl", 'out=""\nwhile (($#)); do case "$1" in --output) out="$2"; shift 2;; *) shift;; esac; done\n'
                          'printf \'%s\\n\' \'{"results":[{"url":"https://example.com/","title":"fixture"}],'
                          '"unresponsive_engines":[]}\' > "$out"\nexit 0\n')
        self.env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", ""),
                    "WAG_TEST_EFFECTS": str(self.effects), "WAG_OVERLAY_ATTEMPTS": "1", "WAG_OVERLAY_DELAY": "0"}
        self.settings = root / "settings.yml"
        self.settings.write_text(BASE, encoding="utf-8")
        self.settings.chmod(0o640)

    def stub(self, name, body):
        file = self.bin / name
        file.write_text("#!/usr/bin/env bash\n" + body, encoding="utf-8")
        file.chmod(0o755)

    def apply(self, stamp):
        command = [str(WRAPPER), "--settings", str(self.settings),
                   "--backup-root", str(Path(self.temp.name) / ("backups-" + stamp)), "--stamp", stamp]
        result = subprocess.run(["bash", *command], capture_output=True, text=True, env=self.env, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def test_apply_is_idempotent_over_a_disposable_settings_file(self):
        # The stubs must really shadow the host commands before anything runs.
        for name in ("systemctl", "ss", "curl"):
            with self.subTest(name):
                resolved = shutil.which(name, path=self.env["PATH"])
                self.assertEqual(Path(resolved).resolve() if resolved else None, (self.bin / name).resolve())
        self.apply("t1")
        first = self.settings.read_bytes()
        merged = yaml.safe_load(first.decode("utf-8"))
        engines = {e["name"]: e for e in merged["engines"]}
        self.assertEqual(merged["outgoing"]["request_timeout"], BUDGET)
        self.assertEqual(merged["outgoing"]["max_request_timeout"], BUDGET)
        self.assertEqual(engines["quark"]["disabled"], False)
        self.assertTrue(engines["brave"]["disabled"])
        # A secret-bearing key of an operator engine entry is left untouched.
        self.assertEqual(engines["google"]["api_key"], "dummy-engine-secret")
        self.assertIn("systemctl restart searxng.service", self.effects.read_text())
        self.apply("t2")
        self.assertEqual(self.settings.read_bytes(), first, "a repeated apply must produce identical settings")


if __name__ == "__main__":
    unittest.main()
