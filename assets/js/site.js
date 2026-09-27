/* kawikalopez.com
   Hand written, no dependencies, loaded with defer. One IIFE per feature; each can be
   deleted on its own. The page works without any of this: prices and sizes are in the
   table, and the order link carries the default size.

   01 Shared
   02 Size and material picker
   03 Room preview (to scale)
   04 Contact form
   05 Cart: storage and header count
   06 Cart: add from a print page
   07 Cart page and checkout
*/

/* 01 Shared ---------------------------------------------------------------- */
var KL = (function () {
  "use strict";
  var money = function (n) { return "$" + Number(n).toLocaleString("en-US"); };
  var parse = function (el, attr) {
    try { return JSON.parse(el.getAttribute(attr)); } catch (e) { return null; }
  };
  /* Same math as viz_rect() in tools/build.py. Keep the two in step. */
  var rect = function (room, wIn, hIn) {
    var W = room.W, H = room.H, wall = room.wall, a = room.anchor;
    var wpx = wIn * room.ppi, hpx = hIn * room.ppi;
    var cx = wall.x + a.x * wall.w, cy = wall.y + a.y * wall.h;
    var left = wpx <= wall.w ? Math.min(Math.max(cx - wpx / 2, wall.x), wall.x + wall.w - wpx) : cx - wpx / 2;
    var top = hpx <= wall.h ? Math.min(Math.max(cy - hpx / 2, wall.y), wall.y + wall.h - hpx) : cy - hpx / 2;
    return { left: left / W * 100, top: top / H * 100, width: wpx / W * 100, height: hpx / H * 100 };
  };
  return { money: money, parse: parse, rect: rect };
})();

/* 02 Size and material picker ---------------------------------------------- */
(function () {
  "use strict";
  var form = document.querySelector("[data-picker]");
  if (!form) return;
  var data = KL.parse(form, "data-picker");
  if (!data) return;
  var priceEl = form.querySelector("[data-price]");
  var noteEl = form.querySelector("[data-ship-note]");
  var buy = form.querySelector("[data-buy]");
  var add = form.querySelector("[data-add]");

  function current() {
    var size = form.querySelector('input[name="size"]:checked');
    var mat = form.querySelector('input[name="material"]:checked');
    if (!size || !mat) return null;
    for (var i = 0; i < data.variants.length; i++) {
      var v = data.variants[i];
      if (v.size === size.value && v.material === mat.value) return v;
    }
    return null;
  }

  function update() {
    var v = current();
    if (!v) return;
    priceEl.textContent = KL.money(v.price);
    noteEl.textContent = v.ships ? "" : "Pickup on Oʻahu only";
    if (add) add.setAttribute("data-id", v.id);
    if (v.link) {
      buy.href = v.link;
    } else {
      var subject = "Print order: " + data.title + ", " + v.size + " in " + v.material;
      buy.href = "mailto:" + data.email + "?subject=" + encodeURIComponent(subject);
    }
    document.dispatchEvent(new CustomEvent("variant:change", { detail: v }));
  }

  form.addEventListener("change", update);
  update();
})();

/* 03 Room preview (to scale) ------------------------------------------------ */
(function () {
  "use strict";
  var room = document.querySelector("[data-room]");
  if (!room) return;
  var cfg = KL.parse(room, "data-room");
  var print = room.querySelector("[data-room-print]");
  var caption = document.querySelector("[data-room-caption]");
  var title = document.querySelector(".info-head h1");
  if (!cfg || !print) return;

  document.addEventListener("variant:change", function (e) {
    var v = e.detail;
    var r = KL.rect(cfg, v.w, v.h);
    print.style.left = r.left + "%";
    print.style.top = r.top + "%";
    print.style.width = r.width + "%";
    print.style.height = r.height + "%";
    room.classList.toggle("is-metal", v.material === "metal");
    room.classList.toggle("is-canvas", v.material === "canvas");
    if (caption) {
      caption.textContent = (title ? title.textContent : "This print") + " at " + v.size + " in, " +
        v.material + ", shown to scale above a 10 foot sofa.";
    }
  });
})();

