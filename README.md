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

`/healthz` 只表示网关进程已响应；`/readyz` 会探测 SearXNG、Crawl4AI、Playwright 和统一公网出口，并返回最近一次依赖检查结果。两个接口都需要 Bearer Token。

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

# 清理 7 天前的截图、PDF 和 HTML 产物
sudo find /data/web-access-gateway/artifacts -type f \
  \( -name '*.png' -o -name '*.pdf' -o -name '*.html' \) -mtime +7 -print -delete
sudo find /data/web-access-gateway/artifacts -type d -empty -delete
```

健康检查定时器：

```bash
systemctl status web-access-healthcheck.timer
systemctl list-timers web-access-healthcheck.timer
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

验收还应覆盖：MCP 鉴权、SearXNG 搜索、静态页面正文、JS 渲染、浏览器快照/点击、截图/PDF、两个并发任务、超时，以及私网 URL 拦截。评测结果页为 [http://yosef-server:8930/evals](http://yosef-server:8930/evals)，仅展示已完成的评测报告；报告保留 30 天，截图/PDF 保留 7 天。MCP、健康检查和通用产物接口仍要求 Token。
