# WAG/SearXNG 引擎集合与超时口径复核（2026-10-08）

本文是 SearXNG overlay（`config/searxng/settings-overlay.yml`）这一轮改动的依据与验收记录。
上游只读诊断报告是 `docs/wag-egress-diagnosis-20261008.md`；本文是它的下游执行记录，
两者结论不一致的地方，本文以**在生产实例上实测**的结果为准，并写明差异。

## 0. 一句话结论

搜索慢和搜索空的**两个真实来源**都在 SearXNG 自己这一层，都能在仓库内改掉：

1. **每次查询都按 8 秒预算跑**。`outgoing.request_timeout` 与 `max_request_timeout` 都是 `8.0`，
   而 SearXNG 的规则是「一次查询共用一份预算 = 选中引擎里最大的那个 timeout，再被
   `max_request_timeout` 压顶」，所以只要池子里有一个 8 秒的引擎，整条查询就得等 8 秒。
2. **池子里能出结果的引擎只剩 yandex 一个**（另加 chinaso news 只服务 news 类目）。
   google / brave / mojeek / duckduckgo / qwant 每一次查询都在失败，其中 duckduckgo 与 qwant
   的失败被标记为「挂起 0 秒」，等于**每次查询都重试一遍**。

改完之后：一次查询的硬上限从 8.0s 降到 3.0s，正常查询中位数落在 0.94~1.39s，
可用引擎从 1 个变成 3 个（yandex、quark、bing），中文类目继续由 yandex + quark + chinaso news 覆盖。

**没有做部署**：本卡只交付到 PR，overlay 的应用与重启由集成卡统一执行。

## 1. 改动清单（before → after）

### 1.1 超时数值

| 位置 | before | after | 为什么 |
|---|---|---|---|
| `outgoing.request_timeout` | `8.0` | `3.0` | 这是「未单独设置 timeout 的引擎」拿到的值，直接决定整条查询的预算 |
| `outgoing.max_request_timeout` | `8.0` | `3.0` | 真正压顶的那一道：`actual_timeout = min(最大引擎 timeout, max_request_timeout)`，设成 3.0 之后，即使某个引擎自带 20 秒 timeout（如 `360search`）或调用方传了 `?timeout_limit=`，单次查询也翻不过 3 秒 |
| `outgoing.pool_connections` / `pool_maxsize` / `retries` / `retry_on_http_error` | `100 / 20 / 1 / false` | 不变 | 没有证据支持改动，保持原样 |
| 引擎级 `timeout` | 操作员手工给部分引擎写了 `3.0`，本轮新增的四个引擎没有 | 四个审查过的引擎都显式写 `3.0` | 让「引擎级 timeout ≤ 共用预算」变成 overlay 里可见、可校验的约束 |

### 1.2 引擎清单

在跑的（general / news 类目）**before**：

| 引擎 | 实测（本机当前出口、只读） | 结果 |
|---|---|---|
| google | `HTTP error 403 (suspended_time=180)`，每次查询都失败 | 拖时间、无结果 |
| brave | `Too many request (suspended_time=180)` | 拖时间、无结果 |
| mojeek | `HTTP error 403 (suspended_time=180)` | 拖时间、无结果 |
| duckduckgo | `CAPTCHA (suspended_time=0)` | **每次查询都重试**，仍无结果 |
| qwant | `CAPTCHA (suspended_time=0)` | **每次查询都重试**，仍无结果 |
| bing | 0 条结果、无报错、0.08~0.72s（15 次含 bing 的探测全为 0 条） | 不拖时间，但也没结果（原因未定位） |
| yandex | 10~15 条结果、0.86~1.81s | 唯一稳定可用 |
| chinaso news | 10 条结果、10 条带日期、0.32~0.97s（news 类目） | 可用 |

**after**：

