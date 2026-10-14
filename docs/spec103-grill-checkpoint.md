# SPEC103 — Stage 1 grill 检查点

日期：2026-10-14。**只完成设计检查点；等待 Hermes 发布，不进入 Stage 2/3。** Hermes 是集成协调者；本 fresh session 是唯一设计 writer。本文不是最终 SPEC、实施授权、生产保护通过收据或 Kanban 卡。

## 1. 实际流程与边界收据

- 已完整读取 `docs/spec103-design-assignment.md`、历史输入 `C:/Users/will/AppData/Local/hermes/cache/scratch/wag103-fork-input.md`、WAG `AGENTS.md` 及 `docs/agents/{domain,issue-tracker,triage-labels}.md`；未找到 WAG CONTEXT/ADR。
- **实际工具调用：`Skill(skill="grilling", args="Only Stage 1 …")`，返回 `Launching skill: grilling`，随后加载 `C:/Users/will/.claude/skills/grilling`。** exposed 列表没有 `grill`，不能声称实际调用名为 `/grill` 的技能。请 Hermes 记录此准确能力限制；本轮使用已暴露的相关技能。未调用或模拟声称 `/to-spec`、`/to-tickets`。
- 技能默认要求提问、等待及子代理；本任务明确覆盖为按推荐默认值自行确认、直接只读找事实、无子代理。下述三个 frontier round 记录问题、推荐、自确认与依据，不向用户发问，也不声称用户另行回答或最终审批。
- WAG 只读 Git 收据：`wt/t_dd6836c1`，HEAD `96b4cba0b4b3796d4479365119c43017584d8bf3`。fork Git 全部经 `wsl.exe -d Ubuntu -- bash -lc`：`wag-production`，HEAD `9fea41204fdfa7a5cfa15b0ebd12904c520478ce`，status 空；ls-tree 未列出根 AGENTS/CLAUDE/CONTEXT 或 docs/adr。源码只从 Ubuntu UNC 读取；未使用 Windows 失败缓存或新版 master。
- 已完整读取 fork `AI_POLICY.rst`、`CONTRIBUTING.rst`。`docs/spec103-parent-provenance.md` 是父输入，只读且未修改；其中 session UUID 属于父提供标识，不声称已独立查询 runtime session identity。
- 本轮只新增本文。没有安装、导入运行 native、测试、commit/push/PR、GitHub 发布、SSH、现场状态/ledger/secret/env 读取、搜索流量、provider API、部署、权限变更或其他项目写入。GitHub 最新授权与历史账目采用 assignment/父记录，不冒充本轮 API 读回；去重在发布前重查。

## 2. 设计树：推荐默认值已自行确认

### Round 1 — 根边界：已知授权 → 拆分与所有权

❓ **Q1 — 是否继续 config-only？**

➡️ **自确认：否。** 最新父授权已解决“能否改用户 fork 源码”的旧问题；config-only 无法覆盖实际 sends 与 durable pause。选择 exactly **A/B/C 三个有意义、互相依赖的 SPEC**，不按单函数拆票、不扩为平台；独立审批在实现之前。

❓ **Q2 — 谁拥有保护真源与发布？**

➡️ **自确认：A 独占 canonical schema/API/identity/classification 定义与核心实现，B/C 只引用。** A 的 fork scope 落在 `williamxhero/searxng`；B/C 落在 `williamxhero/WAG`；#103 保持 OPEN，作为集成索引并保留最新授权。Hermes 后续审批 AC、协调执行与发布，本 writer 不建执行卡。

### Round 2 — 依赖 Round 1：真源 → native 闭环 → WAG 接口

❓ **Q3 — 一份核心如何被 native 和 probe 使用？**

➡️ **自确认：fork 提供一个小型、仅标准库的 `wag_protection` Python 包，加入现有 `setup.py` 包清单；不引入独立服务或额外第三方依赖。** 避免导入核心时顺带运行 `searx` settings/bootstrap。native 与 WAG probe 使用同一经批准、固定 artifact 的包与 contract version；WAG 不复制源码，不保留第二套 ledger 实现，不从 arbitrary PYTHONPATH 静默回退。B 的 adapter 改造依赖 A 的包；C 负责 artifact 路径/provenance 与离线可运行验证。此路径是拟新增设计，不是已存在或已安装能力。

