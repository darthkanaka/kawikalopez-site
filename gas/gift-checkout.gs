/**
 * kawikalopez.com: holiday gift box checkout (Baker's Heart x Kawika Lopez).
 *
 * A Google Apps Script web app, separate from the print store's checkout (gas/checkout.gs), so
 * the store's cart can't break because of this one. The page gifts/holiday-gift-boxes calls it:
 *
 *   {"action": "create", "mode": "test" | "live", "terms_ack": true, "spot": "kalihi" | "pearl",
 *    "date": "2026-12-09", "items": [{"box": "team", "print": "mokulele", "qty": 4}, ...]}
 *     -> {"client_secret": "..."} or {"error": "..."}
 *   {"action": "status", "mode": ..., "session_id": "cs_..."}
 *     -> {"status", "paid", "spot": {id, name, address, hours}, "date", "date_long", "lines": [{box, print, qty}]}
 *
 * Nothing here trusts the browser. Box prices come from Stripe by lookup key (bh_<box>_<print>,
 * made by tools/bh_catalog.py) and must match the rules below, and every pickup and order rule is
 * checked again here, in Hawaiʻi time, before a session is created.
 * Requests come as text/plain JSON so the browser skips the CORS preflight.
 *
 * DEPLOY (one time)
 *   1. script.google.com, signed in as kawika@elevatemediahi.com, New project.
 *      Name it "kawikalopez.com gift checkout".
 *   2. Replace the sample code with this file. Save.
 *   3. Project Settings (gear) > Script Properties > add
 *        STRIPE_LIVE_KEY   CHECKOUT_LIVE_KEY from ~/.claude/credentials/kawikalopez-stripe.env
 *        STRIPE_TEST_KEY   CHECKOUT_TEST_KEY from the same file
 *        BASE_TEST         the site address test checkouts return to, e.g. http://localhost:8781/
 *      (restricted keys: Checkout Sessions write, Customers write, Prices read, Products read)
 *   4. Deploy > New deployment > type Web app. Execute as: Me. Who has access: Anyone.
 *   5. Authorise when asked. Copy the Web app URL ending in /exec into data/bh-gift.yml as endpoint.
 * TEST_TODAY (a Script Property, test mode only) pretends today is that day, to try the rules.
 *
 * CHANGING IT LATER
 *   Deploy > Manage deployments > pencil > Version: New version. "New deployment" mints a new URL.
 *
 * Tested locally by tools/bh_checkout_dev.mjs --check, against the Stripe sandbox.
 */

var STRIPE_VERSION = "2026-03-25.dahlia";
var BASE = { test: "http://localhost:8781/", live: "https://kawikalopez.com/" };
var PAGE = "gifts/holiday-gift-boxes";
var MAX_QTY = 999;

function doGet() {
  return json_({ ok: true, service: "kawikalopez.com gift checkout" });
}

function doPost(e) {
  var req = {};
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (req.action === "status") return json_(status_(req));
    if (req.action === "create") return json_({ client_secret: create_(req) });
    throw new Error("unknown action " + req.action);
  } catch (err) {
    var msg = String(err && err.message || err);
    console.error(msg);
    var say = msg.indexOf("CUSTOMER:") === 0 ? msg.slice(9)
      : req.action === "status" ? "We couldn't find that order."
      : "Checkout could not start. Please try again.";
    return json_({ error: say });
  }
}

/* Key, site address and today's date in Hawaiʻi for a mode. */
function env_(req) {
  var mode = req.mode === "live" ? "live" : req.mode === "test" ? "test" : null;
  if (!mode) throw new Error("bad mode");
  var props = PropertiesService.getScriptProperties();
  var key = props.getProperty(mode === "live" ? "STRIPE_LIVE_KEY" : "STRIPE_TEST_KEY");
  if (!key) throw new Error("no " + mode + " key in Script Properties");
  var base = props.getProperty(mode === "live" ? "BASE_LIVE" : "BASE_TEST") || BASE[mode];
  var today = bhToday(Date.now());
  var fake = mode === "test" ? props.getProperty("TEST_TODAY") : null;
  if (fake && /^\d{4}-\d{2}-\d{2}$/.test(fake)) today = fake;
  return { key: key, base: base, today: today };
}

function printById_(id) {
  for (var i = 0; i < BH_RULES.prints.length; i++) if (BH_RULES.prints[i].id === id) return BH_RULES.prints[i];
  return null;
}

