/* websocket.js —— WEB SOCKET 管理
 * 从 index.html 原样搬出的完整顶层函数。
 */
function connectScanWebSocket(clientId) {
    const endpoint = rendererApi.wsUrl(`/ws/scan/${clientId}`);
    console.log('[DEBUG] 正在连接 WebSocket:', endpoint);

    return new Promise((resolve) => {
        let settled = false;
        let socket = null;
        const finish = (connected) => {
            if (settled) return;
            settled = true;
            resolve(connected);
        };
        const timeout = setTimeout(() => {
            if (socket && socket.readyState !== WebSocket.OPEN) socket.close();
            if (scanWebSocket === socket) scanWebSocket = null;
            finish(false);
        }, 3000);

        try {
            if (scanWebSocket) scanWebSocket.close();
            socket = new WebSocket(endpoint);
            scanWebSocket = socket;

            socket.onopen = () => {
                clearTimeout(timeout);
                console.log('[DEBUG] WebSocket 连接已建立');
                socket.send(JSON.stringify({type: 'ping'}));
                finish(true);
            };

            socket.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    console.log('[DEBUG] WebSocket 收到消息:', message);
                    handleScanMessage(message);
                } catch (e) {
                    console.error('[DEBUG] 解析 WebSocket 消息失败:', e);
                }
            };

            socket.onerror = (error) => {
                clearTimeout(timeout);
                console.error('[DEBUG] WebSocket 错误:', error);
                finish(false);
            };

            socket.onclose = () => {
                console.log('[DEBUG] WebSocket 连接已关闭');
                if (scanWebSocket === socket) scanWebSocket = null;
            };
        } catch (error) {
            clearTimeout(timeout);
            console.error('[DEBUG] 创建 WebSocket 失败:', error);
            finish(false);
        }
    });
}

async function monitorImportJobWithoutWebSocket(jobId) {
    try {
        const job = await rendererProjects.waitForJob(jobId, {
            intervalMs: 750,
            timeoutMs: 30 * 60 * 1000,
            onUpdate: update => updateScanProgress({
                status: update?.stage || 'processing',
                scanned: Number(update?.processed || 0),
                total: Number(update?.total || 0),
                progress: Number(update?.progress || (
                    update?.total ? (Number(update.processed || 0) / Number(update.total)) * 100 : 0
                ))
            })
        });
        if (currentScanTaskId !== jobId) return;
        if (job?.state === 'completed') {
            const processed = Number(job.processed || 0);
            const total = Number(job.total || processed);
            handleScanComplete({ added: processed, skipped: Math.max(0, total - processed) });
        } else {
            handleScanError({
                error: job?.error_message || `任务状态: ${job?.state || 'unknown'}`
            });
        }
    } catch (error) {
        if (currentScanTaskId === jobId) {
            handleScanError({ error: error?.message || '无法读取导入任务状态' });
        }
    }
}

function bindPlayerContextMenu() {
    const wave = document.getElementById('waveformContainer');
    if (wave) {
        wave.addEventListener('contextmenu', (e) => {
            if (!currentSound) return;
            e.preventDefault();
            e.stopPropagation();
            showSoundContextMenu(e, currentSound);
        });
    }
    const footers = [document.getElementById('playerFooter')].filter(Boolean);
    footers.forEach((bar) => {
        bar.addEventListener('contextmenu', (e) => {
            if (!currentSound) return;
            e.preventDefault();
            e.stopPropagation();
            showSoundContextMenu(e, currentSound);
        });
    });
}

function handleScanMessage(message) {
    switch (message.type) {
        case 'scan_progress':
            updateScanProgress(message.data);
            break;
        case 'scan_complete':
            handleScanComplete(message.data);
            break;
        case 'scan_error':
            handleScanError(message.data);
            break;
        case 'scan_status':
            if (message.data && message.data.message) {
                showNotification(message.data.message, 'info');
            }
            if (!scanProgressModal) {
                scanProgressModal = createScanProgressModal();
                document.body.appendChild(scanProgressModal);
            }
            break;
        case 'scan_log':
            // 扫描调试日志 - 在 F12 控制台显示
            handleScanLog(message.data);
            break;
        case 'folder_structure':
            // 接收文件夹结构
            handleFolderStructure(message.data);
            break;
        case 'pong':
            // 心跳响应
            break;
    }
}

function handleScanLog(data) {
    const { log_type, message, data: logData } = data;
    const prefix = '[SCANNER]';
    
    switch (log_type) {
        case 'info':
            console.log(`%c${prefix} ${message}`, 'color: #3b82f6; font-weight: bold;', logData || '');
            break;
        case 'warning':
            console.warn(`%c${prefix} ${message}`, 'color: #f59e0b; font-weight: bold;', logData || '');
            break;
        case 'error':
            console.error(`%c${prefix} ${message}`, 'color: #ef4444; font-weight: bold;', logData || '');
            break;
        case 'debug':
        default:
            console.log(`%c${prefix} ${message}`, 'color: #6b7280;', logData || '');
            break;
    }
}

