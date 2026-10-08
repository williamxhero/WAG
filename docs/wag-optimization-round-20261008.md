# WAG 优化轮次验收与前后对比（2026-10-08）

本轮把 6 个前置 PR 合并到 `main`，用仓库自带的事务化部署路径发布到生产主机
`yosef-server`，然后按卡片要求重跑该服务自身的 smoke / release / evidence 验收，
并做真实查询与读取对比。**本文只写实际命令产出的事实**；没生效、没验证、变差的
项目单列，数字都能追溯到底下命令行。

- 合并后 `main` 修订：`fe50854570883e7be53504fe3f817670185af831`（`fe50854`）
- 本次部署的生产 release：`/data/web-access-gateway/releases/runtime-7x0vxago`
- 部署前生产 release（基线）：`runtime-v1p9_r97`
- 部署方式：`scripts/deploy.sh prepare → activate → commit`（协调 overlay，见下）
- SearXNG overlay 生效摘要（来自事务 provenance）：
  `engines_digest=583e7a40fcfaba2b8e628851a5501b6a33ad34d54447ad1e2d628c8acc95b581`、
  `outgoing_digest=2520eaca85e912a5d16613fa745dfc5b75c5c42e52a30a5134235f32b672e98f`

## 1. 合并复核

| PR | 标题 | 状态 | CI |
|----|------|------|----|
| #44 | fix(search): 结果过滤 / time_range 时效标注 / URL 日期补强 | merged | 成功 |
| #45 | fix(ops): robust gateway startup dirs + public readiness graded as degraded | merged | 成功 |
| #46 | feat(read): 请求身份补齐 + 401/403 回退渲染 (card4) | merged | 成功 |
| #47 | docs: WAG 出口链路与搜索引擎可达性诊断报告 | merged | 成功 |
| #48 | fix(ops): 修复 searxng-healthcheck 每 5 分钟误重启 SearXNG | merged | 成功 |
| #50 | fix(searxng): 引擎池复核 + 查询预算压到 3s(overlay) | merged | 成功 |

六个 PR 均在 `14:48:20Z~14:48:47Z` 由仓库属主账号批量合并；各自 head 提交与合并后
`main` 的 push CI 均为 success。合并前未走“隔离测试通过再放行”的前置卡口（前置卡
随父卡完成自动 ready→dispatch），属**事后复核**：diff 范围和前序卡授权一致，未发现
越权改动。复核同时确认 `gateway/` 下并行改动**没有产生文本冲突**（合并后 main 的
`gateway/server.mjs` 同时含 card4 的读取路径与 card5 的 readiness 三态；本轮的
`runtime-7x0vxago` 部署恰好把两者一起发布）。

## 2. 部署（按仓库自带路径，未手改生产文件）

```bash
# 源树：/tmp/wag-rel-fe50854 = main@fe50854 的干净检出
sudo python3 scripts/release.py prepare /tmp/wag-rel-fe50854 \
  --target /data/web-access-gateway --units /etc/systemd/system \
  --searxng-settings /data/searxng/config/settings.yml
sudo python3 scripts/release.py activate /data/web-access-gateway/releases/runtime-7x0vxago
sudo python3 scripts/release.py commit  /data/web-access-gateway/releases/runtime-7x0vxago
```

产出（三段命令的 stdout）：

```
prepare : {"transaction":"/data/web-access-gateway/releases/runtime-7x0vxago","status":"prepared",...}
activate: {"transaction":"...","status":"activated","public_readiness":"passed",...}
commit  : {"transaction":"...","status":"committed","public_readiness":"passed",...}
```

收尾状态核对：`.release-current = /data/web-access-gateway/releases/runtime-7x0vxago`；
`.release-pending` 已清除；`web-access-gateway / -crawl4ai / -playwright / -egress-proxy`
与 `searxng` 均 `active`。

> 说明：诊断卡给出的代理节点/sing-box 改法**未执行**。本轮没有任何超出 WAG 自身
> 影响面的改动。

## 3. 前后逐项对比

### 3.1 验收三件套

