/**
 * kawikalopez.com: cart checkout.
 *
 * A Google Apps Script web app. The cart page posts the prints in the cart here; this prices
 * them from Stripe, prices shipping for the whole order the way the print lab does (by total
 * square inches, see shipQuote below), creates a Stripe Checkout Session and returns its URL.
 * The browser then goes to Stripe to pay.
 *
 * Nothing here trusts the browser for money: print prices come from Stripe by lookup key,
 * print sizes from the Stripe price metadata, and the shipping model from the site's own
 * assets/data/cart.json (built from data/shipping.yml).
 *
 * Request (POST, body JSON, sent as text/plain so the browser skips the CORS preflight):
 *   {"mode": "test" | "live", "items": [{"id": "033_36x24_metal", "qty": 1}, ...]}
 * Response: {"url": "https://checkout.stripe.com/..."} or {"error": "..."}
 *
 * DEPLOY (one time)
 *   1. script.google.com, signed in as kawika@elevatemediahi.com, New project.
 *      Name it "kawikalopez.com checkout".
 *   2. Replace the sample code with this file. Save.
 *   3. Project Settings (gear) > Script Properties > add
 *        STRIPE_LIVE_KEY   a restricted live key (see below)
 *        STRIPE_TEST_KEY   a restricted test key from the sandbox, same permissions
 *   4. Deploy > New deployment > type Web app
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   5. Authorise when asked. Copy the Web app URL ending in /exec into data/site.yml as
 *      checkout.endpoint, rebuild, push.
 *
 * Restricted key permissions: Checkout Sessions write, Customers write, Shipping Rates write,
 * Prices read, Products read, Promotion Codes read, Coupons read. Everything else None.
 *
 * CHANGING IT LATER
 *   Deploy > Manage deployments > pencil > Version: New version.
 *   "New deployment" mints a new URL and the site keeps posting to the old one.
 *
 * Tested locally by tools/checkout_dev.mjs, which runs this file in Node with the Apps Script
 * services stubbed, against the Stripe sandbox.
 */

var STRIPE_VERSION = "2024-06-20";
var BASE = { test: "https://darthkanaka.github.io/kawikalopez-site/", live: "https://kawikalopez.com/" };

function doGet() {
  return json_({ ok: true, service: "kawikalopez.com checkout" });
}

function doPost(e) {
  try {
    var req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    return json_({ url: createSession_(req) });
  } catch (err) {
    var msg = String(err && err.message || err);
    console.error(msg);
    return json_({ error: msg.indexOf("CUSTOMER:") === 0 ? msg.slice(9) : "Checkout could not start. Please try again." });
  }
}

