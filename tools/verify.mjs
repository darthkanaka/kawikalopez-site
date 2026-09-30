// Site checks over every page the build rendered (data/pages.json).
// Run the preview first: python3 tools/serve.py 8779 --prefix /kawikalopez-site
// Then: cd tools && node verify.mjs   (BASE=http://localhost:8779/kawikalopez-site by default,
//       the same subpath as staging, so the 404 page's root-relative links resolve)
//       EXPECT_NOINDEX=0 node verify.mjs       for a production build
//
// Checks per page: page errors, console errors, failed requests, exactly one h1, alt on every
// image, no bare # links, labelled form fields, horizontal overflow, internal links resolve,
// JSON-LD parses, canonical present, noindex matches the build mode, title and description
// lengths. On print pages: one buy button, the configured default size and material checked,
// and Google's shipping data matching the amounts shown. Then: the picker updates price,
// shipping, link and room; a ?size= link opens that print; the site reads with JS off; the
// mobile menu opens; and reduced motion is honored.
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
  // Never send test visits to Google Analytics: the tag is stubbed, events still land in dataLayer.
  await ctx.route(/googletagmanager\.com|google-analytics\.com/, r => r.fulfill({ status: 204, body: "" }));
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
  if (pg.type === "product") {
    const q = await p.evaluate(() => {
      const shown = el => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
      const num = el => el ? Number(el.textContent.replace(/[^0-9.]/g, "")) : null;
      const graph = [].concat(...[...document.querySelectorAll('script[type="application/ld+json"]')].map(s => JSON.parse(s.textContent)["@graph"] || []));
      const byId = Object.fromEntries(graph.filter(n => n["@id"]).map(n => [n["@id"], n]));
      const group = graph.find(n => n["@type"] === "ProductGroup");
      const data = JSON.parse(document.querySelector("[data-picker]").getAttribute("data-picker"));
      const variant = group && group.hasVariant.find(v => v.sku === data.default);
      const ld = {};
      for (const ref of [].concat(variant ? variant.offers.shippingDetails || [] : [])) {
        const node = ref["@id"] ? byId[ref["@id"]] : ref;
        if (node && node.shippingRate) ld[node.shippingDestination.addressRegion.includes("HI") ? "hi" : "mainland"] = Number(node.shippingRate.value);
      }
      return {
        buttons: [...document.querySelectorAll(".btn-buy")].filter(shown).length,
        size: (document.querySelector('input[name="size"]:checked') || {}).value,
        material: (document.querySelector('input[name="material"]:checked') || {}).value,
        shownRates: { hi: shown(document.querySelector('[data-ship-row="hi"]')) ? num(document.querySelector('[data-ship="hi"]')) : null,
                      mainland: shown(document.querySelector('[data-ship-row="mainland"]')) ? num(document.querySelector('[data-ship="mainland"]')) : null },
        ld, hasGroup: !!group, offers: group ? group.hasVariant.length : 0, variants: data.variants.length,
      };
    });
    const m = pg.meta || {};
    flag(q.buttons !== 1, `${q.buttons} visible buy buttons (want 1)`);
    flag(m.default_size && q.size !== m.default_size, `default size ${q.size}, want ${m.default_size}`);
    flag(m.default_material && q.material !== m.default_material, `default material ${q.material}, want ${m.default_material}`);
    flag(!q.hasGroup || q.offers !== q.variants, `structured data has ${q.offers} offers for ${q.variants} variants`);
    for (const z of ["hi", "mainland"]) flag((q.ld[z] ?? null) !== q.shownRates[z], `${z} shipping ${q.shownRates[z]} on the page but ${q.ld[z]} in structured data`);
  }

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
  const before = await p.evaluate(() => ({ price: document.querySelector("[data-price]").textContent, ship: document.querySelector('[data-ship="hi"]')?.textContent, w: document.querySelector("[data-room-print]")?.style.width, href: document.querySelector("[data-buy]").href }));
  const labels = await p.$$(".opt-size .tier");
  await labels[0].click();
  await p.click('.pill:has(input[value="canvas"])');
  await p.waitForTimeout(450);
  const after = await p.evaluate(() => ({ price: document.querySelector("[data-price]").textContent, ship: document.querySelector('[data-ship="hi"]')?.textContent, w: document.querySelector("[data-room-print]")?.style.width, href: document.querySelector("[data-buy]").href, canvas: document.querySelector("[data-room]")?.classList.contains("is-canvas") }));
  console.log(`picker on /${product.path}: ${before.price} -> ${after.price}, shipping ${before.ship} -> ${after.ship}, room width ${before.w} -> ${after.w}, canvas=${after.canvas}`);
  if (before.price === after.price || before.ship === after.ship || before.w === after.w || before.href === after.href || !after.canvas) problems.push("picker did not update price, shipping, link or room");
  await ctx.close();
}

