/* updater.js —— 检查更新
 * 从 index.html 原样搬出的完整顶层函数。
 */
async function fillMenuVersion() {
    if (!window.electronAPI?.updates) return;
    let version = '';
    try {
        version = 'v' + await window.electronAPI.updates.version();
    } catch (_) {
        return;
    }
    for (const id of ['menuVersionText', 'aboutVersionText']) {
        const el = document.getElementById(id);
        if (el && !el.textContent) el.textContent = version;
    }
}

function showUpdateDialog(latest) {
    document.getElementById('updateDialog')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'updateDialog';
    overlay.className = 'fixed inset-0 z-[300] flex items-center justify-center';
    overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';

    const panel = document.createElement('div');
    panel.className = 'rounded-lg shadow-2xl p-5 w-[520px] max-w-[92vw] max-h-[80vh] flex flex-col';
    panel.style.backgroundColor = 'var(--bg-secondary)';
    panel.style.border = '1px solid var(--border-color)';

    const header = document.createElement('div');
    header.className = 'flex items-start justify-between gap-4 mb-3';
    const titleBox = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.className = 'text-base font-semibold';
    h3.textContent = '发现新版本';
    const sub = document.createElement('div');
    sub.className = 'text-xs opacity-60 mt-1';
    sub.textContent = 'v' + latest.version + (latest.releasedAt ? '　' + latest.releasedAt : '');
    titleBox.appendChild(h3);
    titleBox.appendChild(sub);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'p-1 rounded hover:bg-white/10 transition-colors shrink-0';
    closeBtn.innerHTML = '<i data-lucide="x" class="w-4 h-4"></i>';
    closeBtn.addEventListener('click', () => overlay.remove());
    header.appendChild(titleBox);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    const notes = document.createElement('div');
    notes.className = 'flex-1 overflow-y-auto text-xs opacity-75 leading-6 whitespace-pre-line mb-4';
    notes.textContent = (latest.notes || []).join('\n') || '这个版本没有写更新说明';
    panel.appendChild(notes);

    const footer = document.createElement('div');
    footer.className = 'flex items-center gap-2 shrink-0';
    const openBtn = document.createElement('button');
    openBtn.className = 'px-3 py-1.5 rounded text-sm text-white';
    openBtn.style.background = '#22c55e';
    openBtn.textContent = '打开下载页';
    openBtn.disabled = !latest.url;
    openBtn.style.opacity = latest.url ? '1' : '0.5';
    openBtn.addEventListener('click', () => {
        if (!latest.url) return;
        window.electronAPI?.updates?.openExternal(latest.url);
    });
    footer.appendChild(openBtn);

    if (latest.code) {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'px-3 py-1.5 rounded text-sm border hover:bg-white/5';
        copyBtn.style.borderColor = 'var(--border-color)';
        copyBtn.textContent = '复制提取码 ' + latest.code;
        copyBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(latest.code);
                showNotification('提取码已复制：' + latest.code, 'success');
            } catch (_) {
                showNotification('提取码：' + latest.code, 'info');
            }
        });
        footer.appendChild(copyBtn);
    }

    const spacer = document.createElement('div');
    spacer.className = 'flex-1';
    footer.appendChild(spacer);

    const laterBtn = document.createElement('button');
    laterBtn.className = 'px-3 py-1.5 rounded text-sm border hover:bg-white/5';
    laterBtn.style.borderColor = 'var(--border-color)';
    laterBtn.textContent = '以后再说';
    laterBtn.addEventListener('click', () => overlay.remove());
    footer.appendChild(laterBtn);

    panel.appendChild(footer);
    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', (event) => {
        if (event.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
    if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
}

function formatBytesText(value) {
    const size = Number(value || 0);
    if (size < 1024) return size + ' B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + ' KB';
    if (size < 1024 * 1024 * 1024) return (size / 1024 / 1024).toFixed(1) + ' MB';
    return (size / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

async function installLocalUpdate() {
    const api = window.electronAPI?.updates;
    if (!api?.pickLocal) { showNotification('当前环境不支持本地更新', 'info'); return; }
    const picked = await api.pickLocal();
    if (!picked || picked.canceled || !picked.zipPath) return;

    const info = await api.inspect(picked.zipPath);
    if (!info || !info.ok) {
        showNotification('无法读取更新包: ' + (info?.error || '未知错误'), 'error');
        return;
    }
    if (info.upToDate) {
        showNotification('当前已经是 v' + (info.version || '该版本') + '，无需更新', 'success');
        return;
    }
    const lines = [
        '更新包版本：v' + (info.version || '未知'),
        info.baseVersion ? '适配版本：v' + info.baseVersion : '',
        '',
        '需要替换 ' + info.replaceCount + ' 个文件（约 ' + formatBytesText(info.replaceBytes) + '）',
        info.removeCount ? '需要删除 ' + info.removeCount + ' 个旧文件' : '',
        '',
        '标签、界面布局、皮肤等用户数据不会受影响。',
        '继续安装？'
    ].filter(Boolean);
    if (!confirm(lines.join('\n'))) return;

    showNotification('正在应用更新，请不要关闭软件…', 'info');
    const result = await api.apply(picked.zipPath);
    if (!result || !result.ok) {
        showNotification('更新失败: ' + (result?.error || '未知错误'), 'error');
        return;
    }
    const summary = '更新完成：替换 ' + (result.replaced || 0) + ' 个文件'
        + (result.removed ? '，清理 ' + result.removed + ' 个旧文件' : '')
        + (result.needsRestart ? '，' + (result.pendingCount || 0) + ' 个文件需要退出后替换' : '');
    showNotification(summary, 'success');
    if (confirm(summary + '\n\n需要重启才能生效，现在重启吗？\n（重启时会自动完成剩余文件的替换）')) {
        await api.restart();
    }
}

async function checkForUpdatesFromMenu() {
    if (!window.electronAPI?.updates) {
        showNotification('当前环境不支持检查更新', 'info');
        return;
    }
    showNotification('正在检查更新…', 'info');
    try {
        const res = await window.electronAPI.updates.check();
        if (!res || !res.ok) {
            showNotification((res && res.error) || '检查更新失败', 'error');
            return;
        }
        if (!res.hasUpdate) {
            showNotification('已是最新版本 v' + res.current, 'success');
            return;
        }
        showUpdateDialog(res.latest);
    } catch (error) {
        showNotification('检查更新失败: ' + (error?.message || error), 'error');
    }
}

