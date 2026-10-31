/* utils.js —— 工具函数
 * 从 index.html 原样搬出的完整顶层函数。
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getPathDisplayName(filePath) {
    const normalized = String(filePath || '').replace(/[\\/]+$/, '');
    const pathParts = normalized.split(/[\\/]+/);
    return pathParts[pathParts.length - 1] || filePath;
}

async function updateDiskSpaceDisplay() {
    try {
        let result;
        if (window.electronAPI && window.electronAPI.backendAPI) {
            result = await window.electronAPI.backendAPI.getDiskSpace();
        } else {
            const response = await rendererApi.fetch('/api/v1/disk-space');
            result = await response.json();
        }

        if (result && result.success) {
            const freeSpace = formatFileSize(result.free_bytes);
            const totalSpace = formatFileSize(result.total_bytes);
            const percentUsed = ((result.total_bytes - result.free_bytes) / result.total_bytes * 100).toFixed(1);

            const diskSpaceText = document.getElementById('diskSpaceText');
            if (diskSpaceText) {
                diskSpaceText.textContent = `${freeSpace} 可用`;
                diskSpaceText.title = `总空间: ${totalSpace}\n已用: ${percentUsed}%\n路径: ${result.path}`;
            }
        }
    } catch (error) {
        console.error('获取磁盘空间失败:', error);
        const diskSpaceText = document.getElementById('diskSpaceText');
        if (diskSpaceText) {
            diskSpaceText.textContent = '无法获取';
        }
    }
}

async function checkModelStatus() {
    try {
        const response = await rendererApi.fetch('/api/v1/model/status');
        const result = await response.json();

        const modelDisplay = document.getElementById('modelStatusDisplay');
        const modelText = document.getElementById('modelStatusText');
        const modelIcon = document.getElementById('modelStatusIcon');

        if (result && result.model_status) {
            if (result.model_status.loading) {
                // 模型加载中 - 显示旋转动画
                modelDisplay.style.display = 'flex';
                modelIcon.className = 'w-3.5 h-3.5 rounded-full border-2 border-t-transparent animate-spin';
                modelIcon.style.borderColor = 'var(--text-secondary)';
                modelIcon.style.borderTopColor = 'transparent';
                modelText.textContent = i18n.t('model.loading');
                modelDisplay.style.borderColor = 'var(--border-color)';
            } else if (result.model_status.loaded) {
                // 模型已加载 - 显示绿色对勾
                modelDisplay.style.display = 'flex';
                modelIcon.className = 'w-3.5 h-3.5 flex items-center justify-center';
                modelIcon.style.border = 'none';
                modelIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><polyline points="20 6 9 17 4 12"></polyline></svg>';
                modelText.textContent = i18n.t('model.ready');
                modelText.style.color = '#22c55e';
                modelDisplay.style.borderColor = '#22c55e';
            } else if (result.model_status.error) {
                // 模型加载失败 - 显示红色错误
                modelDisplay.style.display = 'flex';
                modelIcon.className = 'w-3.5 h-3.5 flex items-center justify-center';
                modelIcon.style.border = 'none';
                modelIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" style="width: 14px; height: 14px;"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
                modelText.textContent = i18n.t('model.error');
                modelText.style.color = '#ef4444';
                modelDisplay.style.borderColor = '#ef4444';
            } else {
                // 模型未加载
                modelDisplay.style.display = 'flex';
                modelIcon.className = 'w-3.5 h-3.5 rounded-full border-2';
                modelIcon.style.borderColor = '#f59e0b';
                modelIcon.innerHTML = '';
                modelText.textContent = '模型未加载';
                modelText.style.color = '#f59e0b';
                modelDisplay.style.borderColor = '#f59e0b';
            }
        }
    } catch (error) {
        console.error('获取模型状态失败:', error);
        // 后端不可用时不显示模型状态
        const modelDisplay = document.getElementById('modelStatusDisplay');
        if (modelDisplay) {
            modelDisplay.style.display = 'none';
        }
    }
}

function formatIndexArtifactStatus(summary) {
    // R/P/F 是内部缩写，用户看不懂；改成中文并保留悬停说明
    const failed = Number(summary.failed || 0);
    return `已索引 ${summary.ready} · 待处理 ${summary.pending}` + (failed ? ` · 失败 ${failed}` : '');
}

function updateIndexJobStatus(job) {
    const status = document.getElementById('indexJobStatus');
    if (!status) return;
    const total = Number(job?.total || 0);
    const processed = Number(job?.processed || 0);
    const progress = total > 0 ? ` ${processed}/${total}` : '';
    status.textContent = `${job?.state || 'pending'}${progress}`;
    status.title = job?.error_message || job?.stage || status.textContent;
    status.style.color = '';
    status.style.cursor = '';
    status.onclick = null;
}

function paintIndexStatusLabel(text, { retryable = false, title = '' } = {}) {
    const label = document.getElementById('indexJobStatus');
    if (!label) return;
    label.textContent = text;
    label.title = title || text;
    label.style.cursor = retryable ? 'pointer' : '';
    label.style.color = retryable ? '#f59e0b' : '';
    label.onclick = retryable
        ? (() => { indexStatusFailures = 0; refreshProjectIndexStatus({ showPlaceholder: true }); })
        : null;
}

function scheduleIndexStatusRetry() {
    if (indexStatusRetryTimer) return;
    indexStatusRetryTimer = setTimeout(() => {
        indexStatusRetryTimer = null;
        refreshProjectIndexStatus();
    }, 2000);
}

async function maybeOfferKnowledgePack(backlog) {
    if (knowledgeOfferChecked) return;
    knowledgeOfferChecked = true;
    if (localStorage.getItem('echomind.knowledgePackDismissed') === '1') return;
    let info = null;
    try {
        info = await rendererApi.get('/api/v1/knowledge/available');
    } catch (_) { return; }
    if (!info || !info.available) return;
    if (backlog < 1000) return;   // 已经建好了就别打扰
    if (document.getElementById('knowledgeOfferCard')) return;
    const card = document.createElement('div');
    card.id = 'knowledgeOfferCard';
    card.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:900;width:380px;'
        + 'background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:12px;'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.18);padding:14px;font-size:12px;line-height:1.6';
    card.innerHTML = ''
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
        + '  <strong style="font-size:13px">检测到内置知识包</strong>'
        + '  <button id="knowledgeOfferClose" style="border:0;background:transparent;cursor:pointer;opacity:.55;font-size:14px">×</button>'
        + '</div>'
        + '<div style="opacity:.8">安装包里有 <b>' + (info.files || 0) + '</b> 条描述/标签/向量（'
        + (info.size_mb || '?') + ' MB）。导入后<b>不用再跑几小时索引</b>，约 1~2 分钟即可搜索。</div>'
        + '<div style="display:flex;gap:8px;margin-top:10px">'
        + '  <button id="knowledgeOfferImport" style="flex:1;padding:6px 8px;border-radius:8px;border:0;background:#6b8afd;color:#fff;cursor:pointer">立即导入</button>'
        + '  <button id="knowledgeOfferLater" style="flex:1;padding:6px 8px;border-radius:8px;border:1px solid var(--border-color);background:transparent;color:var(--text-primary);cursor:pointer">以后再说</button>'
        + '</div>';
    document.body.appendChild(card);
    card.querySelector('#knowledgeOfferClose')?.addEventListener('click', () => card.remove());
    card.querySelector('#knowledgeOfferLater')?.addEventListener('click', () => {
        localStorage.setItem('echomind.knowledgePackDismissed', '1');
        card.remove();
    });
    card.querySelector('#knowledgeOfferImport')?.addEventListener('click', () => {
        card.remove();
        importKnowledgePack(info.path || '');
    });
}

function maybeShowIndexBacklogCard(status, busy, job) {
    const CARD_ID = 'indexBacklogCard';
    const existing = document.getElementById(CARD_ID);
    const audio = status?.artifacts?.audio_vector || {};
    const text = status?.artifacts?.text_vector || {};
    const num = (v) => Number(v || 0);
    const audioBacklog = num(audio.pending) + num(audio.stale);
    const textBacklog = num(text.pending) + num(text.stale);
    const backlog = audioBacklog + textBacklog;
    const dismissed = sessionStorage.getItem('echomind.indexBacklogDismissed') === '1';
    if (busy || backlog < 1000 || dismissed) {
        if (existing) existing.remove();
        return;
    }
    if (existing) return;   // 已经显示着，别重复建

    const textMinutes = Math.max(1, Math.round(textBacklog * 0.03));
    const card = document.createElement('div');
    card.id = CARD_ID;
    card.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:900;width:360px;'
        + 'background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:12px;'
        + 'box-shadow:0 8px 24px rgba(0,0,0,.18);padding:14px;font-size:12px;line-height:1.6';
    card.innerHTML = ''
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">'
        + '  <strong style="font-size:13px">索引还没建完</strong>'
        + '  <button id="indexBacklogClose" style="border:0;background:transparent;cursor:pointer;opacity:.55;font-size:14px">×</button>'
        + '</div>'
        + '<div style="opacity:.8">当前有 <b>' + backlog + '</b> 个文件待处理：'
        + '文本 ' + textBacklog + ' 条' + (textBacklog ? '（约 ' + textMinutes + ' 分钟）' : '')
        + '、音频 ' + audioBacklog + ' 条（耗时取决于音频总时长）。</div>'
        + '<div style="opacity:.65;margin-top:4px">两种向量建议分开跑，别同时开。</div>'
        + '<div style="display:flex;gap:8px;margin-top:10px">'
        + '  <button id="indexBacklogText" style="flex:1;padding:6px 8px;border-radius:8px;border:1px solid var(--border-color);background:transparent;cursor:pointer">修复文本向量</button>'
        + '  <button id="indexBacklogAudio" style="flex:1;padding:6px 8px;border-radius:8px;border:1px solid var(--border-color);background:transparent;cursor:pointer">修复音频向量</button>'
        + '</div>';
    document.body.appendChild(card);
    card.querySelector('#indexBacklogClose')?.addEventListener('click', () => {
        sessionStorage.setItem('echomind.indexBacklogDismissed', '1');
        card.remove();
    });
    card.querySelector('#indexBacklogText')?.addEventListener('click', () => {
        card.remove();
        runProjectIndexAction('reconcile', ['text_vector']);
    });
    card.querySelector('#indexBacklogAudio')?.addEventListener('click', () => {
        card.remove();
        runProjectIndexAction('reconcile', ['audio_vector']);
    });
}

async function refreshProjectIndexStatus(options = {}) {
    // 只有首次加载/手动重试才显示「读取中…」；
    // 例行轮询（每 2 秒）不显示，否则界面会不停闪。
    const label = document.getElementById('indexJobStatus');
    if (options.showPlaceholder && label && !label.textContent) {
        paintIndexStatusLabel('读取中…');
    }
    try {
        const status = await rendererProjects.indexStatus(currentProject?.id || 'default');
        indexStatusFailures = 0;
        if (indexStatusRetryTimer) { clearTimeout(indexStatusRetryTimer); indexStatusRetryTimer = null; }
        const audio = rendererProjects.artifactSummary(status, 'audio_vector');
        const text = rendererProjects.artifactSummary(status, 'text_vector');
        const setNum = (id, value) => {
            const el = document.getElementById(id);
            if (!el) return;
            const next = String(Number(value || 0));
            const changed = el.textContent !== next && el.textContent !== '';
            el.textContent = next;
            if (changed) {
                // 进度在动：闪一下，用户能看出 +1
                el.style.transition = 'color .15s ease';
                el.style.color = '#22c55e';
                setTimeout(() => { el.style.color = ''; }, 500);
            }
        };
        setNum('audioIndexStatus', audio.ready);
        setNum('audioPendingStatus', audio.pending);
        setNum('audioFailedStatus', audio.failed);
        setNum('textIndexStatus', text.ready);
        setNum('textPendingStatus', text.pending);
        setNum('textFailedStatus', text.failed);

        // 「待处理」容易被误解成"需要我点修复索引"：
        // 后台正在跑 → 显示「处理中」；没在跑但有积压 → 「待索引」。
        const busy = indexJobRunning
            || Number(status?.artifacts?.audio_vector?.processing || 0) > 0
            || Number(status?.artifacts?.text_vector?.processing || 0) > 0;
        const job = status?.active_job;
        const pendingLabel = busy ? '处理中' : '待索引';
        ['audioPendingLabel', 'textPendingLabel'].forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.textContent = pendingLabel;
        });

        // 失败数 > 0 标红，提醒需要处理
        ['audioFailedStatus', 'textFailedStatus'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            const failed = Number(el.textContent || 0);
            el.style.color = failed > 0 ? '#ef4444' : '';
            el.style.fontWeight = failed > 0 ? '600' : '';
            el.title = failed > 0 ? '有文件解不出（多为文件损坏）；可在损坏文件里查看' : '';
        });

        // 后台确实在跑 → 数字变绿（表示"正在动"），不额外塞 1641/1641
        ['audioPendingStatus', 'textPendingStatus'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.style.color = busy ? '#22c55e' : '';
            el.style.fontWeight = busy ? '600' : '';
            // 正在算时轻微呼吸动画：不用数字变化也能看出"在动"
            el.style.animation = busy ? 'indexPulse 1.6s ease-in-out infinite' : '';
        });
        const progress = status?.progress || {};
        const encoded = Number(progress.audio || 0) + Number(progress.text || 0);
        const jobDetail = job && Number(job.total) > 0
            ? '（已编码 ' + Number(job.processed || 0) + ' / ' + Number(job.total) + '）'
            : (encoded > 0 ? '（本次已编码 ' + encoded + ' 条）' : '');
        const zh = status?.zh_text || null;
        ['audioPendingStatus', 'textPendingStatus'].forEach((id) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.title = busy
                ? '后台正在处理，无需操作' + jobDetail
                : '还没建立索引；可点常用条的「修复索引」，或等下次启动自动补';
        });
        // 中文语义（BGE）不可用时，明确说出来：否则搜索只剩关键词分，用户以为搜错了
        if (zh && !zh.available) {
            const el = document.getElementById('textPendingStatus');
            if (el) {
                el.title = (el.title ? el.title + '｜' : '')
                    + '中文语义检索不可用：' + (zh.hint || '索引未建立')
                    + '（已建 ' + Number(zh.count || 0) + ' 条）';
            }
        }

        // 有大量待索引时给一张明确的卡片，而不是让它静默躺在数字里（B4）
        maybeShowIndexBacklogCard(status, busy, job);
        // 安装目录带了知识包、库里又基本没索引过 → 提示一键导入
        const _backlog = Number(audio.pending || 0) + Number(text.pending || 0)
            + Number(audio.stale || 0) + Number(text.stale || 0);
        if (!busy && _backlog >= 1000) {
            void maybeOfferKnowledgePack(_backlog);
        }

        // 读成功但当前没有索引任务 → 清掉「读取中…／读取失败」这类临时文案
        const label = document.getElementById('indexJobStatus');
        if (label && !indexJobRunning) {
            const text = label.textContent || '';
            if (text === '读取中…' || text.startsWith('读取失败')) {
                paintIndexStatusLabel('');
            }
        }
        return status;
    } catch (error) {
        indexStatusFailures += 1;
        console.warn('[Index] 读取索引状态失败（第 ' + indexStatusFailures + ' 次）:', error?.message || error);
        if (indexStatusFailures < 3) {
            // 后端重启/大任务期间很常见，先静默重试，不打扰用户
            if (options.showPlaceholder) paintIndexStatusLabel('读取中…');
            scheduleIndexStatusRetry();
        } else {
            paintIndexStatusLabel('读取失败 · 点击重试', {
                retryable: true,
                title: '索引状态读取失败：' + (error?.message || error) + '\n点击重试',
            });
            scheduleIndexStatusRetry();
        }
        return null;
    }
}

async function runProjectIndexAction(mode, kinds) {
    if (indexJobRunning) return;
    indexJobRunning = true;
    const reconcileButton = document.getElementById('reconcileIndexBtn');
    const rebuildButton = document.getElementById('rebuildIndexBtn');
    [reconcileButton, rebuildButton].forEach(button => {
        if (button) button.disabled = true;
    });
    try {
        const scope = Array.isArray(kinds) && kinds.length ? kinds : ['waveform', 'audio_vector', 'text_vector'];
        const job = mode === 'rebuild'
            ? await rendererProjects.rebuildIndex(currentProject.id, scope)
            : await rendererProjects.reconcileIndex(currentProject.id, scope);
        updateIndexJobStatus(job);
        const completed = await rendererProjects.waitForJob(job.job_id, {
            onUpdate: updateIndexJobStatus
        });
        if (completed.state === 'completed') {
            const label = scope.length === 3 ? '索引'
                : scope.includes('audio_vector') ? '音频向量'
                : scope.includes('text_vector') ? '文本向量' : '波形';
            showNotification((mode === 'rebuild' ? label + '重建完成' : label + '修复完成'), 'success');
        } else {
            throw new Error(completed.error_message || `索引任务状态: ${completed.state}`);
        }
    } catch (error) {
        console.error('[Index] 索引任务失败:', error);
        showNotification('索引任务失败: ' + error.message, 'error');
    } finally {
        indexJobRunning = false;
        [reconcileButton, rebuildButton].forEach(button => {
            if (button) button.disabled = false;
        });
        await refreshProjectIndexStatus();
    }
}

