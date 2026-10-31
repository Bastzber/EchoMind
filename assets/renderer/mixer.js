/* mixer.js —— 多声道条：分轨音量与静音
 * 从 index.html 原样搬出，全局语义不变。
 */
// ===== 多声道条 =====
const channelState = {
    count: 0,
    layout: '',
    peaks: [],
    mutes: new Set(),
    solos: new Set(),
    paths: new Map(),
};

function audibleChannels() {
    const total = channelState.count;
    if (!total) return [];
    if (channelState.solos.size) {
        return Array.from(channelState.solos)
            .filter(i => !channelState.mutes.has(i))
            .sort((a, b) => a - b);
    }
    const kept = [];
    for (let i = 1; i <= total; i += 1) {
        if (!channelState.mutes.has(i)) kept.push(i);
    }
    return kept;
}

function channelMixKey() {
    return channelState.count + ':' + audibleChannels().join(',');
}


// 按 ffmpeg 的标准声道顺序给名字（5.1 = FL FR FC LFE BL BR）
const CHANNEL_LABELS = {
    mono: ['M'],
    stereo: ['L', 'R'],
    '2.1': ['L', 'R', 'LFE'],
    quad: ['L', 'R', 'SL', 'SR'],
    '5.0': ['L', 'R', 'C', 'SL', 'SR'],
    '5.1': ['L', 'R', 'C', 'LFE', 'SL', 'SR'],
    '6.1': ['L', 'R', 'C', 'LFE', 'BC', 'SL', 'SR'],
    '7.1': ['L', 'R', 'C', 'LFE', 'BL', 'BR', 'SL', 'SR'],
};
function channelLabel(index, total) {
    const byLayout = CHANNEL_LABELS[String(channelState.layout || '')] || null;
    if (byLayout && byLayout[index]) return byLayout[index];
    if (total === 2) return ['L', 'R'][index] || ('CH' + (index + 1));
    if (total === 6) return ['L', 'R', 'C', 'LFE', 'SL', 'SR'][index] || ('CH' + (index + 1));
    if (total === 4) return ['L', 'R', 'SL', 'SR'][index] || ('CH' + (index + 1));
    return 'CH' + (index + 1);
}

// 当前播放位置附近的峰值 → 该声道此刻的「音量」
function channelLevelAt(peaks, ratio) {
    if (!Array.isArray(peaks) || !peaks.length) return 0;
    const center = Math.min(peaks.length - 1, Math.max(0, Math.floor(ratio * peaks.length)));
    let max = 0;
    for (let i = Math.max(0, center - 2); i <= Math.min(peaks.length - 1, center + 2); i += 1) {
        const v = Math.abs(Number(peaks[i]) || 0);
        if (v > max) max = v;
    }
    return Math.min(1, max);
}

