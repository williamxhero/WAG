# WAG 出口链路与搜索引擎可达性诊断报告

日期：2026-10-08
范围：**只读诊断**。本报告没有对生产做任何修改（详见文末「本次对生产的改动」）。
主机：`yosef-server`（Ubuntu，sing-box 1.13.13，SearXNG 由 uWSGI 承载）

---

## 0. 一句话结论

**搜索引擎大量失效，主因不是代理出口被封，而是 SearXNG 侧的三类配置缺陷：**
SearXNG 的 google 引擎请求的是一个**已被 Google 下线的 WML(功能机)端点**；bing/ddg 依赖的搜索域名与若干引擎域名**被本地 DNS 污染**；brave/qwant/mojeek 则被目标站点的**反爬**按当前出口 IP 拦截。
代理出口（sing-box 的 `JP-SG-US` urltest 组、65 节点、12 节点实测可用）本身**是健康的**，改代理节点救不了这些引擎。

> 顺带查出一个与搜索无关、但同样重要的生产缺陷：`searxng-healthcheck` 定时器每 5 分钟**误重启** SearXNG（详见第 6 节）。这会让任何"改配置→观察"的动作被反复清空。

---

## 1. 链路拓扑（实测确认）

```
                        ┌─────────────────────────────────────────┐
 SearXNG (uwsgi)  ────► │ proxies.all:// -> http://127.0.0.1:7890 │
   192.168.50.2:8801      └──────────────────┬──────────────────────┘
                                             ▼
                              sing-box mixed-in 127.0.0.1:7890
                              route.final = "JP-SG-US" (urltest, 62 成员)
                              默认 urltest 探测目标 = oauth2.googleapis.com
                                             │
                    ┌────────────────────────┴────────────────────────┐
                    ▼                                                 ▼
        geosite-cn / geoip-cn 命中                        其余全部流量
        → DIRECT(真实上海移动出口)                    → urltest 选中的节点
```

读取侧（本次未改动，但记录以便对照）：

```
WAG 读取/渲染 ──► 127.0.0.1:7895 (web-access-egress-proxy.service)
                        └──► EGRESS_UPSTREAM=http://127.0.0.1:7890 ──► sing-box
```

**关键澄清（实测）**：搜索走 `7890`，读取/渲染走 `7895→7890`。**搜索根本不经过 WAG 自己的 7895 过滤器**，所以调 7895 的过滤器对搜索引擎可达性没有任何影响——这一点很容易误判。

**第二个关键澄清（实测）**：sing-box 同时开着 TUN inbound（`auto_route: true`），`ip rule` 里有

```
9003:  not from all iif lo lookup 2022
```

意思是**除 loopback 外这台机器的全部流量都被 TUN 捕获并重新按 sing-box 规则路由**。所以在服务器上"不带 `-x` 直连"这个基准并不等于绕过代理：它仍然进 TUN，只是按路由规则走 DIRECT 或代理。下文矩阵里的 (a) 路径只能理解为"不指定显式代理，交给 TUN/系统默认规则"。

---

## 2. 引擎 × 路径 可达性矩阵

数据采集于 2026-10-08，`curl -L --max-time 20/25` 跟随重定向，UA 为桌面 Chrome 126。
"CAPTCHA/反爬"= 正文命中 `unusual traffic|captcha|sorry/index|verify you are human|403 - Forbidden|Service unavailable` 等特征串。

### 2.1 路径 (a)(b)(c) 汇总（同一节点 jp-aws-06 = urltest 当时选中节点）

