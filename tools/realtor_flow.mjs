// End-to-end test of the realtor program on a local staging build, against the Supabase project and
// the Stripe sandbox. Drives every control on /realtors and /realtors/verify, the print page note,
// the cart's realtor rows and checkout, sign-out, and an expired sign-in.
//
//   python3 tools/serve.py 8789 --prefix /kawikalopez-site
//   PORT=8788 KL_BASE_TEST=http://localhost:8789/kawikalopez-site/ node tools/checkout_dev.mjs
//   KL_CHECKOUT_ENDPOINT=http://localhost:8788/ python3 tools/build.py
//   cd tools && node realtor_flow.mjs
//
// It creates one test realtor (an @examplebrokerage.com address, created through the admin API so
// no email is sent), then deletes it and its sandbox Stripe customer at the end. Sending a real
// sign-in email is the one thing it can't do; that's the manual inbox check before launch.
import { chromium } from "playwright";
import { readFileSync } from "fs";
import { homedir } from "os";

const BASE = process.env.BASE || "http://localhost:8789/kawikalopez-site";
const envFile = f => Object.fromEntries(readFileSync(homedir() + "/.claude/credentials/" + f, "utf8").split("\n")
  .filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const sb = envFile("supabase-veex.env"), st = envFile("kawikalopez-stripe.env");
const admin = { apikey: sb.SUPABASE_SERVICE_ROLE_KEY, Authorization: "Bearer " + sb.SUPABASE_SERVICE_ROLE_KEY, "Content-Type": "application/json" };
const stripeGet = async path => (await fetch("https://api.stripe.com/v1/" + path, {
  headers: { Authorization: "Bearer " + st.STRIPE_TEST_KEY, "Stripe-Version": "2026-03-25.dahlia" } })).json();

let failures = 0;
const check = (ok, what) => { console.log((ok ? "ok    " : "FAIL  ") + what); if (!ok) failures++; };

const email = `kl-flow-${Date.now()}@examplebrokerage.com`;
const user = await (await fetch(sb.SUPABASE_URL + "/auth/v1/admin/users", { method: "POST", headers: admin,
  body: JSON.stringify({ email, email_confirm: true,
    user_metadata: { name: "Leilani Flow Test", brokerage: "Example Brokerage", phone: "808-555-0100", license: "RS-12345" } }) })).json();
check(!!user.id, "test realtor created through the admin API");
const link = await (await fetch(sb.SUPABASE_URL + "/auth/v1/admin/generate_link", { method: "POST", headers: admin,
  body: JSON.stringify({ type: "magiclink", email }) })).json();
const hash = link.hashed_token || (link.properties && link.properties.hashed_token);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const visible = sel => page.locator(sel).isVisible();
const text = async sel => (await page.locator(sel).first().textContent() || "").trim();

try {
  // 1. Signed out
  await page.goto(BASE + "/realtors");
  check(await visible("[data-state=out]") && !(await visible("[data-state=in]")), "signed out: the sign-up and sign-in forms show");
  const nav = await page.locator(".nav-list a", { hasText: "Realtors" }).count();
  check(nav === 1, "Realtors is in the menu");

  // 2. Sign-up checks, one problem at a time
  const su = "[data-signup]", msg = "[data-signup] [data-status]";
  await page.click(su + " button");
  check((await text(msg)) === "Please add your name.", "empty form asks for a name");
  await page.fill("#r-name", "Leilani Test");
  await page.fill("#r-email", "leilani@gmail.com");
  await page.click(su + " button");
  check((await text(msg)).startsWith("Please use your brokerage email."), "a Gmail address is refused on the page");
  check((await page.getAttribute("#r-email", "aria-invalid")) === "true", "the email field is marked as the problem");
  await page.fill("#r-email", "leilani@hawaii.rr.com");
  await page.click(su + " button");
  check((await text(msg)).startsWith("Please use your brokerage email."), "a home internet address (hawaii.rr.com) is refused");
  await page.fill("#r-email", "leilani@examplebrokerage.com");
  await page.click(su + " button");
  check((await text(msg)) === "Please add your brokerage.", "missing brokerage is caught");
  await page.fill("#r-brokerage", "Example Brokerage");
  await page.fill("#r-license", "12345");
  await page.click(su + " button");
  check((await text(msg)).startsWith("Please check your license number."), "a license without RS or RB is caught");
  await page.fill("#r-license", "rb 4567");

  // The real otp call would email a test address that can't receive mail, so it's answered here.
  let sentBody = null;
  await page.route("**/auth/v1/otp", async route => { sentBody = JSON.parse(route.request().postData()); await route.fulfill({ status: 200, body: "{}" }); });
  await page.click(su + " button");
  await page.waitForSelector("[data-state=sent]:not([hidden])");
  check((await text("[data-sent-to]")) === "leilani@examplebrokerage.com", "link sent: the page names the email it went to");
  check(sentBody && sentBody.create_user === true && sentBody.data.license === "RB-4567" && sentBody.data.brokerage === "Example Brokerage",
    "sign-up sends the details, with the license tidied to RB-4567");
  await page.click("[data-resend]");
  await page.waitForFunction(() => /Sent\./.test(document.querySelector("[data-state=sent] [data-status]").textContent));
  check(true, "send it again works");
  await page.click("[data-restart]");
  check(await visible("[data-state=out]"), "use a different email goes back to the forms");

  // 3. Sign-in checks
  await page.fill("#r-signin-email", "leilani@yahoo.com");
  await page.click("[data-signin] button");
  check((await text("[data-signin] [data-status]")) === "Please sign in with your brokerage email.", "sign-in refuses a Yahoo address");
  await page.unroute("**/auth/v1/otp");
  await page.fill("#r-signin-email", "nobody-kl-flow@examplebrokerage.com");
  await page.click("[data-signin] button");
  await page.waitForFunction(() => /We don't have a realtor account/.test(document.querySelector("[data-signin] [data-status]").textContent));
  check(true, "sign-in with an email that never signed up says so (real Supabase answer)");

  // 4. Verify page
  await page.goto(BASE + "/realtors/verify");
  check(await visible("[data-realtor-verify] [data-state=bad]"), "verify page without a token offers a new link");
  await page.goto(`${BASE}/realtors/verify?token_hash=${hash}&type=magiclink`);
  check(await visible("[data-realtor-verify] [data-state=ready]"), "verify page waits for a tap (email scanners can't use the link)");
  await page.click("[data-go]");
  await page.waitForURL(/\/realtors#account$/);
  await page.waitForSelector("[data-state=in]:not([hidden])");
  check((await text("[data-first]")) === "Leilani", "signed in: greets the realtor by first name");
  check((await text("[data-email]")) === email, "signed in: shows the email checkout will use");
  const code = await text("[data-code]");
  check(/^AGENT[0-9A-F]{8,}$/.test(code), "signed in: shows their realtor code " + code);
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("kl-realtor")));
  check(stored && stored.code === code && !!stored.refresh_token, "the sign-in is kept in this browser");

  // 5. Print page
  await page.goto(BASE + "/store/018");
  check(!(await page.locator(".fine:has([data-buy])").isVisible()), "print page: the single-print buy link is hidden for a realtor");
  check((await text(".realtor-note")).startsWith("You're signed in as a realtor"), "print page: the realtor note shows");

  // 6. Cart and checkout
  await page.click("[data-add]");
  await page.goto(BASE + "/cart");
  await page.waitForSelector("[data-cart-summary]:not([hidden])");
  check(await page.locator("dt[data-realtor]").isVisible(), "cart: the realtor price line shows");
  check((await text("[data-realtor-email]")) === email, "cart: names the email checkout uses");
  const sub = await text("[data-subtotal]");
  await page.check("[data-terms-ack]");
  const created = page.waitForResponse(r => r.url().startsWith("http://localhost:8788") && r.request().method() === "POST");
  await page.click("[data-checkout]");
  const res = await (await created).json();
  check(!!res.client_secret, "checkout opened (the local checkout script answered)");
  const sent = JSON.parse((await created).request().postData());
  check(!!sent.realtor_token, "the cart sent the realtor's sign-in to checkout");
  const s = await stripeGet("checkout/sessions/" + res.client_secret.split("_secret_")[0] + "?expand[]=customer");
  const want = Math.round(s.amount_subtotal * 0.15);
  check(s.total_details.amount_discount === want, `Stripe took 15% off: ${sub} subtotal, $${(s.total_details.amount_discount / 100).toFixed(2)} off`);
  check(s.customer && s.customer.email === email, "Stripe's checkout is for the realtor's own email");
  await page.waitForSelector("[data-checkout-wrap]:not([hidden])", { timeout: 20000 });
  check(true, "Stripe's payment form opened on the page");

  // 7. Sign out
  await page.goto(BASE + "/realtors");
  await page.waitForSelector("[data-state=in]:not([hidden])");
  await page.click("[data-state=in] [data-signout]");
  check(await visible("[data-state=out]"), "sign out returns to the forms");
  check((await page.evaluate(() => localStorage.getItem("kl-realtor"))) === null, "sign out forgets the sign-in");
  await page.goto(BASE + "/store/018");
  check((await page.locator(".realtor-note").count()) === 0 && (await page.locator(".fine:has([data-buy])").isVisible()),
    "print page is back to normal after sign out");

  // 8. An expired sign-in at checkout
  await page.evaluate(e => localStorage.setItem("kl-realtor", JSON.stringify({ access_token: "x", refresh_token: "expired",
    expires_at: 1, email: e, name: "Leilani Flow Test", code: "AGENTX", status: "active" })), email);
  await page.goto(BASE + "/cart");
  await page.waitForSelector("[data-cart-summary]:not([hidden])");
  await page.check("[data-terms-ack]");
  await page.click("[data-checkout]");
  await page.waitForFunction(() => /realtor sign-in has expired/.test(document.querySelector("[data-cart-status]").textContent));
  check(true, "an expired sign-in at checkout says to sign in again");
  check((await page.evaluate(() => localStorage.getItem("kl-realtor"))) === null, "and forgets the expired sign-in");
  await page.evaluate(() => localStorage.removeItem("kl-cart"));

  // 9. Phone width
  const phone = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true });
  await phone.goto(BASE + "/realtors");
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth);
  check(wide <= 390, `phone width: no sideways scroll (${wide}px)`);
  await phone.screenshot({ path: process.env.SHOT || "/tmp/realtors-390.png", fullPage: true });
  await page.goto(BASE + "/realtors");
  await page.screenshot({ path: (process.env.SHOT || "/tmp/realtors-390.png").replace("390", "1440"), fullPage: true });
} finally {
  await b.close();
  // Clean up: the sandbox customer and code, then the account (its kl_realtors row goes with it).
  const row = await (await fetch(`${sb.SUPABASE_URL}/rest/v1/kl_realtors?id=eq.${user.id}&select=*`, { headers: admin })).json();
  const r = row[0] || {};
  if (r.test_stripe_promo_id) await fetch("https://api.stripe.com/v1/promotion_codes/" + r.test_stripe_promo_id, { method: "POST",
    headers: { Authorization: "Bearer " + st.STRIPE_TEST_KEY, "Content-Type": "application/x-www-form-urlencoded" }, body: "active=false" });
  if (r.test_stripe_customer_id) await fetch("https://api.stripe.com/v1/customers/" + r.test_stripe_customer_id, { method: "DELETE",
    headers: { Authorization: "Bearer " + st.STRIPE_TEST_KEY } });
  if (user.id) await fetch(`${sb.SUPABASE_URL}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers: admin });
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}
