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

function displayProgressRatio() {
    const duration = Number(currentSound?.duration) || 0;
    if (!duration) return 0;
    const raw = playbackProgress / duration;
    const ratio = reverseMode ? (1 - raw) : raw;
    return Math.max(0, Math.min(1, ratio));
}

function displayCurrentTimeMs() {
    const duration = Number(currentSound?.duration) || 0;
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
        durationTimeEl.textContent = formatTime(currentSound.duration);

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

