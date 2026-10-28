# SPEC #82 P0 基线测试执行指南

**状态**: 待执行  
**交付物**: #128 (T0.2)  
**执行位置**: yosef-server (小电脑)

## 文件清单

```
reports/spec82-p0-baseline-20261028/
├── README.md                # 本文件
├── experiment-design.md     # 实验设计文档
├── test-queries.json        # 50 条测试查询
├── run-baseline.py          # Python 测试脚本
├── baseline-detail.jsonl    # 详细结果（执行后生成）
└── baseline-summary.json    # 汇总报告（执行后生成）
```

## 前置条件

1. 小电脑 SearXNG 正常运行
2. Python 3.8+ 已安装
3. `requests` 库已安装

检查命令：

```bash
# 在小电脑执行
curl -s http://127.0.0.1:8801/search?q=test&format=json | jq '.results | length'
python3 --version
python3 -c "import requests; print(requests.__version__)"
```

如果缺少 `requests`：

```bash
pip3 install requests
```

## 执行步骤

### 1. 上传文件到小电脑

从本机 Windows 上传测试文件：

```powershell
# 在本机 PowerShell 执行
scp -r D:\WILL\TOOLS\web_access_gateway_proj\reports\spec82-p0-baseline-20261028 will@yosef-server:/tmp/
```

### 2. 在小电脑执行测试

```bash
# SSH 到小电脑
ssh will@yosef-server

# 进入测试目录
cd /tmp/spec82-p0-baseline-20261028

# 执行基线测试（约 25 分钟）
python3 run-baseline.py \
  --queries test-queries.json \
  --output baseline-detail.jsonl \
  --summary baseline-summary.json
```

预计执行时间：
- 50 查询 × 4 引擎 = 200 次请求
- 每次请求 0.5 秒间隔 + 平均 2 秒延迟
- 总计约 25 分钟

### 3. 下载结果到本机

```powershell
# 在本机 PowerShell 执行
scp will@yosef-server:/tmp/spec82-p0-baseline-20261028/baseline-*.* D:\WILL\TOOLS\web_access_gateway_proj\reports\spec82-p0-baseline-20261028\
```

### 4. 人工抽查失败样本

从 `baseline-detail.jsonl` 中筛选失败记录：

```bash
# 在小电脑或本机执行
jq 'select(.status_code != 200)' baseline-detail.jsonl | head -5
```

记录失败模式：
- 超时 (`error: "timeout"`)
- 验证码 (`captcha: true`)
- HTTP 错误 (非 200 状态码)

### 5. 提交结果

```bash
# 在本机 Git 仓库
git add reports/spec82-p0-baseline-20261028/
git commit -m "feat(spec82): add P0 baseline test results"
```

## 验收检查

- [x] 实验设计文档完整
- [x] 测试集 50 条已准备
- [ ] 基线测试已在小电脑执行
- [ ] 结果文件已下载到本机
- [ ] 失败样本已人工分析
- [ ] 结果已提交到 Git

## 预期输出示例

### baseline-summary.json

```json
{
  "meta": {
    "date": "2026-10-28T10:30:00Z",
    "wag_commit": "ba8d49c",
    "test_duration_sec": 1500,
    "total_queries": 200
  },
  "by_engine": {
    "quark": {
      "success_rate": 0.92,
      "captcha_rate": 0.04,
      "p95_latency_ms": 1850
    }
  }
}
```

### baseline-detail.jsonl (前两行示例)

```jsonl
{"query_id": "q001", "engine": "quark", "query_type": "general", "query": "Claude AI", "status_code": 200, "latency_ms": 1234, "result_count": 8, "captcha": false, "error": null, "timestamp": "2026-10-28T10:15:23Z"}
{"query_id": "q001", "engine": "yandex", "query_type": "general", "query": "Claude AI", "status_code": 200, "latency_ms": 2103, "result_count": 10, "captcha": false, "error": null, "timestamp": "2026-10-28T10:15:26Z"}
```

## 故障排查

### SearXNG 不响应

```bash
# 检查服务状态
sudo systemctl status searxng

# 查看日志
sudo journalctl -u searxng -n 50
```

### 超时过多

调整脚本中的 `timeout` 参数（当前 30 秒）：

```python
# run-baseline.py 第 61 行
resp = requests.get(..., timeout=60)  # 改为 60 秒
```

### 验证码率过高

添加更长的请求间隔：

```python
# run-baseline.py 第 185 行
time.sleep(2.0)  # 从 0.5 秒改为 2 秒
```

## 下一步

T0.2 完成后，继续：
- T0.3: chinaso/yandex 故障模式分析 (#129)
- T1: 引擎选优机制设计 (#130)
