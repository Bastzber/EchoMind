/* ============================================================
 * 创造音效：AI 文字生成（豆包语音 seed-audio-1.0）+ 可视化滑块面板
 * ============================================================ */
(function () {
    'use strict';

    // 打包后页面来自 file://，相对路径 fetch 会打到 file:///api/... 直接 Failed to fetch，
    // 必须走渲染层统一的 api（带 127.0.0.1:8000 前缀）。
    function apiFetch(path, options) {
        const api = window.SoundBotRenderer?.api;
        if (api && typeof api.fetch === 'function') return api.fetch(path, options);
        return fetch(path, options);
    }

    // ---------- 分类模板数据（滑块 → 中文生成描述） ----------
    const SFX_CATEGORIES = [
        { name: '环境音', items: [
            { name: '风与气流', desc: '风从远处到近身流动', params: [
                { key: 'dist', label: '距离', words: ['远处', '中距离', '近身'] },
                { key: 'strength', label: '强度', words: ['微风', '适中风', '强风'] },
                { key: 'texture', label: '质感', words: ['平缓', '带着呼啸', '夹杂气流涡旋'] }
            ], build: v => `${v.dist}的${v.strength}风声，${v.texture}` },
            { name: '城市环境', desc: '街道车流与人声氛围', params: [
                { key: 'traffic', label: '车流', words: ['稀少', '中等', '川流不息'] },
                { key: 'crowd', label: '人群', words: ['安静', '隐约人声', '嘈杂喧闹'] },
                { key: 'amb', label: '氛围', words: ['空旷', '有回声', '繁忙街头'] }
            ], build: v => `城市街道环境音，车流${v.traffic}，人群${v.crowd}，氛围${v.amb}` },
            { name: '雨天', desc: '雨量与雨打物体', params: [
                { key: 'rain', label: '雨量', words: ['绵绵细雨', '中雨', '倾盆大雨'] },
                { key: 'thunder', label: '雷声', words: ['无雷', '偶有闷雷', '雷声轰鸣'] },
                { key: 'hit', label: '雨打', words: ['落在树叶上', '打在窗户玻璃上', '敲击屋顶铁皮'] }
            ], build: v => `${v.rain}，${v.hit}，${v.thunder}，持续的环境雨声` },
            { name: '林间鸟鸣', desc: '清晨树林的鸟叫', params: [
                { key: 'birds', label: '鸟声密度', words: ['零星几声', '此起彼伏', '热闹成群'] },
                { key: 'amb', label: '环境', words: ['安静树林', '微风沙沙', '溪流声相伴'] }
            ], build: v => `清晨林间的鸟鸣，${v.birds}鸟叫声，${v.amb}` },
            { name: '夜晚虫鸣', desc: '夏夜草丛昆虫', params: [
                { key: 'density', label: '虫声密度', words: ['稀疏', '适中', '密集'] },
                { key: 'dist', label: '远近', words: ['远处', '中等距离', '近在耳边'] }
            ], build: v => `夏夜草丛的虫鸣声，蟋蟀等昆虫叫声${v.density}，从${v.dist}传来` },
            { name: '海边浪潮', desc: '海浪拍岸与距离感', params: [
                { key: 'size', label: '浪大小', words: ['轻柔细浪', '中等海浪', '波涛汹涌'] },
                { key: 'dist', label: '距离', words: ['远处', '中等距离', '近岸拍打'] }
            ], build: v => `海边浪潮声，${v.size}，从${v.dist}传来，海水拍打沙滩` },
            { name: '溪流瀑布', desc: '流水大小与落差', params: [
                { key: 'flow', label: '水流', words: ['潺潺细流', '中等水流', '奔涌激流'] },
                { key: 'drop', label: '落差', words: ['平缓流淌', '有落差', '瀑布倾泻'] }
            ], build: v => `溪流声，${v.flow}，${v.drop}，水流撞击岩石` },
            { name: '篝火燃烧', desc: '火焰与柴木噼啪', params: [
                { key: 'fire', label: '火焰大小', words: ['小火苗', '中等火焰', '熊熊大火'] },
                { key: 'crackle', label: '柴木噼啪', words: ['轻微', '适中', '响亮密集'] }
            ], build: v => `篝火燃烧声，${v.fire}，木柴燃烧${v.crackle}的噼啪声` }
        ]},
        { name: '车辆', items: [
            { name: '轿车驶过', desc: '车辆从远处驶来驶过', params: [
                { key: 'speed', label: '车速', words: ['缓慢驶过', '正常速度', '高速驶过'] },
                { key: 'dist', label: '距离', words: ['远处', '中等距离', '近旁'] },
                { key: 'road', label: '路面', words: ['柏油路', '潮湿路面', '砂石路'] }
            ], build: v => `一辆轿车${v.speed}，从${v.dist}驶过，${v.road}上的轮胎声和引擎声` },
            { name: '引擎怠速', desc: '车辆原地怠速', params: [
                { key: 'engine', label: '引擎大小', words: ['轻微', '适中', '低沉有力'] },
                { key: 'type', label: '车型', words: ['轿车', '卡车', '老式发动机'] }
            ], build: v => `${v.type}引擎怠速的声音，${v.engine}的运转声` },
            { name: '喇叭鸣笛', desc: '汽车喇叭远近', params: [
                { key: 'dist', label: '距离', words: ['远处', '中等距离', '近处'] },
                { key: 'freq', label: '频率', words: ['单次短鸣', '连续两下', '急促长鸣'] }
            ], build: v => `汽车喇叭${v.freq}，从${v.dist}传来` },
            { name: '急刹车', desc: '轮胎抱死与摩擦', params: [
                { key: 'dist', label: '距离', words: ['远处', '中等距离', '近前'] },
                { key: 'tire', label: '轮胎摩擦', words: ['轻微', '明显', '尖锐刺耳'] }
            ], build: v => `汽车急刹车，轮胎与地面${v.tire}的摩擦声，从${v.dist}传来` }
        ]},
        { name: '脚步', items: [
            { name: '普通走路', desc: '脚步声与地面材质', params: [
                { key: 'pace', label: '步速', words: ['缓慢', '正常', '急促'] },
                { key: 'ground', label: '地面', words: ['水泥地', '木地板', '沙土地'] }
            ], build: v => `一个人${v.pace}走路的脚步声，走在${v.ground}上` },
            { name: '跑步', desc: '跑步落地与节奏', params: [
                { key: 'pace', label: '节奏', words: ['慢跑', '正常跑步', '冲刺'] },
                { key: 'ground', label: '地面', words: ['操场跑道', '柏油路', '室内地板'] }
            ], build: v => `${v.pace}的脚步声，在${v.ground}上，节奏清晰` },
            { name: '高跟鞋', desc: '鞋跟敲击地面', params: [
                { key: 'pace', label: '步速', words: ['优雅缓慢', '正常', '急促'] },
                { key: 'surface', label: '地面', words: ['大理石', '木地板', '瓷砖'] }
            ], build: v => `高跟鞋踩在${v.surface}上的脚步声，${v.pace}，鞋跟清脆敲击` },
            { name: '木质楼梯', desc: '上下楼梯踩踏', params: [
                { key: 'pace', label: '步速', words: ['缓慢', '正常', '急促'] },
                { key: 'dir', label: '方向', words: ['上楼', '下楼'] }
            ], build: v => `有人在木质楼梯上${v.dir}的脚步声，${v.pace}，木板吱呀作响` }
        ]},
        { name: '衣物摩擦', items: [
            { name: '布料摩擦', desc: '衣物布料相互摩擦', params: [
                { key: 'amount', label: '幅度', words: ['轻微', '适中', '大幅'] },
                { key: 'fabric', label: '布料', words: ['棉布', '皮衣', '尼龙外套'] }
            ], build: v => `${v.fabric}${v.amount}摩擦的声音` },
            { name: '拉链', desc: '拉链拉动声', params: [
                { key: 'speed', label: '速度', words: ['缓慢', '正常', '快速'] },
                { key: 'type', label: '类型', words: ['外套拉链', '裤链', '背包拉链'] }
            ], build: v => `${v.type}${v.speed}拉动的拉链声` },
            { name: '衣服抖动', desc: '抖开/甩动衣物', params: [
                { key: 'vigor', label: '力度', words: ['轻轻抖开', '用力甩动', '猛烈挥舞'] }
            ], build: v => `把衣服${v.vigor}的声音，布料哗啦作响` }
        ]},
        { name: '门与开关', items: [
            { name: '木门开关', desc: '老式木门吱呀', params: [
                { key: 'type', label: '动作', words: ['轻轻推开', '正常开关', '用力关上'] },
                { key: 'creak', label: '吱呀声', words: ['无', '轻微', '明显'] }
            ], build: v => `木门${v.type}的声音，${v.creak === '无' ? '没有杂音' : v.creak + '的吱呀声'}` },
            { name: '金属门', desc: '铁门/金属门扇', params: [
                { key: 'type', label: '动作', words: ['拉开', '关上', '撞击'] },
                { key: 'echo', label: '回声', words: ['闷响', '清脆', '空旷回声'] }
            ], build: v => `金属门${v.type}的声音，${v.echo}，金属撞击感` },
            { name: '锁门', desc: '钥匙锁门/门锁', params: [
                { key: 'type', label: '类型', words: ['钥匙转动锁芯', '插销上锁', '电子锁开锁'] }
            ], build: v => `${v.type}的声音，咔哒一声锁定` },
            { name: '关门声', desc: '门关闭的声响', params: [
                { key: 'force', label: '力度', words: ['轻轻带上', '正常关闭', '砰地关上'] },
                { key: 'echo', label: '环境', words: ['安静房间', '空旷大厅', '走廊'] }
            ], build: v => `在${v.echo}里${v.force}的门声` }
        ]},
        { name: '日常拟音', items: [
            { name: '手机震动', desc: '手机在桌面震动', params: [
                { key: 'intensity', label: '强度', words: ['轻微', '正常', '强烈'] },
                { key: 'surface', label: '桌面', words: ['木质桌面', '玻璃桌面', '拿在手里'] }
            ], build: v => `手机${v.intensity}震动，放在${v.surface}上嗡嗡作响` },
            { name: '键盘敲击', desc: '打字键盘声', params: [
                { key: 'speed', label: '速度', words: ['缓慢', '正常打字', '飞快'] },
                { key: 'type', label: '键盘', words: ['机械键盘', '薄膜键盘', '笔记本键盘'] }
            ], build: v => `${v.type}${v.speed}敲击的声音，噼里啪啦` },
            { name: '纸张翻动', desc: '翻书/翻纸页', params: [
                { key: 'speed', label: '速度', words: ['缓慢', '正常', '快速翻页'] },
                { key: 'type', label: '纸张', words: ['杂志纸张', '报纸', '厚书页'] }
            ], build: v => `${v.speed}翻动${v.type}的声音，纸张沙沙作响` },
            { name: '水滴', desc: '水龙头滴水', params: [
                { key: 'rate', label: '频率', words: ['缓慢滴落', '正常节奏', '连续快滴'] },
                { key: 'surface', label: '落点', words: ['水池水面', '瓷砖', '金属盆'] }
            ], build: v => `水滴${v.rate}的声音，滴落在${v.surface}上` },
            { name: '杯子碰撞', desc: '陶瓷杯碰杯', params: [
                { key: 'force', label: '力度', words: ['轻轻碰撞', '正常', '较重'] },
                { key: 'count', label: '数量', words: ['两只杯子', '三只以上', '托盘上多只'] }
            ], build: v => `${v.count}陶瓷杯${v.force}碰撞的声音，清脆` }
        ]},
        { name: '碰撞与转场', items: [
            { name: '玻璃破碎', desc: '玻璃碎裂声', params: [
                { key: 'size', label: '玻璃大小', words: ['小玻璃杯', '窗户玻璃', '大块玻璃'] },
                { key: 'intensity', label: '碎裂程度', words: ['轻微裂纹', '部分碎裂', '彻底粉碎'] }
            ], build: v => `${v.size}${v.intensity}的声音，玻璃碎片散落` },
            { name: '金属碰撞', desc: '金属物体撞击', params: [
                { key: 'type', label: '物体', words: ['金属管道', '铁桶', '刀叉金属'] },
                { key: 'force', label: '力度', words: ['轻微', '正常', '猛烈'] }
            ], build: v => `${v.type}被${v.force}撞击的金属碰撞声` },
            { name: '重物落地', desc: '重物砸地', params: [
                { key: 'weight', label: '重量', words: ['中等重物', '很重的箱子', '大件家具'] },
                { key: 'ground', label: '地面', words: ['木地板', '水泥地', '地毯'] }
            ], build: v => `${v.weight}砸在${v.ground}上，沉闷的落地声` },
            { name: '快速转场呼啸', desc: '运动/切换的嗖声', params: [
                { key: 'speed', label: '速度', words: ['缓慢', '快速', '极速'] },
                { key: 'style', label: '风格', words: ['平滑', '尖锐', '有力下切'] }
            ], build: v => `${v.speed}的${v.style}呼啸转场声，嗖的一下划过` }
        ]}
    ];

    // ---------- 面板状态 ----------
    const state = {
        activeCat: SFX_CATEGORIES[0],
        activeItem: SFX_CATEGORIES[0].items[0],
        values: {},           // { paramKey: 0-100 }
        duration: 12,
        customMode: false,    // 自定义提示词模式
        customPrompt: '',     // 自定义模式下的文本描述
        distance: 50,         // 声音远近 0-100
        intensity: 50,        // 声音强度 0-100
        current: null,        // { audio_path, duration, size, text_prompt, name }
        player: null,
        playing: false,
        generating: false,
    };
    const HISTORY_KEY = 'soundbot_sfx_history';
    const HISTORY_MAX = 100;

    function loadHistory() {
        try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
        catch (e) { return []; }
    }
    function saveHistory(list) {
        try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX))); } catch (e) {}
    }

    // ---------- 渲染：分类树 ----------
    function renderCategories() {
        const tabs = document.getElementById('sfxCategoryTabs');
        tabs.innerHTML = '';
        // 自定义音效入口（固定在分类最前）
        const customBtn = document.createElement('button');
        customBtn.className = 'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1' +
            (state.customMode ? ' text-white' : ' opacity-70 hover:opacity-100');
        if (state.customMode) customBtn.style.background = '#8b5cf6';
        customBtn.innerHTML = '<i data-lucide="sparkles" class="w-3.5 h-3.5"></i>自定义音效';
        customBtn.addEventListener('click', () => {
            state.customMode = true;
            renderCategories(); renderSubcategories(); renderParams();
        });
        tabs.appendChild(customBtn);
        SFX_CATEGORIES.forEach(cat => {
            const btn = document.createElement('button');
            btn.className = 'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors' +
                (cat === state.activeCat ? ' text-white' : ' opacity-70 hover:opacity-100');
            if (cat === state.activeCat) btn.style.background = '#8b5cf6';
            btn.textContent = cat.name;
            btn.addEventListener('click', () => { state.customMode = false; state.activeCat = cat; state.activeItem = cat.items[0]; renderCategories(); renderSubcategories(); renderParams(); });
            tabs.appendChild(btn);
        });
    }

    function renderSubcategories() {
        const list = document.getElementById('sfxSubcategoryList');
        list.innerHTML = '';
        if (state.customMode) {
            const hint = document.createElement('div');
            hint.className = 'text-xs opacity-40 px-2 py-3 leading-relaxed';
            hint.textContent = '自由模式下无需选择子类，直接在右侧描述你想要的音效即可';
            list.appendChild(hint);
            return;
        }
        state.activeCat.items.forEach(item => {
            const row = document.createElement('button');
            row.className = 'w-full text-left px-3 py-2 rounded-md text-sm transition-colors mb-1 flex items-center justify-between' +
                (item === state.activeItem ? ' text-white' : ' opacity-75 hover:opacity-100');
            if (item === state.activeItem) row.style.background = 'rgba(139, 92, 246, 0.35)';
            const name = document.createElement('span');
            name.textContent = item.name;
            row.appendChild(name);
            const arrow = document.createElement('span');
            arrow.className = 'opacity-50 text-xs';
            arrow.textContent = '›';
            row.appendChild(arrow);
            row.addEventListener('click', () => { state.activeItem = item; renderSubcategories(); renderParams(); });
            list.appendChild(row);
        });
    }

    // 通用滑块：灰轨道 + 紫色填充 + 紫色白边圆点（div 结构，不依赖浏览器伪元素，任何环境下都可见）
    function appendCustomSlider(box, cfg) {
        const min = cfg.min ?? 0;
        const max = cfg.max ?? 100;
        const wrap = document.createElement('div');
        const head = document.createElement('div');
        head.className = 'flex items-center justify-between mb-1.5';
        const label = document.createElement('span');
        label.className = 'text-sm font-medium';
        label.textContent = cfg.label;
        const val = document.createElement('span');
        val.className = 'text-xs opacity-60';
        val.textContent = cfg.getLabel();
        head.appendChild(label); head.appendChild(val);

        const trackWrap = document.createElement('div');
        trackWrap.className = 'relative flex items-center h-4';
        const track = document.createElement('div');
        track.className = 'relative w-full h-1.5 rounded-full overflow-hidden';
        track.style.background = 'rgba(128,128,128,.35)';
        const fill = document.createElement('div');
        fill.className = 'absolute left-0 top-0 h-full rounded-full';
        fill.style.background = '#8b5cf6';
        const thumb = document.createElement('div');
        thumb.className = 'absolute w-4 h-4 rounded-full';
        thumb.style.background = '#a78bfa';
        thumb.style.border = '2px solid #ffffff';
        thumb.style.boxShadow = '0 1px 4px rgba(0,0,0,.4)';
        thumb.style.top = '50%';
        thumb.style.transform = 'translateY(-50%)';
        const input = document.createElement('input');
        input.type = 'range';
        input.min = min; input.max = max; input.value = cfg.value();
        input.className = 'absolute inset-0 w-full opacity-0 cursor-pointer m-0';

        function sync() {
            const v = parseInt(input.value, 10);
            const pct = Math.round((v - min) / (max - min) * 100);
            fill.style.width = pct + '%';
            thumb.style.left = `calc(${pct}% - 8px)`;
            val.textContent = cfg.getLabel();
        }
        input.addEventListener('input', () => {
            cfg.set(parseInt(input.value, 10));
            sync();
            updatePromptPreview();
        });
        track.appendChild(fill); track.appendChild(thumb);
        trackWrap.appendChild(track); trackWrap.appendChild(input);
        wrap.appendChild(head); wrap.appendChild(trackWrap);
        box.appendChild(wrap);
        sync();
    }

    // ---------- 渲染：参数滑块 ----------
    function renderParams() {
        const item = state.activeItem;
        const box = document.getElementById('sfxParams');
        box.innerHTML = '';
        // 自定义音效：自由文本描述 + 时长
        if (state.customMode) {
            document.getElementById('sfxTitle').textContent = '自定义音效';
            document.getElementById('sfxSubtitle').textContent = '用你自己的话描述想要的音效，AI 会按描述生成';
            const wrap = document.createElement('div');
            wrap.className = 'mb-3';
            const label = document.createElement('div');
            label.className = 'text-sm font-medium mb-1.5';
            label.textContent = '音效描述';
            const ta = document.createElement('textarea');
            ta.id = 'sfxCustomPrompt';
            ta.className = 'w-full h-24 rounded-lg p-3 text-sm resize-none outline-none bg-black/5 dark:bg-white/10 border border-transparent focus:border-purple-500 transition-colors';
            ta.placeholder = '例如：教堂里的钟声，低沉悠长，带混响\n例如：老式打字机快速敲击的声音\n例如：雨滴打在铁皮屋顶上，由远及近';
            ta.value = state.customPrompt || '';
            ta.addEventListener('input', () => { state.customPrompt = ta.value; updatePromptPreview(); });
            wrap.appendChild(label); wrap.appendChild(ta);
            box.appendChild(wrap);
            // 声音距离滑杆
            appendCustomSlider(box, {
                label: '声音距离',
                getLabel: () => ['贴耳清晰，仿佛在耳边', '中等距离，清晰自然', '从远处传来，带空间混响'][Math.min(2, Math.round(state.distance / 100 * 2))],
                value: () => state.distance,
                set: v => { state.distance = v; },
            });
            // 声音强度滑杆
            appendCustomSlider(box, {
                label: '声音强度',
                getLabel: () => ['微弱，轻轻掠过', '适中，不吵不弱', '强烈，响亮有力'][Math.min(2, Math.round(state.intensity / 100 * 2))],
                value: () => state.intensity,
                set: v => { state.intensity = v; },
            });
            // 时长滑杆
            appendCustomSlider(box, {
                label: '时长',
                min: 5, max: 30,
                getLabel: () => state.duration + ' 秒',
                value: () => state.duration,
                set: v => { state.duration = v; },
            });
            updatePromptPreview();
            return;
        }
        document.getElementById('sfxTitle').textContent = item.name;
        document.getElementById('sfxSubtitle').textContent = item.desc || '';
        // 初始化参数值
        item.params.forEach(p => {
            if (!(p.key in state.values)) state.values[p.key] = p.default || 40;
        });
        item.params.forEach(p => {
            appendCustomSlider(box, {
                label: p.label,
                min: 0, max: 100,
                getLabel: () => wordFor(p),
                value: () => state.values[p.key],
                set: v => { state.values[p.key] = v; },
            });
        });
        // 时长滑杆
        appendCustomSlider(box, {
            label: '时长',
            min: 5, max: 30,
            getLabel: () => state.duration + ' 秒',
            value: () => state.duration,
            set: v => { state.duration = v; },
        });
        updatePromptPreview();
    }

    function wordFor(p) {
        const idx = Math.round((state.values[p.key] / 100) * (p.words.length - 1));
        return p.words[Math.min(idx, p.words.length - 1)];
    }

    function buildPrompt() {
        if (state.customMode) {
            let prompt = (state.customPrompt || '').trim();
            if (!prompt) prompt = '一段自然的音效环境声';
            const distWords = ['声音很近，贴耳清晰', '声音在中等距离，清晰自然', '声音从远处传来，带有空间混响感'];
            const intWords = ['声音非常微弱，轻轻掠过', '音量适中，不吵不弱', '声音强烈响亮，很有存在感'];
            const d = Math.min(distWords.length - 1, Math.round(state.distance / 100 * (distWords.length - 1)));
            const i = Math.min(intWords.length - 1, Math.round(state.intensity / 100 * (intWords.length - 1)));
            prompt += `，${distWords[d]}，${intWords[i]}，整体时长约${state.duration}秒，纯音效环境声，无任何语音和人声`;
            return prompt;
        }
        const item = state.activeItem;
        const v = {};
        item.params.forEach(p => { v[p.key] = wordFor(p); });
        let prompt = item.build(v);
        prompt += `，整体时长约${state.duration}秒，纯音效环境声，无任何语音和人声`;
        return prompt;
    }

    function updatePromptPreview() {
        const el = document.getElementById('sfxPromptPreview');
        if (el) el.textContent = buildPrompt();
    }

    // ---------- 生成 ----------
    async function generate() {
        if (state.generating) return;
        const btn = document.getElementById('sfxGenerateBtn');
        const status = document.getElementById('sfxGenStatus');
        const prompt = buildPrompt();
        state.generating = true;
        btn.disabled = true;
        status.textContent = '正在生成…（约 10-40 秒）';
        state.current = null;
        renderCurrentSound();
        try {
            const resp = await apiFetch('/api/v1/sfx/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text_prompt: prompt, format: 'mp3', sample_rate: 44100 }),
                timeoutMs: 180000
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.detail || data.message || '生成失败');
            state.current = {
                audio_path: data.audio_path,
                duration: data.duration,
                size: data.size,
                text_prompt: prompt,
                name: autoName(),
            };
            status.textContent = '生成完成，可试听后保存';
            renderCurrentSound();
            showNotification?.('音效生成完成', 'success');
        } catch (e) {
            status.textContent = '';
            console.error('[SFX] 生成失败:', e);
            showNotification?.('生成失败: ' + e.message, 'error');
        } finally {
            state.generating = false;
            btn.disabled = false;
        }
    }

    function autoName() {
        const cat = state.activeCat.name;
        const item = state.activeItem.name;
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        return `AI音效-${cat}-${item}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
    }

    // ---------- 播放（面板内独立播放，不干扰主播放器） ----------
    async function togglePlay(filePath) {
        try {
            if (state.playing && state.player && state.player.src) {
                state.player.pause();
                state.playing = false;
                renderCurrentSound();
                return;
            }
            const src = await rendererAudio.resolvePlaybackSource(
                { filePath }, { api: rendererApi, projectId: (window.currentProject && currentProject.id) || 'default' }
            );
            if (!state.player) state.player = new Audio();
            state.player.pause();
            state.player.src = src;
            await state.player.play();
            state.playing = true;
            renderCurrentSound();
            state.player.onended = () => { state.playing = false; renderCurrentSound(); };
        } catch (e) {
            console.error('[SFX] 播放失败:', e);
            showNotification?.('播放失败: ' + e.message, 'error');
        }
    }

    function renderCurrentSound() {
        const box = document.getElementById('sfxCurrentSound');
        if (!state.current) {
            box.innerHTML = '<div class="text-sm opacity-50">还没有生成</div>';
            return;
        }
        const c = state.current;
        const dur = (c.duration || 0).toFixed(1);
        const sizeMb = ((c.size || 0) / 1024 / 1024).toFixed(2);
        box.innerHTML = '';
        const name = document.createElement('div');
        name.className = 'text-sm font-medium mb-1 truncate';
        name.textContent = c.name;
        box.appendChild(name);
        const meta = document.createElement('div');
        meta.className = 'text-xs opacity-50 mb-2';
        meta.textContent = `${dur} 秒 · ${sizeMb} MB`;
        box.appendChild(meta);
        const controls = document.createElement('div');
        controls.className = 'flex items-center gap-2';
        const playBtn = document.createElement('button');
        playBtn.className = 'px-3 py-1.5 rounded-md text-xs font-medium text-white transition-colors hover:opacity-90';
        playBtn.style.background = state.playing ? '#ef4444' : '#3b82f6';
        playBtn.textContent = state.playing ? '停止' : '试听';
        playBtn.addEventListener('click', () => togglePlay(c.audio_path));
        const saveBtn = document.createElement('button');
        saveBtn.className = 'px-3 py-1.5 rounded-md text-xs font-medium text-white transition-colors hover:opacity-90';
        saveBtn.style.background = '#22c55e';
        saveBtn.textContent = '保存到库';
        saveBtn.addEventListener('click', saveCurrent);
        controls.appendChild(playBtn);
        controls.appendChild(saveBtn);
        box.appendChild(controls);
    }

    // ---------- 保存 ----------
    async function saveCurrent() {
        if (!state.current) { showNotification?.('请先生成音效', 'info'); return; }
        const c = state.current;
        const tags = [state.activeCat.name, state.activeItem.name];
        try {
            const resp = await apiFetch('/api/v1/sfx/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audio_path: c.audio_path, name: c.name, tags: tags }),
                timeoutMs: 60000
            });
            const data = await resp.json();
            if (!resp.ok || !data.success) throw new Error(data.detail || '保存失败');
            showNotification?.('已保存到音效库: ' + data.filename, 'success');
            const hist = loadHistory();
            hist.unshift({
                name: data.filename,
                duration: data.duration || c.duration,
                file_path: data.file_path,
                time: new Date().toLocaleString('zh-CN', { hour12: false })
            });
            saveHistory(hist);
            renderHistory();
        } catch (e) {
            console.error('[SFX] 保存失败:', e);
            showNotification?.('保存失败: ' + e.message, 'error');
        }
    }

    // ---------- 历史 ----------
    function renderHistory() {
        const list = loadHistory();
        document.getElementById('sfxHistoryCount').textContent = `${list.length} 条`;
        const box = document.getElementById('sfxHistoryList');
        box.innerHTML = '';
        if (!list.length) {
            box.innerHTML = '<div class="text-xs opacity-40 px-2 py-3">最近 100 条 · 关闭后仍保留</div>';
            return;
        }
        list.forEach((h, i) => {
            const row = document.createElement('div');
            row.className = 'flex items-center justify-between px-2.5 py-2 rounded-md hover:bg-black/5 dark:hover:bg-white/5';
            const left = document.createElement('div');
            left.className = 'flex-1 min-w-0';
            const nm = document.createElement('div');
            nm.className = 'text-xs font-medium truncate';
            nm.textContent = h.name;
            const meta = document.createElement('div');
            meta.className = 'text-[10px] opacity-40';
            meta.textContent = `${(h.duration || 0).toFixed(1)} 秒 · ${h.time || ''}`;
            left.appendChild(nm); left.appendChild(meta);
            const btn = document.createElement('button');
            btn.className = 'p-1.5 rounded-md hover:opacity-80 shrink-0';
            btn.innerHTML = '<i data-lucide="play" class="w-3.5 h-3.5"></i>';
            btn.title = '播放';
            btn.addEventListener('click', () => togglePlay(h.file_path));
            row.appendChild(left); row.appendChild(btn);
            box.appendChild(row);
        });
        if (window.lucide) { try { lucide.createIcons(); } catch (e) {} }
    }

    // ---------- 面板开关 ----------
    function openPanel() {
        document.getElementById('sfxModal').classList.remove('hidden');
        document.getElementById('sfxModal').classList.add('flex');
        renderCategories();
        renderSubcategories();
        renderParams();
        renderCurrentSound();
        renderHistory();
    }
    function closePanel() {
        if (state.player) { try { state.player.pause(); } catch (e) {} }
        state.playing = false;
        document.getElementById('sfxModal').classList.add('hidden');
        document.getElementById('sfxModal').classList.remove('flex');
    }

    function init() {
        const openBtn = document.getElementById('sfxMenuBtn');
        const closeBtn = document.getElementById('closeSfxModal');
        const genBtn = document.getElementById('sfxGenerateBtn');
        if (openBtn) openBtn.addEventListener('click', openPanel);
        if (closeBtn) closeBtn.addEventListener('click', closePanel);
        if (genBtn) genBtn.addEventListener('click', generate);
        document.addEventListener('keydown', e => {
            if (e.key === 'Escape') closePanel();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
