"""Render the storefront icon as PNG.

The market card accepts only raster (png/jpg/webp) and the SVG we ship for the
DSH plugin row is refused there, so this redraws the same artwork at 180x180.
Drawn at 4x and downsampled so the rounded corners and the check mark stay
clean at the ~96px the card actually uses.

Geometry mirrors icon.svg (viewBox 0 0 64 64) scaled by 180/64.
"""
import os
import sys

from PIL import Image, ImageDraw

OUT = sys.argv[1] if len(sys.argv) > 1 else 'assets/icon-180.png'

SIZE = 180
SCALE = SIZE / 64
SS = 4  # supersample factor

BG = (37, 99, 235, 255)        # #2563eb
INK = (37, 99, 235, 255)
PAPER = (255, 255, 255, 245)
GREEN = (22, 163, 74, 255)     # #16a34a
WHITE = (255, 255, 255, 255)


def px(v):
    """Map a viewBox unit to a supersampled device pixel."""
    return v * SCALE * SS


canvas = SIZE * SS
img = Image.new('RGBA', (canvas, canvas), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

# Rounded background plate
draw.rounded_rectangle([0, 0, canvas - 1, canvas - 1], radius=px(14), fill=BG)

# Sheet of paper
draw.rounded_rectangle(
    [px(14), px(12), px(46), px(52)], radius=px(6), fill=PAPER
)

# Three text rules
for x, y, w in ((20, 20, 20), (20, 27, 14), (20, 34, 17)):
    draw.rounded_rectangle(
        [px(x), px(y), px(x + w), px(y + 3)], radius=px(1.5), fill=INK
    )

# Green badge
cx, cy, r = px(46), px(46), px(12)
draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GREEN)

# Check mark: M40.6 46.3 l3.9 3.9 7.5 -7.8
points = [(px(40.6), px(46.3)), (px(44.5), px(50.2)), (px(52.0), px(42.4))]
width = int(px(2.6))
draw.line(points, fill=WHITE, width=width, joint='curve')
for x, y in (points[0], points[-1]):
    draw.ellipse([x - width / 2, y - width / 2, x + width / 2, y + width / 2], fill=WHITE)

img = img.resize((SIZE, SIZE), Image.LANCZOS)

os.makedirs(os.path.dirname(os.path.abspath(OUT)) or '.', exist_ok=True)
img.save(OUT, 'PNG', optimize=True)
print(f'wrote {OUT}  {img.size[0]}x{img.size[1]}  {os.path.getsize(OUT)} bytes')