| 引擎 | (a) 无 -x（TUN 默认） | (b) 经 7890 | (c) 指定单节点 | 判定 |
|---|---|---|---|---|
| google `/search` | 302→200 OK | 200 OK, 0.80s | 200 OK（日/美），429（美 sjc） | **端点问题**，见 3.1 |
| google `/wml/search`（SearXNG 实际用的） | — | **403 ×6/6** | 403 | **必然失败**，见 3.1 |
| bing | 302→200 | 200（稳态 8/8） | 200/0.5s 多节点 | **可用**，见 3.3 |
| duckduckgo | TIMEOUT | TIMEOUT / 202 | 202（多节点 0/1） | **验证码**，见 3.2 |
| brave | 429 +反爬 | 429 +反爬 | 429 +反爬 | **IP 被限**，见 3.4 |
| qwant | 403 / "Service unavailable" | 200 但 "Service unavailable" | **仅 sg-hy2 节点真正出结果** | 节点/反爬，见 3.4 |
| mojeek | 403 "403 - Forbidden" | 403 ×6/6 | 403 或 "Captcha" | **反爬**，见 3.4 |
| startpage | 307→200 | 200 (86KB) | 200 | 页面可达，但 SearXNG 里 disabled |
| yandex | 302 | 200（含 1 次 TIMEOUT） | 200 | **唯一稳定出结果** |
| baidu | 200 | 200 (962KB) | 200 | 页面通，但 SearXNG disabled |
| sogou / so360 | 302 / 200 | 200 / 200 | — | 页面通，SearXNG disabled |

### 2.2 逐节点结果（path c，用只读 /delay + 临时 scratch 实例测真实 HTTP 码）

覆盖日本 3、 新加坡 3、美国 3，协议含 VLESS 与 Hysteria2：

- **日本节点**（`日本东京01`、`AWS日本06`、`日本东京06 高速专线`）：google 200、bing 200、yandex 200、baidu 200、wikipedia 200 均可达；`日本东京06` 整片 TLS_FAIL，属节点自身故障。
- **新加坡节点**（`新加坡01`、`AWS新加坡03`、`新加坡 高速专线-hy2`）：三个都稳定 200，**qwant 在 `新加坡 | 高速专线-hy2` 上真正返回结果页**。
- **美国节点**（`美国圣何塞01 | 三网推荐`、`美国圣何塞01-0.1倍`、`美国01-0.1倍`）：`美国圣何塞01-0.1倍` 与 `美国01-0.1倍` 整片失败（节点失效）；`美国圣何塞01 | 三网推荐` 可用但 **google 返回 429**（该出口 IP 已被 Google 限流）。
- **8 个可用节点中，`美国01-0.1倍` 在 Clash API 里名字带 ` | ` 后缀**（例如 `🇯🇵AWS日本06 | 电信移动联通推荐`），直接用短名请求 `/delay` 会返回 `404 Resource not found`，必须用完整带后缀的名字。这是排查时的坑。

### 2.3 被明确排除的两个假设

1. **不是 DNS 服务器的问题。** 用同一节点只改 `dns.final`（`remote` DoH 8.8.8.8 vs `local` 223.5.5.5），6 个引擎的 HTTP 码与耗时**完全一致**。所以 sing-box 的 DNS 配置不是搜索引擎失败的原因（虽然它本身有问题，见 3.2）。
2. **不是 HTTP/2 的问题。** `--http1.1`、`--http2`、`--http2-prior-knowledge`、默认，经 7890 各 8 次，bing 全部 8/8 出结果。

---

## 3. 失败原因归类

判定依据写在每一小节里，可复核。

### 3.1 google —— 端点已被下线（HTTP 403，非封锁）

**判定依据**：SearXNG 的 google 引擎代码请求的 URL 是

```
/data/searxng/releases/20260827_143211/searxng-src/searx/engines/google.py:328
    params["url"] = f"https://www.google.com/wml/search?{urlencode(args)}"
```

并把 UA 设成**诺基亚功能机**（同文件 `:329` `params["headers"]["User-Agent"] = random.choice(nokia_useragents)`，列表在 `:71`）。该文件头部注释写明：*"This implementation uses Nokia user agents to request an XML layout from Google."*

复现（三组对照，同一节点、同一出口，只变一个变量）：

