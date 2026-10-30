# -*- coding: utf-8 -*-
"""把一段参考音频注册成助理固定音色（Breeze 保存音色 + 写入 assistant_voice.txt）。

用法（先启动一次 EchoMind，让 breeze-server 跑起来）：

    python scripts/set_assistant_voice.py --sample D:/voice.wav --text "这段音频里说的原话"
    python scripts/set_assistant_voice.py --clear   # 恢复成指令少女音
"""
import argparse
import os
import shutil
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))

VOICE_DIR = Path(os.environ.get('APPDATA', '')) / 'EchoMind' / 'voices'
VOICE_FILE = Path(os.environ.get('APPDATA', '')) / 'EchoMind' / 'assistant_voice.txt'
NAME = 'echomind-assistant'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--sample', help='参考音频（wav/mp3，10~20 秒干净人声）')
    parser.add_argument('--text', help='参考音频里说的原话（必须逐字准确）')
    parser.add_argument('--clear', action='store_true', help='删除配置，恢复默认少女音')
    args = parser.parse_args()

    if args.clear:
        if VOICE_FILE.exists():
            VOICE_FILE.unlink()
        print('已清除固定音色配置，助理恢复成指令生成的少女音（重启软件后完全生效）')
        return 0

    if not args.sample or not args.text:
        parser.print_help()
        return 2
    sample = Path(args.sample)
    if not sample.is_file():
        print(f'找不到文件: {sample}')
        return 2

    from core import tts

    if not tts.breeze_available():
        print('Breeze 未启动：先打开一次 EchoMind，等右上角「模型就绪」再跑这个脚本')
        return 3

    VOICE_DIR.mkdir(parents=True, exist_ok=True)
    target = VOICE_DIR / (NAME + sample.suffix)
    shutil.copy2(sample, target)
    print(f'参考音频已复制到 {target}')

    profile = {'sample': str(target), 'ref_text': args.text.strip(), 'id': 'assistant'}
    t0 = time.time()
    voice_id = tts.register_saved_voice(profile, NAME)
    if not voice_id:
        print('注册失败：看后端日志里的 [TTS] 提示')
        return 4
    print(f'已注册保存音色 {voice_id}（{time.time() - t0:.1f}s）')

    VOICE_FILE.write_text(voice_id, encoding='utf-8')
    print(f'已写入 {VOICE_FILE}')

    test = tts.breeze_speak('你好，我是回声，现在用的是新的固定音色。', voice_id=voice_id)
    if test.get('ok'):
        print(f"试听文件: {test['path']}（{test.get('seconds')} 秒）")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())