function createSession_(req) {
  var mode = req.mode === "live" ? "live" : req.mode === "test" ? "test" : null;
  if (!mode) throw new Error("bad mode");
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(mode === "live" ? "STRIPE_LIVE_KEY" : "STRIPE_TEST_KEY");
  if (!key) throw new Error("no " + mode + " key in Script Properties");
  var base = props.getProperty(mode === "live" ? "BASE_LIVE" : "BASE_TEST") || BASE[mode];
  var cfg = siteConfig_(base);
  var model = cfg.model;

  // Cart lines: known ids, whole quantities, merged.
  var want = {}, order = [];
  (req.items || []).forEach(function (it) {
    var id = String(it && it.id || "");
    var qty = Math.floor(Number(it && it.qty));
    if (!/^[A-Za-z0-9_-]{1,60}$/.test(id) || !(qty >= 1)) return;
    if (!want[id]) order.push(id);
    want[id] = Math.min((want[id] || 0) + qty, model.max_qty);
  });
  if (!order.length) throw new Error("CUSTOMER:Your cart is empty.");
  if (order.length > model.max_items) throw new Error("CUSTOMER:Up to " + model.max_items + " different prints per order, please.");

  // Prices from Stripe, by lookup key (the variant id).
  var q = ["active=true", "limit=100", "expand[]=data.product"];
  order.forEach(function (id) { q.push("lookup_keys[]=" + encodeURIComponent(id)); });
  var prices = stripe_(key, "get", "prices?" + q.join("&")).data;
  var byKey = {};
  prices.forEach(function (p) { byKey[p.lookup_key] = p; });

  var lines = [], items = [], names = [];
  order.forEach(function (id) {
    var p = byKey[id];
    if (!p || !p.product || !p.product.active || p.currency !== "usd") {
      throw new Error("CUSTOMER:One of the prints in your cart is no longer available. Remove it and try again.");
    }
    var m = /(\d+)\s*x\s*(\d+)/.exec(p.metadata.size || "");
    if (!m) throw new Error("price " + p.id + " has no size metadata");
    lines.push({ price: p.id, quantity: want[id] });
    items.push({ w: Number(m[1]), h: Number(m[2]), qty: want[id], material: p.metadata.material });
    names.push(want[id] + " x " + p.product.name + ", " + p.metadata.size + " " + p.metadata.material);
  });

  var s = shipQuote(model, items);
  var days = function (r) {
    return { minimum: { unit: "business_day", value: r[0] }, maximum: { unit: "business_day", value: r[1] } };
  };
  var rate = function (label, amount, r) {
    return { shipping_rate_data: { display_name: label, type: "fixed_amount",
      fixed_amount: { amount: amount, currency: "usd" }, delivery_estimate: days(r) } };
  };
  var options = [rate(model.pickup.label, 0, model.pickup.days)];
  if (s.ships) {
    options.push(rate("Ship to " + model.zones.hi.label, s.hi, model.zones.hi.days));
    options.push(rate("Ship to " + model.zones.mainland.label, s.mainland, model.zones.mainland.days));
  }

  // For Kawika: how to place the order with the lab if it ships to the mainland.
  var labPlan = "";
  if (s.ships && s.boxes.length > 1) {
    labPlan = "If shipping to the mainland, place " + s.boxes.length + " separate lab orders: " +
      s.boxes.map(function (b, i) {
        return (i + 1) + ") " + b.map(function (u) { return u.w + "x" + u.h + " " + u.material; }).join(" + ");
      }).join("; ") + ".";
  }
  var description = ("Cart: " + names.join("; ") + (labPlan ? ". " + labPlan : "")).slice(0, 1000);

  var session = stripe_(key, "post", "checkout/sessions", {
    mode: "payment",
    line_items: lines,
    shipping_address_collection: { allowed_countries: ["US"] },
    shipping_options: options,
    allow_promotion_codes: true,
    phone_number_collection: { enabled: true },
    customer_creation: "always",
    custom_text: {
      shipping_address: { message: s.ships
        ? "Choose free pickup on Oʻahu, or shipping to Hawaiʻi or the US mainland. Shipping covers every print in this order."
        : "Pickup only on Oʻahu for this order: it includes a print too large to ship. We'll email you to set a time." },
      submit: { message: "Printed to order on Oʻahu, usually in about a week." }
    },
    custom_fields: [{ key: "note", label: { type: "custom", custom: "Anything we should know?" }, type: "text", optional: true }],
    success_url: base + "thank-you?session_id={CHECKOUT_SESSION_ID}",
    cancel_url: base + "cart",
    payment_intent_data: { description: description },
    metadata: { source: "cart", lab_orders_mainland: labPlan.slice(0, 500) }
  });
  return session.url;
}