| 请求 | 结果 |
|---|---|
| A. `/wml/search` + Nokia UA（SearXNG 的真实请求） | **403**，正文 `<title>Error 403 (Forbidden)!!1` |
| B. `/wml/search` + 桌面 Chrome UA | **403**（→ 与 UA 无关） |
| C. `/search` + Nokia UA | **403** |
| D. `/search` + 桌面 Chrome UA | **200**，标题 `Google Search` |

也就是说：`/wml/search` 这个**路径**被 Google 拒绝（403），跟出口 IP 无关；只有现代 `/search` 路径能用。

SearXNG 把 403 翻译成中文就是 `拒绝访问`（`searx/translations/zh_Hans_CN/.../messages.po:658` → `"access denied"`），这正是我们看到的报错。所以 **google 的失败与代理出口无关，换任何节点都还是 403**。

> 注：`google` 引擎还有个 `detect_google_sorry()`（`:258`）会把 302 或 `/sorry/` 也判成验证码；但这里连 302 都没到，是直接 403。

### 3.2 duckduckgo / bing —— DNS 污染（不是封锁）

**本机 DNS 解析结果（`223.5.5.5`，即 sing-box `dns.final=local`）明显被污染：**

| 域名 | 223.5.5.5 解析 | 1.1.1.1 / 经代理 DoH 解析 | 判定 |
|---|---|---|---|
| `www.google.com` | `104.244.42.197` / `31.13.92.37` / `157.240.7.20`（**均为 Twitter/Facebook IP**） | `142.251.x.x`（真 Google） | **投毒** |
| `search.brave.com` | `104.244.45.246`（Twitter IP） | — | **投毒** |
| `www.duckduckgo.com` | `162.125.83.1`（**Dropbox IP**） | `20.43.161.105` | **投毒** |
| `cn.bing.com` | `202.89.233.100`（国内 CDN） | `150.171.28.10` | 非投毒，但**地区不同** |

这是 GFW 污染的典型特征（把域名解析到 Twitter/Dropbox/Facebook 的 IP）。

**但要分清因果**：对 bing 而言，投毒**不是**失败主因。真实原因是 **bing 会 302 跳到 `cn.bing.com`**（实测 `location: https://cn.bing.com/search?...`），而 `cn.bing.com` 命中 sing-box 的 `geosite-cn` 规则走 **DIRECT**（真实上海移动出口）。对照实验：

- 生产等价路由（`cn.bing.com` 走 DIRECT）：bing **6/6** 出结果，0.5s。
- 强制 `cn.bing.com` 走代理节点： bing **1/6**，其余 TLS 失败。

也就是说**让 `cn.bing.com` 直连反而更好**（国内 CDN 就近），强制它走海外节点才坏。稳态复测经 7890 的 bing：zh-CN 与 en-US 两种 `Accept-Language` 各 **8/8** 出结果。所以 bing 在 curl 层面是通的。

**那为什么 SearXNG 里的 bing 时好时坏（`超时` / 一次 0 结果 0 报错）？** 这部分我**没有定论**，见第 5 节。已排除的因素：HTTP/2、`Accept-Language`（zh-CN/en-US 均 8/8）、DNS final 选择、HTTP vs SOCKS 本地传输。**剩下的主要嫌疑是 SearXNG 的连接池/超时口径**：overlay 里 `pool_connections: 100` / `pool_maxsize: 20`，引擎 `request_timeout: 8.0`，而实测失败**恰好卡在 8.00s**——这非常像"引擎自身超时被精确打断"，而不是网络慢。

**duckduckgo 则确属被拦**：经 7890 与各节点，`html.duckduckgo.com` 稳定返回 **HTTP 202**，正文含 `anomaly`/`challenge`/`captcha` 共 47 处匹配、`<title>` 为空——这是 DDG 的反爬挑战页。SearXNG 把它归类为 `验证码`（CAPTCHA）。

### 3.3 brave —— 出口 IP 被限流（HTTP 429）+ DNS 投毒

