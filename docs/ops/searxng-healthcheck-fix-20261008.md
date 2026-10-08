# searxng-healthcheck 每 5 分钟误重启 SearXNG —— 修复记录

日期：2026-10-08
主机：`yosef-server`（Ubuntu，SearXNG 由 uWSGI 承载，绑定 `192.168.50.2:8801`）
范围：本记录对应**一次对生产脚本的实际修复**（与只读诊断报告 `docs/wag-egress-diagnosis-20261008.md` 第 6 节发现的缺陷同源）。

---

## 0. 一句话结论

老的健康检查把探测地址**写死成 `127.0.0.1:8801`**，而 SearXNG 实际只监听 `192.168.50.2:8801`，于是它**每 5 分钟都判"失败"并真的重启一次 SearXNG**（24 小时内 271 次）。
修复方式：探测地址改为**运行时从 `ss -ltn` 读出实际 LISTEN 的本机地址**（通配地址折算成 `127.0.0.1`），并保留"真故障时重启"的能力。修复后一个完整观察窗口内**不再出现任何一次误重启**，同时用隔离测试证明"端口不可达 / 只监听但不应答"时**仍会判失败并执行重启动作**。

---

## 1. 这个脚本不在版本控制里，本记录是它唯一的可追溯来源

**明确结论：`/usr/local/sbin/yosef-searxng-healthcheck` 当前不在任何版本控制里。本文件（以及同目录的 `docs/ops/yosef-searxng-healthcheck.sh`）是它唯一的可追溯来源。**

它不是一个"生成物"，而是有人手写放上去的一份遗留文件。改动前做的排查与证据：

| 排查动作 | 命令 | 结果 |
| --- | --- | --- |
| 全盘按文件名查找 | `find / -xdev ... -name '*searxng-healthcheck*'` | 只命中脚本本身 + `searxng-healthcheck.{service,timer}` + timer stamp，**没有任何模板/生成器/副本** |
| 在小目录里按内容查找 | `grep -rIl "searxng-healthcheck" /usr/local /etc /opt /srv /root /home` | 只有脚本自身与两个单元文件命中 |
| 在 WAG 生产树与相关目录里查找 | `grep -rIl "searxng-healthcheck\|yosef-searxng" /data/web-access-gateway /data/searxng /data/wagcli /data/services` | **0 命中** |
| WAG 仓库自身 | 仓库内 `git grep` / 工作区全文搜索 | **0 命中**（唯一命中是诊断报告正文里提到它） |
| WAG 部署产物 | `ls /data/web-access-gateway/systemd/` | 只有 `web-access-*.service/timer`；`searxng.service` 与 `searxng-healthcheck.*` **都不在其中** |
| 其它触发方式 | `ls /etc/cron.d /etc/cron.daily`、`find /etc/systemd/system -name '*searxng*'` | 只有 systemd timer 这一条触发路径，没有 cron 副本 |

旁证：脚本 mtime 为 `2026-08-27 14:47`，单元文件同为 `2026-08-27 14:47`，与 `/data/searxng` 的 `20260827` 发布同期 —— 属于 SearXNG 接入时手工建立、之后无人管理。

**因此"改哪里才不会被覆盖"的答案是：直接改这两个生产文件本身（脚本 + 单元），没有任何上游生成器需要同步改。** 单元文件本次**未改动**（只需改脚本），所以连 `daemon-reload` 都不需要。

---

## 2. 缺陷与实测证据

### 2.1 判定条件与真实监听不一致

改动前的判定条件：

```bash
systemctl is-active --quiet searxng && curl -fsS --max-time 5 http://127.0.0.1:8801/config
```

而 SearXNG 真实绑定（`/data/searxng/config/uwsgi.ini:25`）：

```
http-socket = 192.168.50.2:8801
```

实测对照（2026-10-08，修复前）：

| 探测目标 | 结果 |
| --- | --- |
| `curl http://127.0.0.1:8801/config` | **连不上**（curl rc=7，connect refused） |
| `curl http://192.168.50.2:8801/config` | **HTTP 200** |
| `ss -ltnH "sport = :8801"` | 只有 `192.168.50.2:8801` 一条，**没有 127.0.0.1** |

### 2.2 重启时间线（修复前）

`journalctl` 里 `restarting searxng` 出现的时间点，严格约 5 分钟一次：