// 只在波形左边那一条里画「电平条」，不画波形
function renderChannelStrips() {
    const rail = document.getElementById('channelRail');
    const meters = document.getElementById('channelMeters');
    const info = document.getElementById('channelInfo');
    if (!rail || !meters) return;
    const pinned = localStorage.getItem('echomind.channelBar') === '1';
    // 用户没点「声道」按钮就不显示（以前 >2 声道会自动展开）
    if (!channelState.count || !pinned) {
        rail.classList.add('hidden');
        rail.classList.remove('flex');
        document.getElementById('channelSplitter')?.classList.add('hidden');
        const tools = document.getElementById('channelRailTools');
        if (tools) { tools.classList.add('hidden'); tools.classList.remove('flex'); }
        return;
    }
    rail.classList.remove('hidden');
    rail.classList.add('flex');
    const tools = document.getElementById('channelRailTools');
    if (tools) { tools.classList.remove('hidden'); tools.classList.add('flex'); }
    const splitter = document.getElementById('channelSplitter');
    if (splitter) {
        splitter.classList.remove('hidden');
        const savedWidth = Number(localStorage.getItem('echomind.channelRailWidth') || 0);
        if (savedWidth >= 60) rail.style.width = savedWidth + 'px';
    }
    meters.innerHTML = '';

    const mutedNow = new Set();
    if (channelState.solos.size) {
        for (let i = 1; i <= channelState.count; i += 1) {
            if (!channelState.solos.has(i)) mutedNow.add(i);
        }
    }
    channelState.mutes.forEach(i => mutedNow.add(i));

    const total = Math.min(6, channelState.count);
    for (let index = 0; index < total; index += 1) {
        const channel = index + 1;
        const item = document.createElement('div');
        item.className = 'flex flex-col items-center gap-0.5 min-h-0 shrink-0';
        item.style.width = '40px';

        const label = document.createElement('div');
        label.className = 'text-[9px] opacity-60 shrink-0';
        label.textContent = channelLabel(index, channelState.count);
        item.appendChild(label);

        const track = document.createElement('div');
        track.className = 'flex-1 w-[16px] rounded-sm overflow-hidden relative min-h-0';
        track.style.minHeight = '18px';
        track.style.background = 'var(--bg-tertiary)';
        const fill = document.createElement('div');
        fill.dataset.fillCh = String(channel);
        fill.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:0%;'
            + 'background:linear-gradient(to top,#22c55e,#eab308 70%,#ef4444);transition:height .06s linear';
        fill.style.opacity = mutedNow.has(channel) ? '0.45' : '1';
        track.appendChild(fill);
        item.appendChild(track);

        const buttons = document.createElement('div');
        buttons.className = 'flex gap-0.5 shrink-0 w-full';
        const mkToggle = (text, active, color, handler, kind) => {
            const button = document.createElement('button');
            // 铺满整列：两个按钮撑不进 30px 就会压到旁边声道
            button.className = 'flex-1 min-w-0 h-4 rounded text-[9px] border leading-none px-0';
            button.textContent = text;
            button.style.borderColor = 'var(--border-color)';
            button.style.background = active ? color : 'transparent';
            button.style.color = active ? '#fff' : 'var(--text-secondary)';
            button.dataset.btnCh = String(channel);
            button.dataset.kind = kind;
            button.addEventListener('click', handler);
            return button;
        };
        buttons.appendChild(mkToggle('S', channelState.solos.has(channel), '#3b82f6', () => {
            if (channelState.solos.has(channel)) channelState.solos.delete(channel);
            else channelState.solos.add(channel);
            updateChannelButtonStates();
            applyChannelSelection();
        }, 'S'));
        buttons.appendChild(mkToggle('M', channelState.mutes.has(channel), '#ef4444', () => {
            if (channelState.mutes.has(channel)) channelState.mutes.delete(channel);
            else channelState.mutes.add(channel);
            updateChannelButtonStates();
            applyChannelSelection();
        }, 'M'));
        item.appendChild(buttons);
        meters.appendChild(item);
    }

    if (info) info.textContent = channelState.count + ' 声道';
}

// 每帧刷新电平：没有播放时归零
// 只改按钮外观，不重建 DOM：重建会让整个播放区闪一下
function updateChannelButtonStates() {
    document.querySelectorAll('#channelMeters button[data-btn-ch]').forEach((btn) => {
        const channel = Number(btn.dataset.btnCh);
        const isSolo = btn.dataset.kind === 'S';
        const active = isSolo ? channelState.solos.has(channel) : channelState.mutes.has(channel);
        btn.style.background = active ? (isSolo ? '#3b82f6' : '#ef4444') : 'transparent';
        btn.style.color = active ? '#fff' : 'var(--text-secondary)';
    });
    const mutedNow = new Set(channelState.mutes);
    if (channelState.solos.size) {
        for (let i = 1; i <= channelState.count; i += 1) {
            if (!channelState.solos.has(i)) mutedNow.add(i);
        }
    }
    document.querySelectorAll('#channelMeters [data-fill-ch]').forEach((fill) => {
        fill.style.opacity = mutedNow.has(Number(fill.dataset.fillCh)) ? '0.45' : '1';
    });
}

