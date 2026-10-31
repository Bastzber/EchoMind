/* duplicates2.js —— 重复音效检测
 * 从 index.html 原样搬出的完整顶层函数。
 */
async function pickBackupFolder() {
    if (!window.electronAPI?.fileImport?.selectFolder) {
        showNotification('当前环境无法选择文件夹', 'error');
        return null;
    }
    const result = await window.electronAPI.fileImport.selectFolder({ title: '选择备份文件夹' });
    if (!result || !result.success || !result.folder) return null;
    return result.folder;
}

async function showIgnoredDuplicates() {
    document.getElementById('ignoredDupModal')?.remove();
    const modal = document.createElement('div');
    modal.id = 'ignoredDupModal';
    modal.className = 'fixed inset-0 z-[320] flex items-center justify-center';
    modal.style.background = 'rgba(0,0,0,0.55)';
    modal.innerHTML = `<div class="rounded-lg shadow-xl w-[520px] max-h-[70vh] flex flex-col" style="background: var(--bg-secondary); border: 1px solid var(--border-color);">
        <div class="flex items-center justify-between px-4 py-3 border-b" style="border-color: var(--border-color);">
            <div class="text-sm font-medium">已忽略的重复组</div>
            <button id="ignoredClose" class="p-1 rounded hover:bg-white/10">✕</button>
        </div>
        <div id="ignoredBody" class="p-3 overflow-y-auto text-xs opacity-80">加载中…</div>
    </div>`;
    document.body.appendChild(modal);
    modal.querySelector('#ignoredClose').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    const body = modal.querySelector('#ignoredBody');
    try {
        const data = await rendererApi.get(
            '/api/v1/duplicates/ignored?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
            { timeoutMs: 30000 }
        );
        const groups = (data && data.groups) || [];
        if (!groups.length) {
            body.textContent = '还没有忽略任何组。遇到"同一个音效要归到多个分类"的情况，在那一组点「这一组要保留在多个分类（忽略）」即可。';
            return;
        }
        body.innerHTML = '';
        groups.forEach((group) => {
            const row = document.createElement('div');
            row.className = 'flex items-center gap-2 py-1.5 border-b';
            row.style.borderColor = 'var(--border-color)';
            const label = document.createElement('span');
            label.className = 'flex-1 truncate font-mono opacity-60';
            label.textContent = String(group.sha256).slice(0, 16) + '…';
            const when = document.createElement('span');
            when.className = 'opacity-40';
            when.textContent = String(group.created_at || '').slice(0, 10);
            const restore = document.createElement('button');
            restore.className = 'px-2 py-0.5 rounded border text-xs';
            restore.style.borderColor = 'var(--border-color)';
            restore.textContent = '恢复提示';
            restore.addEventListener('click', async () => {
                try {
                    await rendererApi.delete(
                        '/api/v1/duplicates/ignore/' + encodeURIComponent(group.sha256)
                        + '?project_id=' + encodeURIComponent(currentProject?.id || 'default')
                    );
                    row.remove();
                    showNotification('已恢复，重新检测即可看到', 'success');
                } catch (error) {
                    showNotification('恢复失败: ' + (error?.message || error), 'error');
                }
            });
            row.append(label, when, restore);
            body.appendChild(row);
        });
    } catch (error) {
        body.textContent = '读取失败: ' + (error?.message || error);
    }
}

