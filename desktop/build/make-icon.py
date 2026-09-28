"""
生成桌面端应用图标 desktop/build/icon.ico —— 「晶面层叠」标记（v6-b）。

几何：四层圆角方块沿 45° 方向逐层错位、逐层收缩，每层自带一条向下的厚度边。
晶体本来就是一层层原子面堆起来的，格物就是一层层读进去 —— 用「层」这个
语义同时说清「格」和「物」，不靠描边、不用渐变，八块平色堆出体积。

配色：四层面色在 OKLab 明度轴上等距（层间步长 0.179/0.191/0.177），
彩度中段鼓起、两端收敛；深端色相往青 4° 抵消 sRGB 低明度下的紫倾向。
**色阶跟面积走**：最亮的一档只占可见面积的 23%，亮色一旦铺开就不再是焦点。

同一套标记也用在 web/index.html 的 favicon（那边取三层简化版）。
改标记时两处要一起改（favicon data URI 由本脚本打印）。

产物落两个地方：
- build/icon.ico  —— 给 electron-builder 打包用（electron-builder.yml 的 win.icon）
- ../assets/icon.ico —— 给运行时用（窗口/任务栏图标，见 src/main.js）。
  build/ 是 electron-builder 的 buildResources 目录，不会被拷进应用，所以要另存一份。

改图标改这里的常量后重跑：

    python build/make-icon.py

依赖 Pillow（仅生成图标时需要，不属于应用运行时依赖）。
"""

import shutil
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BASE = 1024
SS = 4                     # 超采样倍数：在 4096 上画再降采样，斜边不会有硬锯齿

# ---------- 交付尺寸 ----------
# 画布稿的几何占到画布 86.5%（留边 69），但交付时要再收一点：错位让左上角与右下角
# 分别顶到更外，按 1.0 交付会显得「顶格」。0.92 之后四边留白 9% / 6%（底边含厚度边）。
# 这个系数只做整体缩放，几何一字不动。
MARK_SCALE = 0.92

# ---------- 标记几何（1024 坐标系，与 Ardot 画布稿 rect 逐一对应）----------
# (边长, 错位序号, 圆角, 顶面色, 厚度色)。错位序号 0 = 底层，最大。
LAYERS = [
    (886, 0, 168, "#162585", "#040A46"),
    (754, 1, 136, "#3B50DF", "#1F2EA2"),
    (622, 2, 104, "#7B96FF", "#4C68EB"),
    (490, 3, 72, "#C6D6FF", "#90A9FF"),
]
OFF_STEP = 100             # 每层沿 45° 反向错位的步长（画布坐标）
K45 = 0.70710678
THICK = 46                 # 每层厚度边的高度；厚度色一律取色板里的下一档，不要机械压暗

# ---------- 小尺寸简化几何 ----------
# 完整几何每层的 L 形露出只有 66 单位：16px 下 1.0px、24px 下 1.5px，缩下去必糊。
# 简化策略 = 减少层数（四层→三层）+ 拉大明度跨度，保住「错位层叠」这个识别特征
# （而不是退化成「方块套方块」——那样和几何无关的图标库素材没区别）。
#
# 三层是实测的下限：两层在 16px 下虽然更干净，但丢掉中间那档明度之后，
# 读起来只剩「深蓝框 + 浅蓝块」，层叠的语义就没了。
SIMPLE_AT_OR_BELOW = 24
TINY = [
    (920, 0, 180, "#162585"),
    (640, 86, 124, "#3B50DF"),
    (360, 172, 56, "#C6D6FF"),
]

SIZES = [16, 24, 32, 48, 64, 128, 256]
PNG_SIZES = [1024, 512, 256, 128, 64, 48, 32, 24, 16]

OUT_DIR = Path(__file__).resolve().parent
ASSETS_DIR = OUT_DIR.parent / "assets"      # 运行时读取的那一份（随包分发）


# ---------------- 几何 ----------------
def place(size, off_i, rad, scale=MARK_SCALE, step=OFF_STEP):
    """按交付比例求一个方块的位置：中心绕画布中心反向错位 off_i 步。"""
    c = BASE / 2
    d = round(step * off_i * K45 * scale)
    sz = size * scale
    r = rad * scale
    return (c - d - sz / 2, c - d - sz / 2, sz, r)


def full_layers(scale=MARK_SCALE):
    out = []
    for size, off_i, rad, top, side in LAYERS:
        x, y, w, r = place(size, off_i, rad, scale)
        out.append((x, y, w, r, top, side))
    return out


def simple_layers(scale=MARK_SCALE):
    """简化版：底块 + 逐层错位的浅色块，无厚度边（小尺寸下那条边只有零点几像素）。"""
    out = []
    for size, off, rad, col in TINY:
        x, y, w, r = place(size, off / OFF_STEP, rad, scale=scale)
        out.append((x, y, w, r, col, col))
    return out


