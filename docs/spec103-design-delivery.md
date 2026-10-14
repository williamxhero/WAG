# SPEC103 设计交付收据 — 待独立审阅

## 范围与实际交付

唯一设计 writer 为 Claude Code session `3f2873e1-0e08-47b5-8ddd-d63fd1151d4d`；Hermes 负责执行协调、发布/读回与此收据。init 实际模型 `gpt-6.1-sol`，不冒称 Anthropic 型号。

- A https://github.com/williamxhero/searxng/issues/1 ：canonical v2 schema/API/identity、native guarded transport/processor/parser、同 query 多 engine 串行与共享 deadline、packaging 与必要 fork CI。
- B https://github.com/williamxhero/WAG/issues/107 ：core readiness 真零 search、机器拒绝/partial、MCP/eval 不补搜、probe 同核心。
- C https://github.com/williamxhero/WAG/issues/108 ：保守 migration/跨 UID、唯一顶层 release ID、一次 search/evidence 复用、compatible rollback/CI/后续有界验收。
- 三张已有 SPEC 兼 delivery tickets；`docs/spec103-ticket-map.md` 已发布/读回 https://github.com/williamxhero/WAG/issues/103#issuecomment-6158571754 。无 worker 新建 issue/Kanban 图。父预建 A/B/C 卡仍 todo gated，不因设计发布就批准实现。

所有 issues OPEN / needs-triage。WAG107/108 native parent 为103；107 blocked_by fork1；108 blocked_by107+fork1。跨 repo dependency API 实际可用，不混为跨 repo parent。#103/#82不关闭；旧#103 config-only题名为历史，不撤销6157869034授权及6158126091 downstream policy裁定。

## 真实流程与退出

- Fresh session actual Skill(grilling) 返回成功；暴露名称无 grill，有 grilling。推荐值自确认与理由见 grill checkpoint，不编造用户回答。
- actual Skill(to-spec)曾 disable-model-invocation拒绝，未计成功。随后显式 CLI `/to-spec` 原生加载：transcript `C:/Users/will/.claude/projects/D--WILL-TOOLS-web-access-gateway-proj--worktrees-t-dd6836c1/3f2873e1-0e08-47b5-8ddd-d63fd1151d4d.jsonl` 230/231 为 command-name/skill正文；433有 invoked_skills。不是仅靠模型自述。
- 长 Stage2 proc_16183f65da74 自动compact耗333929ms，后范围过长；owner按父指令终止，工具返回 killed，后ps无原pid25208。未产生正常 completion，不伪称该段成功结束。A/B/C草稿由父先发布避免丢痕。
- 同 session 显式 `/to-tickets` 原生加载：同 transcript580/581为 command-name/skill正文。短目标 proc_dfdd518e7dbc 定向修父RED并产 map，正常 exit0；stream result is_error=false。无并发 writer/新 session/子代理。此流程未进入 implement-spec。

## 实际验证（文档/状态，不是工程测试）

- git status / branch / rev-parse：本任务 WAG base96b4cba，设计 branch wt/t_dd6836c1；fork WSL实际9fea412/wag-production/pristine。
- 读取 AGENTS、issue/triage/domain 与固定 fork AI_POLICY/CONTRIBUTING；保政策/AGPL，不向 upstream/Matrix投稿。
- gh issue edit --body-file 对既有三票更新；gh issue view --json body --template '{{.body}}' 全文读回，三份 `diff --strip-trailing-cr` 全部 exit0。第一次 readback 漏 --json 报usage，修正后才判一致。
- 三份本地/issue正文 SHA256：
  - A `1b043df3574125bd34f88c83f29583c9bc431f314a4bda08f38ef2fffdfc402c`
  - B `684aadc1cc6b2180362c0b565594ea033efedff897d8396c6a9507beb564867d`
  - C `4c190593418184f39d1a29c7343befe93cc8ad732a8e8b461a41a8e5f76f3c50`
- ticket-map issuecomment exact body diff0；nativeparent/dependency APIs逐项真实读回；needs-triage/state逐票真实读回。
- git diff --check 已执行无错误；最终 docs-only stage再核cached diff。不执行实现 tests/lint/build/install/CI，全部 NOT RUN。初次 python -c 日志解析被headless安全门拒绝，未执行/未改变安全配置；改用read/search。

## 父最后新增只读现场补充（未并发改Claude正文）

该补充到达短目标writer运行中，不作为worker现场访问/运行证据。父实际非破坏 preflight：web-access-gateway active User/Group=yosef（actual UID1000），UMask0022，ProtectSystemfull，ReadWritePaths仅artifacts+data；searxng active Usersearxng UID999，UMask0077，ProtectSystemstrict，ReadWritePaths空；两者 SupplementaryGroups空。父只输出 boolean：anchor_internal_equal/state_identity_equal/state_root_equal 全 true，state1row，quick_checkok，无身份值。

C正文39的“值一致性未来待核/不推断actualUID”是此前草稿快照，现已被父上述current-only证据补齐；不能把它当缺人类输入。未来 activation仍必须重新核current metadata/identitybooleans与unit写路径，不能宣称以后恒成立。权限/write-path gap是真实，targetgroup/modes仅设计，未现场chmod/chown/group/drop-in。此current补充由父独立审阅时一并采用；不派新writer重写设计。

## 限制与后续门槛

三票设计接口已具体化，不代表guarded TCP/TLS/stream cancellation/HTTP计数/native multi-engine loopback已经通过。G1 actual dependency/source与conditionalarchitect evidence由父提供，仅source事实；所有 A/B/C AC、CI、migration/recovery、production/live = NOT RUN。本轮未读secrets、未SSH、未读取/复制/写canonicalledger、未生产发送/重启/权限变更；P0三笔/quarkhold/P1canonical7c等保留。

提交独立设计验收；Hermes逐AC批准前不complete本卡释放A，不ready-for-agent，不merge/closeissues。用户已有fork源码与验收后受控deployment授权有效，不重问所有例行动作；具体 livebudget/stopconditions、安全严重动作、原supply/date/quality/robots/人工finalgate仍保留。仅文档commit/push保存已父授权，不是工程合并/部署。
