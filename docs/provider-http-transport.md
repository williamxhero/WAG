# SPEC #82: bounded provider HTTP transport

## Requirement record (before implementation)

Parent: https://github.com/williamxhero/WAG/issues/82 ; assigned Kanban t_9fc516c6, branch wt/t_9fc516c6, base 15c15c5. Integration owner: default/Hermes. Mode: Delivery with economic safety constraints. Goal: usable bounded HTTPS seam for the three existing adapters, not proof of real supply or authentication.

Prior workflow deviation: Hermes coder published the initial requirement/ticket record and wrote the untracked draft without the required Claude stages. That history is retained, not represented as prior Claude work. Coder reported an initial missing-module RED (0 pass/1 fail); no GREEN was run before takeover.

Sole Claude writer session `db579a5c-645f-481b-a599-4adc3c499bdc` (actual SDK session directory; live address `t-9fc516c6-ce [5b83a7]`) took over on 2026-10-13. Read AGENTS.md/docs/agents, #90 and #82 requirements/decision history and existing adapters/budget/contracts. Installed `spec-ticket-first-loop` and `tdd` loaded. `dev-workflow-rules`, `to-spec`, `to-tickets`, `implement-spec` are absent from exposed skills; dev-workflow source was not found locally. Equivalent requirement/to-spec and ticket/to-tickets confirmation performed IN THIS Claude session and published/read back BEFORE further implementation: [#90 confirmation](https://github.com/williamxhero/WAG/issues/90#issuecomment-6144755541), [#82 confirmation](https://github.com/williamxhero/WAG/issues/82#issuecomment-6144756645). Existing #90 confirmed, no replacement ticket. Hermes supervises only; no subagents/concurrent writer.

Defaults adopted without asking: native Node HTTPS/crypto (no SDK dependency), exact endpoint whitelist, Authorization bearer for Baidu and IQS, TC3 for Tencent, no retries/redirects, reject compressed responses (Accept-Encoding: identity), account tariff confirmation required for paid providers. Reason: smallest bounded implementation; rejection of compression eliminates decompression expansion entirely. Public test seams confirmed by default: exported transport/signing, adapter.search, persistent ledger and budgeted dispatcher. Equivalent implement-spec proceeds in this sole session.

Owned files only: gateway/provider-http-transport.mjs, gateway/provider-http-transport.test.mjs, this document. No server/search, evidence/news-verified, package, production or shared proxy edits. No credential-file reads or real provider calls. E4 remains claimed; budgets stay in existing persistent dispatcher, reserve before send, no refund/retry.

Acceptance: test-first actual RED/GREEN; fixed dummy TC3 golden checked with independent Python reference; exact endpoints/API/body feature guards; fail-closed missing/invalid credentials and unknown tariff; HTTPS certificate/hostname checking; no redirects; request/response/header caps; timeout/abort cleanup; sanitized failures; mock and real loopback TLS tests; durable-budget integration evidence; serial focused/full gateway tests, syntax/diff checks and exact-head Linux complete CI. PR Refs #82 and Closes engineering ticket; independent review before merge. No merge/close by worker.

## Source review

Public document GETs and official SDK downloads were performed by coder before takeover (not provider calls). Claude inspected the supplied SDK signing and WSA sources and re-executed the independent Python dummy reference; do not attribute coder's GETs to Claude:
- Baidu https://ai.baidu.com/ai-doc/AppBuilder/pmaxd1hvy : interface table and HTTP request specify Authorization: Bearer AppBuilder API Key; curl instead specifies X-Appbuilder-Authorization. Choose the normative interface/request definition; send only Authorization, no automatic fallback/double call. Live compatibility remains unverified; pageTime/page_time unresolved and unused.
- IQS https://help.aliyun.com/zh/document_detail/3062218.html : Authorization bearer, unified endpoint, CNLiteBasic. Paid contents disabled.
- Tencent https://cloud.tencent.com/document/product/1806/130616 and /121811 and TC3 docs /document/api/213/30654 returned JS challenges here, not readable current prose. Official Tencent SDK source retrieved as independent authoritative implementation fallback: https://github.com/TencentCloud/tencentcloud-sdk-nodejs/blob/master/src/services/wsa/v20250508/wsa_client.ts confirms wsa.tencentcloudapi.com, SearchPro and 2025-05-08; common/abstract_client.ts selects TC3-HMAC-SHA256 and service wsa. Signing reference common/http/http_connection.ts inspected before implementing. Do not claim challenge response verifies documentation prose or account price.

