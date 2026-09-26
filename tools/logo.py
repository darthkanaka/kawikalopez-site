#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = ["potracer==0.0.4", "numpy", "pillow"]
# ///
"""Kawika's logo as vectors, traced from the only artwork that exists: the 2451 x 1177 PNG
from the old site (harvest/images/site/Logo_2BText_28gray_29.png). No vector original was
found on the Mac or the backup drive on 2026-09-25.

The logo is a signature mark above the wordmark KAWIKA LOPEZ PHOTOGRAPHY. Tracing uses
potrace (the potracer port) on the PNG's alpha channel, then sorts the traced shapes into
the signature and the three words by position.

Writes
  assets/img/site/logo.svg                   the logo as drawn: signature over the wordmark
  assets/img/site/logo-horizontal.svg        the signature beside the wordmark set in two lines,
                                             KAWIKA LOPEZ over PHOTOGRAPHY, for the header
  assets/img/site/logo-horizontal.png        the same lockup as a raster, for share images
  assets/img/site/logo-horizontal-white.png  white version, for placing over photos
The SVGs are drawn in the site's ink color and used as <img>, so every page shares one
cached file instead of repeating the paths in its HTML.

Run: uv run tools/logo.py      (needs uv; the build itself does not)
"""

from pathlib import Path

import numpy as np
import potrace
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "harvest" / "images" / "site" / "Logo_2BText_28gray_29.png"
SITE = ROOT / "assets" / "img" / "site"
INK = "#1b1a18"

# Regions of the source PNG, measured 2026-09-25 (tools/logo.py prints them if they drift).
WORDMARK_TOP = 1098          # first row of the wordmark; everything above is the signature
WORDS = {"kawika": (0, 650), "lopez": (650, 1230), "photography": (1230, 2451)}


def trace(mask):
    bm = potrace.Bitmap(mask)
    return bm.trace(turdsize=4, turnpolicy=potrace.POTRACE_TURNPOLICY_MINORITY,
                    alphamax=1.0, opticurve=True, opttolerance=0.2)


def curve_d(curve, dx=0.0, dy=0.0, s=1.0):
    f = lambda p: f"{(p.x + dx) * s:.1f} {(p.y + dy) * s:.1f}"
    parts = [f"M{f(curve.start_point)}"]
    for seg in curve.segments:
        if seg.is_corner:
            parts.append(f"L{f(seg.c)}L{f(seg.end_point)}")
        else:
            parts.append(f"C{f(seg.c1)} {f(seg.c2)} {f(seg.end_point)}")
    parts.append("Z")
    return "".join(parts)


def bbox(curve):
    pts = [curve.start_point]
    for seg in curve.segments:
        pts += [seg.c, seg.end_point] if seg.is_corner else [seg.c1, seg.c2, seg.end_point]
    xs = [p.x for p in pts]; ys = [p.y for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def group(curves):
    """Sort curves into signature and words. Holes (the counters in O, P, A...) follow
    their outer shape because they sit inside its box."""
    groups = {"signature": [], "kawika": [], "lopez": [], "photography": []}
    for c in curves:
        x0, y0, x1, y1 = bbox(c)
        if y0 < WORDMARK_TOP - 20:
            groups["signature"].append(c)
            continue
        cx = (x0 + x1) / 2
        for name, (a, b) in WORDS.items():
            if a <= cx < b:
                groups[name].append(c)
                break
    return groups


def union_box(curves):
    boxes = [bbox(c) for c in curves]
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def svg(width, height, paths, fill="currentColor", label="Kawika Lopez Photography", inline=True, cls=""):
    """inline=True: for use inside a link or figure that carries the accessible name, so the
    drawing itself is hidden from screen readers. inline=False: a standalone file."""
    d = "".join(paths)
    a11y = 'aria-hidden="true" focusable="false"' if inline else f'role="img" aria-label="{label}"'
    cls_attr = f' class="{cls}"' if cls else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width:.0f} {height:.0f}" '
            f'width="{width:.0f}" height="{height:.0f}" {a11y}{cls_attr}>'
            f'<path fill="{fill}" fill-rule="evenodd" d="{d}"/></svg>')


