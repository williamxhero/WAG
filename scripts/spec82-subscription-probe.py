"""SPEC82 isolated subscription validation; never a production subscription list."""
import argparse
import datetime
import hashlib
import http.client
import ipaddress
import json
import os
import re
import shutil
import subprocess
import socket
import ssl
import sys
import threading
import time
from urllib.parse import quote, unquote, urljoin, urlsplit, urlunsplit
import xml.etree.ElementTree as ET
from pathlib import Path


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


ROOT = Path(__file__).resolve().parents[1]


def evidence_bridge(request, node=None):
    executable = node or shutil.which("node")
    if not executable:
        raise ValueError("evidence_unavailable")
    try:
        result = subprocess.run([executable, str(ROOT / "gateway/spec82-subscription-evidence.mjs")], input=canonical(request), capture_output=True, timeout=15, check=True)
        if len(result.stdout) > 65536:
            raise ValueError("evidence_unavailable")
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise ValueError("evidence_unavailable") from None


SOURCE_FIELDS = ("name", "tier", "group", "route", "source_line", "note")


def load_catalog(path):
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    rows = [{key: row[key] for key in SOURCE_FIELDS} for row in data["rows"]]
    if data.get("count") != 91 or len(rows) != 91 or len({row["route"] for row in rows}) != 91:
        raise ValueError("invalid_catalog")
    for row in rows:
        if any(not isinstance(row[key], str) for key in SOURCE_FIELDS if key != "source_line") or not isinstance(row["source_line"], int):
            raise ValueError("invalid_catalog")
        if not row["route"].startswith("/") or row["route"].startswith("//") or any(char in row["route"] for char in "?#\\\\\r\n"):
            raise ValueError("invalid_catalog")
    return rows


def raw_date(value):
    value = str(value or "").strip()
    # Date-like characters only; never retain arbitrary XML/HTML text or credentials.
    if len(value) > 128 or not re.fullmatch(r"[0-9A-Za-z ,:+./年年月日时分秒\\-]+", value) or not re.search(r"\d{4}", value):
        return None
    if re.search(r"secret|token|password|bearer|api.?key", value, re.I):
        return None
    return value


def parse_feed(body):
    if len(body) > 1048576 or b'\x00' in body or re.search(br"<!DOCTYPE|<!ENTITY", body, re.I):
        raise ValueError("invalid_feed")
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        raise ValueError("invalid_feed") from None
    atom = "{http://www.w3.org/2005/Atom}"
    if root.tag == "rss" and root.find("channel") is not None:
        entries = root.findall("./channel/item")
        form, prefix = "rss", ""
    elif root.tag == atom + "feed":
        entries = root.findall(atom + "entry")
        form, prefix = "atom", atom
    else:
        raise ValueError("not_feed")
    entries = [entry for entry in entries if len(entry)]
    if not entries:
        raise ValueError("empty_feed")
    items = []
    for entry in entries:
        if prefix:
            links = entry.findall(prefix + "link")
            url = next((link.get("href", "") for link in links if link.get("rel", "alternate") == "alternate"), "")
        else:
            url = entry.findtext("link", "").strip()
        dates = []
        for field in (["published", "updated"] if prefix else ["pubDate"]):
            raw = raw_date(entry.findtext(prefix + field, ""))
            if raw:
                dates.append({"source": "feed.item." + field, "raw": raw})
        # Titles, summaries, GUIDs and feed-level dates are not page proof or durable data.
        items.append({"page_url": url, "feed_dates": dates})
    return {"format": form, "item_count": len(entries), "items": items}


POLICY = {"version": 1, "timeout": 10, "max_bytes": 1048576, "max_redirects": 2,
          "max_requests": 364, "global_per_minute": 30, "host_per_minute": 6}