function handleFolderStructure(data) {
    if (!data || !data.structure) {
        console.warn('[FOLDER] 未收到文件夹结构');
        return;
    }

    const backendStructure = data.structure;
    console.log('[FOLDER] 收到文件夹结构:', backendStructure);

    // 转换后端结构为前端格式
    const convertedRoot = convertBackendFolderToFrontend(backendStructure);

    // 添加到 importedFolderData（如果根节点已存在则替换，否则添加）
    const existingIndex = importedFolderData.findIndex(f => f.id === convertedRoot.id);
    if (existingIndex >= 0) {
        importedFolderData[existingIndex] = convertedRoot;
    } else {
        importedFolderData.push(convertedRoot);
    }

    // 重新渲染文件夹树
    renderFolderTree();
    lucide.createIcons();

    console.log('[FOLDER] 导入文件夹结构已更新:', importedFolderData);
}

function convertBackendFolderToFrontend(backendNode) {
    const nodeId = 'folder_' + backendNode.path.replace(/[^a-zA-Z0-9]/g, '_');

    const frontendNode = {
        id: nodeId,
        name: backendNode.name,
        path: backendNode.relative_path,  // 相对路径用于筛选
        fullPath: backendNode.path,       // 完整路径
        expanded: true,                   // 默认展开
        count: backendNode.file_count,    // 文件数量
        children: []
    };

    // 递归转换子文件夹
    if (backendNode.children && backendNode.children.length > 0) {
        frontendNode.children = backendNode.children.map(child =>
            convertBackendFolderToFrontend(child)
        );
    }

    return frontendNode;
}

function finishScanModal(modal) {
    document.getElementById('scanMiniBadge')?.remove();
    const target = modal || scanProgressModal;
    if (target && target.parentNode) target.parentNode.removeChild(target);
    if (scanProgressModal === target) scanProgressModal = null;
}

function requestScanCancel(taskId) {
    if (!taskId) return false;
    try {
        if (scanWebSocket && scanWebSocket.readyState === WebSocket.OPEN) {
            scanWebSocket.send(JSON.stringify({ type: 'cancel', task_id: taskId }));
            return true;
        }
    } catch (error) {
        console.warn('[Scan] 发送取消失败:', error);
    }
    return false;
}

function maybeCancelPendingScan() {
    if (!scanCancelRequested || !currentScanTaskId) return;
    scanCancelRequested = false;
    requestScanCancel(currentScanTaskId);
    finishScanModal(null);
    currentScanTaskId = null;
}

function createScanProgressModal() {
    const modal = document.createElement('div');
    modal.className = 'scan-progress-modal';
    // 非阻塞：固定在右下角，像下载条一样，用户可以继续用其它功能
    modal.style.cssText = `
        position: fixed;
        right: 16px;
        bottom: 84px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        padding: 12px 14px;
        width: 300px;
        z-index: 9999;
        box-shadow: 0 10px 40px rgba(0,0,0,0.35);
    `;
    modal.innerHTML = `
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
            <span style="font-size: 13px; font-weight: 500;">正在后台导入…</span>
            <span style="display:flex;gap:6px;">
                <button class="hide-btn" style="
                    padding: 2px 8px;
                    background: transparent;
                    color: var(--text-secondary);
                    border: 1px solid var(--border-color);
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                " title="隐藏进度，导入继续在后台进行">隐藏</button>
                <button class="cancel-btn" style="
                    padding: 2px 8px;
                    background: transparent;
                    color: #ef4444;
                    border: 1px solid rgba(239,68,68,.4);
                    border-radius: 4px;
                    cursor: pointer;
                    font-size: 11px;
                " title="停止本次导入">取消</button>
            </span>
        </div>
        <div class="progress-bar-container" style="
            background: var(--bg-primary);
            border-radius: 2px;
            height: 4px;
            overflow: hidden;
        ">
            <div class="progress-bar" style="
                height: 100%;
                background: #3b82f6;
                width: 0%;
                transition: width 0.2s ease;
            "></div>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 8px;">
            <p class="progress-text" style="margin: 0; font-size: 11px; color: var(--text-secondary);">准备中...</p>
            <p class="current-file" style="margin: 0; font-size: 11px; color: var(--text-muted); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></p>
        </div>
    `;

    // 隐藏：导入继续在后台跑，右下角留一个迷你入口
    modal.querySelector('.hide-btn')?.addEventListener('click', () => {
        const mini = document.getElementById('scanMiniBadge') || document.createElement('button');
        mini.id = 'scanMiniBadge';
        mini.className = 'fixed z-[9999] rounded-full px-3 py-1.5 text-[11px] shadow-lg';
        mini.style.cssText = 'right:16px; bottom:84px; background: var(--bg-secondary); border:1px solid var(--border-color); color: var(--text-secondary);';
        mini.textContent = '导入进行中 · 点击查看';
        mini.onclick = () => {
            mini.remove();
            if (scanProgressModal) {
                scanProgressModal.style.display = '';
                document.body.appendChild(scanProgressModal);
            }
        };
        document.body.appendChild(mini);
        modal.remove();
        showNotification('导入继续在后台进行，可继续使用其它功能', 'info');
    });

    // 取消按钮：点了必须立刻有反应。
    // 以前只有「任务 id 和 WS 都就绪」时才发消息，否则点下去什么都不发生 ——
    // 而弹窗是在拿到 task_id 之前就弹出来的，所以经常点不动。
    modal.querySelector('.cancel-btn').addEventListener('click', () => {
        const btn = modal.querySelector('.cancel-btn');
        btn.disabled = true;
        btn.textContent = '正在取消…';
        scanCancelRequested = true;

        const taskId = currentScanTaskId;
        if (taskId) {
            requestScanCancel(taskId);
            showNotification('已取消导入（已扫描的文件会留在库里）', 'info');
            finishScanModal(modal);
            return;
        }
        // 任务还没建好：先关弹窗，等 task_id 回来时在 maybeCancelPendingScan 里补一刀
        showNotification('正在取消…', 'info');
        setTimeout(() => finishScanModal(modal), 600);
    });

    return modal;
}

