# SPEC82 bounded resume delivery

Parent [#82](https://github.com/williamxhero/WAG/issues/82); coordination `t_e71068cc`; session `40a6cf16-ff66-4338-a32a-d4876155d660`; branch `claude/spec82-resume`, base `9b4b102`. Hermes owns independent acceptance/merge. No issue closure or merge by this session.

## Requirement/ticket-first record

The full SPEC/body/comments and repository instructions were read before implementation. `/to-spec` and `/to-tickets` are not installed commands; equivalent phases, not invented invocations, were published and read back in [the stage receipt](https://github.com/williamxhero/WAG/issues/82#issuecomment-6143037417). This preserves the previously recorded workflow deviation. Engineering tickets are native children of #82: #85 adapters, #86 durable budget (integration depends on #85), #87 Chinese E2/page-only strict policy, #88 isolated FTS5 (depends on #87). No new Kanban graph.

This pass prioritizes complete #85/#86. #87/#88 are remaining implementable work, **not blocked on credentials**. Offline tests do not establish real Chinese supply, strict-page accuracy or SPEC exit thresholds.

## Official adapter contract (#85)

`gateway/provider-adapters.mjs` exposes `createProviderAdapter({name, enabled, transport, ...})`. Disabled by default; no default HTTP transport, environment/credential reads or MCP/search route integration. An explicit injected transport receives `{endpoint, api, body, maxResponseBytes, signal}` and returns `{status, body}` with a JSON **string** body. It must bound raw/decompressed reads before buffering and honor abort in any future real integration. The adapter rechecks UTF-8 bytes before parsing; the deadline bounds the promise even if the transport ignores abort, but cannot stop arbitrary injected code or undo upstream billing. Defaults: 256KiB, 10 results, 5s; maxima 1MiB/50/30s.

Mapping sources (public docs read 2026-10-13, not real API calls):

- [Baidu](https://ai.baidu.com/ai-doc/AppBuilder/pmaxd1hvy): `references[].title/url/content/website/date`. `messages`, `search_source=baidu_search_v2`, web `top_k`. `search_recency_filter` week/month/year supported; day is deliberately unfiltered. Authentication `Authorization` vs `X-Appbuilder-Authorization` and `pageTime` vs `page_time` remain conflicting; no auth or date-range guess is implemented.
- [Aliyun LiteBasic](https://help.aliyun.com/zh/document_detail/3062218.html): **`engineType=CNLiteBasic`**, not the separate LiteAdvanced page. `pageItems[].title/link/snippet/hostname/publishedTime`; string `advancedParams.numResults`; optional contents disabled, including paid summary. `timeRange` is only a recall hint.
- [Tencent SearchPro](https://cloud.tencent.com/document/product/1806/121811): action `SearchPro`, API version `2025-05-08`; `Query/Site/Freshness`. `Response.Pages` is an array of JSON strings, decoded to `title/url/passage/site/date`; account `Response.Version` must be `lite` (fail closed otherwise). No lite-unsupported `Cnt/Mode` or invented account-version request field.

Malformed/error envelopes and invalid records are rejected; output bounded by configured count, response byte bound limits total parsing. No provider error text is surfaced; kinds include authentication/rate_limited/upstream_error/invalid_response/transport_error/timeout/response_too_large/provider_version_mismatch/provider_unconfigured. Dates remain `claimed` or `unknown`, never `verified`. Blank dates become null. `cacheIdentity` namespaces provider/site/count around the existing normalized query/mode/window key; TTL uses the existing general24h/news2h/strict-day1h contract. Actual cache-before-budget dispatch is #86.

### TDD evidence

Command in every slice: `node.exe --test --test-concurrency=1 gateway/provider-adapters.test.mjs` (foreground Windows Node26.7.0).

1. Mapping/default-disabled RED: missing new module (`ERR_MODULE_NOT_FOUND`), 0 pass/1 fail. GREEN: 3/3.
2. Error-envelope RED: missing expected rejection, 3 pass/1 fail. GREEN: 4/4.
3. Byte/count/malformed-record RED: missing expected oversized rejection, 4 pass/1 fail. GREEN: 5/5.
4. Official requests/cache identity RED: transport_error because documented request shape absent, 5 pass/1 fail. GREEN: 6/6.
5. Deadline RED: actual transport_error vs expected timeout, 6 pass/1 fail. GREEN focused plus legacy `gateway/provider-contract.test.mjs`: 18/18.

Fixtures are explicitly synthetic official-shaped data, not real responses. No credentials/accounts/provider requests/production writes were performed. Independent read-only review found disabled fallback charging, malformed Tencent Error acceptance and legacy string-query incompatibility. Regression RED: 17 pass/2 fail; fixes plus corrected Baidu zero-cost test estimate GREEN: 19/19. The existing fallback now checks explicitly disabled adapters before reservation, while legacy providers without an enabled field remain compatible. Adapters accept a string query as well as an object.

Full foreground gateway suite: first attempt exited1 with terminal output truncation (not claimed passing); rerun with complete scratch log `gateway-ticket85.log`: **439 tests,438 pass,0 fail,0 cancelled,1 existing opt-in GDELT live skip**, exit0, ~424s. Locked `npm.cmd --prefix gateway ci --ignore-scripts` succeeded; package-lock unchanged. Diff whitespace checks passed. Linux exact-head CI is still required, not inferred from the local Node26 run.
