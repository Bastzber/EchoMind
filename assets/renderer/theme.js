/* theme.js —— 皮肤与主题包切换
 * 从 index.html 原样搬出，全局语义不变。
 */
// ==================== 皮肤 / 主题包 ====================
const SKIN_STORAGE_KEY = 'echomind.skin';
let skinList = [];
let activeSkinId = 'default';

function applySkin(skin) {
    const root = document.documentElement;
    const mode = (skin && skin.mode) === 'light' ? 'light' : 'dark';
    root.classList.toggle('dark', mode === 'dark');
    const colors = (skin && skin.colors) || {};
    Object.entries(colors).forEach(([name, value]) => {
        root.style.setProperty(name, String(value));
    });
    let styleEl = document.getElementById('skinCustomCss');
    if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'skinCustomCss';
        document.head.appendChild(styleEl);
    }
    styleEl.textContent = (skin && skin.css) || '';
    activeSkinId = (skin && skin.id) || 'default';
    try { localStorage.setItem(SKIN_STORAGE_KEY, activeSkinId); } catch (_) { }
    const label = document.getElementById('skinNameText');
    if (label) label.textContent = (skin && skin.name) || '';
    try {
        drawMiniWaveforms();
        drawMainWaveform();
    } catch (_) { }
}

function clearSkin() {
    const root = document.documentElement;
    root.classList.add('dark');
    skinList.flatMap(skin => Object.keys(skin.colors || {})).forEach((name) => {
        root.style.removeProperty(name);
    });
    const styleEl = document.getElementById('skinCustomCss');
    if (styleEl) styleEl.textContent = '';
    activeSkinId = 'default';
    try { localStorage.setItem(SKIN_STORAGE_KEY, 'default'); } catch (_) { }
    const label = document.getElementById('skinNameText');
    if (label) label.textContent = '默认';
}

async function loadSkinList() {
    try {
        const data = await rendererApi.get('/api/v1/skins');
        skinList = Array.isArray(data?.skins) ? data.skins : [];
        return skinList;
    } catch (error) {
        console.warn('[Skin] 读取皮肤列表失败:', error);
        return [];
    }
}

async function applySavedSkin() {
    const saved = (() => { try { return localStorage.getItem(SKIN_STORAGE_KEY); } catch (_) { return null; } })();
    if (!saved || saved === 'default') { clearSkin(); return; }
    const items = await loadSkinList();
    const skin = items.find(item => item.id === saved);
    if (skin) applySkin(skin); else clearSkin();
}

async function importSkinFolder() {
    const picked = await window.electronAPI?.dialogs?.showOpenDialog({
        title: '选择皮肤文件夹（需包含 theme.json）',
        properties: ['openDirectory'],
    });
    if (!picked || picked.canceled || !picked.filePaths?.length) return;
    try {
        const result = await rendererApi.post('/api/v1/skins/import', { path: picked.filePaths[0] });
        showNotification('已导入皮肤：' + (result?.skin?.name || ''), 'success');
        await loadSkinList();
        showSkinModal();
    } catch (error) {
        showNotification('导入皮肤失败：' + (error?.message || error), 'error');
    }
}

