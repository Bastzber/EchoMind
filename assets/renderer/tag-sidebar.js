/* tag-sidebar.js —— 侧边栏标签
 * 从 index.html 原样搬出的完整顶层函数。
 */
async function renameSidebarTag(oldName) {
    showInputModal('重命名标签', oldName, async (newName) => {
        const field = document.getElementById('inputModalField');
        if (field) field.value = oldName;
        const target = String(newName || '').trim();
        if (!target || target === oldName) return;
        try {
            const res = await rendererApi.post('/api/v1/tags/rename' + tagProjectQuery(),
                { old: oldName, new: target }, { timeoutMs: 120000 });
            showNotification(res.merged ? '已合并到「' + target + '」，影响 ' + res.files + ' 个文件'
                : '标签已改名为「' + target + '」', 'success');
            await loadTagStats();
        } catch (error) {
            showNotification('改名失败: ' + (error?.message || error), 'error');
        }
    });
}

async function deleteSidebarTag(name) {
    if (!confirm('删除标签「' + name + '」？只会取消这个标签，音效本身不受影响。')) return;
    try {
        const res = await rendererApi.post('/api/v1/tags/delete' + tagProjectQuery(), { name }, { timeoutMs: 120000 });
        showNotification(res.deleted ? '已删除标签「' + name + '」，影响 ' + res.files + ' 个音效' : '标签不存在', 'success');
        await loadTagStats();
    } catch (error) {
        showNotification('删除失败: ' + (error?.message || error), 'error');
    }
}

async function mergeSidebarTag(source, target) {
    if (!source || !target || source === target) return;
    if (!confirm('把「' + source + '」合并到「' + target + '」？\n\n所有带「' + source + '」的音效会改成「' + target + '」。')) return;
    try {
        const res = await rendererApi.post('/api/v1/tags/merge' + tagProjectQuery(),
            { target, sources: [source] }, { timeoutMs: 180000 });
        showNotification('已合并「' + source + '」→「' + target + '」，影响 ' + res.files + ' 个文件', 'success');
        await loadTagStats();
    } catch (error) {
        showNotification('合并失败: ' + (error?.message || error), 'error');
    }
}

function showTagSidebarMenu(event, name) {
    document.getElementById('tagSidebarMenu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'tagSidebarMenu';
    menu.className = 'fixed z-[260] rounded-lg shadow-xl py-1 w-48';
    menu.style.backgroundColor = 'var(--bg-secondary)';
    menu.style.border = '1px solid var(--border-color)';
    menu.style.left = Math.min(event.clientX, window.innerWidth - 200) + 'px';
    menu.style.top = Math.min(event.clientY, window.innerHeight - 160) + 'px';
    const item = (label, onClick, danger) => {
        const btn = document.createElement('button');
        btn.className = 'w-full px-3 py-1.5 text-xs text-left hover:bg-white/5' + (danger ? ' text-red-400' : '');
        btn.textContent = label;
        btn.addEventListener('click', () => { menu.remove(); onClick(); });
        menu.appendChild(btn);
    };
    const layeredNow = window.__tagLayers || { scene: [], attr: [] };
    const foundTag = [...(layeredNow.scene || []), ...(layeredNow.attr || [])].find((t) => t && t.name === name);
    if (foundTag) {
        item('设为场景标签', () => patchTag(foundTag.id, { layer: 'scene' }));
        item('设为属性标签', () => patchTag(foundTag.id, { layer: 'attr' }));
    }
    item('重命名标签…', () => renameSidebarTag(name));
    item('合并到其他标签…', () => {
        const target = prompt('把「' + name + '」合并到哪个标签？（输入目标标签名）', '');
        if (target) mergeSidebarTag(name, target.trim());
    });
    item('删除标签', () => deleteSidebarTag(name), true);
    document.body.appendChild(menu);
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
    setTimeout(() => document.addEventListener('click', close), 100);
}

function attachTagSidebarInteractions(row, name) {
    row.setAttribute('draggable', 'true');
    row.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/plain', name);
        event.dataTransfer.effectAllowed = 'move';
        row.style.opacity = '0.4';
    });
    row.addEventListener('dragend', () => {
        row.style.opacity = '1';
        document.querySelectorAll('.tag-drop-hover').forEach((el) => el.classList.remove('tag-drop-hover'));
    });
    row.addEventListener('dragover', (event) => {
        event.preventDefault();
        row.classList.add('tag-drop-hover');
    });
    row.addEventListener('dragleave', () => row.classList.remove('tag-drop-hover'));
    row.addEventListener('drop', (event) => {
        event.preventDefault();
        event.stopPropagation();
        row.classList.remove('tag-drop-hover');
        const source = event.dataTransfer.getData('text/plain');
        mergeSidebarTag(source, name);
    });
    row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showTagSidebarMenu(event, name);
    });
}

