#!/usr/bin/env python3
"""Bounded, redacted command diagnostics and core/public readiness classification."""
import json
import os
import re
import sys
from urllib.parse import urlsplit, urlunsplit


SECRETS = sorted((value for key, value in os.environ.items() if value and re.search(r"token|secret|password|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key", key, re.I)), key=len, reverse=True)


def sanitize(value):
    text = str(value or "")
    for secret in SECRETS:
        text = text.replace(secret, "[redacted]")
    text = re.sub(r"\b(?:proxy-)?authorization[\"']?\s*[:=]\s*[^\r\n]+", "[redacted header]", text, flags=re.I)
    text = re.sub(r"\bBearer\s+[^\s,\"'<>]+", "Bearer [redacted]", text, flags=re.I)

    def safe_url(match):
        try:
            url = urlsplit(match[0])
            host = url.hostname or ""
            if ":" in host:
                host = f"[{host}]"
            if url.port:
                host += f":{url.port}"
            return urlunsplit((url.scheme, host, url.path, "", ""))
        except ValueError:
            return "[redacted URL]"

    text = re.sub(r"https?://[^\s\"'<>]+", safe_url, text, flags=re.I)
    text = re.sub(r"\b([\w-]*(?:token|secret|password|api[_-]?key|credential|private[_-]?key|access[_-]?key)[\w-]*)[\"']?\s*[:=]\s*[\"']?[^\s,;\"']+", r"\1=[redacted]", text, flags=re.I)
    return re.sub(r"[\x00-\x1f\x7f]", " ", text)[:240]


def read(path):
    if not path:
        return ""
    with open(path, "rb") as stream:
        data = stream.read(65537)
    if len(data) > 65536:
        raise ValueError("dependency response exceeds 64 KiB")
    return data.decode("utf-8", errors="replace")


def engines(value):
    if not isinstance(value, list):
        return []
    return [[sanitize(part) for part in item[:2]] if isinstance(item, list) else sanitize(item) for item in value[:20]]


def dependencies(items):
    result = []
    for item in items[:20]:
        if not isinstance(item, dict):
            continue
        detail = {key: sanitize(item[key]) for key in ("name", "scope", "lifecycle") if key in item}
        for key in ("ok", "initialized", "http_status", "duration_ms", "result_count"):
            if isinstance(item.get(key), (bool, int, float)):
                detail[key] = item[key]
        if isinstance(item.get("error"), dict):
            detail["error"] = {key: sanitize(item["error"][key]) for key in ("kind", "message", "code", "http_status") if key in item["error"]}
        if "unresponsive_engines" in item:
            detail["unresponsive_engines"] = engines(item["unresponsive_engines"])
        result.append(detail)
    return result


def main():
    layer, code, mode, body_path, error_path, status_path = sys.argv[1:]
    code = int(code)
    report = {"layer": layer, "ok": False}

    def finish(exit_code, kind=None, message=None):
        report["ok"] = exit_code == 0
        if kind:
            report["error"] = {"kind": kind, "message": sanitize(message)}
        print(json.dumps(report, ensure_ascii=True), file=sys.stdout if exit_code == 0 else sys.stderr)
        return exit_code

    try:
        body = read(body_path)
        error = read(error_path)
        status = read(status_path).strip()
        if code:
            report["exit_code"] = code
            categories = {6: "curl_dns", 7: "curl_connect", 28: "curl_timeout", 35: "curl_tls", 51: "curl_tls", 60: "curl_tls", 124: "command_timeout", 137: "command_timeout"}
            return finish(1, categories.get(code, "curl_error") if mode != "command" else "command_timeout" if code in (124, 137) else "command_error", error or body or f"command exited {code}")
        if mode == "command":
            if layer == "proxy-restarts":
                if not body.strip().isdigit():
                    raise ValueError("systemctl returned an invalid restart count")
                report["count"] = int(body.strip())
            elif body.strip():
                report["detail"] = sanitize(body)
            return finish(0)
        if not status.isdigit():
            return finish(1, "invalid_http_status", "curl returned no HTTP status")
        http_status = int(status)
        report["http_status"] = http_status
        if mode == "playwright":
            return finish(0) if http_status in (200, 400, 405, 406) else finish(1, "dependency_http_status", f"Playwright returned HTTP {http_status}: {body}")
        if mode not in ("ready", "ready-core") and not 200 <= http_status < 300:
            return finish(1, "dependency_http_status", f"HTTP {http_status}: {body}")
        if mode == "http":
            return finish(0)
        data = json.loads(body)
        if not isinstance(data, dict):
            raise ValueError("dependency response must be an object")
        if mode in ("ready", "ready-core"):
            if not all(isinstance(data.get(key), bool) for key in ("ok", "core_ok", "public_connectivity_ok")) or not isinstance(data.get("dependencies"), list):
                raise ValueError("gateway response lacks core/public readiness classification")
            if data["ok"] != (data["core_ok"] and data["public_connectivity_ok"]):
                raise ValueError("inconsistent gateway readiness classification")
            if http_status != (200 if data["ok"] else 503):
                return finish(1, "dependency_http_status", f"Readiness returned unexpected HTTP {http_status}: {body}")
            report.update(core_ok=data["core_ok"], public_connectivity_ok=data["public_connectivity_ok"], dependencies=dependencies(data["dependencies"]))
            if not data["core_ok"]:
                return finish(1, "core_failure", "Core capability readiness failed")
            if mode == "ready-core":
                return finish(0)
            if not data["public_connectivity_ok"]:
                return finish(2, "public_connectivity", "Public-connectivity readiness degraded")
            return finish(0)
        if mode == "search":
            if not isinstance(data.get("results"), list):
                raise ValueError("SearXNG response must contain a results array")
            report["unresponsive_engines"] = engines(data.get("unresponsive_engines"))
            usable = set()
            for item in data["results"]:
                if not isinstance(item, dict) or not isinstance(item.get("url"), str):
                    continue
                if any(item.get(key) is not None and not isinstance(item[key], str) for key in ("title", "content")):
                    continue
                url = urlsplit(item["url"])
                if url.scheme in ("http", "https") and url.hostname and not url.username and not url.password and ((isinstance(item.get("title"), str) and item["title"].strip()) or (isinstance(item.get("content"), str) and item["content"].strip())):
                    usable.add(item["url"])
            if not usable:
                return finish(1, "search_empty", "SearXNG returned no usable results")
            report["result_count"] = min(20, len(usable))
            return finish(0)
        raise ValueError("unsupported healthcheck validation mode")
    except (ValueError, OSError) as exc:
        return finish(1, "dependency_invalid_data", str(exc))


if __name__ == "__main__":
    sys.exit(main())
