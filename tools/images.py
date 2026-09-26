#!/usr/bin/env python3
# /// script
# dependencies = ["pillow==11.3.0", "pyyaml==6.0.2"]
# ///
"""Make every web image the site serves, from the harvest sources.

Prints
  source chain per urlId, first hit wins:
    1. overrides.yml `image:` path
    2. harvest/images/originals/<urlId>.jpg          (2000 px, the real thing)
    3. harvest/images/products-web/<urlId>.jpg       (1000 to 1500 px, Squarespace)
    4. harvest/images/products/<urlId>.jpg, letterbox trimmed (last resort)
  outputs
    assets/img/prints/<urlId>-<w>.webp   w in 240, 480, 960, 1600, 2000 (never upscaled)
    assets/img/prints/<urlId>-<w>.jpg    same widths from 480 up
    assets/img/og/<urlId>.jpg            1200 x 630, the print letterboxed on the paper color
  record
    data/images.json   per urlId: natural size, widths written, source kind, average color

Site images
    logo, favicons, the three size diagrams, the home hero mockup

Web copies are capped at 2000 px on the long edge on purpose: nothing on the site should be
printable at size. Sources are converted to sRGB and saved without metadata.

Run:  python3 tools/images.py            (skips outputs newer than their source)
      python3 tools/images.py --force
      python3 tools/images.py --only kaimana
"""

import argparse
import io
import json
import sys
from pathlib import Path

import yaml
from PIL import Image, ImageCms, ImageOps, ImageStat

ROOT = Path(__file__).resolve().parent.parent
H = ROOT / "harvest" / "images"
OUT_PRINTS = ROOT / "assets" / "img" / "prints"
OUT_OG = ROOT / "assets" / "img" / "og"
OUT_SITE = ROOT / "assets" / "img" / "site"
RECORD = ROOT / "data" / "images.json"

WIDTHS = [240, 480, 960, 1600, 2000]
JPG_MIN = 480
MAX_EDGE = 2000
PAPER = (244, 242, 237)          # --paper, #f4f2ed
INK = (26, 26, 26)


# ---------------------------------------------------------------- helpers

def to_srgb(im):
    """Convert to RGB in sRGB. Drops the embedded profile after converting."""
    icc = im.info.get("icc_profile")
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if "A" in im.getbands() else "RGB")
    if icc:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            desc = ImageCms.getProfileDescription(src) or ""
            if "srgb" not in desc.lower():
                dst = ImageCms.createProfile("sRGB")
                im = ImageCms.profileToProfile(im, src, dst, outputMode=im.mode)
        except Exception as e:  # a broken profile should not stop the build
            print(f"  warning: could not read ICC profile ({e}); treating as sRGB")
    im.info.pop("icc_profile", None)
    return im


def cap(im, edge=MAX_EDGE):
    if max(im.size) > edge:
        im = im.copy()
        im.thumbnail((edge, edge), Image.LANCZOS)
    return im


def trim_letterbox(im, thresh=12):
    """Crop the white padding Squarespace put around its square product images."""
    gray = ImageOps.grayscale(im.convert("RGB"))
    ink = gray.point(lambda v: 255 if v < 255 - thresh else 0)   # pixels clearly not white
    box = ink.getbbox()
    return im.crop(box) if box else im


def average_color(im):
    small = im.convert("RGB").resize((16, 16), Image.BILINEAR)
    r, g, b = [int(v) for v in ImageStat.Stat(small).mean]
    return f"#{r:02x}{g:02x}{b:02x}"


def widths_for(w):
    ws = [x for x in WIDTHS if x <= w]
    if not ws or w - ws[-1] > 100:
        ws.append(w)
    return ws


def save_webp(im, path, q=80):
    im.convert("RGB").save(path, "WEBP", quality=q, method=6)


def save_jpg(im, path, q=82):
    im.convert("RGB").save(path, "JPEG", quality=q, optimize=True, progressive=True)


def resized(im, w):
    if im.width == w:
        return im
    h = round(im.height * w / im.width)
    return im.resize((w, h), Image.LANCZOS)


def fresh(outputs, src_mtime):
    return all(p.exists() and p.stat().st_mtime >= src_mtime for p in outputs)


# ---------------------------------------------------------------- prints

def load_catalog():
    products = json.loads((ROOT / "data" / "products.json").read_text())
    overrides = yaml.safe_load((ROOT / "data" / "overrides.yml").read_text()) or {}
    ids = [p["urlId"] for p in products]
    for key in overrides:
        if key not in ids:
            ids.append(key)              # prints that did not come from Squarespace
    return ids, overrides


def source_for(url_id, ov):
    if ov.get("image"):
        p = ROOT / ov["image"]
        if p.exists():
            return p, "override"
    for kind, p in [("originals", H / "originals" / f"{url_id}.jpg"),
                    ("products-web", H / "products-web" / f"{url_id}.jpg")]:
        if p.exists():
            return p, kind
    p = H / "products" / f"{url_id}.jpg"
    if p.exists():
        return p, "products-trimmed"
    return None, None