/* 04 Contact form ------------------------------------------------------------ */
/* Posts to the Apps Script in gas/contact-notify.gs when data-endpoint is set. Without an
   endpoint, or if the post fails, it opens the visitor's email app with the message filled
   in, so a message is never lost. A hidden field and a 3 second minimum catch most bots. */
(function () {
  "use strict";
  var form = document.querySelector("[data-contact]");
  if (!form) return;
  var status = form.querySelector("[data-status]");
  var endpoint = form.getAttribute("data-endpoint");
  var to = form.getAttribute("data-email");
  var opened = Date.now();

  var params = new URLSearchParams(location.search);
  if (params.get("print")) form.elements.print.value = params.get("print");

  function say(text, isError) {
    status.textContent = text;
    status.classList.toggle("is-error", !!isError);
  }

  function mailto(d) {
    var subject = d.print ? "Print question: " + d.print : "Message from " + d.name;
    var body = d.message + "\n\n" + d.name + (d.print ? "\nPrint: " + d.print : "");
    location.href = "mailto:" + to + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
    say("Your email app should open with your message ready to send. If it didn't, write to " + to + ".");
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var d = {
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      print: form.elements.print.value.trim(),
      message: form.elements.message.value.trim(),
      website: form.elements.website.value
    };
    if (!d.name || !d.message || d.email.indexOf("@") < 1) {
      say("Please add your name, a working email and a message.", true);
      (!d.name ? form.elements.name : d.email.indexOf("@") < 1 ? form.elements.email : form.elements.message).focus();
      return;
    }
    if (d.website || Date.now() - opened < 3000) { say("Thanks, your message is on its way."); return; }
    if (!endpoint) { mailto(d); return; }
    var body = new URLSearchParams({ name: d.name, email: d.email, print: d.print, message: d.message, page: location.pathname });
    say("Sending...");
    fetch(endpoint, { method: "POST", mode: "no-cors", body: body })
      .then(function () { form.reset(); say("Thanks, your message is on its way. Kawika will reply by email."); })
      .catch(function () { mailto(d); });
  });
})();

/* 05 Cart: storage and header count --------------------------------------- */
/* BEGIN shipQuote: identical in assets/js/site.js and gas/checkout.gs (tools/test_shipping.mjs checks) */
/* Shipping for a cart, in cents, from the model in data/shipping.yml (cart:).
   items: [{w, h, qty, material}]. Returns {ships, pickupOnly, hi, mainland, hiQuote,
   mainlandQuote, boxes}; hi and mainland are what the customer pays (quote x markup, rounded
   up to the next dollar). boxes: the lab orders for mainland shipping, each a list of units. */