❓ **Q4 — 状态/计费/时间默认规则？**

➡️ **自确认：升级同一 canonical DB 为 v2（`PRAGMA user_version=2`），严格识别当前无显式版本的 legacy 四表，而非把任意 version=0 当可迁移库。** root `/var/lib/wag-route-probe`；文件名是 `lock`、`identity`、`ledger.sqlite`；独立 lifetime anchor 是目录外 `/var/lib/wag-route-probe.identity`。不得混为目录内 `.identity` 或 `probe.sqlite`。身份不变，root 不变，release/rollback 不恢复旧 DB/anchor。

保留 legacy `state(id TEXT, root TEXT, checkpoint TEXT)`、`attempts(engine TEXT, domestic INTEGER, stamp REAL, outcome TEXT)`、`pauses(engine TEXT PRIMARY KEY, strikes INTEGER, until REAL)`、`poison(reason TEXT)` 的全部语义与历史；v2 需明确定义 attempt ID、reservation/completion、boot、known/unknown connection/HTTP marks、caller/phase、reviewed identity/alias/provenance 和一次 release-check claim/evidence。完整字段、约束与原子迁移 SQL **留给 Stage 2 的 A 单一定义**，本文不当作已定稿 DDL。

每 engine ≤6/rolling60s，domestic 合计 ≤30/60s；category、route、worker/caller 不分桶。一个 admitted dispatch 最多一个已媒介 transport attempt，任何额外 connection 或 HTTP 重发都须新 charge 或发送前阻止；不把 native client invocation 当成底层一次连接的证明。timeout/empty/error/crash/未知均不退款。charge 窗口保守锚到确认完成；NULL/unknown unfinished 阻塞未来全域 admission。CAPTCHA 暂停 `max(原有更长要求, 1800 × 2^min(strikes−1,16))`，quark900 提升到 floor；仅真实非空、已门控成功可清连续 strike，无 half-open 绕暂停。

clock 沿用同 boot wall/mono 非有限、回退、差分 >2s 一律 durable poison；boot 改变不自行换 epoch。绝不以 elapsed 推导已允许再试 quark。missing/corrupt/locked/unavailable/未知 identity/schema/import/provenance/权限失败均 fail closed，无 fresh-init/fallback。

❓ **Q5 — 先支持全部 helper/retry，还是最小闭环？**

➡️ **自确认：enabled 模式先拒绝未媒介的扩展，允许经过审阅的单发送正常路径。** 在 engine import/setup/init 与 request/response helper 调用前做 capability admission；未知/未审阅 engine 或自建 transport 不允许 backend bypass。四个审阅 identity：quark、chinaso news 为 domestic；bing、yandex 为 overseas；alias 只能经审批映射到原 bucket，不能 caller 自报或按中文 query 分类。

全域非阻塞 dispatch flock 从原子 reserve/commit、立即 dispatch、真正 engine.response 分类直到 outcome/pause commit；SQLite 事务分阶段提交，但 **flock 不在 response 与 parser 之间释放**。线程 → async loop 必须传 engine/attempt/deadline 上下文，不能复用 network 对象推定 identity，不能持锁重复获取 flock。request/response helper、multi_requests、stream、trait provisioning 与 Tor check 在 protected 路径未经审阅时须在 scheduling/connect/send **之前**拒绝；不是请求发出后再拒绝。禁 HTTP/协议自动补发及 redirect follow-up 的具体 transport seam 仍待 G1；保留 operator proxies/routes，不以换出口解决保护。protection off 保持原生默认兼容；显式 enabled 的坏配置绝不能降回 off。

总 deadline 一次建立，init 独立受 bounded budget，搜索沿用实际剩余预算，不给每 stage/helper 增加3s；native future/线程超时不等于停止。若不能确认 sender 已终止，保留 unfinished 并阻塞未来 admission，即使锁最终释放也不能续发。

❓ **Q6 — 拒绝怎样穿过现有接口而不冒充 empty healthy？**

➡️ **自确认：使用现有 `/search?format=json`，由 A 对 `searx/webutils.py:get_json_response` 加一个最小、版本化、白名单机器字段 `outbound_protection`，保留现有 results/unresponsive_engines 与本地化显示。** B 验证版本/结构/静态 reason，将保护拒绝映射为现有 MCP `isError/structuredContent.error.kind` 与 `blocked_reason`；有真实结果的 partial/degraded evidence 不抹掉，也不满足未完成的 supply gate。无新 endpoint/MCP。不能仅凭翻译后的错误字符串猜 policy refusal。

