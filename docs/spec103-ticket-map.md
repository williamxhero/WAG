# SPEC103 — 三张既有 delivery tickets / Stage3 定向交接

## 状态与入口证据

- 本轮用户显式同会话 `/to-tickets` command-name、技能正文及定向参数已提供；只修现有 A/B/C 与本map。技能默认问答/新增发布/ready-for-agent被本次授权覆盖，不重新调用Skill、不创建issue/card/Kanban图。
- 长Stage2曾被owner中断，未形成完整completion收据；不把中断前草稿或model自述加载当完成证明。Skill(to-spec)曾因disable-model-invocation失败；原生入口/父init证据限度见A Further Notes。父真实init记录UUID `3f2873e1-0e08-47b5-8ddd-d63fd1151d4d`、model `gpt-6.1-sol`，宿主Claude Code不等于模型身份。本writer无新runtime查询。
- 下列issue/label/native关系与预建todo卡均为父提供证据，**不是本轮GitHub读回、更新或独立AC批准**。只沿用三票；Hermes随后更新原body并核对关系，不duplicate create。#103保持OPEN/integration index。
- **全部implementation、tests、CI、migration、permissions、deployment、live AC：NOT RUN。** 全部needs-triage，非ready-for-agent；预建todo卡仍gated，Hermes独立审批AC/owned map前不能实施。
- AI-authored、downstream-only；[父policy裁定](https://github.com/williamxhero/WAG/issues/103#issuecomment-6158126091)须保留于fork issue首部与#103引用。原AI_POLICY/AGPL不改、不伪human-written、不向upstream/Matrix提交。

## 唯一三票与依赖

| Ticket | 既有delivery SPEC | Blocked by | Parent / execution映射 |
|---|---|---|---|
| A | [williamxhero/searxng #1 — durable core + native闭环](https://github.com/williamxhero/searxng/issues/1) | 无delivery ticket blocker；仍须独立审批，不等于可立即执行 | WAG103只作跨repo URL；父预建 `t_cc61ca11` todo/gated |
| B | [williamxhero/WAG #107 — 零搜索readiness与真实拒绝](https://github.com/williamxhero/WAG/issues/107) | [A fork #1](https://github.com/williamxhero/searxng/issues/1) | 同仓parent [WAG103](https://github.com/williamxhero/WAG/issues/103)；父预建 `t_fc9b1636` todo/gated |
| C | [williamxhero/WAG #108 — 迁移/一次release/兼容回滚](https://github.com/williamxhero/WAG/issues/108) | [B WAG #107](https://github.com/williamxhero/WAG/issues/107) + [A fork #1](https://github.com/williamxhero/searxng/issues/1) | 同仓parent [WAG103](https://github.com/williamxhero/WAG/issues/103)；父预建 `t_17c0d33a` todo/gated |

父已登记上述native blocked_by/同仓parent。跨repo dependency沿父登记，**不能把WAG103错设为fork native parent**。不新建第四票，不把以下逻辑subslices变成单函数tickets或执行图。

## A — 可演示的native端到端闭环

**交付：** 真正native query→guarded transport→loopback→真实parser→同一durable ledger→现JSON诊断，合法发送可成功，拒绝在实际发送前生效。A是唯一schema/API/protocol owner，B/C不得复制core或另建状态命名空间。

**目标所有权：** future fork owning session；父已预备 `/home/will/projects/searxng-spec103-a`，branch `claude/spec103-a-native`，pristine fixed base `9fea41204fdfa7a5cfa15b0ebd12904c520478ce`，trunk wag-production。本writer未触碰/未新核该worktree，禁止以moving master替代。

**仅票内逻辑subslices / owned map：**
1. `wag_protection`、setup/依赖锁、settings/defaults：A2/A3/A5/A6单一契约；core import零settings/network/create，legacy历史与anchor保留。
2. native engines/network/processors/Search/results：fork-owned AsyncBaseTransport桥接全部guarded httpcore pools，保operator HTTP routes/TLS/source bind；one-address/no-fallback、禁hidden retry/redirect/helper。线程→async只传同dispatch受控context，不转移lock/跨forkpermit。
3. 同query finalrefs确定顺序串行，前ref真正parse/commit/unlock后才开始下一ref；单query唯一≤3s总deadline，跨query/process仍nonblocking lock_busy。现webutils/webapp仅machine JSON/config接线。
4. A-owned focused/core/native tests与fork integration.yml：扩wag-production实际PR/HEAD gate，保Python3.11–3.14/core回归，不触publish/data-update/政策机器人。

**AC，全部NOT RUN：** A正文AC-A1–A9全部保留；关键positive必须同一真实query≥2独立reviewed engines非空、complete、各有charged rows并共用总deadline，不能分两次query或all-deny。direct/HTTPS/HTTP proxy/CONNECT+TLS真实parser阳性；合法线程→async阳性；admitted后deadline耗尽使下一ref before-send refused零connect/header；旧backend停止/卸载→全部guarded mounts验证→新调度顺序。quota6/30、quark900→≥1800 floor、NULL/clock/storage/crash不退款、parser锁与真实计数全部必测。≥2独立源/60%母阈值不下降。

**G1证据边界：** 父提供实际httpx0.28.1/httpcore1.0.9/anyio4.14.2等部署包源码与HTTP operator safe-enum，pre-header awaited trace/CONNECT extensions是source事实；stream arm/取消终止/计数/ABI/positive仍NOT RUN，源码事实不是AC通过。SOCKS真实走python-socks anyio/v2旁路，before-scheduling拒绝，不换route。

## B — MCP/检查/probe真实消费同一保护

**交付：** `/readyz`与core-only真正零搜索，readonly public evidence保持unknown/degraded；现authenticated MCP web_search真实结果或typed refusal，不以empty/provider/evaluator重试洗白。probe导入A批准artifact同一包/identity。

**所有权与subslices：** WAG owning session，main fixed base `96b4cba0b4b3796d4479365119c43017584d8bf3`。
1. protocol/CLI薄adapter + readiness/healthcheck：仅消费A snapshot/descriptor，不重写SQLite/flock/clock。
2. `gateway/server.mjs`仅cfg/readiness/error/web_search/getServer/MCP release context；`gateway/search.mjs`仅firstBody/refusal-before-retry/fallback/summary。这两个hotspot由B独占，provider-routing/adapters不改。
3. eval-case/core/runner两类retry拒绝、一次search真实quality report重放；route-probe与tests改同A core/child锁覆盖真实parse。
4. 对应MCP/health/search/eval/probe/CLI focused tests，再原broad；不写C release/overlay/CI文件。

**AC，全部NOT RUN：** B正文AC-B1–B9全部保留。零search/init/public-egress counters，真实MCP/native阳性；refused/partial停止empty/provider/GDELT/error与quality refill。A唯一状态机`claimed→unknown/0→已认证per-request ingress unknown/1→complete或unknown`，header不能create claim；非法/重放backend0，short flock不跨RPC。quality report复用执行原domain/provenance/date断言、新backend0；失效证据只能失败/not_checked。

## C — 保守迁移到一次release并兼容回滚

**交付：** 同legacy identity/history/pause经受控跨UID迁移，external artifact/state不随release swap消失；一次durable release search的真实quality evidence能被verify/restore/health/eval重用，rollback只退程序/config、不退state。

**所有权与subslices：** WAG独立owning session，A/B接口批准并合入后串行集成；Hermes integration owner。
1. release.py/overlay/wrapper：只有top-level prepare生成release_id；nested overlay必须继承并拒missing/mismatch，apply/verify/restore/restart不生成新ID。listener+/config替代隐蔽search循环。
2. thin release-check/native-acceptance helper + eval-release：A claim/ingress/evidence、B MCP一次backend与质量重放，不另写ledger/HTTP engine client。
3. artifact manifest/inventory与WAG unit最小group/umask/write-path；native unit由目标授权owner实施。外anchor父已核root0600/32bytes，值未读；未来gate核三处identity byte-equal、不输出值。
4. compatible rollback/recovery runbook及overlay/deploy/helpers/权限演练tests；schema forward-only，DB/identity/anchor/claims/pauses never restore/refund。
5. C-owned WAG ci.yml exact-approved-fork integrated Linux gate，真实runtime/positive/no目标skip；保原WAG broad，不动A workflow或B文件。

**AC，全部NOT RUN：** C正文AC-C1–C10全部保留。synthetic三笔legacy+旧pause完整迁移、真实跨UIDjournal/lock成功与拒绝；多次流程one ID/≤1 backend transaction，nativeattempts仍各自charged；10s public总预算/native3s不续时；quality证据不可伪造/重搜；故障/不兼容rollback hold不裸发；exactHEAD非空CI不拿master绿/empty rollup抵过。

**授权边界：** 用户fork源码开发和独立验收后受控deployment已授权，不重问所有例行发布/只读API。Hermes仍须核具体跨UID权限/严重停止动作的安全边界、livebudget/stopconditions、独立AC及原supply/date/quality/robots/人工finalgate。本轮无工程/生产执行权限，quark hold绝不自动解除。

## 最小交接与停止

- 本轮只对既有A/B/C作定向Edit，并新增本map；schema仍只在A，具体完整file/test owned map与AC在各原body。
- Hermes更新既有fork1/WAG107/WAG108 body及#103引用后，逐body/链接/schema/parent/blocked_by/needs-triage读回；本轮未调用gh，不声称修订已上线或关系新核验。
- 不close/merge，不创建更多issue/card，不触目标A worktree。**到此停止，等待独立验收；全部implementationNOTRUN。**
