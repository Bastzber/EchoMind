/* sound-list.js —— 音效列表渲染与分页
 * 从 index.html 原样搬出，全局语义不变。
 */
// ==================== SOUND LIST ====================
// 卡片视图渲染
function renderSoundCards(container, sounds) {
    sounds.forEach((sound) => {
        const card = document.createElement('div');
        card.className = 'sound-card rounded-lg border p-3 flex flex-col gap-2 cursor-pointer transition-colors hover:border-white/20';
        card.style.borderColor = 'var(--border-color)';
        card.style.background = 'var(--bg-secondary)';
        card.dataset.id = sound.id;

        const tags = (sound.tags || []).map((tag) =>
            `<span class="px-1.5 py-0.5 rounded text-[10px]" style="background: var(--bg-tertiary);">${escapeHtml(tag)}</span>`
        ).join('');

        card.innerHTML = `
            <div class="flex items-start justify-between gap-2">
                <div class="text-sm font-medium truncate flex-1 min-w-0">${escapeHtml(sound.name || '')}</div>
                <button class="card-fav shrink-0" title="${sound.favorite ? '取消收藏' : '收藏'}"
                        style="color: ${sound.favorite ? '#f59e0b' : 'var(--text-secondary)'}; opacity: ${sound.favorite ? 1 : 0.35}; font-size: 14px;">${sound.favorite ? '★' : '☆'}</button>
                <span class="text-[10px] opacity-50 shrink-0">${formatDuration((sound.duration || 0) / 1000)}</span>
            </div>
            <div class="text-xs opacity-60 overflow-hidden" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;min-height:2.4em;">
                ${escapeHtml(sound.aiDescription || '（暂无描述）')}
            </div>
            <div class="flex flex-wrap gap-1 min-h-[18px]">${tags}</div>
            <canvas class="mini-waveform w-full" height="28" data-id="${escapeHtml(String(sound.id))}"></canvas>
        `;

        const cardFav = card.querySelector('.card-fav');
        if (cardFav) {
            cardFav.addEventListener('click', async (e) => {
                e.stopPropagation();
                const next = !sound.favorite;
                sound.favorite = next;
                cardFav.textContent = next ? '★' : '☆';
                cardFav.style.color = next ? '#f59e0b' : 'var(--text-secondary)';
                cardFav.style.opacity = next ? '1' : '0.35';
                try {
                    await rendererApi.post(`/api/v1/files/${encodeURIComponent(sound.id)}/favorite`, { favorite: next }, { timeoutMs: 15000 });
                    loadFavoriteCount();
                } catch (error) {
                    sound.favorite = !next;
                    showNotification('收藏失败: ' + error.message, 'error');
                }
            });
        }

        card.addEventListener('click', (e) => {
            if (e.target.closest('.mini-waveform')) {
                selectAndPlaySound(sound);
                return;
            }
            selectAndPlaySound(sound);
        });
        card.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showSoundContextMenu(e, sound);
        });
        container.appendChild(card);
    });
    lucide.createIcons();
    drawMiniWaveforms(sounds);
}

// 视图模式：list（表格）/ card（卡片），存本地
let viewMode = (() => {
    try { return localStorage.getItem('echomind.viewMode') || 'list'; } catch (_) { return 'list'; }
})();

// 排序：纯前端对当前列表排序，配合“全选当前筛选结果”
function currentSortMode() {
    const el = document.getElementById('sortSelect');
    const value = (el && el.value) || 'date-desc';
    const [field, order] = value.split('-');
    return { field, order };
}

function sortSounds(list) {
    const { field, order } = currentSortMode();
    if (!Array.isArray(list) || !list.length) return list;
    const copy = list.slice();
    const desc = order === 'desc';
    copy.sort((a, b) => {
        let result = 0;
        if (field === 'name') result = String(a.name || '').localeCompare(String(b.name || ''), 'zh');
        else if (field === 'duration') result = (a.duration || 0) - (b.duration || 0);
        else if (field === 'size') result = (a.size || 0) - (b.size || 0);
        else result = String(a.id || '').localeCompare(String(b.id || ''));
        return desc ? -result : result;
    });
    return copy;
}

