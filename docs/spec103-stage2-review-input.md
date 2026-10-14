# 父设计审议更新（同一 Claude 下一轮修订输入，不是第二 SPEC writer）

先读 docs/spec103-parent-provenance.md 新末段：policy applicability 已裁定并 GH103comment6158126091 readback；外anchor已metadata核root0600 32bytes。不再humanblocked或未核anchor元数据；身份值仍未读/不输出。

已批准 userfork/source+验收后受控deploy，C 不重设“用户再同意所有例行发布”关卡；仅具体livebudget/stopconditions/原supply质量/独立验收必须满足，本轮无工程/生产权限。

## G1 父真实部署包source证据（只读，不需要安装）

父 importlib.metadata 定位 packages 无searximport/流量：httpx0.28.1,httpcore1.0.9,httpx-socks0.13.1,python-socks3.0.0,anyio4.14.2,h110.16.0,h24.4.1。
可focusread C:/Users/will/AppData/Local/hermes/cache/scratch/wag103-installed-transport-sources.txt （httpcoreconnection/http2/proxy/anyio backend、python-socksasyncio connect/proxy、httpx-socks transport）。additional完整sources JSON：wag103-anyio-actual-connect.json、wag103-socks-connect-sources.json、wag103-socks-anyio-v2-sources.json、wag103-http11-trace-sources.json，同scratch目录。不是缺依赖源码，不下载/安装/工程测试。
anyio4.14.2 _core/_sockets.py145-265 connect_tcp HappyEyeballs：multiaddr + taskgroup start_soon(try_connect)逐addr/250ms；httpcore AnyIOBackend.connect_tcp 调其，单callback不等于单TCP。
httpx_socks/_async_proxy.py::_open_aio_stream实际用 python_socks.async_.anyio.v2.Proxy（不是asyncio版）；anyio/v2/_connect调用anyio.connect_tcp同多地址问题；只守httpcorebackend漏SOCKS。
httpcore1.0.9 _async/http11.py81-86 awaited async Trace('send_request_headers')后才 _send_request_headers/_send_event；_trace.py atrace async callback被await；_async/http_proxy.py199-204 proxy转发和282-286 CONNECT均继承request.extensions，故同dispatch trace能见 CONNECT/origin 两header。只是source seam事实，取消/streamarm/计数/positive验证仍 NOT RUN。

父实际operator proxy safeenum（不URL/secrets）：outgoing.proxies schemes=['http']，yandex ownproxies=['http']，bing/chinaso/quark无ownproxies继承。早先[]误因为只提str漏list，不能当direct证明。本次direct+HTTP(S) reviewed矩阵覆盖现operatorroute，SOCKSfuturebeforedeny不损当前path，不改route。

focusedarchitect sameprofile只读CLI收据 session20261014_084120_c3a0fb；result C:/Users/will/AppData/Local/hermes/cache/scratch/wag103-g1-architect-inline-result.txt（56lines）。结论有条件可行：fork-owned AsyncBaseTransport桥接 guardedhttpcorepools 所有mount，不假定AsyncHTTPTransport接受backend参数；numericIP单addressconnect避免HappyEyeballs；HTTP1+pre-send asyncTrace（父补核above）；operation/TLSwrap/deadline绑定，direct connect+firstHTTP一row、keepalive新HTTP一row、CONNECT+origin两row、chunk不增。不能depedit/globalmonkeypatch。不等于ACpass。
architect建议逐addr新charge可选，父采用Afirstcompatibleaddress不fallback最小更保守，需记录原因/route/TLS兼容阳性测试。

## G2/G3 父设计 RED 必须唯一 A 规范

