# SPEC #82 P0 阶段对照实验设计

Date: 2026-10-28  
Parent: #82 (出口引擎质量门)  
Ticket: #128 (T0.2)

## 实验目的

建立当前 WAG 出口引擎的质量基线，为后续 P1 (选优)、P2 (容错) 和 P3 (监控) 提供对照数据。

## 对照组设计

### 主要对照维度

1. **直连 vs 代理**  
   - 直连：本地网络 → 搜索引擎  
   - 代理：本地 → WAG Provider → 搜索引擎  
   - 目的：隔离代理引入的失败

2. **引擎对比**  
   - quark (夸克)  
   - yandex (Яндекс)  
   - bing (必应)  
   - chinaso (中国搜索)  
   - 目的：识别引擎特性差异

3. **查询类型**  
   - general (通用查询)  
   - news (新闻时效)  
   - strict_day (严格日期)  
   - 目的：区分查询复杂度对成功率的影响

### 固定变量

- 网络环境：yosef-server (小电脑，Ubuntu)  
- WAG 版本：当前 main HEAD (ba8d49c)  
- 测试时间窗口：单次完整执行 < 30 分钟  
- 并发：串行执行，避免速率限制干扰

## 测量指标

### 1. 成功率 (Success Rate)

定义：返回 HTTP 200 且 body 非空的请求占比

```
success_rate = (成功请求数 / 总请求数) × 100%
```

分层统计：
- 按引擎  
- 按查询类型  
- 按直连/代理

### 2. 验证码率 (CAPTCHA Rate)

定义：触发验证码阻断的请求占比

```
captcha_rate = (验证码请求数 / 总请求数) × 100%
```

识别特征：
- HTTP 403/451  
- body 包含 "captcha", "robot", "验证"  
- 重定向到验证页面

### 3. P95 延迟 (P95 Latency)

定义：95% 请求的响应时间上限 (毫秒)

测量范围：
- 请求发起 → 首字节返回 (TTFB)  
- 请求发起 → body 完整接收 (Total)

## 测试集设计

### 中文 general 查询 (25 条)

涵盖：
- 实体查询 (人名、地名、品牌)  
- 概念查询 (抽象词汇)  
- 长尾查询 (3-5 个词组合)

### 中文 news 查询 (15 条)

涵盖：
- 热点事件 ("最新", "今日")  
- 时间范围 ("本周", "近期")  
- 地域新闻 (城市名 + 新闻)

### strict_day 查询 (10 条)

格式：`site:example.com 2026-10-28`  
目的：测试精确日期过滤支持

## 基线记录格式

### 汇总结果 (baseline-summary.json)

```json
{
  "meta": {
    "date": "2026-10-28T10:00:00Z",
    "wag_commit": "ba8d49c",
    "test_duration_sec": 1234,
    "total_queries": 50
  },
  "by_engine": {
    "quark": {
      "success_rate": 0.92,
      "captcha_rate": 0.04,
      "p95_latency_ms": 1850,
      "total": 50,
      "success": 46,
      "captcha": 2,
      "error": 2
    }
  },
  "by_query_type": {
    "general": {"success_rate": 0.94, "total": 25},
    "news": {"success_rate": 0.87, "total": 15},
    "strict_day": {"success_rate": 0.70, "total": 10}
  }
}
```

### 详细日志 (baseline-detail.jsonl)

每行一条请求记录：

```json
{"query_id": "q001", "engine": "quark", "type": "general", "query": "Claude AI", "status": 200, "latency_ms": 1234, "captcha": false, "error": null}
```

## 执行步骤

1. 准备测试集文件 `test-queries.json`  
2. 执行基线测试脚本 `run-baseline.sh`  
3. 生成汇总报告 `baseline-summary.json`  
4. 存档详细日志 `baseline-detail.jsonl`  
5. 人工抽查 5 条失败样本，记录失败模式

## 验收标准

- [x] 实验设计文档完整  
- [ ] 测试集 50 条已准备  
- [ ] 基线测试已执行  
- [ ] 结果已存档到 `reports/spec82-p0-baseline-20261028/`  
- [ ] 失败样本已分析
