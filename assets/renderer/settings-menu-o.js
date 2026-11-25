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
        // 设置菜单贴着窗口右缘，详情往左展开（CSS 里已定位 right:100%），
        // 纵向对齐到「临时文件」这一行，看起来才像它的下一级菜单
        panel.classList.toggle('hidden', !show);
        if (show) {
            const chev = row.querySelector('.om-chev');
            if (chev) chev.style.transform = 'rotate(90deg)';
            const icon = row.querySelector('.om-ico');
            if (icon) icon.style.opacity = '1';
        } else {
            const chev = row.querySelector('.om-chev');
            if (chev) chev.style.transform = '';
            const icon = row.querySelector('.om-ico');
            if (icon) icon.style.opacity = '';
        }
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

        if (row) {
            const panel = panelFor(row);
            // 点「临时文件」进下一级菜单；子菜单左上角「返回」退回主菜单。
            // 不做悬停展开 —— 用户明确要求「点进去」。
            const enter = (event) => {
                if (event) { event.preventDefault(); event.stopPropagation(); }
                showPanel(row, true);
            };
            row.addEventListener('click', enter);
            row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') enter(event);
            });
            const back = document.getElementById('omTempBack');
            if (back) {
                back.addEventListener('click', (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    showPanel(row, false);
                });
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
