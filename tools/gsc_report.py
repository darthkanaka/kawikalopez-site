#!/usr/bin/env python3
# /// script
# dependencies = ["google-auth==2.48.0", "google-auth-oauthlib==1.2.4", "requests==2.32.5",
#                 "jinja2==3.1.6", "markdown==3.9", "pyyaml==6.0.2"]
# ///
"""Search Console, GA4 and Stripe numbers for kawikalopez.com, written as a report in the vault.

  python3 tools/gsc_report.py --baseline                   the starting numbers (reports/baseline.md)
  python3 tools/gsc_report.py --month 2026-10 --ga4 --stripe
                                                            one month; default is the last full month
  python3 tools/gsc_report.py --check 30 --ga4 --stripe    day 30, 60 or 90 after cutover (check-30.md)
  python3 tools/gsc_report.py --auth                       sign in to Google again (opens a browser)

Google: the account that owns the Search Console and GA4 properties, through its OAuth client
(gcal-personal-oauth.json), with read-only Analytics and Search Console scopes; token at
~/.claude/credentials/gsc-kawikalopez-token.json. The first run copies the token the rental tax report
uses (same account, same scopes), so no consent is needed.
Stripe: STRIPE_LIVE_READ_KEY in ~/.claude/credentials/kawikalopez-stripe.env, a restricted key that can
read Checkout Sessions. Without it the report says so and carries on.

Writes, in the vault and never the repo (the site serves every file in the repo):
  ~/Documents/Obsidian/kawikalopez/reports/YYYY-MM.md, baseline.md, check-N.md
  ~/Documents/Obsidian/kawikalopez/reports/data/<same name>.json   raw numbers, for later comparisons
  ~/Documents/Obsidian/kawikalopez/reports/data/inspections.json   URL inspection cache

The line under the heading always starts with **Headline:**, so /today can surface it.
No buyer names, emails, addresses or gift notes are read into a report.
"""

import argparse
import calendar
import datetime as dt
import json
import re
import shutil
import sys
import warnings
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

warnings.filterwarnings("ignore")  # google-auth nags about Python 3.9 on every import

import requests  # noqa: E402
from google.auth.exceptions import RefreshError  # noqa: E402
from google.auth.transport.requests import AuthorizedSession, Request  # noqa: E402
from google.oauth2.credentials import Credentials  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
from build import fold, load_json, load_yaml  # noqa: E402
from stripe_catalog import Stripe, load_key  # noqa: E402

CUTOVER = dt.date(2026, 9, 27)
DATA_START = dt.date(2026, 9, 25)  # Search Console holds nothing earlier; per-28-day rates count from here
SITE = "sc-domain:kawikalopez.com"
GSC = f"https://www.googleapis.com/webmasters/v3/sites/{SITE}"
HST = ZoneInfo("Pacific/Honolulu")
OUT = Path.home() / "Documents" / "Obsidian" / "kawikalopez" / "reports"
RAW = OUT / "data"
CRED = Path.home() / ".claude" / "credentials"
CLIENT = CRED / "gcal-personal-oauth.json"
TOKEN = CRED / "gsc-kawikalopez-token.json"
SEED = CRED / "ga4-hrt-token.json"
SCOPES = ["https://www.googleapis.com/auth/analytics.readonly",
          "https://www.googleapis.com/auth/webmasters.readonly"]
TODAY = dt.date.today()

# Publish-by dates from the SEO plan's seasonal calendar. A row is due when its date is within 10 weeks.
SEASONS = [
    ("2026-10-15", "Christmas 2026: the gifts hub and three gift pages live"),
    ("2026-10-20", "Christmas 2026: the Christmas gifts post live"),
    ("2027-01-05", "Valentine's Day 2027: a section on the gifts hub"),
    ("2027-03-15", "Mother's Day 2027 (May 9): its page or a hub section"),
    ("2027-04-01", "Graduation 2027: a hub section, tied to the moved-away page"),
    ("2027-04-20", "Father's Day 2027 (June 20): refresh gifts/for-dad"),
    ("2027-09-01", "Christmas 2027: refresh the Pinterest gift boards"),
    ("2027-09-15", "Christmas 2027: refresh the gifts hub and pages"),
]


class NeedAuth(Exception):
    pass


# ------------------------------------------------------------------ Google

def google(force=False):
    if not TOKEN.exists() and SEED.exists():
        shutil.copy(SEED, TOKEN)
        TOKEN.chmod(0o600)
    c = None if force or not TOKEN.exists() else Credentials.from_authorized_user_file(str(TOKEN), SCOPES)
    if c and not c.valid and c.refresh_token:
        try:
            c.refresh(Request())
        except RefreshError:
            c = None
    if not c or not c.valid:
        if not sys.stdin.isatty():
            raise NeedAuth("the Google sign-in has expired")
        from google_auth_oauthlib.flow import InstalledAppFlow
        c = InstalledAppFlow.from_client_secrets_file(str(CLIENT), SCOPES).run_local_server(port=0, prompt="consent")
    TOKEN.write_text(c.to_json())
    TOKEN.chmod(0o600)
    s = AuthorizedSession(c)
    sites = call(s, "GET", "https://www.googleapis.com/webmasters/v3/sites")
    if SITE not in {e["siteUrl"] for e in sites.get("siteEntry", [])}:
        raise NeedAuth(f"{SITE} is not visible to this Google sign-in")
    return s