// The matted print: its card sets $55, hides the material choice, ships at its own rates, and the
// room switches to the side table scene with the print in its mat. A ?size= link opens it too.
{
  const product = pages.find(x => x.type === "product" && ["vertical", "horizontal"].includes((x.meta || {}).orientation));
  const { ctx, p } = await open();
  await p.goto(BASE + "/" + product.path, { waitUntil: "networkidle" });
  const data = await p.evaluate(() => JSON.parse(document.querySelector("[data-picker]").getAttribute("data-picker")));
  const mv = data.variants.find(v => v.material === "matted");
  if (!mv) problems.push(`/${product.path}: no matted print`);
  else {
    await p.click(".tier-matted");
    await p.waitForTimeout(100);
    const m = await p.evaluate(() => ({
      price: document.querySelector("[data-price]").textContent,
      materialShown: document.querySelector(".opt-material").getClientRects().length > 0,
      matted: document.querySelector("[data-room]").classList.contains("is-matted"),
      scene: [...document.querySelectorAll("[data-scene-img]")].filter(el => !el.hidden).map(el => el.getAttribute("data-scene-img")),
      hi: document.querySelector('[data-ship="hi"]').textContent, id: document.querySelector("[data-add]")?.getAttribute("data-id"),
      photo: document.querySelector("[data-room-photo]").style.width }));
    console.log(`matted on /${product.path}: ${m.price}, material shown=${m.materialShown}, scene=${m.scene}, Hawaiʻi ${m.hi}, photo ${m.photo}`);
    if (m.price !== "$" + mv.price || m.materialShown || !m.matted || m.scene.length !== 1 || m.scene[0] === "living-dark" ||
        m.hi !== "$" + mv.rates.hi || (m.id && m.id !== mv.id) || !m.photo) problems.push("matted print did not switch price, material, scene, shipping or mat");
    await p.goto(BASE + "/" + product.path + `?size=${mv.w}x${mv.h}&material=matted`, { waitUntil: "networkidle" });
    const q = await p.evaluate(() => ({ price: document.querySelector("[data-price]").textContent, matted: document.querySelector("[data-room]").classList.contains("is-matted") }));
    if (q.price !== "$" + mv.price || !q.matted) problems.push(`?size link did not open ${mv.id}`);
  }
  await ctx.close();
}

// A ?size=&material= link opens the page on that print; a value that isn't sold leaves the default.
{
  const product = pages.find(x => x.type === "product");
  const { ctx, p } = await open();
  await p.goto(BASE + "/" + product.path, { waitUntil: "networkidle" });
  const base = await p.evaluate(() => ({ data: JSON.parse(document.querySelector("[data-picker]").getAttribute("data-picker")),
                                         price: document.querySelector("[data-price]").textContent, w: document.querySelector("[data-room-print]")?.style.width }));
  const def = base.data.variants.find(v => v.id === base.data.default);
  const v = base.data.variants.find(x => x.ships && x.size !== def.size && x.material !== def.material);
  await p.goto(BASE + "/" + product.path + `?size=${v.w}x${v.h}&material=${v.material}`, { waitUntil: "networkidle" });
  const got = await p.evaluate(() => ({ price: document.querySelector("[data-price]").textContent, w: document.querySelector("[data-room-print]")?.style.width,
                                         id: document.querySelector("[data-add]")?.getAttribute("data-id"), size: document.querySelector('input[name="size"]:checked').value }));
  const want = "$" + Number(v.price).toLocaleString("en-US");
  console.log(`?size link on /${product.path}: ${v.size} ${v.material} -> ${got.price}, room width ${base.w} -> ${got.w}`);
  if (got.price !== want || got.size !== v.size || (got.id && got.id !== v.id) || got.w === base.w) problems.push(`?size link did not open ${v.id}`);
  await p.goto(BASE + "/" + product.path + "?size=99x99&material=gold", { waitUntil: "networkidle" });
  const bad = await p.evaluate(() => document.querySelector("[data-price]").textContent);
  if (bad !== base.price) problems.push(`a ?size link for a size that isn't sold changed the page (${bad})`);
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
