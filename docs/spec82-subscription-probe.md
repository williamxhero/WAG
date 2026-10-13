# SPEC82 P2 — isolated bounded subscription probe

Engineering: [#99](https://github.com/williamxhero/WAG/issues/99), parent [#82](https://github.com/williamxhero/WAG/issues/82).

This is executable validation tooling, **not a production subscription list**. The read-only
`subscription-validation-20261013.json` contains 91 unique draft routes, all originally
`unknown` / `not_checked`. Tooling and synthetic tests do not change those facts, prove route
availability, demonstrate 95% accuracy, or freeze production v0. No live feed/publisher run or
RSSHub deployment is performed by this engineering task. After independent review and merge,
default may perform the separately authorized live run and retain its evidence outside the checkout.

## Operator prerequisite: isolated official RSSHub

- Official project: <https://github.com/DIYgod/RSSHub>; deployment reference:
  <https://docs.rsshub.app/deploy/>. Official image repositories are
  `docker.io/diygod/rsshub` and `ghcr.io/diygod/rsshub`.
- Browser-dependent routes require the official **`chromium-bundled`** image variant;
  do not silently call the plain image browser-complete. For this mixed draft catalog,
  use that variant, then resolve and record its actual platform manifest digest and run
  `ghcr.io/diygod/rsshub@sha256:<verified-manifest-digest>`, not a moving tag. Record platform,
  release/tag, digest, effective nonsecret configuration and Chromium availability with the run.
  This document intentionally supplies no invented digest and does not assert a pulled image.
- Bind the dedicated container's port 1200 only to `127.0.0.1:18081` (or another explicit
  unused 1024–65535 port other than 8000, 8080, 8317). Never expose it on `0.0.0.0`.
  Use independent disposable state, not a shared WAG/RSSHub/proxy instance or production volumes.
- No cookies, user credentials, secret environment files, authenticated routes, custom/shared
  proxy, or alternative egress. Do not mount secrets or inject provider tokens. There is no
  authenticated-route fallback. The overseas three sources remain honestly failed/blocked when
  unavailable; do not modify the shared proxy to make them pass.
- **Before starting RSSHub or invoking `run`, the operator must verify ownership, route terms,
  robots rules and permission for feed and publisher retrieval.** The flag is an attestation,
  not a robots parser. Do not pass it without that review. Rejected query/fragment/userinfo URLs
  (including signed URLs) cannot be enabled by a flag.

Important boundary: the probe's socket/rate/request caps apply to **probe → RSSHub and
probe → publisher**, including redirects. RSSHub's upstream fan-out/cache/browser traffic is
not observable or bounded by this client. The operator must separately isolate/control that
service's upstream traffic and check its route-level terms before a live run. There is no Docker
start/download command in the probe. This writer did not start or download any Docker service.

## Invocation and durable resume

Python 3.12+ standard library, Node 22+ and the gateway's existing locked npm dependencies
are required. The evidence bridge never fetches; HTML crosses stdin only, then is discarded.

Create an evidence directory **outside the checkout**. With a fixed, explicit UTC clock:

```sh
python scripts/spec82-subscription-probe.py run \
  --artifact /outside-checkout/spec82-run.jsonl \
  --origin http://127.0.0.1:18081 \
  --now 2026-10-13T04:00:00.000Z --window rolling_24h \
  --operator-approved > /outside-checkout/spec82-coverage.json
```

The clock above is an example, not the time to reuse for a new live run. `calendar_today` uses
the accepted Asia/Kuala_Lumpur civil-day policy; `rolling_24h` is UTC and requires instant precision.
The existing resolver/evaluator supplies inclusive boundaries and future-date handling.

Resume with **the same artifact, origin, clock, window, catalog and implementation**. Never
unlink or truncate a failed/interrupted artifact to retry it. The hash-chained JSONL binds
full source identity, catalog bytes, resolved window, origin, immutable policy, implementation
hashes and operator attestation. Every attempt and socket reservation is flushed and fsynced
before connecting; an attempted logical request is never reissued. A reserved request without a
terminal response freezes its hostname on resume, including the entire loopback feed origin.
A truncated/corrupt/mismatched journal or simultaneous writer fails closed. An exclusive `.lock`
file is normal; the OS releases the lock at process exit. The chain detects corruption but is
**not a signature/authentication scheme**: preserve the artifact in trusted operator storage.

Recompute counts offline from that same journal (no operator flag or network needed):

```sh
python scripts/spec82-subscription-probe.py aggregate \
  --artifact /outside-checkout/spec82-run.jsonl \
  --origin http://127.0.0.1:18081 \
  --now 2026-10-13T04:00:00.000Z --window rolling_24h
```