function updateChannelMeters() {
    if (!channelState.count) return;
    const fills = document.querySelectorAll('#channelMeters [data-fill-ch]');
    if (!fills.length) return;
    const playing = !!(audioPlayer && isPlaying && !audioPlayer.paused);
    const duration = Number(audioPlayer?.duration || 0);
    const ratio = playing && duration > 0
        ? Math.min(1, Math.max(0, audioPlayer.currentTime / duration))
        : 0;
    fills.forEach((fill) => {
        const channel = Number(fill.dataset.fillCh) - 1;
        const level = playing ? channelLevelAt(channelState.peaks[channel], ratio) : 0;
        const prev = Number(fill.dataset.level || 0);
        // 没在播就直接归零，不要留一个慢慢衰减的残影
        const next = !playing ? 0 : (level > prev ? level : prev * 0.75 + level * 0.25);
        fill.dataset.level = String(next);
        fill.style.height = Math.round(next * 100) + '%';
    });
}

async function loadChannelsFor(sound) {
    const filePath = sound?.filePath;
    if (!filePath) return;
    try {
        const data = await rendererApi.get('/api/v1/audio/channels?path=' + encodeURIComponent(filePath) + '&points=600');
        channelState.count = Number(data?.channels || 0);
        channelState.layout = String(data?.layout || '');
        channelState.peaks = Array.isArray(data?.peaks) ? data.peaks : [];
        channelState.mutes.clear();
        channelState.solos.clear();
        channelState.paths.clear();
        renderChannelStrips();
        prefetchChannelMixes(sound);
    } catch (error) {
        console.warn('[Channels] 读取声道失败:', error);
        channelState.count = 0;
        channelState.peaks = [];
        renderChannelStrips();
    }
}

// 预先在后台把「单独听某个声道」的试听文件生成好（服务端按组合缓存），
// 这样第一次点 S/M 时不用等解码，基本是瞬间切换。
function prefetchChannelMixes(sound) {
    if (!sound?.filePath || !channelState.count) return;
    if (localStorage.getItem('echomind.channelBar') !== '1') return;
    const total = Math.min(6, channelState.count);
    const variants = [];
    for (let i = 1; i <= total; i += 1) variants.push([i]);
    if (total <= 3) {
        for (let i = 1; i <= total; i += 1) {
            const rest = [];
            for (let k = 1; k <= total; k += 1) if (k !== i) rest.push(k);
            if (rest.length) variants.push(rest);
        }
    }
    const filePath = sound.filePath;
    const projectId = currentProject?.id || 'default';
    void (async () => {
        for (const audible of variants) {
            const key = total + ':' + audible.join(',');
            if (channelState.paths.has(key)) continue;
            try {
                const res = await rendererApi.post('/api/v1/audio/channel-mix',
                    { path: filePath, audible }, { timeoutMs: 120000 });
                if (res?.path) {
                    channelState.paths.set(key, 'soundmind-audio://local/' + encodeURIComponent(res.path));
                }
            } catch (_) { }
        }
    })();
}

async function resolveChannelSource(sound) {
    if (!channelState.count || !sound?.filePath) return null;
    const audible = audibleChannels();
    if (!audible.length) return null;
    if (audible.length === channelState.count) return null; // 全开 = 原始文件
    const key = channelMixKey();
    if (channelState.paths.has(key)) return channelState.paths.get(key);
    const result = await rendererApi.post('/api/v1/audio/channel-mix',
        { path: sound.filePath, audible }, { timeoutMs: 120000 });
    if (!result?.path) return null;
    const src = 'soundmind-audio://local/' + encodeURIComponent(result.path);
    channelState.paths.set(key, src);
    return src;
}