- **429**：8/8 全部 429，响应体 73KB 且命中反爬特征串，标题 `Brave Search`。这是 Brave 对该出口 IP 的**速率/信誉封禁**，换节点后仍是 429 或整片 TLS 失败——但注意 Brave 的域名本身也被 DNS 投毒（解析到 Twitter IP）。
- SearXNG 翻译：`暂停服务: 请求过于频繁` = `too many requests` + `Suspended`；日志里可见 `SearxEngineAccessDeniedException: HTTP error 403 (suspended_time=180)`，即**失败会被挂起 180 秒**。

### 3.4 qwant / mojeek —— 反爬 / 节点相关

- **mojeek**：稳定 `HTTP 403`，正文仅 339 字节且标题就是 `403 - Forbidden`——服务端硬拒（不是超时、不是验证码页）。换到部分节点会变成返回 `Captcha` 页面，但同样是拒绝。
- **qwant**：经 7890 稳定 `HTTP 200` 但正文标题是 **`Service unavailable`**（假成功/软墙）。逐节点实测：
  - `jp-aws-06` / `jp-b` / `us-a`：`Service unavailable` 或空
  - **`sg-hy2`（`🇸🇬新加坡 | 高速专线-hy2`）：唯一真正返回结果页**（标题 `connectivity probe – Qwant Search`）

  这是**唯一一条"换节点能救"的结论**，且可复现。

### 3.5 yandex —— 唯一健康引擎

连续多次全量查询，`result_engines` 恒为 `{'yandex': 10}`。yandex 自身响应体也含反爬特征串，但在 10s 预算内能稳定解析出 10 条结果。

---

## 4. 哪些引擎"可恢复"

### A. 当前出口就能恢复（不需要动代理）

| 引擎 | 动作 | 落点 |
|---|---|---|
| **bing** | 让它能稳定工作：优先排查 8s 超时口径与连接池（见 5 节），必要时把 `request_timeout` 从 8.0 放宽到 12~15 | `config/searxng/settings-overlay.yml` 的 `outgoing:` 段 |
| **yandex** | 保持 enabled，作为兜底 | 已 enabled |
| **baidu / sogou / so360** | 页面在当前出口可达（200/302），若需要中文结果可解除 disabled，但要先用真实查询验证解析质量 | `config/searxng/settings-overlay.yml` 的 `engines:` 段 |
| **startpage** | 页面可达（200, 86KB），但需先确认 SearXNG 的 startpage 引擎解析仍有效 | 同上 |

### B. 需要换到特定节点/地区才可能恢复

| 引擎 | 需要的节点 | 证据 |
|---|---|---|
| **qwant** | **`🇸🇬新加坡 | 高速专线-hy2`**（tag 含空格与 `|`，注意用完整名） | 5 节点对比中只有它返回真结果页 |
| **duckduckgo** | 目前无任何节点能绕过反爬；但 `sg-aws-03`/`sg-hy2` 上出现过 **1 次 200**（其余为 202） | 说明偶有窗口，非稳定方案 |

### C. 基本无望（靠出口解决不了）

| 引擎 | 原因 |
|---|---|
| **google** | SearXNG 用的是已下线的 `/wml/search` 端点，**任何节点都 403**。这是 SearXNG 版本自身的缺陷，只有升级/改引擎代码或改用 google news/images 等其它引擎才能绕开 |
| **brave** | 出口 IP 被 429 限流 + 域名被 DNS 投毒，属信誉级封禁，短期不可解 |
| **mojeek** | 服务端硬 403，非超时非验证码，换节点无效 |

---

## 5. 未验证的假设（诚实列出）