| 验收 | 基线（runtime-v1p9_r97） | 现状（runtime-7x0vxago） | 结论 |
|------|--------------------------|--------------------------|------|
| `eval-runner.mjs smoke` | 通过，11/11（`smoke-20261008T151355Z`） | 通过，12/12（`smoke-20261008T152538Z`）；**但会抖动**：15:35 一次 11/12（见 §4 D3），15:36 两次 12/12 | 用例数 +1（新增连通性用例 `gateway-public`）；稳定性变差 |
| `eval-runner.mjs release` | **失败**，13 用例全过但门禁 `concurrency_degradation_pct`=250.2%>50（`release-20261008T151414Z`） | **通过**，14 用例全过，`concurrency_degradation_pct`=-13.3%（`release-20261008T153411Z`） | 明显改善 |
| `evidence-live-smoke.mjs` | 通过：5 条搜索全部 15 结果；10 次读取成功，成功前失败 1 次 | 通过（干净重跑）：5 条搜索 15/15/15/14/15；10 次读取成功，**成功前失败 32 次** | 门禁状态相同，但读取失败密度大幅上升（见 §4 D2） |
| 延迟（release 报告） | p50 1097ms / p95 3199ms | p50 730ms / p95 3138ms | 改善 |

### 3.2 `/readyz` 连续 5 次

| 轮次 | 结果 |
|------|------|
| 基线（部署前） | 200 ×5，首次 8.006928s（冷），其余 ~1ms |
| 现状（激活后 15:25） | 200 ×5，全部 ~1ms |
| 现状（15:35，commit 后紧接） | **503 ×5**（~1ms，命中失败缓存） |
| 现状（15:36 复测） | 200 ×10，首次 3.005878s（冷），其余 ~1ms |

→ **抖动没有消除**，只是从“慢 200”变成“快 503 窗口”。直接对 SearXNG 发就绪探针
查询 `?q=readyz&format=json` 在 15:35 前后的 6 次里有 3 次返回 0 结果，与 503 窗口
吻合；15:36 复测 6/6 有结果（0.76–2.76s）。

### 3.3 真实查询（网关 MCP `web_search`，中/英各 2 条，含 `time_range:"day"`）

| 查询 | 基线结果数 / 延迟 | 现状样本1 / 样本2 结果数 / 延迟 | 引擎分布 |
|------|-------------------|--------------------------------|----------|
| 港股 恒生指数 今日 走势（day） | 0 / 2358ms | 0 / 3719ms；14 / 3014ms | yandex |
| A股 上市公司 重大公告 | 15 / 10218ms | 0 / 3016ms；15 / 1510ms | yandex |
| Federal Reserve interest rate decision（day） | 10 / 1182ms | 10 / 3015ms；0 / 3013ms | yandex |
| Tesla quarterly earnings report | 16 / 2982ms | 16 / 2307ms；16 / 3013ms | yandex |

- **延迟**：由 1.2–10.2s 收敛到 1.5–3.7s，最坏情况被 3s 预算封顶 —— 明确改善。
- **引擎分布**：仍然**只有 yandex** 出结果。`quark` 多数时候“暂停服务: 验证码”，
  `bing` 稳定 0 条结果（超时或空）。**引擎多样性没有改善，不得写成“搜索已恢复/多引擎”**。
- **零结果窗口**：3s 预算把 yandex 偶尔的超时截断，8 个查询样本里有 3 个返回 0 结果。
  这是延迟改善的代价，属于**未解决**项。
- **时效标注（新改善，但只在结果级）**：`time_range:"day"` 的查询现在会带
  `time_range_status`——样本2 的“港股 恒生指数 今日 走势”14 条结果为
  `unverified:12 / outside:2`，即“引擎没有真正按日过滤”被如实标注。
  基线同一位置是 `absent`（旧代码没有这个字段）。
- **带 `published_at` 的比例**：基线与现状的 MCP 顶层结果 `published_at` 均为 **0**。
  URL 日期补强只体现在 `published_on`：基线样本 0/1/0/2 条，现状样本 2/2/2 条 ——
  略有改善但量级很小，且**没有一条结果给出真正的 `published_at`**，该口径未验证。