async function showTagPicker(sounds) {
    const layered = window.__tagLayers || { scene: [], attr: [] };
    const sceneTags = layered.scene || [];
    const attrTags = layered.attr || [];
    document.getElementById('tagPicker')?.remove();
    const box = document.createElement('div');
    box.id = 'tagPicker';
    box.className = 'fixed z-[260] rounded-lg shadow-xl p-3 w-[380px] max-h-[60vh] overflow-y-auto';
    box.style.background = 'var(--bg-secondary)';
    box.style.border = '1px solid var(--border-color)';
    box.style.left = Math.round(window.innerWidth / 2 - 190) + 'px';
    box.style.top = '120px';
    box.innerHTML = `<div class="text-sm mb-2">给 ${sounds.length} 个音效设置标签</div>`;

    const section = (title, tags, multiple) => {
        const head = document.createElement('div');
        head.className = 'text-[11px] uppercase tracking-wider opacity-50 mt-2 mb-1';
        head.textContent = title;
        box.appendChild(head);
        if (!tags.length) {
            const empty = document.createElement('div');
            empty.className = 'text-[11px] opacity-40 px-1';
            empty.textContent = '暂无（在左侧标签上右键可设为' + title + '）';
            box.appendChild(empty);
            return [];
        }
        return tags.map((tag) => {
            const label = document.createElement('label');
            label.className = 'flex items-center gap-2 px-1 py-1 rounded hover:bg-white/5 cursor-pointer text-xs';
            const input = document.createElement('input');
            input.type = multiple ? 'checkbox' : 'radio';
            input.name = multiple ? 'attr-' + tag.id : 'scene-' + Math.random().toString(36).slice(2, 6);
            input.value = tag.id;
            input.dataset.layer = tag.layer;
            const span = document.createElement('span');
            span.textContent = tag.name;
            label.append(input, span);
            box.appendChild(label);
            return input;
        });
    };

    const sceneInputs = section('场景（单选）', sceneTags, false);
    const attrInputs = section('属性（可多选）', attrTags, true);

    const actions = document.createElement('div');
    actions.className = 'flex justify-end gap-2 mt-3';
    const cancel = document.createElement('button');
    cancel.className = 'px-3 py-1.5 rounded-md text-xs';
    cancel.style.background = 'var(--bg-tertiary)';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => box.remove());

    const ok = document.createElement('button');
    ok.className = 'px-3 py-1.5 rounded-md text-xs text-white';
    ok.style.background = '#8b5cf6';
    ok.textContent = '应用';
    ok.addEventListener('click', async () => {
        const tagIds = [];
        sceneInputs.forEach((input) => { if (input.checked) tagIds.push(input.value); });
        attrInputs.forEach((input) => { if (input.checked) tagIds.push(input.value); });
        box.remove();
        try {
            for (const sound of sounds) {
                await rendererApi.post(
                    `/api/v1/files/${encodeURIComponent(sound.id)}/tags`,
                    { tag_ids: tagIds }
                );
            }
            showNotification(`已为 ${sounds.length} 个音效设置标签`, 'success');
            await loadTagStats();
        } catch (error) {
            showNotification('设置标签失败: ' + error.message, 'error');
        }
    });
    actions.append(cancel, ok);
    box.appendChild(actions);
    document.body.appendChild(box);
}