| 引擎 | 状态 | 依据 |
|---|---|---|
| yandex | 启用（general, news, timeout 3.0） | 唯一稳定出结果：15 条 / 0.86~1.81s |
| quark | **启用**（general, news, timeout 3.0） | 实测 7~11 条真实结果、带日期，3.0s 预算下 6/6 成功（0.89~2.33s）。它会被限流成验证码，但那种失败只要约 0.1s 并让引擎被挂起，不会拖满预算 |
| bing | 保持启用（general, news, timeout 3.0） | 上游卡明确要求不要禁；它在 15 次含 bing 的探测里都 0 条结果且无任何报错、耗时 0.08~0.72s，既不占预算也不污染结果，先留着（原因见第 4 节） |
| chinaso news | 保持启用（news, timeout 3.0） | 中文结果且带真实发布日期；它还是池子里**唯一一个既能用又支持 `time_range` 的引擎** |
| google / google news | 禁用 | 请求的是已被 Google 下线的 `/wml/search` 端点，403 与出口 IP 无关。**注意：上游诊断建议「把 google 换成 google news」，实测不成立 —— 本版本的 google news 走的是同一个 `/wml/search&tbm=nws`，同样 403**，所以这里把两个都禁用 |
| brave / mojeek / duckduckgo / qwant | 禁用 | 分别 429 / 服务端硬 403 / 验证码(suspended_time=0) / 验证码(suspended_time=0)。qwant 唯一能出结果的配置是某一个新加坡节点，那属于 sing-box 层，不在本仓库范围 |
| baidu / sogou / 360search / startpage | 保持禁用（本轮显式写进 overlay） | 页面本身可达，但 SearXNG 的解析拿到的是验证码（baidu/sogou/startpage，suspended_time=3600）或直接跑满预算（360search）。**上游诊断把 baidu/sogou 列为「当前出口就能恢复」的候选，实测在 SearXNG 里不成立**，所以没有打开它们；中文能力因此不下降（它们原本也是禁用的） |
| crowdview / mwmbl / naver / privacywall | 保持禁用 | 上一轮已禁用，本轮无人验证可用，不动 |

> 说明：overlay 的合并是「按名字更新/追加」，**不会删除**。所以要让一个引擎停下，
> 必须在 overlay 里显式写 `disabled: true` —— 只把它从文件里删掉，线上那个 `disabled: false`
> 会原样留下。这也是本轮把要停的引擎逐条写出来的原因。

## 2. 超时这三个数字之间的关系（下游请按这个对齐）

SearXNG 这一层（本次只负责这一层）：

```
一次查询的预算 actual_timeout
    = min( max(被选中引擎的 engine.timeout),  outgoing.max_request_timeout )
每个引擎线程 join(剩余时间)，引擎的 HTTP 请求共用这条 deadline
```

源码位置（本机 release `20260827_143211`）：
`searx/search/__init__.py:110` 取引擎最大 timeout、`:112-127` 求 `actual_timeout`、
`:140-157` 各引擎线程按剩余时间 join；`searx/search/processors/online.py:249` 把这条预算
交给每个引擎的 HTTP 客户端。

**容易搞错的一点**：引擎自己的 `timeout:` 不是「这个引擎的上限」，它只是把**共用预算抬高**。
所以真正能压住整条查询的是 `max_request_timeout`，本轮把它和 `request_timeout` 一起钉在 3.0。

本层的期望值（供网关卡对齐）：

| 层 | 数值 | 说明 |
|---|---|---|
| SearXNG 单次调用 | **≤ 3.0s**（硬上限，本轮改完） | 改之前是 ≤ 8.0s |
| WAG 网关 `/readyz` 依赖探测 | 默认 10000ms（`GATEWAY_PROBE_TIMEOUT_MS`，未改） | 一次搜索调用 ≤3.0s，占探测预算 30% |
| WAG `web_search` 单请求 | 最多两次串行调用（先带 `time_range`，空结果再去掉重试） | 最坏 2×3.0 = **6.0s**，改之前最坏 2×8.0 = 16.0s |
| `scripts/healthcheck.sh` 内层命令 | `timeout ... 8s`（未改，属别的卡） | 单次搜索 ≤3.0s，留有余量 |

## 3. 怎么测出来的（都是只读命令）

全部探针都只发 `GET/POST http://192.168.50.2:8801/search?format=json`，没有改任何配置、
没有重启任何服务、没有切代理 selector。`timeout_limit` 用 POST 表单传，因为它只从表单读，
而且 `actual_timeout = min(timeout_limit, max_request_timeout)`，所以它能**精确模拟改完之后
的 3.0s 预算**，不用动生产配置。

关键实测（每格是真实输出，节选）：