async function rescanLibraryInto(setBusy) {
    setBusy(true);
    try {
        const projectId = encodeURIComponent(currentProject?.id || 'default');
        showNotification('正在扫描库目录…', 'info');
        const preview = await rendererApi.post(
            '/api/v1/db/library/rescan?project_id=' + projectId,
            { dry_run: true },
            { timeoutMs: 900000 }
        );
        const missing = preview?.missing || 0;
        const roots = (preview?.roots || []).join('、');
        if (!missing) {
            showNotification(`扫描了 ${preview?.scanned || 0} 个音频，全部已在库中`, 'success');
            setBusy(false);
            return;
        }
        const samples = (preview?.missing_sample || []).slice(0, 3).join('\n');
        if (!confirm(`扫描了 ${preview.scanned} 个音频，其中 ${missing} 个磁盘上有、库里没有。\n\n库目录：${roots}\n示例：\n${samples}\n\n要把这 ${missing} 个补录进库吗？（补录后会自动计算哈希）`)) {
            setBusy(false);
            return;
        }
        // 这个接口会一直等后台任务跑完才返回（实测 10 秒起），
        // 所以不要 await，立刻开始轮询进度。
        const progressBox = document.getElementById('dupProgress');
        const bar = progressBox?.querySelector('.dup-progress-bar');
        const text = progressBox?.querySelector('.dup-progress-text');
        const pctEl = progressBox?.querySelector('.dup-progress-pct');
        if (progressBox) {
            progressBox.classList.remove('hidden');
            if (bar) bar.style.width = '100%';
            if (text) text.textContent = '正在补录磁盘上的文件…';
            if (pctEl) pctEl.textContent = '';
        }
        showNotification('已开始补录 ' + missing + ' 个文件…', 'info');
        rendererApi.post('/api/v1/db/library/rescan?project_id=' + projectId, {}, { timeoutMs: 1800000 }).catch(() => { });

        const startedAt = Date.now();
        const poll = async () => {
            const status = await rendererApi.get('/api/v1/db/library/rescan', { timeoutMs: 30000 }).catch(() => null);
            if (!status) { setBusy(false); return; }
            if (status.running) {
                if (text) text.textContent = `正在补录… 已扫描 ${status.scanned}，已新增 ${status.added}`;
                if (Date.now() - startedAt > 1800000) { setBusy(false); return; }
                setTimeout(poll, 1500);
                return;
            }
            showNotification(`补录完成：扫描 ${status.scanned} 个，新增 ${status.added} 个`, 'success');
            if (text) text.textContent = `补录完成：新增 ${status.added} 个`;
            setBusy(false);
            document.getElementById('dupModal')?.remove();
            loadFilesFromDatabase({ reset: true }).catch(() => { });
            loadFolderStats(true).catch(() => { });
            setTimeout(() => showDuplicatesModal(), 900);
        };
        setTimeout(poll, 1200);
    } catch (error) {
        showNotification('扫描失败: ' + (error?.message || error), 'error');
        setBusy(false);
    }
}

async function restoreBackup(manifest) {
    try {
        const result = await rendererApi.post(
            '/api/v1/db/duplicates/restore?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
            { manifest: manifest || '' },
            { timeoutMs: 300000 }
        );
        showNotification(
            '已还原 ' + (result.restored || 0) + ' 个文件'
            + (result.skipped ? '，' + result.skipped + ' 个跳过（原位置已有）' : '')
            + (result.failed ? '，' + result.failed + ' 个失败' : ''),
            result.failed ? 'warning' : 'success'
        );
    } catch (error) {
        showNotification('撤回失败: ' + (error?.message || error), 'error');
    }
}

async function resolveDuplicates(paths, action, targetDir) {
    if (!paths || !paths.length) return null;
    if (window.__dupBusy) return null;
    window.__dupBusy = true;
    const total = paths.length;
    const actionLabel = action === 'records' ? '删除记录' : (action === 'source' ? '移入回收站' : '复制到备份');
    // 备份走一次请求（要在同一份清单里）；其它动作分块，边删边报进度
    const chunkSize = action === 'backup' ? total : 100;

    const progressBox = document.getElementById('dupProgress');
    const bar = progressBox?.querySelector('.dup-progress-bar');
    const text = progressBox?.querySelector('.dup-progress-text');
    const pctEl = progressBox?.querySelector('.dup-progress-pct');
    const showProgress = (done) => {
        if (!progressBox) return;
        progressBox.classList.remove('hidden');
        const pct = total ? Math.round((done / total) * 100) : 0;
        if (bar) bar.style.width = pct + '%';
        if (text) text.textContent = `正在${actionLabel}… ${done} / ${total}`;
        if (pctEl) pctEl.textContent = pct + '%';
    };
    showProgress(0);

    const aggregate = { success: true, action, requested: total, moved: 0, removed: 0, failed: 0, manifest: '', errors: [] };
    try {
        for (let start = 0; start < total; start += chunkSize) {
            const slice = paths.slice(start, start + chunkSize);
            const result = await rendererApi.post(
                '/api/v1/db/duplicates/resolve?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
                { paths: slice, action, target_dir: targetDir || '' },
                { timeoutMs: 300000 }
            );
            aggregate.moved += Number(result?.moved || 0);
            aggregate.removed += Number(result?.removed || 0);
            aggregate.failed += Number(result?.failed || 0);
            if (result?.manifest) aggregate.manifest = result.manifest;
            if (Array.isArray(result?.errors)) aggregate.errors.push(...result.errors);
            showProgress(Math.min(total, start + slice.length));
        }
        showProgress(total);
        const result = aggregate;
        showNotification(
            `已${actionLabel} ${action === 'backup' ? result.moved : result.removed} 个` + (result.failed ? `，${result.failed} 个失败` : ''),
            result.failed ? 'warning' : 'success'
        );
        loadFilesFromDatabase({ reset: true }).catch(() => { });
        Promise.resolve()
            .then(() => loadFolderStats(true))
            .then(() => loadTagStats())
            .catch(() => { });
        return result;
    } catch (error) {
        showNotification('处理失败: ' + (error?.message || error), 'error');
        return false;
    } finally {
        window.__dupBusy = false;
        setTimeout(() => progressBox?.classList.add('hidden'), 1200);
    }
}

