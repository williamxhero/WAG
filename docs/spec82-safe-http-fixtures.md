# SPEC82 engineering: Fetch-safe test-only HTTP listeners

## 实现前 to-spec / to-tickets 等价阶段

Parent SPEC: #82，https://github.com/williamxhero/WAG/issues/82 。Engineering ticket: #97，https://github.com/williamxhero/WAG/issues/97 ，label ready-for-agent，OPEN；已用 native sub-issue 挂 #82，parent/subissue 双向 API 回读一致，无需 fallback。这是一个有界 engineering 子任务，不替代总 SPEC。

2026-10-13，唯一 writer：t_13e16d9d 本 Claude 会话。仅工作于 `D:/WILL/TOOLS/web_access_gateway_proj/.worktrees/t_13e16d9d`，branch `wt/t_13e16d9d`。已核对 clean HEAD = 已 fetch 的 origin/main = `8208e3de9a285f69908a7ce6dc58c5903ccc9b65`，包含 PR94。default/Hermes 负责集成和独立验收；不启动另一 agent/writer/review，不改 Kanban。

已实际读取 AGENTS.md、docs/agents/{domain,issue-tracker,triage-labels}.md、现有全局 `C:/Users/will/.claude/CLAUDE.md`、#82 正文和完整评论历史（截至 6148162050）、#96 ownership、health/eval-runner 测试、相邻只读 fixtures/等待监听 helper 和完整 CI workflow。worktree 内无项目 CLAUDE.md、CONTEXT.md、docs/adr。没有可调用的 /to-spec /to-tickets 工具，故在本会话执行等价阶段，不伪称 slash 调用或加载未提供的技能。不重新全 grill，不向用户追问已授权默认。

- **to-spec 等价阶段**：固化以下根因、边界、选择理由、公开接口、错误码和验收。
- **to-tickets 等价阶段**：创建一张 ready-for-agent engineering 子 issue，精确 `gh issue view` 回读，再用 native sub-issue 挂 #82；不可用则父评论 tasklist + 本票 Parent 链接明确 fallback。
- Blocked by: none for offline engineering。#96 与本票互不依赖，不触碰其 owner 文件。
- **本轮只登记**：仅 SPEC 文档/tracker 写入和读取，不写实现/测试代码，不 npm provisioning，不运行 RED/GREEN，不 commit/push/开 PR。后续同 session 实施。ready 标签不是已实现/已验收。

## 根因与既有证据

Windows 动态 TCP 端口起始 1024、数量 13977（既有只读诊断，不改系统）；listen(0) 可分配 Fetch 禁用端口。debugger 窄 100 次循环第 66 次随机获得1719：三路 fetch 均 bad port，上游请求数全0，core_ok=false。这个循环属于 debugger，不冒称本 writer 重跑。

本会话实际读取 `C:/Users/will/AppData/Local/hermes/profiles/debugger/cache/scratch/wag-readiness-diagnostic/fixed-port-repro-final.log`：9checks；1719/2049各 healthy/malformed/backend503 共6个，raw HTTP200但 Fetch blocked；18080三个对照分别 passed/core true、degraded/dependency_invalid_data/core true、degraded/dependency_http_status/core true，各收到 search/crawler/playwright 请求1次。日志属于既有诊断，不是本轮新测试，也不证明生产故障或所有旧 timing flakes。

现有 anchors：`gateway/health.test.mjs:16-19` 的公共 listen 使用port0，37/48/54/280分别用于backend、CONNECT proxy、child reservation、直接readiness fixture；`gateway/eval-runner.test.mjs:42-45` 的HTTP MCP fixture同样port0。`gateway/read-fallback.test.mjs:26-38`已有局部禁用列表/25次重选，只读借鉴，不迁移/修改（#96 owner）。保留 waitForListening，不以盲sleep取代就绪事件。

## 默认选择与理由

保留 `listen({port:0, host})`。成功 listening 后检查实际端口是否在 helper 固定的完整 Fetch forbidden-port 集合内；若禁用，await close后重新绑定。默认至多25次，禁止无界循环。仅对 EADDRINUSE 有界重试；其他地址/DNS/权限/编程错误及时失败，不能重试掩盖。

理由：沿用 OS 分配和既有25次局部模式，避免固定18080或共享高位小池争抢，不改变IPv4/IPv6/hostname绑定语义。独立worker持有自己的server/reservation，没有global allocator/serializer或全局fetch patch。禁用集合记录 Fetch 标准来源 https://fetch.spec.whatwg.org/#port-blocking ，实施时与 pinned Node26 / CI Node22 行为核对，覆盖完整适用列表，不只排除1719/2049。不新增生产依赖，不供生产模块导入。

