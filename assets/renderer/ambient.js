/* ambient.js —— 环境音：4 条音轨
 * 从 index.html 原样搬出的完整顶层函数。
 */
function stemsGain(stemId, mix, x, y) {
    const near = x;          // 0 远 / 1 近
    const intensity = y;     // 0 轻 / 1 重
    const role = STEM_ROLE[stemId] ?? 0.35;
    // 强度决定层次：轻时只有底噪，重时细节全部打开
    let gain = role * (0.18 + 0.82 * intensity);
    // 距离：远处整体变轻，高频衰减更多
    gain *= STEM_HIGH.has(stemId) ? (0.30 + 0.70 * near) : (0.72 + 0.28 * near);
    return Math.max(0, Math.min(1, gain * 0.55));
}

function applyStemsGains(x, y) {
    if (!stemsState) return;
    stemsState.targets = stemsState.audios.map((item) => stemsGain(item.id, item.mix, x, y));
    if (stemsTicker) return;
    stemsTicker = setInterval(() => {
        if (!stemsState) { clearInterval(stemsTicker); stemsTicker = null; return; }
        let moving = false;
        stemsState.audios.forEach((item, i) => {
            const target = stemsState.targets[i];
            const current = item.el.volume;
            const next = current + (target - current) * 0.35;
            if (Math.abs(next - target) > 0.004) moving = true;
            item.el.volume = Math.max(0, Math.min(1, next));
        });
        if (!moving) { clearInterval(stemsTicker); stemsTicker = null; }
    }, 40);
}

async function startStems(x, y) {
    if (!recipeState.current) return;
    recipeState.ambiencePlaying = true;
    stopRecipeAudio();
    recordAmbiencePoint(x, y);
    const btn = document.getElementById('recipeStopAmbience');
    if (btn) btn.classList.remove('hidden');

    if (stemsState && stemsState.recipeId === recipeState.current.id) {
        applyStemsGains(x, y);
        return;
    }
    stopStems();
    try {
        const base = rendererApi.getConfig?.().apiBase || 'http://127.0.0.1:8000';
        const data = await rendererApi.post(
            `/api/v1/recipes/${encodeURIComponent(recipeState.current.id)}/stems`,
            { seconds: 45 },
            { timeoutMs: 60000 }
        );
        // 用多个 <audio> 元素循环播放（WebAudio 在部分机器上会导致渲染进程崩溃）
        const audios = (data.stems || []).map((stem) => {
            const el = new Audio(base + stem.url);
            el.loop = true;
            el.preload = 'auto';
            el.volume = 0;
            el.play().catch(() => {});
            return { el, mix: stem.mix, id: stem.id };
        });
        stemsState = { recipeId: recipeState.current.id, audios, targets: [] };
        applyStemsGains(x, y);
    } catch (error) {
        showNotification('环境音轨加载失败: ' + error.message, 'error');
    }
}

function updateStems(x, y) {
    if (!recipeState.ambiencePlaying) return;
    recordAmbiencePoint(x, y);
    applyStemsGains(x, y);
}

function stopStems() {
    if (stemsTicker) { clearInterval(stemsTicker); stemsTicker = null; }
    if (stemsState) {
        stemsState.audios.forEach((item) => {
            try { item.el.pause(); item.el.src = ''; } catch (_) { }
        });
        stemsState = null;
    }
    recipeState.ambiencePlaying = false;
    const btn = document.getElementById('recipeStopAmbience');
    if (btn) btn.classList.add('hidden');
}

function renderRecipeLayers() {
    const box = document.getElementById('recipeLayerList');
    const recipe = recipeState.current;
    if (!box || !recipe) return;
    box.innerHTML = '';
    (recipe.layers || []).forEach((layer) => {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 py-1 text-xs';

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = recipeState.enabled.has(layer.id);
        check.addEventListener('change', () => {
            if (check.checked) recipeState.enabled.add(layer.id);
            else recipeState.enabled.delete(layer.id);
        });

        const name = document.createElement('span');
        name.className = 'w-20 shrink-0 truncate';
        name.textContent = layer.label || layer.id;

        const sampleName = document.createElement('span');
        sampleName.className = 'flex-1 min-w-0 truncate opacity-60';
        const override = recipeState.layerSamples[layer.id];
        sampleName.textContent = override
            ? override.split(/[\\/]/).pop()
            : `自动（${layer.pool} 条）`;
        sampleName.title = override || '';

        const pick = document.createElement('button');
        pick.className = 'px-2 py-0.5 rounded shrink-0';
        pick.style.background = 'var(--bg-tertiary)';
        pick.textContent = '选择素材';
        pick.addEventListener('click', () => pickRecipeSample(layer, (path, filename) => {
            if (path) {
                recipeState.layerSamples[layer.id] = path;
                sampleName.textContent = filename;
                sampleName.title = path;
            } else {
                delete recipeState.layerSamples[layer.id];
                sampleName.textContent = `自动（${layer.pool} 条）`;
            }
            triggerRecipeHit({ x: 0.4, y: 0.6 });
        }));

        row.append(check, name, sampleName, pick);
        box.appendChild(row);
    });
}

