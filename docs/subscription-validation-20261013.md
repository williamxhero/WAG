# 订阅清单 v0 首轮只读核验与中文日期证据设计

日期：2026-10-13
SPEC：GitHub Issue #82（P2）
输入：`C:/Users/will/Downloads/订阅清单 v0.md`
结构化逐条结果：`docs/subscription-validation-20261013.json`

## 结论

输入清单解析为 91 条候选：T1 官方 22、T2 央媒与通讯社 11、T3 市场化媒体 45、平台热榜 13。91 条 route 均唯一；每条候选保留原始名称、级别、分组、route、注意事项和源文件行号，映射可追溯。结构化结果里的路由状态统一为 `unknown`，日期状态为 `not_checked`，不是通过或失败结论。

只读探测 `GET https://rsshub.app/gov/zhengce/zuixin` 实际返回 HTTP 403（Cloudflare）。这是公共实例拒绝/限制本次探测的证据，不证明路由不存在，也不证明任何其他路由可用。输入文件虽记载路由已在 2026-10-13 版 RSSHub 源码确认，但本次没有独立逐路由源码核实；该历史声明不等于 feed 可抓取成功。RSSHub、源站 RSS 与 sitemap 对 91 项均没有真实响应证据，因此不得将其标为可用。没有部署 RSSHub、调用付费 API、读取凭证或改生产。

## 候选状态字段

逐条结果采用以下审计字段：

- `name`, `tier`, `group`, `route`, `note`, `source_line`：从用户文件原文映射而来；以 route 和 source_line 维持对照关系。
- `route_discovery.status`: `unknown` | `available` | `unavailable`。本轮全部 `unknown`；`available` 仅能由真实成功响应支持，`unavailable` 需可复现的路由/源站明确失败证据，不能由 403 泛化推出。
- `route_discovery.probe_scope`、`reason`：标明本轮探测范围和未能确立的证据；本轮仅有一条 canary 探针，不表示其余路由逐一请求。
- `date_evidence.status`: `not_checked` | `observed` | `blocked`。本轮全部 `not_checked`，因为没有抓取到条目或页面；后续单篇样本受反爬/渲染阻碍时用 `blocked`，而非伪造日期命中率。
- `date_evidence.classification`：成功获取页面后记录 E1/E2/E3 的逐条观察和原始字段，不由 RSS 声明日期自动推导页面证据。

## 复用的证据模型

仓库已有 `gateway/news-verified.mjs` 和 `gateway/news-feed.mjs`，无需重写现有提取器：`aggregatePublisherEvidence()` 消费 `extractPageEvidence` 的 HTML 发布者证据，`feedItemEvidence()` 只接纳 feed item 发布日期；feed-level `lastBuildDate`/`updated`、搜索时间、HTTP 日期、URL 日期不会晋升为 verified。页面日期证据可沿用 `news_evidence` 字段：`status`, `source_kind`, `source`, `verified_eligible`, `published_at`, `published_on`, `precision`, `evidence_url`, `checked_at`, `conflict_count`。

对 P2 的 E1/E2/E3 分级解释如下：

- E1：页面 JSON-LD 的 `datePublished`、`article:published_time`、发布者日期 meta 等。沿用页面发布者提取路径；保留原始字段来源、规范化值、精度、URL 和冲突数。
- E2：页面正文/明确站点区域的“发布时间”“发布日期”“YYYY年MM月DD日”及“来源”邻近日期。复用现有页面提取结果与模块，不在本 P2 重写日期提取器；逐项标明正文位置/规则来源。日精度只用于 `calendar_today` 的日比较，不伪造成具体时刻；无时区时间不用于 rolling 24h。
- E3：URL 日期段、sitemap `lastmod`。记录为辅助/发现证据和原始 URL 或 sitemap loc；绝不单独标为 `verified`，与 E1/E2 冲突时保留冲突并按 E1/E2 决策。
- E4：feed `pubDate` 或搜索/API 声明日期只是来源声明。依总 SPEC 作为预筛/诊断；页面级核验前不可当成 P2 的页面验证结果。
- E5：缺少有效证据、抓取失败或无法解析。状态分别保留 `unknown`/`blocked`/读取失败原因，不混为日期不符。

严格日期结果必须有符合窗口的 E1/E2 发布者页面证据。侧栏日期、版权年份、评论时间、相关/推荐文章日期，以及今日栏目时间都不是当前文章发布证据；应记录排除原因，不作为页面冲突数以外的命中。转载页的日期不自动代表原发时间。

## 首轮状态与人工处理

- 91/91 路由可用性：`unknown`。唯一探针的公共 RSSHub endpoint 返回 403，且没有单独 RSS/sitemap 响应证据；不宣称 91 个分别失败。
- 91/91 页面日期分类：`not_checked`。没有抓取条目，所以没有 E1/E2 命中率或日期准确率数据。
- 输入备注已保留：PBC 沟通交流和微博热搜需 Chromium；中央纪委、虎嗅、知乎/头条等有反爬说明；境外中文三条需代理。此轮没有尝试规避反爬。
- 下一轮需在获得授权并有可用抓取环境后，先以少量样本核验 endpoint/feed，再按来源抽查三篇页面；遇 403、验证码、必须 Chromium 或必须代理时逐源记为 `blocked` 并附证据，避免扩张为自动重试或绕过机制。
- 用户需对候选清单删改后定稿。遵照 #82 的人工门槛，本报告不替用户删除、批准或冻结任何来源；建议优先审阅反爬强、需 Chromium、走代理的备注项，以及仅提供热榜/标题的 13 项是否符合用途。
- 定稿和 RSSHub 部署授权之前，P3 不得据此建设生产索引。

## 验收证据与限制

- count=91；route 去重；层级合计 22+11+45+13=91；逐项源文件行号用于原文映射。
- 公共 RSSHub 探针（`/gov/zhengce/zuixin`）实际返回 HTTP 403；仅此一路由有 HTTP 探针，其他路由没有逐一请求。
- 日期状态全部诚实保留为未测；无 Chromium/代理访问、无源站 RSS/sitemap 实际验证。
- focused：`node --test news-verified.test.mjs news-feed.test.mjs news-quality.test.mjs`，32/32 通过。
- 全量：`npm test`，404 项中 376 通过、25 失败、2 cancelled、1 skipped。失败包括 fixture/gateway 启动超时、受 Windows 环境限制的 bad port 及全量并行负载超时；不是全量通过。无源码改动，测试文件亦未改。
- `git diff --check` 通过；依赖通过 `npm ci --ignore-scripts --no-audit --no-fund` 按现有 lockfile 本地安装，未更改依赖清单。
