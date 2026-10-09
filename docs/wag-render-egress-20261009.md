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
（`browser_manager.py` 的 `contexts_by_config` / `_make_config_signature`）。signature 内含
`_browser_version`；**只有 bump 版本**才会把刚用过的上下文放进 `_pending_cleanup`，并在该页
release（refcount 归零）时关闭它。

bump 的触发条件是 `browser_manager._should_recycle()`（v0.9.2，l.1779–1784）：

```python
def _should_recycle(self) -> bool:
    limit = self.config.max_pages_before_recycle
    if limit <= 0:
        return False
    return self._pages_served >= limit     # 计数在 get_page() 里自增(l.1711)后才判定
```

判定发生在**每页计数自增之后**（`get_page` 末尾 l.1711–1715 调 `_maybe_bump_browser_version`）。
于是阈值 `N > 1` 时，任何**没有凑满 N 的尾上下文都不会被 bump、也不会入库**：

- **单次渲染**（计数=1）在 N>1 时**一次都不回收**——正是一个 `render:auto` 读取的常见形态；
- **奇数/非整批尾**把最后那个上下文留在 `contexts_by_config`；
- **失败页面**同样先自增计数、由同一机制处理。

没被 bump 的上下文其 socket pool 把已建立的 CONNECT 隧道一直留着，不随页面结束回收，
也不在分钟级内超时关闭。因此：**每渲染一个新主机就 +1 条隧道（重页面更多）**，
一个批次即可吃满 32 条，且批次结束后持续挤占——这就是"一个批次让后续静态读取也 429"的直接原因。

### 1.4 隔离压力/排空对照（第二实例，不改生产）
第二实例：出口代理 `:7896` + Crawl4AI `:11236`，同一 venv/浏览器/上游；渲染后对
`:7896` 的已建立连接数按秒采样，只改 `CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE`。
单次场景直接打到一个目的主机（即 `render:auto` 的常见形态）。

| 场景（均按例标注成功/失败） | N=2（旧默认）| N=1（新默认）|
| -------------------------- | ------------ | ------------ |
| 单次重页面 bbc.com/news（成功 200） | 渲染后立即 21，25s 后仍 **24** | 渲染后 0，25s 后 **0** |
| 单次重页面 ft.com（本组为源站 502 失败渲染） | 渲染后立即 21，25s 后仍 **22** | 渲染后 0，25s 后 **0** |
| 单次中等页 wikipedia（成功 200） | 25s 后仍 3 | 25s 后 **0** |
| 奇数尾批 3 页（iana/w3/rfc） | 尾页上下文留存、不归零 | 批次内峰值 3，批次后 **0** |
| 失败渲染 404 | 失败页上下文留存 | 批次内峰值 1，批次后 **0** |
| 并发 2 × 重页面 | 两上下文均留存 | 批次内峰值 19，批次后 **0** |

关键对照——同一第二实例、同一批 20 条**并发轻量读取**（`curl -x` CONNECT）经同一代理：

| 回收页数 N | 单次重页面 25s 后仍持有隧道 | 随后 20 条轻量读取 |
| ---------- | --------------------------- | ------------------ |
| `2`（旧默认） | **24**（bbc.com/news，200） | **8×200 / 12×429**（`000` = 代理 CONNECT 被 429 拒绝）|
| `2`（旧默认） | **22**（ft.com，502 失败渲染） | 10×200 / 10×429 |
| `1`（新默认） | **0** | **20×200** |

即：旧默认下一次（含失败）重页面渲染就能把 32 条全局预算吃到大半、把随后的静态读取打到
429；每页回收后同样场景归 0、轻量读取全通。第二实例全程独立，未触碰生产。

> 说明：上一版本表格（6 页均匀批次 N=2 → 批次后 0）只覆盖"恰好整除"的批次，掩盖了单次
> 与奇数尾批的缺口；本版按单次/奇数/失败/并发逐例复测，结论以本表为准。

## 2. 修复

### 2.1 网关：本地出口代理的限流不再触发渲染回退
`gateway/server.mjs`
- 回退触发条件由"任何带 401/403/406/429 的失败"收紧为"**源站**返回的
  401/403/406/429"（`isOriginBotChallenge()`：`error.kind === 'upstream_http_status'`）。
