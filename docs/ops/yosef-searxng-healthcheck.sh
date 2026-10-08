#!/usr/bin/env bash
#
# yosef-searxng-healthcheck — 本机 SearXNG(uWSGI) 健康检查 + 自动恢复
#
# 判定标准(健康定义):
#   1) systemd 单元 searxng.service 处于 active;并且
#   2) uWSGI 实际对外提供的 HTTP 端点在其 /config 路径上返回 200。
#
# 探测地址是"运行时发现"的,而不是把 127.0.0.1 写死:
#   先读 `ss -ltn` 得到目标端口当前真正处于 LISTEN 的本机地址
#   (0.0.0.0 / [::] / * 这类通配地址折算成 127.0.0.1),
#   再兜底探测 127.0.0.1。这样无论 SearXNG 绑在 127.0.0.1、192.168.50.2
#   还是别的地址,检查都与真实监听对齐,不会因绑定地址变化而误判。
#   (历史缺陷:写死 127.0.0.1,而 uwsgi.ini 实际绑到 192.168.50.2:8801,
#    导致检查恒判失败并每 5 分钟误重启 SearXNG。)
#
# 同时保留"真故障时恢复"的能力:服务未激活,或端口虽在 LISTEN 但 HTTP
# 不再应答 200(例如 worker 卡死 / 返回错误页),都会判定失败并重启 SearXNG。
#
# 环境变量覆盖(默认即生产值,systemd 单元无需设置;仅测试时用于隔离验证):
#   SEARXNG_HEALTHCHECK_SERVICE   默认 searxng
#   SEARXNG_HEALTHCHECK_PORT      默认 8801
#   SEARXNG_HEALTHCHECK_PATH      默认 /config
#   SEARXNG_HEALTHCHECK_TIMEOUT   默认 5 (秒)
#
# NOTE: 这是 /usr/local/sbin/yosef-searxng-healthcheck 在仓库中的参考副本。
# 该生产文件当前不在版本控制里,本副本与 docs/ops/searxng-healthcheck-fix-20261008.md
# 一起构成它的可追溯来源。安装方式见该文档第 6/8 节。
set -euo pipefail

SERVICE="${SEARXNG_HEALTHCHECK_SERVICE:-searxng}"
PORT="${SEARXNG_HEALTHCHECK_PORT:-8801}"
HPATH="${SEARXNG_HEALTHCHECK_PATH:-/config}"
TIMEOUT="${SEARXNG_HEALTHCHECK_TIMEOUT:-5}"
TAG=searxng-healthcheck

log() { logger -t "$TAG" "$*"; }

# 目标端口当前实际处于 LISTEN 的本机地址;通配地址折算为 127.0.0.1
listen_hosts() {
  ss -ltnH 2>/dev/null | awk -v port="$PORT" '
    {
      n = split($4, p, ":")
      if (n < 2 || p[n] != port) next
      host = $4
      sub(/:[0-9]+$/, "", host)
      if (host == "0.0.0.0" || host == "::" || host == "*" || host == "[::]") host = "127.0.0.1"
      print host
    }'
}

# 依次探测候选地址;任一返回 200 即健康,并打印命中的 URL
probe() {
  local host url
  for host in $( { listen_hosts; printf '127.0.0.1\n'; } | awk '!seen[$0]++' ); do
    [ -n "$host" ] || continue
    url="http://${host}:${PORT}${HPATH}"
    if curl -fsS --max-time "$TIMEOUT" -o /dev/null "$url"; then
      printf '%s\n' "$url"
      return 0
    fi
  done
  return 1
}

if ! systemctl is-active --quiet "$SERVICE"; then
  log "${SERVICE} is not active; restarting ${SERVICE}"
  systemctl restart "$SERVICE"
elif ! hit="$(probe)"; then
  log "local health check failed; restarting ${SERVICE} (no HTTP 200 on port ${PORT}; listened at: $(listen_hosts | tr '\n' ' '))"
  systemctl restart "$SERVICE"
else
  log "health check OK (${hit})"
  exit 0
fi

for _ in $(seq 1 20); do
  if hit="$(probe)"; then
    log "${SERVICE} recovered after restart (${hit})"
    exit 0
  fi
  sleep 1
done

log "${SERVICE} did not recover after restart"
exit 1
