# WAG 引擎池 opt-in 生产低频 A/B 验收（2026-10-10）

范围：只读核对生产 `runtime-hazapu_j` 当前 systemd 配置，并通过已认证 MCP 端点做串行低频探针；未修改 SearXNG overlay、代理/共 sing-box、认证或 SSRF。

生产核对：

- unit：`web-access-gateway.service` active/running。
- 实际 unit 环境仅显式包含 `NODE_ENV=production`、`PLAYWRIGHT_MCP_URL`、`EGRESS_PROXY`；EnvironmentFile 为 `/data/web-access-gateway/secrets/gateway.env`。
- 对 EnvironmentFile 做了只读键名核对：未发现 `WAG_SEARCH_ENGINE_POOL_GENERAL`、`WAG_SEARCH_ENGINE_POOL_NEWS`、`WAG_SEARCH_ENGINE_POOL_STRICT`。
- `/healthz` authenticated readback 为 HTTP 200，`ok:true`；未认证请求为 HTTP 401。

低频 A/B：每组固定 20 次、串行、同一已认证生产 MCP 端点；general/news/strict 各自使用固定查询集。strict 显式发送 `categories=news,time_range=day`。

| 组 | 次数 | zero-result | >=2 结果 | p50 ms | p95 ms | 观察 |
|---|---:|---:|---:|---:|---:|---|
| general（未配置 pool） | 20 | 0 | 20 | 965 | 4559 | 响应未出现 `engine_pool`；部分响应有 `failure_classes={captcha:1}` |
| news（未配置 pool） | 20 | 0 | 20 | 1052 | 1652 | 响应未出现 `engine_pool`；failure_classes 含 captcha，个别含 timeout/upstream_error |
| strict（未配置 pool） | 20 | 0 | 20 | 1413 | 2070 | 响应未出现 `engine_pool`；`time_range=day`，但 `time_range_enforced=false`；failure_classes 含 captcha，个别含 timeout/upstream_error |

结论：本轮证明生产默认行为仍是 opt-out（pool 环境变量为空/未设置），且三组探针在该窗口均非 zero-result、均达到至少 2 条结果；不能据此宣称 opt-in 引擎池质量达标。general/news/strict 没有实际启用 pool，因此没有可归因的 pool A/B 改善证据。strict 的 `time_range_enforced=false` 保留为失败证据，不得写成严格时间窗口通过。

未完成/限制：未启用生产 pool（没有受支持的配置入口证据）；未把配置纳入发布；未重跑 release/quality 套件。strict day 的第二个支持日期引擎仍缺失；naver disabled、bing 未定位等已知限制不因本轮结果消失。

建议：保持生产默认空配置和可回滚状态。若后续要做真实 opt-in A/B，先由运维确认受支持的 systemd EnvironmentFile/发布入口，再以明确的 general/news/strict 池配置做同样的串行样本，并要求 strict `time_range_enforced=true`、第二日期引擎存在后才进入发布评估。