async function showSkinModal() {
    document.getElementById('skinOverlay')?.remove();
    const items = await loadSkinList();

    const overlay = document.createElement('div');
    overlay.id = 'skinOverlay';
    overlay.className = 'fixed inset-0 z-[320] flex items-center justify-center';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.55)';

    const panel = document.createElement('div');
    panel.className = 'rounded-lg shadow-2xl p-5 w-[560px] max-h-[80vh] flex flex-col gap-3';
    panel.style.backgroundColor = 'var(--bg-secondary)';
    panel.style.border = '1px solid var(--border-color)';

    const head = document.createElement('div');
    head.className = 'flex items-center justify-between';
    head.innerHTML = '<div class="text-base font-semibold">外观 / 皮肤</div>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'p-1 rounded hover:bg-white/10';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    head.appendChild(closeBtn);
    panel.appendChild(head);

    const list = document.createElement('div');
    list.className = 'flex flex-col gap-1 overflow-y-auto';
    items.forEach((skin) => {
        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 px-2 py-2 rounded border';
        row.style.borderColor = skin.id === activeSkinId ? 'var(--accent-color, #6b8afd)' : 'var(--border-color)';

        const swatch = document.createElement('div');
        swatch.style.width = '34px';
        swatch.style.height = '22px';
        swatch.style.borderRadius = '4px';
        swatch.style.border = '1px solid var(--border-color)';
        swatch.style.background = (skin.colors && (skin.colors['--bg-secondary'] || skin.colors['--bg-primary'])) || 'linear-gradient(135deg,#2b2b33,#16161a)';
        row.appendChild(swatch);

        const name = document.createElement('div');
        name.className = 'flex-1 text-sm';
        name.textContent = skin.name + (skin.builtin ? '' : ' · 自定义');
        const meta = document.createElement('div');
        meta.className = 'text-[11px] opacity-45';
        meta.textContent = (skin.author || '') + '  v' + (skin.version || '1.0');
        name.appendChild(meta);
        row.appendChild(name);

        const useBtn = document.createElement('button');
        useBtn.className = 'px-3 py-1 rounded text-xs border';
        useBtn.style.borderColor = 'var(--border-color)';
        useBtn.textContent = skin.id === activeSkinId ? '使用中' : '应用';
        useBtn.disabled = skin.id === activeSkinId;
        useBtn.addEventListener('click', () => {
            applySkin(skin);
            overlay.remove();
            showNotification('已切换到皮肤：' + skin.name, 'success');
        });
        row.appendChild(useBtn);

        if (!skin.builtin) {
            const delBtn = document.createElement('button');
            delBtn.className = 'px-2 py-1 rounded text-xs border';
            delBtn.style.borderColor = 'var(--border-color)';
            delBtn.textContent = '删除';
            delBtn.addEventListener('click', async () => {
                if (!confirm('删除皮肤「' + skin.name + '」？')) return;
                try {
                    await rendererApi.delete('/api/v1/skins/' + encodeURIComponent(skin.id));
                    overlay.remove();
                    showSkinModal();
                } catch (error) {
                    showNotification('删除失败：' + (error?.message || error), 'error');
                }
            });
            row.appendChild(delBtn);
        }
        list.appendChild(row);
    });
    panel.appendChild(list);

    const footer = document.createElement('div');
    footer.className = 'flex items-center gap-2';
    const importBtn = document.createElement('button');
    importBtn.className = 'px-3 py-1.5 rounded text-sm border';
    importBtn.style.borderColor = 'var(--border-color)';
    importBtn.textContent = '导入皮肤…';
    importBtn.addEventListener('click', importSkinFolder);
    const resetBtn = document.createElement('button');
    resetBtn.className = 'px-3 py-1.5 rounded text-sm border ml-auto';
    resetBtn.style.borderColor = 'var(--border-color)';
    resetBtn.textContent = '恢复默认';
    resetBtn.addEventListener('click', () => {
        clearSkin();
        overlay.remove();
        showNotification('已恢复默认外观', 'success');
    });
    footer.appendChild(importBtn);
    footer.appendChild(resetBtn);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    lucide.createIcons();
}

const TAG_PRESETS = {
    '类型': ['环境', '拟音', '配乐', '人声', 'UI', '武器', '动物'],
    '场景': ['紧张', '欢快', '悲伤', '恐怖', '回忆', '转场', '悬疑'],
    '特性': ['循环', '短尾', '单发', '长音', '金属', '机械', '电子'],
};

