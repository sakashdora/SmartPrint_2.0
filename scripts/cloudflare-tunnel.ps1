param(
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "         SmartPrint Cloudflare Live Deployment Launcher    " -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

$binDir = Join-Path $PSScriptRoot "..\.data\bin"
if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

$cloudflaredCmd = "cloudflared"
$localCloudflared = Join-Path $binDir "cloudflared.exe"

$hasCloudflared = (Get-Command cloudflared -ErrorAction SilentlyContinue)
if (-not $hasCloudflared) {
    if (Test-Path $localCloudflared) {
        $cloudflaredCmd = $localCloudflared
    } else {
        Write-Host "[1/3] Cloudflare Tunnel binary not found. Downloading official cloudflared..." -ForegroundColor Yellow
        $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $downloadUrl -OutFile $localCloudflared -UseBasicParsing
            Write-Host "      Downloaded cloudflared successfully to $localCloudflared" -ForegroundColor Green
            $cloudflaredCmd = $localCloudflared
        } catch {
            Write-Host "[Error] Could not download cloudflared: $_" -ForegroundColor Red
            Write-Host "Please download cloudflared.exe manually from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
            exit 1
        }
    }
}

Write-Host "[2/3] Checking SmartPrint server on port $Port..." -ForegroundColor Cyan
$serverRunning = $false
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2 -UseBasicParsing -ErrorAction SilentlyContinue
    if ($resp.StatusCode -eq 200) { $serverRunning = $true }
} catch {}

if (-not $serverRunning) {
    Write-Host "      Starting SmartPrint Node.js server..." -ForegroundColor Yellow
    $serverProcess = Start-Process node -ArgumentList "--env-file-if-exists=.env server/index.js" -PassThru -NoNewWindow
    Start-Sleep -Seconds 3
}

Write-Host "[3/3] Establishing Cloudflare Edge Tunnel..." -ForegroundColor Cyan
Write-Host "      Routing http://127.0.0.1:$Port through Cloudflare's Global Network..." -ForegroundColor Gray
Write-Host ""

$tunnelProcess = Start-Process $cloudflaredCmd -ArgumentList "tunnel --url http://127.0.0.1:$Port" -PassThru -NoNewWindow

Wait-Process -Id $tunnelProcess.Id