def iso_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def isolated_origin(value):
    try:
        url = urlsplit(value)
        if url.scheme != "http" or url.hostname != "127.0.0.1" or url.username or url.password or url.path or url.query or url.fragment:
            raise ValueError()
        if url.port is None or not 1024 <= url.port <= 65535 or url.port in {8000, 8080, 8317}:
            raise ValueError()
        return f"http://127.0.0.1:{url.port}"
    except ValueError:
        raise ValueError("invalid_isolated_origin") from None


def publisher_url(value):
    try:
        if not isinstance(value, str) or len(value) > 2048 or any(ord(char) <= 32 for char in value) or "\\" in value:
            raise ValueError()
        url = urlsplit(value)
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ValueError()
        if url.port not in {None, 80 if url.scheme == "http" else 443} or "%" in url.hostname:
            raise ValueError()
        host = url.hostname.encode("idna").decode("ascii").lower()
        try:
            literal = ipaddress.ip_address(host)
        except ValueError:
            literal = None
        if literal is not None and not public_address(host):
            raise ValueError()
        decoded = unquote(url.path)
        # No secret-shaped/control path accepted; preserve encoded slash identity.
        if re.search(r"secret|token|password|api[_-]?key|bearer", decoded, re.I) or any(ord(char) < 32 for char in decoded) or re.search(r"%(?![0-9a-fA-F]{2})", url.path):
            raise ValueError()
        authority = f"[{host}]" if ":" in host else host
        return urlunsplit((url.scheme, authority, quote(url.path or "/", safe="/%:@-._~!$&'()*+,;="), "", ""))
    except (ValueError, UnicodeError):
        raise ValueError("unsafe_publisher_url") from None


def public_address(value):
    try:
        address = ipaddress.ip_address(value)
        return address.is_global and not (address.is_multicast or address.is_reserved or address.is_unspecified) and not (
            isinstance(address, ipaddress.IPv6Address) and (address.ipv4_mapped or address.sixtofour or address.teredo or address.scope_id))
    except ValueError:
        return False


def resolve_addresses(host, timeout):
    # A process bounds libc DNS too; no orphan DNS threads or connection-time second lookup.
    code = "import socket,json,sys; print(json.dumps(sorted({r[4][0] for r in socket.getaddrinfo(sys.argv[1],None,type=socket.SOCK_STREAM)})))"
    try:
        result = subprocess.run([sys.executable, "-c", code, host], capture_output=True, timeout=timeout, check=True)
        if len(result.stdout) > 8192:
            raise ValueError()
        return json.loads(result.stdout)
    except (OSError, ValueError, subprocess.SubprocessError):
        raise ValueError("dns_failed") from None


def connect_address(address, port, timeout):
    family = socket.AF_INET6 if ":" in address else socket.AF_INET
    connection = socket.socket(family, socket.SOCK_STREAM)
    try:
        connection.settimeout(timeout)
        connection.connect((address, port))
        return connection
    except Exception:
        connection.close()
        raise


class BoundedResponse(http.client.HTTPResponse):
    def begin(self):
        stream = self.fp
        class HeaderReader:
            remaining = 16384
            def readline(self, limit=-1):
                value = stream.readline(min(limit, self.remaining + 1) if limit >= 0 else self.remaining + 1)
                self.remaining -= len(value)
                if self.remaining < 0:
                    raise ValueError("header_cap")
                return value
        self.fp = HeaderReader()
        try:
            super().begin()
        finally:
            self.fp = stream


