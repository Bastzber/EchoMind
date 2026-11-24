/* o-nav.js —— 左栏顶部换成「库 / 生产 / 整理 / 维护」分组导航（原型 G 的排法）
 *
 * 原来的左栏是「文件夹树 + 标签 + 历史」三块平铺，看着挤；现在把功能入口收进分组导航，
 * 文件夹树仍然留在下面（浏览目录是高频操作，不能藏）。
 *
 * 每一项都复用已有按钮的点击，不新写业务逻辑：
 *   生产三项 → 顶栏 #sfxMenuBtn / #voiceCloneBtn / #recipeMenuBtn
 *   整理/维护 → 工具条里的同名按钮（#quickActions 里按文字找）
 */
(function oNav() {
    'use strict';

    const GROUPS = [
        {
            title: '库',
            items: [
                { label: '全部音效', icon: 'library-big', badge: 'allCount', action: 'all' },
                { label: '收藏', icon: 'star', badge: 'favCount', action: 'favorites' },
                { label: '最近使用', icon: 'history', badge: 'recentCount', action: 'recent' },
            ],
        },
        {
            title: '生产',
            items: [
                { label: '创造音效', icon: 'sparkles', action: 'btn:#sfxMenuBtn' },
                { label: '声音克隆', icon: 'mic', action: 'btn:#voiceCloneBtn' },
                { label: '拟音工坊', icon: 'audio-lines', action: 'btn:#recipeMenuBtn' },
            ],
        },
        {
            title: '整理',
            items: [
                { label: '标签管理', icon: 'tags', action: 'tagpanel' },
                { label: '损坏文件', icon: 'alert-triangle', badge: 'brokenCount', action: 'btn:#brokenFilesBtn', danger: true },
            ],
        },
        {
            title: '维护',
            items: [
                { label: '修复索引', icon: 'refresh-cw', action: 'tool:修复索引' },
                { label: '转码', icon: 'repeat', action: 'tool:转码' },
                { label: '清理临时文件', icon: 'trash-2', action: 'tool:清理临时文件' },
            ],
        },
    ];

    function findTool(label) {
        const box = document.getElementById('quickActions');
        if (!box) return null;
        return Array.from(box.querySelectorAll('.quick-btn'))
            .find((btn) => (btn.textContent || '').includes(label)) || null;
    }

    function readBadge(kind) {
        if (kind === 'allCount') {
            const el = document.querySelector('#folderTree .tree-count, #folderTree span');
            return '';
        }
        if (kind === 'favCount') {
            const el = document.getElementById('favoritesCount');
            return el ? el.textContent.trim() : '';
        }
        if (kind === 'brokenCount') {
            const el = document.getElementById('brokenFilesCount');
            return el ? el.textContent.trim() : '';
        }
        return '';
    }

    function clickInTree(text) {
        const tree = document.getElementById('folderTree');
        if (!tree) return false;
        const row = Array.from(tree.querySelectorAll('*')).find((el) => {
            if (el.children.length > 3) return false;
            const t = (el.textContent || '').trim();
            return t.startsWith(text) && t.length < 24;
        });
        if (row) { row.click(); return true; }
        return false;
    }

    // 左栏默认只显示分组导航；文件夹树 / 标签 / 历史按需拉出来
    function showDrawer(which) {
        const panels = {
            folder: document.getElementById('folderPanelSection'),
            tag: document.getElementById('tagPanelSection'),
            history: document.getElementById('historyPanels'),
        };
        Object.keys(panels).forEach((key) => {
            const el = panels[key];
            if (!el) return;
            el.classList.toggle('o-drawer-on', key === which);
        });
    }

    function activate(item) {
        const action = item.action || '';
        if (action.startsWith('btn:')) {
            const btn = document.querySelector(action.slice(4));
            if (btn) btn.click();
            return;
        }
        if (action.startsWith('tool:')) {
            const btn = findTool(action.slice(5));
            if (btn) { btn.click(); return; }
            // 工具没加进「常用」条：先展开工具抽屉，提示一下
            const toggle = document.getElementById('toolDrawerToggle');
            const bar = document.getElementById('quickBar');
            if (bar && bar.style.display === 'none' && toggle) toggle.click();
            return;
        }
        if (action === 'all') { showDrawer('folder'); clickInTree('全部'); return; }
        if (action === 'favorites') { showDrawer('folder'); clickInTree('收藏'); return; }
        if (action === 'recent') {
            showDrawer('history');
            const history = document.getElementById('historyPanels');
            const toggle = history ? history.querySelector('.history-toggle') : null;
            if (toggle) toggle.click();
        }
        if (action === 'tagpanel') { showDrawer('tag'); return; }
    }

    function build() {
        if (document.getElementById('oNav')) return;
        const aside = document.getElementById('leftAside');
        if (!aside) return;

        const nav = document.createElement('nav');
        nav.id = 'oNav';

        GROUPS.forEach((group) => {
            const head = document.createElement('div');
            head.className = 'o-nav-group';
            head.textContent = group.title;
            nav.appendChild(head);
            group.items.forEach((item) => {
                const row = document.createElement('button');
                row.className = 'o-nav-item' + (item.danger ? ' o-nav-danger' : '');
                row.innerHTML = '<i data-lucide="' + item.icon + '" class="o-nav-icon"></i>'
                    + '<span class="o-nav-label">' + item.label + '</span>'
                    + (item.badge ? '<span class="o-nav-badge" data-badge="' + item.badge + '"></span>' : '');
                row.addEventListener('click', () => {
                    Array.from(nav.querySelectorAll('.o-nav-item')).forEach((n) => n.classList.remove('is-on'));
                    row.classList.add('is-on');
                    activate(item);
                });
                nav.appendChild(row);
            });
        });

        aside.insertBefore(nav, aside.firstElementChild);
        if (typeof lucide !== 'undefined' && lucide.createIcons) lucide.createIcons();

        // 数字徽标跟着真实数据刷新
        const syncBadges = () => {
            nav.querySelectorAll('[data-badge]').forEach((badge) => {
                const value = readBadge(badge.getAttribute('data-badge'));
                badge.textContent = value || '';
            });
        };
        syncBadges();
        setInterval(syncBadges, 2000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
    } else {
        build();
    }
})();
