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
