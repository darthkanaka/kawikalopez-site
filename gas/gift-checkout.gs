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
 *     -> {"status", "paid", "order", "spot": {id, name, address, hours}, "date", "date_long", "lines": [{box, print, qty}]}
 *
 * After payment (Jenn's order setup, 2026-10-29) every paid order is handled once: it gets an
 * order number, a row in the order sheet (shared with Touch A Heart), a packing slip emailed to
 * orders@touchahearthawaii.org, and a confirmation emailed to the buyer. That happens when the
 * buyer's thank-you screen asks for the order (status), and sweepOrders(), on a 10 minute
 * trigger, catches anyone who closed the tab before it loaded. Script Properties remember which
 * orders are done (order_<session id>), so the sheet can be sorted, edited or trimmed freely.
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
 * ORDER SHEET AND EMAILS (one time, after pasting a version with setup in it)
 *   Pick setup in the function menu at the top of the editor and press Run. Allow the Sheets,
 *   Gmail and trigger permissions it asks for. It makes two sheets in Drive, "Holiday gift box
 *   orders" (live) and "Holiday gift box orders (test)", saves their ids as SHEET_LIVE and
 *   SHEET_TEST, and starts the sweepOrders trigger. Orders placed before setup are left alone.
 *   Share the live sheet with Touch A Heart. Optional Script Properties:
 *     SLIP_TO_LIVE   where live packing slips go (default orders@touchahearthawaii.org)
 *     SLIP_TO_TEST   where test packing slips go (default kawika@elevatemediahi.com)
 *   Test orders get "TEST-" numbers, a [Test] subject, and go to the test sheet.
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
  return { mode: mode, key: key, base: base, today: today };
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

/* What the thank-you pane shows: the order number, lines and pickup. Nothing about the buyer.
   A paid order is handled here (sheet, slip, confirmation) if the sweep hasn't got to it yet. */
function status_(req) {
  var env = env_(req);
  var id = String(req.session_id || "");
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) throw new Error("bad session id");
  var s = stripe_(env.key, "get", "checkout/sessions/" + id);
  var m = s.metadata || {};
  if (m.source !== "bh-gift") throw new Error("session " + id + " is not a gift box order");
  var spot = BH_RULES.spots.hasOwnProperty(m.pickup_spot) ? BH_RULES.spots[m.pickup_spot] : null;
  var no = "";
  try { no = fulfil_(env.mode, s) || ""; } catch (err) { console.error("fulfil " + id + ": " + (err && err.message || err)); }
  return {
    status: s.status,
    paid: s.payment_status === "paid",
    order: no,
    spot: spot ? { id: m.pickup_spot, name: spot.name, address: spot.address, hours: spot.hours } : null,
    date: m.pickup_date || "",
    date_long: m.pickup_date ? bhLong(m.pickup_date) : "",
    lines: order_(s).lines.map(function (l) { return { box: l.box, print: l.print, qty: l.qty }; })
  };
}

/* ---------- After payment: order number, sheet row, packing slip, buyer's confirmation ---------- */

var SLIP_TO = { test: "kawika@elevatemediahi.com", live: "orders@touchahearthawaii.org" };
var FROM_NAME = "Kawika Lopez Photography";
var REPLY_TO = "info@kawikalopez.com";
var PHONE = "(808) 204-4575";
var COOKIES = { team: "Double Box", client: "Gift box" };
var SPOT_SHORT = { kalihi: "Kalihi", pearl: "Pearl City" };
var ORDER_HEAD = ["Order", "Pickup day", "Spot", "Name", "Company", "Phone", "Email", "Double Boxes", "Gift boxes",
  "Prints", "Cookies packed", "Prints in", "Picked up", "Notes", "Total", "Placed", "Stripe session"];
var LINE_HEAD = ["Order", "Pickup day", "Spot", "Box", "Cookies", "Print", "Qty", "Stripe session"];
var SWEEP_DAYS = 3;