class SafeHTTP:
    """Direct, serial, pinned HTTP(S); trusted offline seams are never CLI options."""
    def __init__(self, journal, origin, policy=None, *, resolve=resolve_addresses, connect=connect_address,
                 context=None, clock=time.time, monotonic=time.monotonic, sleep=time.sleep):
        self.journal = journal
        self.origin = isolated_origin(origin)
        self.policy = dict(POLICY if policy is None else policy)
        if self.policy.keys() != POLICY.keys() or self.policy['version'] != 1 or any(
                type(self.policy[key]) not in ({int, float} if key == 'timeout' else {int})
                or not 0 < self.policy[key] <= upper for key, upper in POLICY.items()):
            raise ValueError("invalid_policy")
        self.resolve, self.connect = resolve, connect
        self.context = context or ssl.create_default_context()
        if not self.context.check_hostname or self.context.verify_mode != ssl.CERT_REQUIRED:
            raise ValueError("unsafe_tls_context")
        self.clock, self.monotonic, self.sleep = clock, monotonic, sleep

    def stopped(self):
        requests = {event["id"]: event for event in self.journal.events if event["type"] == "request"}
        finished = {event["request_id"] for event in self.journal.events if event["type"] == "response"}
        hosts = {event["host"]: event["cause"] for event in self.journal.events if event["type"] == "stop"}
        for key, event in requests.items():
            if key not in finished:
                hosts[event["host"]] = "interrupted_request"
        return hosts

    def reserve(self, host):
        while True:
            now = self.clock()
            requests = [event for event in self.journal.events if event["type"] == "request"]
            if len(requests) >= self.policy["max_requests"]:
                raise ValueError("request_cap")
            if any(event["at"] > now for event in requests):
                raise ValueError("clock_rollback")
            active = [event for event in requests if now - event["at"] < 60]
            local = [event for event in active if event["host"] == host]
            waits = []
            for records, cap in [(active, self.policy["global_per_minute"]), (local, self.policy["host_per_minute"])]:
                if len(records) >= cap:
                    waits.append(records[-int(cap)]["at"] + 60 - now)
            if not waits:
                return now
            self.sleep(max(waits) + 0.001)

    def fetch(self, value, kind, attempt_id):
        if kind not in {"feed", "page"} or any(event.get("id") == attempt_id and event["type"] == "attempt" for event in self.journal.events):
            raise ValueError("already_attempted")
        if kind == "feed":
            parsed = urlsplit(value)
            if value[:len(self.origin)] != self.origin or f"{parsed.scheme}://{parsed.netloc}" != self.origin or parsed.query or parsed.fragment:
                raise ValueError("unsafe_feed_url")
            url = value
        else:
            url = publisher_url(value)
        self.journal.append({"type": "attempt", "id": attempt_id, "kind": kind, "url": url})
        visited = {event["url"] for event in self.journal.events if event["type"] == "request" and event["kind"] == "page"}
        hops = 0
        while True:
            parsed = urlsplit(url)
            host = parsed.hostname
            if host in self.stopped():
                raise ValueError("host_stopped")
            if kind == "page" and url in visited:
                raise ValueError("page_already_requested")
            # Rate waits occur before the per-fetch network deadline begins.
            self.reserve(host)
            deadline = self.monotonic() + self.policy["timeout"] if hops == 0 else deadline
            if self.monotonic() >= deadline:
                raise ValueError("timeout")
            if kind == "feed":
                addresses = ["127.0.0.1"]
            else:
                addresses = self.resolve(host, deadline - self.monotonic())
                if not isinstance(addresses, list) or not addresses or len(addresses) > 32 or any(not public_address(address) for address in addresses):
                    raise ValueError("non_public_address")
            port = parsed.port or (443 if parsed.scheme == "https" else 80)
            request_id = f"{attempt_id}:{hops}"
            self.journal.append({"type": "request", "id": request_id, "attempt_id": attempt_id,
                                 "kind": kind, "url": url, "host": host, "address": addresses[0], "at": self.clock()})
            visited.add(url)
            connection = None
            sock = None
            timer = None
            try:
                remaining = deadline - self.monotonic()
                if remaining <= 0:
                    raise TimeoutError()
                sock = self.connect(addresses[0], port, remaining)
                def expire():
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                    sock.close()
                timer = threading.Timer(max(0.001, deadline - self.monotonic()), expire)
                timer.daemon = True
                timer.start()
                if parsed.scheme == "https":
                    sock = self.context.wrap_socket(sock, server_hostname=host)
                connection = http.client.HTTPConnection(host, port, timeout=remaining)
                connection.sock = sock
                connection.response_class = BoundedResponse
                connection.request("GET", parsed.path or "/", headers={"Host": parsed.netloc, "User-Agent": "WAG-SPEC82-Isolated-Probe/1",
                    "Accept-Encoding": "identity", "Accept": "application/rss+xml, application/atom+xml, text/html", "Connection": "close"})
                response = connection.getresponse()
                headers = response.getheaders()
                if sum(len(key) + len(item) for key, item in headers) > 16384:
                    raise ValueError("header_cap")
                status = response.status
                location = response.getheader("Location")
                if status in {403, 429}:
                    body = b""
                    cause = f"http_{status}"
                elif response.getheader("Content-Encoding", "identity").lower() != "identity":
                    raise ValueError("unsupported_encoding")
                else:
                    length = response.getheader("Content-Length")
                    if length is not None and (not length.isdecimal() or int(length) > self.policy["max_bytes"]):
                        raise ValueError("byte_cap")
                    body = response.read(int(self.policy["max_bytes"]) + 1)
                    if len(body) > self.policy["max_bytes"]:
                        raise ValueError("byte_cap")
                    if length is not None and len(body) != int(length):
                        raise ValueError("transport_error")
                    cause = None
                    if re.search(r"captcha|verify.{0,20}(?:human|browser)|cf-chl-|cloudflare|验证码|人机验证", body[:65536].decode("utf-8", errors="replace"), re.I):
                        cause = "captcha"
                    elif kind == "feed" and re.search(br"<!doctype\s+html|<html\b", body[:8192], re.I):
                        cause = "html_not_feed"
                if self.monotonic() >= deadline:
                    raise TimeoutError()
                self.journal.append({"type": "response", "request_id": request_id, "status": status,
                                     "sha256": digest(body), "retrieved_at": iso_now(), "cause": cause})
                if cause:
                    self.journal.append({"type": "stop", "host": host, "cause": cause})
                    raise ValueError(cause)
                if status in {301, 302, 303, 307, 308}:
                    if hops >= self.policy["max_redirects"] or not location:
                        raise ValueError("redirect_cap")
                    target = urljoin(url, location)
                    if kind == "page":
                        target = publisher_url(target)
                    elif not target.startswith(self.origin + "/") or urlsplit(target).netloc != urlsplit(self.origin).netloc or urlsplit(target).query or urlsplit(target).fragment:
                        raise ValueError("unsafe_feed_redirect")
                    url, hops = target, hops + 1
                    continue
                if status != 200:
                    raise ValueError("http_error")
                return {"body": body, "final_url": url, "sha256": digest(body), "retrieved_at": self.journal.events[-1]["retrieved_at"]}
            except (OSError, http.client.HTTPException) as error:
                cause = "timeout" if isinstance(error, TimeoutError) or self.monotonic() >= deadline else "tls_failed" if isinstance(error, ssl.SSLError) else "transport_error"
                self.journal.append({"type": "response", "request_id": request_id, "cause": cause})
                raise ValueError(cause) from None
            except ValueError as error:
                cause = safe_cause(error)
                if not any(event.get("request_id") == request_id and event["type"] == "response" for event in self.journal.events):
                    self.journal.append({"type": "response", "request_id": request_id, "cause": cause})
                raise ValueError(cause) from None
            finally:
                if timer:
                    timer.cancel()
                if connection:
                    connection.close()
                elif sock:
                    sock.close()


