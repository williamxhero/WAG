# WAG PR68 生产候选探针验收记录（2026-10-12）

## SPEC 与范围

- SPEC 留痕：GitHub issue #67。
- 本轮目标：验证已发布质量探针的生产测量链路，不宣称新闻相关性或搜索质量提升。
- 范围边界：只运行固定候选集的 bounded candidate probe；不修改 `web_search` 语义、共享代理、搜索引擎、超时或 SSRF 路径。
- issue #51、#64、#65、#67 保持 OPEN。

## 发布状态核对

- 工作区 `main` 与 `origin/main`：`5b4fa1987aced31ca88cb08285e30a93b70fd635`。
- 当前生产 `.release-current`：`/data/web-access-gateway/releases/runtime-_w7o12mz`。
- 当前事务 `state.json.status`：`committed`；`public_readiness`：`passed`。
- `.release-pending`：不存在。
- `web-access-gateway`、`web-access-crawl4ai`、`web-access-playwright`、`web-access-egress-proxy`：均为 `active`。
- 生产 `/healthz`：HTTP 200；`/readyz`：`status=passed`、`core_ok=true`、`public_connectivity_ok=true`。
- 未重复执行发布事务；既有 rollback 快照保持不变。

## 探针执行

执行的是已发布版本中的 `/data/web-access-gateway/releases/runtime-_w7o12mz/candidate/runtime/gateway/search-quality-probe.mjs`，通过生产 MCP `http://yosef-server:8930/mcp` 运行。

- 候选 fixture：仓库 `gateway/fixtures/search-quality-candidates.json`，固定分母 7，人工标签逐条保留。
- `PROBE_MAX_READS=6`；候选读取串行且不超过预算；第 7 个候选保留为 `unread`。
- 结果 JSON 原文：`docs/wag-pr68-production-candidate-report-20261012.json`。
- 输出中保留每个已读取候选的完整 `raw` MCP payload；MCP `isError` / typed error 不计为 `read_ok`。
- 无密钥输出；报告未保存 token。

## 真实结果

- search：3 次，25 个结果，UTF-8 query echo mismatch：0。
- 固定候选分母：7。
- `read_ok=5`、`read_failure=1`、`unread=1`。
- `both_satisfied=0`、`time_verified=0`、`unknown=4`、`irrelevant=1`。
- gate：`passed=false`；原因：1 个 read failure 超过允许值 0，且 0 个 both-satisfied 低于要求 1。
- FT 候选真实结果为 `read_failure`，错误为生产 MCP 读取阶段的 TLS socket disconnect；未将其计为成功。
- Guardian 候选成功读取并保留 publisher instant，但本次 fixture 未提供显式 `PROBE_WINDOW_START/END`，因此按探针规则分类为 `unknown`，不虚报为 fresh。

## 结论与验收

发布后的生产候选测量链路已实际运行，完整分母、逐条标签、读取状态和 raw 证据均已保存；但质量 gate 未通过。本记录不得解释为新闻相关性提升、搜索质量改善或生产质量验收通过。

已验证：

- 发布版本确为 committed 且 readiness passed；
- 生产 MCP search/read 路径确实被调用；
- `PROBE_MAX_READS<=6` 生效，候选未被重复读取；
- 失败读取未被误计为成功；
- 全部 7 个固定候选均出现在最终报告；
- 报告无密钥输出。

未完成：新闻质量 gate 未通过；不关闭 issue #51/#64/#65/#67。
