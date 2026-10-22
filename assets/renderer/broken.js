/* ============================================================
 * 损坏文件管理：分类查看 + 单个/批量清理
 * 清理仅从软件库移除记录，保留磁盘上的原始文件
 * ============================================================ */
(function () {
    'use strict';

    let currentList = [];
    let cleaningAll = false;

    // 打包后页面来自 dsh-app://，相对路径 fetch 会失败；优先用带后端地址的 api
    function apiFetch(path, options) {
        const api = window.SoundBotRenderer?.api;
        if (api && typeof api.fetch === 'function') return api.fetch(path, options);
        return fetch(path, options);
    }

    async function fetchBroken() {
        const resp = await apiFetch('/api/v1/db/broken-files');
        if (!resp.ok) throw new Error('加载失败');
        return (await resp.json()).files || [];
    }

    function updateSidebarCount(n) {
        const el = document.getElementById('brokenFilesCount');
        if (el) el.textContent = n;
        if (n > 0) {
            document.getElementById('brokenFilesBtn').style.display = 'flex';
        } else {
            document.getElementById('brokenFilesBtn').style.display = 'none';
        }
    }

    function fmtSize(bytes) {
        if (!bytes) return '';
        const mb = bytes / 1024 / 1024;
        return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
    }

    function errorText(failedArtifacts) {
        if (!failedArtifacts || !failedArtifacts.length) return '索引失败';
        const codes = failedArtifacts.map(a => a.error_code || a.kind).filter((v, i, arr) => arr.indexOf(v) === i);
        const firstMsg = failedArtifacts.find(a => a.error_message)?.error_message || '';
        return codes.join(' / ') + (firstMsg ? ' — ' + firstMsg.slice(0, 80) : '');
    }

    function renderList() {
        const box = document.getElementById('brokenFilesList');
        document.getElementById('brokenFilesModalCount').textContent = currentList.length;
        const cleanupBtn = document.getElementById('cleanupAllBrokenBtn');
        cleanupBtn.disabled = currentList.length === 0 || cleaningAll;
        cleanupBtn.textContent = cleaningAll ? '清理中…' : '一键清理全部';
        if (!currentList.length) {
            box.innerHTML = '<div class="text-sm opacity-50 py-8 text-center">🎉 没有损坏文件</div>';
            return;
        }
        box.innerHTML = '';
        currentList.forEach((f, idx) => {
            const row = document.createElement('div');
            row.className = 'flex items-center gap-3 px-3 py-2.5 rounded-lg mb-2 border' +
                (idx % 2 ? '' : '');
            row.style.borderColor = 'var(--border-color)';
            row.style.background = 'var(--bg-tertiary)';
            const icon = document.createElement('div');
            icon.className = 'w-9 h-9 rounded-md flex items-center justify-center shrink-0';
            icon.style.background = 'rgba(239,68,68,.12)';
            icon.innerHTML = '<i data-lucide="file-x-2" class="w-4 h-4" style="color:#ef4444;"></i>';
            const info = document.createElement('div');
            info.className = 'flex-1 min-w-0';
            const name = document.createElement('div');
            name.className = 'text-sm font-medium truncate';
            name.textContent = f.filename || f.path.split(/[\\/]/).pop();
            const path = document.createElement('div');
            path.className = 'text-[10px] opacity-40 truncate';
            path.textContent = f.path;
            const err = document.createElement('div');
            err.className = 'text-[11px] truncate mt-0.5';
            err.style.color = '#ef4444';
            err.textContent = '❌ ' + errorText(f.failed_artifacts);
            info.appendChild(name); info.appendChild(path); info.appendChild(err);
            const meta = document.createElement('div');
            meta.className = 'text-[10px] opacity-40 shrink-0 text-right mr-2';
            meta.textContent = (f.format || '').toUpperCase() + '\n' + fmtSize(f.file_size);
            const rmBtn = document.createElement('button');
            rmBtn.className = 'px-2.5 py-1.5 rounded-md text-xs font-medium shrink-0 transition-colors hover:opacity-80';
            rmBtn.style.background = 'rgba(239,68,68,.15)';
            rmBtn.style.color = '#ef4444';
            rmBtn.textContent = '移除';
            rmBtn.addEventListener('click', () => removeOne(f));
            row.appendChild(icon); row.appendChild(info); row.appendChild(meta); row.appendChild(rmBtn);
            box.appendChild(row);
        });
        if (window.lucide) { try { lucide.createIcons(); } catch (e) {} }
    }

    async function refresh() {
        try {
            currentList = await fetchBroken();
            renderList();
            updateSidebarCount(currentList.length);
        } catch (e) {
            const st = document.getElementById('brokenFilesStatus');
            if (st) st.textContent = '加载失败: ' + e.message;
        }
    }

    async function removeOne(f) {
        if (!confirm(`确定从软件库移除「${f.filename}」？\n磁盘上的原始文件不会被删除。`)) return;
        const status = document.getElementById('brokenFilesStatus');
        try {
            const resp = await apiFetch('/api/v1/db/broken/' + encodeURIComponent(f.path), { method: 'DELETE' });
            if (!resp.ok) {
                const data = await resp.json().catch(() => ({}));
                throw new Error(data.detail || '移除失败');
            }
            if (status) status.textContent = '已移除: ' + f.filename;
            await refresh();
        } catch (e) {
            if (status) status.textContent = '移除失败: ' + e.message;
        }
    }

    async function cleanupAll() {
        if (cleaningAll) return;
        if (!currentList.length) return;
        if (!confirm(`确定一键清理全部 ${currentList.length} 个损坏文件？\n仅从软件库移除，磁盘上的原始文件不会被删除。`)) return;
        cleaningAll = true;
        const status = document.getElementById('brokenFilesStatus');
        renderList();
        try {
            const resp = await apiFetch('/api/v1/db/broken/cleanup', { method: 'POST' });
            const data = await resp.json();
            if (!resp.ok || !data.success) throw new Error(data.detail || '提交失败');
            if (status) status.textContent = `已提交清理 ${data.count || 0} 个文件，正在后台执行…`;
            // 轮询直到清理完成
            const deadline = Date.now() + 120000;
            while (Date.now() < deadline) {
                await new Promise(r => setTimeout(r, 2000));
                try {
                    const remain = (await fetchBroken()).length;
                    updateSidebarCount(remain);
                    if (remain === 0) {
                        currentList = [];
                        renderList();
                        if (status) status.textContent = '✅ 全部损坏文件已清理完毕（原始文件保留在磁盘）';
                        break;
                    }
                    if (status) status.textContent = `清理中… 剩余 ${remain} 个`;
                } catch (e) {
                    break;
                }
            }
        } catch (e) {
            if (status) status.textContent = '清理失败: ' + e.message;
        } finally {
            cleaningAll = false;
            await refresh();
        }
    }

    function openModal() {
        document.getElementById('brokenFilesModal').classList.remove('hidden');
        document.getElementById('brokenFilesModal').classList.add('flex');
        refresh();
    }
    function closeModal() {
        document.getElementById('brokenFilesModal').classList.add('hidden');
        document.getElementById('brokenFilesModal').classList.remove('flex');
    }

    function init() {
        document.getElementById('brokenFilesBtn')?.addEventListener('click', openModal);
        document.getElementById('closeBrokenFilesModal')?.addEventListener('click', closeModal);
        document.getElementById('cleanupAllBrokenBtn')?.addEventListener('click', cleanupAll);
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closeModal();
        });
        // 初始加载数量徽标
        fetchBroken().then(list => updateSidebarCount(list.length)).catch(() => {});
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
