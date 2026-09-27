#!/usr/bin/env python3
"""Build the Stripe catalog for kawikalopez.com and write the payment link for every variant.

  python3 tools/stripe_catalog.py --mode test            sandbox; links point at the staging site
  python3 tools/stripe_catalog.py --mode test --dry-run  show what would change, change nothing
  python3 tools/stripe_catalog.py --mode live            real money; refuses while shipping rates
                                                          are unconfirmed (data/shipping.yml)

Keys come from ~/.claude/credentials/kawikalopez-stripe.env (STRIPE_TEST_KEY, STRIPE_LIVE_KEY),
never from the repo. Talks to the Stripe REST API directly, pinned to one API version, so no
Stripe package is needed.

What it makes, found again on later runs by metadata, so running it twice changes nothing:
  - one Product per print (metadata.urlId), image = the print's share image on the site
  - one Price per variant, lookup_key <urlId>_<w>x<h>_<material>; a changed price makes a new
    Price and archives the old one
  - shipping rates from data/shipping.yml: free Oʻahu pickup, plus one rate per material, size
    and zone (metadata.key = <material>_<w>x<h>_<zone>); a changed amount archives the old rate and
    makes a new one, and rates no longer in the file are archived
  - coupon and promotion code NEW20OFF (20% off, first purchase only), from data/site.yml
  - one Payment Link per variant: quantity fixed at 1 (shipping is a flat rate per order), US shipping address, pickup plus the zone
    rates for its size and material (pickup only over 60 x 30 inches), promotion codes on, phone number, a note
    field, and a redirect to /thank-you. Recreated when its price or shipping options change.

Writes
  data/payment-links-<mode>.json   {mode, generated, links: {variant id: {url, price_id, amount, ships}}}
                                   staging builds read the test file, production builds the live one
  data/stripe-ids.json      the Stripe ids per mode, so later runs can find and compare things

The site never names the print lab. Checkout text says the prints are made on Oʻahu.
"""

import argparse
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import build  # noqa: E402  (reuses the catalog loader, so Stripe sees exactly what the site shows)

API = "https://api.stripe.com/v1/"
# Buyers tick this before paying (Hawaiʻi HRS 481B-5.5: a made-to-order sale can be final only with
# the buyer's acknowledgment). Needs a Terms of service URL in each Stripe account's Public details.
TERMS_ACK = ("I understand every print is made to order, so all sales are final except damage or defects. "
             "See the [terms of sale](https://kawikalopez.com/terms).")
VERSION = "2024-06-20"
CREDS = Path.home() / ".claude" / "credentials" / "kawikalopez-stripe.env"
IDS = ROOT / "data" / "stripe-ids.json"


class Stripe:
    def __init__(self, key, dry=False):
        self.key, self.dry, self.calls = key, dry, 0

    def req(self, method, path, params=None):
        data = None
        url = API + path
        if params and method == "GET":
            url += "?" + urllib.parse.urlencode(flatten(params), doseq=True)
        elif params:
            data = urllib.parse.urlencode(flatten(params)).encode()
        r = urllib.request.Request(url, data=data, method=method)
        r.add_header("Authorization", "Bearer " + self.key)
        r.add_header("Stripe-Version", VERSION)
        for attempt in range(5):
            try:
                self.calls += 1
                with urllib.request.urlopen(r, timeout=60) as resp:
                    return json.loads(resp.read())
            except urllib.error.HTTPError as e:
                body = e.read().decode()
                if e.code == 429 and attempt < 4:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                raise SystemExit(f"Stripe {method} {path} failed ({e.code}): {body[:600]}")

    def get(self, path, params=None):
        return self.req("GET", path, params)

    def post(self, path, params):
        if self.dry:
            print(f"  would POST {path}")
            return {"id": "dry_" + path.replace("/", "_"), "url": "https://example.invalid/dry"}
        return self.req("POST", path, params)

    def all(self, path, params=None):
        out, params = [], dict(params or {}, limit=100)
        while True:
            page = self.get(path, params)
            out += page["data"]
            if not page.get("has_more"):
                return out
            params["starting_after"] = page["data"][-1]["id"]


def flatten(obj, prefix=""):
    """Stripe's form encoding: a[b][0][c]=v."""
    items = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            items += flatten(v, f"{prefix}[{k}]" if prefix else k)
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            items += flatten(v, f"{prefix}[{i}]")
    elif isinstance(obj, bool):
        items.append((prefix, "true" if obj else "false"))
    elif obj is not None:
        items.append((prefix, str(obj)))
    return items