function shipQuote(model, items) {
  var units = [], i, j, it;
  for (i = 0; i < items.length; i++) {
    it = items[i];
    for (j = 0; j < it.qty; j++) {
      units.push({ w: it.w, h: it.h, material: it.material, area: it.w * it.h });
    }
  }
  var oversize = function (u) {
    return Math.max(u.w, u.h) > model.max_long_edge_in || Math.min(u.w, u.h) > model.max_short_edge_in ||
      u.area > model.mainland_box_max_sq_in;
  };
  for (i = 0; i < units.length; i++) {
    if (oversize(units[i])) return { ships: false, pickupOnly: true, boxes: [] };
  }
  if (!units.length) return { ships: false, pickupOnly: false, boxes: [] };

  var hq = model.hi.base;
  for (i = 0; i < units.length; i++) {
    hq += model.hi.per_sq_in * units[i].area + model.hi.per_print +
      (units[i].material === "canvas" ? model.hi.per_canvas_print : 0);
  }

  // Largest first into the first box with room; each box stays under the freight jump.
  var sorted = units.slice().sort(function (a, b) { return b.area - a.area; });
  var boxes = [], sums = [];
  for (i = 0; i < sorted.length; i++) {
    for (j = 0; j < boxes.length; j++) {
      if (sums[j] + sorted[i].area <= model.mainland_box_max_sq_in) break;
    }
    if (j === boxes.length) { boxes.push([]); sums.push(0); }
    boxes[j].push(sorted[i]);
    sums[j] += sorted[i].area;
  }
  var step = function (area) {
    for (var k = 0; k < model.mainland_steps.length; k++) {
      if (area <= model.mainland_steps[k][0]) return model.mainland_steps[k][1];
    }
    return null;
  };
  var mq = 0;
  for (j = 0; j < sums.length; j++) mq += step(sums[j]);

  var charge = function (q) { return Math.ceil(q * model.markup_pct / 10000) * 100; };
  return { ships: true, pickupOnly: false, hi: charge(hq), mainland: charge(mq), hiQuote: hq,
    mainlandQuote: mq, boxes: boxes };
}
/* END shipQuote */

/* The cart lives in this browser only (localStorage): [{id, qty}]. Prices, sizes and shipping
   are looked up fresh from assets/data/cart.json and again by the checkout service. */
var Cart = (function () {
  "use strict";
  var KEY = "kl-cart";
  function read() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || "[]");
      return Array.isArray(v) ? v.filter(function (x) { return x && typeof x.id === "string" && x.qty > 0; }) : [];
    } catch (e) { return []; }
  }
  function write(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { /* private mode: cart lasts this page only */ }
    badge(items);
    document.dispatchEvent(new CustomEvent("cart:change", { detail: items }));
  }
  function count(items) {
    return (items || read()).reduce(function (n, x) { return n + x.qty; }, 0);
  }
  function badge(items) {
    var n = count(items);
    [].forEach.call(document.querySelectorAll("[data-cart-count]"), function (el) {
      el.textContent = n ? "(" + n + ")" : "";
    });
  }
  function add(id, max) {
    var items = read(), hit = null;
    items.forEach(function (x) { if (x.id === id) hit = x; });
    if (hit) hit.qty = Math.min(hit.qty + 1, max || 5);
    else items.push({ id: id, qty: 1 });
    write(items);
  }
  function set(id, qty) {
    write(read().map(function (x) { return x.id === id ? { id: id, qty: qty } : x; }).filter(function (x) { return x.qty > 0; }));
  }
  function clear() { write([]); }
  badge();
  if (document.querySelector("[data-cart-clear]") && /session_id=/.test(location.search)) clear();
  return { read: read, write: write, add: add, set: set, clear: clear, count: count };
})();

/* 06 Cart: add from a print page -------------------------------------------- */
(function () {
  "use strict";
  var btn = document.querySelector("[data-add]");
  if (!btn) return;
  var msg = document.querySelector("[data-added]");
  var cartUrl = btn.getAttribute("data-cart-url");
  btn.addEventListener("click", function () {
    var id = btn.getAttribute("data-id");
    if (!id) return;
    Cart.add(id, 5);
    msg.innerHTML = "";
    msg.appendChild(document.createTextNode("Added to your cart. "));
    var a = document.createElement("a");
    a.href = cartUrl;
    a.textContent = "View cart and check out (" + Cart.count() + ")";
    msg.appendChild(a);
  });
})();