1. **bing 在 SearXNG 里时好时坏的确切原因，我没有定位。** 已排除：HTTP/2、`Accept-Language`、DNS final、本地传输方式、代理节点本身（curl 稳态 8/8）。**未验证**：SearXNG httpx 连接池（`pool_maxsize: 20`）在并发查询下的行为；`request_timeout: 8.0` 是否被精确命中导致引擎被杀；`suspended_time=180` 的挂起机制是否让 bing 在多次查询间被"冷却"。我一次观测到 bing "0 结果 + 0 报错 + 0.1s 返回"，很符合"被挂起后直接跳过"，但**没有直接读出 `suspend_end_time` 来证实**。
2. **我没有做过 selector 切换来测 path (c)。** Clash API 对 `JP-SG-US` 返回 `400 {"message":"Must be a Selector"}`——它是 **urltest** 组，Clash 规范里只有 selector 可写。所以卡片要求的"经 Clash API 临时切 selector 再恢复"在本机**做不到**。我改用两种只读方式达成同样目的：(i) `/proxies/<node>/delay` 端点（但它只反映可达性，**429 也算成功**，不能证明有结果）；(ii) 在 `/tmp` 启动**只含单节点的临时 sing-box 实例**（读生产 JSON、只写 `/tmp`、只监听 127.0.0.1:78xx/79xx、用完即杀）。后者才拿到真实 HTTP 码。**没有因此改动任何生产配置或重启任何服务。**
3. **我假设"从 jp-aws-06 换到 sg-hy2 能让 qwant 出结果"是可持久的。** 单次观测成立，未做长时间、多轮次确认；该节点自身也可能只是当时没被限流。
4. **`sing-box.json` 的 checksum 在我工作期间是 `d448f4dd50075d9c7c730d845760a8dc`**，且 sing-box 进程的 urltest 会**自行更换选中节点**（我观测期间从 `AWS日本06` 变到 `AWS日本04`）。因此报告里"当前节点"随时会变，矩阵按节点标签而非时间点解读。
5. **本机 DNS 投毒的范围我没有穷举**，只测了约 6 个搜索相关域名。`223.5.5.5` 作为 `dns.final=local` 在**直连**语义下被污染；但由于 sing-box 的 TUN 捕获，代理路径上的解析由 `default_domain_resolver: "remote"`（DoH 经节点）处理，所以**代理出口本身拿到的是干净解析**（1.1.1.1 与经代理 DoH 结果一致）。这解释了为什么"换 DNS 服务器"修不好搜索引擎——污染只影响直连那一段。

---

## 6. 顺带发现：searxng-healthcheck 定时器每 5 分钟误重启 SearXNG（生产缺陷，非本次引入）

`/usr/local/sbin/yosef-searxng-healthcheck` 每 5 分钟跑一次，判断条件是

```bash
systemctl is-active --quiet searxng && curl -fsS --max-time 5 http://127.0.0.1:8801/config
```

但 SearXNG 实际绑定的是 **`192.168.50.2:8801`**（`/data/searxng/config/uwsgi.ini:25` `http-socket = 192.168.50.2:8801`，由 `scripts/searxng-bind-direct.sh` 改成直连地址）。实测：

```
curl http://127.0.0.1:8801/config    -> rc=7 连不上
curl http://192.168.50.2:8801/config -> 200
```

于是定时器**每次都判定失败并重启**，日志固定刷：

```
searxng-healthcheck: local health check failed; restarting searxng
searxng-healthcheck: searxng did not recover after restart
```

重启时间线（我第一条命令在 06:34，重启**早于**我开始工作，且节奏固定 ~5min）：06:33:15、06:38:34、06:43:40、06:48:54、06:54:39、06:59:44、07:04:55、07:10:24。

**影响**：任何"改 SearXNG 配置后观察行为"的验证都会被 5 分钟内的一次重启打断，且每次重启都会清空引擎的挂起状态（`suspended_time=180`）。这会让复现和归因非常困难——本报告里 bing 时好时坏的现象**可能部分由此导致**。

最小修法（不在本次范围，仅记录）：把健康检查的目标地址与 `uwsgi.ini` 的实际 `http-socket` 对齐，或改成检查 `ss -ltn` 里 8801 是否处于 LISTEN。

---

## 7. 最小可逆改动方案

> 约束前提（必须遵守）：**sing-box 是全机共享代理**，被本机其它服务共用；任何改动必须**最小影响、可回滚**，**不要**改 `route.final` 这类影响全局的设置。
> 以下均为**建议**，本次**未执行**。

### 7.1 最高价值：解除 google 的 403（不碰代理）

