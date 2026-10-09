# WAG 严格 day 第二日期引擎候选只读调查（2026-10-10）

范围：依据 SPEC #74，只读核对生产 runtime-hazapu_j 对应 SearXNG `GET /config` 与低频 `/search`；未修改 overlay、生产配置、代理、认证、SearXNG 版本或 API 采购。

## 结论

本轮没有找到可进入 strict day opt-in pool 的第二个合格引擎。合格条件是同时满足：

1. `/config` 声明 `enabled=true`、`time_range_support=true`，并覆盖 general/news；
2. 真实 `time_range=day` 查询返回结果；
3. 结果包含可核验的 publisher 发布日期（不把 URL 日期、`retrieved_at` 或搜索时间当作发布日期）。

当前 `/config` 中满足前两项的已启用候选只有 `quark`（general/news）与 `chinaso news`（news）；`quark` 属于已知验证码/不稳定边界，`chinaso news` 本轮返回上游错误。两者都不能构成“第二个稳定、可验证日期”的供应。

## 能力矩阵（只读 `/config`）

| 引擎 | enabled | 类目 | time_range_support | 本轮判断 |
|---|---:|---|---:|---|
| quark | 是 | general, news | 是 | 已知验证码边界；不可作为新增候选 |
| chinaso news | 是 | news | 是 | 本轮上游 API 错误；已有池成员，不是新增候选 |
| bing | 是 | general, news | 否 | strict 会被 SearXNG 跳过；no-go |
| naver / naver news | 否 | general/web 或 news | 是 | disabled；不得改 overlay；no-go |
| reuters | 否 | news | 是 | disabled；不得启用生产配置；no-go |
| bing news | 否 | news | 是 | disabled；且本轮指定查询 0 条；no-go |
| ansa | 否 | news | 是 | disabled；本轮 0 条；no-go |
| duckduckgo | 否 | general/news | 是 | disabled；本轮 CAPTCHA/0 条；no-go |
| mojeek news | 否 | news/web | 是 | disabled；本轮 forbidden/0 条；no-go |
| startpage news | 否 | news/web | 是 | disabled；本轮 CAPTCHA/0 条；no-go |
| baidu | 否 | general | 是 | disabled；不得启用生产配置；no-go |
| 360search | 否 | general | 是 | disabled 且 timeout=20s；不满足当前预算；no-go |

## 真实样本

采样时间为本轮执行时；每次请求串行、间隔约 1.5 秒，查询为 `latest technology news Malaysia`，参数含 `format=json&categories=news&time_range=day&language=en&engines=<candidate>`。注意 SearXNG 的 `engines=` 是叠加语义，因此响应中的其他引擎失败也被完整保留，不能误认为指定候选成功。

| 指定候选 | HTTP/响应 | 结果数 | 实际出结果引擎 | 日期数 | 失败/限制 |
|---|---|---:|---|---:|---|
| chinaso news | 正常 | 4 | quark | 4 | chinaso news：服务器 API 错误；不是候选新增成功 |
| quark | 正常 | 4 | quark | 4 | 仅现有引擎；不能证明第二供应 |
| reuters | 正常 | 0 | — | 0 | chinaso API 错误、quark CAPTCHA；reuters 无结果 |
| bing news | 正常 | 0 | — | 0 | chinaso API 错误、quark suspended CAPTCHA |
| naver news | 正常 | 0 | — | 0 | chinaso API 错误、quark CAPTCHA |
| naver | 正常 | 15 | naver | 0 | 能救结果，但无 publisher 日期；且 disabled，不得启用 |
| ansa | 正常 | 0 | — | 0 | disabled；另有 quark/yandex 失败 |
| duckduckgo | 正常 | 0 | — | 0 | CAPTCHA；disabled |
| mojeek news | 正常 | 0 | — | 0 | forbidden；disabled |
| startpage news | 正常 | 0 | — | 0 | CAPTCHA；disabled |

样本中返回日期的 4 条是 quark 结果；日期字段只作为观察记录，不改变其已有引擎身份，也不代表指定候选成功。naver 的 15 条结果均无 `publishedDate`，因此不满足时效证据要求。

## No-go 与下一决策

- no-go：不启用 naver/naver news、Reuters、Bing News、Ansa、DuckDuckGo、Mojeek News、Startpage News 或其他 disabled 引擎。
- no-go：不把 `quark` 或 `chinaso news` 的单次/混合结果包装成第二日期供应。
- no-go：不把 URL 中的日期、`retrieved_at`、HTTP Date 或搜索时间冒充 publisher 发布日。
- no-go：不重复堆更多验收工具；本轮已完成能力矩阵与真实样本核对。

下一决策：将 strict day 的“第二个同时支持 time_range 且能验证 publisher 日期的引擎”正式记录为外部供应阻塞；保持生产默认 pool 空配置、overlay 不变。只有出现新的已授权供应（或用户另行批准外部 API/生产 overlay 变更）后，才重开候选评估。
