// A real sandbox purchase through the gift box page, the dev checkout and Stripe's form.
// Needs: the preview build served on :8781 (or BASE=<another copy>) and a checkout endpoint built in:
// the deployed script, or `PORT=8792 node tools/bh_checkout_dev.mjs` with KL_BH_ENDPOINT. Stripe returns
// to the script's BASE_TEST, so the copy under test must be that address.
// Run from tools/: node test_bh_purchase.mjs
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { homedir } from "os";

const env = Object.fromEntries(readFileSync(homedir() + "/.claude/credentials/kawikalopez-stripe.env", "utf8")
  .split("\n").filter(l => l.includes("=")).map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const stripe = path => JSON.parse(execFileSync("curl", ["-s", "https://api.stripe.com/v1/" + path, "-u", env.STRIPE_TEST_KEY + ":",
  "-H", "Stripe-Version: 2026-03-25.dahlia"], { encoding: "utf8" }));
let fails = 0, passes = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? passes++ : fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`); };

const b = await chromium.launch();
// A tall window: in test mode Stripe floats a badge at the bottom right of the screen, and on a
// 900 px screen it sits over the Pay button, so a click there never reaches it.
const p = await b.newPage({ viewport: { width: 1440, height: 1700 } });
p.on("pageerror", e => console.log("JS ERROR:", e.message));
p.on("console", m => { if (/checkout:/.test(m.text())) console.log("CONSOLE:", m.text()); });
await p.goto((process.env.BASE || "http://localhost:8781") + "/gifts/holiday-gift-boxes", { waitUntil: "networkidle" });
await p.click('[data-open="team"]');
await p.click('.tile[data-id="mokulele"] [data-step="1"]'); await p.click('.tile[data-id="mokulele"] [data-step="1"]');
await p.click('.co-tabs [data-box="client"]'); await p.click('.tile[data-id="malie"] [data-step="1"]');
await p.check('input[value="kalihi"]');
const day = await p.evaluate(() => { const b = [...document.querySelectorAll('#co-cal [data-day]')]; return b[b.length - 1].dataset.day; });
await p.click(`#co-cal [data-day="${day}"]`);
await p.check("#co-ack");
await p.click("#co-pay");
await p.waitForSelector('#co-paying:not([hidden]) #co-stripe iframe', { timeout: 30000 });
const review = await p.textContent("#co-review");
eq("payment pane shows the order and pickup", ["Mokulele", "Mālie", "Kalihi Union Church", "$280"].every(t => review.includes(t)), true);
await p.waitForTimeout(3000);

// Stripe's form lives in iframes. Choose Card first (the form lists several payment methods),
// then fill every field by its autocomplete hint.
const values = { email: "giftbox-test@kawikalopez.com", "cc-number": "4242424242424242", "cc-exp": "1234", "cc-csc": "123",
  name: "Test Buyer", tel: "8085550100", organization: "Test Company", "postal-code": "96813" };
let card = false;
for (const f of p.frames()) {
  const opt = f.getByText("Card", { exact: true });
  if (await opt.count().catch(() => 0)) { await opt.first().click(); card = true; break; }
}
eq("chose Card", card, true);
await p.waitForTimeout(1500);
for (let round = 0; round < 3; round++) {
  for (const f of p.frames()) {
    for (const input of await f.$$("input").catch(() => [])) {
      const ac = (await input.getAttribute("autocomplete") || "").split(" ").pop();
      const visible = await input.isVisible().catch(() => false);
      if (visible && values[ac] && !(await input.inputValue())) await input.fill(values[ac]);
    }
  }
  await p.waitForTimeout(1000);
}
// Don't sign the test buyer up for Link (Stripe's saved-details option).
for (const f of p.frames()) {
  const opt = await f.$('input[name="linkOptIn"]').catch(() => null);
  if (opt && await opt.isChecked().catch(() => false)) await opt.uncheck().catch(() => opt.click());
}
await p.waitForTimeout(800);
// Submit: the form's Pay button, wherever Stripe renders it.
let clicked = false;
for (const f of p.frames()) {
  const btn = f.getByRole("button", { name: /^Pay/ });
  if (await btn.count().catch(() => 0)) { await btn.first().click(); clicked = true; break; }
}
eq("found Stripe's pay button", clicked, true);
await p.waitForURL(/session_id=cs_test_/, { timeout: 60000 });
await p.waitForSelector("#co-done-body h3", { timeout: 30000 });
eq("thank-you heading", await p.textContent("#co-done-body h3"), "Thank you. Your order is in.");
const id = new URL(p.url()).searchParams.get("session_id");
const cs = stripe(`checkout/sessions/${id}?expand[]=payment_intent&expand[]=line_items`);
eq("paid", [cs.status, cs.payment_status, cs.amount_total], ["complete", "paid", 28000]);
eq("pickup in metadata", [cs.metadata.source, cs.metadata.pickup_spot, cs.metadata.pickup_date], ["bh-gift", "kalihi", day]);
eq("receipt description starts with the boxes", cs.payment_intent.description.startsWith("2 Team boxes with Mokulele; 1 Client box with Mālie. Pickup "), true);
eq("buyer details captured", [cs.customer_details.email, !!cs.customer_details.name, cs.customer_details.phone], ["giftbox-test@kawikalopez.com", true, "+18085550100"]);
await p.screenshot({ path: "/tmp/bh-thanks.png" });
await b.close();
console.log(`\n${passes} passed, ${fails} failed  (session ${id})`);
process.exit(fails ? 1 : 0);
