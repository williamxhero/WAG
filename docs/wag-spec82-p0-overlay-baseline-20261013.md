# SPEC #82 P0: Chinese search egress and engine baseline

Date: 2026-10-13
Status: read-only baseline and proposal; no production configuration or service changed.
Parent: [WAG SPEC #82](https://github.com/williamxhero/WAG/issues/82)
Related: [#49](https://github.com/williamxhero/WAG/issues/49), [#60](https://github.com/williamxhero/WAG/issues/60), [#74](https://github.com/williamxhero/WAG/issues/74)

## Goal and boundary

P0 asks whether domestic/direct versus proxy egress can be compared safely and whether a minimal per-engine SearXNG overlay can express the intended routes. This is a Delivery-phase evidence task, not production deployment. The accepted boundary is repository/source/test inspection, authorized SSH read-only version/config inspection, and review of already-recorded read-only samples. No production search sampling was issued in this task because the existing experiment record already has 120 serialized requests. No credentials were read; no route, proxy selector, shared sing-box file, settings.yml, or service was changed or restarted.

The SPEC's initial rate ceilings are retained for any separately authorized future experiment: at most 6 requests per engine per minute and at most 30 requests across all Chinese engines per minute, counting baseline and treatment arms together. A CAPTCHA must stop that engine's sampling; do not retry it to complete a sample quota. These are ceilings, not targets.

## Current repository behavior

- Authorized read-only SSH check on Oct 13 confirmed `/data/searxng/current` resolves to `/data/searxng/releases/20260827_143211`, `searxng.service` is active, and `/config` reports SearXNG version `2026.8.22+9fea412`. The loopback URL `127.0.0.1:8801` was not listening; the configured LAN listener `192.168.50.2:8801` responded. Only filtered, non-sensitive fields were retained; the full `/config` body was not copied into this report. This version/read is specific to this check time.
- Filtered live `/config` showed: yandex and bing enabled for general/news, neither supports `time_range`; quark enabled for general/news and supports `time_range`; chinaso news enabled for news and supports `time_range`; baidu, sogou, and 360search disabled (360search timeout 20s). This is an engine capability snapshot, not evidence of query success or proxy route behavior.
- `config/searxng/settings-overlay.yml` has an `outgoing.proxies.all://` default to the local proxy and reviewed 3-second shared timeout settings. It does not define domestic-direct versus overseas-proxy routing.
- `scripts/searxng-overlay.py:51` merges engine entries by name and fills absent mappings; `:55-59` deliberately preserves an existing `proxies` mapping rather than overwriting operator/backend choices. Per-engine overlay fields can be merged, but the helper does not prove that an empty or absent engine proxy map bypasses SearXNG's inherited global proxy. Therefore route selection is not yet safe to assert from the repository alone.
- The apply wrapper snapshots first and invokes apply only after prepare (`scripts/searxng-apply-overlay.sh:43-48`). Apply replaces settings and restarts SearXNG (`scripts/searxng-overlay.py:293-297`); restore uses the retained exact settings snapshot and restarts an originally active service (`:263-279`). Those are deployment operations and are explicitly out of scope without authorization.
- Overlay tests assert merge idempotency, operator proxy preservation, and the reviewed timeout/engine pool (`scripts/searxng-overlay.test.py`). The end-to-end apply test shadows `systemctl`, `ss`, and `curl` with stubs and uses a disposable settings file; it does not touch production.

## Existing read-only evidence

The newest paired experiment is `docs/wag-pool-ab20-20261013.json`, summarized in `docs/wag-pool-ab20-20261013.md`. It contains 20 pairs per class (120 requests total), serialized and interleaved, with request parameters, result counts, producing engines, failure classifications, and elapsed times. It compared no `engines` parameter against native `engines=` pool additions; it did not switch egress routes or alter gateway pool configuration.

| Class and exact request shape | Arm | Zero results | Result-producing engine evidence | p50 / p95 ms | Main recorded failures |
|---|---|---:|---|---:|---|
| general: `q=中国 经济 政策`, `categories=general`, `language=zh-CN`, `format=json` | baseline | 18/20 | yandex produced results in 2/20 | 629 / 3007 | quark CAPTCHA/suspension; yandex timeout/suspension |
| same general query | `engines=yandex,quark` | 17/20 | yandex in 3/20; quark none | 187 / 3007 | quark CAPTCHA/suspension; yandex timeout/suspension |
| news: `q=SearXNG documentation`, `categories=news`, `language=en`, `format=json` | baseline | 20/20 | none | 298 / 443 | quark CAPTCHA; yandex timeouts; one chinaso news timeout |
| same news query | `engines=yandex,quark,chinaso news` | 14/20 | yandex in 6/20; quark/chinaso none | 496 / 3006 | quark CAPTCHA; yandex timeout/suspension |
| strict day: `q=Federal Reserve interest rate decision`, `categories=general`, `time_range=day`, `language=en`, `format=json` | baseline | 20/20 | none | 3 / 4 | quark CAPTCHA; one yandex timeout |
| same strict-day query | `engines=quark` | 20/20 | none | 3 / 4 | quark CAPTCHA |

All 120 requests returned HTTP 200 and the record reports no client/HTTP errors. The strict-day zero-result response is not a successful freshness result. No arm requested direct egress, no response is a direct-versus-proxy comparison, and the news/day samples are English rather than Chinese. This evidence therefore does not establish Chinese news/day behavior, a direct-path capability, or that egress is the cause. There is no honest direct/proxy result count, CAPTCHA rate, or latency to report from this evidence.

- The prior `docs/wag-strict-day-engine-candidates-20261010.md` records read-only `/config` candidate inspection and explains that SearXNG `engines=` is additive: specifying a pool does not mean other engine failures in the response are excluded. Current version and filtered engine state were read in this task as described above. Effective per-engine proxy routing is still unverified.

## Minimal proposal (not applied)

1. Keep the existing global proxy default, shared timeout, enabled engine set, and production gateway pools unchanged in the first review. Do not edit the checked-in production overlay as a speculative route experiment.
2. The authorized read-only version and filtered `/config` snapshot is complete. Before drafting route entries, verify from that exact release's source whether per-engine `proxies` overrides can force selected overseas engines through the proxy and selected domestic engines direct despite `outgoing.proxies.all://`. A local fixture can validate the merge, but cannot answer HTTPX/SearXNG fallback semantics. The installed source files returned permission denied to the SSH user, and `rg` is not installed on the server; this semantic check remains a capability gap unless read access is provided through an approved means.
3. If the deployed release supports that behavior, the smallest candidate is only per-engine proxy routing fields for the already-reviewed domestic and overseas engine names, with no engine enablement changes and no shared proxy edits. Preserve existing operator proxy maps. Put the candidate in a disposable settings fixture first and assert the complete effective projection and preserved unrelated/proxy fields. Do not apply it to production as part of this task.
4. For a later authorized route comparison, use identical Chinese general/news/day queries, language, categories, and time window in both arms. Run serially and report per engine and class: actual request parameters, result count, producing engine, unresponsive engine and classified reason (including CAPTCHA), and elapsed time. Enforce a shared rate ledger across both arms: <=6 requests/engine/minute and <=30 Chinese-engine requests/minute. Stop on CAPTCHA; report incomplete sample counts rather than retrying.
5. A production application would require a separate explicit authorization for the overlay change and SearXNG restart. Rollback evidence must include the unique prepare snapshot, verified effective provenance, and successful restore/readback. No restart or restore was attempted here because no mutation was made.

## Acceptance and verification

- Workspace rules read: `AGENTS.md`, `docs/agents/issue-tracker.md`, `docs/agents/domain.md`, and `docs/agents/triage-labels.md`.
- Focused offline test: `wsl -d Ubuntu -- bash -lc 'cd /mnt/d/WILL/TOOLS/web_access_gateway_proj/.worktrees/t_9e494161 && python3 scripts/searxng-overlay.test.py'` -> `Ran 12 tests ... OK`.
- Native Windows `python scripts/searxng-overlay.test.py` is not a valid environment for this Linux helper: 11 tests errored because `scripts/release.py` imports Linux-only `fcntl`; one integration test skipped. WSL Ubuntu is the valid execution evidence.
- `git diff --check` passed after the documentation change.
- `scripts/deploy.test.py` was also attempted under WSL but cannot run from this Windows-linked worktree: its subprocess `git ls-files` calls fail because Git's worktree metadata path is Windows-formatted. This is an environment/path limitation, not an observed test assertion failure.

## Authorization gates and limitations

Human/operator authorization is required before changing or deploying the production overlay, testing a real direct/proxy route switch, or restarting SearXNG. Authorized SSH read-only checks of version and filtered `/config` do not require an additional authorization gate; the checks in this task used that permission and suppressed secrets/configuration details. No credentials, anti-CAPTCHA mechanisms, extra engines, or shared sing-box changes are proposed. Existing findings and gates in #49/#60/#74 remain open; this report does not claim their acceptance criteria pass.