## 预先冻结的公开 test-only 接口和错误码

新模块 `gateway/fixtures/safe-listen.mjs`，三个 exports：

### 1. listenHttp

`async listenHttp(server, { host = '127.0.0.1', maxAttempts = 25, listen = (server, options) => server.listen(options) } = {}) -> { port, url }`

- server 是未监听、无 pending listen 的调用者所有 Node HTTP Server；每次向 listen 传 `{port:0, host}`。成功时保持真实server监听到调用者teardown，不采用普通fixture先释放再绑定策略。
- host为非空字符串，原样传Node，支持IPv4、IPv6 literal、hostname，不强制改IPv4或DNS。url使用传入host和实际port，IPv6 literal正确括号化，不把hostname换成127.0.0.1。maxAttempts必须是1..25整数；非法配置在监听前拒绝。
- listen是显式、局部、仅测试 seam，遵循Node同步发起listen的签名及listening/error事件语义，返回值不作为监听结果。确定性测试可让真实server先绑定forbidden/occupied端口，或用EventEmitter server double模拟事件；不patch全局http/net/fetch、原型、系统或生产配置。
- 同步throw、异步error和listening均收敛；settle后移除helper自加监听器，保留调用者监听器。forbidden重选必须等close完成；cleanup自身失败立即报告，不吞掉继续。

### 2. reserveHttpPort

`async reserveHttpPort(options = {}) -> { port, release }`

- 经listenHttp创建并持有无response handler的私有HTTP server；同样host/attempt/seam规则。占用至 `await release()`；release为幂等async cleanup，不泄漏私有监听器/server。
- health child fixture准备完成后、spawn前立即release，使用所得安全port。teardown尽早注册，覆盖部分初始化/startup失败的backend/proxy/socket/临时目录/已启动child；不只成功尾部注册。
- **不是跨进程原子reservation**：release与child bind间仍有TOCTOU窗口，不声称消除所有EADDRINUSE。child startup冲突经现有waitForListening明确失败并清理，不无限重启、不增timeout、不修改生产server或global serializer。

### 3. SafeListenError

`class SafeListenError extends Error`

- `code = 'WAG_TEST_SAFE_LISTEN_EXHAUSTED'`：仅forbidden/EADDRINUSE消耗maxAttempts后产生；带 `attempts`（实际次数）和 `reason`（`forbidden_port` 或 `address_in_use`），后者可带最后EADDRINUSE cause。invalidaddress不得误报exhaustion。
- `code = 'WAG_TEST_SAFE_LISTEN_INVALID_OPTIONS'`：host/attempt/seam/server precondition非法，0次bind，不擅自关闭调用者已在用的server。
- 其他Node listen/address/DNS错误保留原始code（例如EADDRNOTAVAIL/ENOTFOUND/EACCES/ERR_INVALID_ARG_VALUE），及时reject；close错误也保留，不循环，不留下未处理error或挂起worker。

普通成功listener的连接teardown继续由fixture按现有socket集合、closeAllConnections/await close完成。helper只管理自身尝试/私有reservation生命周期，不改handler/auth/CONNECT行为。失败后无新active listener，无helper自加error/listening/close listener残留，资源可重新绑定。close无需sleep。

## 独占 write map（后续只有五文件）

