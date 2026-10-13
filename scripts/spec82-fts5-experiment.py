"""Bounded synthetic SQLite FTS5 experiment. No services, fetching or new packages."""
import argparse
import hashlib
import json
import platform
import re
import sqlite3
import subprocess
import sys
import tempfile
from time import perf_counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

SOURCE = Path(__file__).resolve().parents[1]
BRIDGE = SOURCE / "gateway/spec82-index-evidence.mjs"


def bridge(operation, records, now, window="rolling_24h"):
    result = subprocess.run(["node", str(BRIDGE)], input=json.dumps({
        "operation": operation, "records": records, "now": now, "window": window,
    }, ensure_ascii=False), capture_output=True, text=True, encoding="utf-8", check=True, timeout=60)
    return json.loads(result.stdout)


def clock(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("clock requires timezone")
    return parsed.astimezone(timezone.utc)


def timestamp(value):
    return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def pretokenize(text):
    # Demonstration only: Han codepoints and contiguous ASCII words, no linguistic segmentation.
    return " ".join(re.findall(r"[㐀-鿿]|[A-Za-z0-9]+", text))


class OfflineIndex:
    def __init__(self, path, arm="raw"):
        if arm not in {"raw", "pretokenized"}:
            raise ValueError("unknown arm")
        self.arm = arm
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS metadata (arm TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS documents (
                    document_id TEXT PRIMARY KEY, canonical_url TEXT UNIQUE NOT NULL,
                    payload TEXT NOT NULL, expires_at TEXT NOT NULL
                );
                CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
                    document_id UNINDEXED, title, body, tokenize='unicode61'
                );
            """)
            stored = self.db.execute("SELECT arm FROM metadata").fetchone()
            if stored and stored[0] != arm:
                raise ValueError("database arm mismatch")
            if not stored:
                with self.db:
                    self.db.execute("INSERT INTO metadata VALUES (?)", (arm,))
        except Exception:
            self.db.close()
            raise

    def close(self):
        self.db.close()

    def get(self, document_id):
        row = self.db.execute("SELECT payload FROM documents WHERE document_id=?", (document_id,)).fetchone()
        return json.loads(row["payload"]) if row else None

    def retention(self, now):
        now = timestamp(clock(now))
        with self.db:
            ids = [row[0] for row in self.db.execute(
                "SELECT document_id FROM documents WHERE expires_at < ? ORDER BY document_id", (now,))]
            for document_id in ids:
                self.db.execute("DELETE FROM documents_fts WHERE document_id=?", (document_id,))
                self.db.execute("DELETE FROM documents WHERE document_id=?", (document_id,))
        return ids

    def ingest(self, documents, now):
        now = timestamp(clock(now))
        documents = list(documents)
        for document in documents:
            for field in ["canonical_url", "page_url"]:
                if field not in document:
                    continue
                url = urlsplit(document[field])
                if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
                    raise ValueError("invalid document URL")
            if not isinstance(document.get("html"), str):
                raise ValueError("synthetic HTML required")
        extracted = bridge("extract", documents, now, "calendar_today")
        with self.db:
            for document, proof in zip(documents, extracted):
                if any(not isinstance(document.get(field), str) or not document[field].strip()
                       for field in ["document_id", "title", "source_id", "source_tier"]):
                    raise ValueError("invalid document fields")
                if not isinstance(document.get("body"), str):
                    raise ValueError("invalid document body")
                document_id = document["document_id"]
                owner = self.db.execute("SELECT document_id FROM documents WHERE canonical_url=?",
                                        (proof["canonical_url"],)).fetchone()
                if owner and owner[0] != document_id:
                    if self.get(document_id):
                        raise ValueError("document ID and URL belong to different records")
                    document_id = owner[0]
                previous = self.get(document_id)
                indexed_at = previous["indexed_at"] if previous else now
                basis = proof["publication"] or indexed_at
                expires_at = timestamp(clock(basis) + timedelta(days=90))
                fields = ["title", "body", "html", "source_id", "source_name", "source_tier", "route",
                          "language", "cluster_id", "cluster_role", "auxiliary", "date_case", "expected_date_status"]
                payload = {**{field: document[field] for field in fields if field in document}, **proof,
                           "document_id": document_id, "published_at": proof["evidence"]["published_at"],
                           "published_on": proof["evidence"]["published_on"], "precision": proof["evidence"]["precision"],
                           "indexed_at": indexed_at, "expires_at": expires_at,
                           "retention_basis": "page_publication" if proof["publication"] else "first_indexed_at"}
                self.db.execute("DELETE FROM documents_fts WHERE document_id=?", (document_id,))
                self.db.execute("INSERT OR REPLACE INTO documents VALUES (?,?,?,?)",
                                (document_id, proof["canonical_url"], json.dumps(payload, ensure_ascii=False), expires_at))
                transform = pretokenize if self.arm == "pretokenized" else str
                self.db.execute("INSERT INTO documents_fts VALUES (?,?,?)",
                                (document_id, transform(document["title"]), transform(document["body"])))

    def query(self, text, now, window="rolling_24h", strict=False, limit=10, source_id=None):
        now = timestamp(clock(now))
        if type(limit) is not int or limit < 1:
            raise ValueError("positive integer limit required")
        text = pretokenize(text) if self.arm == "pretokenized" else text
        if not text.strip():
            return []
        match = '"' + text.replace('"', '""') + '"'
        started = perf_counter()
        rows = self.db.execute("""
            SELECT d.payload, bm25(documents_fts) AS score
            FROM documents_fts JOIN documents d USING (document_id)
            WHERE documents_fts MATCH ? AND d.expires_at >= ? ORDER BY score, document_id
        """, (match, now)).fetchall()
        self.last_sqlite_query_ms = (perf_counter() - started) * 1000
        records = [json.loads(row["payload"]) for row in rows]
        evaluated = bridge("evaluate", records, now, window) if records else []
        results = [{**record, "evidence": proof["evidence"], "raw_score": row["score"]}
                   for record, proof, row in zip(records, evaluated, rows)]
        if strict:
            results = [row for row in results if row["evidence"]["status"] == "verified"]
        if source_id is not None:
            results = [row for row in results if row["source_id"] == source_id]
        return results[:limit]


def load_fixture(path=SOURCE / "fixtures/spec82-fts5-synthetic.json"):
    fixture = json.loads(Path(path).read_text(encoding="utf-8"))
    if fixture.get("synthetic") is not True:
        raise ValueError("only explicitly synthetic fixtures are allowed")
    fixture["documents"] = [{**fixture["document_defaults"], **doc} for doc in fixture["documents"]]
    return fixture


def metrics(observations):
    positive = [item for item in observations if item["expected_ids"]]
    recalls, reciprocal = [], []
    for item in positive:
        ids = [row["document_id"] for row in item["ranks"][:10]]
        expected = set(item["expected_ids"])
        recalls.append(len(expected & set(ids)) / len(expected))
        reciprocal.append(next((1 / rank for rank, document_id in enumerate(ids, 1)
                                if document_id in expected), 0))
    return {"positive_queries": len(positive),
            "mean_recall_at_10": sum(recalls) / len(positive) if positive else None,
            "mrr_at_10": sum(reciprocal) / len(positive) if positive else None,
            "zero_result_queries": [item["query_id"] for item in observations if not item["ranks"]],
            "zero_relevant_queries": [item["query_id"] for item in positive
                                      if not set(item["expected_ids"]) & {row["document_id"] for row in item["ranks"][:10]}]}


def run_experiment():
    fixture_path = SOURCE / "fixtures/spec82-fts5-synthetic.json"
    fixture = load_fixture(fixture_path)
    now = fixture["now"]
    artifact = {"synthetic": True, "executed_at": timestamp(datetime.now(timezone.utc)),
                "versions": {"python": sys.version, "sqlite": sqlite3.sqlite_version,
                             "node": subprocess.check_output(["node", "--version"], text=True).strip(),
                             "platform": platform.platform()},
                "fixture_sha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
                "source_sha256": {str(file.relative_to(SOURCE)).replace("\\", "/"): hashlib.sha256(file.read_bytes()).hexdigest()
                                  for file in [Path(__file__), BRIDGE, SOURCE / "gateway/evidence-metadata.mjs",
                                               SOURCE / "gateway/spec82-evidence.mjs", SOURCE / "gateway/news-verified.mjs"]},
                "scale": {"documents": len(fixture["documents"]), "queries": len(fixture["queries"]),
                          "arms": 2, "repetitions_per_arm": 3},
                "configuration": {"tokenizer": "unicode61", "pretokenizer": "Han codepoint / ASCII word",
                                  "match": "quoted phrase, no expansion", "ranking": "bm25 equal weights, document_id ASC",
                                  "cache": "fresh DB per run, ordered query pass, no OS cache flush",
                                  "timing": "perf_counter wall; SQLite MATCH separate from end-to-end including Node process",
                                  "memory": "not measured", "production_selection": "none"},
                "corpus_audit": [], "runs": []}
    fingerprints = {}
    with tempfile.TemporaryDirectory(prefix="wag88-experiment-", dir=SOURCE) as directory:
        for arm in ["raw", "pretokenized"]:
            for repetition in range(1, 4):
                path = Path(directory) / f"{arm}-{repetition}.sqlite"
                index = OfflineIndex(path, arm)
                try:
                    started = perf_counter()
                    index.ingest(fixture["documents"], now)
                    ingest_ms = (perf_counter() - started) * 1000
                    if not artifact["corpus_audit"]:
                        records = [index.get(doc["document_id"]) for doc in fixture["documents"]]
                        rolling = bridge("evaluate", records, now)
                        for record, proof in zip(records, rolling):
                            audit = {key: record.get(key) for key in ["document_id", "canonical_url", "source_id", "source_tier",
                                     "cluster_id", "cluster_role", "date_case", "expected_date_status", "indexed_at", "expires_at",
                                     "retention_basis", "published_at", "published_on", "precision", "page"]}
                            audit["actual_calendar_today"] = record["evidence"]
                            audit["actual_rolling_24h"] = proof["evidence"]
                            for window in ["calendar_today", "rolling_24h"]:
                                if audit[f"actual_{window}"]["status"] != record["expected_date_status"][window]:
                                    raise AssertionError(f"date label mismatch: {record['document_id']} {window}")
                            artifact["corpus_audit"].append(audit)
                    observations = []
                    for query in fixture["queries"]:
                        started = perf_counter()
                        rows = index.query(query["text"], now, query.get("window", "rolling_24h"),
                                           strict=query["strict"], source_id=query.get("source_id"))
                        elapsed_ms = (perf_counter() - started) * 1000
                        ranks = [{"rank": rank, **{key: row.get(key) for key in ["document_id", "canonical_url",
                                 "source_id", "source_tier", "cluster_id", "cluster_role", "raw_score", "evidence"]}}
                                 for rank, row in enumerate(rows, 1)]
                        if query["strict"]:
                            allowed = set(query["expected_strict_ids"])
                            if any(row["document_id"] not in allowed or row["evidence"]["status"] != "verified" for row in rows):
                                raise AssertionError(f"strict leak: {query['query_id']}")
                        observations.append({**query, "sqlite_query_ms": index.last_sqlite_query_ms,
                                             "end_to_end_query_ms": elapsed_ms, "ranks": ranks,
                                             "missed_expected_ids": sorted(set(query["expected_ids"]) - {row["document_id"] for row in rows})})
                    fingerprint = [[(row["document_id"], row["raw_score"]) for row in item["ranks"]] for item in observations]
                    if arm in fingerprints and fingerprints[arm] != fingerprint:
                        raise AssertionError("unstable repeated ranking")
                    fingerprints[arm] = fingerprint
                    before_reopen = index.query(fixture["queries"][0]["text"], now)
                    index.close()
                    index = OfflineIndex(path, arm)
                    if before_reopen != index.query(fixture["queries"][0]["text"], now):
                        raise AssertionError("unstable reopened ranking")
                    size_bytes = path.stat().st_size
                    started = perf_counter()
                    deleted_at_equality = index.retention(now)
                    deleted_after_equality = index.retention(timestamp(clock(now) + timedelta(milliseconds=1)))
                    retention_ms = (perf_counter() - started) * 1000
                    if deleted_at_equality or deleted_after_equality != ["d48"]:
                        raise AssertionError("retention boundary mismatch")
                    artifact["runs"].append({"arm": arm, "repetition": repetition, "ingest_ms": ingest_ms,
                                             "database_bytes_before_retention": size_bytes, "retention_ms": retention_ms,
                                             "deleted_at_equality": deleted_at_equality, "deleted_after_equality": deleted_after_equality,
                                             "reopened_ranking_stable": True, "metrics": metrics(observations), "queries": observations})
                finally:
                    index.close()
    artifact["repeated_rankings_stable"] = True
    return artifact


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True, help="raw JSON artifact (parent must already exist)")
    arguments = parser.parse_args()
    artifact = run_experiment()
    arguments.output.write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"scale": artifact["scale"], "versions": artifact["versions"],
                      "runs": [{"arm": run["arm"], "repetition": run["repetition"],
                                "metrics": run["metrics"]} for run in artifact["runs"]]}, ensure_ascii=False, indent=2))
