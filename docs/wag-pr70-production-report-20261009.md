# WAG PR70 合并、部署与生产复验（2026-10-09）

## 范围与边界

PR #70 沿用 SPEC #67，只覆盖固定候选质量探针、读取失败分类、逐候选完整 raw、共享读取预算与超时串行门禁。未修改生产搜索语义、共享代理、搜索引擎、认证、生产超时或 SSRF；未降低原生可用性门禁。候选人工标签是离线判据，不代表引擎相关性自动改善。

## 合并与发布

- PR #70 exact head：`62426a331eb330a9be4e37bb665eb836e14ef3c8`
- GitHub CI：`WAG reliability gate / test` SUCCESS
- 独立 review：通过；变更范围核对为探针、评测与回归测试
- 合并提交：`e0843eb4b6c25b6b58f503fad21606b4c5216986`
- 部署事务：`/data/web-access-gateway/releases/runtime-depum72w`
- 原生事务：`prepare`、`activate(public_readiness=passed)`、`commit` 均成功
- 当前事务读回：`committed`；`.release-pending` 不存在
- `web-access-gateway`、`web-access-crawl4ai`、`web-access-playwright`、`web-access-egress-proxy` 均为 `active`
- 回滚快照：事务目录保留；按原生路径可执行 `sudo python3 scripts/release.py restore /data/web-access-gateway/releases/runtime-depum72w`

部署使用 Git bundle 在生产机干净检出，源提交核验为 `e0843eb4b6c25b6b58f503fad21606b4c5216986`。

## 测试与原生门禁

本地聚焦回归：

- `node --test --test-concurrency=1 gateway/news-quality.test.mjs gateway/search-quality-probe.test.mjs`
- 19 passed / 0 failed

生产原生评测：

- smoke：`/data/web-access-gateway/reports/smoke-20261009T103621Z.json`，12/12，success 100%，quality 100%，timeout 0%，`passed`
- release：`/data/web-access-gateway/reports/release-20261009T103655Z.json`，14/14，success 100%，quality 100%，timeout 0%，并发退化 16.9173%（门限 ≤50%），`passed`
- release readiness：gateway、Crawl4AI、Playwright、egress 与 SearXNG 检查均返回预期结果；Playwright 的 HTTP 400 是其健康协议预期，不判为失败

## 固定候选生产探针

完整报告：`/data/web-access-gateway/reports/pr70-candidate-production-raw.json`

运行参数：固定候选夹具、`PROBE_QUERIES=[]`、`PROBE_MAX_READS=6`、串行读取、单次超时 20 秒、时间窗 `2026-10-08T00:00:00Z` 至 `2026-10-10T00:00:00Z`。本次搜索读取数为 0，候选读取预算没有与搜索结果读取重复消耗。

- denominator：7
- read_ok：6
- read_failure：0
- unread：1
- both_satisfied：1
- stale：1
- unknown：3
- irrelevant：1
- `both_satisfied + stale + unknown + irrelevant + unread = 7`
- 每个候选 entry 都含 `raw` 键；6 个已读取候选的 `raw` 非空
- 未读候选为 `http://map.baidu.com/`，`time_status=unverified`，错误说明为预算未读，不判页面无日期
- Guardian 近期来源读取到 publisher instant `2026-10-09T00:20:50.000Z`，窗内，`both_satisfied`
- 亚洲日报旧文章读取到 `2024-11-28T01:35:33.000Z`，窗外，`stale`
- PingWest、SearXNG 文档和 FT 本轮读取成功但没有可核验 publisher instant，保留 `unknown`
- 企业首页按人工负例归为 `irrelevant`

本轮没有把失败伪造为成功；生产固定候选恰好没有触发读取失败样本。MCP `isError`、typed error、非 2xx 归为 `read_failure` 并保留 raw 的路径由本地 19 项聚焦测试覆盖。

## 结论

PR70 已合并并按原生事务成功部署。生产候选报告满足完整分母、逐候选 raw、预算≤6、串行读取、未读与读取失败分类的测量要求；原生 smoke/release 门禁通过。候选质量本身只有 1/7 同时满足相关与时效，且存在 3 条 unknown、1 条 unread，因此新闻质量与搜索引擎相关性仍未证明自动改善；issue #51、#67 继续保持 OPEN。
