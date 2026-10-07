# Web Access Gateway

为本机 LLM 提供统一、受认证保护的网页访问 MCP 服务。它将已有的 SearXNG、原生 Crawl4AI 和原生 Playwright MCP 组合为三个工具：`web_search`、`web_read`、`web_browser`。

当前部署在 `yosef-server`（小电脑）上；Docker 不参与本项目。

## 当前架构

```text
LLM MCP client
    │  Bearer Token
    ▼
Web Access Gateway — yosef-server:8930/mcp
    ├─ web_search  ──► SearXNG       yosef-server:8801
    ├─ web_read    ──► Crawl4AI      127.0.0.1:11235
    └─ web_browser ──► Playwright MCP 127.0.0.1:8931
```

唯一面向局域网客户端的入口是 `http://yosef-server:8930/mcp`。SearXNG 的人工偏好设置入口为 `http://yosef-server:8801`；Crawl4AI 与 Playwright MCP 只监听小电脑的回环地址，不能从局域网直连。

## 目录与边界

本机源码目录：

```text
D:\WILL\TOOLS\web_access_gateway_proj
├─ gateway/                 # Node.js MCP 网关源码
├─ crawl4ai/                # 原生 Crawl4AI HTTP 服务源码
├─ runtime/playwright-mcp/  # Playwright MCP 的锁定 npm 依赖清单
├─ config/                  # 非机密模板与依赖锁定文件
├─ scripts/                 # 初始安装、升级、状态与清理脚本源码
├─ systemd/                 # systemd unit 源文件
└─ compose/                 # 保留的空目录；本项目不使用 Docker Compose
```

小电脑的 `/data/web-access-gateway` 不保存项目源码，只保留运行所需内容：

```text
runtime/     Node.js、npm 依赖、Python 虚拟环境和浏览器二进制
config/      当前运行配置（仅保留 playwright.env）
secrets/     网关与 Crawl4AI 令牌，权限为 0600
data/        Crawl4AI 数据
logs/        运行与诊断日志
artifacts/   截图、PDF 等临时产物
```

已安装的 systemd unit 位于 `/etc/systemd/system/`，是启动所必需的系统运行配置，而不是 `/data` 下的项目源码。

## MCP 连接

连接地址：

```text
http://yosef-server:8930/mcp
```

请求必须带有：

```text
Authorization: Bearer <GATEWAY_TOKEN>
```

令牌只保存在小电脑的 `/data/web-access-gateway/secrets/gateway.env`。在小电脑上以管理员权限查看；不要把令牌提交到此项目或贴入聊天记录。

