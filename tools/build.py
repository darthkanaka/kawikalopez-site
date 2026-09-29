#!/usr/bin/env python3
# /// script
# dependencies = ["jinja2==3.1.6", "markdown==3.9", "pyyaml==6.0.2"]
# ///
"""Render kawikalopez.com from data/, content/ and templates/ into the repo root.

The rendered HTML is committed: GitHub Pages serves the repo as is, with no build step.

  python3 tools/build.py               staging: noindex on every page, staging canonicals
  python3 tools/build.py --production  kawikalopez.com canonicals, indexable, analytics on
  python3 tools/build.py --check       render in memory and list what would change

Reads
  data/site.yml         site facts, nav, feature flags
  data/products.json    the catalog (tools/harvest_to_data.py)
  data/overrides.yml    hand edits per print (titles, alt, places, fixes, status)
  data/pricing.yml      price matrix per orientation, for prints that did not come from Squarespace
  data/locations.yml    places the prints come from
  data/images.json      what tools/images.py wrote for each print
  data/scenes.json      rooms for the to-scale wall preview (tools/scenes.py)
  data/shipping.yml     rates by size and material, the pickup-only rule, and the cart shipping model
  data/payment-links-test.json, data/payment-links-live.json
                        Stripe links per variant (tools/stripe_catalog.py); staging uses test, production live
  data/redirects.yml    old Squarespace paths that get a redirect page

Writes
  index.html, store/..., collection pages, 404.html, redirect pages, sitemap.xml, robots.txt
  data/pages.json       every rendered page, for tools/verify.mjs and tools/a11y.mjs
  data/lastmod.json     the date each page's content last changed, for the sitemap

Rules it keeps
  - Output is deterministic: no timestamps in HTML, so a page only changes when its content does.
  - Links are relative and extensionless, so the same build works on the staging subpath and
    on the custom domain. 404.html is the exception: it uses absolute links.
  - Prints are rendered only when an image exists for them (data/images.json).
"""

import argparse
import datetime as dt
import hashlib
import html
import json
import os
import re
import sys
import unicodedata
from urllib.parse import urlparse
from pathlib import Path

import yaml
from jinja2 import Environment, FileSystemLoader, StrictUndefined, pass_context, select_autoescape
from markupsafe import Markup

import content as md

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TODAY = dt.date.today().isoformat()

ORIENT_LABEL = {"panoramic": "Panoramic", "horizontal": "Horizontal", "vertical": "Vertical", "square": "Square"}
COLLECTION_LABEL = {"landscape": "Landscape", "fine-art": "Fine Art"}

# Collection pages. Paths keep the old Squarespace URLs where they existed.
COLLECTIONS = [
    {"path": "panoramic-prints", "kind": "orientation", "value": "panoramic", "chip": "Panoramic",
     "h1": "Panoramic Hawaiʻi prints",
     "title": "Panoramic Hawaiʻi Prints | Kawika Lopez",
     "description": "Wide panoramic prints of Oʻahu, from Waikīkī and Diamond Head to Kaʻaʻawa Valley. Canvas or metal, up to 72 inches, printed on Oʻahu.",
     "lede": "Stitched from a dozen or more frames, these are made to run long across a wall: above a sofa, a bed or a long hallway."},
    {"path": "horizontal-prints", "kind": "orientation", "value": "horizontal", "chip": "Horizontal",
     "h1": "Horizontal Hawaiʻi prints",
     "title": "Horizontal Hawaiʻi Landscape Prints | Kawika Lopez",
     "description": "Horizontal landscape and aerial prints of Hawaiʻi on canvas or metal, 18 x 12 to 36 x 24 inches, printed on Oʻahu.",
     "lede": "Classic 3 by 2 landscapes, from 18 x 12 to 36 x 24 inches."},
    {"path": "vertical-prints", "kind": "orientation", "value": "vertical", "chip": "Vertical",
     "h1": "Vertical Hawaiʻi prints",
     "title": "Vertical Hawaiʻi Prints for Tall Walls | Kawika Lopez",
     "description": "Vertical landscape and aerial prints of Oʻahu for narrow and tall walls, 16 x 20 to 24 x 30 inches, on canvas or metal.",
     "lede": "Made for the narrow walls: beside a doorway, down a hallway, or in a pair."},
    {"path": "landscape-1", "kind": "collection", "value": "landscape", "chip": "Landscape",
     "h1": "Hawaiʻi landscape photography prints",
     "title": "Hawaiʻi Landscape Photography Prints | Kawika Lopez",
     "description": "Landscape photography prints of Oʻahu and the islands: valleys, ridges, beaches and coastline at sunrise. Canvas or metal, printed on Oʻahu.",
     "lede": "Valleys, ridges and coastline, mostly at sunrise, mostly on Oʻahu."},
    {"path": "fine-art", "kind": "collection", "value": "fine-art", "chip": "Fine art",
     "h1": "Fine art prints",
     "title": "Fine Art Hawaiʻi Photography Prints | Kawika Lopez",
     "description": "Fine art photography prints of Hawaiʻi by Kawika Lopez: long exposures, aerial abstracts and quiet seascapes, on canvas or metal.",
     "lede": "Long exposures, aerial abstracts and quiet seascapes, each made to say one thing."},
]


# ------------------------------------------------------------------ loading

def load_yaml(name, default=None):
    p = DATA / name
    return (yaml.safe_load(p.read_text()) if p.exists() else None) or default


def load_json(name, default=None):
    p = DATA / name
    return json.loads(p.read_text()) if p.exists() else default


class Warnings(list):
    def add(self, msg):
        self.append(msg)


WARN = Warnings()


def apply_fixes(url_id, text, fixes):
    for wrong, right in fixes or []:
        if wrong in text:
            text = text.replace(wrong, right)
        elif right not in text:
            WARN.add(f"{url_id}: fix not applied, '{wrong}' not found")
    return text


def variants_from_pricing(url_id, orientation, pricing):
    rows = pricing.get(orientation) or []
    out = []
    for r in rows:
        for m in ("canvas", "metal"):
            if r.get(m) is None:
                continue
            out.append({"id": f"{url_id}_{r['w']}x{r['h']}_{m}", "size": r["size"], "w": r["w"], "h": r["h"],
                        "material": m, "price": int(r[m]), "sku": None})
    return out


def oversize(v, ship):
    long_edge, short_edge = max(v["w"], v["h"]), min(v["w"], v["h"])
    return long_edge > ship.get("max_ship_long_edge_in", 60) or short_edge > ship.get("max_ship_short_edge_in", 30)


def ship_rates(v, ship):
    """The zone rates for a variant's size and material, or None when it is pickup only."""
    if oversize(v, ship):
        return None
    table = (ship.get("rates") or {}).get(v.get("material"), {})
    return table.get(f"{v['w']}x{v['h']}") or table.get(f"{v['h']}x{v['w']}")


def ships(v, ship):
    """Whether a size ships at all (either material), for pages that list sizes without a material."""
    return any(ship_rates(dict(v, material=m), ship) for m in (ship.get("rates") or {}))


def first_sentence(text):
    m = re.match(r"(.+?[.!?])(\s|$)", text.strip())
    return m.group(1) if m else text.strip()


def clip(text, n):
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= n:
        return text
    cut = text[: n - 1].rsplit(" ", 1)[0].rstrip(",;:")
    return cut + "…"


