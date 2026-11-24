/* level-meter.js —— 播放条最左边的 L/R 电平表
 *
 * 为什么要 WebAudio：<audio> 元素本身拿不到音量包络，得把它的输出接进
 * AnalyserNode 再取时域数据算 RMS/峰值。
 *
 * 三个坑：
 * 1. createMediaElementSource 对同一个元素只能调用一次，重复调用会抛异常 —— 用标记位守住
 * 2. 接进 WebAudio 之后，声音只从 graph 出来，必须再 connect 到 destination，否则没声音
 * 3. 元素换 src（切歌）不用重建 graph，analyser 会跟着新数据走
 */
(function () {
    'use strict';

    var ctx = null;
    var analyser = null;
    var source = null;
    var attached = null;      // 已经接进 WebAudio 的 <audio> 元素
    var buf = null;
    var peak = { l: 0, r: 0 };
    var smooth = { l: 0, r: 0 };
    var running = false;

    function els() {
        return {
            l: document.getElementById('levelL'),
            r: document.getElementById('levelR'),
            pl: document.getElementById('peakL'),
            pr: document.getElementById('peakR'),
            wrap: document.getElementById('levelMeter'),
        };
    }

    function ensureGraph(el) {
        if (!el || attached === el) return analyser;
        try {
            var Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return null;
            if (!ctx) ctx = new Ctx();
            if (attached) return analyser;   // 同一元素之外不重建，避免重复 source 报错
            source = ctx.createMediaElementSource(el);
            analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            analyser.smoothingTimeConstant = 0.65;
            source.connect(analyser);
            analyser.connect(ctx.destination);   // 必须接出来，否则静音
            buf = new Float32Array(analyser.fftSize);
            attached = el;
            return analyser;
        } catch (error) {
            // 已经建过 source 的元素会走到这里；不影响播放
            console.warn('[level-meter] WebAudio 接入失败:', error && error.message);
            return analyser;
        }
    }

    function channelRms(data, start, end) {
        var sum = 0;
        for (var i = start; i < end; i += 1) sum += data[i] * data[i];
        return Math.sqrt(sum / Math.max(1, end - start));
    }

    // RMS -> 0..1 的条高（-48dB 以下当静音，压一点动态让肉眼好看）
    function toBar(rms) {
        if (rms <= 0.0008) return 0;
        var db = 20 * Math.log10(rms);
        var norm = (db + 48) / 48;
        return Math.max(0, Math.min(1, Math.pow(norm, 0.75)));
    }

    // audioPlayer 是 playback-speed.js 里的顶层 let：那个文件比本文件晚执行，
    // 直接引用会撞 TDZ（ReferenceError），所以每次都 try 一下再取
    function currentPlayer() {
        try {
            return typeof audioPlayer !== 'undefined' && audioPlayer ? audioPlayer : null;
        } catch (error) {
            return null;
        }
    }

    function tick() {
        if (!running) return;
        var ui = els();
        var el = currentPlayer();
        var active = Boolean(el) && !el.paused && !el.ended;

        var targetL = 0, targetR = 0;
        if (active) {
            if (!analyser) ensureGraph(el);
            if (ctx && ctx.state === 'suspended') ctx.resume().catch(function () { });
            if (analyser) {
                analyser.getFloatTimeDomainData(buf);
                // 单声道文件两路都填同样的值，听感上不会一半不亮
                var half = Math.floor(buf.length / 2);
                targetL = toBar(channelRms(buf, 0, half));
                targetR = toBar(channelRms(buf, half, buf.length));
                if (el.channelCount === 1 || !el.channelCount) { targetR = targetL; }
            }
        }

        smooth.l += (targetL - smooth.l) * 0.45;
        smooth.r += (targetR - smooth.r) * 0.45;
        peak.l = Math.max(smooth.l, peak.l - 0.012);
        peak.r = Math.max(smooth.r, peak.r - 0.012);

        if (ui.l) ui.l.style.height = (smooth.l * 100).toFixed(1) + '%';
        if (ui.r) ui.r.style.height = (smooth.r * 100).toFixed(1) + '%';
        if (ui.pl) {
            ui.pl.style.bottom = (peak.l * 100).toFixed(1) + '%';
            ui.pl.style.opacity = peak.l > 0.06 ? '0.75' : '0';
        }
        if (ui.pr) {
            ui.pr.style.bottom = (peak.r * 100).toFixed(1) + '%';
            ui.pr.style.opacity = peak.r > 0.06 ? '0.75' : '0';
        }
        requestAnimationFrame(tick);
    }

    function start() {
        if (running) return;
        running = true;
        requestAnimationFrame(tick);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