function create_(req) {
  var env = env_(req);

  // Order lines: known boxes and prints, whole quantities, merged.
  var want = {}, order = [], boxes = 0;
  (req.items || []).forEach(function (it) {
    var box = String(it && it.box || ""), print = String(it && it.print || "");
    var qty = Math.floor(Number(it && it.qty));
    if (!BH_RULES.boxes.hasOwnProperty(box) || !printById_(print) || !(qty >= 1)) return;
    var k = box + "_" + print;
    if (!want[k]) order.push(k);
    want[k] = Math.min((want[k] || 0) + qty, MAX_QTY);
  });
  order.forEach(function (k) { boxes += want[k]; });

  // The buyer ticked the made-to-order, final-sale box (Hawaiʻi HRS 481B-5.5).
  if (req.terms_ack !== true) throw new Error("CUSTOMER:Please tick the box to confirm you've read the terms of sale.");
  var can = bhCanOrder(boxes, env.today);
  if (!can.ok) throw new Error("CUSTOMER:" + can.why);
  var spotId = String(req.spot || "");
  var spot = BH_RULES.spots.hasOwnProperty(spotId) ? BH_RULES.spots[spotId] : null;
  if (!spot) throw new Error("CUSTOMER:Please pick a pickup spot.");
  var date = String(req.date || "");
  if (!bhOpen(date, spotId, env.today)) throw new Error("CUSTOMER:That pickup day isn't available any more. Please pick another one.");

  // Prices from Stripe, by lookup key, checked against the rules.
  var q = ["active=true", "limit=100", "expand[]=data.product"];
  order.forEach(function (k) { q.push("lookup_keys[]=" + encodeURIComponent("bh_" + k)); });
  var byKey = {};
  stripe_(env.key, "get", "prices?" + q.join("&")).data.forEach(function (p) { byKey[p.lookup_key] = p; });

  var lines = [], names = [], summary = [];
  order.forEach(function (k) {
    var p = byKey["bh_" + k], parts = k.split("_"), box = BH_RULES.boxes[parts[0]], print = printById_(parts[1]);
    if (!p || !p.product || !p.product.active || p.currency !== "usd") throw new Error("price bh_" + k + " is missing or inactive");
    if (p.unit_amount !== box.price * 100) throw new Error("price bh_" + k + " is " + p.unit_amount + " cents, the rules say " + box.price * 100);
    lines.push({ price: p.id, quantity: want[k] });
    names.push(want[k] + " " + (want[k] === 1 ? box.name : box.plural) + " with " + print.name);
    summary.push(k + ":" + want[k]);
  });
  var pickup = "Pickup " + bhLong(date) + ", " + spot.hours + ", at " + spot.name + ", " + spot.address + ".";

  var session = stripe_(env.key, "post", "checkout/sessions", {
    ui_mode: "form",
    mode: "payment",
    line_items: lines,
    name_collection: { individual: { enabled: true, optional: false }, business: { enabled: true, optional: true } },
    phone_number_collection: { enabled: true },
    customer_creation: "always",
    return_url: env.base + PAGE + "?session_id={CHECKOUT_SESSION_ID}",
    // The description is printed on the buyer's receipt: the boxes and the pickup.
    payment_intent_data: { description: (names.join("; ") + ". " + pickup).slice(0, 1000) },
    metadata: { source: "bh-gift", pickup_spot: spotId, pickup_date: date, boxes: String(boxes),
      lines: summary.join(",").slice(0, 500), terms_ack: "yes, gift box window checkbox" }
  });
  return session.client_secret;
}

/* What the thank-you pane shows: the order's lines and its pickup. Nothing about the buyer. */
function status_(req) {
  var env = env_(req);
  var id = String(req.session_id || "");
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) throw new Error("bad session id");
  var s = stripe_(env.key, "get", "checkout/sessions/" + id);
  var m = s.metadata || {};
  if (m.source !== "bh-gift") throw new Error("session " + id + " is not a gift box order");
  var spot = BH_RULES.spots.hasOwnProperty(m.pickup_spot) ? BH_RULES.spots[m.pickup_spot] : null;
  return {
    status: s.status,
    paid: s.payment_status === "paid",
    spot: spot ? { id: m.pickup_spot, name: spot.name, address: spot.address, hours: spot.hours } : null,
    date: m.pickup_date || "",
    date_long: m.pickup_date ? bhLong(m.pickup_date) : "",
    lines: String(m.lines || "").split(",").filter(Boolean).map(function (x) {
      var kq = x.split(":"), k = kq[0].split("_");
      return { box: k[0], print: k[1], qty: Number(kq[1]) };
    })
  };
}

