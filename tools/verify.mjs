// Site checks over every page the build rendered (data/pages.json).
// Run the preview first: python3 tools/serve.py 8779 --prefix /kawikalopez-site
// Then: cd tools && node verify.mjs   (BASE=http://localhost:8779/kawikalopez-site by default,
//       the same subpath as staging, so the 404 page's root-relative links resolve)
//       EXPECT_NOINDEX=0 node verify.mjs       for a production build
//
// Checks per page: page errors, console errors, failed requests, exactly one h1, alt on every
// image, no bare # links, labelled form fields, horizontal overflow, internal links resolve,
// JSON-LD parses, canonical present, noindex matches the build mode, title and description
// lengths. Then: the product picker updates price and room, the site reads with JS off, the
// mobile menu opens, and reduced motion is honored.
import { chromium } from "playwright";
import { readFileSync } from "fs";

const BASE = process.env.BASE || "http://localhost:8779/kawikalopez-site";
const EXPECT_NOINDEX = process.env.EXPECT_NOINDEX !== "0";
const pages = JSON.parse(readFileSync(new URL("../data/pages.json", import.meta.url)));
const b = await chromium.launch();
const problems = [];
const checked = new Map();

async function open(ctxOpts = {}) {
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, ...ctxOpts });
  const p = await ctx.newPage();
  p.on("pageerror", e => problems.push("JS ERROR: " + e.message));
  p.on("console", m => { if (m.type() === "error") problems.push("CONSOLE: " + m.text()); });
  p.on("requestfailed", r => problems.push("REQUEST FAILED: " + r.url()));
  return { ctx, p };
}

const { ctx, p } = await open();
for (const pg of pages) {
  const url = "/" + pg.path;
  const res = await p.goto(BASE + url, { waitUntil: "networkidle" });
  const status = res ? res.status() : 0;
  const want = pg.type === "404" ? 200 : 200;
  if (status !== want) problems.push(`${url}: HTTP ${status}`);
  const r = await p.evaluate(() => {
    const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => { try { JSON.parse(s.textContent); return true; } catch { return false; } });
    return {
      h1: document.querySelectorAll("h1").length,
      noAlt: [...document.querySelectorAll("img")].filter(i => !i.hasAttribute("alt")).length,
      bare: document.querySelectorAll('a[href="#"]').length,
      unlabeled: [...document.querySelectorAll("input,select,textarea")].filter(i => i.type !== "hidden" && !i.closest("label") && !(i.id && document.querySelector(`label[for="${i.id}"]`)) && !i.getAttribute("aria-label")).length,
      noindex: document.querySelectorAll('meta[name="robots"][content*="noindex"]').length,
      over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ldOk: ld.length > 0 && ld.every(Boolean),
      canonical: (document.querySelector('link[rel="canonical"]') || {}).href || "",
      title: document.title,
      desc: (document.querySelector('meta[name="description"]') || {}).content || "",
    };
  });
  const flag = (cond, msg) => { if (cond) problems.push(`${url}: ${msg}`); };
  flag(r.h1 !== 1, `${r.h1} h1 elements`);
  flag(r.noAlt, `${r.noAlt} images without alt`);
  flag(r.bare, "bare # link");
  flag(r.unlabeled, `${r.unlabeled} unlabeled fields`);
  flag(r.over > 0, `${r.over}px horizontal overflow`);
  flag(!r.ldOk, "JSON-LD missing or does not parse");
  flag(!r.canonical, "no canonical");
  flag(EXPECT_NOINDEX && pg.type !== "404" && !r.noindex, "missing staging noindex");
  flag(!EXPECT_NOINDEX && pg.indexable && r.noindex, "STILL NOINDEX");
  flag(pg.indexable && r.title.length > 65, `title ${r.title.length} chars`);
  flag(pg.indexable && (r.desc.length < 50 || r.desc.length > 160), `description ${r.desc.length} chars`);

  const hrefs = await p.$$eval("a[href]", as => as.map(a => a.getAttribute("href")).filter(h => h && !h.startsWith("#") && !/^(https?:|mailto:|tel:)/.test(h)));
  for (const h of new Set(hrefs)) {
    const abs = new URL(h, BASE + url).href.split("#")[0];
    if (!checked.has(abs)) {
      const res = await p.request.get(abs);
      checked.set(abs, res.status());
    }
    if (checked.get(abs) >= 400) problems.push(`${url}: link ${h} -> ${checked.get(abs)}`);
  }
  console.log(`${url.padEnd(28)} h1=${r.h1} alt-missing=${r.noAlt} overflow=${r.over} title=${r.title.length} desc=${r.desc.length}`);
}
await ctx.close();