## Configuration boundary

Credentials injected explicitly by integration owner; module never reads environment/files. Future production file: /data/web-access-gateway/secrets/search-providers.env, fields APPBUILDER_API_KEY, IQS_API_KEY, TENCENTCLOUD_SECRET_ID, TENCENTCLOUD_SECRET_KEY. TENCENTCLOUD_WSA_APIKEY is unused; SecretKey is never bearer. Do not print credentials, headers, raw responses or underlying network errors.

Paid transport requires tariff confirmation for exact account version and a positive integer conservative per-call bound: IQS CNLiteBasic >=1 cent, Tencent lite >=2 cents. These minimums are not guarantees covering other versions/features. Integration must use the same or higher estimate in persistent dispatcher. Unknown tariff or standard/flagship rejected before any network dispatch. Baidu free-quota-only confirmation required; never enable paid overflow. No account opening or billing changes here.

## Public seam and safe integration contract

`createProviderHttpTransport({ name, credentials, tariff, timeoutMs = 5000, maxRequestBytes = 16384 })` returns a frozen async function accepting the existing adapter's `{ endpoint, api, body, maxResponseBytes, signal }`. It returns `{ status, body }`; non-2xx bodies are discarded, redirects are rejected, and networking/parser failures have only a fixed sanitized `message`/`kind` (no cause). No environment or file reads, proxy/global-agent reuse, retries, logging or automatic enablement. The optional `request` and `now` dependencies are TRUSTED offline seams, not untrusted runtime configuration. Do not expose them to callers.

Bounds: POST JSON only; exact endpoint strings (no query/fragment/custom port); UTF-8 request default 16 KiB, configurable 1–65536 bytes; response caller limit 1–1048576 bytes; incoming HTTP headers capped at 16 KiB by Node's parser. Outgoing headers are fixed names/values plus printable ASCII credentials of at most 4096 characters, bounding total header bytes below 16 KiB (SecretKey never appears in a header). Absolute total deadline 1–30000 ms, including TLS handshake and slow trickles, not an idle timeout. Native certificate-chain AND hostname validation remain enabled. Every failure/abort destroys response/request; success uses a nonpooled agent and closes the socket. Both the supplied body and actual serialized JSON are feature-validated before signing/sending. Unsupported compression is rejected, never expanded.

Configuration shapes:
- Baidu: `credentials: { apiKey }`, `tariff: { confirmed: true, freeQuotaOnly: true }`.
- IQS: `credentials: { apiKey }`, `tariff: { confirmed: true, version: 'CNLiteBasic', costCents }`.
- Tencent: `credentials: { secretId, secretKey }`, `tariff: { confirmed: true, version: 'lite', costCents }`.

`confirmed` means an integration owner has verified the EXACT account tariff and conservative bound, not merely that keys exist. Unknown tariffs, standard/flagship, IQS paid contents and other engine variants fail closed. TC3 signs exact UTF-8 POST `/` payload, canonical `content-type:application/json` and `host:wsa.tencentcloudapi.com`, signed headers `content-type;host`, UTC date/`wsa`/`tc3_request` key ladder; action `SearchPro`, version `2025-05-08`. Dummy golden is `7bf4126047eaf16a06f5328e1da13bad97087219cea0de4863e069ebed9f27d1` for timestamp1551113065 and the test's Chinese payload.

**Never call the transport directly in production.** It does not own the ledger or enforce quota. Existing `createBudgetedProviderSearch` must reserve before `adapter.search`, using the frozen transport's `estimatedCostCents` or a higher confirmed bound. Its default 1/2-cent floors do NOT automatically discover the transport estimate. Explicit integration (illustrative, not server wiring):

```js
// transports: Map of explicitly constructed/confirmed transports; budget: persistent ledger.
const providers = [...transports].map(([name, transport]) =>
  createProviderAdapter({ name, enabled: true, transport,
    ...(name === 'tencent' ? { site: 'mp.weixin.qq.com' } : {}) }));
const search = createBudgetedProviderSearch({ providers, budget,
  estimateCostCents: name => {
    const transport = transports.get(name);
    if (!transport) throw new TypeError('provider transport required');
    return transport.estimatedCostCents; // Use a higher verified bound if needed; never lower.
  } });
```