function applyViewMode() {
    const container = document.getElementById('soundList');
    const header = document.getElementById('listHeader');
    const listBtn = document.getElementById('viewListBtn');
    const cardBtn = document.getElementById('viewCardBtn');
    const isCard = viewMode === 'card';
    if (container) {
        container.classList.toggle('p-3', isCard);
        container.classList.toggle('grid', isCard);
        container.classList.toggle('grid-cols-[repeat(auto-fill,minmax(220px,1fr))]', isCard);
        container.classList.toggle('gap-3', isCard);
        container.classList.toggle('content-start', isCard);
    }
    if (header) header.classList.toggle('hidden', isCard);
    if (listBtn) listBtn.style.opacity = isCard ? '0.5' : '1';
    if (cardBtn) cardBtn.style.opacity = isCard ? '1' : '0.5';
}

function setViewMode(mode) {
    viewMode = mode === 'card' ? 'card' : 'list';
    try { localStorage.setItem('echomind.viewMode', viewMode); } catch (_) { }
    applyViewMode();
    if (aiResultMode && allSearchResults.length) {
        renderSoundList('', allSearchResults);
    } else if (lastRenderArgs) {
        renderSoundList(lastRenderArgs.filter, lastRenderArgs.sounds);
    } else {
        renderSoundList(document.getElementById('searchInput')?.value || '');
    }
}