- **响应级诊断未透出**：`search.mjs` 会返回 `filtered_out / filtered_reasons /
  time_range_applied / time_range_enforced / time_range_note`，但 `server.mjs` 的
  `web_search` 只白名单转发 `number_of_results / results / unresponsive_engines /
  stages_ms`，所以这些字段**没有到达 MCP 调用方**（实测 `mcp_top_level_keys` 恒为这
  6 个键）。这属于“装置在、未接线”，列为未生效项。

### 3.4 读取对比（`web_read`，render:auto）

| URL | 基线 | 现状 |
|-----|------|------|
| example.com | crawl4ai 200，1009ms | crawl4ai 200，1552ms |
| cnstock.com | lightweight 200 | lightweight 200 |
| xueqiu.com | lightweight 200 | lightweight 200 |
| reuters.com | 401，无回退 | 回退 crawl4ai → DataDome 拦截 → 502 `render_fallback_failed`（**机制生效，结果仍失败**） |
| ft.com | 403，返回结构化错误载荷 | 回退 crawl4ai → **MCP 协议错误 -32602**（见 §4 D1） |

## 4. 未改善 / 未验证 / 新发现的问题

### D1（新缺陷，代码级确定）：`web_read` 兜底路径会把结构化结果变成协议错误
`renderedMetadata()`（本轮新增）在渲染器没给出整数 `status_code` 时返回
`http_status: null`，而 `readOutputSchema` 里是 `z.number().optional()`（不允许 null），
于是 MCP 直接抛 `-32602 Output validation error: ... expected number, received null at http_status`，
调用方拿不到 `blocked_reason` 等证据。基线走的是 `fetchedMetadata()`，状态码恒为整数，
不会触发。复现：`web_read https://www.ft.com/`（render:auto）、`https://www.google.com/?hl=ja`、
`rfi.fr`。**下一步**：单开修复卡（`http_status` 允许 null，或渲染器无状态码时省略该字段），
并补一条“渲染器结果无 status_code”的回归用例（现有 `read-fallback.test.mjs` 的 fixture
全都带 `status_code: 200/401`，正好漏掉这条路径）。

### D2（未确定根因，需隔离验证）：render:auto 的读取成功率在受控对比下大幅下降
同一时刻、同一批 20 条候选 URL、同一网关，只改渲染参数：

| 参数 | 成功 | 说明 |
|------|------|------|
| `render: never`（纯轻量） | **17 / 20** | 13 条正常返回正文 |
| `render: auto`（含兜底） | **3 / 20** | 14 条翻成失败 |

14 条翻车的失败形态全是渲染腿：`render_backend_status`（Crawl4AI 返回 502，
日志见 `Failed on navigating ACS-GOTO` / `Proxy direct failed`）、`egress_proxy_status`
（本地出口代理合成 429：`EGRESS_MAX_HOST_CONCURRENCY=8`，`Retry-After: 5`），
以及 2 条是 D1 的 -32602。

需要说清的边界：**“轻量正文 <700 字 → 继续走渲染”这条规则在旧代码里也存在**，
所以这不是可以简单归因于本轮的改动；但本轮新增的“401/403/406/429 也回退渲染”会让
Chromium 会话明显变多，而出口代理按 host 限并发 8，渲染会话长期占满后连轻量读取
也会被 429 挡住 —— 这条因果链**尚未隔离证明**，列为未确定项。**下一步**：单开排查卡，
用旧 release（`runtime-v1p9_r97` 的候选目录仍在）在同一批 URL 上做 A/B，并统计出口代理
的 host 槽位占用/释放。

> **2026-10-08 追加**：该隔离验证已完成，D1 修复已部署生产。结论、出口代理槽位实测与
> 部署后验收结果见 **§6**（本节保留当时判断，不回改）。