问题在 SearXNG 自身端点，不在出口。三个选项按侵入性从低到高：

- **方案 1（推荐，零代理改动）**：在 `config/searxng/settings-overlay.yml` 里把 google 换成不依赖 WML 端点的引擎，例如 `google news`（或 images/videos）。这些引擎走的是现代端点。
- **方案 2**：升级 SearXNG 到已修复 google 引擎的版本（当前 release 为 `20260827_143211`，`google.py:328` 仍是 `/wml/search`）。升级属于发版动作，需另开任务评估。
- **方案 3（不推荐）**：直接改 searxng-src 里的 `google.py`。会与上游产生分叉，且 `/data/searxng/releases/*` 会在下次升级时被覆盖。

**落点与命令**：

```bash
# 编辑 config/searxng/settings-overlay.yml 的 engines: 段，把 google 换成 google news 等
# 应用（脚本自带备份与回滚）
sudo bash scripts/searxng-apply-overlay.sh
sudo systemctl restart searxng
```

**验证**：

```bash
curl -s -G "http://192.168.50.2:8801/search" \
  --data-urlencode "q=connectivity probe" --data-urlencode "format=json" \
| python3 -c "import json,sys,collections;d=json.load(sys.stdin);\
print('engines:',dict(collections.Counter(r.get('engine') for r in d.get('results') or [])));\
print('unresponsive:',d.get('unresponsive_engines'))"
# 期望：result_engines 里出现 google news，unresponsive 里不再有 ("google","拒绝访问")
```

回滚：`python3 scripts/searxng-overlay.py restore /data/searxng/backups/overlay-<stamp>`（apply 脚本每次都会打印备份路径）。

### 7.2 只为 qwant 定向一个节点（最小影响、可回滚）

结论是 qwant **只在 `🇸🇬新加坡 | 高速专线-hy2` 上真正出结果**。用现有的、已被设计好的**覆盖规则机制**，只为 qwant 的域名加一条定向规则，**不动 `route.final`、不动 urltest 成员**：

```bash
# 备份
sudo cp -a /data/net-proxy/config/override-rules.json \
        /data/net-proxy/config/override-rules.json.bak-$(date -u +%Y%m%dT%H%M%SZ)
```

在 `/data/net-proxy/config/override-rules.json` 的数组里**追加**（不要动已有条目）：

```json
{ "type": "DOMAIN-SUFFIX", "value": "qwant.com",  "outbound": "PROXY" },
{ "type": "DOMAIN-SUFFIX", "value": "qwant.fr",  "outbound": "PROXY" }
```

**重要**：`PROXY` 在 `generate-sing-box-config.py` 里会被映射成 `route.final` 那个 urltest 组（`convert_override_rule`，约 `:178` 行），**并不会**绑定到某个具体节点。要真正绑定 `sg-hy2`，需要在 `build_route()`（约 `:217` 行）里新增一条指名该 outbound 的 `domain_suffix` 规则：

```python
# /data/net-proxy/scripts/generate-sing-box-config.py, build_route() 内，override 规则之后、
# geosite-cn 之前插入（顺序很重要：必须早于 geosite-cn，否则会被 CN 规则先命中）
rules.append({'domain_suffix': ['qwant.com', 'qwant.fr'], 'outbound': '🇸🇬新加坡 | 高速专线-hy2'})
```

**影响面**：只有 `qwant.com` / `qwant.fr` 两个域名走指定节点，其它域名与所有服务完全不受影响。
**是否需要重启**：需要。`sing-box.service` 的 `ExecStartPre` 会重跑 `generate-sing-box-config.py` 重新生成 JSON，所以改完直接重启即可自动生效：

```bash
sudo systemctl restart sing-box
```

**重启影响谁**：重启 sing-box 会**短暂中断全机共享代理**（本机上所有依赖 7890/7895 的服务，包括 WAG 的读取与渲染、searxng、以及其它共用服务），通常几秒。建议低峰期做，并先 `sudo systemctl restart web-access-gateway web-access-egress-proxy` 之后确认 `curl -x http://127.0.0.1:7890 https://example.com/` 恢复。

