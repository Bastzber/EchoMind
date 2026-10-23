# Dev loop: run Electron from source (no packaging). Frontend reload = Ctrl+R.
# Backend runs from .venv python (main.js falls back automatically when not packaged).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

Get-Process -Name 'EchoMind', 'soundbot-backend' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

Set-Location $root
Write-Host '[dev] starting electron from source...'
$env:ELECTRON_ENABLE_LOGGING = '1'
# 关键：某些环境里 ELECTRON_RUN_AS_NODE=1，会让 electron.exe 退化成 node
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

# 直接调用 node_modules 里的 electron.exe，避免依赖 PATH 里的 npx
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electron)) {
    Write-Host "[dev] electron.exe not found at $electron"
    exit 1
}
Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $root

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8000/api/v1/health' -TimeoutSec 3 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            Write-Host '[dev] backend healthy'
            Write-Host '[dev] change files, then press Ctrl+R in the app window to reload the UI'
            exit 0
        }
    } catch {
        Start-Sleep -Seconds 2
    }
}
Write-Host '[dev] backend did not become healthy in time'
exit 1
