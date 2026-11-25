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
            const rowTop = row.offsetTop || 0;
            panel.style.top = Math.max(0, rowTop - 6) + 'px';
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
            // 只认点击：以前是「悬停展开 + 点击切换」，鼠标本来就停在上面时
            // 一点击反而把它关掉，看着就像「点了没反应」。
            // 悬停和点击都只负责「打开」，不负责关闭 —— 关掉的方式是点别处或鼠标移开。
            // 这样无论用户是点还是划过去，都不会出现「点了没反应」的错觉。
            const open = (event) => {
                if (event) {
                    event.preventDefault();
                    event.stopPropagation();
                }
                showPanel(row, true);
            };
            row.addEventListener('mouseenter', open);
            row.addEventListener('click', open);
            row.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') open(event);
            });
            // 鼠标从这一行移进面板时不要收起；移出面板就收起
            if (panel) {
                panel.addEventListener('mouseleave', () => showPanel(row, false));
            }
            // 点菜单里别的项，收起子菜单
            dropdown.querySelectorAll('.om-set-row').forEach((other) => {
                if (other !== row) {
                    other.addEventListener('click', () => showPanel(row, false));
                }
            });
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