// 记住最近一次渲染用的数据源：切换列表/卡片时要原样重画，
// 否则会退回 soundData（整库分页），搜索结果直接变空
let lastRenderArgs = null;
function renderSoundList(filter = '', sounds = soundData) {
    lastRenderArgs = { filter, sounds };
    const container = document.getElementById('soundList');
    container.innerHTML = '';
    applyViewMode();
    
    let filteredSounds = sounds.filter(sound => 
        (sound.name || '').toLowerCase().includes(filter.toLowerCase()) ||
        (Array.isArray(sound.tags) && sound.tags.some(tag => String(tag).toLowerCase().includes(filter.toLowerCase())))
    );
    filteredSounds = sortSounds(filteredSounds);
    lastRenderedSounds = filteredSounds;
    
    // 空状态提示 - 区分无文件和搜索无结果
    if (filteredSounds.length === 0) {
        const emptyDiv = document.createElement('div');
        emptyDiv.className = 'flex items-center justify-center h-full';
        if (soundData.length === 0) {
            // 没有导入任何文件
            emptyDiv.innerHTML = `<span class="text-sm opacity-40 i18n-empty-import" style="color: var(--text-secondary);" data-i18n="empty.import.audio">请导入音频文件</span>`;
        } else {
            // 有文件但搜索无结果
            emptyDiv.innerHTML = `<span class="text-sm opacity-40" style="color: var(--text-secondary);" data-i18n="search.no.results">未检索到结果</span>`;
        }
        container.appendChild(emptyDiv);
        return;
    }
    
    if (viewMode === 'card') {
        renderSoundCards(container, filteredSounds);
        return;
    }

    filteredSounds.forEach(sound => {
        const row = document.createElement('div');
        row.className = `sound-row flex items-center px-4 py-3 border-b cursor-pointer ${selectedSounds.has(sound.id) ? 'selected' : ''}`;
        row.style.borderColor = 'var(--border-color)';
        row.dataset.id = sound.id;
        row.draggable = true;
        
        const isCurrent = currentSound && currentSound.id === sound.id;
        
        // 拖拽事件
        row.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', sound.filePath || '');
            e.dataTransfer.setData('text/uri-list', sound.filePath ? 'file://' + sound.filePath : '');
            e.dataTransfer.effectAllowed = 'copy';
            
            // 如果有 filePath，设置为拖拽的文件
            if (sound.filePath) {
                // 尝试设置文件
                try {
                    e.dataTransfer.setData('application/x-moz-file', sound.filePath);
                } catch (err) {}
            }
            
            row.style.opacity = '0.5';
        });
        
        row.addEventListener('dragend', () => {
            row.style.opacity = '1';
        });
        
        // 根据文件格式选择图标
        const fileExt = (sound.name || '').split('.').pop()?.toLowerCase() || '';
        const formatIcons = {
            'wav': 'audio-waveform',
            'mp3': 'music',
            'flac': 'music-2',
            'aiff': 'mic',
            'ogg': 'radio',
            'm4a': 'smartphone',
            'aac': 'music-3'
        };
        const iconName = formatIcons[fileExt] || 'file-audio';

        // 检查是否有封面图片
        const hasCover = sound.cover || sound.coverPath || sound.artwork;
        const coverUrl = sound.cover || sound.coverPath || sound.artwork;

        row.innerHTML = `
            <div class="w-10 flex justify-center">
                <input type="checkbox" class="w-4 h-4 rounded sound-checkbox" data-sound-id="${sound.id}" ${selectedSounds.has(sound.id) ? 'checked' : ''}>
            </div>
            <div class="w-12 flex justify-center">
                <div class="w-8 h-8 rounded border flex items-center justify-center overflow-hidden" style="border-color: var(--border-color);">
                    ${hasCover ? `
                        <img src="${escapeHtml(coverUrl)}" class="w-full h-full object-cover" alt="cover" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                        <i data-lucide="${iconName}" class="w-4 h-4 opacity-70 hidden"></i>
                    ` : `
                        <i data-lucide="${iconName}" class="w-4 h-4 opacity-70"></i>
                    `}
                </div>
            </div>
            <div class="w-32 flex justify-center">
                <canvas class="mini-waveform w-28 h-8" data-id="${sound.id}"></canvas>
            </div>
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2 min-w-0 flex-wrap">
                    <span class="text-sm truncate">${escapeHtml(sound.name)}</span>
                    ${sound.source === 'ai' ? '<span class="px-1 py-0.5 rounded text-[10px] shrink-0" style="background:rgba(139,92,246,.2);color:#a78bfa;">AI</span>' : ''}
                    ${sound.source === 'ai' ? '<span class="px-1 py-0.5 rounded text-[10px] shrink-0" style="background:rgba(139,92,246,.2);color:#a78bfa;">AI</span>' : ''}
                    ${sound.aiDescription ? `<span class="text-xs truncate opacity-50 shrink-0 max-w-[38%]" style="color: var(--text-secondary);" title="${escapeHtml(sound.aiDescription.replace(/^\[auto\]/,''))}">${escapeHtml(sound.aiDescription.replace(/^\[auto\]/,''))}</span>` : ''}
                    ${isCurrent && isPlaying ? `
                        <div class="playing-indicator">
                            <span></span><span></span><span></span><span></span>
                        </div>
                    ` : ''}
                    ${sound.similarity !== undefined ? `
                        <div class="flex items-center gap-1 text-xs opacity-60" title="语义: ${(sound.semanticScore || 0).toFixed(2)}, 关键词: ${(sound.keywordScore || 0).toFixed(2)}">
                            <span class="px-1.5 py-0.5 rounded" style="background: ${sound.keywordOnly ? '#f59e0b' : (sound.keywordScore >= 0.7 ? '#22c55e' : '#3b82f6')}; color: white; font-size: 10px;">
                                ${(sound.similarity * 100).toFixed(0)}%
                            </span>
                            ${sound.keywordOnly ? '<span style="color: #f59e0b;">关键词</span>' : ''}
                        </div>
                    ` : ''}
                </div>
                ${(Array.isArray(sound.tags) && sound.tags.length) ? `
                    <div class="flex flex-wrap items-center gap-1 mt-0.5" title="${escapeHtml(sound.tags.join('、'))}">
                        ${sound.tags.map(tag => `
                            <span class="px-1.5 py-0.5 rounded text-[10px] whitespace-nowrap" style="background: var(--bg-tertiary); color: var(--text-secondary);">${escapeHtml(tag)}</span>
                        `).join('')}
                    </div>
                ` : ''}
            </div>
            <div class="w-24 text-right text-sm opacity-70 font-mono">${formatTime(sound.duration)}</div>
            <div class="w-16 flex items-center justify-center gap-1">
                <button class="favorite-btn w-6 h-6 flex items-center justify-center rounded transition-transform hover:scale-110" data-id="${sound.id}"
                        title="${sound.favorite ? '取消收藏' : '收藏'}">
                    <span style="color: ${sound.favorite ? '#f59e0b' : 'var(--text-secondary)'}; opacity: ${sound.favorite ? 1 : 0.35}; font-size: 14px;">${sound.favorite ? '★' : '☆'}</span>
                </button>
                <button class="play-sound-btn w-7 h-7 rounded-full border flex items-center justify-center transition-all hover:scale-110" data-id="${sound.id}"
                        style="border-color: var(--border-color);">
                    <i data-lucide="${isCurrent && isPlaying ? 'pause' : 'play'}" class="w-3.5 h-3.5"></i>
                </button>
            </div>
        `;
        
        const favBtn = row.querySelector('.favorite-btn');
        if (favBtn) {
            favBtn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const next = !sound.favorite;
                sound.favorite = next;
                favBtn.innerHTML = `<span style="color: ${next ? '#f59e0b' : 'var(--text-secondary)'}; opacity: ${next ? 1 : 0.35}; font-size: 14px;">${next ? '★' : '☆'}</span>`;
                favBtn.title = next ? '取消收藏' : '收藏';
                try {
                    await rendererApi.post(
                        `/api/v1/files/${encodeURIComponent(sound.id)}/favorite`,
                        { favorite: next },
                        { timeoutMs: 15000 }
                    );
                    if (typeof rememberEvent === 'function') rememberEvent('usage', sound, next ? '收藏' : '取消收藏');
                    loadFavoriteCount();
                } catch (error) {
                    sound.favorite = !next;
                    showNotification('收藏失败: ' + error.message, 'error');
                }
            });
        }

        row.addEventListener('click', (e) => {
            if (e.target.closest('.sound-checkbox')) {
                const checkbox = e.target.closest('.sound-checkbox');
                const listIndex = filteredSounds.findIndex(item => item.id === sound.id);
                if (e.shiftKey && lastCheckedIndex >= 0 && listIndex >= 0) {
                    // Shift：从上次位置到当前位置整段选中/取消
                    const [from, to] = lastCheckedIndex < listIndex
                        ? [lastCheckedIndex, listIndex]
                        : [listIndex, lastCheckedIndex];
                    for (let idx = from; idx <= to; idx += 1) {
                        const target = filteredSounds[idx];
                        if (!target) continue;
                        if (checkbox.checked) selectedSounds.add(target.id);
                        else selectedSounds.delete(target.id);
                    }
                    refreshSelectionUI();
                } else {
                    if (checkbox.checked) selectedSounds.add(sound.id);
                    else selectedSounds.delete(sound.id);
                    row.classList.toggle('selected', checkbox.checked);
                }
                lastCheckedIndex = listIndex;
            } else if (e.target.closest('.play-sound-btn')) {
                playSound(sound);
            } else {
                // 单击直接播放（原来只选中，需要再按空格）
                selectAndPlaySound(sound);
            }
        });

        // 右键菜单（Billfish 式文件操作 + 标签操作）
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            showSoundContextMenu(e, sound);
        });
        
        container.appendChild(row);
    });
    
    lucide.createIcons();
    drawMiniWaveforms(filteredSounds);
}

