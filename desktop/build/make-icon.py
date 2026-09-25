"""
生成应用图标 desktop/build/icon.ico。

与 web/index.html 里 favicon 的视觉保持一致：圆角方块 #4a6cf7 + 白色「格」字。
改图标只需要改这里的常量后重跑：

    python build/make-icon.py

依赖 Pillow（仅生成图标时需要，不属于应用运行时依赖）。
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BRAND = (74, 108, 247, 255)  # #4a6cf7，与前端 favicon / 主色一致
GLYPH = "格"
FONT_PATH = r"C:\Windows\Fonts\msyhbd.ttc"  # 微软雅黑 Bold，中文覆盖最稳

SIZES = [16, 24, 32, 48, 64, 128, 256]
BASE = 1024  # 先在高分辨率上绘制，再逐级降采样

OUT_DIR = Path(__file__).resolve().parent


def render_base() -> Image.Image:
    img = Image.new("RGBA", (BASE, BASE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 圆角比例对齐 favicon 的 rx=8/32
    draw.rounded_rectangle([0, 0, BASE - 1, BASE - 1], radius=int(BASE * 0.25), fill=BRAND)

    font = ImageFont.truetype(FONT_PATH, int(BASE * 0.6))
    # anchor="mm" 以字形外框中点对齐，比按基线绘图更居中
    draw.text((BASE / 2, BASE / 2), GLYPH, font=font, fill=(255, 255, 255, 255), anchor="mm")
    return img


def main() -> None:
    base = render_base()

    # 逐级 LANCZOS 降采样，比让 PIL 在保存时自己缩放要锐利
    frames = [base.resize((size, size), Image.LANCZOS) for size in SIZES]

    ico_path = OUT_DIR / "icon.ico"
    # 用最大帧作为源，再把预先算好的各尺寸帧逐个塞进去
    frames[-1].save(
        ico_path,
        format="ICO",
        sizes=[(size, size) for size in SIZES],
        append_images=frames[:-1],
    )

    preview_path = OUT_DIR / "icon-preview.png"
    base.resize((256, 256), Image.LANCZOS).save(preview_path)

    print(f"已生成 {ico_path}（{', '.join(f'{s}x{s}' for s in SIZES)}）")
    print(f"预览图 {preview_path}")


if __name__ == "__main__":
    main()
