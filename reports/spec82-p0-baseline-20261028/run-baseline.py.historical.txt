#!/usr/bin/env python3
"""
SPEC #82 P0 基线测试脚本

在小电脑 (yosef-server) 上执行，直接调用本地 SearXNG。
不修改 WAG 配置，不依赖 WAG 网关层。

使用方法：
  python3 run-baseline.py --queries test-queries.json --output baseline-detail.jsonl

依赖：
  - Python 3.8+
  - requests
  - 本地 SearXNG 运行在 http://127.0.0.1:8801
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Dict, List, Any
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

try:
    import requests
except ImportError:
    print("Error: requests module not found. Install with: pip3 install requests", file=sys.stderr)
    sys.exit(1)


@dataclass
class QueryResult:
    """单次查询结果"""
    query_id: str
    engine: str
    query_type: str
    query: str
    status_code: int
    latency_ms: int
    result_count: int
    captcha: bool
    error: str | None
    timestamp: str


class BaselineRunner:
    """基线测试执行器"""

    SEARXNG_URL = "http://127.0.0.1:8801/search"
    ENGINES = ["quark", "yandex", "bing", "chinaso"]

    def __init__(self, queries_file: Path, output_file: Path):
        self.queries_file = queries_file
        self.output_file = output_file
        self.results: List[QueryResult] = []

    def load_queries(self) -> List[Dict[str, Any]]:
        """加载测试查询"""
        with open(self.queries_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data['queries']

    def execute_search(self, query: str, engine: str) -> QueryResult:
        """执行单次搜索"""
        start_ns = time.perf_counter_ns()

        params = {
            'q': query,
            'engines': engine,
            'format': 'json',
            'language': 'zh-CN'
        }

        try:
            resp = requests.get(
                self.SEARXNG_URL,
                params=params,
                timeout=30,
                headers={'User-Agent': 'WAG-Baseline-Test/1.0'}
            )

            latency_ms = (time.perf_counter_ns() - start_ns) // 1_000_000

            # 检测验证码
            captcha = self._detect_captcha(resp)

            # 统计结果数
            result_count = 0
            if resp.status_code == 200:
                try:
                    body = resp.json()
                    result_count = len(body.get('results', []))
                except Exception:
                    pass

            return QueryResult(
                query_id='',  # 由调用方设置
                engine=engine,
                query_type='',  # 由调用方设置
                query=query,
                status_code=resp.status_code,
                latency_ms=latency_ms,
                result_count=result_count,
                captcha=captcha,
                error=None,
                timestamp=datetime.now(timezone.utc).isoformat()
            )

        except requests.Timeout:
            latency_ms = (time.perf_counter_ns() - start_ns) // 1_000_000
            return QueryResult(
                query_id='',
                engine=engine,
                query_type='',
                query=query,
                status_code=0,
                latency_ms=latency_ms,
                result_count=0,
                captcha=False,
                error='timeout',
                timestamp=datetime.now(timezone.utc).isoformat()
            )

        except Exception as e:
            latency_ms = (time.perf_counter_ns() - start_ns) // 1_000_000
            return QueryResult(
                query_id='',
                engine=engine,
                query_type='',
                query=query,
                status_code=0,
                latency_ms=latency_ms,
                result_count=0,
                captcha=False,
                error=str(e),
                timestamp=datetime.now(timezone.utc).isoformat()
            )

    def _detect_captcha(self, resp: requests.Response) -> bool:
        """检测是否触发验证码"""
        if resp.status_code in [403, 429, 451]:
            return True

        # 检查响应体关键词
        try:
            text = resp.text.lower()
            if any(kw in text for kw in ['captcha', 'robot', '验证', 'recaptcha']):
                return True
        except Exception:
            pass

        return False

    def run(self):
        """执行完整基线测试"""
        queries = self.load_queries()
        total = len(queries) * len(self.ENGINES)

        print(f"开始基线测试: {len(queries)} 个查询 × {len(self.ENGINES)} 个引擎 = {total} 次请求")
        print(f"输出: {self.output_file}")

        completed = 0

        with open(self.output_file, 'w', encoding='utf-8') as f:
            for q in queries:
                query_id = q['id']
                query_text = q['query']
                query_type = q['type']

                for engine in self.ENGINES:
                    result = self.execute_search(query_text, engine)
                    result.query_id = query_id
                    result.query_type = query_type

                    # 写入 JSONL
                    f.write(json.dumps(asdict(result), ensure_ascii=False) + '\n')
                    f.flush()

                    self.results.append(result)
                    completed += 1

                    # 进度显示
                    success = '✓' if result.status_code == 200 else '✗'
                    print(f"[{completed}/{total}] {success} {engine:8s} {query_id} ({result.latency_ms}ms)")

                    # 避免速率限制
                    time.sleep(0.5)

        print(f"\n基线测试完成，结果已保存到 {self.output_file}")

    def generate_summary(self, summary_file: Path):
        """生成汇总报告"""
        if not self.results:
            print("警告: 无测试结果，跳过汇总生成", file=sys.stderr)
            return

        # 按引擎汇总
        by_engine = {}
        for engine in self.ENGINES:
            engine_results = [r for r in self.results if r.engine == engine]
            total = len(engine_results)
            success = len([r for r in engine_results if r.status_code == 200])
            captcha = len([r for r in engine_results if r.captcha])
            error = len([r for r in engine_results if r.error is not None])

            latencies = [r.latency_ms for r in engine_results if r.status_code == 200]
            p95_latency = int(sorted(latencies)[int(len(latencies) * 0.95)]) if latencies else 0

            by_engine[engine] = {
                'success_rate': round(success / total, 3) if total > 0 else 0.0,
                'captcha_rate': round(captcha / total, 3) if total > 0 else 0.0,
                'p95_latency_ms': p95_latency,
                'total': total,
                'success': success,
                'captcha': captcha,
                'error': error
            }

        # 按查询类型汇总
        by_query_type = {}
        for qtype in ['general', 'news', 'strict_day']:
            type_results = [r for r in self.results if r.query_type == qtype]
            total = len(type_results)
            success = len([r for r in type_results if r.status_code == 200])

            by_query_type[qtype] = {
                'success_rate': round(success / total, 3) if total > 0 else 0.0,
                'total': total
            }

        # 生成汇总
        summary = {
            'meta': {
                'date': datetime.now(timezone.utc).isoformat(),
                'wag_commit': 'ba8d49c',  # 手动填写
                'test_duration_sec': 0,  # 手动计算
                'total_queries': len(self.results)
            },
            'by_engine': by_engine,
            'by_query_type': by_query_type
        }

        with open(summary_file, 'w', encoding='utf-8') as f:
            json.dump(summary, f, indent=2, ensure_ascii=False)

        print(f"汇总报告已保存到 {summary_file}")


def main():
    parser = argparse.ArgumentParser(description='SPEC #82 P0 基线测试')
    parser.add_argument('--queries', type=Path, required=True, help='测试查询 JSON 文件')
    parser.add_argument('--output', type=Path, required=True, help='详细结果输出 JSONL 文件')
    parser.add_argument('--summary', type=Path, help='汇总报告输出 JSON 文件（可选）')

    args = parser.parse_args()

    if not args.queries.exists():
        print(f"错误: 查询文件不存在: {args.queries}", file=sys.stderr)
        sys.exit(1)

    runner = BaselineRunner(args.queries, args.output)

    try:
        runner.run()

        if args.summary:
            runner.generate_summary(args.summary)

    except KeyboardInterrupt:
        print("\n\n测试被用户中断", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"\n测试失败: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == '__main__':
    main()
