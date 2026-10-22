# -*- coding: utf-8 -*-
"""快速诊断 melworker 子进程为什么大量返回 None。
只跑 3 个失败文件，输出 worker 内部异常到 stdout。"""
import sys, os, io, pickle, subprocess, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

BACKEND = r"E:\音效库管理软件\EchoMind\EchoMind-main\backend"
sys.path.insert(0, BACKEND)

import config  # noqa: E402

model_path = config.get_clap_model_name()
sample_rate = 48000
max_samples = 480000

fail_files = [
    r"D:\资源库\z秋拾实用音效库\5-底音 氛围环境音\21-自然环境类音\大自然、丛林、森林\鸭塘日出伴孔雀叫声.mp3",
    r"D:\资源库\z秋拾实用音效库\5-底音 氛围环境音\21-自然环境类音\水流、小溪、河流、瀑布、水滴\中等流速的河水与溪流潺潺流淌.wav",
    r"D:\资源库\z秋拾实用音效库\5-底音 氛围环境音\21-自然环境类音\水流、小溪、河流、瀑布、水滴\小溪，河4 (fcp2).wav",
    r"D:\资源库\z秋拾实用音效库\5-底音 氛围环境音\21-自然环境类音\水流、小溪、河流、瀑布、水滴\川口溪流.mp3",
]

# 模拟 _mel_round_trip：spawn 常驻子进程，发 req，读结果
proc = subprocess.Popen(
    [sys.executable, os.path.join(BACKEND, "core", "melworker.py")],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    cwd=BACKEND,
)
try:
    req = {"model_path": model_path, "sample_rate": sample_rate,
           "max_samples": max_samples, "paths": fail_files}
    proc.stdin.write(pickle.dumps(req))
    proc.stdin.flush()
    t0 = time.time()
    try:
        raw = proc.stdout.read()
        print("worker result time=%.1fs bytes=%d" % (time.time() - t0, len(raw)))
        res = pickle.loads(raw)
        for p, v in res.items():
            if v is None:
                print("FAIL:", os.path.basename(p))
            else:
                print("OK  :", os.path.basename(p), v.shape, v.dtype)
    except Exception as e:
        print("read error:", repr(e))
    err = proc.stderr.read()
    if err:
        print("--- worker stderr ---")
        print(err.decode("utf-8", errors="replace")[-3000:])
finally:
    proc.kill()