WAG `/readyz` 的 core 路径改用 native `/config` 的结构/能力检查及既有 core dependencies，**不执行 engine/search 或 public egress**；普通轮询不得主动补公共证据。保留 `ok/core_ok/public_connectivity_ok` 与现有 HTTP200/503 一致性；未检查 public 时 `public_connectivity_ok=false`、`status=degraded`，增加明确 `public_unknown/not_checked` 诊断，不伪造健康。B 的 `search.mjs` 在首次 body 解析后、empty retry/provider routing 前处理 refusal；eval error 与 quality retries 均不 refill policy refusal。provider 实现与独立预算不改。

### Round 3 — 依赖 Round 2：跨 UID → release lifetime → 验收

❓ **Q7 — root ledger 如何供 UID999/1000 安全共用？**

➡️ **自确认：C 在独立授权迁移中安排 root 控制、专用共享组的最小权限方案；A 校验同一路径/身份/文件类型与迁移前提。** 父确认服务 UID999/GID988，canonical root0700、lock0600 都不容普通服务用户访问；UID1000 的实际调用身份/成员关系未证明，不能按名字或数字猜测。

推荐待审批权限目标：root 拥有 canonical 目录并设专用共享组/setgid2770；lock/SQLite0660、identity0640；目录外 anchor root 拥有、组只读0640，父目录不可由调用者改写。仅纳入已验证的 cooperative writer，保留 journal 创建权限和受控 umask，不用 world writable、不把 GID988 当自动共享组。不把协作进程可写目录当作防恶意同组用户的安全边界；删除/替换/内容不一致必须拒绝，绝不生成新身份。anchor 当前内容/权限未核实，这是未来只读 gate，不是本阶段现场调查。**本轮零 chmod/chown/migration。**

❓ **Q8 — 一次发布如何避免 apply/verify/restore/healthcheck 补搜？**

➡️ **自确认：C 创建 durable release-attempt ID，A 的共享存储提供一次 search transaction claim；先持久消费再发送，crash/refusal/failure 不回收。** 所有 apply/verify/restore/full-healthcheck/restart 复用同一 ID，listener/config 可重复但 search transaction 总计 ≤1；该 transaction 下各 native attempt 仍逐一 gate。普通 full healthcheck 只消费已有证据，没有显式合法 release claim 则 not_checked，不另建 attempt 补发。证据绑定 artifact/config/contract，重启可保留 claim 而不得把已失效证据称 current pass。

rollback 只恢复配置/程序，不恢复保护状态；退回无 native gate 的旧 fork 不能继续发送：必须保留 compatible protected artifact 或停止 search 服务并如实降级。C 不重写 release orchestrator，A 定义 claim/storage 接口，B 定义 readiness/typed-refusal 接口。

❓ **Q9 — 怎样避免 all-deny/CI 冒充生产保护？**

➡️ **自确认：要求真实固定 fork imports + synthetic loopback settings + packaged traits 的正向 admitted sends 和真实 parser 结果，再测安全拒绝。** 禁 AST 提取、手写替代 parser 或 all-deny vacuous pass。先 focused core/network/processor/probe/readiness/search/eval/release fixtures，再既有 broad gates、exact-head Linux CI、Hermes 独立 review；所有未来 AC/演练/live gate 此轮 **NOT RUN**。合成旧账迁移与跨 UID 演练不代表生产迁移完成。live gate 后续另行批准 bounded budget/stop conditions；本轮无任何 live 授权。

## 3. 有界源码证据与不能越过的缺口

以下行号为本轮实际固定源码读取，不是运行测试：