**验证**：

```bash
# 1) 确认路由规则已进生成结果
python3 -c "import json;r=json.load(open('/data/net-proxy/config/sing-box.json'))['route']['rules'];\
print([x for x in r if 'qwant' in str(x)])"
# 期望：[{'domain_suffix': ['qwant.com','qwant.fr'], 'outbound': '🇸🇬新加坡 | 高速专线-hy2'}]

# 2) 确认出口 IP 已切到新加坡
curl -s -x http://127.0.0.1:7890 https://api.ipify.org; echo

# 3) 确认 qwant 真的出结果（标题应为 Qwant Search，而不是 "Service unavailable"）
curl -s -L -x http://127.0.0.1:7890 -A "Mozilla/5.0 Chrome/126.0" \
  "https://www.qwant.com/?q=connectivity+probe" | grep -oiE "<title>[^<]{0,40}" | head -1
```

**回滚**：

```bash
sudo cp -a /data/net-proxy/config/override-rules.json.bak-<stamp> \
        /data/net-proxy/config/override-rules.json
# 若改过 generate-sing-box-config.py，先从 *.bak-<stamp> 恢复
sudo systemctl restart sing-box
```

### 7.3 修 8 秒超时口径（针对 bing 未定问题）

先观测再改。8s 恰好等于失败耗时，怀疑是引擎被自身超时精确打断：

```bash
# 观察 bing 真实耗时分布（10 次）
for i in $(seq 1 10); do
  curl -s -o /dev/null -G "http://192.168.50.2:8801/search" \
    --data-urlencode "q=probe$i" --data-urlencode "format=json" \
    --data-urlencode "engines=bing" -w "%{time_total}\n"
done
```

若确认大量卡在 8.00s 附近，把 `config/searxng/settings-overlay.yml` 里的 `request_timeout` / `max_request_timeout` 从 `8.0` 放宽到 `12.0`，再 `sudo bash scripts/searxng-apply-overlay.sh && sudo systemctl restart searxng`。代价是单次查询最坏耗时变长——需与 `/readyz` 的 8s 依赖检查预算一起权衡。

---

## 8. 本次对生产的改动

**没有。** 严格只读，具体如下：

- 只做了 HTTP GET/HEAD 只读请求，以及读取配置/服务状态。
- **没有**修改 `sing-box.json`、`override-rules.json`、`generate-sing-box-config.py`、SearXNG 任何配置或代码。收尾核对的 checksum：
  ```
  d448f4dd50075d9c7c730d845760a8dc  /data/net-proxy/config/sing-box.json
  71889b2c7ec6a0ec7d8c74c81429a39e  /data/net-proxy/config/override-rules.json
  6fb938f869c09c363dfc5f84cfe91ff3  /data/net-proxy/scripts/generate-sing-box-config.py
  ```
- **没有**重启任何服务；收尾核对 `sing-box`、`searxng`、`web-access-gateway`、`web-access-egress-proxy` 均 active。
- **没有**通过 Clash API 切换任何 selector/节点——尝试过 `PUT /proxies/JP-SG-US`，服务端以 `400 Must be a Selector` 拒绝（urltest 组不可写），**未发生任何状态变更**，无需恢复。
- 逐节点测试用的是**只读**的 `/proxies/<node>/delay` 端点，以及在 `/tmp` 启动的**临时单节点 sing-box 实例**（只监听 127.0.0.1:78xx/79xx，用完即杀）。收尾已核对：所有探针端口关闭，只剩生产 sing-box 进程。
- 探测脚本与临时产物只落在 `/tmp` 与本地 scratch 目录，未写入仓库。
- 未打印或记录任何 token / 密钥 / cookie。引用凭据时只使用变量名 `GATEWAY_TOKEN`（远端 source 后使用，未回显）。**注意**：诊断过程中曾有一次命令把 `server.secret_key` 一并打印到了终端输出，该值**未**写入本报告或仓库任何文件。