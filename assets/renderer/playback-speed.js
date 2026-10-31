/* playback-speed.js —— 倍速 / 倒放
 * 从 index.html 原样搬出的完整顶层函数。
 */
function applyPlaybackRate() {
    if (audioPlayer) {
        try { audioPlayer.playbackRate = playbackRate; } catch (_) { }
    }
    const label = document.getElementById('playbackRateLabel');
    if (label) label.textContent = formatRate(playbackRate);
    const slider = document.getElementById('playbackRateSlider');
    if (slider && Number(slider.value) !== playbackRate) slider.value = String(playbackRate);
}

function formatRate(value) {
    const rounded = Math.round(Number(value) * 100) / 100;
    return (Number.isInteger(rounded) ? String(rounded) : String(rounded)) + '×';
}

function setPlaybackRate(value) {
    const next = Math.min(6, Math.max(0.25, Number(value) || 1));
    playbackRate = Math.round(next * 20) / 20;   // 0.05 步进
    try { localStorage.setItem('echomind.playbackRate', String(playbackRate)); } catch (_) { }
    applyPlaybackRate();
}

function updateReverseButton() {
    const button = document.getElementById('reverseBtn');
    if (!button) return;
    button.style.background = reverseMode ? 'rgba(107,138,253,0.18)' : 'transparent';
    button.style.color = reverseMode ? 'var(--accent-color, #6b8afd)' : '';
    button.title = reverseMode ? '倒放中（点击恢复正放）' : '倒放（生成反向临时文件）';
}

async function fetchReversedPath(sound) {
    const filePath = sound?.filePath;
    if (!filePath) throw new Error('缺少文件路径');
    const cacheKey = filePath + '|' + (sound.duration || 0);
    if (reverseSourceCache.has(cacheKey)) return reverseSourceCache.get(cacheKey);
    const result = await rendererApi.post('/api/v1/audio/reverse', { path: filePath }, { timeoutMs: 120000 });
    if (!result?.path) throw new Error(result?.detail || '倒放失败');
    const src = 'soundmind-audio://local/' + encodeURIComponent(result.path);
    reverseSourceCache.set(cacheKey, src);
    return src;
}

async function resolveAudioSourceWithReverse(sound, options) {
    // 倒放 > 效果器 > 声道混音 > 原文件
    if (!reverseMode && effectState.active && effectState.preset !== 'dry') {
        try {
            const effected = await buildEffectSource(sound);
            if (effected) return effected;
        } catch (error) {
            console.warn('[Effect] 生成失败，回退原文件:', error);
        }
    }
    if (!reverseMode) {
        try {
            const mixed = await resolveChannelSource(sound);
            if (mixed) return mixed;
        } catch (error) {
            console.warn('[Channels] 混音失败，回退原文件:', error);
        }
        return rendererAudio.resolvePlaybackSource(sound, options);
    }
    try {
        return await fetchReversedPath(sound);
    } catch (error) {
        console.warn('[Player] 倒放失败，回退正放:', error);
        showNotification('倒放失败，已按正放播放：' + (error?.message || error), 'warning');
        reverseMode = false;
        updateReverseButton();
        return rendererAudio.resolvePlaybackSource(sound, options);
    }
}

