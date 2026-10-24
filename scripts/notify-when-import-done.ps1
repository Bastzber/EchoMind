# -*- coding: utf-8 -*-
# 等导入+索引跑完 -> 写入大羽标注 -> 弹出置顶提示窗口（游戏里也能看到）
param(
  [int]$PollSeconds = 60,
  [int]$StableCount = 3,
  [string]$Python = 'E:\音效库管理软件\EchoMind\EchoMind-main\.venv\Scripts\python.exe',
  [string]$Repo = 'E:\音效库管理软件\EchoMind\EchoMind-main',
  [string]$StateFile = 'E:\AI音效管理器\import-done.json'
)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$nl = [char]10

function Get-IndexStatus {
  try { return Invoke-RestMethod "http://127.0.0.1:8000/api/v1/projects/default/index/status" -TimeoutSec 30 }
  catch { return $null }
}

function Is-Done($status) {
  if (-not $status) { return $false }
  $pending = 0; $processing = 0
  foreach ($k in @("waveform", "audio_vector", "text_vector")) {
    $a = $status.artifacts.$k
    if ($a) { $pending += [int]$a.pending; $processing += [int]$a.processing }
  }
  return ($pending -eq 0 -and $processing -eq 0)
}

Write-Host "[watch] 开始监控索引状态，每 $PollSeconds 秒检查一次"
$stable = 0
$lastTotal = -1
while ($true) {
  $status = Get-IndexStatus
  if (-not $status) { Start-Sleep -Seconds $PollSeconds; continue }
  $total = [int]$status.total_files
  $pending = 0; $processing = 0; $ready = 0; $failed = 0
  foreach ($k in @("waveform", "audio_vector", "text_vector")) {
    $a = $status.artifacts.$k
    if ($a) { $pending += [int]$a.pending; $processing += [int]$a.processing; $ready += [int]$a.ready; $failed += [int]$a.failed }
  }
  Write-Host ("[watch] 文件 {0}  待处理 {1}  处理中 {2}  就绪 {3}  失败 {4}" -f $total, $pending, $processing, $ready, $failed)
  if ((Is-Done $status) -and ($total -eq $lastTotal)) {
    $stable++
    if ($stable -ge $StableCount) { Write-Host "[watch] 索引完成，开始写入大羽标注"; break }
  } else { $stable = 0 }
  $lastTotal = $total
  Start-Sleep -Seconds $PollSeconds
}

$annotateLog = "E:\AI音效管理器\annotate.log"
& $Python (Join-Path $Repo "scripts\apply_dayu_annotations.py") --apply *>&1 | Tee-Object -FilePath $annotateLog | Out-Null
$annotateText = ""
try { $annotateText = (Get-Content $annotateLog -Tail 3 -Encoding UTF8) -join " " } catch {}

$final = Get-IndexStatus
$total = if ($final) { $final.total_files } else { 0 }
$summary = "导入与索引完成" + $nl + $nl + ("库内文件: " + $total) + $nl + ("大羽标注: " + $annotateText)
$summary | Out-File $StateFile -Encoding UTF8
Write-Host "[watch] $summary"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "EchoMind - 任务完成"
$form.TopMost = $true
$form.StartPosition = "CenterScreen"
$form.Width = 660
$form.Height = 320
$form.BackColor = [System.Drawing.Color]::FromArgb(32, 32, 36)
$form.ForeColor = [System.Drawing.Color]::White

$label = New-Object System.Windows.Forms.Label
$label.Text = $summary
$label.Dock = "Fill"
$label.Font = New-Object System.Drawing.Font("Microsoft YaHei", 12)
$label.TextAlign = "MiddleCenter"
$form.Controls.Add($label)

$ok = New-Object System.Windows.Forms.Button
$ok.Text = "知道了"
$ok.Dock = "Bottom"
$ok.Height = 44
$ok.BackColor = [System.Drawing.Color]::FromArgb(139, 92, 246)
$ok.ForeColor = [System.Drawing.Color]::White
$ok.FlatStyle = "Flat"
$ok.Add_Click({ $form.Close() })
$form.Controls.Add($ok)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 8000
$timer.Add_Tick({ $form.TopMost = $true; $form.Activate(); [System.Media.SystemSounds]::Exclamation.Play() })
$timer.Start()

for ($i = 0; $i -lt 3; $i++) { [System.Media.SystemSounds]::Exclamation.Play(); Start-Sleep -Milliseconds 400 }

$form.Add_Shown({ $form.Activate() })
[System.Windows.Forms.Application]::Run($form)
$timer.Stop()
$form.Dispose()