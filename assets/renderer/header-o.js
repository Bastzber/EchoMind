/* header-o.js —— 顶栏排法（按老板给的图）
 *
 * 三个要点：
 * 1. 六个入口都有边框（1px，用 --border-color），不是透明按钮
 * 2. 从左边开始往右排：导航紧跟「回声」logo，右边的东西用 margin-left:auto 顶到最右
 * 3. 不给「创造音效」单独上色：它和其余五个一模一样
 */
(function headerO() {
    'use strict';

    const BASE_CLASS = 'menu-btn h-9 px-3 rounded-lg text-[13px] font-medium flex items-center gap-2 transition-colors';
    const ENTRIES = ['fileMenuBtn', 'importBtn', 'descPackMenuBtn', 'sfxMenuBtn', 'recipeMenuBtn', 'voiceCloneBtn'];

    function paintIcon(btn) {
        btn.querySelectorAll('svg').forEach((svg) => {
            svg.querySelectorAll('stop').forEach((stop) => stop.setAttribute('stop-color', 'currentColor'));
            svg.querySelectorAll('path, circle, line, rect, polyline').forEach((node) => {
                node.setAttribute('stroke', 'currentColor');
                node.setAttribute('fill', 'none');
            });
        });
        btn.querySelectorAll('i[data-lucide]').forEach((icon) => { icon.style.color = 'currentColor'; });
    }

    function styleButtons() {
        ENTRIES.forEach((id) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            btn.className = BASE_CLASS;
            btn.style.cssText = 'background:var(--bg-tertiary);border:1px solid var(--border-color);'
                + 'color:var(--text-primary);box-shadow:none;backdrop-filter:none;';
            paintIcon(btn);
        });
    }

    function alignLeft() {
        const nav = document.querySelector('#fileMenuBtn')?.closest('nav');
        if (!nav) return;
        const header = nav.parentElement;
        if (header) {
            header.style.justifyContent = 'flex-start';
            header.style.gap = '10px';
        }
        nav.style.justifyContent = 'flex-start';
        nav.style.marginRight = 'auto';   // 后面的索引状态 / 设置被顶到最右
    }

    function boot() {
        styleButtons();
        alignLeft();
        const nav = document.querySelector('#fileMenuBtn')?.closest('nav');
        if (nav && !nav.dataset.oObserved) {
            nav.dataset.oObserved = '1';
            new MutationObserver(() => styleButtons()).observe(nav, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