/* A paid gift box session, in the shape the sheet and the emails use. */
function order_(s) {
  var m = s.metadata || {}, c = s.customer_details || {};
  var spot = BH_RULES.spots.hasOwnProperty(m.pickup_spot) ? BH_RULES.spots[m.pickup_spot] : { name: m.pickup_spot || "", address: "", hours: "" };
  return {
    id: s.id, created: s.created, date: m.pickup_date || "", spotId: m.pickup_spot || "", spot: spot,
    total: (s.amount_total || 0) / 100,
    // With a company name, Stripe's "name" is the company and the person is individual_name.
    name: c.individual_name || c.name || "", company: c.business_name || "", email: c.email || "", phone: c.phone || "",
    lines: String(m.lines || "").split(",").filter(Boolean).map(function (x) {
      var kq = x.split(":"), k = kq[0].split("_"), box = BH_RULES.boxes[k[0]], print = printById_(k[1]), qty = Number(kq[1]);
      return { box: k[0], print: k[1], qty: qty, cookies: COOKIES[k[0]] || k[0],
        boxName: box ? (qty === 1 ? box.name : box.plural) : k[0], printName: print ? print.name : k[1] };
    })
  };
}

/* Handle one paid order once. Returns its order number, or null for sessions that aren't paid
   gift box orders (or came before setup). Safe to call again: each step remembers it's done. */
function fulfil_(mode, s) {
  var m = s.metadata || {};
  if (m.source !== "bh-gift" || s.payment_status !== "paid") return null;
  var props = PropertiesService.getScriptProperties(), MODE = mode.toUpperCase();
  var since = Number(props.getProperty("SINCE_" + MODE) || 0);
  if (!since || s.created < since) return null;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var key = "order_" + s.id, rec = JSON.parse(props.getProperty(key) || "null"), o = order_(s);
    if (!rec) {
      var n = Number(props.getProperty("SEQ_" + MODE) || 1000) + 1;
      rec = { no: (mode === "live" ? "BH-" : "TEST-") + n };
      record_(mode, rec.no, o);
      props.setProperty("SEQ_" + MODE, String(n));
      props.setProperty(key, JSON.stringify(rec));
    }
    if (!rec.slip) {
      slip_(mode, rec.no, o);
      rec.slip = 1;
      props.setProperty(key, JSON.stringify(rec));
    }
    if (!rec.buyer) {
      if (o.email) confirm_(mode, rec.no, o);
      rec.buyer = 1;
      props.setProperty(key, JSON.stringify(rec));
    }
    return rec.no;
  } finally {
    lock.releaseLock();
  }
}

/* Every 10 minutes (trigger made by setup): paid gift box orders from the last few days that
   haven't been handled, for anyone who closed the tab before the thank-you screen loaded. */
function sweepOrders() {
  var props = PropertiesService.getScriptProperties();
  ["test", "live"].forEach(function (mode) {
    var MODE = mode.toUpperCase(), key = props.getProperty("STRIPE_" + MODE + "_KEY");
    if (!key || !props.getProperty("SHEET_" + MODE)) return;
    var from = Math.max(Math.floor(Date.now() / 1000) - SWEEP_DAYS * 86400, Number(props.getProperty("SINCE_" + MODE) || 0));
    var after = null, page;
    do {
      page = stripe_(key, "get", "checkout/sessions?status=complete&limit=100&created%5Bgte%5D=" + from + (after ? "&starting_after=" + after : ""));
      page.data.forEach(function (s) {
        try { fulfil_(mode, s); } catch (err) { console.error("sweep " + s.id + ": " + (err && err.message || err)); }
      });
      after = page.data.length ? page.data[page.data.length - 1].id : null;
    } while (page.has_more && after);
  });
}

function book_(mode) {
  var id = PropertiesService.getScriptProperties().getProperty("SHEET_" + mode.toUpperCase());
  if (!id) throw new Error("no " + mode + " order sheet; run setup in the script editor");
  return SpreadsheetApp.openById(id);
}

