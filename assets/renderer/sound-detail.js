/* sound-detail.js —— 音效详情面板
 * 从 index.html 原样搬出的完整顶层函数。
 */
function setDetailPanelOpen(open) {
    detailPanelOpen = Boolean(open);
    const aside = document.getElementById('detailAside');
    const btn = document.getElementById('detailToggleBtn');
    if (aside) {
        aside.classList.toggle('hidden', !detailPanelOpen);
        aside.classList.toggle('flex', detailPanelOpen);
    }
    if (btn) {
        btn.style.opacity = detailPanelOpen ? '1' : '0.6';
        btn.style.background = detailPanelOpen ? 'var(--bg-tertiary)' : 'transparent';
    }
    if (detailPanelOpen) renderSoundDetail(currentSound || null);
}

function detailRow(label, value) {
    const row = document.createElement('div');
    row.className = 'flex items-start gap-3 py-1';
    const key = document.createElement('div');
    key.className = 'w-14 shrink-0 text-xs opacity-50';
    key.textContent = label;
    const val = document.createElement('div');
    val.className = 'flex-1 min-w-0 text-xs break-all';
    val.textContent = (value === null || value === undefined || value === '') ? '—' : String(value);
    row.appendChild(key);
    row.appendChild(val);
    return row;
}

function detailSectionTitle(text) {
    const el = document.createElement('div');
    el.className = 'text-xs font-medium opacity-70 mt-3 mb-1';
    el.textContent = text;
    return el;
}

function detailInput(className) {
    const el = document.createElement('input');
    el.type = 'text';
    el.className = 'w-full h-7 px-2 rounded border text-xs ' + (className || '');
    el.style.cssText = 'background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary);';
    return el;
}

function detailSaveButton(text, onClick) {
    const btn = document.createElement('button');
    btn.className = 'mt-1 px-2 py-1 rounded text-xs border hover:bg-white/5';
    btn.style.borderColor = 'var(--border-color)';
    btn.textContent = text;
    btn.dataset.idleText = text;
    if (onClick) btn.addEventListener('click', onClick);
    return btn;
}

async function withButtonFeedback(button, busyText, successText, task) {
    if (button.dataset.busy === '1') return;
    button.dataset.busy = '1';
    button.disabled = true;
    button.style.opacity = '0.55';
    button.textContent = busyText;
    button.style.color = '';
    button.style.borderColor = '';
    try {
        await task();
        button.textContent = successText;
        button.style.color = '#22c55e';
        button.style.borderColor = '#22c55e';
    } catch (error) {
        button.textContent = '保存失败，再点重试';
        button.style.color = '#ef4444';
        button.style.borderColor = '#ef4444';
        showNotification('保存失败: ' + (error?.message || error), 'error');
    } finally {
        delete button.dataset.busy;
        button.disabled = false;
        button.style.opacity = '';
        setTimeout(() => {
            button.textContent = button.dataset.idleText || '保存';
            button.style.color = '';
            button.style.borderColor = '';
        }, 2200);
    }
}

// 保存成功后，把列表里那条数据同步成最新值再重绘。
// 之前只改内存对象 + renderSoundList()，但列表的数据源是分页加载的 soundData，
// sound 偶尔不是里面同一个引用（重新分页/筛选后换过对象），于是界面看着没更新。
// 这里直接按 id 覆盖 soundData 里对应的那条，再重绘，不管引用关系都能对上。
function syncSoundToList(sound, patch) {
    if (!sound || !sound.id) return;
    Object.assign(sound, patch || {});
    try {
        if (Array.isArray(soundData)) {
            const hit = soundData.find((item) => item && item.id === sound.id);
            if (hit && hit !== sound) Object.assign(hit, patch || {});
        }
    } catch (_e) { /* soundData 不可用时忽略 */ }
    // tags 变化时只更新那一行（补4）；其它字段仍走全量重绘
    const onlyTags = Object.keys(patch || {}).every((key) => key === 'tags');
    if (onlyTags && typeof updateSoundRowTags === 'function' && updateSoundRowTags(sound)) {
        if (typeof renderCategoryTree === 'function') renderCategoryTree();
        return;
    }
    if (typeof renderSoundList === 'function') renderSoundList();
    if (typeof renderCategoryTree === 'function') renderCategoryTree();
}

