// Runs gas/gift-checkout.gs locally with the Apps Script services stubbed, against the Stripe sandbox.
//
//   node tools/bh_checkout_dev.mjs            the checkout on http://localhost:8782/ for the local page
//   node tools/bh_checkout_dev.mjs --check    scenario checks, then exit (non-zero on any failure)
//
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
    const args = ["-s", "-X", (o.method || "get").toUpperCase(), "-w", "\n%{http_code}"];
    for (const [k, v] of Object.entries(o.headers || {})) args.push("-H", `${k}: ${v}`);
    if (o.contentType) args.push("-H", "Content-Type: " + o.contentType);
    if (o.payload) args.push("--data-binary", o.payload);
    const out = execFileSync("curl", [...args, url], { encoding: "utf8", maxBuffer: 1 << 26 });
    const i = out.lastIndexOf("\n");
    return { getResponseCode: () => Number(out.slice(i + 1)), getContentText: () => out.slice(0, i) };
  }
};
const sandbox = {
  UrlFetchApp, console, encodeURIComponent, Date,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: text => ({ text, setMimeType() { return this; } })
  }
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(root + "gas/gift-checkout.gs", "utf8"), sandbox);
const call = body => JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify(body) } }).text);

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
    status: "open", paid: false,
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

  console.log(`\n${passes} passed, ${fails} failed`);
  process.exit(fails ? 1 : 0);
}

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