1. NEW `gateway/fixtures/safe-listen.mjs`：exported TEST-ONLY helper。
2. NEW `gateway/safe-listen.test.mjs`：独立helper测试，进入现有gateway/*.test.mjs glob。
3. `gateway/health.test.mjs`：仅fixture listen/reservation及必要部分初始化清理，保留全部既有断言。
4. `gateway/eval-runner.test.mjs`：仅fixture listen及必要监听/句柄清理，保留全部既有断言。
5. NEW `docs/spec82-safe-http-fixtures.md`：本独立SPEC及后续实际执行/失败/验收/局限收据。

NEVER：生产readiness/server/evidence或其他生产代码；其他测试（包括evals）；#96 boundary/search/read/browser/adapters/provider-routing/canary/config/release等owner文件；proxy实现/测试；packages/locks/CI；系统portrange/registry/proxy/TLS/SSRF；Fetch unsafe-port safeguard；NODE_OPTIONS。不迁移所有测试、不修scope外flake、不新增工具/daemon/生产依赖。不读凭证、不真实API、不SSH/生产部署/重启，不merge/close任何issue。

## 后续真实 TDD 验收（全部 pending）

同一writer会话，垂直真实RED→GREEN；不把missing依赖/import/setup错误冒充行为RED，不sleep或增timeout：

- [ ] 确定性forbidden→safe，显式1719/2049及完整列表边界；筛选期间无HTTP请求；前次监听关闭后才下一次；port/url正确，事件监听器不增长。
- [ ] 确定性occupied→retry→safe；连续EADDRINUSE精确maxAttempts后typedfail；连续forbidden同样typedfail，覆盖同步throw/异步error，不用随机碰运气。
- [ ] invalidaddress/DNS/nonretryable错误一次及时失败并保留code；invalid options零bind；不能误关闭调用者正在监听的server。
- [ ] 真实loopback HTTP + 未修改原生fetch请求安全listener成功，计数可观测。IPv4/IPv6/hostname绑定、IPv6 URL、独立并发listener/no serializer；平台能力不足明确记录，不任意skip。
- [ ] 真实occupied listener冲突与release后同port重绑；reservation持有/幂等release；forbidden/retry/exhaustion/fatal/部分初始化失败后监听/socket/句柄/temp/child清理。用close事件/await/rebind/隔离child自然退出证明，不以sleep或私有active-handle快照为唯一证据。
- [ ] 真实因果RED→GREEN：局部listen seam令旧fixture路径确定性获得1719/2049，rawHTTP成功、原生fetch bad port、请求0，回归断言旧行为RED；helper筛选后safe listener收到真实请求GREEN。不得关闭Fetch防护、依赖随机重跑等红或制造假绿。
- [ ] health/eval完整保留schema/security/auth/redaction/core/public/deadline/status/cache/cleanup/exit/report断言及原timeout值。healthy/malformed/backend503对照不能一律healthy；不宣称其他旧timing flakes已解决。

## 固定验证执行计划（本登记轮不执行）

Windows pinned Node：`C:/Users/will/AppData/Local/hermes/tools/node-26.7.0-win32-x64/node.exe`。确认版本，使npm子进程PATH用该Node，不修改NODE_OPTIONS。锁定provisioning，不改manifest/lock：

```sh
npm --prefix gateway ci --ignore-scripts --no-audit --no-fund
npm --prefix runtime/playwright-mcp ci --ignore-scripts --no-audit --no-fund
```

仅Windows测试环境：`WAG_TEST_CHROMIUM_EXECUTABLE=C:/Program Files/Google/Chrome/Application/chrome.exe`、`PLAYWRIGHT_SKIP_BROWSER_GC=1`。真实isolated headless，不碰用户窗口/profile、不假浏览器，不启用真实API/live opt-in。

顺序：helper targeted -> health/eval targeted/files -> foreground file-serial完整 `node --test --test-concurrency=1 gateway/*.test.mjs proxy/*.test.mjs` -> bounded **100次targeted repeat**：每轮固定窄health readiness、eval成功lifecycle与helper真实fetch用例，记录case/iteration/port或safe error、退出/总计；首失败停止保存，不能retry直到凑100成功。要求100轮完成、零bad port、无新增句柄泄漏；不是100次全suite或所有flakes已解决的声明。

若full出现scope外flake，只 **一次精确single -> 一次对应file -> 一次full**，保留原失败及每步输出；持续失败升级最小复现/报告，不untilgreen、不放宽断言、不改scope外文件。复跑绿不抹首次红。

检查owned/all适用tracked JS/shell/Python syntax、`git diff --check`、最终逐行diff/五文件scope、无临时/debug artifacts。Linux必须现有 `.github/workflows/ci.yml` 完整exact-final-head：Node22、两套locked npm/browser Chromium provisioning、crawler fixture deps、全部tracked syntax、serial gateway+proxy、全部scripts Python、crawler lifecycle/readiness、evidence artifact retention。不改workflow，不以focused或旧head绿替代；后续核对local/remote/PR/CI head一致并读回steps/logs/明确skips。CI后仅外部receipt，避免doc-only收据循环制造新head。

## 后续 ticket / delivery checklist

- [x] #97 已创建；实现前gh issue view完整精确回读body/title/label/state/url；native挂82并双向回读parent/subissue，不需要fallback。其余实施/验收项保持pending。
- [ ] 同session逐片真实RED→GREEN，仅health/eval迁移及五文件diff。
- [ ] focused/full/100repeat/syntax/diff与实际失败/局限证据。
- [ ] **后续轮**已授权scope checkpoint commit/push及一个PR：Refs #82，Closes 本engineering issue；遵守commit/PR attribution。本登记轮禁止这些操作。
- [ ] 后续完整exact-head LinuxCI、Hermes/default独立验收；本writer不merge、不close。

登记轮结束时：**仅SPEC/TICKET登记；实现、npm provisioning、代码测试、RED/GREEN、100repeat、commit/push/PR/CI均未运行。** 无生产、真实API、凭证或系统端口范围修改。本票不完成#82/#49/#60/#74生产供给/日期/真实接入退出条件，不重开已交付#92。

## 实施轮 checkpoint（2026-10-13，同一 session）

操作者明确授权issue登记后直接实施、早期checkpoint commit/push/唯一PR。Hermes已在本worktree执行两套locked npm ci成功；本writer没有重跑安装，更不追溯冒称登记轮执行。实际核对Node v26.7.0、PATH pinned、Chrome测试env/GC禁用，TMP/TEMP/TMPDIR均为本coder scratch。所有下列日志存于 `C:/Users/will/AppData/Local/hermes/profiles/coder/cache/scratch/t_13e16d9d/`，不是其他profile或系统tmp。

已实现三个冻结exports、OSport0完整Fetch禁用表筛选/最多25次close-rebind、仅EADDRINUSE重试和typedfail、原始invalidaddr错误、host语义、幂等reservation release。保留所有既有HTTP处理/auth/CONNECT/readiness/eval断言和deadline值，只迁移fixture并提前注册部分初始化teardown。eval constructor仍接受第二参数callable handler，可选listenOptions是第三参数，不把handler改为配置对象。新增失败注入是显式局部测试listen seam，无生产开关/全局patch/调度框架。

实际垂直TDD证据（所有命令由本writer执行，保存完整stdout/stderr）：

| 阶段 | 命令 | 结果 / 日志 |
| --- | --- | --- |
| unsafe因果RED | `node --test <coder-scratch>/wag97-baseline.test.mjs` | 4 tests / 2pass / 2fail；1719/2049原生fetch cause bad port；raw200且fetch请求0。`wag97-red-forbidden.log` |
| 筛选首次验证 | `node --test gateway/safe-listen.test.mjs` | 4 / 2pass / 2fail；fetch已成功，新增测试错误地期待Node自带listening listener为0。改为保持原始listener数量，不削弱原有测试。`wag97-green-forbidden.log` |
| 筛选GREEN | 同上 | 4/4；真实fetch、先close再rebind、请求计数1。`wag97-green-forbidden-2.log` |
| 重试/校验RED | 同上 | 9 / 6pass / 3fail：occupied未经重试、未typed exhaustion、非法options未拒绝。`wag97-red-retry-validation.log` |
| 重试/校验GREEN | 同上 | 9/9，`wag97-green-retry-validation.log` |
| helper扩大覆盖 | 同上 | 17/17；完整80个禁用端口逐个原生fetch核对；real invalidbind、IPv4/IPv6/hostname、reservation重绑、失败/listener清理及隔离进程自然退出。`wag97-helper-complete.log` |
| constructor/partial RED | `node --test --test-concurrency=1 --test-name-pattern='fixture cleans\|fixture retains' gateway/health.test.mjs gateway/eval-runner.test.mjs` | 3 / 1pass / 2fail（Missing expected rejection），`wag97-red-constructor-cleanup.log` |
| constructor/partial GREEN | 同上 | 3/3，`wag97-green-constructor-cleanup.log` |
| focused三完整文件 | `node --test --test-concurrency=1 gateway/safe-listen.test.mjs gateway/health.test.mjs gateway/eval-runner.test.mjs` | **99/99，0fail/0skip/0cancel，79.855s**，`wag97-focused-files.log` |

unsafe baseline是scratch内忠实复现旧port0监听边界的局部seam，测试副本仅替换import，非模块缺失RED；后续GREEN使用真实新helper。它不是修改生产server/Fetch防护。raw bad-port control测试有意证明防护仍生效，不能误算为修复后fixture失败。

checkpoint前四owned JS syntax、git diff --check、五文件scope、两原测试每条既有assertion行保留核对均通过。新helper原生Node26内置禁用列表已只读核对；CI Node22行为由同一跨版本测试及parent完整CI验证。

**此checkpoint状态：实现及focused已绿；full gateway+proxy、100repeat、全tracked syntax及parent独立完整exact-head CI仍待执行/验收。** 后续记录不抹去上述首次失败。reservation release→child bind仍非原子；scope外其他fixture的bad-port风险只报告，不迁移。无需生产凭证/API/SSH或系统端口修改。PR merge/issue closure不属于本writer。