function bindPlaybackRateAndReverse() {
    const slider = document.getElementById('playbackRateSlider');
    const hint = document.getElementById('playbackRateHint');
    if (slider) {
        slider.value = String(playbackRate);
        slider.title = '拖动调速（0.25×–6×）；双击方块或数字复位 1.0×；Ctrl+↑/↓ 微调';
        slider.addEventListener('pointerenter', () => { if (hint) hint.classList.remove('hidden'); });
        slider.addEventListener('pointerleave', () => { if (hint) hint.classList.add('hidden'); });
        slider.addEventListener('input', () => setPlaybackRate(slider.value));
        slider.addEventListener('change', () => {
            setPlaybackRate(slider.value);
            // 关键：拖动后滑条会抢占焦点，导致全局空格键被"输入框保护"吞掉
            slider.blur();
        });
        // 双击复位
        slider.addEventListener('dblclick', () => { setPlaybackRate(1); slider.blur(); });
    }

    // Ctrl + ↑ / ↓ 微调（Shift 加倍）
    document.addEventListener('keydown', (event) => {
        if (!event.ctrlKey) return;
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        const el = document.activeElement;
        if (el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type !== 'range'))) return;
        event.preventDefault();
        const step = event.shiftKey ? 0.25 : 0.05;
        setPlaybackRate(playbackRate + (event.key === 'ArrowUp' ? step : -step));
    });
    const label = document.getElementById('playbackRateLabel');
    if (label) {
        label.addEventListener('click', () => setPlaybackRate(1));
        label.addEventListener('dblclick', () => setPlaybackRate(1));
    }
    applyPlaybackRate();
    const button = document.getElementById('reverseBtn');
    if (button) {
        updateReverseButton();
        button.addEventListener('click', async () => {
            const wasPlaying = Boolean(isPlaying);
            const position = audioPlayer ? audioPlayer.currentTime : 0;
            reverseMode = !reverseMode;
            try { localStorage.setItem('echomind.reverseMode', reverseMode ? '1' : '0'); } catch (_) { }
            updateReverseButton();
            if (!currentSound) return;
            try {
                const source = await resolveAudioSourceWithReverse(currentSound, {
                    api: rendererApi,
                    projectId: currentProject?.id || 'default'
                });
                if (!audioPlayer) initAudioPlayer();
                audioPlayer.pause();
                audioPlayer.src = source;
                audioPlayer.load();
                await rendererAudio.waitForMetadata(audioPlayer);
                applyPlaybackRate();
                if (position > 0) {
                    try { audioPlayer.currentTime = Math.min(position, audioPlayer.duration || position); } catch (_) { }
                }
                if (wasPlaying) {
                    await audioPlayer.play();
                    isPlaying = true;
                }
                showNotification(reverseMode ? '已切换倒放' : '已恢复正放', 'success');
            } catch (error) {
                showNotification('切换播放方向失败: ' + (error?.message || error), 'error');
            }
        });
    }
}

function attachPlayerHandlers(el) {
    el.addEventListener('ended', () => {
        if (el !== audioPlayer) return;
        if (isLooping) {
            el.currentTime = 0;
            el.play();
        } else {
            isPlaying = false;
            stopPlaybackAnimation();
            if (playbackInterval) clearInterval(playbackInterval);
            releaseCurrentBlobUrl();
            updatePlaybackUI();
            broadcastPlayState();
            const searchQuery = document.getElementById('searchInput').value.trim();
            if (allSearchResults.length > 0) {
                renderSoundList('', allSearchResults);
            } else {
                renderSoundList(searchQuery);
            }
        }
    });
    el.addEventListener('timeupdate', () => {
        if (el !== audioPlayer || !currentSound) return;
        playbackProgress = Math.round(el.currentTime * 1000);
        updatePlaybackUI();
    });
    el.addEventListener('loadedmetadata', () => {
        if (el !== audioPlayer || !currentSound) return;
        currentSound.duration = Math.round(el.duration * 1000);
        updatePlaybackUI();
    });
    el.addEventListener('error', (e) => {
        if (el !== audioPlayer) return;
        console.error('[Player] 音频加载失败:', e);
        showNotification('音频加载失败', 'error');
        isPlaying = false;
        updatePlaybackUI();
        broadcastPlayState();
    });
}

function initAudioPlayer() {
    audioPlayer = new Audio();
    audioPlayer.preload = 'metadata';
    attachPlayerHandlers(audioPlayer);
}

