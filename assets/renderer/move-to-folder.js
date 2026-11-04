/* move-to-folder.js —— 把选中的音频在磁盘上移动到音效库里的另一个目录
 * 场景：待人工判断的音效，听完直接归到对应分类文件夹。
 * 后端 /api/v1/db/files/move 会真移动文件并同步库内路径，file_uuid 不变，索引不丢。
 */

async function showMoveToFolderDialog(sounds) {
    const list = (sounds || []).filter(s => s && s.filePath);
    if (!list.length) {
        showNotification('先选中要移动的音效', 'info');
        return;
    }
    document.getElementById('moveFolderOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'moveFolderOverlay';
    overlay.className = 'fixed inset-0 flex items-center justify-center';
    overlay.style.cssText = 'z-index:335;background:rgba(0,0,0,0.6)';
    overlay.innerHTML = `
        <div class="rounded-xl shadow-2xl w-[620px] max-h-[80vh] flex flex-col"
             style="background:var(--bg-secondary);border:1px solid var(--border-color)">
            <div class="flex items-center gap-2 px-4 py-3 border-b" style="border-color:var(--border-color)">
                <span class="text-sm font-semibold">移动到文件夹</span>
                <span id="moveFolderCount" class="text-[11px] opacity-50"></span>
                <button id="moveFolderClose" class="ml-auto text-xs opacity-50 hover:opacity-100">关闭</button>
            </div>
            <div class="px-4 py-2 text-[11px] opacity-50 border-b" style="border-color:var(--border-color)">
                从磁盘上移动，库内路径同步更新；标签、描述、索引都不受影响。
            </div>
            <div class="px-4 py-2">
                <input id="moveFolderSearch" class="w-full px-2 py-1.5 rounded text-xs"
                    placeholder="输入目录名过滤…"
                    style="background:var(--bg-tertiary);border:1px solid var(--border-color);color:var(--text-primary)">
            </div>
            <div id="moveFolderList" class="flex-1 overflow-y-auto px-2 pb-2 min-h-0 text-xs"></div>
            <div class="flex items-center gap-2 px-4 py-3 border-t" style="border-color:var(--border-color)">
                <span id="moveFolderSelected" class="text-[11px] opacity-50 flex-1 truncate">未选择目标目录</span>
                <button id="moveFolderCancel" class="px-3 py-1.5 rounded text-sm border"
                    style="border-color:var(--border-color)">取消</button>
                <button id="moveFolderOk" class="px-4 py-1.5 rounded text-sm text-white"
                    style="background:#3b5bdb" disabled>移动</button>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    if (window.lucide?.createIcons) window.lucide.createIcons();

    const $ = (id) => overlay.querySelector('#' + id);
    $('moveFolderCount').textContent = '共 ' + list.length + ' 个文件';
    let pickedDir = '';
    let allDirs = [];

    const renderList = (keyword) => {
        const host = $('moveFolderList');
        const kw = String(keyword || '').trim().toLowerCase();
        const items = kw ? allDirs.filter(d => d.toLowerCase().includes(kw)) : allDirs;
        host.innerHTML = '';
        if (!items.length) {
            host.innerHTML = '<div class="p-3 opacity-50">没有匹配的目录</div>';
            return;
        }
        items.forEach((dir) => {
            const row = document.createElement('div');
            row.className = 'px-2 py-1.5 rounded cursor-pointer truncate hover:bg-white/5';
            row.textContent = dir;
            row.title = dir;
            if (dir === pickedDir) {
                row.style.background = 'rgba(107,138,253,0.25)';
            }
            row.addEventListener('click', () => {
                pickedDir = dir;
                $('moveFolderSelected').textContent = '目标：' + dir;
                $('moveFolderOk').disabled = false;
                renderList($('moveFolderSearch').value);
            });
            host.appendChild(row);
        });
    };

    try {
        const stats = await rendererApi.get('/api/v1/db/folder-stats');
        const folders = Array.isArray(stats?.folders) ? stats.folders : [];
        allDirs = folders.map(f => String(f.path || '')).filter(Boolean).sort();
        if (!allDirs.length) {
            $('moveFolderList').innerHTML = '<div class="p-3 opacity-50">库里还没有可用的目录（先重新读取目录）</div>';
            return;
        }
        renderList('');
    } catch (error) {
        $('moveFolderList').innerHTML = '<div class="p-3 text-red-400">读取目录失败：' + (error.message || error) + '</div>';
        return;
    }

    $('moveFolderSearch').addEventListener('input', (e) => renderList(e.target.value));
    $('moveFolderClose').addEventListener('click', () => overlay.remove());
    $('moveFolderCancel').addEventListener('click', () => overlay.remove());

    $('moveFolderOk').addEventListener('click', async () => {
        if (!pickedDir) return;
        const btn = $('moveFolderOk');
        btn.disabled = true;
        btn.textContent = '移动中…';
        try {
            const res = await rendererApi.post('/api/v1/db/files/move', {
                file_uuids: list.map(s => s.id).filter(Boolean),
                target_dir: pickedDir,
                overwrite: false,
            }, { timeoutMs: 300000 });
            const movedCount = Number(res?.moved_count || 0);
            const failed = Array.isArray(res?.failed) ? res.failed : [];
            if (movedCount) {
                showNotification('已移动 ' + movedCount + ' 个文件到 ' + pickedDir.split(/[\\/]/).pop(), 'success');
            }
            if (failed.length) {
                const first = failed[0];
                showNotification(
                    failed.length + ' 个没移动：' + (first.error || '未知原因')
                    + (failed.length > 1 ? '（还有 ' + (failed.length - 1) + ' 个）' : ''),
                    'error',
                );
            }
            overlay.remove();
            if (movedCount) {
                if (typeof loadFilesFromDatabase === 'function') {
                    await loadFilesFromDatabase({ reset: true });
                }
                if (typeof loadFolderStats === 'function') {
                    await loadFolderStats(true);
                }
            }
        } catch (error) {
            showNotification('移动失败: ' + (error.message || error), 'error');
            btn.disabled = false;
            btn.textContent = '移动';
        }
    });
}