function drawMiniWaveforms(renderedSounds = lastRenderedSounds, options = {}) {
    const renderedSoundMap = new Map((renderedSounds || []).map(sound => [String(sound.id), sound]));

    document.querySelectorAll('.mini-waveform').forEach(canvas => {
        const soundId = String(canvas.dataset.id);
        const sound = renderedSoundMap.get(soundId) || soundData.find(s => String(s.id) === soundId);
        drawMiniWaveformCanvas(canvas, sound);
    });

    // 异步加载没有波形数据的声音的波形
    if (options.queueLoad !== false) queueVisibleWaveformLoad(renderedSounds);
}

function drawMiniWaveformCanvas(canvas, sound) {
    if (!sound) return;
    const isCurrent = currentSound && String(currentSound.id) === String(sound.id);
    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text-primary').trim() || '#e5e5e5';
    const secondaryColor = getComputedStyle(document.documentElement).getPropertyValue('--text-secondary').trim() || '#a3a3a3';
    rendererWaveform.drawMini(canvas, {
        waveformData: getSoundWaveform(sound),
        isCurrent,
        loading: sound.waveformLoading,
        error: sound.waveformError,
        activeColor: textColor,
        inactiveColor: secondaryColor
    });
}

function getVisibleMiniWaveformIds() {
    const container = document.getElementById('soundList');
    if (!container) return new Set();

    const containerRect = container.getBoundingClientRect();
    const visibleIds = new Set();
    document.querySelectorAll('.mini-waveform').forEach(canvas => {
        const rect = canvas.getBoundingClientRect();
        const nearViewport = rect.bottom >= containerRect.top - 80 && rect.top <= containerRect.bottom + 80;
        if (nearViewport) {
            visibleIds.add(String(canvas.dataset.id));
        }
    });
    return visibleIds;
}

