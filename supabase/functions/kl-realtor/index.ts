// kawikalopez.com realtor program: set up a signed-in realtor and return their account.
//
// Called by the /realtors pages right after a realtor signs in (and on later visits), with their
// Supabase sign-in in the Authorization header. Safe to call any number of times.
//
//   1. Confirms the sign-in with Supabase and that the email isn't a free address.
//   2. Creates their kl_realtors row from what they entered at sign-up, the first time.
//   3. Creates their Stripe customer (their brokerage email) and a personal 15% promotion code
//      locked to that customer, once per mode. Stripe refuses a locked code for anyone else, and
//      for a checkout with no customer, so the code only works through the signed-in cart.
//   4. In live mode, emails the welcome note once.
//
// Request:  POST {"mode": "live" | "test"}   Response: {"status", "name", "brokerage", "code"}
// Secrets (Supabase > Edge Functions > Secrets): KL_SECRET_KEY, KL_STRIPE_LIVE_KEY,
// KL_STRIPE_TEST_KEY, KL_COUPON_LIVE, KL_COUPON_TEST, KL_RESEND_KEY, KL_EMAIL_FROM.
// Deployed with verify_jwt off: the sign-in is checked here, against Supabase Auth.

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = Deno.env.get("KL_SECRET_KEY") ?? "";
const STRIPE_VERSION = "2026-03-25.dahlia";
const ORIGINS = ["https://kawikalopez.com", "https://darthkanaka.github.io"];
const LICENSE = /^(RS|RB)[-\s]?(\d{3,7})$/i;

type Mode = "live" | "test";
type Row = Record<string, string | null>;

