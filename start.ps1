# Launcher: starts the DeepSeek bridge in a new window, waits for /health,
# then runs `claude` in the current window with ANTHROPIC_BASE_URL pointed at it.

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Read PORT and PROXY_API_KEY from .env (if present).
$port = 4141
$apiKey = 'proxy_api_key'
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile) {
        if ($line -match '^\s*PORT\s*=\s*(\d+)\s*$') {
            $port = [int]$Matches[1]
        }
        elseif ($line -match '^\s*PROXY_API_KEY\s*=\s*(.+?)\s*$') {
            $apiKey = $Matches[1]
        }
    }
}
else {
    Write-Host ".env not found. Copy the template and fill DEEPSEEK_TOKEN first." -ForegroundColor Red
    exit 1
}

# Pick a runner: prefer standalone `bun`, fall back to `npx bun`.
$bunCmd = if (Get-Command bun -ErrorAction SilentlyContinue) { 'bun' } else { 'npx bun' }

# Start the bridge in a new PowerShell window so logs stay visible.
$bridgeCmd = "Set-Location -LiteralPath '$root'; $bunCmd run index.ts"
$proc = Start-Process -FilePath 'powershell.exe' `
    -ArgumentList '-NoExit', '-NoProfile', '-Command', $bridgeCmd `
    -WindowStyle Normal -PassThru

Write-Host "Bridge PID: $($proc.Id). Waiting for http://localhost:$port/health ..." -ForegroundColor Cyan

# Poll /health until ready (max ~15s).
$ok = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-RestMethod -Uri "http://localhost:$port/health" -TimeoutSec 1 -ErrorAction Stop
        if ($r.ok) { $ok = $true; break }
    }
    catch { }
    Start-Sleep -Milliseconds 500
}

if (-not $ok) {
    Write-Host "Bridge did not respond in 15s. Check the bridge window for errors." -ForegroundColor Red
    exit 1
}

Write-Host "Bridge is up. Launching Claude Code..." -ForegroundColor Green
$env:ANTHROPIC_BASE_URL = "http://localhost:$port"
$env:ANTHROPIC_API_KEY = $apiKey
claude @args