function queueVisibleWaveformLoad(renderedSounds = lastRenderedSounds) {
    if (waveformLoadTimer) {
        clearTimeout(waveformLoadTimer);
    }
    waveformLoadTimer = setTimeout(() => {
        loadMissingWaveforms(renderedSounds);
    }, 80);
}

// 异步加载列表中缺少的波形数据
async function loadMissingWaveforms(renderedSounds = lastRenderedSounds) {
    if (!window.electronAPI?.backendAPI) return;
    
    const visibleIds = getVisibleMiniWaveformIds();
    if (visibleIds.size === 0) return;

    // 只加载当前可见区域需要波形且未在加载中的声音，避免启动时扫完整个库
    const soundsNeedingWaveform = (renderedSounds || [])
        .filter(s => visibleIds.has(String(s.id)))
        .filter(s => s.filePath && !getSoundWaveform(s) && !s.waveformLoading && !s.waveformError)
        .slice(0, 12);
    
    if (soundsNeedingWaveform.length === 0) return;
    
    // 标记为加载中，避免重复加载
    soundsNeedingWaveform.forEach(s => s.waveformLoading = true);
    
    // 批量并行加载（最多3个并发）
    const batchSize = 3;
    for (let i = 0; i < soundsNeedingWaveform.length; i += batchSize) {
        const batch = soundsNeedingWaveform.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (sound) => {
            try {
                const waveformData = await rendererWaveform.requestForSound(sound, {
                    backendAPI: window.electronAPI?.backendAPI,
                    projectId: currentProject?.id || 'default',
                    unavailableMessage: i18n.t('waveform.api.unavailable')
                });
                rendererWaveform.applyPayload(sound, waveformData, i18n.t('waveform.invalid'));
                // 只重绘这个特定的波形，而不是整个列表
                drawSingleMiniWaveform(sound.id);
            } catch (e) {
                console.warn(`[Waveform] 加载失败: ${sound.name}`, e);
                sound.waveformError = e?.message || i18n.t('waveform.error');
                drawSingleMiniWaveform(sound.id);
            } finally {
                sound.waveformLoading = false;
            }
        }));

        // 小延迟避免阻塞UI
        if (i + batchSize < soundsNeedingWaveform.length) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
    }
}

// 只绘制单个波形，不重绘整个列表
function drawSingleMiniWaveform(soundId) {
    const canvas = document.querySelector(`.mini-waveform[data-id="${soundId}"]`);
    if (!canvas) return;
    const sound = soundData.find(s => String(s.id) === String(soundId))
        || lastRenderedSounds.find(s => String(s.id) === String(soundId));
    drawMiniWaveformCanvas(canvas, sound);
}

function selectSound(sound, { preload = true } = {}) {
    cancelActiveWaveformRequest();
    const previousSound = currentSound;
    currentSound = sound;
    playbackProgress = 0;
    
    // 暂停当前播放的音频
    if (audioPlayer) {
        audioPlayer.pause();
    }
    
    // 选择新音频时清除选区和相关状态
    selectionStart = null;
    selectionEnd = null;
    playbackStartedInSelection = false;
    playbackStartTime = 0;
    lastStoppedAtSelectionEnd = false;
    
    // 预加载新音频到audioPlayer.src，但不播放。选择后立即播放的
    // 调用方会跳过预加载，避免两个异步加载竞争同一个 Audio 元素。
    if (preload) preloadAudioSource(sound);
    
    updatePlaybackUI();
    
    // 清除拖拽框
    const dragHandle = document.getElementById('dragHandle');
    if (dragHandle) {
        dragHandle.classList.add('hidden');
        dragHandle.setAttribute('draggable', 'false');
    }
    
    // 使用 Canvas 波形 + /api/waveform 的真实数据。
    loadWaveformForSound(sound);
    
    // 只更新选中状态，不重绘整个列表
    updateSelectionState(previousSound, sound);

    // 详情面板跟着选中走
    if (detailPanelOpen) renderSoundDetail(sound);

    // 主窗口：把当前选中音效广播给所有独立浮窗（浮窗模式自身不广播，避免回环）
    broadcastPlayState({ playing: false });
}

