#!/usr/bin/env python3
"""Stripe products for the holiday gift boxes (Baker's Heart x Kawika Lopez).

  python3 tools/bh_catalog.py --mode test             the sandbox
  python3 tools/bh_catalog.py --mode test --dry-run   show what would change, change nothing
  python3 tools/bh_catalog.py --mode live             real money, only at launch

One Product and one Price per box and photograph (2 boxes x 6 photographs), found again on later
runs by metadata.bh_key and the price lookup key bh_<box>_<print>, which gas/gift-checkout.gs looks
prices up by. Names, prints and prices come from assets/js/bh-pickup.js, the same rules the page and
the checkout script use. Running it twice changes nothing; a changed price makes a new Price, moves
the lookup key to it, and archives the old one. Keys: ~/.claude/credentials/kawikalopez-stripe.env.
"""
import argparse
import json
import subprocess
from pathlib import Path

from stripe_catalog import Stripe, load_key

ROOT = Path(__file__).resolve().parent.parent


def rules():
    js = "const B=require(process.argv[1]);process.stdout.write(JSON.stringify(B.RULES))"
    out = subprocess.run(["node", "-e", js, str(ROOT / "assets/js/bh-pickup.js")],
                         capture_output=True, text=True, check=True)
    return json.loads(out.stdout)


def wanted(R):
    """Every product the gift boxes need: {lookup key: (name, description, cents)}."""
    out = {}
    for box_id, box in R["boxes"].items():
        for p in R["prints"]:
            size = "8 x 12" if p["h"] else "8 x 10"
            cookies = ("a Baker's Heart Double Box, twelve lace cookies in three flavors" if box_id == "team"
                       else "a Baker's Heart gift box of lace cookies and biscotti bites")
            out[f"bh_{box_id}_{p['id']}"] = (f"{box['name']} with {p['name']}",
                                             f"A matted {size} print of {p['name']} and {cookies}.",
                                             box["price"] * 100)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--mode", choices=["test", "live"], required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    s = Stripe(load_key(a.mode), dry=a.dry_run)
    products = {p["metadata"]["bh_key"]: p for p in s.all("products", {"active": "true"})
                if (p.get("metadata") or {}).get("bh_key")}
    prices = {pr["lookup_key"]: pr for pr in s.all("prices", {"active": "true"})
              if (pr.get("lookup_key") or "").startswith("bh_")}
    changes = 0
    for key, (name, desc, cents) in wanted(rules()).items():
        prod = products.get(key)
        if not prod:
            prod = s.post("products", {"name": name, "description": desc,
                                       "metadata": {"bh_key": key, "collection": "holiday gift boxes"}})
            print(f"  product {key}: {name}")
            changes += 1
        elif prod["name"] != name or prod.get("description") != desc:
            s.post(f"products/{prod['id']}", {"name": name, "description": desc})
            print(f"  renamed {key}: {name}")
            changes += 1
        price = prices.get(key)
        if price and price["unit_amount"] == cents and price["product"] == prod["id"]:
            continue
        s.post("prices", {"product": prod["id"], "currency": "usd", "unit_amount": cents, "lookup_key": key,
                          "transfer_lookup_key": True, "metadata": {"bh_key": key}})
        print(f"  price {key}: ${cents // 100}")
        changes += 1
        if price:
            s.post(f"prices/{price['id']}", {"active": False})
    print(f"{a.mode}: {changes} changes, {s.calls} API calls")


if __name__ == "__main__":
    main()
