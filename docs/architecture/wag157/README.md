# WAG #157 delivery snapshot (2026-11-19) architecture

Show what #157 restores and which acceptance gates still separate the candidate from delivered software.

**Read from.** docs/HANDOFF.md (document); docs/wag157-preservation.md (document); https://github.com/williamxhero/WAG/commit/3ce71b5526741c3f7c837dbb1373a5b40a221fb6 (code); https://github.com/williamxhero/WAG/blob/3ce71b5526741c3f7c837dbb1373a5b40a221fb6/README.md (code); https://github.com/williamxhero/WAG/blob/3ce71b5526741c3f7c837dbb1373a5b40a221fb6/gateway/spec82-rrf.mjs (code); https://github.com/williamxhero/WAG/blob/3ce71b5526741c3f7c837dbb1373a5b40a221fb6/gateway/spec82-rrf.test.mjs (code); https://github.com/williamxhero/WAG/blob/3ce71b5526741c3f7c837dbb1373a5b40a221fb6/reports/spec82-p0-baseline-20261028/README.md (code); https://github.com/williamxhero/WAG/issues/159 (external); https://github.com/williamxhero/WAG/pull/163 (external); https://github.com/williamxhero/WAG/pull/156 (external); https://github.com/williamxhero/searxng-ex/pull/4 (external); 2026-11-17 historical delivery analysis (document).

> Generated from the analysis by archlens. Edit the analysis, never this file.

## What this architecture answers

### What belongs in the restoration candidate?

**What was restored and what remains separate?**

The historical local and remote main diverged. A branch or a green check is not a deployment receipt.

Use the #161 source pin above #160, plus the reviewed #162 handoff. Observed canonical main and the frozen A and B heads are separate, unpromoted identities.

[Open the diagram](restoration.architecture.html). 3 components.

| Component | Responsibility |
|---|---|
| **#160 Preserve** | Records recovery coordinates without cleaning history. |
| **#161 Restore** | Restores query docs, offline RRF and T0.2 design selectively. |
| **#162 Reconcile** *(partial)* | Aligns delivery evidence for the remaining #157 gates. |

**Deliberately not shown.** Historical branch inventory, full runtime graphs, raw receipts and untracked audit inputs are not projected.

#### The long read

Follow preservation into selective recovery: #122 query docs, #125 offline RRF, and the T0.2 design. #128 is NOT RUN, and the old runner is inert. #162 makes the evidence legible without editing the state snapshots or restarting a job.

The separate evidence view records the three detached ref identities. Canonical main CI covers its old SHA; A Integration is for fork PR #4 only, and B failed at PR #156. The earlier #163 draft is not combined-candidate proof. Stop on mismatched SHA or missing fresh evidence.

#### Terms used here

- **RRF**: Reciprocal Rank Fusion; here only a deterministic offline core.

### Which gates remain after #157?

**Which acceptance prerequisites remain and what is independent?**

An edge is an acceptance prerequisite, not network activity. Status describes evidence or proposed delivery, not deployed code.

#157 gates #158, then #107 and #108. The existing quality gates demand their own evidence; #121 is independent and frozen.

[Open the diagram](gates.architecture.html). 5 components.

| Component | Responsibility |
|---|---|
| **#161 Restore** | Restores query docs, offline RRF and T0.2 design selectively. |
| **#162 Reconcile** *(partial)* | Aligns delivery evidence for the remaining #157 gates. |
| **#158 Reconcile A** *(planned)* | Reconciles approval, artifact identity, ABI and owning main without replacing A. |
| **#107 Wire B** *(partial)* | Owns WAG consumer enforcement of the single approved A contract. |
| **#108 Guard release** *(planned)* | Owns migration, guarded release and rollback evidence without resetting protection state. |

**Deliberately not shown.** Detailed B branches, individual quality tests and the legacy six views are deliberately not expanded here.

#### The long read

Complete the first three slices with actual Linux broad reliability, exact-head CI, independent Standards and Spec reviews, and merged-main verification. Only #157 is authorized. Next, #158 reconciles A identity and gates B, including #151. #151 gates #152, #153 and #155; #153 gates #154. B remains partial, and C must verify guarded migration/release separately.

For #49, #60 and #74, live sampling acceptance follows #108 but still needs protection, lawful supply and permission. #82 retains its own P0–P3 exit rules; offline work is not live acceptance. #121 does not block the existing public contract.

#### Terms used here

- **Exact-head CI**: A workflow run whose recorded commit matches the candidate being evaluated.
- **RRF**: Reciprocal Rank Fusion; here only a deterministic offline core.
- **Acceptance prerequisite**: A required earlier gate, not a runtime call or permission to begin later work.
- **ABI**: The binary interface that an installed artifact and its dependencies must satisfy.

### Which refs do the receipts actually cover?

**What do the observed ref identities establish?**

The observed refs are separate from the restoration tree.

Old main passed, A passed at its draft head, and B failed at its draft head. None proves the combined #157 candidate or deployment.

