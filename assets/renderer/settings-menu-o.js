/* settings-menu-o.js —— 设置菜单（B 布局 + 临时文件右侧详情）
 * 只做交互补丁：不动任何原有 id 和事件，只负责
 *   1) 「临时文件」一行悬停/点击展开右侧详情面板
 *   2) 语言分段控件的高亮同步
 *   3) 图标重绘
 */
(function () {
    'use strict';

    function panelFor(row) {
        const id = row && row.dataset && row.dataset.panel;
        return id ? document.getElementById(id) : null;
    }

    function showPanel(row, show) {
        const panel = panelFor(row);
        if (!panel) return;
        // 设置菜单贴着窗口右缘，详情一律往左展开（CSS 里已定位 right:100%）
        panel.classList.toggle('hidden', !show);
        if (show && typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
    }

    function syncLang() {
        const seg = document.querySelectorAll('#settingsDropdown .om-seg-item');
        if (!seg.length) return;
        const active = document.querySelector('#settingsDropdown .setting-option.active');
        seg.forEach((item) => {
            const isOn = active ? item === active : !item.querySelector('.check-icon.hidden');
            item.style.background = isOn ? 'rgba(255,255,255,.10)' : '';
            item.style.color = isOn ? 'var(--text-primary)' : '';
        });
    }

    function boot() {
        const dropdown = document.getElementById('settingsDropdown');
        if (!dropdown) return;
        const row = document.getElementById('omTempRow');
        let hideTimer = null;

        if (row) {
            const open = () => {
                clearTimeout(hideTimer);
                showPanel(row, true);
            };
            const scheduleClose = () => {
                clearTimeout(hideTimer);
                hideTimer = setTimeout(() => showPanel(row, false), 220);
            };
            row.addEventListener('mouseenter', open);
            row.addEventListener('mouseleave', scheduleClose);
            row.addEventListener('click', (event) => {
                event.stopPropagation();
                const panel = panelFor(row);
                if (panel) showPanel(row, panel.classList.contains('hidden'));
            });
            const panel = panelFor(row);
            if (panel) {
                panel.addEventListener('mouseenter', () => clearTimeout(hideTimer));
                panel.addEventListener('mouseleave', scheduleClose);
            }
        }

        // 菜单关掉时把详情面板也收起来
        const closeAll = () => {
            if (row) showPanel(row, false);
        };
        document.addEventListener('click', (event) => {
            if (!dropdown.contains(event.target)) closeAll();
        });

        syncLang();
        document.querySelectorAll('#settingsDropdown .setting-option')
            .forEach((btn) => btn.addEventListener('click', () => setTimeout(syncLang, 0)));

        if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