| 已核事实 | 精确 source seam | 对设计的约束 |
|---|---|---|
| retries=0 仍可能一次 RemoteProtocolError 重发；redirect 转为 follow_redirects | fork `searx/network/network.py:227-235,272-301` | 不能只改 retries 配置；在实际补发前 gate/deny |
| direct/HTTP-proxy/SOCKS mounts 各建 transport；httpx-socks 路径不同 | fork `searx/network/client.py:97-155,178-205`；`network.py:190-214` | 一处 wrapper 未证明所有底层 connect 都覆盖；Tor get_client 可额外发请求 |
| sync helper 提交到共用 async loop；future timeout 未 cancel；multi_requests 先排全组 | fork `searx/network/__init__.py:96-134,173-180,204-276` | dispatch admission 必须早于 scheduling/send，total deadline/unfinished 必须持久 |
| import→setup 在 processor init 前；init 是独立线程；online request/HTTP/response 后才 extend | fork `searx/engines/__init__.py:126-165,271-293`；`processors/abstract.py:124-173`；`online.py:118-130,225-284` | 不能只罩 `_send_http_request`；parse 前不得 unlock，已审阅 import/setup 才允许 |
| native suspension 仅内存，extend 的空结果也可能 resume；join 只标 timeout | fork `processors/abstract.py:78-122,175-240`；`searx/search/__init__.py:136-157` | canonical pause/strikes 不受 native resume 清除，join 不是终止证明 |
| quark challenge explicit900；Yandex captcha header；403/429 分类不同 | fork `engines/quark.py:35-48,83-90`、`yandex.py:51-53,88-108`、`network/raise_for_httperror.py:61-79` | 实际 parser 分类，floor1800；probe 现把403/429统称 captcha 的差异需 adapter 校正 |
| 四 parser 常规 request/response 未见 helper；quark/chinaso init 本地校验；Bing fetch_traits 会 GET | fork `engines/{quark,chinaso,bing,yandex}.py` 已读相关函数；`bing.py:158-176` | 四审阅 capability 不能推广所有继承 engine；traits 使用 packaged data，不在 test/release 下载 |
| legacy reserve commit→callback parser→outcome commit 在 flock 内，anchor 独立 | WAG `scripts/searxng-route-probe.py:496-640`；父 provenance:8-19 | 继承三笔 chinaso2/quark1 与 pause/strikes；父 quark until 是旧 mono，不转成剩余秒 |
| probe 原生依赖/provenance gate 与 child watchdog；真实 parser test 可 skip | WAG probe `:164-243,278-334`；test `:350-368` | fork patch 后旧 revision/digest 门槛要受控升级，不能粗暴去掉；既有 WAG CI 不保证真实 native gate |
| readyz 真搜索；healthcheck core-only 先访问它；overlay 最多30次循环搜索 | WAG `gateway/readiness.mjs:99-140`、`scripts/healthcheck.sh:118-133`、`scripts/searxng-overlay.py:207-244,267-303` | 名字 core-only 不证明零流量；三条入口都要闭合 |
| search 可 empty 再搜；eval 可 error/quality retry；MCP error 已有标准 envelope | WAG `gateway/search.mjs:189-205,347-372`、`eval-case.mjs:43-64`、`eval-core.mjs:24-57`、`server.mjs:371-385,1019-1021` | B 最小接线必须发生在 retry/fallback 前；保持 auth 与 response 一致性 |
| JSON unresponsive_engines 被翻译，未知异常变 unexpected crash；/config 无 engine request | fork `searx/webutils.py:70-82,162-174`、`searx/webapp.py:1246-1277` | A 需最小 JSON machine-field slice，B 不做 regex 猜测 |
| release 调 overlay、反复 core check、再 full check；restore 会再调 helper | WAG `scripts/release.py:686-708,764-836`、`scripts/searxng-apply-overlay.sh:29-47` | 一次 claim 要覆盖重入/restore/独立 wrapper，不只当前进程内标志 |

**精确待结技术缺口（不是向用户追问，Stage 2 必须定稿）：**

