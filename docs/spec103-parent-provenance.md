# 父只读 provenance 输入（不是 worker 新现场核验）

供 Claude session 3f2873e1-0e08-47b5-8ddd-d63fd1151d4d 阶段继续。仅父提供的事实；worker 不 SSH、不读取 canonical 内容、不改变权限。

生产 searxng.service active：User=searxng UID999，Group=searxng GID988；不要凭 UID1000 假定用户/组。
/var/lib/wag-route-probe root0700 UID0/GID0；目录内实际文件：lock 0600 root，identity 0644 root 32bytes，ledger.sqlite 0644 root 24576bytes。目录内不是 .identity/probe.sqlite。已有代码还定义目录外 lifetime anchor /var/lib/wag-route-probe.identity（scripts/searxng-route-probe.py:500,511），父此次未核该文件内容/权限，不能从目录内 identity 推定 anchor 已核验。设计保留两个不同身份路径并 future gate 只读核对，失败不能初始化。

父以 mode=ro 确认 actual legacy schema：
state(id TEXT, root TEXT, checkpoint TEXT)
attempts(engine TEXT, domestic INTEGER, stamp REAL, outcome TEXT)
pauses(engine TEXT PRIMARY KEY, strikes INTEGER, until REAL)
poison(reason TEXT)

attempts：chinaso news domestic ok 2；quark domestic captcha 1。
quark pause strikes=1，until=8074715.728828768，是旧 monotonic 值，不得当作当前剩余秒/新 wall time。
poison 0；quick_check ok；checkpoint keys wall,mono,boot。
实际 id 内容不输出，不读取，不 reset。迁移须保 id/root/boot/clock/unknown、原三笔及 pause/strikes；跨 UID 文件可访问方案必须被指定 schema/integration owner 控制迁移，不能 root 文件读失败后 freshDB/fallback，不能 fixture/copy作为新的liveidentity。

本阶段这些数值只作继承记录，不运行新测试或迁移，不由 elapsed 时间推导 CAPTCHA 可追加尝试。

父 fixed fork CI 实读：.github/workflows/integration.yml triggers only master，wag-production PR 不会自动跑。A 的 ownedmap 必须含最小 fork-specific Linux exact-head/offline CI（显式新增/扩 wag-production trigger），保原 Python/core 回归覆盖，不依赖 empty rollup；不触发 container publish/data-update/l10n/外部机器人。现在只 SPEC，不改 CI。

WSL network GitHub 只读可用，但无 Node/Claude/Linuxgh 已登录；不为设计安装新平台。Windows Claude 可 Read UNC source/WAG docs，Windows gh --repo williamxhero/searxng 负责下游 issue。以后 Linux push 由父 supported credential bridge 或 Windows git --git-dir UNC .git 只 push（不 Windows checkout），不要求人类重复登录/手输凭证。本阶段不 push。

更新（父后续补核，不是重复现场读）：目录外 /var/lib/wag-route-probe.identity 已实核 metadata：root UID0/GID0，0600，32bytes，未读值。它与目录内 identity0644 是两个不同真实路径；C AC 保原值并验证最小跨UID安全访问。

父已对 AI_POLICY 适用范围作精确裁定并真实发布 https://github.com/williamxhero/WAG/issues/103#issuecomment-6158126091 ，Hermes 读回原文：
协调者已完整核fixedfork AI_POLICY.rst：原文our discussion forums、向upstreammaintainers贡献的上下文，不能据此要求用户重答已明确授权的自己的fork开发。此轮仅用户williamxhero downstreamfork内记录SPEC/PR，文本明确AIauthored(ClaudeCode)/Hermes独立验收，不伪humanwritten、不声称用户逐行审过；原policy/AGPL保持不变。不向searxng/searxng、Matrix提交或向其maintainers转嫁审阅。本裁定是已有用户fork授权的适用范围说明，未豁免upstream规定。设计卡继续真实同会话to-spec/to-tickets，当前工程/部署均NOT RUN。
下一阶段必须在 forkissue 首部及 WAG103引用本裁定，不再标 missinghumaninput，不修改政策、不扩大任何权限。