def fold(s):
    """Lowercase, without ʻokina, kahakō or other marks, for comparing phrases to titles."""
    s = unicodedata.normalize("NFKD", s.replace("ʻ", "").replace("'", "").replace("’", ""))
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def seo_title(p):
    t, s = p["title"], p.get("subtitle")
    options = []
    if s:
        options += [f"{t}: {s} Print | Kawika Lopez", f"{t}: {s} | Kawika Lopez", f"{t}: {s} Print", f"{t}: {s}"]
    options += [f"{t} Print | Kawika Lopez", t]
    for o in options:
        if len(o) <= 62:
            return o
    return options[-1]


def seo_description(p):
    sizes = p["sizes"]
    rng = f"{sizes[0]['label']} to {sizes[-1]['label']} inches" if len(sizes) > 1 else f"{sizes[0]['label']} inches"
    lead = first_sentence(p["description"]) if p["description"] else (p.get("subtitle") or p["title"]) + "."
    tail = f" Canvas or metal, {rng}, from ${p['priceFrom']:,}. Printed on Oʻahu."
    room = 155 - len(tail)
    return clip(lead, max(room, 60)) + tail if len(lead) > room else lead + tail


def load_products(site, links, warn=WARN):
    raw = load_json("products.json", [])
    ov_all = load_yaml("overrides.yml", {})
    pricing = load_yaml("pricing.yml", {})
    images = load_json("images.json", {})
    locations = load_yaml("locations.yml", {})
    ship = load_yaml("shipping.yml", {})

    by_id = {p["urlId"]: dict(p) for p in raw}
    for key, ov in ov_all.items():                      # prints that did not come from Squarespace
        if key not in by_id and ov.get("orientation"):
            v = variants_from_pricing(key, ov["orientation"], pricing)
            sizes = sorted({(x["size"], x["w"], x["h"]) for x in v}, key=lambda s: s[1] * s[2])
            by_id[key] = {"urlId": key, "title": ov.get("title", key), "description": ov.get("description", ""),
                          "orientation": ov["orientation"], "collections": ov.get("collections", ["landscape"]),
                          "ratio": round(sizes[0][1] / sizes[0][2], 4) if sizes else 1,
                          "addedOn": TODAY, "updatedOn": TODAY,
                          "priceFrom": min(x["price"] for x in v), "priceTo": max(x["price"] for x in v),
                          "sizes": [{"label": s[0], "w": s[1], "h": s[2]} for s in sizes], "variants": v}

    out = []
    for url_id, p in by_id.items():
        ov = ov_all.get(url_id) or {}
        if ov.get("status") == "removed":
            continue
        img = images.get(url_id)
        if not img:
            if ov.get("status") != "pending":
                warn.add(f"{url_id}: no image in data/images.json, left out (run tools/images.py)")
            continue
        p = dict(p)
        p.update({"subtitle": None, "alt": None, "island": "", "seo_title": None, "seo_description": None,
                  "story": None, "draft": False, "featured": False, "location": None})
        p["tags"] = ov.get("tags") or []
        for k in ("title", "subtitle", "alt", "island", "seo_title", "seo_description", "story", "draft", "featured"):
            if k in ov:
                p[k] = ov[k]
        p["title"] = p.get("title") or url_id
        p["description"] = apply_fixes(url_id, p.get("description", ""), ov.get("fixes"))
        p["sort"] = ov.get("sort", 100)
        p["image"] = img
        p["path"] = f"store/{url_id}"
        if not p.get("alt"):
            warn.add(f"{url_id}: no alt text in overrides.yml, using the title")
            p["alt"] = f"{p['title']}, a photograph by Kawika Lopez"
        loc_key = ov.get("location")
        if loc_key:
            if loc_key not in locations:
                warn.add(f"{url_id}: location '{loc_key}' is not in data/locations.yml")
            else:
                p["location"] = dict(locations[loc_key], slug=loc_key, page=None)
        # variants: shipping rates, link
        vs = []
        for v in p["variants"]:
            v = dict(v)
            v["ship_rates"] = ship_rates(v, ship)
            v["ships"] = v["ship_rates"] is not None
            if not v["ships"] and not oversize(v, ship):
                warn.add(f"{v['id']}: no shipping rate in data/shipping.yml, pickup only until one is added")
            link = (links or {}).get(v["id"])
            v["link"] = link["url"] if link else None
            # What one print of this size and material costs to ship, in dollars, per zone.
            v["rates"] = {z: c // 100 for z, c in v["ship_rates"].items()} if v["ship_rates"] else None
            vs.append(v)
        p["variants"] = vs
        p["sizes"] = [dict(sz, ships=ships(next(v for v in vs if v["size"] == sz["label"]), ship)) for sz in p["sizes"]]
        pick_defaults(p, ov, pricing, site, warn)
        p["orientation_label"] = ORIENT_LABEL[p["orientation"]]
        p["collection_labels"] = [COLLECTION_LABEL.get(c, c.title()) for c in p.get("collections", [])]
        p["title_tag"] = p.get("seo_title") or seo_title(p)
        p["meta_description"] = p.get("seo_description") or seo_description(p)
        p["paragraphs"] = [x.strip() for x in re.split(r"\n\s*\n", p["description"]) if x.strip()]
        out.append(p)
    out.sort(key=lambda p: (p["sort"], p["title"].lower()))
    return out


# ------------------------------------------------------------------ room preview math

def pick_defaults(p, ov, pricing, site, warn=WARN):
    """The size and material a print page opens on. Size: `default_size` in overrides.yml, else the
    row marked `default: true` for the print's shape in pricing.yml, else the upper middle of the
    sizes that ship. Material: `recommend` in overrides.yml, else site.yml picker.default_material."""
    labels = [s["label"] for s in p["sizes"]]
    rows = {(r["w"], r["h"]): r for r in pricing.get(p["orientation"]) or []}
    flagged = [s["label"] for s in p["sizes"] if (rows.get((s["w"], s["h"])) or {}).get("default")]
    if len(flagged) > 1:
        warn.add(f"{p['urlId']}: more than one default size in pricing.yml ({', '.join(flagged)})")
    size = ov.get("default_size") if ov.get("default_size") in labels else None
    if ov.get("default_size") and not size:
        warn.add(f"{p['urlId']}: default_size '{ov['default_size']}' is not one of its sizes")
    if not size and flagged:
        size = flagged[0]
    if not size:
        pool = [s["label"] for s in p["sizes"] if s["ships"]] or labels
        size = pool[len(pool) // 2]
    if size == labels[0] and len(labels) > 1:
        warn.add(f"{p['urlId']}: the default size is the first one listed; verify.mjs clicks the first size to test the picker")
    if not next(s for s in p["sizes"] if s["label"] == size)["ships"]:
        warn.add(f"{p['urlId']}: the default size {size} is pickup only")
    material = ov.get("recommend") or (site.get("picker") or {}).get("default_material") or "metal"
    p["recommend"] = ov.get("recommend")
    p["default_size"] = size
    p["default_variant"] = (next((v for v in p["variants"] if v["size"] == size and v["material"] == material), None)
                            or next((v for v in p["variants"] if v["size"] == size), p["variants"][0]))


def default_size(p, scene=None):
    """The print's default size (see pick_defaults). With a scene, warn if it would not fit the wall."""
    s = next(s for s in p["sizes"] if s["label"] == p["default_size"])
    if scene:
        wall, ppi = scene["wall"], scene["ppi"]
        if s["w"] * ppi > wall["w"] * 0.96 or s["h"] * ppi > wall["h"] * 0.96:
            WARN.add(f"{p['urlId']}: default size {s['label']} is wider or taller than the room scene's wall")
    return s


def viz_rect(scene, w_in, h_in, anchor=None):
    """Where a w_in x h_in print sits on the scene, as percentages of the scene image.
    The same math runs in assets/js/site.js, so the page looks the same before and after JS."""
    W, H = scene["image"]["width"], scene["image"]["height"]
    wall, ppi = scene["wall"], scene["ppi"]
    a = anchor or scene["anchor"]
    wpx, hpx = w_in * ppi, h_in * ppi
    cx = wall["x"] + a["x"] * wall["w"]
    cy = wall["y"] + a["y"] * wall["h"]
    left = min(max(cx - wpx / 2, wall["x"]), wall["x"] + wall["w"] - wpx) if wpx <= wall["w"] else cx - wpx / 2
    top = min(max(cy - hpx / 2, wall["y"]), wall["y"] + wall["h"] - hpx) if hpx <= wall["h"] else cy - hpx / 2
    r = lambda v: round(v, 3)
    return {"left": r(left / W * 100), "top": r(top / H * 100), "width": r(wpx / W * 100), "height": r(hpx / H * 100)}


# ------------------------------------------------------------------ json-ld

def abs_url(base, path):
    return base + path


def site_graph(site, base):
    person = {"@type": "Person", "@id": base + "#kawika", "name": site["person"]["name"],
              "jobTitle": site["person"]["job_title"], "image": base + "assets/img/site/portrait-960.jpg",
              "url": base + "about",
              "address": {"@type": "PostalAddress", "addressLocality": site["person"]["locality"],
                          "addressRegion": site["person"]["region"], "addressCountry": "US"},
              "sameAs": site["person"]["same_as"]}
    org = {"@type": "Organization", "@id": base + "#org", "name": site["name"], "legalName": site["legal_name"],
           "url": base, "logo": base + "assets/img/site/logo-512.png", "founder": {"@id": base + "#kawika"},
           "sameAs": site["person"]["same_as"]}
    web = {"@type": "WebSite", "@id": base + "#site", "name": site["name"], "url": base,
           "publisher": {"@id": base + "#org"}, "inLanguage": "en-US"}
    return [org, person, web]


def breadcrumbs_ld(base, items):
    return {"@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": i + 1, "name": name, "item": base + path}
        for i, (name, path) in enumerate(items)]}