- **G1 / A：底层 actual-send seam。** manifest 固定 httpx0.28.1、httpx-socks0.13.1，但本轮未读取 transitive httpcore/python-socks/地址遍历实现，无法证明 transport callback=单次 TCP attempt。需用经批准固定依赖源码明确 direct、HTTP CONNECT、SOCKS、HTTP2 stale connection 的隐藏重连/重试边界，并选逐次 charge 或 send-before-denial；不能把未证明路径留作 supported bypass。helper 重入拒绝、request/parser 持锁与 async cancellation 必须有真实 imports 正反向测试。
- **G2 / A：v2 DDL/API 与 migration map。** 具体字段类型/约束、enum、legacy rowid/NULL/poison/stamp 无损导入、registry digest/alias admission、2s 阈值与 reboot recovery、claim/evidence 原子状态转换仍需唯一 contract 定稿；预留 API 不得暴露可缓存的裸 permit。
- **G3 / A→B：JSON 与兼容性。** `outbound_protection` 的 version/reason/partial/admitted/unknown 表达及 enabled proof 未定稿；旧 backend/字段缺失在已启用场景必须拒绝真实放行，不能误作 healthy empty。query/body/URL/proxy/identity value 不进入新增诊断。B 的 public evidence 获取/失效接口也须定稿，不能因读 evidence 触发 search。
- **G4 / C：artifact/import/跨 UID 接入。** 实际 probe UID1000 身份、专用组、anchor 只读校验、SQLite journal 与 setgid/umask/lock 生命周期、包 root 与 digest 安装/升级/回滚矩阵须用后续隔离 fixtures 验证；没有假定额外包已装。
- **G5 / A+C：exact-head CI。** fork `.github/workflows/integration.yml:5-11` 仅监听 master，目标 trunk 是 wag-production；需 A 明确最小 downstream trigger 修正，不能拿 master CI 当 target HEAD 绿。WAG `.github/workflows/ci.yml:54-64` 没 provision fork runtime，现真实 parser tests 会 skip；C 定义独立 exact-artifact native gate 与证据，不能仅现 broad CI 替代。

设计偏好 frontier 已自行确认；上述事实/接口缺口未假称解决。当前不得进入实现或 production gate。

## 4. 拟议三 SPEC 与互斥 owned map

| SPEC / durable issue repo | 一体交付与唯一 writer 边界 | 依赖/测试边界 |
|---|---|---|
| **A — fork durable core + native network/processors 闭环** / `williamxhero/searxng` | 新 `wag_protection` 最小 stdlib 包、canonical contract/migrator/claim API；`setup.py` 包清单；`searx/network/{__init__,network,client}.py`、`searx/search/processors/{abstract,online}.py`、`searx/engines/__init__.py` admission、`searx/webutils.py` JSON machine-field；需要的最小 settings/schema 声明与 integration workflow trigger。保留 AGPL。 | fixed fork base；真实 native imports/traits、successful loopback sends、connection/retry/redirect/helper/init/parser/clock/concurrency/legacy fixtures。不是只做一函数或只做 ledger 的票。 |
| **B — WAG checks + truthful refusal** / `williamxhero/WAG` | `scripts/searxng-route-probe.py` 与对应 test 的 canonical adapter/provenance/classification；`gateway/readiness.mjs`、`gateway/search.mjs` body/refusal-before-retry 切片、`gateway/server.mjs` 仅 readiness/error envelope 接线、`gateway/eval-{case,core,runner}.mjs` 保护拒绝传播/不重试切片；`scripts/healthcheck{.sh,-diagnostics.py}`。 | 依赖 A contract/artifact；对应 health/healthcheck/search/eval tests + MCP boundary；核心 zero engine/public search、partial/degraded/public_unknown 真实。 |
| **C — WAG migration/release/rollback + genuine acceptance** / `williamxhero/WAG` | `scripts/{release.py,searxng-overlay.py,searxng-apply-overlay.sh,eval-release.sh}` 的 release ID/claim/evidence/import/兼容回滚切片；对应 overlay/deploy fixtures；必要的 release inventory/provisioning/CI 最小接线和迁移/recovery操作文档。调用 A migrator，不另写 schema；调用 B readiness/healthcheck，不改这些同文件。 | 依赖 A+B；isolated legacy/UID/restart/restore 故障演练、release claim ≤1、exact-artifact gates、之后独立审批的有界 live acceptance。 |

- A fork owning session 从固定 wag-production base 单独 branch/worktree 实现；B/C 从 WAG main96b4cba，C 在 A/B 接口验收后串行集成。A 不写 WAG，B/C 不写 fork；需跨项目实现时由目标 owning session 承接。所有细化改由 Hermes 批准；此表不是执行卡。
- **冻结热点归属**：必要的 `gateway/server.mjs`/`search.mjs` 最小切片只给 B，理由是现有 envelope/readiness/empty-retry 会丢保护拒绝；`provider-routing.mjs`、`provider-adapters.mjs` 零修改。不并发同文件 writer；C 不重复改 B 的 healthcheck/probe。
- 后续 focused gate 后保留既有 WAG serial `node --test --test-concurrency=1 gateway/*.test.mjs proxy/*.test.mjs`、`scripts/*.test.py`、crawler unittest 和 tracked syntax；fork 以 Makefile `test.unit` 起步、继承 integration 的 `make V=1 ci.test` broad gate，并明确公共网络/自动 provisioning 与离线 gate 的隔离，不在本轮运行。不得削弱/跳过有效测试。
- 将来每票 `needs-triage`，独立审批前无 `ready-for-agent`。WAG 同仓关系使用 native parent/dependency（若可用），fork↔WAG 用 URL；不把 fork issue 原生挂到 WAG parent。发布前去重、发布后 body/schema/relations 读回；本轮均未执行。

