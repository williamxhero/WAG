# #119 single-root preflight: bounded static repair

## Scope and provenance

This is a repair of the preparation candidate under [WAG #119](https://github.com/williamxhero/WAG/issues/119), not a new diagnostic or execution admission. The accepted [attempt contract](https://github.com/williamxhero/WAG/issues/119#issuecomment-6215480801), [preparation admission](https://github.com/williamxhero/WAG/issues/119#issuecomment-6215494438), and [implementation specification](https://github.com/williamxhero/WAG/issues/119#issuecomment-6215571251) remain the source of authority.

Original durable attachment: `t_2af36058/deliverable.zip`, SHA256 `d40f7ad6e89a79b37e56b9670f18c425c1b83ead5253f014dc2f3260b09dcc17`. Its source SHA256 is `d1799e75088a0542f178d73c89424e59fa43aae61b1ce06624f01366c7e9f2e2`; its static verifier SHA256 is `31c3161efc4c2ee065f2d2fbd7a2802a487472beb5efe0c5a1acaa7ef054dfcb`. The attachment, receipts and previous NO_GO review remain unchanged.

The source is brought into `scripts/one_root_preflight.py`, with the original fake suite adapted to the existing `scripts/*.test.py` convention as `scripts/one_root_preflight.test.py`. This helper remains separate from the gateway/crawler and is not connected to production or deployment.

## Required behavior

1. Resource observation starts after a complete, valid resource sample. A candidate requires start/end samples separated by at least six seconds and an intervening valid sample. A slow first query does not itself constitute an observation interval. All queries, pacing and cleanup remain within the original `D = t0 + 60s`; insufficient time or incomplete sampling is not a candidate.
2. Win32 `WAIT_TIMEOUT` (258) and `WAIT_FAILED` (0xffffffff) are distinct. Capture the numeric last-error immediately after a failed wait; record it through `Fault`/`UNKNOWN` unless the overall deadline actually expired. Cleanup waits must preserve failures too. Existing timeout, termination-request and actual-exit distinctions remain intact.

## Agreed verification seams

The delegated repair explicitly covers `run_state(factory, clock)` reports and the real native wait adapter against fake Win32/clock boundaries. Reuse the existing compile/AST and 21 pure-fake checks; add regressions red-first for slow resource samples and failed waits. Run only the script's static/pure-fake suite with isolated Python and bytecode disabled. A non-implementer must review the accurate new source and tests before admission is considered.

No native DLL/API, process/Job probe, CPA/model, crawler, `fs.rm`, business network request, installation or deployment is part of this repair. Existing WIP, ledgers, budgets and the paused Hermes goal remain untouched. This manual repair is not evidence that LF executed a WAG task.

## Remaining execution gate

Static acceptance alone does not authorize a run. The owner/trusted parent must separately admit one isolated single-root attempt, bound to the reviewed source, real interpreter identity, directory, total deadline, resource-observation and external capture/actual-exit/durability protocol. CLI flags do not grant that authority. Native remains NOT_RUN, runtime controls remain zero and the EBUSY root cause remains UNKNOWN; the full #119/#82 and release gates stay open.