function updateScanProgress(data) {
    if (!scanProgressModal) {
        scanProgressModal = createScanProgressModal();
        document.body.appendChild(scanProgressModal);
    }

    const progressBar = scanProgressModal.querySelector('.progress-bar');
    const progressText = scanProgressModal.querySelector('.progress-text');
    const currentFileText = scanProgressModal.querySelector('.current-file');

    const total = Number(data.total || 0);
    const scanned = Number(data.scanned ?? data.processed ?? 0);
    const percent = data.progress !== undefined && data.progress !== null
        ? Number(data.progress)
        : (total ? Math.min(100, Math.round((scanned / total) * 100)) : 0);
    if (progressBar) progressBar.style.width = percent + '%';

    // 后端阶段名 -> 用户能看懂的说法
    const statusMap = {
        'scanning': '正在扫描文件',
        'preparing': '正在登记文件',
        'decoding': '正在解码分析',
        'analyzing': '正在分析音频',
        'saving': '正在写入数据库',
        'indexing': '正在生成索引',
        'processing': '正在处理'
    };
    const statusText = statusMap[data.status] || statusMap['processing'];

    if (progressText) {
        progressText.textContent = total
            ? statusText + '：' + scanned + ' / ' + total + '（' + percent + '%）'
            : statusText + '…（正在统计文件数量）';
    }
    if (currentFileText && data.current_file) {
        currentFileText.textContent = data.current_file;
    }
}

function handleScanComplete(data) {
    // WebSocket 与轮询兜底可能同时到达，只提示一次
    if (scanCompletionHandled) return;
    scanCompletionHandled = true;
    setTimeout(() => { scanCompletionHandled = false; }, 5000);
    if (scanProgressModal) {
        scanProgressModal.remove();
        scanProgressModal = null;
    }
    currentScanTaskId = null;

    if (data.error) {
        showNotification(`导入失败: ${data.error}`, 'error');
    } else {
        showNotification(`导入完成: 新增 ${data.added} 个文件，跳过 ${data.skipped} 个`, 'success');

        // 从 SQLite 重新加载文件列表
        loadFilesFromDatabase();
        refreshProjectIndexStatus();

        // 重新加载文件夹结构和映射
        loadUserFolders().then(() => {
            renderFolderTree();
            lucide.createIcons();
        });
        // 目录树按后端全库统计重建（导入后立刻刷新，不受节流限制）
        loadFolderStats(true);
        loadTagStats();

        // 导入的新文件还没算 sha256 —— 先触发补算，否则重复检测查不到它们
        rendererApi.post('/api/v1/index/hash?project_id=' + encodeURIComponent(currentProject?.id || 'default'), {}, { timeoutMs: 60000 })
            .catch(() => { });

        // 索引默认暂停：先让用户导描述包，再分别跑两种向量
        if (data.added > 0) {
            setTimeout(() => {
                showNotification(
                    '波形已在后台自动补。两种向量留给你手动跑：建议先「导入描述包」，再点「修复文本向量」和「修复音频向量」（分开跑，不会互相拖慢）',
                    'info', 12000
                );
            }, 1200);
        }

        // 导入完成后提醒一次：库里还有多少重复没处理
        setTimeout(() => { maybeHintDuplicates(); }, 2500);
    }
}

