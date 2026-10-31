/* folder-menu.js —— 文件夹右键管理
 * 从 index.html 原样搬出的完整顶层函数。
 */
function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(2) + ' GB';
    if (value >= 1024 ** 2) return (value / 1024 ** 2).toFixed(1) + ' MB';
    if (value >= 1024) return (value / 1024).toFixed(0) + ' KB';
    return value + ' B';
}

function showFolderContextMenu(event, folder, kind) {
    document.getElementById('folderContextMenu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'folderContextMenu';
    menu.className = 'fixed z-[200] rounded-lg shadow-xl py-1 w-56';
    menu.style.backgroundColor = 'var(--bg-secondary)';
    menu.style.border = '1px solid var(--border-color)';
    menu.style.left = Math.min(event.clientX, window.innerWidth - 240) + 'px';
    menu.style.top = Math.min(event.clientY, window.innerHeight - 180) + 'px';

    const title = document.createElement('div');
    title.className = 'px-3 py-2 text-xs opacity-60 border-b truncate';
    title.style.borderColor = 'var(--border-color)';
    title.textContent = folder.name || folder.fullPath || '文件夹';
    menu.appendChild(title);

    if (kind === 'user') {
        const remove = document.createElement('button');
        remove.className = 'w-full px-3 py-2 text-sm text-left hover:bg-white/5 text-red-400';
        remove.textContent = '删除分类（不删文件）';
        remove.addEventListener('click', async () => {
            menu.remove();
            if (!confirm(`删除分类「${folder.name}」？\n\n只解除归类，音效文件与描述都不会被删除。`)) return;
            try {
                await rendererApi.delete(
                    `/api/v1/projects/${encodeURIComponent(currentProject.id)}/folders/${encodeURIComponent(folder.id)}`
                );
                showNotification('分类已删除', 'success');
                await loadUserFolders();
                renderFolderTree();
            } catch (error) {
                showNotification('删除分类失败: ' + error.message, 'error');
            }
        });
        menu.appendChild(remove);
    } else {
        const hasFiles = Number(folder.count || 0) > 0;
        const remove = document.createElement('button');
        remove.className = 'w-full px-3 py-2 text-sm text-left hover:bg-white/5'
            + (hasFiles ? ' text-red-400' : ' opacity-40 cursor-not-allowed');
        remove.textContent = hasFiles ? '删除文件夹…' : '删除文件夹（该目录没有音效）';
        remove.disabled = !hasFiles;
        if (hasFiles) {
            remove.addEventListener('click', () => {
                menu.remove();
                openFolderDeleteModal(folder);
            });
        }
        menu.appendChild(remove);
    }

    document.body.appendChild(menu);
    const close = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', close);
        }
    };
    setTimeout(() => document.addEventListener('click', close), 100);
}