async function patchTag(tagId, payload) {
    try {
        await rendererApi.patch(`/api/v1/tags/${encodeURIComponent(tagId)}`, payload);
        await loadTagStats();
    } catch (error) {
        showNotification('修改标签失败: ' + error.message, 'error');
    }
}

function createNewTag(preferredLayer) {
    document.getElementById('createTagOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'createTagOverlay';
    overlay.className = 'fixed inset-0 flex items-center justify-center';
    overlay.style.cssText = 'z-index:330;background:rgba(0,0,0,0.55)';

    const panel = document.createElement('div');
    panel.className = 'rounded-lg shadow-2xl p-5 w-[380px] flex flex-col gap-3';
    panel.style.cssText = 'background:var(--bg-secondary);border:1px solid var(--border-color)';
    panel.innerHTML = '<div class="text-base font-semibold">新建标签</div>';

    let layer = preferredLayer === 'scene' ? 'scene' : 'attr';
    const layerRow = document.createElement('div');
    layerRow.className = 'flex gap-2';
    const mkOption = (value, label, hint) => {
        const button = document.createElement('button');
        button.className = 'flex-1 px-2 py-1.5 rounded text-xs border text-left';
        button.dataset.layer = value;
        button.innerHTML = '<div class="font-medium">' + label + '</div>'
            + '<div class="opacity-50 text-[10px]">' + hint + '</div>';
        button.addEventListener('click', () => { layer = value; paint(); });
        layerRow.appendChild(button);
        return button;
    };
    const sceneBtn = mkOption('scene', '场景', '互斥，一个音效只能有一个');
    const attrBtn = mkOption('attr', '属性', '可多个，如 短促 / 金属');
    const paint = () => {
        [sceneBtn, attrBtn].forEach(btn => {
            const on = btn.dataset.layer === layer;
            btn.style.borderColor = on ? 'var(--accent-color, #6b8afd)' : 'var(--border-color)';
            btn.style.background = on ? 'rgba(107,138,253,0.16)' : 'transparent';
        });
    };
    paint();
    panel.appendChild(layerRow);

    const input = document.createElement('input');
    input.className = 'w-full px-2 py-1.5 rounded text-sm outline-none';
    input.style.cssText = 'background:var(--bg-primary);border:1px solid var(--border-color);color:var(--text-primary)';
    input.placeholder = layer === 'scene' ? '如：枪械、环境、UI' : '如：短促、金属、远距离';
    input.setAttribute('autofocus', '');
    input.setAttribute('tabindex', '0');
    panel.appendChild(input);

    const footer = document.createElement('div');
    footer.className = 'flex items-center justify-between mt-1';
    const hint = document.createElement('span');
    hint.className = 'text-[11px] opacity-50';
    hint.textContent = '回车确认，Esc 取消';
    const actions = document.createElement('div');
    actions.className = 'flex gap-2';
    const cancel = document.createElement('button');
    cancel.className = 'px-3 py-1.5 rounded text-sm border';
    cancel.style.borderColor = 'var(--border-color)';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => overlay.remove());
    const save = document.createElement('button');
    save.className = 'px-3 py-1.5 rounded text-sm font-medium';
    save.style.cssText = 'background:#3b82f6;color:#fff';
    save.textContent = '创建';
    actions.appendChild(cancel);
    actions.appendChild(save);
    footer.appendChild(hint);
    footer.appendChild(actions);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    const submit = async () => {
        const name = String(input.value || '').trim();
        if (!name) { input.focus(); return; }
        overlay.remove();
        try {
            await rendererApi.post('/api/v1/tags' + tagProjectQuery(), { name, layer });
        } catch (error) {
            showNotification('创建标签失败: ' + (error?.message || error), 'error');
            return;
        }
        const local = new Set(window.__localTags || []);
        local.add(name);
        window.__localTags = Array.from(local);
        try { localStorage.setItem('echomind.localTags', JSON.stringify(window.__localTags)); } catch (_) { }

        // 有选中音效就顺手打上（走用户标签接口）
        const targets = Array.from(selectedSounds || []);
        let applied = 0;
        for (const sound of targets) {
            const uuid = sound.fileId || sound.file_uuid;
            if (!uuid) continue;
            try {
                const current = await rendererApi.get('/api/v1/files/' + encodeURIComponent(uuid) + '/user-tags');
                const names = Array.from(new Set([...(current?.names || []), name]));
                await rendererApi.post('/api/v1/files/' + encodeURIComponent(uuid) + '/tags', { names, tag_ids: [] });
                applied += 1;
            } catch (error) {
                console.warn('[Tags] 打标签失败:', uuid, error);
            }
        }
        await loadTagStats();
        showNotification(
            applied ? `已创建标签「${name}」并加到 ${applied} 个音效` : `已创建标签「${name}」`,
            'success'
        );
    };
    save.addEventListener('click', submit);
    input.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') { event.preventDefault(); submit(); }
        if (event.key === 'Escape') { event.preventDefault(); overlay.remove(); }
    });

    // 焦点：只 focus 输入框本身。以前每次都先 window.focus()，
    // 它会把焦点从 input 抢回窗口，结果敲键盘没有任何字符进得去。
    const focusInput = () => { try { input.focus({ preventScroll: true }); input.select(); } catch (_) { } };
    requestAnimationFrame(focusInput);
    setTimeout(focusInput, 60);
    setTimeout(focusInput, 200);

    // 兜底：即使焦点没落到 input，敲进来的字符也手动补进输入框，
    // 保证「新建标签」在任何焦点状态下都可用。
    overlay.addEventListener('keydown', (event) => {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Enter') { event.preventDefault(); submit(); return; }
        if (event.key === 'Escape') { event.preventDefault(); overlay.remove(); return; }
        if (event.key === 'Backspace') {
            event.preventDefault();
            input.value = input.value.slice(0, -1);
            return;
        }
        if (event.key.length === 1) {
            event.preventDefault();
            input.value += event.key;
            try { input.focus({ preventScroll: true }); } catch (_) { }
        }
    }, true);
    overlay.addEventListener('mousedown', (event) => {
        if (event.target !== overlay) setTimeout(focusInput, 0);
    });
}

