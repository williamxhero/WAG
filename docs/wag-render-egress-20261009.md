# WAG 读取回退放大限流与渲染连接占满：诊断与修复（2026-10-09）

本文件记录 issue #51 D2 之后的一项独立工作：① 修掉"本地出口代理限流被当作反爬、
触发渲染回退"的自伤；② 查清渲染会话的连接生命周期，并让渲染及时归还共享出口预算。

文中所有数字都来自生产机 `yosef-server` 上的真实命令输出；**没有任何生产服务被
修改**：观测是只读的，压力对照跑在第二实例（第二个出口代理 + 第二个 Crawl4AI）上，
与生产实例共用同一份 `crawl4ai-venv`、浏览器与上游 sing-box。

## 1. 现象与根因

### 1.1 现象（沿用 issue #51 / 轮次报告 §6）
- 生产 `EGRESS_MAX_CONNECTIONS`（代码默认）= 32，`EGRESS_MAX_HOST_CONCURRENCY` = 32。
- 一个 `render:auto` 批次就能把到 `127.0.0.1:7895` 的 CONNECT 隧道顶到 32–33；
  饱和后所有新 CONNECT 被代理合成 `429 Too Many Requests`（`Retry-After: 5`）。
- 批次结束后数分钟内隧道不释放（报告实测 ~4 分钟），期间连纯轻量读取也 429。

### 1.2 只读观测：隧道只增不减
在生产机上对一个新目的主机渲染 1 次（`POST http://127.0.0.1:11235/crawl`），
到 `:7895` 的已建立连接数 +1，并持续 >2 分钟不变；持有者是 Crawl4AI 的
`chrome-headless-shell` network service（`ss -Htnp` 可见 pid 与 `/proc/<pid>/cmdline`）。

### 1.3 机制（Crawl4AI 0.9.2 源码 + 实测）
`AsyncWebCrawler` 把浏览器上下文按 **config signature 缓存复用**
（`browser_manager.py` 的 `contexts_by_config` / `_make_config_signature`）。网关每次
渲染下发的 `crawler_config` 只有 `screenshot`/`pdf` 两个取值，signature 恒定，于是
整个进程生命周期只用一个 Chromium 上下文；该上下文的 socket pool 把已建立的
CONNECT 隧道一直留着，不随页面结束回收，也不在分钟级内超时关闭。

因此：**每渲染一个新主机就 +1 条隧道（重页面更多），一个批次即可吃满 32 条**，且
批次结束后持续挤占——这就是"一个批次让后续静态读取也 429"的直接原因。

### 1.4 隔离压力/排空对照（第二实例，不改生产）
第二实例：出口代理 `:7896` + Crawl4AI `:11236`，同一 venv/浏览器/上游；
连续渲染 6 个不同主机，每 1 秒采样 `:7896` 的已建立连接数；只改
`CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE`。

| 回收页数 N | 批次内峰值隧道 | 批次后 30s 峰值 | 说明 |
| ---------- | -------------- | --------------- | ---- |
| `0`（= 现网行为） | **10** | **10** | 只增不减，批次结束仍全部挂着 |
| `4` | 5 | 6 | 每 4 页回收；批次末尾那个上下文仍留着 |
| `2` | 5 | **0** | 回收后立即归还 |
| `1` | 3 | **0** | 每页回收，峰值最低 |

批次均为 6 次渲染、0 失败；渲染耗时 1.0–2.0s，与基线同量级（回收不引入可见延迟）。
命令与原始采样见本文件 §4。

## 2. 修复

### 2.1 网关：本地出口代理的限流不再触发渲染回退
`gateway/server.mjs`
- 回退触发条件由"任何带 401/403/406/429 的失败"收紧为"**源站**返回的
  401/403/406/429"（`isOriginBotChallenge()`：`error.kind === 'upstream_http_status'`）。
- 出口代理自己合成的失败（`egress_proxy_status`）直接回报，并透出 `retry_after`
  （代理的 `Retry-After: 5`）与 `blocked_reason`
  （`egress_proxy_blocked` / `egress_proxy_rate_limited`）。
- 理由：经同一条已经饱和的代理再发起 Chromium 渲染只会加重拥塞（自伤）。

### 2.2 Crawl4AI：按页回收浏览器上下文，立即归还隧道
`crawl4ai/app.py`
- `BrowserConfig(..., max_pages_before_recycle=CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE)`；
  默认 **2**，`0` 表示关闭（回退到旧行为），负值启动即 `ValueError`。