// 预加载音频元数据，不读取或解码整文件
async function preloadAudioSource(sound) {
    if (!sound || !sound.filePath) return;

    try {
        releaseCurrentBlobUrl();

        if (audioPlayer) {
            const audioSrc = await rendererAudio.resolvePlaybackSource(sound, {
                api: rendererApi,
                projectId: currentProject?.id || 'default'
            });
            if (currentSound !== sound) return;
            audioPlayer.src = audioSrc;
            audioPlayer.preload = 'metadata';
            audioPlayer.load();
        }
    } catch (error) {
        console.error('[preloadAudioSource] 加载音频失败:', error);
    }
}

// 仅更新选中状态，避免重绘整个列表
function updateSelectionState(previousSound, newSound) {
    // 移除之前的选中状态
    if (previousSound) {
        const prevRow = document.querySelector(`.sound-row[data-id="${previousSound.id}"]`);
        if (prevRow) {
            prevRow.classList.remove('selected');
            // 重绘之前选中的波形（恢复非高亮状态）
            drawSingleMiniWaveform(previousSound.id);
        }
    }
    
    // 添加新的选中状态
    if (newSound) {
        const newRow = document.querySelector(`.sound-row[data-id="${newSound.id}"]`);
        if (newRow) {
            newRow.classList.add('selected');
            // 重绘新选中的波形（高亮状态）
            drawSingleMiniWaveform(newSound.id);
        }
    }
}

// 从后端加载波形数据
function cancelActiveWaveformRequest() {
    const requestId = activeWaveformBackendRequestId;
    activeWaveformBackendRequestId = null;
    if (requestId && window.electronAPI?.backendAPI?.cancelRequest) {
        window.electronAPI.backendAPI.cancelRequest(requestId).catch(() => {});
    }
}

// 构造可跨窗口序列化的音效摘要（IPC 结构化克隆，剔除函数/大对象）
function buildSoundBroadcast(sound) {
    if (!sound) return null;
    return {
        filePath: sound.filePath,
        id: sound.id,
        fileId: sound.fileId || sound.id,
        filename: sound.filename,
        name: sound.name || sound.filename,
        path: sound.path || sound.filePath,
        duration: sound.duration,
        sampleRate: sound.sampleRate,
        channels: sound.channels,
        fileSize: sound.fileSize,
        tags: sound.tags
    };
}

// 广播当前播放状态（音效 + 是否播放中）给所有独立浮窗
function broadcastPlayState(override = {}) {
    if (document.body.dataset.floatMode) return; // 浮窗不广播，避免回环
    if (!window.electronAPI?.floatPanel?.broadcastSound) return;
    if (!currentSound?.filePath) return;
    try {
        window.electronAPI.floatPanel.broadcastSound({
            sound: buildSoundBroadcast(currentSound),
            playing: override.playing !== undefined ? override.playing : !!isPlaying
        });
    } catch (_e) { /* 序列化失败不影响主窗口 */ }
}