class Refusal extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function cors(origin: string | null): Record<string, string> {
  // Local previews run on any localhost port.
  const ok = origin && (ORIGINS.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin));
  const allow = ok ? origin : ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function reply(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

async function db(path: string, init: RequestInit = {}): Promise<unknown> {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...(init.headers ?? {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`db ${path} ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function stripe(mode: Mode, path: string, params: Record<string, string>, idem: string): Promise<Row> {
  const key = Deno.env.get(mode === "live" ? "KL_STRIPE_LIVE_KEY" : "KL_STRIPE_TEST_KEY");
  if (!key) throw new Error(`no ${mode} Stripe key`);
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": STRIPE_VERSION,
      "Idempotency-Key": idem,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const out = await r.json();
  if (!r.ok) throw new Error(`stripe ${path} ${r.status} ${JSON.stringify(out.error ?? out)}`);
  return out;
}

// The code a realtor sees, made from their account id so a retried request makes the same one.
function codeFor(uid: string, extra = 0): string {
  return "AGENT" + uid.replace(/-/g, "").slice(0, 8 + extra).toUpperCase();
}

function clean(v: unknown, max: number): string {
  return String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function signedInUser(auth: string | null): Promise<Row & { user_metadata?: Record<string, unknown> }> {
  const token = (auth ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new Refusal(401, "Please sign in again.");
  const r = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) throw new Refusal(401, "Please sign in again.");
  return await r.json();
}

async function welcome(row: Row): Promise<boolean> {
  const key = Deno.env.get("KL_RESEND_KEY");
  if (!key) return false;
  const from = Deno.env.get("KL_EMAIL_FROM") ?? "Kawika Lopez Photography <info@kawikalopez.com>";
  const first = (row.name ?? "").split(" ")[0] || "there";
  const text = [
    `Aloha ${first},`,
    "",
    "Your realtor account on kawikalopez.com is set up, and 15% comes off every print for your clients.",
    "",
    "Sign in at kawikalopez.com/realtors with this email, add prints to your cart, and the 15% is applied for you at checkout.",
    "",
    `Your realtor code is ${row.promo_code}. It works with this email address only, and you never need to type it.`,
    "",
    "Mahalo,",
    "Kawika Lopez",
    "kawikalopez.com",
  ].join("\n");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [row.email],
      reply_to: "info@kawikalopez.com",
      subject: "Your realtor pricing on kawikalopez.com",
      text,
    }),
  });
  if (!r.ok) console.error("welcome email", r.status, await r.text());
  return r.ok;
}

async function setUp(user: Row & { user_metadata?: Record<string, unknown> }, mode: Mode): Promise<Row> {
  const uid = String(user.id);
  const email = String(user.email ?? "").toLowerCase();
  if (!user.email_confirmed_at) throw new Refusal(403, "Please confirm your email first.");
  const free = await db("rpc/kl_is_free_domain", { method: "POST", body: JSON.stringify({ d: email.split("@")[1] ?? "" }) });
  if (free === true) throw new Refusal(403, "Please sign up with your brokerage email.");

  let row = ((await db(`kl_realtors?id=eq.${uid}&select=*`)) as Row[])[0];
  if (!row) {
    const m = user.user_metadata ?? {};
    const lic = LICENSE.exec(clean(m.license, 20));
    const name = clean(m.name, 120);
    const brokerage = clean(m.brokerage, 160);
    if (!name || !brokerage || !lic) throw new Refusal(422, "We're missing your name, brokerage or license number. Please sign up again.");
    row = ((await db("kl_realtors", {
      method: "POST",
      headers: { Prefer: "return=representation,resolution=ignore-duplicates" },
      body: JSON.stringify({
        id: uid,
        email,
        name,
        brokerage,
        phone: clean(m.phone, 40) || null,
        license_number: `${lic[1].toUpperCase()}-${lic[2]}`,
        license_type: lic[1].toUpperCase(),
      }),
    })) as Row[])[0] ?? ((await db(`kl_realtors?id=eq.${uid}&select=*`)) as Row[])[0];
  }
  if (row.status !== "active") return row;

  const p = mode === "live" ? "" : "test_";
  if (!row[`${p}stripe_promo_id`]) {
    const coupon = Deno.env.get(mode === "live" ? "KL_COUPON_LIVE" : "KL_COUPON_TEST");
    if (!coupon) throw new Error(`no ${mode} coupon`);
    let customer = row[`${p}stripe_customer_id`];
    if (!customer) {
      const c = await stripe(mode, "customers", {
        email,
        name: String(row.name),
        "metadata[kl_realtor_id]": uid,
        "metadata[brokerage]": String(row.brokerage),
        "metadata[license]": String(row.license_number),
      }, `kl-cust-${mode}-${uid}`);
      customer = String(c.id);
      await db(`kl_realtors?id=eq.${uid}`, { method: "PATCH", body: JSON.stringify({ [`${p}stripe_customer_id`]: customer }) });
    }
    let promo: Row | null = null;
    for (let extra = 0; extra <= 8 && !promo; extra += 4) {
      try {
        promo = await stripe(mode, "promotion_codes", {
          "promotion[type]": "coupon",
          "promotion[coupon]": coupon,
          code: codeFor(uid, extra),
          customer,
          "metadata[kl_realtor_id]": uid,
        }, `kl-promo-${mode}-${uid}-${extra}`);
      } catch (e) {
        // Another account already has this code (very unlikely): try a longer one.
        if (!String(e).includes("already exists") || extra === 8) throw e;
      }
    }
    row = ((await db(`kl_realtors?id=eq.${uid}`, {
      method: "PATCH",
      body: JSON.stringify({ [`${p}stripe_promo_id`]: promo!.id, [`${p}promo_code`]: promo!.code }),
    })) as Row[])[0];
  }

  if (mode === "live" && !row.welcome_sent_at && (await welcome(row))) {
    row = ((await db(`kl_realtors?id=eq.${uid}`, {
      method: "PATCH",
      body: JSON.stringify({ welcome_sent_at: new Date().toISOString() }),
    })) as Row[])[0];
  }
  return row;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return reply({ error: "POST only" }, 405, origin);
  try {
    const body = await req.json().catch(() => ({}));
    const mode: Mode = body.mode === "test" ? "test" : "live";
    const user = await signedInUser(req.headers.get("Authorization"));
    const row = await setUp(user, mode);
    const p = mode === "live" ? "" : "test_";
    return reply({
      status: row.status,
      name: row.name,
      brokerage: row.brokerage,
      email: row.email,
      code: row.status === "active" ? row[`${p}promo_code`] : null,
    }, 200, origin);
  } catch (e) {
    if (e instanceof Refusal) return reply({ error: e.message }, e.status, origin);
    console.error(String(e));
    return reply({ error: "Something went wrong setting up your account. Please try again in a minute." }, 500, origin);
  }
});
