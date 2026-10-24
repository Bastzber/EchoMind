# Dev loop: run Electron from source (no packaging). Frontend reload = Ctrl+R.
# Backend runs from .venv python (main.js falls back to source when not packaged).
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

#
# Keep every env assignment ABOVE any non-ASCII comment.
# Windows PowerShell 5.1 reads a BOM-less .ps1 as GBK; a UTF-8 Chinese comment can
# swallow the following line into itself, so the assignment silently never ran.
# That is exactly what happened to SOUNDBOT_BACKEND_DEV below: dev mode quietly
# loaded the stale dist\backend binary instead of .venv python, and every new
# endpoint answered 404. This file is now saved UTF-8 *with* BOM as well.
#
$env:ELECTRON_ENABLE_LOGGING = '1'
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:SOUNDBOT_BACKEND_DEV = '1'

Get-Process -Name 'EchoMind', 'soundbot-backend' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# Also stop a previously launched dev instance. Without this the old window keeps the
# single-instance lock, the new launch exits instantly, and the *old* process (which
# never saw SOUNDBOT_BACKEND_DEV) restarts the packaged backend -- silently undoing dev mode.
Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Set-Location $root
Write-Host '[dev] starting electron from source...'

# Call node_modules\electron\dist\electron.exe directly (do not depend on PATH's npx)
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
