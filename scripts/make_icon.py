#!/usr/bin/env python3
"""Generate The Orchestrator's application icon set.

Original mark: a conductor node linked to three satellite session nodes on
orbit arcs -- one orchestrator directing concurrent agents. No third-party
branding is used or implied.

Drawn directly with Pillow (4x supersampled) so the build needs no SVG
rasterizer. Produces the PNG sizes Tauri expects plus a macOS .icns.

Usage: python3 scripts/make_icon.py
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required: python3 -m pip install Pillow")

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(HERE, "..", "apps", "desktop", "src-tauri", "icons")

# Palette: quiet, dark, technical. Deliberately not neon.
BG_TOP = (35, 38, 46)
BG_BOTTOM = (20, 22, 27)
ACCENT_A = (110, 139, 255)   # indigo — the conductor
ACCENT_B = (89, 212, 196)    # teal — the sessions
CORE_BG = (14, 16, 20)

S = 1024          # design grid
SS = 4            # supersample factor


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def gradient_bg(size: int) -> Image.Image:
    """Vertical gradient background."""
    img = Image.new("RGB", (1, size))
    px = img.load()
    for y in range(size):
        px[0, y] = lerp(BG_TOP, BG_BOTTOM, y / max(1, size - 1))
    return img.resize((size, size), Image.NEAREST)


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def blend(base: Image.Image, color, alpha: float, draw_fn) -> None:
    """Draw `draw_fn` onto `base` in `color` at `alpha`, antialiased by SS."""
    layer = Image.new("L", base.size, 0)
    draw_fn(ImageDraw.Draw(layer))
    if alpha < 1.0:
        layer = layer.point(lambda v: int(v * alpha))
    solid = Image.new("RGB", base.size, color)
    base.paste(solid, (0, 0), layer)


def render(size: int) -> Image.Image:
    """Render the mark at `size` px."""
    w = size * SS
    k = w / S  # design units -> supersampled px

    def u(v: float) -> float:
        return v * k

    img = gradient_bg(w).convert("RGB")

    cx = cy = u(512)

    # Orbit arcs — the concurrent sessions.
    for r, a in ((248, 0.30), (336, 0.18)):
        rr, width = u(r), u(18)
        blend(img, ACCENT_B, a, lambda d, rr=rr, width=width: d.ellipse(
            [cx - rr, cy - rr, cx + rr, cy + rr], outline=255, width=round(width)))

    # Session node positions.
    nodes = [(512, 264), (727, 636), (297, 636)]

    # Links from the conductor outward.
    for nx, ny in nodes:
        blend(img, ACCENT_B, 0.85, lambda d, nx=nx, ny=ny: d.line(
            [cx, cy, u(nx), u(ny)], fill=255, width=round(u(22))))

    # Session nodes.
    for nx, ny in nodes:
        r = u(72)
        blend(img, ACCENT_B, 1.0, lambda d, nx=nx, ny=ny, r=r: d.ellipse(
            [u(nx) - r, u(ny) - r, u(nx) + r, u(ny) + r], fill=255))

    # Conductor: dark core with an indigo ring, so it reads as distinct.
    r_out = u(104)
    blend(img, ACCENT_A, 1.0, lambda d: d.ellipse(
        [cx - r_out, cy - r_out, cx + r_out, cy + r_out], fill=255))
    r_in = u(104 - 26)
    blend(img, CORE_BG, 1.0, lambda d: d.ellipse(
        [cx - r_in, cy - r_in, cx + r_in, cy + r_in], fill=255))
    r_dot = u(34)
    blend(img, ACCENT_A, 1.0, lambda d: d.ellipse(
        [cx - r_dot, cy - r_dot, cx + r_dot, cy + r_dot], fill=255))

    img = img.resize((size, size), Image.LANCZOS)

    # macOS-style squircle-ish rounding.
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), rounded_mask(size, round(size * 0.2227)))
    return out


def main() -> int:
    os.makedirs(ICON_DIR, exist_ok=True)

    # Sizes Tauri references in tauri.conf.json.
    for name, px in [
        ("32x32.png", 32),
        ("128x128.png", 128),
        ("128x128@2x.png", 256),
        ("icon.png", 1024),
    ]:
        render(px).save(os.path.join(ICON_DIR, name))
        print(f"wrote {name}")

    # .icns via iconutil (macOS only).
    iconset = os.path.join(ICON_DIR, "icon.iconset")
    if os.path.isdir(iconset):
        shutil.rmtree(iconset)
    os.makedirs(iconset)
    for name, px in [
        ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
        ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
        ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
        ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
        ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
    ]:
        render(px).save(os.path.join(iconset, name))

    if shutil.which("iconutil"):
        subprocess.run(
            ["iconutil", "-c", "icns", iconset, "-o", os.path.join(ICON_DIR, "icon.icns")],
            check=True,
        )
        print("wrote icon.icns")
        shutil.rmtree(iconset)
    else:
        print("iconutil unavailable; .icns not generated (macOS only)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