# Every state but Hawaiʻi pays the mainland rate (gas/checkout.gs), Alaska included.
MAINLAND = ["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "ID", "IL", "IN", "IA", "KS", "KY",
            "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND",
            "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"]
WEEKDAYS = ["https://schema.org/" + d for d in ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")]


def variant_url(url, v):
    """The address that opens a print page on one size and material (read by site.js)."""
    return f"{url}?size={v['w']}x{v['h']}&material={v['material']}"


def product_ld(p, base, ship=None, site=None):
    """A ProductGroup with one Product and Offer per size and material, which is what Google's
    merchant listings accept. Each offer carries its shipping rates per zone and the returns policy
    from /terms. Delivery times go in only once shipping.yml days_confirmed is true."""
    ship, site = ship or {}, site or {}
    url = base + p["path"]
    img = p["image"]
    big = max(w for w in img["widths"] if w >= 480) if any(w >= 480 for w in img["widths"]) else img["widths"][-1]
    image_url = f"{base}assets/img/prints/{p['urlId']}-{big}.jpg"
    zones = {z["id"]: z for z in ship.get("zones", [])}
    shared = {}

    def days(lo_hi):
        return {"@type": "QuantitativeValue", "minValue": lo_hi[0], "maxValue": lo_hi[1], "unitCode": "DAY"}

    def ship_ref(zone, cents):
        nid = f"{url}#ship-{zone}-{cents}"
        if nid not in shared:
            node = {"@type": "OfferShippingDetails", "@id": nid,
                    "shippingRate": {"@type": "MonetaryAmount", "value": f"{cents / 100:.2f}", "currency": "USD"},
                    "shippingDestination": {"@type": "DefinedRegion", "addressCountry": "US",
                                            "addressRegion": ["HI"] if zone == "hi" else MAINLAND}}
            if ship.get("days_confirmed") and ship.get("handling_days") and (ship.get("transit_days") or {}).get(zone):
                node["deliveryTime"] = {"@type": "ShippingDeliveryTime", "handlingTime": days(ship["handling_days"]),
                                        "transitTime": days(ship["transit_days"][zone]),
                                        "businessDays": {"@type": "OpeningHoursSpecification", "dayOfWeek": WEEKDAYS}}
            shared[nid] = node
        return {"@id": nid}

    returns = {"@type": "MerchantReturnPolicy", "@id": url + "#returns", "applicableCountry": "US",
               "returnPolicyCountry": "US", "returnPolicyCategory": "https://schema.org/MerchantReturnNotPermitted",
               "merchantReturnLink": base + "terms"}
    variants = []
    for v in p["variants"]:
        offer = {"@type": "Offer", "url": variant_url(url, v), "price": f"{v['price']:.2f}", "priceCurrency": "USD",
                 "itemCondition": "https://schema.org/NewCondition", "seller": {"@id": base + "#org"},
                 "hasMerchantReturnPolicy": {"@id": returns["@id"]}}
        if v["ships"] and v.get("ship_rates"):
            offer["availability"] = "https://schema.org/InStock"
            offer["shippingDetails"] = [ship_ref(z, c) for z, c in v["ship_rates"].items() if z in zones]
        else:
            offer["availability"] = "https://schema.org/InStoreOnly"
            offer["availableDeliveryMethod"] = "https://schema.org/OnSitePickup"
            offer["shippingDetails"] = {"@type": "OfferShippingDetails", "doesNotShip": True,
                                        "shippingDestination": {"@type": "DefinedRegion", "addressCountry": "US"}}
        variants.append({"@type": "Product", "sku": v["id"], "inProductGroupWithID": p["urlId"],
                         "name": f"{p['title']}, {v['size']} in {v['material']}", "image": image_url,
                         "size": f"{v['size']} in", "material": v["material"].capitalize(), "offers": offer})
    group = {"@type": "ProductGroup", "@id": url + "#product", "productGroupID": p["urlId"], "url": url,
             "name": f"{p['title']}" + (f": {p['subtitle']}" if p.get("subtitle") else ""),
             "description": p["meta_description"], "image": [image_url, f"{base}assets/img/og/{p['urlId']}.jpg"],
             "brand": {"@type": "Brand", "name": "Kawika Lopez"}, "category": "Art > Photographs",
             "variesBy": ["https://schema.org/size", "https://schema.org/material"], "hasVariant": variants}
    photo = {"@type": "ImageObject", "contentUrl": image_url, "name": p["title"], "caption": p["alt"],
             "creator": {"@id": base + "#kawika"}, "creditText": "Kawika Lopez",
             "copyrightNotice": "© Kawika Lopez", "copyrightHolder": {"@id": base + "#kawika"}}
    if p.get("location"):
        photo["contentLocation"] = {"@type": "Place", "name": p["location"]["title"]}
    return [group, returns, *shared.values(), photo]


def collection_ld(base, path, name, description, items):
    return {"@type": "CollectionPage", "@id": base + path, "url": base + path, "name": name,
            "description": description, "isPartOf": {"@id": base + "#site"},
            "mainEntity": {"@type": "ItemList", "numberOfItems": len(items), "itemListElement": [
                {"@type": "ListItem", "position": i + 1, "url": base + p["path"], "name": p["title"]}
                for i, p in enumerate(items)]}}


def ld_script(graph):
    text = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False, separators=(",", ":"))
    return Markup(text.replace("</", "<\\/"))


