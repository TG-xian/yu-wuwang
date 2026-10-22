"""
生成应用图标：九爻印（豫 + 无妄叠合）——外框 + 九爻，画在深色圆角底上。
输出 assets/icon-{16,32,48,64,128,256}.png
爻序（上→下）：[1,1,1, 0,0,1, 0,0,0]  —— 乾3实 / 震(断断实) / 坤3断
"""
from PIL import Image, ImageDraw
import os

GOLD = (201, 162, 39, 255)
GOLD_L = (232, 199, 102, 255)
GOLD_D = (138, 109, 31, 255)
BG = (10, 10, 11, 255)
SEQ = [1, 1, 1, 0, 0, 1, 0, 0, 0]

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets')
os.makedirs(OUT, exist_ok=True)
S = 1024  # 超采样后缩小


def draw_mark(size, with_bg=True, with_frame=True, padding=0.12):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    if with_bg:
        radius = int(size * 0.22)
        d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=BG)

    pad = size * padding
    w = size - pad * 2

    # ── 外框：和 SVG 的 std 一样，方形描边包住九爻 ──
    frame_w = max(2, int(round(size * 0.026)))
    if with_frame:
        d.rectangle([pad, pad, size - pad, size - pad], outline=GOLD, width=frame_w)

    # 框内可用区域（扣掉框线本身）
    inner_x0 = pad + frame_w
    inner_y0 = pad + frame_w
    inner = w - frame_w * 2

    # ── 九爻：横竖都占 inner 的 78%，居中 ──
    # 旧版 lw=0.082w / gap=0.045w 算出总高 1.098w > 可用高度，
    # y 偏移变负数、最下爻压到框上，这就是「爻和边框重叠」的根因。
    lw = inner * 0.058          # 线粗
    gap = inner * 0.031         # 爻间距 → 总高 inner × 0.786
    total_h = 9 * lw + 8 * gap
    line_w = inner * 0.78
    gap_seg = inner * 0.13      # 断爻中间的空隙
    x0 = inner_x0 + (inner - line_w) / 2
    y = inner_y0 + (inner - total_h) / 2

    for i, solid in enumerate(SEQ):
        # 上爻亮、下爻暗（和 SVG 一致）
        color = GOLD_L if i < 3 else (GOLD if i < 6 else GOLD_D)
        if solid:
            d.rounded_rectangle([x0, y, x0 + line_w, y + lw], radius=lw * 0.2, fill=color)
        else:
            seg = (line_w - gap_seg) / 2
            d.rounded_rectangle([x0, y, x0 + seg, y + lw], radius=lw * 0.2, fill=color)
            d.rounded_rectangle([x0 + seg + gap_seg, y, x0 + line_w, y + lw], radius=lw * 0.2, fill=color)
        y += lw + gap
    return img


for px in (16, 24, 32, 48, 64, 128, 256):
    # 小尺寸去掉底、加粗线，否则糊成一团
    small = px <= 32
    base = draw_mark(S, with_bg=not small, with_frame=not small,
                     padding=0.08 if small else 0.12)
    img = base.resize((px, px), Image.LANCZOS)
    path = os.path.join(OUT, f'icon-{px}.png')
    img.save(path)
    print(f'icon-{px}.png')

# macOS 的 icns 由 electron-builder 从大尺寸 png 自动生成（需要 512 以上）
for px in (512, 1024):
    base = draw_mark(S, with_bg=True, with_frame=True, padding=0.12)
    base.resize((px, px), Image.LANCZOS).save(os.path.join(OUT, f'icon-{px}.png'))
    print(f'icon-{px}.png')

# electron-builder 认这个文件名做图标源
base = draw_mark(S, with_bg=True, with_frame=True, padding=0.12)
base.resize((1024, 1024), Image.LANCZOS).save(os.path.join(OUT, 'icon.png'))
print('icon.png')

# Windows 托盘/窗口/exe 用 ico（多尺寸）
ico_sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
base = draw_mark(S, with_bg=True, with_frame=True, padding=0.12)
tmp = os.path.join(OUT, '_master.png')
base.save(tmp)
Image.open(tmp).save(os.path.join(OUT, 'icon.ico'), sizes=ico_sizes)
os.remove(tmp)
print('icon.ico')
