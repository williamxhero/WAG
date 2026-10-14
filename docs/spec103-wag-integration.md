# SPEC103-B — WAG 零搜索 core readiness 与真实保护拒绝接线

## Problem Statement

当前 WAG `/readyz` 直接调用 SearXNG `/search`，使 healthcheck 的 `--core-only` 仍会产生公开 engine sends；search 的 empty retry 与 evaluator 的 error/quality retry 可能把 policy refusal 当作补搜理由。现有 MCP error envelope 可以表达拒绝，但 native JSON 的本地化 engine error 无法可靠区分共享保护拒绝。probe 还持有自己的 ledger 实现及旧source digest门槛。

如果只改脚本名称、把搜索结果置空或把所有public checks删成“通过”，就没有解决上述问题。

## Solution

接入 A 的唯一包与机器协议，保留现有 endpoint/MCP/auth。WAG core readiness只读config和core依赖，不发搜索/公共egress；public证据只消费同一durable release-attempt的已有记录。搜索在retry/provider阶段前处理typed protection refusal，evaluator不对拒绝或partial补齐。probe只保留transport/parser adapter，调用A同一core。

状态：**draft / needs-triage；全部未来AC NOT RUN；独立审批前不实施。** 本delivery ticket为[WAG #107](https://github.com/williamxhero/WAG/issues/107)，同仓parent [#103](https://github.com/williamxhero/WAG/issues/103)。Blocked by [A fork #1](https://github.com/williamxhero/searxng/issues/1)，供[C WAG #108](https://github.com/williamxhero/WAG/issues/108)集成。issue/needs-triage/native parent/dependency由父登记提供，非本轮GitHub核验；本轮仅修订body供Hermes更新，不duplicate create，跨repo不native错挂parent。

## User Stories

1. 作为运维人员，我希望 `/readyz` 和 `--core-only` 真正零engine/public搜索，重复轮询也不补搜。
2. 作为发布负责人，我希望core健康与public_unknown/degraded分开，engine故障不触发错误的core rollback。
3. 作为MCP用户，我希望quota/CAPTCHA/storage/clock拒绝有typed reason，而不是healthy empty。
4. 作为用户，我希望partial真实结果不丢失，但不被称为完整供给通过。
5. 作为budget owner，我希望empty/quality/error retry不绕共享保护，也不自动调用provider来掩盖拒绝。
6. 作为probe操作人员，我希望同一native包/ledger/identity生效，不让旧copy/freshDB变成放行路径。
7. 作为evaluator使用者，我希望原domain/provenance/日期/质量断言保留，而不是只断言count>0。
8. 作为release reviewer，我希望search-public case复用同一次合法search结果，不额外发第二次查询。
9. 作为维护者，我希望缺包/错误版本/未知diagnostics被诚实诊断，不自动兼容成通过。
10. 作为现有调用者，我希望auth/SSRF/工具名/结果格式和独立provider预算不被重做。
11. 作为维护者，我希望provider热点和release owned files与本票互斥，避免同文件多writer。
12. 作为reviewer，我希望跨真实MCP边界和真实native positive send的离线证据明确，不把mock绿当生产通过。

## Implementation Decisions

### B1. 共享契约与激活

**唯一规范是[A fork #1 的 A1–A6](https://github.com/williamxhero/searxng/issues/1)。** 本票不复制schema/enum/DDL，不实现sqlite/flock、CAPTCHA退避或clock恢复；只有typed parser/CLI adapter和consumer行为。遇到未定义reason/version不猜新enum，按A的schema/provenance refusal处理。

- WAG新增最小纯protocol模块 `gateway/outbound-protection.mjs` 和标准库CLI adapter `scripts/searxng-protection-state.py`。CLI仅导入批准artifact的 `wag_protection`，提供snapshot和consume-release-ingress两个有界命令；无search、无create/reset、无schema迁移，无新endpoint/daemon。
- server现有cfg处增加 `WAG_PROTECTION_MANIFEST` 的可选canonical path接线；C发布时必需提供批准manifest。没有该配置的旧off兼容模式保留正常interactive行为，但**一旦backend带A enabled字段就必须验证/遵守，不因WAG配置off忽略refusal**。C的保护release不能在manifest缺失时通过。没有新增工程config.mjs；该revision的cfg就在server.mjs。
- descriptor、CLI包path/version/digest与release manifest一致；包不存在/错误root/timeout/输出过大/unknown字段返回typed失败，禁止第二个import root/PYTHONPATH/旧ProbeLedger fallback。Python执行路径来自C批准artifact的固定解释器，不假定WSL安装Node/Claude/gh或额外venv；spawn不得shell拼接，stdout ≤16KiB、总超时≤min(剩余readiness预算,1s)，故障只给static reason。
- `/config`与read-onlysnapshot分别证明native服务配置可达、当前保护/证据状态；不读取secret-bearing配置内容或canonical identity值来打印“证明”。fixture manifest必须显式synthetic，production只能canonical root。

### B2. `/readyz` 与 healthcheck 语义

现 `createReadiness` 的SearXNG `/search?q=readyz` 改为同服务 `/config`；确认categories/engines结构与A descriptor。Crawl4AI `/readyz`和Playwright现有core请求保持；SearXNG config成为core dependency。**整个core路径不运行engine init/search/trait fetch，也不运行现example.com egressProbe**。native服务可能已在此前启动，但这个readiness invocation自身不得产生engine调用。

`searxng_search` / `egress_proxy` public dependencies从A `public_snapshot`映射，不调用任何search/egress操作。cache/inFlight只是缓存core+readonlysnapshot；miss/worker/restart/cacheexpiry不会触发publicprobe。等待C explicit release流程产出证据；没有、过期、artifact/config不匹配、新boot、claim unknown等都为public_unknown/not_checked。锁忙/保护blocked仍可以core_ok=true，但public degraded；服务/config/schema/import本身无效才core失败。缺包不允许伪装已经配套的protected release已core ready。

- 保留booleans `ok/core_ok/public_connectivity_ok` 与 `ok=core_ok&&public_connectivity_ok`；HTTP仍200 iff ok，否则503。
- status仅failed/passed/degraded：core失败→failed；完整有效public passed→passed；其他core正常→degraded。以public dependency `status=not_checked/unknown/refused`、static reason及 `public_unknown:true` 区分未检查与真实故障。
- 对A的completed零hit，只有真实responsive证据时可表示completed/degraded，**不能变supply passed**。不伪造result_count/responsive_engine_count；unknown值保留NULL/缺失而非0。
- `healthcheck.sh --core-only`保留ready-core判定：即使HTTP503/public degraded，core_ok=true仍exit0；不得掩盖core_failure/invaliddata。default full只消费readonly `/readyz` evidence；不保留独立direct `/search?q=healthcheck`，也不自发新release ID或public搜索。原example.com连接诊断移到C一次explicit release operation（可保持独立egress诊断），full轮询不重复发它。
- diagnostics parser保留HTTP/classification一致性校验，增加unknown/refusal typed记录；core-only不把publicfailed当corefailed，full对publicunknown/degraded按现公共降级exit语义返回非0并保留报告。不得改有效测试成全通过。

### B3. Search → MCP refusal/partial 与冻结热点

`requestSearch` JSON解析后立即验证A6。`searchSearxng` empty判断之前处理；对HTTP non-2xx若有合法A typed envelope仍诊断refusal（body有大小/结构上限），不能只显示HTTP status或rawbody。

- 完全refused/unfinished、enabled期待下missing/off/malformed/version/digest不符：throw typed `kind='outbound_protection_refused'`，`blockedReason`取A static reason，message固定模板，retryable=false。现server `errorResult` 已产生 `isError:true`、`structuredContent.error.kind`、`blocked_reason`；只补充可验证的版本化保护summary，不显示query/raw URL/body/cause/identity/proxy。
- partial存在真实usable结果：保留原normalization/temporal/provenance/quality处理，返回真实results并附A机器summary、`degraded:true`、`retryable:false`，不得删除refusal或补provider/GDELT/empty retry来把它洗成完整pass。没有usable结果的partial按refusal处理；不制造synthetic hits。
- complete且正常empty：保持原非release ordinary empty retry行为（每次backend请求仍由native逐attempt gate）；下一次response若拒绝立即停，不返旧emptyhealthy。正常非空路径及既有strict time/date语义不变。
- 不改 `provider-routing.mjs` / `provider-adapters.mjs`；只在search入口遇保护拒绝时**不调用它们**。正常非拒绝interactive provider逻辑/独立预算仍原样；官方API不是P0 quota替代。MCP工具schema/endpoint不新增。

唯一B持有server/search的最小切片：cfg/createReadiness callback、web_search internal options与release header context、error/normal结果附typed summary；以及search的firstBody验证、retry/fallback之前的保护分支。不改server其他read/browser/auth/SSRF槽位，也不更改provider implementation。这是必要hotspot授权，而不是解冻整个文件。

### B4. Release ingress 与 evaluator不补搜

引用A5的一次claim/ingress API及A6 quality evidence，不在WAG定义第二套票据。

- C在一次operation中调用现authenticated `/mcp` `web_search`，携带A规定的 `X-WAG-Release-Attempt` header。B在已存在requireToken之后把header传到本request的server instance context，**不能用全局mutable current-release**；`getServer`只增加internal context参数，不改变public工具schema。
- header严格解析；在web_search操作内、fetch之前调用A `consume_release_ingress`。不存在有效claim/重复、clock/deadline、provenance坏都MCPtyped拒绝，backend count0。header不能create/重开claim，也不允许request自己扩大预算。header缺失为普通interactive请求，不受release一次claim权限，但同样受native所有配额。
- 正常消耗后internal `maxBackendTransactions=1`、`relaxEmpty=false`，只一次native `/search`；本release operation不调用provider/GDELT候补、不因quality/error重发。不是新增用户输入选项；只由verified release context限制行为。使用原search结果的source/date/quality处理，不降低断言。
- `evaluateCase`与`runWithRetries`在typed refusal或payload.degraded/protection retryable=false时禁止**两条** error retry/quality retry；其它read/browser的合法transient retry保留。partial不把has-results单断言当整体健康。availability case仍failed/degraded而非expected-security pass；只有明确negative fixture可按expected-outcome断言。
- `eval-runner` release mode的 `search-public` 支持两种内部来源：C的one-shot operation执行一次真实web_search；或在同release ID+artifact/config+freshness+digest校验后，复用那一次的现有evaluation artifact。artifact保留真实既有results/provenance，**原 has-results/expected-domain/search-provenance 断言仍执行**，不以canonical DB里的计数伪造result。报告写 `evidence_reused`、release_id、actual新backend transactions=0，保留原搜索时间/attempt证据，不假称本轮重新调用。
- 无matching/fresh artifact或quality不满足→case失败/not_checked，**不再调用web_search**，不skip/降低case门槛。report parsing只接受C批准的固定路径和非secret search evidence section，大小上限、symlink/过期/digest/绑定都校验；不能让任意文件冒充live证据。
- 非release interactive/其他eval suite仍走正常公共搜索gate；policy拒绝不retry。readinessQuality保留core/public区分，public_unknown不满足release public/supply gates。release suite其余read/browser/auth/SSRF/quality断言仍在原seam执行，受各自原预算，不称P0保护治理它们全部。

### B5. Probe adapter与真实parser

- `searxng-route-probe.py`去掉生产独立ProbeLedger实现，public调用形状可保留adapter名供现test演进，但内部仅A `open_store/run_engine`。synthetic clock/registry由A fixture API提供；production --initialize改为typed拒绝与受控migration指引，不能再创建freshroot。
- 旧source revision/digest硬编码不直接删除，而改为批准fork artifact manifest（fixedbase+实现commit/hash、实际parser/utils/traits/module root）；未验证artifact/缺dependencies/runtimecontaminated仍零send。不能只导入同名包或假定SOURCE_DIGEST旧值适用于patchedfork。
- OneSendTransport保留direct/HTTP proxy明确路由、禁止retry/redirect的现有限制；由A内部context媒介connect/request并记known/unknown。`http.client`实际路径也用单数值address一次socket.connect，防socket.create_connection多个addr自动尝试；proxy CONNECT+origin各消费A row，不能沿用“一请求=一row”的错误报告。helper/parse仍用真实native module与no-network guard。
- 原fork子进程watchdog不传父store/token/flock FD到child。child自行open现canonicalstore，**整个run_engine（含parse）在child持锁执行**；parent只收sanitized stage/result并在总deadline杀停/确认。parent死亡与child尚存时child锁继续保护；child死亡后NULL挡后续。停止不能确认→Aunfinished。不在parent提前reserve再让child拿stalepermit。
- pair构造/cookies相等、disabled/category/time_range检查保留；each arm总3s包含原build耗时，不能每个阶段再加3s。预构造纯request回调不允许网络；对第二arm也按实际独立attempt预算减build耗时，不重建/换身份绕暂停。
- CAPTCHA/403/429分类与A native真实parser一致；现probe把403/429都当captcha的粗分类修正为access_denied/rate_limited并同样停发，unknown body不清strike。failure/result report仅A白名单，不输出rawresponse。

### B6. Owned map、分支与依赖

B future owning session在WAG main `96b4cba0b4b3796d4479365119c43017584d8bf3`基础上独立branch/worktree，消费经A批准artifact，Hermes协调合并后C串行使用；没有与C并发同文件writer。当前只写本文。

| path | B唯一拥有的切片/对应test |
|---|---|
| `gateway/outbound-protection.mjs`（拟新增）、`scripts/searxng-protection-state.py`（拟新增） | A protocol validation/read-only snapshot/ingress CLI；拟新增gateway protocol test + CLI tests，不重写core |
| `gateway/readiness.mjs` | B2零search/config/core+existingpublic evidence；`gateway/health.test.mjs` |
| `gateway/server.mjs:90-100,371-385,web_search,getServer,/mcp,/readyz` | B1/B3/B4必要cfg/上下文/envelope接线；existing MCP/health boundary测试，不碰其他行为 |
| `gateway/search.mjs:189-205,326-372,最终return` | refusal-before-empty/provider，single release transaction内部限制与typed summary；`gateway/search.test.mjs` |
| `gateway/eval-{case,core,runner}.mjs` | 两类refusal不retry、release search evidence replay；对应eval-case/eval-core/eval-runner/evals tests，保原质量 |
| `scripts/healthcheck.sh:114-135`、`scripts/healthcheck-diagnostics.py:130-174` | core零public、full证据消费/unknown；`gateway/healthcheck.test.mjs` |
| `scripts/searxng-route-probe.py`、`scripts/searxng-route-probe.test.py` | 同A package adapter/provenance/native parser/child ownership/positive send，删重复core不删有效验收 |

A独占fork/core/schema；C独占release/overlay/wrapper/provisioning/CI/权限迁移；B不改这些C文件或WAGprovider文件。若新增gateway tests涉及既有server/MCP fixture文件，只由B writer处理且父先确认owned map，不令C重复写。

## Testing Decisions

**全部 NOT RUN。** 首选现MCP→search→真实fork→loopback seam及现health/readiness/eval/probe fixture，避免只unit mock验证新consumer。

1. **AC-B1 零发送**：真实 `/readyz` +healthcheck core-only（含cachecold/multiworker/restart/repeatedcalls）对搜索backend/search、engine init/helpers、公共egressconnect counters全为0；/config与Crawl/Playwright core检查实有成功calls。不得只断言healthcheck未运行第133行。
2. **AC-B2 分类**：corefail/invalidprotocol→HTTP503+failed；core正常无证据→503+degraded/public_unknown、core-only exit0/full非0；真实matching/fresh public证据可200/passed；expired/mismatched/claimedunknown/lockbusy/CAPTCHA不伪造hits。原健康与诊断valid tests更新请求seam但不弱化断言。
3. **AC-B3 MCP正向**：真实native loopback非空发送与parser通过→现authenticated web_search真实results/provenance、A summary complete、canonicalrow同域；不接受all-deny。正常off兼容search/strict date/engine pool路径回归保留。
4. **AC-B4 拒绝不补齐**：native engine_rate/domestic_rate/cooldown/clock/storage/unfinished及missing/wrongversion descriptor，MCPtyped isError/blocked_reason；empty relaxed retry、provider/GDELT dispatch、eval error/quality retry计数为0。partial保留真实results/refusal且不供给passed。
5. **AC-B5 release一次**：C claim→authenticated releaseheader→gateway onebackendfetch（normalempty亦不retry）；重复header/未知ID/expired/multiworker并发只一个ingress成功，拒绝前零backend。helper释放短锁后native可正常取锁，无RPC-flock死锁。
6. **AC-B6 原质量+复用**：一次真实search写existingevidence；同ID的release evaluator重放原expected-domain/provenance断言并报告actual newtransactions0；tamper/digest/invalidpath/stale/mismatch/qualityfail不得第二次search。normalother-eval retry仍合理；不得删/skip有效case。
7. **AC-B7 probe共享**：native与probe同artifact+identity，跨process/category/route合计；真实四parser、quarkfloor、parent/childcrash/unfinished、connect多地址/CONNECT、timeout无退款都使用A核心，旧ledger不可fallback。三笔legacyfixture迁移后仍保留pause/history，fixture不是productioncopy。
8. **AC-B8 安全回归**：auth/Host/SSRF/原providerbudgets/disabled/operatorroutes、deadline与秘密redaction保持；header无token不能消费claim；普通caller不能借header制造新release ID。
9. **AC-B9 focused→existing broad→exactHEAD**：先指定health/search/eval/probe/CLI/MCPfocused tests；后现serial `node --test --test-concurrency=1 gateway/*.test.mjs proxy/*.test.mjs`、全部 `scripts/*.test.py`、crawler unittest及trackedsyntax。C的separate exact-fork-artifact Linux gate实际provision真实runtime，要求本票native positives无skip；普通WAG CI中的WAG_ROUTE_SOURCE缺失skip不是gate通过。

任何CI/mock结果只标offline工程证据；独立review与C later live gate未满足不能宣称production shared protection完成。

## Out of Scope

新endpoint/MCP工具/daemon、provider-routing/adapters修改、Tencent诊断、proxy/线路/disabled engines调整、质量/日期/robots门槛下降、release orchestrator重写或A schema再定义。当前phase无安装/测试/工程写入/GitHub发布/live请求/SSH/envsecret读取；P0/P1既有历史不改，不reset/refund/newidentity/newquark。

## Further Notes

- A的canonical contract唯一；C只编排B的readonlyhealth/one-shot evaluator接口。#103保持OPEN作为索引，future needs-triage；独立审批前非ready-for-agent，不生成实施任务/执行卡。
- Stage2中断前未形成完整completion收据；本轮显式同会话 `/to-tickets` command-name/技能正文已提供，仅执行指定docs RED修订与ticket map。之前Skill(to-spec) disable-model-invocation失败不是成功；Stage2原生入口/模型/会话证据限度引用A。推荐自行确认、无subagents；不按技能默认询问/ready-for-agent/新增发布，而沿用needs-triage和既有三票，由Hermes更新body。
- Stage1已由Hermes发布/读回6158086439；本阶段不做GitHub调用。父已发布/readback downstream-only AI policy适用范围裁定：[6158126091](https://github.com/williamxhero/WAG/issues/103#issuecomment-6158126091)，完整披露与后续fork issue首部/WAG103引用义务见A。不是本writer自行裁定/核验，不修改policy/AGPL、不扩权限，不再标missing human input；A/B/C是AI-authored草稿，非human-written或production收据。
