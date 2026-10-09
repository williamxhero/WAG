# WAG 新闻模式可解释相关性排序与去重（SPEC #72）

## 范围与边界

- 关联 SPEC GitHub issue **#72**（以及 #60/#64/#65/#67）。
- 只改网关**搜索结果层**：`gateway/search.mjs` 及其专用测试 `gateway/search-news-mode.test.mjs`、固定样本夹具 `gateway/fixtures/news-mode-samples.json`。
- **未改**：`gateway/evidence-metadata.mjs`、`gateway/news-quality.mjs`、`gateway/search-quality-probe.mjs`、共享代理、引擎配置、认证、SSRF、超时路径。
- 普通（非新闻）检索行为保持兼容：不传 `categories: 'news'` 时输出与改动前逐字节一致（不新增 `news_mode`/`news_ranking`/`dedup` 键）。

## 设计：opt-in 新闻模式

`searchSearxng` 新增选项 `newsMode`；未显式给出时，若 `input.categories` 含 `news` 则自动 opt-in。新闻模式**只对已过滤、已去重的结果重排序**，不丢弃也不新增结果（召回不变），信号是可解释启发式，**不声称规则等于真实相关性**。

每条结果的打分信号（`scoreNewsRelevance` 返回 `{ score, reasons }`）：

| reason | 影响 | 含义 |
| --- | --- | --- |
| `navigational_root` | −5 | 裸域名/`/`（根路径，含地图/企业首页/裸域） |
| `article_path` | +1 | 深度 ≥ 2 的路径（文章式 URL） |
| `redirect_wrapper` | −3 | 搜索跳转/聚合包装（`/link`、`/blm/…`、或带 `url=https://…` 参数） |
| `empty_snippet` | −4 | 空摘要 |
| `navigational_snippet` | −4 | Yandex 的 “Link to …” 导航占位 |
| `publisher_instant` | +3 | 有发布者级 instant（`published_at`） |
| `dated` | +1 | 有 day 级日期（`published_on`） |
| `undated` | −1 | 无任何日期证据 |
| `title_match` | +min(hits,3)×2 | 查询词命中**标题** |
| `snippet_match` | +1 | 查询词命中摘要 |
| `no_query_match` | −1 | 查询词未命中标题/摘要 |

查询分词 `newsQueryTerms`：拉丁/数字连续段整体保留；**中文按重叠 bigram** 展开（无词典，不依赖外部分词器）。无别名词典：标题仅含实体的**另一种语言名**时不会命中（已知限制）。

排序 `rankNewsResults`：按 score 降序、**稳定排序**（同分保留引擎原序），输入结果**全部且仅一次**返回。

响应级新增（仅新闻模式）：`news_mode: true`、`news_ranking`（`total/moved/demoted/promoted/reasons` 计数）、`dedup`（`raw_results/unique_urls/merged/multi_source/sources`）。**去重保留多来源证据**：同一规范化 URL 由多个引擎返回时，合并后仍记录 `sources: [{url, engines:[…]}]`，不静默丢弃。

> 接口说明：`news_mode`/`news_ranking`/`dedup` 为响应级键，`server.mjs` 的 `web_search` 分支目前未转发它们（外层 schema 为 `passthrough`）。按 SPEC “必要接口由协调集成”，`server.mjs` 白名单接线留给协调者；本卡不改 `server.mjs`。

## 测试

- 测试先行：先写 `search-news-mode.test.mjs`（红：缺导出），再实现（绿）。
- 覆盖：受控正负例（导航根/空摘要/跳转包装/导航占位/日期/查询命中）、中文分词、无日期、规范 URL 去重与多来源证据、`category`/`engine`/`source` schema 回归、稳定排序不增删结果、普通模式兼容（无 `news_mode`、顺序不变）。
- 配对真实样本：`fixtures/news-mode-samples.json`（生产 SearXNG **只读** JSON API 采样的固定真实结果 + 人工离线标签），比较前后 Precision@5、重复比例、召回、排序耗时。

## 实测配对结果（真实样本）

采样源：`http://yosef-server:8801/search`（生产 SearXNG 只读 JSON API，2026-10-09）。样本：中文金融 `英伟达 财报`、英文科技 `openai`、官方文档 `python asyncio documentation`。

| 样本 | sample | Precision@5 前 → 后 | 重复比例前/后 | 召回 | 排序耗时 |
| --- | --- | --- | --- | --- | --- |
| 中文金融 | zh-finance | 0.80 → **1.00** | 0.00 / 0.00 | 1.00 | ~0.22 ms |
| 英文科技 | en-tech | 0.20 → **0.60** | 0.00 / 0.00 | 1.00 | ~0.12 ms |
| 官方文档 | docs | 0.80 → **1.00** | 0.00 / 0.00 | 1.00 | ~0.09 ms |
| **均值** | | **0.600 → 0.867** | | 1.00 | <0.25 ms |

- 召回损失 0：新闻模式不增删结果，URL 集合与普通模式完全一致。
- 延迟极小（每批 <0.25 ms，纯 CPU 重排序，无额外网络）。
- `zh-finance`：把 `page.sm.cn/blm/video-page…`（跳转包装）与空摘要项降出前五，前五全部相关。
- `en-tech`：把 `instagram`/`external.auth.openai.com` 的 “Link to …” 导航项降到底部，`ft.com` 文章升到首位。
- `docs`：启用了新闻模式做配对比较，但**新闻模式并非为文档检索设计**；结果虽提升 P@5，却把一条 YouTube 教程升到第 2 位——对文档类查询应保持普通模式（如实记录，未粉饰）。

## 诚实边界

- 数字来自**配对真实样本**，不是编造；但样本量小（3 查询 / 40 结果），标签为人工离线判据，仅作离线比较，**不构成在线自动相关性判断**。
- 规则为启发式，**不声称规则等于真实相关性**；生产可用性/引擎供给不是本卡范围，不因通用 availability 通过而宣称新闻质量通过。
- 未使用付费 API/LLM；未改安全/共享代理/引擎/认证/SSRF。
