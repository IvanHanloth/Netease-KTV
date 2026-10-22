# Netease KTV one-click start (Windows PowerShell).
#   - picks the NVIDIA GPU separator when Docker can reach a GPU, CPU otherwise
#     (force with $env:KTV_GPU = 'on' / 'off')
#   - fills the phone QR address with this machine's LAN IP
#   - extra args go to `docker compose up`
$ErrorActionPreference = 'Continue'
# Windows PowerShell 5.1 consoles default to the ANSI code page; print UTF-8 instead.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Set-Location -LiteralPath $PSScriptRoot

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '[x] Docker 没有运行，请先启动 Docker Desktop。' -ForegroundColor Red
  exit 1
}

if (-not (Test-Path .env)) { Copy-Item .env.example .env }
$envText = Get-Content .env -Raw
$port = if ($envText -match '(?m)^KTV_PORT=(\d+)') { $Matches[1] } else { '8686' }

# LAN address for the phone QR code, unless .env sets PUBLIC_URL.
if ($envText -notmatch '(?m)^PUBLIC_URL=\S+') {
  $ip = (Get-NetIPConfiguration |
      Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
      Select-Object -First 1).IPv4Address.IPAddress
  if ($ip) { $env:PUBLIC_URL = "http://${ip}:$port" }
}

$files = @('-f', 'docker-compose.yml')
$gpu = if ($env:KTV_GPU) { $env:KTV_GPU } elseif ($envText -match '(?m)^KTV_GPU=(\w+)') { $Matches[1] } else { 'auto' }
$useGpu = $false
if ($gpu -eq 'on') {
  $useGpu = $true
} elseif ($gpu -ne 'off') {
  Write-Host '.. 检测 GPU'
  docker run --rm --gpus all busybox:1.36 true *> $null
  $useGpu = ($LASTEXITCODE -eq 0)
}
if ($useGpu) {
  $files += @('-f', 'docker-compose.gpu.yml')
  Write-Host '>> 伴奏分离：NVIDIA GPU' -ForegroundColor Cyan
} else {
  Write-Host '>> 伴奏分离：CPU（较慢，每首几分钟）' -ForegroundColor Yellow
}

docker compose @files up -d --build @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$desk = if ($env:PUBLIC_URL) { $env:PUBLIC_URL } else { "http://localhost:$port" }
Write-Host ''
Write-Host '[OK] Netease KTV 已启动' -ForegroundColor Green
Write-Host "  点歌台：$desk/"
Write-Host "  主屏：  http://localhost:$port/tv  （在主屏电脑上用 localhost 打开，才能用麦克风打分）"
Write-Host '  首次启动会自动下载分离模型，查看进度：docker compose logs -f separator'