async function showTagManagerModal() {
    document.getElementById('tagMgrOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'tagMgrOverlay';
    overlay.className = 'fixed inset-0 z-[300] flex items-center justify-center';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';

    const panel = document.createElement('div');
    panel.className = 'rounded-lg shadow-2xl p-5 w-[620px] max-h-[78vh] flex flex-col';
    panel.style.backgroundColor = 'var(--bg-secondary)';
    panel.style.border = '1px solid var(--border-color)';
    panel.innerHTML = `
        <div class="flex items-center justify-between mb-3">
            <h3 class="text-lg font-semibold">标签管理</h3>
            <button id="tagMgrClose" class="p-1 rounded hover:bg-white/10 transition-colors">✕</button>
        </div>
        <div class="flex items-center gap-2 mb-3 flex-wrap">
            <button id="tagMgrMerge" class="px-2 py-1 rounded text-xs text-white" style="background:#8b5cf6;">合并所选到…</button>
            <button id="tagMgrDelete" class="px-2 py-1 rounded text-xs text-white" style="background:#b91c1c;">删除所选</button>
            <button id="tagMgrUndoAuto" class="px-2 py-1 rounded text-xs border" style="border-color: var(--border-color);" title="把自动补全的标签还原成补全前的样子">撤销自动补全</button>
        <button id="tagMgrPresets" class="px-2 py-1 rounded text-xs border ml-auto" style="border-color: var(--border-color);">套用预设标签</button>
        </div>
        <div id="tagMgrList" class="flex-1 overflow-y-auto text-sm opacity-80">加载中…</div>
        <div id="tagMgrHint" class="text-xs opacity-50 mt-3"></div>
    `;
    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    const list = panel.querySelector('#tagMgrList');
    const hint = panel.querySelector('#tagMgrHint');
    let tags = [];

    const render = () => {
        list.innerHTML = '';
        if (!tags.length) {
            list.innerHTML = '<div class="opacity-40 text-center py-6">还没有标签。可以点「套用预设标签」建立基础词表，或右键音效添加。</div>';
            return;
        }
        tags.forEach((tag) => {
            const row = document.createElement('label');
            row.className = 'flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-white/5 cursor-pointer';
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.value = tag.name;
            check.className = 'shrink-0';
            const name = document.createElement('span');
            name.className = 'flex-1 truncate';
            name.textContent = tag.name;
            const layer = document.createElement('span');
            layer.className = 'text-[10px] opacity-40';
            layer.textContent = tag.layer === 'scene' ? '场景' : '属性';
            const usage = document.createElement('span');
            usage.className = 'text-xs opacity-50 tabular-nums';
            usage.textContent = tag.usage + ' 个';
            row.append(check, name, layer, usage);
            list.appendChild(row);
        });
    };

    const refresh = async () => {
        try {
            const data = await rendererApi.get(
                '/api/v1/tags/usage?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
                { timeoutMs: 30000 }
            );
            tags = (data && data.tags) || [];
        } catch (error) {
            tags = [];
            hint.textContent = '读取失败: ' + (error?.message || error);
        }
        render();
    };

    const selectedNames = () => [...list.querySelectorAll('input[type="checkbox"]:checked')].map(c => c.value);

    panel.querySelector('#tagMgrMerge').addEventListener('click', async () => {
        const names = selectedNames();
        if (names.length < 1) { hint.textContent = '先勾选要合并的标签（至少 1 个）'; return; }
        const target = prompt('合并到哪个标签？（选中的都会并进它，不存在则新建）', names[0]);
        if (!target || !target.trim()) return;
        try {
            const result = await rendererApi.post(
                '/api/v1/tags/merge?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
                { target: target.trim(), sources: names },
                { timeoutMs: 120000 }
            );
            hint.textContent = `已合并 ${result.merged} 个标签，影响 ${result.files} 个文件`;
            await refresh();
            await loadTagStats();
        } catch (error) {
            hint.textContent = '合并失败: ' + (error?.message || error);
        }
    });

    panel.querySelector('#tagMgrDelete').addEventListener('click', async () => {
        const names = selectedNames();
        if (!names.length) { hint.textContent = '先勾选要删除的标签'; return; }
        if (!confirm(`删除 ${names.length} 个标签？文件本身不受影响。`)) return;
        let removed = 0;
        for (const name of names) {
            try {
                await rendererApi.post(
                    '/api/v1/tags/delete?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
                    { name },
                    { timeoutMs: 60000 }
                );
                removed += 1;
            } catch (_) { }
        }
        hint.textContent = `已删除 ${removed} 个标签`;
        await refresh();
        await loadTagStats();
    });

    panel.querySelector('#tagMgrPresets').addEventListener('click', async () => {
        const existing = new Set(tags.map(t => t.name));
        const missing = [];
        Object.values(TAG_PRESETS).flat().forEach((name) => {
            if (!existing.has(name)) missing.push(name);
        });
        if (!missing.length) { hint.textContent = '预设标签都已存在'; return; }
        let created = 0;
        for (const name of missing) {
            try {
                await rendererApi.post('/api/v1/tags' + tagProjectQuery(), { name, layer: 'attr' });
                created += 1;
            } catch (_) { }
        }
        hint.textContent = `已新建 ${created} 个预设标签（类型/场景/特性共 21 个）`;
        await refresh();
        await loadTagStats();
    });

    const undoBtn = panel.querySelector('#tagMgrUndoAuto');
    if (undoBtn) {
        try {
            const stats = await rendererApi.get('/api/v1/tags/auto-backup');
            const count = Number(stats?.count || 0);
            undoBtn.textContent = count ? '撤销自动补全 (' + count + ')' : '撤销自动补全';
            undoBtn.disabled = !count;
            undoBtn.style.opacity = count ? '1' : '0.4';
        } catch (_) { }
        undoBtn.addEventListener('click', async () => {
            if (!confirm('把自动补全的标签全部还原成补全前的样子？手动添加的标签不受影响。')) return;
            try {
                const result = await rendererApi.post('/api/v1/tags/auto-undo', {});
                hint.textContent = '已还原 ' + (result?.restored ?? 0) + ' 个文件的标签';
                await refresh();
                await loadTagStats();
                undoBtn.disabled = true;
                undoBtn.style.opacity = '0.4';
            } catch (error) {
                hint.textContent = '撤销失败: ' + (error?.message || error);
            }
        });
    }

    panel.querySelector('#tagMgrClose').addEventListener('click', () => overlay.remove());
    await refresh();
    lucide.createIcons();
}

