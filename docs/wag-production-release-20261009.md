# WAG PR62 生产发布验收（2026-10-09）

PR62 经第二轮独立审查批准，发布者亲自读回 `/tmp/wag-review30/result.json`、完整差异及同一提交 CI 后合并。实现提交为 `fe20d02ce8f889bcd273fc753d3e5a348b49dad8`，CI run 37873784135 SUCCESS。生产源修订为合并提交 `2f461fbcd744819a033c4c2d67dab35f685e98fa`。

## 发布与回滚

生产事务 `/data/web-access-gateway/releases/runtime-181pgex1` 已按仓库原生 prepare → activate → commit 执行并读回 committed；`.release-current` 指向该事务，`.release-pending` 不存在，public_readiness=passed。准备前无待处理事务、无其他 release.py 进程。本次不重配 SearXNG，不改共享 sing-box、不提高出口配额、不放宽安全。

爬虫真实运行进程没有 `CRAWL4AI_MAX_PAGES_BEFORE_RECYCLE` 环境覆盖；安装源码默认值为1，实际渲染回收也已观测。出口限制仍为32/32。运行文件通过事务投影安装，没有手改。Windows git archive 首次传输造成换行差异，prepare 正确拒绝；随后使用 Git bundle 在 Linux 干净检出同一提交，prepare 成功，失败的准备未激活生产。

需要回滚时执行：

```sh
sudo bash /data/web-access-gateway/scripts/deploy.sh restore /data/web-access-gateway/releases/runtime-181pgex1
```

该事务保存前版 `runtime-assl85oe` 的运行文件、unit、依赖链接及服务状态快照。保留整个事务、candidate 与 snapshot；不要删除或移动仍被虚拟环境链接引用的目录。回滚后必须重新读状态并验收。

## 原生三个门禁

报告在生产机，发布者逐一解析 JSON，不以管道退出码代替结果。

| 门禁 | 原始报告 | 实际结果 |
| --- | --- | --- |
| smoke | `/data/web-access-gateway/reports/smoke-20261009T023623Z.json` | passed，12/12，成功率及质量100% |
| release | `/data/web-access-gateway/reports/release-20261009T023651Z.json` | passed，14/14，成功率及质量100%，超时0%，并发退化5.882352941176472%（门限50%） |
| evidence | `/data/web-access-gateway/reports/release31/evidence.json` | 原生脚本exit0，5次搜索、10条读取成功；1条搜索零结果，凑满10成功前有2条读取失败 |

Evidence 的10条成功不等于10条新鲜且相关的新闻：仅4条有发布者时间，2条在原生证据时间窗内。原生脚本查询日期仍为2026年8月30日，结果混入无关网站。本次没有修改或降低脚本门槛，不能宣称时效与相关性已改善。

## 生产真实读取与连接归属

原始完整采样：`/data/web-access-gateway/reports/release31/production-probe.json`（首次），`production-probe-html.json`（HTML复验）；脚本 `/tmp/wag-release31-probe.mjs`、`/tmp/wag-release31-probe-html.mjs`。每0.5秒采样一次已建立出口连接。

连续auto读取覆盖ft.com、bbc、wikipedia、iana、w3、rfc。首次5/6成功，ft触发403后渲染成功且没有schema协议错误；w3反爬渲染502。复验4/6成功，ft因反爬结构检测502，w3仍Cloudflare挑战502；其余4条轻量读取成功。两次失败均返回结构化错误，不包装成通过。

首次静态样本误选RFC的text/plain（接口仅支持HTML），19条返回不支持类型、1条404，0/20；失败原始结果完整保留。改用实际支持的20条唯一HTML URL（RFC9110–9130跳过不存在的9123）复验20/20成功，未见代理429。不是为提高成功率删除失败记录：两套结果均保留，HTML批次专门验证出口释放后支持格式的读取能力。

HTML复验出口基线2条、瞬时峰值26条、auto结束2条、30秒后2条、静态结束2条。用 `ss -Htnp` 及 `/proc/PID/cgroup` 读回：这2条归属 `web-access-playwright.service`（Chrome PID3597713），不是爬虫；爬虫残留0条。因此证明本次爬虫请求结束后归还新增槽位，不宣称全站所有浏览器连接归零。第一次原生浏览器门禁之后总连接基线11条，批次后仍11，随后自然下降；也不能把该基线冒称爬虫泄漏或排空。

两轮各5次readyz（间隔11秒避免缓存）全部200、ok=true、render_active=0、browser_active=0。中文及英文搜索均成功，复验中文15条、英文10条；day时效参数请求成功但结果仍混入2024/2025页面，所有搜索结果均缺published_at。quark因验证码暂停，其他引擎仍提供结果。可用性通过不等于时效质量通过。

## 分支与worktree收尾

枚举所有本地/远端引用，包括历史claude与worktree-agent分支，以及所有注册worktree。45个引用全部是生产源修订的祖先；两个历史detached worktree头也核实。逐一执行47次普通 `git merge --no-edit <sha>`，全部exit0、Already up to date，没有丢弃未合并内容，也没有删除分支或worktree。详细机器记录留在发布者本机scratch的 `wag-release31-branches.json` 与 `wag-release31-merges.json`；本报告分支是验收记录新增内容，将另经CI合并。

## 仍未改善与关闭边界

公网ft/w3反爬仍可能失败；时效参数不保证新鲜结果，查询相关性仍不足；Playwright空闲连接不属于本次爬虫回收修复范围；text/plain读取不受当前接口支持。三个原生门禁均通过，生产已commit，但不能据此宣称所有公网读取及新闻质量通过。issue51保持OPEN，由主协调者依据这些真实证据决定关闭；本发布者不关闭。
