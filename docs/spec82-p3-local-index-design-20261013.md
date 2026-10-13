# SPEC #82 P3：本地中文索引选型与依赖勘探记录

日期：2026-10-13
所属 SPEC：GitHub Issue #82（WAG 中文优先搜索供给增强）
阶段：P3 设计/勘探，仅离线、可逆；未部署生产索引
集成负责人：default/Hermes

## 1. 目标、范围与模式

本阶段的目标是为已获用户确认的订阅来源设计一个最小、可逆的 SQLite FTS5 与 Meilisearch 对照实验。重点是确认中文召回、入库日期验证、90 天保留、转载聚类和 RRF 融合所需的字段与边界，而不是提前建设生产索引。

本任务服务于 Delivery，但交付物只是一份离线设计和实验计划；不把未完成的 P2 依赖伪装成实现结果。

范围：

- 定义两种候选后端使用同一份规范化离线 fixture 的 schema 映射。
- 设计中文分词/预分词对照、日期安全过滤、保留清理、RRF 与转载聚类的可测指标。
- 定义最小实验、可逆切换方式、验收证据和停止条件。
- 记录当前 P2 证据和本地工具勘探的限制。

非目标：

- 不部署 RSSHub、Task Center、SQLite/Meilisearch 常驻服务或生产索引。
- 不抓取 91 条来源、源站 RSS、sitemap、文章页面或公众号内容。
- 不读取凭证，不调用付费 API，不创建调度任务，不改共享代理或生产配置。
- 不替用户删改或冻结订阅清单，不冻结 P0/P1 阈值。
- 不实现分词器、爬虫、索引适配器、聚类器或 RRF 代码；本记录只规定离线实验契约。

## 2. 当前证据与前置依赖

P2 的只读交付已经回填 #82：清单解析为 91 条、route 唯一；T1/T2/T3/热榜计数为 22/11/45/13。公共 RSSHub canary `/gov/zhengce/zuixin` 实际返回 HTTP 403，其余 90 条没有逐项探针；91 条 route 的可用性仍为 `unknown`，页面日期均为 `not_checked`。因此本 P3 不把 91 条清单当作可抓取语料，也不从 403 推导其他 route 失败。

现有日期证据约定继续生效：E1/E2 页面发布者日期才能进入可验证链；URL/sitemap 日期为 E3 辅助，feed/API 声明为 E4，不能单独使 strict 结果变为 `verified`。实验 fixture 必须显式包含这些状态，不能只用干净的已验证样本。

进入任何生产实现前必须同时满足：

1. 用户删改后的订阅清单定稿并在 #82 留痕。
2. RSSHub 部署授权、网络出口和频率边界由用户确认；本阶段不替代授权。
3. 存储/维护负责人和备份、清理、故障恢复边界明确。
4. P0/P1/P2 的相关门槛和接口契约已确认；尤其是日期验证输入输出不能由 P3 自行放宽。

## 3. 默认推荐与可逆决策

默认先做 SQLite FTS5 arm，Meilisearch 作为同 fixture 的比较 arm；这不是生产选型结论。理由是 SQLite arm 可在单文件、单进程、离线 fixture 中完成，删除和回滚边界清楚，较适合小电脑上的最小实验；Meilisearch 仍需作为独立比较，以实测中文分词、过滤和资源开销，而不是凭产品印象决策。

两种 arm 必须使用相同的规范化文档、查询集、日期状态、来源等级、聚类键和计时方法。实验产物只包括临时数据库/导出结果和报告，完成后可删除；不接入 WAG 请求路径。

本机只读勘探显示：PATH 中的 sqlite3 为 3.50.6，但该 CLI 没有可用的 FTS5 module；本机也没有 `meilisearch` 可执行文件。该结果只说明当前探针环境不能直接作为候选运行时，不是对目标部署环境的结论。下一阶段需在隔离的、明确版本的运行时中确认 FTS5 编译选项和 Meilisearch 镜像/二进制版本；若需新增常驻依赖，必须重新过授权门槛。

## 4. 规范化离线 schema（拟议，不执行）

规范化文档（两种 arm 的共同输入）至少包含以下字段：