父先前A/B快照不一致：B consume_release_ingress / X-WAG-Release-Attempt不可自造。A最新文件可能已经有 ingress_used/API（Hermes实际看到），仍逐项核：claimed→unknown-before-operation→authenticated bound ingress one-time consume0to1→complete/unknown；不unknown全拒、不ordinaryheader忽略让多fetch。唯一A DDL/API/authbinding/deadline/artifactconfig semantics，B/C引用，无secondschema。header缺失/重复/非法caller不可构造额外release事务，不靠请求自己声明classification或claim。
A run_engine context“跨线程失效”与 ContextVar native线程→async必需transfer矛盾：明确同dispatch/同owner合法受控transfer，非任意leak/childfork继承，线程到async合法native能send。取消关闭证明/poison保持。

## 流程实证诚实

CLI以 -p '/to-spec …' 明确原生入口执行；stream中model声称加载，不足以伪造command-name收据，如原生session记录无技能加载证据须如实保留证据限度，不声称Skill成功。actual Skill(to-spec)曾disable-model-invocation失败，grilling Skill实际成功。后续显式/to-tickets同session，不用Skill绕限制，不修改技能。宿主ClaudeCode但init实际model=gpt-6.1-sol，UUID已真实init核，不说未查/Anthropicmodel。

先小范围修A/B/C，发布needs-triage实际issues+ownedmap/native关系；G1 targeted gap/全部futuretests NOT RUN如实标，不无限研究。父独立AC审批后才能implementation，no Kanban graphs byworker。

父 C145line review：C5/C39外anchormetadata已核，值未读分开；C67 只有顶层 prepare 唯一 origin 产生 durable ID，nestedoverlay 必须继承并拒 missing/mismatch，真正 standalone 独立顶层才能产生一次，apply/verify/restore不新 ID。C76 quality_evidence_digest 若A已定义需逐项对齐，不另建schema。C134/145不泛化已批准 controlled deploy为所有例行配置/窗口/只读API需用户重授权；具体跨UID安全权限及不兼容rollbackstop严重动作依原授权安全门槛单独评估。livebudget/独立AC/quality保留。补 native admitted/refused deadline 阳性、old backend卸载相位顺序测试。

父forkActions actual enabled=true/allowedall，但workflowsAPI[]；未来真实PR注册运行exactHEAD验证，不能原master/emptyrollup当绿。AI-policy.yml/cjs过滤first-time非owner贡献者，用户owner不匹配；不虚勾humanpolicy，不加humanunderstands/humanwritten声明，不改政策机器人文件。

父已归档只读G1证据zip到本卡 attachment21（54577bytes），source版本/HTTPtrace/routeenum/interface反例已GH103comments6158126091/6158158425/6158287940/6158297622真实回读；可只引用这些无需再全读巨大sourcehistory。原missingRead/falseactivePR/argv206/str-only错误如实记录，不当通过。父授权本次仅docs commit/push保存，源码不commit/push，不merge/closeissues。

母82 multi-engine design blocker：全域nonblockingflock跨send/parser若保原Search parallel refs每query仅1admitted，其余lock_busy永远partial/不满足多源门槛。选择同query reviewedrefs确定顺序串行：每ref真正reserve前才取flock，前refparse/outcomecommit后调下一ref；no queuedpermit/no sleep/no每ref3秒，同query唯一totaldeadline。跨query/process仍lock_busy拒绝。一次真实native单query>=2engine非空complete/独立rows正向loopback是必测，不把分多query称共同结果、不降≥2独立源/60%母阈值。

父已代真实publish/readback current唯一Claude drafts：A https://github.com/williamxhero/searxng/issues/1，B https://github.com/williamxhero/WAG/issues/107，C https://github.com/williamxhero/WAG/issues/108。Exactmap C:/Users/will/AppData/Local/hermes/cache/scratch/wag103-published-spec-map.json。禁止duplicate issuecreate；same-session修正文后 updateexistingbody，crossrefs换真实URL。父正在needs-triage/nativeparent登记。draft发布不是ACapproved，所有futuretests NOT RUN。/to-tickets优先这三份SPEC兼deliverytickets，少量ownedmap逻辑slice即可，不新增一堆issues，不Kanban建图。