`aggregate` still requires the matching implementation and Node offline window resolver.
Do not point a new binary at an old journal and claim it resumed successfully.
Failures emit fixed stderr tokens, never raw exceptions, response headers, credentials or HTML.

## Bounds and stop policy

- Serial, concurrency 1. One logical feed attempt per route; no retry or alternate-address retry.
- Feed must have actual RSS channel/items or namespaced Atom entries. HTML 200 is not a feed.
- Select the first **three unique admissible publisher URLs in feed order**, deduplicating
  repeated items. Invalid URLs are counted, not durably retained. Fewer admissible links remain short.
- Global page cache avoids another fetch of a known page/final URL. Redirecting to an already
  requested URL fails closed rather than sending it again; it can leave a conservative short sample.
- Each logical fetch: at most 10 seconds of network time, 1 MiB body, 16 KiB accepted headers,
  two redirects. All hops together: at most **364 socket reservations**; redirects consume the
  same global budget, so 91 + 273 is an upper cap, not a promise of complete coverage.
- Rolling 60 seconds: at most 30 global reservations and 6 per hostname. Rate waiting happens
  before network work; all redirects share the original fetch deadline. Resume retains rate history.
- Publisher URLs: public HTTP(S), default ports only. All DNS answers must be global unicast;
  connect to the checked literal IP, retain original Host/TLS SNI, revalidate each redirect.
  Reject mixed/private/mapped/transition/scoped addresses, credentials, queries, fragments,
  secret-shaped paths and unsafe schemes. No environment proxy, automatic cookies or auth headers.
- TLS certificate and hostname validation are mandatory. Untrusted/wrong-host TLS fails, never
  downgraded. Size, encoding, timeout, redirect and transport failures are retained without retry.
- 403, 429 or CAPTCHA stops the corresponding host. Feed HTML 200 stops the isolated origin.
  Remaining routes are recorded blocked with `host_stopped` and `no_request: true`; this does
  **not** mean the routes do not exist. Page-host stop does not authorize another URL on that host.
- No bypass, alternate egress, infinite redirect, recursive crawl, or automatic new-artifact rerun.

## Evidence and interpretation

JSONL contains exact `name/tier/group/route/source_line/note`, source URL, feed structure/count,
selected item dates, page and final URL, body SHA256, retrieval time, fixed window, sanitized
raw publication fields, classification and evidence provenance. Full XML/HTML, titles, authors,
headers and arbitrary exception text are not retained. The SHA256 is a commitment, not enough
to reconstruct discarded HTML; independent content reproduction requires separately authorized retrieval.

The offline Node bridge calls the existing
`extractPageEvidence(..., { chinesePublicationDates: true })`, `evaluateSpec82Evidence` and
`resolveNewsWindow`. Canonical/og:url/JSON-LD article identity must match the acquired final URL.
Different-article claims conservatively make the sample unknown. E1/E2 page proof can verify;
RSS/Atom dates are E4 claimed only, never verified. Unknown timezone, Event/other nonarticle
JSON-LD, sidebar noise, invalid civil dates and future dates cannot become verified proof.
Day precision remains day precision, not a fabricated instant.

A cached shared page retains its first acquisition's evidence and E4 diagnostics; each source's
sample event separately retains its own feed dates. Cache reuse never promotes feed dates to
page proof. The bridge accepts no manufactured status/label as proof.

Python computes counts from actual journal events. Every source has a fixed denominator of **3**,
and the catalog denominator is **273**, including blocked, unknown and short samples. Per-source
page counts deduplicate final URLs. Verified counts represent source sample slots, not 273
independent fetches. `raw_event_counts` exposes actual attempts, socket reservations, responses,
feed/page results, sample references and stops. Without independent human labels, `accuracy`
is always `null`; this is coverage only, never the SPEC's real-page accuracy exit metric.

## Offline acceptance / handoff

```sh
python scripts/spec82-subscription-probe.test.py
```

All embedded fixtures are explicitly **synthetic/offline**, using ephemeral local HTTP/TLS,
trusted test-only DNS/socket mapping, temporary certificates and the actual HTML evidence bridge.
These mappings are not CLI options and do not weaken live DNS/TLS gates. OpenSSL is required for
the real TLS fixture (failure is not silently skipped). Test temporary files stay outside the repo.

Behavioral RED/GREEN receipts and broader verification results belong in #99/#82 and the PR.
The existing CI discovers `scripts/*.test.py`; no CI file, package, lock, catalog, production
reader/server/search/evaluator or #96-owned file changes are required. Complete exact-head Linux
CI and independent default review remain necessary. No merge/close or production rollout is done
by this writer; the live 91-route/max-three-pages validation is default's post-review handoff.