通用 MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "web-access-gateway": {
      "url": "http://yosef-server:8930/mcp",
      "headers": {
        "Authorization": "Bearer <GATEWAY_TOKEN>"
      }
    }
  }
}
```

健康检查示例（在小电脑执行，令牌不会打印到终端）：

```bash
set -a
. /data/web-access-gateway/secrets/gateway.env
set +a
curl --fail -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "http://$GATEWAY_HOST:$GATEWAY_PORT/healthz"
```

`/healthz` 只表示网关进程已响应，不触发依赖探测；`/readyz` 会检查 SearXNG 非空有效标准化结果、Crawl4AI 已初始化生命周期、Playwright 和统一公网出口。每个探测最多 5 秒（包括响应体），结果缓存 10 秒，进行中的检查合并复用；诊断响应体限制为 64 KiB，错误与引擎详情会脱敏。两个网关接口都需要 Bearer Token；Crawl4AI 的 `/readyz` 使用 `CRAWL4AI_TOKEN`，不执行实际抓取。

就绪响应保留 `ok` 与 `dependencies`，并添加 `core_ok`、`public_connectivity_ok`、`status`（`passed` / `degraded` / `failed`）。核心能力失败返回 503；仅搜索或公网出口失败也返回 503，但分类为公网连通性退化。`healthcheck.sh --core-only` 只根据核心能力决定部署回滚；完整健康检查会对公网退化返回非零，并保留脱敏的 curl / 后端错误分类。整个脚本默认最多 45 秒，另有最多 2 秒的终止宽限。实际抓取能力由发布验收验证，而非反复运行的存活探针。

## MCP 工具

### `web_search`

通过现有 SearXNG JSON API 搜索公开网页，结果标准化为标题、链接、摘要、来源引擎与分类。

```json
{
  "query": "SearXNG documentation",
  "categories": "general",
  "language": "en",
  "time_range": "month",
  "page": 1
}
```

`query` 必填；可选参数为 `categories`、`engines`、`language`、`time_range`（`day`、`month`、`year`）和 `page`（1–10）。网关不会修改 SearXNG 已配置的可用引擎。

每个搜索结果还返回 `retrieved_at`、`source.url`、`source.host` 和 `temporal_evidence`。如果 SearXNG 提供可信的发布时间，网关会将其作为 `published_at` 保留，并在摘要前标明发布时间的元数据来源。

### `web_read`

读取公开 URL 并返回干净 Markdown。默认先以轻量 HTML 提取读取；正文过短或要求渲染时，自动改用 Crawl4AI。

```json
{
  "url": "https://example.com/article",
  "render": "auto",
  "output": "markdown"
}
```

- `render`：`auto`（默认）、`never`、`always`
- `output`：`markdown`（默认）、`screenshot`、`pdf`
- Markdown 结果返回 `retrieved_at`、`source` 和 `temporal_evidence`；`published_at` 只来自页面发布者元数据或 JSON-LD，不使用网关检索时间代替。
- 结果同时返回 `http_status`、`content_type`、`bytes`、`content_hash` 和字符集；403、429、5xx 和超限响应作为错误返回，不进入正文证据。
- 截图和 PDF 保存到 `artifacts/`，返回的下载链接同样需要 Bearer Token；默认保留 7 天。

### `web_browser`

用于复杂公开网页的有限交互。每个会话最长 15 分钟，最多两个会话/两个浏览器任务并发；不保存 Cookie 或登录状态。

```json
{
  "actions": [
    { "type": "navigate", "url": "https://example.com" },
    { "type": "snapshot" },
    { "type": "screenshot" }
  ]
}
```

可用动作：`navigate`、`click`、`wait`、`scroll`、`snapshot`、`screenshot`。后续调用传回的 `session_id` 可以复用同一会话。接口不提供填写字段、上传、下载或登录操作；只应用于公开网页，避免点击会提交外部表单的按钮。

浏览器导航、点击后的最终 URL 和页面请求都经过公网出口；私网、回环、链路本地和保留地址由网关与出口代理共同拦截。快照结果带有当前 `url`、`retrieved_at`、`source` 和 `temporal_evidence`。

## 安全与资源限制

- 网关使用 Bearer Token，未启用跨域访问入口。
- 所有 URL 仅允许 HTTP/HTTPS；初始 URL 和最多五次重定向都会进行 DNS 解析。
- 回环、私网、链路本地、Docker 常用网段和多播/保留地址会被拒绝，避免 SSRF 访问小电脑或局域网内部服务。
- 轻量读取最大响应 5 MiB、单次网络请求超时 30 秒；Crawl4AI 渲染超时 90 秒。
- Crawl4AI 渲染与浏览器任务的并发上限均为 2；浏览器 service 的内存上限为 6 GiB。
- 出网沿用小电脑的 sing-box 代理；本机服务地址被加入 `NO_PROXY`。
- 出口代理的全局 CONNECT 并发上限由 `EGRESS_MAX_CONNECTIONS` 配置，默认 32，必须为正整数；它独立于 `EGRESS_MAX_HOST_CONCURRENCY`（代码默认 8，当前 systemd unit 配置为 32）。systemd 部署可通过该代理 service 的 `Environment=` drop-in 覆盖这些值。
- 从接受 CONNECT、DNS 校验及上游握手到隧道关闭均占用连接配额；超限立即返回 `429 Too Many Requests` 和 `Retry-After: 5`，不排队。`EGRESS_CONNECT_TIMEOUT_MS`（默认 10000 ms）同时约束 DNS 校验和上游握手；失败、超时、重置、客户端中止和正常关闭都释放配额，既有隧道不受其他请求失败影响。

## 运维

以下命令通过 `ssh yosef-server` 执行。运行中的服务由 systemd 管理，不需要也不应从本机直接运行 `scripts/` 中的 Linux 脚本。

```bash
# 状态
sudo systemctl status web-access-crawl4ai web-access-playwright web-access-gateway

# 启动 / 停止
sudo systemctl start web-access-crawl4ai web-access-playwright web-access-gateway
sudo systemctl stop web-access-gateway web-access-playwright web-access-crawl4ai

# 日志
journalctl -u web-access-gateway -n 200 --no-pager
journalctl -u web-access-crawl4ai -n 200 --no-pager
journalctl -u web-access-playwright -n 200 --no-pager

# 立即执行依赖健康检查
sudo systemctl start web-access-healthcheck.service
systemctl show -p Result --value web-access-healthcheck.service