```
（24 小时内共 271 次；最近一轮摘录）
Oct 08 10:46:14   Oct 08 10:51:24   Oct 08 10:56:54   Oct 08 11:01:56
Oct 08 11:07:07   Oct 08 11:12:24   Oct 08 11:17:34   Oct 08 11:22:47
Oct 08 11:28:05   Oct 08 11:33:07   Oct 08 11:38:08   Oct 08 11:43:24
Oct 08 11:48:34   Oct 08 11:53:37   Oct 08 11:58:58   Oct 08 12:04:24
Oct 08 12:09:34   Oct 08 12:14:44   Oct 08 12:20:04   Oct 08 12:25:08
Oct 08 12:30:15   Oct 08 12:35:41   Oct 08 12:41:06   Oct 08 12:46:14
Oct 08 12:51:22   Oct 08 12:56:41   Oct 08 13:01:51   Oct 08 13:07:01
Oct 08 13:12:22   Oct 08 13:17:54   <- 最后两次（修复前）
```

每次日志固定刷两条：`local health check failed; restarting searxng` →（20 次重试全部连不上）→ `searxng did not recover after restart`，服务单元长期 `failed`。修复前状态：`searxng` 的 `ActiveEnterTimestamp` 每 5 分钟就变一次，`searxng-healthcheck.service` 恒为 `failed`。

### 2.3 为什么要修

1. 每次重启都会**清空引擎的挂起/封禁状态**（`suspended_time=180`），让任何"改配置 → 观察行为"的验证在 5 分钟内被打断，本轮搜索引擎调优直接受此污染；
2. 属无意义的周期性服务中断；
3. 掩盖真实故障：健康检查永远亮红灯，真出问题时没人能靠它发现。

---

## 3. 改动前：脚本全文（逐字，取自备份 `yosef-searxng-healthcheck.bak-20261008T132005Z`，md5 `cea11b6e277737292b9a744681ab129d`）

```bash
#!/usr/bin/env bash
set -euo pipefail

if systemctl is-active --quiet searxng && \
   curl -fsS --max-time 5 http://127.0.0.1:8801/config >/dev/null; then
  exit 0
fi

logger -t searxng-healthcheck 'local health check failed; restarting searxng'
systemctl restart searxng
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 http://127.0.0.1:8801/config >/dev/null; then
    logger -t searxng-healthcheck 'searxng recovered after restart'
    exit 0
  fi
  sleep 1
done

logger -t searxng-healthcheck 'searxng did not recover after restart'
exit 1
```

单元文件（**本次未改动**，原文如下）：

`/etc/systemd/system/searxng-healthcheck.service`
```ini
[Unit]
Description=Check local SearXNG health and recover a stuck service
After=searxng.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/yosef-searxng-healthcheck
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
```

`/etc/systemd/system/searxng-healthcheck.timer`
```ini
[Unit]
Description=Run the SearXNG local health check every five minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
RandomizedDelaySec=30s
AccuracySec=15s
Persistent=true
Unit=searxng-healthcheck.service

[Install]
WantedBy=timers.target
```

---

## 4. 改动后：脚本全文（逐字，即当前生产文件，md5 `0ce8c95af9ee778e4c5b175b6f13791b`）

同步留在仓库里的参考副本：`docs/ops/yosef-searxng-healthcheck.sh`（逻辑与生产文件逐字一致，仅多了一段说明性注释头）。

```bash
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
```

---

## 5. 为什么这样改（设计与取舍）

1. **探测地址不再写死，改为运行时发现（`ss -ltn`）**：
   任务给出的两个候选里选了"用 `ss` 判断 8801 是否 LISTEN"这一路，但**没有把它简化成"端口开着就算健康"**——端口开着但 uWSGI 卡死、或返回错误页，同样应该被发现。所以最终形态是：**用 `ss` 找出端口当前真实绑定的本机地址 → 对这个地址真的发一次 HTTP GET `/config` → 要求 200**。
   这样同时满足"与真实监听一致"和"对未来绑定变化健壮"：无论以后绑 `127.0.0.1`、`0.0.0.0`、`192.168.50.2` 还是别的地址，检查都会跟着走，不需要再改脚本。
