// Runs gas/gift-checkout.gs locally with the Apps Script services stubbed, against the Stripe sandbox.
//
//   node tools/bh_checkout_dev.mjs            the checkout on http://localhost:8782/ for the local page
//   node tools/bh_checkout_dev.mjs --check    scenario checks, then exit (non-zero on any failure)
//
// The order sheet, mail and lock are faked in memory (setup runs at start), so nothing is emailed.
// Test mode only: the key is STRIPE_TEST_KEY from ~/.claude/credentials/kawikalopez-stripe.env.
// Build the page against it with KL_BH_ENDPOINT=http://localhost:8782/ (see tools/build.py).
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { createServer } from "http";
import { homedir } from "os";
import vm from "vm";

const PORT = Number(process.env.PORT || 8782);
const root = new URL("..", import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(homedir() + "/.claude/credentials/kawikalopez-stripe.env", "utf8")
  .split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const props = { STRIPE_TEST_KEY: env.STRIPE_TEST_KEY, BASE_TEST: process.env.BASE_TEST || "http://localhost:8781/" };
if (process.env.TEST_TODAY) props.TEST_TODAY = process.env.TEST_TODAY;

// UrlFetchApp is synchronous in Apps Script; curl keeps it synchronous here.
const UrlFetchApp = {
  fetch(url, o = {}) {
    const args = ["-s", "-g", "-X", (o.method || "get").toUpperCase(), "-w", "\n%{http_code}"];
    for (const [k, v] of Object.entries(o.headers || {})) args.push("-H", `${k}: ${v}`);
    if (o.contentType) args.push("-H", "Content-Type: " + o.contentType);
    if (o.payload) args.push("--data-binary", o.payload);
    const out = execFileSync("curl", [...args, url], { encoding: "utf8", maxBuffer: 1 << 26 });
    const i = out.lastIndexOf("\n");
    return { getResponseCode: () => Number(out.slice(i + 1)), getContentText: () => out.slice(0, i) };
  }
};
// The after-payment step's services, in memory: order sheets, mail, the lock, triggers.
class Sheet {
  constructor(name) { this.name = name; this.cells = []; this.hidden = false; this.checkboxes = []; }
  setName(n) { this.name = n; return this; }
  getLastRow() { return this.cells.length; }
  set(r, c, v) { while (this.cells.length < r) this.cells.push([]); this.cells[r - 1][c - 1] = v; }
  getRange(r, c, nr = 1, nc = 1) {
    if (typeof r === "string") {  // A1 notation, e.g. "A2" or "B2:B"
      const m = /^([A-Z]+)(\d+)/.exec(r);
      [r, c] = [Number(m[2]), [...m[1]].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0)];
    }
    const sh = this, range = {
      setValues(v) { v.forEach((row, i) => row.forEach((x, j) => sh.set(r + i, c + j, x))); return range; },
      setValue(x) { sh.set(r, c, x); return range; },
      setFormula(f) { sh.set(r, c, f); return range; },
      insertCheckboxes() { for (let j = 0; j < nc; j++) { sh.set(r, c + j, false); sh.checkboxes.push([r, c + j]); } return range; },
      setFontWeight() { return range; }, setNumberFormat() { return range; }
    };
    return range;
  }
  setFrozenRows() { return this; }
  setColumnWidth() { return this; }
  hideSheet() { this.hidden = true; return this; }
}
const books = {}, mail = [], triggers = [];
let locks = 0;
const SpreadsheetApp = {
  create(title) {
    const id = "book" + (Object.keys(books).length + 1), sheets = [new Sheet("Sheet1")];
    return books[id] = { title, id, sheets, getId: () => id, getUrl: () => "https://docs.google.com/spreadsheets/d/" + id,
      setSpreadsheetTimeZone(z) { this.tz = z; }, getSheets: () => sheets, setActiveSheet() {},
      insertSheet(name, at) { const t = new Sheet(name); at === undefined ? sheets.push(t) : sheets.splice(at, 0, t); return t; },
      getSheetByName: n => sheets.find(t => t.name === n) || null };
  },
  openById(id) { if (!books[id]) throw new Error("no sheet " + id); return books[id]; }
};
const sandbox = {
  UrlFetchApp, console, encodeURIComponent, Date, SpreadsheetApp,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] ?? null, setProperty: (k, v) => { props[k] = String(v); } }) },
  MailApp: { sendEmail: m => { mail.push(m); if (!process.argv.includes("--check")) console.log("MAIL to", m.to, "|", m.subject); } },
  LockService: { getScriptLock: () => ({ waitLock() { locks++; }, releaseLock() { locks--; } }) },
  ScriptApp: {
    getProjectTriggers: () => triggers.map(f => ({ getHandlerFunction: () => f })),
    newTrigger: f => ({ timeBased: () => ({ everyMinutes: n => ({ create: () => triggers.push(f) }) }) })
  },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: text => ({ text, setMimeType() { return this; } })
  }
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(root + "gas/gift-checkout.gs", "utf8"), sandbox);
const call = body => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).text);
const quiet = fn => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };
quiet(() => sandbox.setup());

