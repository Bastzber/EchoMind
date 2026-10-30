/* EchoMind 助理形象控制（经典脚本，file:// 下可直接用） */
(function () {
  'use strict';
  var EXPRESSIONS = {
    neutral: {},
    smile: { eyeLOpen: 0.95, eyeROpen: 0.95, eyeSmile: 0.28, blush: 0.4, browY: 0.25 },
    shy: { eyeLOpen: 0.85, eyeROpen: 0.85, eyeSmile: 0.42, blush: 1, browAngle: -0.5, browY: -0.1, gazeY: 0.3 },
    surprise: { eyeLOpen: 1.18, eyeROpen: 1.18, browY: 1, mouthOpen: 0.22, mouthForm: 0.6 },
    thinking: { eyeLOpen: 0.72, eyeROpen: 0.72, gazeX: -0.45, gazeY: -0.3, browAngle: 0.35 }
  };

  function create(el) {
    var params = {};
    var current = 'neutral';
    var talkTimer = 0;
    var voiceTimer = 0;
    var voice = 0;
    var phase = 0;

    function api() { return el && el.avatar; }

    function express(name) {
      if (!EXPRESSIONS[name]) return;
      current = name;
      params = EXPRESSIONS[name];
      var a = api();
      if (!a) return;
      a.setExpression('neutral');
      a.setParameters(params, 1);
    }

    function stopTalk() {
      clearTimeout(talkTimer);
      clearInterval(voiceTimer);
      talkTimer = 0; voiceTimer = 0; voice = 0;
      var a = api();
      if (a) { a.setSpeaking(false); a.setVoiceLevel(0); }
    }

    /* 没有真实音频分析，就用文字长度估个时长，音量走正弦抖动 */
    function talk(text) {
      var a = api();
      if (!a) return;
      stopTalk();
      var ms = Math.min(15000, Math.max(1200, String(text || '').length * 180));
      a.setSpeaking(true);
      voiceTimer = setInterval(function () {
        phase += 0.55;
        voice = 0.32 + 0.3 * Math.abs(Math.sin(phase)) + Math.random() * 0.12;
        a.setVoiceLevel(voice);
      }, 90);
      talkTimer = setTimeout(stopTalk, ms);
    }

    return { express: express, talk: talk, stopTalk: stopTalk, get expression() { return current; } };
  }

  window.EchoMindAvatar = { create: create };
})();
