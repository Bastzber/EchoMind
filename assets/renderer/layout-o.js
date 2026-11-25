/* layout-o.js —— 主界面 O 排法的改造（全部是渐进增强，不动任何已有 id / 行为）
 *
 * 做三件事：
 * 1. 「常用工具条」默认收起，顶部一条「工具 ▾」抽屉头；状态记 localStorage，Ctrl+T 也能切
 * 2. 左栏每个板块（文件夹 / 标签 / 场景 / 历史 …）的标题可以点，点了收起/展开，状态各自记住
 * 3. 抽屉展开时给按钮加分组标签（日常 / 修数据 / AI）——标签由 app-core.js 渲染时插
 *
 * 为什么写成独立文件而不是改 index.html 的既有结构：
 * 这两个板块（#quickBar、[data-panel]）都已经被别处的 JS 依赖（拖拽分界、浮动面板、
 * 面板高度记忆），改结构容易连环炸；只在外面包一层、用 caret 控制高度，风险小得多。
 */
(function layoutO() {
    'use strict';

    var DRAWER_KEY = 'echomind.toolDrawer.open';
    var PANEL_KEY = 'echomind.layoutO.panels';

    function readPanelState() {
        try { return JSON.parse(localStorage.getItem(PANEL_KEY) || '{}') || {}; } catch (e) { return {}; }
    }
    function savePanelState(state) {
        try { localStorage.setItem(PANEL_KEY, JSON.stringify(state)); } catch (e) { /* 存不下就只影响记忆 */ }
    }

    // ---------- 1. 工具抽屉 ----------
    function setupDrawer() {
        var bar = document.getElementById('quickBar');
        var toggle = document.getElementById('toolDrawerToggle');
        var caret = document.getElementById('toolDrawerCaret');
        if (!bar || !toggle) return;

        var open = false;
        try { open = localStorage.getItem(DRAWER_KEY) === '1'; } catch (e) { open = false; }

        function apply(next) {
            open = next;
            bar.style.display = open ? '' : 'none';
            if (caret) caret.textContent = open ? '▴' : '▾';
            try { localStorage.setItem(DRAWER_KEY, open ? '1' : '0'); } catch (e) { /* 忽略 */ }
        }

        toggle.addEventListener('click', function (event) {
            event.stopPropagation();
            apply(!open);
        });
        document.addEventListener('keydown', function (event) {
            if (!(event.ctrlKey || event.metaKey) || String(event.key).toLowerCase() !== 't') return;
            var tag = (event.target.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || event.target.isContentEditable) return;
            event.preventDefault();
            apply(!open);
        });
        apply(open);
    }

    // ---------- 2. 左栏板块折叠 ----------
    function setupPanels() {
        var state = readPanelState();
        var panels = document.querySelectorAll('#leftAside [data-panel]');
        panels.forEach(function (panel, index) {
            var body = panel.querySelector('[data-panel-body]') || panel.querySelector('.overflow-y-auto');
            var header = panel.querySelector(':scope > div');
            if (!body || !header || header.dataset.collapsible === '1') return;
            header.dataset.collapsible = '1';

            var key = panel.getAttribute('data-panel') || ('panel' + index);
            // 折角放到标题最左边（放最右边会被「＋ / 浮动」按钮挤掉，看不见）
            var caret = document.createElement('span');
            caret.className = 'layout-o-caret';
            caret.style.cssText = 'font-size:12px;line-height:1;opacity:.6;margin-right:6px;cursor:pointer;user-select:none';
            var titleBox = header.firstElementChild || header;
            titleBox.insertBefore(caret, titleBox.firstElementChild);

            var saved = state[key];
            var collapsed = saved === true;

            function apply() {
                body.style.display = collapsed ? 'none' : '';
                caret.textContent = collapsed ? '▸' : '▾';
                // 板块本身的高度也一起放掉，否则收起后还留着一条空白
                if (panel.style.height) {
                    panel.dataset.fullHeight = panel.dataset.fullHeight || panel.style.height;
                    panel.style.height = collapsed ? 'auto' : (panel.dataset.fullHeight || '');
                }
            }

            function toggle(event) {
                // 标题里的按钮（＋、浮动、帮助点）不触发折叠
                if (event && event.target && event.target.closest && event.target.closest('button, .help-dot, input')) return;
                collapsed = !collapsed;
                state[key] = collapsed;
                savePanelState(state);
                apply();
            }

            header.style.cursor = 'pointer';
            header.addEventListener('click', toggle);
            apply();
        });
    }

    // 标签面板加一个刷新按钮：以前标签树只在启动时加载一次，数据变了界面也不动
    function addTagRefreshButton() {
        const panel = document.getElementById('tagPanelSection');
        if (!panel || document.getElementById('tagRefreshBtn')) return;
        const header = panel.querySelector(':scope > div');
        if (!header) return;
        const btn = document.createElement('button');
        btn.id = 'tagRefreshBtn';
        btn.title = '刷新标签计数';
        btn.style.cssText = 'margin-left:8px;padding:2px 6px;border-radius:6px;border:1px solid var(--border-color);'
            + 'background:transparent;color:var(--text-secondary);font-size:11px;cursor:pointer';
        btn.textContent = '刷新';
        btn.addEventListener('click', async (event) => {
            event.stopPropagation();
            btn.textContent = '…';
            try {
                if (typeof refreshTagTree === 'function') await refreshTagTree();
                else if (typeof loadTagStats === 'function') await loadTagStats();
                if (typeof renderCategoryTree === 'function') renderCategoryTree();
                btn.textContent = '刷新';
            } catch (error) {
                btn.textContent = '刷新';
                if (typeof showNotification === 'function') showNotification('刷新标签失败: ' + (error?.message || error), 'error');
            }
        });
        header.appendChild(btn);
    }

    function boot() {
        setupDrawer();
        setupPanels();
        addTagRefreshButton();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