# ------------------------------------------------------------------ rendering

class Builder:
    def __init__(self, production=False, check=False):
        self.production = production
        self.check = check
        self.site = load_yaml("site.yml", {})
        self.base = self.site["base_url"]["production" if production else "staging"]
        pl = load_json(f"payment-links-{'live' if production else 'test'}.json", {}) or {}
        self.links_mode = pl.get("mode") if self.site["features"].get("checkout") else None
        if production and self.site["features"].get("checkout") and self.links_mode != "live":
            raise SystemExit("production build with test payment links: run tools/stripe_catalog.py --mode live first")
        self.links = pl.get("links") if self.links_mode else None
        self.locations = load_yaml("locations.yml", {})
        self.products = load_products(self.site, self.links)
        self.by_id = {p["urlId"]: p for p in self.products}
        self.scenes = load_json("scenes.json", [])
        self.scene = self.scenes[0] if self.scenes else None
        self.shipping = load_yaml("shipping.yml", {})
        hd = self.shipping.get("handling_days")
        for z in self.shipping.get("zones", []):
            td = (self.shipping.get("transit_days") or {}).get(z["id"])
            if hd and td and [hd[0] + td[0], hd[1] + td[1]] != list(z["days"]):
                WARN.add(f"shipping.yml: handling_days plus transit_days for {z['id']} do not add up to its days {z['days']}")
        # Cart: on when checkout links exist and the checkout service (gas/checkout.gs) is deployed.
        # KL_CHECKOUT_ENDPOINT overrides site.yml for local testing (tools/checkout_dev.mjs).
        endpoint = os.environ.get("KL_CHECKOUT_ENDPOINT") or (self.site.get("checkout") or {}).get("endpoint") or ""
        self.cart = {"endpoint": endpoint, "mode": self.links_mode} if endpoint and self.links_mode else None
        self.lastmod = load_json("lastmod.json", {}) or {}
        self.pages = []            # every page rendered: {path, file, type, title, indexable}
        self.changed = []
        self.env = Environment(loader=FileSystemLoader(str(ROOT / "templates")),
                               autoescape=select_autoescape(["html", "xml"]),
                               trim_blocks=True, lstrip_blocks=True, undefined=StrictUndefined)
        self.env.globals.update(links_mode=self.links_mode, picture=picture, pic_site=pic_site, url=url, asset=asset, preload_img=preload_img,
                                money=lambda n: f"${n:,}", site=self.site, production=production,
                                cart=self.cart)
        self.env.filters["longdate"] = lambda d: (dt.date.fromisoformat(str(d)[:10]).strftime("%B %-d, %Y") if d else "")
        self.env.filters["json"] = lambda o: Markup(html.escape(json.dumps(o, ensure_ascii=False, separators=(",", ":")), quote=True))
        # Place pages and posts from content/ (synced from the vault). Drafts render on staging
        # only, with a draft label, so Kawika can read them in place before they go live.
        self.show_drafts = not production
        keep = lambda d: d["status"] == "published" or (self.show_drafts and d["status"] == "draft")
        self.place_docs = {}
        for d in md.load_docs(ROOT / "content" / "places", WARN):
            key = d.get("place") or d["slug"]
            if key not in self.locations:
                WARN.add(f"place page {d['slug']}: '{key}' is not in data/locations.yml, skipped")
                continue
            if keep(d):
                d["key"] = key
                d["path"] = f"hawaii-prints/{key}"
                self.place_docs[key] = d
        self.posts = [d for d in md.load_docs(ROOT / "content" / "posts", WARN) if keep(d)]
        for d in self.posts:
            d["path"] = f"blog/{d['slug']}"
        self.posts.sort(key=lambda d: d.get("date") or "", reverse=True)
        for p in self.products:
            if p.get("location") and p["location"]["slug"] in self.place_docs:
                p["location"]["page"] = self.place_docs[p["location"]["slug"]]["path"]

        # Pages that exist in this build. Nav and links only point at these.
        self.available = ({"", "store/", "prints", "about", "contact", "privacy", "terms", "thank-you"}
                          | {c["path"] for c in COLLECTIONS}
                          | {d["path"] for d in self.place_docs.values()}
                          | {d["path"] for d in self.posts})
        if self.place_docs:
            self.available.add("hawaii-prints/")
        if self.posts:
            self.available.add("blog/")
        if self.cart:
            self.available.add("cart")

    # -- output
    def write(self, rel, text):
        out = ROOT / rel
        old = out.read_text() if out.exists() else None
        if old == text:
            return False
        self.changed.append(rel)
        if not self.check:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text)
        return True

    def emit(self, template, rel, path, page_type, title, description, crumbs=None, graph=None,
             indexable=True, meta=None, **ctx):
        depth = rel.count("/")
        root = "../" * depth
        is404 = rel == "404.html"
        if is404:
            root = urlparse(self.base).path   # root-relative: GitHub Pages serves 404.html at any depth
        canonical = self.base + path
        full_graph = site_graph(self.site, self.base)
        if crumbs:
            full_graph.append(breadcrumbs_ld(self.base, crumbs))
        full_graph += graph or []
        ctx.setdefault("preload", None)
        ctx.setdefault("draft", False)
        for k in ("og_alt", "og_type", "published", "modified"):
            ctx.setdefault(k, None)
        if ctx.get("og_image") is None:
            ctx.pop("og_image", None)
        text = self.env.get_template(template).render(
            root=root, path=path, rel=rel, canonical=canonical, title=title, description=description,
            page_type=page_type, noindex=(not self.production) or not indexable, crumbs=crumbs or [],
            jsonld=ld_script(full_graph), nav=self.nav(), base=self.base, **ctx)
        text = re.sub(r"\n{3,}", "\n\n", text)
        changed = self.write(rel, text)
        key = path or "/"
        digest = hashlib.sha1(text.encode()).hexdigest()[:12]
        prev = self.lastmod.get(key)
        if changed or not prev:
            if not prev or prev.get("hash") != digest:
                self.lastmod[key] = {"hash": digest, "date": TODAY}
        # The page's main photograph at its largest JPG, for the image sitemap. Pages that preload a
        # print (print, place and post pages) have one; the others list none.
        images = []
        if ctx.get("preload"):
            base_path, widths = ctx["preload"][0], ctx["preload"][1]
            images.append(f"{base_path}-{max([w for w in widths if w >= 480] or widths)}.jpg")
        self.pages.append({"path": path, "file": rel, "type": page_type, "title": title,
                           "description": description, "indexable": indexable and not is404,
                           **({"images": images} if images else {}), **({"meta": meta} if meta else {})})

    def ship_zones(self):
        places = {"hi": "Hawaiʻi", "mainland": "the US mainland"}
        return [dict(z, place=places.get(z["id"], z["label"])) for z in self.shipping.get("zones", [])]

    def nav(self):
        return [n for n in self.site["nav"] if n["href"] in self.available]

    # -- pages
    def related(self, p, n=4, max_same_place=2):
        """Photos that look and feel like this one, not only ones from the same place.
        Shared subject tags count most, then place, island, style and shape. At most
        `max_same_place` come from any one place, so the row always has some range."""
        tags = set(p.get("tags") or [])
        slug = (p.get("location") or {}).get("slug")
        colls = set(p.get("collections") or [])

        def score(q):
            s = 3 * len(tags & set(q.get("tags") or []))
            q_slug = (q.get("location") or {}).get("slug")
            if slug and q_slug == slug:
                s += 3
            elif p.get("island") and q.get("island") == p.get("island"):
                s += 1
            s += len(colls & set(q.get("collections") or []))
            if q["orientation"] == p["orientation"]:
                s += 1
            return s

        pool = [q for q in self.products if q["urlId"] != p["urlId"] and not q.get("draft")]
        pool.sort(key=lambda q: (-score(q), q["sort"], q["title"].lower()))
        picked, per_place = [], {}
        for q in pool:
            q_slug = (q.get("location") or {}).get("slug")
            if q_slug:
                if per_place.get(q_slug, 0) >= max_same_place:
                    continue
                per_place[q_slug] = per_place.get(q_slug, 0) + 1
            picked.append(q)
            if len(picked) == n:
                break
        return picked

    def room_for(self, p):
        if not self.scene:
            return None
        s = default_size(p, self.scene)
        return {"scene": self.scene, "size": s, "rect": viz_rect(self.scene, s["w"], s["h"]),
                "data": {"W": self.scene["image"]["width"], "H": self.scene["image"]["height"],
                         "wall": self.scene["wall"], "ppi": self.scene["ppi"], "anchor": self.scene["anchor"]}}

    def product_pages(self):
        for p in self.products:
            room = self.room_for(p)
            default_variant = p["default_variant"]
            orient_page = f"{p['orientation']}-prints"
            crumbs = [("Prints", "store/")]
            if orient_page in self.available:
                crumbs.append((p["orientation_label"], orient_page))
            crumbs.append((p["title"], p["path"]))
            picker = {"variants": [{"id": v["id"], "size": v["size"], "w": v["w"], "h": v["h"], "material": v["material"],
                                    "price": v["price"], "link": v["link"], "ships": v["ships"], "rates": v["rates"]}
                                   for v in p["variants"]],
                      "title": p["title"], "email": self.site["contact"]["email"], "default": default_variant["id"]}
            table = []
            for s in p["sizes"]:
                row = {"size": s, "canvas": None, "metal": None}
                for v in p["variants"]:
                    if v["size"] == s["label"]:
                        row[v["material"]] = v
                table.append(row)
            self.emit("product.html", f"store/{p['urlId']}.html", p["path"], "product",
                      p["title_tag"], p["meta_description"], crumbs=crumbs,
                      graph=product_ld(p, self.base, self.shipping, self.site),
                      indexable=not p.get("draft"), p=p, room=room, picker=picker, table=table,
                      default_variant=default_variant, related=self.related(p),
                      ship_zones=self.ship_zones(), pickup_days=self.shipping["pickup"]["days"],
                      days_on=bool(self.shipping.get("days_confirmed")),
                      meta={"default_id": default_variant["id"], "default_size": default_variant["size"],
                            "default_material": default_variant["material"], "orientation": p["orientation"]},
                      og_image=f"{self.base}assets/img/og/{p['urlId']}.jpg", og_alt=p["alt"],
                      preload=(f"assets/img/prints/{p['urlId']}", p["image"]["widths"], sizes_for_product(p)))

    def store_page(self):
        items = [p for p in self.products if not p.get("draft")]
        desc = ("Fine art prints of Hawaiʻi by Kawika Lopez: panoramas of Waikīkī and Kaʻaʻawa Valley and aerials "
                "of the Kaiwi coast, on canvas or metal.")
        self.emit("store.html", "store/index.html", "store/", "store", "Hawaiʻi Wall Art Prints for Sale | Kawika Lopez",
                  desc, crumbs=[("Prints", "store/")],
                  graph=[collection_ld(self.base, "store/", "Hawaiʻi wall art prints", desc, items)],
                  items=items, collections=COLLECTIONS, current="store/", h1="Hawaiʻi wall art prints",
                  lede="Every print is made to order on Oʻahu, on canvas or metal. Pick a size and see it to scale on a wall before you buy.")

    def collection_pages(self):
        for c in COLLECTIONS:
            if c["kind"] == "orientation":
                items = [p for p in self.products if p["orientation"] == c["value"] and not p.get("draft")]
            else:
                items = [p for p in self.products if c["value"] in p.get("collections", []) and not p.get("draft")]
            crumbs = [("Prints", "store/"), (c["h1"], c["path"])]
            self.emit("store.html", f"{c['path']}.html", c["path"], "collection", c["title"], c["description"],
                      crumbs=crumbs, graph=[collection_ld(self.base, c["path"], c["h1"], c["description"], items)],
                      items=items, collections=COLLECTIONS, current=c["path"], h1=c["h1"], lede=c["lede"])

    def home(self):
        order = self.site.get("featured_order") or []
        featured = [self.by_id[i] for i in order if i in self.by_id and not self.by_id[i].get("draft")]
        featured += [p for p in self.products if p.get("featured") and p not in featured and not p.get("draft")]
        featured = featured[:8]
        tiles = []
        for c, pid in [("panoramic-prints", "kaimana"), ("landscape-1", "kaaawasunrise"), ("fine-art", "puao")]:
            coll = next(x for x in COLLECTIONS if x["path"] == c)
            count = len([p for p in self.products if (p["orientation"] == coll["value"] if coll["kind"] == "orientation"
                                                       else coll["value"] in p.get("collections", [])) and not p.get("draft")])
            if pid in self.by_id:
                tiles.append({"c": coll, "p": self.by_id[pid], "count": count})
        teaser = None
        if "kaimana" in self.by_id and self.scene:
            k = self.by_id["kaimana"]
            s = default_size(k, self.scene)
            teaser = {"p": k, "size": s, "rect": viz_rect(self.scene, s["w"], s["h"]), "scene": self.scene}
        desc = ("Hawaiʻi landscape and aerial photography prints by Kawika Lopez. Panoramas of Waikīkī, Diamond Head "
                "and Kaʻaʻawa Valley on canvas or metal, printed on Oʻahu.")
        self.emit("home.html", "index.html", "", "home", "Kawika Lopez | Hawaiʻi Landscape and Aerial Prints", desc,
                  featured=featured, total=len([p for p in self.products if not p.get("draft")]),
                  places=list(self.place_docs.values()), tiles=tiles, teaser=teaser, hero_print=self.by_id.get("naniwaikiki"),
                  preload=("assets/img/site/hero-living", [480, 960, 1600, 2000], "100vw"))

    def prints_page(self):
        pricing = load_yaml("pricing.yml", {})
        ship = self.shipping
        labels = {"panoramic": ("Panoramic", "3 to 1"), "horizontal": ("Horizontal", "3 to 2"),
                  "vertical": ("Vertical", "4 to 5"), "square": ("Square", "1 to 1")}
        examples = {"panoramic": "kaimana", "horizontal": "kaaawasunrise", "vertical": "olomana", "square": "hanauma"}
        groups = []
        for o in ("panoramic", "horizontal", "vertical", "square"):
            rows = pricing.get(o) or []
            if not rows:
                continue
            items = [p for p in self.products if p["orientation"] == o and not p.get("draft")]
            if not items:
                continue
            ex = self.by_id.get(examples[o]) or items[0]
            ghosts = [{"label": f"{r['size']}", "rect": viz_rect(self.scene, r["w"], r["h"])} for r in rows] if self.scene else []
            browse = f"{o}-prints" if f"{o}-prints" in self.available else "store/"
            groups.append({
                "orientation": o, "label": labels[o][0], "shape": labels[o][1], "count": len(items),
                "example": ex, "ghosts": ghosts, "browse": browse,
                "rows": [{"size": r["size"], "canvas": r.get("canvas"), "metal": r.get("metal"),
                          "ships": ships(r, ship)} for r in rows],
            })
        lows = [r.get(m) for g in groups for r in g["rows"] for m in ("canvas", "metal") if r.get(m)]
        desc = (f"Sizes and prices for Kawika Lopez's Hawaiʻi prints, from ${min(lows):,}: panoramas up to 72 inches, "
                "canvas or metal, each size drawn to scale on a real wall.")
        page = {"@type": "WebPage", "@id": self.base + "prints", "url": self.base + "prints",
                "name": "Print sizes and prices", "isPartOf": {"@id": self.base + "#site"}}
        self.emit("prints.html", "prints.html", "prints", "page", "Print Sizes and Prices | Kawika Lopez", desc,
                  crumbs=[("Sizes and pricing", "prints")], graph=[page], groups=groups, scene=self.scene)

    def about_page(self):
        feature = self.by_id.get("kahana") or self.products[0]
        src = ROOT / "harvest" / "images" / "site" / "portrait-kawika.jpg"
        pw, ph = (1400, 1750)
        if src.exists():
            from PIL import Image as _Image
            with _Image.open(src) as im:
                pw, ph = im.size
        portrait = {"w": pw, "h": ph, "widths": [w for w in (480, 960, 1400) if w <= pw] or [pw]}
        desc = ("Kawika Lopez is a landscape and aerial photographer on Oʻahu. How the prints are made, "
                "from pre-dawn hikes to drone flights along the coast.")
        page = {"@type": "AboutPage", "@id": self.base + "about", "url": self.base + "about",
                "name": "About Kawika Lopez", "mainEntity": {"@id": self.base + "#kawika"},
                "isPartOf": {"@id": self.base + "#site"}}
        self.emit("about.html", "about.html", "about", "page", "About Kawika Lopez | Hawaiʻi Landscape Photographer",
                  desc, crumbs=[("About", "about")], graph=[page], feature=feature, portrait=portrait,
                  og_image=self.base + "assets/img/og/about.jpg", og_alt="Kawika Lopez, landscape and aerial photographer")

    def contact_page(self):
        desc = "Questions about a Kawika Lopez print, sizing for your wall, or shipping a large piece? Send a message."
        page = {"@type": "ContactPage", "@id": self.base + "contact", "url": self.base + "contact",
                "name": "Contact Kawika Lopez", "isPartOf": {"@id": self.base + "#site"}}
        self.emit("contact.html", "contact.html", "contact", "page", "Contact | Kawika Lopez Photography", desc,
                  crumbs=[("Contact", "contact")], graph=[page],
                  prints=[p for p in self.products if not p.get("draft")])

    def privacy_page(self):
        desc = "What kawikalopez.com collects when you buy a print or send a message, why, who sees it, and how to have it deleted."
        self.emit("privacy.html", "privacy.html", "privacy", "page", "Privacy Policy | Kawika Lopez Photography", desc,
                  crumbs=[("Privacy", "privacy")], updated="September 27, 2026")

    def terms_page(self):
        desc = "How print orders work at kawikalopez.com: made to order on Oʻahu, shipping and pickup, cancellations, damage and returns, and copyright."
        self.emit("terms.html", "terms.html", "terms", "page", "Terms of Sale | Kawika Lopez Photography", desc,
                  crumbs=[("Terms", "terms")], updated="September 27, 2026")

    def cart_page(self):
        """The cart page, and assets/data/cart.json: what the page needs to show each print, plus
        the shipping model that the checkout service (gas/checkout.gs) also reads."""
        if not self.cart:
            return
        ship = self.shipping
        variants = {}
        for p in self.products:
            if p.get("draft"):
                continue
            for v in p["variants"]:
                variants[v["id"]] = {"title": p["title"], "size": v["size"], "material": v["material"], "price": v["price"],
                                     "w": v["w"], "h": v["h"], "ships": v["ships"], "path": p["path"],
                                     "img": f"assets/img/prints/{p['urlId']}-240.webp", "link": v["link"]}
        model = dict(ship["cart"], max_long_edge_in=ship["max_ship_long_edge_in"],
                     max_short_edge_in=ship["max_ship_short_edge_in"],
                     pickup={"label": ship["pickup"]["label"], "days": ship["pickup"]["days"]},
                     zones={z["id"]: {"label": z["label"], "days": z["days"]} for z in ship["zones"]})
        pk = ((self.site.get("checkout") or {}).get("publishable_key") or {}).get(self.cart["mode"]) or ""
        if not pk.startswith("pk_" + self.cart["mode"] + "_"):
            WARN.add(f"cart: no {self.cart['mode']} publishable key in data/site.yml (checkout.publishable_key)")
        data = {"mode": self.cart["mode"], "endpoint": self.cart["endpoint"], "pk": pk, "model": model, "variants": variants}
        self.write("assets/data/cart.json", json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n")
        self.emit("cart.html", "cart.html", "cart", "page", "Your cart | Kawika Lopez Photography",
                  "The prints in your cart, shipping to Hawaiʻi or the US mainland, and checkout.", indexable=False)

    def thankyou_page(self):
        self.emit("thank-you.html", "thank-you.html", "thank-you", "page", "Thank you | Kawika Lopez Photography",
                  "Your order is in. What happens next.", indexable=False)

    # -- places and posts
    def md_html(self, body, rel):
        root = "../" * rel.count("/")

        def link_for(kind, key):
            if kind == "print":
                if key in self.by_id:
                    return root + self.by_id[key]["path"]
                WARN.add(f"{rel}: link to unknown print '{key}'")
            elif kind == "place":
                if key in self.place_docs:
                    return root + self.place_docs[key]["path"]
                WARN.add(f"{rel}: link to a place without a page '{key}'")
            elif kind == "page":
                if key in self.available:
                    return root + key if key else (root or "./")
                WARN.add(f"{rel}: link to a page that is not built '{key}'")
            return None

        def card_for(ids):
            items = [self.by_id[i] for i in ids if i in self.by_id]
            for i in ids:
                if i not in self.by_id:
                    WARN.add(f"{rel}: print card for unknown print '{i}'")
            if not items:
                return ""
            one = len(items) == 1
            figs = []
            for p in items:
                sizes = "(min-width: 900px) 760px, calc(100vw - 32px)" if one else "(min-width: 900px) 360px, 50vw"
                figs.append(
                    f'<a class="inline-print" href="{root}{p["path"]}" style="--r:{p["image"]["w"] / p["image"]["h"]:.4f}">'
                    f'{print_picture(p, root, sizes)}'
                    f'<span class="inline-cap"><span class="card-title">{html.escape(p["title"])}</span> '
                    f'<span class="card-sub">{html.escape(p.get("subtitle") or "")}, from ${p["priceFrom"]:,}</span></span></a>')
            cls = "inline-prints" + (" is-one" if one else "")
            return f'<div class="{cls}">' + "".join(figs) + "</div>"

        return Markup(md.render(body, link_for, card_for))

    def place_pages(self):
        for key, d in self.place_docs.items():
            loc = dict(self.locations[key], slug=key)
            items = [p for p in self.products if (p.get("location") or {}).get("slug") == key and not p.get("draft")]
            hero = self.by_id.get(d.get("hero")) or (items[0] if items else None)
            if not items or not hero:
                WARN.add(f"place page {key}: no prints, skipped")
                continue
            rel = f"{d['path']}.html"
            body = self.md_html(d["body"], rel)
            others = [self.place_docs[k] for k in self.place_docs if k != key]
            posts = [q for q in self.posts if key in (q.get("places") or [])]
            place_ld = {"@type": "Place", "name": loc["title"],
                        "containedInPlace": {"@type": "Place", "name": loc.get("island", "")}}
            if loc.get("coords"):
                place_ld["geo"] = {"@type": "GeoCoordinates", "latitude": loc["coords"][0], "longitude": loc["coords"][1]}
            coll = collection_ld(self.base, d["path"], d["title"], d.get("description", ""), items)
            coll["about"] = place_ld
            title = d.get("seo_title") or f"{d['title']} | Kawika Lopez"
            if d.get("target") and d["target"].lower() not in d["title"].lower():
                WARN.add(f"place page {key}: title does not contain its target phrase '{d['target']}'")
            self.emit("place.html", rel, d["path"], "place", title, d.get("description", ""),
                      crumbs=[("Places", "hawaii-prints/"), (loc["short"], d["path"])], graph=[coll],
                      indexable=d["status"] == "published", draft=d["status"] != "published",
                      doc=d, loc=loc, body=body, items=items, hero=hero, others=others, posts=posts,
                      og_image=f"{self.base}assets/img/og/{hero['urlId']}.jpg",
                      preload=(f"assets/img/prints/{hero['urlId']}", hero["image"]["widths"], "100vw"))

    def places_index(self):
        if not self.place_docs:
            return
        cards = []
        for key, d in self.place_docs.items():
            items = [p for p in self.products if (p.get("location") or {}).get("slug") == key and not p.get("draft")]
            hero = self.by_id.get(d.get("hero")) or (items[0] if items else None)
            if hero:
                cards.append({"doc": d, "loc": self.locations[key], "hero": hero, "count": len(items)})
        desc = ("Hawaiʻi prints by place: Kaʻaʻawa Valley, Mokoliʻi, Makapuʻu, the Kaiwi coast, Diamond Head, "
                "the North Shore, Lanikai and the Koʻolau.")
        coll = {"@type": "CollectionPage", "@id": self.base + "hawaii-prints/", "url": self.base + "hawaii-prints/",
                "name": "Hawaiʻi prints by place", "isPartOf": {"@id": self.base + "#site"}}
        self.emit("places.html", "hawaii-prints/index.html", "hawaii-prints/", "places", "Hawaiʻi Prints by Place | Kawika Lopez",
                  desc, crumbs=[("Places", "hawaii-prints/")], graph=[coll], cards=cards,
                  indexable=any(c["doc"]["status"] == "published" for c in cards))

    def post_pages(self):
        for d in self.posts:
            rel = f"{d['path']}.html"
            body = self.md_html(d["body"], rel)
            hero = self.by_id.get(d.get("hero"))
            prints = [self.by_id[i] for i in (d.get("prints") or []) if i in self.by_id]
            if not prints:
                WARN.add(f"post {d['slug']}: lists no prints (every post should link at least one)")
            url_ = self.base + d["path"]
            post_ld = {"@type": "BlogPosting", "@id": url_ + "#post", "headline": d["title"],
                       "description": d.get("description", ""), "url": url_, "mainEntityOfPage": url_,
                       "datePublished": d.get("date"), "dateModified": d.get("updated") or d.get("date"),
                       "author": {"@id": self.base + "#kawika"}, "publisher": {"@id": self.base + "#org"},
                       "inLanguage": "en-US"}
            if hero:
                post_ld["image"] = f"{self.base}assets/img/og/{hero['urlId']}.jpg"
            title = d.get("seo_title") or f"{d['title']} | Kawika Lopez"
            places = [self.place_docs[k] for k in (d.get("places") or []) if k in self.place_docs]
            self.emit("post.html", rel, d["path"], "post", title, d.get("description", ""),
                      crumbs=[("Blog", "blog/"), (d["title"], d["path"])], graph=[post_ld],
                      indexable=d["status"] == "published", draft=d["status"] != "published",
                      doc=d, body=body, hero=hero, prints=prints, places=places,
                      minutes=md.reading_minutes(d["body"]),
                      og_image=f"{self.base}assets/img/og/{hero['urlId']}.jpg" if hero else None,
                      og_alt=hero["alt"] if hero else None, og_type="article",
                      published=d.get("date"), modified=d.get("updated") or d.get("date"),
                      preload=(f"assets/img/prints/{hero['urlId']}", hero["image"]["widths"], "(min-width: 1100px) 1040px, 100vw") if hero else None)

    def blog_index(self):
        if not self.posts:
            return
        items = []
        for d in self.posts:
            items.append({"doc": d, "hero": self.by_id.get(d.get("hero"))})
        desc = "Stories behind the prints and plain advice on choosing, sizing and hanging wall art, from Kawika Lopez."
        coll = {"@type": "Blog", "@id": self.base + "blog/", "url": self.base + "blog/", "name": "Kawika Lopez blog",
                "publisher": {"@id": self.base + "#org"}}
        self.emit("blog.html", "blog/index.html", "blog/", "blog", "Blog | Kawika Lopez Photography", desc,
                  crumbs=[("Blog", "blog/")], graph=[coll], items=items,
                  indexable=any(d["status"] == "published" for d in self.posts))

    def not_found(self):
        self.emit("404.html", "404.html", "404", "404", "Page not found | Kawika Lopez",
                  "That page isn't here. Browse Hawaiʻi prints by Kawika Lopez instead.", indexable=False,
                  picks=[p for p in self.products if p.get("featured")][:4])

    def redirects(self):
        made, skipped = [], []
        for r in load_yaml("redirects.yml", []):
            target = r["to"]
            external = target.startswith("http")
            if not external and target not in self.available:
                skipped.append(r["from"])
                continue
            rel = f"{r['from']}.html"
            root = "../" * rel.count("/")
            href = target if external else (root + target if target else (root or "./"))
            text = self.env.get_template("redirect.html").render(
                href=href, canonical=target if external else self.base + target, title="Moved")
            self.write(rel, text)
            made.append(r["from"])
        if skipped:
            WARN.add("redirect pages waiting on their target: " + ", ".join(skipped))
        self.redirects_made = made

    def sitemap_and_robots(self):
        urls = [pg for pg in self.pages if pg["indexable"]]
        prod_base = self.site["base_url"]["production"]
        # Image entries tell Google Images which photograph belongs to which page. Only image:loc is
        # read now (Google dropped caption, title and license from image sitemaps in 2022).
        lines = ['<?xml version="1.0" encoding="UTF-8"?>',
                 '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" '
                 'xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">']
        for pg in sorted(urls, key=lambda x: (x["path"] != "", x["path"])):
            lm = self.lastmod.get(pg["path"] or "/", {}).get("date", TODAY)
            imgs = "".join(f"<image:image><image:loc>{html.escape(prod_base + i)}</image:loc></image:image>"
                           for i in pg.get("images", []))
            lines.append(f"  <url><loc>{html.escape(prod_base + pg['path'])}</loc><lastmod>{lm}</lastmod>{imgs}</url>")
        lines.append("</urlset>")
        self.write("sitemap.xml", "\n".join(lines) + "\n")
        if self.production:
            robots = f"User-agent: *\nAllow: /\n\nSitemap: {prod_base}sitemap.xml\n"
        else:
            robots = "# Staging: every page also carries a noindex tag.\nUser-agent: *\nDisallow: /\n"
        self.write("robots.txt", robots)

    def run(self):
        self.product_pages()
        self.store_page()
        self.collection_pages()
        self.home()
        self.prints_page()
        self.about_page()
        self.contact_page()
        self.privacy_page()
        self.terms_page()
        self.thankyou_page()
        self.cart_page()
        self.place_pages()
        self.places_index()
        self.post_pages()
        self.blog_index()
        self.not_found()
        self.redirects()
        self.sitemap_and_robots()
        if not self.check:
            (DATA / "pages.json").write_text(json.dumps(self.pages, indent=1, ensure_ascii=False) + "\n")
            (DATA / "lastmod.json").write_text(json.dumps(self.lastmod, indent=1, sort_keys=True) + "\n")
        self.checks()

    def checks(self):
        titles = {}
        for pg in self.pages:
            if not pg["indexable"]:
                continue
            titles.setdefault(pg["title"], []).append(pg["path"])
            if len(pg["title"]) > 65:
                WARN.add(f"title over 65 characters on /{pg['path']}: {pg['title']}")
        for t, paths in titles.items():
            if len(paths) > 1:
                WARN.add(f"duplicate title '{t}' on " + ", ".join("/" + p for p in paths))

        # Descriptions: 50 to 160 characters, and none cut off mid-sentence.
        clipped = []
        for pg in self.pages:
            if not pg["indexable"]:
                continue
            d = pg.get("description") or ""
            if "…" in d:
                clipped.append(pg["path"].replace("store/", ""))
            elif not 50 <= len(d) <= 160:
                WARN.add(f"description is {len(d)} characters on /{pg['path']} (want 50 to 160)")
        if clipped:
            WARN.add(f"{len(clipped)} descriptions are cut off mid-sentence; give them seo_description in "
                     "overrides.yml (SEO plan phase 2): " + ", ".join(sorted(clipped)))

        # Target phrase registry (data/targets.yml). `planned: true` entries have no page yet; they are
        # the queue the monthly report picks the next pages from.
        by_path = {pg["path"]: pg for pg in self.pages}
        for t in load_yaml("targets.yml", []) or []:
            if t.get("planned"):
                continue
            pg = by_path.get(t["page"])
            if not pg or not pg["indexable"]:
                WARN.add(f"target '{t['phrase']}': /{t['page']} is not an indexable page in this build")
            elif fold(t["phrase"]) not in fold(pg["title"]):
                WARN.add(f"target '{t['phrase']}': not in the title of /{t['page']} ('{pg['title']}')")


# ------------------------------------------------------------------ template helpers

def _srcset(root, base, widths, ext):
    return ", ".join(f"{root}{base}-{w}.{ext} {w}w" for w in widths)


def sizes_for_product(p):
    if p["orientation"] == "panoramic":
        return "(min-width: 1328px) 1280px, calc(100vw - 32px)"
    if p["orientation"] == "vertical":
        return "(min-width: 960px) 44vw, calc(100vw - 32px)"
    return "(min-width: 960px) 58vw, calc(100vw - 32px)"


def print_picture(p, root, sizes, eager=False, cls="", alt=None):
    img = p["image"]
    base = f"assets/img/prints/{p['urlId']}"
    webp = _srcset(root, base, img["widths"], "webp")
    jws = [w for w in img["widths"] if w >= 480] or img["widths"]
    jpg = _srcset(root, base, jws, "jpg")
    src_w = max([w for w in jws if w <= 960] or jws[:1])
    alt_text = alt if alt is not None else p["alt"]
    loading = 'loading="eager" fetchpriority="high"' if eager else 'loading="lazy"'
    cls_attr = f' class="{cls}"' if cls else ""
    return (f'<picture><source type="image/webp" srcset="{webp}" sizes="{sizes}">'
            f'<img src="{root}{base}-{src_w}.jpg" srcset="{jpg}" sizes="{sizes}" width="{img["w"]}" height="{img["h"]}" '
            f'alt="{html.escape(alt_text, quote=True)}" {loading} decoding="async"{cls_attr} '
            f'style="background-color:{img["avg"]}"></picture>')


@pass_context
def picture(ctx, url_id_or_p, sizes, eager=False, cls="", alt=None):
    """<picture> for a print, from data/images.json."""
    p = url_id_or_p if isinstance(url_id_or_p, dict) else None
    img = p["image"] if p else None
    url_id = p["urlId"] if p else url_id_or_p
    if img is None:
        raise ValueError(f"no image for {url_id}")
    root = ctx["root"]
    base = f"assets/img/prints/{url_id}"
    webp = _srcset(root, base, img["widths"], "webp")
    jws = [w for w in img["widths"] if w >= 480] or img["widths"]
    jpg = _srcset(root, base, jws, "jpg")
    src_w = max([w for w in jws if w <= 960] or jws[:1])
    alt_text = alt if alt is not None else (p["alt"] if p else "")
    loading = 'loading="eager" fetchpriority="high"' if eager else 'loading="lazy"'
    cls_attr = f' class="{cls}"' if cls else ""
    return Markup(
        f'<picture><source type="image/webp" srcset="{webp}" sizes="{sizes}">'
        f'<img src="{root}{base}-{src_w}.jpg" srcset="{jpg}" sizes="{sizes}" width="{img["w"]}" height="{img["h"]}" '
        f'alt="{html.escape(alt_text, quote=True)}" {loading} decoding="async"{cls_attr} '
        f'style="background-color:{img["avg"]}"></picture>')


@pass_context
def pic_site(ctx, base, widths, w, h, sizes, alt, eager=False, cls="", jpg=True):
    """<picture> for a site image (hero, scenes) with known widths."""
    root = ctx["root"]
    webp = _srcset(root, base, widths, "webp")
    loading = 'loading="eager" fetchpriority="high"' if eager else 'loading="lazy"'
    cls_attr = f' class="{cls}"' if cls else ""
    src_w = max([x for x in widths if x <= 1600] or widths[:1])
    jset = _srcset(root, base, widths, "jpg") if jpg else webp
    ext = "jpg" if jpg else "webp"
    return Markup(
        f'<picture><source type="image/webp" srcset="{webp}" sizes="{sizes}">'
        f'<img src="{root}{base}-{src_w}.{ext}" srcset="{jset}" sizes="{sizes}" width="{w}" height="{h}" '
        f'alt="{html.escape(alt, quote=True)}" {loading} decoding="async"{cls_attr}></picture>')


@pass_context
def preload_img(ctx, spec):
    """Head preload for the page's largest image, spec = (base, widths, sizes)."""
    base, widths, sizes = spec
    return Markup(f'<link rel="preload" as="image" type="image/webp" '
                  f'imagesrcset="{_srcset(ctx["root"], base, widths, "webp")}" imagesizes="{sizes}">')


@pass_context
def url(ctx, path):
    root = ctx["root"]
    if path == "":
        return root or "./"
    return root + path


_asset_hash = {}


@pass_context
def asset(ctx, path):
    if path not in _asset_hash:
        f = ROOT / path
        _asset_hash[path] = hashlib.sha1(f.read_bytes()).hexdigest()[:8] if f.exists() else "0"
    return f"{ctx['root']}{path}?v={_asset_hash[path]}"


# ------------------------------------------------------------------ main

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--production", action="store_true")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args(argv)
    b = Builder(production=a.production, check=a.check)
    b.run()
    mode = "production" if a.production else "staging"
    print(f"{mode} build: {len(b.pages)} pages, {len(b.products)} prints, {len(b.changed)} files "
          f"{'would change' if a.check else 'changed'}")
    for c in b.changed[:40]:
        print("  ", c)
    if len(b.changed) > 40:
        print(f"   ... and {len(b.changed) - 40} more")
    if WARN:
        print("warnings:")
        for w in WARN:
            print("  ", w)
    return 0


if __name__ == "__main__":
    sys.exit(main())
