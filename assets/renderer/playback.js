/* playback.js —— PLAYBACK
 * 从 index.html 原样搬出的完整顶层函数。
 */
function startPlayback() {
    if (!currentSound) return;

    if (audioPlayer && audioPlayer.src) {
        // 无选区播放，重置播放上下文
        playbackStartedInSelection = false;
        playbackStartTime = audioPlayer.currentTime;

        // 保存 play() 返回的 Promise，防止被 pause() 中断时报错
        playPromise = audioPlayer.play();
        playPromise
            .then(() => {
                isPlaying = true;
                startPlaybackAnimation(); // 启动毫秒级动画更新
                updatePlaybackUI();
                updatePlayButtonState();
                broadcastPlayState();
            })
            .catch(error => {
                // 只有当不是被主动暂停时才报错
                if (error.name !== 'AbortError') {
                    console.error('播放失败:', error);
                    showNotification('播放失败: ' + error.message, 'error');
                }
                isPlaying = false;
                updatePlaybackUI();
                updatePlayButtonState();
            })
            .finally(() => {
                playPromise = null;
            });
    } else {
        // 如果没有音频源，重新加载
        loadAndPlaySound(currentSound);
    }
}

function pausePlayback() {
    // 如果有正在进行的播放 Promise，等待它完成再暂停
    if (playPromise) {
        playPromise
            .then(() => {
                if (audioPlayer) {
                    audioPlayer.pause();
                }
            })
            .catch(() => {
                // Promise 被拒绝，说明播放被中断，无需处理
            })
            .finally(() => {
                isPlaying = false;
                stopPlaybackAnimation(); // 停止动画更新
                updatePlaybackUI();
                updatePlayButtonState();
                playPromise = null;
                broadcastPlayState();
            });
    } else {
        if (audioPlayer) {
            audioPlayer.pause();
        }
        isPlaying = false;
        stopPlaybackAnimation(); // 停止动画更新
        updatePlaybackUI();
        updatePlayButtonState();
        broadcastPlayState();
    }
}

function updatePlayButtonState() {
    document.querySelectorAll('.play-sound-btn').forEach(btn => {
        const soundId = String(btn.dataset.id);
        const isCurrent = currentSound && String(currentSound.id) === soundId;
        const icon = btn.querySelector('i');
        if (icon) {
            icon.setAttribute('data-lucide', isCurrent && isPlaying ? 'pause' : 'play');
        }
        // 更新播放指示器
        const row = btn.closest('.sound-row');
        if (row) {
            const nameDiv = row.querySelector('.flex-1');
            if (nameDiv) {
                let indicator = nameDiv.querySelector('.playing-indicator');
                if (isCurrent && isPlaying) {
                    if (!indicator) {
                        indicator = document.createElement('div');
                        indicator.className = 'playing-indicator';
                        indicator.innerHTML = '<span></span><span></span><span></span><span></span>';
                        nameDiv.appendChild(indicator);
                    }
                } else if (indicator) {
                    indicator.remove();
                }
            }
        }
    });
    // 普通列表行的播放按钮（data-path 标识）同步播放/暂停视觉
    document.querySelectorAll('.play-btn').forEach(btn => {
        const path = btn.dataset.path;
        const isCurrent = currentSound && currentSound.path === path;
        const icon = btn.querySelector('i');
        if (icon) {
            icon.setAttribute('data-lucide', isCurrent && isPlaying ? 'pause' : 'play');
            if (isCurrent && isPlaying) {
                btn.style.color = '#8b5cf6';
            } else {
                btn.style.color = '';
            }
        }
    });
    lucide.createIcons();
}

function stopPlayback() {
    if (audioPlayer) {
        audioPlayer.pause();
        audioPlayer.currentTime = 0;
    }
    // 释放 Blob URL，防止内存泄漏
    if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
        currentBlobUrl = null;
    }
    isPlaying = false;
    playbackProgress = 0;
    stopPlaybackAnimation(); // 停止动画更新
    updatePlaybackUI();
    renderSoundList(document.getElementById('searchInput').value);
}

// 播放头用哪条时长来换算：优先用 <audio> 自己报的时长（真实播的那条），
// 库里的 duration 是入库时算的，转码/缓存副本偶尔差几秒，用错就会看到
// 播放头和声音越走越偏（用户反馈差 2-3 秒）。
function effectiveDurationSec() {
    const audioDur = (typeof audioPlayer !== 'undefined' && audioPlayer && Number.isFinite(audioPlayer.duration))
        ? Number(audioPlayer.duration) : 0;
    if (audioDur > 0.05) return audioDur;
    return Number(currentSound?.duration) || 0;
}

// waveformDuration 的单位不统一：后端解码给的是「秒」，重复检测那条路径塞的是「毫秒」。
// 直接拿去当分母会出现「一秒走完整个进度条」（毫秒÷秒=1000倍）。
// 这里统一换算成秒：拿音频真实时长当参照，取更接近的那个量级。
function waveformDurationSec() {
    const audioDur = effectiveDurationSec();
    const raw = Number(currentSound?.waveformDuration);
    if (!Number.isFinite(raw) || raw <= 0) return audioDur;
    if (audioDur > 0.05) {
        const asSeconds = Math.abs(raw - audioDur);
        const asMillis = Math.abs(raw / 1000 - audioDur);
        return asMillis < asSeconds ? raw / 1000 : raw;
    }
    return raw > 10000 ? raw / 1000 : raw;
}

function displayProgressRatio() {
    // 分母优先用 <audio> 自己报的时长：这样进度条一定和「实际在播的声音」同步收尾，
    // 不受库里/波形元数据那条时长准不准的影响（用户反馈 3:10 的音频，条到 3:00 就停了）。
    // audio 还没加载时再退回 waveformDuration。
    const duration = effectiveDurationSec() || waveformDurationSec();
    if (!duration) return 0;
    const raw = (playbackProgress / 1000) / duration;
    const ratio = reverseMode ? (1 - raw) : raw;
    return Math.max(0, Math.min(1, ratio));
}

function displayCurrentTimeMs() {
    const duration = effectiveDurationSec();
    if (!duration) return playbackProgress;
    return reverseMode ? Math.max(0, duration - playbackProgress) : playbackProgress;
}

function updatePlaybackUI() {
    const playIcon = document.getElementById('playIcon');
    const pauseIcon = document.getElementById('pauseIcon');
    const currentTimeEl = document.getElementById('currentTime');
    const durationTimeEl = document.getElementById('durationTime');
    const progressBar = document.getElementById('progressBar');
    
    if (!playIcon || !pauseIcon || !currentTimeEl || !durationTimeEl || !progressBar) return;
    
    if (isPlaying) {
        playIcon.classList.add('hidden');
        pauseIcon.classList.remove('hidden');
    } else {
        playIcon.classList.remove('hidden');
        pauseIcon.classList.add('hidden');
    }
    
    if (currentSound) {
        currentTimeEl.textContent = formatTime(displayCurrentTimeMs());
        durationTimeEl.textContent = formatTime(effectiveDurationSec() * 1000);

        const progress = displayProgressRatio() * 100;
        progressBar.style.width = `${progress}%`;
        
        // 更新音频信息显示
        updateAudioInfo();
    } else {
        currentTimeEl.textContent = '00:00.000';
        durationTimeEl.textContent = '00:00.000';
        progressBar.style.width = '0%';
        // 清空音频信息
        updateAudioInfo();
    }
}

