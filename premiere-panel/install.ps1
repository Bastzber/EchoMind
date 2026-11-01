# EchoMind panel installer (Premiere Pro 2022+, CEP)
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI,
# so non-ASCII text here would be mangled and break parsing.
$ErrorActionPreference = 'Stop'

$bundleId = 'com.echomind.panel'
$src = Split-Path -Parent $MyInvocation.MyCommand.Path
$dest = Join-Path $env:APPDATA "Adobe\CEP\extensions\$bundleId"

Write-Host "Source : $src"
Write-Host "Target : $dest"

if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path (Join-Path $src '*') -Destination $dest -Recurse -Force

# Allow unsigned CEP extensions (debug mode) for CSXS 9..12 (PR 2022 uses 11)
foreach ($v in @('9','10','11','12')) {
    $key = "HKCU:\Software\Adobe\CSXS.$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name 'PlayerDebugMode' -Value '1' -PropertyType String -Force | Out-Null
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
Write-Host 'Next steps:'
Write-Host '  1) Fully quit Premiere Pro (File > Exit), not just close the window'
Write-Host '  2) Start Premiere Pro again'
Write-Host '  3) Menu: Window > Extensions > EchoMind Search'
