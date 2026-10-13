#!/usr/bin/env python3
"""Guarded candidate generation and isolated single-parser route comparison.

Never operates a service or production settings. Live CLI uses one fixed ledger;
source provisioning is separate from execution. Reports contain bounded enums,
not upstream bodies, proxy endpoints or exception messages.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid
import tempfile
import logging
import signal
import threading
import http.client
import multiprocessing
import ssl
from urllib.parse import urlsplit
from contextlib import contextmanager, redirect_stdout, redirect_stderr

sys.dont_write_bytecode = True
DOMESTIC = ("quark", "chinaso news")
REVISION = "9fea41204fdfa7a5cfa15b0ebd12904c520478ce"
SOURCE_DIGEST = "883ada98b2f81e6734c900510c6b375e958d81a9775e821fc1cad564f30e5863"
ENGINE_MODULES = {"quark": "quark", "chinaso news": "chinaso", "bing": "bing", "yandex": "yandex"}
CASES = {"general": ("中国 经济 政策", "general", None),
         "news": ("中国 科技 新闻", "news", None),
         "day": ("中国 经济 政策", "general", "day"),
         "news-day": ("中国 科技 新闻", "news", "day")}
_RESTRICT_NETWORK = 0
CANONICAL_LEDGER = Path("/var/lib/wag-route-probe")
_ACTIVE_LEDGER = None


def _audit(event, args):
    if _RESTRICT_NETWORK and event in ("socket.connect", "socket.getaddrinfo", "socket.bind"):
        raise ProbeError("helper_network_refused")


sys.addaudithook(_audit)


@contextmanager
def no_network():
    global _RESTRICT_NETWORK
    _RESTRICT_NETWORK += 1
    try:
        yield
    finally:
        _RESTRICT_NETWORK -= 1


class ProbeError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def generate_candidate(settings, template):
    if template != {"engines": [{"name": n, "proxies": {}} for n in DOMESTIC]}:
        raise ProbeError("candidate_invalid")
    if not isinstance(settings, dict) or settings.get("use_default_settings"):
        raise ProbeError("settings_unresolved")
    entries = settings.get("engines", [])
    if (not isinstance(entries, list) or any(not isinstance(e, dict) or
            not isinstance(e.get("name"), str) for e in entries)):
        raise ProbeError("settings_invalid")
    engines = {e["name"]: e for e in entries}
    if len(engines) != len(entries):
        raise ProbeError("settings_invalid")
    for name in DOMESTIC:
        if name in engines:
            entry = engines[name]
            if type(entry.get("disabled")) is not bool or type(entry.get("inactive", False)) is not bool:
                raise ProbeError("settings_unresolved")
            if ("network" in entry and entry["network"] is not None and not isinstance(entry["network"], (str, dict))
                    or "proxies" in entry and entry["proxies"] is not None and not isinstance(entry["proxies"], dict)
                    or isinstance(entry.get("network"), dict) and "proxies" in entry["network"]
                    and entry["network"]["proxies"] is not None and not isinstance(entry["network"]["proxies"], dict)):
                raise ProbeError("settings_invalid")
    changes, overlay = [], []
    for name in DOMESTIC:
        engine = engines.get(name)
        reason = ("missing" if engine is None else "disabled" if engine.get("disabled")
                  else "inactive" if engine.get("inactive") else "filled")
        if engine is not None and ("proxies" in engine or "network" in engine):
            # Upstream ignores top-level network parameters when an explicit network exists.
            reason = "operator_choice"
        changes.append({"name": name, "status": "changed" if reason == "filled" else "not_changed", "reason": reason})
        if reason == "filled":
            overlay.append({"name": name, "proxies": {}})
    return {"overlay": {"engines": overlay}, "changes": changes}


def validate_candidate(settings, proposal, template):
    if proposal != generate_candidate(settings, template):
        raise ProbeError("candidate_drift")
    source = Path(__file__).with_name("searxng-overlay.py")
    spec = importlib.util.spec_from_file_location("wag_overlay", source)
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(source.parent))
    try:
        spec.loader.exec_module(module)
        return module.merge(settings, proposal["overlay"])
    finally:
        sys.path.remove(str(source.parent))


class FixtureResponse:
    def __init__(self, content, headers=None, status_code=200):
        self.content = content
        self.text = content.decode("utf-8", errors="replace")
        self.headers = {k.lower(): v for k, v in (headers or {}).items()}
        self.status_code = status_code

    def json(self):
        return json.loads(self.text)


class EngineRuntime:
    def __init__(self, module, entry, provenance):
        self.module, self.entry, self.provenance = module, copy.deepcopy(entry), provenance

    def build(self, case):
        if self.entry["disabled"] or self.entry.get("inactive", False):
            raise ProbeError("disabled")
        query, category, time_range = CASES[case]
        if category not in self.entry["categories"]:
            raise ProbeError("unsupported_category")
        if time_range and not getattr(self.module, "time_range_support", False):
            raise ProbeError("unsupported_time_range")
        params = {"method": "GET", "headers": {"Accept-Language": "zh-CN", "User-Agent": "WAG isolated route probe"},
                  "cookies": {}, "data": None, "language": "zh-CN", "searxng_locale": "zh-CN",
                  "pageno": 1, "time_range": time_range, "safesearch": 0, "category": category}
        started = time.monotonic()
        with deadline(), no_network():
            self.module.request(query, params)
        params["_wag_build_elapsed"] = time.monotonic() - started
        return params

    def parse(self, response):
        from searx.exceptions import SearxEngineCaptchaException
        try:
            with no_network():
                results = self.module.response(response)
            if not isinstance(results, list) or len(results) > 100:
                return {"status": "response_limit", "result_count": 0}
            return {"status": "ok" if results else "empty", "result_count": len(results)}
        except SearxEngineCaptchaException:
            return {"status": "captcha", "result_count": 0}
        except Exception:
            return {"status": "parser_error", "result_count": 0}


def load_engine(source_root, revision, engine_entry):
    root = Path(source_root).resolve()
    name = engine_entry.get("name")
    if revision != REVISION or name not in ENGINE_MODULES:
        raise ProbeError("source_invalid")
    if (engine_entry.get("engine") != ENGINE_MODULES[name] or type(engine_entry.get("disabled")) is not bool
            or not isinstance(engine_entry.get("categories"), list)
            or type(engine_entry.get("inactive", False)) is not bool):
        raise ProbeError("settings_unresolved")
    if (name == "quark" and engine_entry.get("quark_category", "general") != "general"
            or name == "yandex" and engine_entry.get("search_type", "web") != "web"
            or name == "chinaso news" and engine_entry.get("chinaso_news_source", "all") not in ("all", "CENTRAL", "LOCAL", "BUSINESS", "EPAPER")
            or "base_url" in engine_entry):
        raise ProbeError("engine_configuration_unsupported")
    try:
        files = sorted(p for p in (root / "searx").rglob("*") if p.is_file() and
                       (p.suffix == ".py" or p.is_relative_to(root / "searx/data") or p == root / "searx/settings.yml"))
        digest = hashlib.sha256()
        for path in files:
            if path.is_symlink():
                raise ProbeError("source_invalid")
            digest.update(path.relative_to(root).as_posix().encode() + b"\0" + hashlib.sha256(path.read_bytes()).digest())
        if digest.hexdigest() != SOURCE_DIGEST:
            raise ProbeError("source_invalid")
        import yaml
        settings = yaml.safe_load((root / "searx/settings.yml").read_text())
        settings.update({"use_default_settings": False, "engines": []})
        settings["general"]["debug"] = False
        settings["server"]["public_instance"] = False
        settings["outgoing"].update({"request_timeout": 3, "max_request_timeout": 3, "retries": 0, "proxies": {}})
        already = sys.modules.get("searx")
        if already and getattr(already, "_wag_verified_root", None) != str(root):
            raise ProbeError("runtime_contaminated")
        sys.path.insert(0, str(root))
        previous = {k: os.environ.get(k) for k in ("SEARXNG_SETTINGS_PATH", "SEARXNG_DISABLE_ETC_SETTINGS")}
        level = logging.root.manager.disable
        try:
            with tempfile.TemporaryDirectory(prefix="wag-isolated-settings-") as folder, open(os.devnull, "w") as sink:
                cfg = Path(folder) / "settings.yml"
                cfg.write_text(yaml.safe_dump(settings))
                os.environ["SEARXNG_SETTINGS_PATH"] = str(cfg)
                os.environ["SEARXNG_DISABLE_ETC_SETTINGS"] = "1"
                logging.disable(logging.CRITICAL)
                with no_network(), redirect_stdout(sink), redirect_stderr(sink):
                    import searx
                    import searx.utils
                    import searx.exceptions
                    searx._wag_verified_root = str(root)
                    spec = importlib.util.spec_from_file_location("wag_engine_" + ENGINE_MODULES[name],
                                                                 root / "searx/engines" / (ENGINE_MODULES[name] + ".py"))
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    if name == "bing":
                        from searx.enginelib.traits import EngineTraits
                        from searx.data import ENGINE_TRAITS
                        module.traits = EngineTraits(**copy.deepcopy(ENGINE_TRAITS["bing"]))
        finally:
            logging.disable(level)
            sys.path.remove(str(root))
            for k, v in previous.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        for imported in (searx, searx.utils, searx.exceptions):
            if not Path(imported.__file__).resolve().is_relative_to(root):
                raise ProbeError("runtime_contaminated")
        if name == "quark":
            module.quark_category = "general"
        elif name == "chinaso news":
            module.chinaso_news_source = engine_entry.get("chinaso_news_source", "all")
        elif name == "yandex":
            module.search_type = "web"
        return EngineRuntime(module, engine_entry, {"revision": REVISION, "source_digest": SOURCE_DIGEST,
                                                   "verified_files": len(files),
                                                   "parser_sha256": hashlib.sha256(Path(module.__file__).read_bytes()).hexdigest()})
    except ProbeError:
        raise
    except Exception:
        raise ProbeError("runtime_unavailable") from None


@contextmanager
def deadline(seconds=3):
    if threading.current_thread() is not threading.main_thread() or signal.getitimer(signal.ITIMER_REAL)[0]:
        raise ProbeError("runtime_error")
    previous = signal.getsignal(signal.SIGALRM)
    def expired(signum, frame):
        raise TimeoutError()
    signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


class OneSendTransport:
    """One HTTP request, no redirect, retry, environment proxy or result fetch."""
    def __init__(self, proxies, local_only=False):
        if (not isinstance(proxies, dict) or not proxies or set(proxies) - {"all://", "http://", "https://"}
                or any(not isinstance(v, str) for v in proxies.values())):
            raise ProbeError("proxy_invalid")
        for value in proxies.values():
            route = urlsplit(value)
            if route.scheme != "http" or not route.hostname or route.username or route.password or route.path not in ("", "/") or route.query or route.fragment:
                raise ProbeError("proxy_invalid")
            if local_only and route.hostname not in ("127.0.0.1", "::1"):
                raise ProbeError("proxy_invalid")
        self.proxies = copy.deepcopy(proxies)
        self.local_only = local_only
        self.mode = "offline_mock" if local_only else "live"

    def send(self, request, runtime, arm):
        if not self.local_only and (_ACTIVE_LEDGER != (CANONICAL_LEDGER, runtime.entry["name"])
                                   or type(runtime) is not EngineRuntime or runtime.provenance["source_digest"] != SOURCE_DIGEST):
            raise ProbeError("live_identity_refused")
        # A parent watchdog also bounds native parser work and swallowed alarms.
        prepared = request.get("_wag_build_elapsed", 0)
        if type(prepared) not in (float, int) or not math.isfinite(prepared) or prepared < 0:
            return {"status": "request_refused", "attempted": False}
        budget = 2.8 - prepared
        if budget <= 0:
            return {"status": "timeout", "attempted": False}
        started, attempted, http_attempted = time.monotonic(), False, False
        if threading.current_thread() is not threading.main_thread():
            return {"status": "runtime_error", "attempted": False}
        ctx = multiprocessing.get_context("fork")
        reader, writer = ctx.Pipe(duplex=False)
        def worker():
            reader.close()
            writer.send(self._send(request, runtime, arm, writer.send))
            writer.close()
        child = ctx.Process(target=worker)
        result = {"status": "timeout", "attempted": False}
        try:
            child.start()
            writer.close()
            while time.monotonic() - started < budget:
                if not reader.poll(max(0, budget - (time.monotonic() - started))):
                    break
                value = reader.recv()
                if value == "attempted":
                    attempted = True
                elif value == "http_attempted":
                    http_attempted = True
                else:
                    result = safe_result(value)
                    break
        except KeyboardInterrupt:
            result = {"status": "interrupted"}
        except Exception:
            result = {"status": "runtime_error"}
        finally:
            if child.pid:
                if child.is_alive():
                    child.kill()
                child.join(0.15)
                if child.is_alive():
                    error = ProbeError("unfinished_attempt")
                    error.attempted = attempted
                    raise error
            reader.close()
            writer.close()
        result["attempted"] = attempted
        result["http_attempted"] = http_attempted
        elapsed = time.monotonic() - started + prepared
        if elapsed <= 3:
            result["elapsed"] = elapsed
        return result

    def _send(self, request, runtime, arm, mark_attempt):
        started, attempted, connection = time.monotonic(), False, None
        result = {"status": "request_refused", "result_count": 0}
        try:
            with deadline():
                target = urlsplit(request["url"])
                if (arm not in ("direct", "proxy") or request.get("method") != "GET" or request.get("data") is not None
                        or target.username or target.password or target.fragment or len(request["url"]) > 8192):
                    raise ProbeError("request_refused")
                if self.local_only:
                    if target.scheme != "http" or target.hostname not in ("127.0.0.1", "::1"):
                        raise ProbeError("request_refused")
                else:
                    allowed = {"quark": "quark.sm.cn", "chinaso news": "www.chinaso.com", "bing": "www.bing.com", "yandex": "yandex.com"}
                    if target.scheme != "https" or target.hostname != allowed[runtime.entry["name"]] or target.port not in (None, 443):
                        raise ProbeError("request_refused")
                host, port = target.hostname, target.port or (443 if target.scheme == "https" else 80)
                route = self.proxies.get(target.scheme + "://", self.proxies.get("all://")) if arm == "proxy" else None
                if arm == "proxy" and route is None:
                    raise ProbeError("request_refused")
                path = (target.path or "/") + ("?" + target.query if target.query else "")
                if route:
                    proxy = urlsplit(route)
                    if target.scheme == "https":
                        connection = http.client.HTTPSConnection(proxy.hostname, proxy.port or 80, timeout=3, context=ssl.create_default_context())
                        connection.set_tunnel(host, port)
                    else:
                        connection = http.client.HTTPConnection(proxy.hostname, proxy.port or 80, timeout=3)
                        path = request["url"]
                elif target.scheme == "https":
                    connection = http.client.HTTPSConnection(host, port, timeout=3, context=ssl.create_default_context())
                else:
                    connection = http.client.HTTPConnection(host, port, timeout=3)
                headers = copy.deepcopy(request.get("headers", {}))
                headers["Accept-Encoding"] = "identity"
                headers["Connection"] = "close"
                cookies = request.get("cookies", {})
                if cookies:
                    headers["Cookie"] = "; ".join(str(k) + "=" + str(v) for k, v in cookies.items())
                attempted = True
                mark_attempt("attempted")
                connection.connect()
                mark_attempt("http_attempted")
                connection.request("GET", path, headers=headers)
                response = connection.getresponse()
                headers = {k.lower(): v for k, v in response.getheaders()}
                if headers.get("x-yandex-captcha") == "captcha" or response.status in (403, 429):
                    result = {"status": "captcha", "result_count": 0}
                elif 300 <= response.status < 400:
                    result = {"status": "redirect_refused", "result_count": 0}
                elif response.status != 200:
                    result = {"status": "http_error", "result_count": 0}
                elif headers.get("content-encoding", "identity") != "identity":
                    result = {"status": "response_limit", "result_count": 0}
                else:
                    content = response.read(262145)
                    if len(content) > 262144:
                        result = {"status": "response_limit", "result_count": 0}
                    elif b"captcha" in content.lower():
                        result = {"status": "captcha", "result_count": 0}
                    else:
                        with no_network():
                            result = runtime.parse(FixtureResponse(content, headers))
        except TimeoutError:
            result = {"status": "timeout", "result_count": 0}
        except ProbeError:
            result = {"status": "request_refused", "result_count": 0}
        except KeyboardInterrupt:
            result = {"status": "interrupted", "result_count": 0}
        except Exception:
            result = {"status": "error", "result_count": 0}
        finally:
            if connection:
                connection.close()
        return safe_result({**result, "attempted": attempted, "elapsed": time.monotonic() - started})


def run_probe(plan, runtime, ledger, transport):
    if transport.mode == "live" and (type(transport) is not OneSendTransport or transport.local_only
            or ledger.root != CANONICAL_LEDGER or any(type(r) is not EngineRuntime for r in runtime.values() if r is not None)):
        raise ProbeError("live_identity_refused")
    if transport.mode not in ("offline_mock", "offline_parser_fixture", "live"):
        raise ProbeError("mode_invalid")
    if (not isinstance(plan, list) or not 1 <= len(plan) <= 48 or any(
            not isinstance(p, dict) or set(p) != {"engine", "case", "sample"}
            or p["engine"] not in ENGINE_MODULES or p["case"] not in CASES
            or type(p["sample"]) is not int or not 1 <= p["sample"] <= 3 for p in plan)):
        raise ProbeError("plan_invalid")
    if len({(p["engine"], p["case"], p["sample"]) for p in plan}) != len(plan):
        raise ProbeError("plan_invalid")
    samples, stopped, abort = [], set(), False
    for item in plan:
        name = item["engine"]
        engine = runtime.get(name)
        status, request = None, None
        if abort:
            status = "aborted"
        elif name in stopped:
            status = "cooldown"
        elif engine is None:
            status = "disabled"
        else:
            try:
                request = engine.build(item["case"])
            except ProbeError as error:
                status = error.code if error.code in ("disabled", "unsupported_category", "unsupported_time_range") else "runtime_error"
            except (Exception, SystemExit):
                status = "runtime_error"
            except KeyboardInterrupt:
                status, abort = "interrupted", True
        for arm in ("direct", "proxy"):
            result = {"status": "aborted" if abort else "cooldown" if name in stopped else status,
                      "reserved": False, "attempted": False}
            if result["status"] is None:
                try:
                    result = ledger.attempt(name, name in DOMESTIC,
                                            lambda: transport.send(copy.deepcopy(request), engine, arm))
                except ProbeError as error:
                    result = {"status": error.code if error.code in ("clock_error", "storage_error", "unfinished_attempt", "interrupted") else "runtime_error",
                              "reserved": getattr(error, "reserved", False), "attempted": getattr(error, "attempted", False)}
                    abort = True
                if result["status"] == "captcha":
                    stopped.add(name)
                if result["status"] in ("interrupted", "runtime_error"):
                    abort = True
            samples.append({**item, "arm": arm, **result})
    return {"schema": "wag.route-probe.v1", "mode": transport.mode,
            "counts": {"planned": len(samples), "reserved": sum(s["reserved"] for s in samples),
                       "actual_attempted": sum(s["attempted"] for s in samples),
                       "skipped": sum(not s["attempted"] for s in samples)},
            "samples": samples, "partial": any(s["status"] not in ("ok", "empty") for s in samples),
            "limitations": ["single-parser-not-production-processor", "cooperative-ledger-only", "no-publisher-date-proof"]}


SEND_STATUSES = {"ok", "empty", "captcha", "timeout", "error", "parser_error", "response_limit",
                 "redirect_refused", "http_error", "interrupted", "runtime_error", "request_refused"}


def safe_result(value):
    if not isinstance(value, dict) or value.get("status") not in SEND_STATUSES:
        return {"status": "error"}
    result = {"status": value["status"]}
    if type(value.get("result_count")) is int and 0 <= value["result_count"] <= 100:
        result["result_count"] = value["result_count"]
    elapsed = value.get("elapsed")
    if type(elapsed) in (int, float) and math.isfinite(elapsed) and 0 <= elapsed <= 3:
        result["elapsed"] = elapsed
    for key in ("attempted", "http_attempted"):
        if type(value.get(key)) is bool:
            result[key] = value[key]
    return result


def clock_now():
    return {"wall": time.time(), "mono": time.monotonic(),
            "boot": Path("/proc/sys/kernel/random/boot_id").read_text().strip()}


class ProbeLedger:
    """One durable reservation per send, including failed sends. No refunds."""
    def __init__(self, root, clock=clock_now):
        self.root = Path(root).absolute()
        self.anchor = self.root.with_name(self.root.name + ".identity")
        self.clock = clock

    @classmethod
    def initialize(cls, root, clock=clock_now):
        root = Path(root).absolute()
        try:
            if root.exists() or any(p.is_symlink() for p in (root, *root.parents)):
                raise ProbeError("ledger_initialize_refused")
            identity = uuid.uuid4().hex
            # Separate lifetime anchor survives a missing DB or deleted state directory.
            anchor = root.with_name(root.name + ".identity")
            fd = os.open(anchor, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as output:
                output.write(identity)
                output.flush()
                os.fsync(output.fileno())
            root.mkdir(mode=0o700)
            (root / "identity").write_text(identity)
            (root / "lock").touch(mode=0o600)
            with sqlite3.connect(root / "ledger.sqlite") as db:
                db.execute("PRAGMA synchronous=FULL")
                db.execute("CREATE TABLE state (id TEXT, root TEXT, checkpoint TEXT)")
                db.execute("INSERT INTO state VALUES (?, ?, ?)",
                           ((root / "identity").read_text(), str(root), json.dumps(clock())))
                db.execute("CREATE TABLE attempts (engine TEXT, domestic INTEGER, stamp REAL, outcome TEXT)")
                db.execute("CREATE TABLE pauses (engine TEXT PRIMARY KEY, strikes INTEGER, until REAL)")
                db.execute("CREATE TABLE poison (reason TEXT)")
        except Exception:
            raise ProbeError("ledger_initialize_refused") from None

    @contextmanager
    def locked(self):
        import fcntl
        try:
            paths = (self.root, *self.root.parents, self.anchor,
                     *(self.root / n for n in ("lock", "identity", "ledger.sqlite")))
            if any(p.is_symlink() for p in paths) or not (self.root / "ledger.sqlite").is_file():
                raise ProbeError("storage_error")
            with (self.root / "lock").open("r+") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                db = sqlite3.connect(f"file:{self.root / 'ledger.sqlite'}?mode=rw", uri=True, timeout=0)
                try:
                    db.execute("PRAGMA synchronous=FULL")
                    identity, root, checkpoint = db.execute("SELECT * FROM state").fetchone()
                    if (identity != (self.root / "identity").read_text() or identity != self.anchor.read_text()
                            or root != str(self.root) or db.execute("SELECT count(*) FROM state").fetchone()[0] != 1):
                        raise ProbeError("storage_error")
                    yield db
                finally:
                    db.close()
        except ProbeError:
            raise
        except (Exception, KeyboardInterrupt) as cause:
            error = ProbeError("interrupted" if isinstance(cause, KeyboardInterrupt) else "storage_error")
            error.reserved = getattr(self, "_reserved", False)
            error.attempted = getattr(self, "_attempted", False)
            raise error from None

    def checkpoint(self, db):
        poison = db.execute("SELECT reason FROM poison").fetchone()
        if poison:
            raise ProbeError(poison[0])
        try:
            now = self.clock()
            previous = json.loads(db.execute("SELECT checkpoint FROM state").fetchone()[0])
            valid = all(type(now[k]) in (int, float) and math.isfinite(now[k]) and now[k] >= previous[k]
                        for k in ("wall", "mono"))
            valid = valid and isinstance(now["boot"], str) and bool(now["boot"]) and now["boot"] == previous["boot"]
            valid = valid and abs((now["wall"] - previous["wall"]) - (now["mono"] - previous["mono"])) <= 2
        except Exception:
            valid = False
        if not valid:
            db.execute("INSERT INTO poison VALUES ('clock_error')")
            db.commit()
            raise ProbeError("clock_error")
        db.execute("UPDATE state SET checkpoint=?", (json.dumps(now),))
        db.commit()
        return now

    def attempt(self, engine, domestic, send):
        global _ACTIVE_LEDGER
        self._reserved, self._attempted = False, False
        if (not isinstance(engine, str) or not 0 < len(engine) <= 80 or type(domestic) is not bool
                or engine in ENGINE_MODULES and domestic != (engine in DOMESTIC)):
            raise ProbeError("engine_invalid")
        with self.locked() as db:
            if db.execute("SELECT count(*) FROM attempts WHERE outcome IS NULL").fetchone()[0]:
                raise ProbeError("unfinished_attempt")
            now = self.checkpoint(db)
            pause = db.execute("SELECT strikes, until FROM pauses WHERE engine=?", (engine,)).fetchone()
            if pause and now["mono"] < pause[1]:
                return {"status": "cooldown", "reserved": False, "attempted": False}
            since = now["mono"] - 60
            if db.execute("SELECT count(*) FROM attempts WHERE engine=? AND stamp>?", (engine, since)).fetchone()[0] >= 6:
                return {"status": "engine_rate", "reserved": False, "attempted": False}
            if domestic and db.execute("SELECT count(*) FROM attempts WHERE domestic=1 AND stamp>?", (since,)).fetchone()[0] >= 30:
                return {"status": "domestic_rate", "reserved": False, "attempted": False}
            db.execute("INSERT INTO attempts VALUES (?, ?, ?, NULL)", (engine, int(domestic), now["mono"]))
            row = db.execute("SELECT last_insert_rowid()").fetchone()[0]
            db.commit()
            self._reserved = True
            try:
                _ACTIVE_LEDGER = (self.root, engine)
                result = safe_result(send())
            except KeyboardInterrupt:
                result = {"status": "interrupted"}
            except SystemExit:
                result = {"status": "runtime_error"}
            except ProbeError as error:
                if error.code == "unfinished_attempt":
                    error.reserved = True
                    error.attempted = getattr(error, "attempted", False)
                    raise
                result = {"status": "error"}
            except Exception:
                result = {"status": "error"}
            finally:
                _ACTIVE_LEDGER = None
            self._attempted = result.get("attempted", True)
            try:
                finished = self.checkpoint(db)
            except (ProbeError, KeyboardInterrupt) as cause:
                error = cause if isinstance(cause, ProbeError) else ProbeError("interrupted")
                error.reserved, error.attempted = True, result.get("attempted", True)
                raise error from None
            if result["status"] == "captcha":
                strikes = (pause[0] if pause else 0) + 1
                until = finished["mono"] + 1800 * 2 ** min(strikes - 1, 16)
                db.execute("INSERT OR REPLACE INTO pauses VALUES (?, ?, ?)", (engine, strikes, until))
            elif result["status"] == "ok":
                db.execute("DELETE FROM pauses WHERE engine=?", (engine,))
            # End-of-call charge is conservative: connect/parse delay cannot expire a send early.
            db.execute("UPDATE attempts SET outcome=?, stamp=? WHERE rowid=?", (result["status"], finished["mono"], row))
            db.commit()
            return {**result, "reserved": True, "attempted": result.get("attempted", True)}

    def snapshot(self):
        with self.locked() as db:
            return {"reservations": db.execute("SELECT count(*) FROM attempts").fetchone()[0],
                    "unknown_attempts": db.execute("SELECT count(*) FROM attempts WHERE outcome IS NULL").fetchone()[0]}


def partial_report(plan, status):
    samples = [{**item, "arm": arm, "status": status, "reserved": False, "attempted": False}
               for item in plan for arm in ("direct", "proxy")]
    return {"schema": "wag.route-probe.v1", "mode": "live", "status": status, "partial": True,
            "counts": {"planned": len(samples), "reserved": 0, "actual_attempted": 0, "skipped": len(samples)},
            "samples": samples, "limitations": ["preflight-no-send", "historical-ledger-attempts-not-this-run"]}


class SafeArgumentParser(argparse.ArgumentParser):
    def error(self, message):
        raise ProbeError("arguments_invalid")


def isolated_path(path, folder):
    target, root = Path(path).absolute(), Path(folder).resolve()
    if (root in (Path("/"), Path("/etc"), Path("/opt"), Path("/var/lib"))
            or root.is_relative_to("/etc") or root.is_relative_to("/var/lib")
            or not root.is_dir() or not target.resolve().is_relative_to(root)
            or any(p.is_symlink() for p in (target, *target.parents))):
        raise ProbeError("isolated_path_invalid")
    return target


def read_input(path):
    import yaml
    if not path.is_file() or path.stat().st_size > 1048576:
        raise ProbeError("input_invalid")
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def main(argv=None):
    parser = SafeArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True, parser_class=SafeArgumentParser)
    commands.add_parser("init-ledger", help="explicit first initialization; no reset or path override")
    for command in ("candidate", "probe"):
        sub = commands.add_parser(command)
        sub.add_argument("--isolated-dir", required=True)
        sub.add_argument("--settings", required=True)
        sub.add_argument("--output")
        if command == "candidate":
            sub.add_argument("--proposal", help="validate an existing generated proposal against this input")
        else:
            sub.add_argument("--source-root", required=True)
            sub.add_argument("--revision", default=REVISION)
            sub.add_argument("--proxy-map", required=True)
            sub.add_argument("--samples", type=int, choices=(1, 2, 3), default=1)
            sub.add_argument("--news-day", action="store_true")
            sub.add_argument("--authorized-live", action="store_true", required=True)
    args = parser.parse_args(argv)
    try:
        return execute(args)
    except (Exception, KeyboardInterrupt) as error:
        if args.command != "probe":
            raise
        cases = ("general", "news", "day", "news-day") if args.news_day else ("general", "news", "day")
        plan = [{"engine": name, "case": case, "sample": sample} for name in ENGINE_MODULES
                for case in cases for sample in range(1, args.samples + 1)]
        status = error.code if isinstance(error, ProbeError) else "interrupted" if isinstance(error, KeyboardInterrupt) else "input_or_storage_error"
        print(json.dumps(partial_report(plan, status)))
        return 2


def execute(args):
    if args.command == "init-ledger":
        ProbeLedger.initialize(CANONICAL_LEDGER)
        print(json.dumps({"status": "initialized", "schema": "wag.route-ledger.v1"}))
        return 0
    output = isolated_path(args.output, args.isolated_dir) if args.output else None
    if output and output.exists():
        raise ProbeError("output_exists")
    settings = read_input(isolated_path(args.settings, args.isolated_dir))
    template = read_input(Path(__file__).resolve().parents[1] / "config/searxng/cn-routing-candidate.yml")
    proposal = generate_candidate(settings, template)
    if args.command == "candidate":
        if args.proposal:
            proposal = read_input(isolated_path(args.proposal, args.isolated_dir))
        validate_candidate(settings, proposal, template)
        report = proposal
    else:
        ledger = ProbeLedger(CANONICAL_LEDGER)
        ledger.snapshot()
        proxies = read_input(isolated_path(args.proxy_map, args.isolated_dir))
        transport = OneSendTransport(proxies)
        entries = {e["name"]: e for e in settings["engines"]}
        runtimes = {}
        for name in ENGINE_MODULES:
            entry = entries.get(name)
            if entry and not entry.get("disabled", True) and not entry.get("inactive", False):
                runtimes[name] = load_engine(args.source_root, args.revision, entry)
        cases = ("general", "news", "day", "news-day") if args.news_day else ("general", "news", "day")
        plan = [{"engine": name, "case": case, "sample": sample} for name in ENGINE_MODULES
                for case in cases for sample in range(1, args.samples + 1)]
        report = run_probe(plan, runtimes, ledger, transport)
        report["provenance"] = {name: r.provenance for name, r in runtimes.items()}
    return emit_report(report, output)


def emit_report(report, output=None):
    encoded = json.dumps(report, ensure_ascii=False, sort_keys=True) + "\n"
    if output:
        try:
            with output.open("x", encoding="utf-8") as target:
                target.write(encoded)
            return 0
        except (Exception, KeyboardInterrupt):
            report = {**report, "partial": True, "report_status": "output_error"}
            print(json.dumps(report, ensure_ascii=False, sort_keys=True))
            return 2
    print(encoded, end="")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ProbeError as error:
        print(json.dumps({"status": error.code, "partial": True}))
        sys.exit(2)
    except KeyboardInterrupt:
        print(json.dumps({"status": "interrupted", "partial": True}))
        sys.exit(2)
    except Exception:
        print(json.dumps({"status": "input_or_storage_error", "partial": True}))
        sys.exit(2)