```
# 现状：默认类目（全部引擎）
(default all) lat=[8.01, 0.91, 8.01]  n=[0, 0, 0]
   unresponsive: brave 请求过于频繁 / duckduckgo 验证码 / google 拒绝访问 / mojeek 拒绝访问 / qwant 验证码 / yandex 超时

# 预算 3.0s，池子 = yandex + chinaso news + quark
yandex+chinaso+quark budget=3.0  {"dt": 1.392, "n": 25, "eng": {"yandex": 15, "chinaso news": 10}, "dates": 10}
yandex+chinaso+quark budget=3.0  {"dt": 1.904, "n": 25, ...}
yandex+chinaso+quark budget=3.0  {"dt": 0.965, "n": 25, ...}
yandex+chinaso+quark budget=3.0  {"dt": 3.011, "n": 10, "eng": {"chinaso news": 10}, "unresp": ["yandex:超时", ...]}
   -> 3/3 有结果；yandex 偶尔超时，chinaso news 照样把带日期的结果交出来

# 预算 2.0s 太紧（这就是不做「一刀切 1~2 秒」的证据）
yandex budget=2.0   -> ok=1/3（两次被 2.011s 掐断）
yandex+bing+quark budget=2.0 -> ok=1/3
yandex budget=3.0   -> ok=1/3（3.011s 掐断一次）
yandex+chinaso+quark budget=3.0 -> ok=3/3（同一个引擎，池子够厚就不会空手而归）

# quark 实测
quark  {"dt": 1.534, "n": 11, "dates": 2, "first_title": "【上海天气】上海40天天气预报..."}
quark  {"dt": 0.942, "n": 7,  "dates": 6}          # 英文查询
quark budget=3.0 -> 3/3 成功（1.08~2.33s）

# bing 实测（不是超时问题）
bing+google(预算8.0) -> 6/6 n=0，0.083~0.721s，无报错、无挂起记录
手工复现同一个 URL 取回 200 / 101880 字节，含约 10 个 b_algo 结果块、无验证码
   -> 出口没问题、请求本身没问题，问题在 SearXNG 侧（见第 4 节）
```

## 4. 顺带发现（不在本卡范围，交给集成卡决策）

1. **`time_range` 查询在 general 类目下必然 0 条结果。**
   SearXNG 会把 `time_range_support=False` 的引擎**静默跳过**（`searx/search/processors/abstract.py:264`），
   而 general 类目里支持 `time_range` 的只有 google / brave / mojeek / duckduckgo / startpage —— 全是坏的。
   于是 WAG 的「先带 `time_range` 查一次，空结果再去掉重试一次」必然触发，**每次都要 8s+8s**。
   实测：`default categories + time_range=day` → n=0；`news + time_range=day` → 10 条带日期结果。
   现成的两条修法（都还没做，因为会改变默认搜索的结果构成，属于产品决策）：
   - 把 `chinaso news` 的类目扩成 `[news, general]`（实测它带 `time_range` 可用：10/10 带日期）；
   - 或让网关在 `time_range` 查询里跳过那注定为空的一次调用。
   本轮只把上限从 8s 压到 3s，让最坏情况从 16s 变成 6s。
2. **bing 在 SearXNG 里 0 结果的原因没定位。** 手工复现同一 URL 能拿到含结果块的页面、
   无验证码，说明不是出口、不是封锁；引擎进程已成功注册（启动日志里 bing 没有 init 失败）。
   属于 SearXNG 引擎自身的缺陷类别（和 google 的 `/wml/search` 同类），修它需要动引擎代码或升级，超出本卡范围。
3. **每个 uwsgi worker 各自记挂起状态。** 线上有多个 worker，同一个引擎在不同 worker 里的挂起状态不同，
   所以「某引擎刚才失败、现在又好了」的现象有一部分只是打到了另一个 worker。排查时要注意。
4. **`searxng-healthcheck` 每 5 分钟误重启的问题** 已由另一张卡（t_2d474cb3）修掉；本次整轮探测期间
   SearXNG 的 `ActiveEnterTimestamp` 一直是 `13:17:55 UTC`，没有再被重启。

## 5. overlay 幂等性怎么验的

`scripts/searxng-overlay.test.py`（新增，CI 的 `for test in scripts/*.test.py` 会自动跑到）：

- 合并层：`merge(base, overlay)` 连做两次结果完全相同；把 overlay 再合并到「已合并结果」上是不动点；
  同一输入两次序列化的 YAML 字节一致。
- 字段层：改完之后 `outgoing.request_timeout == max_request_timeout == 3.0`、
  四个审查引擎 `disabled: false` 且 `timeout: 3.0`、其余审查引擎 `disabled: true`；
  故意把某个声明过的字段改脏，provenance 摘要必须跟着变（含本轮新纳入校验的引擎 `timeout`）。
- 安全层：投影（写进 `state.json`/`provenance.json` 的那份）里不能出现 `secret_key`、
  引擎 `api_key`、代理 URL 里的用户名密码。
