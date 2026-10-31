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

    const titleEl = document.createElement('div');
    titleEl.className = 'text-sm font-medium break-all';
    titleEl.textContent = sound.name || '';
    body.appendChild(titleEl);

    const pathEl = document.createElement('div');
    pathEl.className = 'text-[11px] opacity-40 break-all mt-1 mb-2';
    pathEl.textContent = sound.filePath || '';
    body.appendChild(pathEl);

    // ---- 文件名（会真的改磁盘上的源文件）----
    body.appendChild(detailSectionTitle('文件名'));
    const nameInput = detailInput('detail-name');
    nameInput.value = sound.name || '';
    body.appendChild(nameInput);
    const nameSave = detailSaveButton('重命名文件', null);
    body.appendChild(nameSave);
    const nameHint = document.createElement('div');
    nameHint.className = 'text-[11px] opacity-40 mt-1';
    nameHint.textContent = '会同步改磁盘上的源文件名；扩展名可以省略';
    body.appendChild(nameHint);
    nameSave.addEventListener('click', () => {
        // 两步确认：第二次点击才动磁盘
        if (nameSave.dataset.armed !== '1') {
            nameSave.dataset.armed = '1';
            nameSave.textContent = '再点一次确认重命名';
            nameSave.style.color = '#ef4444';
            setTimeout(() => {
                if (nameSave.dataset.armed !== '1') return;
                delete nameSave.dataset.armed;
                nameSave.textContent = nameSave.dataset.idleText || '重命名文件';
                nameSave.style.color = '';
            }, 5000);
            return;
        }
        delete nameSave.dataset.armed;
        nameSave.textContent = nameSave.dataset.idleText || '重命名文件';
        nameSave.style.color = '';
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

    // ---- 效果器（折叠，放在详情最上方，方便找）----
    const effectSection = document.createElement('div');
    effectSection.id = 'effectPanel';
    effectSection.className = 'mt-4 pt-3 border-t';
    effectSection.style.borderColor = 'var(--border-color)';
    effectSection.innerHTML = [
        '<button class="effect-toggle w-full text-left">',
        '  <span class="flex items-center gap-2">',
        '    <i data-lucide="sliders" class="w-4 h-4 shrink-0" style="color: #8ea7ff;"></i>',
        '    <span class="text-sm font-semibold tracking-wide" style="color: #a9bcff;">效果器</span>',
        '    <span class="text-[10px] opacity-45">混响</span>',
        '    <i data-lucide="chevron-down" class="w-3.5 h-3.5 effect-chevron opacity-50 ml-auto"></i>',
        '  </span>',
        '  <span class="flex items-center gap-1 mt-1 pl-6 text-[10px] opacity-50">',
        '    <span>室内 / 大厅 / 教堂，试听后可导出</span>',
        '    <span class="effect-summary ml-auto"></span>',
        '  </span>',
        '</button>',
        '<div class="effect-body mt-2"></div>'
    ].join('');
    try {
        body.appendChild(effectSection);
    } catch (error) {
        console.warn('[Effect] 面板挂载失败:', error);
    }
    const effectToggle = effectSection.querySelector('.effect-toggle');
    effectToggle.addEventListener('click', () => {
        const bodyEl = effectSection.querySelector('.effect-body');
        const chevron = effectSection.querySelector('.effect-chevron');
        const open = bodyEl.classList.toggle('hidden') === false;
        if (chevron) chevron.style.transform = open ? 'rotate(180deg)' : '';
        if (open) renderEffectPanel(sound);
    });
    // 默认展开：效果器是高频功能，不该需要点两次才能用
    renderEffectPanel(sound);


    // ---- 系统标签（6 维，不进左侧栏）----
    body.appendChild(detailSectionTitle('系统标签'));
    const sysHint = document.createElement('div');
    sysHint.className = 'text-[11px] opacity-40 -mt-1 mb-1';
    sysHint.textContent = '音效自带的属性标签，只在详情里改，不会出现在左侧「我的标签」';
    body.appendChild(sysHint);

    const chipsEl = document.createElement('div');
    chipsEl.className = 'flex flex-wrap gap-1 mb-1';
    body.appendChild(chipsEl);
    const renderChips = () => {
        chipsEl.innerHTML = '';
        const list = Array.isArray(sound.tags) ? sound.tags : [];
        if (!list.length) {
            const none = document.createElement('span');
            none.className = 'text-xs opacity-40';
            none.textContent = '（暂无）';
            chipsEl.appendChild(none);
            return;
        }
        list.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'px-1.5 py-0.5 rounded text-[11px]';
            chip.style.cssText = 'background: var(--bg-tertiary); color: var(--text-secondary);';
            chip.textContent = tag;
            chipsEl.appendChild(chip);
        });
    };
    renderChips();
    const tagsInput = detailInput('detail-tags');
    tagsInput.placeholder = '逗号分隔，如：城市, 环境';
    tagsInput.value = (Array.isArray(sound.tags) ? sound.tags : []).join(', ');
    body.appendChild(tagsInput);
    const tagsSave = detailSaveButton('保存系统标签', null);
    body.appendChild(tagsSave);
    tagsSave.addEventListener('click', () => withButtonFeedback(tagsSave, '保存中…', '✓ 已保存', async () => {
        const nextTags = parseTagsInput(tagsInput.value);
        const previous = Array.isArray(sound.tags) ? sound.tags.slice() : [];
        sound.tags = nextTags;
        renderChips();          // 先把界面改了，别等接口
        try {
            await setSoundTags(sound, nextTags, { silent: true });
        } catch (error) {
            sound.tags = previous;
            renderChips();
            throw error;
        }
    }));

    // ---- 用户标签（我的标签，进左侧栏）----
    body.appendChild(detailSectionTitle('用户标签'));
    const userHint = document.createElement('div');
    userHint.className = 'text-[11px] opacity-40 -mt-1 mb-1';
    userHint.textContent = '你自己的分类标签，会出现在左侧「我的标签」；不进系统标签';
    body.appendChild(userHint);

    const userChips = document.createElement('div');
    userChips.className = 'flex flex-wrap gap-1 mb-1';
    body.appendChild(userChips);
    let userTagNames = [];
    const renderUserChips = () => {
        userChips.innerHTML = '';
        if (!userTagNames.length) {
            const none = document.createElement('span');
            none.className = 'text-xs opacity-40';
            none.textContent = '（暂无）';
            userChips.appendChild(none);
            return;
        }
        userTagNames.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'px-1.5 py-0.5 rounded text-[11px]';
            chip.style.cssText = 'background: rgba(107,138,253,0.16); color: var(--text-primary);';
            chip.textContent = tag;
            userChips.appendChild(chip);
        });
    };

    const userInput = detailInput('detail-user-tags');
    userInput.placeholder = '逗号分隔，如：常用, 片头';
    body.appendChild(userInput);
    const userSave = detailSaveButton('保存用户标签', null);
    body.appendChild(userSave);

    const fileUuid = sound.fileId || sound.file_uuid || '';
    const reloadUserTags = async () => {
        if (!fileUuid) { renderUserChips(); return; }
        try {
            const data = await rendererApi.get('/api/v1/files/' + encodeURIComponent(fileUuid) + '/user-tags');
            userTagNames = Array.isArray(data?.names) ? data.names : [];
        } catch (_) {
            userTagNames = [];
        }
        renderUserChips();
        userInput.value = userTagNames.join(', ');
    };
    renderUserChips();
    reloadUserTags();

    userSave.addEventListener('click', () => withButtonFeedback(userSave, '保存中…', '✓ 已保存', async () => {
        if (!fileUuid) throw new Error('这个音效还没有入库记录');
        const names = parseTagsInput(userInput.value);
        await rendererApi.post('/api/v1/files/' + encodeURIComponent(fileUuid) + '/tags',
            { names, tag_ids: [] }, { timeoutMs: 60000 });
        userTagNames = names;
        renderUserChips();
        if (typeof rememberEvent === 'function') rememberEvent('usage', sound, '用户标签');
        await loadTagStats();
        renderFolderTree();
    }));

    // ---- 一句话描述 ----
    body.appendChild(detailSectionTitle('一句话描述'));
    const descInput = document.createElement('textarea');
    descInput.rows = 3;
    descInput.className = 'w-full px-2 py-1 rounded border text-xs leading-5';
    descInput.style.cssText = 'background: var(--bg-tertiary); border-color: var(--border-color); color: var(--text-primary);';
    descInput.placeholder = '一句话说清这是什么声音';
    descInput.value = String(sound.aiDescription || '').replace(/^\[auto\]/, '');
    body.appendChild(descInput);
    const descSave = detailSaveButton('保存描述', null);
    body.appendChild(descSave);
    descSave.addEventListener('click', () => withButtonFeedback(descSave, '保存中…', '✓ 已保存', async () => {
        const text = descInput.value.trim().slice(0, 500);
        const previous = sound.aiDescription || '';
        sound.aiDescription = text;
        renderSoundList();      // 列表里的描述立刻跟着变
        try {
            await saveSoundDescription(sound, text);
            if (typeof rememberEvent === 'function') rememberEvent('usage', sound, '改描述');
        } catch (error) {
            sound.aiDescription = previous;
            renderSoundList();
            throw error;
        }
    }));

    // ---- 文件信息 ----
    const attrs = document.createElement('div');
    attrs.className = 'mt-4 pt-3 border-t';
    attrs.style.borderColor = 'var(--border-color)';
    // match() 返回数组，直接 .replace 会炸；这里统一转成字符串
    const rawExt = sound.type
        || ((sound.name || '').match(/\.[^.]+$/) || [''])[0]
        || '';
    const ext = String(rawExt).replace('.', '').toUpperCase();
    const seconds = Number(sound.duration) > 0 ? (Number(sound.duration) / 1000).toFixed(2) + ' 秒' : '';
    const khz = Number(sound.sampleRate) > 0 ? (Number(sound.sampleRate) / 1000).toFixed(Number(sound.sampleRate) % 1000 === 0 ? 0 : 1) + ' kHz' : '';
    attrs.appendChild(detailRow('格式', ext));
    attrs.appendChild(detailRow('时长', seconds));
    attrs.appendChild(detailRow('采样率', khz));
    attrs.appendChild(detailRow('声道', sound.channels));
    attrs.appendChild(detailRow('大小', Number(sound.size) > 0 ? formatBytes(Number(sound.size)) : ''));
    attrs.appendChild(detailRow('来源', sound.source === 'ai' ? 'AI 生成' : '用户导入'));
    body.appendChild(attrs);

    if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
}

