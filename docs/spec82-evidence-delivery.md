# SPEC82 Chinese page evidence delivery (#87)

2026-10-13; Kanban `t_3a3dc071`; implementation session `75a7d153-6702-444d-9e6e-5007bc45e3c0`; branch `wt/t_3a3dc071`, worktree `.worktrees/t_3a3dc071`; clean base HEAD/origin/main `15c15c51b1ff37902b924667306f5b21f52ea3ea`.

## Goal, approval and boundary

Delivery toward stable Chinese supply: this card supplies **offline Chinese E2 extraction and an independent page-only SPEC82 policy**, not real supply improvement, production integration or a 200-page accuracy result. [#82](https://github.com/williamxhero/WAG/issues/82) remains the SPEC; [#87](https://github.com/williamxhero/WAG/issues/87) the engineering ticket. #85/#86 were independently accepted/merged prerequisites. No replacement SPEC, task, subagent, Kanban state change, provider call, credential/.env read, real source scrape, server/search/MCP integration, shared-proxy change or threshold relaxation. #88 remains unreleased pending independent acceptance/merge.

Installed skills/local sources did not provide `dev-workflow-rules`/`implement-spec`; this session performed equivalent implement-spec phases, **not an invoked slash**. Approved equivalent to-spec/to-tickets receipt: [6143037417](https://github.com/williamxhero/WAG/issues/82#issuecomment-6143037417). Start/default decisions published and read back in [#87 receipt](https://github.com/williamxhero/WAG/issues/87#issuecomment-6144622851) and [#82 receipt](https://github.com/williamxhero/WAG/issues/82#issuecomment-6144623419). Credentials/subscription-v0 approval do not block this offline card. Hermes/default owns independent acceptance and merge; this session does neither merge nor close issues.

## API and adopted defaults

```js
import { extractPageEvidence } from '../gateway/evidence-metadata.mjs';
import { resolveNewsWindow } from '../gateway/news-verified.mjs';
import { evaluateSpec82Evidence } from '../gateway/spec82-evidence.mjs';

const checkedAt = '2026-10-13T04:00:00.000Z';
const page = extractPageEvidence(html, finalUrl, {}, checkedAt, {
  chinesePublicationDates: true,
});
const window = resolveNewsWindow({ window: 'calendar_today', now: checkedAt });
const verdict = evaluateSpec82Evidence(page, window, {
  checked_at: checkedAt,
  auxiliary: [{ source: 'url.pattern', on: '2026-10-13', precision: 'day' }],
});
```

- `extractPageEvidence` adds an optional fifth argument; **default false** leaves existing extraction/routing unchanged. With opt-in, it removes recognized peripheral regions, scans all publisher selector declarations (deduplicating matching DOM nodes), applies Chinese rules, and adds `publication_candidates` containing all parsed declarations with `raw` provenance. `conflicts` retains disagreeing declarations, including different timezone-less times on the same day. The existing date parser is reused; exported `normalizePagePublicationDate` adds strict ISO/civil-date validation before it, rejecting rollover dates and invalid clocks.
- Chinese rules require `article`/`main` scope, an explicit 发布时间/发布日期 label or same-block source-adjacent date; accept `YYYY年M月D日` and `YYYY-MM-DD HH:MM` with optional seconds/explicit zone. Inline tags are transparent; block boundaries are not. Bare body dates are not proof. Conservative noise exclusion: aside/footer/nav, sidebar/comment/recommendation/related/today hooks, recognized section headings, hidden regions and scripts other than JSON-LD. No domain-specific rules or source data are invented.
- `evaluateSpec82Evidence(pageEvidence, resolvedWindow, {auxiliary, checked_at})` is pure/offline. Input page records must come from the **opt-in extractor above**, not a legacy page result (which lacks the tightened contextual/entity filtering) or untrusted source claims. Named labels are provenance contracts, not cryptographic authentication. Auxiliary records can never declare E1/E2, even when a caller supplies a known HTML label. Arrays contain temporal records (`source`, `kind`, `value`/`on`, `precision`); call-side `source_kind`/`evidence_level` claims are not authoritative.
- Only known publication meta/JSON-LD `datePublished` and explicit publication time/Chinese sources qualify as E1/E2. Arbitrary `html.*`, generic DC/date metadata, `dateCreated` and `uploadDate` are not automatically promoted. Bare `html.article time[datetime]` is ineligible for SPEC82. URL/sitemap E3 is auxiliary only; `feed.*`, `api.*`, `provider.*`, `searxng.*`, GDELT E4 is `claimed` when dated, otherwise `unknown`. Neither fills the page publication fields. E4 disagreements remain diagnostics, not page proof or vetoes.
- Returned fields: `status` (`verified`, `claimed`, `unknown`, `out_of_window`), `evidence_level`, `source`, nullable `published_at/published_on/precision/evidence_url/checked_at`, `diagnostics`, `conflicts`, `conflict_count`, nullable `reason`. Page dates can remain in the diagnostic publication fields for unknown/out-of-window results; **consumers must filter on status**, not field presence. Conflicts resolve `unknown` with `reason=conflicting_evidence`; they are never hidden or resolved by picking the latest date.
- Reuses `resolveNewsWindow` and `classifyVerifiedWindow`: instant boundaries inclusive; future unknown; prior evidence out_of_window. `rolling_24h` never verifies day precision. Day-only evidence may verify only under existing `calendar_today` semantics (Asia/Kuala_Lumpur civil day). This is the window timezone, **not an assumed publisher timezone**; no Asia/Shanghai default is added. Timezone-less time-of-day stays unknown under both windows and never becomes midnight or an instant.

These defaults deliberately minimize compatibility changes and prefer conservative false negatives over false verified. `gateway/news-verified.mjs` and server/search routes are untouched: SPEC78 controlled feed-item verification remains available under its own policy.

## Independent WIP blocker and JSON-LD boundary

[#87 comment6145005019](https://github.com/williamxhero/WAG/issues/87#issuecomment-6145005019) identified an event time being treated as publication:

```html
<article><p>活动开始于<time datetime="2026-10-13T03:30Z">10月13日</time>，发布日期不详。</p></article>
```

At `2026-10-13T04:00Z`, the pre-fix opt-in returned verified/E2. Regression RED reproduced it and explicit `@type:Event/datePublished` promotion (10 pass/2 fail). GREEN after the opt-in-only fix: 12/12. Naked article time is now ignored unless marked `pubdate`/`itemprop=datePublished` or directly adjacent to a publication/source label within the same block; explicit hook/context positives and unchanged legacy behavior are tested. The SPEC82 provenance classifier also rejects the naked generic article-time label.

For opt-in JSON-LD, explicit types are restricted to `Article`, `NewsArticle`, `BlogPosting` (schema.org HTTP(S) IRIs accepted); all types in an array must qualify. Event/Product/Organization/WebSite/Person and mixed Event+NewsArticle do not prove publication. **Untyped `datePublished` remains supported** because no explicit entity claim contradicts it; this is a bounded compatibility choice, not general JSON-LD entity linking. Other article subtypes/graphs linking a page to an article are not inferred. Legacy extraction is unchanged.

## Actual RED/GREEN and local execution

Windows Node **v26.7.0**, all tests foreground and file-serial. `npm --prefix gateway ci --ignore-scripts --no-audit --no-fund` succeeded (133 existing packages); package/lock unchanged, no new dependency. Initial dependency probe failed `ERR_MODULE_NOT_FOUND` for local jsdom before installation; not a product test result.

Every slice used `node --test --test-concurrency=1 gateway/spec82-evidence.test.mjs`:

| Slice | RED evidence | GREEN |
| --- | --- | --- |
| Chinese publication labels/inline/day/opt-in | 0 pass/1 fail; null instead of 2026-10-13 | 1/1 |
| Source-near dates/noise | 1 pass/2 fail; missing source-near date, aside promoted | 3/3 |
| Page-only policy + legacy feed | module missing, 0 pass/1 file fail | 5/5 |
| Duplicate declarations/conflict audit/E3 | 5 pass/1 fail; duplicate meta conflict count0 | 6/6 |
| Strict civil-day/time/precision validation | 7 pass/1 fail; Feb30 rolled to March2 | 8/8 |
| Modification/partial-token exclusion | 8 pass/1 fail; dateModified became publication | 9/9 |
| Auxiliary must not masquerade as page | 9 pass/1 fail; auxiliary HTML label verified | 10/10 |
| Independent event-time + non-article JSON-LD blocker | 10 pass/2 fail; both verified instead of unknown | 12/12 |

Zoned start/end/future/day boundaries were also actually executed; these tests already passed when added, **not claimed as an extra RED**. All HTML fixtures are explicitly synthetic, embedded in the test module, not real site samples.

Commands/results:

1. `node --test --test-concurrency=1 gateway/spec82-evidence.test.mjs gateway/evidence-metadata.test.mjs gateway/news-verified.test.mjs gateway/news-feed.test.mjs gateway/search.test.mjs`: 79/79 before final slices; 80/80 before independent blocker fix.
2. `node --test --test-concurrency=1 gateway/*.test.mjs` first full: **462 tests,460 pass,1 fail,0 cancelled,1 skip**, exit1,355217ms. Unchanged `read-pinning.test.mjs:164` failed `TypeError: fetch failed`, cause `Error: bad port`, inside MCP client/undici. No related code/assertion/port setup was changed; exact intermittent cause is not established. The log remains part of evidence, not silently replaced by the rerun.
3. After blocker fix, `node --test --test-concurrency=1 gateway/spec82-evidence.test.mjs gateway/evidence-metadata.test.mjs gateway/news-verified.test.mjs gateway/news-feed.test.mjs gateway/search.test.mjs gateway/read-pinning.test.mjs`: **92/92**, exit0,17522ms. This includes an unchanged-file isolation check for the prior failure, not a claimed fix for its intermittent cause.
4. After blocker fix, `node --test --test-concurrency=1 gateway/*.test.mjs`: **464 tests,463 pass,0 fail,0 cancelled,1 skip**, exit0,352042ms. Skip is the existing opt-in GDELT live test; no real requests were enabled.
5. `node --check gateway/evidence-metadata.mjs`, `node --check gateway/spec82-evidence.mjs`, `node --check gateway/spec82-evidence.test.mjs`: exit0. `git diff --check`: exit0. Final staged/commit whitespace gates checked at publication.

Sanitized failing-output excerpts are retained durably in [spec82-evidence-failures.log](spec82-evidence-failures.log). Complete local raw logs (`red1..8.log`, `green1..8.log`, `focused*.log`, `gateway-full.log`, `gateway-full-final.log`, `npm-ci.log`) remain in this session's scratch directory `C:/Users/will/.claude/jobs/75a7d153/tmp` while the job exists. Windows success is **not** Linux CI. Exact-head complete Linux gate, PR and final implementation receipt are recorded on #87/#82 after publishing; no CI result is inferred from local execution.

## Limitations and handoff

Not a 200-page corpus or accuracy/recall benchmark; no real common-50-domain rules, WeChat script dates, source availability/supply, billing/authentication or production runtime proof. `main`/`article` plus explicit same-block contexts miss other layouts; conservative noise hooks and subtype/precision conflicts can over-reject. Strict input parsing supports ISO-style page dates (not arbitrary RFC822/compact dialects); no timezone database or publisher-local date inference is added. Different precision declarations may be conservatively conflicting; E3 day comparisons use the existing normalized civil/UTC `on` representation, not inferred publisher locality. No cache/fetcher/concurrency integration is implemented. Existing window semantics/thresholds remain unchanged.

Final action: PR is handed to Hermes/default for independent acceptance/merge. Parent #82 and engineering issues are not closed by this session; #88 is not released. Real integration and SPEC exit criteria remain separate work.
