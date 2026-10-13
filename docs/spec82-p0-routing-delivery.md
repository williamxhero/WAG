# SPEC #82 P0 — guarded routing candidate and isolated single-engine probe

Date: 2026-10-13. Requirements/ticket phase complete. **Equivalent implement-spec active**, authorized in the same Claude session; [implementation receipt 6145249451](https://github.com/williamxhero/WAG/issues/92#issuecomment-6145249451) read back. Four-file implementation, offline/local verification, scoped commit/push and PR now authorized; no merge/close/live execution.
Parent: [#82](https://github.com/williamxhero/WAG/issues/82).
Engineering ticket / implementation truth source: [#92](https://github.com/williamxhero/WAG/issues/92), OPEN with `ready-for-agent`; initial exact body/label/state read back.
Stage receipt: [6145058624](https://github.com/williamxhero/WAG/issues/82#issuecomment-6145058624), exact body read back.
Parent ticket backlink / phase receipt: [6145189413](https://github.com/williamxhero/WAG/issues/82#issuecomment-6145189413), exact body read back.

## Ownership and workflow evidence

- Owning repository: `williamxhero/WAG`.
- Existing card: `t_0edfda1d`; sole writer: this Claude session. Hermes coder supervises only; default/Hermes owns integration and independent acceptance. No subagents or Kanban diagram/state changes.
- Actual SDK session ID: `a59a41a6-12c5-47e3-9b08-aa8061670e9b`, observed in this session's CLI tool-result directory, not invented.
- Workspace: `D:/WILL/TOOLS/web_access_gateway_proj/.worktrees/t_0edfda1d`; branch `wt/t_0edfda1d`; clean initial base/HEAD `15c15c51b1ff37902b924667306f5b21f52ea3ea`.
- Read AGENTS.md/docs/agents/*, full #82 body/current comments, #49/#60/#74 discussions, P0 baseline, overlay helper/test/config and CI. Root CLAUDE.md/CONTEXT.md/GLOSSARY.md/docs/adr absent in this worktree; supplied global CLAUDE.md applies.
- `dev-workflow-rules`, `to-spec`, `to-tickets`, `implement-spec` unavailable in exposed skills and searched repository/local skill locations. Loaded `spec-ticket-first-loop`, `tdd`, `grilling`; equivalent named phases in THIS Claude session, not fictitious slash invocation. Recommended grill defaults preapproved by user; no interview. Requirements-only phase completed first; equivalent implement-spec then explicitly authorized in this same session.
- `gh` confirmed `ready-for-agent` exists. Exactly one vertical engineering ticket, no replacement parent or decomposition framework. Failed first creation command was a shell parsing error before execution; use this document as body-file for creation/readback instead.

## Delivery purpose, evidence and readiness

Deliver safe candidate routing for existing enabled quark/chinaso news and a genuinely single-engine isolated comparison seam. Offline evidence proves isolation, configuration, protection and truthful reporting, NOT actual出口/supply restoration or publisher-date accuracy; it does not satisfy #82/#49/#60/#74 live exit gates.

Prerequisite evidence: [6144845062](https://github.com/williamxhero/WAG/issues/82#issuecomment-6144845062) and [6144960838](https://github.com/williamxhero/WAG/issues/82#issuecomment-6144960838). Explicitly authorized read-only public projection attachment: `C:/Users/will/AppData/Local/hermes/kanban/attachments/t_9e494161/wag-p0-upstream-routing-proof.json`.

Attachment revision: `9fea41204fdfa7a5cfa15b0ebd12904c520478ce`. Four installed routing files matched upstream SHA256 according to coordinator evidence:

| File | SHA256 |
|---|---|
| searx/network/network.py | 2ec932d6200c09c9776f269040282f68497653be57088b2d9eb96e6ec4580fdc |
| searx/network/client.py | 858e29c1aaac8b8264171e9778d02fc8dfbe8b492998cd3bbf32b079ecb118c7 |
| searx/search/processors/online.py | 8c36b397bbd405d7509d75e16f8cb97ea41a8df7a6214891cac74c1a33af6471 |
| searx/engines/__init__.py | 7c7c74151c00112bf95590b769886ee754b13b859c1d1542f36450a69543df19 |

Source/config projection shows absent engine.proxies inherits outgoing; explicit empty/null overrides; network.proxies also overrides. This is not a real direct/proxy result, CAPTCHA rate or latency comparison. Worker did not read installed production source or execute this attachment's AST experiment. Prior source-permission gap is NOT an engineering blocker.

Blocked by: none for offline engineering. #87/#90 are parallel with no shared files/dependencies. Missing local verified runtime/dependencies can block the **actual-parser evidence gate**, not this SPEC/ticket phase. Do not replace that gate with fake parser/mock evidence or request production access. API credentials do not block this work.

## Scope and hard write boundary

Only eventual owned delivery files:

1. `config/searxng/cn-routing-candidate.yml`
2. `scripts/searxng-route-probe.py`
3. `scripts/searxng-route-probe.test.py`
4. `docs/spec82-p0-routing-delivery.md`

The requirements round added only documentation/GitHub records. The next user turn explicitly authorized four-file implementation, tests, scoped commits/push and PR in this session. No merge/close or live execution; the earlier requirements-only boundary is historical, not a blocker. No other repository edits, especially #87 evidence-metadata/spec82-evidence, #90 provider-http-transport, server/search, production settings-overlay.yml, release.py, CI or dependency/lock files. Disposable later test artifacts must remain isolated under owning workspace, never another workspace's source or main.

## Default decisions and reasons

### Guarded candidate, not production apply

- Static template only `name: quark` / `name: chinaso news` plus `proxies: {}`. No disabled:false, new enablement, categories, timeouts, overseas/global fields.
- Existing merge-by-name APPENDS missing engines. Therefore **static candidate is NOT safe to apply to arbitrary settings**. Minimal offline generator filters against explicit resolved isolated settings: existing enabled/active domestic engines with neither explicit engine.proxies nor any explicit engine.network qualify. Missing/disabled/inactive engines never added/activated. Verified network.py:396-412 uses an explicit network mapping/reference instead of top-level network parameters; even network:{} without proxies must therefore be conservatively not_changed/operator_choice, not falsely direct. Unresolved defaults, ambiguous enabled state, duplicate names or malformed proxy/network shape fail closed.
- Preserve all explicit proxy choices, including empty/null and nested network.proxies. Report `not_changed` with bounded reason, not assumed direct. Overseas bing/yandex inheritance/operator maps, unrelated settings and shared 3s budget unchanged. Input immutable; guarded merge idempotent.
- Reuse existing helper.merge in memory only, never prepare/apply/verify/restore (service/readiness side effects). Regenerate eligibility/statuses on validation and reject mismatched engine/enabled/proxy-presence conditions on another input. This is an eligibility binding, not a hash of the whole settings: untouched operator proxy values remain untouched even if changed independently. No secret-bearing settings dumps/hashes.
- Reason: smallest compatible addition, respecting authoritative operator settings and preventing merge's missing-engine append from becoming enablement.

### Genuine single-engine parser path, not service bootstrap

- Allowed real names: already enabled quark/chinaso news and overseas bing/yandex. No disabled/new engines or new engine modules. Resolve actual backend defaults/settings without production reads.
- Prefer exact upstream imported engine.request/response with REAL searx utilities/exceptions/traits over full OnlineProcessor/service bootstrap. Use fixed revision above or independently verified installed source, verify hashes/revision and actual imported paths/dependencies. Four routing-file hashes do NOT prove selected parser hashes. No fake parser or AST-only extraction as parser integration.
- Public source retrieved this session via gh contents API at fixed revision: quark.py, chinaso.py, bing.py, yandex.py, online.py, searx/__init__.py and selected settings.yml entries. Quark/chinaso depend on real utils/exceptions; yandex requires search_type=web; bing requires real traits/locales/lxml. **searx package import invokes init_settings**. Supply isolated settings before import, never default production path; no server, network initialization, fetch_traits, helper HTTP calls or background fanout. Missing prerequisites are honest capability gaps, not fabricated functions.
- Configure private independent direct/proxy runtime configs. Proxy input is only explicit operator-provided isolated map, never environment proxy fallback. Experiment direct/proxy variants do not mean preserved candidate operator routes changed.
- Fixed Chinese cases: general `中国 经济 政策`; news `中国 科技 新闻`; day `中国 经济 政策`, category general and time_range=day. Chinaso general skips. Optional news-day is separately declared with category news/time_range=day, identical paired parameters. Language zh-CN, pageno=1, bounded samples, serial arms, no quota filling. Require enabled, category and genuine time_range support before requests; never remove time_range or claim publisher proof.
- Build pair's upstream request ONCE and copy to arms: query/category/language/time_range/body/headers/cookies identical, only independent transport route differs. Chinaso request creates random uid cookie; building twice would confound comparison. Keep generated cookie/header contents out of report.
- Never production `/search?engines=` (additive); no result-page fetching. Worker tests only offline/local mock. Public-source retrieval is not engine sampling.
- Reason: one imported real parser boundary is simpler than a whole SearXNG service and avoids uncontrolled init/network behavior. It does not reproduce full production processor/middleware/egress conditions; record that limitation.

### Shared durable safety ledger, not a scheduler

- One canonical persistent ledger identity for all comparison/canary arms, engines, processes/runs, outside disposable runs and release swaps. Explicit first initialization only; missing/corrupt/unavailable/locked state fails closed, no fresh automatic ledger/in-memory fallback. No separate per-arm/run/engine real ledger.
- Rolling 60s ceilings <=6 actual calls/engine, <=30 all domestic engines combined. Both routes count domestic engine usage. Atomic durable reserve BEFORE immediate request, failed/empty/timeout/CAPTCHA/crashed reservations never refunded. Crash between reserve/request stays charged; distinguish reservation from known actual attempt.
- Default minimal mechanism: stdlib SQLite transaction plus bounded Linux process lock around reserve -> immediate call -> outcome/CAPTCHA persistence. Cross-process serial dispatch avoids stale permits/concurrent requests after CAPTCHA; no daemon, queue, cron or generic scheduler. Independent databases allowed only for test isolation.
- Transport retries=0 and redirects disabled. No engine init/helper/background network. Exactly one actual send per reservation; additional calls require new reservations, unmediated fanout refused. Deadline <=3s TOTAL/request, bounded response bytes/results/parser work, not 3s per stage/read. No retry-to-fill behavior.
- CAPTCHA detection uses genuine parser exceptions plus conservative bounded challenge/header/redirect classification. Immediately stop engine's remaining arms/samples across processes/runs; persist >=30min pause and exponential consecutive trigger backoff. No bypass. Persist before releasing dispatch lock; outcome-storage failure poisons/fails closed subsequent execution.
- Persist wall/monotonic checkpoint and boot identity: rollback and wall-vs-monotonic jumps within/across runs, invalid clocks or ambiguous reboot transition fail closed. Wall-clock jumps/process restart never expire reservations or cooldowns/reset backoff. No automatic clock-error reset; documented operator safety recovery is a separate boundary, not CLI bypass.
- Reason: Python stdlib storage plus process locking is sufficient for this narrow serialized tool without dependencies or runtime framework. One shared ledger protects cooperative probe/canary callers only. Uninstrumented production search/other applications/full household-IP governance are NOT covered; do not claim production family-broadband protection is complete.

### Truthful sanitized partial reports

Report schema/mode/provenance/config-choice status; planned/reserved/actual attempted/skipped; per-engine/arm/case/sample result_count/elapsed/status enums and limitations. Retain complete/partial report for exceptions, interrupts, runtime errors and disabled/unsupported/cooldown/rate/clock skips. Attempted != successful != nonempty; unknown latency/percentages for unattempted arms remain unknown.

No raw response/results/URLs, cookies/auth/header/proxy endpoints or exception/cause text. Bounded typed errors only. Mock evidence is `offline_mock`; genuine imported parser on synthetic response is `offline_parser_fixture`; neither is live出口 evidence. Actual live source/config identity and egress confirmation remain Hermes acceptance responsibilities.

## Preapproved minimal public interfaces / test seams

These fit the ONE probe script, not separate scaffolding:

- `generate_candidate(settings, template)` -> guarded minimal overlay + sanitized statuses; validate/merge against same resolved input, no production writes/service calls.
- `load_engine(source_root, revision, engine_entry)` -> actual verified imported request/response parser + provenance/capabilities; independent runtime config, no automatic download/network/bootstrap.
- `ProbeLedger(path).reserve(...)`, CAPTCHA outcome/checkpoint and sanitized snapshot -> durable safety decisions. Clock and bounded transport injected only at external test boundaries.
- `run_probe(plan, runtime, ledger, transport)` -> sanitized complete/partial report. CLI only offline generate/validate and explicit bounded probe, no deploy/restart/cron. Explicit isolated settings/source root/operator map/shared ledger, no production/env/credential discovery. Output only to explicit new isolated targets, no overwrite of existing production config.

Exact spelling may follow surrounding idiom at implementation without changing behaviors. User's recommended-default approval confirms these seams for later TDD. Mock runtime implementing the interface cannot supply actual-parser evidence.

## Acceptance / vertical test-first RED-GREEN plan

Each slice: ONE seam-level regression -> execute actual RED/retain failure -> minimum GREEN -> next slice. No bulk tests first or weakening valid tests.

1. Candidate missing/disabled and explicit top-level/nested proxy preservation; truthful not_changed, overseas/unrelated/3s unchanged; idempotence/input mismatch rejection; no production mutation/service invocation.
2. Genuine verified single-engine parser, independent configs, identical paired requests including chinaso cookies; disabled/category/time-range skip before transport. Wrong revision/hash/import path/missing dependency refuses safely.
3. Restart/cross-process rolling 6/7 boundary; shared domestic 30/31 (synthetic ledger IDs for sum tests do not expand real engine allowlist); both arms counted, concurrency, failed/crashed no refund, no stale permits, missing/corrupt/locked storage refusal.
4. CAPTCHA stops remaining arm/sample AND queued process; persisted >=30min cooldown and repeated exponential backoff across run/restart; no quota completion/bypass.
5. Clock rollback/forward jumps/cross-run/reboot/nonfinite clocks fail closed, no expiry/reset loophole, attempt counts stay bounded under races/delays.
6. Redirect/retry/fanout refusal, total deadline and byte/count limits with local mocks; no parser/helper uncharged HTTP. Partial/error reporting preserves counts and rejects secret/cause/raw-response leak sentinels.
7. **Mandatory separate actual-parser offline integration gate**: ACTUALLY import verified runtime and invoke request/response on explicit synthetic quark/chinaso/bing/yandex fixtures as applicable, including parse/CAPTCHA and zero HTTP side effects. No hand-written replacement, AST-only extraction or mock-to-live claim. Missing runtime is gate NOT RUN/BLOCKED, not passed.
8. Focused new suite -> existing overlay suite -> all applicable scripts/*.test.py, serial gateway+proxy, crawler deterministic suite, tracked syntax/diff checks. WSL Ubuntu because release.py imports fcntl. If Windows-linked worktree metadata fails Linux git ls-files, use isolated Linux copy UNDER owning workspace, matching source diff/identity, not main. Preserve skips/failures honestly.
9. Later separately authorized scoped commit/push/PR main: Refs #82, Closes engineering ticket; full exact-head Ubuntu Node22/Python CI readback; default/Hermes independent review. Worker no merge/close.

Current CI already discovers scripts/*.test.py and provisions PyYAML but **not a SearXNG runtime**. Do not alter CI or silently assume runtime import succeeds. Default deterministic tests must prove missing-runtime safe refusal. Actual-parser gate additionally needs explicit isolated verified source/dependency provisioning and reproducible source hashes/import evidence, with **no downloads during offline tests**. If unavailable, retain limitation and withhold complete acceptance; exact-head core CI cannot substitute for this gate. Public fixed archive and isolated WSL dependencies were provisioned separately. The genuine request/response/parser+utils+exceptions gate has now actually run; final counts and commands are recorded below. Core CI's two deliberate fixture-provisioning skips do not substitute for this separately executed gate.

## Non-goals and live authorization gates

No SSH, real engine requests, production config reads, deployment/apply/upgrade/restart, shared proxy/sing-box changes, CAPTCHA evasion, new/disabled engine enablement, server/search wiring, credentials/env/auth reads, subscription/threshold freeze, long-term monitoring/cron or whole-family governance. No lowering #82/#49/#60/#74 gates.

Actual comparison only after Hermes independent acceptance and explicit serial authorization. This phase does not provide it. Subsequent worker is still offline/local mock; public source retrieval allowed. No fake transport samples presented as real出口 data. No production mutation means rollback/restore evidence is not applicable now, not fabricated.

## Implemented interfaces and operating limits

- All four owned files implemented. Candidate generation/validation uses only helper.merge; never imports/calls service operations. Static template is not an apply-ready settings file.
- `ProbeLedger.initialize(root)` / `attempt(engine, domestic, send)` / `snapshot()` are the durable test seams. CLI fixes root to `/var/lib/wag-route-probe`, without `--ledger` or environment override. `/var/lib/wag-route-probe.identity` is the separate, exclusive-create lifetime anchor; loss of state/DB cannot initialize a fresh ledger. Root/path aliases, identity mismatches, missing/corrupt/locked storage refuse. Anchor/state destruction by a privileged operator is outside cooperative protection; do not delete/reset them. Reboot, clock poison or unfinished attempt requires separately approved operator recovery, not an automatic reset command.
- Linux fcntl nonblocking exclusive lock spans reserve/send/outcome, so a queued/concurrent process refuses immediately rather than waiting with a stale permit. SQLite synchronous=FULL commits reservation first; failed sends never refund. Finish-time stamps conservatively retain the reservation for 60 seconds after completion, preventing connection delay from expiring a recent actual send early. CAPTCHA persists pause >=1800 seconds, doubles consecutive trigger pauses (bounded at 2^16 multiplier), and resets strikes only after verified nonempty success. Empty/error responses do not reduce protection.
- OneSendTransport uses Python stdlib http.client, separate direct/proxy connection objects, no environment proxy fallback, redirects/retries/auth retries/result fetches. Explicit non-authenticated HTTP proxies only (`all://`, `http://`, `https://` keys); unsupported schemes/auth/configuration refuse, not fallback. Live send also requires the active canonical-ledger dispatch and verified EngineRuntime. CLI requires explicit isolated settings/source/proxy inputs and `--authorized-live`; no source download at execution.
- Total request deadline includes request construction plus connect/read/parser work. Parent watchdog kills the isolated one-request child at 2.8 seconds minus construction time, leaving cleanup margin inside the 3-second budget; native parser work or swallowed signal alarms cannot extend dispatch. No subsequent request if child termination cannot be confirmed. Source verification/import/provisioning is preflight, not engine-request latency. Linux scheduling is not a hard-real-time guarantee; over-budget elapsed values are not clamped into a false <=3s measurement. Tests' local HTTP server threads cause Python's fork deprecation warning; actual CLI is a bounded serial main-thread tool, not a threaded service integration.
- Response body <=262144 bytes; reject compression, redirects and >100 parsed results. Standard http.client header bounds also apply. Conservatively classify CAPTCHA body markers, Yandex header, 403/429 as challenge; false positives intentionally stop rather than bypass. Reports distinguish known initiated network connection attempts (`actual_attempted`) and HTTP request invocation (`http_attempted`), neither guarantees remote receipt. Reservations and unfinished/unknown attempts are separate. Connection failures are still charged and count as initiated network attempts, while HTTP-only attempts remain false.
- run_probe preserves the full planned arm list, copies one generated pair request including cookies, and stops after CAPTCHA/interrupt/storage/clock errors. Unattempted arms have no invented latency. emit_report preserves already-known counts on output collision/failure and never overwrites an existing target. Offline mocks are not live results.

### Reproducible genuine parser provenance

Public download: `https://codeload.github.com/searxng/searxng/tar.gz/9fea41204fdfa7a5cfa15b0ebd12904c520478ce`.
Archive SHA256: `4065d39a15d33f717c002d7196d39694902943f95f75f6970d78365856cd5cf7`.
Runtime manifest SHA256: `883ada98b2f81e6734c900510c6b375e958d81a9775e821fc1cad564f30e5863`.
Exactly 364 files: every `searx/**/*.py`, every `searx/data/*` file recursively and `searx/settings.yml`; sorted relative UTF-8 path + NUL + binary SHA256(file), concatenated then SHA256. Each extracted file was additionally compared byte-for-byte to its pinned archive member. Native Windows tar exited 2 on unrelated `utils/templates/etc/apache2 -> httpd`; all 364 verified runtime files matched, so no claim of a completely successful archive extraction. Four routing hashes above independently matched the downloaded source too.

| Actual imported parser/support file | SHA256 |
|---|---|
| searx/engines/quark.py | f1d5deb7ca7801ff0941a1f1702af2a019918a858806a3b2d2ae4810efe87273 |
| searx/engines/chinaso.py | 6bae6decce7abf4312a203fbc2185b10be5c4766b4aed4a7e6508ce466f0896e |
| searx/engines/bing.py | ab2efa12f0dfcb607abed2222f092e22e9ecda516cd2afe11f5de21853b131cb |
| searx/engines/yandex.py | 5a4bf5fd6891b64412b247e0b7e1326101aea5c7ef3865a58afaf1d079246622 |
| searx/utils.py | a4e28ed1923aa72e9d411047f7812b24fd2c9bbe751885306686a7153160b597 |
| searx/exceptions.py | 40b796a2baed9f1282e715829b0f7df6182b741a43033b760af15831c7a5bab5 |
| searx/enginelib/traits.py | 8741e3d0ce3de2aff4d3b98d7b56c74b0c5c52b059522c4f2dc7ca224f2c9131 |

Importer verifies before import and refuses unrelated preloaded searx. Real package init_settings receives temporary explicit isolated YAML with engines=[], retries=0, proxies={}, 3s, public/debug off, and SEARXNG_DISABLE_ETC_SETTINGS=1. No production discovery/network.initialize/fetch_traits. Actual imported utils/exceptions paths were asserted inside verified source root. Bing uses real EngineTraits plus packaged ENGINE_TRAITS. Quark general/Yandex web are bounded supported backends; conflicting overrides refuse. Chinaso source selection is preserved. Fixture request/response calls prove Chinese query/day parameters, parsed results, empty ChinaSo, Quark/Yandex CAPTCHA exceptions and capability/disabled skips with zero public engine traffic.

### Actual RED/GREEN and verification evidence

Genuine vertical RED logs retained only in authorized `.route-probe-test/` (not staged): missing module; operator maps (5 subcase failures); ambiguous settings; missing ledger; domestic30/31; CAPTCHA pause; rollback/forward/monotonic/reboot/nonfinite clocks; crash reservation; reset/alias; sanitizer/interrupt; domestic identity; missing real importer; Bing missing traits; pair/cookies/counts; failed-connect accounting; post-send clock counts; inactive entries; swallowed deadline; conservative delayed-send window; canonical live identity; missing CLI; preflight report; construction budget; network mapping effectiveness; backend override; output collision; checkpoint interrupt. Every failure was actually executed before its minimum fix; original shell wrapper's exit2 and native tar exit2 are not described as successful test runs. HTTP-only failed-connect invariant was retained as `http_attempted=false`, alongside a new genuine RED->GREEN asserting network-attempt true; no valid protection test weakened.

Commands run from owning workspace (W denotes its WSL `/mnt/d/.../.worktrees/t_0edfda1d` path):

```sh
wsl -d Ubuntu -- python3 W/scripts/searxng-route-probe.test.py
wsl -d Ubuntu -- python3 W/scripts/searxng-overlay.test.py
wsl -d Ubuntu -- env WAG_ROUTE_SOURCE=W/.route-probe-test/searxng-9fea41204fdfa7a5cfa15b0ebd12904c520478ce W/.route-probe-test/venv/bin/python W/scripts/searxng-route-probe.test.py
wsl -d Ubuntu -- python3 W/.route-probe-test/full-linux.py
```

Source provisioning was separate from offline tests: pinned archive, isolated WSL venv, pinned upstream requirements installed exit0 (including Babel2.18.0/lxml6.1.1/PyYAML6.0.3/msgspec0.21.1). Locked crawler fixture dependencies and npm packages also provisioned separately, no manifest/lockfile changes. Independent Git Linux copy under owning hidden test directory avoids Windows worktree .git metadata; copied owned source bytes and SHA256 are recorded by the full runner. Node22.20.0 / Python3.12.3; isolated Playwright cache.

### Checkpoint verification readback (2026-10-13)

Operator directed immediate scoped checkpoint commit/push/draft PR before waiting for full local regression. This is durable engineering delivery, **not full acceptance**. No additional dependency copying/provisioning is planned. PR/head/exact-head CI links will be recorded on #92 and the PR; no old-head check substitutes for exact-head acceptance.

| Gate / retained log | Actual outcome |
|---|---|
| `focused-final.log`: direct new-suite invocation above | 34 tests in 9.427s, OK, 2 deliberate separately provisioned parser-fixture skips |
| `actual-final.log`: pinned source + isolated venv invocation above | 34 tests in 46.380s, OK, **zero skips**; actual Quark/ChinaSo/Bing/Yandex request/response and real utils/exceptions |
| `full-searxng-overlay.test.py.log`: direct existing overlay invocation | 12 tests in 1.791s, OK |
| `overlay-final.log`: later unittest discovery with a dotted script filename | Exit 5, 0 tests, NO TESTS RAN; invocation error, **not PASS** and does not erase the earlier direct 12/12 result |
| `full-bootstrap.test.py.log` | 11 tests, OK |
| `full-release.test.py.log` | 3 tests, OK, skipped 1 |
| `full-deploy.test.py.log` | 41 tests in 332.471s, FAILED (errors=2): existing complete-offline-rehearsal and staged-wrapper `prepare` subprocesses exceed unchanged 30s deadlines |
| `full-searxng-route-probe.test.py.log` (earlier snapshot) | 32 tests, OK, skipped 2; superseded for owned code by final 34-test results above |
| full gateway/proxy, crawler and all tracked syntax | Full runner terminal completion unavailable after operator process stop; gateway log already contains failures/startup timeouts. Crawler/syntax not verified by that incomplete runner; overall local full **not passed** |
| `filesystem-mre.log` | Locked gateway package copy from WSL `/mnt/d` took **81.419s**, Express import 2.135s; independently exceeds deploy's 30s deadline and supports filesystem overhead diagnosis, not proof that every failure has the same cause |
| `native-retry-summary.log` | Corrective isolated dependency-storage attempt exited 1 in Express preflight: `Cannot find module 'body-parser'`; did not reach full suites. Preserve this failure; no endless reprovision/copy loop |

Final review added two genuine vertical RED/GREEN regressions: `red-uncertain-termination.log` failed because an unconfirmed child termination was incorrectly finalized; its minimum fix retains the durable NULL outcome and blocks all subsequent engines. `red-presend-interrupt.log` exited 2 with unhandled KeyboardInterrupt before reservation; its minimum fix emits sanitized interrupted/unreserved accounting. Both are included in the final 34-test gates. Existing tests and safety thresholds were not weakened. Python 3.12's threaded-local-fixture fork deprecation warning remains visible.

The operator separately corrected supervision comment 6146161276 in 6146233212: the reported source_invalid was an outer MSYS `$PWD` path issue, not upstream-source corruption. This worker uses absolute `/mnt/d/...` fixture paths; the mandatory 364-file digest remains `883ada98b2f81e6734c900510c6b375e958d81a9775e821fc1cad564f30e5863`, unchanged.

After checkpoint PR publication, operator authorizes exactly one normal integration merge of `origin/main@bddc4a7` into this branch, contingent on fetched target readback, then focused/actual-parser verification and final-head push. No manual edits outside the four owned files or conflict resolutions without reporting. This is not permission to merge the PR to main.

- Requirements/tickets and equivalent implement-spec receipt: published/read back as linked above. Final #92 SPEC synchronization and checkpoint/CI receipts are pending at this checkpoint.
- Independent review: default/Hermes responsibility, not performed by worker.
- Live direct/proxy comparison: **NOT RUN**, separately gated; no #82/#49/#60/#74 acceptance/closure claim.
- Production deployment/upgrade/apply/restart/SSH/config reads: **NOT PERFORMED**. No production mutation; rollback/apply evidence not applicable.
- Scoped four-file commit/push/PR authorized; worker does not merge/close issues or mutate Kanban.
