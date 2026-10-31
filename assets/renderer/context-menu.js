/* context-menu.js —— 右键菜单：文件操作与标签
 * 从 index.html 原样搬出，全局语义不变。
 */
// ==================== 右键菜单：文件操作 + 标签 ====================
let copiedTags = null; // 剪贴板中的标签集合（JSON 数组）

function closeSoundContextMenu() {
    const menu = document.getElementById('soundContextMenu');
    if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
}

function makeMenuItem(label, icon, action, { danger = false, disabled = false } = {}) {
    const item = document.createElement('button');
    item.className = `w-full px-3 py-2 text-sm text-left flex items-center gap-2 transition-colors ${disabled ? 'opacity-40 cursor-default' : 'hover:bg-white/5'} ${danger ? 'text-red-400' : ''}`;
    item.innerHTML = `<i data-lucide="${icon}" class="w-3.5 h-3.5 opacity-70 shrink-0"></i><span>${label}</span>`;
    if (!disabled) item.addEventListener('click', (e) => { e.stopPropagation(); closeSoundContextMenu(); action(); });
    return item;
}

// 转码：把剪辑软件不认的格式转成 WAV/MP3（顺手救损坏文件）
function showTranscodeModal(sounds) {
    document.getElementById('transcodeModal')?.remove();
    const list = (sounds || []).filter(Boolean);
    if (!list.length) return;

    const overlay = document.createElement('div');
    overlay.id = 'transcodeModal';
    overlay.className = 'fixed inset-0 z-[310] flex items-center justify-center';
    overlay.style.background = 'rgba(0,0,0,0.55)';
    overlay.innerHTML =
        '<div class="rounded-lg w-[540px] flex flex-col" style="background: var(--bg-secondary); border: 1px solid var(--border-color);">' +
        '  <div class="px-4 py-3 border-b text-sm font-medium" style="border-color: var(--border-color);">转码 ' + list.length + ' 个音频</div>' +
        '  <div class="p-4 space-y-3 text-sm">' +
        '    <div class="flex items-center gap-2"><span class="w-20 opacity-70">目标格式</span>' +
        '      <select id="tcFormat" class="flex-1 px-2 py-1 rounded" style="background: var(--bg-tertiary);">' +
        '        <option value="wav">WAV（无损，剪辑软件都认）</option>' +
        '        <option value="mp3">MP3（体积小）</option>' +
        '      </select></div>' +
        '    <div class="flex items-center gap-2"><span class="w-20 opacity-70">输出到</span>' +
        '      <input id="tcOutDir" type="text" class="flex-1 px-2 py-1 rounded" style="background: var(--bg-tertiary);" placeholder="留空 = 原文件夹下的 _转码 子目录"></div>' +
        '    <label class="flex items-center gap-2 opacity-70"><input id="tcKeepSource" type="checkbox" checked> 转码后替换源文件（库里记录改成新格式，标签/索引保留）</label>' +
        '    <label class="flex items-center gap-2 opacity-70"><input id="tcOverwrite" type="checkbox"> 同名输出文件直接覆盖</label>' +
        '    <div class="text-xs opacity-50">损坏的文件会自动尽量救回能解码的部分（救回多少算多少）。</div>' +
        '    <div id="tcProgress" class="text-xs opacity-60 h-4"></div>' +
        '    <div id="tcResults" class="max-h-44 overflow-y-auto text-[11px] space-y-1 pr-1"></div>' +
        '    <div id="tcOutHint" class="text-[11px] opacity-55"></div>' +
        '  </div>' +
        '  <div class="px-4 py-3 flex justify-end gap-2 border-t" style="border-color: var(--border-color);">' +
        '    <button id="tcCancel" class="px-3 py-1 rounded text-xs border" style="border-color: var(--border-color);">取消</button>' +
        '    <button id="tcStart" class="px-3 py-1 rounded text-xs text-white" style="background: #8b5cf6;">开始转码</button>' +
        '  </div>' +
        '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (event) => { if (event.target === overlay) overlay.remove(); });
    overlay.querySelector('#tcCancel').addEventListener('click', () => overlay.remove());

    overlay.querySelector('#tcStart').addEventListener('click', async () => {
        const format = overlay.querySelector('#tcFormat').value;
        const outDir = overlay.querySelector('#tcOutDir').value.trim();
        const overwrite = overlay.querySelector('#tcOverwrite').checked;
        const replaceSource = overlay.querySelector('#tcKeepSource')?.checked ?? false;
        const progress = overlay.querySelector('#tcProgress');
        const button = overlay.querySelector('#tcStart');
        button.disabled = true;
        button.style.opacity = '0.5';

        // 列表对象用的是 filePath（历史遗留有 path/file_path 两种），三个都要兼容
        const paths = list.map(item => item.filePath || item.path || item.file_path).filter(Boolean);
        const resultsEl = overlay.querySelector('#tcResults');
        const outHint = overlay.querySelector('#tcOutHint');
        let done = 0, ok = 0, salvaged = 0, failed = 0;
        let firstOutput = '';
        const addRow = (name, state, detail) => {
            if (!resultsEl) return;
            const row = document.createElement('div');
            row.className = 'flex items-start gap-1.5';
            const icon = state === 'ok' ? '✓' : (state === 'warn' ? '⚠' : '✗');
            const color = state === 'ok' ? '#22c55e' : (state === 'warn' ? '#f59e0b' : '#ef4444');
            row.innerHTML = '<span style="color:' + color + '">' + icon + '</span>'
                + '<span class="truncate" title="' + String(name).replace(/"/g, '&quot;') + '">' + name + '</span>'
                + (detail ? '<span class="opacity-45 truncate" title="' + String(detail).replace(/"/g, '&quot;') + '">' + detail + '</span>' : '');
            resultsEl.appendChild(row);
            resultsEl.scrollTop = resultsEl.scrollHeight;
        };
        if (!paths.length) {
            progress.textContent = '';
            addRow('没有选中任何文件', 'fail', '先在列表里选中要转码的音效');
            button.disabled = false; button.style.opacity = '1';
            return;
        }
        const CHUNK = 20;
        for (let i = 0; i < paths.length; i += CHUNK) {
            const chunk = paths.slice(i, i + CHUNK);
            try {
                const result = await rendererApi.post('/api/v1/transcode', {
                    paths: chunk,
                    target_format: format,
                    out_dir: replaceSource ? null : (outDir || null),
                    overwrite,
                    replace_source: replaceSource,
                }, { timeoutMs: 600000 });
                ok += result.ok || 0;
                failed += result.failed || 0;
                salvaged += result.salvaged || 0;
                (result.results || []).forEach((item) => {
                    const name = String(item.source || '').split(/[\\/]/).pop();
                    if (!item.destination) firstOutput = '';
                    else if (!firstOutput) firstOutput = item.destination;
                    if (item.ok && item.salvaged) addRow(name, 'warn', '救回（部分数据损坏）');
                    else if (item.ok) addRow(name, 'ok', '');
                    else addRow(name, 'fail', (item.error || '失败').slice(0, 60));
                });
            } catch (error) {
                failed += chunk.length;
                addRow('本批 ' + chunk.length + ' 个', 'fail', (error?.message || String(error)).slice(0, 60));
            }
            done += chunk.length;
            progress.textContent = '进度 ' + done + ' / ' + paths.length + '（成功 ' + ok + '，救回 ' + salvaged + '，失败 ' + failed + '）';
        }
        progress.textContent = '完成：成功 ' + ok + '，其中救回 ' + salvaged + '，失败 ' + failed;
        if (outHint) {
            if (firstOutput) {
                const dir = firstOutput.replace(/[\\/][^\\/]+$/, '');
                outHint.innerHTML = '输出目录：<span class="opacity-80">' + dir + '</span>'
                    + ' <button id="tcOpenOut" class="ml-1 underline">打开</button>';
                outHint.querySelector('#tcOpenOut')?.addEventListener('click', () => {
                    window.electronAPI?.fileImport?.revealInExplorer?.(firstOutput);
                });
            } else if (!outDir) {
                outHint.textContent = '输出位置：每个源文件同级的「_转码」子文件夹';
            }
        }
        if (typeof rememberEvent === 'function') {
            list.slice(0, 20).forEach((item) => rememberEvent('usage', item, '转码'));
        }
        showNotification('转码完成：' + ok + ' 个成功' + (salvaged ? '，' + salvaged + ' 个是救回的' : ''), failed ? 'warning' : 'success');
        if (ok > 0) {
            // 替换模式下文件名/格式变了，刷新列表让用户立刻看到 .wav
            try {
                await loadFilesFromDatabase({ reset: true });
                if (currentSound) renderSoundDetail(currentSound);
            } catch (refreshError) {
                console.warn('[Transcode] 刷新列表失败:', refreshError);
            }
        }
        button.disabled = false;
        button.style.opacity = '1';
    });
    lucide.createIcons();
}


async function batchDeleteSounds(targets, deleteSource) {
    const list = (targets || []).filter(Boolean);
    if (!list.length) return;
    const names = list.slice(0, 5).map(item => item.name).join('\n');
    const more = list.length > 5 ? '\n… 等 ' + list.length + ' 个' : '';
    const ok = confirm(
        (deleteSource
            ? '删除 ' + list.length + ' 个音效的源文件（送回收站）并从库移除？'
            : '从软件中移除 ' + list.length + ' 条记录（磁盘文件保留）？')
        + '\n\n' + names + more
    );
    if (!ok) return;

    const paths = list.map(item => item.filePath || item.path).filter(Boolean);
    showNotification('正在处理 ' + paths.length + ' 个…', 'info');
    try {
        if (deleteSource) {
            const trashed = await window.electronAPI?.fileImport?.trashFiles?.(paths);
            if (trashed && trashed.failed && trashed.failed.length) {
                console.warn('[Delete] 部分文件未能送回收站:', trashed.failed.slice(0, 5));
            }
        }
        const result = await rendererApi.post('/api/v1/db/files/delete', { paths, delete_source: deleteSource },
            { timeoutMs: 600000 });
        selectedSounds.clear();
        lastCheckedIndex = -1;
        await loadFilesFromDatabase({ reset: true });
        showNotification(
            '已' + (deleteSource ? '删除源文件并' : '') + '移除 ' + (result?.removed ?? paths.length) + ' 条记录'
            + (result?.failed ? '，失败 ' + result.failed : ''),
            result?.failed ? 'warning' : 'success'
        );
    } catch (error) {
        showNotification('删除失败: ' + (error?.message || error), 'error');
    }
}

function showSoundContextMenu(event, sound) {
    closeSoundContextMenu();
    const menu = document.createElement('div');
    menu.id = 'soundContextMenu';
    menu.className = 'fixed z-[200] rounded-lg shadow-xl py-1 w-52';
    menu.style.backgroundColor = 'var(--bg-secondary)';
    menu.style.border = '1px solid var(--border-color)';
    menu.style.left = `${Math.min(event.clientX, window.innerWidth - 230)}px`;
    menu.style.top = `${Math.min(event.clientY, window.innerHeight - 340)}px`;

    const multi = selectedSounds.size > 0 && selectedSounds.has(sound.id);

    // 标签操作组
    menu.appendChild(makeMenuItem('添加/编辑标签', 'tag', () => showTagModal(sound)));
    menu.appendChild(makeMenuItem('复制标签', 'copy', () => {
        copiedTags = [...(sound.tags || [])];
        showNotification(`已复制 ${copiedTags.length} 个标签`, 'success');
    }));
    menu.appendChild(makeMenuItem(`粘贴标签${copiedTags && copiedTags.length ? ` (${copiedTags.length}个)` : ''}`, 'clipboard', () => pasteTagsToSounds(multi ? [...selectedSounds] : [sound.id]), { disabled: !(copiedTags && copiedTags.length) }));
    menu.appendChild(makeMenuItem('标签管理', 'tags', () => showTagManagerModal()));
    menu.appendChild(makeMenuItem('转码为 WAV / MP3…', 'repeat', () => {
        const targets = (selectedSounds.size > 0 && selectedSounds.has(sound.id))
            ? soundData.filter(item => selectedSounds.has(item.id))
            : [sound];
        showTranscodeModal(targets);
    }));

    // 分隔线
    const sep = document.createElement('div');
    sep.className = 'my-1 border-t';
    sep.style.borderColor = 'var(--border-color)';
    menu.appendChild(sep);

    // 标签：双层设置
    menu.appendChild(makeMenuItem('设置标签…', 'tags', () => {
        const targets = (selectedSounds.size > 0 && selectedSounds.has(sound.id))
            ? [...selectedSounds]
            : [sound];
        showTagPicker(targets);
    }));

    // 添加到自定义文件夹（常用 / 收藏 等）
    if (Array.isArray(userFolders) && userFolders.length > 0) {
        const sepFolder = document.createElement('div');
        sepFolder.className = 'my-1 border-t';
        sepFolder.style.borderColor = 'var(--border-color)';
        menu.appendChild(sepFolder);
        menu.appendChild(makeMenuItem('添加到文件夹…', 'folder-plus', () => {
            const targets = (selectedSounds.size > 0 && selectedSounds.has(sound.id))
                ? [...selectedSounds]
                : [sound];
            showAddToUserFolderMenu(targets);
        }));
    }

    // 正在「我的文件夹」视图里：给一条直接移出的入口（单选 / 多选都行）
    if (activeUserFolder && activeUserFolder.sounds === allSearchResults) {
        const removeTargets = (multi && selectedSounds.has(sound.id))
            ? resolveSoundsForIds([...selectedSounds])
            : [sound];
        if (removeTargets.length) {
            menu.appendChild(makeMenuItem(
                '从「' + activeUserFolder.name + '」移出' + (removeTargets.length > 1 ? ' (' + removeTargets.length + ')' : ''),
                'folder-minus',
                () => removeSoundsFromUserFolder(activeUserFolder, removeTargets)
            ));
        }
    }

    // 文件操作组（Billfish 式）
    menu.appendChild(makeMenuItem('在资源管理器中打开', 'folder-open', () => openInExplorer(sound)));
    // 多选时给「批量重命名」，单选还是原来的单文件重命名
    if (multi && selectedSounds.size > 1) {
        const batchSounds = resolveSoundsForIds([...selectedSounds]);
        if (batchSounds.length > 1) {
            menu.appendChild(makeMenuItem(
                '批量重命名… (' + batchSounds.length + ')',
                'files',
                () => showBatchRenameModal(batchSounds)
            ));
        }
    }
    menu.appendChild(makeMenuItem('重命名', 'edit-3', () => renameSoundFile(sound)));
    menu.appendChild(makeMenuItem('复制文件', 'file-copy', () => copySoundFile(sound)));
    const extras = document.createElement('div');
    extras.className = 'border-t mt-1 pt-1';
    extras.style.borderColor = 'var(--border-color)';
    const mkExtra = (label, danger, handler) => {
        const item = document.createElement('button');
        item.className = 'w-full text-left px-3 py-1.5 text-xs hover:bg-white/10';
        if (danger) item.style.color = '#ef4444';
        item.textContent = label;
        item.addEventListener('click', () => { closeSoundContextMenu(); handler(); });
        extras.appendChild(item);
    };
    const targetsForDelete = () => (selectedSounds.size && selectedSounds.has(sound.id))
        ? soundData.filter(item => selectedSounds.has(item.id))
        : [sound];
    mkExtra('仅从软件中移除（保留文件）', false, () => batchDeleteSounds(targetsForDelete(), false));
    mkExtra('删除源文件并从库移除（回收站）', true, () => batchDeleteSounds(targetsForDelete(), true));
    menu.appendChild(extras);

    menu.appendChild(makeMenuItem('重新分析：一句话描述（只重算文本向量）', 'file-text', () => reanalyzeSound(sound, 'description')));
    menu.appendChild(makeMenuItem('重新分析：音频向量（不动描述/标签）', 'audio-waveform', () => reanalyzeSound(sound, 'audio')));
    menu.appendChild(makeMenuItem('重新分析：全部', 'refresh-cw', () => reanalyzeSound(sound, 'all')));

    const closeMenu = (e) => {
        if (!menu.contains(e.target)) {
            closeSoundContextMenu();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 100);
    document.body.appendChild(menu);
    lucide.createIcons();
}

// 把选中的音效加入某个用户文件夹（常用/收藏等）
function showAddToUserFolderMenu(sounds) {
    closeSoundContextMenu();
    document.getElementById('addToFolderMenu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'addToFolderMenu';
    menu.className = 'fixed z-[210] rounded-lg shadow-xl py-1 w-52 max-h-80 overflow-y-auto';
    menu.style.backgroundColor = 'var(--bg-secondary)';
    menu.style.border = '1px solid var(--border-color)';
    menu.style.left = Math.round(window.innerWidth / 2 - 110) + 'px';
    menu.style.top = '160px';

    const head = document.createElement('div');
    head.className = 'px-3 py-2 text-xs opacity-60 border-b';
    head.style.borderColor = 'var(--border-color)';
    head.textContent = `添加 ${sounds.length} 个音效到…`;
    menu.appendChild(head);

    userFolders.forEach((folder) => {
        const item = document.createElement('button');
        item.className = 'w-full px-3 py-2 text-sm text-left hover:bg-white/5 flex items-center gap-2';
        item.innerHTML = `<span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${folder.color || '#3b82f6'}"></span>
            <span class="truncate">${escapeHtml(folder.name)}</span>`;
        item.addEventListener('click', async () => {
            menu.remove();
            try {
                const paths = sounds.map(s => s.filePath || s.path).filter(Boolean);
                const result = await rendererApi.post(
                    `/api/v1/projects/${encodeURIComponent(currentProject?.id || 'default')}`
                    + `/folders/${encodeURIComponent(folder.id)}/files`,
                    { paths }
                );
                showNotification(
                    `已添加 ${result?.added ?? 0} 个到「${folder.name}」`,
                    (result?.added ?? 0) > 0 ? 'success' : 'info'
                );
                await loadUserFolders();
                renderFolderTree();
            } catch (error) {
                showNotification('添加失败: ' + error.message, 'error');
            }
        });
        menu.appendChild(item);
    });

    const cancel = document.createElement('button');
    cancel.className = 'w-full px-3 py-2 text-sm text-left hover:bg-white/5 opacity-70 border-t mt-1';
    cancel.style.borderColor = 'var(--border-color)';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => menu.remove());
    menu.appendChild(cancel);

    document.body.appendChild(menu);
    const close = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', close);
        }
    };
    setTimeout(() => document.addEventListener('click', close), 100);
}

// ---- 标签操作 ----
function parseTagsInput(raw) {
    return (raw || '').split(/[,，、;；]/).map(t => t.trim()).filter(Boolean);
}

function showTagModal(sound) {
    document.getElementById('tagPickerOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'tagPickerOverlay';
    overlay.className = 'fixed inset-0 z-[320] flex items-center justify-center';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.55)';

    const panel = document.createElement('div');
    panel.className = 'rounded-lg shadow-2xl p-5 w-[560px] max-h-[80vh] flex flex-col gap-3';
    panel.style.backgroundColor = 'var(--bg-secondary)';
    panel.style.border = '1px solid var(--border-color)';

    const title = document.createElement('div');
    title.className = 'flex items-center justify-between';
    title.innerHTML = '<div class="text-base font-semibold">标签</div>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'p-1 rounded hover:bg-white/10';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());
    title.appendChild(closeBtn);
    panel.appendChild(title);

    const current = new Set((sound.tags || []).map(t => String(t)));
    const chosen = new Set(current);

    // 预设标签（类型/场景/特性各 7 个）
    Object.entries(TAG_PRESETS).forEach(([group, names]) => {
        const label = document.createElement('div');
        label.className = 'text-[11px] opacity-50 mt-1';
        label.textContent = group;
        panel.appendChild(label);

        const row = document.createElement('div');
        row.className = 'flex flex-wrap gap-1.5';
        names.forEach((name) => {
            const chip = document.createElement('button');
            chip.className = 'px-2 py-1 rounded text-xs border transition-colors';
            chip.textContent = name;
            const paint = () => {
                const on = chosen.has(name);
                chip.style.borderColor = on ? 'var(--accent-color, #6b8afd)' : 'var(--border-color)';
                chip.style.backgroundColor = on ? 'rgba(107,138,253,0.18)' : 'transparent';
                chip.style.opacity = on ? '1' : '0.75';
            };
            chip.addEventListener('click', () => {
                if (chosen.has(name)) chosen.delete(name); else chosen.add(name);
                paint();
            });
            paint();
            row.appendChild(chip);
        });
        panel.appendChild(row);
    });

    const input = document.createElement('input');
    input.className = 'w-full px-2 py-1.5 rounded text-sm outline-none';
    input.style.backgroundColor = 'var(--bg-tertiary)';
    input.style.border = '1px solid var(--border-color)';
    input.placeholder = '还可以自己输入，用逗号分隔多个';
    panel.appendChild(input);

    const footer = document.createElement('div');
    footer.className = 'flex items-center justify-between mt-1';
    const hint = document.createElement('span');
    hint.className = 'text-[11px] opacity-50';
    hint.textContent = '预设标签来自词表，建议优先用它们';
    const actions = document.createElement('div');
    actions.className = 'flex gap-2';
    const cancel = document.createElement('button');
    cancel.className = 'px-3 py-1.5 rounded text-sm border';
    cancel.style.borderColor = 'var(--border-color)';
    cancel.textContent = '取消';
    cancel.addEventListener('click', () => overlay.remove());
    const save = document.createElement('button');
    save.className = 'px-3 py-1.5 rounded text-sm font-medium';
    save.style.backgroundColor = 'var(--accent-color, #6b8afd)';
    save.style.color = '#fff';
    save.textContent = '保存';
    save.addEventListener('click', async () => {
        const extra = String(input.value || '')
            .split(/[,，]/)
            .map(t => t.trim())
            .filter(Boolean);
        extra.forEach(t => chosen.add(t));
        const tags = Array.from(chosen);
        overlay.remove();
        await setSoundTags(sound, tags);
    });
    actions.appendChild(cancel);
    actions.appendChild(save);
    footer.appendChild(hint);
    footer.appendChild(actions);
    panel.appendChild(footer);

    overlay.appendChild(panel);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    lucide.createIcons();
    input.focus();
}

async function setSoundTags(sound, tags, options = {}) {
    if (!window.electronAPI || !window.electronAPI.backendAPI) {
        if (!options.silent) showNotification('后端不可用', 'error');
        throw new Error('后端不可用');
    }
    try {
        await window.electronAPI.backendAPI.updateFileTags(sound.filePath, tags);
        sound.tags = tags;
        renderSoundList();
        renderCategoryTree();
        if (typeof rememberEvent === 'function') rememberEvent('usage', sound, '改标签');
        if (!options.silent) showNotification(`已保存 ${tags.length} 个标签`, 'success');
    } catch (err) {
        if (options.silent) throw err;
        showNotification('保存标签失败: ' + (err.message || err), 'error');
    }
}

async function pasteTagsToSounds(ids) {
    if (!copiedTags || copiedTags.length === 0) return;
    const targets = soundData.filter(s => ids.includes(s.id));
    if (targets.length === 0) return;
    try {
        if (targets.length === 1) {
            await window.electronAPI.backendAPI.updateFileTags(targets[0].filePath, copiedTags);
        } else {
            await window.electronAPI.backendAPI.batchSetTags(targets.map(t => t.filePath), copiedTags);
        }
        targets.forEach(t => { t.tags = [...copiedTags]; });
        renderSoundList();
        renderCategoryTree();
        showNotification(`已粘贴标签到 ${targets.length} 个文件`, 'success');
    } catch (err) {
        showNotification('粘贴标签失败: ' + (err.message || err), 'error');
    }
}

// ---- 文件操作（Billfish 式）----
function openInExplorer(sound) {
    if (!window.electronAPI || !window.electronAPI.fileImport || !window.electronAPI.fileImport.revealInExplorer) {
        showNotification('打开资源管理器功能不可用', 'error');
        return;
    }
    window.electronAPI.fileImport.revealInExplorer(sound.filePath).then((r) => {
        if (r && !r.success) showNotification(r.error || '无法定位文件', 'error');
    }).catch((err) => showNotification('打开失败: ' + (err.message || err), 'error'));
}

function renameSoundFile(sound) {
    const extMatch = (sound.name || '').match(/(\.[^.]+)$/);
    const hint = sound.name || '';
    showInputModal('重命名文件（含扩展名）', hint, (newName) => {
        if (!newName || newName === sound.name) return;
        const oldPath = sound.filePath;
        const newPath = oldPath.replace(/[^\\/]+$/, newName);
        if (!window.electronAPI || !window.electronAPI.fileImport || !window.electronAPI.fileImport.renameFileOnDisk) {
            showNotification('重命名功能不可用', 'error');
            return;
        }
        window.electronAPI.fileImport.renameFileOnDisk(oldPath, newName).then((r) => {
            if (r && r.success) {
                sound.name = newName;
                sound.filePath = newPath;
                renderSoundList();
                renderCategoryTree();
                showNotification('文件已重命名', 'success');
            } else {
                showNotification((r && r.error) || '重命名失败', 'error');
            }
        }).catch((err) => showNotification('重命名失败: ' + (err.message || err), 'error'));
    });
    const inputEl = document.getElementById('inputModalField');
    if (inputEl) inputEl.value = sound.name;
}

function copySoundFile(sound) {
    if (!window.electronAPI || !window.electronAPI.fileImport || !window.electronAPI.fileImport.copyFileToClipboard) {
        showNotification('复制文件功能不可用', 'error');
        return;
    }
    window.electronAPI.fileImport.copyFileToClipboard(sound.filePath).then((r) => {
        if (r && r.success) {
            if (r.method === 'fallback') {
                showNotification('已复制文件（兼容模式）', 'info');
            } else {
                showNotification('文件已复制到剪贴板，可到资源管理器粘贴', 'success');
            }
        } else {
            showNotification((r && r.error) || '复制失败', 'error');
        }
    }).catch((err) => showNotification('复制失败: ' + (err.message || err), 'error'));
}

// B22：重新分析拆成四个粒度，只动该动的部分
async function reanalyzeSound(sound, scope) {
    const mode = scope || 'all';
    const label = {
        description: '重新生成描述',
        audio: '重算音频向量',
        tags: '重新生成标签',
        all: '全部重新分析',
    }[mode] || '重新分析';
    try {
        const res = await rendererApi.post(
            '/api/v1/db/file/' + encodeURIComponent(sound.filePath)
            + '/reanalyze?scope=' + encodeURIComponent(mode),
            {},
            { timeoutMs: 180000 }
        );
        showNotification(`已提交${label}：「${sound.name}」`, 'info');
        return res;
    } catch (error) {
        showNotification(label + '失败: ' + (error?.message || error), 'error');
    }
}

// ---- 批量重命名 ----
// 选中 id → sound（列表 / 卡片 / AI 结果里都可能躺着同一个 id）
function resolveSoundsForIds(ids) {
    const wanted = new Set((ids || []).map(String));
    const found = [];
    const seen = new Set();
    const consider = (sound) => {
        if (!sound || sound.id === undefined || sound.id === null) return;
        const key = String(sound.id);
        if (!wanted.has(key) || seen.has(key)) return;
        seen.add(key);
        found.push(sound);
    };
    (soundData || []).forEach(consider);
    (lastRenderedSounds || []).forEach(consider);
    (allSearchResults || []).forEach(consider);
    return found;
}

const BATCH_RENAME_PATH = '/api/v1/files/rename';

function postBatchRename(items, extra) {
    const projectId = currentProject?.id || 'default';
    return rendererApi.post(
        BATCH_RENAME_PATH + '?project_id=' + encodeURIComponent(projectId),
        Object.assign({ items: items }, extra),
        { timeoutMs: 180000 }
    );
}

// 预览只问不动盘；执行才真改名
function previewBatchRename(items) { return postBatchRename(items, { dry_run: true }); }
function executeBatchRename(items) { return postBatchRename(items, { dry_run: false }); }

// 按标签 / 文件夹整批改名：先按标签页相同的查询把文件捞出来，再进弹窗
function soundsFromFiles(files) {
    return (files || []).map((file, index) => mapDbFileToSound(
        Object.assign({}, file, { path: file.path || file.file_path }),
        index
    )).filter((sound) => sound && sound.filePath);
}

function dedupeSounds(list) {
    const seen = new Set();
    return (list || []).filter((sound) => {
        const key = sound && (sound.filePath || sound.id);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function openBatchRenameFor(loader, label) {
    try {
        showNotification('正在收集' + label + '…', 'info');
        const sounds = dedupeSounds(await loader());
        if (!sounds.length) {
            showNotification(label + ' 里没有可重命名的音效', 'info');
            return;
        }
        showBatchRenameModal(sounds);
    } catch (error) {
        showNotification('收集失败：' + (error?.message || error), 'error');
    }
}

function renameSoundsInTag(tagName) {
    const projectId = currentProject?.id || 'default';
    openBatchRenameFor(async () => {
        const page = await rendererApi.get(
            '/api/v1/files?limit=500&tag=' + encodeURIComponent(tagName)
            + '&project_id=' + encodeURIComponent(projectId)
        );
        return soundsFromFiles(page && page.files);
    }, '标签「' + tagName + '」');
}

function renameSoundsInFolder(folderPath) {
    const projectId = currentProject?.id || 'default';
    openBatchRenameFor(async () => {
        const collected = [];
        let cursor = null;
        // 分页取，最多凑够一个批次（MAX_BATCH）
        do {
            let url = '/api/v1/files?project_id=' + encodeURIComponent(projectId)
                + '&limit=500&folder=' + encodeURIComponent(folderPath);
            if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
            const data = await rendererApi.get(url);
            collected.push.apply(collected, soundsFromFiles(data && data.files));
            cursor = data && data.next_cursor ? data.next_cursor : null;
        } while (cursor && collected.length < rendererRename.MAX_BATCH);
        return collected;
    }, '文件夹「' + rendererRename.basename(folderPath) + '」');
}

function renameSoundsInUserFolder(folder, childFolders) {
    const projectId = currentProject?.id || 'default';
    openBatchRenameFor(async () => {
        const collected = [];
        for (const child of (childFolders || [])) {
            if (collected.length >= rendererRename.MAX_BATCH) break;
            try {
                const page = await rendererApi.get(
                    '/api/v1/files?project_id=' + encodeURIComponent(projectId)
                    + '&limit=500&folder=' + encodeURIComponent(child.path)
                );
                collected.push.apply(collected, soundsFromFiles(page && page.files));
            } catch (error) {
                console.warn('[BatchRename] 读取映射目录失败:', error);
            }
        }
        try {
            const data = await rendererApi.get(
                '/api/v1/projects/' + encodeURIComponent(projectId)
                + '/folders/' + encodeURIComponent(folder.id) + '/files'
            );
            collected.push.apply(collected, soundsFromFiles(data && data.files));
        } catch (error) {
            console.warn('[BatchRename] 读取文件夹成员失败:', error);
        }
        return collected;
    }, '文件夹「' + folder.name + '」');
}
function showBatchRenameModal(sounds) {
    const picked = (sounds || []).filter(Boolean);
    const targets = picked.slice(0, rendererRename.MAX_BATCH);
    if (targets.length === 0) {
        showNotification('没有可重命名的音效', 'info');
        return;
    }
    if (picked.length > targets.length) {
        showNotification('一次最多重命名 ' + rendererRename.MAX_BATCH + ' 个，本次只处理前 ' + targets.length + ' 个', 'info');
    }

    document.getElementById('batchRenameModal')?.remove();

    const overlay = document.createElement('div');
    overlay.id = 'batchRenameModal';
    overlay.className = 'fixed inset-0 z-[300] flex items-center justify-center';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.55)';

    const panel = document.createElement('div');
    panel.className = 'rounded-lg shadow-2xl flex flex-col overflow-hidden w-[880px] max-w-[94vw] max-h-[82vh]';
    panel.style.backgroundColor = 'var(--bg-secondary)';
    panel.style.border = '1px solid var(--border-color)';
    panel.innerHTML =
        '<div class="flex items-start justify-between gap-4 px-5 py-4 border-b shrink-0" style="border-color: var(--border-color);">' +
            '<div class="min-w-0">' +
                '<h3 class="text-base font-semibold">批量重命名</h3>' +
                '<div class="text-xs opacity-60 mt-1">共 ' + targets.length + ' 个文件 · 改「新文件名」那一列，回车可预览</div>' +
            '</div>' +
            '<button data-role="close" class="p-1 rounded hover:bg-white/10 transition-colors shrink-0"><i data-lucide="x" class="w-4 h-4"></i></button>' +
        '</div>' +
        '<div class="flex items-center gap-2 px-5 py-2 border-b shrink-0 text-xs" style="border-color: var(--border-color);">' +
            '<span class="opacity-60">已改 <span data-role="changed" class="font-mono">0</span> 个</span>' +
            '<span data-role="sep" class="opacity-20" style="display: none;">|</span>' +
            '<span data-role="summary" class="truncate opacity-70"></span>' +
            '<span class="flex-1"></span>' +
            '<button data-role="reset" class="px-2 py-1 rounded border hover:bg-white/5" style="border-color: var(--border-color);">全部还原</button>' +
        '</div>' +
        '<div data-role="rules" class="px-5 py-2 border-b shrink-0 text-xs" style="border-color: var(--border-color);">' +
            '<div class="flex items-center gap-1.5 flex-wrap">' +
                '<span class="opacity-60">前缀</span>' +
                '<input data-rule="prefix" placeholder="SFX_" class="h-6 w-24 px-1.5 rounded border" style="background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary);">' +
                '<span class="opacity-60 ml-2">后缀</span>' +
                '<input data-rule="suffix" placeholder="_v2" class="h-6 w-20 px-1.5 rounded border" style="background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary);">' +
                '<span class="opacity-60 ml-2">大小写</span>' +
                '<select data-rule="caseMode" class="h-6 px-1 rounded border" style="background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary);">' +
                    '<option value="">原样</option>' +
                    '<option value="lower">全小写</option>' +
                    '<option value="upper">全大写</option>' +
                    '<option value="title">首字母大写</option>' +
                '</select>' +
                '<label class="flex items-center gap-1 cursor-pointer ml-2" title="按正则在主名上替换，支持 $1 分组引用">' +
                    '<input type="checkbox" data-rule="regex" class="w-3.5 h-3.5 rounded">' +
                    '<span class="opacity-60">正则</span>' +
                '</label>' +
                '<span class="opacity-60 ml-1">查找</span>' +
                '<input data-rule="find" placeholder="_" class="h-6 w-24 px-1.5 rounded border" style="background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary);">' +
                '<span class="opacity-40">→</span>' +
                '<input data-rule="replace" placeholder="空格" class="h-6 w-24 px-1.5 rounded border" style="background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary);">' +
            '</div>' +
            '<div class="flex items-center gap-1.5 mt-1.5">' +
                '<label class="flex items-center gap-1 cursor-pointer">' +
                    '<input type="checkbox" data-rule="numbering-enabled" class="w-3.5 h-3.5 rounded">' +
                    '<span class="opacity-60">自动编号</span>' +
                '</label>' +
                '<span class="opacity-60 ml-1">起始</span>' +
                '<input type="number" data-rule="numbering-start" value="1" class="h-6 w-14 px-1.5 rounded border" style="background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary);">' +
                '<span class="opacity-60">位数</span>' +
                '<input type="number" data-rule="numbering-digits" value="2" class="h-6 w-12 px-1.5 rounded border" style="background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary);">' +
                '<span class="opacity-60">分隔</span>' +
                '<input data-rule="numbering-separator" value="_" class="h-6 w-10 px-1.5 rounded border" style="background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary);">' +
                '<span class="flex-1"></span>' +
                '<span class="opacity-40 mr-1">规则按原名重算，重复应用不会叠加</span>' +
                '<button data-role="apply-rules" class="px-2 py-1 rounded border hover:bg-white/5" style="border-color: var(--border-color);">应用到全部</button>' +
            '</div>' +
        '</div>' +
        '<div class="grid items-center gap-2 px-5 py-1.5 text-[11px] uppercase tracking-wider opacity-60 border-b shrink-0" style="border-color: var(--border-color); grid-template-columns: 1fr 16px 1fr 92px;">' +
            '<div>原名</div><div></div><div>新名</div><div>状态</div>' +
        '</div>' +
        '<div data-role="rows" class="flex-1 overflow-y-auto min-h-[160px]"></div>' +
        '<div class="flex items-center gap-2 px-5 py-3 border-t shrink-0" style="border-color: var(--border-color);">' +
            '<div data-role="hint" class="flex-1 text-xs opacity-60 truncate">先「预览」确认可改范围，再「执行」动磁盘</div>' +
            '<button data-role="cancel" class="px-3 py-1.5 rounded text-sm border hover:bg-white/5" style="border-color: var(--border-color);">取消</button>' +
            '<button data-role="preview" class="px-3 py-1.5 rounded text-sm hover:opacity-90" style="background: var(--bg-tertiary);">预览</button>' +
            '<button data-role="execute" class="px-3 py-1.5 rounded text-sm text-white" style="background: #22c55e; opacity: 0.4; cursor: not-allowed;" disabled>执行</button>' +
        '</div>';

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const rowsEl = panel.querySelector('[data-role="rows"]');
    const changedEl = panel.querySelector('[data-role="changed"]');
    const summaryEl = panel.querySelector('[data-role="summary"]');
    const hintEl = panel.querySelector('[data-role="hint"]');
    const previewBtn = panel.querySelector('[data-role="preview"]');
    const executeBtn = panel.querySelector('[data-role="execute"]');

    const state = { rows: [], previewOk: null, previewItems: [], busy: false, armed: false, armTimer: null };
    const STATUS_COLORS = { idle: 'var(--text-secondary)', stale: '#f59e0b', ok: '#22c55e', error: '#ef4444', done: '#22c55e' };

    function setStatus(row, kind, text) {
        row.kind = kind;
        row.statusEl.textContent = text;
        row.statusEl.style.color = STATUS_COLORS[kind] || 'var(--text-secondary)';
        row.statusEl.style.opacity = kind === 'idle' ? '0.5' : '1';
        row.statusEl.title = text;
    }

    // 统计行没内容时把分隔符一起藏起来，别留一根孤零零的竖线
    function setSummary(text) {
        summaryEl.textContent = text || '';
        const sep = panel.querySelector('[data-role="sep"]');
        if (sep) sep.style.display = text ? '' : 'none';
    }

    function setExecuteEnabled(enabled) {
        executeBtn.disabled = !enabled;
        executeBtn.style.opacity = enabled ? '1' : '0.4';
        executeBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
    }

    function setPreviewBusy(busy) {
        previewBtn.disabled = busy;
        previewBtn.textContent = busy ? '预览中…' : '预览';
        previewBtn.style.opacity = busy ? '0.5' : '1';
    }

    function disarm() {
        state.armed = false;
        if (state.armTimer) { clearTimeout(state.armTimer); state.armTimer = null; }
        executeBtn.textContent = '执行';
        executeBtn.style.background = '#22c55e';
    }

    function collectPlan() {
        const names = {};
        state.rows.forEach((row) => { names[String(row.sound.id)] = row.inputEl.value; });
        return rendererRename.planItems(state.rows.map((row) => row.sound), names);
    }

    function readRules() {
        const field = (name) => {
            const el = panel.querySelector('[data-rule="' + name + '"]');
            return el ? el.value : '';
        };
        return {
            prefix: field('prefix'),
            suffix: field('suffix'),
            find: field('find'),
            replace: field('replace'),
            regex: Boolean(panel.querySelector('[data-rule="regex"]')?.checked),
            caseMode: field('caseMode'),
            numbering: {
                enabled: Boolean(panel.querySelector('[data-rule="numbering-enabled"]')?.checked),
                start: field('numbering-start'),
                digits: field('numbering-digits'),
                separator: field('numbering-separator')
            }
        };
    }

    // 规则一律以「原名」为底稿重算，所以手改过的行也会被覆盖，重复点不会叠前缀
    function applyRulesToAll() {
        const rules = readRules();
        const problem = rendererRename.validateRules(rules);
        if (problem) {
            setSummary(problem);
            hintEl.textContent = '「查找」里的正则没写对，改好再应用';
            showNotification(problem, 'error');
            return;
        }
        state.rows.forEach((row, index) => {
            const next = rendererRename.applyRules(row.oldName, rules, index);
            row.inputEl.value = next;
            const reason = rendererRename.validateName(next);
            if (reason) setStatus(row, 'error', reason);
            else if (next.trim() === row.oldName) setStatus(row, 'idle', '未改动');
            else setStatus(row, 'stale', '待预览');
        });
        onDirty();
        hintEl.textContent = '已按规则更新 ' + state.rows.length + ' 行，预览后再执行';
    }

    function countKinds() {
        const tally = { ok: 0, error: 0, idle: 0, stale: 0 };
        state.rows.forEach((row) => { tally[row.kind] = (tally[row.kind] || 0) + 1; });
        return tally;
    }

    // 任何一处编辑都会让上一次预览作废：强制重看一遍再执行
    function onDirty() {
        changedEl.textContent = String(collectPlan().length);
        setSummary('');
        state.previewOk = null;
        state.previewItems = [];
        disarm();
        setExecuteEnabled(false);
    }

    function closeModal() {
        if (state.armTimer) { clearTimeout(state.armTimer); state.armTimer = null; }
        document.removeEventListener('keydown', onKeydown);
        overlay.remove();
    }

    function onKeydown(event) {
        if (event.key === 'Escape') {
            event.stopPropagation();
            closeModal();
        }
    }

    function nameOf(row) {
        return row.inputEl.value.trim();
    }

    async function runPreview() {
        if (state.busy) return;
        const plan = collectPlan();
        changedEl.textContent = String(plan.length);

        // 先在本地把能判定的错误标出来，别让它们白跑一次接口
        const sendable = [];
        state.rows.forEach((row) => {
            const value = nameOf(row);
            if (!value) { setStatus(row, 'error', rendererRename.EMPTY_MESSAGE); return; }
            if (value === row.oldName) { setStatus(row, 'idle', '未改动'); return; }
            const reason = rendererRename.validateName(value);
            if (reason) { setStatus(row, 'error', reason); return; }
            setStatus(row, 'stale', '检查中…');
        });
        plan.forEach((item) => {
            if (!rendererRename.validateName(item.new_name)) sendable.push(item);
        });
        if (sendable.length === 0) {
            const tally = countKinds();
            setSummary('可改 0 / 失败 ' + tally.error + ' / 未改动 ' + tally.idle);
            hintEl.textContent = tally.error > 0
                ? '先把上面标红的改好，再来预览'
                : '改几行「新文件名」再来预览';
            setExecuteEnabled(false);
            return;
        }

        state.busy = true;
        setPreviewBusy(true);
        try {
            const data = await previewBatchRename(sendable.map((item) => ({ file_uuid: item.file_uuid, new_name: item.new_name })));
            const results = Array.isArray(data?.results) ? data.results : [];
            const byId = new Map(results.map((item) => [String(item.file_uuid), item]));
            state.previewItems = [];
            state.rows.forEach((row) => {
                const uuid = String(row.sound.fileId || row.sound.id);
                const result = byId.get(uuid);
                const value = nameOf(row);
                if (!result) {
                    if (value && value !== row.oldName) {
                        const reason = rendererRename.validateName(value);
                        if (reason) setStatus(row, 'error', reason);
                    }
                    return;
                }
                if (result.ok) {
                    setStatus(row, 'ok', '可改');
                    state.previewItems.push({ file_uuid: result.file_uuid, new_name: result.new_name || value });
                } else {
                    setStatus(row, 'error', result.message || '不能改');
                }
            });
            const tally = countKinds();
            state.previewOk = tally.ok;
            setSummary('可改 ' + tally.ok + ' / 失败 ' + tally.error + ' / 未改动 ' + tally.idle);
            hintEl.textContent = tally.ok > 0
                ? '确认无误后点「执行」，会真的改动 ' + tally.ok + ' 个文件'
                : '没有可改的文件，先看看上面标红的原因';
            setExecuteEnabled(tally.ok > 0);
        } catch (error) {
            setSummary('预览失败：' + (error?.message || error));
            hintEl.textContent = '后端不可用时无法预览（不会动到文件）';
            setExecuteEnabled(false);
        } finally {
            state.busy = false;
            setPreviewBusy(false);
        }
    }

    async function runExecute() {
        if (state.busy || !state.previewItems.length) return;
        if (!state.armed) {
            // 两步确认：改名不可撤销，手滑一次不该动磁盘
            state.armed = true;
            executeBtn.textContent = '确认执行 ' + state.previewItems.length + ' 个？';
            executeBtn.style.background = '#dc2626';
            hintEl.textContent = '再点一次就真的改名，无法撤销';
            state.armTimer = setTimeout(() => { state.armTimer = null; disarm(); }, 5000);
            return;
        }
        disarm();
        state.busy = true;
        setPreviewBusy(true);
        executeBtn.textContent = '执行中…';
        try {
            const data = await executeBatchRename(state.previewItems);
            const results = Array.isArray(data?.results) ? data.results : [];
            const byId = new Map(results.map((item) => [String(item.file_uuid), item]));
            state.rows.forEach((row) => {
                const result = byId.get(String(row.sound.fileId || row.sound.id));
                if (!result) return;
                if (result.ok) {
                    setStatus(row, 'done', '已改名');
                    // 原名基准跟着一起更新，否则「全部还原」会把刚改好的名字又改回去
                    const nextName = rendererRename.basename(result.new_path) || result.new_name;
                    if (nextName) {
                        row.oldName = nextName;
                        row.oldEl.textContent = nextName;
                        row.oldEl.title = result.new_path || nextName;
                    }
                } else {
                    setStatus(row, 'error', result.message || '失败');
                }
            });
            rendererRename.applyResults(state.rows.map((row) => row.sound), results);
            const summary = rendererRename.summarize(results);
            if (typeof rendererAudio.clearPlaybackSourceCache === 'function') rendererAudio.clearPlaybackSourceCache();
            renderSoundList();
            renderCategoryTree();
            showNotification(
                '批量重命名完成：成功 ' + summary.ok + ' 个' + (summary.failed ? '，失败 ' + summary.failed + ' 个' : ''),
                summary.failed ? 'info' : 'success'
            );
            state.previewItems = [];
            state.previewOk = null;
            setExecuteEnabled(false);
            const leftover = countKinds();
            if (leftover.error === 0) {
                closeModal();
            } else {
                // 还有没改成的那几行，留在弹窗里让用户接着修
                setSummary('可改 0 / 失败 ' + leftover.error + ' / 未改动 ' + leftover.idle);
                hintEl.textContent = '已完成 ' + summary.ok + ' 个，还有 ' + leftover.error + ' 个没处理，改好可以再来一次';
            }
        } catch (error) {
            showNotification('执行失败：' + (error?.message || error), 'error');
        } finally {
            state.busy = false;
            setPreviewBusy(false);
            executeBtn.textContent = '执行';
        }
    }

    targets.forEach((sound) => {
        const oldName = sound.name || rendererRename.basename(sound.filePath) || '';

        const rowEl = document.createElement('div');
        rowEl.className = 'grid items-center gap-2 px-5 py-1 border-b';
        rowEl.style.borderColor = 'var(--border-color)';
        rowEl.style.gridTemplateColumns = '1fr 16px 1fr 92px';

        const oldEl = document.createElement('div');
        oldEl.className = 'text-xs truncate';
        oldEl.style.color = 'var(--text-secondary)';
        oldEl.textContent = oldName;
        oldEl.title = sound.filePath || oldName;

        const arrowEl = document.createElement('div');
        arrowEl.className = 'text-xs text-center opacity-30';
        arrowEl.textContent = '→';

        const inputEl = document.createElement('input');
        inputEl.type = 'text';
        inputEl.className = 'h-7 px-2 rounded border text-xs w-full focus:outline-none';
        inputEl.style.backgroundColor = 'var(--bg-tertiary)';
        inputEl.style.borderColor = 'var(--border-color)';
        inputEl.style.color = 'var(--text-primary)';
        inputEl.value = oldName;
        inputEl.spellcheck = false;

        const statusEl = document.createElement('div');
        statusEl.className = 'text-[11px] truncate';

        rowEl.appendChild(oldEl);
        rowEl.appendChild(arrowEl);
        rowEl.appendChild(inputEl);
        rowEl.appendChild(statusEl);
        rowsEl.appendChild(rowEl);

        const row = { sound: sound, inputEl: inputEl, statusEl: statusEl, oldEl: oldEl, oldName: oldName, kind: 'idle' };
        state.rows.push(row);
        setStatus(row, 'idle', '未改动');

        inputEl.addEventListener('input', () => {
            const reason = rendererRename.validateName(inputEl.value);
            if (reason) setStatus(row, 'error', reason);
            else if (inputEl.value.trim() === row.oldName) setStatus(row, 'idle', '未改动');
            else setStatus(row, 'stale', '待预览');
            onDirty();
        });
        inputEl.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                runPreview();
            }
        });
    });

    panel.querySelector('[data-role="close"]').addEventListener('click', closeModal);
    panel.querySelector('[data-role="cancel"]').addEventListener('click', closeModal);
    panel.querySelector('[data-role="reset"]').addEventListener('click', () => {
        state.rows.forEach((row) => {
            row.inputEl.value = row.oldName;
            setStatus(row, 'idle', '未改动');
        });
        onDirty();
    });
    panel.querySelector('[data-role="apply-rules"]').addEventListener('click', applyRulesToAll);
    panel.querySelector('[data-role="rules"]').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            applyRulesToAll();
        }
    });
    previewBtn.addEventListener('click', runPreview);
    executeBtn.addEventListener('click', runExecute);
    overlay.addEventListener('mousedown', (event) => {
        if (event.target === overlay) closeModal();
    });
    document.addEventListener('keydown', onKeydown);

    setExecuteEnabled(false);
    lucide.createIcons();
}