| 字段 | 类型/约束 | 用途 |
| --- | --- | --- |
| `document_id` | 稳定字符串，唯一 | 文档身份；不可用临时行号替代 |
| `canonical_url` | 字符串，规范化后唯一候选 | 去重、证据 URL、回溯 |
| `source_id` | 字符串 | 订阅来源身份 |
| `source_name` | 字符串 | 展示和审计 |
| `source_tier` | `T1`–`T5`/`platform` | 排序权重，不作为日期过滤 |
| `route` | 字符串或 null | RSSHub/来源路由回溯 |
| `title` | 原文字符串 | 展示、分词输入 |
| `body` | 原文字符串或受限摘要 | 分词输入；不要求保存完整正文 |
| `title_tokens` | 预分词字符串或 token 数组 | SQLite FTS5 预分词 arm；Meili arm 保留同一逻辑输入用于对照 |
| `body_tokens` | 预分词字符串或 token 数组 | 同上 |
| `language` | `zh`/`zh-Hant`/其他 | 查询扩展与分组 |
| `published_at` | ISO 8601 或 null | 仅 E1/E2 页面证据可填入验证字段 |
| `published_on` | `YYYY-MM-DD` 或 null | 日精度 strict 比较 |
| `date_precision` | `instant`/`day`/`month`/`unknown-timezone`/null | 防止把日精度伪造成时刻 |
| `date_evidence_level` | `E1`–`E5`/null | 日期证据审计 |
| `date_status` | `verified`/`claimed`/`unknown`/`out_of_window`/`blocked` | strict 过滤只允许 `verified` |
| `evidence_url` | 字符串或 null | 日期证据回溯 |
| `checked_at` | ISO 8601 或 null | 验证时间 |
| `fetched_at` | ISO 8601 或 null | 获取时间，仅用于审计/兜底保留 |
| `indexed_at` | ISO 8601 | 入库时间 |
| `expires_at` | ISO 8601 | 90 天清理边界 |
| `content_hash` | 稳定哈希或 null | 内容变更检测，不用于身份替代 |
| `cluster_id` | 字符串或 null | 转载簇身份 |
| `cluster_role` | `representative`/`member`/`unclustered` | 展示与质量指标 |
| `cluster_size` | 非负整数 | 聚类诊断 |
| `simhash` | 固定位宽字符串或 null | 聚类输入/回溯 |
| `ingest_status` | `accepted`/`rejected`/`quarantined` | 入库结果审计 |

建议的逻辑索引/约束：

- 全文只索引 `title_tokens` 和 `body_tokens`；`date_status`, `published_on`, `source_tier`, `source_id`, `expires_at`, `cluster_id` 是结构化过滤/排序字段，不混入全文 token。
- `canonical_url`、`content_hash`、`document_id` 不因后端不同而改变语义；后端内部主键可以不同。
- `date_status=verified` 必须同时有允许的证据级别、有效日期和 `checked_at`；`E3`/`E4`/无日期只能是辅助或非 verified 状态。
- `ingest_status=rejected` 不进入可检索集合；`quarantined` 可保留在审计表，但不得进入 strict 结果。

### 4.1 SQLite FTS5 映射

离线实验的建议表（伪 DDL，仅用于设计）：

- `documents`：保存上述非全文字段和原文/摘要。
- `documents_fts`：FTS5 external-content 或独立表，列为 `title_tokens`, `body_tokens`，并保存 `document_id` 关联值。
- `source_documents`：可选的来源/路由元数据表。
- `rank_observations`：每次查询、每个来源/后端的 `query_id`, `document_id`, `rank`, `raw_score`。
- `cluster_observations`：`cluster_id`, `document_id`, `role`, `simhash`, `cluster_size`。

FTS5 默认 unicode61 是否能满足中文词边界不能假定；实验必须比较“后端默认输入”和“应用侧预分词输入”两种明确 arm。若目标 SQLite 构建没有 FTS5，实验应记录 capability gap 并停止，不通过增加生产脚本或临时插件绕过。

### 4.2 Meilisearch 映射

