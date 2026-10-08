import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const gatewayUrl = process.env.GATEWAY_EVAL_URL ?? `http://yosef-server:${process.env.GATEWAY_PORT ?? '8930'}/mcp`;
const token = process.env.GATEWAY_TOKEN ?? '';
if (token.length < 32) throw new Error('GATEWAY_TOKEN is required');

const queries = [
  'A股 周末 重大事件 2026年8月30日',
  'A股 公告 2026年8月30日',
  '中国 经济 政策 2026年8月30日',
  '市场 风险 反证 2026年8月30日',
  '全球 市场 周末 要闻 2026年8月30日',
];
const windowStart = Date.parse(process.env.EVIDENCE_WINDOW_START ?? '2026-08-28T07:00:00Z');
const windowEnd = Date.parse(process.env.EVIDENCE_WINDOW_END ?? new Date().toISOString());

function payload(result) {
  const raw = (result.content ?? []).filter(item => item.type === 'text').map(item => item.text).join('\n');
  return JSON.parse(raw);
}

function assertReadEvidence(value) {
  if (!value.retrieved_at || !value.source?.url || !value.source?.host) throw new Error('read result lacks retrieval/source metadata');
  if (!(value.temporal_evidence ?? []).some(item => item.kind === 'retrieved_at' && item.source === 'gateway.clock')) throw new Error('read result lacks retrieval provenance');
  if (value.published_at || value.published_on) {
    const record = value.temporal_evidence.find(item => item.kind === 'published_at');
    if (!record || ['gateway.clock', 'http.header.date'].includes(record.source)) throw new Error('publication time has unsafe provenance');
    if (record.on !== (value.published_on ?? value.published_at.slice(0, 10))) throw new Error('publication date precision is inconsistent');
    if (!String(value.markdown).includes(value.published_at ?? value.published_on)) throw new Error('publication time is not visible to the evidence client');
  }
}

const transport = new StreamableHTTPClientTransport(new URL(gatewayUrl), { requestInit: { headers: { authorization: `Bearer ${token}` } } });
const client = new Client({ name: 'wag-evidence-live-smoke', version: '1.1.2' });
await client.connect(transport);
try {
  const searches = [];
  const candidates = [];
  for (const query of queries) {
    const value = payload(await client.callTool({ name: 'web_search', arguments: { query, categories: 'general', language: 'zh-CN' } }));
    searches.push({ query, trace_id: value.trace_id, count: value.results?.length ?? 0 });
    candidates.push(...(value.results ?? []));
  }
  const unique = [...new Map(candidates.filter(item => /^https?:\/\//.test(item.url ?? '')).map(item => [item.url, item])).values()];
  unique.sort((a, b) => Number(/2026(?:[-/]?08[-/]?30|08\/30)/.test(b.url)) - Number(/2026(?:[-/]?08[-/]?30|08\/30)/.test(a.url)));
  const reads = [];
  const failures = [];
  for (const item of unique.slice(0, 50)) {
    if (reads.length >= 10) break;
    try {
      const value = payload(await client.callTool({ name: 'web_read', arguments: { url: item.url, render: 'auto', output: 'markdown' } }));
      assertReadEvidence(value);
      const published = Date.parse(value.published_at);
      reads.push({
        trace_id: value.trace_id,
        url: value.url,
        published_at: value.published_at,
        publication_source: value.temporal_evidence.find(record => record.kind === 'published_at')?.source ?? null,
        in_evidence_window: Number.isFinite(published) && published > windowStart && published <= windowEnd,
      });
    } catch (error) {
      failures.push({ url: item.url, error: String(error.message ?? error).slice(0, 160) });
    }
  }
  // A zero-hit for a single term is a normal SearXNG answer (see #38/#42), not a
  // WAG failure, so it is reported rather than thrown. Only a systematic failure
  // to search (every equivalent query empty) or an errored call is fatal.
  const zeroResultSearches = searches.filter(item => item.count === 0);
  if (searches.length && zeroResultSearches.length === searches.length) throw new Error('every equivalent search returned no results');
  if (reads.length < 10) throw new Error(`only ${reads.length} evidence reads succeeded`);
  console.log(JSON.stringify({
    version: '1.1.3',
    evidence_window: { start: new Date(windowStart).toISOString(), end: new Date(windowEnd).toISOString() },
    searches,
    reads,
    summary: {
      searches_succeeded: searches.length,
      searches_with_zero_results: zeroResultSearches.length,
      zero_result_queries: zeroResultSearches.map(item => item.query),
      reads_succeeded: reads.length,
      reads_with_publisher_time: reads.filter(item => item.published_at).length,
      reads_in_evidence_window: reads.filter(item => item.in_evidence_window).length,
      read_failures_before_ten_successes: failures.length,
    },
  }, null, 2));
} finally {
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
}