SAFE_CAUSES = {"already_attempted", "host_stopped", "page_already_requested", "request_cap", "clock_rollback",
               "timeout", "dns_failed", "non_public_address", "unsafe_publisher_url", "unsafe_feed_redirect",
               "header_cap", "byte_cap", "unsupported_encoding", "transport_error", "tls_failed", "http_403", "http_429",
               "captcha", "html_not_feed", "redirect_cap", "http_error", "invalid_feed", "not_feed", "empty_feed",
               "interrupted_attempt", "evidence_unavailable", "invalid_html_encoding"}


def safe_cause(error):
    return str(error) if type(error) is ValueError and str(error) in SAFE_CAUSES else "probe_error"


def run_probe(catalog, journal, http, *, node=None):
    feeds = {event["source"]["route"]: event for event in journal.events if event["type"] == "feed"}
    pages = {event["page_url"]: event for event in journal.events if event["type"] == "page"}
    for page in list(pages.values()):
        if page.get("final_url"):
            pages.setdefault(page["final_url"], page)
    samples = {(event["route"], event["page_url"]) for event in journal.events if event["type"] == "sample"}
    binding = journal.events[0]["binding"]
    for row in catalog:
        source_url = http.origin + quote(row["route"], safe="/")
        feed_id = "feed:" + digest(row["route"].encode())
        feed = feeds.get(row["route"])
        if feed is None:
            attempted = any(event.get("id") == feed_id and event["type"] == "attempt" for event in journal.events)
            try:
                if attempted:
                    raise ValueError("interrupted_attempt")
                response = http.fetch(source_url, "feed", feed_id)
                parsed = parse_feed(response["body"])
                items, rejected = [], 0
                for item in parsed["items"]:
                    try:
                        url = publisher_url(item["page_url"])
                    except ValueError:
                        rejected += 1
                        continue
                    if url not in {entry["page_url"] for entry in items}:
                        items.append({**item, "page_url": url})
                feed = {"type": "feed", "source": row, "source_url": source_url, "status": "ok", "cause": None,
                        "final_url": response["final_url"], "sha256": response["sha256"], "retrieved_at": response["retrieved_at"],
                        "format": parsed["format"], "item_count": parsed["item_count"], "rejected_urls": rejected, "items": items[:3]}
            except ValueError as error:
                cause = safe_cause(error)
                feed = {"type": "feed", "source": row, "source_url": source_url, "status": "blocked" if cause in {"http_403", "http_429", "captcha", "html_not_feed", "host_stopped", "request_cap", "interrupted_attempt"} else "failed",
                        "cause": cause, "no_request": not any(event.get("attempt_id") == feed_id for event in journal.events), "items": []}
            journal.append(feed)
            feeds[row["route"]] = feed
        for item in feed["items"]:
            url = item["page_url"]
            if (row["route"], url) in samples:
                continue
            page_id = "page:" + digest(url.encode())
            page = pages.get(url)
            if page is None:
                attempted = any(event.get("id") == page_id and event["type"] == "attempt" for event in journal.events)
                try:
                    if attempted:
                        raise ValueError("interrupted_attempt")
                    response = http.fetch(url, "page", page_id)
                    try:
                        html = response["body"].decode("utf-8-sig")
                    except UnicodeError:
                        raise ValueError("invalid_html_encoding") from None
                    evidence = evidence_bridge({"operation": "evaluate", "now": binding["now"], "window": binding["window"]["window"],
                        "html": html, "page_url": response["final_url"], "validated_url": response["final_url"],
                        "retrieved_at": response["retrieved_at"], "feed_dates": item["feed_dates"]}, node)
                    page = {"type": "page", "id": page_id, "page_url": url, "status": "ok", "cause": None,
                            **{key: response[key] for key in ("final_url", "sha256", "retrieved_at")}, **evidence}
                except ValueError as error:
                    page = {"type": "page", "id": page_id, "page_url": url, "status": "blocked", "cause": safe_cause(error),
                            "classification": "unknown", "no_request": not any(event.get("attempt_id") == page_id for event in journal.events)}
                journal.append(page)
                pages[url] = page
                if page.get("final_url"):
                    pages.setdefault(page["final_url"], page)
            journal.append({"type": "sample", "route": row["route"], "source_url": source_url, "page_url": url,
                            "page_id": page["id"], "feed_dates": item["feed_dates"]})
            samples.add((row["route"], url))
    return aggregate(journal.events, catalog)


