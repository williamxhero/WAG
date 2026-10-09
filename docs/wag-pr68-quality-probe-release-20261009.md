# WAG PR68 质量探针发布与生产候选验收（2026-10-09）

## 范围与边界

PR #68（固定候选搜索质量验收层）已独立审查通过并合并。本次发布只覆盖测量工具，不改变 `web_search` 语义、共享代理、搜索引擎、认证、超时或 SSRF 路径。生产可用性、搜索结果质量和候选新闻质量分开报告；本报告不把测量结果写成新闻相关性改善。

SPEC 留痕：GitHub issue #67。issue #51、#64、#65、#67 仍保持 OPEN。

## 合并与发布

- PR #68 exact head：`20f76123c210b620fa2e4effff8252f36636539b`
- GitHub CI：`WAG reliability gate / test` SUCCESS
- 合并提交：`cbd11a149e13a51710c76dc3c05db649e1987bb0`
- 部署事务：`/data/web-access-gateway/releases/runtime-cy_af7vv`
- 生产 reviewed revision：`cbd11a149e13a51710c76dc3c05db649e1987bb0`
- 原生事务：`prepare`、`activate(public_readiness=passed)`、`commit` 均成功
- `.release-current` 已指向 `runtime-cy_af7vv`；`.release-pending` 不存在
- `web-access-gateway`、`web-access-crawl4ai`、`web-access-playwright`、`web-access-egress-proxy` 均为 `active`
- rollback：保留事务快照；按原生路径执行 `sudo bash /data/web-access-gateway/scripts/deploy.sh restore /data/web-access-gateway/releases/runtime-cy_af7vv`

部署使用 Git bundle 在生产机干净检出，避免 Windows archive 换行差异。无密钥写入报告或聊天；报告写入前做了 token 扫描。

## 测试

本地聚焦：

- `node --test --test-concurrency=1 gateway/news-quality.test.mjs gateway/search-quality-probe.test.mjs`
- 19 passed / 0 failed
- `git diff --check` passed

## 生产候选探针

完整报告：`/data/web-access-gateway/reports/pr68-candidate-production-raw.json`

运行方式是发布版 `search-quality-probe.mjs`，通过生产 MCP `http://yosef-server:8930/mcp`，固定候选集，`PROBE_QUERIES=[]`，`PROBE_MAX_READS=6`，串行读取。候选夹具通过 `/tmp/pr68-search-quality-candidates.json` 提供；候选报告仍为固定七项完整分母。

- denominator：7
- read_ok：6
- read_failure：0
- unread：1
- relevant：5
- time_verified：1
- both_satisfied：1
- irrelevant：1
- stale：1
- unknown：3
- time_precision：instant 2、day 0、month 0、none 4
- `both_satisfied + irrelevant + stale + unknown + read_failure + unread = 7`
- 未读候选是 `http://map.baidu.com/`，明确为预算外未读，不判页面无日期
- Guardian：`article:published_time=2026-10-09T00:20:50.000Z`，窗内，`both_satisfied`
- Asia Daily：`article:published_time=2024-11-28T01:35:33.000Z`，窗外，`stale`
- FT：MCP 原始响应为 `isError=true`；轻量路径 HTTP 403 后渲染回退最终 HTTP 502、`render_fallback_failed`。发布版探针却记为 `read_ok` / `unknown`，这是验收发现的错误，不能当作读取成功。
- PingWest、SearXNG 文档：读取成功但没有 publisher instant，`unknown`

候选原始 MCP 响应以 `capture.calls[].raw` 保存，包含 trace、HTTP 状态、renderer、markdown、content hash、blocked reason、完整 temporal evidence 等字段。采集脚本仅作本次证据捕获，不修改生产代码。

## 发布版 search 只读探针

完整报告：`/data/web-access-gateway/reports/pr68-search-production.json`

- 3 次搜索，36 条结果
- UTF-8 query echo mismatches：0
- publisher instant：0
- published_on：6
- 严格 day 查询返回 11 条，但 `time_window_strict=true`、`time_range_enforced=false`
- unresponsive engine：quark（意外崩溃）
- reads：0（本轮独立验证没有增加页面读取）

因此本次验证确认测量链路、发布版本和报告分母工作；不宣称新闻相关性或时效质量已经改善。候选默认 gate 虽因 `minBothSatisfied=1` 返回 passed，完整人工验收质量仍只有 1/7 同时满足；该差异按真实结果保留。

## 已知缺口

当前发布版 `buildCandidateReadRecord` 会在候选条目中保留完整 `raw`，但 `evaluateNewsQuality` 的最终 `entries` 只投影分类字段，不能单凭 `candidate_report.entries` 看到 raw。为满足本轮完整证据要求，使用只读 MCP 客户端拦截保存了完整 `capture.calls[].raw`；该缺口已在 issue #67 回填，后续应让正式报告在不改变分类语义的前提下直接关联逐候选 raw，而不依赖临时捕获。

另一个生产验收失败：`readCandidate` 未检查 MCP `isError`，将 FT 的错误 JSON 当作成功读。上面的 6/0/3 是发布版实际输出，真实口径应为 read_ok=5、read_failure=1、unknown=2、unread=1；默认质量 gate 也应因读取失败而失败。本次生产验收判定未通过，不能用临时捕获掩盖正式工具缺陷。PingWest 正文是 2021 年 BuzzFeed 上市旧文，但本次发布版没有提取发布日，未获得可核验的 2021-12-14 发布日期，仍保留 unknown。

本次窗口显式设为 2026-10-08T00:00:00Z 至 2026-10-10T00:00:00Z（48小时），因此 time_range=day 是夹具标签，不把本次实测冒称滚动24小时验收。候选第一次执行不含原始捕获；为确认 raw 缺失做了第二次同预算6的执行，两份原始结果均保留，合计12次读取，每次预算均≤6。
