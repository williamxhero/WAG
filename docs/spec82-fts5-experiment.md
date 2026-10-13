# SPEC82 / #88：有界离线 SQLite FTS5 实验

## 交付边界与会话阶段

这是 Delivery 模式的**可执行离线实验**，不是生产索引选型、真实中文供给恢复或真实日期准确率证明。仅拥有本报告、Python experiment/test、Node bridge、合成 fixture 和 raw JSON 六个文件。不接 server/search，不修改已合并 evidence/news/CI/package/lock/design，不抓取真实 feed/page/provider，不读取凭证，不部署/合并/关闭/修改 Kanban。Hermes/default 负责独立验收。

唯一 writer 会话：`405fce9d-d21b-4e0b-a621-1eae2113c9a8`（实际 SDK tool-results 目录），工作区 `.worktrees/t_96d4b440`，分支 `wt/t_96d4b440`，base `f0ba5d0a52d0412c6713d6b2bafa34d1186cc240`。#87 的 PR93 已合并，依赖已满足。

已加载 grilling、spec-ticket-first-loop、tdd；任务预授权默认决策。缺少可调用的 grill/to-spec/to-tickets/implement-spec，故执行**等价**需求、确认现有票据、实施阶段，不假称缺失 slash 已运行。实现前需求/验收/seam/六文件范围已发布且读回：[#88 收据](https://github.com/williamxhero/WAG/issues/88#issuecomment-6145973128)、[#82 收据](https://github.com/williamxhero/WAG/issues/82#issuecomment-6145973616)。没有创建替代票据或其他 writer/reviewer。

此前 P3 设计比本次授权更宽。本次默认 **SQLite-only**，Meilisearch 不作为依赖：Python 自带 FTS5 可在单进程文件内完成，不必安装服务/新包。没有运行 Meilisearch、RRF、聚类器、查询扩展或实际源 benchmark；预置 cluster 标签不是聚类准确率。不得将本结果用于证明父 #82 的生产退出指标达标，也不调整/冻结其阈值。

## 重跑与最小公共接口

```sh
npm --prefix gateway ci --ignore-scripts --no-audit --no-fund
python scripts/spec82-fts5-experiment.test.py
python scripts/spec82-fts5-experiment.py --output docs/experiments/spec82-fts5-raw.json
```

输出 parent 必须存在；重跑会替换自己指定的 raw 文件，先检查该目标。脚本仅加载版本化 fixture，在 owning 工作区隔离 TemporaryDirectory 创建 SQLite，结束自动清理，无端口、定时任务或生产 schema migration。示例输出是实际六次运行的 [raw JSON](experiments/spec82-fts5-raw.json)，不是手填计时。JSON 绑定 fixture 与 experiment/bridge/merged87 modules 的 SHA256；fixture SHA256 为 `1dc6688387c7cb2a0e57c2709a0a5f667b200a418b533bdc5870be5f35db8adb`。

公开测试 seam：`OfflineIndex(path, arm).ingest(documents, now)`、`query(text, now, window, strict, limit, source_id)`、`get(document_id)`、`retention(now)`、`close()`，以及实际 CLI。`raw` / `pretokenized` 写入 DB metadata，重开不允许切 arm。

- `ingest`：HTML 必须显式提供，不接收预构造 page proof。实际调用 `extractPageEvidence(...,{chinesePublicationDates:true})` 和 `evaluateSpec82Evidence`，保存 page publication candidates/conflicts/temporal records、derived dates、checked_at、evidence_url 与诊断。不把输入 date_status/evidence_level/published_at/expires_at 当真。
- URL 复用现有 `normalizeUrlForDedup`；HTTP(S)、无 URL credentials，实际 page URL 必须与规范化文档 URL 匹配才可 strict。tracking/hash 变体去重；重复 URL 保留首个逻辑 ID；同 ID 可更新 URL。两个既有 ID/URL 冲突拒绝整批，不静默合并不同身份。
- 每次 query 重新调用现有 window/evidence policy，不信入库 status。E1/E2 才有严格资格；E3/E4 仅诊断/claim。future、conflict、event time、噪声、非法民用日期、无时区时间不能冒充当前 verified。允许 general 返回未知/声明状态以便审计。
- window 复用 `resolveNewsWindow`：`rolling_24h` 的 UTC instant 起点/now 均 inclusive；`calendar_today` 原策略为 Asia/Kuala_Lumpur（UTC+08）的民用日，日精度只用于此模式，绝不伪造 publication instant；unknown-timezone 两种模式都不合格。没有自行假设 Asia/Shanghai。
- 保留按 usable、非未来且无冲突的 E1/E2 publication +90 天，旧有效日期不因入库今天而变新。日精度 retention 锚定现有 calendar window 时区的当天 00:00+08，作为清理边界，不写成 published_at。无可用页面日期用首次 indexed_at+90 天，重复/无证据更新不刷新兜底时钟。`retention` 事务同步删 documents/FTS，只删 expires_at < now；query 即使清理尚未执行也排除过期项，等号保留。
- 一批更新在一个 SQLite transaction 中写 documents 与 FTS；错误回滚，包括此前已更新的 proof/tokens。重开保留审计与排序；bm25 同分按 document_id ASC。tier/source/cluster 仅可追溯，不参与加权/聚类/RRF。

## 预先固定语料与实验方法

48 篇**手工合成**文档：24 新闻/政策与日期案例、8 相同/近标题、4 平台形态、4 繁体形态、4 日期噪声、4 时间边界。全部 URL 是 synthetic.example，无真实文章正文/用户数据/订阅质量含义。source s1–s6、T1–T5、synthetic-A/B cluster 均为合成标签；d32 特意不聚类。共享的正文/metadata defaults 在 fixture 明示，每文档自带 HTML、source、URL、expected_date_status 两种窗口与 date_case。

24 个查询：23 个正例、1 个显式负例 q24。每个保留人工 expected_ids，strict 还固定 expected_strict_ids；涵盖精确中文、substring、phrase、专名长尾、number+English、繁体、繁简/别名**不扩展**、来源过滤、重复标题与安全边界。相关性标签含概念级期望（不保证字面相同），不是运行后从命中反推标签。各臂同 corpus/queries/quoted phrase/bm25 权重/tie-break/date policy，每臂 3 个独立新库，按 raw 1–3 然后 pretokenized 1–3 顺序跑，不随机化、不冲刷 OS cache，不宣称纯冷缓存。

两臂仅输入变换不同：

1. **raw**：原文直接进入默认 unicode61。
2. **pretokenized**：U+3400–U+9FFF 汉字每 codepoint 独立 token，连续 ASCII 字母数字为词；文档与 query 同样变换，再用 quoted phrase MATCH，防止 OR/列选择等用户输入变为 FTS 语法。它只是确定性示例，非生产语言分词器：不覆盖扩展区/全部 Unicode，丢掉标点，可能将标点两侧连成短语；不处理繁简、同义词、实体别名、词序或语义重排。

recall@10 为 **23 个有期望 ID 查询的宏平均**；MRR@10 亦排除 q24。原始查询包含 q24 的空 ranks。零结果/零相关查询分别保存；不把 negative zero 算 recall 失败，也不隐藏 raw 的 positive zero。返回 rank/raw_score/source/tier/cluster/evidence 和 missed_expected_ids 均逐 query 保存。

## 实际能力、规模与原始计时

Windows 11 build 26300；Python **3.14.7**，内置 SQLite **3.53.1**，Node **v26.7.0**。本会话实际 `CREATE VIRTUAL TABLE probe USING fts5(text)` 成功，不能用旧 PATH sqlite CLI 的 module 缺失否定 Python 能力。锁定 gateway dependencies 提供 jsdom，无新 production dependency。最终 raw executed_at：**2026-10-13T13:30:54.613Z**。

每臂 48 文档 / 24 queries / 3 runs，总共 **144 个 measured query observations**。另有未计入 measured queries 的 reopen q01 核验、全 corpus 日期审计与 retention 操作。计时为 perf_counter wall milliseconds，不是 CPU time；SQLite MATCH 单独计时，end-to-end 包含 Python JSON、Node 子进程启动/import 与现有 evaluator，ingest 包含 HTML extraction。

| arm / run | ingest ms | DB bytes | retention ms（两次） | SQLite query median / max ms | end-to-end median / max ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| raw / 1 | 1366.945 | 229376 | 13.561 | 0.025 / 11.763 | 0.032 / 540.287 |
| raw / 2 | 880.398 | 229376 | 13.764 | 0.038 / 0.322 | 0.046 / 716.544 |
| raw / 3 | 753.099 | 229376 | 9.010 | 0.029 / 0.287 | 0.038 / 643.431 |
| pretokenized / 1 | 755.584 | 249856 | 13.547 | 0.191 / 0.378 | 535.698 / 663.543 |
| pretokenized / 2 | 764.090 | 249856 | 12.814 | 0.208 / 0.320 | 454.732 / 604.280 |
| pretokenized / 3 | 865.082 | 249856 | 15.657 | 0.221 / 0.380 | 528.954 / 653.397 |

这些是小样本单机观察，不是延迟/资源承诺。raw 多数查询没有候选，不启动 evaluator 子进程，因此其 end-to-end median 很低，**不能把零召回速度当性能优势**。预分词更多命中触发 Node policy，主要端到端成本来自桥接进程启动。峰值内存未测，DB bytes 不代表压缩后的语料、总进程内存或规模化成本。保留测试未声称自动 vacuum/文件缩小。

## 召回结果、失败解释与安全观察

三次各臂的排序和分数都一致，重开 q01 排序亦一致。

| arm（每次相同） | recall@10 | MRR@10 | 正例零相关 | 全查询零结果（含 q24） |
| --- | ---: | ---: | ---: | ---: |
| raw | 0.1347826087 | 0.1739130435 | 19 / 23 | 20 / 24 |
| pretokenized | 0.9130434783 | 1.0000000000 | 0 / 23 | 1 / 24 |

raw 只命中 q01（d01/d25/d26 完整 token，同概念近标题 d27/d28 缺失）、q13（英文 CATL，d12）、q19/q20（独立 ASCII SAFETY）。**raw 不适用于本 fixture 的中文 substring/phrase 需求**，不是“修正标签”让它通过。

- raw 零正例：q02–q12、q14–q18、q21–q23；unicode61 把未加空格的中文及相连数字/ASCII 长串当 token，不能直接做部分词召回；q17 中 IPv6 与中文相连也未形成独立 token。繁体短语同样如此。q01/13 的部分漏召回另含 near-title 或 alias 不扩展。
- 预分词仍漏 q08→d39（跨境结算 vs 跨境金融結算試點，非字面短语/繁简）、q12→d12 与 q13→d11（宁德时代↔CATL 别名不扩展）、q14→d38（科技创新↔科技創新）。这些查询仍有首条相关，所以 MRR=1 **不等于全召回或语义理解**。不为合成结果调参、改标签、选赢家或放宽 SPEC 指标。
- q24 两臂均空，是预期负例。原始 JSON 完整保留空 ranks/expected IDs 和每个 missed ID，不能只报告成功查询。
- 全体 48 篇实际提取与两个窗口的 date labels 对照吻合（测试逐条核验；raw artifact 保存实际 page/diagnostics/derived dates）。q19 strict 返回 d45/d46；q20 返回 d21/d46；无 E3/E4、future、invalid、conflict、noise 或 unknown-timezone 泄漏。d21 保持 published_at=null，只 calendar_today 合格。d48 old-valid 是 out_of_window 而非无效日期；其 expires_at 恰为 now。
- 六次 retention：在 now 无删除，在 now+1ms 都只删除 d48；等号不删。事务、FTS 更新/删除、重复 URL/idempotence、verified→unsafe proof/tokens 移除、invalid batch rollback、碰撞拒绝和 reopen 有额外测试，不用此一次删除证明所有状态。

## 实际 RED/GREEN 与验证记录

在本会话按公共 seam 逐片执行，并非先写全部测试后补实现：

1. 首片 RED：实际 `python scripts/spec82-fts5-experiment.test.py` 缺 experiment module；最小 HTML→Node→SQLite GREEN **1/1**。
2. URL 对应关系 RED：strict 错误返回 `[e2,mismatch]`，而期望 `[e2]`；bridge 校验 actual evidence URL 后 GREEN **3/3**。精度/inclusive窗口同时通过。
3. 保留 RED：get/retention 尚无接口；old-valid/future/forged/first-index/equality 完成后 GREEN **4/4**。
4. identity/batch/reopen RED：duplicate URL 出现两条、arm mismatch 未拒绝、无类型错误界限；补 canonical identity/transaction/metadata/构造异常 close 后 GREEN **7/7**。原 RED 的 Windows cleanup 报错是未关闭 arm-mismatch 测试连接，已随构造 close 解决。
5. source/48-24 fixture 接口 RED 后 GREEN **9/9**；指标独立例子 RED 后 GREEN **10/10**。
6. 自审新增过期未清理反例 RED：general 返回 `[expired,future]`；query 加 expires_at >= now 后 GREEN **12/12**，同时验证 reingest 不留下 FTS orphan 和既有 ID/URL 碰撞整批回滚。最终 raw 六次在此修正之后重跑；源码 hash 已核对匹配。

已运行 merged87 受影响证据 suite：
`node --test --test-concurrency=1 gateway/evidence-metadata.test.mjs gateway/spec82-evidence.test.mjs gateway/news-verified.test.mjs gateway/news-feed.test.mjs gateway/news-quality.test.mjs` → **69/69 pass**。

Windows 现有完整串行 `gateway/*.test.mjs proxy/*.test.mjs`：**497 tests / 495 pass / 1 fail / 1 existing skip / 0 cancelled**，不能报告整体绿色。唯一失败在未改动 `gateway/server-browser.test.mjs:213` 的 zero-ms no-op，`TypeError: fetch failed` / cause `bad port`。一次最小隔离 `--test-name-pattern='accepts a zero-millisecond no-op'` → **1/1 pass**；原 full fail 不因此抹去，未修改既有测试/阈值，精确 intermittency 根因未确定。日志：assigned scratch `wag88-gateway-proxy-full.log`。锁定 browser provision 后纠正 Git Bash $PWD 变为 Windows 字面 /d 的 cache 路径，session 下载缓存已移到 owning worktree；这不是产品修复或测试通过依据。

最终全部 tracked syntax 通过：**15 shell / 69 JavaScript / 13 Python**；`git diff --cached --check` 与 `git diff --check` 通过。再次核对 raw 的源码/fixture SHA256、48 date audits、144 query observations、strict 资格、重复/reopen 排序及六次 retention 边界；staged 范围恰为批准的六文件。按 standards/spec 两轴完成本会话自审。

本地 WSL Ubuntu / Python 3.12.3 / 锁定 Node v22.23.2 的隔离快照全套 Python 尝试**未通过/未完成**。初次把临时 Node 的 2735 文件误纳入快照索引，停止并仅修正临时索引；修正后现有 `deploy.test.py` **41 tests / 2 errors**，两个真实依赖准备步骤在既有 30 秒上限触发 `subprocess.TimeoutExpired`。最小复现入口（完整运行已实际触发这些案例，不另称隔离重跑通过）：`python scripts/deploy.test.py ReleaseTests.test_complete_offline_rehearsal_runs_provenance_matched_search_and_independent_helper ReleaseTests.test_staged_release_wrapper_exercises_complete_offline_evaluation_before_commit`。`release.test.py` **3 tests / 1 existing skip / OK**，`searxng-overlay.test.py` **12/12 OK**；新 focused Python 在该快照仍运行时中止，crawler 尚未运行，不能称 Linux 本地全绿。进程诊断显示 bridge Node 当时处于 disk sleep；不据此认定所有失败的精确根因，不调整既有阈值/测试或继续无限重跑。原始日志保留 assigned scratch `wag88-linux-python-checks.log` / `wag88-linux-python-checks-fixed.log`（WSL 重定向混合导致部分输出覆盖；只报告可读回证据），已停止本会话校验进程后清理临时环境。

PR 最终 exact-head **完整 Linux GitHub CI** 仍是交付门禁，包括全部 Python 与 crawler，不用本地失败/中止代替；尚未发生于本报告提交前版本。最终结果必须在 #88/#82/PR 留痕并读回，CI 之后不再修改仓库以免使证据失效。

## 自审与限制

按 standards 与 spec 两轴在本会话自审，任务禁止另起 reviewers/subagents；不将加载 code-review 指南等同独立审查。保留必要 Node bridge（任务明确不得 port extractor）；不用新服务、分词包、RRF/聚类抽象。自审的 expired-before-cleanup 缺陷已实际 RED/GREEN，未范围外修浏览器 flaky。父 SPEC、票据及 CI 要求均对照，不把初期 design 广泛非目标误当禁止本次批准的源项目离线脚本。

已知限制：合成 48/24 非代表性，仅 codepoint example；全部源/tier/cluster 人工，不代表 91 个订阅可用性、50域规则/200真实页面准确率、转载最早原发语义、融合/排序生产质量。内存未测，无并发 writer/多进程/存储恢复/备份运维承诺，bridge 是进程级离线验证而非高吞吐服务。生产参数/语料规模/硬延迟阈值/目标主机编译能力/Meilisearch 比较均未验收。本结果**无生产胜者**。没有凭证、共享代理、service/production、Kanban、合并或关闭操作。