/* One row on Orders (Touch A Heart's checklist) and one row per line on Lines (feeds the totals). */
function record_(mode, no, o) {
  var book = book_(mode), orders = book.getSheetByName("Orders"), lines = book.getSheetByName("Lines");
  var day = dateCell_(o.date), placed = placedCell_(o.created);
  var r = orders.getLastRow() + 1;
  orders.getRange(r, 1, 1, ORDER_HEAD.length).setValues([[no, day, o.spot.name, o.name, o.company, phone_(o.phone), o.email,
    boxCount_(o, "team"), boxCount_(o, "client"), printList_(o), false, false, false, "", o.total, placed, o.id]]);
  orders.getRange(r, 11, 1, 3).insertCheckboxes();
  if (!o.lines.length) return;
  lines.getRange(lines.getLastRow() + 1, 1, o.lines.length, LINE_HEAD.length).setValues(o.lines.map(function (l) {
    return [no, day, o.spot.name, BH_RULES.boxes[l.box] ? BH_RULES.boxes[l.box].name : l.box, l.cookies, l.printName, l.qty, o.id];
  }));
}

/* The packing slip, to Touch A Heart. */
function slip_(mode, no, o) {
  var to = PropertiesService.getScriptProperties().getProperty("SLIP_TO_" + mode.toUpperCase()) || SLIP_TO[mode];
  var test = mode === "test", url = book_(mode).getUrl();
  var who = o.name + (o.company ? " (" + o.company + ")" : "");
  var pickup = bhLong(o.date) + ", " + o.spot.hours + ", " + o.spot.name;
  var cookies = cookieList_(o);
  var rows = [["Pickup", pickup], ["Customer", who], ["Phone", phone_(o.phone)], ["Email", o.email], ["Placed", placedText_(o.created)]];
  var cell = "padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #ddd;";
  var html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#1b1a18;max-width:640px">' +
    (test ? '<p style="background:#fff3cd;padding:8px 12px">Test order. Nothing was charged and nothing needs packing.</p>' : "") +
    '<h2 style="margin:0 0 12px">Packing slip, order ' + esc_(no) + "</h2>" +
    '<table style="border-collapse:collapse;margin-bottom:16px">' + rows.map(function (x) {
      return '<tr><th style="' + cell + 'text-align:left">' + x[0] + '</th><td style="' + cell + '">' + esc_(x[1]) + "</td></tr>";
    }).join("") + "</table>" +
    '<table style="border-collapse:collapse;margin-bottom:16px"><tr>' + ["Qty", "Box", "Cookies", "Print"].map(function (h) {
      return '<th style="' + cell + 'text-align:left">' + h + "</th>";
    }).join("") + "</tr>" + o.lines.map(function (l) {
      return "<tr>" + [l.qty, l.boxName, l.cookies, l.printName].map(function (v) { return '<td style="' + cell + '">' + esc_(v) + "</td>"; }).join("") + "</tr>";
    }).join("") + "</table>" +
    "<p><b>Cookies for this order:</b> " + esc_(cookies) + "</p>" +
    "<p>Kawika brings the matted prints to Kalihi with the weekly print drop. Every order is also in the shared sheet, " +
    '<a href="' + url + '">Holiday gift box orders</a>.</p></div>';
  var text = (test ? "TEST ORDER. Nothing was charged and nothing needs packing.\n\n" : "") +
    "Packing slip, order " + no + "\n\n" + rows.map(function (x) { return x[0] + ": " + x[1]; }).join("\n") + "\n\n" +
    o.lines.map(function (l) { return l.qty + " x " + l.boxName + " (" + l.cookies + "), " + l.printName + " print"; }).join("\n") +
    "\n\nCookies for this order: " + cookies + "\n\nKawika brings the matted prints to Kalihi with the weekly print drop. Every order is also in the shared sheet, " + url + "\n";
  MailApp.sendEmail({ to: to, subject: (test ? "[Test] " : "") + "Gift box order " + no + ", pickup " + shortDay_(o.date) + " at " + (SPOT_SHORT[o.spotId] || o.spot.name),
    body: text, htmlBody: html, name: FROM_NAME, replyTo: REPLY_TO });
}

