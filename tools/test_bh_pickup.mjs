// Pickup and order rules for the holiday gift boxes (assets/js/bh-pickup.js).
// Run: node tools/test_bh_pickup.mjs
import { createRequire } from "module";
import { readFileSync, existsSync } from "fs";

const require = createRequire(import.meta.url);
const BH = require("../assets/js/bh-pickup.js");
const root = new URL("..", import.meta.url).pathname;
let fails = 0, passes = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? passes++ : fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

// Today in Hawaiʻi (UTC minus 10)
eq("11:59 pm Oct 15 in Hawaiʻi", BH.today(Date.UTC(2026, 9, 16, 9, 59)), "2026-10-15");
eq("midnight Oct 16 in Hawaiʻi", BH.today(Date.UTC(2026, 9, 16, 10, 0)), "2026-10-16");

// Business days
eq("Saturday", BH.isBusinessDay("2026-11-21"), false);
eq("Thanksgiving", BH.isBusinessDay("2026-11-26"), false);
eq("day after Thanksgiving", BH.isBusinessDay("2026-11-27"), false);
eq("Christmas Eve", BH.isBusinessDay("2026-12-24"), false);
eq("Christmas", BH.isBusinessDay("2026-12-25"), false);
eq("an ordinary Monday", BH.isBusinessDay("2026-11-23"), true);
eq("five business days after Nov 23 skips Thanksgiving", BH.addBusinessDays("2026-11-23", 5), "2026-12-02");

// First Kalihi pickup (the tracker's worked examples)
for (const [ordered, want] of [["2026-10-20", "2026-11-16"], ["2026-11-13", "2026-11-20"], ["2026-11-16", "2026-11-23"],
  ["2026-11-23", "2026-12-02"], ["2026-12-15", "2026-12-22"], ["2026-12-16", null]]) {
  eq(`Kalihi, ordered ${ordered}`, BH.firstOpen("kalihi", ordered), want);
}
// First Pearl City pickup (Wednesdays only)
for (const [ordered, want] of [["2026-10-15", "2026-11-18"], ["2026-11-16", "2026-11-25"], ["2026-11-19", "2026-12-02"],
  ["2026-12-09", "2026-12-16"], ["2026-12-10", null]]) {
  eq(`Pearl City, ordered ${ordered}`, BH.firstOpen("pearl", ordered), want);
}

// Every open day of the season, ordering on Oct 15
const openDays = spot => {
  const out = [];
  for (let d = "2026-11-01"; d <= "2026-12-31"; d = BH.shift(d, 1)) if (BH.open(d, spot, "2026-10-15")) out.push(d);
  return out;
};
eq("Kalihi open days", openDays("kalihi"), ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20",
  "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04",
  "2026-12-07", "2026-12-08", "2026-12-09", "2026-12-10", "2026-12-11", "2026-12-14", "2026-12-15", "2026-12-16",
  "2026-12-17", "2026-12-18", "2026-12-21", "2026-12-22"]);
eq("Pearl City open days", openDays("pearl"), ["2026-11-18", "2026-11-25", "2026-12-02", "2026-12-09", "2026-12-16"]);

// Refusals
eq("unknown spot", BH.open("2026-12-09", "waikiki", "2026-10-15"), false);
eq("not a date", BH.open("Dec 9", "kalihi", "2026-10-15"), false);
eq("too soon after ordering", BH.open("2026-11-20", "kalihi", "2026-11-16"), false);
eq("after the last day", BH.open("2026-12-23", "kalihi", "2026-10-15"), false);
eq("Pearl City on a Tuesday", BH.open("2026-12-08", "pearl", "2026-10-15"), false);

// Order size and the season
eq("no boxes", BH.canOrder(0, "2026-10-15"), { ok: false, why: "Add at least one box first." });
eq("26 boxes on Dec 1", BH.canOrder(26, "2026-12-01"), { ok: true });
eq("26 boxes on Dec 2", BH.canOrder(26, "2026-12-02"),
  { ok: false, why: "Orders of more than 25 boxes could be placed through December 1. You can still order up to 25." });
eq("25 boxes on Dec 2", BH.canOrder(25, "2026-12-02"), { ok: true });
eq("open on Dec 15", BH.canOrder(1, "2026-12-15"), { ok: true });
eq("closed on Dec 16", BH.canOrder(1, "2026-12-16"), { ok: false, why: "Ordering is closed for this season." });
eq("long date", BH.long("2026-12-09"), "Wednesday, December 9");
eq("last Pearl City day", BH.lastOpen("pearl", "2026-10-15"), "2026-12-16");
eq("last Kalihi day", BH.lastOpen("kalihi", "2026-10-15"), "2026-12-22");

// Boxes and prints the catalog and the page rely on
eq("boxes", Object.keys(BH.RULES.boxes), ["team", "client"]);
eq("prints", BH.RULES.prints.map(p => p.id), ["mokulele", "mokulua", "shoreline", "leahi", "kahana", "malie"]);
eq("print ids have no underscores (lookup keys split on them)", BH.RULES.prints.every(p => !p.id.includes("_")), true);

// The Apps Script carries an identical copy of the rules block (Task 3 adds the script).
const block = f => {
  if (!existsSync(root + f)) return null;
  const s = readFileSync(root + f, "utf8");
  const a = s.indexOf("/* BEGIN bhRules"), b = s.indexOf("/* END bhRules */");
  return a < 0 || b < 0 ? null : s.slice(a, b);
};
if (process.argv.includes("--drift")) {
  eq("rules block in gas/gift-checkout.gs matches assets/js/bh-pickup.js",
    block("gas/gift-checkout.gs") !== null && block("gas/gift-checkout.gs") === block("assets/js/bh-pickup.js"), true);
}

console.log(`\n${passes} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
