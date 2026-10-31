/* import-flow.js —— 拖拽 / 文件 / 文件夹导入入口
 *
 * 这三段原本挤在 index.html 的 DOMContentLoaded 闭包里（A5）：
 * 闭包里的 scanProgressModal / currentScanTaskId / scanWebSocket 只有闭包自己能看见，
 * 而 assets/renderer/websocket.js 里的 WS 逻辑读的是同名全局 —— 于是 connectScanWebSocket
 * 每次都在第一次读 scanWebSocket 时抛 ReferenceError，被自己的 try/catch 吞掉，
 * WS 从来没真正连上过（一直靠轮询兜底）。
 *
 * 现在状态收口到 window.importRuntime（由 websocket.js 定义），这里只管入口。
 */
(function () {
    'use strict';

    function runtime() {
        return window.importRuntime || (window.importRuntime = {
            scanProgressModal: null,
            currentScanTaskId: null,
            scanWebSocket: null,
        });
    }

    // ===== 拖拽导入（文件夹 / 音频文件） =====
    async function importDroppedPaths(paths) {
        const state = runtime();
        const projectId = currentProject?.id;
        if (!projectId) {
            showNotification('当前工程尚未就绪，请稍后重试', 'error');
            return;
        }
        let items = [];
        try {
            items = (await window.electronAPI?.classifyPaths?.(paths)) || [];
        } catch (error) {
            console.warn('[Drop] 路径识别失败:', error);
        }
        const dirs = items.filter(i => i.isDirectory).map(i => i.path);
        const files = items.filter(i => !i.isDirectory && !i.missing).map(i => i.path);
        if (!dirs.length && !files.length) {
            showNotification('没有可导入的文件或文件夹', 'error');
            return;
        }
        if (dirs.length) {
            const clientId = 'drop_' + Date.now();
            if (!state.scanProgressModal) {
                state.scanProgressModal = createScanProgressModal();
                document.body.appendChild(state.scanProgressModal);
            }
            await connectScanWebSocket(clientId);
            for (const dir of dirs) {
                try {
                    const res = await window.electronAPI.backendAPI.importFolderAsync(
                        dir, true, clientId, projectId
                    );
                    if (res && res.task_id) {
                        state.currentScanTaskId = res.task_id;
                        maybeCancelPendingScan();
                        monitorImportJobWithoutWebSocket(res.task_id);  // 与 WS 并行兜底，handleScanComplete 内部去重
                    }
                } catch (error) {
                    showNotification('导入文件夹失败: ' + error.message, 'error');
                }
            }
        }
        if (files.length) {
            await handleImportedFiles(files.map(p => ({ path: p })), projectId);
        }
    }

    // ===== 拖放区域高亮 =====
    function initDropImport() {
        const zone = document.getElementById('folderPanelSection');
        const mark = (on) => { if (zone) zone.style.outline = on ? '2px solid #3b82f6' : ''; };
        ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, (e) => {
            if (!e.dataTransfer) return;
            const types = Array.from(e.dataTransfer.types || []);
            if (!types.includes('Files')) return;
            e.preventDefault();
            mark(true);
        }));
        ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, () => mark(false)));
        document.addEventListener('drop', async (e) => {
            const dropped = Array.from(e.dataTransfer?.files || []);
            if (!dropped.length) return;
            e.preventDefault();
            const paths = dropped.map(f => f.path).filter(Boolean);
            if (paths.length) await importDroppedPaths(paths);
        });
    }

    // ===== 导入单个/多个音频文件 =====
    async function handleImportedFiles(files, importProjectId) {
        const state = runtime();
        try {
            if (!window.electronAPI?.backendAPI?.importFiles) {
                throw new Error(i18n.t('import.backend.unavailable'));
            }

            const filePaths = (files || []).map(file => file?.path).filter(Boolean);
            if (filePaths.length === 0) {
                throw new Error(i18n.t('import.path.required'));
            }
            if (!importProjectId) {
                throw new Error('当前工程尚未就绪，请稍后重试');
            }

            const clientId = `files_${Date.now()}`;
            if (!state.scanProgressModal) {
                state.scanProgressModal = createScanProgressModal();
                document.body.appendChild(state.scanProgressModal);
            }
            await connectScanWebSocket(clientId);

            const result = await window.electronAPI.backendAPI.importFiles(
                filePaths,
                clientId,
                importProjectId
            );
            state.currentScanTaskId = result?.job_id || null;
            if (!state.currentScanTaskId) {
                throw new Error(i18n.t('import.job.invalid'));
            }

            showNotification(i18n.t('import.started', { count: result.total ?? filePaths.length }), 'info');
            // 与 WebSocket 并行兜底（handleScanComplete 内部去重）
            monitorImportJobWithoutWebSocket(state.currentScanTaskId);
        } catch (error) {
            console.error('处理导入文件时出错:', error);
            if (state.scanProgressModal) {
                state.scanProgressModal.remove();
                state.scanProgressModal = null;
            }
            if (state.scanWebSocket) {
                state.scanWebSocket.close();
                state.scanWebSocket = null;
            }
            showNotification(i18n.t('import.failed') + ': ' + error.message, 'error');
        }
    }

    window.importDroppedPaths = importDroppedPaths;
    window.handleImportedFiles = handleImportedFiles;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDropImport, { once: true });
    } else {
        initDropImport();
    }
})();