- `config/crawl4ai.env.template` 增加 `CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE=2`。
- 未改任何出口限流参数，也未改渲染并发（仍为 2）：按页回收后单批次峰值已从 10 降到 ~5。

## 3. 测试

测试先行：两条新增用例在修复前都失败。

| 用例 | 修复前 | 修复后 |
| ---- | ------ | ------ |
| `gateway/read-fallback.test.mjs`「a read throttled by the local egress proxy is reported, never sent to the renderer」(403/429) | 失败：旧代码把 `egress_proxy_blocked` 当反爬回退渲染，并返回伪造的 `http_status:200` 成功 | 通过 |
| `crawl4ai/health_test.py`「test_browser_recycles_its_context_after_a_bounded_number_of_pages」「test_an_invalid_recycle_setting_is_rejected」 | 失败 | 通过 |

本地已跑（Windows，`node --test --test-concurrency=1`）：

| 范围 | 结果 |
| ---- | ---- |
| `gateway/read-fallback.test.mjs` | 20 pass / 0 fail |
| `gateway/health.test.mjs` | 48 pass / 0 fail |
| `gateway/eval-core/evals/eval-runner` | 69 pass / 0 fail |
| `gateway/read-deadline + search + search-boundary` | 41 pass / 0 fail |
| `gateway/read-pinning + server-browser + read-fallback` | 39 pass / 0 fail |
| `gateway/artifact-* + bootstrap-host + crawl-response + eval-case + startup + server-read + release-rehearsal + proxy/*` | 87 pass / 2 fail（两个用例需要 `runtime/playwright-mcp` 的 `playwright` 模块与 Chromium，本机未 provisioning；CI 会安装） |
| `python -m unittest discover -s crawl4ai -p '*_test.py'` | 5 pass / 0 fail |
| `scripts/bootstrap.test.py` | 11 pass / 0 fail |

未在本机跑通：`gateway/healthcheck.test.mjs`（>420s 超时）、
`scripts/deploy.test.py`、`scripts/searxng-overlay.test.py`（依赖 Unix-only 的
`fcntl` 与子进程解码）。这些都不涉及本次改动，由 CI（ubuntu-latest）覆盖。

## 4. 复现命令

只读观测（生产机，不触发新渲染）：
```bash
ss -Htnp state established '( dport = :7895 )'        # 现有隧道与持有进程
for pid in $(ss -Htnp state established '( dport = :7895 )' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
  tr '\0' ' ' < /proc/$pid/cmdline; echo; done         # 归属：chrome-headless-shell network service
```

隔离对照（生产机，第二实例；`/tmp/wag-exp/` 为临时目录，测试后已清理）：
```bash
# proxy:  EGRESS_PROXY_PORT=7896 EGRESS_MAX_HOST_CONCURRENCY=32 node proxy/server.mjs
# crawl4ai: CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE=N uvicorn app:app --port 11236 （同一 venv/浏览器）
# 连续 POST /crawl 6 个不同主机，同时每秒采样：
ss -Htn state established '( dport = :7896 )' | wc -l
# N=0 → 峰值 10、批次后 10；N=2 → 峰值 5、批次后 0；N=1 → 峰值 3、批次后 0
```

本地测试：
```bash
npm --prefix gateway ci --ignore-scripts
node --test --test-concurrency=1 gateway/*.test.mjs proxy/*.test.mjs
python -m unittest discover --start-directory crawl4ai --pattern '*_test.py'
```

## 5. 边界与未完成

- 未改 `EGRESS_MAX_CONNECTIONS` / `EGRESS_MAX_HOST_CONCURRENCY`，未动共享
  `127.0.0.1:7890`（sing-box）。
- **未部署生产**：本卡只交付独立 worktree + PR；生产验收（smoke / release /
  evidence 三件套 + 真实查询）由协调者与运维在合并后执行。
- 生产 `evidence-live-smoke.mjs` 是否恢复到 10/10 尚未验证——按 §1.4，单批次峰值已从
  10 降到 ~5（32 条预算的 ~1/6），预期不再触发全量 429，但这需要部署后实测确认。
- 渲染并发仍为 2、单页仍可能瞬时开多条隧道；若部署后仍见饱和，下一步是降低渲染
  并发或给出口代理加空闲隧道回收（本卡未做，避免扩大影响面）。
