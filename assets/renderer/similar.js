/* similar.js —— 右键「找相似」：标签/描述命中排前面，音频向量（听感）接在后面。
 * 排序与打分都在后端 backend/core/similar.py 里做，这里只负责取数、铺列表、加横幅。
 */
const SIMILAR_LIMIT = 100;
const SIMILAR_AUDIO_THRESHOLD = 0.55;

function similarMatchLabel(match) {
    if (match === 'tags') return '同类 · 标签';
    if (match === 'description') return '同类 · 描述';
    if (match === 'text') return '同类 · 语义';
    return '听感相似';
}

function removeSimilarBanner() {
    window.__similarOrder = false;
    const existing = document.getElementById('similarBanner');
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
}

function showSimilarBanner(sourceSound, payload) {
    removeSimilarBanner();
    const counts = (payload && payload.counts) || {};
    const sourceName = (sourceSound && sourceSound.name) || (payload && payload.source && payload.source.filename) || '';
    const banner = document.createElement('div');
    banner.id = 'similarBanner';
    banner.className = 'flex items-center gap-3 px-4 py-2 text-xs border-b shrink-0';
    banner.style.borderColor = 'var(--border-color)';
    banner.style.background = 'var(--bg-tertiary)';
    const label = document.createElement('span');
    label.className = 'flex-1 truncate';
    let text = '与「' + sourceName + '」相似 · 同类 ' + (counts.same || 0) + ' 条 / 听感相似 ' + (counts.audio || 0) + ' 条';
    if (payload && payload.audio_ready === false) text += ' · 该文件音频向量未就绪，只按标签/描述';
    label.textContent = text;
    label.title = text;
    const back = document.createElement('button');
    back.className = 'px-2 py-0.5 rounded border hover:bg-white/10';
    back.style.borderColor = 'var(--border-color)';
    back.textContent = '返回全部';
    back.addEventListener('click', () => {
        removeSimilarBanner();
        loadFilesFromDatabase({ reset: true });
    });
    banner.appendChild(label);
    banner.appendChild(back);
    const list = document.getElementById('soundList');
    if (list && list.parentNode) list.parentNode.insertBefore(banner, list);
}

function mapSimilarItem(item, index) {
    const path = item.path || '';
    const name = item.filename || path.split(/[\\/]/).pop() || '';
    const isAudioMatch = item.match === 'audio';
    const score = isAudioMatch ? (item.audio_score || 0) : (item.score || 0);
    return {
        id: item.file_uuid || ('similar-' + index),
        fileId: item.file_uuid,
        name: name,
        category: similarMatchLabel(item.match),
        duration: Math.round((item.duration || 0) * 1000),
        tags: Array.isArray(item.tags) ? item.tags : [],
        filePath: path,
        size: 0,
        type: name.includes('.') ? '.' + name.split('.').pop().toLowerCase() : '',
        similarity: score,
        similarMatch: item.match,
        similarTagOverlap: item.tag_overlap || [],
        aiDescription: item.ai_description || '',
        lastModified: new Date()
    };
}

async function findSimilarForSound(sound) {
    if (!sound) return;
    const fileId = sound.fileId || sound.id;
    if (!fileId) {
        showNotification('这条音效没有文件 ID，无法找相似', 'error');
        return;
    }
    const projectId = (currentProject && currentProject.id) || 'default';
    showNotification('正在找「' + (sound.name || '') + '」的相似音效…', 'info');
    try {
        const url = '/api/v1/files/' + encodeURIComponent(fileId) + '/similar'
            + '?project_id=' + encodeURIComponent(projectId)
            + '&limit=' + SIMILAR_LIMIT
            + '&threshold=' + SIMILAR_AUDIO_THRESHOLD;
        const data = await rendererApi.post(url, {}, { timeoutMs: 120000 });
        const items = (data && data.items) || [];
        if (!items.length) {
            showNotification('没有找到相似音效（标签、描述、听感都没命中）', 'info');
            return;
        }
        const mapped = items.map(mapSimilarItem);
        allSearchResults = mapped;
        window.__similarOrder = true;   // 顺序即相关性，禁止 sortSounds 重排
        renderSoundList('', mapped);
        showSimilarBanner(sound, data);
        showNotification('找到 ' + mapped.length + ' 条相似音效', 'success');
    } catch (error) {
        console.error('[Similar] 查找失败:', error);
        showNotification('找相似失败: ' + ((error && error.message) || error), 'error');
    }
}
