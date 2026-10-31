/* duplicates.js —— 重复音效检测（同 sha256 分组合并展示）
 * 从 index.html 原样抽出，仍是全局函数 showDuplicatesModal()，调用方无需改动。
 */
async function showDuplicatesModal() {
    document.getElementById('dupModal')?.remove();
    const box = document.createElement('div');
    box.id = 'dupModal';
    box.className = 'fixed inset-0 z-[300] flex items-center justify-center';
    box.style.background = 'rgba(0,0,0,0.55)';
    box.innerHTML = `<div class="w-[820px] max-h-[82vh] flex flex-col rounded-xl" style="background: var(--bg-secondary); border: 1px solid var(--border-color);">
        <div class="flex items-center justify-between px-5 py-3 border-b" style="border-color: var(--border-color);">
            <div class="text-base font-medium">重复音效检测</div>
            <button id="dupClose" class="p-1 rounded hover:bg-white/10">✕</button>
        </div>
        <div id="dupBody" class="p-4 overflow-y-auto text-sm opacity-70">正在扫描…</div>
    </div>`;
    document.body.appendChild(box);
    box.querySelector('#dupClose').addEventListener('click', () => box.remove());
    box.addEventListener('click', (e) => { if (e.target === box) box.remove(); });

    const body = box.querySelector('#dupBody');
    let groups = [];
    let processedGroups = 0;
    let processedFiles = 0;
    let summaryEl = null;

    const updateSummary = () => {
        if (!summaryEl) return;
        const totalFiles = groups.reduce((sum, group) => sum + group.files.length, 0);
        const wasted = groups.reduce((sum, group) => sum + (group.files.length - 1) * Number(group.files[0]?.size || 0), 0);
        summaryEl.innerHTML = `发现 <b>${groups.length}</b> 组重复，共 <b>${totalFiles}</b> 个文件，约浪费 <b>${(wasted / 1024 / 1024).toFixed(1)} MB</b>`
            + (groups.length >= 20000 ? '　<span style="color:#f59e0b;">（已达 20000 组上限，处理完后重新扫描可看到剩余的）</span>' : '')
            + (processedGroups ? `　<span style="color:#22c55e;">已处理 ${processedGroups} 组 / ${processedFiles} 个副本</span>` : '');
    };

    // 删完之后把列表收成"只剩保留下来的那一份"，避免还显示已经被删的路径
    const keepOnlyRow = (card, keepPath, originalCount) => {
        const rows = [...card.querySelectorAll('.dup-panel label')];
        rows.forEach((row) => {
            const span = row.querySelector('span');
            const isKeep = span && span.textContent === keepPath;
            if (!isKeep) {
                row.remove();
                return;
            }
            const radio = row.querySelector('input[type="radio"]');
            if (radio) {
                radio.disabled = true;
                radio.checked = true;
            }
            row.style.opacity = '1';
        });
        const head = card.querySelector('.dup-head-title');
        const save = card.querySelector('.dup-save');
        if (head) head.textContent = `第 ${card.dataset.index ? Number(card.dataset.index) + 1 : ''} 组 · 已保留 1 份（原有 ${originalCount} 个）`;
        if (save) save.textContent = '可省 0 MB';
    };

    const markProcessed = (card, text, files, groupCount = 1, backupDir = '', extra = {}) => {
        const alreadyDone = card.dataset.done === '1';
        card.dataset.done = '1';
        if (!alreadyDone) {
            processedGroups += groupCount;
            processedFiles += files;
        }
        const status = card.querySelector('.dup-status');
        if (status) {
            status.textContent = text;
            status.style.color = '#22c55e';
        }
        card.querySelectorAll('button.dup-action').forEach((button) => {
            button.disabled = true;
            button.style.opacity = '0.35';
            button.style.pointerEvents = 'none';
        });
        card.querySelector('.dup-aftercare')?.remove();

        // 处理完之后给两个出口：打开备份目录 / 重新处理
        const aftercare = document.createElement('div');
        aftercare.className = 'dup-aftercare flex items-center gap-2 mt-1 flex-wrap';
        if (backupDir) {
            const openBtn = document.createElement('button');
            openBtn.className = 'px-2 py-1 rounded text-xs border';
            openBtn.style.borderColor = 'var(--border-color)';
            openBtn.textContent = '打开备份目录';
            openBtn.addEventListener('click', () => {
                try { window.electronAPI?.fileImport?.revealInExplorer?.(backupDir); } catch (_) { }
            });
            aftercare.appendChild(openBtn);
        }
        // 备份是"复制"，原文件还在 —— 听完确认后可以真正删掉这些副本
        if (extra.manifest && Array.isArray(extra.dups) && extra.dups.length) {
            const delBtn = document.createElement('button');
            delBtn.className = 'px-2 py-1 rounded text-xs text-white';
            delBtn.style.background = '#b91c1c';
            delBtn.textContent = `删除源目录里的 ${extra.dups.length} 个副本（备份保留）`;
            delBtn.title = '把重复的副本从原文件夹移入回收站；备份目录里的文件不动';
            delBtn.addEventListener('click', async () => {
                if (!confirm(`保留「${extra.keepName || '第一个'}」，把源目录里这 ${extra.dups.length} 个副本移入回收站？\n\n备份目录（${backupDir}）里的文件不会动，随时可以撤回。`)) return;
                const result = await resolveDuplicates(extra.dups, 'source');
                if (result && !result.failed) {
                    if (extra.keepPath) keepOnlyRow(card, extra.keepPath, extra.originalCount || extra.dups.length + 1);
                    const badge = card.querySelector('.dup-status');
                    if (badge) badge.textContent = `已删除 ${extra.dups.length} 个副本（备份仍在，可撤回）`;
                }
            });
            aftercare.appendChild(delBtn);

            if (Array.isArray(extra.allPaths) && extra.allPaths.length) {
                const delAllBtn = document.createElement('button');
                delAllBtn.className = 'px-2 py-1 rounded text-xs text-white';
                delAllBtn.style.background = '#7f1d1d';
                delAllBtn.textContent = `整组删除源文件（含保留的，备份保留）`;
                delAllBtn.title = '把这一组的所有源文件移入回收站；备份目录里的文件不动';
                delAllBtn.addEventListener('click', async () => {
                    if (!confirm(`把这一组全部 ${extra.allPaths.length} 个源文件移入回收站（包括保留的那一份）？\n\n备份目录（${backupDir}）里的文件不会动，随时可以撤回。`)) return;
                    const result = await resolveDuplicates(extra.allPaths, 'source');
                    if (result && !result.failed) {
                        card.querySelectorAll('.dup-panel label').forEach(row => row.remove());
                        const head = card.querySelector('.dup-head-title');
                        const save = card.querySelector('.dup-save');
                        if (head) head.textContent = `第 ${Number(card.dataset.index) + 1} 组 · 已整组删除（原有 ${extra.allPaths.length} 个）`;
                        if (save) save.textContent = '可省 0 MB';
                        const badge = card.querySelector('.dup-status');
                        if (badge) badge.textContent = `已整组删除 ${extra.allPaths.length} 个（备份仍在，可撤回）`;
                    }
                });
                aftercare.appendChild(delAllBtn);
            }

            const undoBtn = document.createElement('button');
            undoBtn.className = 'px-2 py-1 rounded text-xs border';
            undoBtn.style.borderColor = 'var(--border-color)';
            undoBtn.textContent = '撤回备份';
            undoBtn.addEventListener('click', () => restoreBackup(extra.manifest));
            aftercare.appendChild(undoBtn);
        }
        const retryBtn = document.createElement('button');
        retryBtn.className = 'px-2 py-1 rounded text-xs border';
        retryBtn.style.borderColor = 'var(--border-color)';
        retryBtn.textContent = '重新处理';
        retryBtn.addEventListener('click', () => {
            card.dataset.done = '';
            card.querySelectorAll('button.dup-action').forEach((button) => {
                button.disabled = false;
                button.style.opacity = '';
                button.style.pointerEvents = '';
            });
            const badge = card.querySelector('.dup-status');
            if (badge) { badge.textContent = ''; badge.style.color = ''; }
            aftercare.remove();
        });
        aftercare.appendChild(retryBtn);
        card.appendChild(aftercare);
        updateSummary();
    };

    try {
        // 哈希没算完，重复检测就查不全 —— 先看看还剩多少
        try {
            const hashStatus = await rendererApi.get('/api/v1/index/hash', { timeoutMs: 30000 });
            if (hashStatus && hashStatus.pending > 0) {
                const hint = document.createElement('div');
                hint.className = 'mb-3 p-2 rounded-md text-xs';
                hint.style.cssText = 'background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.4);';
                hint.innerHTML = `还有 <b>${hashStatus.pending}</b> / ${hashStatus.total} 个文件没算内容哈希，
                    它们暂时不会出现在重复列表里。<span class="opacity-70">（刚导入或从回收站还原的文件需要先算哈希）</span>`;
                const startBtn = document.createElement('button');
                startBtn.className = 'ml-2 px-2 py-1 rounded text-xs text-white';
                startBtn.style.background = '#f59e0b';
                startBtn.textContent = '立即计算';
                startBtn.addEventListener('click', async () => {
                    startBtn.disabled = true;
                    startBtn.textContent = '计算中…';
                    await rendererApi.post('/api/v1/index/hash?project_id=' + encodeURIComponent(currentProject?.id || 'default'), {}, { timeoutMs: 60000 }).catch(() => { });
                    const poll = async () => {
                        const status = await rendererApi.get('/api/v1/index/hash', { timeoutMs: 30000 }).catch(() => null);
                        if (!status) return;
                        startBtn.textContent = `计算中… ${status.done}/${status.total}`;
                        if (status.pending > 0) {
                            setTimeout(poll, 3000);
                        } else {
                            hint.innerHTML = '哈希已算完，正在重新检测…';
                            setTimeout(() => { box.remove(); showDuplicatesModal(); }, 600);
                        }
                    };
                    setTimeout(poll, 1500);
                });
                hint.appendChild(startBtn);
                body.appendChild(hint);
            }
        } catch (_) { /* 拿不到进度就照常检测 */ }

        const data = await rendererApi.get('/api/v1/duplicates?limit=20000', { timeoutMs: 240000 });
        groups = (data && data.groups) || [];

        body.innerHTML = '';
        summaryEl = document.createElement('div');
        summaryEl.className = 'mb-2';
        body.appendChild(summaryEl);
        updateSummary();

        const toolbar = document.createElement('div');
        toolbar.className = 'flex items-center gap-2 mb-3';
        const expandAll = document.createElement('button');
        expandAll.className = 'px-2 py-1 rounded text-xs border';
        expandAll.style.borderColor = 'var(--border-color)';
        expandAll.textContent = '全部展开';
        const collapseAll = document.createElement('button');
        collapseAll.className = 'px-2 py-1 rounded text-xs border';
        collapseAll.style.borderColor = 'var(--border-color)';
        collapseAll.textContent = '全部收起';
        const rescanBtn = document.createElement('button');
        rescanBtn.className = 'px-2 py-1 rounded text-xs border';
        rescanBtn.style.borderColor = 'var(--border-color)';
        rescanBtn.textContent = '补录磁盘上的文件';
        rescanBtn.title = '扫描库目录，把磁盘上有、库里没有的音频（比如从回收站还原的）重新加进来';
        rescanBtn.addEventListener('click', () => rescanLibraryInto(button => rescanBtn.disabled = button));
        toolbar.appendChild(rescanBtn);

        const repairBtn = document.createElement('button');
        repairBtn.className = 'px-2 py-1 rounded text-xs border';
        repairBtn.style.borderColor = 'var(--border-color)';
        repairBtn.textContent = '修复路径';
        repairBtn.title = '在磁盘上改了文件夹名/移了位置后，按"同名同大小"把库里的路径修正回来';
        repairBtn.addEventListener('click', () => repairLibraryPaths(repairBtn));
        toolbar.appendChild(repairBtn);

        const ignoredBtn = document.createElement('button');
        ignoredBtn.className = 'px-2 py-1 rounded text-xs border';
        ignoredBtn.style.borderColor = 'var(--border-color)';
        ignoredBtn.textContent = '已忽略的组';
        ignoredBtn.addEventListener('click', () => showIgnoredDuplicates());
        toolbar.appendChild(ignoredBtn);

        const hint = document.createElement('span');
        hint.className = 'text-xs opacity-50 ml-auto';
        hint.textContent = '点每组标题展开/收起，行前的圆点决定保留哪一份';
        toolbar.append(expandAll, collapseAll, hint);
        body.appendChild(toolbar);

        const progressBox = document.createElement('div');
        progressBox.id = 'dupProgress';
        progressBox.className = 'hidden mb-2 px-1 py-1 rounded';
        progressBox.style.cssText = 'position: sticky; top: 0; z-index: 5; background: var(--bg-secondary); border: 1px solid var(--border-color);';
        progressBox.innerHTML = `<div class="flex items-center justify-between text-xs mb-1">
                <span class="dup-progress-text opacity-70"></span>
                <span class="dup-progress-pct opacity-50"></span>
            </div>
            <div style="height:4px;background:var(--bg-tertiary);border-radius:2px;overflow:hidden;">
                <div class="dup-progress-bar" style="height:100%;width:0%;background:#22c55e;transition:width .15s ease;"></div>
            </div>`;
        body.appendChild(progressBox);

        const toggleCard = (card, open) => {
            const panel = card.querySelector('.dup-panel');
            const arrow = card.querySelector('.dup-arrow');
            if (!panel) return;
            const next = open === undefined ? panel.style.display === 'none' : open;
            panel.style.display = next ? 'block' : 'none';
            if (arrow) arrow.style.transform = next ? 'rotate(90deg)' : '';
        };

        expandAll.addEventListener('click', () => body.querySelectorAll('[data-dup-card]').forEach(card => toggleCard(card, true)));
        collapseAll.addEventListener('click', () => body.querySelectorAll('[data-dup-card]').forEach(card => toggleCard(card, false)));

        if (!groups.length) {
            const empty = document.createElement('div');
            empty.className = 'py-6 text-center';
            empty.innerHTML = `<div class="text-sm opacity-70 mb-2">没有发现重复音效（按 sha256 内容哈希比对）</div>
                <div class="text-xs opacity-50 leading-6">如果刚从回收站还原过文件，或手动往库目录里拷过音效，<br>点上面的「补录磁盘上的文件」把它们找回来。</div>`;
            body.appendChild(empty);
            return;
        }

        groups.forEach((group, index) => {
            const sizeMb = (Number(group.files[0]?.size || 0) * (group.files.length - 1) / 1024 / 1024).toFixed(2);
            const card = document.createElement('div');
            card.className = 'mb-2 rounded-md overflow-hidden';
            card.style.background = 'var(--bg-tertiary)';
            card.dataset.dupCard = '1';
            card.dataset.index = String(index);
            group.__index = index;

            const header = document.createElement('button');
            header.className = 'w-full px-2 py-2 flex items-center gap-2 text-left hover:bg-white/5';
            header.innerHTML = `<span class="dup-arrow inline-block transition-transform" style="width:10px;">▶</span>
                <span class="dup-head-title text-xs font-medium">第 ${index + 1} 组 · ${group.files.length} 个同内容文件</span>
                <span class="dup-save text-xs opacity-50">可省 ${sizeMb} MB</span>
                <span class="dup-status text-xs ml-auto"></span>`;

            const panel = document.createElement('div');
            panel.className = 'dup-panel px-2 pb-2';
            panel.style.display = 'none';

            // 内容懒加载：700+ 组时如果一开始就把每行都建出来会很卡，
            // 展开哪组才建哪组。
            let built = false;
            const buildBody = () => {
                if (built) return;
                built = true;
                const radioName = 'dupKeep-' + index;
                group.files.forEach((file, i) => {
                    const row = document.createElement('label');
                    row.className = 'flex items-start gap-2 text-xs py-0.5 cursor-pointer hover:bg-white/5 rounded px-1';
                    const radio = document.createElement('input');
                    radio.type = 'radio';
                    radio.name = radioName;
                    radio.checked = i === preferredKeepIndex(group.files);
                    radio.className = 'mt-0.5 shrink-0';
                    const text = document.createElement('span');
                    text.className = 'truncate';
                    text.textContent = file.path;
                    row.appendChild(radio);
                    row.appendChild(text);
                    panel.appendChild(row);
                });

                const pickedFiles = () => {
                    const radios = [...panel.querySelectorAll('input[type="radio"]')];
                    const at = radios.findIndex(radio => radio.checked);
                    const keep = group.files[at >= 0 ? at : 0];
                    return {
                        keep,
                        keepName: String(keep.path || '').split(/[\\\\/]/).pop() || '第一个文件',
                        dups: group.files.filter(file => file.path !== keep.path).map(file => file.path),
                    };
                };

                const actions = document.createElement('div');
                actions.className = 'mt-1 flex flex-wrap items-center gap-2';
                const makeBtn = (label, bg, handler) => {
                    const button = document.createElement('button');
                    button.className = 'dup-action px-2 py-1 rounded text-xs text-white';
                    button.style.background = bg;
                    button.textContent = label;
                    button.addEventListener('click', () => handler(button));
                    actions.appendChild(button);
                };
                makeBtn('保留选中的，删库记录', '#ef4444', async () => {
                    const { keep, keepName, dups } = pickedFiles();
                    if (!dups.length) return;
                    if (!confirm(`保留「${keepName}」，删掉其余 ${dups.length} 条库记录？（磁盘文件保留）`)) return;
                    const result = await resolveDuplicates(dups, 'records');
                    if (result && !result.failed) {
                        keepOnlyRow(card, keep.path, group.files.length);
                        markProcessed(card, `已处理：保留「${keepName}」，删了 ${dups.length} 条记录`, dups.length);
                    }
                });
                makeBtn('保留选中的，删源文件（回收站）', '#b91c1c', async () => {
                    const { keep, keepName, dups } = pickedFiles();
                    if (!dups.length) return;
                    if (!confirm(`保留「${keepName}」，把其余 ${dups.length} 个源文件移入回收站？`)) return;
                    const result = await resolveDuplicates(dups, 'source');
                    if (result && !result.failed) {
                        keepOnlyRow(card, keep.path, group.files.length);
                        markProcessed(card, `已处理：保留「${keepName}」，${dups.length} 个源文件进回收站`, dups.length);
                    }
                });
                makeBtn('保留选中的，其余移到备份…', '#0ea5e9', async () => {
                    const { keep, keepName, dups } = pickedFiles();
                    if (!dups.length) return;
                    const picked = await pickBackupFolder();
                    if (!picked) return;
                    const result = await resolveDuplicates(dups, 'backup', picked);
                    if (result && !result.failed) {
                        markProcessed(
                            card,
                            `已备份 ${result.moved} 个副本（原文件仍在，可先试听再决定）`,
                            dups.length, 1, picked,
                            {
                                manifest: result.manifest, dups, keepName,
                                keepPath: keep.path, originalCount: group.files.length,
                                allPaths: group.files.map(file => file.path),
                            }
                        );
                    }
                });
                makeBtn('保留选中的，其余分类转成标签后删源文件', '#0369a1', async () => {
                    const { keep, keepName, dups } = pickedFiles();
                    if (!dups.length) return;
                    if (!confirm(`保留「${keepName}」，把其余 ${dups.length} 个副本所在的目录名转成它的标签，然后把这些副本移入回收站？\n\n这样分类信息不丢，但磁盘上只留一份。`)) return;
                    try {
                        const result = await rendererApi.post(
                            '/api/v1/duplicates/merge-tags?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
                            { keep_path: keep.path, paths: dups, delete_source: true },
                            { timeoutMs: 300000 }
                        );
                        keepOnlyRow(card, keep.path, group.files.length);
                        markProcessed(
                            card,
                            `已合并：保留 1 份，删 ${result.removed || dups.length} 个副本，新增标签 ${(result.tags_added || []).join('、') || '无'}`,
                            dups.length
                        );
                        loadTagStats().catch(() => { });
                    } catch (error) {
                        showNotification('合并失败: ' + (error?.message || error), 'error');
                    }
                });
                makeBtn('这一组要保留在多个分类（忽略）', '#475569', async () => {
                    if (!confirm(`同一个音效归到多个分类目录是正常的，把这个组加入忽略名单？\n\n以后重复检测不再提示它（不会删任何文件）。`)) return;
                    try {
                        await rendererApi.post(
                            '/api/v1/duplicates/ignore?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
                            { sha256: group.sha256, note: '' },
                            { timeoutMs: 30000 }
                        );
                        card.remove();
                        showNotification('已忽略这一组（可在「已忽略」里恢复）', 'success');
                    } catch (error) {
                        showNotification('忽略失败: ' + (error?.message || error), 'error');
                    }
                });
                makeBtn('整组删除（含保留的那份）', '#7f1d1d', async () => {
                    const paths = group.files.map(file => file.path);
                    if (!confirm(`把这一组的 ${paths.length} 个文件全部移入回收站，并从库中移除？\n\n适合"整组都是静音/无效文件"的情况。`)) return;
                    const result = await resolveDuplicates(paths, 'source');
                    if (result && !result.failed) {
                        panel.querySelectorAll('label').forEach(row => row.remove());
                        const head = card.querySelector('.dup-head-title');
                        const save = card.querySelector('.dup-save');
                        if (head) head.textContent = `第 ${index + 1} 组 · 已整组删除（原有 ${paths.length} 个）`;
                        if (save) save.textContent = '可省 0 MB';
                        markProcessed(card, `已整组删除 ${paths.length} 个文件（回收站可还原）`, paths.length);
                    }
                });
                panel.appendChild(actions);
            };

            header.addEventListener('click', () => {
                const opening = panel.style.display === 'none';
                if (opening) buildBody();
                toggleCard(card);
            });

            card.appendChild(header);
            card.appendChild(panel);
            body.appendChild(card);
        });

        const allPaths = groups.flatMap(group => splitGroupByPreference(group).dups);
        const globalBar = document.createElement('div');
        globalBar.className = 'mt-4 pt-3 border-t flex flex-wrap items-center gap-2';
        globalBar.style.borderColor = 'var(--border-color)';
        const tip = document.createElement('span');
        tip.className = 'text-xs opacity-60 mr-auto';
        tip.textContent = `全部 ${groups.length} 组、${allPaths.length} 个多余副本（每组保留优先项）：`;
        globalBar.appendChild(tip);
        const markAll = (files, count) => {
            body.querySelectorAll('[data-dup-card]').forEach((card) => {
                if (card.dataset.done === '1') return;
                markProcessed(card, '已按优先项处理', files, count || 1);
            });
        };
        // 保留优先：中文名 / 原始顺序
        const prefBtn = document.createElement('button');
        prefBtn.className = 'px-2 py-1 rounded text-xs border';
        prefBtn.style.borderColor = 'var(--border-color)';
        prefBtn.title = '决定每组默认保留哪一份：中文名优先，或按原始顺序';
        const syncPrefLabel = () => {
            prefBtn.textContent = '保留优先：' + (duplicateKeepPreference === 'cjk' ? '中文名 ✓' : '原始顺序');
        };
        syncPrefLabel();
        prefBtn.addEventListener('click', () => {
            duplicateKeepPreference = duplicateKeepPreference === 'cjk' ? 'original' : 'cjk';
            syncPrefLabel();
            body.querySelectorAll('[data-dup-card]').forEach((card) => {
                const index = Number(card.dataset.index);
                const group = groups.find(item => item.__index === index);
                if (!group) return;
                const radios = [...card.querySelectorAll('input[type="radio"]')];
                if (!radios.length) return;
                const at = preferredKeepIndex(group.files);
                radios.forEach((radio, i) => { radio.checked = i === at; });
            });
            showNotification('保留优先已切换为「' + (duplicateKeepPreference === 'cjk' ? '中文名' : '原始顺序') + '」', 'success');
        });
        globalBar.appendChild(prefBtn);
        const globalBtn = (label, bg, handler) => {
            const button = document.createElement('button');
            button.className = 'px-2 py-1 rounded text-xs text-white';
            button.style.background = bg;
            button.textContent = label;
            button.addEventListener('click', () => handler(button));
            globalBar.appendChild(button);
        };
        globalBtn('全部：每组保留优先项，删库记录', '#ef4444', async () => {
            if (!confirm(`每组保留优先项，其余 ${allPaths.length} 个只删库记录？（磁盘文件保留）`)) return;
            const ok = await resolveDuplicates(allPaths, 'records');
            if (ok) markAll(allPaths.length);
        });
        globalBtn('全部：每组保留优先项，删源文件', '#b91c1c', async () => {
            if (!confirm(`每组保留优先项，把其余 ${allPaths.length} 个源文件移入回收站？`)) return;
            const ok = await resolveDuplicates(allPaths, 'source');
            if (ok) markAll(allPaths.length);
        });
        globalBtn('全部：每组保留优先项，其余移到备份…', '#0ea5e9', async () => {
            const picked = await pickBackupFolder();
            if (!picked) return;
            const ok = await resolveDuplicates(allPaths, 'backup', picked);
            if (ok) markAll(allPaths.length);
        });

        // 批量：每组保留优先项，其余目录名转成标签后删源文件（治本，防库臃肿）
        globalBtn('全部：保留优先项，其余分类转成标签后删除', '#0369a1', async () => {
            const totalCopies = groups.reduce((sum, group) => sum + Math.max(0, group.files.length - 1), 0);
            if (!totalCopies) return;
            if (!confirm(`对全部 ${groups.length} 组执行：每组保留优先项，把其余 ${totalCopies} 个副本所在的目录名转成标签，然后把副本移入回收站？\n\n处理后每个音效只留一份物理文件，分类信息以标签形式保留。`)) return;

            const progressBox = document.getElementById('dupProgress');
            const bar = progressBox?.querySelector('.dup-progress-bar');
            const text = progressBox?.querySelector('.dup-progress-text');
            const pctEl = progressBox?.querySelector('.dup-progress-pct');
            if (progressBox) progressBox.classList.remove('hidden');

            let done = 0;
            let removed = 0;
            let failed = 0;
            const tagPool = new Set();
            for (const group of groups) {
                const { keep, dups } = splitGroupByPreference(group);
                if (!dups.length) continue;
                try {
                    const result = await rendererApi.post(
                        '/api/v1/duplicates/merge-tags?project_id=' + encodeURIComponent(currentProject?.id || 'default'),
                        { keep_path: keep.path, paths: dups, delete_source: true },
                        { timeoutMs: 300000 }
                    );
                    removed += Number(result?.removed || 0);
                    (result?.tags_added || []).forEach(tag => tagPool.add(tag));
                    const card = body.querySelector('[data-dup-card][data-index="' + group.__index + '"]');
                    if (card) {
                        card.querySelector('button')?.click();
                        keepOnlyRow(card, keep.path, group.files.length);
                        markProcessed(card, `已合并：保留 1 份，新增标签 ${(result?.tags_added || []).join('、') || '无'}`, dups.length);
                    }
                } catch (error) {
                    failed += 1;
                    console.warn('[Dedupe] 合并失败:', keep.path, error);
                }
                done += 1;
                const pct = Math.round(done / groups.length * 100);
                if (bar) bar.style.width = pct + '%';
                if (text) text.textContent = `正在合并… ${done} / ${groups.length} 组`;
                if (pctEl) pctEl.textContent = pct + '%';
            }
            showNotification(
                `合并完成：${groups.length} 组，删除 ${removed} 个副本`
                + (failed ? `，${failed} 组失败` : '')
                + `；新增标签 ${tagPool.size} 个`,
                failed ? 'warning' : 'success'
            );
            loadTagStats().catch(() => { });
            loadFilesFromDatabase({ reset: true }).catch(() => { });
            loadFolderStats(true).catch(() => { });
            setTimeout(() => progressBox?.classList.add('hidden'), 1500);
        });

        // 整组全删：连每组保留的那一份也删掉（适合整组都是静音/无效文件）
        globalBtn('全部：整组删除（含保留的那份）', '#7f1d1d', async () => {
            const everything = groups.flatMap(group => group.files.map(file => file.path));
            if (!everything.length) return;
            if (!confirm(`把全部 ${groups.length} 组、共 ${everything.length} 个文件的源文件移入回收站，并从库中移除？\n\n这会连每组保留的那一份一起删掉，只适合"整组都是静音/无效文件"。`)) return;
            if (!confirm(`再确认一次：真的要删除 ${everything.length} 个文件吗？（回收站可还原）`)) return;
            const result = await resolveDuplicates(everything, 'source');
            if (result && !result.failed) {
                body.querySelectorAll('[data-dup-card]').forEach((card) => {
                    const rows = [...card.querySelectorAll('.dup-panel label')];
                    const count = rows.length || Number((card.querySelector('.dup-head-title')?.textContent || '').match(/·\s*(\d+)\s*个/)?.[1] || 0);
                    rows.forEach(row => row.remove());
                    const head = card.querySelector('.dup-head-title');
                    const save = card.querySelector('.dup-save');
                    if (head) head.textContent = `第 ${Number(card.dataset.index) + 1} 组 · 已整组删除`;
                    if (save) save.textContent = '可省 0 MB';
                    if (card.dataset.done !== '1') markProcessed(card, '已整组删除', count);
                    else markProcessed(card, '已整组删除', 0);
                });
            }
        });
        body.appendChild(globalBar);

        const undoBar = document.createElement('div');
        undoBar.className = 'mt-2 text-xs opacity-60 flex items-center gap-2';
        const undoText = document.createElement('span');
        undoText.textContent = '备份是复制，原文件不动；想反悔就点这里把备份还原回原目录：';
        const undoLatest = document.createElement('button');
        undoLatest.className = 'px-2 py-1 rounded text-xs border';
        undoLatest.style.borderColor = 'var(--border-color)';
        undoLatest.textContent = '撤回最近一次备份';
        undoLatest.addEventListener('click', async () => {
            if (!confirm('把最近一次备份的文件还原回原来的目录？（原位置已有文件的会跳过）')) return;
            await restoreBackup('');
        });
        undoBar.append(undoText, undoLatest);
        body.appendChild(undoBar);
    } catch (error) {
        body.textContent = '扫描失败: ' + error.message;
    }
}
