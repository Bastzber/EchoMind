// host.jsx —— 在 PR 里执行的小脚本：把素材导入当前项目。
// 面板通过 evalScript('EchoMindImport("路径")') 调用。
//
// 说明：PR 的面板 API 不能把素材直接拖进时间线，所以流程是
// 「导入到项目面板」→ 用户在项目面板里拖一下。这是所有音频库插件的通行做法。

function EchoMindImport(filePath) {
    try {
        if (!app.project) {
            return 'NO_PROJECT';
        }
        var ok = app.project.importFiles([filePath], true, app.project.rootItem, false);
        return ok ? 'OK' : 'FAIL';
    } catch (e) {
        return 'ERROR:' + e.toString();
    }
}

function EchoMindPing() {
    try {
        return app.version ? ('PR ' + app.version) : 'PR';
    } catch (e) {
        return 'ERROR';
    }
}