def aggregate(events, catalog):
    pages = {event["id"]: event for event in events if event["type"] == "page"}
    feeds = {event["source"]["route"]: event for event in events if event["type"] == "feed"}
    reports = []
    for row in catalog:
        observed, classifications, seen = 0, {}, set()
        for event in events:
            if event["type"] != "sample" or event["route"] != row["route"]:
                continue
            page = pages[event["page_id"]]
            final = page.get("final_url")
            if page["status"] != "ok" or not final or final in seen:
                continue
            seen.add(final)
            observed += 1
            label = page["classification"]
            classifications[label] = classifications.get(label, 0) + 1
        feed = feeds.get(row["route"], {})
        reports.append({"source": row, "feed_status": feed.get("status", "not_checked"), "cause": feed.get("cause"),
                        "sample_denominator": 3, "observed_unique_pages": observed, "short_samples": max(0, 3 - observed),
                        "classifications": classifications, "verified_coverage": classifications.get("verified", 0) / 3,
                        "accuracy": None})
    counts = {kind: sum(event["type"] == kind for event in events) for kind in ("attempt", "request", "response", "feed", "page", "sample", "stop")}
    return {"kind": "coverage_only_not_accuracy", "synthetic": events[0]["binding"].get("synthetic", False),
            "sources": reports, "sample_denominator": 3 * len(catalog), "raw_event_counts": counts,
            "observed_unique_pages": len({page["final_url"] for page in pages.values() if page["status"] == "ok"}),
            "observed_source_samples": sum(row["observed_unique_pages"] for row in reports),
            "verified_pages": sum(row["classifications"].get("verified", 0) for row in reports), "accuracy": None}


