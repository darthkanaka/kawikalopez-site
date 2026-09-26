// axe-core accessibility check (WCAG 2.1 A and AA plus best practice) at three widths.
// Covers one page of each type from data/pages.json, plus every page with PAGES=all.
// Run the preview first: python3 tools/serve.py 8779 --prefix /kawikalopez-site, then: cd tools && node a11y.mjs
import { chromium } from "playwright";
import { createRequire } from "module";
import { readFileSync } from "fs";

const require = createRequire(import.meta.url);
const axePath = require.resolve("axe-core/axe.min.js");
const BASE = process.env.BASE || "http://localhost:8779/kawikalopez-site";
const all = JSON.parse(readFileSync(new URL("../data/pages.json", import.meta.url)));
const seen = new Set();
const pages = process.env.PAGES === "all" ? all : all.filter(p => (seen.has(p.type) ? false : seen.add(p.type)));
const b = await chromium.launch();
let total = 0;
for (const width of [1440, 1024, 390]) {
  for (const pg of pages) {
    const p = await b.newPage({ viewport: { width, height: 900 } });
    await p.goto(BASE + "/" + pg.path, { waitUntil: "networkidle" });
    await p.addScriptTag({ path: axePath });
    const r = await p.evaluate(async () => await window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] } }));
    const line = `${String(width).padStart(4)} /${pg.path || ""}`;
    console.log(`${line.padEnd(40)} ${r.violations.length} violations, ${r.passes.length} passed`);
    r.violations.forEach(v => { total++; console.log(`     [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}) ${v.nodes.slice(0, 2).map(n => n.target.join(" ")).join(" | ")}`); });
    await p.close();
  }
}
console.log("\n" + (total ? `${total} violations` : "NO ACCESSIBILITY VIOLATIONS"));
await b.close();
process.exit(total ? 1 : 0);
