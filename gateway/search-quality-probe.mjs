import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { evaluateNewsQuality } from './news-quality.mjs';

// Read-only online probe for search temporal evidence (goal 3, SPEC issue #65) plus a bounded,
// candidate-driven quality verification layer (SPEC issue #67).
//
// It records *complete* evidence per result — `temporal_evidence`, `published_on`, `precision`,
// `engine`, the exact request parameters, `trace_id` and the UTF-8 query echo — instead of only
// `published_at`. It performs a small, fixed set of queries and reads at most PROBE_MAX_READS pages
// (0 by default) so it never adds a default public-network load. This is a probe, not a gate: the
// native availability gate stays in `evidence-live-smoke.mjs` and its verdict is unchanged.
//
// CLI
// ---
// Required: GATEWAY_TOKEN (>= 32 chars) and a reachable gateway. Optional:
//   GATEWAY_EVAL_URL      MCP endpoint   (default http://yosef-server:8930/mcp)
//   PROBE_QUERIES         JSON array of fixed web_search args (search mode)
//   PROBE_CANDIDATES      path to a fixed candidate fixture (candidate mode, see below)
//   PROBE_MAX_READS       bounded read budget (default 0; serial; recommended 6)
//   PROBE_READ_TIMEOUT_MS per-read timeout in ms (default 20000)
//   PROBE_WINDOW_START / PROBE_WINDOW_END  explicit freshness window (ISO-8601)
//   PROBE_OUTPUT          output path (default ./wag-search-quality-probe.json)
//
// Candidate mode (`PROBE_CANDIDATES=gateway/fixtures/search-quality-candidates.json`):
//   node gateway/search-quality-probe.mjs
//   Reads at most PROBE_MAX_READS of the fixed candidates (serially, each with a bounded timeout),
//   preserves the complete raw MCP read payload per candidate, and emits a complete quality report
//   whose denominator is every fixed candidate. Candidates left out of the budget are recorded as
//   `unread` — never judged to be date-less, and never dropped from the denominator. This measures
//   the fixed set; it does not by itself improve engine relevance.

// A UTF-8 request must come back byte-for-byte; a mangled echo (e.g. a mis-encoded CJK query)
// invalidates the batch as quality evidence, so the mismatch is recorded rather than ignored.
export function checkUtf8Echo(requested, echoed) {
  return typeof requested === 'string' && typeof echoed === 'string' && requested === echoed;
}

function projectResult(result) {
  return {
    title: result?.title ?? null,
    url: result?.url ?? null,
    engine: result?.engine ?? null,
    category: result?.category ?? null,
    published_at: result?.published_at ?? null,
    published_on: result?.published_on ?? null,
    precision: result?.precision ?? null,
    retrieved_at: result?.retrieved_at ?? null,
    time_range_status: result?.time_range_status ?? null,
    source: result?.source ?? null,
    temporal_evidence: Array.isArray(result?.temporal_evidence) ? result.temporal_evidence : [],
  };
}

export function buildSearchEvidenceRecord({ traceId, params, response }) {
  return {
    trace_id: traceId ?? response?.trace_id ?? null,
    params: { ...params },
    query: response?.query ?? null,
    query_echo_ok: checkUtf8Echo(params?.query, response?.query),
    number_of_results: response?.number_of_results ?? null,
    time_range: response?.time_range ?? null,
    time_range_applied: response?.time_range_applied ?? null,
    time_range_enforced: response?.time_range_enforced ?? null,
    time_range_note: response?.time_range_note ?? null,
    time_window_strict: response?.time_window_strict ?? null,
    filtered_out: response?.filtered_out ?? null,
    filtered_reasons: response?.filtered_reasons ?? null,
    unresponsive_engines: response?.unresponsive_engines ?? null,
    results: (Array.isArray(response?.results) ? response.results : []).map(projectResult),
  };
}

export function buildReadEvidenceRecord({ traceId, url, response }) {
  return {
    trace_id: traceId ?? response?.trace_id ?? null,
    url,
    query_echo_ok: true,
    ok: true,
    published_at: response?.published_at ?? null,
    published_on: response?.published_on ?? null,
    precision: response?.precision ?? null,
    retrieved_at: response?.retrieved_at ?? null,
    source: response?.source ?? null,
    temporal_evidence: Array.isArray(response?.temporal_evidence) ? response.temporal_evidence : [],
  };
}