2. **没有选"直接探测 `192.168.50.2:8801`"**：它只在当前这一种绑定下正确；一旦绑定再变（比如有人换回 loopback），就会重演同一个 bug。而且它是硬编码 IP，换个环境/主机同样失效。
3. **通配地址折算**：`0.0.0.0` / `[::]` / `*` 这类"监听所有网卡"的地址折算成 `127.0.0.1` 来探测（更稳，不受网卡列表变化影响）。
4. **兜底探测 `127.0.0.1`**：`ss` 万一拿不到结果（极端情况），仍会试 loopback。
5. **不做无关改动**：单元文件的沙箱限制、`After=`、timer 全部保持原样；`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` 下 `ss` 会因为拿不到 netlink 而回退读 `/proc/net/tcp`，**实测在该沙箱里照常输出正确**（见 7.1）。
6. **刻意保留可被测试的接缝**：4 个环境变量默认值即生产值，单元不设置它们 → 生产行为不变；测试时可以用它们把"被检查的服务 / 端口"换成一次性的临时单元，从而**在不碰生产 SearXNG 的前提下**验证"真故障时会重启"（见 7.1）。
7. **日志行为保留并增强**：仍然用 `logger -t searxng-healthcheck` 写 syslog/journal；成功时新增一条 `health check OK (<实际命中的 URL>)`，失败时在原有 `local health check failed; restarting ...` 里补上"检查的端口 / 当时监听在哪"，因此 journal 里能直接看出**检查了什么、结果是什么**。

**边界（未越界）**：没有改 SearXNG 的绑定地址、配置或引擎集；没有重启 sing-box；没有碰 `/data/net-proxy/**`；没有弱化认证或 SSRF 校验。

---

## 6. 备份（带 UTC 时间戳，改动前创建）

| 文件 | 备份路径 |
| --- | --- |
| 脚本 | `/usr/local/sbin/yosef-searxng-healthcheck.bak-20261008T132005Z`（md5 `cea11b6e277737292b9a744681ab129d`，原文件 md5 一致） |
| 服务单元 | `/etc/systemd/system/searxng-healthcheck.service.bak-20261008T132005Z` |
| 定时器单元 | `/etc/systemd/system/searxng-healthcheck.timer.bak-20261008T132005Z` |

（单元文件本次未改动，已用 `diff -q` 复核与备份逐字节一致。）

---

## 7. 验证与真实输出

### 7.1 隔离验证：证明"真故障时仍会动作"，且全程不碰生产 SearXNG

做法：把新脚本（未改动地）拷到 `/tmp`，用 **4 个环境变量**把"被检查/被重启的服务"换成一次的临时单元（`hctest-dummy` = `sleep infinity`，用 `systemctl link` 从 `/tmp` 链接成真单元以便能被 `restart`），而**探测端口仍指向真实的生产 8801**（只发只读 GET）。这样既能验证脚本逻辑，又绝不会重启生产 SearXNG。

命令（节选）：

```bash
sudo systemctl link /tmp/hctest-dummy.service && sudo systemctl start hctest-dummy
sudo env SEARXNG_HEALTHCHECK_SERVICE=hctest-dummy \
     SEARXNG_HEALTHCHECK_PORT=8899 SEARXNG_HEALTHCHECK_TIMEOUT=2 \
     /tmp/yosef-searxng-healthcheck.new
```

真实输出：

```
### 0. 语法检查
    bash -n: OK

### T1 健康路径: dummy active,探测真实 8801 -> 期望 OK, exit 0, searxng 不动
    exit=0
    searxng ActiveEnterTimestamp = Thu 2026-10-08 13:17:55 UTC
    searxng: 未动

### T2 恢复路径: 停掉 dummy(单元仍 loaded) -> 期望 restart dummy 后 recovered, exit 0
    hctest-dummy active=inactive
    exit=0
    hctest-dummy active=active  ActiveEnterTimestamp=Thu 2026-10-08 13:19:12 UTC
    -> dummy 被真的 restart;searxng: 未动

### T3 真故障检测: 端口 8899 无人监听 -> 期望 failed + did not recover, exit 1
    （20 次 curl: Failed to connect to 127.0.0.1 port 8899）
    exit=1
    searxng ActiveEnterTimestamp = Thu 2026-10-08 13:17:55 UTC
    (被 restart 的是 dummy;searxng: 未动)

### T4 只监听但不服务: 8899 起一个只会 404 的 http.server -> 期望仍判失败, exit 1
    ss: LISTEN 0      5          127.0.0.1:8899  0.0.0.0:*
    curl /config 状态码: 404
    （20 次 curl: The requested URL returned error: 404）
    exit=1
    searxng: 未动
```

解读：
- **T1** = 健康路径正确（exit 0），且**没有触碰生产 searxng**；
- **T2** = 服务处于 inactive 时，脚本**真的执行了 `systemctl restart`**（临时单元的 `ActiveEnterTimestamp` 从空变成 `13:19:12`），随后判 recovered、exit 0 —— 这就是"真挂时会动作"的直接证据；
- **T3** = 端口无人监听 → 判失败、走完 20 次重试、`did not recover`、**exit 1**；
- **T4** = **端口在 LISTEN 但 `/config` 返回 404 时同样判失败** → 证明这不是"端口开着就算健康"的假动作，也证明"为了让检查通过而把它改成永远通过"没有发生。

