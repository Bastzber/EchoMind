/* history.js —— 搜索历史
 * 从 index.html 原样搬出的完整顶层函数。
 */
function readHistory(kind) {
    try {
        const raw = localStorage.getItem('echomind.history.' + kind);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch (_) {
        return [];
    }
}

function writeHistory(kind, list) {
    try {
        localStorage.setItem('echomind.history.' + kind, JSON.stringify(list.slice(0, HISTORY_LIMIT[kind] || 50)));
    } catch (_) { }
}

function rememberSearch(query) {
    const text = String(query || '').trim();
    if (!text) return;
    const list = readHistory('search').filter(item => item !== text);
    list.unshift(text);
    writeHistory('search', list);
    renderSearchHistoryMenu();
}

function rememberEvent(kind, sound, label) {
    if (!sound) return;
    const path = sound.filePath || sound.path || '';
    if (!path) return;
    const entry = {
        path,
        name: sound.name || (path.split(/[\\/]/).pop() || ''),
        fileId: sound.fileId || null,
        at: Date.now(),
        label: label || '',
    };
    const list = readHistory(kind).filter(item => item.path !== path);
    list.unshift(entry);
    writeHistory(kind, list);
    renderHistoryPanels();
}

function formatHistoryTime(ts) {
    const diff = Date.now() - Number(ts || 0);
    if (!Number.isFinite(diff) || diff < 0) return '';
    const minute = 60000, hour = 3600000, day = 86400000;
    if (diff < minute) return '刚刚';
    if (diff < hour) return Math.floor(diff / minute) + ' 分钟前';
    if (diff < day) return Math.floor(diff / hour) + ' 小时前';
    return Math.floor(diff / day) + ' 天前';
}

function renderSearchHistoryMenu(filterText) {
    const menu = document.getElementById('searchHistoryMenu');
    if (!menu) return;
    const keyword = String(filterText || '').trim().toLowerCase();
    let items = readHistory('search');
    if (keyword) {
        items = items.filter(item => String(item).toLowerCase().includes(keyword));
    }
    menu.innerHTML = '';
    if (!items.length) {
        menu.classList.add('hidden');
        return;
    }
    const header = document.createElement('div');
    header.className = 'px-3 py-1 text-[10px] opacity-40 flex items-center justify-between';
    header.innerHTML = '<span>最近搜索</span>';
    const clear = document.createElement('button');
    clear.className = 'text-[10px] opacity-60 hover:opacity-100';
    clear.textContent = '清空';
    clear.addEventListener('mousedown', (event) => {
        event.preventDefault();
        writeHistory('search', []);
        renderSearchHistoryMenu();
    });
    header.appendChild(clear);
    menu.appendChild(header);

    const chipBox = document.createElement('div');
    chipBox.className = 'flex flex-wrap gap-1.5 px-2 pb-2';
    menu.appendChild(chipBox);
    items.slice(0, 24).forEach((text) => {
        const row = document.createElement('button');
        row.className = 'px-2 py-1 text-xs rounded border whitespace-nowrap hover:bg-white/10';
        row.style.borderColor = 'var(--border-color)';
        row.style.maxWidth = '220px';
        row.style.overflow = 'hidden';
        row.style.textOverflow = 'ellipsis';
        row.textContent = text;
        row.addEventListener('mousedown', (event) => {
            event.preventDefault();
            const input = document.getElementById('searchInput');
            if (input) input.value = text;
            menu.classList.add('hidden');
            if (typeof runKeywordSearch === 'function') runKeywordSearch();
        });
        chipBox.appendChild(row);
    });
    menu.classList.remove('hidden');
}

function renderHistoryPanels() {
    const panels = document.getElementById('historyPanels');
    if (!panels) return;
    panels.querySelectorAll('.history-block').forEach((block) => {
        const kind = block.dataset.kind;
        const list = readHistory(kind);
        const countEl = block.querySelector('.history-count');
        if (countEl) countEl.textContent = list.length ? String(list.length) : '';
        const listEl = block.querySelector('.history-list');
        if (!listEl) return;
        listEl.innerHTML = '';
        if (!list.length) {
            const empty = document.createElement('div');
            empty.className = 'text-[11px] opacity-40 py-1 px-1';
            empty.textContent = kind === 'play' ? '还没有播放过音效' : '还没有操作记录';
            listEl.appendChild(empty);
            return;
        }
        list.slice(0, 20).forEach((entry) => {
            const row = document.createElement('button');
            row.className = 'block w-full text-left px-1.5 py-1 rounded text-[11px] hover:bg-white/10 truncate';
            const prefix = entry.label ? entry.label + ' · ' : '';
            row.textContent = prefix + entry.name + '　' + formatHistoryTime(entry.at);
            row.title = entry.path;
            row.addEventListener('click', () => {
                const target = soundData.find(item => item.filePath === entry.path);
                if (target) {
                    if (kind === 'play' && typeof selectAndPlaySound === 'function') selectAndPlaySound(target);
                    else if (typeof selectSound === 'function') selectSound(target);
                } else {
                    showNotification('这个音效已不在当前列表（可能换过文件夹）', 'info');
                }
            });
            row.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                if (!confirm('清空「' + (kind === 'play' ? '历史播放记录' : '历史使用记录') + '」？')) return;
                writeHistory(kind, []);
                renderHistoryPanels();
            });
            listEl.appendChild(row);
        });
    });
}

function bindHistoryPanels() {
    const panels = document.getElementById('historyPanels');
    if (!panels) return;
    panels.querySelectorAll('.history-toggle').forEach((button) => {
        button.addEventListener('click', () => {
            const block = button.closest('.history-block');
            const listEl = block?.querySelector('.history-list');
            const chevron = block?.querySelector('.history-chevron');
            if (!listEl) return;
            const open = listEl.classList.toggle('hidden') === false;
            if (chevron) chevron.style.transform = open ? 'rotate(90deg)' : '';
        });
    });
    renderHistoryPanels();

    const input = document.getElementById('searchInput');
    const menu = document.getElementById('searchHistoryMenu');
    if (input && menu) {
        const show = () => renderSearchHistoryMenu(input.value);
        input.addEventListener('focus', () => { if (!input.value.trim()) show(); });
        input.addEventListener('input', () => {
            if (!input.value.trim()) renderSearchHistoryMenu('');
            else menu.classList.add('hidden');
        });
        input.addEventListener('blur', () => setTimeout(() => menu.classList.add('hidden'), 120));
    }
}

