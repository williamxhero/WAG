Stage 1 设计检查点已完成（只读源码 + 文档；无实现、测试或现场操作）。实际通过 Skill 调用的是 `grilling`；会话未暴露名为 `grill` 的技能，未伪称 slash 调用。唯一设计 writer Claude Code session `3f2873e1-0e08-47b5-8ddd-d63fd1151d4d`，Hermes 协调；CLI 配置模型 gpt-6.1-sol，不冒称 Anthropic 模型。

推荐并自行确认三份 linked SPEC：A 在 `williamxhero/searxng`，负责唯一 durable core/schema/import 及 native 发送—真实 parser 闭环；B 在 WAG，负责真正零搜索 core readiness、保护拒绝/partial-degraded 传播和不补搜；C 在 WAG，负责保留 canonical identity/旧账的跨 UID 迁移、durable release-attempt 一次 search claim、回滚与真实验收。#103 保持 OPEN 作集成索引，各票先 needs-triage，独立审批后才实施。

已核对隐藏 protocol retry、helper/future 未终止、quark900 与 JSON 翻译丢异常类型等具体 seam。Stage 2 尚须定稿底层连接计费/阻止边界、v2 字段与迁移、机器拒绝协议、包/provenance/权限及 exact-head CI；现 CI/mock 不代表生产保护通过。root ledger 内实际文件为 lock/identity/ledger.sqlite，目录外 anchor 单独保留，不改身份/不退款/不追加 quark。

已读 fork AI policy，发现 human-written issue 条款与未来直接发布 AI-authored fork 文本存在具体冲突，交 Hermes 在 fork 发布前裁定；不删 policy、不虚称人写、不向 upstream/Matrix 发布。完整 Stage 1 检查点：`docs/spec103-grill-checkpoint.md`。本阶段所有实现/迁移/live AC 均 NOT RUN；同一会话继续后续设计阶段。源码授权由 #103 的 6157869034 评论明确给定，本 checkpoint 不撤销授权，也不扩大至现在部署。
