#!/usr/bin/env python3
# /// script
# dependencies = ["pillow==11.3.0"]
# ///
"""Room scenes for "see it on your wall".

A scene is a room photo with an empty wall, plus three numbers the visualizer needs:
  wall   the rectangle (image pixels) a print may sit in
  ppi    pixels per inch at the wall, measured from an object of known width
  anchor where a print is centred by default, as a fraction of the wall rectangle

Scenes are listed in data/scenes.json. For each scene with a `source`, this tool:
  1. opens the source image,
  2. paints out `clean` (a print that was baked into a mockup) with a Coons patch fill from the
     rectangle's border plus a little grain, so the wall reads as empty,
  3. writes assets/img/scenes/<id>-<w>.{webp,jpg} for w in 960, 1600, 2000 (never upscaled),
  4. records the natural size and widths back into data/scenes.json.

estimate_ppi(from, to, inches) is the helper for calibrating a new scene: measure the pixel
ends of something whose real width you know (a sofa, a door, a print already on the wall).

Run: python3 tools/scenes.py [--force]
"""

import argparse
import json
import random
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "scenes.json"
OUT = ROOT / "assets" / "img" / "scenes"
WIDTHS = (960, 1600, 2000)


def estimate_ppi(p_from, p_to, inches):
    (x1, y1), (x2, y2) = p_from, p_to
    return round(((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5 / inches, 3)


def _band_mean(px, coords):
    n = len(coords)
    r = g = b = 0
    for (x, y) in coords:
        p = px[x, y]
        r += p[0]; g += p[1]; b += p[2]
    return (r / n, g / n, b / n)


def clean_rect(im, rect, band=4, grain=2.2, seed=7):
    """Fill rect with a Coons patch built from the average of a `band` of pixels just
    outside each edge. Smooth wall light gradients survive; the print disappears."""
    im = im.convert("RGB").copy()
    px = im.load()
    x0, y0, w, h = rect["x"], rect["y"], rect["w"], rect["h"]
    x1, y1 = x0 + w - 1, y0 + h - 1
    top = [_band_mean(px, [(x, y0 - 1 - k) for k in range(band)]) for x in range(x0, x1 + 1)]
    bot = [_band_mean(px, [(x, y1 + 1 + k) for k in range(band)]) for x in range(x0, x1 + 1)]
    lef = [_band_mean(px, [(x0 - 1 - k, y) for k in range(band)]) for y in range(y0, y1 + 1)]
    rig = [_band_mean(px, [(x1 + 1 + k, y) for k in range(band)]) for y in range(y0, y1 + 1)]
    c00, c10, c01, c11 = top[0], top[-1], bot[0], bot[-1]
    rnd = random.Random(seed)
    for j in range(h):
        v = j / (h - 1)
        for i in range(w):
            u = i / (w - 1)
            out = []
            for c in range(3):
                lc = (1 - v) * top[i][c] + v * bot[i][c]
                ld = (1 - u) * lef[j][c] + u * rig[j][c]
                b = ((1 - u) * (1 - v) * c00[c] + u * (1 - v) * c10[c]
                     + (1 - u) * v * c01[c] + u * v * c11[c])
                out.append(lc + ld - b)
            n = rnd.gauss(0, grain)
            px[x0 + i, y0 + j] = tuple(max(0, min(255, int(round(o + n)))) for o in out)
    return im


def resized(im, w):
    if im.width <= w:
        return im
    return im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    OUT.mkdir(parents=True, exist_ok=True)
    scenes = json.loads(DATA.read_text())
    for sc in scenes:
        src = ROOT / sc["source"]
        outs = [OUT / f"{sc['id']}-{w}.{e}" for w in WIDTHS for e in ("webp", "jpg")]
        stale = a.force or not all(p.exists() and p.stat().st_mtime >= src.stat().st_mtime for p in outs)
        im = Image.open(src).convert("RGB")
        sc["image"]["width"], sc["image"]["height"] = im.size
        widths = [w for w in WIDTHS if w <= im.width] or [im.width]
        sc["image"]["widths"] = widths
        if sc.get("calibration"):
            cal = sc["calibration"]
            sc["ppi"] = estimate_ppi(cal["from"], cal["to"], cal["inches"])
        if stale:
            if sc.get("clean"):
                im = clean_rect(im, sc["clean"])
            for w in widths:
                r = resized(im, w)
                r.save(OUT / f"{sc['id']}-{w}.webp", "WEBP", quality=80, method=6)
                r.save(OUT / f"{sc['id']}-{w}.jpg", "JPEG", quality=82, optimize=True, progressive=True)
            print(f"  scene {sc['id']}: {im.size[0]}x{im.size[1]}, ppi {sc['ppi']}, widths {widths}")
    DATA.write_text(json.dumps(scenes, indent=1, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
