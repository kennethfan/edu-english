#!/usr/bin/env python3
"""从一张源图生成 Android 全套启动图标（适配式 + 传统）。

用法:
    /Users/kenneth/anaconda3/envs/python3.12/bin/python3 scripts/make-icons.py <source.png>

为什么用「边缘泛洪」抠底而不是全图去白:
    徽标内部有白色的字母 "A" 和汉字 "文"。若按颜色全局去白，这两个字会被一起抠穿。
    源图徽标外轮廓是粗黑描边且闭合，因此从四边泛洪只会吃掉外部背景，字被围在里面不受影响。

产出（写入 android/app/src/main/res/，删除后重跑即可完全重建）:
    mipmap-*/ic_launcher.png             传统方形（圆角矩形底）
    mipmap-*/ic_launcher_round.png       传统圆形（圆形底）
    mipmap-*/ic_launcher_foreground.png  适配式前景（透明底，内容居中留安全区）
    mipmap-*/ic_launcher_background.png  适配式背景（浅蓝渐变）
    ../../assets/icon-emblem.png         抠好的透明底徽标母版（供后续复用）
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# ---------- 可调参数 ----------

# 背景渐变（上 → 下）。选浅蓝是因为徽标带粗黑描边 + 蓝/橙两色卡片，
# 浅底能让描边和两种主色都保持最高对比。
BG_TOP = (234, 242, 255)      # #EAF2FF
BG_BOTTOM = (191, 213, 255)   # #BFD5FF

# 自适应图标：108dp 画布，系统取中央 72dp 后再套遮罩，内容须落在中央安全区。
ADAPTIVE_EMBLEM_RATIO = 0.54  # 徽标占画布比例（0.60 实测离圆形遮罩边缘过近，收紧到 0.54）
LEGACY_SQUARE_RATIO = 0.68    # 传统方形图标中徽标占比
LEGACY_ROUND_RATIO = 0.62     # 传统圆形图标中徽标占比（圆会切角，略留边距）
SQUARE_CORNER_RATIO = 0.22    # 传统方形图标的圆角半径占边长比例

# 去底阈值: 与种子像素(四角)每通道差值 <= 此值的像素视为背景。
# 取小值(25)是为了不吃掉中央那簇淡黄色火花(B 通道约 196, 距白 59)。
KEY_THRESHOLD = 25
ERODE_PX = 1                  # 收边像素（1024 母版尺度），用来压掉描边的浅色抗锯齿晕
FEATHER_PX = 1.0              # 羽化半径

# 各密度目标尺寸（dp → px），key 为 mipmap 目录名
DENSITIES = {
    "mdpi": 1.0, "hdpi": 1.5, "xhdpi": 2.0, "xxhdpi": 3.0, "xxxhdpi": 4.0,
}
ADAPTIVE_DP = 108
LEGACY_DP = 48

ROOT = Path(__file__).resolve().parent.parent
RES = ROOT / "android" / "app" / "src" / "main" / "res"
ASSETS = ROOT / "assets"


def key_out_background(src: Image.Image) -> Image.Image:
    """边缘泛洪抠底，返回 RGBA 徽标（已按内容裁剪）。"""
    rgb = src.convert("RGB")
    w, h = rgb.size

    sentinel = (255, 0, 255)  # 洋红哨兵色，正常图里不会出现
    work = rgb.copy()
    seeds = [
        (0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
        (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2),
    ]
    for s in seeds:
        if work.getpixel(s) != sentinel:
            ImageDraw.floodfill(work, s, sentinel, thresh=KEY_THRESHOLD)

    arr = np.asarray(work).astype(np.int16)
    is_bg = (arr[:, :, 0] == 255) & (arr[:, :, 1] == 0) & (arr[:, :, 2] == 255)

    alpha = np.where(is_bg, 0, 255).astype(np.uint8)
    mask = Image.fromarray(alpha, "L")
    mask = mask.filter(ImageFilter.MinFilter(2 * ERODE_PX + 1))   # 收边
    mask = mask.filter(ImageFilter.GaussianBlur(FEATHER_PX))      # 羽化

    out = rgb.convert("RGBA")
    out.putalpha(mask)

    box = mask.point(lambda v: 255 if v > 8 else 0).getbbox()
    if box:
        out = out.crop(box)
    return out


def gradient(size: int) -> Image.Image:
    """生成 BG_TOP → BG_BOTTOM 的竖直渐变底。"""
    col = Image.new("RGB", (1, size))
    px = col.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM))
    return col.resize((size, size), Image.NEAREST)


def emblem_at(emblem: Image.Image, target: int) -> Image.Image:
    """把徽标等比缩放到最长边 = target。"""
    e = emblem.copy()
    e.thumbnail((target, target), Image.LANCZOS)
    return e


def paste_center(canvas: Image.Image, item: Image.Image) -> None:
    x = (canvas.width - item.width) // 2
    y = (canvas.height - item.height) // 2
    canvas.alpha_composite(item, (x, y))


def masked(bg: Image.Image, shape: str) -> Image.Image:
    """给背景套遮罩（rounded=圆角方形 / circle=圆形）。"""
    size = bg.width
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    if shape == "circle":
        d.ellipse((0, 0, size - 1, size - 1), fill=255)
    else:
        r = max(1, round(size * SQUARE_CORNER_RATIO))
        d.rounded_rectangle((0, 0, size - 1, size - 1), radius=r, fill=255)
    out = bg.copy()
    out.putalpha(m)
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    src_path = Path(sys.argv[1]).expanduser().resolve()
    if not src_path.is_file():
        print(f"[x] 源图不存在: {src_path}")
        return 1

    src = Image.open(src_path)
    print(f"[i] 源图: {src_path.name}  mode={src.mode}  size={src.size}")

    emblem = key_out_background(src)
    ASSETS.mkdir(parents=True, exist_ok=True)
    master = ASSETS / "icon-emblem.png"
    emblem.save(master)
    print(f"[+] 透明底徽标母版: {master.relative_to(ROOT)}  ({emblem.width}x{emblem.height})")

    for name, scale in DENSITIES.items():
        d = RES / f"mipmap-{name}"
        d.mkdir(parents=True, exist_ok=True)

        a_size = round(ADAPTIVE_DP * scale)
        bg = gradient(a_size)
        bg.save(d / "ic_launcher_background.png")

        fg = Image.new("RGBA", (a_size, a_size), (0, 0, 0, 0))
        paste_center(fg, emblem_at(emblem, round(a_size * ADAPTIVE_EMBLEM_RATIO)))
        fg.save(d / "ic_launcher_foreground.png")

        l_size = round(LEGACY_DP * scale)
        sq = masked(gradient(l_size), "square")
        paste_center(sq, emblem_at(emblem, round(l_size * LEGACY_SQUARE_RATIO)))
        sq.save(d / "ic_launcher.png")

        rd = masked(gradient(l_size), "circle")
        paste_center(rd, emblem_at(emblem, round(l_size * LEGACY_ROUND_RATIO)))
        rd.save(d / "ic_launcher_round.png")

        print(f"[+] mipmap-{name}: adaptive={a_size}px  legacy={l_size}px")

    print("[ok] 完成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
