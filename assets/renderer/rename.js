(function (global) {
    'use strict';

    const namespace = global.SoundBotRenderer = global.SoundBotRenderer || {};

    // Windows 文件名里不允许出现的字符（后端同样校验，这里提前在界面上拦掉）
    const ILLEGAL_CHARS = /[\\/:*?"<>|]/;
    const ILLEGAL_MESSAGE = '文件名不能包含 \\ / : * ? " < > |';
    const EMPTY_MESSAGE = '新文件名不能为空';
    // 一次弹窗最多处理的条数：5000 行输入框会把渲染线程卡死
    const MAX_BATCH = 500;

    function trim(value) {
        return String(value === undefined || value === null ? '' : value).trim();
    }

    function validateName(name) {
        const value = trim(name);
        if (!value) return EMPTY_MESSAGE;
        if (ILLEGAL_CHARS.test(value)) return ILLEGAL_MESSAGE;
        return '';
    }

    function basename(filePath) {
        const value = String(filePath || '');
        const index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
        return index >= 0 ? value.slice(index + 1) : value;
    }

    function splitExtension(name) {
        const value = String(name === undefined || name === null ? '' : name);
        const index = value.lastIndexOf('.');
        if (index <= 0 || index === value.length - 1) return { stem: value, ext: '' };
        return { stem: value.slice(0, index), ext: value.slice(index) };
    }

    function textOf(value) {
        return value === undefined || value === null ? '' : String(value);
    }

    // 批量规则：一律以「原名」为输入，所以重复点不会把前缀叠两层。
    // 扩展名永远放在最后，查找替换也只在主名上做。
    function applyRules(name, rules, index) {
        const config = rules || {};
        const parts = splitExtension(name);

        let core = parts.stem;
        const find = textOf(config.find);
        if (find) core = core.split(find).join(textOf(config.replace));

        let number = '';
        const numbering = config.numbering;
        if (numbering && numbering.enabled) {
            const startRaw = numbering.start;
            const start = startRaw === '' || startRaw === undefined || startRaw === null
                ? 1
                : Math.round(Number(startRaw));
            const base = Number.isFinite(start) ? start : 1;
            const digits = Math.max(0, Math.round(Number(numbering.digits) || 0));
            const raw = String(base + (Number(index) || 0));
            number = (digits > 0 ? raw.padStart(digits, '0') : raw) + textOf(numbering.separator);
        }

        return textOf(config.prefix) + number + core + textOf(config.suffix) + parts.ext;
    }

    // 只把「真的改了」的行送进接口：没动的不发，空的也不发
    function planItems(sounds, namesById) {
        const items = [];
        (sounds || []).forEach((sound) => {
            if (!sound) return;
            const id = String(sound.id === undefined || sound.id === null ? '' : sound.id);
            const fileUuid = trim(sound.fileId || sound.id || '');
            if (!id || !fileUuid) return;
            const raw = namesById ? namesById[id] : undefined;
            if (raw === undefined || raw === null) return;
            const next = trim(raw);
            if (!next) return;
            if (next === trim(sound.name)) return;
            items.push({ file_uuid: fileUuid, new_name: next, old_name: sound.name || '' });
        });
        return items;
    }

    // 把接口结果写回内存里的 sound（后端会在省略扩展名时替我们补上，所以以 new_path 为准）
    function applyResults(sounds, results) {
        const byId = new Map();
        (sounds || []).forEach((sound) => {
            if (!sound) return;
            if (sound.id !== undefined && sound.id !== null) byId.set(String(sound.id), sound);
            if (sound.fileId) byId.set(String(sound.fileId), sound);
        });

        const updated = [];
        const failed = [];
        (results || []).forEach((result) => {
            if (!result) return;
            const sound = byId.get(String(result.file_uuid === undefined ? '' : result.file_uuid));
            if (!result.ok) {
                failed.push(result);
                return;
            }
            if (!sound) return;
            if (result.new_path) {
                sound.filePath = result.new_path;
                const name = basename(result.new_path);
                if (name) sound.name = name;
            } else if (trim(result.new_name)) {
                sound.name = trim(result.new_name);
            }
            updated.push(sound);
        });
        return { updated, failed };
    }

    function summarize(results) {
        const list = results || [];
        const ok = list.filter(item => item && item.ok).length;
        return { total: list.length, ok, failed: list.length - ok };
    }

    namespace.rename = Object.freeze({
        MAX_BATCH,
        ILLEGAL_CHARS,
        ILLEGAL_MESSAGE,
        EMPTY_MESSAGE,
        validateName,
        basename,
        splitExtension,
        applyRules,
        planItems,
        applyResults,
        summarize
    });
})(typeof window !== 'undefined' ? window : globalThis);