async function maybeHintDuplicates() {
    if (document.getElementById('dupHintCard')) return;
    let data = null;
    try {
        data = await rendererApi.get('/api/v1/duplicates?limit=1', { timeoutMs: 120000 });
    } catch (_) {
        return;
    }
    if (!data || !data.group_count) return;

    const card = document.createElement('div');
    card.id = 'dupHintCard';
    card.className = 'fixed z-[260] rounded-lg shadow-xl p-3';
    card.style.cssText = 'right: 20px; bottom: 90px; width: 300px; background: var(--bg-secondary); border: 1px solid var(--border-color);';
    card.innerHTML = `
        <div class="text-sm font-medium mb-1">导入完成，发现重复音效</div>
        <div class="text-xs opacity-70 leading-5 mb-3">库里现有 <b>${data.group_count}</b> 组重复，共 <b>${data.file_count}</b> 个文件（约 ${((data.wasted_bytes || 0) / 1024 / 1024).toFixed(1)} MB）。多数是素材包本身就重复收录。</div>
        <div class="flex items-center gap-2">
            <button id="dupHintOpen" class="px-3 py-1.5 rounded-md text-xs text-white" style="background:#8b5cf6;">去处理</button>
            <button id="dupHintLater" class="px-3 py-1.5 rounded-md text-xs border" style="border-color: var(--border-color);">以后再说</button>
        </div>`;
    document.body.appendChild(card);
    card.querySelector('#dupHintOpen').addEventListener('click', () => {
        card.remove();
        showDuplicatesModal();
    });
    card.querySelector('#dupHintLater').addEventListener('click', () => card.remove());
}

function handleScanError(data) {
    if (scanProgressModal) {
        scanProgressModal.remove();
        scanProgressModal = null;
    }
    currentScanTaskId = null;

    showNotification(`导入错误: ${data.error || '未知错误'}`, 'error');
}

function buildImportedFoldersFromSounds(force = false) {
    if (!soundData.length) return;
    if (!force && importedFolderData.length > 0) return;
    const normalise = (value) => String(value || '').replace(/\//g, '\\').replace(/\\+$/, '');
    const dirs = soundData
        .map((sound) => normalise(sound.folderPath))
        .filter(Boolean)
        .map((dir) => dir.split('\\').filter(Boolean));
    if (!dirs.length) return;

    // 求「主库」的公共父目录并剥掉，让树从库根开始（CJ音效库 / z秋拾…）。
    // 不能对全部文件求公共前缀：只要有一个离群文件（比如 E:AI生成音效），
    // 公共前缀就会塌成空串，树就退化成一堆盘符和深层子目录。
    const groupKey = (parts) => ((parts[0] || '') + '\\' + (parts[1] || '')).toLowerCase();
    const groupCounts = new Map();
    dirs.forEach((parts) => {
        const key = groupKey(parts);
        groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
    });
    let mainKey = null;
    let mainCount = -1;
    groupCounts.forEach((count, key) => {
        if (count > mainCount) { mainCount = count; mainKey = key; }
    });
    let common = [];
    dirs.forEach((parts) => {
        if (groupKey(parts) !== mainKey) return;
        if (!common.length) { common = parts.slice(0, -1); return; }
        let i = 0;
        while (i < common.length && i < parts.length - 1
               && common[i].toLowerCase() === parts[i].toLowerCase()) {
            i += 1;
        }
        common = common.slice(0, i);
    });

    const byPath = new Map();
    const roots = [];
    dirs.forEach((parts) => {
        const inMain = common.length > 0
            && parts.length > common.length
            && common.every((seg, i) => (parts[i] || '').toLowerCase() === seg.toLowerCase());
        const relative = inMain ? parts.slice(common.length) : parts;
        let acc = inMain ? common.join('\\') : '';
        let siblings = roots;
        const counted = new Set();
        relative.forEach((part) => {
            acc = acc ? acc + '\\' + part : part;
            const key = acc.toLowerCase();
            let node = byPath.get(key);
            if (!node) {
                node = { name: part, path: acc, fullPath: acc, children: [], count: 0 };
                byPath.set(key, node);
                siblings.push(node);
            }
            if (!counted.has(key)) {
                node.count += 1;
                counted.add(key);
            }
            siblings = node.children;
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
    console.log('[Folder] 重建文件夹树:', roots.length, '个根，', soundData.length, '个文件');
}

