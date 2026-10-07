#!/usr/bin/env bash
# 将 AutoJs6 运行代码部署到手机，不覆盖已有配置、消息、图片或任务记录。
# 示例：
#   ./deploy-phone.sh --dry-run             只检查，不上传
#   ./deploy-phone.sh                       上传并重启
#   ./deploy-phone.sh --no-restart          上传但不重启
#   ./deploy-phone.sh --serial 手机序列号    指定目标手机
# 依赖：Bash、ADB、jq、curl，以及 sha256sum 或 shasum。

# 命令失败、变量未定义或管道失败时立即退出，避免继续执行不完整的部署。
set -euo pipefail

# 一、初始化路径和选项。代码路径按脚本所在目录计算，与执行目录无关。
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REMOTE="/sdcard/wechat-bridge"
ADB_BIN="${ADB:-}"
SERIAL=""
CONFIG=""
DRY=0
RESTART=1
FORWARD=""
TEMP=""

# 仅上传运行文件，不上传电脑凭证或网页代码。
FILES=(
    bridge.js
    wechat.js
    restart.js
)
# 旧版双脚本结构的代码文件，部署新版本后删除，避免误启动。
OBSOLETE=(
    agent.js
    phone-server.js
    visual.js
    phone-store.js
    event-store.js
    restart-agent.js
    restart-phone-server.js
)

fail() {
    echo "部署未完成：$*" >&2
    exit 1
}

usage() {
    echo "用法：$0 [--adb 路径] [--serial 序列号] [--config 配置文件] [--dry-run] [--no-restart]"
}

# 二、解析参数。--config 只用于手机尚无配置的首次部署。
while (($#)); do
    case "$1" in
        --adb | --serial | --config)
            (($# >= 2)) || fail "$1 缺少参数"
            case "$1" in
                --adb) ADB_BIN="$2" ;;
                --serial) SERIAL="$2" ;;
                --config) CONFIG="$2" ;;
            esac
            shift 2
            ;;
        --dry-run)
            DRY=1
            shift
            ;;
        --no-restart)
            RESTART=0
            shift
            ;;
        --help | -h)
            usage
            exit 0
            ;;
        *)
            usage
            fail "未知参数：$1"
            ;;
    esac
done

# 三、检查电脑依赖。优先使用指定的 ADB，其次 PATH，最后 macOS SDK 路径。
for dependency in jq curl; do
    command -v "$dependency" >/dev/null || fail "缺少 $dependency，请先安装"
done

if [[ -z "$ADB_BIN" ]]; then
    ADB_BIN="$(command -v adb || true)"
fi
if [[ -z "$ADB_BIN" && -x "$HOME/Library/Android/sdk/platform-tools/adb" ]]; then
    ADB_BIN="$HOME/Library/Android/sdk/platform-tools/adb"
fi
[[ -n "$ADB_BIN" ]] || fail "未找到 ADB，请指定 --adb"
command -v "$ADB_BIN" >/dev/null || fail "ADB 不可执行"

# Linux 常见 sha256sum，macOS 自带 shasum；二者统一返回哈希字符串。
if command -v sha256sum >/dev/null; then
    hash() {
        sha256sum "$1" | awk '{print $1}'
    }
else
    command -v shasum >/dev/null || fail "缺少 SHA-256 工具"
    hash() {
        shasum -a 256 "$1" | awk '{print $1}'
    }
fi

# 四、选择已授权设备。排除 offline 和 unauthorized 状态的手机。
DEVICES=()
while IFS= read -r device; do
    if [[ -n "$device" ]]; then
        DEVICES+=("$device")
    fi
done < <("$ADB_BIN" devices | awk 'NR > 1 && $2 == "device" {print $1}')