// A bounded read budget must stay small: the probe is a diagnostic, not a crawler. Even a mis-set
// PROBE_MAX_READS can never trigger a large public-network batch.
export const PROBE_READ_HARD_CAP = 12;

// Decide which fixed candidates to read under the bounded budget. Reading is serial and capped at
// `hardCap`; every candidate beyond the budget (or with a non-http URL, or a duplicate) is returned as
// `unread` so the caller keeps the full denominator instead of silently trimming the set.
export function selectCandidateReads(candidates = [], maxReads = 0, hardCap = PROBE_READ_HARD_CAP) {
  const requested = Number.isFinite(maxReads) ? Math.floor(maxReads) : 0;
  const budget = Math.max(0, Math.min(requested, Number.isFinite(hardCap) ? hardCap : PROBE_READ_HARD_CAP));
  const seen = new Set();
  const toRead = [];
  const unread = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const url = typeof candidate?.url === 'string' ? candidate.url : '';
    if (!/^https?:\/\//.test(url) || seen.has(url) || toRead.length >= budget) { unread.push(candidate); continue; }
    seen.add(url);
    toRead.push(candidate);
  }
  return { budget, planned: toRead.length, toRead, unread };
}

// One candidate read record. A successful read preserves the *complete* raw MCP payload (`raw`) so no
// publisher field is lost; a failed read keeps the reason and is never promoted to a success.
export function buildCandidateReadRecord({ candidate, url, response, error }) {
  const target = url ?? candidate?.url ?? null;
  if (error) {
    return {
      url: target,
      label: candidate?.label ?? null,
      read_status: 'read_failure',
      ok: false,
      error: String(error?.message ?? error).slice(0, 200),
    };
  }
  return {
    url: target,
    label: candidate?.label ?? null,
    read_status: 'read_ok',
    ok: true,
    published_at: response?.published_at ?? null,
    published_on: response?.published_on ?? null,
    precision: response?.precision ?? null,
    retrieved_at: response?.retrieved_at ?? null,
    source: response?.source ?? null,
    temporal_evidence: Array.isArray(response?.temporal_evidence) ? response.temporal_evidence : [],
    raw: response ?? null,
  };
}

export function summarizeProbe(searches, reads = []) {
  const results = searches.flatMap(search => search.results ?? []);
  return {
    searches: searches.length,
    results_total: results.length,
    results_with_publisher_instant: results.filter(result => result.temporal_evidence.some(item => item.kind === 'published_at' && item.value)).length,
    results_with_published_on: results.filter(result => result.published_on).length,
    results_time_range_within: results.filter(result => result.time_range_status === 'within').length,
    results_time_range_outside: results.filter(result => result.time_range_status === 'outside').length,
    results_time_range_unverified: results.filter(result => result.time_range_status === 'unverified').length,
    query_echo_mismatches: searches.filter(search => search.query_echo_ok === false).length + reads.filter(read => read.query_echo_ok === false).length,
    reads: reads.length,
  };
}

export const DEFAULT_QUERIES = [
  { query: '中国 经济 政策', language: 'zh-CN' },
  { query: 'SearXNG documentation', language: 'en' },
  { query: '全球 市场 最新 新闻', language: 'zh-CN', time_range: 'day', time_window_strict: true },
];