# 已授权运维时手动运行同一产物保留策略（会删除过期的已完成产物）
sudo systemctl start web-access-artifact-cleanup.service
systemctl list-timers web-access-artifact-cleanup.timer
```

健康检查定时器：

```bash
systemctl status web-access-healthcheck.timer
systemctl list-timers web-access-healthcheck.timer
```

### 产物生命周期

仓库中的 `systemd/web-access-artifact-cleanup.service` 和 `.timer` 是权威来源；初始安装与部署通过 `scripts/install-artifact-cleanup.sh` 安装并启用每日定时器（`OnCalendar=daily`、`Persistent=true`），本次离线代码验证不代表已在小电脑启用。

七天截止定义只有一个：**已完成文件的 `mtime <= 清理开始时刻 - 604800000 毫秒`**，边界相等时删除；不是按日历日期，也不是 `find -mtime +7` 的取整规则。网关使用完成发布时刻作为 mtime。清理读取与网关相同的 `ARTIFACT_DIR`，默认 `/data/web-access-gateway/artifacts`，并只删除：

- 网关的 `YYYY-MM-DD/<UUID>.png` / `.pdf`；
- 专属 `playwright/`、`crawl4ai/` 子树中的已完成 `.png` / `.pdf` / `.html`。

临时/隐藏/进行中名称（包括 `.tmp`、`.part`、`in-progress`）、近期文件、未知类型、符号链接和多重硬链接均保留；不删除目录。外部产物写入者应先写临时名称，再原子发布最终名称。配置根目录必须是规范路径，不能是文件系统根或符号链接；Linux 使用打开的目录句柄与不跟随符号链接的遍历防止目录替换造成越界删除。评测报告的 30 天保留策略独立且不变。

网关产物写入串行、临时文件原子重命名发布，默认上限仍为单产物 25 MiB、总存储 1 GiB。清理后重新统计，且**每次写入准入前**统计根目录中的实际普通文件（也包括临时/未知文件与外部 Playwright 产物），因此外部添加、删除或定时清理释放的空间无需重启即可生效；统计错误不会被当成零用量。Playwright 是独立写入者，已存在的输出计入网关准入，不能把扫描当作跨进程磁盘预留。

离线验证只使用自动创建并回收的临时树与 mocked `systemctl`：

```bash
node --test gateway/artifact-store.test.mjs gateway/artifact-cleanup-install.test.mjs
for script in scripts/cleanup-artifacts.sh scripts/install-artifact-cleanup.sh scripts/bootstrap.sh scripts/deploy.sh; do bash -n "$script" || exit; done
```

## 版本与升级

当前锁定版本：Node.js `v22.23.2`、Crawl4AI `0.9.2`、FastAPI `0.141.1`、Uvicorn `0.52.4`；网关 npm 依赖和 Playwright MCP 依赖由各自的 `package-lock.json` 锁定。

升级应当是显式、可审阅的操作：先在本机源码目录修改并验证，再把必要的运行时文件部署到小电脑，重启对应 service，并执行健康检查。不要使用自动滚动升级，也不要把本机源码目录整体常驻复制回 `/data/web-access-gateway`。

`scripts/bootstrap.sh` 用于从零开始的初始安装流程；当前小电脑已经是“运行时仅保留”部署，不应对现有服务直接重跑该脚本。

## 部署后验收

```bash
# 应均为 active
systemctl is-active web-access-crawl4ai.service
systemctl is-active web-access-playwright.service
systemctl is-active web-access-gateway.service
systemctl is-active web-access-healthcheck.timer

# 网关与 SearXNG 仅绑定直连网线接口；其余服务仅绑定回环接口。
sudo ss -ltnp '( sport = :8930 or sport = :8931 or sport = :11235 )'
```

评测门禁默认值：smoke 成功率/质量通过率均至少 100%；release 均至少 95%，普通可用性案例的超时率至多 2%，并发退化至多 50%。边界相等通过；比较使用未取整的测量值。可在 `WAG_EVAL_SAMPLES` 指定的 JSON 样本文件中提供 `thresholds` 对象覆盖当前套件的门限（键为 `success_rate_pct`、`quality_rate_pct`、`timeout_rate_pct`、`concurrency_degradation_pct`）；无效门限或缺失必需测量不会通过。故意超时/安全拒绝案例不进入普通可用性超时分母。

核心案例失败或任一门禁失败，结论为 `failed`；仅公网连接案例不通过且没有失败门禁时为 `degraded`。两者的评测命令退出码均为非零，不改变部署脚本独立的核心/公网 readiness 回滚策略。报告增量提供 `gates`、`failing_gates` 和 `reasons`；空/不完整套件及失败的并发基线均不能通过。

看板从每次报告读取并显示门限，不使用独立常量。历史结构化及旧格式报告的原有结论保留；缺少门限时按 suite 使用以上默认值，未知 suite 使用 smoke 默认值，标记 `thresholds_source: legacy_defaults`。这是兼容显示，不是重新认证历史报告。

验收还应覆盖：MCP 鉴权、SearXNG 搜索、静态页面正文、JS 渲染、浏览器快照/点击、截图/PDF、两个并发任务、超时，以及私网 URL 拦截。评测结果页为 [http://yosef-server:8930/evals](http://yosef-server:8930/evals)，仅展示已完成的评测报告；报告保留 30 天，截图/PDF 保留 7 天。MCP、健康检查和通用产物接口仍要求 Token。
