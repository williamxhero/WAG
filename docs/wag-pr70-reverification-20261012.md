# WAG PR70 生产复验复核（2026-10-12）

## 范围与边界

本次只复核 PR70 合并版本的生产事务状态和既有候选探针证据，不改变 `web_search` 语义、共享代理、搜索引擎、认证、超时或 SSRF 路径；不把历史报告当作本轮生产候选验收。

SPEC 留痕：GitHub issue #67。issue #51、#64、#65、#67 保持 OPEN。

## 已核对事实

- PR70 merge：`e0843eb4b6c25b6b58f503fad21606b4c5216986`；PR70 exact head：`62426a331eb330a9be4e37bb665eb836e14ef3c8`；仓库 `main`/`origin/main` 当前为 `5b4fa19`。
- 生产 `.release-current` 内容为 `/data/web-access-gateway/releases/runtime-hazapu_j`；该事务 `state.json` 为 `committed`，`public_readiness=passed`。
- 生产 `.release-pending` 当前存在，内容为 `/data/web-access-gateway/releases/runtime-_cowhhlg`；该事务 `state.json` 为 `restore_failed`。其 `public_readiness` 字段虽为 `passed`，但事务状态不是可提交状态，不能作为新发布完成证据。
- `web-access-gateway`、`web-access-crawl4ai`、`web-access-playwright`、`web-access-egress-proxy` 当前 systemd 状态均为 `active`。
- 未持有生产 MCP 凭据；未运行候选生产 MCP 探针，未伪称本轮完成候选验收。未修改生产文件、事务指针或凭据。
- 历史 `/data/web-access-gateway/reports/pr70-candidate-production-raw.json` 的时间为 2026-10-09；它只能作为历史证据，不能覆盖当前 pending/restore_failed 状态。

## 结论

本轮发布/生产候选验收阻塞，不能标记任务完成，也不能继续 `prepare`、`activate` 或 `commit`。阻塞原因是生产原生事务存在未清理的 `.release-pending`，且指向事务状态为 `restore_failed`；应由具备生产运维权限的后续动作先按原生事务流程核实并安全收敛该状态，再重新执行候选探针并保存完整 JSON 报告。

当前证据不代表新闻相关性提升或候选质量通过；此前 PR70 报告中的 1/7 同时满足结论仍仅是 2026-10-09 历史测量结果。

## 验收与交付记录

已执行：生产指针及各事务 `state.json` 只读核对；systemd 服务状态只读核对；生产健康接口未带认证时返回 `unauthorized`，因此不作为健康通过证据；仓库工作区未跟踪项仅为既有 `.worktrees/`，未清理。

未执行：新的生产发布事务、生产 MCP 候选探针、事务 abort/restore/cleanup、issue 关闭。