async function loadWaveformForSound(sound, { force = false } = {}) {
    if (!sound || !sound.filePath) {
        if (sound) sound.waveformError = i18n.t('waveform.path.missing');
        if (sound === currentSound) {
            rendererWaveform.setStatus('error', sound.waveformError, { translate: key => i18n.t(key) });
        }
        drawMainWaveform();
        return;
    }

    if (!force && getSoundWaveform(sound)) {
        sound.waveformError = null;
        rendererWaveform.setStatus('ready', '', { translate: key => i18n.t(key) });
        updateAudioInfo(sound);
        drawMainWaveform();
        return;
    }

    const requestId = ++waveformLoadRequestId;
    const backendRequestId = `main-waveform-${requestId}`;
    activeWaveformBackendRequestId = backendRequestId;
    sound.waveformRequestId = requestId;
    sound.waveformLoading = true;
    sound.waveformError = null;
    if (sound === currentSound) rendererWaveform.setStatus('loading', '', { translate: key => i18n.t(key) });

    try {
        const waveformData = await rendererWaveform.requestForSound(sound, {
            backendAPI: window.electronAPI?.backendAPI,
            projectId: currentProject?.id || 'default',
            requestId: backendRequestId,
            unavailableMessage: i18n.t('waveform.api.unavailable')
        });
        rendererWaveform.applyPayload(sound, waveformData, i18n.t('waveform.invalid'));
        console.log('[Waveform] 成功加载波形数据:', waveformData.peaks.length, '个点');
        updateAudioInfo(sound);

        if (sound === currentSound && requestId === waveformLoadRequestId) {
            rendererWaveform.setStatus('ready', '', { translate: key => i18n.t(key) });
        }
    } catch (error) {
        const cancelled = error?.code === 'REQUEST_CANCELLED';
        if (!cancelled) {
            console.warn('[Waveform] 加载波形数据失败:', error);
            sound.waveform = null;
            sound.waveformError = error?.message || i18n.t('waveform.error');
            if (sound === currentSound && requestId === waveformLoadRequestId) {
                rendererWaveform.setStatus('error', sound.waveformError, { translate: key => i18n.t(key) });
            }
        }
    } finally {
        if (sound.waveformRequestId === requestId) {
            sound.waveformLoading = false;
            delete sound.waveformRequestId;
        }
        if (activeWaveformBackendRequestId === backendRequestId) {
            activeWaveformBackendRequestId = null;
        }
    }

    if (sound === currentSound && requestId === waveformLoadRequestId) drawMainWaveform();
}

// 更新音频信息显示（采样率、比特深度等）
function updateAudioInfo(sound = null) {
    const targetSound = sound || currentSound;
    const fileNameEl = document.getElementById('waveformFileName');
    const sampleRateEl = document.getElementById('sampleRateInfo');
    const sampleRateValue = document.getElementById('sampleRateValue');
    const bitDepthEl = document.getElementById('bitDepthInfo');
    const bitDepthValue = document.getElementById('bitDepthValue');
    
    if (!targetSound) {
        // 没有音频时隐藏所有信息
        if (fileNameEl) fileNameEl.textContent = '';
        if (sampleRateEl) sampleRateEl.classList.add('hidden');
        if (bitDepthEl) bitDepthEl.classList.add('hidden');
        return;
    }
    
    // 显示文件名
    if (fileNameEl) fileNameEl.textContent = targetSound.name;
    
    // 显示采样率（如果有数据）
    if (targetSound.waveformSampleRate) {
        if (sampleRateEl) {
            sampleRateEl.classList.remove('hidden');
            sampleRateValue.textContent = targetSound.waveformSampleRate.toLocaleString();
        }
    } else {
        if (sampleRateEl) sampleRateEl.classList.add('hidden');
    }

    // 显示比特深度（根据音频格式估算或从后端获取）
    if (targetSound.waveformChannels) {
        if (bitDepthEl) {
            bitDepthEl.classList.remove('hidden');
            // 根据文件类型估算比特深度
            const fileExt = (targetSound.name || '').split('.').pop().toLowerCase();
            let bitDepth = 16; // 默认16位
            if (fileExt === 'wav' || fileExt === 'aiff' || fileExt === 'aif') {
                bitDepth = 24; // 专业音频格式通常是24位
            } else if (fileExt === 'mp3' || fileExt === 'aac') {
                bitDepth = '压缩'; // 压缩格式没有固定比特深度
            }
            bitDepthValue.textContent = bitDepth;
        }
    } else {
        if (bitDepthEl) bitDepthEl.classList.add('hidden');
    }
}

function playSound(sound, { forcePlay = false } = {}) {
    // 播放统一使用 HTML5 Audio + Electron 本地安全协议。
    const action = rendererAudio.playbackAction(
        currentSound,
        sound,
        isPlaying,
        { forcePlay }
    );
    if (action === 'pause') {
        pausePlayback();
    } else {
        currentSound = sound;
        loadAndPlaySound(sound);
    }
}

function selectAndPlaySound(sound) {
    // Selecting first changes currentSound while the previous sound may
    // still have isPlaying=true. Force this explicit user action down
    // the play branch and load the source only once.
    selectSound(sound, { preload: false });
    playSound(sound, { forcePlay: true });
}

