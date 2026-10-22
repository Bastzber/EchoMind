/* ============================================================
 * 回声 · 可自定义界面引擎（PR 风格）
 * 1) 板块之间可拖拽分隔条调整大小
 * 2) 板块可浮动为独立面板（拖动/缩放/停靠）
 * ============================================================ */
(function () {
    'use strict';

    const CSS = `
    .panel-resizer-v {
        width: 5px; cursor: col-resize; flex-shrink: 0;
        position: relative; z-index: 5;
        background: transparent;
        transition: background .15s;
    }
    .panel-resizer-v::after {
        content: ''; position: absolute; left: 2px; top: 0; bottom: 0; width: 1px;
        background: var(--border-color, rgba(128,128,128,.35));
    }
    .panel-resizer-v:hover, .panel-resizer-v.dragging {
        background: rgba(139,92,246,.35);
    }
    .panel-resizer-h {
        height: 5px; cursor: row-resize; flex-shrink: 0;
        position: relative; z-index: 5;
        background: transparent;
        transition: background .15s;
    }
    .panel-resizer-h::after {
        content: ''; position: absolute; top: 2px; left: 0; right: 0; height: 1px;
        background: var(--border-color, rgba(128,128,128,.35));
    }
    .panel-resizer-h:hover, .panel-resizer-h.dragging {
        background: rgba(139,92,246,.35);
    }

    .float-window {
        position: fixed; z-index: 300;
        display: flex; flex-direction: column;
        min-width: 260px; min-height: 160px;
        background: var(--bg-secondary, #1e1e2e);
        border: 1px solid var(--border-color, rgba(128,128,128,.4));
        border-radius: 10px;
        box-shadow: 0 12px 40px rgba(0,0,0,.45);
        overflow: hidden;
    }
    .float-window .float-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px; cursor: move; user-select: none;
        background: rgba(139,92,246,.14);
        border-bottom: 1px solid var(--border-color, rgba(128,128,128,.25));
        font-size: 12px; font-weight: 600; flex-shrink: 0;
    }
    .float-window .float-body {
        flex: 1; min-height: 0; overflow: auto;
        display: flex; flex-direction: column;
    }
    .float-window .float-dock-btn {
        padding: 3px 6px; border-radius: 6px; cursor: pointer;
        opacity: .7; font-size: 11px;
        transition: opacity .15s;
    }
    .float-window .float-dock-btn:hover { opacity: 1; background: rgba(255,255,255,.12); }
    .float-window .float-resize {
        position: absolute; right: 0; bottom: 0;
        width: 16px; height: 16px; cursor: nwse-resize;
        background: linear-gradient(135deg, transparent 0 55%, var(--border-color, #888) 55% 60%, transparent 60% 100%);
        opacity: .7;
    }
    .float-placeholder {
        display: flex; align-items: center; justify-content: center;
        border: 1px dashed var(--border-color, rgba(128,128,128,.5));
        border-radius: 8px; color: var(--text-secondary, #888);
        font-size: 12px; opacity: .6; margin: 4px;
    }
    `;
    function injectCSS() {
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    const panels = {};   // id → 面板描述
    const floatWins = {}; // id → 浮窗元素

    function registerPanel(id, title, bodyEl, opts = {}) {
        const section = opts.dockRoot || bodyEl.parentElement;
        const extras = (opts.extras || []).map(sel => {
            const el = document.querySelector(sel);
            return el ? { el, parent: el.parentNode, next: el.nextSibling } : null;
        }).filter(Boolean);
        const hides = (opts.hide || []).map(sel => {
            const el = document.querySelector(sel);
            return el ? { el, prevDisplay: el.style.display } : null;
        }).filter(Boolean);
        panels[id] = {
            id,
            title,
            body: bodyEl,
            dockedRoot: section,
            bodyAnchor: { parent: bodyEl.parentNode, next: bodyEl.nextSibling },
            extras,
            hides,
            floated: false,
        };
    }

    // ---------------- 浮动 / 停靠 ----------------
    // 独立浮动面板：主进程创建无边框 BrowserWindow（可拖到任意屏幕），
    // 浮窗加载同一页面 ?float=<id> 进入单面板模式。
    function floatPanel(id) {
        const p = panels[id];
        if (!p || p.floated) return;
        // 浮窗窗口内部不再开新浮窗
        if (window.electronAPI?.floatPanel?.floatId?.()) return;
        p.floated = true;
        // 原板块隐藏（恢复由 dockPanel 处理）
        p.dockedRoot.style.display = 'none';
        p.hides.forEach(({ el }) => { el.style.display = 'none'; });
        const rect = p.dockedRoot.getBoundingClientRect();
        if (window.electronAPI?.floatPanel?.open) {
            window.electronAPI.floatPanel.open({
                id,
                title: p.title,
                rect: { left: rect.left, top: rect.top },
            }).then(ok => {
                if (!ok) { p.floated = false; p.dockedRoot.style.display = ''; }
            });
        } else {
            p.floated = false;
            p.dockedRoot.style.display = '';
        }
    }

    function dockPanel(id) {
        const p = panels[id];
        if (!p) return;
        p.floated = false;
        p.dockedRoot.style.display = '';
        p.hides.forEach(({ el, prevDisplay }) => { el.style.display = prevDisplay; });
    }

    // 主窗口监听浮窗停靠/关闭 → 恢复原面板
    if (window.electronAPI?.floatPanel?.onDocked) {
        window.electronAPI.floatPanel.onDocked((id) => dockPanel(id));
    }

    // ---------------- 拖拽分隔条 ----------------
    function initResizers() {
        document.querySelectorAll('[data-resizer]').forEach(bar => {
            bar.addEventListener('pointerdown', e => {
                if (e.button !== 0) return;
                e.preventDefault();
                bar.classList.add('dragging');
                const dir = bar.dataset.resizer;      // left | right | bottom
                const target = document.querySelector(bar.dataset.target);
                if (!target) { bar.classList.remove('dragging'); return; }
                const axis = (dir === 'bottom') ? 'y' : 'x';
                const startPos = axis === 'x' ? e.clientX : e.clientY;
                const startSize = axis === 'x' ? target.offsetWidth : target.offsetHeight;
                const min = parseInt(bar.dataset.min || '160', 10);
                const max = parseInt(bar.dataset.max || '1200', 10);
                const move = ev => {
                    const cur = axis === 'x' ? ev.clientX : ev.clientY;
                    let size = startSize + (cur - startPos);
                    if (dir === 'right') size = startSize - (cur - startPos); // 右栏：左拖变宽
                    if (dir === 'bottom') size = startSize - (cur - startPos); // 波形区：往下拖变小、往上拖变大
                    size = Math.max(min, Math.min(max, size));
                    if (axis === 'x') {
                        target.style.width = size + 'px';
                    } else {
                        target.style.height = size + 'px';
                    }
                };
                const up = () => {
                    bar.classList.remove('dragging');
                    window.removeEventListener('pointermove', move);
                    window.removeEventListener('pointerup', up);
                };
                window.addEventListener('pointermove', move);
                window.addEventListener('pointerup', up);
            });
        });
    }

    // ---------------- 自动注册板块 ----------------
    function autoRegister() {
        document.querySelectorAll('[data-panel]').forEach(section => {
            const id = section.dataset.panel;
            const title = section.dataset.panelTitle || id;
            const body = section.querySelector('[data-panel-body]');
            if (!body) return;
            const extras = (section.dataset.panelExtra || '').split(',').map(s => s.trim()).filter(Boolean);
            const hides = (section.dataset.panelHide || '').split(',').map(s => s.trim()).filter(Boolean);
            registerPanel(id, title, body, {
                dockRoot: section,
                extras,
                hide: hides,
            });
        });
    }

    // ---------------- 浮动按钮绑定 ----------------
    function bindFloatButtons() {
        document.querySelectorAll('[data-float]').forEach(btn => {
            btn.addEventListener('click', () => floatPanel(btn.dataset.float));
        });
    }

    function init() {
        injectCSS();
        autoRegister();
        initResizers();
        bindFloatButtons();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // 供其他模块调用
    window.SoundBotRenderer = window.SoundBotRenderer || {};
    window.SoundBotRenderer.panels = {
        registerPanel,
        floatPanel,
        dockPanel,
    };
})();