# ---------------- 渲染 ----------------
def render(layers):
    img = Image.new("RGBA", (BASE * SS, BASE * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    for x, y, w, r, top, side in layers:
        box = [round(v * SS) for v in (x, y, x + w, y + w)]
        rad = round(r * SS)
        if side != top:
            # 厚度边先画（在顶面之下），顶面后压上去
            draw.rounded_rectangle([box[0], box[1] + round(THICK * SS), box[2], box[3] + round(THICK * SS)],
                                   radius=rad, fill=side, outline=side)
        draw.rounded_rectangle(box, radius=rad, fill=top, outline=top)
    return img


def downsample(img, size):
    """逐级减半再 LANCZOS 收尾，比一步缩到底锐利也干净。"""
    cur, w = img, BASE
    while w // 2 >= size:
        w //= 2
        cur = cur.resize((w, w), Image.LANCZOS)
    if w != size:
        cur = cur.resize((size, size), Image.LANCZOS)
    return cur


# ---------------- 产物 ----------------
def build_ladder(frames, out_path):
    """对照图：上排 1× 实际大小，下排最近邻放大看像素真相。图标靠缩小后的样子被判断。"""
    pad, label_w = 24, 132
    native = [128, 64, 48, 32, 24, 16]
    zooms = [(64, 3), (32, 6), (16, 12)]

    row_a_w = sum(native) + pad * (len(native) - 1)
    row_b_w = sum(s * z for s, z in zooms) + pad * (len(zooms) - 1)
    width = label_w + max(row_a_w, row_b_w) + pad * 2
    height = pad + 40 + 150 + 30 + 40 + 204 + pad

    img = Image.new("RGB", (width, height), "#FFFFFF")
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 15)
        font_sm = ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", 12)
    except OSError:
        font = font_sm = ImageFont.load_default()

    baseline_a = pad + 40 + 150
    draw.text((pad, pad), "1× 实际大小", font=font, fill="#101322")
    x = label_w
    for size in native:
        frame = frames[size]
        img.paste(frame, (x, baseline_a - size), frame)
        draw.text((x, baseline_a + 6), f"{size}", font=font_sm, fill="#7A8497")
        x += size + pad

    draw.text((pad, baseline_a + 44), "最近邻放大", font=font, fill="#101322")
    baseline_b = baseline_a + 44 + 40
    x = label_w
    for size, zoom in zooms:
        px = size * zoom
        big = frames[size].resize((px, px), Image.NEAREST)
        img.paste(big, (x, baseline_b), big)
        draw.text((x, baseline_b + px + 6), f"{size}px ×{zoom}", font=font_sm, fill="#7A8497")
        x += px + pad

    img.save(out_path)
    return out_path


def _rect(x, y, size, rad, fill):
    return (f'<rect x="{x:.0f}" y="{y:.0f}" width="{size:.0f}" height="{size:.0f}" '
            f'rx="{rad:.0f}" fill="{fill}"/>')


def build_svg(out_path):
    """矢量源，几何与 PNG 完全一致（已按交付比例缩放）。"""
    body = []
    for x, y, w, r, top, side in full_layers():
        if side != top:
            body.append(_rect(x, y + THICK * MARK_SCALE, w, r, side))
        body.append(_rect(x, y, w, r, top))
    svg = ('<svg width="1024" height="1024" viewBox="0 0 1024 1024" fill="none" '
           'xmlns="http://www.w3.org/2000/svg">' + "".join(body) + "</svg>")
    out_path.write_text(svg, encoding="utf-8")
    return out_path, svg


def build_favicon_uri():
    """favicon 用的 data URI —— 与 16/24px PNG 同一套三层简化几何。

    favicon 在标签页里只有 16–32px，走完整四层层叠等于自找模糊。
    viewBox 收紧到最外块的边界：标签页空间太小，不该再留 5% 的透明边。
    `<` / `>` / `#` 必须百分号编码，否则部分浏览器解析不出。
    """
    layers = simple_layers()
    xs = [x for x, _, _, _, _, _ in layers]
    ys = [y for _, y, _, _, _, _ in layers]
    xe = [x + w for x, _, w, _, _, _ in layers]
    ye = [y + w for _, y, w, _, _, _ in layers]
    x0, y0 = min(xs), min(ys)
    side = max(max(xe) - x0, max(ye) - y0)

    body = "".join(
        (f"<rect x='{x:.0f}' y='{y:.0f}' width='{w:.0f}' height='{w:.0f}' rx='{r:.0f}' fill='{top}'/>")
        for x, y, w, r, top, _ in layers
    )
    svg = (f"<svg xmlns='http://www.w3.org/2000/svg' viewBox='{x0:.0f} {y0:.0f} "
           f"{side:.0f} {side:.0f}'>{body}</svg>")
    return ("data:image/svg+xml,"
            + svg.replace("<", "%3C").replace(">", "%3E").replace("#", "%23"))


def main() -> None:
    full = render(full_layers())
    tiny = render(simple_layers())

    def pick(size):
        return tiny if size <= SIMPLE_AT_OR_BELOW else full

    frames = {size: downsample(pick(size), size) for size in PNG_SIZES}

    ico_frames = [frames[size] for size in SIZES]
    ico_path = OUT_DIR / "icon.ico"
    ico_frames[-1].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in SIZES],
        append_images=ico_frames[:-1],
    )

    # 复制一份给运行时：build/ 不随包分发，assets/ 会（见 electron-builder.yml 的 files）。
    # 用 copy 而不是再 save 一次，保证两份字节完全一致。
    ASSETS_DIR.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ico_path, ASSETS_DIR / "icon.ico")

    for size in PNG_SIZES:
        frames[size].save(OUT_DIR / f"icon-{size}.png")
    frames[256].save(OUT_DIR / "icon-preview.png")

    _, svg = build_svg(OUT_DIR / "icon.svg")
    ladder = build_ladder(frames, OUT_DIR / "icon-ladder.png")

    print(f"已生成 {ico_path.name}（{', '.join(f'{s}x{s}' for s in SIZES)}）")
    print(f"  运行时副本：{ASSETS_DIR.name}/icon.ico")
    print(f"  各档 PNG：icon-{{{','.join(str(s) for s in PNG_SIZES)}}}.png")
    print(f"  矢量源：icon.svg（{len(svg)} 字节）")
    print(f"  对照图：{ladder.name}")
    print(f"  ≤{SIMPLE_AT_OR_BELOW}px 走三层简化几何")
    print("  favicon data URI（web/index.html）：")
    print(build_favicon_uri())


if __name__ == "__main__":
    main()