function selectRecipe(recipe) {
    recipeState.current = recipe;
    recipeState.events = [];
    recipeState.lastSession = null;
    recipeState.sample = null;
    recipeState.layerSamples = {};
    recipeState.enabled = new Set((recipe.layers || []).map((l) => l.id));
    stopStems();
    document.getElementById('recipeTitle').textContent = recipe.name;
    document.getElementById('recipeLayers').textContent = (recipe.mode === 'env' ? '环境音' : '拟音') + ` · ${(recipe.layers || []).length} 层`;
    renderRecipeLayers();
    const pad = document.getElementById('recipePad');
    if (pad) {
        const fallback = recipe.mode === 'env'
            ? ['远处 · 轻', '远处 · 重', '近处 · 轻', '近处 · 重']
            : ['远处 · 轻', '远处 · 重', '近处 · 轻', '近处 · 重'];
        const labels = (Array.isArray(recipe.labels) && recipe.labels.length === 4)
            ? recipe.labels
            : fallback;
        const spans = pad.querySelectorAll('span');
        if (spans.length >= 4) {
            // 左上 / 右上 / 左下 / 右下
            spans[0].textContent = labels[0];
            spans[1].textContent = labels[1];
            spans[2].textContent = labels[2];
            spans[3].textContent = labels[3];
        }
    }
    document.getElementById('recipePlayBtn').disabled = true;
    document.getElementById('recipeSaveBtn').disabled = true;
    if (recipeState.recording) stopRecipeRecording();
}

function recipePadParams(event) {
    const pad = document.getElementById('recipePad');
    const rect = pad.getBoundingClientRect();
    const x = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
    const y = Math.min(Math.max((event.clientY - rect.top) / rect.height, 0), 1);
    const dot = document.getElementById('recipeDot');
    if (dot) {
        dot.style.left = (x * 100) + '%';
        dot.style.top = (y * 100) + '%';
    }
    return { x, y };
}

async function triggerRecipeHit(params) {
    if (!recipeState.current) return;
    try {
        const body = Object.assign({}, params || { x: 0.3, y: 0.5 }, {
            sample: recipeState.sample || undefined,
            variation: recipeState.variation,
            enabled: [...recipeState.enabled],
            layer_samples: recipeState.layerSamples,
        });
        const data = await rendererApi.post(
            `/api/v1/recipes/${encodeURIComponent(recipeState.current.id)}/hit`,
            body
        );
        const base = rendererApi.getConfig?.().apiBase || 'http://127.0.0.1:8000';
        playRecipeAudio(data.url, 'hit');
        if (recipeState.recording) {
            recipeState.events.push({
                t: (Date.now() - recipeState.startedAt) / 1000,
                x: (params || {}).x ?? 0.3,
                y: (params || {}).y ?? 0.5,
            });
        }
        return data;
    } catch (error) {
        showNotification('演奏失败: ' + error.message, 'error');
    }
}

function startRecipeRecording() {
    try {
        startRecipeRecordingInner();
    } catch (error) {
        reportUiError('开始录制失败', error);
    }
}

function startRecipeRecordingInner() {
    if (!recipeState.current) return;
    recipeState.recording = true;
    recipeState.startedAt = Date.now();
    recipeState.events = [];
    const timer = document.getElementById('recipeTimer');
    const button = document.getElementById('recipeRecordBtn');
    if (button) { button.textContent = '■ 完成录制'; button.style.background = '#334155'; }
    recipeState.timer = setInterval(() => {
        const seconds = (Date.now() - recipeState.startedAt) / 1000;
        if (timer) timer.textContent = seconds.toFixed(1) + ' / 60 秒';
        if (seconds >= 60) stopRecipeRecording();
    }, 100);
}