Keep one canonical private ledger outside replaceable releases. Cache hits skip reservation/network; failures, empty results, timeouts and aborts retain committed spend. Lost cache or response-version mismatch cannot refund usage. Provider dates remain E4 `claimed`/`unknown`, never page `verified`. This ticket changes neither dispatcher nor server routing. Account/version truth and billing upper bounds must be checked before a future canary; a 2-cent lite minimum is NOT sufficient for standard/flagship.

## Implementation/test/delivery results

Equivalent implement-spec and two-axis standards/SPEC review were performed by sole Claude session above, not independent review agents. `code-review` was loaded; its normal parallel subagent step was deliberately not run under the explicit no-subagents instruction. The git-guardrails skill was found to be configuration installation, not a delivery procedure; no hooks/settings were changed. Hermes remains the independent reviewer.

Executed in this session on local Node v26.7.0:
- Inherited draft baseline: 6/6 pass (not retrospective Claude RED).
- Serialized paid-feature regression: actual RED 0 pass/1 fail (`Missing expected rejection`), then GREEN7/7 after validating wire JSON.
- Abort-during-request-creation regression: actual RED0/1 (`false !== true`, request not destroyed), then GREEN11/11 after destroying the returned request and never ending/sending it once settled.
- Actual loopback TLS: trusted provider certificate accepted; untrusted and wrong-host certificates rejected before HTTP. Initial fixture lookup needed explicit IPv4 `autoSelectFamily: false`; this was a fixture compatibility failure, NOT a transport defect/TDD implementation RED.
- TLS response cases: split UTF-8, chunked overflow, declared oversize, 17 KiB headers, nonidentity compression, redirect, truncated content-length, invalid UTF-8, HTTP401 body discard; total slow-trickle deadline and active-response abort; socket drain and AbortSignal listener removal checked before fixture cleanup.
- Real TLS + adapter + persistent SQLite dispatcher for all three providers: independent ledger observer sees committed usage before request creation, higher 250-cent reservation from 200-cent transport estimate (not 1/2-cent defaults), normalized cache skips, E4 remains claimed, failed send is once/no refund, exhausted monthly budgets skip network, empty Baidu cache still consumes one free call, close/reopen preserves spend.
- Focused transport/adapters/budget/contract suite: **44/44 pass**, no skips. Transport suite12/12.
- Full gateway FOREGROUND serial run first failed with missing locked worktree dependencies:175 tests/121 pass/53 fail/1 existing skip. Authorized `npm --prefix gateway ci --ignore-scripts --no-audit --no-fund` installed133 locked packages; no package/lock changes. Full rerun: **464 tests/463 pass/0 fail/1 existing skip**, ~330 s. Logs retained in operator scratch as `wag90-gateway-full-1.log` and `wag90-gateway-full-2.log`. No tests weakened or unrelated timing repairs.
- Final standards review removed a developer-specific Windows scratch path from the committed tests: use native `tmpdir()` like neighboring tests, while execution sets TEMP/TMP/TMPDIR to the operator's explicit scratch directory. Final full FOREGROUND rerun: **464 tests/462 pass/1 fail/1 existing skip**, ~412 s. Unchanged `server-browser.test.mjs:251` expected waits `[0.001]`, got `[]`; isolated exact test rerun **1/1 pass**. Root cause unestablished; do not label latest Windows full suite green. No unrelated file/test changes or threshold relaxation. Final log: `wag90-gateway-final.log`; earlier green full run is retained, not substituted for final result.
- Independent Python TC3 reference re-executed and matches fixed literal; owned JS `node --check`, scoped diff/whitespace review performed. No generated TLS keys/DB/logs committed; test-owned scratch cleaned by hooks.

PR and exact-head complete Linux Node22 CI evidence will be filled after committed delivery/readback. No deployment, merge, issue closure, real authentication, credential read or provider network request performed. Live Baidu auth compatibility, Tencent account tariff/version, provider supply/quality, production connection and SPEC82 live exit criteria remain unverified.