def main():
    im = Image.open(SRC)
    alpha = np.array(im.getchannel("A"))
    # potracer reads its input like a photo, dark pixels (False) as ink, so pass "not ink".
    mask = alpha <= 127
    curves = trace(mask)
    g = group(curves)
    counts = {k: len(v) for k, v in g.items()}
    print("traced shapes:", counts)

    # Stacked: the logo as drawn, cropped to its ink.
    x0, y0, x1, y1 = union_box(curves)
    pad = 2
    stacked = [curve_d(c, dx=-x0 + pad, dy=-y0 + pad) for c in curves]
    w, h = x1 - x0 + 2 * pad, y1 - y0 + 2 * pad
    SITE.mkdir(parents=True, exist_ok=True)
    (SITE / "logo.svg").write_text(svg(w, h, stacked, fill=INK, inline=False) + "\n")
    print(f"stacked logo viewBox {w:.0f} x {h:.0f}")

    # Horizontal: signature, then KAWIKA LOPEZ over PHOTOGRAPHY, scaled so the capitals
    # are a fifth of the signature's height and the two lines sit on its middle.
    sx0, sy0, sx1, sy1 = union_box(g["signature"])
    sig_h = sy1 - sy0
    cap = 79.0                                  # capital height of the wordmark in the source
    k = 0.2 * sig_h / cap                       # text scale relative to the source
    gap = 0.30 * sig_h                          # space between mark and text
    line_gap = 0.62 * cap                       # between the two lines, in source units
    line1 = g["kawika"] + g["lopez"]
    l1x0, l1y0, l1x1, l1y1 = union_box(line1)
    l2x0, l2y0, l2x1, l2y1 = union_box(g["photography"])
    text_w = max(l1x1 - l1x0, l2x1 - l2x0) * k
    text_h = (cap * 2 + line_gap) * k
    tx = (sx1 - sx0) + gap
    ty = (sig_h - text_h) / 2
    paths = [curve_d(c, dx=-sx0, dy=-sy0) for c in g["signature"]]

    def placed(c, ox, oy, lx0, ly0):
        """Scale a wordmark shape by k about its line's top-left corner, then move it to (ox, oy)."""
        f = lambda p: f"{ox + (p.x - lx0) * k:.1f} {oy + (p.y - ly0) * k:.1f}"
        parts = [f"M{f(c.start_point)}"]
        for seg in c.segments:
            if seg.is_corner:
                parts.append(f"L{f(seg.c)}L{f(seg.end_point)}")
            else:
                parts.append(f"C{f(seg.c1)} {f(seg.c2)} {f(seg.end_point)}")
        parts.append("Z")
        return "".join(parts)

    for c in line1:
        paths.append(placed(c, tx, ty, l1x0, l1y0))
    for c in g["photography"]:
        paths.append(placed(c, tx, ty + (cap + line_gap) * k, l2x0, l2y0))
    hw, hh = tx + text_w + 2, sig_h + 2
    (SITE / "logo-horizontal.svg").write_text(svg(hw, hh, paths, fill=INK, inline=False) + "\n")
    print(f"horizontal lockup viewBox {hw:.0f} x {hh:.0f} (ratio {hw / hh:.2f})")

    # Raster horizontal lockup for share images, drawn from the same geometry with Pillow.
    scale = 2.0                                  # source px per output px; output ~ 500 px tall
    out_h = int(hh / scale)
    canvas = Image.new("L", (int(hw / scale) + 4, out_h + 4), 0)
    a_img = Image.fromarray(alpha)
    sig = a_img.crop((int(sx0), int(sy0), int(sx1) + 1, int(sy1) + 1))
    sig = sig.resize((max(1, int(sig.width / scale)), max(1, int(sig.height / scale))), Image.LANCZOS)
    canvas.paste(sig, (0, 0))
    for (lx0, ly0, lx1, ly1), oy in [((l1x0, l1y0, l1x1, l1y1), ty), ((l2x0, l2y0, l2x1, l2y1), ty + (cap + line_gap) * k)]:
        part = a_img.crop((int(lx0), int(ly0), int(lx1) + 1, int(ly1) + 1))
        part = part.resize((max(1, int(part.width * k / scale)), max(1, int(part.height * k / scale))), Image.LANCZOS)
        canvas.paste(part, (int(tx / scale), int(oy / scale)))
    rgba = Image.new("RGBA", canvas.size, (0x1b, 0x1a, 0x18, 0))
    rgba.putalpha(canvas)
    rgba = rgba.crop(rgba.getbbox())
    rgba.save(SITE / "logo-horizontal.png", optimize=True)
    white = Image.new("RGBA", rgba.size, (255, 255, 255, 0))
    white.putalpha(rgba.getchannel("A"))
    white.save(SITE / "logo-horizontal-white.png", optimize=True)
    print("wrote", (SITE / "logo-horizontal.png").relative_to(ROOT), "and the white version", rgba.size)


if __name__ == "__main__":
    main()
