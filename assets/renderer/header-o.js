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

    // 无边框窗口：顶栏右侧自己画 最小化 / 最大化 / 关闭
    // 拖动区不能盖住可点击控件：整个顶栏设成 no-drag，只在「品牌区」和空白间隔上开 drag。
    // 之前顶栏是 drag，导致 #modelStatusDisplay 这种 div 胶囊的点击被系统吃掉（只有 .help-dot 能点）。
    function fixDragRegions() {
        const header = document.querySelector('header.h-14');
        if (!header) return;
        header.style.webkitAppRegion = 'no-drag';
        const brand = header.firstElementChild;
        if (brand && !brand.querySelector('button, a, input')) {
            brand.style.webkitAppRegion = 'drag';
        }
        header.querySelectorAll('.flex-1, [class*="flex-1"]').forEach((el) => {
            if (!el.querySelector('button, a, input, select')) el.style.webkitAppRegion = 'drag';
        });
    }

    function mountWindowButtons() {
        if (document.getElementById('oWinBtns')) return;
        const header = document.querySelector('header.h-14');
        if (!header) return;
        header.style.paddingRight = '10px';
        const box = document.createElement('div');
        box.id = 'oWinBtns';
        const mk = (label, title, cls, onClick) => {
            const b = document.createElement('button');
            b.innerHTML = label;
            b.title = title;
            if (cls) b.className = cls;
            b.addEventListener('click', onClick);
            return b;
        };
        const api = window.electronAPI && window.electronAPI.windowControl;
        box.appendChild(mk('&#8211;', '最小化', '', () => api && api.minimize()));
        box.appendChild(mk('&#9744;', '最大化 / 还原', '', async () => {
            if (!api) return;
            const maxed = await api.isMaximized().catch(() => false);
            if (maxed) api.maximize(); else api.maximize();   // 主进程里是 toggle
        }));
        box.appendChild(mk('&#10005;', '关闭', 'o-close', () => api && api.close()));
        header.appendChild(box);

        // 最大化时去掉圆角，免得四角露出底色
        const syncMax = async () => {
            if (!api) return;
            const maxed = await api.isMaximized().catch(() => false);
            document.body.classList.toggle('o-maximized', Boolean(maxed));
        };
        syncMax();
        window.addEventListener('resize', syncMax);
    }

    function boot() {
        styleButtons();
        alignLeft();
        mountWindowButtons();
        fixDragRegions();
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