if [[ -z "$SERIAL" ]]; then
    [[ ${#DEVICES[@]} == 1 ]] || fail "需要一台已授权手机；多设备请指定 --serial（当前 ${#DEVICES[@]} 台）"
    SERIAL="${DEVICES[0]}"
fi
FOUND=0
for device in "${DEVICES[@]}"; do
    if [[ "$device" == "$SERIAL" ]]; then
        FOUND=1
    fi
done
[[ "$FOUND" == 1 ]] || fail "指定手机未连接或未授权"

# 后续所有 ADB 操作都固定到同一台手机，避免多设备时操作错对象。
adb_device() {
    "$ADB_BIN" -s "$SERIAL" "$@"
}

# 正常完成或异常退出时，释放临时端口并删除包含凭证的临时文件。
cleanup() {
    if [[ -n "$FORWARD" ]]; then
        adb_device forward --remove "tcp:$FORWARD" >/dev/null 2>&1 || true
    fi
    if [[ -n "$TEMP" ]]; then
        rm -rf -- "$TEMP"
    fi
}
trap cleanup EXIT

# 五、检查应用、运行文件和配置；检查完成前不修改手机文件。
[[ -n "$(adb_device shell pm path org.autojs.autojs6)" ]] || fail "手机未安装 AutoJs6"
for file in "${FILES[@]}"; do
    [[ -f "$ROOT/$file" ]] || fail "缺少运行文件 $file"
done

EXISTS=0
if adb_device shell test -f "$REMOTE/config.json"; then
    EXISTS=1
fi
if [[ "$EXISTS" == 0 ]]; then
    [[ -f "$CONFIG" ]] || fail "首次部署需要 --config 配置文件"
    # 凭证不能是示例占位符，配置里的设备编号必须与目标手机一致。
    jq -e --arg serial "$SERIAL" '
        .device_id == $serial and
        (.phone_api_token | type == "string" and length >= 32 and (contains("REPLACE") | not))
    ' "$CONFIG" >/dev/null || fail "配置设备编号或凭证无效"
fi

echo "目标手机：${SERIAL}；运行文件：${#FILES[@]} 个"
if [[ "$DRY" == 1 ]]; then
    echo "检查通过，未修改手机。"
    exit 0
fi

# 六、上传到临时文件，核对电脑和手机的 SHA-256 后再替换正式文件。
adb_device shell mkdir -p "$REMOTE"
for file in "${FILES[@]}"; do
    adb_device push "$ROOT/$file" "$REMOTE/$file.deploy" >/dev/null
    actual="$(
        adb_device shell sha256sum "$REMOTE/$file.deploy" |
            awk '{print $1}' |
            tr -d "\r"
    )"
    [[ "$actual" == "$(hash "$ROOT/$file")" ]] || fail "上传校验失败：$file"
    adb_device shell mv "$REMOTE/$file.deploy" "$REMOTE/$file"
done
if [[ "$EXISTS" == 0 ]]; then
    adb_device push "$CONFIG" "$REMOTE/config.json" >/dev/null
fi
for file in "${OBSOLETE[@]}"; do
    adb_device shell rm -f "$REMOTE/$file"
done

echo "上传及 SHA-256 校验通过，现有运行数据已保留。"
if [[ "$RESTART" == 0 ]]; then
    echo "未重启，下次启动时加载新代码。"
    exit 0
fi

# 七、打开 AutoJs6 并运行 restart.js：它停止旧脚本、等待锁释放后启动 bridge.js。
adb_device shell am start \
    -n org.autojs.autojs6/org.autojs.autojs.ui.main.MainActivity >/dev/null

result="$(adb_device shell am start \
    -n org.autojs.autojs6/org.autojs.autojs.external.open.RunIntentActivity \
    -a android.intent.action.VIEW \
    -d "file://$REMOTE/restart.js" \
    -t application/x-javascript 2>&1)"
[[ "$result" != *Error* && "$result" != *Exception* ]] || fail "无法启动 restart.js"
sleep 6

# 八、通过临时 ADB 端口转发检查真实就绪状态，不依赖手机的局域网 IP。
# umask 077 确保临时配置和请求头只有当前用户能读取，凭证不放在进程参数中。
umask 077
TEMP="$(mktemp -d)"
adb_device shell cat "$REMOTE/config.json" > "$TEMP/config.json"

PORT="$(jq -er '
    .phone_api_port // 8766 |
    select(type == "number" and . >= 1 and . <= 65535 and floor == .)
' "$TEMP/config.json")"

jq -er '
    .phone_api_token |
    select(type == "string" and (test("[\\r\\n]") | not)) |
    "Authorization: Bearer " + .
' "$TEMP/config.json" > "$TEMP/headers"

# tcp:0 让 ADB 分配空闲电脑端口；退出时仅清理本次创建的转发。
FORWARD="$(adb_device forward tcp:0 "tcp:$PORT" | tr -d "\r")"
[[ "$FORWARD" =~ ^[0-9]+$ ]] || fail "无法创建临时端口转发"

# 最多尝试 30 次；online 和 ready 同时为 true 才表示微信桥可以接收任务。
for ((attempt = 0; attempt < 30; attempt++)); do
    if curl --noproxy "*" --silent --fail --max-time 2 \
        --header "@$TEMP/headers" \
        "http://127.0.0.1:$FORWARD/v1/device" > "$TEMP/status.json" &&
        jq -e '.online == true and .info.ready == true' "$TEMP/status.json" >/dev/null; then
        echo "部署成功：微信桥已上报就绪。"
        exit 0
    fi
    sleep 1
done

fail "代码已更新，但未确认微信桥就绪。请解锁手机并检查无障碍、屏幕捕获授权；不要重复发送消息。"
