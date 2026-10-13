"""Explicit synthetic/offline acceptance, NOT live 91-source coverage."""
import contextlib
import http.server
import importlib.util
import socket
import shutil
import ssl
import subprocess
import threading
import time
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("subscription_probe", ROOT / "scripts/spec82-subscription-probe.py")
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
CATALOG = ROOT / "docs/subscription-validation-20261013.json"
CLOCK = "2026-10-13T04:00:00.000Z"


@contextlib.contextmanager
def fixture(respond, tls=None):
    received = []
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            received.append({"path": self.path, "host": self.headers.get("Host"),
                             "authorization": self.headers.get("Authorization"), "cookie": self.headers.get("Cookie")})
            respond(self)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    if tls:
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield server.server_port, received
    finally:
        server.shutdown()
        server.server_close()
        thread.join(2)


def reply(handler, body=b'<article>synthetic</article>', status=200, headers=None):
    handler.send_response(status)
    for key, value in (headers or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    try:
        handler.wfile.write(body)
        handler.wfile.flush()
    except (OSError, ssl.SSLError):
        pass


class ProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wag99-synthetic-")
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def test_catalog_exact_91_identity_and_duplicate_fail_closed(self):
        rows = probe.load_catalog(CATALOG)
        self.assertEqual(len(rows), 91)
        self.assertEqual(rows[0], {"name": "中国政府网 · 最新政策", "tier": "T1", "group": "T1 官方（22 个）",
                                  "route": "/gov/zhengce/zuixin", "source_line": 13, "note": ""})
        original = json.loads(CATALOG.read_text(encoding="utf-8"))
        for row, source in zip(rows, original["rows"]):
            self.assertEqual(row, {key: source[key] for key in rows[0]})
        original["rows"][-1]["route"] = original["rows"][0]["route"]
        path = self.directory / "duplicate.json"
        path.write_text(json.dumps(original), encoding="utf-8")
        with self.assertRaises(ValueError):
            probe.load_catalog(path)
        original["rows"].pop()
        path.write_text(json.dumps(original), encoding="utf-8")
        with self.assertRaises(ValueError):
            probe.load_catalog(path)

    def test_journal_fsync_binding_resume_corruption_and_exclusive_writer(self):
        path = self.directory / "evidence.jsonl"
        binding = {"catalog": "synthetic", "window": CLOCK, "origin": "http://127.0.0.1:18081", "policy": 1}
        calls = []
        fsync = os.fsync
        with patch.object(probe.os, "fsync", side_effect=lambda fd: (calls.append(fd), fsync(fd))):
            with probe.Journal(path, binding) as journal:
                journal.append({"type": "attempt", "id": "feed:0", "kind": "feed", "url": "http://127.0.0.1:18081/r"})
                self.assertEqual(len(calls), 2, "run and attempt must both be durable")
                with self.assertRaises(ValueError):
                    probe.Journal(path, binding)
        with probe.Journal(path, binding) as resumed:
            self.assertEqual(len(resumed.events), 2)
        for key in binding:
            with self.subTest(key=key), self.assertRaises(ValueError):
                probe.Journal(path, {**binding, key: "changed"})
        contents = path.read_bytes()
        path.write_bytes(contents[:-1])
        with self.assertRaises(ValueError):
            probe.Journal(path, binding)
        path.write_bytes(contents.replace(b"feed:0", b"feed:1"))
        with self.assertRaises(ValueError):
            probe.Journal(path, binding)

    def test_rss_atom_require_real_structure_and_dates_remain_raw_claims(self):
        rss = b'<rss version="2.0"><channel><item><link>https://synthetic.example/a</link><pubDate>Tue, 13 Oct 2026 03:30:00 GMT</pubDate></item></channel></rss>'
        parsed = probe.parse_feed(rss)
        self.assertEqual(parsed["format"], "rss")
        self.assertEqual(parsed["item_count"], 1)
        self.assertEqual(parsed["items"], [{"page_url": "https://synthetic.example/a", "feed_dates": [{"source": "feed.item.pubDate", "raw": "Tue, 13 Oct 2026 03:30:00 GMT"}]}])
        atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><link href="https://synthetic.example/a"/><published>2026-10-13T03:30Z</published></entry></feed>'.encode()
        self.assertEqual(probe.parse_feed(atom)["format"], "atom")
        self.assertEqual(probe.parse_feed(atom)["item_count"], 1)
        for body in [b'<html><item>not a feed</item></html>', b'<rss><channel/></rss>', b'<rss><item><link>https://synthetic.example/a</link></item></rss>', b'<rss><channel><item/></channel></rss>', b'<feed xmlns="http://www.w3.org/2005/Atom"/>', b'<!DOCTYPE rss [<!ENTITY x "private">]><rss><channel><item><title>&x;</title></item></channel></rss>']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                probe.parse_feed(body)

    def evidence(self, html, **overrides):
        request = {"operation": "evaluate", "now": CLOCK, "window": "rolling_24h", "html": html,
                   "page_url": "https://synthetic.example/a", "validated_url": "https://synthetic.example/a",
                   "retrieved_at": CLOCK, "feed_dates": [], **overrides}
        return probe.evidence_bridge(request)

    def test_actual_html_evidence_matched_url_gate_precision_claims_and_noise(self):
        html = '<meta name="pubdate" content="2026-10-13T03:30Z">'
        self.assertEqual(self.evidence(html)["classification"], "verified")
        self.assertEqual(self.evidence(html, page_url="https://synthetic.example/other")["classification"], "unknown")
        self.assertEqual(self.evidence('<script type="application/ld+json">{"@type":"NewsArticle","url":"https://synthetic.example/other","datePublished":"2026-10-13T03:30Z"}</script>')["classification"], "unknown")
        cases = [
            ('<article><p>发布时间：2026-10-13T03:30Z</p></article>', "verified"),
            ('<article><p>发布日期：2026年10月13日</p></article>', "unknown"),
            ('<article><p>发布时间：2026-10-13 11:30</p></article>', "unknown"),
            ('<meta name="pubdate" content="2026-02-30T03:30Z">', "unknown"),
            ('<meta name="pubdate" content="2026-10-13T04:00:00.001Z">', "unknown"),
            ('<article><time datetime="2026-10-13T03:30Z">Event</time></article>', "unknown"),
            ('<script type="application/ld+json">{"@type":"Event","datePublished":"2026-10-13T03:30Z"}</script>', "unknown"),
            ('<article><aside>发布时间：2026年10月13日</aside></article>', "unknown"),
            ('<meta name="pubdate" content="2026-10-12T04:00Z">', "verified"),
            ('<meta name="pubdate" content="2026-10-12T03:59:59.999Z">', "out_of_window"),
        ]
        for body, expected in cases:
            with self.subTest(body=body):
                self.assertEqual(self.evidence(body)["classification"], expected)
        day = self.evidence('<article><p>发布日期：2026年10月13日</p></article>', window="calendar_today")
        self.assertEqual(day["classification"], "verified")
        self.assertEqual(day["evidence"]["precision"], "day")
        self.assertIsNone(day["evidence"]["published_at"])
        claim = self.evidence('<article>no date</article>', feed_dates=[{"source": "feed.item.pubDate", "raw": "2026-10-13T03:30Z"}])
        self.assertEqual(claim["classification"], "claimed")
        self.assertEqual(claim["evidence"]["evidence_level"], "E4")
        safe = self.evidence(html + '<meta name="author" content="SECRET-BODY"><script type="application/ld+json">{"@type":"NewsArticle","author":"SECRET-BODY"}</script>')
        self.assertNotIn("SECRET-BODY", json.dumps(safe))

    def journal(self, name="run", **binding):
        journal = probe.Journal(self.directory / f"{name}.jsonl", {"synthetic": True, **binding})
        self.addCleanup(journal.close)
        return journal

    def http(self, journal, port, addresses=None, **options):
        return probe.SafeHTTP(journal, f"http://127.0.0.1:{port}",
            resolve=lambda host, timeout: addresses or ["8.8.8.8"],
            connect=lambda address, remote_port, timeout: socket.create_connection(("127.0.0.1", port), timeout), **options)

    def test_mixed_dns_and_redirect_private_userinfo_are_refused_before_target_socket(self):
        def respond(handler):
            redirects = {"/private": "http://127.0.0.1/secret", "/mixed": "https://mixed.synthetic/a",
                         "/userinfo": "https://user:SECRET@synthetic.example/a", "/scheme": "file:///private",
                         "/query": "https://synthetic.example/a?token=SECRET"}
            reply(handler, status=302, headers={"Location": redirects[handler.path]})
        with fixture(respond) as (port, received):
            mixed = self.http(self.journal("mixed"), port, ["8.8.8.8", "127.0.0.1"])
            with self.assertRaisesRegex(ValueError, "non_public_address"):
                mixed.fetch("http://synthetic.example/mixed", "page", "page:mixed")
            self.assertEqual(received, [], "any private DNS answer forbids the initial socket")
            for index, path in enumerate(["private", "userinfo", "scheme", "query"]):
                http = self.http(self.journal(str(index)), port)
                with self.assertRaises(ValueError):
                    http.fetch(f"http://synthetic.example/{path}", "page", f"page:{index}")
                self.assertEqual(len(received), index + 1)
                self.assertNotIn("SECRET", http.journal.path.read_text())
        for address in ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:8.8.8.8", "2002:0808:0808::1", "224.0.0.1", "100.64.0.1"]:
            self.assertFalse(probe.public_address(address), address)

    def test_run_three_unique_global_dedupe_durable_resume_and_raw_aggregate(self):
        rows = probe.load_catalog(CATALOG)[:2]
        items = ''.join(f'<item><link>http://synthetic.example/{path}</link></item>' for path in ['a', 'a', 'b', 'c', 'd'])
        feed = f'<rss><channel>{items}</channel></rss>'.encode()
        def respond(handler):
            if handler.path.startswith('/gov/'):
                reply(handler, feed)
            else:
                reply(handler, b'<meta name="pubdate" content="2026-10-13T03:30Z">')
        with fixture(respond) as (port, received):
            window = probe.evidence_bridge({"operation": "window", "window": "rolling_24h", "now": CLOCK})
            journal = self.journal("engine", now=CLOCK, window=window)
            http = self.http(journal, port)
            report = probe.run_probe(rows, journal, http)
            self.assertEqual([entry['path'] for entry in received if not entry['path'].startswith('/gov/')], ['/a', '/b', '/c'])
            self.assertEqual(report['sample_denominator'], 6)
            self.assertEqual(report['verified_pages'], 6)
            self.assertEqual(report['observed_unique_pages'], 3, 'global final-page dedupe must not count shared source slots twice')
            self.assertEqual(report['raw_event_counts']['page'], 3)
            self.assertEqual(report['raw_event_counts']['sample'], 6)
            self.assertIsNone(report['accuracy'])
            before = len(received)
            self.assertEqual(probe.run_probe(rows, journal, http), report)
            self.assertEqual(len(received), before)
            binding, path = journal.events[0]['binding'], journal.path
            journal.close()
            with probe.Journal(path, binding) as resumed:
                self.assertEqual(probe.run_probe(rows, resumed, self.http(resumed, port)), report)
                self.assertEqual(len(received), before)

    def test_http_terminal_bounds_truncation_and_stop_have_no_secret_body(self):
        def respond(handler):
            if handler.path == '/truncated':
                reply(handler, b'abc', headers={'Content-Length': '20'})
            elif handler.path == '/large':
                reply(handler, b'x' * 101)
            elif handler.path == '/headers':
                reply(handler, headers={'X-Synthetic': 'x' * 17000})
            elif handler.path == '/gzip':
                reply(handler, headers={'Content-Encoding': 'gzip'})
            elif handler.path == '/slow':
                time.sleep(0.3)
                reply(handler)
            elif handler.path == '/redirect':
                reply(handler, status=302, headers={'Location': '/redirect'})
            elif handler.path in ['/403', '/429']:
                reply(handler, b'SECRET-BODY', status=int(handler.path[1:]))
            else:
                reply(handler, b'<html>CAPTCHA SECRET-BODY</html>')
        cases = [('truncated', 'transport_error'), ('large', 'byte_cap'), ('headers', 'header_cap'),
                 ('gzip', 'unsupported_encoding'), ('slow', 'timeout'), ('redirect', 'page_already_requested'),
                 ('403', 'http_403'), ('429', 'http_429'), ('captcha', 'captcha')]
        with fixture(respond) as (port, received):
            for path, cause in cases:
                with self.subTest(path=path):
                    journal = self.journal(path)
                    http = self.http(journal, port, policy={**probe.POLICY, 'max_bytes': 100, 'timeout': 0.15})
                    with self.assertRaisesRegex(ValueError, cause):
                        http.fetch('http://synthetic.example/' + path, 'page', 'page:' + path)
                    self.assertNotIn('SECRET-BODY', journal.path.read_text())
                    self.assertEqual(sum(e['type'] == 'request' for e in journal.events), 1)
                    self.assertEqual(sum(e['type'] == 'response' for e in journal.events), 1)
                    before = len(received)
                    if path in ['403', '429', 'captcha']:
                        with self.assertRaisesRegex(ValueError, 'host_stopped'):
                            http.fetch('http://synthetic.example/new', 'page', 'page:new')
                        self.assertEqual(len(received), before)

    def test_journal_rejects_semantically_corrupt_events_even_with_valid_hash(self):
        journal = self.journal('state')
        attempt = {'type': 'attempt', 'id': 'feed:0', 'kind': 'feed', 'url': 'http://127.0.0.1:18081/r'}
        journal.append(attempt)
        with self.assertRaises(ValueError):
            journal.append(attempt)
        with self.assertRaises(ValueError):
            journal.append({'type': 'response', 'request_id': 'never_sent', 'cause': 'timeout'})
        with self.assertRaises(ValueError):
            journal.append({'type': 'invented_verified', 'secret': 'SECRET'})
        binding, path = journal.events[0]['binding'], journal.path
        journal.close()
        event = {'type': 'response', 'request_id': 'never_sent', 'cause': 'timeout'}
        previous = json.loads(path.read_text().splitlines()[-1])['hash']
        payload = {'seq': 2, 'previous': previous, 'event': event}
        with path.open('ab') as stored:
            stored.write(probe.canonical({**payload, 'hash': probe.digest(probe.canonical(payload))}) + b'\n')
        with self.assertRaises(ValueError):
            probe.Journal(path, binding)

    def test_real_tls_trust_hostname_pinned_address_host_and_no_credentials(self):
        key, cert = self.directory / 'synthetic-key.pem', self.directory / 'synthetic-cert.pem'
        openssl = shutil.which('openssl')
        self.assertIsNotNone(openssl, 'local TLS acceptance requires openssl, never silently skipped')
        subprocess.run([openssl, 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(key), '-out', str(cert),
                        '-days', '1', '-subj', '/CN=synthetic.example', '-addext', 'subjectAltName=DNS:synthetic.example'],
                       check=True, capture_output=True, timeout=30)
        server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        server_context.load_cert_chain(cert, key)
        names = []
        server_context.set_servername_callback(lambda sock, name, context: names.append(name))
        client_context = ssl.create_default_context(cafile=str(cert))
        with fixture(lambda handler: reply(handler), server_context) as (port, received):
            connects, resolves = [], []
            def resolve(host, timeout):
                resolves.append(host)
                return ['8.8.8.8', '1.1.1.1']
            def connect(address, remote_port, timeout):
                connects.append((address, remote_port))
                return socket.create_connection(('127.0.0.1', port), timeout)
            journal = self.journal('tls-valid')
            http = probe.SafeHTTP(journal, f'http://127.0.0.1:{port}', resolve=resolve, connect=connect, context=client_context)
            with patch.dict(os.environ, {'HTTPS_PROXY': 'http://user:SECRET@127.0.0.1:1', 'HTTP_PROXY': 'http://127.0.0.1:1'}):
                response = http.fetch('https://synthetic.example/a', 'page', 'page:tls')
            self.assertEqual(response['body'], b'<article>synthetic</article>')
            self.assertEqual(connects, [('8.8.8.8', 443)])
            self.assertEqual(resolves, ['synthetic.example'])
            self.assertEqual(received, [{'path': '/a', 'host': 'synthetic.example', 'authorization': None, 'cookie': None}])
            for index, (host, context) in enumerate([('wrong.synthetic', client_context), ('synthetic.example', ssl.create_default_context())]):
                http = self.http(self.journal('tls-refuse' + str(index)), port, context=context)
                with self.assertRaisesRegex(ValueError, 'tls_failed'):
                    http.fetch(f'https://{host}/a', 'page', 'page:tls')
            self.assertEqual(len(received), 1)
            self.assertEqual(names, ['synthetic.example', 'wrong.synthetic', 'synthetic.example'])
        insecure = ssl._create_unverified_context()
        with self.assertRaisesRegex(ValueError, 'unsafe_tls_context'):
            self.http(self.journal('tls-insecure'), 18081, context=insecure)

    def test_interrupted_attempts_and_requests_never_resend_and_origin_stop(self):
        rows = probe.load_catalog(CATALOG)
        window = probe.evidence_bridge({'operation': 'window', 'now': CLOCK, 'window': 'rolling_24h'})
        with fixture(lambda handler: reply(handler, b'<html>not an RSS feed SECRET-BODY</html>')) as (port, received):
            journal = self.journal('origin-stop', now=CLOCK, window=window)
            report = probe.run_probe(rows, journal, self.http(journal, port))
            self.assertEqual(len(received), 1)
            self.assertEqual(report['sample_denominator'], 273)
            self.assertEqual(report['observed_unique_pages'], 0)
            self.assertEqual(report['sources'][0]['cause'], 'html_not_feed')
            self.assertTrue(all(row['cause'] == 'host_stopped' for row in report['sources'][1:]))
            self.assertTrue(all(e['no_request'] for e in journal.events if e['type'] == 'feed' and e['source']['route'] != rows[0]['route']))
            journal = self.journal('crash', now=CLOCK, window=window)
            origin = f'http://127.0.0.1:{port}'
            feed_id = 'feed:' + probe.digest(rows[0]['route'].encode())
            url = origin + rows[0]['route']
            journal.append({'type': 'attempt', 'id': feed_id, 'kind': 'feed', 'url': url})
            journal.append({'type': 'request', 'id': feed_id + ':0', 'attempt_id': feed_id, 'kind': 'feed', 'url': url,
                            'host': '127.0.0.1', 'address': '127.0.0.1', 'at': time.time()})
            binding, path = journal.events[0]['binding'], journal.path
            journal.close()
            with probe.Journal(path, binding) as resumed:
                report = probe.run_probe(rows, resumed, self.http(resumed, port))
                self.assertEqual(len(received), 1, 'crash/resume cannot send any already-attempted or stopped-origin request')
                self.assertEqual(report['sources'][0]['cause'], 'interrupted_attempt')
                self.assertTrue(all(row['cause'] == 'host_stopped' for row in report['sources'][1:]))
            self.assertNotIn('SECRET-BODY', path.read_text())

    def test_rate_hop_total_request_caps_and_invalid_policy_fail_closed(self):
        def respond(handler):
            index = int(handler.path[1:])
            reply(handler, status=302 if index < 3 else 200, headers={'Location': f'/{index + 1}'})
        with fixture(respond) as (port, received):
            http = self.http(self.journal('hops'), port)
            with self.assertRaisesRegex(ValueError, 'redirect_cap'):
                http.fetch('http://synthetic.example/0', 'page', 'page:hops')
            self.assertEqual(len(received), 3)
        with fixture(lambda handler: reply(handler)) as (port, received):
            now, waits = [1000.0], []
            def sleep(seconds):
                waits.append(seconds)
                now[0] += seconds
            journal = self.journal('rate')
            http = self.http(journal, port, clock=lambda: now[0], sleep=sleep, policy={**probe.POLICY, 'max_requests': 4, 'global_per_minute': 2, 'host_per_minute': 1})
            for index in range(4):
                http.fetch(f'http://synthetic{index % 2}.example/{index}', 'page', 'page:' + str(index))
            self.assertEqual(len(received), 4)
            self.assertEqual(len(waits), 1)
            self.assertGreaterEqual(waits[0], 60)
            with self.assertRaisesRegex(ValueError, 'request_cap'):
                http.fetch('http://third.example/a', 'page', 'page:cap')
            self.assertEqual(len(received), 4)
            now[0] = 999
            with self.assertRaises(ValueError):
                http.fetch('http://fourth.example/a', 'page', 'page:rollback')
        for key, value in [('timeout', float('nan')), ('max_requests', 2.5), ('max_redirects', True), ('version', 0.5), ('max_bytes', 1048577)]:
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'invalid_policy'):
                self.http(self.journal('policy' + key), 18081, policy={**probe.POLICY, key: value})

    def test_literal_private_urls_refused_and_encoded_publisher_path_preserved(self):
        for value in ['http://127.0.0.1/a', 'http://10.0.0.1/a', 'https://[::1]/a', 'https://[::ffff:8.8.8.8]/a',
                      'https://synthetic.example/a%0d%0aX-Private:value', 'https://synthetic.example/a?password=SECRET']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                probe.publisher_url(value)
        self.assertEqual(probe.publisher_url('https://synthetic.example/a%2Fb'), 'https://synthetic.example/a%2Fb')

    def test_cli_binding_operator_gate_offline_aggregate_and_mismatch(self):
        path = self.directory / 'cli.jsonl'
        args = ['--artifact', str(path), '--origin', 'http://127.0.0.1:18081', '--now', CLOCK]
        command = [sys.executable, str(ROOT / 'scripts/spec82-subscription-probe.py')]
        denied = subprocess.run([*command, 'run', *args], capture_output=True, timeout=20)
        self.assertEqual(denied.returncode, 1)
        self.assertEqual(denied.stderr.splitlines(), [b'subscription_probe_failed_closed'])
        self.assertFalse(path.exists())
        binding = probe.make_binding(CATALOG, 'http://127.0.0.1:18081', CLOCK, 'rolling_24h')
        with probe.Journal(path, binding):
            pass
        output = subprocess.run([*command, 'aggregate', *args], capture_output=True, timeout=20, check=True)
        report = json.loads(output.stdout)
        self.assertEqual(report['sample_denominator'], 273)
        self.assertEqual(len(report['sources']), 91)
        self.assertIsNone(report['accuracy'])
        mismatch = subprocess.run([*command, 'aggregate', *args, '--window', 'calendar_today'], capture_output=True, timeout=20)
        self.assertEqual(mismatch.returncode, 1)
        self.assertEqual(mismatch.stdout, b'')
        self.assertEqual(mismatch.stderr.splitlines(), [b'subscription_probe_failed_closed'])
        for origin in ['http://localhost:18081', 'http://127.0.0.1:8000', 'http://127.0.0.1:8080', 'http://127.0.0.1:8317',
                       'https://127.0.0.1:18081', 'http://127.0.0.1:18081/', 'http://user:SECRET@127.0.0.1:18081']:
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                probe.isolated_origin(origin)

    def test_headers_are_bounded_during_read_and_utf16_entities_rejected(self):
        def respond(handler):
            try:
                handler.wfile.write(b'HTTP/1.1 200 OK\r\nX-Big: ' + b'x' * 17000)
                handler.wfile.flush()
                time.sleep(0.3)
            except OSError:
                pass
        with fixture(respond) as (port, received):
            http = self.http(self.journal('bounded-header-read'), port, policy={**probe.POLICY, 'timeout': 0.15})
            with self.assertRaisesRegex(ValueError, 'header_cap'):
                http.fetch('http://synthetic.example/a', 'page', 'page:header')
        xml = '<!DOCTYPE rss [<!ENTITY x "private">]><rss><channel><item><title>&x;</title></item></channel></rss>'
        with self.assertRaises(ValueError):
            probe.parse_feed(xml.encode('utf-16'))

    def test_durable_write_failure_closes_writer_and_blocks_future_events(self):
        journal = self.journal('write-failed')
        with patch.object(probe.os, 'fsync', side_effect=OSError('SECRET-SYNTHETIC')):
            with self.assertRaises(Exception):
                journal.append({'type': 'attempt', 'id': 'feed:0', 'kind': 'feed', 'url': 'http://127.0.0.1:18081/r'})
        with self.assertRaises(ValueError):
            journal.append({'type': 'attempt', 'id': 'feed:1', 'kind': 'feed', 'url': 'http://127.0.0.1:18081/next'})
        self.assertNotIn('SECRET-SYNTHETIC', journal.path.read_text())


if __name__ == "__main__":
    unittest.main()
