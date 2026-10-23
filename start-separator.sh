#!/usr/bin/env bash
# Start a standalone separator server for Netease KTV (Linux / macOS / WSL / Git Bash).
#   - picks the NVIDIA GPU image when Docker can reach a GPU, CPU otherwise (KTV_GPU=on|off)
#   - creates a random token in .env.separator on first run
#   - prints the address and token to enter in the KTV's 后台管理 -> 分离服务器
set -euo pipefail
cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "[x] Docker 没有运行，请先启动 Docker（Docker Desktop 或 dockerd）。" >&2
  exit 1
fi

envfile=.env.separator
if [ ! -f "$envfile" ]; then
  token=$(LC_ALL=C tr -dc 'a-zA-Z0-9' </dev/urandom | head -c 24 || true)
  printf 'SEPARATOR_PORT=9000\nSEPARATOR_TOKEN=%s\nSEPARATOR_MODEL=\nKTV_GPU=auto\n' "$token" >"$envfile"
fi
val() { grep -E "^$1=" "$envfile" | head -n1 | cut -d= -f2- | tr -d '[:space:]' || true; }
port=$(val SEPARATOR_PORT); port=${port:-9000}
token=$(val SEPARATOR_TOKEN)

files=(-f docker-compose.separator.yml)
gpu=${KTV_GPU:-$(val KTV_GPU)}
gpu=${gpu:-auto}
use_gpu=false
if [ "$gpu" = "on" ]; then
  use_gpu=true
elif [ "$gpu" != "off" ]; then
  echo ".. 检测 GPU"
  if docker run --rm --gpus all busybox:1.36 true >/dev/null 2>&1; then use_gpu=true; fi
fi
if $use_gpu; then
  files+=(-f docker-compose.gpu.yml)
  echo ">> 分离：NVIDIA GPU"
else
  echo ">> 分离：CPU（较慢，每首几分钟）"
fi

docker compose --env-file "$envfile" "${files[@]}" up -d --build "$@"

ip=""
case "$(uname -s)" in
  Darwin) ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true) ;;
  Linux) ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true) ;;
  MINGW* | MSYS* | CYGWIN*)
    ip=$(powershell.exe -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { \$_.IPv4DefaultGateway -and \$_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1).IPv4Address.IPAddress" 2>/dev/null | tr -d '\r' || true)
    ;;
esac

echo
echo "[OK] 分离服务器已启动。在 KTV 的 后台管理 → 分离服务器 → 添加服务器 里填写："
echo "  地址：http://${ip:-<本机局域网 IP>}:$port"
echo "  令牌：${token:-（未设置）}"
echo "  防火墙需要放行 $port 端口。首次启动会自动下载模型：docker compose -f docker-compose.separator.yml logs -f"
