"""Offline HTML evidence -> SQLite acceptance; no live sources or services."""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

sys.dont_write_bytecode = True
SOURCE = Path(__file__).resolve().parents[1]
CLOCK = "2026-10-13T04:00:00.000Z"
spec = importlib.util.spec_from_file_location("spec82_fts5", SOURCE / "scripts/spec82-fts5-experiment.py")
experiment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(experiment)


def document(document_id="a", title="中国经济政策", date="2026-10-13T03:30Z", **overrides):
    return {"document_id": document_id, "canonical_url": f"https://synthetic.example/{document_id}",
            "title": title, "body": "合成正文", "html": f'<meta name="pubdate" content="{date}">',
            "source_id": "synthetic-official", "source_tier": "T1", "cluster_id": None,
            **overrides}


class OfflineIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="wag88-test-", dir=SOURCE)
        self.addCleanup(self.temp.cleanup)

    def index(self, arm="pretokenized"):
        index = experiment.OfflineIndex(Path(self.temp.name) / f"{arm}.sqlite", arm)
        self.addCleanup(index.close)
        return index

    def test_actual_html_publication_supports_chinese_substring_only_in_pretokenized_arm(self):
        for arm, expected in [("raw", []), ("pretokenized", ["a"])]:
            with self.subTest(arm=arm):
                index = self.index(arm)
                index.ingest([document()], CLOCK)
                results = index.query("经济", CLOCK, strict=True)
                self.assertEqual([row["document_id"] for row in results], expected)
                if results:
                    self.assertEqual(results[0]["evidence"]["status"], "verified")
                    self.assertEqual(results[0]["evidence"]["evidence_level"], "E1")
                    self.assertEqual(results[0]["evidence"]["evidence_url"], "https://synthetic.example/a")

    def test_strict_requires_extracted_page_not_forged_labels_or_mismatched_url(self):
        index = self.index()
        cases = [
            document("e2", html='<article><p>发布时间：2026-10-13T03:30Z</p></article>'),
            document("forged", html="<article>没有日期</article>", date_status="verified",
                     evidence_level="E1", published_at=CLOCK,
                     auxiliary=[{"source": "feed.item.pubDate", "value": CLOCK, "precision": "instant"}]),
            document("e3", html="<article>没有日期</article>",
                     auxiliary=[{"source": "url.pattern", "on": "2026-10-13", "precision": "day"}]),
            document("mismatch", page_url="https://synthetic.example/other"),
            document("conflict", html='<meta name="pubdate" content="2026-10-13T03:30Z">'
                                     '<article><p>发布日期：2024年1月1日</p></article>'),
            document("future", date="2026-10-13T04:00:00.001Z"),
            document("invalid", date="2026-02-30T03:30Z"),
            document("unzoned", date="2026-10-13 11:30"),
            document("noise", html='<article><aside>发布时间：2026年10月13日</aside></article>'),
            document("event", html='<article><time datetime="2026-10-13T03:30Z">事件</time></article>'),
        ]
        index.ingest(cases, CLOCK)
        self.assertEqual([row["document_id"] for row in index.query("经济", CLOCK, strict=True)], ["e2"])
        general = {row["document_id"]: row for row in index.query("经济", CLOCK, limit=20)}
        self.assertEqual(general["forged"]["evidence"]["status"], "claimed")
        self.assertEqual(general["e3"]["evidence"]["status"], "unknown")
        self.assertEqual(general["mismatch"]["evidence"]["reason"], "mismatched_evidence_url")
        self.assertEqual(general["conflict"]["evidence"]["reason"], "conflicting_evidence")
        self.assertTrue(general["e2"]["page"]["publication_candidates"])
        self.assertEqual(general["e2"]["evidence"]["checked_at"], CLOCK)

    def test_windows_preserve_day_precision_and_inclusive_instants_and_rederive_status(self):
        index = self.index()
        index.ingest([
            document("start", date="2026-10-12T04:00Z"),
            document("before", date="2026-10-12T03:59:59.999Z"),
            document("end", date=CLOCK),
            document("future", date="2026-10-13T04:00:00.001Z"),
            document("day", html='<article><p>发布日期：2026年10月13日</p></article>'),
            document("unzoned", date="2026-10-13 11:30"),
            document("midnight", date="2026-10-12T16:00Z"),
            document("before-midnight", date="2026-10-12T15:59:59.999Z"),
        ], CLOCK)
        ids = lambda window, now=CLOCK: {row["document_id"] for row in index.query("经济", now, window, strict=True)}
        self.assertEqual(ids("rolling_24h"), {"start", "end", "midnight", "before-midnight"})
        self.assertEqual(ids("calendar_today"), {"end", "day", "midnight"})
        self.assertEqual(ids("rolling_24h", "2026-10-15T04:00:00.000Z"), set())

    def test_retention_uses_old_valid_publication_or_first_ingest_fallback_and_preserves_equality(self):
        index = self.index()
        index.ingest([
            document("old", date="2026-07-15T04:00Z"),
            document("equal", date="2026-07-15T04:00:00.000Z"),
            document("expired", date="2026-07-15T03:59:59.999Z"),
            document("day", date="2026-07-16"),
            document("future", date="2099-01-01T00:00Z"),
            document("forged", html="<article>没有日期</article>", published_at="2099-01-01T00:00Z",
                     expires_at="2099-04-01T00:00Z"),
        ], CLOCK)
        self.assertEqual(index.get("old")["expires_at"], CLOCK)
        self.assertEqual(index.get("old")["retention_basis"], "page_publication")
        self.assertEqual(index.get("day")["expires_at"], "2026-10-13T16:00:00.000Z")
        for document_id in ["future", "forged"]:
            self.assertEqual(index.get(document_id)["expires_at"], "2027-01-11T04:00:00.000Z")
            self.assertEqual(index.get(document_id)["retention_basis"], "first_indexed_at")
        index.ingest([document("forged", html="<article>仍然没有日期</article>")], "2026-10-14T04:00:00.000Z")
        self.assertEqual(index.get("forged")["indexed_at"], CLOCK)
        self.assertEqual(index.get("forged")["expires_at"], "2027-01-11T04:00:00.000Z")
        self.assertEqual(index.retention(CLOCK), ["expired"])
        self.assertIsNone(index.get("expired"))
        self.assertNotIn("expired", [row["document_id"] for row in index.query("经济", CLOCK, limit=20)])
        self.assertIsNotNone(index.get("equal"))
        self.assertEqual(index.retention("2026-10-13T04:00:00.001Z"), ["equal", "old"])

    def test_idempotent_url_identity_update_replaces_old_tokens_and_proof(self):
        index = self.index()
        index.ingest([document()], CLOCK)
        index.ingest([document()], CLOCK)
        index.ingest([document("alias", canonical_url="https://synthetic.example/a?utm_source=fixture#top")], CLOCK)
        self.assertEqual([row["document_id"] for row in index.query("经济", CLOCK)], ["a"])
        index.ingest([document(title="安全修订", html="<article>没有日期</article>")], CLOCK)
        self.assertEqual(index.query("经济", CLOCK), [])
        self.assertEqual(index.query("安全", CLOCK, strict=True), [])
        updated = index.query("安全", CLOCK)
        self.assertEqual(len(updated), 1)
        self.assertEqual(updated[0]["evidence"]["published_at"], None)
        self.assertEqual(updated[0]["page"]["publication_candidates"], [])

    def test_failed_batch_rolls_back_prior_changes_and_invalid_urls_are_rejected(self):
        index = self.index()
        index.ingest([document()], CLOCK)
        with self.assertRaises(ValueError):
            index.ingest([document(title="不应保留"), document("bad", title=None)], CLOCK)
        self.assertEqual([row["document_id"] for row in index.query("经济", CLOCK)], ["a"])
        self.assertIsNone(index.get("bad"))
        for url in ["file:///article", "not a url", "https://user:password@synthetic.example/a"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                index.ingest([document("bad", canonical_url=url)], CLOCK)
        self.assertIsNone(index.get("bad"))

    def test_bm25_ties_and_reopened_ranking_persist_and_arm_mismatch_is_rejected(self):
        index = self.index()
        index.ingest([document("z"), document("a"), document("m")], CLOCK)
        first = index.query("经济", CLOCK, strict=True)
        self.assertEqual([row["document_id"] for row in first], ["a", "m", "z"])
        self.assertEqual(first, index.query("经济", CLOCK, strict=True))
        reopened = self.index()
        self.assertEqual(first, reopened.query("经济", CLOCK, strict=True))
        with self.assertRaises(ValueError):
            experiment.OfflineIndex(Path(self.temp.name) / "pretokenized.sqlite", "raw")

    def test_source_filter_and_literal_query_do_not_expand_fts_operators(self):
        index = self.index()
        index.ingest([document("a"), document("b", source_id="other")], CLOCK)
        self.assertEqual([row["document_id"] for row in index.query("经济", CLOCK, source_id="other")], ["b"])
        self.assertEqual(index.query("经济 OR nonexistent", CLOCK), [])
        self.assertEqual(index.query("", CLOCK), [])
        for value in ["2026-10-13T04:00:00", "bad-clock"]:
            with self.assertRaises(ValueError):
                index.query("", value)
        with self.assertRaises(ValueError):
            index.query("经济", CLOCK, limit=-1)
        for document_id in ["a", "b"]:
            self.assertEqual(index.get(document_id)["published_at"], "2026-10-13T03:30:00.000Z")

    def test_fixture_has_explicit_48_24_labels_and_actual_extracted_date_cases(self):
        fixture = experiment.load_fixture()
        self.assertEqual(len(fixture["documents"]), 48)
        self.assertEqual(len(fixture["queries"]), 24)
        index = self.index()
        index.ingest(fixture["documents"], CLOCK)
        for window in ["rolling_24h", "calendar_today"]:
            rows = index.query("这是明确合成的实验正文", CLOCK, window, limit=100)
            self.assertEqual(len(rows), 48)
            labels = {doc["document_id"]: doc["expected_date_status"][window] for doc in fixture["documents"]}
            for row in rows:
                self.assertEqual(row["evidence"]["status"], labels[row["document_id"]], row["document_id"])
                self.assertEqual(row["evidence"]["evidence_url"], row["canonical_url"])
            for query in fixture["queries"]:
                if query.get("strict") and query["window"] == window:
                    results = index.query(query["text"], CLOCK, window, strict=True)
                    self.assertTrue({row["document_id"] for row in results} <= set(query["expected_strict_ids"]))
                    self.assertTrue(all(row["evidence"]["status"] == "verified" for row in results))
        self.assertEqual(index.get("d24")["published_at"], None)

    def test_metrics_use_expected_ids_and_keep_explicit_zero_queries_out_of_recall_denominator(self):
        observations = [
            {"query_id": "one", "expected_ids": ["a", "b"], "ranks": [{"document_id": "x"}, {"document_id": "b"}]},
            {"query_id": "miss", "expected_ids": ["c"], "ranks": []},
            {"query_id": "negative", "expected_ids": [], "ranks": []},
        ]
        metrics = experiment.metrics(observations)
        self.assertEqual(metrics["mean_recall_at_10"], 0.25)
        self.assertEqual(metrics["mrr_at_10"], 0.25)
        self.assertEqual(metrics["positive_queries"], 2)
        self.assertEqual(metrics["zero_result_queries"], ["miss", "negative"])
        self.assertEqual(metrics["zero_relevant_queries"], ["miss"])

    def test_expired_records_cannot_be_returned_before_cleanup_and_reingest_has_no_fts_orphans(self):
        index = self.index()
        index.ingest([document("expired", date="2026-07-15T03:59:59.999Z"),
                      document("future", date="2099-01-01T00:00Z")], CLOCK)
        self.assertEqual([row["document_id"] for row in index.query("经济", CLOCK)], ["future"])
        self.assertEqual(index.query("经济", "2099-01-01T00:00:00.000Z", strict=True), [])
        self.assertEqual(index.retention(CLOCK), ["expired"])
        index.ingest([document("expired")], CLOCK)
        self.assertEqual([row["document_id"] for row in index.query("经济", CLOCK, strict=True)], ["expired"])

    def test_id_can_change_url_but_colliding_existing_id_url_batch_is_atomic(self):
        index = self.index()
        index.ingest([document("a"), document("b")], CLOCK)
        index.ingest([document("a", canonical_url="https://synthetic.example/new", title="修订内容",
                               html="<article>无日期</article>")], CLOCK)
        self.assertEqual([row["document_id"] for row in index.query("经济", CLOCK)], ["b"])
        self.assertEqual(index.query("修订", CLOCK, strict=True), [])
        with self.assertRaises(ValueError):
            index.ingest([document("c"), document("a", canonical_url="https://synthetic.example/b")], CLOCK)
        self.assertIsNone(index.get("c"))
        self.assertEqual(index.get("a")["canonical_url"], "https://synthetic.example/new")
        self.assertEqual(index.query("修订", CLOCK)[0]["evidence"]["published_at"], None)


if __name__ == "__main__":
    unittest.main()
