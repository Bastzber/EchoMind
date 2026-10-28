# 启动本地 Breeze TTS 2 语音服务（Windows / Vulkan）
$exe = 'E:\AI音效管理器\breeze\breeze-tts-2-v0.1.3-windows-x64-vulkan\breeze-server.exe'
$model = Join-Path $env:USERPROFILE 'breeze-weights\breeze-tts-2-q8_0.gguf'
if (-not (Test-Path $exe)) { Write-Error '找不到 breeze-server.exe'; exit 1 }
if (-not (Test-Path $model)) { Write-Error '找不到 GGUF 权重'; exit 1 }
Write-Host '启动 Breeze TTS 2（127.0.0.1:8080）…'
& $exe $model --port 8080 --host 127.0.0.1 --webui