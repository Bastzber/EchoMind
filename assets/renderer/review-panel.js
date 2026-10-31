/* review-panel.js —— 待归类审阅面板
 * 从 index.html 原样搬出的完整顶层函数。
 */
function topFoldersUnder(root) {
    return [];
}

async function showReviewPanel() {
    document.getElementById('reviewOverlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'reviewOverlay';
    overlay.className = 'fixed inset-0 flex items-center justify-center';
    overlay.style.cssText = 'z-index:330;background:rgba(0,0,0,0.6)';
    overlay.innerHTML = [
        '<div class="rounded-xl shadow-2xl w-[720px] max-h-[86vh] flex flex-col" style="background: var(--bg-secondary); border: 1px solid var(--border-color);">',
        '  <div class="px-4 py-3 border-b flex items-center gap-2" style="border-color: var(--border-color);">',
        '    <span class="text-sm font-semibold">待归类审阅</span>',
        '    <span id="reviewCount" class="text-[11px] opacity-50"></span>',
        '    <input id="reviewSearch" class="ml-auto px-2 py-1 rounded text-xs w-40" style="background: var(--bg-tertiary); border:1px solid var(--border-color); color: var(--text-primary)" placeholder="搜索文件名/描述…">',
        '    <button id="reviewClose" class="text-xs opacity-50 hover:opacity-100">关闭</button>',
        '  </div>',
        '  <div class="px-4 py-2 border-b flex items-center gap-2 text-xs" style="border-color: var(--border-color);">',
        '    <button id="reviewPrev" class="px-2 py-1 rounded border" style="border-color: var(--border-color)">上一个</button>',
        '    <button id="reviewPlay" class="px-2 py-1 rounded border" style="border-color: var(--border-color)">播放 (空格)</button>',
        '    <button id="reviewNext" class="px-2 py-1 rounded border" style="border-color: var(--border-color)">下一个</button>',
        '    <span class="ml-auto opacity-50">选目标目录后回车归类</span>',
        '  </div>',
        '  <div class="px-4 py-2 flex items-center gap-2 text-xs border-b" style="border-color: var(--border-color);">',
        '    <span class="opacity-60">移动到</span>',
        '    <input id="reviewTarget" list="reviewTargetList" class="flex-1 px-2 py-1 rounded text-xs" style="background: var(--bg-tertiary); border:1px solid var(--border-color); color: var(--text-primary)" placeholder="输入或从下拉选已有目录">',
        '    <datalist id="reviewTargetList"></datalist>',
        '    <button id="reviewApply" class="px-3 py-1 rounded text-xs text-white" style="background:#8b5cf6">归类 (回车)</button>',
        '  </div>',
        '  <div id="reviewBody" class="flex-1 overflow-y-auto p-2 min-h-0"></div>',
        '</div>'
    ].join('');
    document.body.appendChild(overlay);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.querySelector('#reviewClose').addEventListener('click', () => overlay.remove());

    const body = overlay.querySelector('#reviewBody');
    const countEl = overlay.querySelector('#reviewCount');
    const targetInput = overlay.querySelector('#reviewTarget');

    const load = async (keyword = '') => {
        body.innerHTML = '<div class="p-4 text-xs opacity-50">读取中…</div>';
        try {
            const data = await rendererApi.get('/api/v1/db/review/unclassified?limit=50&offset=0&keyword=' + encodeURIComponent(keyword));
            reviewState.items = data.items || [];
            reviewState.total = data.total || 0;
            reviewState.index = 0;
            countEl.textContent = '共 ' + reviewState.total + ' 个待归类';
            renderList();
        } catch (error) {
            body.innerHTML = '<div class="p-4 text-xs text-red-400">读取失败：' + (error?.message || error) + '</div>';
        }
    };

    const renderList = () => {
        body.innerHTML = '';
        reviewState.items.forEach((item, idx) => {
            const row = document.createElement('button');
            row.className = 'w-full text-left px-3 py-1.5 rounded text-xs flex items-center gap-2 hover:bg-white/10';
            row.style.background = idx === reviewState.index ? 'rgba(107,138,253,0.14)' : 'transparent';
            row.innerHTML = '<span class="opacity-40" style="width:28px">' + (idx + 1) + '</span>'
                + '<span class="truncate" style="max-width:300px">' + (item.filename || '') + '</span>'
                + '<span class="opacity-40 truncate" style="max-width:260px">' + (item.path || '').replace(/^.*_待归类[\\/]?/, '') + '</span>';
            row.addEventListener('click', () => {
                reviewState.index = idx;
                renderList();
                playCurrent();
            });
            body.appendChild(row);
        });
    };

    const current = () => reviewState.items[reviewState.index];

    const playCurrent = async () => {
        const item = current();
        if (!item) return;
        try {
            const src = 'soundmind-audio://local/' + encodeURIComponent(item.path);
            if (!audioPlayer) initAudioPlayer();
            audioPlayer.src = src;
            audioPlayer.load();
            await audioPlayer.play();
            isPlaying = true;
        } catch (error) {
            showNotification('播放失败: ' + (error?.message || error), 'error');
        }
    };

    const applyCurrent = async () => {
        const item = current();
        const target = targetInput.value.trim();
        if (!item) return;
        if (!target) { showNotification('先填目标文件夹', 'info'); return; }
        try {
            const res = await rendererApi.post('/api/v1/db/review/move', { file_uuid: item.file_uuid, target_dir: target }, { timeoutMs: 60000 });
            showNotification('已归类：' + (res?.filename || item.filename), 'success');
            reviewState.items.splice(reviewState.index, 1);
            reviewState.total = Math.max(0, reviewState.total - 1);
            countEl.textContent = '共 ' + reviewState.total + ' 个待归类';
            if (reviewState.index >= reviewState.items.length) reviewState.index = Math.max(0, reviewState.items.length - 1);
            renderList();
        } catch (error) {
            showNotification('归类失败: ' + (error?.message || error), 'error');
        }
    };

    overlay.querySelector('#reviewPrev').addEventListener('click', () => {
        reviewState.index = Math.max(0, reviewState.index - 1);
        renderList();
    });
    overlay.querySelector('#reviewNext').addEventListener('click', () => {
        reviewState.index = Math.min(reviewState.items.length - 1, reviewState.index + 1);
        renderList();
    });
    overlay.querySelector('#reviewPlay').addEventListener('click', playCurrent);
    overlay.querySelector('#reviewApply').addEventListener('click', applyCurrent);
    overlay.querySelector('#reviewSearch').addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') load(e.target.value.trim());
    });
    targetInput.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') applyCurrent();
    });
    overlay.addEventListener('keydown', (e) => {
        if (e.key === ' ') { e.preventDefault(); playCurrent(); }
    });

    // 目标目录候选（库里已有目录，按文件数排序）
    try {
        const targets = await rendererApi.get('/api/v1/db/review/targets');
        const list = overlay.querySelector('#reviewTargetList');
        (targets?.items || []).forEach((item) => {
            const opt = document.createElement('option');
            opt.value = item.path;
            opt.label = item.path + '（' + item.count + '）';
            list.appendChild(opt);
        });
    } catch (error) {
        console.warn('[Review] 读取目标目录失败:', error);
    }

    await load('');
}