/* BEGIN bhRules: identical in assets/js/bh-pickup.js and gas/gift-checkout.gs (tools/test_bh_pickup.mjs --drift checks) */
var BH_RULES = {
  first: "2026-11-16",       // first pickup day, the day Touch A Heart starts holiday pickups
  last: "2026-12-22",        // last pickup day
  leadDays: 5,               // business days between placing an order and picking it up
  closed: ["2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25"],   // weekdays with no pickups
  bigOrder: 25,              // orders over this many boxes...
  bigLastDay: "2026-12-01",  // ...can be placed through this day only
  spots: {
    kalihi: { name: "Kalihi Union Church", address: "2214 N. King St., Honolulu", hours: "8 am to 1 pm", days: [1, 2, 3, 4, 5] },
    pearl: { name: "Pearl City Community Church", address: "933 Lehua Ave., Pearl City", hours: "1:30 to 3 pm", days: [3] }
  },
  boxes: {
    team: { name: "Team box", plural: "Team boxes", price: 80,
      what: "Every Team box has a matted print of the photograph you pick and a Baker's Heart Double Box, twelve lace cookies in three flavors." },
    client: { name: "Client box", plural: "Client boxes", price: 120,
      what: "Every Client box has a matted print of the photograph you pick and a Baker's Heart gift box of lace cookies and biscotti bites." }
  },
  prints: [
    { id: "mokulele", name: "Mokulele", h: false, img: "mokulele" },
    { id: "mokulua", name: "Mokulua", h: true, img: "mokulua-islands" },
    { id: "shoreline", name: "Shoreline Cascade", h: false, img: "shorelinecascade" },
    { id: "leahi", name: "Lēʻahi Kahiko", h: true, img: "leahikahiko" },
    { id: "kahana", name: "Kahana", h: false, img: "kahana" },
    { id: "malie", name: "Mālie", h: true, img: "malie" }
  ]
};

/* Today's date in Hawaiʻi (UTC minus 10, no daylight saving). */
function bhToday(nowMs) {
  return new Date(nowMs - 10 * 3600 * 1000).toISOString().slice(0, 10);
}
function bhShift(day, n) {
  var d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function bhWeekday(day) {
  return new Date(day + "T00:00:00Z").getUTCDay();
}
function bhIsBusinessDay(day) {
  var w = bhWeekday(day);
  return w > 0 && w < 6 && BH_RULES.closed.indexOf(day) < 0;
}
/* The day that is `n` business days after `day`. */
function bhAddBusinessDays(day, n) {
  var d = day;
  while (n > 0) {
    d = bhShift(d, 1);
    if (bhIsBusinessDay(d)) n--;
  }
  return d;
}
/* Can `spot` hand out an order on `day`, when the order is placed on `today`? */
function bhOpen(day, spot, today) {
  var s = BH_RULES.spots[spot];
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return false;
  var floor = bhAddBusinessDays(today, BH_RULES.leadDays);
  if (floor < BH_RULES.first) floor = BH_RULES.first;
  return day >= floor && day <= BH_RULES.last && bhIsBusinessDay(day) && s.days.indexOf(bhWeekday(day)) >= 0;
}
/* The first day `spot` can do for an order placed `today`, or null when it has none left. */
function bhFirstOpen(spot, today) {
  for (var d = today; d <= BH_RULES.last; d = bhShift(d, 1)) {
    if (bhOpen(d, spot, today)) return d;
  }
  return null;
}
/* The last day `spot` can do for an order placed `today`, or null. */
function bhLastOpen(spot, today) {
  for (var d = BH_RULES.last; d >= today; d = bhShift(d, -1)) {
    if (bhOpen(d, spot, today)) return d;
  }
  return null;
}
/* Can an order of `boxes` boxes be placed `today`? {ok: true}, or {ok: false, why} in words for the buyer. */
function bhCanOrder(boxes, today) {
  if (!(boxes >= 1)) return { ok: false, why: "Add at least one box first." };
  if (!bhFirstOpen("kalihi", today)) return { ok: false, why: "Ordering is closed for this season." };
  if (boxes > BH_RULES.bigOrder && today > BH_RULES.bigLastDay) {
    return { ok: false, why: "Orders of more than " + BH_RULES.bigOrder + " boxes could be placed through December 1. You can still order up to " + BH_RULES.bigOrder + "." };
  }
  return { ok: true };
}
/* "Wednesday, December 9" */
function bhLong(day) {
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var d = new Date(day + "T00:00:00Z");
  return DAYS[d.getUTCDay()] + ", " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
}
/* END bhRules */

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
