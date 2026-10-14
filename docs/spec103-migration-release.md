# SPEC103-C — WAG 保守迁移、一次 release check、兼容回滚与真实验收

## Problem Statement

仅有native保护和WAG诊断仍不足以发布：canonical legacy账本由root拥有，native服务UID999/GID988无法直接使用；父已补核目录外anchor metadata，但值一致性尚待未来授权核验。当前overlay apply/verify/restore和healthcheck/eval-release会多次搜索，release rollback还可能恢复不含native gate的程序。现WAG CI未provision真实fork，fork CI只监听master，green/skip不能证明wag-production exact HEAD或生产共享保护。

发布必须保存旧identity/三笔历史与CAPTCHA/unknown，明确跨UID路径权限与artifact生命周期，把代码回滚和状态回滚完全分离。

## Solution

作为WAG集成scope，调用A唯一migrator/store/claim/API与B零搜索readiness/真实拒绝入口；交付有限migration/recovery runbook、artifact绑定、durable release-attempt一次search/质量证据、compatible rollback和隔离演练/CI收据。**不重写release平台、不创建第二套schema，不把offline positive send当production通过。**

状态：**draft / needs-triage，全部未来AC NOT RUN。** 本delivery ticket为[WAG #108](https://github.com/williamxhero/WAG/issues/108)，Blocked by [A fork #1](https://github.com/williamxhero/searxng/issues/1)及[B WAG #107](https://github.com/williamxhero/WAG/issues/107)；同仓parent [WAG #103](https://github.com/williamxhero/WAG/issues/103)保持OPEN/integration index。父已登记issues/needs-triage/native parent/dependencies，本轮未GitHub核验或更新；修订供Hermes更新原body，不新增issue/card。Hermes独立审批/协调执行，预建todo卡非审批，本writer不建卡、不部署；跨repo parent只用URL。

## User Stories

1. 作为发布负责人，我希望native与probe使用同一外部canonical state，而不是各有freshDB。
2. 作为历史账目owner，我希望chinaso2/quark1、旧clock/unknown/poison/strikes/pause完整保留，不因schema升级遗失。
3. 作为服务维护者，我希望UID999与已核准的WAG/probe身份最小权限共享，而不是sudo fallback或world writable。
4. 作为发布人员，我希望缺anchor/身份不符/权限失败就停，不借修路径生成新token。
5. 作为release操作人员，我希望apply/verify/restore/restart/core health可以重入，却不能反复public search。
6. 作为evaluator用户，我希望唯一合法搜索保留真实质量证据，后续验证不重搜也不降低断言。
7. 作为维护者，我希望rollback只退程序/配置，不退款、不退DB或消除pause。
8. 作为operator，我希望不兼容的旧fork不能重新裸发，回滚hold/degraded也要如实报告。
9. 作为reviewer，我希望迁移/权限/crash/restart演练只用synthetic state与loopback，但确实有成功发送。
10. 作为CI owner，我希望wag-production与WAG实际HEAD都执行真实native离线gate，不能接受empty rollup/skip。
11. 作为用户，我希望公开live gate只有另行授权后有界执行，不自动追加quark或provider请求。
12. 作为release reviewer，我希望robots/safety/date/supply/quality与原人审门槛仍单独成立，工程绿不能自动放行。
13. 作为维护者，我希望runtime identity/路径/provenance未核验被列为明确准入前提，不要求用户重复登录或安装设计平台。

## Implementation Decisions

### C1. 唯一contract、输入及外部生命周期

**canonical schema、枚举、计费、clock、migration/recovery、claim/ingress/evidence仅由[A fork #1 的 A1–A6](https://github.com/williamxhero/searxng/issues/1)定义。** C调用，不复制DDL或自行决定新namespace；B负责gateway/probe/healthcheck/evaluatorconsumer。以下是编排与验收，不另造core。

固定base：WAG main `96b4cba0b4b3796d4479365119c43017584d8bf3`；fork wag-production `9fea41204fdfa7a5cfa15b0ebd12904c520478ce`。C独立WAG owning worktree，在A/B批准接口并合入后serial integration，Hermes协调所有权，不与B并发同文件。fork源实现只由fork owning session处理；本设计session不写fork。没有Windows checkout/失败bootstrap cache/new master。

父只读事实（**非本轮现场核验**）：native服务active、UID999/GID988；root ledger root0700 UID0/GID0，内部lock0600、identity0644/32bytes、ledger.sqlite0644/24576bytes，actual legacy四表/三笔、quarkuntil是旧mono。父后续补核目录外anchor为UID0/GID0、0600、32bytes，未读值；与内部identity是两个真实路径。未来authorized gate仍须核current metadata及state/internalidentity/anchor值一致性，不输出值、不从metadata推定byte-equal。WAG仓库unit声明User/Group=yosef，但**不据此推断actual UID1000/probe身份**。

artifact install目标为root控制的外部 `/opt/wag-searxng/artifacts/<artifact_digest>/`，readonly code/native source/packagedtraits/dependency环境与非secretmanifest；不随WAG release tree swap删除/覆盖。批准Python executable固定路径与实际resolved二进制摘要（venv正常解释器symlink须显式批准target，不允许任意跳转）；B CLI、probe和native导入的保护package必须同artifact/module digest。无新服务、无额外单独保护venv假设；在既有SearXNG artifact环境内包含同一个stdllib包，WAG通过固定解释器使用它。批准artifact之间切换不重建state；至少保留一个schema-v2-compatible rollback artifact。

非secret `config/searxng/protection-artifact.json`（拟新增）由C写入approval manifest引用：exact fork commit/artifact digest、approved解释器/module root、registry/config allowlist digest、contract与canonicalroot；数据类型按A规范，C不定义新version。不能留`latest`/movingbranch/空hash作为可放行配置。不把identity值或env/secrets写manifest。

### C2. Cross-UID access与迁移步骤（仅设计，不执行）

root controlled专用组（建议名称wag-outbound，实际GID在授权迁移前登记），仅已验证native UID999、实际WAG/probe cooperative account及maintenance actor加入；不因GID988存在直接把它当共享组，也不自动给予任意UID1000权限。

目标权限沿A storage协议：canonical root root:专用组/setgid2770、lock/ledger0660、identity0640，目录外anchor root:专用组0640，parent /var/lib不可由caller改写；journal由setgid/受控umask0007产生，包每次验证group/mode/regularfile/nosymlink/root+identity。目录是trusted cooperative writers边界，不宣称可以防止恶意同组删除/写DB；anchor由root控制且在不可写parent，缺失/替换发现就failclosed。

用户已授权自己的fork源码开发及独立验收后的受控deployment，不要求重新同意所有例行发布/只读API。迁移在Hermes核准具体window与安全前提后按顺序执行；跨UID权限、停止sender、不兼容rollback等严重动作按既有授权边界单独评估，本轮无执行权限：

1. 核验exact service/package/manifest及actual UID/GID、组、unit硬化、解释器路径。不凭源码unit或父历史推断当前runtime一致；该核验在已批准受控deployment的独立验收流程中完成，不重设例行用户授权关卡；本轮不读现场。
2. 停止所有cooperative send入口（native/probe、WAGinteractive/eval/release/运维自动搜索），证明后台sender已终止；不只停前端线程。取得原flock与root维护权限。若停止证明不足，A unfinished拒绝，不能迁移后先试一次。
3. A migrator以原canonical path/anchor/state验证schema、quick_check/identity/root/clock与parent继承历史。read-only backup若父授权仅为forensic evidence，**标记never-admission/never-restore**；不另copy live namespace、不把backup用于退款。没有anchor或identity差异就停，不initialize。
4. 调用A transactional legacy→v2 importer，保留原token/root/checkpoint/rowid/clock/NULL/poison/旧三笔与pause/strikes；quark operator_hold独立保留。新schema提交失败留旧DB并保持发送hold；不要求运行native“试一下”。
5. root在所有writers停止且持同lock时受控调整group/modes；lock文件inode不替换，权限变更failure保持hold。standalonepermissioncheck不会发送；不能read失败就sudo/freshroot回退。
6. native与WAG unit的SupplementaryGroups/UMask以及必要ReadWritePaths最小drop-in生效，核验 `/var/lib/wag-route-probe` 与目录外anchor可访问；只读snapshot与有界maintenance schema-validation，不做engine请求。既有unit ProtectSystem/full、ProtectHome等安全约束保持；若mount namespace拒写state，授权owner添加精确state目录的write exception，不放开整个/var/家目录。B snapshot与ingress均通过同包，Node不直接解析SQLite。
7. 核对A compatibility manifest，enabled native `/config` descriptor与B core-ready zero-search可达；批准后的canonical只读历史核对不输出identity值。迁移/权限/包gate全部满足才能进入后续explicit release claim，不自动public sampling。

native `searxng.service` drop-in由目标服务授权owner在以后window执行；C提供runbook/受控模板，不直接在另一个source repo改unit。WAG现 `systemd/web-access-gateway.service` 最小SupplementaryGroups/UMask/manifest path/必要write exception由C拥有；不借机动auth/envsecret文件、proxy或otherunits。service账号不提权为root。

reboot/clock recovery调用A `recover` 并记录独立authorization与停止证明，先保留旧checkpoint/poison/charge/pause审计再保守重锚；未授权始终failclosed。此路径不兼作迁移时清clock，也不提供reset命令。quark pause expired不能解除operator_hold。

### C3. Durable release-attempt与一次搜索闭环

top-level `release.py` prepare在transaction/state.json生成一个32hex release_id并fsync持久保存；它调用的overlay prepare继承该ID并写入overlay backup/state.json，不另生成。只有独立standalone overlay prepare作为新的top-level attempt才生成一个ID；nested prepare拒绝missing/mismatched ID，不退回standalone生成逻辑；同attempt所有apply/verify/restore/restart/healthcheck/eval-release传同ID。已有pending/restored记录不生成新ID“修复”；缺字段/非法/超时与fingerprint不符→not_checked/hold，不能偷偷prepare新的attempt。canonical claim持久在A store，release journal被rollback也不能把claim恢复未消费。

将目前 `searxng-overlay.py healthy()` 的ss/listener+30次search循环改为有界**listener+`/config`只读等待**；原最多30/1s的等待上限和overall deadline保留，actual config/provenance校验不可删。apply/verify/active restore都不search。standalonewrapper同样仅core/config；没有明确批准的release publiccheck不补发。C不直接重改B healthcheck文件。

流程默认：

1. prepare批准artifact、配置snapshot、release_id、非secretfingerprints与已有safe_configuration/provenance，拒stale/supersededtx；canonicalstate/anchor不在snapshot/inventory里，禁止恢复它们。
2. 只在A保护已ready/identity迁移完毕前提下切native配置/兼容artifact；启动engine只允许A reviewed本地init。新native和WAG code接线完成、B core-only实际零search通过后，才允许explicit public check。旧WAG存在时不会在overlay apply先search。
3. C的有界helper `scripts/searxng-release-check.py`（拟新增，thin orchestrator）调用A claim/run_release_check；一次operation通过现authenticated MCP web_search→B one-ingress/onebackendtransaction→A native attempts。helper不实现SQLite/secondHTTPengineclient，不持flock跨RPC，不回收claim。total publiccheck≤10s含claim/MCP/body/report，native仍≤3s，各阶段不续时。
4. 用B提供的one-shot evaluator入口保留同一response的原quality evidence section（existing reports directory，publicresults正常source URL可用于quality，不进canonicaldiagnostics）；A record counts/status/quality_evidence_digest。可在同explicitoperation里运行现bounded example.com/proxy诊断，作为独立egress evidence，而不是engine supply证明；无默认/轮询egress流量。此项具体livebudget/stopconditions须经Hermes核准，沿用已有受控deployment授权而不重问全部例行发布；本轮NOT RUN。
5. 同ID再次verify/fullhealthcheck/apply/restore/restart只读A snapshot +绑定artifact。B release evaluator复用同一次artifact重跑原断言，不重调web_search；C `eval-release.sh`传该ID/path而不是先full healthcheck又制造新search。missing/stale/refused/failed/empty/unknown均不retry-to-fill，也不调用provider换结果。
6. completed zerohit/partial/pause/rate/storage等→public degraded/not_checked/failed evidence；core依据真实core检查，不为第三方publicfail自动rollbackcore，也不把activated=productionpassed。原releasegate与#49/#60/#74/#82质量/日期/供给及人工finalgate仍单独阻断promotion。

全attempt search transaction总数≤1，MCP/request失败也消费；这一个transaction的最终category refs、connect/CONNECT/header等仍按A逐attempt限制，transaction1不是send1。无explicitID的fullhealthcheck只看已批准证据，不创建claim；service restart/timer/watchdog不得auto-newrelease补预算。

later live gate若获授权，搜索输入必须是父审阅的无bang固定query、明确合法engine、**不带additive categories**；用真实fixed webadapter先在isolated source验证resolved refs。当前WAG buildSearchParams只发送显式categories/engines（无默认categories），可以传审阅的 `engines=chinaso news` 而省categories，但仍需确认实际resolvedconfig/prefs。任一展开quark/unknown/disabled在native发送前拒绝；quark production operator_hold永远优先于elapsed pause。不能据此声称新live采样已允许或结果一定满足domain/supply。

### C4. Rollback与状态不回滚

- restore运行现stale/supersededtx校验，恢复配置/服务行为、记录各阶段失败并保持retryable journal；不覆盖/删除A canonicalDB/identity/anchor，不复制旧ledger回来，不重置release_checks/strikes/history/unknown。
- 新配置rollback到旧配置意味着fingerprint变化；已消费claim仍消费，但旧publicevidence不得移花接木成currentpass。可重复B core/config checks，不再search；public_unknown/degraded诚实保留。
- 回退artifact必须属于manifest批准的schema-v2-compatible protectedset，能够继续使用同identity/core。若只有pre-A legacy/unprotectedfork，**stop/hold native search服务**，保留state与artifact，报告core/public实际降级，不能在原服务裸发状态下宣称rollback成功保护。
- WAG降回pre-B版本时，也不能让old /readyz/overlay/eval隐藏搜索穿透：保留compatible B caller层或停止其search/运维调用并hold。不能仅因为native有gate就接受回退caller会不停耗预算；不把hold当供给healthy。
- migration是forward-only；旧程序若不识别v2拒绝，不自动down-migrate。compatibleartifact代码rollback不等于schemarollback。partialpermission/migration/claim/reportfailure均保留审计并人工/父独立审阅恢复；没有“retry publiccheck”快捷路径。

### C5. Artifact provisioning、exact-head Linux CI（G4/G5 定稿）

当前phase不安装/下载/跑CI；后续工程的有限计划如下，不要求用户重复登录/手输凭证，也不因WSL缺Node/Claude/Linuxgh而安装设计平台。

1. A负责fork最小integration trigger：保master，加wag-production push/PR；在现Python3.11–3.14 Linux/corejob显式运行newprotection offline suite及existing回归。wag-production不要牵动theme publishing/container/data-update/l10n/外部bot；必要themejob仅保原master路径，A-owned workflow说明condition。不能以一个不运行tests的emptyrollup算forkCI。
2. C负责WAG CI最小job/step（`.github/workflows/ci.yml`）：checkout实际WAG testedHEAD + nonsecret approvedmanifest声明的exact fork artifact/commit，**不能 checkout moving master/default branch**。provision锁定existing依赖与A包一次，跟deterministictest阶段分开；不安装Node/Claude/gh到本地WSL。forkhead approval输入缺失/错误视为BLOCKED而非skip-green。
3. `scripts/spec103-native-acceptance.py`（拟新增thin offline launcher）只接受显式artifact/manifest/disposable evidence root；生成synthetic settings、装载真实fork/packagedtraits，调用A/B existing testseams；非loopbacksocket硬拒绝，记录actualadmittedpositive sends/rows、fork&WAG HEAD与依赖digest。不是AST/stub/另建core，不能启动生产服务或读生产.env。
4. WAG job继续当前Node22与Python3.12、locked gateway/browser/crawler provisioning、serialgateway/proxy、scripts、crawler及syntaxchecks；额外job使用同锁定artifact运行mandatory native/probe positive tests。现WAG_ROUTE_SOURCE可skip的普通test不删除/伪改为pass；**mandatorygate先验证该输入与runtime，任何目标nativecase skip或positive count0就失败**。
5. 至少Python3.12的WAG↔forkintegratedartifact gate与A native-supported版本gate通过；依赖ABI/HTTP trace缺失、backend安装不完整、只默认transport而漏HTTPmount、SOCKS未知等都按A拒绝/失败记录，不改validtests。provisionedsource读取审阅集中在锁定httpcoreconnect/proxy/trace相关文件，gate验证adapter替换defaultbackend、before-header trace与fallback阻止；不把未来该read当本轮已执行。
6. 保留现CI artifacts标记offline-only，追加sanitizedschema/version/knownunknown/positive counts/exactHEAD/ABI evidence；需要已有与新增requiredjob/check名单非空、workflow确实触发并每个结果成功，artifactbody/commit/hash交叉读回。独立review看真实AC，不凭rollup总绿。provisioning失败/现broad失败/skip如实记录，不禁用测试。

后续Linuxgitpush由父supportedcredentialbridge处理；parent provenance提到Windows git --git-dir UNC只push的可选bridge，本任务不使用它、不做forkGit Windows操作。当前/后续forkread/branch/worktreeGit遵守WSL-only。凭证如何桥接属于parent，不能要求现场secret给设计writer。

### C6. Source/test owned map

| path | C唯一future切片 |
|---|---|
| `scripts/release.py:REQUIRED/provenance,686-708,764-836,prepare` | ID/durableclaim引用、外部artifactpreflight/排除stateinventory、zero-search readiness、publiccheck/evidence绑定、compatible rollback；不改provider安全/预算 |
| `scripts/searxng-overlay.py:207-244,267-303`、`scripts/searxng-apply-overlay.sh:29-47` | listener/config bounded wait、同ID传递、standalone不search、restore no-publicretry，保持merge/operatorproxies/provenance |
| `scripts/eval-release.sh` | 同ID/evidence传递到B evaluator，live模式无第二次search；原offline fixture隔离/secret不trace/安全listenerchecks保留 |
| `scripts/searxng-release-check.py`、`scripts/spec103-native-acceptance.py`（拟新增） | A API薄编排/实际MCP one-shot、隔离exactartifact launcher；无ledger/transport重复实现 |
| `config/searxng/protection-artifact.json`（拟新增）、必要bootstrap/releaseinventory切片 | nonsecretexactartifact输入/manifest path绑定，拒latest/missing；不改engine/proxy配置以凑pass |
| `systemd/web-access-gateway.service` | 最小sharedgroup/umask/manifest引用/必要statepath权限，保现hardened/auth账户；nativeunit仅授权owner实施drop-in/runbook |
| `.github/workflows/ci.yml` | C5新增mandatoryintegratednativegate；不改A forkworkflow、不删现jobs |
| `scripts/{searxng-overlay,deploy,bootstrap}.test.py`（bootstrap仅provision/inventory需要时） | ID/merge/rollback/permissions/artifact/rehearsal；新增two薄helper对应tests |
| 拟新增 `docs/spec103-operations.md`（未来工程文档） | migration/recovery/rollback及laterlive runbook；不是本Stage2第四deliverable |

C不写B的server/search/readiness/eval模块/probe/healthcheck及其tests；B提供可调用接口、父在必要slice冲突时先重新审批，不允许并发同文件writer。A独占schema/package/nativefork所有文件；C不在WAG内复制A库，不改forkpolicy/source。

## Testing Decisions

**以下全部 NOT RUN；没有本轮迁移、permissions、tests、CI或live操作。** 主seam为现release/overlay CLI→B MCP/readiness→真实forkloopback→A store；继承 `scripts/deploy.test.py` coordinatedrestore/provenancefixture和overlaytests，不新建伪production平台。

1. **AC-C1 合成旧账迁移**：严格父four-table fixture、三笔、旧quarkpause、NULL/poison/clock与anchor，迁移后identity/root/原字段/rowid不丢；precommit/postcommitcrash、wrongversion/schema/anchor/readonly/corrupt不fresh-init。取证backup不得作为live admission/rollback输入。fixture/copy成功不写productionpass。
2. **AC-C2 跨UID真实文件访问**：disposable Linux目录中实际root与UID999、synthetic映射的已核准UID1000账号/group调用；成功SQLitejournal/lock/snapshot/reserve/outcome与positive loopback；wrongmember、umask、symlink、inode替换、namespacewrite拒绝时0send。CI若无权限建立roles则该mandatorygate BLOCKED，不用mock权限或skip称pass。对现场权限当前无变更。
3. **AC-C3 多次流程一次claim**：同ID sequential/concurrentapply/verify/restore/healthcheck/eval/restart与多进程：config/listenercalls可重复，MCPone-shot、nativebackendtransactions≤1，真实nativeconnect/headers均按A charged。至少一次合法positiveend-to-end，不能全部refuse。原empty/CAPTCHA/timeout/claim/reportcrash不refund，不newID补搜。
4. **AC-C4 总deadline**：claim/IPC/MCP/body/parser/reportdelay从同deadline扣；corewait可用原独立bounded总预算，但publiccheck绝不每stage延时。10s超时/unknownsender保存unknown、拒绝补operation；known/unknown/actualelapsed报告完整。
5. **AC-C5 评测真实质量**：单searchartifact复用仍执行B原domain/provenance/time/quality断言；count-only/corrupt/expired/mismatch失败不重搜。completed零hit真实degraded、refusalnothealthy、supply/dategate保持失败，不把已activatedruntime标productionpassed。
6. **AC-C6 故障/回滚**：artifactimport/ABI、enabled配置、permission/migration、overlayapply、unitrestart、coreready、claim/publiccheck、recordevidence各阶段失败；compatible程序/configrestore成功但state/history/claim/pause不回滚；不兼容旧fork需停searchhold。stale/supersededtx不能restore；repeatrestore无search、不清unknown。
7. **AC-C7 standalone/继承路由**：standaloneoverlay无ID只core；active restore/coretimer零search；operatorproxy/network precedence、disabled/inactive、additivemerge与原服务配置保留，不能为了测试换direct/启用engine。quarkhold即使until已过仍0send；onlysyntheticpositive fixture可有quarkparser发送。
8. **AC-C8 focused→broad**：先两个thinhelper与overlay/deploy/permissions/mandatorynativefocusedgates，再现全部scripts、serialgateway/proxy、crawler与trackedsyntax及A existingcore/broad；保有效测试并记录所有失败/skip。没有依赖provision或native source就BLOCKED，不能用普通CI绿替代。
9. **AC-C9 exactHEAD证明**：wag-production PR及拟mergeHEAD的A非空Linuxchecks、WAG实际HEAD和exactforkartifact的C mandatory integratedchecks均真实触发/成功，positivecounts>0、hashes/HEAD/versions与approvalmanifest一致；无containerpush/机器人工流作为保护gate。Hermes对AC/source ownedmap/收据独立审核，再安排implementation/release，不由本writer自审代替。
10. **AC-C10 later live gate — NOT RUN / 本阶段未授权**：独立批准exactartifact/受控迁移window/canonical只读核对、actualUID/路径/anchor、compatible rollback、oneID/一次search预算、最终refs/stopconditions；准入未知全部hold。任何quark/unknown/disabled展开、CAPTCHA/state/clock/unfinished、deadline/供给不满足立即停，不retry/refund/newidentity。以真实currentevidence执行原supply/date/quality/robots与人工finalgate；historical三笔、P1canary、mock/CI均不能抵作此pass。

## Out of Scope

当前phase任何安装/测试/工程写入/权限变更/迁移/SSH/现场内容/envsecret读取、GitHub发布、commit/push/PR、部署/重启/publictraffic。新daemon/endpoints/MCP/sharedproxy、release平台重写、unreviewedengine/route支持、验证码/IP逃避、Tencent/P1再诊断、降低质量/robots/date/supplygate。原P0/P1历史与disabled/operator/auth/SSRF/providerbudgets保留；91retainedcandidate不代表releaseadmission。无reset/refund/newidentity/newquark。

## Further Notes

- 长Stage2被owner中断，未形成完整completion收据。本轮用户显式同会话`/to-tickets` command-name/正文授权仅定向修A/B/C与ticket map；不创建issue/card、不gh更新，由Hermes发布修订body。此前Skill(to-spec)失败不是成功receipt；原生/to-spec证据限度与父真实init model/UUID见A。技能默认询问/ready-for-agent/新增发布被覆盖，保持needs-triage、推荐自确认、无subagents。
- Stage1 publication6158086439来自Hermes的exact-readback收据，本轮没有GitHub/API读回。父已发布/readback适用范围裁定：[WAG103 comment6158126091](https://github.com/williamxhero/WAG/issues/103#issuecomment-6158126091)；只限用户downstream fork，完整AI-authored/Hermes独立验收披露见A。后续fork issue首部及WAG103必须引用裁定，不再标missing human input，不假称human-written/用户逐行审过，不删除policy/AGPL、不扩任何工程或部署权限。绝不向searxng/searxng/Matrix提交。
- G1由A窄backend/支持矩阵、真实trace/connectgate收敛；G2/G3唯一Acontract；G4由C1/C2确定artifact/UID/权限与strictgate；G5由C5/Aworkflow收敛为具体非空exactHEADjobs。尚未实测的dependencyABI/productionmetadata不是无限研究分支：失败即BLOCKED，不扩大scope、不替换路由、不放行。
- Hermes是唯一integration/releaseowner；已有用户fork开发及验收后受控deployment授权继续有效，不重设所有例行操作的用户同意关卡。具体跨UID安全权限、不兼容rollback停止等严重动作仍依原授权安全边界评估，具体livebudget/stopconditions、独立AC、原supply/quality与人工finalgate必须满足；本轮没有工程/生产权限。先独立审批，再目标owningsession实施，最后执行经Hermes核准的boundedlivegate。