async function loadUserFolderFiles(folderId, baseList) {
    try {
        const data = await rendererApi.get(
            `/api/v1/projects/${encodeURIComponent(currentProject?.id || 'default')}`
            + `/folders/${encodeURIComponent(folderId)}/files`
        );
        const files = (data && data.files) || [];
        if (!files.length) return;
        const mapped = files.map(mapDbFileToSound);
        const seen = new Set((baseList || []).map(s => s.filePath));
        const extra = mapped.filter(s => !seen.has(s.filePath));
        if (!extra.length) return;
        allSearchResults = (baseList || []).concat(extra);
        renderSoundList('', allSearchResults);
    } catch (error) {
        console.warn('[Folder] 读取文件夹成员失败:', error);
    }
}

async function loadFolderStats(force = false) {
    if (!force && importedFolderData.length > 0
        && (Date.now() - folderTreeBuiltAt) < 60000) {
        return;
    }
    try {
        const projectId = currentProject?.id || 'default';
        const data = await withDbRetry(
            () => rendererApi.get('/api/v1/db/folder-stats?project_id=' + encodeURIComponent(projectId)),
            { label: '目录统计', attempts: 3 }
        );
        if (!data || !data.success || !Array.isArray(data.folders)) {
            return;
        }
        // 以前这里遇到空列表就直接 return，树里会一直留着已经删掉的目录
        buildFolderTreeFromStats(data.folders);
    } catch (error) {
        console.warn('[Folder] 加载目录统计失败:', error);
    }
}

