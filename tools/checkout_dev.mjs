// Runs gas/checkout.gs locally, with the Apps Script services stubbed, so the cart can be
// tested end to end against the Stripe sandbox before the script is deployed.
//
//   python3 tools/serve.py 8779 --prefix /kawikalopez-site      (the site)
//   node tools/checkout_dev.mjs                                  (checkout on :8780)
//   KL_CHECKOUT_ENDPOINT=http://localhost:8780/ python3 tools/build.py
//
// Test mode only. The key is STRIPE_TEST_KEY from ~/.claude/credentials/kawikalopez-stripe.env,
// and the shipping model is read from the local preview. Rebuild without the variable afterwards.
import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { createServer } from "http";
import { homedir } from "os";
import vm from "vm";

const PORT = Number(process.env.PORT || 8780);
const root = new URL("..", import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(homedir() + "/.claude/credentials/kawikalopez-stripe.env", "utf8")
  .split("\n").filter(l => l.includes("=") && !l.trim().startsWith("#"))
  .map(l => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
const props = { STRIPE_TEST_KEY: env.STRIPE_TEST_KEY, BASE_TEST: "http://localhost:8779/kawikalopez-site/" };

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
const store = new Map();
const sandbox = {
  UrlFetchApp, console,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null }) },
  CacheService: { getScriptCache: () => ({ get: k => store.get(k) || null, put: (k, v) => store.set(k, v) }) },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: text => ({ text, setMimeType() { return this; } })
  },
  encodeURIComponent
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(root + "gas/checkout.gs", "utf8"), sandbox);

createServer((req, res) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  if (req.method !== "POST") { res.writeHead(200, cors); res.end(sandbox.doGet().text); return; }
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    store.clear();   // always read the freshly built cart.json
    const out = sandbox.doPost({ postData: { contents: body } });
    console.log("POST", body, "->", out.text.slice(0, 120));
    res.writeHead(200, cors);
    res.end(out.text);
  });
}).listen(PORT, () => console.log(`checkout dev server on http://localhost:${PORT}/ (test mode)`));
