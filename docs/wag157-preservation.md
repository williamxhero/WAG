# WAG #157 — preservation receipt (#160)

Read-only snapshot of the historical resources, taken 2026-11-19 at 07:40–07:45 UTC. This is an inventory and recovery receipt, not a product, release, or cleanup approval. Scope: [#157](https://github.com/williamxhero/WAG/issues/157) AC-P1, AC-P2 and the AC-P8 preservation prerequisite, as scoped by [#160](https://github.com/williamxhero/WAG/issues/160).

## Fresh inventory

- WAG: one Git common-dir, 68 local branches, 50 `origin` tracking heads (excluding the `origin/HEAD` alias), and 48 live remote heads from `git ls-remote --heads`. All 48 live OIDs match tracking. `origin/wt/t_16c55db1` and `origin/wt/t_7ef88678` are tracking-only; retained, not pruned. Five other local refs were recorded; one points to a tree, so commit ancestry does not apply to it.
- 34 WAG worktree registrations: 33 directories exist, 10 registrations are detached, and `.worktrees/119-crawler-teardown` is missing and prunable. Its registered HEAD is `59769ad`, not the current local teardown branch tip. Compared with the earlier audit, only `codex/wag157-integration` and `codex/wag157-160` and their worktrees were added; they are #157 resources, not old evidence. Ten other historical side directories under the worktree containers are not separate registered checkouts.
- No tracked status changes in the 33 WAG worktrees at capture. Eleven had untracked entries. The original root has 86 normal-status entries (one more than the earlier audit: `docs/architecture/`) or 1,659 with file-level expansion. Counts use Git's ignore rules and exclude submodule interiors; they are not a backup list.
- SearXNG: 26 affiliated top-level directories: 19 Git checkout directories in 15 common-dirs and seven receipt directories without their own Git marker. The 19 match the earlier checkout list; the extra seven were outside that list, not evidence of recent creation. Thirteen checkouts share one HEAD tree and three share another; matching objects do not make their work files interchangeable. Large deletion counts and mixed mode/link/checkout differences are not established product changes. `searxng-spec103-a-lf-proof-v3` has no resolvable `HEAD^{commit}`; its status counts do not prove a valid checkout. One fork patch comparison failed because Git could not read an object; the exact comparison and error are in the private inventory. Neither unknown was treated as clean or equivalent.

The inventory maps each observed ref and registered worktree to its repository, exact object or explicit unknown, status where applicable, and retain disposition. Ancestry and patch comparison use WAG's fixed baseline, or the historical SearXNG comparison base where present. Repository or worker association is not evidence of a personal writer. No historical directory or ref is a cleanup candidate on this evidence.

## Source pins, not integrations

WAG tracking and live `main`: `6481f551d3406d450a62a0a6e52311a107b7f076`. Local `main` at `c64b469` is +2/−2; the B candidate at `075f7f4` is +6/−17. Local diagnostic `f8ee7de` is an ancestor of remote diagnostic `50ee77c`, which is not in the baseline. Git patch comparisons and exact path blobs show that `6f687fa`'s provider-routing fixture and `9abbd42`'s server-engine-pool fixture already match the baseline; `9abbd42` itself is a CI recheck, not another fixture change.

| Retained commit | What was confirmed |
| --- | --- |
| `412f7f0e2b83139c72e1db4bcf3839303d505867` | T0.2 design/runner source retained in local history; experiment files absent at the baseline. No baseline measurement claimed. |
| `e586b03cce19e3a65eb7014e15903ebf48fde5c4` | #122 README query-syntax section present at source, absent at the baseline. |
| `ba8d49cb983d50c786d8a0a5bcee714a3e282a2b` | #125 offline RRF module and test absent at the baseline; detached `wag125-main-verify-v1` HEAD and surviving refs resolve to or contain the source. |

## Private recovery

Locate the session's `evidence-160/` directory beside the #160 worktree, not in the repository. Use `inventory.json` for ref/worktree/copy coordinates and `preservation.json` for exact source, ownership class, byte count, SHA-256 and disposition. Keep both the evidence directory and the original locations; a digest alone cannot recover bytes.

| Disposition | Evidence groups in `preservation.json` |
| --- | --- |
| 64 verified copies | 10 handoff/status files, 2 household/Tencent drafts, 15 WAG148 receipt/report files, 31 frozen #122/#125 receipt/oracle files, 3 unused local stand-in sources, and 3 immutable Git blobs. |
| 34 retained in place, not copied | Two loop state files and the adjacent ticket map (potentially sensitive values, not inspected); 31 named historical failure/test records (raw output risk). Recovery depends on the originals. |

For a copied item, copy its recorded `backup/` entry into fresh private scratch and compare its SHA-256 and byte count to the manifest. The recorded exercise compared the original, backup and freshly restored file. For an in-place entry, locate the original by its private `source` field and verify its recorded digest locally; do not publish or replay it. Non-allowlisted material, including configs, dependency caches and arbitrary raw logs, was not copied.

The T0.2 runner is `backup/t02/run-baseline.py.txt`, 9,081 exact bytes from blob `ea51336a13f508e90445a392492fcf2cfe938b97` (`412f7f0:reports/spec82-p0-baseline-20261028/run-baseline.py`). The detached RRF source/test were likewise recovered from Git blobs at `ba8d49c`, not the working copy. Recover Git sources with binary-safe `git cat-file blob <blob-id>` output into private scratch, never by running them. All copied code, including the unused stand-in, is inert `.txt` history; the stand-in is not A's protection package or a build/import dependency.

Manifest SHA-256 at capture:

- `inventory.json`: `4b5110f619554e35c55f4adc9fd912217bea3e64a112a092dfd255dba694b61a`
- `preservation.json`: `5739d84744208dedb226d61b825a01c6de0ac152d063a0f7d1fdacc675fcee99`

No old runner or loop was run. #160 verification covers inventory, recovery and this document only. Parent AC-P7 (including Linux broad) is for the stable combined candidate, not this document commit.