def validate_event(event, events):
    if not isinstance(event, dict):
        raise ValueError("journal_schema")
    kind = event.get("type")
    required = {
        "run": {"type", "binding"}, "attempt": {"type", "id", "kind", "url"},
        "request": {"type", "id", "attempt_id", "kind", "url", "host", "address", "at"},
        "response": {"type", "request_id", "cause"}, "stop": {"type", "host", "cause"},
        "feed": {"type", "source", "source_url", "status", "cause", "items"},
        "page": {"type", "id", "page_url", "status", "cause", "classification"},
        "sample": {"type", "route", "source_url", "page_url", "page_id", "feed_dates"},
    }
    optional = {"response": {"status", "sha256", "retrieved_at"},
                "feed": {"final_url", "sha256", "retrieved_at", "format", "item_count", "rejected_urls", "no_request"},
                "page": {"final_url", "sha256", "retrieved_at", "window", "evidence", "raw_fields", "feed_dates", "no_request"}}
    if kind not in required or not required[kind] <= event.keys() or not event.keys() <= required[kind] | optional.get(kind, set()):
        raise ValueError("journal_schema")
    if (not events) != (kind == "run"):
        raise ValueError("journal_state")
    if kind == "run":
        if not isinstance(event["binding"], dict):
            raise ValueError("journal_schema")
        return
    if "cause" in event and event["cause"] is not None and event["cause"] not in SAFE_CAUSES | {"probe_error"}:
        raise ValueError("journal_schema")
    for key in {"id", "request_id", "attempt_id", "host", "url", "route", "source_url", "page_url", "page_id"} & event.keys():
        if not isinstance(event[key], str) or not event[key] or len(event[key]) > 2048:
            raise ValueError("journal_schema")
    if kind in {"attempt", "request", "page"} and any(old["type"] == kind and old["id"] == event["id"] for old in events):
        raise ValueError("journal_state")
    if kind in {"attempt", "request"}:
        if event["kind"] not in {"feed", "page"}:
            raise ValueError("journal_schema")
        if event["kind"] == "page" and publisher_url(event["url"]) != event["url"]:
            raise ValueError("journal_schema")
        if event["kind"] == "feed":
            url = urlsplit(event["url"])
            isolated_origin(f"{url.scheme}://{url.netloc}")
            if url.query or url.fragment:
                raise ValueError("journal_schema")
    if kind == "request":
        attempts = [old for old in events if old["type"] == "attempt" and old["id"] == event["attempt_id"]]
        if not attempts or attempts[0]["kind"] != event["kind"] or event["host"] != urlsplit(event["url"]).hostname:
            raise ValueError("journal_state")
        if type(event["at"]) not in {int, float} or not 0 <= event["at"] < 1e12:
            raise ValueError("journal_schema")
        if event["kind"] == "page" and not public_address(event["address"]):
            raise ValueError("journal_schema")
        if event["kind"] == "feed" and event["address"] != "127.0.0.1":
            raise ValueError("journal_schema")
    if kind == "response":
        if not any(old["type"] == "request" and old["id"] == event["request_id"] for old in events) or any(old["type"] == "response" and old["request_id"] == event["request_id"] for old in events):
            raise ValueError("journal_state")
    if kind == "feed":
        if not isinstance(event["source"], dict) or set(event["source"]) != set(SOURCE_FIELDS) or not isinstance(event["items"], list) or len(event["items"]) > 3:
            raise ValueError("journal_schema")
        if any(old["type"] == "feed" and old["source"]["route"] == event["source"]["route"] for old in events):
            raise ValueError("journal_state")
        for item in event["items"]:
            if set(item) != {"page_url", "feed_dates"} or publisher_url(item["page_url"]) != item["page_url"]:
                raise ValueError("journal_schema")
    if kind == "page":
        if publisher_url(event["page_url"]) != event["page_url"] or event["classification"] not in {"verified", "claimed", "unknown", "conflicting", "out_of_window"}:
            raise ValueError("journal_schema")
    if kind in {"feed", "page"} and event["status"] not in {"ok", "blocked", "failed"}:
        raise ValueError("journal_schema")
    if kind == "sample":
        feed = next((old for old in events if old["type"] == "feed" and old["source"]["route"] == event["route"]), None)
        prior = [old for old in events if old["type"] == "sample" and old["route"] == event["route"]]
        if not feed or len(prior) >= 3 or any(old["page_url"] == event["page_url"] for old in prior) or not any(old["type"] == "page" and old["id"] == event["page_id"] for old in events):
            raise ValueError("journal_state")
        if {"page_url": event["page_url"], "feed_dates": event["feed_dates"]} not in feed["items"] or event["source_url"] != feed["source_url"]:
            raise ValueError("journal_state")


