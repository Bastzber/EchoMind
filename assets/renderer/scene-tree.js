/* scene-tree.js —— M4：场景 / 属性双层
 * 从 index.html 原样搬出的完整顶层函数。
 */
async function loadTagStats() {
    try {
        const data = await rendererApi.get('/api/v1/db/tags');
        window.__tagStats = (data && data.tags) || [];
    } catch (error) {
        console.warn('[Tags] 标签统计加载失败:', error);
        window.__tagStats = window.__tagStats || [];
    }
    try {
        const layered = await rendererApi.get('/api/v1/tags');
        window.__tagLayers = {
            scene: (layered && layered.scene) || [],
            attr: (layered && layered.attr) || [],
        };
    } catch (error) {
        console.warn('[Tags] 分层标签加载失败:', error);
        window.__tagLayers = window.__tagLayers || { scene: [], attr: [] };
    }
    renderCategoryTree();
}

function showTagLayerMenu(event, tag) {
    document.getElementById('tagLayerMenu')?.remove();
    const menu = document.createElement('div');
    menu.id = 'tagLayerMenu';
    menu.className = 'fixed z-[210] rounded-lg shadow-xl py-1 w-44';
    menu.style.backgroundColor = 'var(--bg-secondary)';
    menu.style.border = '1px solid var(--border-color)';
    menu.style.left = Math.min(event.clientX, window.innerWidth - 190) + 'px';
    menu.style.top = Math.min(event.clientY, window.innerHeight - 190) + 'px';

    const item = (label, onClick, danger) => {
        const btn = document.createElement('button');
        btn.className = 'w-full px-3 py-1.5 text-xs text-left hover:bg-white/5'
            + (danger ? ' text-red-400' : '');
        btn.textContent = label;
        btn.addEventListener('click', onClick);
        menu.appendChild(btn);
    };

    item(tag.layer === 'scene' ? '✓ 已是场景标签' : '设为场景标签', async () => {
        menu.remove();
        await patchTag(tag.id, { layer: 'scene' });
    });
    item(tag.layer === 'attr' ? '✓ 已是属性标签' : '设为属性标签', async () => {
        menu.remove();
        await patchTag(tag.id, { layer: 'attr' });
    });
    item('批量重命名该标签…', () => {
        menu.remove();
        renameSoundsInTag(tag.name);
    });
    item('删除标签', async () => {
        menu.remove();
        if (!confirm(`删除标签「${tag.name}」？`)) return;
        await rendererApi.delete(`/api/v1/tags/${encodeURIComponent(tag.id)}`);
        await loadTagStats();
    }, true);

    document.body.appendChild(menu);
    const close = (e) => {
        if (!menu.contains(e.target)) {
            menu.remove();
            document.removeEventListener('click', close);
        }
    };
    setTimeout(() => document.addEventListener('click', close), 100);
}

