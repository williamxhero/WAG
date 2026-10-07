#!/usr/bin/env python3
"""WAG runtime release transaction (Linux, stdlib only).

prepare SOURCE --target ROOT --units UNIT_DIR returns {transaction: PATH}.
activate PATH leaves an uncommitted candidate; commit PATH seals it. abort PATH
restores any uncommitted transaction; restore PATH also restores a committed one.
Add --searxng-settings FILE to prepare for a coordinated reviewed-overlay release.
Prepare snapshots both sides; activation applies/verifies the overlay before the
runtime, and commit rechecks effective engines/proxies. Abort/restore and ALL
activation/commit errors restore both sides, with retryable sanitized diagnostics.
Without that option the #24 runtime-only CLI/contract remains unchanged.
Snapshots and candidate venvs must be retained: venv scripts are not relocatable.
This offline contract does not authorize deployment or assert #9 acceptance.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit

RUNTIME = ("web-access-egress-proxy.service", "web-access-crawl4ai.service",
           "web-access-playwright.service", "web-access-gateway.service")
TIMERS = ("web-access-healthcheck.timer", "web-access-artifact-cleanup.timer")
UNITS = RUNTIME + TIMERS + ("web-access-healthcheck.service", "web-access-artifact-cleanup.service")
MAPPING = {"gateway": "runtime/gateway", "crawl4ai": "runtime/crawl4ai-service",
           "proxy": "runtime/proxy", "scripts": "scripts", "systemd": "systemd",
           "eval": "eval", "tools": "tools", "runtime/playwright-mcp": "runtime/playwright-mcp"}
CODE_SUFFIXES = {".mjs", ".js", ".py", ".sh", ".json", ".css", ".html", ".yml", ".yaml", ".service", ".timer"}
PROTECTED = {"secrets", "artifacts", "reports", "logs", "data", "node_modules", "__pycache__"}
MANIFESTS = ("runtime/gateway/package.json", "runtime/gateway/package-lock.json",
             "runtime/playwright-mcp/package.json", "runtime/playwright-mcp/package-lock.json",
             "config/crawl4ai-requirements.lock")
REQUIRED = ("runtime/gateway/server.mjs", "runtime/gateway/search.mjs",
            "runtime/gateway/eval-runner.mjs", "runtime/gateway/eval-case.mjs",
            "runtime/gateway/artifact-store.mjs", "runtime/gateway/readiness.mjs",
            "runtime/gateway/evidence-metadata.mjs", "scripts/searxng-overlay.py",
            "runtime/gateway/public/evals.html", "runtime/gateway/public/evals.js", "runtime/gateway/public/evals.css",
            "runtime/proxy/server.mjs", "runtime/crawl4ai-service/app.py", "eval/samples.json",
            "scripts/bootstrap-bind.py", "scripts/healthcheck.sh", "scripts/healthcheck-diagnostics.py",
            "scripts/searxng-apply-overlay.sh", "scripts/cleanup-artifacts.sh", "scripts/install-artifact-cleanup.sh",
            "config/searxng/settings-overlay.yml") + MANIFESTS + tuple("systemd/" + x for x in UNITS)


class ReleaseError(Exception):
    pass


class Interrupted(Exception):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(value).hexdigest()


def save(file, value):
    tmp = file.with_suffix(file.suffix + ".tmp")
    with tmp.open("wb") as handle:
        handle.write(canonical(value) + b"\n")
        handle.flush()
        os.fsync(handle.fileno())
    tmp.replace(file)
    # Flush the rename as well as the data for recoverable journal states.
    fd = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def load(file):
    return json.loads(file.read_text())


def record_diagnostics(out, error, records):
    layers = {"healthcheck", "process", "gateway", "crawl4ai", "playwright", "gateway-ready",
              "egress-connect", "public-search", "proxy-restarts"}
    kinds = {"curl_dns", "curl_connect", "curl_timeout", "curl_tls", "curl_error", "command_error",
             "command_timeout", "invalid_http_status", "dependency_http_status", "dependency_invalid_data",
             "core_failure", "public_connectivity", "search_empty", "healthcheck_timeout", "invalid_deadline"}
    for line in (out + b"\n" + error)[:65536].decode("utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if not isinstance(value, dict) or not isinstance(value.get("layer"), str) or value["layer"] not in layers:
            continue
        # Keep classifications/statuses, never arbitrary message/detail/header text.
        item = {"layer": value["layer"]}
        for key in ("ok", "core_ok", "public_connectivity_ok", "exit_code", "http_status"):
            if type(value.get(key)) in (bool, int):
                item[key] = value[key]
        failure = value.get("error")
        if isinstance(failure, dict) and isinstance(failure.get("kind"), str) and failure["kind"] in kinds:
            item["error"] = {"kind": failure["kind"]}
        records.append(item)
    records[:] = records[-20:]


def run(args, label, env=None, timeout=120, allowed=(0,), diagnostics=None):
    # Never forward dependency-manager output or secret-bearing command errors.
    process = subprocess.Popen(list(map(str, args)), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               env=env, start_new_session=True)
    try:
        out, error = process.communicate(timeout=timeout)
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        raise
    if diagnostics is not None:
        record_diagnostics(out, error, diagnostics)
    if process.returncode not in allowed:
        raise ReleaseError(label + " failed (exit " + str(process.returncode) + ")")
    return out.decode("utf-8", errors="strict").strip(), process.returncode


def exists(file):
    return file.exists() or file.is_symlink()


def remove(file):
    if file.is_symlink() or file.is_file():
        file.unlink()
    elif file.is_dir():
        shutil.rmtree(file)


def copy(src, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.is_symlink():
        dest.symlink_to(os.readlink(src))
    elif src.is_dir():
        shutil.copytree(src, dest, symlinks=True)
        for file in src.rglob("*"):
            info = file.lstat()
            os.chown(dest / file.relative_to(src), info.st_uid, info.st_gid, follow_symlinks=False)
    else:
        shutil.copy2(src, dest)
    info = src.lstat()
    os.chown(dest, info.st_uid, info.st_gid, follow_symlinks=False)


def text(file, value):
    tmp = file.with_suffix(".tmp")
    with tmp.open("w") as handle:
        handle.write(value + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    tmp.replace(file)
    fd = os.open(file.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def safe_root(value):
    path = Path(value)
    if not path.is_absolute() or path == Path("/") or path.resolve() != path:
        raise ReleaseError("roots must be absolute canonical non-symlink directories")
    if not path.is_dir():
        raise ReleaseError("installation and unit roots must already exist")
    return path


def check_parents(file, root):
    if not file.is_relative_to(root) or ".." in file.relative_to(root).parts:
        raise ReleaseError("path outside release roots")
    for parent in file.parents:
        if parent == root:
            break
        if parent.is_symlink() or (exists(parent) and not parent.is_dir()):
            raise ReleaseError("unsafe installation parent")


def production(name):
    path = Path(name)
    if any(part in PROTECTED or part in {"fixtures", "test-fixtures", "tests"} for part in path.parts):
        return False
    base = path.name
    if base.startswith((".", "test_")) or ".test." in base or base.endswith(("_test.py", "-test.py")):
        return False
    return path.suffix in CODE_SUFFIXES and ".env" not in base


def inventory(source):
    revision, _ = run(["git", "-C", source, "rev-parse", "HEAD"], "reviewed revision")
    if not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise ReleaseError("invalid reviewed revision")
    names, _ = run(["git", "-C", source, "ls-files", "-z"], "tracked inventory")
    result = {}
    for name in names.split("\0"):
        if not name:
            continue
        path = Path(name)
        if path.is_absolute() or ".." in path.parts:
            raise ReleaseError("invalid tracked path")
        destination = None
        for prefix, target in MAPPING.items():
            if prefix == "scripts" and path.suffix in {".service", ".timer"}:
                continue  # systemd/, not a legacy script-side copy, is authoritative.
            if name.startswith(prefix + "/") and production(name):
                destination = target + name[len(prefix):]
                break
        if name.startswith("config/") and (name.endswith(".env.template") or name in
                {"config/crawl4ai-requirements.lock", "config/searxng/settings-overlay.yml"}):
            destination = name
        if destination:
            file = source / name
            if not file.is_file() or file.is_symlink():
                raise ReleaseError("candidate inventory contains absent or symbolic source")
            result[destination] = {"source": name, "sha256": digest(file.read_bytes()),
                                   "executable": file.suffix == ".sh"}
    if any(name not in result for name in REQUIRED):
        raise ReleaseError("required release inventory missing")
    # A revision label cannot hide locally modified or staged production files.
    run(["git", "-C", source, "diff", "--exit-code", "HEAD", "--"] +
        [item["source"] for item in result.values()] + ["config/playwright.env"], "reviewed inventory")
    return revision, dict(sorted(result.items()))


def locked_python(file):
    pins = {}
    for line in file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        match = re.fullmatch(r"([A-Za-z0-9_.-]+)==([A-Za-z0-9_.+!-]+)", line)
        if not match:
            raise ReleaseError("Python requirements must retain exact version pins")
        name = re.sub(r"[-_.]+", "-", match[1]).lower()
        if name in pins:
            raise ReleaseError("duplicate Python requirement")
        pins[name] = match[2]
    if not {"crawl4ai", "fastapi", "uvicorn", "playwright"}.issubset(pins):
        raise ReleaseError("required pinned Python packages missing")
    return pins


def node_packages(folder):
    lock = load(folder / "package-lock.json")
    manifest = load(folder / "package.json")
    if lock.get("lockfileVersion") not in (2, 3) or not isinstance(lock.get("packages"), dict):
        raise ReleaseError("unsupported Node lockfile")
    if lock["packages"].get("", {}).get("dependencies") != manifest.get("dependencies"):
        raise ReleaseError("Node manifest and approved lock disagree")
    versions = {}
    for name, info in sorted(lock["packages"].items()):
        if not name or info.get("dev"):
            continue
        if not name.startswith("node_modules/") or ".." in Path(name).parts:
            raise ReleaseError("unsupported locked package path")
        file = folder / name / "package.json"
        if not file.is_file():
            if info.get("optional"):
                continue
            raise ReleaseError("locked Node dependency missing")
        installed = load(file).get("version")
        if installed != info.get("version"):
            raise ReleaseError("installed Node dependency differs from approved lock")
        versions[name] = installed
    return versions


def python_packages(candidate, env):
    pins = locked_python(candidate / "config/crawl4ai-requirements.lock")
    pip = candidate / "runtime/crawl4ai-venv/bin/pip"
    run([pip, "check"], "Python dependency check", env=env)
    packages, _ = run([pip, "list", "--format=json"], "Python versions", env=env)
    installed = {re.sub(r"[-_.]+", "-", item["name"]).lower(): item["version"] for item in json.loads(packages)}
    if any(installed.get(name) != version for name, version in pins.items()):
        raise ReleaseError("installed Python dependency differs from approved lock")
    return dict(sorted(installed.items()))


def safe_configuration(root, candidate, env):
    bind, _ = run(["python3", candidate / "scripts/bootstrap-bind.py", root / "secrets/gateway.env",
                   candidate / "config/gateway.env.template"], "approved bind preflight", env=env, timeout=15)
    result = {"gateway_bind": bind}
    # Only a reviewed allowlist of parsed, non-secret fields. Never hash an env
    # file, even if this particular fixture or shipped default contains no token.
    file = root / "config/playwright.env"
    if not file.exists():
        file = candidate / "config/playwright.env"
    if file.exists():
        values = dict(line.split("=", 1) for line in file.read_text().splitlines() if "=" in line)
        for key in ("HTTP_PROXY", "HTTPS_PROXY"):
            value = urlsplit(values.get(key, ""))
            if value.scheme in {"http", "https"} and value.hostname:
                result[key] = {"scheme": value.scheme, "hostname": value.hostname, "port": value.port}
        value = values.get("PLAYWRIGHT_MCP_PING_TIMEOUT_MS", "")
        if re.fullmatch(r"[0-9]{1,8}", value):
            result["PLAYWRIGHT_MCP_PING_TIMEOUT_MS"] = value
    return result


def prerequisites(root, candidate, entries):
    node = root / "runtime/node/bin/node"
    npm = os.environ.get("WAG_RELEASE_NPM", str(root / "runtime/node/bin/npm"))
    python = os.environ.get("WAG_RELEASE_PYTHON", "python3")
    env = dict(os.environ, PATH=str(node.parent) + os.pathsep + os.environ.get("PATH", ""),
               PLAYWRIGHT_SKIP_BROWSER_GC="1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1",
               PLAYWRIGHT_BROWSERS_PATH=str(root / "runtime/crawl4ai-browsers"))
    version, _ = run([node, "--version"], "Node runtime", env=env)
    if not re.fullmatch(r"v(?:2[2-9]|[3-9][0-9])\.[0-9]+\.[0-9]+", version):
        raise ReleaseError("Node 22 or newer is required")
    py_version, _ = run([python, "--version"], "Python runtime", env=env)
    if not re.fullmatch(r"Python 3\.(?:1[0-9]|[2-9][0-9])\.[0-9]+", py_version):
        raise ReleaseError("Python 3.10 or newer is required")
    npm_version, _ = run([npm, "--version"], "npm version", env=env)
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", npm_version):
        raise ReleaseError("invalid npm version")
    for name in entries:
        file = candidate / name
        if file.suffix == ".mjs":
            run([node, "--check", file], "Node syntax", env=env)
        elif file.suffix == ".sh":
            run(["bash", "-n", file], "shell syntax", env=env)
        elif file.suffix == ".py":
            compile(file.read_bytes(), str(file), "exec")
    node_versions = {}
    for name in ("runtime/gateway", "runtime/playwright-mcp"):
        folder = candidate / name
        run([npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", folder],
            "locked Node install", env=env, timeout=600)
        node_versions[name] = node_packages(folder)
    locked_python(candidate / "config/crawl4ai-requirements.lock")
    venv = candidate / "runtime/crawl4ai-venv"
    run([python, "-m", "venv", venv], "staged Python environment", env=env)
    run([venv / "bin/pip", "install", "--no-deps", "--requirement",
         candidate / "config/crawl4ai-requirements.lock"], "locked Python install", env=env, timeout=600)
    installed = python_packages(candidate, env)
    py_version, _ = run([venv / "bin/python", "--version"], "installed Python version", env=env)
    browsers, _ = run([venv / "bin/python", "-c",
        "import json, crawl4ai, fastapi, uvicorn; from playwright.sync_api import sync_playwright; "
        "from patchright.sync_api import sync_playwright as patch; "
        "\nwith sync_playwright() as p, patch() as q: print(json.dumps([p.chromium.executable_path, q.chromium.executable_path]))"],
        "crawler/browser imports", env=env)
    paths = json.loads(browsers)
    unit = (candidate / "systemd/web-access-playwright.service").read_text()
    match = re.search(r"--executable-path\s+(\S+)", unit)
    if not match:
        raise ReleaseError("authoritative Playwright unit has no executable")
    # Existing browser caches are read-only prerequisites, never installed or GC'd.
    paths.append(match[1].replace("/data/web-access-gateway", str(root), 1))
    browser_versions = {}
    for path in paths:
        file = Path(path)
        if not file.is_relative_to(root / "runtime") or not file.is_file() or not os.access(file, os.X_OK):
            raise ReleaseError("required browser executable missing")
        browser_version, _ = run([file, "--version"], "browser prerequisite", env=env, timeout=15)
        if not re.fullmatch(r"[A-Za-z ]+ [0-9.]+", browser_version):
            raise ReleaseError("unexpected browser version")
        browser_versions[str(file.relative_to(root))] = browser_version
    return {"node": version, "npm": npm_version, "python": py_version,
            "node_packages": node_versions, "python_packages": dict(sorted(installed.items())),
            "browsers": dict(sorted(browser_versions.items()))}, safe_configuration(root, candidate, env)


def verify(candidate, entries):
    for name, item in entries.items():
        file = candidate / name
        if not file.is_file() or file.is_symlink() or digest(file.read_bytes()) != item["sha256"]:
            raise ReleaseError("candidate inventory integrity failure")


def prepare(args):
    root, unit_dir, source = safe_root(args.target), safe_root(args.units), safe_root(args.source)
    if (root == unit_dir or root.is_relative_to(unit_dir) or unit_dir.is_relative_to(root)
            or root.is_relative_to(source) or source.is_relative_to(root)
            or source.is_relative_to(unit_dir) or unit_dir.is_relative_to(source)):
        raise ReleaseError("release roots must not overlap")
    revision, entries = inventory(source)
    releases = root / "releases"
    check_parents(releases / "transaction", root)
    releases.mkdir(exist_ok=True, mode=0o750)
    tx = Path(tempfile.mkdtemp(prefix="runtime-", dir=releases))
    candidate = tx / "candidate"
    try:
        for name, item in entries.items():
            copy(source / item["source"], candidate / name)
            (candidate / name).chmod(0o750 if item["executable"] else 0o640)
        # A default is installed only if absent; an operator's env is never replaced.
        default = source / "config/playwright.env"
        if not default.is_file() or default.is_symlink():
            raise ReleaseError("reviewed Playwright default missing or symbolic")
        copy(default, candidate / "config/playwright.env")
        (candidate / "config/playwright.env").chmod(0o640)
        versions, safe_config = prerequisites(root, candidate, entries)
        verify(candidate, entries)
        owner = root.stat()
        for file in [tx, releases, *candidate.rglob("*")]:
            os.chown(file, owner.st_uid, owner.st_gid, follow_symlinks=False)
        tx.chmod(0o750)
        provenance = {"schema": 1, "reviewed_revision": revision, "inventory": entries,
                      "inventory_digest": digest(canonical(sorted(entries))),
                      "code_digest": digest(canonical(entries)),
                      "dependency_manifest_digest": digest(canonical({n: entries[n]["sha256"] for n in MANIFESTS})),
                      "safe_configuration_digest": digest(canonical(safe_config)), "versions": versions,
                      "scope": "runtime-only; overlay and complete release acceptance pending"}
        save(tx / "provenance.json", provenance)
        save(tx / "state.json", {"schema": 1, "status": "prepared", "root": str(root),
                                  "unit_dir": str(unit_dir), "inventory": entries})
        return tx
    except BaseException:
        shutil.rmtree(tx)
        raise


def obsolete(root, entries):
    names = set()
    for prefix in MAPPING.values():
        folder = root / prefix
        if folder.is_symlink():
            raise ReleaseError("owned code directory is a symlink")
        if not folder.exists():
            continue
        for file in folder.rglob("*"):
            name = str(file.relative_to(root))
            if (any(part in PROTECTED for part in Path(name).parts)
                    or ".env" in file.name or file.name.startswith(".")):
                continue
            # Legacy executable code is owned. Unknown operator JSON/YAML/HTML
            # isn't: only a previous committed inventory authorizes its removal.
            owned = file.suffix in {".mjs", ".js", ".py", ".sh"}
            owned |= prefix == "systemd" and file.name.startswith("web-access-")
            owned |= name == "scripts/web-access-playwright.service"
            if owned and name not in entries:
                names.add(name)
    previous = root / ".release-current"
    if previous.exists():
        old = load(Path(previous.read_text().strip()) / "provenance.json")["inventory"]
        names.update(name for name in old if name not in entries)
    return sorted(names)


def snapshot(tx, state):
    root, unit_dir = Path(state["root"]), Path(state["unit_dir"])
    paths = [(root / name, "root") for name in sorted(set(state["inventory"]) | set(state["obsolete"]))]
    paths += [(root / name, "root") for name in ("runtime/gateway/node_modules",
              "runtime/playwright-mcp/node_modules", "runtime/crawl4ai-venv", ".release-current")]
    if not exists(root / "config/playwright.env"):
        paths.append((root / "config/playwright.env", "root"))
    paths += [(unit_dir / name, "units") for name in UNITS]
    entries, absent_parents = [], set()
    for index, (file, scope) in enumerate(paths):
        base = root if scope == "root" else unit_dir
        check_parents(file, base)
        backup = tx / "snapshot" / str(index)
        present = exists(file)
        if present:
            copy(file, backup)
        entries.append({"path": str(file.relative_to(base)), "scope": scope,
                        "present": present, "backup": str(index)})
        for parent in file.parents:
            if parent == base:
                break
            if not exists(parent):
                absent_parents.add((scope, str(parent.relative_to(base))))
    state["snapshot"] = entries
    state["absent_parents"] = sorted(absent_parents, key=lambda pair: len(Path(pair[1]).parts), reverse=True)
    services = {}
    for unit in RUNTIME + TIMERS:
        active, _ = run(["systemctl", "is-active", unit], "service snapshot", allowed=(0, 3, 4))
        enabled, _ = run(["systemctl", "is-enabled", unit], "unit snapshot", allowed=(0, 1, 4))
        if active not in {"active", "inactive", "failed", "unknown"} or enabled not in {
                "enabled", "disabled", "static", "not-found", "masked", "enabled-runtime"}:
            raise ReleaseError("unsupported prior service state")
        services[unit] = {"active": active == "active", "enabled": enabled}
    state["services"] = services


@contextlib.contextmanager
def root_lock(root):
    file = root / ".release-lock"
    if file.is_symlink():
        raise ReleaseError("unsafe release lock")
    with file.open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ReleaseError("another release command is running") from None
        yield


def transaction(value):
    tx = safe_root(value)
    state = load(tx / "state.json")
    root, unit_dir = safe_root(state["root"]), safe_root(state["unit_dir"])
    if tx.parent != root / "releases" or state.get("schema") != 1:
        raise ReleaseError("invalid transaction directory")
    return tx, state, root, unit_dir


def write_state(tx, state, status):
    state["status"] = status
    save(tx / "state.json", state)


def pending(root, tx):
    file = root / ".release-pending"
    if not file.is_file() or file.read_text().strip() != str(tx):
        raise ReleaseError("transaction is not the pending release")


def restore_runtime(tx, state, root, unit_dir, finalize=True):
    if state["status"] == "restored":
        file = root / ".release-pending"
        if finalize and file.exists() and file.read_text().strip() == str(tx):
            file.unlink()
        return
    if state["status"] == "prepared":
        pending(root, tx)
        if finalize:
            write_state(tx, state, "restored")
            (root / ".release-pending").unlink()
        return
    if state["status"] == "committed":
        file = root / ".release-pending"
        if ((file.exists() and file.read_text().strip() != str(tx))
                or (root / ".release-current").read_text().strip() != str(tx)):
            raise ReleaseError("cannot restore a superseded committed release")
        text(file, str(tx))
    else:
        pending(root, tx)
    # Persist before restoration: failed or interrupted restores are retryable.
    write_state(tx, state, "restoring")
    errors = []
    for unit in RUNTIME + TIMERS:
        try:
            run(["systemctl", "stop", unit], "rollback stop")
        except (ReleaseError, OSError):
            errors.append("service_stop")
    if errors:
        state["restore_errors"] = sorted(set(errors))
        write_state(tx, state, "restore_failed")
        raise ReleaseError("snapshot restoration failed: service_stop")
    for entry in state["snapshot"]:
        try:
            base = root if entry["scope"] == "root" else unit_dir
            file = base / entry["path"]
            check_parents(file, base)
            backup = tx / "snapshot" / entry["backup"]
            if entry["present"] and not exists(backup):
                raise ReleaseError("snapshot missing")
            remove(file)
            if entry["present"]:
                copy(backup, file)
        except (ReleaseError, OSError):
            errors.append("snapshot_copy")
    for scope, name in state["absent_parents"]:
        file = (root if scope == "root" else unit_dir) / name
        if file.is_dir():
            try:
                file.rmdir()
            except OSError:
                errors.append("absent_parent")
    if errors:
        state["restore_errors"] = sorted(set(errors))
        write_state(tx, state, "restore_failed")
        raise ReleaseError("snapshot restoration failed: " + ",".join(state["restore_errors"]))
    try:
        run(["systemctl", "daemon-reload"], "rollback reload")
        for unit, previous in state["services"].items():
            enabled = previous["enabled"]
            if enabled in {"enabled", "enabled-runtime"}:
                run(["systemctl", "enable", *(["--runtime"] if enabled == "enabled-runtime" else []), unit], "rollback enable")
            elif enabled == "masked":
                run(["systemctl", "mask", unit], "rollback mask")
            elif enabled in {"disabled", "not-found"}:
                run(["systemctl", "disable", unit], "rollback disable")
        # enable/disable may rewrite the top-level unit link. Reapply the exact
        # entry snapshot afterwards, before reloading/starting the old runtime.
        for entry in state["snapshot"]:
            if entry["scope"] == "units":
                file = unit_dir / entry["path"]
                remove(file)
                if entry["present"]:
                    copy(tx / "snapshot" / entry["backup"], file)
        run(["systemctl", "daemon-reload"], "rollback unit reload")
        for unit, previous in state["services"].items():
            if previous["active"]:
                run(["systemctl", "start", unit], "rollback start")
    except (ReleaseError, OSError):
        errors.append("service_restore")
    if errors:
        state["restore_errors"] = sorted(set(errors))
        write_state(tx, state, "restore_failed")
        raise ReleaseError("snapshot restoration failed: " + ",".join(state["restore_errors"]))
    state.pop("restore_errors", None)
    if finalize:
        write_state(tx, state, "restored")
        file = root / ".release-pending"
        if file.exists() and file.read_text().strip() == str(tx):
            file.unlink()


def overlay_command(tx, command):
    helper = Path(__file__).with_name("searxng-overlay.py")
    output, _ = run(["python3", helper, command, tx / "searxng"], "overlay " + command,
                    timeout=480)
    return json.loads(output)


def restore(tx, state, root, unit_dir):
    # Runtime's automatic restoration alone cannot undo an external overlay.
    # Attempt both sides even if one fails; preserve a pending retryable journal.
    # Refuse stale/superseded transactions before touching either side.
    if state["status"] == "committed":
        file = root / ".release-pending"
        current = root / ".release-current"
        if ((file.exists() and file.read_text().strip() != str(tx)) or not current.is_file()
                or current.read_text().strip() != str(tx)):
            raise ReleaseError("cannot restore a superseded committed release")
    elif state["status"] != "restored":
        pending(root, tx)
    overlay_errors = []
    if state.get("searxng"):
        try:
            overlay_command(tx, "restore")
            state.pop("overlay_restore_errors", None)
        except (ReleaseError, OSError, ValueError, subprocess.TimeoutExpired, Interrupted):
            overlay_errors.append("overlay_restore")
            try:
                errors = load(tx / "searxng/state.json").get("restore_errors", [])
                state["overlay_restore_errors"] = [e for e in errors if e in {
                    "snapshot_copy", "service_restore", "readiness_restore"}]
            except (OSError, ValueError):
                state["overlay_restore_errors"] = ["journal_unavailable"]
    runtime_error = None
    try:
        # Keep the pending marker until BOTH sides have restored. An overlay
        # failure must never briefly publish runtime's standalone success state,
        # even if the coordinator is interrupted before recording the failure.
        restore_runtime(tx, state, root, unit_dir, finalize=not state.get("searxng"))
    except (ReleaseError, OSError, Interrupted) as error:
        runtime_error = error
    if overlay_errors:
        state["restore_errors"] = sorted(set(state.get("restore_errors", []) + overlay_errors))
        text(root / ".release-pending", str(tx))
        write_state(tx, state, "restore_failed")
        raise ReleaseError("coordinated restoration failed: " + ",".join(state["restore_errors"]))
    if runtime_error:
        raise runtime_error
    if state.get("searxng"):
        write_state(tx, state, "restored")
        file = root / ".release-pending"
        if file.exists() and file.read_text().strip() == str(tx):
            file.unlink()


def validate_candidate(tx, state, root):
    candidate = tx / "candidate"
    verify(candidate, state["inventory"])
    provenance = load(tx / "provenance.json")
    if state["inventory"] != provenance["inventory"]:
        raise ReleaseError("transaction inventory differs from provenance")
    for name in ("runtime/gateway", "runtime/playwright-mcp"):
        if node_packages(candidate / name) != provenance["versions"]["node_packages"][name]:
            raise ReleaseError("staged Node dependency drift")
    env = dict(os.environ, PLAYWRIGHT_BROWSERS_PATH=str(root / "runtime/crawl4ai-browsers"),
               PLAYWRIGHT_SKIP_BROWSER_GC="1", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1")
    if python_packages(candidate, env) != provenance["versions"]["python_packages"]:
        raise ReleaseError("staged Python dependency drift")
    if digest(canonical(safe_configuration(root, candidate, env))) != provenance["safe_configuration_digest"]:
        raise ReleaseError("safe configuration changed after prepare")
    node_version, _ = run([root / "runtime/node/bin/node", "--version"], "Node prerequisite")
    if node_version != provenance["versions"]["node"]:
        raise ReleaseError("Node runtime changed after prepare")
    for path, version in provenance["versions"]["browsers"].items():
        observed, _ = run([root / path, "--version"], "browser prerequisite", env=env, timeout=15)
        if observed != version:
            raise ReleaseError("browser changed after prepare")


def activation(tx, state, root, unit_dir):
    pending(root, tx)
    if state["status"] != "prepared":
        raise ReleaseError("only a prepared transaction can activate")
    candidate = tx / "candidate"
    try:
        validate_candidate(tx, state, root)
        if state.get("searxng"):
            overlay_command(tx, "apply")
        write_state(tx, state, "activating")
        for unit in RUNTIME + TIMERS:
            run(["systemctl", "stop", unit], "activation stop")
        for name in state["obsolete"]:
            remove(root / name)
        for name, item in state["inventory"].items():
            file = root / name
            check_parents(file, root)
            remove(file)
            copy(candidate / name, file)
        if not exists(root / "config/playwright.env"):
            copy(candidate / "config/playwright.env", root / "config/playwright.env")
        for name in ("runtime/gateway/node_modules", "runtime/playwright-mcp/node_modules", "runtime/crawl4ai-venv"):
            file = root / name
            check_parents(file, root)
            remove(file)
            file.parent.mkdir(parents=True, exist_ok=True)
            file.symlink_to(candidate / name, target_is_directory=True)
        for unit in UNITS:
            if unit.startswith("web-access-artifact-cleanup."):
                continue  # Reuse the cleanup installer's authoritative contract.
            file = unit_dir / unit
            remove(file)
            file.symlink_to(root / "systemd" / unit)
        env = dict(os.environ, WAG_ROOT=str(root), WAG_SYSTEMD_DIR=str(unit_dir))
        run(["systemctl", "daemon-reload"], "activation reload")
        run(["systemctl", "enable", *RUNTIME, TIMERS[0]], "activation enable")
        run(["systemctl", "restart", *RUNTIME], "activation restart")
        run(["systemctl", "start", TIMERS[0]], "activation timers")
        run(["bash", root / "scripts/install-artifact-cleanup.sh"], "artifact cleanup installation", env=env)
        attempts = int(os.environ.get("WAG_RELEASE_ATTEMPTS", "12"))
        delay = float(os.environ.get("WAG_RELEASE_DELAY", "5"))
        seconds = int(os.environ.get("WAG_RELEASE_READY_SECONDS", "60"))
        if not (1 <= attempts <= 12 and 0 <= delay <= 5 and 1 <= seconds <= 600):
            raise ReleaseError("invalid readiness bounds")
        health = os.environ.get("WAG_RELEASE_HEALTHCHECK", str(root / "scripts/healthcheck.sh"))
        env = dict(os.environ, WAG_ROOT=str(root), WAG_SYSTEMD_DIR=str(unit_dir))
        deadline = time.monotonic() + seconds
        ready = False
        for _ in range(attempts):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            try:
                run(["bash", health, "--core-only"], "core readiness", env=env, timeout=min(47, remaining),
                    diagnostics=state.setdefault("readiness_diagnostics", []))
                ready = True
                break
            except (ReleaseError, subprocess.TimeoutExpired):
                pass
            time.sleep(min(delay, max(0, deadline - time.monotonic())))
        if not ready:
            raise ReleaseError("core readiness exhausted")
        try:
            run(["bash", health], "public readiness", env=env, timeout=47,
                diagnostics=state.setdefault("readiness_diagnostics", []))
            state["public_readiness"] = "passed"
        except (ReleaseError, subprocess.TimeoutExpired):
            state["public_readiness"] = "degraded"
        verify(root, state["inventory"])
        write_state(tx, state, "activated")
    except BaseException:
        restore(tx, state, root, unit_dir)
        raise


def interrupt(signum, frame):
    raise Interrupted("transaction interrupted")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    stage = sub.add_parser("prepare")
    stage.add_argument("source")
    stage.add_argument("--target", required=True)
    stage.add_argument("--units", required=True)
    stage.add_argument("--searxng-settings", help="opt in to coordinated reviewed overlay and runtime release")
    for name in ("activate", "commit", "abort", "restore", "status"):
        sub.add_parser(name).add_argument("transaction")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGHUP, interrupt)
    if args.command == "prepare":
        root = safe_root(args.target)
        with root_lock(root):
            if (root / ".release-pending").exists():
                raise ReleaseError("pending transaction must be committed or aborted first")
            tx = prepare(args)
            state = load(tx / "state.json")
            try:
                state["obsolete"] = obsolete(root, state["inventory"])
                snapshot(tx, state)
                if args.searxng_settings:
                    output, _ = run(["python3", Path(__file__).with_name("searxng-overlay.py"), "prepare",
                                     args.searxng_settings, tx / "candidate/config/searxng/settings-overlay.yml",
                                     "--backup", tx / "searxng"], "overlay snapshot")
                    state["searxng"] = json.loads(output)
                    provenance = load(tx / "provenance.json")
                    provenance["searxng"] = state["searxng"]
                    provenance["scope"] = "coordinated runtime and reviewed overlay; complete release acceptance pending"
                    save(tx / "provenance.json", provenance)
                save(tx / "state.json", state)
                text(root / ".release-pending", str(tx))
            except BaseException:
                shutil.rmtree(tx)
                raise
    else:
        tx, state, root, unit_dir = transaction(args.transaction)
        with root_lock(root):
            if args.command == "activate":
                activation(tx, state, root, unit_dir)
            elif args.command == "commit":
                pending(root, tx)
                if state["status"] != "activated":
                    raise ReleaseError("only an activated transaction can commit")
                try:
                    validate_candidate(tx, state, root)
                    if state.get("searxng"):
                        observed = overlay_command(tx, "verify")
                        if observed != state["searxng"] or observed != load(tx / "provenance.json").get("searxng"):
                            raise ReleaseError("effective overlay provenance drift")
                    verify(root, state["inventory"])
                    for name in ("runtime/gateway/node_modules", "runtime/playwright-mcp/node_modules", "runtime/crawl4ai-venv"):
                        file = root / name
                        if not file.is_symlink() or os.readlink(file) != str(tx / "candidate" / name):
                            raise ReleaseError("active dependency location drift")
                    write_state(tx, state, "committing")
                    text(root / ".release-current", str(tx))
                    write_state(tx, state, "committed")
                    (root / ".release-pending").unlink()
                except BaseException:
                    restore(tx, state, root, unit_dir)
                    raise
            elif args.command in {"abort", "restore"}:
                if args.command == "abort" and state["status"] == "committed":
                    raise ReleaseError("use restore for a committed release")
                restore(tx, state, root, unit_dir)
    print(json.dumps({"transaction": str(tx), "status": state["status"],
                      "public_readiness": state.get("public_readiness"),
                      "restore_errors": state.get("restore_errors", []),
                      "overlay_restore_errors": state.get("overlay_restore_errors", [])}))


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, Interrupted) as error:
        # ReleaseError messages are fixed stage labels and numeric exit codes.
        print(json.dumps({"ok": False, "error": str(error)}), file=sys.stderr)
        sys.exit(1)
    except (OSError, ValueError, KeyError, SyntaxError, subprocess.TimeoutExpired):
        # Never print raw subprocess/env/OS values (including dependency output).
        print('{"ok":false,"error":"runtime release prerequisite or filesystem failure"}', file=sys.stderr)
        sys.exit(1)
