/* header-o.js —— 顶栏保持原样（文件/导入/导入知识包/创造音效/拟音工坊/声音克隆）
 *
 * 唯一改动：把「创造音效」做成蓝色主按钮，其余六个入口一个不藏、顺序不动。
 * （上一版把入口收进「更多」被否了，这里退回原结构，只保留配色。）
 */
(function headerO() {
    'use strict';

    function stylePrimary() {
        const sfx = document.getElementById('sfxMenuBtn');
        if (!sfx || sfx.dataset.oPrimary === '1') return;
        sfx.dataset.oPrimary = '1';
        sfx.style.background = '#3b82f6';
        sfx.style.borderColor = '#3b82f6';
        sfx.style.color = '#fff';
        sfx.style.boxShadow = '0 2px 10px rgba(59,130,246,.35)';
        // 里面那层渐变 svg 描边在蓝底上看不清，换成白色描边
        sfx.querySelectorAll('svg path, svg circle, svg stop').forEach((node) => {
            if (node.tagName.toLowerCase() === 'stop') {
                node.setAttribute('stop-color', '#ffffff');
            } else {
                node.setAttribute('stroke', '#ffffff');
            }
        });
    }

    function boot() {
        stylePrimary();
        // 顶栏可能被其他脚本重建，MutationObserver 兜一手
        const nav = document.querySelector('#sfxMenuBtn')?.closest('nav');
        if (nav && !nav.dataset.oObserved) {
            nav.dataset.oObserved = '1';
            new MutationObserver(() => stylePrimary()).observe(nav, { childList: true, subtree: true });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