async function applyChannelSelection() {
    if (!currentSound) return;
    // S 和 M 同时选中 = 这条声道既不单独听也被静音 → 什么都不响
    const audibleNow = audibleChannels();
    if (channelState.count > 0 && audibleNow.length === 0) {
        channelState.silent = true;
        if (audioPlayer) audioPlayer.volume = 0;
        return;
    }
    if (channelState.silent) {
        channelState.silent = false;
        if (audioPlayer) audioPlayer.volume = currentVolume / 100;
    }
    channelState.switchToken = (channelState.switchToken || 0) + 1;
    const token = channelState.switchToken;
    const wasPlaying = Boolean(isPlaying);
    const startedAt = Date.now();
    const position = audioPlayer ? audioPlayer.currentTime : 0;
    try {
        const mixed = await resolveChannelSource(currentSound);
        if (token !== channelState.switchToken) return;
        const base = mixed || await rendererAudio.resolvePlaybackSource(currentSound, {
            api: rendererApi,
            projectId: currentProject?.id || 'default',
        });
        if (token !== channelState.switchToken) return;
        if (!audioPlayer) initAudioPlayer();
        if (audioPlayer.src === base) return;
        // 等待期间旧声音一直在播，这里按实际耗补正播放位置
        const advance = wasPlaying ? (Date.now() - startedAt) / 1000 : 0;
        await switchPlaybackSource(base, position + advance, wasPlaying);
    } catch (error) {
        showNotification('切换声道失败: ' + (error?.message || error), 'error');
    }
}
// 通用「试听 → 勾选 → 另存」对话框：分轨和去人声共用
function openAudioSaveDialog({ title, hint, rows, checkboxes = true }) {
    document.getElementById('stemsDialog')?.remove();
    if (!rows || !rows.length) {
        showNotification('没有可保存的文件', 'warning');
        return;
    }
    const overlay = document.createElement('div');
    overlay.id = 'stemsDialog';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'width:min(760px,94vw);max-height:82vh;overflow:auto;background:var(--bg-secondary);'
        + 'border:1px solid var(--border-color);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;font-size:12px';
    box.innerHTML = ''
        + '<div style="display:flex;justify-content:space-between;align-items:center">'
        + '  <strong style="font-size:13px">' + title + '</strong>'
        + '  <button id="stemsClose" style="border:0;background:transparent;cursor:pointer;font-size:16px;opacity:.6">×</button>'
        + '</div>'
        + '<div style="opacity:.7">' + (hint || '') + '</div>'
        + '<div id="stemsList" style="display:flex;flex-direction:column;gap:8px"></div>'
        + '<div style="display:flex;gap:8px;align-items:center;margin-top:4px">'
        + '  <input id="stemsTarget" readonly placeholder="还没有选择保存文件夹"'
        + '         style="flex:1;padding:6px 8px;border-radius:8px;border:1px solid var(--border-color);background:transparent;color:var(--text-primary)">'
        + '  <button id="stemsPick" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border-color);background:transparent;cursor:pointer">选择文件夹</button>'
        + '</div>'
        + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">'
        + '  <button id="stemsCancel" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border-color);background:transparent;cursor:pointer">关闭</button>'
        + '  <button id="stemsSave" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border-color);background:var(--accent-color,#6b8afd);color:#fff;cursor:pointer">保存选中</button>'
        + '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const list = box.querySelector('#stemsList');
    rows.forEach((row, index) => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:8px;border:1px solid var(--border-color)';
        if (checkboxes) {
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = true;
            checkbox.dataset.stemIndex = String(index);
            item.appendChild(checkbox);
        }
        const name = document.createElement('span');
        name.style.cssText = 'min-width:96px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500';
        name.textContent = row.label || row.name || ('轨道 ' + (index + 1));
        name.title = row.stemPath || '';
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.style.cssText = 'flex:1;height:32px';
        audio.src = 'soundmind-audio://local/' + encodeURIComponent(row.stemPath);
        audio.addEventListener('play', () => {
            list.querySelectorAll('audio').forEach((other) => { if (other !== audio) other.pause(); });
        });
        item.appendChild(name);
        item.appendChild(audio);
        list.appendChild(item);
    });
    let targetDir = '';
    const targetInput = box.querySelector('#stemsTarget');
    box.querySelector('#stemsPick').addEventListener('click', async () => {
        try {
            const picked = await window.electronAPI.fileImport.selectFolder({ title: '选择保存到的文件夹' });
            if (picked?.success && picked.folder) {
                targetDir = picked.folder;
                targetInput.value = targetDir;
            }
        } catch (error) {
            showNotification('选择文件夹失败: ' + (error?.message || error), 'error');
        }
    });
    const close = () => overlay.remove();
    box.querySelector('#stemsClose').addEventListener('click', close);
    box.querySelector('#stemsCancel').addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    box.querySelector('#stemsSave').addEventListener('click', async () => {
        const picked = [];
        if (checkboxes) {
            box.querySelectorAll('#stemsList input[type=checkbox]').forEach((checkbox) => {
                if (checkbox.checked) {
                    const row = rows[Number(checkbox.dataset.stemIndex)];
                    if (row) picked.push(row.stemPath);
                }
            });
        } else {
            rows.forEach((row) => picked.push(row.stemPath));
        }
        if (!picked.length) { showNotification('还没勾选任何文件', 'warning'); return; }
        if (!targetDir) { showNotification('先选一个保存文件夹', 'warning'); return; }
        try {
            const res = await rendererApi.post('/api/v1/audio/stems/save', {
                files: picked, target_dir: targetDir,
            }, { timeoutMs: 300000 });
            showNotification('已保存 ' + (res?.count || 0) + ' 个到 ' + targetDir, 'success');
            if ((res?.skipped || []).length) console.warn('[Save] 跳过:', res.skipped);
            close();
        } catch (error) {
            showNotification('保存失败: ' + (error?.message || error), 'error');
        }
    });
}
// 分轨结果：逐条试听 + 勾选 + 选保存文件夹（绝不写回原文件夹）
function openStemsDialog(result) {
    document.getElementById('stemsDialog')?.remove();
    const rows = [];
    (result?.results || []).forEach((item) => {
        if (!item || !item.ok) return;
        Object.entries(item.stems || {}).forEach(([name, stemPath]) => {
            if (stemPath) rows.push({ name, stemPath });
        });
        if (item.instrumental) rows.push({ name: 'instrumental', stemPath: item.instrumental });
    });
    if (!rows.length) {
        showNotification('分轨没有产出可保存的轨道', 'warning');
        return;
    }
    const label = { vocals: '人声', drums: '鼓', bass: '贝斯', other: '其他', instrumental: '伴奏（无人声）' };
    const overlay = document.createElement('div');
    overlay.id = 'stemsDialog';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:10000;display:flex;align-items:center;justify-content:center';
    const box = document.createElement('div');
    box.style.cssText = 'width:min(760px,94vw);max-height:82vh;overflow:auto;background:var(--bg-secondary);'
        + 'border:1px solid var(--border-color);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;font-size:12px';
    box.innerHTML = ''
        + '<div style="display:flex;justify-content:space-between;align-items:center">'
        + '  <strong style="font-size:13px">分轨完成 · 选择要保存的轨道</strong>'
        + '  <button id="stemsClose" style="border:0;background:transparent;cursor:pointer;font-size:16px;opacity:.6">×</button>'
        + '</div>'
        + '<div style="opacity:.7">先试听，勾选满意的；保存位置自己选，不会写回原文件夹。</div>'
        + '<div id="stemsList" style="display:flex;flex-direction:column;gap:8px"></div>'
        + '<div style="display:flex;gap:8px;align-items:center;margin-top:4px">'
        + '  <input id="stemsTarget" readonly placeholder="还没有选择保存文件夹"'
        + '         style="flex:1;padding:6px 8px;border-radius:8px;border:1px solid var(--border-color);background:transparent;color:var(--text-primary)">'
        + '  <button id="stemsPick" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border-color);background:transparent;cursor:pointer">选择文件夹</button>'
        + '</div>'
        + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:4px">'
        + '  <button id="stemsCancel" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border-color);background:transparent;cursor:pointer">关闭</button>'
        + '  <button id="stemsSave" style="padding:6px 12px;border-radius:8px;border:1px solid var(--border-color);background:var(--accent-color,#6b8afd);color:#fff;cursor:pointer">保存选中</button>'
        + '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    const list = box.querySelector('#stemsList');
    rows.forEach((row, index) => {
        const item = document.createElement('div');
        item.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:8px;border:1px solid var(--border-color)';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = true;
        checkbox.dataset.stemIndex = String(index);
        const name = document.createElement('span');
        name.style.cssText = 'min-width:96px;font-weight:500';
        name.textContent = label[row.name] || row.name;
        const audio = document.createElement('audio');
        audio.controls = true;
        audio.preload = 'none';
        audio.style.cssText = 'flex:1;height:32px';
        audio.src = 'soundmind-audio://local/' + encodeURIComponent(row.stemPath);
        audio.addEventListener('play', () => {
            list.querySelectorAll('audio').forEach((other) => { if (other !== audio) other.pause(); });
        });
        item.appendChild(checkbox);
        item.appendChild(name);
        item.appendChild(audio);
        list.appendChild(item);
    });
    let targetDir = '';
    const targetInput = box.querySelector('#stemsTarget');
    box.querySelector('#stemsPick').addEventListener('click', async () => {
        try {
            const picked = await window.electronAPI.fileImport.selectFolder({ title: '选择分轨保存到的文件夹' });
            if (picked?.success && picked.folder) {
                targetDir = picked.folder;
                targetInput.value = targetDir;
            }
        } catch (error) {
            showNotification('选择文件夹失败: ' + (error?.message || error), 'error');
        }
    });
    const close = () => overlay.remove();
    box.querySelector('#stemsClose').addEventListener('click', close);
    box.querySelector('#stemsCancel').addEventListener('click', close);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    box.querySelector('#stemsSave').addEventListener('click', async () => {
        const saved = [];
        box.querySelectorAll('#stemsList input[type=checkbox]').forEach((checkbox) => {
            if (checkbox.checked) {
                const row = rows[Number(checkbox.dataset.stemIndex)];
                if (row) saved.push(row.stemPath);
            }
        });
        if (!saved.length) { showNotification('还没勾选任何轨道', 'warning'); return; }
        if (!targetDir) { showNotification('先选一个保存文件夹', 'warning'); return; }
        try {
            const res = await rendererApi.post('/api/v1/audio/stems/save', {
                files: saved, target_dir: targetDir,
            }, { timeoutMs: 120000 });
            showNotification('已保存 ' + (res?.count || 0) + ' 条到 ' + targetDir, 'success');
            if ((res?.skipped || []).length) console.warn('[Stems] 跳过:', res.skipped);
            close();
        } catch (error) {
            showNotification('保存失败: ' + (error?.message || error), 'error');
        }
    });
}