def call(s, method, url, **kw):
    r = s.request(method, url, timeout=90, **kw)
    if r.status_code != 200:
        raise RuntimeError(f"{r.status_code} from {url}: {r.text[:300]}")
    return r.json()


def path_of(url):
    """https://kawikalopez.com/store/kaimana -> store/kaimana; the home page is ''."""
    return urlparse(url).path.lstrip("/") if "://" in url else url.lstrip("/")


# ------------------------------------------------------------------ Search Console

def sc_query(s, start, end, dims, kind="web"):
    rows, first = [], 0
    while True:
        body = {"startDate": str(start), "endDate": str(end), "dimensions": dims, "type": kind,
                "dataState": "all", "rowLimit": 25000, "startRow": first}
        got = call(s, "POST", GSC + "/searchAnalytics/query", json=body).get("rows", [])
        rows += got
        if len(got) < 25000:
            return rows
        first += 25000


def totals(rows):
    imp = sum(r["impressions"] for r in rows)
    clicks = sum(r["clicks"] for r in rows)
    pos = sum(r["position"] * r["impressions"] for r in rows) / imp if imp else None
    return {"impressions": imp, "clicks": clicks, "ctr": clicks / imp if imp else 0, "position": pos}


def search_console(s, start, end):
    by_date = sc_query(s, start, end, ["date"])
    pairs = sc_query(s, start, end, ["query", "page"])
    return {
        "start": str(start), "end": str(end),
        "totals": totals(by_date),
        "first_day": by_date[0]["keys"][0] if by_date else None,
        "by_date": [[r["keys"][0], r["clicks"], r["impressions"]] for r in by_date],
        "pairs": [{"query": r["keys"][0], "page": path_of(r["keys"][1]), "clicks": r["clicks"],
                   "impressions": r["impressions"], "position": r["position"]} for r in pairs],
        "pages": [dict(totals([r]), page=path_of(r["keys"][0])) for r in sc_query(s, start, end, ["page"])],
        "image": totals(sc_query(s, start, end, ["date"], "image")),
        "countries": [[r["keys"][0], r["clicks"], r["impressions"]] for r in sc_query(s, start, end, ["country"])][:8],
        "devices": [[r["keys"][0], r["clicks"], r["impressions"]] for r in sc_query(s, start, end, ["device"])],
    }


def by_query(sc):
    """Query rows summed across pages."""
    agg = {}
    for r in sc["pairs"]:
        a = agg.setdefault(r["query"], {"query": r["query"], "clicks": 0, "impressions": 0, "wpos": 0, "pages": set()})
        a["clicks"] += r["clicks"]
        a["impressions"] += r["impressions"]
        a["wpos"] += r["position"] * r["impressions"]
        a["pages"].add(r["page"])
    for a in agg.values():
        a["position"] = a["wpos"] / a["impressions"] if a["impressions"] else None
    return sorted(agg.values(), key=lambda a: -a["impressions"])


def sitemaps(s):
    out = []
    for m in call(s, "GET", GSC + "/sitemaps").get("sitemap", []):
        web = next((c for c in m.get("contents", []) if c.get("type") == "web"), {})
        out.append({"path": m["path"], "downloaded": (m.get("lastDownloaded") or "")[:10],
                    "submitted": int(web.get("submitted", 0)), "errors": int(m.get("errors", 0)),
                    "warnings": int(m.get("warnings", 0))})
    return out


def sitemap_urls():
    return re.findall(r"<loc>([^<]+)</loc>", (ROOT / "sitemap.xml").read_text())


def inspect(s, urls, mode):
    """URL Inspection for every sitemap URL. Cached; a URL is asked again when it is not yet indexed
    or its answer is over 6 days old, so a run costs at most one call per URL (quota is 2,000 a day)."""
    f = RAW / "inspections.json"
    cache = json.loads(f.read_text()) if f.exists() else {}

    def stale(u):
        e = cache.get(u)
        return not e or e.get("verdict") != "PASS" or (TODAY - dt.date.fromisoformat(e["checked"])).days > 6

    def one(u):
        r = call(s, "POST", "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
                 json={"inspectionUrl": u, "siteUrl": SITE})
        ir = r.get("inspectionResult", {}).get("indexStatusResult", {})
        return u, {"checked": str(TODAY), "verdict": ir.get("verdict"), "coverage": ir.get("coverageState"),
                   "last_crawl": (ir.get("lastCrawlTime") or "")[:10], "google_canonical": ir.get("googleCanonical")}

    todo = [u for u in urls if mode == "all" or (mode == "auto" and stale(u))]
    if todo:
        # About 7 seconds a call, so six at a time (the limit is 600 a minute).
        print(f"inspecting {len(todo)} URLs", file=sys.stderr)
        with ThreadPoolExecutor(6) as pool:
            cache.update(pool.map(one, todo))
    RAW.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps(cache, indent=1, sort_keys=True) + "\n")
    return {u: cache.get(u) or {} for u in urls}