function pruneImportedFolders(paths) {
    const targets = (paths || []).filter(Boolean).map(p => String(p).replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase());
    if (!targets.length) return;
    const hit = (nodePath) => {
        const value = String(nodePath || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
        return targets.some(t => value === t || value.startsWith(t + '\\'));
    };
    const walk = (nodes) => nodes
        .filter(node => !hit(node.fullPath || node.path))
        .map(node => ({ ...node, children: node.children ? walk(node.children) : [] }));
    importedFolderData = walk(importedFolderData || []);
    targets.forEach(t => folderMultiSelection.delete(t));
    applyFolderMultiSelection();
    renderFolderTree();
}

function buildFolderTreeFromStats(folders) {
    const entries = folders
        .map(item => ({
            parts: String(item.path || '').replace(/\//g, '\\').split('\\').filter(Boolean),
            count: Number(item.count) || 0,
        }))
        .filter(entry => entry.parts.length);
    if (!entries.length) {
        importedFolderData = [];
        folderTreeBuiltAt = Date.now();
        renderFolderTree();
        return;
    }

    // 按「盘符 + 顶层目录」分组，每组各自建一棵树。
    // 以前只给文件最多的那个根建层级，其他根（比如另一个盘里的资源包）被压成根级平铺，
    // 结果一堆同名目录（单次/短尾/连续）看起来一模一样 —— 删掉一个别的还在，
    // 就像"删了没生效"。
    const groupKey = (parts) => ((parts[0] || '') + '\\' + (parts[1] || '')).toLowerCase();
    const groups = new Map();
    entries.forEach(entry => {
        const key = groupKey(entry.parts);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
    });

    const roots = [];
    groups.forEach((list) => {
        // 该组公共前缀作为根（短于两段就退回前两段，避免出现盘符节点）
        let common = list[0].parts.slice();
        list.forEach(entry => {
            let i = 0;
            while (i < common.length && i < entry.parts.length
                   && common[i].toLowerCase() === entry.parts[i].toLowerCase()) {
                i += 1;
            }
            common = common.slice(0, i);
        });
        const rootParts = common.length >= 2
            ? common
            : list[0].parts.slice(0, Math.max(2, common.length));
        const rootPath = rootParts.join('\\');

        const byPath = new Map();
        let root = byPath.get(rootPath.toLowerCase());
        if (!root) {
            root = {
                name: rootParts[rootParts.length - 1] || rootPath,
                path: rootPath,
                fullPath: rootPath,
                children: [],
                count: 0,
            };
            byPath.set(rootPath.toLowerCase(), root);
            roots.push(root);
        }

        list.forEach(entry => {
            let acc = rootPath;
            let siblings = root.children;
            root.count += entry.count;      // 子目录文件数也累加到父级
            entry.parts.slice(rootParts.length).forEach(part => {
                acc = acc ? acc + '\\' + part : part;
                const key = acc.toLowerCase();
                let node = byPath.get(key);
                if (!node) {
                    node = { name: part, path: acc, fullPath: acc, children: [], count: 0 };
                    byPath.set(key, node);
                    siblings.push(node);
                }
                node.count += entry.count;
                siblings = node.children;
            });
        });
    });

    const sortTree = (list) => {
        list.sort((a, b) => a.name.localeCompare(b.name, 'zh', { numeric: true }));
        list.forEach((node) => sortTree(node.children));
    };
    sortTree(roots);
    importedFolderData = roots;
    folderTreeBuiltCount = soundData.length;
    folderTreeBuiltAt = Date.now();
    renderFolderTree();
    console.log('[Folder] 从后端统计重建目录树:', roots.length, '个根');
}

function normalizeTags(raw) {
    if (Array.isArray(raw)) return raw.filter((t) => typeof t === 'string' && t.trim());
    if (typeof raw === 'string' && raw.trim()) {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return parsed.filter((t) => typeof t === 'string' && t.trim());
        } catch (_) {
            return raw.split(',').map((t) => t.trim()).filter(Boolean);
        }
    }
    return [];
}

function mapDbFileToSound(file, index) {
    return {
        id: file.id || file.file_uuid || ('folder-' + index),
        fileId: file.file_uuid || file.id || null,
        name: file.filename,
        filePath: file.path,
        duration: (file.duration || 0) * 1000,
        sampleRate: file.sample_rate,
        channels: file.channels,
        size: file.size,
        type: file.format ? ('.' + file.format) : '',
        peaks: null,
        waveform: null,
        waveformDuration: file.duration,
        waveformSampleRate: file.sample_rate,
        waveformChannels: file.channels,
        tags: normalizeTags(file.tags),
        favorite: Boolean(file.is_favorite || file.favorite),
        source: file.source || 'user',
        aiDescription: file.ai_description || '',
        createdAt: file.created_at,
        folderPath: getParentPath(file.path)
    };
}

async function fetchFolderPage(folderPath, cursor) {
    const projectId = currentProject?.id || 'default';
    let url = '/api/v1/files?project_id=' + encodeURIComponent(projectId)
        + '&limit=200&folder=' + encodeURIComponent(folderPath);
    if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
    const data = await rendererApi.get(url);
    return {
        files: Array.isArray(data && data.files) ? data.files : [],
        cursor: data && data.next_cursor ? data.next_cursor : null,
        total: Number(data && data.total) || 0,
    };
}

async function renderFolderFiles(folderPath) {
    activeUserFolder = null; // 看的是磁盘目录，不是「我的文件夹」
    setSidebarView(null);
    folderFilter.path = folderPath;
    folderFilter.cursor = null;
    folderFilter.total = 0;
    folderFilter.loading = true;
    try {
        const page = await fetchFolderPage(folderPath, null);
        const mapped = page.files.map(mapDbFileToSound);
        allSearchResults = mapped;
        aiResultMode = false;
        folderFilter.cursor = page.cursor;
        folderFilter.total = page.total || mapped.length;
        renderSoundList('', mapped);
        showNotification('该文件夹下共 ' + folderFilter.total + ' 个文件，滚动可继续加载', 'info');
    } catch (error) {
        console.error('[Folder] 加载目录文件失败:', error);
        showNotification('加载文件夹失败: ' + error.message, 'error');
    } finally {
        folderFilter.loading = false;
    }
}

async function loadMoreFolderFiles() {
    if (folderFilter.loading || !folderFilter.path || !folderFilter.cursor) return;
    folderFilter.loading = true;
    try {
        const page = await fetchFolderPage(folderFilter.path, folderFilter.cursor);
        folderFilter.cursor = page.cursor;
        if (!page.files.length) return;
        const mapped = page.files.map(mapDbFileToSound);
        const existing = new Set((allSearchResults || []).map(s => s.filePath));
        const extra = mapped.filter(s => !existing.has(s.filePath));
        if (!extra.length) return;
        allSearchResults = (allSearchResults || []).concat(extra);
        renderSoundList('', allSearchResults);
    } catch (error) {
        console.warn('[Folder] 加载更多失败:', error);
    } finally {
        folderFilter.loading = false;
    }
}

async function withDbRetry(task, { attempts = 4, delayMs = 1200, label = '加载' } = {}) {
    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            return await task(attempt);
        } catch (error) {
            lastError = error;
            console.warn('[Retry] ' + label + ' 第 ' + attempt + ' 次失败:', error?.message || error);
            if (attempt < attempts) {
                await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
            }
        }
    }
    throw lastError;
}