async function stopRecipeRecording() {
    if (!recipeState.recording) return;
    recipeState.recording = false;
    if (recipeState.timer) { clearInterval(recipeState.timer); recipeState.timer = null; }
    const button = document.getElementById('recipeRecordBtn');
    if (button) { button.textContent = '● 开始录制'; button.style.background = '#ef4444'; }
    const seconds = (Date.now() - recipeState.startedAt) / 1000;
    if (!recipeState.events.length && recipeState.current && recipeState.current.mode === 'env') {
        // 环境音：至少把当前位置记成一帧，避免"无法录制"
        const point = recipeState.lastPoint || { x: 0.5, y: 0.5 };
        recipeState.events.push({ t: 0, x: point.x, y: point.y });
    }
    if (!recipeState.events.length) {
        showNotification('没有演奏任何声音', 'info');
        return;
    }
    try {
        const data = await rendererApi.post(
            `/api/v1/recipes/${encodeURIComponent(recipeState.current.id)}/session`,
            {
                events: recipeState.events,
                max_seconds: Math.min(60, Math.max(seconds, 1)),
                sample: recipeState.sample || undefined,
                variation: recipeState.variation,
                enabled: [...recipeState.enabled],
                layer_samples: recipeState.layerSamples,
            },
            { timeoutMs: 60000 }
        );
        recipeState.lastSession = data;
        recipeState.takes.unshift({
            name: `${recipeState.current ? recipeState.current.name : '录音'} ${new Date().toLocaleTimeString('zh-CN', { hour12: false }).slice(0, 5)}`,
            url: data.url,
            file_path: data.file_path,
            duration: data.duration,
        });
        recipeState.takes = recipeState.takes.slice(0, 10);
        renderRecipeTakes();
        document.getElementById('recipePlayBtn').disabled = false;
        document.getElementById('recipeSaveBtn').disabled = false;
        showNotification(`录制完成：${data.duration} 秒`, 'success');
    } catch (error) {
        showNotification('生成录音失败: ' + error.message, 'error');
    }
}

function stopRecipeAudio() {
    if (recipeAudio) {
        try {
            recipeAudio.pause();
            recipeAudio.currentTime = 0;
        } catch (_) { }
    }
    recipeAudio = null;
    recipeAudioOwner = null;
    document.querySelectorAll('[data-audition]').forEach((btn) => {
        btn.textContent = '试听';
        btn.dataset.playing = '0';
    });
    const playBtn = document.getElementById('recipePlayBtn');
    if (playBtn) playBtn.textContent = '试听录制';
}

function playRecipeAudio(url, owner) {
    const base = rendererApi.getConfig?.().apiBase || 'http://127.0.0.1:8000';
    stopRecipeAudio();
    const audio = new Audio(base + url);
    recipeAudio = audio;
    recipeAudioOwner = owner;
    audio.addEventListener('ended', () => {
        if (recipeAudio === audio) stopRecipeAudio();
    });
    audio.play().catch(() => {});
    return audio;
}

function toggleRecipeAudio(url, owner, button) {
    if (recipeAudioOwner === owner && recipeAudio && !recipeAudio.paused) {
        stopRecipeAudio();
        return;
    }
    playRecipeAudio(url, owner);
    if (button) {
        button.textContent = '暂停';
        button.dataset.playing = '1';
    }
    const playBtn = document.getElementById('recipePlayBtn');
    if (playBtn) playBtn.textContent = (owner === 'session') ? '暂停试听' : '试听录制';
}