async function switchPlaybackSource(src, position, wasPlaying) {
    const next = new Audio();
    next.preload = 'auto';
    next.src = src;
    next.volume = channelState.silent ? 0 : currentVolume / 100;
    next.muted = isMuted;
    next.loop = isLooping;
    try { next.playbackRate = playbackRate; } catch (_) { }
    await new Promise((resolve, reject) => {
        let settled = false;
        const done = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            next.removeEventListener('loadedmetadata', onOk);
            next.removeEventListener('error', onErr);
            if (ok) resolve(); else reject(new Error('音源加载失败'));
        };
        const onOk = () => done(true);
        const onErr = () => done(false);
        const timer = setTimeout(() => done(true), 6000);
        next.addEventListener('loadedmetadata', onOk);
        next.addEventListener('error', onErr);
        next.load();
    });
    try {
        next.currentTime = Math.min(position, next.duration || position);
    } catch (_) { }
    const previous = audioPlayer;
    attachPlayerHandlers(next);
    audioPlayer = next;
    if (previous) {
        try { previous.pause(); previous.removeAttribute('src'); previous.load(); } catch (_) { }
    }
    if (wasPlaying) { await next.play(); isPlaying = true; }
    return next;
}

async function loadAndPlaySound(sound) {
    console.log('[loadAndPlaySound] 开始播放:', sound);

    try {
        if (!sound.filePath) {
            console.error('[loadAndPlaySound] 缺少文件路径');
            showNotification('无法播放：缺少文件路径', 'error');
            return;
        }

        // 确保 audioPlayer 存在
        if (!audioPlayer) {
            console.log('[loadAndPlaySound] 初始化 audioPlayer');
            initAudioPlayer();
        }

        // 释放旧的 Blob URL，防止内存泄漏
        releaseCurrentBlobUrl();

        await loadChannelsFor(sound);

        let audioSrc = await resolveAudioSourceWithReverse(sound, {
            api: rendererApi,
            projectId: currentProject?.id || 'default'
        });
        console.log('[Frontend] 播放音频源:', audioSrc);

        // 先暂停当前播放的音频
        audioPlayer.pause();
        
        // 设置音频源
        audioPlayer.src = audioSrc;
        audioPlayer.load();  // 强制加载新音频，确保切换音频时正确加载
        audioPlayer.volume = currentVolume / 100;
        audioPlayer.muted = isMuted;
        audioPlayer.loop = isLooping;

        console.log('[loadAndPlaySound] 开始播放...');

        await rendererAudio.waitForMetadata(audioPlayer);

        // 尝试播放
        try {
            applyPlaybackRate();
            await audioPlayer.play();
            isPlaying = true;
            rememberEvent('play', sound);
            startPlaybackAnimation(); // 启动毫秒级动画更新
            console.log('[loadAndPlaySound] 播放成功');
            broadcastPlayState();
        } catch (playError) {
            console.error('[loadAndPlaySound] 播放失败:', playError);
            // 如果本地协议失败，回退到后端文件直出接口；仍然避免整文件 IPC 搬运。
            if (window.electronAPI?.backendAPI?.getAudioUrl) {
                try {
                    const fallback = await window.electronAPI.backendAPI.getAudioUrl(sound.filePath);
                    if (!fallback?.url) {
                        throw playError;
                    }
                    audioSrc = fallback.url;
                    audioPlayer.src = audioSrc;
                    audioPlayer.load();
                    await rendererAudio.waitForMetadata(audioPlayer);
                    await audioPlayer.play();
                    isPlaying = true;
                    startPlaybackAnimation(); // 启动毫秒级动画更新
                    console.log('[loadAndPlaySound] 后备方案播放成功');
                    broadcastPlayState();
                } catch (e2) {
                    console.error('[loadAndPlaySound] 后备方案也失败:', e2);
                    showNotification('播放失败: ' + e2.message, 'error');
                }
            } else {
                showNotification('播放失败: ' + playError.message, 'error');
            }
        }

        updatePlaybackUI();
        // 如果有搜索结果（包括AI搜索），保持显示搜索结果；否则显示正常列表
        const searchQuery = document.getElementById('searchInput').value.trim();
        if (allSearchResults.length > 0) {
            renderSoundList('', allSearchResults);
        } else {
            renderSoundList(searchQuery);
        }

    } catch (error) {
        console.error('[loadAndPlaySound] 总体错误:', error);
        if (typeof showNotification === 'function') {
            showNotification('播放失败: ' + error.message, 'error');
        } else {
            alert('播放失败: ' + error.message);
        }
        // 确保即使出错也更新 UI
        isPlaying = false;
        updatePlaybackUI();
    }
}

