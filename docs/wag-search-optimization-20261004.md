# WAG 搜索链路优化报告（2026-10-04）

## 根因诊断

小电脑 `yosef-server` 上的 SearXNG outgoing 请求此前没有经过 sing-box。实测结果如下：

- 直连 Google、Bing、DuckDuckGo 的 `curl` 分别为 `000`（超时）；
- 经 `127.0.0.1:7890` 代理后，Google/Bing 返回 `302`，DuckDuckGo 返回 `200`；
- 273 个已配置引擎中，只有 Yandex 等少数引擎偶尔能够直连；
- 典型失败响应包含百度验证码，以及 `crowdview`、`mwmbl`、`naver`、`privacywall`、`yandex` 超时，最终使 `web_search` 经常得到 0 条结果。

因此问题主要是 SearXNG 的出站路径和引擎池配置，而不是 MCP 网关的鉴权或 URL 访问控制。

## 改动清单与理由

- `gateway/search.mjs`：集中封装 SearXNG 查询；透传 `unresponsive_engines`；首次查询 0 条结果时去掉 `time_range` 自动重试一次；提取 URL 路径日期并进行阶段耗时记录。
- `gateway/server.mjs`：让 `web_search` 使用上述查询封装，并把引擎不响应信息带回调用方。
- `gateway/evidence-metadata.mjs`：标准化搜索结果、按规范化 URL 去重并保留信息更完整的记录；URL 日期只作为 `source: url.pattern` 的日期证据，不冒充发布者时间。
- `config/searxng/settings-overlay.yml`：将 SearXNG `outgoing` 的 `all://` HTTPX 路由指向 `http://127.0.0.1:7890`，设置超时、连接池和单次传输重试；启用主要代理引擎，禁用当前已知的验证码/超时引擎。
- `scripts/searxng-apply-overlay.sh`：在小电脑上以 root 幂等应用 overlay。脚本先备份 `settings.yml`，用 PyYAML 递归合并配置，并按引擎 `name` 合并 `engines` 列表；重启后自动验证，失败会恢复备份并再次重启。

## 测试结果

在本机源码目录执行：

```bash
cd gateway
node --test *.test.mjs
```

结果：**18/18 全部通过**。

没有通过 SSH 连接或修改 `yosef-server`；overlay 脚本只提交到仓库，需由运维人员在目标机器上显式执行。

## 应用、验证与回滚

### 1. 使用当前安装契约

本报告记录的是历史诊断，不是当前部署操作手册。不要只复制 overlay 与 shell 脚本两个文件：当前入口还依赖 `scripts/searxng-overlay.py`、`scripts/release.py` 和锁定环境中的 PyYAML。

安装、协调 runtime/overlay 事务、验证与回滚以 [README 的 Runtime release transaction](../README.md#runtime-release-transaction-offline-preparation-contract) 为准；独立 overlay 操作也必须使用完整的已审阅安装布局。下面的小电脑应用示例只说明历史调用形式，不替代当前 prepare/activate/commit/restore 契约，也不授权 live 部署。

### 2. 在小电脑上应用

SearXNG 配置通常由 root 拥有，必须使用 `sudo`。如果脚本和 overlay 不在相对路径布局中，显式传入 overlay 路径：

```bash
sudo bash /path/to/searxng-apply-overlay.sh \
  /path/to/settings-overlay.yml
```

脚本会创建：

```text
/data/searxng/backups/overlay-<UTC时间戳>/settings.yml
```

随后执行 `systemctl restart searxng.service`。脚本用 `ss` 确认 `:8801` 监听，并请求：

```text
http://yosef-server:8801/search?q=test&format=json
```

验证响应为 JSON、`results` 非空，并拒绝三条或更多 timeout 类 `unresponsive_engines`（避免把成片超时当成成功）。任何应用或验证失败都会自动恢复本次备份并重启服务。

### 3. 手动验证

```bash
ss -ltn | grep ':8801'
curl --fail --get 'http://yosef-server:8801/search' \
  --data-urlencode 'q=test' --data 'format=json'
```

确认返回 JSON 中有非空 `results`；少量单引擎不响应仍应结合日志和实际查询观察。

### 4. 手动回滚

从需要回滚的时间戳目录恢复，然后重启：

```bash
sudo cp -a /data/searxng/backups/overlay-<stamp>/settings.yml \
  /data/searxng/config/settings.yml
sudo systemctl restart searxng.service
```

## 遗留风险

- Google 等引擎即使能经代理访问，仍可能因代理出口 IP 被限流、验证码或地区策略而间歇失败，需要在实际查询中持续观察。
- SearXNG 版本升级或发行版配置迁移可能重置 `settings.yml`；升级后应重新审阅并应用 overlay。
- `baidu`、`naver` 等引擎目前按环境观测结果禁用；如果业务需要，可以从 overlay 中移除对应 `disabled: true` 或改为 `false` 后重新应用，但应同时观察超时和验证码比例。
- `127.0.0.1:7890` 依赖 sing-box 保持 active；代理服务停止时，SearXNG 仍会出现出站失败。
