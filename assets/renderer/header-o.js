/* header-o.js —— 顶栏统一成一套克制的样式
 *
 * 之前的毛病：每个入口自带一套渐变 + 彩色描边（紫、青、粉、蓝），六个挤在一起像玩具。
 * 现在：全部退成中性按钮（透明底、无描边、hover 才出背景），只有「创造音效」保留主色，
 * 而且不用渐变、不加发光阴影。图标统一跟着文字色走。
 */
(function headerO() {
    'use strict';

    const BASE_CLASS = 'menu-btn h-9 px-3 rounded-lg text-[13px] font-medium flex items-center gap-2 '
        + 'transition-colors hover:bg-black/5 dark:hover:bg-white/5';
    const ENTRIES = ['fileMenuBtn', 'importBtn', 'descPackMenuBtn', 'sfxMenuBtn', 'recipeMenuBtn', 'voiceCloneBtn'];

    function paintIcon(btn, color) {
        btn.querySelectorAll('svg').forEach((svg) => {
            svg.querySelectorAll('stop').forEach((stop) => stop.setAttribute('stop-color', color));
            svg.querySelectorAll('path, circle, line, rect, polyline').forEach((node) => {
                node.setAttribute('stroke', color);
                node.setAttribute('fill', 'none');
            });
        });
        btn.querySelectorAll('i[data-lucide]').forEach((icon) => {
            icon.style.color = color;
        });
    }

    function apply() {
        let painted = false;
        ENTRIES.forEach((id) => {
            const btn = document.getElementById(id);
            if (!btn) return;
            const isPrimary = id === 'sfxMenuBtn';
            btn.className = BASE_CLASS;
            btn.style.cssText = isPrimary
                ? 'background:#3b82f6;border:1px solid #3b82f6;color:#fff;'
                : 'background:transparent;border:1px solid transparent;color:var(--text-primary);';
            // hover 时给中性按钮补一点底色（主按钮自带蓝色，不需要）
            if (!isPrimary) {
                btn.style.setProperty('--o-hover', '1');
            }
            paintIcon(btn, isPrimary ? '#ffffff' : 'currentColor');
            painted = true;
        });
        if (painted) {
            document.querySelectorAll('#headerExtraTags, .badge').forEach(() => {});
        }
    }

    function boot() {
        apply();
        const nav = document.querySelector('#sfxMenuBtn')?.closest('nav');
        if (nav && !nav.dataset.oObserved) {
            nav.dataset.oObserved = '1';
            new MutationObserver(() => apply()).observe(nav, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