- 出口代理自己合成的失败（`egress_proxy_status`）直接回报，并透出 `retry_after`
  （代理的 `Retry-After: 5`）与 `blocked_reason`
  （`egress_proxy_blocked` / `egress_proxy_rate_limited`）。
- 理由：经同一条已经饱和的代理再发起 Chromium 渲染只会加重拥塞（自伤）。

### 2.2 Crawl4AI：默认每页回收浏览器上下文
`crawl4ai/app.py`
- `BrowserConfig(..., max_pages_before_recycle=CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE)`；
  默认 **1（每页回收）**，`0` 表示关闭（回退到旧行为），负值启动即 `ValueError`。
- 为什么是 1 而不是更大：见 §1.3，阈值 > 1 时单次渲染与奇数尾批的上下文永不回收、
  隧道常驻。`1` 让每页 bump、每次 release 归零，单页面结束后立即归还出口预算。
- `config/crawl4ai.env.template` 同步为 `CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE=1`。
- 未改任何出口限流参数，也未改渲染并发（仍为 2）。

## 3. 测试

测试先行：两条新增用例在修复前都失败。

| 用例 | 修复前 | 修复后 |
| ---- | ------ | ------ |
| `gateway/read-fallback.test.mjs`「a read throttled by the local egress proxy is reported, never sent to the renderer」(403/429) | 失败：旧代码把 `egress_proxy_blocked` 当反爬回退渲染，并返回伪造的 `http_status:200` 成功 | 通过 |
| `crawl4ai/health_test.py`「test_browser_recycles_its_context_after_a_bounded_number_of_pages」「test_an_invalid_recycle_setting_is_rejected」 | 失败 | 通过（默认值断言为 1） |

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

生命周期行为（单次/奇数尾批/失败/并发 + 后续轻量读取）由 §1.4 的隔离实例实测覆盖，
而不是离线单测——真实回收逻辑在 Crawl4AI 库内部，CI 不安装该库。

## 4. 复现命令

只读观测（生产机，不触发新渲染）：
```bash
ss -Htnp state established '( dport = :7895 )'        # 现有隧道与持有进程
for pid in $(ss -Htnp state established '( dport = :7895 )' | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u); do
  tr '\0' ' ' < /proc/$pid/cmdline; echo; done         # 归属：chrome-headless-shell network service
```

隔离对照（生产机，第二实例；第二代理 `:7896` + 第二 Crawl4AI `:11236`）：
```bash
# proxy:    EGRESS_PROXY_PORT=7896 EGRESS_MAX_HOST_CONCURRENCY=32 EGRESS_MAX_CONNECTIONS=32 \
#             node proxy/server.mjs
# crawl4ai: CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE=N uvicorn app:app --port 11236 （同一 venv/浏览器）
# 单次重页面渲染，25s 后排空对照；随后 20 条并发轻量读取经同一代理：
curl -x http://127.0.0.1:7896 https://www.iana.org/      # 命中则 200，饱和则被代理 429
# N=2 → 单次重页面后仍持 21–24 条隧道、轻量读取 8–10/20 被 429；
# N=1 → 单次重页面后归 0、20/20 轻量读取全通。
```

**清理状态**：本文件写作期间的第二实例进程（代理 `:7896`、Crawl4AI `:11236` 及其
`chrome-headless-shell`）已全部停止、端口已释放；临时目录 `/tmp/wag-exp`、
`/tmp/wag-exp3` **保留未删**（单查询模式禁用 `rm`），可由人工清理。生产 `:7895`/
`:11235` 未受影响（`healthz=200`）。

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
- 生产 `evidence-live-smoke.mjs` 是否恢复到 10/10 尚未验证——按 §1.4，单次重页面渲染
  后的残留隧道已从 21–24 降到 0，预期不再触发后续全量 429，但这需要部署后实测确认。
- 渲染并发仍为 2、单页仍可能瞬时开多条隧道；若部署后仍见饱和，下一步是降低渲染
  并发或给出口代理加空闲隧道回收（本卡未做，避免扩大影响面）。