使用与 SQLite 相同的规范化字段作为文档 JSON；将 `document_id` 设为稳定 primary key。只把 `title_tokens`/`body_tokens` 和必要展示字段放入 searchable attributes；将 `date_status`, `published_on`, `source_tier`, `source_id`, `expires_at`, `cluster_id` 设为 filterable attributes，将展示和排序需要的字段设为 sortable/displayable。具体设置必须绑定实验所用 Meilisearch 版本并在报告中记录，不能把未实测的中文 tokenizer 行为写成保证。

Meilisearch arm 仅在隔离实例运行；实验结束删除实例和数据卷。不得因“需要比较”而写入现有部署、开放端口或创建常驻任务。

## 5. 最小可逆 fixture 计划

不抓取真实来源。由手工/脚本生成一份版本化、无凭证的合成 fixture，建议 48 条文档和 24 条查询，足以覆盖边界而不声称代表 91 个来源：

- 24 条中文新闻/政策文档：含分词歧义、专名、数字、繁简体、英文缩写和同义表达。
- 8 条同标题或近标题转载：至少 3 个来源层级，预置 2 个转载簇和 1 个不应聚类的相似标题对照。
- 4 条公众号/平台形态文档：只用于字段和过滤测试，不表示真实平台可抓取。
- 4 条境外中文/繁体文档：测试语言字段和繁简查询扩展。
- 4 条噪声文档：侧栏/评论/相关推荐日期、错误日期或正文无日期，必须保持 `unknown`/`blocked`，不能成为 strict 命中。
- 4 条边界文档：窗口起点、窗口终点、未来日期、90 天到期点。

每条 fixture 预置人工期望标签：`relevance_grade`、期望查询集合、`expected_date_status`、`expected_cluster_id`、`expected_representative`。fixture 还应包含相同内容的 URL 规范化变体、重复 feed item 和缺少 `published_at` 的记录，以验证幂等和拒绝/隔离行为。

fixture 文件只包含公开的合成文本和固定时间戳；不得复制真实文章正文、真实用户数据、凭证或未授权抓取结果。

## 6. 最小 benchmark 矩阵

每个 arm 在同一机器、同一 Node/Python/后端版本、同一冷/热缓存条件下各运行 3 次，报告中保存原始计时和版本信息，不把一次运行当成稳定结论。

### 6.1 中文召回与分词

- 查询类别：精确词、无空格中文短语、长尾专名、数字/英文混合、繁简变体、同义词、来源限定。
- 指标：`recall@10`, `MRR@10`, 命中文档数、未召回查询数；另记录 tokenization mismatch（期望概念被拆散或粘连）。
- 对照：SQLite 默认 tokenizer、SQLite 应用侧预分词、Meili 当前版本默认行为；不能混用查询扩展或排序参数而不记录。
- 质量闸门：任何候选若在包含明确期望命中的 fixture 查询中产生 0 召回，必须解释为分词/字段/过滤问题并修复或标记不适用；未达到预先冻结的质量阈值时不选为生产方案。阈值由 P0/P2 后续确认，P3 不擅自降低 #82 原阈值。

### 6.2 日期安全与窗口过滤

- 构造 verified、claimed、unknown、blocked、out_of_window，以及日精度/无时区/冲突日期样本。
- 对 strict 查询检查：结果必须全部 `date_status=verified`，窗口边界符合 `published_at`/`published_on` 精度语义，E3/E4 不得漏入。
- 验收证据：0 条未验证结果漏入 strict；0 条未来日期被当作当前已验证；每条被排除文档可解释原因。

### 6.3 90 天保留与幂等入库

- 运行一次重复导入、一次更新同 URL、一次过期清理和一次重启/重新打开数据库（SQLite）或重新建立隔离索引（Meili）。
- `expires_at` 优先按有效发布日期计算；无有效发布日期的隔离记录使用 `indexed_at` 作为有界兜底，且仍不可进入 strict。清理只删除 `expires_at < now`，对边界点使用固定时钟测试。
- 验收证据：重复导入不增加逻辑文档；清理后 100% 过期记录消失、0 条未到期记录误删；审计统计保留删除计数和原因。

### 6.4 转载聚类与 RRF 所需字段