[Open the diagram](evidence.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **Canonical main** | Identifies what was on remote main at readback, not what this candidate will deliver. |
| **Frozen A head** | Records an unmerged fork candidate and exact-head Integration receipt, not deployed identity. |
| **Frozen B head** | Records the unmerged WAG B candidate and exact-head failure, not acceptance of the B wiring. |
| **#161 Restore** | Restores query docs, offline RRF and T0.2 design selectively. |

**Deliberately not shown.** Production topology and historical worktree inventory are not projected.

#### The long read

Compare the three refs without any promotion arrows. Match the workflow head SHA and scope before reusing its result; the handoff links each exact run.

#### Terms used here

- **RRF**: Reciprocal Rank Fusion; here only a deterministic offline core.

### Why are quality and week separate?

**What does release acceptance leave unresolved?**

A guarded release does not establish the quality of search results.

Real sampling for #49/#60/#74 follows #108, and #82 retains its own exit criteria. The public week freeze is independent.

[Open the diagram](quality.architecture.html). 4 components.

| Component | Responsibility |
|---|---|
| **#108 Guard release** *(planned)* | Owns migration, guarded release and rollback evidence without resetting protection state. |
| **Quality gates** *(planned)* | Requires each existing supply, date and quality gate independently of engineering CI. |
| **#121 Public week** *(planned)* | Requires a distinct owner decision before changing the public week window. |
| **#161 Restore** | Restores query docs, offline RRF and T0.2 design selectively. |

**Deliberately not shown.** Detailed per-ticket quality thresholds remain in the original specs.

#### The long read

Read the single edge as a real-sampling prerequisite only, not a new runtime connection or sampling approval. Offline preparation remains distinct. The detached #121 decision does not gate the existing public API.

#### Terms used here

- **RRF**: Reciprocal Rank Fusion; here only a deterministic offline core.

## Boundaries

A boundary is a claim about everything inside it.

### #157 only

*ownership boundary.* Only this preservation and selective integration scope is authorized; it confers no downstream or production permission.

Contains: #160 Preserve, #161 Restore, #162 Reconcile.

Crossed by:

- **#162 Reconcile → #158 Reconcile A** over manual. Only accepted #157 clears this prerequisite; no automatic start.

### Evidence snapshots

*ownership boundary.* These are observed ref identities, not promotions or runtime connections.

Contains: Canonical main, Frozen A head, Frozen B head.

## Components

**#160 Preserve**: Records recovery coordinates without cleaning history.

- Documented in: [docs/HANDOFF.md Restored increments](../../../docs/HANDOFF.md)

**#161 Restore**: Restores query docs, offline RRF and T0.2 design selectively.

- Documented in: [docs/HANDOFF.md Restored increments](../../../docs/HANDOFF.md)

**#162 Reconcile** *(partial)*: Aligns delivery evidence for the remaining #157 gates.

- Documented in: [docs/HANDOFF.md Candidate and CI receipts](../../../docs/HANDOFF.md)

**#158 Reconcile A** *(planned)*: Reconciles approval, artifact identity, ABI and owning main without replacing A.

- Documented in: [docs/HANDOFF.md Decisions and next gates](../../../docs/HANDOFF.md)

**#107 Wire B** *(partial)*: Owns WAG consumer enforcement of the single approved A contract.

- Documented in: [docs/HANDOFF.md Decisions and next gates](../../../docs/HANDOFF.md)

**#108 Guard release** *(planned)*: Owns migration, guarded release and rollback evidence without resetting protection state.

- Documented in: [docs/HANDOFF.md Decisions and next gates](../../../docs/HANDOFF.md)

**Quality gates** *(planned)*: Requires each existing supply, date and quality gate independently of engineering CI.

- Documented in: [docs/HANDOFF.md Decisions and next gates](../../../docs/HANDOFF.md)

**#121 Public week** *(planned)*: Requires a distinct owner decision before changing the public week window.

- Documented in: [docs/HANDOFF.md Decisions and next gates](../../../docs/HANDOFF.md)

**Canonical main**: Identifies what was on remote main at readback, not what this candidate will deliver.

- Documented in: [docs/HANDOFF.md Candidate and CI receipts](../../../docs/HANDOFF.md)

**Frozen A head**: Records an unmerged fork candidate and exact-head Integration receipt, not deployed identity.

- Documented in: [docs/HANDOFF.md Candidate and CI receipts](../../../docs/HANDOFF.md)

**Frozen B head**: Records the unmerged WAG B candidate and exact-head failure, not acceptance of the B wiring.

- Documented in: [docs/HANDOFF.md Candidate and CI receipts](../../../docs/HANDOFF.md)

## What moves between them

| From | To | Mechanism | What crosses |
|---|---|---|---|
| #160 Preserve | #161 Restore | manual | Confirmed lineage and the retained originals. |
| #161 Restore | #162 Reconcile | manual | Reviewed increments and exact restoration pin. |
| #162 Reconcile | #158 Reconcile A | manual | Only accepted #157 clears this prerequisite; no automatic start. *(crosses #157 only)* |
| #158 Reconcile A | #107 Wire B | manual | Approved artifact and ABI evidence, not a copied core. |
| #107 Wire B | #108 Guard release | manual | Validated consumer behavior, not deployment approval. |
| #108 Guard release | Quality gates | manual | Applies to real sampling for #49/#60/#74; lawful supply and explicit approval are also required. |

## Doctrines, guarantees and trade-offs

### Constraints

- **CI proves only its exact SHA and scope.**
- **No production, paid, public, or automated operation is authorized by this snapshot.**

