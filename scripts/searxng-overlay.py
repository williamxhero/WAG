#!/usr/bin/env python3
"""WAG-owned merge-by-engine overlay, snapshot and sanitized verification CLI.

prepare SETTINGS OVERLAY --backup DIRECTORY snapshots without mutation. apply,
verify and restore DIRECTORY operate on that retained snapshot. No remote calls.
PyYAML is the same prerequisite as searxng-apply-overlay.sh, not a runtime install.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import tempfile
import time
from urllib.parse import urlsplit

# CLI imports must not create caches in installation or inherited package roots.
sys.dont_write_bytecode = True
import yaml

from release import (ReleaseError, Interrupted, canonical, digest, load, run,
                     save, safe_root, interrupt)

UNIT = "searxng.service"
OUTGOING = ("request_timeout", "max_request_timeout", "pool_connections", "pool_maxsize",
            "retries", "retry_on_http_error", "using_tor", "enable_http2")


def mapping(file):
    # Do not expose YAML parser excerpts (they may include credentials).
    try:
        value = yaml.safe_load(file.read_text(encoding="utf-8"))
    except (yaml.YAMLError, UnicodeError):
        raise ReleaseError("invalid SearXNG YAML") from None
    if not isinstance(value, dict):
        raise ReleaseError("SearXNG settings and overlay must be mappings")
    engines = value.get("engines", [])
    if (not isinstance(engines, list) or any(not isinstance(e, dict) or
            not isinstance(e.get("name"), str) or not e["name"] for e in engines)
            or len({e["name"] for e in engines}) != len(engines)):
        raise ReleaseError("SearXNG engines must have unique names")
    if not isinstance(value.get("outgoing", {}), dict):
        raise ReleaseError("SearXNG outgoing must be a mapping")
    return value


def merge(base, overlay, key=None):
    if isinstance(base, dict) and isinstance(overlay, dict):
        result = copy.deepcopy(base)
        for name, value in overlay.items():
            # Operator/backend proxy choices are authoritative; fill only absent
            # proxy maps. This includes per-engine overrides, not just outgoing.
            if name == "proxies" and name in result:
                continue
            result[name] = merge(result[name], value, name) if name in result else copy.deepcopy(value)
        return result
    if key == "engines":
        result = copy.deepcopy(base)
        positions = {e["name"]: i for i, e in enumerate(result)}
        for engine in overlay:
            name = engine["name"]
            if name in positions:
                result[positions[name]] = merge(result[positions[name]], engine)
            else:
                positions[name] = len(result)
                result.append(copy.deepcopy(engine))
        return result
    return copy.deepcopy(overlay)


def proxies(value):
    if not isinstance(value, dict):
        raise ReleaseError("invalid outbound proxy configuration")
    result = {}
    for route, urls in value.items():
        if route not in {"all://", "http://", "https://"}:
            raise ReleaseError("unsupported outbound proxy route")
        if isinstance(urls, str):
            urls = [urls]
        if not isinstance(urls, list) or not urls:
            raise ReleaseError("invalid outbound proxy list")
        result[route] = []
        for url in urls:
            if not isinstance(url, str):
                raise ReleaseError("invalid outbound proxy URL")
            try:
                parsed = urlsplit(url)
                port = parsed.port
            except ValueError:
                raise ReleaseError("invalid outbound proxy URL") from None
            if parsed.scheme not in {"http", "https", "socks4", "socks5", "socks5h"} or not parsed.hostname:
                raise ReleaseError("invalid outbound proxy URL")
            # Never include userinfo, path/query/fragment or original URL text.
            result[route].append({"scheme": parsed.scheme, "hostname": parsed.hostname, "port": port})
    return result


def effective(settings, names):
    outgoing = settings.get("outgoing", {})
    result = {"outgoing": {}, "engines": []}
    for name in OUTGOING:
        if name in outgoing:
            value = outgoing[name]
            if type(value) not in (bool, int, float) or (isinstance(value, float) and not (-1e10 < value < 1e10)):
                raise ReleaseError("invalid effective outgoing setting")
            result["outgoing"][name] = value
    result["outgoing"]["proxies"] = proxies(outgoing.get("proxies", {}))
    engines = {e["name"]: e for e in settings.get("engines", [])}
    for name in sorted(names):
        if name not in engines:
            raise ReleaseError("effective reviewed engine missing")
        engine = engines[name]
        item = {"name": name, "disabled": engine.get("disabled", False)}
        if type(item["disabled"]) is not bool:
            raise ReleaseError("invalid effective engine state")
        for key in ("engine", "categories", "timeout"):
            if key in engine:
                value = engine[key]
                if key == "engine" and (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", value)):
                    raise ReleaseError("invalid engine backend name")
                if key == "categories" and (not isinstance(value, list) or any(
                        not isinstance(v, str) or not re.fullmatch(r"[A-Za-z0-9 _-]+", v) for v in value)):
                    raise ReleaseError("invalid engine categories")
                # A reviewed engine timeout shares the query budget with
                # outgoing.max_request_timeout, so it stays a plain finite number.
                if key == "timeout":
                    if isinstance(value, bool) or not isinstance(value, (int, float)):
                        raise ReleaseError("invalid engine timeout")
                    if not (0 < value < 1e6):
                        raise ReleaseError("invalid engine timeout")
                item[key] = sorted(value) if isinstance(value, list) else value
        if "proxies" in engine:
            item["proxies"] = proxies(engine["proxies"])
        result["engines"].append(item)
    return result


def provenance(projection):
    return {"schema": 1, "tool_versions": {"PyYAML": yaml.__version__},
            "effective_digest": digest(canonical(projection)),
            "engines_digest": digest(canonical(projection["engines"])),
            "outgoing_digest": digest(canonical(projection["outgoing"]))}


def prepare(settings, overlay, backup):
    settings = Path(settings)
    if (not settings.is_absolute() or settings.resolve() != settings or
            not settings.is_file() or settings.is_symlink()):
        raise ReleaseError("settings must be an existing canonical regular file")
    base, addition = mapping(settings), mapping(Path(overlay))
    merged = merge(base, addition)
    names = sorted(e["name"] for e in addition.get("engines", []))
    if not names:
        raise ReleaseError("reviewed overlay engines missing")
    projection = effective(merged, names)
    backup = Path(backup)
    safe_root(str(backup.parent))
    # Exclusive creation: a same-stamp backup is never reused or overwritten.
    backup.mkdir(mode=0o750)
    info = settings.stat()
    snapshot = backup / "settings.yml"
    import shutil
    shutil.copy2(settings, snapshot)
    os.chown(snapshot, info.st_uid, info.st_gid)
    candidate = backup / "merged.yml"
    candidate.write_text(yaml.safe_dump(merged, sort_keys=False, allow_unicode=True), encoding="utf-8")
    os.chmod(candidate, stat.S_IMODE(info.st_mode))
    os.chown(candidate, info.st_uid, info.st_gid)
    for file in (snapshot, candidate):
        with file.open("rb") as handle:
            os.fsync(handle.fileno())
    active, _ = run(["systemctl", "is-active", UNIT], "overlay service snapshot", allowed=(0, 3, 4))
    if active not in {"active", "inactive", "failed", "unknown"}:
        raise ReleaseError("unsupported prior overlay service state")
    save(backup / "state.json", {"schema": 1, "status": "prepared", "settings": str(settings),
                                "active": active == "active", "names": names,
                                "overlay": str(Path(overlay).resolve()),
                                "expected": projection, "provenance": provenance(projection)})
    return provenance(projection)


def replace(source, target):
    import shutil
    info = source.stat()
    fd, name = tempfile.mkstemp(prefix=".wag-settings-", dir=target.parent)
    os.close(fd)
    tmp = Path(name)
    try:
        shutil.copy2(source, tmp)
        os.chown(tmp, info.st_uid, info.st_gid)
        with tmp.open("rb") as handle:
            os.fsync(handle.fileno())
        tmp.replace(target)
        fd = os.open(target.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        tmp.unlink(missing_ok=True)


def healthy():
    attempts = int(os.environ.get("WAG_OVERLAY_ATTEMPTS", "30"))
    delay = float(os.environ.get("WAG_OVERLAY_DELAY", "1"))
    if not (1 <= attempts <= 30 and 0 <= delay <= 1):
        raise ReleaseError("invalid overlay readiness bounds")
    with tempfile.TemporaryDirectory(prefix="wag-overlay-check-") as folder:
        response = Path(folder) / "response.json"
        for attempt in range(attempts):
            try:
                listeners, _ = run(["ss", "-ltn"], "overlay listener", timeout=10)
                if not re.search(r"(?:^|\s)\S*:8801(?:\s|$)", listeners):
                    raise ReleaseError("overlay listener missing")
                run(["curl", "--silent", "--show-error", "--fail", "--max-time", "10", "--get",
                     "http://yosef-server:8801/search", "--data-urlencode", "q=test", "--data", "format=json",
                     "--output", response], "overlay search", timeout=12)
                if response.stat().st_size > 4 * 1024 * 1024:
                    raise ReleaseError("overlay response too large")
                body = load(response)
                if not isinstance(body, dict) or not isinstance(body.get("results"), list) or not body["results"]:
                    raise ReleaseError("overlay search empty")
                unresponsive = body.get("unresponsive_engines") or []
                if not isinstance(unresponsive, list):
                    raise ReleaseError("invalid overlay engine diagnostics")
                if sum(bool(re.search(r"timeout|timed\s+out|time\s+out", str(e), re.I)) for e in unresponsive) >= 3:
                    raise ReleaseError("overlay timeout cluster")
                return
            except (ReleaseError, OSError, ValueError):
                if attempt + 1 < attempts:
                    time.sleep(delay)
    raise ReleaseError("overlay readiness failed")


def verify(backup, state, service=True):
    observed = effective(mapping(Path(state["settings"])), state["names"])
    if observed != state["expected"] or provenance(observed) != state["provenance"]:
        raise ReleaseError("effective overlay configuration drift")
    if service:
        healthy()
    return state["provenance"]


def operate(command, backup):
    backup = safe_root(str(backup))
    state = load(backup / "state.json")
    settings = Path(state["settings"])
    if (settings.resolve() != settings or settings.is_symlink() or not settings.parent.is_dir()
            or (settings.exists() and not settings.is_file())
            or (command != "restore" and not settings.is_file())):
        raise ReleaseError("unsafe overlay settings target")
    if command == "restore":
        if state["status"] == "restored":
            return state["provenance"]
        if state["status"] == "prepared":
            state["status"] = "restored"
            save(backup / "state.json", state)
            return state["provenance"]
        state["status"] = "restoring"
        save(backup / "state.json", state)
        stage = "snapshot_copy"
        try:
            replace(backup / "settings.yml", settings)
            stage = "service_restore"
            run(["systemctl", "restart" if state["active"] else "stop", UNIT], "overlay service restore")
            if state["active"]:
                stage = "readiness_restore"
                healthy()
        except BaseException:
            state["status"] = "restore_failed"
            state["restore_errors"] = [stage]
            save(backup / "state.json", state)
            raise
        state["status"] = "restored"
        state.pop("restore_errors", None)
        save(backup / "state.json", state)
    elif command == "apply":
        if state["status"] != "prepared":
            raise ReleaseError("only a prepared overlay can apply")
        snapshot = backup / "settings.yml"
        if settings.read_bytes() != snapshot.read_bytes():
            raise ReleaseError("SearXNG settings changed after snapshot")
        staged = mapping(backup / "merged.yml")
        # Compare full values in memory to catch secret/unrelated-field drift,
        # without persisting or printing a hash of secret-bearing settings.
        if (staged != merge(mapping(snapshot), mapping(Path(state["overlay"])))
                or effective(staged, state["names"]) != state["expected"]):
            raise ReleaseError("staged effective overlay drift")
        state["status"] = "applying"
        save(backup / "state.json", state)
        replace(backup / "merged.yml", settings)
        run(["systemctl", "restart", UNIT], "overlay restart")
        verify(backup, state)
        state["status"] = "applied"
        save(backup / "state.json", state)
    elif command == "verify":
        if state["status"] != "applied":
            raise ReleaseError("overlay is not applied")
        verify(backup, state)
    return state["provenance"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    stage = sub.add_parser("prepare")
    stage.add_argument("settings")
    stage.add_argument("overlay")
    stage.add_argument("--backup", required=True)
    for name in ("apply", "verify", "restore"):
        sub.add_parser(name).add_argument("backup")
    args = parser.parse_args()
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, interrupt)
    result = prepare(args.settings, args.overlay, args.backup) if args.command == "prepare" else operate(args.command, args.backup)
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, Interrupted) as error:
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print('{"ok":false,"error":"overlay prerequisite or filesystem failure"}', file=sys.stderr)
        sys.exit(1)