def load_key(mode):
    env = {}
    if CREDS.exists():
        for line in CREDS.read_text().splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    key = env.get("STRIPE_TEST_KEY" if mode == "test" else "STRIPE_LIVE_KEY")
    if not key:
        raise SystemExit(f"no {mode} key in {CREDS}")
    want = ("sk_test_", "rk_test_") if mode == "test" else ("sk_live_", "rk_live_")
    if not key.startswith(want):
        raise SystemExit(f"the {mode} key in {CREDS} does not start with {' or '.join(want)}")
    return key


def days(rng):
    lo, hi = rng
    return {"minimum": {"unit": "business_day", "value": lo}, "maximum": {"unit": "business_day", "value": hi}}


def rate_key(material, size, zone):
    return f"{material}_{size}_{zone}"


def ensure_shipping_rates(s, ship):
    """Pickup plus material x size x zone. Rates can't change amount once made, so a new amount
    means archive and recreate."""
    existing = {r["metadata"].get("key"): r for r in s.all("shipping_rates", {"active": "true"}) if r["metadata"].get("key")}
    wanted = {"pickup": (ship["pickup"]["label"], ship["pickup"]["amount"], ship["pickup"]["days"])}
    zones = {z["id"]: z for z in ship["zones"]}
    for material, sizes in ship["rates"].items():
        for size, by_zone in sizes.items():
            for z, amount in by_zone.items():
                wanted[rate_key(material, size, z)] = (f"Ship to {zones[z]['label']}", amount, zones[z]["days"])
    ids = {}
    for key, (label, amount, rng) in wanted.items():
        cur = existing.get(key)
        if cur and cur["fixed_amount"]["amount"] == amount and cur["display_name"] == label:
            ids[key] = cur["id"]
            continue
        if cur:
            s.post(f"shipping_rates/{cur['id']}", {"active": False})
        made = s.post("shipping_rates", {"display_name": label, "type": "fixed_amount",
                                          "fixed_amount": {"amount": amount, "currency": ship["currency"]},
                                          "delivery_estimate": days(rng), "metadata": {"key": key}})
        ids[key] = made["id"]
        print(f"  shipping rate {key}: {label} ${amount / 100:,.2f}")
    for key, cur in existing.items():
        if key not in wanted:
            s.post(f"shipping_rates/{cur['id']}", {"active": False})
            print(f"  archived shipping rate {key}")
    return ids


def ensure_promo(s, promo):
    code = promo["code"]
    try:
        coupon = s.get(f"coupons/{code}")
    except SystemExit:
        coupon = None
    if not coupon or coupon.get("deleted"):
        coupon = s.post("coupons", {"id": code, "percent_off": 20, "duration": "once", "name": promo["text"]})
        print(f"  coupon {code}")
    codes = s.all("promotion_codes", {"code": code})
    active = [c for c in codes if c["active"]]
    if active:
        return active[0]["id"]
    made = s.post("promotion_codes", {"coupon": coupon["id"], "code": code,
                                      "restrictions": {"first_time_transaction": True}})
    print(f"  promotion code {code}")
    return made["id"]


