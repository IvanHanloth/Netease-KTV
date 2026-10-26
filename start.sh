#!/usr/bin/env bash
# Netease KTV one-click start (Linux / macOS / WSL / Git Bash).
#   - picks the NVIDIA GPU separator when Docker can reach a GPU, CPU otherwise
#     (force with KTV_GPU=on|off)
#   - fills the phone QR address with this machine's LAN IP
#   - with KTV_DOMAIN set in .env: HTTPS through Caddy (docker-compose.https.yml)
#   - extra args go to `docker compose up`, e.g. ./start.sh --pull always
set -euo pipefail
cd "$(dirname "$0")"

if ! docker info >/dev/null 2>&1; then
  echo "[x] Docker 没有运行，请先启动 Docker（Docker Desktop 或 dockerd）。" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "[x] 需要 Docker Compose v2（docker compose 命令）。" >&2
  exit 1
fi

[ -f .env ] || cp .env.example .env
port=$(grep -E '^KTV_PORT=' .env | cut -d= -f2 | tr -d '[:space:]' || true)
port=${port:-8686}

envval() { grep -E "^$1=" .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]' || true; }

# HTTPS: own domain on Cloudflare, certificate issued by Caddy.
domain=${KTV_DOMAIN:-$(envval KTV_DOMAIN)}
https_port=${KTV_HTTPS_PORT:-$(envval KTV_HTTPS_PORT)}
https_port=${https_port:-443}
if [ -n "$domain" ] && [ -z "${CF_API_TOKEN:-$(envval CF_API_TOKEN)}" ]; then
  echo "[x] 设置了 KTV_DOMAIN，但 .env 里没有 CF_API_TOKEN（Cloudflare 令牌，需要 区域 → DNS → 编辑 权限）。" >&2
  exit 1
fi

# LAN address for the phone QR code, unless .env sets PUBLIC_URL.
if [ -n "$domain" ] && ! grep -qE '^PUBLIC_URL=[^[:space:]]+' .env; then
  if [ "$https_port" = "443" ]; then export PUBLIC_URL="https://$domain"; else export PUBLIC_URL="https://$domain:$https_port"; fi
elif ! grep -qE '^PUBLIC_URL=[^[:space:]]+' .env; then
  ip=""
  case "$(uname -s)" in
    Darwin) ip=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true) ;;
    Linux) ip=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit }}' || true) ;;
    MINGW* | MSYS* | CYGWIN*)
      ip=$(powershell.exe -NoProfile -Command "(Get-NetIPConfiguration | Where-Object { \$_.IPv4DefaultGateway -and \$_.NetAdapter.Status -eq 'Up' } | Select-Object -First 1).IPv4Address.IPAddress" 2>/dev/null | tr -d '\r' || true)
      ;;
  esac
  if [ -n "$ip" ]; then export PUBLIC_URL="http://$ip:$port"; fi
fi

sep=${KTV_SEPARATOR:-$(grep -E '^KTV_SEPARATOR=' .env | cut -d= -f2 | tr -d '[:space:]' || true)}
sep=${sep:-on}
files=(-f docker-compose.yml)
web=(app)
gpu=${KTV_GPU:-$(grep -E '^KTV_GPU=' .env | cut -d= -f2 | tr -d '[:space:]' || true)}
gpu=${gpu:-auto}
use_gpu=false
if [ "$sep" = "off" ]; then
  echo ">> 本机不运行分离服务（KTV_SEPARATOR=off），请在 后台管理 → 分离服务器 里添加其他电脑"
elif [ "$gpu" = "on" ]; then
  use_gpu=true
elif [ "$gpu" != "off" ]; then
  echo ".. 检测 GPU"
  if docker run --rm --gpus all busybox:1.36 true >/dev/null 2>&1; then use_gpu=true; fi
fi
if $use_gpu; then
  files+=(-f docker-compose.gpu.yml)
  echo ">> 伴奏分离：NVIDIA GPU"
elif [ "$sep" != "off" ]; then
  echo ">> 伴奏分离：CPU（较慢，每首几分钟）"
fi

if [ -n "$domain" ]; then
  files+=(-f docker-compose.https.yml)
  web+=(caddy)
  echo ">> HTTPS：https://$domain$([ "$https_port" = "443" ] || echo ":$https_port")（Caddy 自动申请证书）"
fi

if [ "$sep" = "off" ]; then
  docker compose "${files[@]}" rm -sf separator >/dev/null 2>&1 || true
  docker compose "${files[@]}" up -d --build --no-deps "$@" "${web[@]}"
else
  docker compose "${files[@]}" up -d --build "$@"
fi

echo
echo "[OK] Netease KTV 已启动"
desk=${PUBLIC_URL:-$(envval PUBLIC_URL)}
echo "  点歌台：${desk:-http://localhost:$port}/"
echo "  主屏：  http://localhost:$port/tv  （在主屏电脑上用 localhost 打开，才能用麦克风打分）"
echo "  首次启动会自动下载分离模型，查看进度：docker compose logs -f separator"
