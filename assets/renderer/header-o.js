/* header-o.js —— 顶栏收敛成「创造音效 / 导入 / 声音克隆 / 更多 ▾」
 *
 * 做法：不动 index.html 里的按钮本身，运行时把「文件菜单里的三个工程操作」
 * 和「导入知识包」搬进新建的「更多」下拉，然后把原来那几个入口隐藏。
 * 这样每个按钮的 id 和已绑定的点击处理都还在（moveChild 不会丢监听器），
 * 只是换了个位置——比在 HTML 里重写一遍安全。
 */
(function headerO() {
    'use strict';

    function q(sel) { return document.querySelector(sel); }

    function buildMoreMenu() {
        const nav = q('#fileMenuBtn')?.closest('nav') || q('nav');
        if (!nav || q('#moreMenuWrap')) return;

        // 「更多」按钮 + 下拉容器
        const wrap = document.createElement('div');
        wrap.className = 'relative';
        wrap.id = 'moreMenuWrap';
        const btn = document.createElement('button');
        btn.id = 'moreMenuBtn';
        btn.className = 'menu-btn h-10 px-3 rounded-md text-sm font-medium transition-colors hover:bg-black/5 dark:hover:bg-white/5 flex items-center gap-1.5';
        btn.innerHTML = '<span>更多</span><span style="font-size:10px;opacity:.6;margin-left:2px">▾</span>';
        const menu = document.createElement('div');
        menu.id = 'moreDropdown';
        menu.className = 'dropdown-menu hidden absolute top-full left-0 mt-2 w-56 rounded-lg shadow-xl border py-2 z-50';
        menu.style.background = 'var(--bg-secondary)';
        menu.style.borderColor = 'var(--border-color)';
        wrap.appendChild(btn);
        wrap.appendChild(menu);
        nav.insertBefore(wrap, nav.querySelector('#navFishWrap') || null);

        const section = (title) => {
            const div = document.createElement('div');
            div.className = 'px-3 py-2 text-xs font-medium uppercase tracking-wider opacity-50';
            div.textContent = title;
            menu.appendChild(div);
        };
        const divider = () => {
            const div = document.createElement('div');
            div.className = 'border-t my-2';
            div.style.borderColor = 'var(--border-color)';
            menu.appendChild(div);
        };

        // 搬进「更多」的条目：工程类 + 导入知识包 + 拟音工坊
        const moves = [
            { id: '#newProjectBtn', label: '新建工程' },
            { id: '#openProjectBtn', label: '打开工程' },
            { id: '#recentProjectsBtn', label: '最近工程' },
        ];
        section('工程');
        moves.forEach((item) => {
            const node = q(item.id);
            if (node) {
                node.className = 'w-full px-4 py-2 text-sm text-left hover:bg-black/5 dark:hover:bg-white/5 flex items-center gap-2';
                menu.appendChild(node);
            }
        });
        divider();
        const packBtn = q('#descPackMenuBtn');
        const recipeBtn = q('#recipeMenuBtn');
        // 先记住原来外层的容器再搬节点：搬完之后 closest('.relative') 会指到「更多」自己头上
        const packWrap = packBtn ? packBtn.closest('.relative') : null;
        const recipeWrap = recipeBtn ? recipeBtn.closest('.relative') : null;
        if (packBtn) {
            packBtn.className = 'w-full px-4 py-2 text-sm text-left hover:bg-black/5 dark:hover:bg-white/5 flex items-center gap-2';
            packBtn.style.background = 'transparent';
            packBtn.style.boxShadow = 'none';
            packBtn.style.color = 'var(--text-primary)';
            menu.appendChild(packBtn);
        }
        if (packWrap && packWrap !== wrap) packWrap.classList.add('hidden');
        if (recipeBtn) {
            recipeBtn.className = 'w-full px-4 py-2 text-sm text-left hover:bg-black/5 dark:hover:bg-white/5 flex items-center gap-2';
            recipeBtn.style.background = 'transparent';
            recipeBtn.style.boxShadow = 'none';
            menu.appendChild(recipeBtn);
        }
        if (recipeWrap && recipeWrap !== wrap) recipeWrap.classList.add('hidden');

        // 原来占位的「文件」入口隐藏（三个工程操作已经搬到「更多」里）
        const fileWrap = q('#fileMenuBtn')?.closest('.relative');
        if (fileWrap) fileWrap.classList.add('hidden');

        // 顺序按「创造音效（主）· 导入 · 声音克隆 · 更多」，创造音效做成主按钮
        const sfxWrap = q('#sfxMenuBtn')?.closest('.relative');
        const importWrap = q('#importBtn')?.closest('.relative');
        if (sfxWrap && importWrap && nav.contains(sfxWrap) && nav.contains(importWrap)) {
            nav.insertBefore(sfxWrap, importWrap);
        }
        const sfxBtn = q('#sfxMenuBtn');
        if (sfxBtn) {
            sfxBtn.style.background = '#3b82f6';
            sfxBtn.style.borderColor = '#3b82f6';
            sfxBtn.style.color = '#fff';
            sfxBtn.style.boxShadow = '0 2px 10px rgba(59,130,246,.35)';
        }

        btn.addEventListener('click', (event) => {
            event.stopPropagation();
            const open = !menu.classList.contains('hidden');
            document.querySelectorAll('.dropdown-menu').forEach((d) => d.classList.add('hidden'));
            menu.classList.toggle('hidden', open);
        });
        document.addEventListener('click', () => menu.classList.add('hidden'));
        menu.addEventListener('click', (event) => event.stopPropagation());
    }

    function boot() {
        try {
            buildMoreMenu();
        } catch (error) {
            console.warn('[header-o] 顶栏收敛失败:', error && error.message);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
