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
  data/shipping.yml     tiers and the pickup-only rule
  data/payment-links.json  Stripe links per variant (tools/stripe_catalog.py), when checkout is live
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
import re
import sys
from urllib.parse import urlparse
from pathlib import Path

import yaml
from jinja2 import Environment, FileSystemLoader, StrictUndefined, pass_context, select_autoescape
from markupsafe import Markup

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


def shipping_tier(v, ship):
    long_edge = max(v["w"], v["h"])
    if long_edge > ship.get("max_ship_long_edge_in", 60):
        return "oversize"
    for t in ship.get("tiers", []):
        if long_edge <= t["max_long_edge_in"]:
            return t["id"]
    return "oversize"


def first_sentence(text):
    m = re.match(r"(.+?[.!?])(\s|$)", text.strip())
    return m.group(1) if m else text.strip()


def clip(text, n):
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= n:
        return text
    cut = text[: n - 1].rsplit(" ", 1)[0].rstrip(",;:")
    return cut + "…"


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
            by_id[key] = {"urlId": key, "title": ov.get("title", key), "description": "",
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
                p["location"] = dict(locations[loc_key], slug=loc_key)
        # variants: shipping tier, link
        vs = []
        for v in p["variants"]:
            v = dict(v)
            v["tier"] = shipping_tier(v, ship)
            v["ships"] = v["tier"] != "oversize"
            link = (links or {}).get(v["id"])
            v["link"] = link["url"] if link else None
            vs.append(v)
        p["variants"] = vs
        p["orientation_label"] = ORIENT_LABEL[p["orientation"]]
        p["collection_labels"] = [COLLECTION_LABEL.get(c, c.title()) for c in p.get("collections", [])]
        p["title_tag"] = p.get("seo_title") or seo_title(p)
        p["meta_description"] = p.get("seo_description") or seo_description(p)
        p["paragraphs"] = [x.strip() for x in re.split(r"\n\s*\n", p["description"]) if x.strip()]
        out.append(p)
    out.sort(key=lambda p: (p["sort"], p["title"].lower()))
    return out


# ------------------------------------------------------------------ room preview math

def default_size(p, scene):
    """Largest shippable size that fits the scene's wall; the smallest size if none fits."""
    wall, ppi = scene["wall"], scene["ppi"]
    fits = [s for s in p["sizes"]
            if s["w"] * ppi <= wall["w"] * 0.96 and s["h"] * ppi <= wall["h"] * 0.96
            and max(s["w"], s["h"]) <= 60]
    return (fits or p["sizes"][:1])[-1]


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


def product_ld(p, base):
    url = base + p["path"]
    img = p["image"]
    big = max(w for w in img["widths"] if w >= 480) if any(w >= 480 for w in img["widths"]) else img["widths"][-1]
    image_url = f"{base}assets/img/prints/{p['urlId']}-{big}.jpg"
    offers = [{"@type": "Offer", "sku": v["id"], "name": f"{v['size']} in {v['material']}",
               "price": f"{v['price']:.2f}", "priceCurrency": "USD",
               "availability": "https://schema.org/InStock" if v["ships"] else "https://schema.org/InStoreOnly",
               "itemCondition": "https://schema.org/NewCondition", "url": url,
               "seller": {"@id": base + "#org"}} for v in p["variants"]]
    prod = {"@type": "Product", "@id": url + "#product", "name": f"{p['title']}" + (f": {p['subtitle']}" if p.get("subtitle") else ""),
            "description": p["meta_description"], "sku": p["urlId"], "image": [image_url, f"{base}assets/img/og/{p['urlId']}.jpg"],
            "brand": {"@type": "Brand", "name": "Kawika Lopez"}, "category": "Art > Photographs",
            "material": "Canvas, Metal",
            "offers": {"@type": "AggregateOffer", "priceCurrency": "USD", "lowPrice": f"{p['priceFrom']:.2f}",
                       "highPrice": f"{p['priceTo']:.2f}", "offerCount": len(offers), "offers": offers}}
    photo = {"@type": "ImageObject", "contentUrl": image_url, "name": p["title"], "caption": p["alt"],
             "creator": {"@id": base + "#kawika"}, "creditText": "Kawika Lopez",
             "copyrightNotice": "© Kawika Lopez", "copyrightHolder": {"@id": base + "#kawika"}}
    if p.get("location"):
        photo["contentLocation"] = {"@type": "Place", "name": p["location"]["title"]}
    return [prod, photo]


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
        self.links = (load_json("payment-links.json", {}) or {}).get("links") if self.site["features"].get("checkout") else None
        self.products = load_products(self.site, self.links)
        self.by_id = {p["urlId"]: p for p in self.products}
        self.scenes = load_json("scenes.json", [])
        self.scene = self.scenes[0] if self.scenes else None
        self.shipping = load_yaml("shipping.yml", {})
        self.locations = load_yaml("locations.yml", {})
        self.lastmod = load_json("lastmod.json", {}) or {}
        self.pages = []            # every page rendered: {path, file, type, title, indexable}
        self.changed = []
        self.env = Environment(loader=FileSystemLoader(str(ROOT / "templates")),
                               autoescape=select_autoescape(["html", "xml"]),
                               trim_blocks=True, lstrip_blocks=True, undefined=StrictUndefined)
        self.env.globals.update(picture=picture, pic_site=pic_site, url=url, asset=asset, preload_img=preload_img,
                                money=lambda n: f"${n:,}", site=self.site, production=production)
        self.env.filters["json"] = lambda o: Markup(html.escape(json.dumps(o, ensure_ascii=False, separators=(",", ":")), quote=True))
        # Pages that exist in this build. Nav and links only point at these.
        self.available = ({"", "store/", "prints", "about", "contact", "privacy", "thank-you"}
                          | {c["path"] for c in COLLECTIONS})

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
             indexable=True, **ctx):
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
        self.pages.append({"path": path, "file": rel, "type": page_type, "title": title,
                           "indexable": indexable and not is404})

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
            default = room["size"] if room else p["sizes"][0]
            default_variant = next((v for v in p["variants"] if v["size"] == default["label"] and v["material"] == "metal"),
                                   p["variants"][0])
            orient_page = f"{p['orientation']}-prints"
            crumbs = [("Prints", "store/")]
            if orient_page in self.available:
                crumbs.append((p["orientation_label"], orient_page))
            crumbs.append((p["title"], p["path"]))
            picker = {"variants": [{"id": v["id"], "size": v["size"], "w": v["w"], "h": v["h"], "material": v["material"],
                                    "price": v["price"], "link": v["link"], "ships": v["ships"]} for v in p["variants"]],
                      "title": p["title"], "email": self.site["contact"]["email"]}
            table = []
            for s in p["sizes"]:
                row = {"size": s, "canvas": None, "metal": None}
                for v in p["variants"]:
                    if v["size"] == s["label"]:
                        row[v["material"]] = v
                table.append(row)
            self.emit("product.html", f"store/{p['urlId']}.html", p["path"], "product",
                      p["title_tag"], p["meta_description"], crumbs=crumbs, graph=product_ld(p, self.base),
                      indexable=not p.get("draft"), p=p, room=room, picker=picker, table=table,
                      default_variant=default_variant, related=self.related(p),
                      og_image=f"{self.base}assets/img/og/{p['urlId']}.jpg",
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
                  featured=featured, total=len([p for p in self.products if not p.get("draft")]), tiles=tiles, teaser=teaser, hero_print=self.by_id.get("naniwaikiki"),
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
                          "ships": max(r["w"], r["h"]) <= ship.get("max_ship_long_edge_in", 60)} for r in rows],
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
                  og_image=self.base + f"assets/img/site/portrait-{portrait['widths'][-1]}.jpg")

    def contact_page(self):
        desc = "Questions about a Kawika Lopez print, sizing for your wall, or shipping a large piece? Send a message."
        page = {"@type": "ContactPage", "@id": self.base + "contact", "url": self.base + "contact",
                "name": "Contact Kawika Lopez", "isPartOf": {"@id": self.base + "#site"}}
        self.emit("contact.html", "contact.html", "contact", "page", "Contact | Kawika Lopez Photography", desc,
                  crumbs=[("Contact", "contact")], graph=[page],
                  prints=[p for p in self.products if not p.get("draft")])

    def privacy_page(self):
        desc = "What kawikalopez.com collects, why, and what happens to it: messages, orders and analytics."
        self.emit("privacy.html", "privacy.html", "privacy", "page", "Privacy | Kawika Lopez Photography", desc,
                  crumbs=[("Privacy", "privacy")], updated="September 25, 2026")

    def thankyou_page(self):
        self.emit("thank-you.html", "thank-you.html", "thank-you", "page", "Thank you | Kawika Lopez Photography",
                  "Your order is in. What happens next.", indexable=False)

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
        lines = ['<?xml version="1.0" encoding="UTF-8"?>',
                 '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">']
        for pg in sorted(urls, key=lambda x: (x["path"] != "", x["path"])):
            lm = self.lastmod.get(pg["path"] or "/", {}).get("date", TODAY)
            lines.append(f"  <url><loc>{html.escape(prod_base + pg['path'])}</loc><lastmod>{lm}</lastmod></url>")
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
        self.thankyou_page()
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


# ------------------------------------------------------------------ template helpers

def _srcset(root, base, widths, ext):
    return ", ".join(f"{root}{base}-{w}.{ext} {w}w" for w in widths)


def sizes_for_product(p):
    if p["orientation"] == "panoramic":
        return "(min-width: 1328px) 1280px, calc(100vw - 32px)"
    if p["orientation"] == "vertical":
        return "(min-width: 960px) 44vw, calc(100vw - 32px)"
    return "(min-width: 960px) 58vw, calc(100vw - 32px)"


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
