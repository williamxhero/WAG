# SPEC82 当前验收与暂停边界

SPEC 真源：https://github.com/williamxhero/WAG/issues/82
集成负责人：default/Hermes。目标为中文搜索稳定供给及页面级 strict 日期证明；当前为 Delivery 中的离线准备阶段。

P0/P2/P3 子卡仅交付只读报告/离线设计，不等于总 SPEC 完成。P1 骨架也不等于三个真实 adapter 已接入。

## 本次独立核对

- P0 报告 strict 样本实际为 `categories=general,time_range=day`，已与原始40条 strict记录核对。限速为每引擎每分钟6次、全部中文引擎合计30次，报告中误写“每中文引擎30次”已纠正。WSL overlay focused测试12/12通过。已有120次样本不含直连/代理对照，不能证明出口因果。
- P2 清单91行、91唯一路由，名称/路由/source_line逐条与用户原始清单核对通过；所有路由unknown、日期not_checked。只有一条公共RSSHub canary实际返回403，不能推广至其余90条。focused测试32/32通过；前轮协调者重跑gateway报告419 pass、0 fail、1 skipped，worker的环境失败保留在原报告作为历史记录；集成PR仍须独立CI验证。
- P3设计覆盖共同schema、中文召回对照、日期过滤、90天保留、RRF/转载聚类、停止条件和回滚。没有实际benchmark结果。按#82，feed/API日期均为E4，不能单独verified；归档设计已去除“允许的feed item证据”可填验证字段的歧义。
- P1独立审查发现默认阿里/腾讯日上限为Infinity，与SPEC20/12不符；缺失费用估算默认零费用可能绕过月预算。已退回原worker修复，修复通过前不可合并。

## 未完成事项和真实门槛

- 三家API凭证和账号开通由用户管理；未读取、未创建或调用真实API。未把¥10预算授权等同于已有凭证。
- 首批订阅清单必须由用户删改定稿；当前v0不能擅自冻结为生产订阅。
- P0直连/代理生产切换、overlay应用、升级/重启，以及RSSHub/Task Center/索引生产部署，当前协调边界明确不执行；只读核验与离线设计已经进行。
- 阈值需要按SPEC做基线校准并由用户确认；本次没有中文golden set基线，不提交伪造阈值冻结报告。
- #49/#60/#74供给门禁未通过，保持开放；不将离线报告、短时健康或单引擎结果冒充多源/日期质量达标。

## 流程记录

本轮重新加载dev-workflow-rules、GitHub与Kanban工作流。goal-guardian当前skill_view返回not found，现有skills/plugins中未找到可读副本；本轮依照既有SPEC目标与边界继续验收已经授权的工作，不创建替代goal注册表。早期SPEC和拆卡已由协调者直接登记，未获得Claude完整工作流执行证据；如实保留这一偏差，不宣称已跑完/grill或/to-spec。本轮只补验收、归档和已授权的交付收尾。

本PR为离线证据归档；无生产部署，无运行时路由改动。合并结果与最终CI以#82后续回填为准。