清理：临时单元 `hctest-dummy` / `hctest-http` 已停止并从 `/etc/systemd/system` 移除、`daemon-reload` 已执行。

### 7.2 生产强制运行 ×5（每次都记录退出码）

```
基线 UTC:            2026-10-08 13:20:20
searxng NRestarts:   0
searxng ActiveEnter: Thu 2026-10-08 13:17:55 UTC

run#1: systemctl_rc=0  ExecMainStatus=0  Result=success  searxng_ts=13:17:55 UTC  => 未重启
run#2: systemctl_rc=0  ExecMainStatus=0  Result=success  searxng_ts=13:17:55 UTC  => 未重启
run#3: systemctl_rc=0  ExecMainStatus=0  Result=success  searxng_ts=13:17:55 UTC  => 未重启
run#4: systemctl_rc=0  ExecMainStatus=0  Result=success  searxng_ts=13:17:55 UTC  => 未重启
run#5: systemctl_rc=0  ExecMainStatus=0  Result=success  searxng_ts=13:17:55 UTC  => 未重启
```

脚本写入的 journal 记录（logger，节选）：

```
Oct 08 13:20:12 yosef-server searxng-healthcheck[3149370]: health check OK (http://192.168.50.2:8801/config)
Oct 08 13:20:20 yosef-server searxng-healthcheck[3149600]: health check OK (http://192.168.50.2:8801/config)
Oct 08 13:20:21 yosef-server searxng-healthcheck[3149624]: health check OK (http://192.168.50.2:8801/config)
Oct 08 13:20:22 yosef-server searxng-healthcheck[3149648]: health check OK (http://192.168.50.2:8801/config)
Oct 08 13:20:23 yosef-server searxng-healthcheck[3149672]: health check OK (http://192.168.50.2:8801/config)
Oct 08 13:20:24 yosef-server searxng-healthcheck[3149697]: health check OK (http://192.168.50.2:8801/config)
```

### 7.3 观察窗口（≥15 分钟，覆盖 ≥3 个 timer 周期）

窗口：`2026-10-08 13:27:45 UTC` → `2026-10-08 13:44:45 UTC`（17 分钟，覆盖 3 个 timer 周期）。

```
窗口开始 UTC: 2026-10-08 13:27:45
  searxng ActiveEnterTimestamp = Thu 2026-10-08 13:17:55 UTC
  searxng NRestarts            = 0

窗口结束 UTC: 2026-10-08 13:44:45
  searxng ActiveEnterTimestamp = Thu 2026-10-08 13:17:55 UTC
  searxng NRestarts            = 0

=== 窗口内 healthcheck 运行结果统计 ===
  Finished(成功) 次数: 3
  Failed(失败)   次数: 0
  出现 'restarting searxng' 次数: 0

=== 窗口内所有 'Starting ... service' 时间点(3 个 timer 周期都跑到了) ===
Oct 08 13:31:22 yosef-server systemd[1]: Starting searxng-healthcheck.service ...
Oct 08 13:36:30 yosef-server systemd[1]: Starting searxng-healthcheck.service ...
Oct 08 13:42:02 yosef-server systemd[1]: Starting searxng-healthcheck.service ...

=== 窗口内脚本的判定日志(logger) ===
Oct 08 13:31:22 yosef-server searxng-healthcheck[3153798]: health check OK (http://192.168.50.2:8801/config)
Oct 08 13:36:30 yosef-server searxng-healthcheck[3155082]: health check OK (http://192.168.50.2:8801/config)
Oct 08 13:42:02 yosef-server searxng-healthcheck[3156272]: health check OK (http://192.168.50.2:8801/config)
```

结论：窗口内 **3 个 timer 周期全部成功（0 次失败）、0 次 `restarting searxng`**，`searxng` 的 `ActiveEnterTimestamp` **保持不变**（`13:17:55`，早于修复时刻 `13:20:05`，说明修复后从未被健康检查重启过）。补充：从修复完成（`13:20:05 UTC`）到窗口结束（`13:44:45 UTC`）共 5 个 timer 周期，`journalctl` 里 `restarting searxng` 出现 **0 次**（修复前是每 5 分钟一次）。

### 7.4 收尾服务状态