function filterByCategory(categoryId) {
    let filtered = soundData;
    
    if (categoryId === 'tag-all') {
        filtered = soundData;
    } else if (categoryId.startsWith('tag-')) {
        // 动态分类 - 根据分类名称过滤
        const categoryName = categoryId.replace('tag-', '');
        filtered = soundData.filter(s => s.category === categoryName);
    } else if (categoryId.startsWith('mytag:')) {
        // 「我的标签」是用户分类，存在 tags/file_tags 里，
        // 和文件自带的 6 维标签（files.tags）是两套，所以走后端查询。
        const tagName = categoryId.slice(6);
        loadFilesFromDatabase({ reset: true, tag: tagName }).then(() => {
            renderCategoryTree();
        });
        return;
    }
    
    renderSoundList(document.getElementById('searchInput').value, filtered);
}

function filterByFolder(folderId) {
    let filtered = soundData;
    
    if (folderId === 'nature') {
        filtered = soundData.filter(s => s.category === '自然音效');
    } else if (folderId === 'human') {
        filtered = soundData.filter(s => s.category === '人声动作');
    } else if (folderId === 'mechanical') {
        filtered = soundData.filter(s => s.category === '机械音效');
    } else if (folderId === 'foley') {
        filtered = soundData.filter(s => s.category === '拟音');
    } else if (folderId === 'ambient') {
        filtered = soundData.filter(s => s.category === '环境音');
    }
    
    renderSoundList(document.getElementById('searchInput').value, filtered);
}

