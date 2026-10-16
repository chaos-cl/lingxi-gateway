#!/usr/bin/env python3
"""生成应用图标：1024 渐变圆角方块 + 「139」+ 副标（与面板品牌色一致）"""
from PIL import Image, ImageDraw, ImageFont
import os, sys

S = 1024
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon.png")

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def font(size):
    candidates = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/HelveticaNeue.ttc",
        "/System/Library/Fonts/SFNS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/Library/Fonts/Arial Bold.ttf",
    ]
    for p in candidates:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# 渐变底（#3b82f6 → #22d3ee，斜向）
grad = Image.new("RGB", (S, S))
gd = grad.load()
c1, c2 = (59, 130, 246), (34, 211, 238)
for y in range(S):
    for x in range(0, S, 4):
        t = (x + y) / (2 * S)
        col = lerp(c1, c2, t)
        for dx in range(4):
            if x + dx < S:
                gd[x + dx, y] = col
grad = grad.resize((S, S))

# 圆角遮罩（macOS 风格超椭圆近似）
mask = Image.new("L", (S, S), 0)
md = ImageDraw.Draw(mask)
pad = int(S * 0.086)          # 与 macOS 图标留白一致
radius = int(S * 0.225)
md.rounded_rectangle([pad, pad, S - pad, S - pad], radius=radius, fill=255)
img.paste(grad, (0, 0), mask)

d = ImageDraw.Draw(img)

# 顶部高光
hi = Image.new("RGBA", (S, S), (0, 0, 0, 0))
hd = ImageDraw.Draw(hi)
hd.rounded_rectangle([pad, pad, S - pad, int(S * 0.5)], radius=radius, fill=(255, 255, 255, 34))
img.alpha_composite(hi)

# 主文字 139（anchor=mm 精确居中）
f_main = font(int(S * 0.335))
d.text((S / 2, S * 0.415), "139", font=f_main, fill=(255, 255, 255, 255), anchor="mm")

# 分隔线（位于数字下方，不与文字重叠）
d.rounded_rectangle([S * 0.315, S * 0.632, S * 0.685, S * 0.641], radius=6, fill=(255, 255, 255, 130))

# 副标 AI GATEWAY
f_sub = font(int(S * 0.072))
d.text((S / 2, S * 0.712), "AI GATEWAY", font=f_sub, fill=(255, 255, 255, 235), anchor="mm")

img.save(OUT)
print("icon.png ->", OUT, img.size)
