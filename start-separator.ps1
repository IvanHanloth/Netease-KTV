# Start a standalone separator server for Netease KTV (Windows PowerShell).
#   - picks the NVIDIA GPU image when Docker can reach a GPU, CPU otherwise ($env:KTV_GPU = 'on' / 'off')
#   - creates a random token in .env.separator on first run
#   - prints the address and token to enter in the KTV's 后台管理 -> 分离服务器
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Set-Location -LiteralPath $PSScriptRoot

docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host '[x] Docker 没有运行，请先启动 Docker Desktop。' -ForegroundColor Red
  exit 1
}

$envFile = '.env.separator'
if (-not (Test-Path $envFile)) {
  $chars = [char[]]'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  $token = -join (1..24 | ForEach-Object { $chars | Get-Random })
  Set-Content -Path $envFile -Encoding ascii -Value @("SEPARATOR_PORT=9000", "SEPARATOR_TOKEN=$token", "SEPARATOR_MODEL=", "KTV_GPU=auto")
}
$envText = Get-Content $envFile -Raw
$port = if ($envText -match '(?m)^SEPARATOR_PORT=(\d+)') { $Matches[1] } else { '9000' }
$token = if ($envText -match '(?m)^SEPARATOR_TOKEN=(\S+)') { $Matches[1] } else { '' }

$files = @('-f', 'docker-compose.separator.yml')
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
  Write-Host '>> 分离：NVIDIA GPU' -ForegroundColor Cyan
} else {
  Write-Host '>> 分离：CPU（较慢，每首几分钟）' -ForegroundColor Yellow
}

docker compose --env-file $envFile @files up -d --build @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$ip = (Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    Select-Object -First 1).IPv4Address.IPAddress
if (-not $ip) { $ip = '<本机局域网 IP>' }
$shownToken = if ($token) { $token } else { '（未设置）' }

Write-Host ''
Write-Host '[OK] 分离服务器已启动。在 KTV 的 后台管理 → 分离服务器 → 添加服务器 里填写：' -ForegroundColor Green
Write-Host "  地址：http://${ip}:$port"
Write-Host "  令牌：$shownToken"
Write-Host "  防火墙需要放行 $port 端口。首次启动会自动下载模型：docker compose -f docker-compose.separator.yml logs -f"
