#!/usr/bin/env python3
# /// script
# dependencies = ["pyyaml==6.0.2"]
# ///
"""Turn the Squarespace dump into the site's catalog data.

Reads  harvest/products.json  (pulled from kawikalopez.com/store?format=json)
Writes data/products.json     (normalized catalog, one record per print)
       data/pricing.yml       (the size and price matrix per orientation)

What it normalizes:
  sizes        "72 24" becomes "72 x 24"; every size gets numeric w and h
  materials    lowercase: canvas, metal
  orientation  from the Squarespace categories (Horizontal, Vertical, Square, Panoramic)
  collections  the remaining categories, lowercase (landscape, fine-art)
  ratio        w / h of the print sizes, so the visualizer and image markup know the shape
  variant ids  <urlId>_<w>x<h>_<material>, which double as Stripe lookup keys

It does not apply data/overrides.yml. The build does that, so this file stays a faithful
normalization of what Squarespace had and overrides stay the one place hand edits live.

Run: python3 tools/harvest_to_data.py
"""

import json
import re
import sys
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "harvest" / "products.json"
OUT = ROOT / "data" / "products.json"
PRICING = ROOT / "data" / "pricing.yml"

ORIENTATIONS = ("horizontal", "vertical", "square", "panoramic")


def parse_size(label):
    """'30 x 10' or '72 24' -> ('30 x 10', 30, 10). Width first, as Squarespace listed it."""
    nums = [int(n) for n in re.findall(r"\d+", label or "")]
    if len(nums) != 2:
        raise ValueError(f"cannot parse size {label!r}")
    w, h = nums
    return f"{w} x {h}", w, h


def iso_date(ms):
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date().isoformat()


def normalize(rec):
    cats = [c.lower() for c in (rec.get("categories") or [])]
    orientation = next((c for c in cats if c in ORIENTATIONS), None)
    if not orientation:
        raise ValueError(f"{rec['urlId']}: no orientation in categories {cats}")
    collections = [c.replace(" ", "-") for c in cats if c not in ORIENTATIONS]

    sizes = OrderedDict()
    variants = []
    for v in rec.get("variants") or []:
        label, w, h = parse_size(v.get("size") or v["attributes"].get("Size"))
        material = (v.get("material") or v["attributes"].get("Material") or "").lower()
        if material not in ("canvas", "metal"):
            raise ValueError(f"{rec['urlId']}: unknown material {material!r}")
        sizes.setdefault(label, {"label": label, "w": w, "h": h})
        variants.append({
            "id": f"{rec['urlId']}_{w}x{h}_{material}",
            "size": label, "w": w, "h": h,
            "material": material,
            "price": int(round(float(v["price"]))),
            "sku": v.get("sku"),
        })
    variants.sort(key=lambda v: (v["w"] * v["h"], v["material"]))
    size_list = sorted(sizes.values(), key=lambda s: s["w"] * s["h"])
    ratio = round(size_list[0]["w"] / size_list[0]["h"], 4) if size_list else None
    prices = [v["price"] for v in variants]
    src_img = (rec.get("images") or [{}])[0]

    return OrderedDict([
        ("urlId", rec["urlId"]),
        ("title", rec.get("title") or rec["urlId"]),
        ("description", (rec.get("description") or "").strip()),
        ("orientation", orientation),
        ("collections", collections),
        ("ratio", ratio),
        ("addedOn", iso_date(rec.get("addedOn"))),
        ("updatedOn", iso_date(rec.get("updatedOn"))),
        ("priceFrom", min(prices) if prices else None),
        ("priceTo", max(prices) if prices else None),
        ("sizes", size_list),
        ("variants", variants),
        ("sourceFilename", src_img.get("filename") or ""),
    ])


def pricing_matrix(products):
    """Per orientation: the list of sizes with canvas and metal prices.
    Warns when a product deviates from the matrix its orientation implies."""
    matrix = {}
    deviations = []
    for p in products:
        m = matrix.setdefault(p["orientation"], OrderedDict())
        for v in p["variants"]:
            row = m.setdefault(v["size"], {"w": v["w"], "h": v["h"], "canvas": None, "metal": None})
            if row[v["material"]] is None:
                row[v["material"]] = v["price"]
            elif row[v["material"]] != v["price"]:
                deviations.append((p["urlId"], v["size"], v["material"], v["price"], row[v["material"]]))
    out = {}
    for o, rows in matrix.items():
        out[o] = [{"size": s, **r} for s, r in sorted(rows.items(), key=lambda kv: kv[1]["w"] * kv[1]["h"])]
    return out, deviations


def main():
    raw = json.loads(SRC.read_text())
    products = [normalize(r) for r in raw]
    products.sort(key=lambda p: p["urlId"])
    # Descriptions written by hand after the harvest (the Squarespace copy had none) survive a rerun.
    if OUT.exists():
        kept = {p["urlId"]: p.get("description") for p in json.loads(OUT.read_text())}
        for p in products:
            if not p.get("description") and kept.get(p["urlId"]):
                p["description"] = kept[p["urlId"]]
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(products, indent=1, ensure_ascii=False) + "\n")

    matrix, deviations = pricing_matrix(products)
    # Keys added by hand to pricing.yml rows (default and the like) survive a rerun.
    if PRICING.exists():
        old = yaml.safe_load(PRICING.read_text()) or {}
        for o, rows in matrix.items():
            prev = {(r["w"], r["h"]): r for r in old.get(o) or []}
            for r in rows:
                for k, v in (prev.get((r["w"], r["h"])) or {}).items():
                    r.setdefault(k, v)
    header = ("# Size and price matrix per orientation, derived from the Squarespace catalog on 2026-09-25.\n"
              "# New prints inherit the matrix of their orientation. Prices in whole dollars.\n"
              "# Edit here to change prices for every print of an orientation; per-print prices live in products.json.\n")
    PRICING.write_text(header + yaml.safe_dump(matrix, sort_keys=False, allow_unicode=True))

    print(f"products: {len(products)} -> {OUT.relative_to(ROOT)}")
    print(f"variants: {sum(len(p['variants']) for p in products)}")
    for o, rows in matrix.items():
        print(f"  {o}: " + ", ".join(f"{r['size']} c${r['canvas']} m${r['metal']}" for r in rows))
    if deviations:
        print("price deviations from the orientation matrix:")
        for d in deviations:
            print("  ", d)
    return 0


if __name__ == "__main__":
    sys.exit(main())
