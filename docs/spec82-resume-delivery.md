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

## Durable budget and opt-in dispatch (#86)

`gateway/provider-budget.mjs` uses built-in `node:sqlite` (unflagged capability requires Node22.13+; Node22 remains experimental). No new npm dependency, daemon, environment credential read, production schema or route change. Local probe was Node26.7.0/SQLite3.53.4; the production binary version is **not inferred** from bootstrap fixtures. Future deployment must probe its actual binary and SQLite support before enablement.

`createPersistentBudgetLedger({databasePath,initialize,now,...})` requires an absolute file path. `initialize:true` is explicit first provisioning using exclusive `wx` creation (mode0600), never truncation. Normal reopen requires an existing regular single-link file, schema version1 and SQLite quick_check. Missing, corrupt or replaced files fail closed; no automatic repair/recreation or memory ledger substitution. Parent directory must already exist, be private and application-owned. Provision exactly one canonical local filesystem DB path for all workers, outside runtime candidates/rollback/cleanup (future suggested path `/data/web-access-gateway/data/provider-budget/budget.sqlite`, **not created here**). Do not point different workers at different files or rewind a backup to recover allowance. Whole-machine loss/DB deletion requires manual accounting recovery, not re-initialization.

Daily and monthly usage rows retain historical period keys (UTC, matching existing contract), including monthly call counts. Each reserve uses `BEGIN IMMEDIATE`, reads/checks all caps, updates usage and persistent clock high-water, then commits with `synchronous=FULL` before returning permission. Snapshot is transactionally consistent. Lock waits are bounded (default1s, maximum5s); storage, corruption and commit failure raise sanitized `budget_storage_error` and do not dispatch. Backward timestamps below persisted high-water raise `budget_clock_regression`, including across new instances/processes. This intentionally sacrifices availability on NTP/clock rollback until the clock catches up; it cannot reopen quota. No reset or refund API.