- 对每个 query/arm/source 保存 `query_id`, `document_id`, `source_id`, `rank`, `raw_score`, `cluster_id`, `cluster_role`, `source_tier`。
- 离线用固定公式计算 RRF（例如记录 `k`、各路 rank 和 tie-break 顺序），检查重复执行结果字节级/排序级稳定；公式参数在实验开始前固定，不能为某个后端临时调参。
- 验收证据：每条返回结果都能追溯到来源与原始 rank；合并后可解释独立来源数；同一转载簇的代表和成员关系可回溯；同分时按固定 `source_tier`, `published_at`, `document_id` 规则稳定排序。

### 6.5 资源与运维观察

仅测离线导入、查询、批量删除的 wall time、数据库/索引大小、峰值内存和失败可恢复性。这里不先设未经用户确认的硬资源承诺；若任一 arm 需要常驻服务、额外外部网络、未授权凭证或无法在隔离环境清理，直接标记为本阶段不适用。

## 7. 选择、回滚与停止条件

选择规则（仅适用于实验结束后的候选结论）：

1. 先过安全正确性：strict 日期过滤、90 天清理、幂等导入和可追溯字段不得有未解释失败。
2. 再比较中文召回/分词、延迟、内存、索引大小和维护复杂度；只在同一 fixture、同一查询集上比较。
3. 若质量接近，优先 SQLite FTS5 单文件方案，理由是本地部署面和回滚面更小；若 SQLite FTS5 在目标构建不可用或中文召回明显不达标，才考虑 Meilisearch。该偏好不是跳过实测。
4. 结论必须写明 fixture 规模、版本、配置、原始指标和未知项；不能以合成 fixture 证明 91 个真实来源已经可用。

立即停止/不晋级条件：

- 任一候选无法保证 strict 结果只含 `verified`，或无法验证 90 天删除边界。
- 目标运行时没有 FTS5，或 Meilisearch 需要未批准的常驻服务/端口/存储运维；记录 capability gap，不添加生产 workaround。
- 需要抓取真实 91 条来源、读取凭证、部署 RSSHub/Task Center、修改生产配置或绕过反爬才能继续。
- P2 清单未由用户定稿，RSSHub 部署授权或存储维护边界缺失。
- 聚类/RRF 字段无法逐条回溯，或重复运行排序不稳定且无明确修复方案。
- 实验结果只在某一后端私有字段/私有排序参数上成立，无法保持共同输入和可逆切换。

回滚：实验只使用临时 SQLite 文件或隔离 Meilisearch 数据卷；删除文件/数据卷即可回滚。不得执行生产 schema migration、替换现有搜索路径或开启常驻服务。

## 8. 验收证据、部署/合并结果与限制

本阶段设计验收标准：

- 本记录明确目标、非目标、P2/RSSHub/存储依赖、SQLite FTS5 与 Meilisearch 的最小可逆实验、中文分词、入库日期验证、90 天保留、RRF/转载聚类字段、选择规则和停止条件。
- 本阶段不产生生产代码、生产配置、常驻任务、外部抓取或凭证副作用。
- 选型结论在实验实际运行前保持“未决”；本记录的 SQLite 优先只是可逆实验顺序建议。

实际已完成的只读核验：读取 #82 及最新 P2 回填；读取现有 `gateway/news-verified.mjs` 与 `gateway/news-feed.mjs` 的证据语义；检查本机 `sqlite3`/PATH 工具。未运行 Meilisearch，未执行真实 feed/page/API 请求。

测试/验证：本任务为设计记录，无源码改动，因此没有可宣称通过的代码测试。对现有 P2 交付的测试结果以 #82 原评论为准：focused news tests 32/32 通过；全量 `npm test` 为 404 项，其中 376 通过、25 失败、2 cancelled、1 skipped，不能报告为全量通过。

部署/合并结果：无部署、无生产变更、无合并；本记录作为 P3 离线设计交付，待用户门槛满足后才能创建实现卡。

限制：未确认目标主机的 SQLite 编译选项、Meilisearch 版本和中文分词实际效果；合成 fixture 不代表真实来源质量；91 条订阅仍未逐源抓取或日期抽样。上述未知项必须在授权后的独立实验中补证，不得提前填写为通过。