if (process.argv.includes("--check")) {
  let fails = 0, passes = 0;
  const eq = (name, got, want) => {
    const ok = JSON.stringify(got) === JSON.stringify(want);
    ok ? passes++ : fails++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
  };
  const stripe = path => JSON.parse(execFileSync("curl", ["-s", "https://api.stripe.com/v1/" + path,
    "-u", env.STRIPE_TEST_KEY + ":", "-H", "Stripe-Version: 2026-03-25.dahlia"], { encoding: "utf8" }));
  const good = { action: "create", mode: "test", terms_ack: true, spot: "kalihi", date: "2026-12-09",
    items: [{ box: "team", print: "mokulele", qty: 4 }, { box: "team", print: "shoreline", qty: 2 }, { box: "client", print: "malie", qty: 2 }] };
  props.TEST_TODAY = "2026-10-15";

  eq("GET says hello", JSON.parse(sandbox.doGet().text), { ok: true, service: "kawikalopez.com gift checkout" });
  const made = call(good);
  eq("a good order gets a client secret", /^cs_test_[A-Za-z0-9]+_secret_/.test(made.client_secret || ""), true);
  const id = (made.client_secret || "").split("_secret_")[0];
  const cs = stripe(`checkout/sessions/${id}?expand[]=line_items&expand[]=payment_intent`);
  eq("session form and total", [cs.ui_mode, cs.mode, cs.amount_total], ["form", "payment", 72000]);
  eq("session lines", cs.line_items.data.map(l => [l.description, l.quantity, l.amount_total]),
    [["Team box with Mokulele", 4, 32000], ["Team box with Shoreline Cascade", 2, 16000], ["Client box with Mālie", 2, 24000]]);
  eq("session metadata", cs.metadata, { boxes: "8", lines: "team_mokulele:4,team_shoreline:2,client_malie:2",
    pickup_date: "2026-12-09", pickup_spot: "kalihi", source: "bh-gift", terms_ack: "yes, gift box window checkbox" });
  eq("name collection", cs.name_collection, { business: { enabled: true, optional: true }, individual: { enabled: true, optional: false } });
  eq("no shipping address, no promo codes", [cs.shipping_address_collection, !cs.allow_promotion_codes], [null, true]);
  eq("return url", cs.return_url, "http://localhost:8781/gifts/holiday-gift-boxes?session_id={CHECKOUT_SESSION_ID}");
  eq("status of an unpaid order", call({ action: "status", mode: "test", session_id: id }), {
    status: "open", paid: false, order: "",
    spot: { id: "kalihi", name: "Kalihi Union Church", address: "2214 N. King St., Honolulu", hours: "8 am to 1 pm" },
    date: "2026-12-09", date_long: "Wednesday, December 9",
    lines: [{ box: "team", print: "mokulele", qty: 4 }, { box: "team", print: "shoreline", qty: 2 }, { box: "client", print: "malie", qty: 2 }] });

  const refuse = (name, patch, want) => eq(name, call({ ...good, ...patch }), { error: want });
  refuse("no terms tick", { terms_ack: false }, "Please tick the box to confirm you've read the terms of sale.");
  refuse("unknown prints and boxes are dropped", { items: [{ box: "team", print: "candlestick", qty: 1 }, { box: "tote", print: "malie", qty: 1 }] }, "Add at least one box first.");
  refuse("zero quantity", { items: [{ box: "team", print: "malie", qty: 0 }] }, "Add at least one box first.");
  refuse("no spot", { spot: "waikiki" }, "Please pick a pickup spot.");
  refuse("a Saturday", { date: "2026-12-12" }, "That pickup day isn't available any more. Please pick another one.");
  refuse("Pearl City on a Tuesday", { spot: "pearl", date: "2026-12-08" }, "That pickup day isn't available any more. Please pick another one.");
  refuse("after the last day", { date: "2026-12-23" }, "That pickup day isn't available any more. Please pick another one.");
  props.TEST_TODAY = "2026-12-02";
  refuse("too soon after ordering", { date: "2026-12-04" }, "That pickup day isn't available any more. Please pick another one.");
  refuse("26 boxes after Dec 1", { date: "2026-12-10", items: [{ box: "team", print: "malie", qty: 26 }] },
    "Orders of more than 25 boxes could be placed through December 1. You can still order up to 25.");
  props.TEST_TODAY = "2026-12-16";
  refuse("season closed", { date: "2026-12-22" }, "Ordering is closed for this season.");
  props.TEST_TODAY = "2026-10-15";
  eq("live mode without a live key", call({ ...good, mode: "live" }), { error: "Checkout could not start. Please try again." });
  eq("a bad session id", call({ action: "status", mode: "test", session_id: "nope" }), { error: "We couldn't find that order." });
  eq("an unknown action", call({ action: "refund", mode: "test" }), { error: "Checkout could not start. Please try again." });

  // After payment: setup, then a paid sandbox order (from test_bh_purchase.mjs) through status and the sweep.
  const [test, live] = [books[props.SHEET_TEST], books[props.SHEET_LIVE]];
  eq("setup makes a test and a live sheet", [test.title, live.title, test.tz], ["Holiday gift box orders (test)", "Holiday gift box orders", "Pacific/Honolulu"]);
  eq("sheet tabs, Lines hidden", test.sheets.map(t => t.name + (t.hidden ? " (hidden)" : "")), ["Orders", "Cookies to pack", "Prints to bring", "Lines (hidden)"]);
  eq("Orders headings", test.sheets[0].cells[0], ["Order", "Pickup day", "Spot", "Name", "Company", "Phone", "Email", "Double Boxes", "Gift boxes",
    "Prints", "Cookies packed", "Prints in", "Picked up", "Notes", "Total", "Placed", "Stripe session"]);
  eq("totals are formulas over Orders and Lines", [test.sheets[1].cells[1][0].includes("QUERY(Orders!A2:Q"), test.sheets[1].cells[6][0].includes("group by B, C"),
    test.sheets[2].cells[1][0].includes("QUERY(Lines!A2:H"), test.sheets[2].cells[11][0].includes("pivot F")], [true, true, true, true]);
  eq("sweep trigger made once", triggers, ["sweepOrders"]);
  quiet(() => sandbox.setup());
  eq("setup again changes nothing", [Object.keys(books).length, triggers.length], [2, 1]);

  const paid = [];
  for (let after = null, page; !page || page.has_more;) {
    page = stripe(`checkout/sessions?status=complete&limit=100${after ? "&starting_after=" + after : ""}`);
    paid.push(...page.data.filter(s => s.metadata?.source === "bh-gift" && s.payment_status === "paid"));
    after = page.data.at(-1)?.id;
  }
  const buy = paid.find(s => s.metadata.lines === "team_mokulele:2,client_malie:1" && s.customer_details?.email === "giftbox-test@kawikalopez.com");
  if (!buy) { console.log("FAIL  no paid sandbox order from test_bh_purchase.mjs; run it once"); process.exit(1); }
  eq("an order from before setup is left alone", call({ action: "status", mode: "test", session_id: buy.id }).order, "");
  props.SINCE_TEST = "1";  // pretend setup came before every sandbox order
  const st = call({ action: "status", mode: "test", session_id: buy.id });
  eq("status of a paid order gives its number", [st.paid, st.order, st.date_long], [true, "TEST-1001", "Monday, November 30"]);
  const orders = test.sheets[0], lines = test.sheets[3];
  const placed = new Date(buy.created * 1000 - 36e6);
  eq("Orders row", orders.cells[1], ["TEST-1001", "=DATE(2026,11,30)", "Kalihi Union Church", "Test Buyer", "Test Company", "(808) 555-0100",
    "giftbox-test@kawikalopez.com", 2, 1, "2 Mokulele, 1 Mālie", false, false, false, "", 280,
    `=DATE(${placed.getUTCFullYear()},${placed.getUTCMonth() + 1},${placed.getUTCDate()})+TIME(${placed.getUTCHours()},${placed.getUTCMinutes()},0)`, buy.id]);
  eq("checkboxes on the row", orders.checkboxes, [[2, 11], [2, 12], [2, 13]]);
  const look = (col, r) => `=IFERROR(INDEX(Orders!${col}:${col}, MATCH($A${r}, Orders!$A:$A, 0)), "")`;
  eq("Lines rows (pickup day and spot looked up from Orders, so a moved pickup is one edit)", lines.cells.slice(1), [
    ["TEST-1001", look("B", 2), look("C", 2), "Team box", "Double Box", "Mokulele", 2, buy.id],
    ["TEST-1001", look("B", 3), look("C", 3), "Client box", "Gift box", "Mālie", 1, buy.id]]);
  eq("two emails, slip (Jenn on cc in test) then confirmation", mail.map(m => [m.to, m.cc ?? null, m.subject, m.name, m.replyTo]), [
    ["kawika@elevatemediahi.com", "jennifer@touchahearthawaii.org", "[Test] Gift box order TEST-1001, pickup Mon Nov 30 at Kalihi", "Kawika Lopez Photography", "info@kawikalopez.com"],
    ["giftbox-test@kawikalopez.com", null, "[Test] Your holiday gift box order, TEST-1001", "Kawika Lopez Photography", "info@kawikalopez.com"]]);
  eq("live slips have no cc by default", sandbox.SLIP_CC.live, "");
  const hour = placed.getUTCHours();
  eq("packing slip text", mail[0].body, "TEST ORDER. Nothing was charged and nothing needs packing.\n\nPacking slip, order TEST-1001\n\n" +
    "Pickup: Monday, November 30, 8 am to 1 pm, Kalihi Union Church\nCustomer: Test Buyer (Test Company)\nPhone: (808) 555-0100\n" +
    `Email: giftbox-test@kawikalopez.com\nPlaced: ${sandbox.bhLong(placed.toISOString().slice(0, 10)).split(", ")[1]}, ${hour % 12 || 12}:${String(placed.getUTCMinutes()).padStart(2, "0")} ${hour < 12 ? "am" : "pm"}\n\n` +
    "2 x Team boxes (Double Box), Mokulele print\n1 x Client box (Gift box), Mālie print\n\nCookies for this order: 2 Double Boxes, 1 Gift box\n\n" +
    `Kawika brings the matted prints to Kalihi with the weekly print drop. Every order is also in the shared sheet, https://docs.google.com/spreadsheets/d/${props.SHEET_TEST}\n`);
  eq("packing slip html has the lines", ["Packing slip, order TEST-1001", "<td style=\"padding:6px 12px 6px 0;vertical-align:top;border-bottom:1px solid #ddd;\">Mālie</td>", "Test order. Nothing was charged"].map(t => mail[0].htmlBody.includes(t)), [true, true, true]);
  eq("confirmation text", mail[1].body, "This is a test order. Nothing was charged.\n\nHi Test,\n\nThank you for your order! Your order number is TEST-1001.\n\n" +
    "Pick up your gift boxes on Monday, November 30, between 8 am and 1 pm, at Kalihi Union Church, 2214 N. King St., Honolulu. On your pickup day, call Jennifer at (808) 970-1633 when you arrive in the Kalihi Union Church parking lot. If someone else is picking up for you, they can show this email.\n\n" +
    "What you ordered\n2 Team boxes with Mokulele\n1 Client box with Mālie\nTotal $280\n\n" +
    "Questions, or need to change something? Reply to this email or call (808) 204-4575.\n\nMahalo for supporting Touch A Heart's job training and a local artist.\n\nKawika Lopez\nKawika Lopez Photography\n");
  eq("confirmation html: the note, with the order's details", ["Thank you, Test.", "Your order number is <b>TEST-1001</b>", "This is a test order.",
    "border-top:6px solid #4f5e3f", "border-left:4px solid #4f5e3f", "Monday, November 30", "call Jennifer at (808) 970-1633",
    "prints/mokulele-480.jpg", "prints/malie-480.jpg", "2 Team boxes with Mokulele", "Each with a Baker&#39;s Heart Double Box", "$160", "$120", "<b>$280</b>"]
    .filter(t => !mail[1].htmlBody.replace(/'/g, "&#39;").includes(t)), []);
  eq("the same order again: same number, no new row or email", [call({ action: "status", mode: "test", session_id: buy.id }).order, orders.cells.length, mail.length], ["TEST-1001", 2, 2]);

  const other = paid.find(s => s.id !== buy.id);
  if (other) {
    const keep = props.SHEET_TEST;
    delete props.SHEET_TEST;
    const err = console.error; console.error = () => {};
    const st2 = call({ action: "status", mode: "test", session_id: other.id });
    console.error = err;
    props.SHEET_TEST = keep;
    eq("no sheet yet: the thank-you still loads, the sweep gets it later", [st2.paid, st2.order, orders.cells.length, mail.length, props["order_" + other.id] ?? null], [true, "", 2, 2, null]);
  }

  sandbox.SWEEP_DAYS = 4000;  // reach back to every sandbox order
  quiet(() => sandbox.sweepOrders());
  const ids = orders.cells.slice(1).map(r => r[16]);
  eq("sweep: one row per paid order, no repeats", [ids.length, new Set(ids).size], [paid.length, paid.length]);
  eq("sweep: numbers run in order, the first kept", [ids.indexOf(buy.id), orders.cells.slice(1).map(r => r[0]).join() === paid.map((_, i) => "TEST-" + (1001 + i)).join()], [0, true]);
  eq("sweep: a slip and a confirmation for each", mail.length, paid.length * 2);
  eq("sweep: Lines match the boxes", lines.cells.slice(1).reduce((a, r) => a + r[6], 0), paid.reduce((a, s) => a + Number(s.metadata.boxes), 0));
  const pearlMail = mail.find(m => m.body.includes("at Pearl City Community Church, 933 Lehua Ave., Pearl City."));
  eq("Pearl City confirmation: the table, not the phone call", pearlMail ? [pearlMail.body.includes("Pearl City. Give your name or order number at the Touch A Heart table when you pick up. If someone else"), pearlMail.body.includes("970-1633")] : "no Pearl City order in the sandbox", [true, false]);
  quiet(() => sandbox.sweepOrders());
  eq("sweep again: nothing new", [orders.cells.length - 1, mail.length], [paid.length, paid.length * 2]);
  eq("live sheet untouched, lock released", [live.sheets[0].cells.length, locks], [1, 0]);

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

props.SINCE_TEST = "1";  // local page tests can number any paid sandbox order
createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (req.method !== "POST") { res.writeHead(200, cors); res.end(sandbox.doGet().text); return; }
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    const out = sandbox.doPost({ postData: { contents: body } });
    console.log("POST", body.slice(0, 160), "->", out.text.slice(0, 120));
    res.writeHead(200, cors);
    res.end(out.text);
  });
}).listen(PORT, () => console.log(`gift checkout (test mode) on http://localhost:${PORT}/  BASE_TEST=${props.BASE_TEST}  TEST_TODAY=${props.TEST_TODAY || "real"}`));