## 5. 政策、保留门槛与 Hermes 处理项

**具体政策冲突：** fork `AI_POLICY.rst:8` 要求披露全部 AI，`:9` 要求 human-in-loop 理解，`:10` 禁 AI 作 PR 主要作者，**`:11` 要求 Issues/PR descriptions 完全 human-written，禁止 LLM 讨论内容**。本任务要求唯一 AI design writer 并未来发布 authored fork issue，若原样采用会与该明文要求冲突。用户 commissioning downstream 并不由本 writer 擅自判定为 policy 豁免。Hermes 须在 fork 发布前获得/记录 owner 对 downstream-only policy applicability 的明确裁定或采用符合政策的发表流程；**不删/改 policy、不虚称 human-written，也不要求用户本轮回答**。fork `.github/workflows/ai-policy.yml` 另有自动检查，未修改或运行。此项不妨碍 Hermes 将下方 WAG 检查点及时发布到 WAG #103。

未来 fork 文本必须诚实披露：由用户委托的 downstream fork；Hermes 协调；Claude Code 辅助并作为本阶段设计文本的唯一 writer；尚未经独立审批、无实现/生产 claim。不得向 `searxng/searxng` 或 Matrix 提交 issue/PR/comment，不借 fork 向 upstream maintainers 转嫁评审；保留 AGPL 和 policy。

Inherited history 保持：P0 chinaso news2/quark1、CAPTCHA pause/strikes/unknown；P1 canonical7c、baidu2/Ali1/Tencent2。Tencent 仍技术未知，不扩诊断工流。91 retained candidates 不等于 robots/safety/date release admission；原 #49/#60/#74 与 #82 supply/date/quality、人审门槛、disabled engines、operator routes/proxies、auth/SSRF/API/provider budgets 均保留。不 reset/refund/new identity，不追加 quark 请求。

## 6. 可由 Hermes 立即发布到 WAG #103 的短检查点

> Stage 1 设计检查点已完成（只读源码 + 文档；无实现、测试或现场操作）。实际通过 Skill 调用的是 `grilling`；会话未暴露名为 `grill` 的技能，未伪称 slash 调用。
>
> 推荐并自行确认三份 linked SPEC：A 在 `williamxhero/searxng`，负责唯一 durable core/schema/import 及 native 发送—真实 parser 闭环；B 在 WAG，负责真正零搜索 core readiness、保护拒绝/partial-degraded 传播和不补搜；C 在 WAG，负责保留 canonical identity/旧账的跨 UID 迁移、durable release-attempt 一次 search claim、回滚与真实验收。#103 保持 OPEN 作集成索引，各票先 needs-triage，独立审批后才实施。
>
> 已核对隐藏 protocol retry、helper/future 未终止、quark900 与 JSON 翻译丢异常类型等具体 seam。Stage 2 尚须定稿底层连接计费/阻止边界、v2 字段与迁移、机器拒绝协议、包/provenance/权限及 exact-head CI；现 CI/mock 不代表生产保护通过。root ledger 内实际文件为 lock/identity/ledger.sqlite，目录外 anchor 单独保留，不改身份/不退款/不追加 quark。
>
> 已读 fork AI policy，发现 human-written issue 条款与未来直接发布 AI-authored fork 文本存在具体冲突，交 Hermes 在 fork 发布前裁定；不删 policy、不虚称人写、不向 upstream/Matrix 发布。完整 Stage 1 检查点：`docs/spec103-grill-checkpoint.md`。本阶段所有实现/迁移/live AC 均 NOT RUN；暂停等待 Hermes 发布本小检查点，再在同会话继续后续阶段。
