"""Offline seam acceptance; never requests a public engine."""
import copy
import importlib.util
import multiprocessing
import os
import threading
import subprocess
import json
import io
from contextlib import redirect_stdout
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]


def helper():
    spec = importlib.util.spec_from_file_location("route_probe", ROOT / "scripts/searxng-route-probe.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CandidateTests(unittest.TestCase):
    def test_candidate_only_changes_existing_enabled_domestic_engine(self):
        probe = helper()
        base = {"engines": [{"name": "quark", "disabled": False},
                            {"name": "chinaso news", "disabled": True},
                            {"name": "bing", "disabled": False}],
                "outgoing": {"request_timeout": 3, "max_request_timeout": 3}}
        original = copy.deepcopy(base)
        template = {"engines": [{"name": "quark", "proxies": {}},
                                {"name": "chinaso news", "proxies": {}}]}
        result = probe.generate_candidate(base, template)
        self.assertEqual(result["overlay"], {"engines": [{"name": "quark", "proxies": {}}]})
        self.assertEqual(result["changes"][1]["reason"], "disabled")
        self.assertEqual(base, original)
        absent = probe.generate_candidate({"engines": []}, template)
        self.assertEqual(absent["overlay"], {"engines": []})

    def test_explicit_proxy_choices_are_not_changed_or_misreported(self):
        probe = helper()
        template = {"engines": [{"name": n, "proxies": {}} for n in probe.DOMESTIC]}
        for field in ({"proxies": {"all://": "http://dummy-secret@localhost:9"}},
                      {"proxies": {}}, {"proxies": None},
                      {"network": {"proxies": {}}}, {"network": "operator-network"}):
            with self.subTest(field=field):
                result = probe.generate_candidate({"engines": [{"name": "quark", "disabled": False, **field}]}, template)
                self.assertEqual(result["overlay"], {"engines": []})
                self.assertEqual(result["changes"][0]["status"], "not_changed")
                self.assertNotIn("dummy-secret", str(result))

    def test_candidate_rejects_ambiguous_settings_and_input_drift(self):
        probe = helper()
        template = {"engines": [{"name": n, "proxies": {}} for n in probe.DOMESTIC]}
        for base in ({"engines": [{"name": "quark"}]},
                     {"use_default_settings": True, "engines": []},
                     {"engines": [{"name": "quark", "disabled": "false"}]},
                     {"engines": [{"name": "quark", "disabled": False}] * 2}):
            with self.assertRaises(probe.ProbeError):
                probe.generate_candidate(base, template)
        base = {"engines": [{"name": "quark", "disabled": False}], "outgoing": {"request_timeout": 3}}
        proposal = probe.generate_candidate(base, template)
        merged = probe.validate_candidate(base, proposal, template)
        self.assertEqual(merged["outgoing"], base["outgoing"])
        self.assertEqual(probe.generate_candidate(merged, template)["overlay"], {"engines": []})
        with self.assertRaises(probe.ProbeError):
            probe.validate_candidate({"engines": []}, proposal, template)

    def test_inactive_or_malformed_network_entries_never_become_candidate_routes(self):
        probe = helper()
        template = {"engines": [{"name": n, "proxies": {}} for n in probe.DOMESTIC]}
        result = probe.generate_candidate({"engines": [{"name": "chinaso news", "disabled": False, "inactive": True}]}, template)
        self.assertEqual(result["overlay"], {"engines": []})
        self.assertEqual(result["changes"][1]["reason"], "inactive")
        for field in ({"network": []}, {"network": 9}, {"proxies": "bad"}):
            with self.assertRaises(probe.ProbeError):
                probe.generate_candidate({"engines": [{"name": "quark", "disabled": False, **field}]}, template)

    def test_network_mapping_without_proxies_is_not_falsely_reported_direct(self):
        probe = helper()
        template = {"engines": [{"name": n, "proxies": {}} for n in probe.DOMESTIC]}
        settings = {"engines": [{"name": "quark", "disabled": False, "network": {"retries": 0}}]}
        result = probe.generate_candidate(settings, template)
        self.assertEqual(result["overlay"], {"engines": []})
        self.assertEqual(result["changes"][0]["reason"], "operator_choice")


class Clock:
    def __init__(self):
        self.wall, self.mono, self.boot = 100000.0, 100.0, "test-boot"

    def __call__(self):
        return {"wall": self.wall, "mono": self.mono, "boot": self.boot}

    def advance(self, seconds):
        self.wall += seconds
        self.mono += seconds


class LedgerTests(unittest.TestCase):
    def test_both_arms_and_failures_share_rolling_budget_after_reopen(self):
        probe = helper()
        clock = Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            calls = []
            for i in range(6):
                ledger = probe.ProbeLedger(root, clock)
                result = ledger.attempt("quark", True, lambda: calls.append(i) or {"status": "error"})
                self.assertTrue(result["reserved"])
            result = probe.ProbeLedger(root, clock).attempt("quark", True, lambda: calls.append(7))
            self.assertEqual(result["status"], "engine_rate")
            self.assertEqual(len(calls), 6)
            clock.advance(60)
            self.assertTrue(probe.ProbeLedger(root, clock).attempt("quark", True, lambda: {"status": "empty"})["reserved"])
            self.assertEqual(probe.ProbeLedger(root, clock).snapshot()["reservations"], 7)

    def test_domestic_total_counts_all_engine_ids_and_both_arms(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            ledger = probe.ProbeLedger(root, clock)
            for engine in range(5):
                for arm in range(6):
                    self.assertTrue(ledger.attempt(str(engine), True, lambda: {"status": "empty"})["reserved"])
            calls = []
            denied = ledger.attempt("sixth", True, lambda: calls.append(1))
            self.assertEqual(denied["status"], "domestic_rate")
            self.assertEqual(calls, [])
            self.assertTrue(ledger.attempt("bing", False, lambda: {"status": "empty"})["reserved"])
            clock.advance(60)
            self.assertTrue(ledger.attempt("sixth", True, lambda: {"status": "empty"})["reserved"])

    def test_captcha_stops_next_arm_and_persists_exponential_pause(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            calls = []
            def send():
                calls.append(1)
                return {"status": "captcha"}
            self.assertEqual(probe.ProbeLedger(root, clock).attempt("quark", True, send)["status"], "captcha")
            for advance in (0, 1799):
                clock.advance(advance)
                result = probe.ProbeLedger(root, clock).attempt("quark", True, send)
                self.assertEqual(result["status"], "cooldown")
                self.assertFalse(result["reserved"])
            self.assertEqual(len(calls), 1)
            clock.advance(1)
            self.assertEqual(probe.ProbeLedger(root, clock).attempt("quark", True, send)["status"], "captcha")
            clock.advance(1800)
            self.assertEqual(probe.ProbeLedger(root, clock).attempt("quark", True, send)["status"], "cooldown")
            clock.advance(1800)
            self.assertEqual(probe.ProbeLedger(root, clock).attempt("quark", True, send)["status"], "captcha")
            self.assertEqual(len(calls), 3)

    def test_cross_run_clock_anomaly_is_durable_and_never_recovers_automatically(self):
        probe = helper()
        for change in ("rollback", "forward", "mono", "reboot", "nan"):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as folder:
                clock = Clock()
                root = Path(folder) / "state"
                probe.ProbeLedger.initialize(root, clock)
                ledger = probe.ProbeLedger(root, clock)
                ledger.attempt("quark", True, lambda: {"status": "empty"})
                old = clock()
                if change == "rollback":
                    clock.wall -= 10
                elif change == "forward":
                    clock.wall += 100
                elif change == "mono":
                    clock.mono -= 1
                elif change == "reboot":
                    clock.boot = "new-boot"
                else:
                    clock.wall = float("nan")
                calls = []
                with self.assertRaises(probe.ProbeError) as error:
                    probe.ProbeLedger(root, clock).attempt("quark", True, lambda: calls.append(1))
                self.assertEqual(error.exception.code, "clock_error")
                clock.wall, clock.mono, clock.boot = old["wall"], old["mono"], old["boot"]
                clock.advance(7200)
                with self.assertRaises(probe.ProbeError):
                    probe.ProbeLedger(root, clock).attempt("quark", True, lambda: calls.append(1))
                self.assertEqual(calls, [])
                self.assertEqual(ledger.snapshot()["reservations"], 1)

    def test_crash_after_reservation_remains_charged_and_blocks_next_process(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            ctx = multiprocessing.get_context("fork")
            child = ctx.Process(target=lambda: probe.ProbeLedger(root, clock).attempt("quark", True, lambda: os._exit(23)))
            child.start()
            child.join(5)
            self.assertEqual(child.exitcode, 23)
            ledger = probe.ProbeLedger(root, clock)
            self.assertEqual(ledger.snapshot()["reservations"], 1)
            calls = []
            with self.assertRaises(probe.ProbeError) as error:
                ledger.attempt("quark", True, lambda: calls.append(1))
            self.assertEqual(error.exception.code, "unfinished_attempt")
            self.assertEqual(calls, [])
            self.assertEqual(ledger.snapshot()["unknown_attempts"], 1)

    def test_uncertain_transport_termination_keeps_reservation_unfinished(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            ledger = probe.ProbeLedger(root, clock)
            def uncertain_send():
                error = probe.ProbeError("unfinished_attempt")
                error.attempted = True
                raise error
            with self.assertRaises(probe.ProbeError) as error:
                ledger.attempt("quark", True, uncertain_send)
            self.assertEqual(error.exception.code, "unfinished_attempt")
            self.assertTrue(error.exception.reserved)
            self.assertTrue(error.exception.attempted)
            reopened = probe.ProbeLedger(root, clock)
            self.assertEqual(reopened.snapshot(), {"reservations": 1, "unknown_attempts": 1})
            with self.assertRaises(probe.ProbeError):
                reopened.attempt("bing", False, lambda: self.fail("uncertain child must block all engines"))

    def test_missing_state_cannot_be_reinitialized_and_symlinks_refuse(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            link = Path(folder) / "alias"
            link.symlink_to(root, target_is_directory=True)
            with self.assertRaises(probe.ProbeError):
                probe.ProbeLedger(link, clock).attempt("quark", True, lambda: {"status": "ok"})
            for file in root.iterdir():
                file.unlink()
            root.rmdir()
            with self.assertRaises(probe.ProbeError):
                probe.ProbeLedger.initialize(root, clock)
            with self.assertRaises(probe.ProbeError):
                probe.ProbeLedger(root, clock).attempt("quark", True, lambda: {"status": "ok"})

    def test_ledger_sanitizes_callback_results_and_records_interrupt_without_refund(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            ledger = probe.ProbeLedger(root, clock)
            result = ledger.attempt("quark", True, lambda: {"status": "ok", "raw": "SECRET", "result_count": 1})
            self.assertNotIn("SECRET", str(result))
            def interrupt():
                raise KeyboardInterrupt()
            result = ledger.attempt("quark", True, interrupt)
            self.assertEqual(result["status"], "interrupted")
            self.assertTrue(result["attempted"])
            self.assertEqual(ledger.snapshot()["reservations"], 2)
            self.assertEqual(ledger.snapshot()["unknown_attempts"], 0)

    def test_pre_send_clock_interrupt_is_a_sanitized_unreserved_refusal(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            def interrupted_clock():
                raise KeyboardInterrupt()
            with self.assertRaises(probe.ProbeError) as error:
                probe.ProbeLedger(root, interrupted_clock).attempt("quark", True, lambda: self.fail("send after interrupt"))
            self.assertEqual(error.exception.code, "interrupted")
            self.assertFalse(error.exception.reserved)
            self.assertFalse(error.exception.attempted)
            self.assertEqual(probe.ProbeLedger(root, clock).snapshot()["reservations"], 0)

    def test_domestic_identity_cannot_be_misclassified_to_escape_total(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            with self.assertRaises(probe.ProbeError):
                probe.ProbeLedger(root, clock).attempt("quark", False, lambda: {"status": "empty"})
            self.assertEqual(probe.ProbeLedger(root, clock).snapshot()["reservations"], 0)

    def test_cross_process_lock_spans_send_and_captcha_persistence(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            ctx = multiprocessing.get_context("fork")
            entered, release = ctx.Event(), ctx.Event()
            def send():
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("test timeout")
                return {"status": "captcha"}
            child = ctx.Process(target=lambda: probe.ProbeLedger(root, clock).attempt("quark", True, send))
            child.start()
            try:
                self.assertTrue(entered.wait(5))
                with self.assertRaises(probe.ProbeError):
                    probe.ProbeLedger(root, clock).attempt("quark", True, lambda: self.fail("concurrent send"))
            finally:
                release.set()
                child.join(5)
            self.assertEqual(child.exitcode, 0)
            ledger = probe.ProbeLedger(root, clock)
            self.assertEqual(ledger.attempt("quark", True, lambda: self.fail("post-CAPTCHA send"))["status"], "cooldown")
            self.assertEqual(ledger.snapshot()["reservations"], 1)

    def test_connection_delay_cannot_expire_a_recent_actual_send_early(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            ledger = probe.ProbeLedger(root, clock)
            def send():
                clock.advance(2)
                return {"status": "empty"}
            for i in range(6):
                ledger.attempt("quark", True, send)
            clock.advance(49)
            self.assertEqual(ledger.attempt("quark", True, lambda: {"status": "empty"})["status"], "engine_rate")


class RuntimeTests(unittest.TestCase):
    def test_missing_or_unverified_runtime_refuses_without_bootstrap(self):
        probe = helper()
        before = {k: v for k, v in sys.modules.items() if k == "searx" or k.startswith("searx.")}
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(probe.ProbeError):
                probe.load_engine(folder, probe.REVISION, {"name": "quark", "engine": "quark", "disabled": False, "categories": ["general"]})
            self.assertEqual({k: v for k, v in sys.modules.items() if k == "searx" or k.startswith("searx.")}, before)

    def test_unsupported_backend_override_is_not_silently_replaced(self):
        probe = helper()
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(probe.ProbeError) as error:
                probe.load_engine(folder, probe.REVISION, {"name": "quark", "engine": "quark", "disabled": False,
                                                         "categories": ["general"], "quark_category": "images"})
            self.assertEqual(error.exception.code, "engine_configuration_unsupported")

    @unittest.skipUnless(os.environ.get("WAG_ROUTE_SOURCE"), "separate provisioned actual-parser gate")
    def test_actual_quark_parser_and_real_utilities_on_synthetic_fixture(self):
        probe = helper()
        runtime = probe.load_engine(os.environ["WAG_ROUTE_SOURCE"], probe.REVISION,
                                    {"name": "quark", "engine": "quark", "disabled": False, "categories": ["general"]})
        params = runtime.build("day")
        self.assertIn("tl_request=4", params["url"])
        self.assertEqual(params["language"], "zh-CN")
        text = '<script type="application/json" id="s-data-1" data-used-by="hydrate">{"data":{"initialData":{"title":{"content":"<b>中国</b>"},"source":{"url":"https://example.invalid/"},"summary":{"content":"政策"}}},"extraData":{"sc":"addition"}}</script>'
        response = probe.FixtureResponse(text.encode())
        self.assertEqual(runtime.parse(response), {"status": "ok", "result_count": 1})
        self.assertEqual(runtime.parse(probe.FixtureResponse(b'{"action":"captcha","url":"https://example.invalid/"}'))["status"], "captcha")
        for name in ("searx", "searx.utils", "searx.exceptions"):
            self.assertTrue(Path(sys.modules[name].__file__).is_relative_to(Path(os.environ["WAG_ROUTE_SOURCE"])))
        self.assertEqual(runtime.provenance["revision"], probe.REVISION)
        self.assertEqual(runtime.provenance["verified_files"], 364)

    @unittest.skipUnless(os.environ.get("WAG_ROUTE_SOURCE"), "separate provisioned actual-parser gate")
    def test_actual_chinaso_bing_yandex_requests_and_results_are_isolated(self):
        probe = helper()
        fixtures = {
            "chinaso news": ('{"data":{"data":[{"title":"<b>中国</b>","url":"https://example.invalid/","snippet":"新闻"}]}}', "news-day"),
            "bing": ('<html><ol id="b_results"><li class="b_algo"><h2><a href="https://example.invalid/">中国</a></h2><p>政策</p></li></ol></html>', "general"),
            "yandex": ('<html><li class="serp-item"><h3 class="b-serp-item__title"><a class="b-serp-item__title-link" href="https://example.invalid/"><span>中国</span></a></h3><div class="b-serp-item__content"><div class="b-serp-item__text">政策</div></div></li></html>', "general")}
        for name, (text, case) in fixtures.items():
            with self.subTest(name=name):
                entry = {"name": name, "engine": probe.ENGINE_MODULES[name], "disabled": False,
                         "categories": ["news" if name == "chinaso news" else "general"]}
                runtime = probe.load_engine(os.environ["WAG_ROUTE_SOURCE"], probe.REVISION, entry)
                request = runtime.build(case)
                self.assertTrue(request["url"].startswith("https://"))
                self.assertEqual(runtime.parse(probe.FixtureResponse(text.encode())), {"status": "ok", "result_count": 1})
                with self.assertRaises(probe.ProbeError) as error:
                    runtime.build("general" if name == "chinaso news" else "day")
                self.assertEqual(error.exception.code, "unsupported_category" if name == "chinaso news" else "unsupported_time_range")
                if name == "chinaso news":
                    self.assertIn("stime=24h", request["url"])
                    self.assertIn("uid", request["cookies"])
                    self.assertEqual(runtime.parse(probe.FixtureResponse(b'{"data":{}}'))["status"], "empty")
                if name == "yandex":
                    self.assertEqual(runtime.parse(probe.FixtureResponse(b"<html/>", {"x-yandex-captcha": "captcha"}))["status"], "captcha")
                entry["disabled"] = True
                disabled = probe.EngineRuntime(runtime.module, entry, runtime.provenance)
                with self.assertRaises(probe.ProbeError) as error:
                    disabled.build(case)
                self.assertEqual(error.exception.code, "disabled")


class ProbeTests(unittest.TestCase):
    def test_pair_builds_once_copies_cookies_and_reports_disabled_and_captcha_skips(self):
        probe, clock = helper(), Clock()
        class Runtime:
            builds = 0
            def build(self, case):
                self.builds += 1
                return {"url": "https://example.invalid/", "cookies": {"uid": "random-cookie"}, "case": case}
        class Transport:
            mode = "offline_mock"
            requests = []
            def send(self, request, runtime, arm):
                self.requests.append((arm, copy.deepcopy(request)))
                request["cookies"]["uid"] = "mutated"
                return {"status": "captcha" if len(self.requests) == 2 else "ok", "result_count": 1, "raw": "SECRET"}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            runtime, transport = Runtime(), Transport()
            plan = [{"engine": "quark", "case": "general", "sample": 1},
                    {"engine": "quark", "case": "general", "sample": 2},
                    {"engine": "bing", "case": "day", "sample": 1}]
            report = probe.run_probe(plan, {"quark": runtime}, probe.ProbeLedger(root, clock), transport)
            self.assertEqual(report["counts"], {"planned": 6, "reserved": 2, "actual_attempted": 2, "skipped": 4})
            self.assertEqual(runtime.builds, 1)
            self.assertEqual(transport.requests[0][1], transport.requests[1][1])
            self.assertEqual(report["mode"], "offline_mock")
            self.assertNotIn("SECRET", str(report))
            self.assertNotIn("random-cookie", str(report))
            self.assertEqual([r["status"] for r in report["samples"]], ["ok", "captcha", "cooldown", "cooldown", "disabled", "disabled"])

    def test_post_send_clock_error_preserves_partial_reservation_and_attempt_counts(self):
        probe, clock = helper(), Clock()
        class Runtime:
            def build(self, case):
                return {"cookies": {}}
        class Transport:
            mode = "offline_mock"
            def send(self, request, runtime, arm):
                clock.wall += 100
                return {"status": "ok", "attempted": True}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            report = probe.run_probe([{"engine": "quark", "case": "general", "sample": 1}],
                                     {"quark": Runtime()}, probe.ProbeLedger(root, clock), Transport())
            self.assertEqual(report["counts"], {"planned": 2, "reserved": 1, "actual_attempted": 1, "skipped": 1})
            self.assertEqual([r["status"] for r in report["samples"]], ["clock_error", "aborted"])
            self.assertTrue(report["partial"])

    def test_live_mode_cannot_use_mock_runtime_transport_or_replace_canonical_ledger(self):
        probe, clock = helper(), Clock()
        class Runtime:
            def build(self, case):
                self.fail("must not build")
        class Transport:
            mode = "live"
            def send(self, *args):
                raise AssertionError("must not send")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            with self.assertRaises(probe.ProbeError) as error:
                probe.run_probe([{"engine": "quark", "case": "general", "sample": 1}],
                                {"quark": Runtime()}, probe.ProbeLedger(root, clock), Transport())
            self.assertEqual(error.exception.code, "live_identity_refused")
            self.assertEqual(probe.ProbeLedger(root, clock).snapshot()["reservations"], 0)

    def test_interrupt_during_post_send_checkpoint_keeps_known_attempts_in_report(self):
        probe = helper()
        class InterruptClock(Clock):
            calls = 0
            def __call__(self):
                self.calls += 1
                if self.calls == 3:
                    raise KeyboardInterrupt()
                return super().__call__()
        class Runtime:
            def build(self, case):
                return {}
        class Transport:
            mode = "offline_mock"
            def send(self, request, runtime, arm):
                return {"status": "empty"}
        clock = InterruptClock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            report = probe.run_probe([{"engine": "quark", "case": "general", "sample": 1}],
                                     {"quark": Runtime()}, probe.ProbeLedger(root, clock), Transport())
            self.assertEqual(report["counts"], {"planned": 2, "reserved": 1, "actual_attempted": 1, "skipped": 1})
            self.assertEqual(report["samples"][0]["status"], "interrupted")


class TransportTests(unittest.TestCase):
    def test_local_transport_sends_once_refuses_redirect_and_classifies_challenge(self):
        probe = helper()
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                received.append(self.path)
                if self.path == "/redirect":
                    self.send_response(302)
                    self.send_header("Location", "/result")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b"captcha challenge" if self.path == "/captcha" else b"synthetic result")
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        class Runtime:
            def parse(self, response):
                return {"status": "ok", "result_count": 1}
        try:
            transport = probe.OneSendTransport({"http://": "http://127.0.0.1:9"}, local_only=True)
            base = {"method": "GET", "headers": {}, "cookies": {}, "data": None}
            for path, expected in (("/result", "ok"), ("/redirect", "redirect_refused"), ("/captcha", "captcha")):
                request = {**base, "url": f"http://127.0.0.1:{server.server_port}{path}"}
                result = transport.send(request, Runtime(), "direct")
                self.assertEqual(result["status"], expected)
                self.assertTrue(result["attempted"])
                self.assertLessEqual(result["elapsed"], 3)
            self.assertEqual(received, ["/result", "/redirect", "/captcha"])
            proxy_result = transport.send({**base, "url": f"http://127.0.0.1:{server.server_port}/result"}, Runtime(), "proxy")
            self.assertEqual(proxy_result["status"], "error")
            self.assertEqual(len(received), 3)
            self.assertEqual(transport.mode, "offline_mock")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_total_deadline_byte_limit_and_parser_helper_network_refusal(self):
        probe = helper()
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                requests.append(self.path)
                self.send_response(200)
                self.end_headers()
                try:
                    if self.path == "/large":
                        self.wfile.write(b"x" * 262145)
                    elif self.path == "/slow":
                        for i in range(8):
                            self.wfile.write(b"x")
                            self.wfile.flush()
                            time.sleep(0.6)
                    else:
                        self.wfile.write(b"fixture")
                except (BrokenPipeError, ConnectionResetError):
                    pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        class Runtime:
            def parse(self, response):
                import socket
                socket.create_connection(("127.0.0.1", server.server_port))
                return {"status": "ok"}
        try:
            transport = probe.OneSendTransport({"all://": "http://127.0.0.1:9"}, local_only=True)
            for path, expected in (("/slow", "timeout"), ("/large", "response_limit"), ("/helper", "request_refused")):
                request = {"url": f"http://127.0.0.1:{server.server_port}{path}", "method": "GET"}
                start = time.monotonic()
                self.assertEqual(transport.send(request, Runtime(), "direct")["status"], expected)
                self.assertLess(time.monotonic() - start, 3.3)
            self.assertEqual(requests, ["/slow", "/large", "/helper"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_failed_connection_is_reserved_but_not_actual_http_attempt(self):
        probe, clock = helper(), Clock()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "state"
            probe.ProbeLedger.initialize(root, clock)
            transport = probe.OneSendTransport({"all://": "http://127.0.0.1:9"}, local_only=True)
            result = probe.ProbeLedger(root, clock).attempt("quark", True, lambda: transport.send(
                {"url": "http://127.0.0.1:9/", "method": "GET"}, None, "direct"))
            self.assertTrue(result["reserved"])
            self.assertFalse(result["http_attempted"])
            self.assertTrue(result["attempted"])
            self.assertEqual(probe.ProbeLedger(root, clock).snapshot()["reservations"], 1)

    def test_parser_cannot_swallow_total_deadline_and_return_success(self):
        probe = helper()
        class Runtime:
            def parse(self, response):
                try:
                    time.sleep(5)
                except TimeoutError:
                    time.sleep(1)
                return {"status": "ok", "result_count": 1}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"synthetic")
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            transport = probe.OneSendTransport({"all://": "http://127.0.0.1:9"}, local_only=True)
            start = time.monotonic()
            result = transport.send({"url": f"http://127.0.0.1:{server.server_port}/", "method": "GET"}, Runtime(), "direct")
            self.assertEqual(result["status"], "timeout")
            self.assertLess(time.monotonic() - start, 3.3)
            self.assertTrue(result["attempted"])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(2)

    def test_request_preparation_time_is_not_added_on_top_of_three_second_budget(self):
        probe = helper()
        transport = probe.OneSendTransport({"all://": "http://127.0.0.1:9"}, local_only=True)
        result = transport.send({"url": "http://127.0.0.1:9/", "method": "GET", "_wag_build_elapsed": 3}, None, "direct")
        self.assertEqual(result["status"], "timeout")
        self.assertFalse(result["attempted"])

    def test_measured_deadline_overrun_is_retained_without_clamping(self):
        probe = helper()
        result = probe.safe_result({"status": "timeout", "elapsed": 3.2, "attempted": True})
        self.assertEqual(result.get("elapsed"), 3.2)
        self.assertTrue(result["deadline_exceeded"])
        self.assertEqual(result["status"], "timeout")
        self.assertTrue(result["attempted"])

    def test_failed_connect_still_counts_a_known_network_attempt(self):
        probe = helper()
        transport = probe.OneSendTransport({"all://": "http://127.0.0.1:9"}, local_only=True)
        result = transport.send({"url": "http://127.0.0.1:9/", "method": "GET"}, None, "direct")
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["attempted"])


class CliTests(unittest.TestCase):
    def test_cli_generates_only_new_isolated_candidate_and_rejects_ledger_override(self):
        script = ROOT / "scripts/searxng-route-probe.py"
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            settings = root / "isolated.yml"
            settings.write_text("engines:\n  - name: quark\n    disabled: false\n")
            output = root / "candidate.json"
            args = [sys.executable, str(script), "candidate", "--isolated-dir", folder,
                    "--settings", str(settings), "--output", str(output)]
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(output.read_text())["overlay"], {"engines": [{"name": "quark", "proxies": {}}]})
            original = output.read_bytes()
            result = subprocess.run(args, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(output.read_bytes(), original)
            result = subprocess.run([sys.executable, str(script), "probe", "--ledger", "SECRET"], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("SECRET", result.stdout + result.stderr)
            self.assertEqual(json.loads(result.stdout)["status"], "arguments_invalid")

    def test_runtime_or_storage_preflight_error_report_preserves_the_entire_plan(self):
        probe = helper()
        plan = [{"engine": "quark", "case": "general", "sample": 1},
                {"engine": "bing", "case": "general", "sample": 1}]
        report = probe.partial_report(plan, "runtime_unavailable")
        self.assertEqual(report["counts"], {"planned": 4, "reserved": 0, "actual_attempted": 0, "skipped": 4})
        self.assertTrue(report["partial"])
        self.assertTrue(all(r["status"] == "runtime_unavailable" for r in report["samples"]))

    def test_report_output_collision_keeps_actual_counts_and_existing_file(self):
        probe = helper()
        report = {"mode": "offline_mock", "partial": False, "counts": {"planned": 2, "reserved": 2, "actual_attempted": 2, "skipped": 0}}
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "report.json"
            target.write_text("existing")
            captured = io.StringIO()
            with redirect_stdout(captured):
                self.assertEqual(probe.emit_report(report, target), 2)
            recovered = json.loads(captured.getvalue())
            self.assertEqual(recovered["counts"]["actual_attempted"], 2)
            self.assertTrue(recovered["partial"])
            self.assertEqual(target.read_text(), "existing")


if __name__ == "__main__":
    unittest.main()