### D3（未改善）：就绪抖动与新的连通性用例
`/readyz` 的 HTTP 状态码只由 `ok = core_ok && public_connectivity_ok` 决定
（`gateway/server.mjs:872-875`），**公网侧不 ok 就是 503**，card5 的三态策略改的是
*评测判级*（`eval-core.mjs` 的 `classifyReadiness`），不是 `/readyz` 的状态码。
实测：15:25 激活后 5×200；15:35 commit 后紧接 **5×503**；15:36 复测 10×200。
同一时刻的 post-commit smoke 也失败在新增用例 `gateway-public`
（`public-connectivity-ready` 断言不通过）。窗口与 SearXNG 就绪查询
`/search?q=readyz&format=json` 返回 0 结果的窗口吻合（那一轮 6 次里 3 次 0 结果，
其它窗口 6/6、8/8 正常）；闸门逻辑见 `gateway/readiness.mjs:116`——只有在“零结果且
拿不到任何可用引擎证据”时才算 `search_empty`。**下一步**：3s 预算把 yandex 截断后
引擎池里没有第二个能出结果的引擎，这一环要单独处理（提高 yandex 预算、或让就绪探针
在零结果窗口区分“引擎不可达”与“查询恰好无结果”、或把 `gateway-public` 移出 smoke 的
100% 分母）。

### 未验证
- 引擎多样性、`published_at` 覆盖：只在两轮真实查询上取样，未见改善，未做长时统计。
- `bing` 在 SearXNG 内稳定 0 结果的原因未定位（本轮不改）。
- 出口链路诊断卡给出的代理节点/sing-box 改法未执行（影响面超出 WAG，按约束不改）。
- D2 的根因、D1 修复后的复验，都要在后续卡片里做。

## 5. 结论

- 合并：6 个 PR 已按证据复核并合并；冲突真实解决（文本无冲突，语义共存）。
- 部署：生产已用仓库自带事务路径发布并 commit，版本号
  `runtime-7x0vxago`（`fe50854`），旧版本 `runtime-v1p9_r97` 及事务快照保留可回滚。
- 真改善：release 门禁由失败转通过、并发退化 250% → -13.3%、查询延迟封顶 3.7s、
  读取路径新增可观测的回退证据字段。
- 未改善 / 新问题：引擎仍只有 yandex；`published_at` 覆盖没有提高；`/readyz` 抖动
  仍在且新增了会让 smoke 抖动的连通性用例；`web_read` 兜底路径有协议级缺陷 D1 和
  未定因的成功率下降 D2。

## 6. issue #51 复核：D1 修复与 D2 隔离验证（2026-10-08 追加）

本节复核上文 §4 的 D1、D2。全部数字来自生产机 `yosef-server` 实测；原始输出归档在
`/data/web-access-gateway/reports/round-20261008-d1d2/`，驱动脚本在 `/tmp/wag-ab/`。

### 6.1 D1：渲染器无 `status_code` 触发 MCP -32602 —— 已修复、已部署、已复验

| 项 | 值 |
|----|----|
| 修复 | PR #53，head `b3d26d5`，合并 `2c3cf98`（`main`） |
| 做法 | `renderedMetadata()` 无整数 `status_code` 时**省略** `http_status` 键（不再写 `null`）；`readOutputSchema` 与 `errorResult()` 不动 |
| 回归用例 | `gateway/read-fallback.test.mjs` 新增「渲染器结果无 `status_code`」 |
| 测试 | 新用例修复前失败（`MCP error -32602 ... expected number, received null at http_status` 原样冒泡成客户端协议错误）、修复后通过；`node --test --test-concurrency=1 gateway/*.test.mjs` = **301 pass / 0 fail**（基线 `main@19ba670` = 300 pass）；PR CI success（run 37804675324，5m16s）|
| 部署 | 仓库自带路径 `scripts/deploy.sh prepare/activate/commit` → release **`runtime-assl85oe`**（源 `2c3cf98`）；`.release-current` 已指向；三段返回 `prepared` / `activated(public_readiness=passed)` / `committed(public_readiness=passed)`，`restore_errors` 与 `overlay_restore_errors` 均为空 |
| 部署前 | `runtime-7x0vxago`（`fe50854`）|

生产复验（`/tmp/wag-probe/verify-d1.mjs`，`web_read` `render:auto`，release 自带 Node v22.23.2）：

| URL | 结果 |
|-----|------|
| `https://www.ft.com/` | 不再 -32602：结构化载荷，`renderer=crawl4ai`、`render_fallback={reason:"upstream_forbidden",http_status:403}`、**`http_status` 键不存在**、`blocked_reason=null`、markdown 40013 字、4292ms |
| `https://www.rfi.fr/cn/` | 结构化载荷，`renderer=crawl4ai`、`render_fallback={reason:"upstream_http_status",http_status:429}`、35k+ 字、1241ms |
| 对照（修复前同一命令） | `MCP error -32602: Output validation error: ... expected number, received null at http_status` |