# ------------------------------------------------------------------ GA4

def ga4(s, start, end):
    mid = load_yaml("site.yml", {}).get("ga4")
    prop = None
    for a in call(s, "GET", "https://analyticsadmin.googleapis.com/v1beta/accountSummaries").get("accountSummaries", []):
        for p in a.get("propertySummaries", []):
            streams = call(s, "GET", f"https://analyticsadmin.googleapis.com/v1beta/{p['property']}/dataStreams")
            if any(st.get("webStreamData", {}).get("measurementId") == mid for st in streams.get("dataStreams", [])):
                prop = p["property"]
    if not prop:
        raise RuntimeError(f"no GA4 property has the stream {mid}")

    def run(dims, mets, limit=1000):
        body = {"dateRanges": [{"startDate": str(start), "endDate": str(end)}],
                "dimensions": [{"name": d} for d in dims], "metrics": [{"name": m} for m in mets], "limit": limit}
        rows = call(s, "POST", f"https://analyticsdata.googleapis.com/v1beta/{prop}:runReport", json=body).get("rows", [])
        out = []
        for row in rows:
            d = {k: v["value"] for k, v in zip(dims, row.get("dimensionValues", []))}
            d.update({k: float(v["value"]) for k, v in zip(mets, row["metricValues"])})
            out.append(d)
        return out

    shop = ["addToCarts", "checkouts", "ecommercePurchases", "purchaseRevenue"]
    tot = run([], ["sessions", "totalUsers", "engagedSessions"] + shop)
    return {
        "property": prop,
        "totals": tot[0] if tot else {},
        "landing": [dict(r, page=path_of(r.pop("landingPage"))) for r in
                    run(["landingPage", "sessionDefaultChannelGroup"], ["sessions", "engagedSessions"] + shop)],
        "events": run(["eventName"], ["eventCount"], 30),
        "sources": run(["sessionSource", "sessionMedium"], ["sessions"], 20),
        "transactions": [r for r in run(["transactionId"], ["ecommercePurchases", "purchaseRevenue"])
                         if r["transactionId"] not in ("", "(not set)")],
    }


# ------------------------------------------------------------------ Stripe

def stripe_sales(start, end):
    try:
        key = load_key("live", "STRIPE_LIVE_READ_KEY")
    except SystemExit:
        return {"error": "not connected yet (STRIPE_LIVE_READ_KEY is empty)"}
    if not key.startswith("rk_live_"):
        return {"error": "STRIPE_LIVE_READ_KEY must be a restricted read key (rk_live_)"}
    lo = int(dt.datetime.combine(start, dt.time(0), HST).timestamp())
    hi = int(dt.datetime.combine(end + dt.timedelta(days=1), dt.time(0), HST).timestamp())
    try:
        found = Stripe(key).all("checkout/sessions", {"status": "complete", "created": {"gte": lo, "lt": hi},
                                                       "expand": ["data.line_items"]})
    except SystemExit as e:
        return {"error": str(e)[:300]}
    sales = []
    for cs in found:
        if cs.get("payment_status") != "paid" or not cs.get("livemode"):
            continue
        meta = cs.get("metadata") or {}
        prints = []
        for li in (cs.get("line_items") or {}).get("data", []):
            pm = (li.get("price") or {}).get("metadata") or {}
            prints.append({"urlId": pm.get("urlId") or meta.get("urlId"), "size": pm.get("size") or meta.get("size"),
                           "material": pm.get("material") or meta.get("material"),
                           "qty": li.get("quantity", 1), "amount": li.get("amount_total", 0) / 100})
        sales.append({"id": cs["id"], "date": dt.datetime.fromtimestamp(cs["created"], HST).date().isoformat(),
                      "channel": "payment link" if cs.get("payment_link") else "cart",
                      "total": (cs.get("amount_total") or 0) / 100, "subtotal": (cs.get("amount_subtotal") or 0) / 100,
                      "prints": prints})
    return {"sales": sales, "count": len(sales), "gross": sum(x["total"] for x in sales),
            "prints_subtotal": sum(x["subtotal"] for x in sales)}


# ------------------------------------------------------------------ analysis

def targets():
    return load_yaml("targets.yml", []) or []


def matches(t, query):
    q = fold(query)
    return any(fold(p) in q for p in (t.get("queries") or []) + [t["phrase"]])