/* The buyer's confirmation: order number, pickup, what they ordered. */
function confirm_(mode, no, o) {
  var test = mode === "test", first = (o.name || "").split(" ")[0] || "there";
  var when = bhLong(o.date) + ", between " + o.spot.hours.replace(" to ", " and ");
  var paras = [
    "Hi " + first + ",",
    "Thank you for your order! Your order number is " + no + ".",
    "Pick up your gift boxes on " + when + ", at " + o.spot.name + ", " + o.spot.address + ". Go to the Touch A Heart table and give your name or order number. If someone else is picking up for you, they can show this email.",
    "__LINES__",
    "Questions, or need to change something? Reply to this email or call " + PHONE + ".",
    "Mahalo for supporting Touch A Heart's job training and a local artist.",
    "Kawika Lopez\nKawika Lopez Photography"
  ];
  if (test) paras.unshift("This is a test order. Nothing was charged.");
  var items = o.lines.map(function (l) { return l.qty + " " + l.boxName + " with " + l.printName; });
  var total = "Total $" + o.total.toFixed(2).replace(/\.00$/, "");
  var html = '<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;color:#1b1a18;max-width:560px">' + paras.map(function (p) {
    if (p === "__LINES__") return '<p style="margin:0 0 16px"><b>What you ordered</b><br>' + items.map(esc_).join("<br>") + "<br>" + total + "</p>";
    return '<p style="margin:0 0 16px">' + esc_(p).replace(/\n/g, "<br>") + "</p>";
  }).join("") + "</div>";
  var text = paras.map(function (p) { return p === "__LINES__" ? "What you ordered\n" + items.join("\n") + "\n" + total : p; }).join("\n\n") + "\n";
  MailApp.sendEmail({ to: o.email, subject: (test ? "[Test] " : "") + "Your holiday gift box order, " + no,
    body: text, htmlBody: html, name: FROM_NAME, replyTo: REPLY_TO });
}

function boxCount_(o, box) {
  return o.lines.reduce(function (a, l) { return a + (l.box === box ? l.qty : 0); }, 0);
}
/* "4 Mokulele, 2 Mālie": prints across both boxes. */
function printList_(o) {
  var n = {}, order = [];
  o.lines.forEach(function (l) { if (!n[l.printName]) order.push(l.printName); n[l.printName] = (n[l.printName] || 0) + l.qty; });
  return order.map(function (p) { return n[p] + " " + p; }).join(", ");
}
/* "6 Double Boxes, 2 Gift boxes" */
function cookieList_(o) {
  return ["team", "client"].map(function (b) {
    var q = boxCount_(o, b);
    return q ? q + " " + COOKIES[b] + (q === 1 ? "" : "es") : "";
  }).filter(Boolean).join(", ");
}
/* Dates go in as formulas so the sheet's own time zone can't shift them a day. */
function dateCell_(day) {
  var p = String(day).split("-");
  return p.length === 3 ? "=DATE(" + Number(p[0]) + "," + Number(p[1]) + "," + Number(p[2]) + ")" : "";
}
function hst_(sec) {
  return new Date(sec * 1000 - 10 * 3600 * 1000);
}
function placedCell_(sec) {
  var d = hst_(sec);
  return "=DATE(" + d.getUTCFullYear() + "," + (d.getUTCMonth() + 1) + "," + d.getUTCDate() + ")+TIME(" + d.getUTCHours() + "," + d.getUTCMinutes() + ",0)";
}
/* "October 30, 2:14 pm" in Hawaiʻi. */
function placedText_(sec) {
  var d = hst_(sec), h = d.getUTCHours(), mm = ("0" + d.getUTCMinutes()).slice(-2);
  return bhLong(d.toISOString().slice(0, 10)).split(", ")[1] + ", " + (h % 12 || 12) + ":" + mm + (h < 12 ? " am" : " pm");
}
/* "Wed Nov 18" */
function shortDay_(day) {
  var p = bhLong(day).split(", "), md = p[1].split(" ");
  return p[0].slice(0, 3) + " " + md[0].slice(0, 3) + " " + md[1];
}
/* "+18085550100" -> "(808) 555-0100"; anything else as given. */
function phone_(p) {
  var m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(String(p || ""));
  return m ? "(" + m[1] + ") " + m[2] + "-" + m[3] : String(p || "");
}
function esc_(t) {
  return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
}

