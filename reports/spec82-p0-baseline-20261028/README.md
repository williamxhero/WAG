# T0.2 搜索质量基线：设计交接

**NOT RUN（未执行）**。本目录只保留设计与固定查询集，没有实测成功率、验证码率或 P95 延迟。#128 仍待真实基线验收。

- [experiment-design.md](experiment-design.md)：历史实验设计、分组和指标定义。文中的环境、版本、步骤及脚本名仅为历史设计记录，不是运行指引；JSON 和 JSONL 中的数字都是格式示例，不是实测结果。
- [test-queries.json](test-queries.json)：50 条固定查询，含 25 条 `general`、15 条 `news`、10 条 `strict_day`。

原 runner 仅作私有历史保全，不随本目录交付。它直连本地 `/search`，没有接入共享保护，不能作为上线或采样方案。实际执行方案和结果须另行验收。