```
sing-box                     active (ActiveEnterTimestamp Mon 2026-10-05 18:27:08 UTC)
searxng                      active (ActiveEnterTimestamp Thu 2026-10-08 13:17:55 UTC)
web-access-gateway           active (ActiveEnterTimestamp Thu 2026-10-08 02:21:27 UTC)
web-access-egress-proxy      active (ActiveEnterTimestamp Thu 2026-10-08 02:21:27 UTC)

searxng-healthcheck.timer    enabled
searxng-healthcheck.service  ExecMainStatus=0  Result=success

临时测试单元 hctest-*       无残留（已 stop + 从 /etc/systemd/system 删除 + daemon-reload）
```

注意 `sing-box` / `web-access-*` 的 `ActiveEnterTimestamp` 都远早于本次改动时刻，说明**本次没有重启它们**（符合"不要重启 sing-box"的硬性约束）。

---

## 8. 回滚（逐条命令）

单元文件本次未改，所以回滚只需把脚本换回原版：

```bash
# 1) 恢复改动前的脚本
sudo cp -a /usr/local/sbin/yosef-searxng-healthcheck.bak-20261008T132005Z \
           /usr/local/sbin/yosef-searxng-healthcheck

# 2) 核对 md5 应回到原值 cea11b6e277737292b9a744681ab129d
sudo md5sum /usr/local/sbin/yosef-searxng-healthcheck

# 3) （可选）若单元文件也需要回到原状
sudo cp -a /etc/systemd/system/searxng-healthcheck.service.bak-20261008T132005Z \
           /etc/systemd/system/searxng-healthcheck.service
sudo cp -a /etc/systemd/system/searxng-healthcheck.timer.bak-20261008T132005Z \
           /etc/systemd/system/searxng-healthcheck.timer
sudo systemctl daemon-reload

# 4) 立即跑一次确认（回滚后它会再次误重启；这是预期行为，仅用于核对回滚成功）
sudo systemctl start searxng-healthcheck.service
sudo journalctl -u searxng-healthcheck --since "-2 min"
```

---

## 9. 未验证 / 局限（诚实列出）

1. **没有真的把生产 SearXNG 停掉来验"真挂时重启"**（任务明确禁止）。用的是 7.1 的隔离法：把"被检查/被重启的服务"换成一次性临时单元，脚本逻辑逐字节相同 —— 证明的是**脚本的判定与重启动作**，而不是"生产 searxng 被停之后一定会被拉起来"这一整条链路。
2. **`ss` 在单元沙箱里的行为依赖 `/proc/net/tcp` 回退**：`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6` 下 `ss` 拿不到 netlink，会打印 `Cannot open netlink socket` 并回退读 `/proc`。已实测在该沙箱里**输出正确且过滤有效**；但如果将来有人把单元的沙箱改得连 `/proc` 也不可读，`ss` 会失效（届时脚本仍有 `127.0.0.1` 兜底，只是失去"跟随绑定"的能力）。
3. **没有覆盖 `ss` 也读不到、且 `127.0.0.1` 恰好被别的进程占用的极端情形**（不在本缺陷范围）。
4. **`NRestarts` 指标本身不敏感**：健康检查用的是 `systemctl restart`（手动重启），**不会**增加 `NRestarts`（它只统计 `Restart=` 自动重启）。因此"窗口内 NRestarts 不变"这条**不能单独作为没重启的证据**，本记录以 **`searxng` 的 `ActiveEnterTimestamp` 是否变化** + journal 里是否还有 `restarting searxng` 作为主判据。

---

## 10. 本次对生产的改动清单

| 类型 | 目标 | 说明 |
| --- | --- | --- |
| 改动 | `/usr/local/sbin/yosef-searxng-healthcheck` | 换为新版（md5 `0ce8c95af9ee778e4c5b175b6f13791b`） |
| 未改动 | `/etc/systemd/system/searxng-healthcheck.service` / `.timer` | 与备份逐字节一致（`diff -q` 复核） |
| 新增临时物 | `hctest-dummy` / `hctest-http` 临时 systemd 单元 | 仅用于 7.1 隔离验证，**已删除** |
| 未触碰 | SearXNG 绑定地址/配置/引擎集、`sing-box`、`/data/net-proxy/**` | 均未改动 |
| 期间的生产重启 | 仅由**修复前**的旧脚本在其最后一次触发（13:17:54 UTC）产生；修复后**无任何健康检查触发的重启** | 未额外手动重启 SearXNG |
| 凭据 | 全程未打印或写入任何密钥 / token / cookie；`settings.yml` 只按字段名引用 | — |
