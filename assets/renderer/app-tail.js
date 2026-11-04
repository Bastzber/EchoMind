    (function () {
      'use strict';
      var el = document.getElementById('navAvatar');
      if (!el || !window.EchoMindAvatar) return;
      var avatar = window.EchoMindAvatar.create(el);
      window.echoAvatar = avatar;

      // 发消息 → 思考
      document.addEventListener('click', function (e) {
if (e.target && e.target.closest && e.target.closest('#sendMessage')) {
  if (avatar) avatar.express('thinking');
}
      }, true);

      // 收到回复 → 微笑，几秒后回到平常
      var msgs = document.getElementById('chatMessages');
      if (msgs && window.MutationObserver) {
var smileTimer = 0;
new MutationObserver(function (records) {
  var added = records.some(function (r) { return r.addedNodes && r.addedNodes.length; });
  if (!added || !avatar) return;
  avatar.express('smile');
  clearTimeout(smileTimer);
  smileTimer = setTimeout(function () { avatar.express('neutral'); }, 5000);
}).observe(msgs, { childList: true });
      }

      // 播报语音时对口型（没有音频分析，按文字长度估时长）
      function hookSpeak() {
if (!window.rendererApi || !window.rendererApi.post || window.rendererApi.__avatarHooked) return;
var orig = window.rendererApi.post.bind(window.rendererApi);
window.rendererApi.post = function (url, body, opts) {
  try {
    if (String(url).indexOf('/assistant/speak') >= 0 && avatar) {
      avatar.talk(body && body.text);
    }
  } catch (err) {}
  return orig(url, body, opts);
};
window.rendererApi.__avatarHooked = true;
      }
      hookSpeak();
      setTimeout(hookSpeak, 1500);
    })();
