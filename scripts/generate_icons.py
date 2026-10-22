#!/usr/bin/env python3
"""
生成应用图标脚本
从 SoundBot.png 生成各种平台所需的图标格式
"""

import os
import sys
from pathlib import Path
from PIL import Image

# 项目路径
PROJECT_ROOT = Path(__file__).parent.parent
BUILD_DIR = PROJECT_ROOT / "build"
SOURCE_IMAGE = PROJECT_ROOT / "SoundBot.png"

# 图标尺寸配置
ICON_SIZES = {
    "macos": [16, 32, 64, 128, 256, 512, 1024],
    "windows": [16, 20, 24, 32, 40, 48, 64, 128, 256],
    "png": [16, 32, 64, 128, 256, 512, 1024],
}


def generate_macos_icon():
    """生成 macOS .icns 文件"""
    print("生成 macOS icon.icns...")
    
    from PIL import Image
    import tempfile
    import shutil
    
    # 创建临时目录
    with tempfile.TemporaryDirectory() as tmpdir:
        iconset_dir = Path(tmpdir) / "icon.iconset"
        iconset_dir.mkdir()
        
        # 打开源图片
        img = Image.open(SOURCE_IMAGE)
        
        # 确保是正方形
        size = min(img.size)
        img = img.crop((0, 0, size, size))
        
        # 生成各种尺寸
        for size in ICON_SIZES["macos"]:
            # 1x
            icon_1x = img.resize((size, size), Image.Resampling.LANCZOS)
            icon_1x.save(iconset_dir / f"icon_{size}x{size}.png")
            
            # 2x (如果尺寸允许)
            if size * 2 <= 1024:
                icon_2x = img.resize((size * 2, size * 2), Image.Resampling.LANCZOS)
                icon_2x.save(iconset_dir / f"icon_{size}x{size}@2x.png")
        
        # 使用 iconutil 生成 icns (macOS only)
        output_path = BUILD_DIR / "icon.icns"
        result = os.system(f"iconutil -c icns {iconset_dir} -o {output_path}")
        
        if result == 0:
            print(f"✅ 已生成: {output_path}")
        else:
            print("⚠️  iconutil 失败，尝试使用 Python 生成...")
            # 回退方案：只生成最大的 PNG
            img.save(output_path.with_suffix(".png"))
            print(f"✅ 已生成: {output_path.with_suffix('.png')}")


def generate_windows_icon():
    """生成 Windows .ico 文件"""
    print("生成 Windows icon.ico...")
    
    img = Image.open(SOURCE_IMAGE)
    
    # 确保是正方形
    size = min(img.size)
    img = img.crop((0, 0, size, size))
    
    # 转换为 RGBA 模式（支持透明）
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    
    # 生成各种尺寸
    icons = []
    for size in sorted(ICON_SIZES["windows"], reverse=True):
        icon = img.resize((size, size), Image.Resampling.LANCZOS)
        icons.append(icon)
    
    # 保存为 .ico
    output_path = BUILD_DIR / "icon.ico"
    icons[0].save(
        output_path,
        format='ICO',
        sizes=[(i.width, i.height) for i in icons]
    )
    
    print(f"✅ 已生成: {output_path}")
    print(f"   包含尺寸: {', '.join(str(s) for s in ICON_SIZES['windows'])}")


def generate_png_icons():
    """生成各种尺寸的 PNG 图标"""
    print("生成 PNG 图标...")
    
    img = Image.open(SOURCE_IMAGE)
    
    # 确保是正方形
    size = min(img.size)
    img = img.crop((0, 0, size, size))
    
    for size in ICON_SIZES["png"]:
        icon = img.resize((size, size), Image.Resampling.LANCZOS)
        output_path = BUILD_DIR / f"icon_{size}x{size}.png"
        icon.save(output_path)
        print(f"✅ 已生成: {output_path}")


def main():
    """主函数"""
    print("=" * 60)
    print("SoundBot 图标生成工具")
    print("=" * 60)
    
    # 检查源文件
    if not SOURCE_IMAGE.exists():
        print(f"❌ 错误: 找不到源文件 {SOURCE_IMAGE}")
        sys.exit(1)
    
    print(f"源文件: {SOURCE_IMAGE}")
    
    # 确保 build 目录存在
    BUILD_DIR.mkdir(exist_ok=True)
    
    try:
        # 生成 Windows 图标
        generate_windows_icon()
        print()
        
        # 生成 macOS 图标
        if sys.platform == "darwin":
            generate_macos_icon()
        else:
            print("⚠️  非 macOS 系统，跳过 .icns 生成")
            # 生成一个大的 PNG 作为替代
            img = Image.open(SOURCE_IMAGE)
            size = min(img.size)
            img = img.crop((0, 0, size, size))
            img.save(BUILD_DIR / "icon.png")
            print(f"✅ 已生成: {BUILD_DIR / 'icon.png'}")
        print()
        
        # 生成各种尺寸的 PNG
        generate_png_icons()
        
        print()
        print("=" * 60)
        print("🎉 图标生成完成！")
        print(f"输出目录: {BUILD_DIR}")
        print("=" * 60)
        
    except Exception as e:
        print(f"❌ 错误: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