def target_rows(sc, prev):
    pages = {p["page"]: p for p in sc["pages"]}
    before = {r["phrase"]: r for r in (prev or {}).get("targets", [])}
    out = []
    for t in targets():
        if t.get("planned"):
            continue
        hit = [r for r in sc["pairs"] if matches(t, r["query"])]
        q = totals(hit)
        pg = pages.get(t["page"], {})
        was = before.get(t["phrase"], {})
        change = ""
        if q["position"] and was.get("query_position"):
            change = f"{was['query_position'] - q['position']:+.1f} places"
        out.append({"phrase": t["phrase"], "page": t["page"], "cluster": t.get("cluster"),
                    "page_impressions": pg.get("impressions", 0), "page_clicks": pg.get("clicks", 0),
                    "page_position": pg.get("position"), "query_impressions": q["impressions"],
                    "query_clicks": q["clicks"], "query_position": q["position"], "change": change})
    return out


def unmatched(queries):
    ts = [t for t in targets()]
    return [q for q in queries if not any(matches(t, q["query"]) for t in ts)]


def next_two(sc, queries):
    lines, note = [], ""
    r1 = sorted((q for q in unmatched(queries) if q["impressions"] >= 50 and 8 <= q["position"] <= 25),
                key=lambda q: -q["impressions"] / q["position"])
    lines += [f"Write a page for \"{q['query']}\" ({q['impressions']} impressions at position {q['position']:.1f}, "
              "no page targets it). Rule 1." for q in r1]
    r2 = [p for p in sc["pages"] if p["impressions"] >= 100 and p["ctr"] < 0.015 and p["position"] <= 10]
    lines += [f"Rewrite the title and description of /{p['page']} ({p['impressions']} impressions, "
              f"CTR {p['ctr']:.1%} at position {p['position']:.1f}). Rule 2." for p in r2]
    if not r1 and not r2:
        note = "No query or page qualified from the data this month (rules 1 and 2 found nothing)."
    lines += [f"{what} (publish by {d}). Rule 3." for d, what in seasons_due()]
    planned = sorted((t for t in targets() if t.get("planned")), key=lambda t: t.get("priority", 9))
    lines += [f"Next planned target: \"{t['phrase']}\" at /{t['page']}. Rule 4." for t in planned]
    if not planned:
        lines.append("targets.yml has no planned entries yet (the keyword research pass adds them). Rule 4.")
    return note, lines[:2]


def seasons_due():
    return [(d, what) for d, what in SEASONS if 0 <= (dt.date.fromisoformat(d) - TODAY).days <= 70]


def page_types():
    return {p["path"]: p["type"] for p in load_json("pages.json", []) or []}


def type_of(path, types):
    if path.startswith("gifts"):
        return "gift"
    return types.get(path) or types.get(path.rstrip("/")) or types.get(path + "/") or "other"


# ------------------------------------------------------------------ writing

def n(x):
    return f"{int(round(x or 0)):,}"


def pos(x):
    return f"{x:.1f}" if x else "n/a"


def money(x):
    return f"${x:,.0f}" if x == int(x) else f"${x:,.2f}"