async function saveSoundDescription(sound, value) {
    const text = String(value || '').trim().slice(0, 500);
    await rendererApi.post(
        '/api/v1/files/' + encodeURIComponent(sound.id) + '/description',
        { description: text }
    );
    return text;
}

async function renameSoundViaBackend(sound, newName) {
    const next = String(newName || '').trim();
    const problem = rendererRename.validateName(next);
    if (problem) throw new Error(problem);
    const data = await postBatchRename([{ file_uuid: sound.id, new_name: next }], { dry_run: false });
    const result = (data && data.results && data.results[0]) || null;
    if (!result || !result.ok) throw new Error((result && result.message) || '重命名失败');
    rendererRename.applyResults([sound], [result]);
    return result;
}

function renderSoundDetail(sound) {
    const body = document.getElementById('detailBody');
    if (!body) return;
    body.innerHTML = '';

    if (!sound) {
        const empty = document.createElement('div');
        empty.className = 'text-xs opacity-40 leading-6';
        empty.textContent = '选中一条音效，这里会显示它的标签、一句话描述和文件信息。';
        body.appendChild(empty);
        return;
    }

    const fileUuid = sound.fileId || sound.file_uuid || '';
    const original = {
        description: String(sound.aiDescription || '').replace(/^\[auto\]/, ''),
        sysTags: (Array.isArray(sound.tags) ? sound.tags.slice() : []),
        userTags: [],
    };
    let userTagNames = [];

    // ---------- 顶部分页 ----------
    const tabsEl = document.createElement('div');
    tabsEl.className = 'detail-tabs';
    const TABS = [['overview', '概览'], ['edit', '标签与描述'], ['fx', '效果器']];
    let activeTab = 'overview';
    const tabButtons = {};
    TABS.forEach(([key, label]) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'detail-tab';
        b.textContent = label;
        b.addEventListener('click', () => switchTab(key));
        tabButtons[key] = b;
        tabsEl.appendChild(b);
    });
    body.appendChild(tabsEl);

    const paneOverview = document.createElement('div');
    paneOverview.className = 'detail-pane';
    const paneEdit = document.createElement('div');
    paneEdit.className = 'detail-pane hidden';
    const paneFx = document.createElement('div');
    paneFx.className = 'detail-pane hidden';
    body.appendChild(paneOverview);
    body.appendChild(paneEdit);
    body.appendChild(paneFx);

    const foot = document.createElement('div');
    foot.className = 'detail-foot';
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'detail-btn';
    undoBtn.textContent = '撤销改动';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'detail-btn detail-btn-pri';
    saveBtn.textContent = '没有待保存的改动';
    saveBtn.disabled = true;
    foot.appendChild(undoBtn);
    foot.appendChild(saveBtn);
    body.appendChild(foot);

    function switchTab(key) {
        activeTab = key;
        Object.entries(tabButtons).forEach(([k, b]) => b.classList.toggle('on', k === key));
        paneOverview.classList.toggle('hidden', key !== 'overview');
        paneEdit.classList.toggle('hidden', key !== 'edit');
        paneFx.classList.toggle('hidden', key !== 'fx');
        foot.classList.toggle('hidden', key === 'fx');
        if (key === 'fx' && typeof renderEffectPanel === 'function') renderEffectPanel(sound);
    }

    // ---------- 概览 ----------
    const titleEl = document.createElement('div');
    titleEl.className = 'text-sm font-medium break-all';
    titleEl.textContent = sound.name || '';
    paneOverview.appendChild(titleEl);

    const pathEl = document.createElement('div');
    pathEl.className = 'text-[11px] opacity-40 break-all mt-1 mb-2';
    pathEl.textContent = sound.filePath || '';
    paneOverview.appendChild(pathEl);

    const meta = document.createElement('div');
    meta.className = 'detail-kv-grid';
    const durSec = Number(sound.duration || 0) / 1000;
    const ext = String(sound.name || '').split('.').pop().toUpperCase();
    const fmtDur = (sec) => {
        const m = Math.floor(sec / 60);
        const r = Math.round(sec % 60);
        return String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0');
    };
    [["时长", durSec ? fmtDur(durSec) : '—'], ["格式", ext || '—'],
     ["标签", String(original.sysTags.length) + ' 个系统'], ["索引", '已完成']].forEach(([k, v]) => {
        const cell = document.createElement('div');
        cell.className = 'detail-kv';
        cell.innerHTML = '<span class="k"></span><span class="v"></span>';
        cell.querySelector('.k').textContent = k;
        cell.querySelector('.v').textContent = v;
        meta.appendChild(cell);
    });
    paneOverview.appendChild(meta);

    // 描述（只读，去编辑入口）
    const descHead = document.createElement('div');
    descHead.className = 'detail-sec-line';
    descHead.innerHTML = '<span>一句话描述</span><span class="detail-link">去编辑 ›</span>';
    descHead.querySelector('.detail-link').addEventListener('click', () => switchTab('edit'));
    paneOverview.appendChild(descHead);
    const descView = document.createElement('div');
    descView.className = 'detail-desc-view';
    descView.textContent = original.description || '（还没有描述）';
    paneOverview.appendChild(descView);
    const descViewHint = document.createElement('div');
    descViewHint.className = 'detail-hint';
    descViewHint.textContent = '这里只读，点右上「去编辑」或切到「标签与描述」页改';
    paneOverview.appendChild(descViewHint);

    // 文件名（动磁盘，独立两步确认）
    paneOverview.appendChild(detailSectionTitle('文件名'));
    const nameInput = detailInput('detail-name');
    nameInput.value = sound.name || '';
    paneOverview.appendChild(nameInput);
    const nameSave = detailSaveButton('重命名文件', null);
    nameSave.className = 'detail-btn detail-btn-danger';
    paneOverview.appendChild(nameSave);
    const nameHint = document.createElement('div');
    nameHint.className = 'detail-hint';
    nameHint.textContent = '改名会真的动磁盘；它不在「保存改动」里，单独提交';
    paneOverview.appendChild(nameHint);
    nameSave.addEventListener('click', () => {
        if (nameSave.dataset.armed !== '1') {
            nameSave.dataset.armed = '1';
            nameSave.textContent = '再点一次确认重命名';
            setTimeout(() => {
                if (nameSave.dataset.armed !== '1') return;
                delete nameSave.dataset.armed;
                nameSave.textContent = '重命名文件';
            }, 5000);
            return;
        }
        delete nameSave.dataset.armed;
        nameSave.textContent = '重命名文件';
        const next = nameInput.value.trim();
        if (!next || next === sound.name) {
            showNotification('文件名没有变化', 'info');
            return;
        }
        withButtonFeedback(nameSave, '重命名中…', '✓ 已重命名', async () => {
            await renameSoundViaBackend(sound, next);
            if (typeof rememberEvent === 'function') rememberEvent('usage', sound, '重命名');
            titleEl.textContent = sound.name || '';
            pathEl.textContent = sound.filePath || '';
            nameInput.value = sound.name || '';
            renderSoundList();
        });
    });

    // ---------- 标签与描述（唯一编辑处）----------
    const editTitle = document.createElement('div');
    editTitle.className = 'text-sm font-medium break-all';
    editTitle.textContent = sound.name || '';
    paneEdit.appendChild(editTitle);
    const editHint = document.createElement('div');
    editHint.className = 'detail-hint';
    editHint.style.marginBottom = '10px';
    editHint.textContent = '全界面只有这一处能改描述和标签，底部一次提交';
    paneEdit.appendChild(editHint);

    paneEdit.appendChild(detailSectionTitle('一句话描述'));
    const descInput = document.createElement('textarea');
    descInput.rows = 3;
    descInput.className = 'detail-textarea';
    descInput.placeholder = '一句话说清这是什么声音';
    descInput.value = original.description;
    paneEdit.appendChild(descInput);

    // 系统标签
    paneEdit.appendChild(detailSectionTitle('系统标签'));
    const sysHint = document.createElement('div');
    sysHint.className = 'detail-hint';
    sysHint.textContent = 'AI 自动打，只在详情里改，不进左侧「我的标签」';
    paneEdit.appendChild(sysHint);
    const chipsEl = document.createElement('div');
    chipsEl.className = 'detail-chips';
    paneEdit.appendChild(chipsEl);
    let sysTags = original.sysTags.slice();
    const renderChips = () => {
        chipsEl.innerHTML = '';
        if (!sysTags.length) {
            const none = document.createElement('span');
            none.className = 'text-xs opacity-40';
            none.textContent = '（暂无）';
            chipsEl.appendChild(none);
            return;
        }
        sysTags.forEach((tag, idx) => {
            const chip = document.createElement('span');
            chip.className = 'detail-chip detail-chip-sys';
            chip.innerHTML = '<span></span><span class="x">✕</span>';
            chip.querySelector('span').textContent = tag;
            chip.querySelector('.x').addEventListener('click', () => {
                sysTags.splice(idx, 1);
                sysInput.value = sysTags.join(', ');
                renderChips();
                updateDirty();
            });
            chipsEl.appendChild(chip);
        });
    };
    renderChips();
    const sysInput = detailInput('detail-tags');
    sysInput.placeholder = '逗号分隔，如：城市, 环境';
    sysInput.value = sysTags.join(', ');
    sysInput.addEventListener('input', () => {
        sysTags = parseTagsInput(sysInput.value);
        renderChips();
        updateDirty();
    });
    paneEdit.appendChild(sysInput);

    // 我的标签
    paneEdit.appendChild(detailSectionTitle('我的标签'));
    const userHint = document.createElement('div');
    userHint.className = 'detail-hint';
    userHint.textContent = '你自己的分类，会出现在左侧「我的标签」';
    paneEdit.appendChild(userHint);
    const userChips = document.createElement('div');
    userChips.className = 'detail-chips';
    paneEdit.appendChild(userChips);
    const renderUserChips = () => {
        userChips.innerHTML = '';
        if (!userTagNames.length) {
            const none = document.createElement('span');
            none.className = 'text-xs opacity-40';
            none.textContent = '（暂无）';
            userChips.appendChild(none);
            return;
        }
        userTagNames.forEach((tag, idx) => {
            const chip = document.createElement('span');
            chip.className = 'detail-chip detail-chip-mine';
            chip.innerHTML = '<span></span><span class="x">✕</span>';
            chip.querySelector('span').textContent = tag;
            chip.querySelector('.x').addEventListener('click', () => {
                userTagNames.splice(idx, 1);
                userInput.value = userTagNames.join(', ');
                renderUserChips();
                updateDirty();
            });
            userChips.appendChild(chip);
        });
    };
    renderUserChips();
    const userInput = detailInput('detail-user-tags');
    userInput.placeholder = '逗号分隔，如：常用, 片头';
    userInput.addEventListener('input', () => {
        userTagNames = parseTagsInput(userInput.value);
        renderUserChips();
        updateDirty();
    });
    paneEdit.appendChild(userInput);

    const reloadUserTags = async () => {
        if (!fileUuid) { renderUserChips(); return; }
        try {
            const data = await rendererApi.get('/api/v1/files/' + encodeURIComponent(fileUuid) + '/user-tags');
            userTagNames = Array.isArray(data?.names) ? data.names : [];
        } catch (_) {
            userTagNames = [];
        }
        original.userTags = userTagNames.slice();
        renderUserChips();
        userInput.value = userTagNames.join(', ');
        updateDirty();
    };
    reloadUserTags();

    // ---------- 脏值与保存 ----------
    function sameList(a, b) {
        if (a.length !== b.length) return false;
        return a.every((x, i) => String(x) === String(b[i]));
    }
    function dirtyParts() {
        const parts = [];
        const descNow = descInput.value.trim();
        if (descNow !== original.description.trim()) parts.push('描述 1');
        if (!sameList(sysTags, original.sysTags)) parts.push('系统标签 ' + (sysTags.length + original.sysTags.length - sameList(sysTags, original.sysTags) * 0));
        if (!sameList(userTagNames, original.userTags)) parts.push('我的标签');
        return parts;
    }
    function updateDirty() {
        const parts = dirtyParts();
        if (!parts.length) {
            saveBtn.disabled = true;
            saveBtn.textContent = '没有待保存的改动';
            undoBtn.disabled = true;
            return;
        }
        saveBtn.disabled = false;
        saveBtn.textContent = '保存改动（' + parts.join(' · ') + '）';
        undoBtn.disabled = false;
    }
    descInput.addEventListener('input', updateDirty);
    updateDirty();

    undoBtn.addEventListener('click', () => {
        descInput.value = original.description;
        sysTags = original.sysTags.slice();
        sysInput.value = sysTags.join(', ');
        renderChips();
        userTagNames = (original.userTags || []).slice();
        userInput.value = userTagNames.join(', ');
        renderUserChips();
        updateDirty();
    });

    saveBtn.addEventListener('click', () => {
        if (saveBtn.disabled) return;
        withButtonFeedback(saveBtn, '保存中…', '✓ 已保存', async () => {
            const prevDesc = sound.aiDescription || '';
            const prevTags = Array.isArray(sound.tags) ? sound.tags.slice() : [];
            const prevUser = (original.userTags || []).slice();
            const nextDesc = descInput.value.trim().slice(0, 500);
            const nextSys = sysTags.slice();
            const nextUser = userTagNames.slice();
            const descChanged = nextDesc !== prevDesc.replace(/^\[auto\]/, '').trim();
            try {
                if (descChanged) {
                    sound.aiDescription = nextDesc;
                    await saveSoundDescription(sound, nextDesc);
                }
                if (!sameList(nextSys, prevTags)) {
                    sound.tags = nextSys;
                    await setSoundTags(sound, nextSys, { silent: true });
                }
                if (!sameList(nextUser, prevUser) && fileUuid) {
                    await rendererApi.post('/api/v1/files/' + encodeURIComponent(fileUuid) + '/tags',
                        { names: nextUser, tag_ids: [] }, { timeoutMs: 60000 });
                }
                original.description = nextDesc;
                original.sysTags = nextSys.slice();
                original.userTags = nextUser.slice();
                descView.textContent = nextDesc || '（还没有描述）';
                syncSoundToList(sound, { aiDescription: nextDesc, tags: nextSys });
                renderSoundList();
                if (typeof rememberEvent === 'function') rememberEvent('usage', sound, '改标签');
                if (typeof loadTagStats === 'function') await loadTagStats();
                if (typeof renderFolderTree === 'function') renderFolderTree();
                updateDirty();
            } catch (error) {
                sound.aiDescription = prevDesc;
                sound.tags = prevTags;
                syncSoundToList(sound, { aiDescription: prevDesc, tags: prevTags });
                throw error;
            }
        });
    });

    // ---------- 效果器 ----------
    // renderEffectPanel 认的是 #effectPanel 里的 .effect-body，所以这里要把骨架搭全
    const effectSection = document.createElement('div');
    effectSection.id = 'effectPanel';
    effectSection.className = 'effect-host';
    effectSection.innerHTML = [
        '<div class="flex items-center gap-2 mb-1">',
        '  <i data-lucide="sliders" class="w-4 h-4 shrink-0" style="color:#8ea7ff"></i>',
        '  <span class="text-sm font-semibold" style="color:#a9bcff">混响</span>',
        '  <span class="text-[11px] opacity-50">室内 / 大厅 / 教堂，试听后可导出</span>',
        '  <span class="effect-summary ml-auto text-[11px] opacity-50"></span>',
        '</div>',
        '<div class="text-[11px] opacity-45 mb-2">选一个预设试听，觉得合适再导出成新文件；不改动源文件</div>',
        '<div class="effect-body"></div>'
    ].join('');
    paneFx.appendChild(effectSection);
    try {
        if (typeof renderEffectPanel === 'function') renderEffectPanel(sound);
        if (typeof refreshLucideIcons === 'function') refreshLucideIcons();
        else if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
    } catch (error) {
        console.warn('[Effect] 面板挂载失败:', error);
    }

    switchTab('overview');
}
