# WAG engine supply governance (SPEC #74)

Implementation record for the minimal, in-repo part of [SPEC issue #74](https://github.com/williamxhero/WAG/issues/74):
explicit, opt-in engine pools by layer, strict-layer capability validation, a stable failure-reason
enum, a bounded in-memory cooldown for the classes that carry no SearXNG suspension, and the
`engine_pool` / `failure_classes` / `cooldown_engines` diagnostics. It reuses the existing readiness
judgement, `time_window_strict` semantics and news-quality modules; it changes none of them.

## What changed

- `gateway/engine-health.mjs` (new) — pure functions and a small state machine:
  - `classifyFailureReason(raw)` maps every raw reason observed by the SPEC sampling matrix
    (`暂停服务: 验证码`, `验证码`, `暂停服务: 超时`, `超时`, `请求过于频繁`, `服务器 API 错误`, `意外崩溃`,
    `拒绝访问`) plus English equivalents to `captcha | timeout | rate_limited | upstream_error | crash |
    forbidden | unknown`.
  - `validateStrictPool` / `supportsTimeRange` keep only `time_range_support=true` engines in the
    strict layer and report the rejected ones.
  - `createEngineHealth` is the bounded local cooldown. Only `timeout | upstream_error | crash` are
    locally cooled (the classes SearXNG reports *without* a `suspended_time`); `captcha`,
    `rate_limited` and `forbidden` keep SearXNG's own suspension and are never doubled. The first
    failure cools for `cooldown_ms`, each repeat doubles it, capped at `state_ttl_ms`. After the
    cooldown the engine is half-open; a success clears its state, another failure extends the
    cooldown. State is in-memory only — a restart forgets it.
- `gateway/search.mjs` — selects the layer (strict when `time_range` is set, else news when the
  category is `news`, else general), applies the configured pool to the outgoing `engines=`
  parameter, never asks an engine inside its cooldown, feeds the selected response back into the
  health state, and attaches the supply diagnostics. An explicit caller `engines` list always wins.
- `gateway/server.mjs` — forwards `engine_pool` / `failure_classes` / `cooldown_engines` through the
  `web_search` output schema and logs the resolved pools at startup.

## Configuration (all default to today's behaviour)

| Variable | Default | Effect |
|---|---|---|
| `WAG_SEARCH_ENGINE_POOL_GENERAL` | `""` (empty) | Engines appended for a plain (no `time_range`, not news) query. |
| `WAG_SEARCH_ENGINE_POOL_NEWS` | `""` | Engines for a `categories=news` query without a `time_range`. |
| `WAG_SEARCH_ENGINE_POOL_STRICT` | `""` | Engines for a query with `time_range`; only `time_range_support=true` engines are kept. |
| `WAG_SEARCH_ENGINE_COOLDOWN_MS` | `30000` | First-failure local cooldown for `timeout/upstream_error/crash`. |
| `WAG_SEARCH_ENGINE_STATE_TTL_MS` | `90000` | Cooldown ceiling / state TTL, matching SearXNG's `suspended_time` magnitude. |

Empty pools send no `engines=` parameter at all, so an unconfigured deployment is byte-for-byte
unchanged and fully rollback-safe. Nothing here changes the shared sing-box / proxy nodes, the
SearXNG overlay, auth, SSRF handling or the native availability gate.

## Diagnostics (additive only)

`engine_pool: { layer, engines, source, rejected?, cooling? }` appears when a configured pool shaped
the query; `failure_classes` whenever the backend reported engine failures; `cooldown_engines`
alongside a shaped query. A plain search with no pool and no failures grows no new key.

## Tests

- `gateway/engine-health.test.mjs` — the failure enum in full, pool parsing/validation, strict-layer
  rejection, cooldown / half-open / bounding, and that non-locally-cooled classes are not cooled.
- `gateway/search-engine-pool.test.mjs` — layer selection, pool application, caller-`engines`
  precedence, cooldown exclusion across requests, `failure_classes`, and old-request compatibility.
- `gateway/server-engine-pool.test.mjs` — the same diagnostics and the shaped upstream query crossing
  the MCP contract, plus a no-pool gateway forwarding no pool keys.

Run: `node --test --test-concurrency=1 gateway/*.test.mjs` (all green, 384 tests) and
`node --test --test-concurrency=1 proxy/*.test.mjs` (real-browser routing tests need the CI-provided
Playwright/crawler fixtures).

## Unresolved external engine limitations (not fixed here)

- `naver` is the only engine proven to answer a strict `day` window and is still `disabled` in the
  overlay, so strict-time supply stays single-engine until an overlay change is approved. Its results
  also carry no `publishedDate`, so it rescues zero-results but proves no freshness (that is #73).
- The second time_range-capable, dated engine for strict `day` is still missing.
- `bing` returning zero results / timing out is still unexplained (same as 2026-10-08).
- Supply governance and news quality remain separate reports; this change does not raise
  `published_at` coverage or relevance.

Supply metrics are still produced through the existing `news-quality.mjs` /
`search-quality-probe.mjs` modules; no parallel evaluation module was added.