async function openFolderBatchDeleteModal(folders) {
    const selected = (folders || []).filter(Boolean);
    if (!selected.length) return;

    // 先问后端每个目录还剩多少条记录：已经删空的目录不该再出现在"要删除"的清单里
    const projectId = encodeURIComponent(currentProject?.id || 'default');
    const checked = await Promise.all(selected.map(async (item) => {
        const path = item.fullPath || item.path;
        let files = null;
        try {
            const stats = await rendererApi.get(
                '/api/v1/db/folder/stats?path=' + encodeURIComponent(path) + '&project_id=' + projectId
            );
            if (stats && stats.success) files = Number(stats.files || 0);
        } catch (_) { /* 查不到就当未知，仍列出来 */ }
        return { ...item, path, files };
    }));
    const list = checked.filter(item => item.files !== 0);
    const skipped = checked.filter(item => item.files === 0);
    if (!list.length) {
        showNotification('这些目录已经没有库内记录了，不需要再删', 'info');
        return;
    }

    document.getElementById('folderBatchDeleteModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'folderBatchDeleteModal';
    modal.className = 'fixed inset-0 z-[300] flex items-center justify-center';
    modal.style.background = 'rgba(0,0,0,0.55)';
    const preview = list.slice(0, 8).map((item, index) =>
        '<div class="text-xs opacity-70 truncate">' + (index + 1) + '. ' + escapeHtml(item.name || item.fullPath || item.path)
        + (item.files === null ? '' : '　<span class="opacity-50">' + item.files + ' 个文件</span>') + '</div>'
    ).join('');
    const more = list.length > 8 ? '<div class="text-xs opacity-50 mt-1">…等 ' + list.length + ' 个</div>' : '';
    const skippedNote = skipped.length
        ? '<div class="text-xs mt-2" style="color:#f59e0b;">已自动排除 ' + skipped.length + ' 个没有库内记录的目录</div>'
        : '';

    modal.innerHTML = `
        <div class="rounded-lg shadow-xl w-[460px] max-h-[80vh] overflow-auto p-5"
             style="background: var(--bg-secondary); border: 1px solid var(--border-color);">
            <h3 class="text-base font-semibold mb-2">删除 ${list.length} 个文件夹</h3>
            <p class="text-xs opacity-60 mb-3">这些文件夹在音效库里的记录会被删除，磁盘上的源文件按下面的选择处理。</p>
            <div class="rounded-md p-2 mb-2" style="background: var(--bg-tertiary); max-height: 160px; overflow: auto;">
                ${preview}${more}
            </div>
            ${skippedNote}
            <div class="mb-3"></div>
            <label class="flex items-start gap-2 p-2 mb-2 rounded-md cursor-pointer" style="border:1px solid var(--border-color);">
                <input type="radio" name="folderBatchMode" value="records" class="mt-0.5" checked>
                <span class="text-xs">
                    <span class="block text-sm mb-0.5">只从库中移除记录</span>
                    <span class="opacity-60">磁盘文件一律不动，以后还能重新导入。</span>
                </span>
            </label>
            <label class="flex items-start gap-2 p-2 rounded-md cursor-pointer" style="border:1px solid var(--border-color);">
                <input type="radio" name="folderBatchMode" value="source" class="mt-0.5">
                <span class="text-xs">
                    <span class="block text-sm mb-0.5 text-red-400">连源文件一起删除</span>
                    <span class="opacity-60">源文件移入回收站（可从回收站恢复）。</span>
                </span>
            </label>
            <label id="folderBatchRisk" class="hidden items-start gap-2 mt-3 p-2 rounded-md text-xs cursor-pointer"
                   style="background: rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.35);">
                <input type="checkbox" id="folderBatchRiskCheck" class="mt-0.5">
                <span>我明白源文件会被移入回收站。</span>
            </label>
            <div class="flex justify-end gap-2 mt-5">
                <button id="folderBatchCancel" class="px-4 py-2 rounded-md text-sm" style="background: var(--bg-tertiary); color: var(--text-primary);">取消</button>
                <button id="folderBatchOk" class="px-4 py-2 rounded-md text-sm text-white" style="background: #ef4444;">确认删除</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const riskRow = modal.querySelector('#folderBatchRisk');
    const riskCheck = modal.querySelector('#folderBatchRiskCheck');
    modal.querySelectorAll('input[name="folderBatchMode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            const isSource = modal.querySelector('input[name="folderBatchMode"]:checked').value === 'source';
            riskRow.classList.toggle('hidden', !isSource);
            riskRow.classList.toggle('flex', isSource);
            if (!isSource) riskCheck.checked = false;
        });
    });
    modal.querySelector('#folderBatchCancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    modal.querySelector('#folderBatchOk').addEventListener('click', async () => {
        const mode = modal.querySelector('input[name="folderBatchMode"]:checked').value;
        const deleteSource = mode === 'source';
        if (deleteSource && !riskCheck.checked) {
            showNotification('请先勾选「我明白源文件会被移入回收站」', 'error');
            return;
        }
        // 先在界面上把事办完：关窗、摘节点、给提示，全部同步完成（毫秒级）
        const targets = list.map(item => item.fullPath || item.path).filter(Boolean);
        modal.remove();
        folderMultiSelection.clear();
        applyFolderMultiSelection();
        pruneImportedFolders(targets);          // 只重绘一次树，而不是每个目录重绘一次
        showNotification('正在删除 ' + list.length + ' 个文件夹…', 'info');

        // 再去后台删；界面不等它
        let removed = 0;
        let failed = 0;
        const outcomes = [];
        for (const path of targets) {
            try {
                const result = await rendererApi.post(
                    '/api/v1/db/folder/delete?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
                    { path, delete_source: deleteSource }
                );
                const count = Number(result?.removed || 0);
                removed += count;
                outcomes.push({ path, removed: count, error: '' });
            } catch (error) {
                failed += 1;
                outcomes.push({ path, removed: 0, error: error?.message || String(error) });
                console.warn('[Folder] 批量删除失败:', path, error);
            }
        }
        console.info('[Folder] 批量删除结果:', outcomes);
        const empty = outcomes.filter(o => o.removed === 0 && !o.error).length;
        showNotification(
            '已删除 ' + (list.length - failed) + ' 个文件夹，共 ' + removed + ' 条记录'
            + (deleteSource ? '（源文件已移入回收站）' : '')
            + (empty ? '；' + empty + ' 个目录本来就没有库内记录（可能已删过）' : '')
            + (failed ? '，' + failed + ' 个失败' : ''),
            failed ? 'warning' : 'success'
        );

        // 最后统一对一次账：不 await，界面早就更新完了
        Promise.resolve()
            .then(() => loadUserFolders())
            .then(() => loadFolderStats(true))
            .then(() => loadTagStats())
            .catch((error) => console.warn('[Folder] 删除后刷新失败:', error));
        loadFilesFromDatabase({ reset: true }).catch((error) => console.warn('[Folder] 删除后重载列表失败:', error));
    });
}

async function openFolderDeleteModal(folder) {
    const path = folder.fullPath || folder.path;
    if (!path) return;
    let stats = { files: 0, with_description: 0, with_tags: 0, size_bytes: 0 };
    try {
        const data = await rendererApi.get(
            '/api/v1/db/folder/stats?path=' + encodeURIComponent(path)
            + '&project_id=' + encodeURIComponent(currentProject?.id || 'default')
        );
        if (data && data.success) stats = data;
    } catch (error) {
        console.warn('[Folder] 统计失败:', error);
    }

    document.getElementById('folderDeleteModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'folderDeleteModal';
    modal.className = 'fixed inset-0 z-[300] flex items-center justify-center';
    modal.style.background = 'rgba(0,0,0,0.55)';
    modal.innerHTML = `
        <div class="w-[520px] rounded-xl p-5" style="background: var(--bg-secondary); border: 1px solid var(--border-color);">
            <div class="text-base font-medium mb-1">删除文件夹「${escapeHtml(folder.name || path)}」</div>
            <div class="text-xs opacity-60 mb-3 break-all">${escapeHtml(path)}</div>

            <div class="rounded-lg p-3 mb-4 text-xs" style="background: var(--bg-tertiary);">
                <div class="flex justify-between mb-1"><span>库内文件</span><span>${stats.files} 条</span></div>
                <div class="flex justify-between mb-1"><span>一句话描述</span><span>${stats.with_description} 条</span></div>
                <div class="flex justify-between mb-1"><span>标签</span><span>${stats.with_tags} 条</span></div>
                <div class="flex justify-between"><span>源文件占用</span><span>${formatBytes(stats.size_bytes)}</span></div>
            </div>

            <div class="text-xs font-medium mb-2">请选择删除方式</div>
            <label class="flex items-start gap-2 p-2 rounded-md cursor-pointer mb-2" style="border:1px solid var(--border-color);">
                <input type="radio" name="folderDeleteMode" value="records" checked class="mt-0.5">
                <span class="text-xs">
                    <span class="block text-sm mb-0.5">仅从软件中移除（保留源文件）</span>
                    <span class="opacity-60">删除库内记录、描述、标签和索引；磁盘上的音效文件原样保留，之后还能重新导入。</span>
                </span>
            </label>
            <label class="flex items-start gap-2 p-2 rounded-md cursor-pointer" style="border:1px solid var(--border-color);">
                <input type="radio" name="folderDeleteMode" value="source" class="mt-0.5">
                <span class="text-xs">
                    <span class="block text-sm mb-0.5 text-red-400">删除源文件并从软件移除</span>
                    <span class="opacity-60">库内记录、描述、标签、索引 <b>以及磁盘上的 ${stats.files} 个源文件</b>都会被删除（移入回收站，可从回收站恢复）。</span>
                </span>
            </label>

            <label id="folderDeleteRisk" class="hidden items-start gap-2 mt-3 p-2 rounded-md text-xs cursor-pointer" style="background: rgba(239,68,68,0.12); border:1px solid rgba(239,68,68,0.35);">
                <input type="checkbox" id="folderDeleteRiskCheck" class="mt-0.5">
                <span>我明白源文件会被移入回收站并清空回收站后无法恢复。</span>
            </label>

            <div class="flex justify-end gap-2 mt-5">
                <button id="folderDeleteCancel" class="px-4 py-2 rounded-md text-sm" style="background: var(--bg-tertiary); color: var(--text-primary);">取消</button>
                <button id="folderDeleteOk" class="px-4 py-2 rounded-md text-sm text-white" style="background: #ef4444;">确认删除</button>
            </div>
        </div>`;
    document.body.appendChild(modal);

    const riskRow = modal.querySelector('#folderDeleteRisk');
    const riskCheck = modal.querySelector('#folderDeleteRiskCheck');
    modal.querySelectorAll('input[name="folderDeleteMode"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            const isSource = modal.querySelector('input[name="folderDeleteMode"]:checked').value === 'source';
            riskRow.classList.toggle('hidden', !isSource);
            riskRow.classList.toggle('flex', isSource);
            if (!isSource) riskCheck.checked = false;
        });
    });
    modal.querySelector('#folderDeleteCancel').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    modal.querySelector('#folderDeleteOk').addEventListener('click', async () => {
        const mode = modal.querySelector('input[name="folderDeleteMode"]:checked').value;
        if (mode === 'source' && !riskCheck.checked) {
            showNotification('请先勾选「我明白源文件会被永久删除」', 'error');
            return;
        }
        modal.remove();
        await deleteFolderRecords(folder, mode === 'source');
    });
}

async function deleteFolderRecords(folder, deleteSource) {
    const path = folder.fullPath || folder.path;
    if (!path) return;

    // 前端先"预演"：节点立刻从树上消失，不让用户等后端把上千条记录删完
    const snapshot = importedFolderData;
    pruneImportedFolders([path]);
    showNotification('正在删除…', 'info');

    try {
        const result = await rendererApi.post(
            '/api/v1/db/folder/delete?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
            { path, delete_source: deleteSource }
        );
        console.info('[Folder] 删除目录:', path, 'removed=', result.removed);
        showNotification(
            deleteSource
                ? `已删除 ${result.removed} 条记录及磁盘文件`
                : `已从库中移除 ${result.removed} 条记录（源文件保留）`,
            'success'
        );
        // 后台对账，不阻塞界面
        Promise.resolve()
            .then(() => loadUserFolders())
            .then(() => loadFolderStats(true))
            .then(() => loadTagStats())
            .catch((refreshError) => console.warn('[Folder] 删除后刷新目录失败:', refreshError));
        loadFilesFromDatabase({ reset: true }).catch((refreshError) => console.warn('[Folder] 删除后刷新列表失败:', refreshError));
    } catch (error) {
        // 删除失败就把树还原，别让用户以为删掉了
        importedFolderData = snapshot;
        renderFolderTree();
        showNotification('删除失败: ' + error.message, 'error');
    }
}