function renderRecipeTakes() {
    const box = document.getElementById('recipeTakes');
    if (!box) return;
    if (!recipeState.takes.length) {
        // 右栏常驻，空的时候给个提示，不要整块消失
        box.innerHTML = '<div class="opacity-40 text-center py-6">还没有录音</div>';
        return;
    }
    box.innerHTML = '<div class="opacity-50 mb-1 px-1">历史录音（本次会话）</div>';
    recipeState.takes.forEach((take, index) => {
        // 右栏只有 288px：名字一行，按钮一行，别挤成一条
        const row = document.createElement('div');
        row.className = 'py-1.5 px-1 border-b';
        row.style.borderColor = 'var(--border-color)';
        const head = document.createElement('div');
        head.className = 'flex items-center gap-2 mb-1';
        head.innerHTML = `<span class="opacity-60">${index + 1}.</span>
            <span class="flex-1 truncate">${escapeHtml(take.name)}</span>
            <span class="opacity-50">${take.duration}s</span>`;
        const actions = document.createElement('div');
        actions.className = 'flex items-center gap-1';
        row.appendChild(head);
        row.appendChild(actions);
        const play = document.createElement('button');
        play.className = 'px-2 py-0.5 rounded flex-1';
        play.style.background = 'var(--bg-tertiary)';
        play.textContent = '试听';
        play.dataset.audition = 'take';
        play.dataset.playing = '0';
        play.addEventListener('click', () => {
            toggleRecipeAudio(take.url, 'take-' + index, play);
        });

        const save = document.createElement('button');
        save.className = 'px-2 py-0.5 rounded flex-1';
        save.style.background = '#8b5cf6';
        save.style.color = '#fff';
        save.textContent = '保存';
        save.addEventListener('click', () => saveTakeToLibrary(take));

        const copy = document.createElement('button');
        copy.className = 'px-2 py-0.5 rounded flex-1';
        copy.style.background = 'var(--bg-tertiary)';
        copy.textContent = '复制路径';
        copy.addEventListener('click', () => copyTakePath(take));

        actions.append(play, save, copy);
        box.appendChild(row);
    });
}

async function saveTakeToLibrary(take) {
    try {
        const name = take.name.replace(/\s+/g, '-');
        await rendererApi.post('/api/v1/sfx/save', {
            audio_path: take.file_path,
            name,
            tags: ['环境音', recipeState.current ? recipeState.current.category : '拟音'],
        }, { timeoutMs: 120000 });
        showNotification('已保存到音效库：' + name, 'success');
        await loadFilesFromDatabase({ reset: true });
    } catch (error) {
        showNotification('保存失败: ' + error.message, 'error');
    }
}

async function copyTakePath(take) {
    try {
        await navigator.clipboard.writeText(take.file_path);
        showNotification('路径已复制，可粘贴到任意文件夹', 'success');
    } catch (_) {
        showNotification(take.file_path, 'info');
    }
}

async function pickRecipeSample(layer, onPick) {
    if (!recipeState.current) return;
    try {
        const data = await rendererApi.get(
            `/api/v1/recipes/${encodeURIComponent(recipeState.current.id)}/samples`
        );
        const all = (data && data.samples) || [];
        const samples = all.filter((s) => s.path && (layer.pool === 0 || true));
        if (!samples.length) {
            showNotification('该配方没有可选素材', 'info');
            return;
        }
        // 用浏览器原生 select 风格的选择器（简单可靠）
        document.getElementById('recipeSamplePicker')?.remove();
        const box = document.createElement('div');
        box.id = 'recipeSamplePicker';
        box.className = 'fixed z-[260] rounded-lg shadow-xl p-3 w-[360px] max-h-[50vh] overflow-y-auto';
        box.style.background = 'var(--bg-secondary)';
        box.style.border = '1px solid var(--border-color)';
        box.style.left = (window.innerWidth / 2 - 180) + 'px';
        box.style.top = '140px';
        box.innerHTML = '<div class="text-xs opacity-60 mb-2">选择主声音素材（只播这一条，不再叠加）</div>';
        const auto = document.createElement('button');
        auto.className = 'w-full text-left px-2 py-1.5 rounded text-xs hover:bg-white/5 mb-1';
        auto.textContent = '↺ 恢复自动挑选';
        auto.addEventListener('click', () => {
            box.remove();
            onPick && onPick(null, null);
        });
        box.appendChild(auto);
        samples.forEach((sample) => {
            const item = document.createElement('button');
            item.className = 'w-full text-left px-2 py-1.5 rounded text-xs hover:bg-white/5 truncate';
            item.textContent = sample.filename;
            item.title = sample.path;
            item.addEventListener('click', () => {
                box.remove();
                onPick && onPick(sample.path, sample.filename);
            });
            box.appendChild(item);
        });
        document.body.appendChild(box);
    } catch (error) {
        showNotification('读取素材失败: ' + error.message, 'error');
    }
}

async function saveRecipeSession() {
    const session = recipeState.lastSession;
    if (!session || !recipeState.current) return;
    try {
        const name = `${recipeState.current.name}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`;
        await rendererApi.post('/api/v1/sfx/save', {
            audio_path: session.file_path,
            name,
            tags: ['声音配方', recipeState.current.category],
        }, { timeoutMs: 120000 });
        showNotification('已保存到音效库：' + name, 'success');
        await loadFilesFromDatabase({ reset: true });
    } catch (error) {
        showNotification('保存失败: ' + error.message, 'error');
    }
}

