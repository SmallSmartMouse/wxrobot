#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if command -v go >/dev/null 2>&1; then
  GO_BIN=$(command -v go)
elif [ -x "$HOME/.cache/wechat-web-go/go/bin/go" ]; then
  GO_BIN="$HOME/.cache/wechat-web-go/go/bin/go"
else
  echo "需要安装 Go 1.25 或更新版本：https://go.dev/dl/" >&2
  exit 1
fi
mkdir -p .state
# 先编译：编译失败时不影响正在运行的服务。
"$GO_BIN" build -o .state/wechat-web .

# 监听地址：取参数中的 -listen，默认 127.0.0.1:8787。
LISTEN=127.0.0.1:8787
PREV=""
for ARG in "$@"; do
  case "$PREV" in -listen | --listen) LISTEN=$ARG ;; esac
  case "$ARG" in -listen=* | --listen=*) LISTEN=${ARG#*=} ;; esac
  PREV=$ARG
done
PORT=${LISTEN##*:}

# 端口被占用时先停止占用的进程：先正常退出（服务会保存数据），5 秒后仍未退出再强制结束。
listeners() { lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true; }
if ! command -v lsof >/dev/null 2>&1; then
  echo "未找到 lsof，跳过端口检测" >&2
elif [ -n "$(listeners)" ]; then
  echo "端口 $PORT 已被占用，停止以下进程："
  ps -o pid=,command= -p "$(listeners | paste -sd, -)"
  kill $(listeners) 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ -z "$(listeners)" ] && break
    sleep 0.5
  done
  if [ -n "$(listeners)" ]; then
    echo "进程未正常退出，强制结束"
    kill -9 $(listeners) 2>/dev/null || true
    sleep 1
  fi
  if [ -n "$(listeners)" ]; then
    echo "端口 $PORT 仍被占用，请手动处理" >&2
    exit 1
  fi
fi

echo "微信消息台启动中：http://$LISTEN ，日志写入 .state/server.log"
# 固定记录服务日志，避免手动启动时日志仅出现在终端，诊断页无法查看。
exec .state/wechat-web "$@" >> .state/server.log 2>&1