- 端到端：用桩替换 `systemctl`/`ss`/`curl`，把**真实的** `scripts/searxng-apply-overlay.sh`
  在一个临时目录里的 settings.yml 上连跑两次，两次产出的文件字节完全一致，
  且断言了桩确实生效（`shutil.which` 指向桩目录）才继续，绝不会碰到真服务。

## 6. 测试与真实输出

在 Linux（yosef-server，Python 3.12.3 / PyYAML 6.0.1）上、用仓库工作树的副本执行：

```
$ python3 scripts/searxng-overlay.test.py
............
Ran 12 tests in 0.393s
OK

$ python3 scripts/deploy.test.py
Ran 41 tests in 41.389s
FAILED (failures=2)
```

对 `deploy.test.py` 这 2 个失败做了**改动前/改动后对照**（同一个临时副本、同样的环境）：

```
$ diff /tmp/base-failures.txt /tmp/mine2-failures.txt && echo IDENTICAL
IDENTICAL FAILURE SETS
```

两个失败在**改动之前也一样失败**，原因是副本里没有 `npm --prefix gateway ci` 装出来的
`gateway/node_modules`（服务器上没有 npm，CI 会装）。它们与本改动无关。

`bootstrap.test.py` 11/11、`release.test.py` OK(跳过 1)。

**没有在本机验证的**：`gateway/*.test.mjs`、`proxy/*.test.mjs`（需要 npm 依赖，服务器没有 npm）。
本轮 diff 里没有任何 `.mjs` / `.js` 文件，这些用例的输入没被触碰，交给 CI 跑。

### 改动过的既有测试（说明理由）

`scripts/deploy.test.py` 里有 3 处断言**写死了旧的引擎决定**，本轮的引擎决定变了，它们必然失败：

- `test_coordinated_commit_preserves_backend_proxies_and_restores_exact_settings` 断言
  `assertFalse(engines["google"]["disabled"])`（即「overlay 会把 google 打开」）。
  现在把断言改成：google 被审查为关闭、但操作员的 `engine` 后端与 `api_key` 原样保留，
  同时新增 review 过的 `quark` 已启用且 `timeout: 3.0`、`outgoing.request_timeout == 3.0`。
- 两处 drift 用例写的是 `value["engines"][0]["disabled"] = True`（假定第一个引擎是「开着」的，
  把它关掉制造漂移）。现在改成**取反**当前值，无论 overlay 把它钉成开还是关，都一定构成漂移。

改动只涉及断言与漂移构造方式，测试意图不变；`scripts/deploy.sh` 没有改。

## 7. 对生产的改动

**没有。** 本轮只做了：

- 只读查询线上 SearXNG（`GET/POST /search`，含用 `timeout_limit` 模拟 3s 预算）；
- `ssh` 只读查看配置/源码/日志（引用 `secret_key` 时只提字段名，没有打印内容）；
- 在 `/tmp` 下用桩命令跑测试（`systemctl` 全程被桩挡住，探针日志确认 `searxng` 的
  `ActiveEnterTimestamp` 在整轮操作中保持 `13:17:55 UTC` 不变），结束后已清理。

没有改 `settings.yml`、没有改 `/data/net-proxy/**`、没有重启任何服务、没有切任何代理节点。
overlay 的应用与重启留给集成卡。

## 8. 未验证 / 待下游确认

1. **overlay 尚未应用到生产**（本卡交付到 PR 为止）。应用后的真实 p50/p95、以及
   `eval-runner.mjs release` / `evidence-live-smoke.mjs` 的验收，由集成卡执行。
2. **bing 为什么 0 结果** 没有定位（第 4.2 节）。
3. **quark 的限流频率**：实测有「连续成功 6 次后被验证码」和「隔一分钟就验证码」两种情形，
   没有做长时段统计；它失败很快且会被挂起，所以对时延没有影响，但可能会被集成卡观察到「时好时坏」。
4. **`time_range` 的空结果问题没有修**（第 4.1 节），本轮只是把最坏耗时从 16s 压到 6s。
5. 3.0s 这个值本身：如果集成卡实测发现某些正常引擎（尤其 yandex）经常卡在 3.011s，
   可以整体抬到 4.0（`request_timeout` 与 `max_request_timeout` 一起改），
   代价是网关两次调用的最坏耗时从 6.0s 变成 8.0s，逼近 `/readyz` 10s 的探测预算。