def table(head, rows):
    cell = lambda c: str(c).replace("|", "/")
    return "\n".join(["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
                     + ["| " + " | ".join(cell(c) for c in r) + " |" for r in rows])


def per28(t, start, end):
    days = (end - max(start, DATA_START)).days + 1
    return {k: t[k] * 28 / days for k in ("impressions", "clicks")} if days > 0 else {"impressions": 0, "clicks": 0}


def front(kind, **extra):
    lines = ["---", "tags: [kawikalopez-site, seo-report]", f"date: {TODAY}", "status: done",
             "project: kawikalopez-site", f"kind: {kind}"] + [f"{k}: {v}" for k, v in extra.items()] + ["---", ""]
    return "\n".join(lines)


def section_index(insp, urls):
    ok = sum(1 for u in urls if insp.get(u, {}).get("verdict") == "PASS")
    out = [f"{ok} of {len(urls)} sitemap pages are on Google (URL Inspection)."]
    notyet = [(path_of(u) or "(home)", insp.get(u, {}).get("coverage") or "not inspected") for u in urls
              if insp.get(u, {}).get("verdict") != "PASS"]
    if notyet:
        out += ["", "Not yet indexed:", ""] + [f"- /{p}: {c}" for p, c in notyet[:40]]
        if len(notyet) > 40:
            out.append(f"- and {len(notyet) - 40} more")
    return "\n".join(out)


def section_targets(rows):
    return table(["Phrase", "Page", "Page impr.", "Page clicks", "Query impr.", "Query clicks", "Query pos.", "Change"],
                 [[r["phrase"], "/" + r["page"], n(r["page_impressions"]), n(r["page_clicks"]),
                   n(r["query_impressions"]), n(r["query_clicks"]), pos(r["query_position"]), r["change"] or ""]
                  for r in rows])


def section_opportunities(sc, queries):
    out = []
    near = [q for q in queries if q["impressions"] >= 20 and q["position"] and 8 <= q["position"] <= 25]
    out.append("**Close to page one** (position 8 to 25, 20+ impressions):")
    out += [f"- \"{q['query']}\": {q['impressions']} impressions, position {q['position']:.1f}" for q in near[:15]] or ["- none yet"]
    low = [p for p in sc["pages"] if p["impressions"] >= 100 and p["ctr"] < 0.015]
    out += ["", "**Seen but not clicked** (100+ impressions, CTR under 1.5%):"]
    out += [f"- /{p['page']}: {p['impressions']} impressions, CTR {p['ctr']:.1%}, position {p['position']:.1f}"
            for p in low[:15]] or ["- none yet"]
    loose = [q for q in unmatched(queries) if q["impressions"] >= 10]
    out += ["", "**Searches no page targets** (10+ impressions, no match in targets.yml):"]
    out += [f"- \"{q['query']}\": {q['impressions']} impressions, position {q['position']:.1f}" for q in loose[:15]] or ["- none yet"]
    return "\n".join(out)


def section_sales(g, st, types):
    out = []
    if g is not None:
        if "error" in g:
            out.append(f"GA4: {g['error']}")
        else:
            t = g["totals"]
            organic = sum(r["sessions"] for r in g["landing"] if r["sessionDefaultChannelGroup"] == "Organic Search")
            out.append(f"GA4: {n(t.get('sessions'))} sessions ({n(organic)} from organic search), "
                       f"{n(t.get('addToCarts'))} add to carts, {n(t.get('checkouts'))} checkouts, "
                       f"{n(t.get('ecommercePurchases'))} purchases, {money(t.get('purchaseRevenue', 0))} in print value.")
            by_type = {}
            for r in g["landing"]:
                if r["sessionDefaultChannelGroup"] == "Organic Search":
                    k = type_of(r["page"], types)
                    by_type[k] = by_type.get(k, 0) + r["sessions"]
            if by_type:
                out.append("Organic sessions by page type: " + ", ".join(f"{k} {n(v)}" for k, v in sorted(by_type.items(), key=lambda kv: -kv[1])) + ".")
            land = sorted(g["landing"], key=lambda r: (-r["ecommercePurchases"], -r["sessions"]))[:15]
            if land:
                out += ["", "Landing pages (sales by landing page):", "",
                        table(["Landing page", "Channel", "Sessions", "Add to carts", "Purchases", "Revenue"],
                              [["/" + r["page"], r["sessionDefaultChannelGroup"], n(r["sessions"]), n(r["addToCarts"]),
                                n(r["ecommercePurchases"]), money(r["purchaseRevenue"])] for r in land])]
            ev = [f"{r['eventName']} {n(r['eventCount'])}" for r in g["events"]
                  if r["eventName"] in ("view_item", "add_to_cart", "begin_checkout", "purchase")]
            out += ["", "Store events: " + (", ".join(ev) if ev else "none recorded yet") + "."]
    if st is not None:
        out.append("")
        if "error" in st:
            out.append(f"Stripe: {st['error']}.")
        else:
            out.append(f"Stripe: {st['count']} paid orders, {money(st['gross'])} gross "
                       f"({money(st['prints_subtotal'])} in prints before shipping).")
            per = {}
            for s_ in st["sales"]:
                for p in s_["prints"]:
                    k = p["urlId"] or "unknown"
                    a = per.setdefault(k, [0, 0.0])
                    a[0] += p["qty"]
                    a[1] += p["amount"]
            if per:
                out.append("By print: " + ", ".join(f"{k} {q} ({money(v)})" for k, (q, v) in sorted(per.items(), key=lambda kv: -kv[1][1])) + ".")
            chans = {}
            for s_ in st["sales"]:
                chans[s_["channel"]] = chans.get(s_["channel"], 0) + 1
            if chans:
                out.append("By checkout: " + ", ".join(f"{k} {v}" for k, v in chans.items()) + ".")
            if g is not None and "error" not in g and st["count"]:
                seen = {r["transactionId"] for r in g["transactions"]}
                hit = sum(1 for s_ in st["sales"] if s_["id"] in seen)
                flag = " Under 80 percent: time for the Stripe webhook to GA4 upgrade in the SEO plan." if hit / st["count"] < 0.8 else ""
                out.append(f"GA4 recorded {hit} of {st['count']} Stripe orders.{flag}")
    return "\n".join(out) if out else ""


def section_other(sc, maps):
    im = sc["image"]
    out = [f"- Image search: {n(im['impressions'])} impressions, {n(im['clicks'])} clicks.",
           "- Countries: " + (", ".join(f"{c.upper()} {i}" for c, _, i in sc["countries"]) or "none") + " (impressions).",
           "- Devices: " + (", ".join(f"{d.lower()} {i}" for d, _, i in sc["devices"]) or "none") + " (impressions).",
           "- Sitemap: " + ("; ".join(f"{m['path']}, {m['submitted']} URLs, {m['errors']} errors, read {m['downloaded']}" for m in maps) or "none"),
           "- Bing: not wired to an API; read it in Bing Webmaster Tools."]
    return "\n".join(out)


def headline(label, sc, g, st, cmp=None):
    t = sc["totals"]
    parts = [f"{n(t['impressions'])} impressions, {n(t['clicks'])} clicks"]
    if st is not None and "error" not in st:
        parts.append(f"{st['count']} orders, {money(st['gross'])} (Stripe)")
    elif g is not None and "error" not in g:
        parts.append(f"{n(g['totals'].get('ecommercePurchases'))} purchases, "
                     f"{money(g['totals'].get('purchaseRevenue', 0))} (GA4; Stripe not connected)")
    line = f"**Headline:** {label}: " + "; ".join(parts) + "."
    return line + (" " + cmp if cmp else "")


def save(name, text, data):
    OUT.mkdir(parents=True, exist_ok=True)
    RAW.mkdir(parents=True, exist_ok=True)
    (OUT / f"{name}.md").write_text(text)
    (RAW / f"{name}.json").write_text(json.dumps(data, indent=1, default=list) + "\n")
    print(f"wrote {OUT / (name + '.md')}")


def load_raw(name):
    f = RAW / f"{name}.json"
    return json.loads(f.read_text()) if f.exists() else None


# ------------------------------------------------------------------ reports

def gather(s, start, end, args):
    sc = search_console(s, start, end)
    g = st = None
    if args.ga4:
        try:
            g = ga4(s, start, end)
        except Exception as e:  # a GA4 hiccup should not cost the Search Console report
            g = {"error": str(e)[:300]}
    if args.stripe:
        st = stripe_sales(start, end)
    return sc, g, st


def report_month(s, args):
    ym = args.month or (TODAY.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m")
    y, m = map(int, ym.split("-"))
    start = dt.date(y, m, 1)
    last = dt.date(y, m, calendar.monthrange(y, m)[1])
    end = min(last, TODAY)
    label = start.strftime("%B %Y") + ("" if end == last else f" (through {end:%b %-d})")
    sc, g, st = gather(s, start, end, args)
    urls = sitemap_urls()
    insp = inspect(s, urls, args.inspect)
    pstart = (start - dt.timedelta(days=1)).replace(day=1)
    prev_name = pstart.strftime("%Y-%m")
    prev = load_raw(prev_name)
    prev_t = totals(sc_query(s, pstart, start - dt.timedelta(days=1), ["date"]))
    base = load_raw("baseline")
    cmp = []
    if prev_t["impressions"]:
        cmp.append(f"Last month: {n(prev_t['impressions'])} impressions, {n(prev_t['clicks'])} clicks.")
    if base and base.get("per28"):
        now = per28(sc["totals"], start, end)
        cmp.append(f"Per 28 days: {n(now['impressions'])} impressions and {n(now['clicks'])} clicks, "
                   f"against a baseline of {n(base['per28']['impressions'])} and {n(base['per28']['clicks'])}.")
    queries = by_query(sc)
    rows = target_rows(sc, prev)
    note, two = next_two(sc, queries)
    types = page_types()
    parts = [front("month", period=ym, data_through=end), f"# kawikalopez.com report: {label}", "",
             headline(label, sc, g, st, " ".join(cmp)), "",
             "## Indexed", "", section_index(insp, urls), "",
             "## Target phrases", "", "Page columns are everything the page earned; query columns are only the searches "
             "that match the phrase or its `queries` in targets.yml.", "", section_targets(rows), "",
             "## Opportunities", "", section_opportunities(sc, queries), ""]
    sales = section_sales(g, st, types)
    if sales:
        parts += ["## Sales", "", sales, ""]
    parts += ["## Everything else", "", section_other(sc, sitemaps(s)), "", "## Seasonal", ""]
    parts += [f"- {what}: publish by {d}" for d, what in seasons_due()] or ["- nothing due in the next 10 weeks"]
    parts += ["", "## Proposed next two pages", ""] + ([note, ""] if note else []) + [f"{i}. {x}" for i, x in enumerate(two, 1)]
    save(ym, "\n".join(parts) + "\n", {"period": ym, "start": str(start), "end": str(end), "sc": sc, "ga4": g,
                                       "stripe": st, "targets": rows})


def report_baseline(s, args):
    """Provisional until day 30; from then on the first 28 full days after cutover."""
    final = TODAY >= CUTOVER + dt.timedelta(days=30)
    history = sc_query(s, TODAY - dt.timedelta(days=486), TODAY, ["date"])
    first = history[0]["keys"][0] if history else None
    if final:
        start, end = CUTOVER + dt.timedelta(days=1), CUTOVER + dt.timedelta(days=28)
    else:  # everything Search Console holds so far, today's partial day included
        start, end = min(dt.date.fromisoformat(first), CUTOVER) if first else CUTOVER, TODAY
    sc, g, st = gather(s, start, end, args)
    pre = totals([r for r in history if r["keys"][0] < str(CUTOVER)])
    urls = sitemap_urls()
    insp = inspect(s, urls, args.inspect)
    days = (end - start).days + 1
    queries = by_query(sc)
    status = "final" if final else "provisional"
    label = f"Baseline ({status}, {start:%b %-d} to {end:%b %-d})"
    parts = [front("baseline", baseline=status, period=f"{start} to {end}"),
             "# kawikalopez.com Search Console baseline", "",
             headline(label, sc, g, st, f"Search Console holds data from {first or 'no date yet'}."), "",
             "## Before the cutover", "",
             (f"From {first} to {CUTOVER - dt.timedelta(days=1)}: {n(pre['impressions'])} impressions, {n(pre['clicks'])} clicks."
              if first and first < str(CUTOVER) else
              "Nothing. Search Console holds no data from before the new site (the Squarespace era was never "
              "verified, and Google did not backfill it)."), "",
             f"## {start:%b %-d} to {end:%b %-d} ({days} days)", "",
             f"- Impressions {n(sc['totals']['impressions'])}, clicks {n(sc['totals']['clicks'])}, "
             f"CTR {sc['totals']['ctr']:.1%}, average position {pos(sc['totals']['position'])}",
             f"- Per 28 days: {n(per28(sc['totals'], start, end)['impressions'])} impressions, {n(per28(sc['totals'], start, end)['clicks'])} clicks",
             f"- Image search: {n(sc['image']['impressions'])} impressions", "",
             "Top queries:", ""]
    parts += [f"- \"{q['query']}\": {q['impressions']} impressions, {q['clicks']} clicks, position {q['position']:.1f}"
              for q in queries[:20]] or ["- none yet"]
    parts += ["", "Top pages:", ""]
    parts += [f"- /{p['page']}: {p['impressions']} impressions, {p['clicks']} clicks, position {p['position']:.1f}"
              for p in sorted(sc["pages"], key=lambda p: -p["impressions"])[:20]] or ["- none yet"]
    parts += ["", "## Indexed", "", section_index(insp, urls), "",
              "## Linking sites", "", "Not in the API. Read Search Console, Links, Top linking sites, and list them here "
              "(expected: Fstoppers, f-stop Gear, Lion Coffee, Facebook).", ""]
    sales = section_sales(g, st, page_types())
    if sales:
        parts += ["## Store", "", sales, ""]
    save("baseline", "\n".join(parts) + "\n", {"status": status, "start": str(start), "end": str(end),
                                               "per28": per28(sc["totals"], start, end), "totals": sc["totals"],
                                               "first_day": first, "sc": sc, "ga4": g, "stripe": st})


def report_check(s, args):
    d = args.check
    start, end = CUTOVER, min(CUTOVER + dt.timedelta(days=d), TODAY)
    sc, g, st = gather(s, start, end, args)
    urls = sitemap_urls()
    insp = inspect(s, urls, args.inspect)
    types = page_types()
    queries = by_query(sc)
    rows = target_rows(sc, None)
    base = load_raw("baseline")
    last28 = totals([{"impressions": i, "clicks": c, "position": 0} for day, c, i in sc["by_date"]
                     if day >= str(end - dt.timedelta(days=27))])

    # The four success criteria from the SEO plan.
    must = [u for u in urls if type_of(path_of(u), types) in ("product", "place")]
    indexed = sum(1 for u in must if insp.get(u, {}).get("verdict") == "PASS")
    place_hits = [r for r in rows if r["cluster"] == "place" and r["query_position"] and r["query_position"] <= 20]
    organic_sale = [] if g is None or "error" in g else [
        r for r in g["landing"] if r["sessionDefaultChannelGroup"] == "Organic Search" and r["ecommercePurchases"] > 0
        and type_of(r["page"], types) in ("place", "post", "gift")]
    crit = [
        ("Every print and place page indexed (by day 30)", indexed == len(must), f"{indexed} of {len(must)}"),
        ("A place page in the top 20 for its phrase (by day 90)", bool(place_hits),
         ", ".join(f"{r['phrase']} {r['query_position']:.1f}" for r in place_hits) or "none yet"),
        ("Organic clicks per 28 days above the baseline (by day 90)",
         bool(base) and last28["clicks"] > base["per28"]["clicks"],
         f"{n(last28['clicks'])} in the last 28 days against {n(base['per28']['clicks'])}" if base else "no baseline recorded"),
        ("First organic sale from a place, post or gift page", bool(organic_sale),
         ", ".join("/" + r["page"] for r in organic_sale) or ("GA4 not pulled" if g is None else "none yet")),
    ]
    passed = sum(1 for _, ok, _ in crit if ok)
    cmp = f"{sum(1 for u in urls if insp.get(u, {}).get('verdict') == 'PASS')} of {len(urls)} pages indexed. Criteria met: {passed} of 4."
    parts = [front("check", day=d, period=f"{start} to {end}"), f"# kawikalopez.com day {d} check", "",
             headline(f"Day {d} ({start:%b %-d} to {end:%b %-d})", sc, g, st, cmp), "",
             "## Success criteria", ""]
    parts += [f"- {'PASS' if ok else 'not yet'}: {what}. {detail}." for what, ok, detail in crit]
    parts += ["", "## Search", "",
              f"- Impressions {n(sc['totals']['impressions'])}, clicks {n(sc['totals']['clicks'])}, "
              f"CTR {sc['totals']['ctr']:.1%}, average position {pos(sc['totals']['position'])}",
              f"- Last 28 days: {n(last28['impressions'])} impressions, {n(last28['clicks'])} clicks"
              + (f" (baseline {n(base['per28']['impressions'])} and {n(base['per28']['clicks'])})" if base else ""), "",
              "Top 10 queries:", ""]
    parts += [f"- \"{q['query']}\": {q['impressions']} impressions, {q['clicks']} clicks, position {q['position']:.1f}"
              for q in queries[:10]] or ["- none yet"]
    parts += ["", "## Indexed", "", section_index(insp, urls), "", "## Target phrases", "", section_targets(rows), ""]
    sales = section_sales(g, st, types)
    if sales:
        parts += ["## Store", "", sales, ""]
    parts += ["## Everything else", "", section_other(sc, sitemaps(s)),
              "- Pinterest and Google Business Profile: n/a until they exist.",
              "- Linking sites: read Search Console, Links, and compare with the baseline list.", "",
              "## Core Web Vitals (lab, mobile)", "", core_web_vitals()]
    save(f"check-{d}", "\n".join(parts) + "\n", {"day": d, "start": str(start), "end": str(end), "sc": sc, "ga4": g,
                                                 "stripe": st, "targets": rows, "criteria": crit})


def core_web_vitals():
    out = []
    for p in ["", "store/", "store/kaimana", "hawaii-prints/kaaawa-valley"]:
        try:
            r = requests.get("https://www.googleapis.com/pagespeedonline/v5/runPagespeed", timeout=120,
                             params={"url": "https://kawikalopez.com/" + p, "strategy": "mobile", "category": "performance"})
            j = r.json()
            if "error" in j:  # keyless calls share one daily quota, so a 429 is common
                out.append(f"- /{p}: PageSpeed Insights answered {j['error'].get('code')}, "
                           f"{j['error'].get('status', '').lower().replace('_', ' ')}; run Lighthouse by hand")
                continue
            lh = j["lighthouseResult"]
            a = lh["audits"]
            out.append(f"- /{p}: performance {round(lh['categories']['performance']['score'] * 100)}, "
                       f"LCP {a['largest-contentful-paint']['displayValue']}, CLS {a['cumulative-layout-shift']['displayValue']}")
        except Exception as e:
            out.append(f"- /{p}: PageSpeed Insights did not answer ({type(e).__name__})")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--baseline", action="store_true")
    mode.add_argument("--month", nargs="?", const="", metavar="YYYY-MM")
    mode.add_argument("--check", type=int, choices=[30, 60, 90])
    ap.add_argument("--ga4", action="store_true", help="add GA4 landing pages, events and purchases")
    ap.add_argument("--stripe", action="store_true", help="add Stripe orders (needs STRIPE_LIVE_READ_KEY)")
    ap.add_argument("--inspect", choices=["auto", "all", "none"], default="auto",
                    help="URL Inspection: auto asks only for pages not yet indexed or checked over 6 days ago")
    ap.add_argument("--auth", action="store_true", help="sign in to Google again")
    args = ap.parse_args()
    try:
        s = google(force=args.auth)
    except NeedAuth as e:
        # Under launchd nobody can click a consent screen: leave a stub /today will surface.
        ym = args.month or (TODAY.replace(day=1) - dt.timedelta(days=1)).strftime("%Y-%m")
        name = "baseline" if args.baseline else f"check-{args.check}" if args.check else ym
        f = OUT / f"{name}.md"
        if not f.exists():
            OUT.mkdir(parents=True, exist_ok=True)
            f.write_text(front("stub") + f"\n# kawikalopez.com report: {name}\n\n**Headline:** not run: {e}. "
                         "Run `python3 tools/gsc_report.py --auth` in ~/Documents/Developer/kawikalopez-site, then rerun.\n")
        raise SystemExit(f"Google: {e}. Run with --auth.")
    if args.auth and not (args.baseline or args.check or args.month is not None):
        print("Google sign-in saved.")
        return
    if args.baseline:
        report_baseline(s, args)
    elif args.check:
        report_check(s, args)
    else:
        report_month(s, args)


if __name__ == "__main__":
    main()
