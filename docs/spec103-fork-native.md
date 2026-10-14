# SPEC103-A — 下游 fork durable 保护核心与 native 发送—解析闭环

## Problem Statement

用户的小电脑（yosef-server）上，WAG 免费 recall、SearXNG 原生查询/init/helper、运维检查和独立 route probe 尚未共用实际发送邻接的持久保护。现有 probe ledger 保留历史，但不能限制 native fanout；原生限流配置、内存 suspension 和 retries=0 均不满足跨进程配额、CAPTCHA floor、未知发送与状态丢失 fail closed。仅把所有请求拒绝也不是完成交付。

本票是一体 native delivery，不拆成“只写 SQLite”或“只改发送函数”的票。

**发布首部披露：AI-authored，Claude Code宿主内当前会话为唯一设计writer，Hermes协调并独立验收；不是human-written，不声称用户逐行审过。** 用户自己的downstream fork适用范围按父已发布/readback的[裁定6158126091](https://github.com/williamxhero/WAG/issues/103#issuecomment-6158126091)；原AI_POLICY/AGPL不变，不豁免upstream规定、不向searxng/searxng或Matrix提交。

## Solution

在用户委托的 `williamxhero/searxng` 下游 fork 内交付一个 canonical 标准库保护包、可审阅 capability registry、真实 native network/processors/parser 闭环及版本化诊断。native 和 WAG probe 导入同一个批准 artifact 的包、访问同一账本/identity；非空成功 loopback 是必要验收，公开流量不是本设计阶段的验证手段。

状态：**draft / needs-triage；全部未来 AC NOT RUN；独立审批后才实施。** 本票单独不代表生产放行，依赖 B/C 的 caller 闭合与迁移/回滚验收。集成索引：[WAG #103](https://github.com/williamxhero/WAG/issues/103)，父：[WAG #82](https://github.com/williamxhero/WAG/issues/82)。父已发布/readback的delivery SPEC：[本票fork #1](https://github.com/williamxhero/searxng/issues/1)、[B WAG #107](https://github.com/williamxhero/WAG/issues/107)、[C WAG #108](https://github.com/williamxhero/WAG/issues/108)；本轮修订尚待更新原body，不duplicate create。跨repo仅真实URL，不伪造native parent；配套body的canonical消费方就是上述B/C真实issue。

## User Stories

1. 作为家宽使用者，我希望实际 engine 连接/请求都受持久预算约束，而不是用 backend 请求数猜测上游流量。
2. 作为原生搜索调用者，我希望合法、已审阅的发送能成功得到真实 parser 结果，而不是 all-deny 的假通过。
3. 作为国内 engine 使用者，我希望多个 category/route/worker/caller 仍共享原 engine 与 domestic aggregate bucket。
4. 作为操作人员，我希望 CAPTCHA 在真实 parser 发现后先落盘，再允许另一个 sender 获得 admission。
5. 作为服务维护者，我希望 quark 的900秒原生异常不能缩短1800秒保护 floor。
6. 作为 probe 调用者，我希望与 native 导入相同核心，不因拷贝旧实现产生另一套状态。
7. 作为维护者，我希望断连、timeout、取消、crash 和未知实际发送都保留 charge。
8. 作为发布负责人，我希望 root legacy identity、三笔历史、pause/strikes 与 lifetime anchor 原样保留。
9. 作为维护者，我希望坏 clock/storage/import/provenance fail closed，不自动 fresh-init 或退回内存模式。
10. 作为 engine owner，我希望新增名称/alias/backend 必须经过 capability/provenance 审阅，不能借新桶解锁。
11. 作为 operator，我希望原 routes/proxies/disabled engines 不被自动修改或换出口。
12. 作为 WAG 调用者，我希望机器诊断不被本地化字符串吞掉，不把保护拒绝当成 empty healthy。
13. 作为发布负责人，我希望一次 durable release-attempt 只能消费一次 public search transaction。
14. 作为 reviewer，我希望 source、dependency artifact、positive sends、状态与 CI HEAD 有可核对证据。
15. 作为保护关闭的现有用户，我希望默认 off 时原生行为保持兼容；显式 enabled 的失败绝不能变 off。

## Implementation Decisions

以下为选定的实现契约，不是已经实现/运行的能力。**A 是下述 contract 的唯一 schema/API/protocol owner。B/C 引用，不复制 DDL、另建 enum 或实现 ledger。** assignment 要求精确 owned map、schema 与 seams，优先于技能模板“不列具体路径”的默认建议。

### A1. 固定版本、包与启用条件

- fork trunk/base：`wag-production` / `9fea41204fdfa7a5cfa15b0ebd12904c520478ce`。父已预备future owning WSL worktree `/home/will/projects/searxng-spec103-a`、branch `claude/spec103-a-native`，报告pristine fixed base；仅目标A owning session在独立审批后使用，本writer未触碰/未新核其状态。不以新版master替代，不改default/upstream/rollback branches。Hermes是integration owner。
- 新 `wag_protection` 顶层小包纳入现有 setuptools 包清单；核心仅用 sqlite3/fcntl/time/os/pathlib/json/hashlib 等标准库。`import wag_protection` 不导入 searx、不解析 settings、不建 DB、不接触网络。不得发布成新的第三方服务/平台。
- contract 常量 `CONTRACT = "wag.outbound.v2"`，SQLite `user_version=2`，协议整数 `version=2`。artifact manifest 固定 fork commit、保护包/相关 native/parser/traits 文件 digest、registry digest、dependency distribution versions 和 wheel hashes；拒绝未声明、影子模块、symlink 跳转、版本/digest 不符。
- manifest JSON精确顶层字段：`schema="wag.protection-artifact.v2"`、`contract`、`mode`（production/synthetic）、`fork_commit`（40hex）、`artifact_digest/registry_digest/config_digest/python_digest`（64hex）、`module_root/python_executable`（canonical absolute TEXT，解释器resolved target显式批准并核python_digest）、`root`、`shared_gid`（正int）、`allowed_uids`（去重非负int数组，root及已核准writers）、`files`（artifact相对path→64hex，含core/native/parser/traits）、`distributions`（name→exact版本TEXT）、`wheels`（filename→64hex）、`registry`（按engine排序的A2 identity/alias/profile声明）。production root固定；unknown/missing字段拒绝。canonical JSON统一UTF-8、key排序、无额外空白、禁NaN。artifact_digest只hash `{contract,fork_commit,files,distributions,wheels,registry_digest,python_digest}` 内容投影，不含digest本身、含digest的安装路径或部署config，避免自引用；registry_digest为registry canonical JSON摘要。config_digest只覆盖resolved非secret allowlist：engine/profile/active/categories/timeout、network-reference/source-family及去userinfo的route scheme/host/port结构摘要；不存proxy URL/credential，不hash整个secret-bearing settings。三个摘要均不含identity值；manifest≤128KiB，relativepath无绝对路径/`..`，大小/路径逃逸检查是import prerequisite。
- 现有 manifest 为 httpx[http2]0.28.1、httpx-socks0.13.1；选定 protected direct/HTTP-proxy adapter 的兼容目标为 **httpx0.28.1 + httpcore1.0.9**。httpcore 已是原有 transitive dependency，只收紧其版本，不引入第二套 HTTP 客户端。新增最小 protection dependency lock/compatibility manifest，后续受控 provisioning 固定全部 transitive hashes；包与 backend ABI test 未通过之前不得启用。父后续实际metadata确认部署为httpx0.28.1/httpcore1.0.9/httpx-socks0.13.1/python-socks3.0.0/anyio4.14.2/h110.16.0/h24.4.1；本writer已focus读父归档的connection/proxy/http11/Trace源码片段与架构意见。此为父提供source证据，不是本轮现场import/ABI运行证明。
- 在原 settings 中新增 `outgoing.wag_protection` mapping：`enabled` 严格 bool（默认 false）、`root`、`artifact_manifest` 两个 canonical absolute path。enabled=true 时 root 必须为 canonical production root（synthetic 模式使用显式 disposable root）；配置键错拼、unknown key、路径/provenance/包不可用导致启动/配置验证失败，绝不默认为 false。配置 off 不打开 store、不改变原网络/重试/协议行为。
- artifact manifest 的 registry 是 A 提供并由父批准的四 engine 配置 profile，不接受请求/header 自报分类。runtime resolved settings、loader module/source、traits 与 manifest 对不上即拒绝该 capability，不能重写 operator routes 以使它匹配。四canonical identity为quark/chinaso news domestic、bing/yandex overseas；quark仅general backend、Yandex仅web、ChinaSo all/CENTRAL/LOCAL/BUSINESS/EPAPER受审阅本地profile、Bing用packagedtraits。
- profile_json另有严格bool `live_hold`。继承“不得追加quark请求”使production registry的quark live_hold=true，独立于原until与strikes；到期仍operator_hold、aliases同样hold，不改disabled配置或原pause/history。只有以后独立授权的registry amendment才可解除，不能迁移/release自动清除。synthetic四parser fixture明确live_hold=false以验证真实阳性路径，但不是live许可。

### A2. Canonical storage contract（唯一规范）

生产 root **`/var/lib/wag-route-probe`**，目录内 **`lock`、`identity`、`ledger.sqlite`**；独立 anchor **`/var/lib/wag-route-probe.identity`** 在目录外。不存在 `.identity` / `probe.sqlite` 别名。identity 是原32-byte lowercase hex token，内容不进入 logs/JSON/artifact；三个 identity 副本（state.id、identity 文件、anchor）必须 byte-equal。path/root/regular-file/no-symlink/owner/mode 校验失败、缺任一文件一律拒绝；普通 open 仅 `mode=rw` 或 `mode=ro`，永不 create。

SQLite 使用 DELETE journal、`synchronous=FULL`、foreign_keys=ON、timeout=0；每个操作先取得同一非阻塞全域 Linux flock。目录/journal 所需权限由 C 控制迁移，不让包自动 chmod/chown。读操作取得同一非阻塞锁以获取一致 snapshot；锁忙返回 typed lock_busy，不排队保留 permit。sqlite3 不可用或 FULL/commit/fsync 失败就是拒绝，无其他 store/fallback。

目标表定义如下；TEXT 中 JSON 由包验证，不假定 SQLite JSON/STRICT 扩展。INT 精确整数检查、REAL 所有使用点检查有限且非负（elapsed 除外亦非负）；NULL 与0不可混用。所有主键/FK/下述 enum/0或1约束由 DDL + admission validation 共同执行。

| 表 | 字段/类型/约束 |
|---|---|
| `state` | `id TEXT PRIMARY KEY`（32 hex）、`root TEXT NOT NULL`（canonical）、`checkpoint TEXT NOT NULL`（仅 wall REAL/mono REAL/boot 非空 TEXT）；恰好一行 |
| `contract_meta` | `singleton INTEGER PRIMARY KEY CHECK(singleton=1)`、`version INTEGER NOT NULL CHECK(version=2)`、`registry_digest TEXT NOT NULL`、`migration_wall REAL NOT NULL`、`migration_mono REAL NOT NULL`、`migration_boot TEXT NOT NULL`；digest64hex，恰好一行 |
| `engine_identities` | `engine TEXT PRIMARY KEY`（1..80）、`domestic INTEGER NOT NULL CHECK(domestic IN (0,1))`、`module TEXT NOT NULL`、`capability TEXT NOT NULL CHECK(capability='online_one_send')`、`source_digest TEXT NOT NULL`（64hex）、`profile_json TEXT NOT NULL`（canonical bounded JSON，≤8KiB） |
| `aliases` | `alias TEXT PRIMARY KEY`（1..80）、`engine TEXT NOT NULL REFERENCES engine_identities(engine)`；每个 canonical name 自映射，禁止链/cycle/collision；alias 不产生新 bucket |
| `attempts` | `attempt_id INTEGER PRIMARY KEY`、`dispatch_id TEXT NOT NULL`（1..80）、`engine TEXT NOT NULL REFERENCES engine_identities(engine)`、`domestic INTEGER NOT NULL CHECK(domestic IN (0,1))`、`stamp REAL NOT NULL`、`outcome TEXT NULL`、`reserved_mono REAL NULL`、`finished_mono REAL NULL`、`account_boot TEXT NOT NULL`、`account_mono REAL NOT NULL`、`caller TEXT NOT NULL`、`phase TEXT NOT NULL`、`connection_attempted INTEGER NULL CHECK(connection_attempted IN (0,1))`、`http_attempted INTEGER NULL CHECK(http_attempted IN (0,1))`、`elapsed REAL NULL`、`source TEXT NOT NULL CHECK(source IN ('legacy','v2'))` |
| `pauses` | `engine TEXT PRIMARY KEY REFERENCES engine_identities(engine)`、`strikes INTEGER NOT NULL CHECK(strikes>=0)`、`until REAL NOT NULL`（same validated boot 的 mono）；不因 category/route 复制 |
| `poison` | `reason TEXT NOT NULL`（保留 legacy 的多行、重复与顺序；新写必须 reason enum） |
| `release_checks` | `release_id TEXT PRIMARY KEY`（32hex）、`artifact_digest TEXT NOT NULL`、`config_digest TEXT NOT NULL`（两者64hex）、`boot TEXT NOT NULL`、`claimed_mono REAL NOT NULL`、`deadline_mono REAL NOT NULL`、`state TEXT NOT NULL CHECK(state IN ('claimed','complete','unknown'))`、`ingress_used INTEGER NOT NULL CHECK(ingress_used IN (0,1))`、`finished_mono REAL NULL`、`evidence_json TEXT NULL`（仅 A6 结构，≤16KiB） |
| `recoveries` | `recovery_id INTEGER PRIMARY KEY`、`authorization TEXT NOT NULL`（bounded非secret引用）、`old_checkpoint TEXT NOT NULL`、`old_poison_json TEXT NOT NULL`、`new_boot TEXT NOT NULL`、`wall REAL NOT NULL`、`mono REAL NOT NULL`、`decision TEXT NOT NULL`（clock_reanchor/terminated_sender/combined）；append-only |
| `recovery_attempts` | `recovery_id INTEGER NOT NULL REFERENCES recoveries(recovery_id)`、`attempt_id INTEGER NOT NULL REFERENCES attempts(attempt_id)`、`old_row_json TEXT NOT NULL`（该attempt变更前全部A2字段，≤8KiB）；复合主键(recovery_id,attempt_id)，append-only |
| `recovery_pauses` | `recovery_id INTEGER NOT NULL REFERENCES recoveries(recovery_id)`、`engine TEXT NOT NULL REFERENCES engine_identities(engine)`、`old_strikes INTEGER NULL`、`old_until REAL NULL`；复合主键(recovery_id,engine)，两值同时NULL表示恢复前无pause，否则保留原值，append-only |

索引：attempts(engine,account_boot,account_mono)、attempts(domestic,account_boot,account_mono)、attempts(dispatch_id)。存储不保存 query、URL、response body、headers、cookie、proxy 或秘密。artifact/config digest 均针对明确的非secret allowlist，不对 secret-bearing settings hash/log。

`caller` enum：native_search/native_init/probe/release/legacy_probe。`phase`：engine_http/proxy_connect/connection_only/legacy。new outcome enum：ok/empty/captcha/access_denied/rate_limited/challenge_unknown/timeout/error/parser_error/response_limit/redirect_refused/protocol_retry_refused/helper_refused/interrupted/runtime_error/request_refused/cancelled/not_sent/unknown_terminated。**NULL 只表示 unfinished，永远不按 elapsed 自动删除或终结。** new rows reserved_mono 非NULL；legacy 未知真实预留时间保留 NULL，不编造。

typed refusal reason enum：engine_rate/domestic_rate/cooldown/operator_hold/lock_busy/storage_error/clock_error/unfinished_attempt/identity_error/schema_error/import_error/provenance_error/capability_refused/route_unsupported/deadline_exceeded/helper_refused/redirect_refused/protocol_retry_refused/challenge_unknown/release_consumed/evidence_unknown。`query_unsupported` 是普通 skipped，不冒充保护故障。原生 CAPTCHA/access-denied/rate-limit outcome 与拒绝 reason 是两个不同维度。

### A3. Atomic reserve、lock、计费与 clock

1. dispatch 从完整 capability/path/identity/schema/poison/clock/pause/deadline 校验开始；flock 持续到 immediate native attempt、response body、**真正 engine.response**、outcome/pause/checkpoint commit 完成。不能在 HTTP 返回时释放，再“稍后”解析。enabled Search在现search_multiple_requests的最小分支中将同query reviewed finalrefs按canonical engine/category稳定排序串行调度：前ref parse/outcome commit/unlock之后才构造下一ref的dispatch并尝试flock，不在原parallel线程群里让siblings全变lock_busy。全部refs共用Search.start_time的同一totaldeadline，ref无新3s预算；不sleep等待flock、不预reserve/排队permit。跨query/process仍nonblocking lock_busy拒绝，off保原parallel行为。未开始ref若总deadline已过，记录deadline_exceeded/refused、零send；同query至少两独立engine的真实非空complete是必要positive AC，不能用分两次query冒充多源。
2. 一次 charge 最多覆盖 **一个 OS socket connect attempt + 一个 HTTP request attempt**；已有 keepalive 只含 HTTP 也照 charge。失败 connect 也 charge。HTTP proxy CONNECT 是 HTTP attempt，origin GET 是另一个 HTTP attempt，各有 row；直接 connect+GET 不人为双倍收费。所有 actual connection/HTTP counts 单独报告，分别 ≤reservations；未知用 NULL，不能报告成实际0。
3. 第一 row 在 client/get_client side effect 之前 `BEGIN IMMEDIATE` 校验并 INSERT NULL outcome/commit，再 immediate dispatch。额外 proxy-origin HTTP row 由同一个持锁 dispatch 内部在 native header send 之前重新完整检查预算/clock/deadline并 commit；不对外返回/缓存裸 permit。除了该审阅 handshake 序列，第二 connect、重试、重定向和 helper 全部 before-send 拒绝。
4. 每 engine 在 `account_boot=current_boot AND account_mono>now.mono−60` 的 row 数 <6，domestic row 合计 <30 才 reserve；保留边界 `(now−60,now]`，59.999秒不提前放行。结束时该 dispatch 全部 row 的 stamp/account_mono 更新为 `finished.mono`，保证 connect/read/parse 延迟不让刚发送的请求提前过期；始终保留 reserved_mono。所有失败与 not_sent 均不退款，不 prune 历史。
5. 接受新 dispatch 前任何 outcomeNULL 都拒绝；仅当前合法内部 dispatch 可追加自己的 reviewed proxy-origin row。进程死亡/停止确认失败/结果写失败保留 NULL，全域拒绝后续。存储已坏到不能写 poison 时，NULL/身份/DB校验本身仍拒绝；不能靠另一个易丢的内存标记。
6. 同 boot：now.wall/mono 必须 finite、非负、不小于 previous；boot 非空并 byte-equal；`abs(Δwall−Δmono)≤2.0s`，超过或 boot改变记录 clock_error poison 并拒绝。正常 wall 和 mono 同步前进不是异常；wall-only/mono-only 前跳不释放 quota/pause。checkpoint 原子更新，拒绝中的 clock poison 也先 commit。没有 sleep 自动解 poison。
7. CAPTCHA：真实 exception/挑战信息 + parser 决定；strikes+1，until=`max(旧until, finish.mono + max(exception要求,1800*2^min(strikes−1,16)))`。quark900 不改原 parser，保护 floor覆盖；更长 CF 暂停保留。403/429 是 access_denied/rate_limited，不谎称 CAPTCHA，但保守沿用同等持久暂停/strike策略。challenge_unknown 停该 engine并暂停，不按success清除。只有经门控、实际非空结果的 ok 清除连续 pause row；empty/error/native resume不能清。
8. total deadline 在 Search.start_time 起算，protected search ≤min(native actual_timeout,3.0s)，init 独立≤min(engine.timeout,3.0s)。构造/排队/DNS/connect/body/parser都使用剩余时间，取消 request helper 的0.2s加成只作用 enabled 模式。deadline过去不得创建新socket/header send。3.2秒报告真实elapsed及deadline_exceeded，不钳制为3秒。
9. native future timeout 主动取消 async工作并等待停止确认到原 total deadline；仅 `future.cancel()`/线程_timeout 不算确认。未确认时transaction snapshot立刻unfinished、当前row保持NULL，timeout observer只通知拥有该dispatch的worker，**不得重新取得worker已持有的flock/连接写DB，也不得替worker解锁**。持锁worker在下一安全控制点、unlock之前commit unfinished_attempt poison；parser终于返回也不自动解poison。同步parser阻塞时锁仍持有、其他进程lock_busy；worker被杀/崩溃时锁由OS释放、NULL挡下一进程，即使尚无法写poison仍failclosed。flock仅在sender真正停止/分类落盘后释放，或随持有进程死亡释放；超时响应可先返回unknown，不能伪称sender已终止。每个独立进程新open lock FD，拒绝fork继承token/FD；sync线程→async只通过显式ContextVar传播同dispatch，不用进程全局mutable ACTIVE_LEDGER。

### A4. 实际 native send-before-denial 边界（G1 的有界选择）

**不替换 HTTP parser/HTTP 客户端、不 monkeypatch 全局 socket、不修改 third-party 源码。** protected client仍为native httpx.AsyncClient，fork自有窄 `httpx.AsyncBaseTransport` 桥接带guarded AsyncNetworkBackend/stream的httpcore AsyncConnectionPool/AsyncHTTPProxy；使用原HTTP framing/parser与httpx request/response/byte-stream映射，保留TLS verify/SNI、proxy认证/地址、source_ips与原mounts优先级，不实现第二HTTP客户端。不能假定AsyncHTTPTransport构造器接受network_backend，也不靠偷偷替换其私有_pool而漏mount；该桥接与固定httpcore接口由A拥有并纳入artifact ABI gate。

父实际operator safe-enum是outgoing与Yandex ownproxies均http，其他三engine继承；不是direct证明，也不是允许换路线。选定direct+HTTP(S)矩阵覆盖此已知route类型，HTTPS-proxy能力仍须阳性验收。旧unprotected client/pool不能在enabled后继续使用：配置切换先禁止新调度、撤销并确认旧operation终止、关闭/卸载旧pool，再构建并验证全部guarded transports，最后启用；任何阶段失败保持hold，不复用旧defaultbackend。startup无旧pool同样先验证后调度。C负责部署停止顺序，A负责同进程client生命周期。

- guarded connect_tcp 在同一 event loop 内用 getaddrinfo 获得地址，按原 family/source bind 选择第一个兼容地址，然后**显式创建一个 socket、对该数值 sockaddr 调一次 loop.sock_connect**；不用 anyio.connect_tcp 的多地址 Happy Eyeballs、不调用 socket.create_connection 的地址循环。失败不换地址/线路；socket超时/取消必须关闭并确认，尚未完成就保持unfinished。IPv4/IPv6各有测试。
- 返回符合锁定 httpcore AsyncNetworkStream 协议的窄 stream（read/write/aclose/start_tls/get_extra_info），用 asyncio stream封装已连接socket；不实现 HTTP framing。TLS 用原 sslcontext/SNI，重复 start_tls合法proxy/origin层保留，但不得产生新connect。所有原pool（direct与HTTP(S)-proxy）必须使用该backend；不得只覆盖默认transport而漏mounts。fork桥接固定httpx/httpcore request/stream/pool ABI，版本/字段/trace能力不符即import/provenance拒绝，不能默默使用default backend。
- 首次 HTTP headers 发送由锁定 httpcore `http11.send_request_headers.started` trace在write前检查/绑定row；native HTTP-proxy CONNECT 后 origin headers再次触发，先reserve新row。guarded stream.write 校验当前已armed row和剩余deadline；没有匹配trace上下文不得写协议headers/body。body分块是同一个请求，不按每write重复charge；CONNECT控制请求也记录真实attempt，不当免费连接准备。pool尝试第二socket时 backend在socket创建/连接之前拒绝；known firstattempt仍charged。
- protected模式强制HTTP/1.1 client选项，禁HTTP2内部retry/reconnect；不改operator配置文件。普通支持HTTP/1.1的原站点可以正常发送。若要求HTTP2-only，明确route_unsupported，不退到未经媒介transport。
- **SOCKS4/5/5h与Tor、UDS/custom transports 不在v2 reviewed支持矩阵**：在get_client/get_transport_for_socks_proxy/check_tor_proxy提交任何工作前route_unsupported，保留原configured route，不静默走direct/HTTP proxy。父后续归档表明httpx-socks实际调用python_socks.async_.anyio.v2.Proxy，其connect进入anyio.connect_tcp，多地址路径不经过本httpcorebackend；不能声称backend覆盖SOCKS。本票明确before-scheduling拒绝，不以无限研究承诺支持。若真实operator路由是该类型，发布保持hold/degraded，不能为过gate改路由。将来扩支持需另行scope审批，不偷偷放行。
- `Network.call_client` protected分支只能一次client.request，不进入现retries循环，RemoteProtocolError直接terminal，不执行close后continue；`follow_redirects=False`，3xx classified redirect_refused，不能等待soft_max_redirects事后报错。transport handle_async_request计数若超过该dispatch约定的main request也在client.dispatch前拒绝。
- engine.request/response/init/setup 阶段内的 network helper、multi_requests/stream/traits fetch，在 `searx.network.request/multi_requests/stream` **run_coroutine_threadsafe或future-list创建前**拒绝。main `_send_http_request`进入唯一 main_request phase，才允许一次network.request；response期间helper拒绝不重入flock。其registry声明与artifact sourcedigest匹配，阻止绕searx.network自建socket的未审阅engine在import/setup前加载。
- engine.init只允许四审阅profile的纯本地初始化；新engine或network-init不自动fallback。四parser本身仍是真实模块，packaged traits来自artifact，fetch_traits不在运行/CI/release触网。
- Search `_get_requests` 记录最终refs与被拒绝/跳过ref；同name不同category共享engine row。thread join若超过deadline就将transaction snapshot标为unfinished并要求持久poison；不能依sent metric/Server-Timing认为actual sends已完成。

父归档的httpcore1.0.9源码已明确：HTTP11在_send_request_headers前await Trace.started，async callback被await；forward/CONNECT继承request.extensions，因此该before-header seam有source依据。anyio4.14.2 hostname connect会Happy Eyeballs多地址，故选择first-compatible numeric sockaddr、一次sock_connect、不fallback，最小且更保守；不是一次backend callback就等于一次TCP。**stream arm/取消终止/全部mount计数/真实阳性与ABI仍NOT RUN**，不得把源码事实或架构意见当AC通过。父归档/readback参考：[G1证据](https://github.com/williamxhero/WAG/issues/103#issuecomment-6158297622)。

### A5. 唯一 Python API、legacy migration 与恢复

公共 API（包版本2，类型/值按A2/A3）：

- `open_store(root, *, manifest, mode)`：mode为production/synthetic；验证存在的store，返回无网络store handle，不create/不移权。synthetic只能显式disposable路径；production只能canonical路径，不容许fixture/副本充当live identity。
- `run_engine(engine_name, *, caller, deadline_mono, build, send, parse)`：在真实callback执行处取得锁、解析identity/profile并reserve。build/request网络禁用；send接收仅当前执行期间有效的内部context；parse调用真实parser。返回 `EngineOutcome` 或 `Refusal`，不把异常cause/raw文本输出。context在返回、未经批准跨线程、任何跨fork或phase不匹配时失效；A3显式sync→async桥接只能绑定同一未结束dispatch，不能转移lock所有权或复制permit。内部connect/header只能由native adapter或经批准probe adapter消费。
- `initialize_fixture(root, *, registry, clock)`：只允许synthetic test，保留独立anchor；production没有initialize/reset命令。原probe production --initialize 不保留重新建库能力。
- `migrate_legacy(root, *, manifest, authorization)`：offline-maintenance，调用者已停止所有cooperative sender，取得原flock；要求父只读确认的四表列/type、无多余表/trigger/view、单state、identity/anchor/root一致、DB quick_check通过、user_version=0、合法rows/clock/registry。v2同digest再次调用只验证，不重迁移。未知schema/version拒绝。
- `claim_release(release_id, artifact_digest, config_digest, deadline_mono)`：独立短事务先消耗claim；新ID仅由C在prepare创建并持久保存，不是每次healthcheck生成。返回当前stack一次性执行receipt，重复/失效/unknown一律release_consumed；crash不退款。
- `run_release_check(receipt, operation)`：**消费receipt并持久置unknown/ingress_used=0后、释放flock，再调用一次现有MCP web_search operation**（不能持锁等待gateway/native的flock）。authenticated请求携带`X-WAG-Release-Attempt: <release_id>`；B将其绑定唯一现有web_search入口，internal backend transaction上限1，无empty retry/provider补齐/HTTP retry/redirect；native各attempt仍走run_engine。deadline涵盖claim/MCP/search/body/record；结果落complete/evidence，崩溃停留unknown。receipt不是可持久恢复的发送permit；resume只能读取结果，不能再次operation。
- `consume_release_ingress(release_id, artifact_digest, config_digest)`：B的已认证web_search入口在发送前持短锁验证current boot/deadline、claim fingerprint、state=unknown且ingress_used=0，原子置1/commit；后续同ID/replayed header返回release_consumed，不发backend请求。不允许header产生claim或扩大预算；值缺失是普通interactive路径，不携带release权限。网络调用始终在unlock以后，以免与native dispatch死锁。
- `public_snapshot(artifact_digest, config_digest, *, max_age_s=60)`：同锁一致read-only，**零send**，返回A6 public evidence；clock/boot/provenance/ID/age校验失败或unknown为not_checked/refused。不得write freshclaim或刷新cache搜索。
- `recover(root, *, authorization, decision, proof)`：独立授权maintenance接口，没有auto-recovery或reset CLI；只支持下述保守恢复。未授权路径只输出typed拒绝。

release唯一状态机：claim插入`claimed/ingress_used=0`；run_release_check仅接受本stack未消费receipt并commit `unknown/0` 后unlock；既有auth通过的唯一web_search ingress才可在同boot/未超deadline/批准artifact与当前config相等时将`unknown/0→unknown/1`；operation结束记录`complete/1`与A6 evidence，失败/crash保持unknown且不能再operation。unknown不等于无条件拒绝：只允许这一次合法ingress；重放、claimed未启动、complete、unknown/1或非法值拒绝且backend0。claim/operation主体是批准维护caller，ingress绑定既有requireToken后的per-request server context，不信header自报caller/分类；header本身无授权能力，不能create claim。header出现但非法/重复一律拒绝，不能当ordinary忽略；header缺失仅能走普通交互路径，release orchestrator若丢失header必须停止，不能降级成普通搜索来补operation。所有短锁在RPC前释放，native仍独立逐attempt门控。

legacy migration 在一个SQLite事务内创建带约束的新表/copy/rename/user_version=2/commit，旧state checkpoint JSON及identity/root byte-for-byte保留；新增contract_meta记录迁移观察clock但不覆盖旧checkpoint来绕过差分校验。legacy attempts原rowid作为attempt_id、engine/domestic/stamp/outcome原值保留；dispatch_id=`legacy:<rowid>`、caller=legacy_probe、phase=legacy、source=legacy；reserved_mono NULL，finished_mono=stamp仅当旧outcome非NULL，account_mono=stamp/account_boot=原checkpoint.boot，known connection/HTTP/elapsed NULL。已知原三笔必须仍是chinaso news domestic ok2、quark domestic captcha1；quark strikes1/until8074715.728828768 原REAL精度保留，**不是现在剩余秒**。原NULL/poison行保留（poison按rowid顺序复制），未知engine或非法outcome不猜修，直接拒绝整个迁移。不能复制成新live root或生成新token。

migration crash前commit→旧schema保留且protected开启失败；commit后→完整v2。identity/anchor不参与DB schema rename，锁inode不换；没有release备份恢复DB流程。malformed/corrupt/I/O不能通过重新迁移“修好”。

恢复只在新授权和sender停止证明后运行：在同一持锁事务中先把旧checkpoint/poison按原行顺序写recoveries，所有将变更的attempt全字段写recovery_attempts，所有将变更/新增pause的原值或原不存在标记写recovery_pauses，再执行恢复与commit；审计写失败则整个恢复rollback，不删除charge。重启跨boot时将需要保守重计的row account_boot/account_mono重锚到新boot/currentmono（stamp不改），至少全部尚未确定/旧窗口内row继续charge60s。pause剩余按`max(旧until−旧checkpoint.mono, 1800*2^min(strikes−1,16),0)`从新mono重设，保留旧值审计；不得按不可信wall判断expired。unfinished只有独立证明sender已停止后可标unknown_terminated，保留charge，并对受影响engine应用保守unknown-challenge暂停；若不能证明，继续NULL/fail closed。clear poison的每项理由写审计，不引入新identity。**此接口/演练属于批准后的A实现+C编排，不授权本轮实际恢复，也不是允许追加quark的凭证。**

### A6. 现有 endpoint 的唯一 machine/evidence protocol（G3）

无新 endpoint。`/search?format=json` enabled时新增 `outbound_protection`，off时不新增/改变既有JSON。机器字段不使用get_translated_errors输出；原localized unresponsive_engines继续保留。

| 字段 | 规范 |
|---|---|
| `version` / `enabled` / `contract` | 2 / true / wag.outbound.v2 |
| `artifact_digest` / `registry_digest` / `config_digest` | 审批manifest与当前resolved非secretconfig的64hex；绝不含canonical identity值。当前config与批准manifest不匹配不得发送 |
| `status` | complete / partial / refused / unfinished；必须按全部最终selected refs真实outcome判定，不以结果长度独立决定 |
| `engines` | ≤64条，每条engine canonical TEXT、category bounded TEXT、status admitted/refused/skipped/unfinished、reason enum或NULL、outcome new enum或NULL、reservations非负int、connection_attempts/http_attempts非负int或NULL（有任一unknown即NULL）、result_count非负int或NULL、elapsed_s finite非负或NULL、deadline_exceeded bool。按engine/category排序；重复ref仍分别报告但预算共桶 |
| `retryable` | 任何保护拒绝/unfinished/partial时false；complete正常行为true。不为quality retry重新发保护拒绝 |

Search finalrefs记录缺processor/capability拒绝、原suspended、unsupported query及skip；native skipped不用捏造HTTP行。`status=complete`仅所有已派发ref完成且无保护拒绝/unfinished；正常完成empty可complete，但**不证明supply通过**。已完成有结果且有拒绝为partial；全部无admitted且有拒绝为refused；任何尚未终结为unfinished。snapshot必须thread-safe；closed container以后不得静默写late success改变已送出的证据。

`/config` additive descriptor `outbound_protection`（off时只 `{version:2, enabled:false, contract:"wag.outbound.v2"}`；on时还有artifact_digest/registry_digest/config_digest、admission=available/blocked、reason）；digest类型同上，config_digest来自当前resolved非secretallowlist，非盲抄manifest；不匹配则blocked/provenance_error。available要求reason=NULL，blocked要求A2 typed reason。仅包/config/storage只读校验，零engine调用。未知/locked/poison admission blocked并诊断，不把service可达假称public通过。没有ledger身份值/pause绝对timestamp泄漏。

`release_checks.evidence_json` / `public_snapshot`：`version=2`、release_id、artifact_digest/config_digest、checked_at ISO wall、age_s（finite非负，存储时0，snapshot按同boot mono重算）、search={status:passed/degraded/refused/not_checked/unknown,result_count:非负int或NULL,responsive_engine_count:非负int或NULL,protection_status:A6状态或NULL,quality_evidence_digest:64hex或NULL,reason:A2 refusal或empty/quality_failed/public_not_checked/operation_failed或NULL}、egress={status:passed/degraded/not_checked,reason:not_checked/connect_failed/deadline_exceeded/provenance_error或NULL}。passed reason必须NULL；unknown/未执行不编造计数。只有真实completed/usable非空+保护完整的搜索可passed；completed零hit即degraded，refusal/未知不冒充responsive。egress是独立现有诊断，不称本核心治理所有proxy流量。public通过必须两个passed；没有matching complete/newboot/≤60s evidence就是public_unknown/not_checked。rollback/restart不新增claim，配置/artifact变更使旧证据失效；不反向重置claim。该schema仅由A定义，B/C据此渲染与记录。单次MCP的真实results/provenance保存在既有evaluation report artifact，而非canonical DB；quality_evidence_digest绑定该artifact的非secret规范化search evidence section。B的release evaluator复用同一次结果执行原domain/provenance/quality断言，不把count替代质量，不为验证再次search；失效/缺失artifact只能失败或not_checked。普通诊断仍不输出raw URL/body/query；正常既有search results里的公共source URL不是新增保护诊断。

### A7. Source/test owned map 与依赖（G2/G4/G5）

唯一future writer是目标fork owning session；当前WAG设计writer仅写本文，**不直接编辑fork**。

| path | A拥有的最小切片/验收 |
|---|---|
| `wag_protection/{__init__,ledger,contract}.py`（拟新增） | A2/A3/A5/A6、小registry与无searx副作用的API；synthetic fixtures、多进程、migration/clock/recovery测试 |
| `setup.py`、`requirements.txt`、`requirements-protection.lock`（最后一项拟新增） | 将包纳入existing find_packages include；固定httpcore兼容目标与artifact依赖，不搬新平台 |
| `searx/settings.yml`、`searx/settings_defaults.py:249-267` | 已实读existing outgoing defaults consumer；增加enabled mapping声明与严格native读取。contract validator须在常规bool coercion丢失原类型之前验证raw enabled/unknown keys，不能把错拼/字符串/无效enabled配置转换成off |
| `searx/engines/__init__.py:90-165,271-293` | import/setup之前capability；保持resolved disabled/inactive/routes与packaged traits |
| `searx/network/{__init__,network,client}.py`，拟新增`searx/network/protected.py` | main/helper/context/deadline、禁protocol/retry/redirect、全部HTTP mounts guarded backend、unknown routes before-send拒绝；不复制核心 |
| `searx/search/processors/{abstract,online}.py` | init/request/response阶段、持锁parser、durable outcomes而不让native resume清保护；positive parser测试 |
| `searx/search/__init__.py`、`searx/results.py` | 最小finalref/timeout/线程安全snapshot；为A6不能静默丢ref或把late线程假称完成 |
| `searx/webutils.py:70-82,162-174`、`searx/webapp.py:1246-1277` | 仅现JSON machine field与/config descriptor；不新增route/auth/plugin |
| `tests/unit/network/test_network.py`、拟新增`tests/unit/network/test_protected.py`、`tests/unit/test_wag_protection.py` | existing native seam + real loopback/multiprocess，不用mock回包证明actual-send |
| `tests/unit/test_{engines_init,search,results,webutils,webapp}.py` | registry/refs/JSON与off兼容回归；原retry valid tests保留off模式 |
| `.github/workflows/integration.yml` | 保master trigger，加wag-production push/PR；显式Linux exact-head protection gate，保现Python3.11–3.14/core回归，不触container/data-update/l10n/AI-policy机器人 |

A不写B/C文件；B的probe adapter依赖A artifact，不把canonical core文件复制回WAG。C的permissions/artifact/provenance编排依赖A接口；schema变更只由A writer在A issue评审。CI artifact/codegate做完仍须Hermes独立审阅，不给ready-for-agent自动标签。

## Testing Decisions

**所有以下 AC：NOT RUN（本轮只有文档设计）。** 最高主seam为真正native Search/OnlineProcessor→Network→httpx/httpcore→loopback→真实parser→canonical store；核心API另做必要clock/multiprocess/migration边界，不增加伪production endpoint。

1. **AC-A1 正向非vacuous**：真实导入固定fork的webadapter/preferences/engines/processors/network/results/utils/exceptions，synthetic settings（关闭default继承、只四审阅engine）、packaged traits；loopback返回四真实parser的非空fixture结果。至少direct HTTP、direct HTTPS、HTTP proxy转发、HTTP CONNECT+TLS各有真正成功send+parser+durable outcome。测试专用resolver将真实request生成的host映射至loopback，保留原URL/Host/SNI/parser输入，HTTPS用synthetic trust与匹配host证书；只在显式synthetic manifest/test launcher注入，production没有该reroute开关。proxy fixture同样只到loopback，并仍走真实guarded backend/httpcore。mock可控制响应，不能替代native imports或用AST。禁止非loopbacksocket，fixture TLS只用synthetic证书。同一真实native query至少两个独立reviewed engines均非空、summary complete、独立charged rows，在同一≤3s总deadline内完成；不能以两次query或partial代替，不降低母#82的≥2独立源/60%门槛。
2. **AC-A2 实际尝试**：记录loopback accept/headers、socketconnect callbacks与SQLite reservations；direct每row≤1connect/1HTTP，CONNECT+origin两个row。6个direct admitted attempts可成功、第7拒绝；synthetic多个reviewed IDs测domestic第30成功/31拒绝，海外仅单engine计额；59.999s拒绝、安全60s完成窗口放行；delay>60秒测试仅用受控clock，charge不提前过期。原3sdeadline不靠真实等待延长。
3. **AC-A3 隐藏扩展**：原off分支RemoteProtocolError/retries反例保留；on分支断连、HTTP status retry、3xx、stale connection、multiple DNS candidates、HTTP2/SOCKS/Tor/customtransport的第二connect/header/scheduler计数为0或均已新reserve（只有reviewed CONNECT-origin允许）。嵌套request/response/init/helper/multi_requests/stream/traits在future/socket创建前拒绝。无guarded backend/trace能力时零send，不只assert error文本。
4. **AC-A4 真实挑战**：quark synthetic challenge真实exception900→durable≥1800；Yandex header、CF/reCAPTCHA、更长pause、200challenge、403/429/unknown分别分类，strikes1800/3600/7200与cap跨进程重开保留。empty/error不清strike；pending另一engine/ref/进程不能在parser前发出。status写失败仍charge且挡所有后续。
5. **AC-A5 并发/截止**：两个进程及多个native线程抢同flock；lock_busy零send，不排队库存permit。response已到、parser尚阻塞时第二进程不能connect；join timeout/futurecancel不能伪终止。build/DNS/connect/read/parse各阶段只用总剩余deadline；late任务不能后发；unfinished/kill/commitfail后NULL或poison继续拒绝。report有known/unknown与真实elapsed，无退款。补合法受控线程→async的admitted阳性，以及同query前ref耗尽总deadline、后ref before-send refused零connect/header；startup/enable/reload必须先停旧operation并close卸载旧backend，guarded全部mount验证后才调度的相位顺序测试，失败不得复用旧pool。
6. **AC-A6 legacy与状态失败**：用父schema合成三笔+quarkpause fixture（非copy生产），保rowid/identity/root/原clock/unknown/poison；migrate crash前后不可fresh。missing/symlink/root/anchor/schema/digest/alias/disabled/inactive权限错误、lock/corruption/I/O/finite值/boot/2s差分全部零send；独立authorized recovery fixture保charge/pause审计，不绕unknown。
7. **AC-A7 protocol**：真实JSON serializer不把refusal仅翻译成unexpected crash；selected/skipped/duplicate-category/partial/unfinished准确，off原JSON兼容。/config和public_snapshot执行期间engine init/search/publicsocket计数0；missingevidence没有passed/虚构hit。
8. **AC-A8 packaging**：从同一个approved artifact导入native核心与probe消费的包，`__file__`/manifest/dependencyABI一致；包无settings/network副作用。shadow/wrong版本/未安装都拒绝，不能降级旧ProbeLedger。
9. **AC-A9 focused→broad→HEAD**：isolated provision已批准依赖后，`python -m unittest tests.unit.test_wag_protection`（stdlib核心gate）及原nose2对应native focused suites；随后 `make V=1 test.unit` /现 `make V=1 ci.test`，保原valid测试。CI在wag-production实际PR HEAD及拟合并HEAD明确跑 protection offline gate，零unexpectedskip、阳性send数量>0、source/dependency hashes与HEAD一致；empty rollup/仅master绿不算。

早期本地fork/system目录探测未找到dependency源码；父后续提供实际部署包归档，已按A1/A4补正，不再称missing source。没有本轮download/install/runtime import/tests；trace source顺序事实不等于stream/取消/ABI/positive验收。运行兼容性属exact-artifact gate，失败标BLOCKED，不改有效测试放行。父当前Actions enabled但workflow API列表空，也不能作为exact-head绿；未来真实PR必须注册并实际运行非空checks。

## Out of Scope

新daemon/plugin/endpoints/MCP/共享代理或全屋流量平台；SOCKS/HTTP2/Tor/customtransport支持扩展；验证码破解、换IP/route绕暂停；engine扩池/启用disabled engine、新版master升级；provider/router/adapters/Tencent诊断、官方API预算变更；本轮源码/测试/CI修改、安装/执行/迁移/部署/SSH/现场读取/公开搜索。原auth/SSRF/operator routes与#49/#60/#74/#82 supply/date/quality、人审门槛不降低。

P0原chinaso2/quark1与CAPTCHA pause保留；P1 canonical7c、baidu2/Ali1/Tencent2保留；Tencent仍technical unknown。91 retained candidates不等于robots/safety/date release admission。不得reset/refund/newidentity/newquark。

## Further Notes

- Stage1 checkpoint据Hermes已经发布并exact-readback：[WAG103 comment6158086439](https://github.com/williamxhero/WAG/issues/103#issuecomment-6158086439)；本阶段未自行GitHub读回或发布。最新授权来自assignment引用6157869034/6157869664，不重开旧authorization问题。
- 原生入口证据：父记录CLI `-p '/to-spec …'`；当前会话上下文有显式/to-spec命令与技能正文，但model自述加载不能替代原生session加载日志，不伪造Skill成功。此前Skill(to-spec)确实因disable-model-invocation失败；Stage1 Skill(grilling)成功。长Stage2被owner中断，未形成完整completion收据。本轮用户显式`/to-tickets` command-name与技能正文已提供，同会话仅做定向docs修订/map，不重执行技能setup或绕禁用Skill。
- 同一continuing conversation、唯一设计writer，无subagents。父已真实init核会话UUID `3f2873e1-0e08-47b5-8ddd-d63fd1151d4d`、init model `gpt-6.1-sol`；这里记录父init证据而非本writer新runtime查询。宿主Claude Code不等于Anthropic模型身份，不从宿主推断Claude/Fable/Mythos型号。
- 已读AGENTS/domain/issue-tracker/triage及fork AI_POLICY/CONTRIBUTING；WAG没有CONTEXT/ADR，fork根absence由固定ls-tree确认。仅写A/B/C设计Markdown，未动fork或已有文档。
- 披露：用户委托的downstream-only工作；Hermes协调，Claude Code宿主内当前AI会话是设计文本唯一writer，非human-written、无实现/生产claim。父已提供适用范围裁定与发布/readback证据：[WAG103 comment6158126091](https://github.com/williamxhero/WAG/issues/103#issuecomment-6158126091)，见最新parent provenance；这不是本writer自行GitHub核验或重新解释policy。裁定限定用户自己的williamxhero下游fork，明确AI-authored(Claude Code)/Hermes独立验收，不伪human-written或声称用户逐行审过；原AI_POLICY/AGPL保持，不豁免upstream规定。未来fork issue首部及WAG103必须引用该裁定，不再标missing human input，不扩大工程/部署权限；绝不向searxng/searxng或Matrix发布。
- G1由A4受支持矩阵/明确before-send seam收敛；G2由A2/A3/A5定稿；G3由A6定稿；G4由A1/A5及C落实；G5由A7/AC-A9及C exact-artifact gate落实。所有代码/CI/production成立性仍是未运行AC，而非设计已证明生产通过。