class Journal:
    """One writer; incomplete lines or changed run identity never permit more requests."""
    def __init__(self, path, binding):
        self.path = Path(path)
        self.events = []
        self.previous = "0" * 64
        self.lock = None
        self.file = None
        try:
            if self.path.is_symlink() or self.path.with_suffix(".lock").is_symlink():
                raise ValueError("unsafe_artifact")
            self.lock = self.path.with_suffix(".lock").open("a+b")
            self.lock.seek(0)
            if os.name == "nt":
                import msvcrt
                if self.lock.read(1) == b"":
                    self.lock.write(b"0")
                    self.lock.flush()
                self.lock.seek(0)
                msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if self.path.exists():
                if self.path.stat().st_size > 16 * 1024 * 1024:
                    raise ValueError("journal_too_large")
                with self.path.open("rb") as stored:
                    for line in stored:
                        if not line.endswith(b"\n"):
                            raise ValueError("journal_corrupt")
                        envelope = json.loads(line)
                        event = envelope["event"]
                        expected = digest(canonical({"seq": len(self.events), "previous": self.previous, "event": event}))
                        if envelope != {"seq": len(self.events), "previous": self.previous, "event": event, "hash": expected}:
                            raise ValueError("journal_corrupt")
                        validate_event(event, self.events)
                        self.events.append(event)
                        self.previous = expected
                if not self.events or self.events[0] != {"type": "run", "binding": binding}:
                    raise ValueError("resume_mismatch")
                self.file = self.path.open("ab")
            else:
                self.file = self.path.open("xb")
                self.append({"type": "run", "binding": binding})
        except Exception:
            self.close()
            raise ValueError("journal_unavailable_or_mismatch") from None

    def append(self, event):
        if self.file is None:
            raise ValueError("journal_closed")
        validate_event(event, self.events)
        if len(self.events) >= 3000:
            raise ValueError("journal_event_cap")
        payload = {"seq": len(self.events), "previous": self.previous, "event": event}
        checksum = digest(canonical(payload))
        line = canonical({**payload, "hash": checksum}) + b"\n"
        if len(line) > 512 * 1024:
            raise ValueError("event_too_large")
        try:
            self.file.write(line)
            self.file.flush()
            os.fsync(self.file.fileno())
        except BaseException:
            self.close()
            raise ValueError("journal_write_failed") from None
        self.events.append(event)
        self.previous = checksum

    def close(self):
        if self.file:
            self.file.close()
            self.file = None
        if self.lock:
            self.lock.close()
            self.lock = None

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def make_binding(catalog_path, origin, now, window):
    rows = load_catalog(catalog_path)
    resolved = evidence_bridge({"operation": "window", "now": now, "window": window})
    implementation = ["scripts/spec82-subscription-probe.py", "gateway/spec82-subscription-evidence.mjs",
                      "gateway/evidence-metadata.mjs", "gateway/spec82-evidence.mjs", "gateway/news-verified.mjs"]
    return {"version": 1, "synthetic": False, "catalog_sha256": digest(Path(catalog_path).read_bytes()),
            "catalog": rows, "origin": isolated_origin(origin), "now": resolved["evaluated_at"], "window": resolved,
            "policy": POLICY, "implementation": {path: digest((ROOT / path).read_bytes()) for path in implementation},
            "operator_robots_terms_approved": True}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Isolated SPEC82 coverage only; no retries, no accuracy claim.")
    parser.add_argument("operation", choices=["run", "aggregate"])
    parser.add_argument("--artifact", required=True)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--now", required=True, help="Fixed ISO clock; reuse exactly on resume.")
    parser.add_argument("--window", choices=["rolling_24h", "calendar_today"], default="rolling_24h")
    parser.add_argument("--operator-approved", action="store_true", help="Explicit isolated-origin ownership and robots/terms approval.")
    args = parser.parse_args(argv)
    try:
        path = Path(args.artifact).absolute()
        if path.suffix != ".jsonl" or not path.parent.is_dir() or path.resolve().is_relative_to(ROOT.resolve()):
            raise ValueError("invalid_artifact")
        if args.operation == "run" and not args.operator_approved:
            raise ValueError("operator_approval_required")
        if args.operation == "aggregate" and not path.is_file():
            raise ValueError("missing_artifact")
        binding = make_binding(ROOT / "docs/subscription-validation-20261013.json", args.origin, args.now, args.window)
        with Journal(path, binding) as journal:
            report = run_probe(binding["catalog"], journal, SafeHTTP(journal, binding["origin"])) if args.operation == "run" else aggregate(journal.events, binding["catalog"])
        sys.stdout.buffer.write(canonical(report) + b"\n")
        return 0
    except KeyboardInterrupt:
        sys.stderr.write("subscription_probe_interrupted_resume_same_binding\n")
        return 130
    except Exception:
        # Never echo CLI URLs, raw exception causes, response headers or HTML.
        sys.stderr.write("subscription_probe_failed_closed\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
