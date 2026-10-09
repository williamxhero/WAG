import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Read-only online probe for search temporal evidence (goal 3, SPEC issue #65).
//
// It records *complete* evidence per result — `temporal_evidence`, `published_on`, `precision`,
// `engine`, the exact request parameters, `trace_id` and the UTF-8 query echo — instead of only
// `published_at`. It performs a small, fixed set of queries and reads at most PROBE_MAX_READS pages
// (0 by default) so it never adds a default public-network load. This is a probe, not a gate: the
// native availability gate stays in `evidence-live-smoke.mjs` and its verdict is unchanged.

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

async function main() {
  const token = process.env.GATEWAY_TOKEN ?? '';
  if (token.length < 32) throw new Error('GATEWAY_TOKEN is required (>=32 chars)');
  const gatewayUrl = process.env.GATEWAY_EVAL_URL ?? `http://yosef-server:${process.env.GATEWAY_PORT ?? '8930'}/mcp`;
  const queries = process.env.PROBE_QUERIES ? JSON.parse(process.env.PROBE_QUERIES) : DEFAULT_QUERIES;
  const maxReads = Number(process.env.PROBE_MAX_READS ?? '0');
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
      for (const url of [...new Set(urls)].slice(0, maxReads)) {
        try {
          const value = payload(await client.callTool({ name: 'web_read', arguments: { url, render: 'auto', output: 'markdown' } }));
          reads.push(buildReadEvidenceRecord({ traceId: value.trace_id, url, response: value }));
        } catch (error) {
          reads.push({ url, ok: false, error: String(error.message ?? error).slice(0, 160) });
        }
      }
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
      summary: summarizeProbe(searches, reads),
    };
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ output, summary: evidence.summary }, null, 2));
  } finally {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
