#!/usr/bin/env python3
"""Render one text overlay to a full-frame transparent PNG.

Exists because this machine's ffmpeg is built without libfreetype, so the
`drawtext` filter is unavailable. A full-frame RGBA PNG lets the render
pipeline composite text with the always-present `overlay` filter at 0:0,
which keeps positioning maths out of the filtergraph.

Usage: make_text_png.py <out.png> <width> <height> <position> <size> <text>
"""
import sys
from PIL import Image, ImageDraw, ImageFont

FONTS = [
    ("/System/Library/Fonts/Helvetica.ttc", 0),
    ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", 0),
    ("/Library/Fonts/Arial.ttf", 0),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
]
# Divisors mirror the original drawtext sizing: height / divisor = font px.
SIZE_DIVISOR = {"small": 24, "medium": 18, "large": 12}


def load_font(px):
    for path, idx in FONTS:
        try:
            return ImageFont.truetype(path, px, index=idx)
        except Exception:
            continue
    raise SystemExit("no usable font found")


def main():
    out, w, h, position, size, text = (
        sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6],
    )
    font = load_font(max(12, round(h / SIZE_DIVISOR.get(size, 18))))
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    stroke = max(2, round(h / 360))
    left, top, right, bottom = draw.textbbox((0, 0), text, font=font, stroke_width=stroke)
    tw, th = right - left, bottom - top

    x = (w - tw) / 2 - left
    if position == "lower-third":
        y = round(h * 0.78) - top
    elif position == "top":
        y = round(h * 0.08) - top
    else:  # center
        y = (h - th) / 2 - top

    # White with a semi-opaque black stroke — same look the drawtext path had.
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 255),
              stroke_width=stroke, stroke_fill=(0, 0, 0, 128))
    img.save(out)


if __name__ == "__main__":
    main()