`http_status` 键缺失是修复后的预期形态：既没有上游整数状态码可报，也不再写 `null` 触发输出校验。

### 6.2 D2：render:auto 成功率下降 —— 隔离验证与出口代理槽位实测

**方法**

| 项 | 值 |
|----|----|
| URL 集合 | `/tmp/wag-ab/candidates.json`（= `round-20261008/wag-round-after/candidates.json` 副本，20 条，与原报告同批）|
| 新 release | 生产 `runtime-7x0vxago`（`fe50854`），`http://yosef-server:8930/mcp` |
| 旧 release | `runtime-v1p9_r97/candidate/runtime/gateway` 起第二个实例 `127.0.0.1:8935`（同一 crawl4ai / egress / searxng；独立端口与 artifact 目录；`GATEWAY_ALLOWED_HOSTS` 增加 `127.0.0.1`）|
| 观测 | 每 1s `ss -Htn state established '( dport = :7895 )'` 采样（= 存活 CONNECT 隧道数）；轮次 1 另用 `tcpdump` 抓出口代理控制面（CONNECT / 200 / 429）|
| 轮次 1 | 8 条腿连续跑（never/auto 交替），复刻原报告跑法，不加间隔 |
| 轮次 2 | 每条腿起跑前等出口代理排空到 ≤3 隧道，单腿独立采样 |

**轮次 1（连续跑，隧道峰值来自 1s 采样）**

| 腿 | 成功 | 轻量成功 | crawl4ai 成功 | 渲染尝试 | 失败形态 | 隧道峰值 |
|----|------|---------|--------------|---------|---------|---------|
| old-never-1 | 18/20 | 18 | 0 | 0 | egress_timeout 1、upstream_http_status 1 | 2 |
| new-never-1 | 17/20 | 17 | 0 | 0 | upstream_http_status 2、egress_timeout 1 | 3 |
| old-auto-1 | 13/20 | 9 | 4 | 5 | render_backend_status 1、egress_proxy_status 6 | 32 |
| new-auto-1 | 3/20 | 2 | 1 | 18 | render_backend_status 13、mcp_-32602 4 | 33 |
| new-auto-2 | 0/20 | 0 | 0 | 20 | render_backend_status 15、mcp_-32602 5 | 33 |
| old-auto-2 | 0/20 | 0 | 0 | 0 | egress_proxy_status 20 | 32 |
| new-never-2 | 0/20 | 0 | 0 | 0 | egress_proxy_status 20 | 32 |
| old-never-2 | 0/20 | 0 | 0 | 0 | egress_proxy_status 20 | 32 |

**轮次 2（每条腿从空代理起跑）**

| 腿 | 起始隧道 | 成功 | 轻量 | crawl4ai | 渲染尝试 | 失败形态 | 峰值 / 均值 |
|----|---------|------|------|---------|---------|---------|------------|
| old-auto-r2 | 1 | 15/20 | 9 | 6 | 6 | egress_timeout 1、upstream_http_status 1、egress_proxy_status 3 | 32 / 24.3 |
| new-auto-r2 | 3 | 13/20 | 9 | 4 | 11 | render_backend_status 6、mcp_-32602 1 | 32 / 24.6 |
| new-auto-r3 | 2 | 14/20 | 9 | 5 | 11 | render_backend_status 5、mcp_-32602 1 | 32 / 21.7 |
| old-auto-r3 | 1 | 16/20 | 10 | 6 | 6 | upstream_http_status 1、egress_proxy_status 3 | 32 / 20.0 |

**出口代理槽位实测**

- 生产实际参数：`EGRESS_MAX_HOST_CONCURRENCY=32`（unit 文件），`EGRESS_MAX_CONNECTIONS`
  未设置 → 代码默认 **32**。**修正 §4 D2 正文（与 issue #51）里“`EGRESS_MAX_HOST_CONCURRENCY=8`”的说法：
  8 是代码默认值，不是生产值。**