async function loadFilesFromDatabase({ reset = true, tag = null } = {}) {
    if (tag !== null) fileListTagFilter = String(tag || '');
    if ((fileListLoading && !reset) || (!reset && !fileListNextCursor)) return;
    const loadToken = reset ? ++fileListLoadToken : fileListLoadToken;
    const projectId = currentProject?.id || 'default';
    if (reset) {
        fileListNextCursor = null;
        fileListTotal = 0;
    }
    fileListLoading = true;
    const cursor = reset ? null : fileListNextCursor;
    const startTime = Date.now();
    console.log('[Library] 加载文件页:', { reset, cursor });

    try {
        const result = await withDbRetry(
            () => fileListTagFilter
                ? rendererApi.get('/api/v1/files?limit=500&tag=' + encodeURIComponent(fileListTagFilter)
                    + '&project_id=' + encodeURIComponent(projectId))
                : rendererProjects.listFiles(projectId, { limit: 200, cursor }),
            { label: '文件列表' }
        );
        if (loadToken !== fileListLoadToken || projectId !== currentProject?.id) return null;
        const files = Array.isArray(result?.files) ? result.files : [];
        const mapped = files.map((file, index) => ({
            id: file.id || file.file_uuid || `${cursor || 'first'}-${index}`,
            fileId: file.file_uuid || file.id || null,
            name: file.filename,
            filePath: file.path,
            duration: (file.duration || 0) * 1000,
            sampleRate: file.sample_rate,
            channels: file.channels,
            size: file.size,
            type: file.format ? `.${file.format}` : '',
            peaks: isValidWaveformData(file.peaks) ? file.peaks : null,
            waveform: isValidWaveformData(file.peaks) ? file.peaks : null,
            waveformDuration: file.duration,
            waveformSampleRate: file.sample_rate,
            waveformChannels: file.channels,
            tags: normalizeTags(file.tags),
            favorite: Boolean(file.is_favorite || file.favorite),
        source: file.source || 'user',
            aiDescription: file.ai_description || '',
            createdAt: file.created_at,
            folderPath: getParentPath(file.path)
        }));

        if (reset) {
            soundData = mapped;
        } else {
            const existing = new Set(soundData.map(sound => sound.fileId || sound.filePath));
            soundData = soundData.concat(mapped.filter(sound => !existing.has(sound.fileId || sound.filePath)));
        }
        fileListNextCursor = result?.next_cursor || null;
        fileListTotal = Number(result?.total || soundData.length);
        // 「全部音效」的数字要等这一页回来才知道，树上可能已经渲染过了
        const allCount = document.getElementById('allSoundsCount');
        if (allCount) allCount.textContent = fileListTotal ? String(fileListTotal) : '';
        // 从数据库加载的文件重建文件夹树：这样重开软件后，
        // 左侧文件夹结构、每个文件夹的数量都还在。
        // 文件是分页加载的，节流重建，避免每页都重排整棵树。
        const foldersStale = soundData.length !== folderTreeBuiltCount;
        const foldersDue = (Date.now() - folderTreeBuiltAt) > 3000
            || (fileListTotal > 0 && soundData.length >= fileListTotal);
        if (foldersStale && foldersDue) {
            // 目录树用后端全库统计构建（分页数据反推会缺目录）
            await loadFolderStats(false);
        }
        updateCategoryData();
        renderSoundList();
        console.log('[Library] 文件页加载完成:', {
            loaded: mapped.length,
            visible: soundData.length,
            total: fileListTotal,
            nextCursor: fileListNextCursor,
            elapsedMs: Date.now() - startTime
        });
        return {
            loaded: mapped.length,
            total: fileListTotal,
            nextCursor: fileListNextCursor
        };
    } catch (error) {
        console.error('[Library] 文件列表加载失败:', error);
        showNotification('加载文件列表失败: ' + error.message, 'error');
        return null;
    } finally {
        if (loadToken === fileListLoadToken) fileListLoading = false;
    }
}

