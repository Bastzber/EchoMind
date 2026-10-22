# -*- coding: utf-8 -*-
"""中文音效词 → 英文检索词（本地词典，零延迟）。

CLAP 文本塔以英文为主，中文直接编码几乎无信号。LLM 翻译实测 30~110 秒，
不适合放在搜索主路径；这里用一张精选词典做即时转换，覆盖常见音效词。
未命中时返回 None，由调用方决定是否回退（保留原查询/扩展词）。
"""
from __future__ import annotations

import re
from typing import List, Optional

# 词典按「最长匹配优先」扫描，所以长词条要能被正确命中（如"玻璃破碎"先于"玻璃"）
_LEXICON = {
    # 天气 / 自然
    "下雨": "rain", "雨天": "rain", "雨": "rain", "雨声": "rain sound",
    "暴雨": "heavy rain", "水滴声": "water drop",
    "雷": "thunder", "打雷": "thunder", "雷声": "thunder", "闪电": "lightning",
    "风": "wind", "风声": "wind sound", "大风": "strong wind", "狂风": "gale",
    "雪": "snow", "冰雹": "hail", "水": "water", "流水": "water flow",
    "海浪": "ocean waves", "波浪": "waves", "河流": "river", "溪流": "stream",
    "瀑布": "waterfall", "水滴": "water drop", "沸腾": "boiling",
    "火": "fire", "火焰": "fire", "篝火": "campfire", "燃烧": "burning",
    "森林": "forest", "树林": "forest", "草地": "grassland", "沙漠": "desert",
    "海边": "seaside", "海滩": "beach", "洞穴": "cave", "夜晚": "night",
    # 动物
    "鸟": "bird", "鸟叫": "bird chirp", "鸡": "chicken", "鸭": "duck",
    "狗": "dog", "狗叫": "dog bark", "猫": "cat", "猫叫": "cat meow",
    "马": "horse", "牛": "cow", "羊": "sheep", "猪": "pig", "狼": "wolf",
    "狮": "lion", "老虎": "tiger", "熊": "bear", "猴": "monkey",
    "青蛙": "frog", "虫": "insect", "蜜蜂": "bee", "蚊子": "mosquito",
    "海豚": "dolphin", "鲸": "whale", "蛇": "snake", "老鼠": "mouse",
    # 人声
    "人声": "human voice", "说话": "speech", "对话": "conversation",
    "人群": "crowd", "喧哗": "crowd noise", "笑": "laughter", "笑声": "laughter",
    "哭": "crying", "婴儿": "baby", "小孩": "child", "女人": "woman",
    "男人": "man", "老人": "elderly", "尖叫": "scream", "喊叫": "shout",
    "呼吸": "breathing", "咳嗽": "cough", "叹气": "sigh", "打鼾": "snoring",
    "心跳": "heartbeat", "脚步": "footsteps", "走路": "walking",
    "鼓掌": "applause", "掌声": "applause", "亲吻": "kiss", "咀嚼": "chewing",
    # 动作 / 物理
    "碰撞": "impact", "撞击": "impact", "打击": "hit", "敲": "knock",
    "敲门": "knock on door", "锤": "hammer", "打碎": "smash",
    "破碎": "shatter", "玻璃破碎": "glass break", "玻璃": "glass",
    "金属": "metal", "金属碰撞": "metal impact", "铁": "iron",
    "木头": "wood", "木头碰撞": "wood impact", "纸": "paper",
    "塑料": "plastic", "陶瓷": "ceramic", "石头": "stone", "石头碰撞": "stone impact",
    "摩擦": "friction", "刮擦": "scrape", "撕裂": "rip", "断裂": "snap",
    "开关": "switch", "按钮": "button click", "点击": "click", "打字": "typing",
    "门": "door", "关门": "door slam", "开门": "door open", "窗": "window",
    "窗户": "window", "抽屉": "drawer", "柜子": "cabinet",
    "键盘": "keyboard", "鼠标": "mouse click", "拉链": "zipper",
    "倒水": "pouring water", "倒": "pour", "搅拌": "stirring",
    "转场": "transition", "上升": "rise", "下降": "fall", "呼啸": "whoosh",
    "呼啸声": "whoosh", "嗖": "whoosh", "冲击": "impact",
    # 交通
    "汽车": "car", "车": "car", "刹车": "brake", "喇叭": "horn",
    "摩托": "motorcycle", "火车": "train", "地铁": "subway", "飞机": "airplane",
    "直升机": "helicopter", "船": "boat", "引擎": "engine", "发动机": "engine",
    "轮胎": "tire", "油门": "accelerate",
    # 武器
    "枪": "gun", "枪声": "gunshot", "手枪": "pistol", "步枪": "rifle",
    "机枪": "machine gun", "炮": "cannon", "爆炸": "explosion",
    "炸弹": "bomb", "刀": "knife", "剑": "sword", "弓": "bow",
    "上膛": "gun reload", "弹壳": "shell casing",
    # 乐器 / 音乐
    "钢琴": "piano", "吉他": "guitar", "贝斯": "bass", "鼓": "drum",
    "架子鼓": "drum kit", "小提琴": "violin", "大提琴": "cello",
    "号": "horn", "小号": "trumpet", "笛": "flute", "萨克斯": "saxophone",
    "音乐": "music", "旋律": "melody", "和弦": "chord", "节奏": "rhythm",
    "铃": "bell", "钟": "bell", "铃声": "bell", "钟声": "church bell",
    # 机器 / 电子 / 提示
    "机械": "mechanical", "电机": "motor", "电流": "electricity",
    "电子": "electronic", "警报": "alarm", "警笛": "siren", "闹钟": "alarm clock",
    "提示音": "notification", "通知": "notification", "错误": "error",
    "成功": "success", "开机": "startup", "关机": "shutdown",
    "相机": "camera", "快门": "shutter", "闪光": "flash",
    "电锯": "chainsaw", "电钻": "drill", "风扇": "fan", "空调": "air conditioner",
    "吸尘器": "vacuum", "洗衣机": "washing machine", "微波炉": "microwave",
    # 场景
    "城市": "city", "街道": "street", "交通": "traffic", "机场": "airport",
    "车站": "train station", "办公室": "office", "餐厅": "restaurant",
    "厨房": "kitchen", "浴室": "bathroom", "教室": "classroom",
    "医院": "hospital", "教堂": "church", "市场": "market", "酒吧": "bar",
    "游戏": "game", "科幻": "sci-fi", "恐怖": "horror", "魔法": "magic",
}

# 结构性虚词：不参与匹配，避免"的/声音"把查询拖偏
_STOPWORDS = ("的声音", "声音", "音效", "的")

_SORTED_KEYS = sorted(_LEXICON.keys(), key=len, reverse=True)


def _clean(query: str) -> str:
    text = str(query or "").strip()
    for stop in _STOPWORDS:
        text = text.replace(stop, " ")
    return re.sub(r"\s+", " ", text).strip()


def translate_to_english(query: str) -> Optional[str]:
    """把中文查询转成英文检索词；无法转换时返回 None。"""
    text = _clean(query)
    if not text:
        return None

    matched: List[str] = []
    remaining = text
    for key in _SORTED_KEYS:
        if key in remaining:
            english = _LEXICON[key]
            if english not in matched:
                matched.append(english)
            remaining = remaining.replace(key, " ")
    if not matched:
        return None
    return " ".join(matched)