- 占用：任一条 auto 腿都能把隧道数顶到 **32–33**（两个上限同时打满）。轮次 1 的 never 腿峰值
  只有 2–3；轮次 2 四条 auto 腿峰值全是 32、均值 20.0–24.6。极端观测两次：
  3 条 URL 的渲染探针（`example.com`+`tver.jp` 走 crawl4ai）把隧道从 ~1 推到 **28**；
  一次证据门禁运行里 **2 秒内从 6 推到 34**（16:50:28→16:50:38）。即**一两个并发渲染就足以吃光整个出口代理预算**。
- 释放：**很慢**。轮次 1 最后一次渲染 16:03:49，隧道数 33 → 32 → 31 → 25 → 24 → 17（16:06:47）
  → 5（16:07:08）→ 1（16:07:49）：**约 4 分钟**才排空，窗口内所有新 CONNECT 都被代理合成 429。
- 归属：饱和时 24 条隧道里 **23 条由 `chrome-headless`**（Crawl4AI 的 Chromium）持有，代理侧对应
  24 条到 `127.0.0.1:7890` 的上游连接。
- 429 命中率：轮次 1 控制面抓包 **320 次 CONNECT，其中 191 次被回 429（60%）**。

**失败形态与因果**

- 代理打满后两条腿一起完蛋：轻量腿收到代理合成的 429（`egress_proxy_status`）；渲染腿里
  Chromium 的 CONNECT 被拒，Playwright 报 `net::ERR_TUNNEL_CONNECTION_FAILED`，Crawl4AI 包成
  502（`render_backend_status`，实测 40–235ms 快速失败）。所以轮次 1 里旧 release 的失败写成
  `egress_proxy_status`、新 release 的失败写成 `render_backend_status`，**是同一个 429 的两种外衣**。
- 3/20 与 17/20 不是稳定特征：`new-auto-1` 之后，后续四条腿（含**两条 `render:never`**、且含旧
  release 实例）全部 0/20，20/20 失败都是 `egress_proxy_status` —— 一旦打满，连同一台机器上
  另一个网关实例的纯轻量读取也被挡住约 4 分钟。
- 轮次 2 把每条腿放在空代理上跑：旧 = **15/20、16/20**，新 = **13/20、14/20**；渲染尝试
  旧 每条腿 **6 次**、新 **11 次**（≈2×，差集正是本轮新增的 401/403/406/429 回退）。

**结论**

1. “出口代理打满 → 所有读取被 429”这条链路**在旧 release 上同样成立**（旧版单腿也把隧道顶到 32、
   也拿 3–6 次 429、饱和后也 0/20）。D2 的机制**不是本轮引入**。
2. 本轮新增的 401/403/406/429 → 渲染回退把每条 auto 腿的渲染量从 6 提到 11（≈2×），让饱和更
   容易被触发、更难恢复。原报告 17/20 vs 3/20 的对比里只有一小部分（空代理下 15–16 vs 13–14）
   可归因到本轮改动，其余是共享出口/渲染环境的饱和效应与跑腿顺序。
3. D1 缺陷本身在 auto 腿里贡献 1–5 条失败（`mcp_-32602`）；修复后这些变成结构化成功（见 6.1）。
4. 修复建议（**本卡不做**，属读取回退策略，应单独开卡）：
   - **不要把“本地出口代理 429”（`egress_proxy_status`）当作可回退的 bot-challenge 去渲染**：
     那是 WAG 自己的限流，再走同一条代理的 Chromium 只会自伤；应直接回报 429（或按
     `Retry-After: 5` 退避）。
   - 渲染并发与出口预算解耦：`renderSlots=2` 却能让单个页面开 ~14 条 CONNECT，一两个渲染就吃掉
     32 条预算；考虑渲染后短暂冷却、或按出口预算限制在飞渲染。
   - 出口限流参数（`EGRESS_MAX_CONNECTIONS` / `EGRESS_MAX_HOST_CONCURRENCY`）属 WAG 自己的 unit，
     改它不改动非 WAG 服务**配置**；但出口最终经共享 `127.0.0.1:7890`（sing-box），抬高上限等于把
     压力转给共享出口，属影响面超出 WAG 的改动 —— 因此**本卡不改参数**，交用户决策。