// The picker updates the price, the order link and the room.
{
  const product = pages.find(x => x.type === "product");
  const { ctx, p } = await open();
  await p.goto(BASE + "/" + product.path, { waitUntil: "networkidle" });
  const before = await p.evaluate(() => ({ price: document.querySelector("[data-price]").textContent, w: document.querySelector("[data-room-print]")?.style.width, href: document.querySelector("[data-buy]").href }));
  const labels = await p.$$(".opt:first-of-type .pill");
  await labels[0].click();
  await p.click('.pill:has(input[value="canvas"])');
  await p.waitForTimeout(450);
  const after = await p.evaluate(() => ({ price: document.querySelector("[data-price]").textContent, w: document.querySelector("[data-room-print]")?.style.width, href: document.querySelector("[data-buy]").href, canvas: document.querySelector("[data-room]")?.classList.contains("is-canvas") }));
  console.log(`picker on /${product.path}: ${before.price} -> ${after.price}, room width ${before.w} -> ${after.w}, canvas=${after.canvas}`);
  if (before.price === after.price || before.w === after.w || before.href === after.href || !after.canvas) problems.push("picker did not update price, link or room");
  await ctx.close();
}

// Without JS nothing is stuck invisible and the prices are still readable.
{
  const { ctx, p } = await open({ javaScriptEnabled: false });
  for (const url of ["/", "/" + pages.find(x => x.type === "product").path]) {
    await p.goto(BASE + url, { waitUntil: "load" });
    const r = await p.evaluate(() => ({
      hidden: [...document.querySelectorAll("h1,h2,h3,p,img,.card")].filter(el => { const c = getComputedStyle(el); return c.opacity === "0" || c.visibility === "hidden"; }).length,
      text: document.body.innerText.replace(/\s+/g, " ").trim().length }));
    console.log(`no-JS ${url}: ${r.text} chars, ${r.hidden} invisible`);
    if (r.hidden) problems.push(`no-JS ${url}: ${r.hidden} invisible`);
  }
  await ctx.close();
}

// Phone: the menu opens and nothing overflows.
{
  const { ctx, p } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  for (const url of ["/", "/" + pages.find(x => x.type === "product").path, "/store/"]) {
    await p.goto(BASE + url, { waitUntil: "networkidle" });
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 0) problems.push(`mobile ${url}: ${over}px overflow`);
  }
  await p.goto(BASE + "/", { waitUntil: "networkidle" });
  await p.click(".menu summary");
  const open_ = await p.isVisible(".menu-list");
  console.log(`mobile: menu opens=${open_}`);
  if (!open_) problems.push("mobile menu does not open");
  await ctx.close();
}

// Reduced motion: transitions are effectively off.
{
  const { ctx, p } = await open({ reducedMotion: "reduce" });
  await p.goto(BASE + "/" + pages.find(x => x.type === "product").path, { waitUntil: "networkidle" });
  const t = await p.evaluate(() => getComputedStyle(document.querySelector("[data-room-print]")).transitionDuration);
  console.log(`reduced motion: room transition ${t}`);
  if (!/^0\.0+1s|^1e-05s|^0s/.test(t.split(",")[0])) problems.push(`reduced motion: transition ${t}`);
  await ctx.close();
}

console.log("\n" + (problems.length ? "PROBLEMS:\n- " + [...new Set(problems)].join("\n- ") : `ALL CHECKS PASSED (${pages.length} pages, ${checked.size} links)`));
await b.close();
process.exit(problems.length ? 1 : 0);
