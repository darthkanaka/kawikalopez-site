// Checks the cart shipping math (shipQuote) against the lab's own quotes.
//   cd tools && node test_shipping.mjs
// 1. shipQuote in assets/js/site.js and gas/checkout.gs is the same code.
// 2. One print of every shippable size and material costs exactly the flat rate in
//    data/shipping.yml (rates:), which came from 354 calculator lookups.
// 3. Multi-print orders match the quantity probes in harvest/shipping-calculator-model.md,
//    and mainland orders over the freight jump split into boxes.
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import vm from "vm";

const root = new URL("..", import.meta.url).pathname;
const block = f => {
  const t = readFileSync(root + f, "utf8");
  const m = t.match(/\/\* BEGIN shipQuote[\s\S]*?\/\* END shipQuote \*\//);
  if (!m) throw new Error("no shipQuote block in " + f);
  return m[0];
};
const a = block("assets/js/site.js"), b = block("gas/checkout.gs");
const fails = [];
if (a !== b) fails.push("shipQuote differs between assets/js/site.js and gas/checkout.gs");

const ctx = {};
vm.runInNewContext(a + "\nthis.shipQuote = shipQuote;", ctx);
const ship = JSON.parse(execFileSync("python3", ["-c",
  "import json,yaml;print(json.dumps(yaml.safe_load(open('data/shipping.yml'))))"], { cwd: root }));
const model = Object.assign({}, ship.cart, {
  max_long_edge_in: ship.max_ship_long_edge_in, max_short_edge_in: ship.max_ship_short_edge_in });
const q = items => ctx.shipQuote(model, items);
const eq = (label, got, want) => { if (got !== want) fails.push(`${label}: got ${got}, want ${want}`); };

let n = 0;
for (const [material, sizes] of Object.entries(ship.rates)) {
  for (const [size, want] of Object.entries(sizes)) {
    const [w, h] = size.split("x").map(Number);
    const r = q([{ w, h, qty: 1, material }]);
    eq(`${material} ${size} Hawaiʻi`, r.hi, want.hi);
    eq(`${material} ${size} mainland`, r.mainland, want.mainland);
    n++;
  }
}

// Lab quotes before markup (harvest/shipping-calculator-model.md), metal.
const probes = [
  [[{ w: 16, h: 16, qty: 2 }], 5084, 9500],
  [[{ w: 16, h: 16, qty: 3 }], 6626, 10500],
  [[{ w: 36, h: 24, qty: 1 }], 7190, 14500],
  [[{ w: 24, h: 16, qty: 1 }, { w: 16, h: 16, qty: 1 }], 2000 + 640 * 6 + 12, 10000],
];
for (const [items, hi, ml] of probes) {
  const r = q(items.map(i => ({ material: "metal", ...i })));
  const label = items.map(i => `${i.qty}x${i.w}x${i.h}`).join("+");
  eq(label + " Hawaiʻi quote", r.hiQuote, hi);
  eq(label + " mainland quote", r.mainlandQuote, ml);
}

// Over the freight jump: two 24 x 30s ship as two boxes, not one $410 box.
const two = q([{ w: 24, h: 30, qty: 2, material: "metal" }]);
eq("2x24x30 boxes", two.boxes.length, 2);
eq("2x24x30 mainland quote", two.mainlandQuote, 21000);
eq("2x24x30 Hawaiʻi quote (one order)", two.hiQuote, 10652);
const four = q([{ w: 24, h: 16, qty: 4, material: "canvas" }]);
eq("4x24x16 boxes", four.boxes.length, 2);
// Pickup only when anything is too big to ship.
eq("72x24 pickup only", q([{ w: 72, h: 24, qty: 1, material: "metal" }, { w: 18, h: 12, qty: 1, material: "metal" }]).pickupOnly, true);
eq("40x40 pickup only", q([{ w: 40, h: 40, qty: 1, material: "canvas" }]).pickupOnly, true);

// Matted prints ship from Kawika in mailers of up to three, a flat charge each, on top of any lab
// shipping, and never into a lab box.
const mm = model.matted;
eq("3 matted, one mailer, Hawaiʻi", q([{ w: 8, h: 10, qty: 3, material: "matted" }]).hi, mm.hi);
eq("3 matted, one mailer, mainland", q([{ w: 8, h: 12, qty: 3, material: "matted" }]).mainland, mm.mainland);
const fourM = q([{ w: 8, h: 10, qty: 2, material: "matted" }, { w: 8, h: 12, qty: 2, material: "matted" }]);
eq("4 matted, two mailers", fourM.mailers, 2);
eq("4 matted mainland", fourM.mainland, 2 * mm.mainland);
eq("4 matted, no lab boxes", fourM.boxes.length, 0);
const mixed = q([{ w: 24, h: 16, qty: 1, material: "metal" }, { w: 8, h: 10, qty: 1, material: "matted" }]);
const metalOnly = q([{ w: 24, h: 16, qty: 1, material: "metal" }]);
eq("metal + matted Hawaiʻi", mixed.hi, metalOnly.hi + mm.hi);
eq("metal + matted mainland", mixed.mainland, metalOnly.mainland + mm.mainland);
eq("metal + matted lab boxes", mixed.boxes.length, 1);
eq("oversize + matted is pickup only", q([{ w: 72, h: 24, qty: 1, material: "metal" }, { w: 8, h: 10, qty: 1, material: "matted" }]).pickupOnly, true);

if (fails.length) { console.log(fails.join("\n")); console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log(`shipping OK: ${n} single-print rates match, multi-print probes match, boxes split, oversize is pickup only, matted mailers add up`);