function payload(result) {
  const raw = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  return JSON.parse(raw);
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readCandidate(client, candidate, timeoutMs) {
  try {
    const value = payload(await withTimeout(
      client.callTool({ name: 'web_read', arguments: { url: candidate.url, render: 'auto', output: 'markdown' } }),
      timeoutMs,
      'web_read',
    ));
    return buildCandidateReadRecord({ candidate, url: candidate.url, response: value });
  } catch (error) {
    return buildCandidateReadRecord({ candidate, url: candidate.url, error });
  }
}

async function main() {
  const token = process.env.GATEWAY_TOKEN ?? '';
  if (token.length < 32) throw new Error('GATEWAY_TOKEN is required (>=32 chars)');
  const gatewayUrl = process.env.GATEWAY_EVAL_URL ?? `http://yosef-server:${process.env.GATEWAY_PORT ?? '8930'}/mcp`;
  const queries = process.env.PROBE_QUERIES ? JSON.parse(process.env.PROBE_QUERIES) : DEFAULT_QUERIES;
  const maxReads = Number(process.env.PROBE_MAX_READS ?? '0');
  const readTimeoutMs = Number(process.env.PROBE_READ_TIMEOUT_MS ?? '20000');
  const candidateFixturePath = process.env.PROBE_CANDIDATES ?? '';
  const output = process.env.PROBE_OUTPUT ?? path.resolve('wag-search-quality-probe.json');
  const startedAt = new Date().toISOString();

  const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'wag-search-quality-probe', version: '1.0.0' });
  await client.connect(transport);
  try {
    const searches = [];
    for (const args of queries) {
      const value = payload(await client.callTool({ name: 'web_search', arguments: args }));
      searches.push(buildSearchEvidenceRecord({ traceId: value.trace_id, params: args, response: value }));
    }
    const reads = [];
    if (Number.isFinite(maxReads) && maxReads > 0) {
      const urls = searches.flatMap(search => search.results.map(result => result.url)).filter(url => /^https?:\/\//.test(url ?? ''));
      for (const url of [...new Set(urls)].slice(0, Math.min(maxReads, PROBE_READ_HARD_CAP))) {
        try {
          const value = payload(await client.callTool({ name: 'web_read', arguments: { url, render: 'auto', output: 'markdown' } }));
          reads.push(buildReadEvidenceRecord({ traceId: value.trace_id, url, response: value }));
        } catch (error) {
          reads.push({ url, ok: false, error: String(error.message ?? error).slice(0, 160) });
        }
      }
    }

    // Candidate mode: read a fixed, labelled candidate set under the same bounded budget and emit a
    // complete quality report (denominator = every fixed candidate). It reuses the read budget and the
    // shared news-quality evaluator instead of a parallel module; candidates left out of the budget
    // stay in the denominator as `unread`, and the complete raw MCP read payload is preserved.
    let candidateReport = null;
    if (candidateFixturePath) {
      const fixture = JSON.parse(fs.readFileSync(path.resolve(candidateFixturePath), 'utf8'));
      const candidates = Array.isArray(fixture?.candidates) ? fixture.candidates : Array.isArray(fixture) ? fixture : [];
      const { budget, planned, toRead, unread } = selectCandidateReads(candidates, maxReads);
      const candidateReads = {};
      for (const candidate of toRead) candidateReads[candidate.url] = await readCandidate(client, candidate, readTimeoutMs);
      const window = fixture?.window ?? {
        start: process.env.PROBE_WINDOW_START ?? null,
        end: process.env.PROBE_WINDOW_END ?? null,
      };
      candidateReport = {
        fixture: path.relative(process.cwd(), path.resolve(candidateFixturePath)),
        budget,
        planned,
        unread_planned: unread.length,
        ...evaluateNewsQuality({
          query: fixture?.query ?? null,
          language: fixture?.language ?? null,
          time_range: fixture?.time_range ?? null,
          window,
          candidates,
          reads: candidateReads,
          require: fixture?.require ?? {},
        }),
      };
    }
    const evidence = {
      probe: 'wag-search-quality-probe',
      version: '1.0.0',
      gateway_host: new URL(gatewayUrl).host,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      window: { start: process.env.PROBE_WINDOW_START ?? null, end: process.env.PROBE_WINDOW_END ?? null },
      searches,
      reads,
      candidate_report: candidateReport,
      summary: summarizeProbe(searches, reads),
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({
      output,
      summary: evidence.summary,
      candidate_report: candidateReport && {
        denominator: candidateReport.denominator,
        read_ok: candidateReport.read_ok,
        read_failure: candidateReport.read_failure,
        unread: candidateReport.unread,
        both_satisfied: candidateReport.both_satisfied,
      },
    }, null, 2));
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