### 6.3 部署后验收三件套（生产机原生命令）

| 验收 | 命令 | 结果 |
|------|------|------|
| smoke | `bash /data/web-access-gateway/scripts/eval-smoke.sh` | **通过**：报告 `smoke-20261008T163936Z`（12/12 用例、success/quality 100%、门禁全绿）|
| release | `bash /data/web-access-gateway/scripts/eval-release.sh` | **通过**：报告 `release-20261008T163954Z`（14/14 用例、`concurrency_degradation_pct=0`（门禁 ≤50）、timeout 0%、门禁全绿）|
| evidence | `node /data/web-access-gateway/runtime/gateway/evidence-live-smoke.mjs` | **失败**：`only N evidence reads succeeded`。3 次尝试 2/10、6/10、5/10；对照实验用**旧 release 实例**跑同一门禁同样失败（7/10）。原因即 6.2：门禁自身连续 auto 读取在 2 秒内把出口代理推到 34 条隧道，随后每个 CONNECT 被 429；同一窗口 gateway 审计里 44/55 次读取是 `render_backend_status`，失败耗时 40–235ms。**与 D1 修复无关**（D1 只省略一个字段，不改变任何网络行为）。|

### 6.4 归档

- 结果与观测：`/data/web-access-gateway/reports/round-20261008-d1d2/`
  （`old-auto-*.json` / `new-auto-*.json` / `*-never-*.json` / `legs*.timeline` / `ss-samples.log` /
  `proxy-http.log` / `d1-verify.json` / `gates-*.out` / `evidence*.out` / `smoke-20261008T163936Z.json` /
  `release-20261008T163954Z.json` / `analyze.mjs` / `verify-d1.mjs`）
- 驱动脚本（生产机 `/tmp/wag-ab/`）：`ab-run.sh`（轮次 1）、`ab2-run.sh`（轮次 2，含排空等待）、
  `fix-leg.sh`、`run-gates.sh`、`rerun-evidence*.sh`、`start-old.sh`（旧 release 第二实例）

## 附：原始输出留档

生产机关 `yosef-server` 上的原始文件（本轮全部实测输出），持久目录：

- 打包：`/data/web-access-gateway/reports/round-20261008.tgz`（39 个文件）
- 目录：`/data/web-access-gateway/reports/round-20261008/`
  - 基线：`wag-round-baseline/{smoke-before.log,release-before.log,evidence-before.json,search-before.json,read-before.json,readyz-before.txt}`
  - 现状：`wag-round-after/{smoke-after.log,smoke-rerun-1.log,smoke-rerun-2.log,release-after.log,evidence-after2.json,evidence-diag.err,search-after.json,search-after2.json,read-after.json,read-auto.json,read-never.json,read-always-after.json,readyz-after.txt,candidates.json}`
  - 评测报告：`{smoke-20261008T151355Z,smoke-20261008T152538Z,smoke-20261008T153514Z,release-20261008T151414Z,release-20261008T153411Z}.json`
- 事务 journal：`/data/web-access-gateway/releases/runtime-7x0vxago/{state.json,provenance.json,searxng/state.json}`
- 探针脚本：`/tmp/wag-probe/{search-probe.mjs,read-probe2.mjs,read-list.mjs,candidates.mjs,evidence-diag.mjs}`

关键命令行：

```bash
# 基线/现状 验收
bash /data/web-access-gateway/scripts/eval-smoke.sh
bash /data/web-access-gateway/scripts/eval-release.sh
node /data/web-access-gateway/runtime/gateway/evidence-live-smoke.mjs   # 需先 source secrets/gateway.env
# 就绪
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' -H "Authorization: Bearer $GATEWAY_TOKEN" http://yosef-server:8930/readyz
# 真实查询 / 读取（MCP 客户端脚本）
node /tmp/wag-probe/search-probe.mjs
node /tmp/wag-probe/read-probe2.mjs https://www.ft.com/
node /tmp/wag-probe/read-list.mjs /tmp/wag-round-after/candidates.json never
node /tmp/wag-probe/read-list.mjs /tmp/wag-round-after/candidates.json auto
```