function bindChannelBar() {
    const toggle = document.getElementById('channelToggleBtn');
    if (toggle) {
        const paint = () => {
            const on = localStorage.getItem('echomind.channelBar') === '1';
            toggle.style.background = on ? 'rgba(107,138,253,0.18)' : 'transparent';
        };
        paint();
        toggle.addEventListener('click', () => {
            const on = localStorage.getItem('echomind.channelBar') === '1';
            try { localStorage.setItem('echomind.channelBar', on ? '0' : '1'); } catch (_) { }
            paint();
            renderChannelStrips();
        });
    }
    document.getElementById('channelResetBtn')?.addEventListener('click', () => {
        channelState.mutes.clear();
        channelState.solos.clear();
        renderChannelStrips();
        applyChannelSelection();
    });

    // 声道栏和波形之间可拖拽改宽度（双击复位）
    const splitter = document.getElementById('channelSplitter');
    const rail = document.getElementById('channelRail');
    if (splitter && rail) {
        let dragging = false;
        let startX = 0;
        let startWidth = 0;
        splitter.addEventListener('pointerdown', (event) => {
            dragging = true;
            startX = event.clientX;
            startWidth = rail.getBoundingClientRect().width;
            splitter.setPointerCapture(event.pointerId);
            event.preventDefault();
        });
        splitter.addEventListener('pointermove', (event) => {
            if (!dragging) return;
            const next = Math.round(Math.min(420, Math.max(60, startWidth + (event.clientX - startX))));
            rail.style.width = next + 'px';
        });
        const stop = () => {
            if (!dragging) return;
            dragging = false;
            const width = Math.round(rail.getBoundingClientRect().width);
            try { localStorage.setItem('echomind.channelRailWidth', String(width)); } catch (_) { }
        };
        splitter.addEventListener('pointerup', stop);
        splitter.addEventListener('pointercancel', stop);
        splitter.addEventListener('dblclick', () => {
            rail.style.width = '';
            try { localStorage.removeItem('echomind.channelRailWidth'); } catch (_) { }
        });
    }
}

