/* 知识包：导入 / 导出 / 增量导出
 *
 * 从 index.html 抽出来的独立模块。依赖由 mount() 注入，避免再和页面里的
 * 上千个全局符号纠缠：
 *   api        -> rendererApi（GET/POST 封装）
 *   notify     -> showNotification(text, type)
 *   getProject -> 返回当前工程 id
 *   onImported -> 导入完成后刷新列表/索引状态（可选）
 */
(function () {
    'use strict';

    const ctx = {
        api: null,
        notify: null,
        getProject: () => 'default',
        onImported: null,
    };

    function setStatus(text) {
        const el = document.getElementById('knowledgePackStatus');
        if (el) el.textContent = text;
    }

    function notify(text, type) {
        if (typeof ctx.notify === 'function') ctx.notify(text, type);
    }

    // 底部固定进度卡片：导入/导出都用它
    function showProgress(title) {
        document.getElementById('packProgressCard')?.remove();
        const card = document.createElement('div');
        card.id = 'packProgressCard';
        card.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:950;width:320px;'
            + 'background:var(--bg-secondary);border:1px solid var(--border-color);border-radius:12px;'
            + 'box-shadow:0 8px 24px rgba(0,0,0,.18);padding:12px 14px;font-size:12px';
        card.innerHTML = ''
            + '<div style="font-weight:600;margin-bottom:6px">' + title + '</div>'
            + '<div style="height:6px;border-radius:3px;background:var(--bg-tertiary);overflow:hidden">'
            + '  <div id="packProgressBar" style="height:100%;width:0%;background:#6b8afd;transition:width .3s"></div>'
            + '</div>'
            + '<div id="packProgressText" style="opacity:.7;margin-top:6px">准备中…</div>';
        document.body.appendChild(card);
        return {
            set(text, ratio) {
                const t = card.querySelector('#packProgressText');
                const b = card.querySelector('#packProgressBar');
                if (t) t.textContent = text;
                if (b && Number.isFinite(ratio)) b.style.width = Math.max(0, Math.min(100, ratio * 100)) + '%';
            },
            close() { card.remove(); },
        };
    }

    const STAGE_LABELS = {
        metadata: '写描述和标签',
        audio_vector: '导入音频向量',
        text_vector: '导入文本向量',
    };
    const EXPORT_LABELS = {
        metadata: '打包描述和标签',
        audio_vector: '导出音频向量',
        text_vector: '导出文本向量',
    };

    async function pollJob(jobId, progress, handlers) {
        for (let i = 0; i < 900; i += 1) {
            await new Promise((r) => setTimeout(r, 1500));
            let job = null;
            try {
                job = await ctx.api.get('/api/v1/jobs/' + encodeURIComponent(jobId));
            } catch (_) {
                continue;
            }
            if (!job) continue;
            if (job.state === 'completed') { handlers.done(job); return; }
            if (job.state === 'failed' || job.state === 'cancelled') { handlers.failed(job); return; }
            const done = Number(job.processed || 0);
            const total = Number(job.total || 0);
            if (handlers.tick) handlers.tick(job, done, total);
            const label = (handlers.labels || STAGE_LABELS)[job.stage] || (job.stage || '处理中');
            progress.set(total > 0 ? label + ' ' + done + '/' + total : label + '…',
                total > 0 ? Math.min(1, done / total) : 0);
        }
        progress.set('仍在后台进行，可在任务列表查看', 0);
        setStatus('仍在后台进行，可在任务列表查看');
    }

    async function importPack(filePath) {
        try {
            setStatus('正在检查知识包…');
            const res = await ctx.api.post(
                '/api/v1/knowledge/import',
                { path: filePath || '', project_id: ctx.getProject() },
                { timeoutMs: 120000 }
            );
            const jobId = res?.job_id;
            if (!jobId) { setStatus('提交失败'); return false; }
            setStatus('已开始：' + (res.files ?? 0) + ' 条，' + (res.size_mb ?? '?') + ' MB');
            notify('开始导入知识包，请稍候（约 1~2 分钟）', 'info');
            const progress = showProgress('正在导入知识包');
            try {
                await pollJob(jobId, progress, {
                    labels: STAGE_LABELS,
                    done: async () => {
                        progress.set('完成', 1);
                        setStatus('✅ 导入完成');
                        notify('知识包导入完成，索引已就绪', 'success');
                        if (typeof ctx.onImported === 'function') await ctx.onImported();
                        setTimeout(() => progress.close(), 1500);
                    },
                    failed: (job) => {
                        const msg = job.error_message || job.stage || '';
                        progress.set('失败：' + msg, 0);
                        setStatus('导入失败: ' + msg);
                        notify('知识包导入失败: ' + msg, 'error');
                        setTimeout(() => progress.close(), 3000);
                    },
                });
            } finally {
                setTimeout(() => progress.close(), 6000);
            }
            return true;
        } catch (error) {
            const message = String(error?.message || error);
            setStatus('导入失败: ' + message);
            if (!/没找到知识包|404/.test(message)) notify('知识包导入失败: ' + message, 'error');
            return false;
        }
    }

    async function pickSavePath(defaultName) {
        const saved = await window.electronAPI?.dialogs?.showSaveDialog({
            title: defaultName.includes('增量') ? '导出增量包' : '导出知识包',
            defaultPath: defaultName,
            filters: [{ name: '知识包', extensions: ['zip'] }],
        });
        return saved?.filePath || saved?.filePaths?.[0] || null;
    }

    async function exportPack(basePackPath) {
        const isDelta = Boolean(basePackPath);
        const outPath = await pickSavePath(isDelta ? 'EchoMind-知识包-增量.zip' : 'EchoMind-知识包.zip');
        if (!outPath) { setStatus('已取消'); return false; }
        setStatus(isDelta ? '正在对比基线…' : '正在导出…');
        const body = { out_path: outPath, project_id: ctx.getProject() };
        if (isDelta) body.base_pack = basePackPath;
        const res = await ctx.api.post('/api/v1/knowledge/export', body, { timeoutMs: 60000 });
        const jobId = res?.job_id;
        if (!jobId) { setStatus('导出提交失败'); return false; }
        const progress = showProgress(isDelta ? '正在导出增量包' : '正在导出知识包');
        try {
            await pollJob(jobId, progress, {
                labels: EXPORT_LABELS,
                done: () => {
                    progress.set('完成', 1);
                    setStatus('✅ 已导出: ' + outPath);
                    notify((isDelta ? '增量包' : '知识包') + '已导出到 ' + outPath, 'success');
                    setTimeout(() => progress.close(), 1500);
                },
                failed: (job) => {
                    const msg = job.error_message || job.stage || '';
                    progress.set('失败：' + msg, 0);
                    setStatus('导出失败: ' + msg);
                    notify((isDelta ? '增量包' : '知识包') + '导出失败: ' + msg, 'error');
                    setTimeout(() => progress.close(), 3000);
                },
            });
        } finally {
            setTimeout(() => progress.close(), 6000);
        }
        return true;
    }

    async function pickZip(title) {
        const picked = await window.electronAPI?.dialogs?.showOpenDialog({
            title,
            filters: [{ name: '知识包', extensions: ['zip'] }],
            properties: ['openFile'],
        });
        return picked?.filePaths?.[0] || picked?.filePath || null;
    }

    function wire() {
        document.getElementById('exportKnowledgePackBtn')?.addEventListener('click', () => {
            exportPack(null).catch((e) => notify('导出失败: ' + (e?.message || e), 'error'));
        });
        document.getElementById('exportDeltaPackBtn')?.addEventListener('click', async () => {
            try {
                const base = await pickZip('选择基线知识包（只导出它里面没有的新文件）');
                if (!base) { setStatus('已取消'); return; }
                await exportPack(base);
            } catch (error) {
                notify('增量包导出失败: ' + (error?.message || error), 'error');
            }
        });
        document.getElementById('importKnowledgePackBtn')?.addEventListener('click', async () => {
            try {
                const filePath = await pickZip('选择知识包（EchoMind-知识包.zip）');
                if (filePath) await importPack(filePath);
            } catch (error) {
                notify('选择知识包失败: ' + (error?.message || error), 'error');
            }
        });
    }

    window.EchoMindKnowledgePack = {
        mount(options) {
            Object.assign(ctx, options || {});
            wire();
            window.importKnowledgePack = importPack;
        },
        importPack,
        exportPack,
        showProgress,
    };
})();