/* Run once from the editor: the two order sheets and the sweep trigger. Safe to run again: it
   only makes what's missing, and re-applies the totals and formats to sheets that exist. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  ["test", "live"].forEach(function (mode) {
    var MODE = mode.toUpperCase(), id = props.getProperty("SHEET_" + MODE), book;
    if (id) {
      book = SpreadsheetApp.openById(id);
    } else {
      book = SpreadsheetApp.create(mode === "live" ? "Holiday gift box orders" : "Holiday gift box orders (test)");
      book.setSpreadsheetTimeZone("Pacific/Honolulu");
      heading_(book.getSheets()[0].setName("Orders"), ORDER_HEAD);
      heading_(book.insertSheet("Lines"), LINE_HEAD);
      book.insertSheet("Cookies to pack", 1);
      book.insertSheet("Prints to bring", 2);
    }
    dress_(book);
    if (!id) {
      props.setProperty("SHEET_" + MODE, book.getId());
      props.setProperty("SINCE_" + MODE, String(Math.floor(Date.now() / 1000)));
    }
    console.log(mode + " sheet " + (id ? "updated" : "made") + ": " + book.getUrl());
  });
  var has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === "sweepOrders"; });
  if (!has) ScriptApp.newTrigger("sweepOrders").timeBased().everyMinutes(10).create();
  console.log(has ? "sweepOrders trigger already on" : "sweepOrders trigger made, every 10 minutes");
}

/* Formats and totals. The totals are formulas, so they follow any edit to the sheet. QUERY
   hands dates back as plain numbers, so the pickup day columns get a date format of their own. */
function dress_(book) {
  var orders = book.getSheetByName("Orders"), lines = book.getSheetByName("Lines");
  var cookies = book.getSheetByName("Cookies to pack"), prints = book.getSheetByName("Prints to bring");
  orders.getRange("B2:B").setNumberFormat("ddd mmm d");
  orders.getRange("O2:O").setNumberFormat("$#,##0");
  orders.getRange("P2:P").setNumberFormat("mmm d, h:mm am/pm");
  orders.setColumnWidth(10, 260);
  orders.setColumnWidth(14, 220);
  lines.getRange("B2:B").setNumberFormat("ddd mmm d");
  cookies.getRange("A1").setValue("Season so far").setFontWeight("bold");
  cookies.getRange("A2").setFormula("=IFERROR(QUERY(Orders!A2:Q, \"select count(A), sum(H), sum(I) where B is not null label count(A) 'Orders', sum(H) 'Double Boxes', sum(I) 'Gift boxes'\", 0), \"No orders yet\")");
  cookies.getRange("A6").setValue("By pickup day").setFontWeight("bold");
  cookies.getRange("A7").setFormula("=IFERROR(QUERY(Orders!A2:Q, \"select B, C, count(A), sum(H), sum(I) where B is not null group by B, C order by B label B 'Pickup day', C 'Spot', count(A) 'Orders', sum(H) 'Double Boxes', sum(I) 'Gift boxes'\", 0), \"No orders yet\")");
  cookies.getRange("A8:A").setNumberFormat("ddd mmm d");
  cookies.setColumnWidth(2, 220);
  prints.getRange("A1").setValue("Season so far").setFontWeight("bold");
  prints.getRange("A2").setFormula("=IFERROR(QUERY(Lines!A2:H, \"select F, sum(G) where B is not null group by F label F 'Print', sum(G) 'Prints'\", 0), \"No orders yet\")");
  prints.getRange("A11").setValue("By pickup day").setFontWeight("bold");
  prints.getRange("A12").setFormula("=IFERROR(QUERY(Lines!A2:H, \"select B, sum(G) where B is not null group by B pivot F order by B label B 'Pickup day'\", 0), \"No orders yet\")");
  prints.getRange("A13:A").setNumberFormat("ddd mmm d");
  prints.setColumnWidth(1, 160);
  lines.hideSheet();
  book.setActiveSheet(orders);
}

function heading_(sheet, head) {
  sheet.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight("bold");
  sheet.setFrozenRows(1);
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