def write_print(url_id, ov, record, force=False):
    src, kind = source_for(url_id, ov)
    if not src:
        return None
    mtime = src.stat().st_mtime
    prev = record.get(url_id)
    if prev and not force and prev.get("src") == str(src.relative_to(ROOT)) and prev.get("mtime") == mtime:
        outs = [OUT_PRINTS / f"{url_id}-{w}.webp" for w in prev["widths"]]
        outs += [OUT_PRINTS / f"{url_id}-{w}.jpg" for w in prev["widths"] if w >= JPG_MIN]
        outs.append(OUT_OG / f"{url_id}.jpg")
        if fresh(outs, mtime):
            return prev

    im = Image.open(src)
    im = to_srgb(im)
    if kind == "products-trimmed":
        im = trim_letterbox(im)
    im = cap(im)
    ws = widths_for(im.width)
    for w in ws:
        r = resized(im, w)
        save_webp(r, OUT_PRINTS / f"{url_id}-{w}.webp")
        if w >= JPG_MIN:
            save_jpg(r, OUT_PRINTS / f"{url_id}-{w}.jpg")
    write_og(im, OUT_OG / f"{url_id}.jpg")
    rec = {
        "w": im.width, "h": im.height, "widths": ws,
        "source": kind, "src": str(src.relative_to(ROOT)), "mtime": mtime,
        "avg": average_color(im),
    }
    print(f"  {url_id}: {im.width}x{im.height} from {kind}, widths {ws}")
    return rec


def write_og(im, path, size=(1200, 630), margin=48):
    canvas = Image.new("RGB", size, PAPER)
    box = (size[0] - 2 * margin, size[1] - 2 * margin)
    pic = im.convert("RGB").copy()
    pic.thumbnail(box, Image.LANCZOS)
    x = (size[0] - pic.width) // 2
    y = (size[1] - pic.height) // 2
    canvas.paste(pic, (x, y))
    save_jpg(canvas, path, q=84)


# ---------------------------------------------------------------- site images

def site_images(force=False):
    OUT_SITE.mkdir(parents=True, exist_ok=True)
    s = H / "site"
    done = []

    # Logo lockup (signature + wordmark), trimmed to its ink, for the footer and schema.
    for name, out in [("Logo_2BText_28gray_29.png", "logo-gray"), ("Logo_2BText_28white_29.png", "logo-white")]:
        src = s / name
        target = OUT_SITE / f"{out}.png"
        if src.exists() and (force or not fresh([target], src.stat().st_mtime)):
            im = Image.open(src).convert("RGBA")
            im = im.crop(im.getbbox())
            im.thumbnail((600, 600), Image.LANCZOS)
            im.save(target, optimize=True)
            done.append(target.name)

    # Signature mark on paper for favicons (a transparent dark mark disappears on dark tabs).
    src = s / "Logo_2BText_28gray_29.png"
    fav = [OUT_SITE / f"favicon-{n}.png" for n in (32, 180, 192, 512)]
    if src.exists() and (force or not fresh(fav, src.stat().st_mtime)):
        im = Image.open(src).convert("RGBA")
        w, h = im.size
        sig = im.crop((0, 0, w, int(h * 0.80)))          # everything above the wordmark
        sig = sig.crop(sig.getbbox())
        side = int(max(sig.size) * 1.18)
        tile = Image.new("RGBA", (side, side), PAPER + (255,))
        tile.alpha_composite(sig, ((side - sig.width) // 2, (side - sig.height) // 2))
        for n, p in zip((32, 180, 192, 512), fav):
            tile.resize((n, n), Image.LANCZOS).convert("RGB").save(p, optimize=True)
        done += [p.name for p in fav]

    # Size diagrams from the old /prints page.
    for name in ("PanoOptions.jpg", "StandardOptions.jpg", "PanelOptions.jpg"):
        src = s / name
        if not src.exists():
            continue
        stem = name.replace(".jpg", "").lower()
        outs = [OUT_SITE / f"{stem}-{w}.{ext}" for w in (960, 1600) for ext in ("webp", "jpg")]
        if force or not fresh(outs, src.stat().st_mtime):
            im = to_srgb(Image.open(src))
            for w in (960, 1600):
                r = resized(im, w)
                save_webp(r, OUT_SITE / f"{stem}-{w}.webp")
                save_jpg(r, OUT_SITE / f"{stem}-{w}.jpg")
            done.append(stem)

    # Home hero: the living room mockup with Nani Waikīkī on the wall.
    src = s / "home-hero-living-room-panorama.jpg"
    if src.exists():
        outs = [OUT_SITE / f"hero-living-{w}.{ext}" for w in (480, 960, 1600, 2000) for ext in ("webp", "jpg")]
        if force or not fresh(outs, src.stat().st_mtime):
            im = to_srgb(Image.open(src))
            for w in (480, 960, 1600, 2000):
                r = resized(im, w)
                save_webp(r, OUT_SITE / f"hero-living-{w}.webp", q=78)
                save_jpg(r, OUT_SITE / f"hero-living-{w}.jpg", q=80)
            done.append("hero-living")
    if done:
        print("  site:", ", ".join(done))


# ---------------------------------------------------------------- main

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--only")
    a = ap.parse_args(argv)

    for d in (OUT_PRINTS, OUT_OG, OUT_SITE):
        d.mkdir(parents=True, exist_ok=True)
    record = json.loads(RECORD.read_text()) if RECORD.exists() else {}
    ids, overrides = load_catalog()

    missing, fallback = [], []
    for url_id in ids:
        ov = overrides.get(url_id) or {}
        if ov.get("status") == "removed":
            record.pop(url_id, None)
            continue
        if a.only and url_id != a.only:
            continue
        rec = write_print(url_id, ov, record, force=a.force)
        if rec is None:
            missing.append(url_id)
            record.pop(url_id, None)
            continue
        record[url_id] = rec
        if rec["source"] not in ("originals", "override") or max(rec["w"], rec["h"]) < MAX_EDGE:
            fallback.append(f"{url_id} ({rec['source']}, {rec['w']}x{rec['h']})")

    if not a.only:
        site_images(force=a.force)
    RECORD.write_text(json.dumps(record, indent=1, sort_keys=True) + "\n")

    print(f"prints recorded: {len(record)}")
    if fallback:
        print("below 2000 px or not from originals yet:")
        for f in fallback:
            print("  ", f)
    if missing:
        print("no image source at all (kept out of the site until one exists):", ", ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