def shipping_options_for(v, ship, rates):
    if not v["ships"]:
        return [{"shipping_rate": rates["pickup"]}]
    size = next(f"{a}x{b}" for a, b in ((v["w"], v["h"]), (v["h"], v["w"]))
                if f"{a}x{b}" in ship["rates"][v["material"]])
    return [{"shipping_rate": rates["pickup"]}] + [{"shipping_rate": rates[rate_key(v["material"], size, z["id"])]}
                                                   for z in ship["zones"]]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["test", "live"], required=True)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only")
    a = ap.parse_args(argv)

    ship = yaml.safe_load((ROOT / "data" / "shipping.yml").read_text())
    if a.mode == "live" and not ship.get("rates_confirmed"):
        raise SystemExit("shipping rates are placeholders (rates_confirmed: false in data/shipping.yml); not going live")
    site = yaml.safe_load((ROOT / "data" / "site.yml").read_text())
    base = site["base_url"]["production" if a.mode == "live" else "staging"]
    s = Stripe(load_key(a.mode), dry=a.dry_run)
    products = build.load_products(site, None)
    if a.only:
        products = [p for p in products if p["urlId"] == a.only]

    ids_all = json.loads(IDS.read_text()) if IDS.exists() else {}
    ids = ids_all.setdefault(a.mode, {"products": {}, "prices": {}, "links": {}})
    links_file = ROOT / "data" / f"payment-links-{a.mode}.json"

    print(f"{a.mode} catalog: {len(products)} prints, {sum(len(p['variants']) for p in products)} variants")
    rates = ensure_shipping_rates(s, ship)
    ensure_promo(s, site["promo"])

    by_urlid = {p["metadata"].get("urlId"): p for p in s.all("products") if p["metadata"].get("urlId")}
    prices = {pr["lookup_key"]: pr for pr in s.all("prices", {"active": "true"}) if pr.get("lookup_key")}
    links_out = json.loads(links_file.read_text()).get("links", {}) if links_file.exists() else {}
    made = {"products": 0, "prices": 0, "links": 0}

    for p in products:
        name = p["title"] + (f": {p['subtitle']}" if p.get("subtitle") else "")
        image = f"{base}assets/img/og/{p['urlId']}.jpg"
        prod = by_urlid.get(p["urlId"])
        if not prod:
            prod = s.post("products", {"name": name, "description": p["meta_description"][:350], "images": [image],
                                       "metadata": {"urlId": p["urlId"]}, "url": base + p["path"]})
            made["products"] += 1
        elif prod["name"] != name or prod.get("images") != [image] or not prod["active"]:
            s.post(f"products/{prod['id']}", {"name": name, "images": [image], "active": True, "url": base + p["path"]})
        ids["products"][p["urlId"]] = prod["id"]

        for v in p["variants"]:
            amount = v["price"] * 100
            pr = prices.get(v["id"])
            if not pr or pr["unit_amount"] != amount or pr["product"] != prod["id"]:
                new = s.post("prices", {"product": prod["id"], "currency": "usd", "unit_amount": amount,
                                        "lookup_key": v["id"], "transfer_lookup_key": True,
                                        "nickname": f"{v['size']} {v['material']}",
                                        "metadata": {"urlId": p["urlId"], "size": v["size"], "material": v["material"]}})
                if pr:
                    s.post(f"prices/{pr['id']}", {"active": False})
                pr = new
                made["prices"] += 1
            ids["prices"][v["id"]] = pr["id"]

            options = shipping_options_for(v, ship, rates)
            sig = pr["id"] + "|" + ",".join(o["shipping_rate"] for o in options) + "|" + base + "|qty1|tos1"
            known = ids["links"].get(v["id"])
            if known and known.get("sig") == sig and links_out.get(v["id"]):
                continue
            if known and known.get("id") and not a.dry_run:
                s.post(f"payment_links/{known['id']}", {"active": False})
            pickup_note = ("Pickup only on Oʻahu for this size. We'll email you to set a time."
                           if not v["ships"] else
                           "Choose free pickup on Oʻahu, or shipping to Hawaiʻi or the US mainland.")
            link = s.post("payment_links", {
                "line_items": [{"price": pr["id"], "quantity": 1}],
                "shipping_address_collection": {"allowed_countries": ship["allowed_countries"]},
                "shipping_options": options,
                "allow_promotion_codes": True,
                "phone_number_collection": {"enabled": True},
                "customer_creation": "always",
                "custom_text": {"shipping_address": {"message": pickup_note},
                                "submit": {"message": "Printed to order on Oʻahu, usually in about a week."},
                                "terms_of_service_acceptance": {"message": TERMS_ACK}},
                "consent_collection": {"terms_of_service": "required"},
                "custom_fields": [{"key": "note", "label": {"type": "custom", "custom": "Anything we should know?"},
                                   "type": "text", "optional": True}],
                "after_completion": {"type": "redirect",
                                     "redirect": {"url": base + "thank-you?session_id={CHECKOUT_SESSION_ID}"}},
                "metadata": {"urlId": p["urlId"], "size": v["size"], "material": v["material"], "variant": v["id"]},
            })
            ids["links"][v["id"]] = {"id": link["id"], "sig": sig}
            links_out[v["id"]] = {"url": link["url"], "price_id": pr["id"], "amount": amount, "ships": v["ships"]}
            made["links"] += 1

    if not a.dry_run:
        IDS.write_text(json.dumps(ids_all, indent=1, sort_keys=True) + "\n")
        links_file.write_text(json.dumps({"mode": a.mode, "generated": dt.date.today().isoformat(), "links": links_out},
                                    indent=1, sort_keys=True) + "\n")
    print(f"made {made['products']} products, {made['prices']} prices, {made['links']} links "
          f"({s.calls} API calls); {len(links_out)} links on file")
    return 0


if __name__ == "__main__":
    sys.exit(main())