/* 07 Cart page and checkout -------------------------------------------------- */
(function () {
  "use strict";
  var root = document.querySelector("[data-cart]");
  if (!root) return;
  var list = root.querySelector("[data-cart-list]");
  var empty = root.querySelector("[data-cart-empty]");
  var summary = root.querySelector("[data-cart-summary]");
  var status = root.querySelector("[data-cart-status]");
  var go = root.querySelector("[data-checkout]");
  var prefix = root.getAttribute("data-root");
  var cfg = null;
  var dollars = function (cents) { return KL.money(cents / 100); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function lines() {
    // Drop anything no longer sold; the rest joins the catalog entry.
    var items = Cart.read(), out = [];
    items.forEach(function (x) { if (cfg.variants[x.id]) out.push({ id: x.id, qty: Math.min(x.qty, cfg.model.max_qty), v: cfg.variants[x.id] }); });
    if (out.length !== items.length) Cart.write(out.map(function (x) { return { id: x.id, qty: x.qty }; }));
    return out;
  }

  function render() {
    var ls = lines();
    list.innerHTML = "";
    empty.hidden = ls.length > 0;
    summary.hidden = ls.length === 0;
    if (!ls.length) return;
    var subtotal = 0;
    ls.forEach(function (x) {
      var v = x.v;
      subtotal += v.price * x.qty;
      var li = el("li", "cart-item");
      var img = el("img", "cart-thumb");
      img.src = prefix + v.img; img.alt = ""; img.width = 96; img.height = 96; img.loading = "lazy";
      li.appendChild(img);
      var info = el("div", "cart-info");
      var a = el("a", "cart-title", v.title); a.href = prefix + v.path;
      info.appendChild(a);
      info.appendChild(el("p", "cart-meta", v.size + " in, " + v.material + (v.ships ? "" : ". Pickup on Oʻahu only")));
      var row = el("div", "cart-row");
      var lab = el("label", "cart-qty");
      lab.appendChild(document.createTextNode("Qty "));
      var sel = el("select");
      for (var q = 1; q <= cfg.model.max_qty; q++) {
        var o = el("option", "", String(q)); o.value = q; if (q === x.qty) o.selected = true; sel.appendChild(o);
      }
      sel.setAttribute("aria-label", "Quantity of " + v.title + ", " + v.size + " " + v.material);
      sel.addEventListener("change", function () { Cart.set(x.id, Number(sel.value)); });
      lab.appendChild(sel);
      row.appendChild(lab);
      var rm = el("button", "cart-remove", "Remove"); rm.type = "button";
      rm.setAttribute("aria-label", "Remove " + v.title + ", " + v.size + " " + v.material);
      rm.addEventListener("click", function () { Cart.set(x.id, 0); });
      row.appendChild(rm);
      info.appendChild(row);
      li.appendChild(info);
      li.appendChild(el("p", "cart-line", KL.money(v.price * x.qty)));
      list.appendChild(li);
    });

    var s = shipQuote(cfg.model, ls.map(function (x) { return { w: x.v.w, h: x.v.h, qty: x.qty, material: x.v.material }; }));
    root.querySelector("[data-subtotal]").textContent = KL.money(subtotal);
    var ship = root.querySelector("[data-ship]");
    ship.innerHTML = "";
    var add = function (label, value) {
      var dt = el("dt", "", label), dd = el("dd", "", value);
      ship.appendChild(dt); ship.appendChild(dd);
    };
    add(cfg.model.pickup.label, "Free");
    if (s.ships) {
      add("Ship to " + cfg.model.zones.hi.label, dollars(s.hi));
      add("Ship to " + cfg.model.zones.mainland.label, dollars(s.mainland));
    }
    root.querySelector("[data-ship-note]").textContent = s.pickupOnly
      ? "This order includes a print too large to ship, so it's pickup on Oʻahu only. Get in touch if you need it shipped and we'll quote freight."
      : "One shipping charge covers every print in the order. You choose pickup or shipping at checkout.";
  }

  // Checkout runs in Stripe's embedded form, shown on this page. The checkout service creates
  // the session (prints priced from Stripe); when the buyer finishes their address, the service
  // offers the one shipping rate that matches it (Hawaiʻi or mainland), plus free pickup.
  var wrap = document.querySelector("[data-checkout-wrap]");
  var mountEl = document.querySelector("[data-checkout-form]");
  var form = null, started = false;

  function post(body) {
    return fetch(cfg.endpoint, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(Object.assign({ mode: cfg.mode }, body))
    }).then(function (r) { return r.json(); });
  }

  function stripeJs() {
    if (window.Stripe) return Promise.resolve(window.Stripe);
    return new Promise(function (ok, fail) {
      var sc = document.createElement("script");
      sc.src = "https://js.stripe.com/dahlia/stripe.js";
      sc.onload = function () { ok(window.Stripe); };
      sc.onerror = fail;
      document.head.appendChild(sc);
    });
  }

  function fail(e) {
    started = false;
    go.disabled = false;
    go.hidden = false;
    wrap.hidden = true;
    status.classList.add("is-error");
    status.textContent = (e && e.user ? e.user + " " : "Checkout didn't open. ") +
      "Please try again, or buy a print on its own from its page.";
  }

  function stop() {
    // The cart changed while checkout was open: that session no longer matches the cart.
    if (!started) return;
    if (form && form.unmount) { try { form.unmount(); } catch (e) { /* already gone */ } }
    form = null;
    started = false;
    mountEl.innerHTML = "";
    wrap.hidden = true;
    go.hidden = false;
    go.disabled = false;
    status.textContent = "Your cart changed. Check out again when you're ready.";
  }

  function checkout() {
    var ls = lines();
    if (!ls.length || started) return;
    started = true;
    go.disabled = true;
    status.textContent = "Opening secure checkout...";
    status.classList.remove("is-error");
    Promise.all([
      post({ action: "create", items: ls.map(function (x) { return { id: x.id, qty: x.qty }; }) }),
      stripeJs()
    ]).then(function (res) {
      var d = res[0];
      if (!d || !d.client_secret) throw { user: d && d.error };
      var stripe = res[1](cfg.pk);
      var sdk = stripe.initCheckoutFormSdk({
        clientSecret: d.client_secret,
        appearance: { theme: "stripe", variables: { colorPrimary: "#0e5566", borderRadius: "2px" } }
      });
      form = sdk.createForm({
        layout: "expanded",
        expressCheckout: { paymentMethods: { applePay: "never", googlePay: "never", amazonPay: "never", paypal: "never", link: "never" } }
      });
      wrap.hidden = false;
      go.hidden = true;
      status.textContent = "";
      form.mount(mountEl);
      wrap.scrollIntoView({ behavior: "smooth", block: "start" });

      var priced = false;
      form.on("change", function (ev) {
        var done = ev.status && ev.status.shippingAddress && ev.status.shippingAddress.complete;
        if (done && !priced) {
          priced = true;
          sdk.loadActions().then(function (r) {
            if (r.type !== "success") { priced = false; return; }
            var a = r.actions;
            var addr = (ev.value.shippingAddress && ev.value.shippingAddress.address) || ev.value.shippingAddress || {};
            return a.runServerUpdate(function () {
              return post({ action: "shipping", session_id: a.getSession().id, address: addr })
                .then(function (out) { if (out.type === "error") throw new Error(out.message); return out; });
            });
          }).catch(function () { priced = false; });
        } else if (!done && priced) {
          priced = false;
        }
      });
      sdk.loadActions().then(function (r) {
        if (r.type !== "success") return;
        form.on("confirm", function (ev) {
          r.actions.confirm({ formConfirmEvent: ev }).then(function (res) {
            if (res && res.type === "error") console.warn("checkout:", res.error && res.error.message);
          }).catch(function (e) { console.warn("checkout:", e && e.message); });
        });
      });
    }).catch(fail);
  }

  fetch(root.getAttribute("data-src"))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      cfg = d;
      render();
      document.addEventListener("cart:change", function () { stop(); render(); });
      go.addEventListener("click", checkout);
    })
    .catch(function () {
      empty.hidden = false;
      empty.textContent = "The cart couldn't load. Please refresh the page.";
    });
})();
