/* effects.js —— 效果器（混响）
 * 从 index.html 原样搬出的完整顶层函数。
 */
async function loadEffectPresets() {
    try {
        const data = await rendererApi.get('/api/v1/audio/effect-presets');
        effectState.presets = Array.isArray(data?.presets) ? data.presets : [];
    } catch (error) {
        console.warn('[Effect] 读取预设失败:', error);
        effectState.presets = [];
    }
}

async function buildEffectSource(sound) {
    if (!sound?.filePath) return null;
    const key = sound.filePath + '|' + effectState.preset + '|' + effectState.wet.toFixed(2);
    if (effectState.cache.has(key)) return effectState.cache.get(key);
    const result = await rendererApi.post('/api/v1/audio/apply-effect', {
        path: sound.filePath,
        preset: effectState.preset,
        wet: effectState.wet,
    }, { timeoutMs: 180000 });
    if (!result?.path) return null;
    const src = 'soundmind-audio://local/' + encodeURIComponent(result.path);
    effectState.cache.set(key, src);
    return src;
}

async function setEffectEnabled(enabled) {
    effectState.active = Boolean(enabled);
    try { localStorage.setItem('echomind.effectActive', effectState.active ? '1' : '0'); } catch (_) { }
    // 重新渲染：关闭后预设不应再高亮
    try { renderEffectPanel(currentSound || null); } catch (_) { }
    if (!currentSound) return;
    const wasPlaying = Boolean(isPlaying);
    const position = audioPlayer ? audioPlayer.currentTime : 0;
    try {
        const source = await resolveAudioSourceWithReverse(currentSound, {
            api: rendererApi,
            projectId: currentProject?.id || 'default',
        });
        if (!audioPlayer) initAudioPlayer();
        audioPlayer.pause();
        audioPlayer.src = source;
        audioPlayer.load();
        await rendererAudio.waitForMetadata(audioPlayer);
        applyPlaybackRate();
        try { audioPlayer.currentTime = Math.min(position, audioPlayer.duration || position); } catch (_) { }
        if (wasPlaying) { await audioPlayer.play(); isPlaying = true; }
    } catch (error) {
        showNotification('应用效果器失败: ' + (error?.message || error), 'error');
    }
}

function openEffectPanel() {
    if (!currentSound) {
        showNotification('先选一个音效，再加效果器', 'info');
        return;
    }
    setDetailPanelOpen(true);
    const section = document.getElementById('effectPanel');
    if (!section) {
        showNotification('详情面板还没渲染好，稍等一下再点', 'info');
        return;
    }
    const bodyEl = section.querySelector('.effect-body');
    const chevron = section.querySelector('.effect-chevron');
    if (bodyEl && bodyEl.classList.contains('hidden')) {
        bodyEl.classList.remove('hidden');
        if (chevron) chevron.style.transform = 'rotate(90deg)';
    }
    renderEffectPanel(currentSound);
    section.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function renderEffectPanel(sound) {
    const host = document.getElementById('effectPanel');
    if (!host) return;
    const body = host.querySelector('.effect-body');
    const chevron = host.querySelector('.effect-chevron');
    const summary = host.querySelector('.effect-summary');
    const body2 = host.querySelector('.effect-body');
    if (summary) {
        const active = effectState.active && effectState.preset !== 'dry';
        const presetName = (effectState.presets.find(p => p.id === effectState.preset) || {}).name || '';
        summary.textContent = active ? presetName + ' · 湿声 ' + Math.round(effectState.wet * 100) + '%' : '未启用';
    }
    if (!body2) return;
    body2.innerHTML = '';

    const chips = document.createElement('div');
    chips.className = 'flex flex-wrap gap-1 mb-2';
    (effectState.presets.length ? effectState.presets : [{ id: 'room_large', name: '大房间' }]).forEach((preset) => {
        const button = document.createElement('button');
        button.className = 'px-2 py-1 rounded text-[11px] border';
        // 未启用时不显示蓝色选中框，避免误以为已经加上效果
        const on = effectState.active && effectState.preset === preset.id;
        button.style.borderColor = on ? 'var(--accent-color, #6b8afd)' : 'var(--border-color)';
        button.style.background = on ? 'rgba(107,138,253,0.16)' : 'transparent';
        button.style.opacity = effectState.active || on ? '1' : '0.72';
        button.textContent = preset.name;
        button.addEventListener('click', async () => {
            effectState.preset = preset.id;
            try { localStorage.setItem('echomind.effectPreset', preset.id); } catch (_) { }
            // 未启用时点预设 -> 直接套用；已启用时 -> 换预设重算
            renderEffectPanel(sound);
            await setEffectEnabled(preset.id === 'dry' ? false : true);
        });
        chips.appendChild(button);
    });
    body2.appendChild(chips);

    const wetRow = document.createElement('div');
    wetRow.className = 'flex items-center gap-2 mb-2 text-[11px]';
    wetRow.style.opacity = effectState.active ? '1' : '0.45';
    const label = document.createElement('span');
    label.className = 'opacity-50';
    label.textContent = '湿声';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.value = String(Math.round(effectState.wet * 100));
    slider.className = 'flex-1';
    const valueText = document.createElement('span');
    valueText.className = 'w-8 text-right opacity-60';
    valueText.textContent = slider.value + '%';
    slider.addEventListener('input', () => {
        valueText.textContent = slider.value + '%';
    });
    slider.addEventListener('change', async () => {
        effectState.wet = Number(slider.value) / 100;
        try { localStorage.setItem('echomind.effectWet', String(effectState.wet)); } catch (_) { }
        if (effectState.active) await setEffectEnabled(true);
    });
    wetRow.appendChild(label);
    wetRow.appendChild(slider);
    wetRow.appendChild(valueText);
    body2.appendChild(wetRow);

    const actions = document.createElement('div');
    actions.className = 'flex items-center gap-2';
    const toggle = document.createElement('button');
    toggle.className = 'px-3 py-1 rounded text-xs border';
    toggle.style.borderColor = 'var(--border-color)';
    toggle.style.background = effectState.active ? 'rgba(107,138,253,0.18)' : 'transparent';
    toggle.textContent = effectState.active ? '关闭效果' : '试听效果';
    toggle.addEventListener('click', () => setEffectEnabled(!effectState.active));
    actions.appendChild(toggle);

    const exportBtn = document.createElement('button');
    exportBtn.className = 'px-3 py-1 rounded text-xs border';
    exportBtn.style.borderColor = 'var(--border-color)';
    exportBtn.textContent = '导出为新文件';
    exportBtn.addEventListener('click', async () => {
        if (!sound?.filePath) { showNotification('缺少文件路径', 'error'); return; }
        try {
            const result = await rendererApi.post('/api/v1/audio/export-effect', {
                path: sound.filePath,
                preset: effectState.preset,
                wet: effectState.wet,
            }, { timeoutMs: 300000 });
            showNotification('已导出: ' + (result?.path ? result.path.split(/[\\/]/).pop() : ''), 'success');
        } catch (error) {
            showNotification('导出失败: ' + (error?.message || error), 'error');
        }
    });
    actions.appendChild(exportBtn);
    body2.appendChild(actions);
}