/* The site's cart.json (shipping model), cached for ten minutes. */
function siteConfig_(base) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get("cfg:" + base);
  if (hit) return JSON.parse(hit);
  var res = UrlFetchApp.fetch(base + "assets/data/cart.json", { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("cart.json: HTTP " + res.getResponseCode());
  var cfg = JSON.parse(res.getContentText());
  var slim = JSON.stringify({ model: cfg.model });
  cache.put("cfg:" + base, slim, 600);
  return JSON.parse(slim);
}

function stripe_(key, method, path, params) {
  var opts = { method: method, muteHttpExceptions: true,
    headers: { Authorization: "Bearer " + key, "Stripe-Version": STRIPE_VERSION } };
  if (params) {
    opts.contentType = "application/x-www-form-urlencoded";
    opts.payload = form_(params);
  }
  var res = UrlFetchApp.fetch("https://api.stripe.com/v1/" + path, opts);
  var body = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 300) throw new Error("Stripe " + path.split("?")[0] + ": " + (body.error && body.error.message));
  return body;
}

/* Stripe's form encoding: a[b][0][c]=v. */
function form_(obj) {
  var out = [];
  (function walk(v, prefix) {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { v.forEach(function (x, i) { walk(x, prefix + "[" + i + "]"); }); return; }
    if (typeof v === "object") {
      Object.keys(v).forEach(function (k) { walk(v[k], prefix ? prefix + "[" + k + "]" : k); });
      return;
    }
    out.push(encodeURIComponent(prefix) + "=" + encodeURIComponent(String(v)));
  })(obj, "");
  return out.join("&");
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/* BEGIN shipQuote: identical in assets/js/site.js and gas/checkout.gs (tools/test_shipping.mjs checks) */
/* Shipping for a cart, in cents, from the model in data/shipping.yml (cart:).
   items: [{w, h, qty, material}]. Returns {ships, pickupOnly, hi, mainland, hiQuote,
   mainlandQuote, boxes}; hi and mainland are what the customer pays (quote x markup, rounded
   up to the next dollar). boxes: the lab orders for mainland shipping, each a list of units. */
function shipQuote(model, items) {
  var units = [], i, j, it;
  for (i = 0; i < items.length; i++) {
    it = items[i];
    for (j = 0; j < it.qty; j++) {
      units.push({ w: it.w, h: it.h, material: it.material, area: it.w * it.h });
    }
  }
  var oversize = function (u) {
    return Math.max(u.w, u.h) > model.max_long_edge_in || Math.min(u.w, u.h) > model.max_short_edge_in ||
      u.area > model.mainland_box_max_sq_in;
  };
  for (i = 0; i < units.length; i++) {
    if (oversize(units[i])) return { ships: false, pickupOnly: true, boxes: [] };
  }
  if (!units.length) return { ships: false, pickupOnly: false, boxes: [] };

  var hq = model.hi.base;
  for (i = 0; i < units.length; i++) {
    hq += model.hi.per_sq_in * units[i].area + model.hi.per_print +
      (units[i].material === "canvas" ? model.hi.per_canvas_print : 0);
  }

  // Largest first into the first box with room; each box stays under the freight jump.
  var sorted = units.slice().sort(function (a, b) { return b.area - a.area; });
  var boxes = [], sums = [];
  for (i = 0; i < sorted.length; i++) {
    for (j = 0; j < boxes.length; j++) {
      if (sums[j] + sorted[i].area <= model.mainland_box_max_sq_in) break;
    }
    if (j === boxes.length) { boxes.push([]); sums.push(0); }
    boxes[j].push(sorted[i]);
    sums[j] += sorted[i].area;
  }
  var step = function (area) {
    for (var k = 0; k < model.mainland_steps.length; k++) {
      if (area <= model.mainland_steps[k][0]) return model.mainland_steps[k][1];
    }
    return null;
  };
  var mq = 0;
  for (j = 0; j < sums.length; j++) mq += step(sums[j]);

  var charge = function (q) { return Math.ceil(q * model.markup_pct / 10000) * 100; };
  return { ships: true, pickupOnly: false, hi: charge(hq), mainland: charge(mq), hiQuote: hq,
    mainlandQuote: mq, boxes: boxes };
}
/* END shipQuote */