Cost floors: Baidu0, Aliyun1cent, Tencent2cents. [LiteBasic pricing](https://help.aliyun.com/zh/document_detail/2862023.html) ¥8/1000 is 0.8cent/call; [Tencent lite pricing](https://cloud.tencent.com/document/product/1806/121798) ¥14/1000 is 1.4cent/call. Round each attempted call upward, independent of invoice rounding: maximum500 Ali calls/250 Tencent calls per month (daily caps may reduce these). Higher integer estimates supported; lower/zero paid estimates rejected, Baidu nonzero rejected. Defaults remain100/20/12 per day,500 cents each paid provider/month and1000 combined/month. Global cap may only be lowered, not raised above SPEC. Current public prices are not actual account/settlement verification; Tencent standard/flagship, optional paid IQS features, price changes or requests outside WAG are not covered by this assumed unit cost. Before real enablement, authenticate/account-confirm the chosen tariff and disable unbudgeted features; do not claim production ¥10 billing guarantee from these offline tests.

`createBudgetedProviderSearch` requires the durable ledger, skips disabled adapters before reservation, uses adapter query/mode/window/provider/site/count cache identity and existing TTLs, and tries providers sequentially. Storage/config errors escape; only typed upstream errors fall through. Nonempty result stops; successful empty results are cached too. Cache hits do not reserve; cache is bounded, per-instance, volatile, and results are normalized/frozen. Lost caches after restart cannot restore budget; they can only consume remaining allowance more quickly. Failed/empty/timeout attempts stay charged; crash after commit but before send may waste allowance by design. No network transaction is held while awaiting the provider.

### Budget TDD / execution evidence

Foreground command for ledger slices: `node.exe --test --test-concurrency=1 gateway/provider-budget.test.mjs`.

1. Persistent reopen RED: new module missing,0 pass/1 fail. First implementation test cleanup failed EPERM because directory cleanup ran before DB closes; fixture cleanup order corrected (not a product pass). GREEN1/1.
2. Daily/provider/global caps RED1 pass/2 fail (101st Baidu and501st Ali cent incorrectly allowed); GREEN3/3.
3. Storage/clock fail-closed RED3 pass/3 fail (rollback accepted, missing file recreated, raw lock error); GREEN6/6.
4. Cross-process/kill/deletion/logical-corruption verification added after atomic implementation:9/9. These are actual subprocess executions, not a claimed additional RED cycle. Four processes32 Ali attempts => exactly20 allowed; two500cent contenders => exactly one allowed; forced process kill after committed Tencent reservation =>2cents retained.
5. Durable dispatch/cache RED: missing exported dispatcher; GREEN focused all three provider files30/30. Real SQLite commit failure injected at the DB boundary, separate real lock transaction, reopen visible before transport, failures/empty remain charged, cache expiry and disabled/no-memory checks included.

### Review fixes and final verification record

Independent read-only budget review reproduced deleted daily/monthly counter rows reopening exhausted allowance despite SQLite quick_check. Regression RED11 pass/1 fail; reconciliation validates all current-month daily totals/caps against monthly calls and rejects orphan rows before any authorization. GREEN combined31/31; independent follow-up confirmed fix,12/12 scoped tests. This catches inconsistent missing counters, not arbitrary coordinated tampering/deletion of both counters and clock.

Full serial suite exposed constructor contention: the synchronous PRAGMA could read a locked schema before busy_timeout was installed. A real cross-process250ms exclusive lock reproduced it, RED12 pass/1 fail. Install bounded busy_timeout first; GREEN final combined **32/32** (13 budget,8 adapter,11 legacy). Existing long-lock failure test remains; no retries/reset or weakened assertion. Syntax and diff whitespace checks passed.

Windows Node26 full gateway runs were executed foreground with complete logs and **are not claimed green**:

- `gateway-ticket86.log`:451 tests,448 pass,2 fail (screenshot encoded-budget subtest plus parent),1 existing live skip. Expected artifact_too_large, got request. Unchanged `gateway/crawl-response.test.mjs` isolated rerun16/16 passed; exact intermittent cause not established.
- `gateway-ticket86-rerun.log`:451 tests,449 pass,1 fail,1 skip. Cross-process budget opening failed; the constructor-lock RED/GREEN above fixes the identified ordering defect.
- After that fix `gateway-ticket86-final.log`:452 tests,447 pass,4 fail,1 skip. Budget13/13 passed. Unchanged health shell tests exceeded `<7000ms`/`<5000ms` elapsed thresholds (never-answer subtest plus parent, core-only); unchanged engine-pool fixture failed with fetch `bad port` after OS-assigned port selection. Focused serial healthcheck+engine-pool rerun39/39 passed. No unrelated files/tests/thresholds were changed. These Windows full-suite instabilities remain an acceptance caveat, not erased by focused passes.

Adapter checkpoint `b79271026100339d8c6fcdd50f6c347bfcdaee23` complete Linux CI was read back **success**: [run38383561500](https://github.com/williamxhero/WAG/actions/runs/38383561500), including every syntax gate, gateway+proxy, locked Chromium, Python release/CLI and crawler tests. This predates the budget module and does **not** establish its Node22 compatibility. Final budget checkpoint must run the same exact-head gate; the subsequent outcome/run URL belongs in the PR/tracker acceptance receipt. Production runtime/account verification remains out of scope.

Remaining implementable work: #87 Chinese E2/page-only policy, then #88 real isolated FTS5 experiment. Coordinator separately reported Python SQLite3.53.1 FTS5 capability and a one-document unicode61/pretokenization probe in #82 comment6143054856; that is **not a benchmark executed by this session** and no backend winner/source-quality conclusion follows. Legacy SPEC78 feed-item verification remains unchanged. Credentials/account configuration, user subscription-v0 approval and later threshold confirmation remain the true manual gates for their respective real integrations, not blockers for these remaining offline tickets.
