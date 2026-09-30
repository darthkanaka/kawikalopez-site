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
   08 Analytics events (GA4, production only)
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
    var cx = wall.x + a.x * wall.w;
    var cy = a.bottom !== undefined ? wall.y + a.bottom * wall.h - hpx / 2 : wall.y + a.y * wall.h;
    var left = wpx <= wall.w ? Math.min(Math.max(cx - wpx / 2, wall.x), wall.x + wall.w - wpx) : cx - wpx / 2;
    var top = hpx <= wall.h ? Math.min(Math.max(cy - hpx / 2, wall.y), wall.y + wall.h - hpx) : cy - hpx / 2;
    return { left: left / W * 100, top: top / H * 100, width: wpx / W * 100, height: hpx / H * 100 };
  };
  /* GA4 events. gtag exists only on production builds with site.ga4 set; everywhere else this
     does nothing. Never pass names, emails or addresses: prints and totals only. */
  var track = function (name, params) {
    if (typeof window.gtag === "function") window.gtag("event", name, params);
  };
  var item = function (id, title, size, material, price, qty) {
    return { item_id: id, item_name: title, item_variant: size + " " + material, price: price, quantity: qty || 1 };
  };
  var store = function (key, val) {
    try { if (val === undefined) return JSON.parse(localStorage.getItem(key) || "null"); localStorage.setItem(key, JSON.stringify(val)); }
    catch (e) { return null; }
  };
  /* Remember what is being bought, so the thank-you page can report the purchase. */
  var beginCheckout = function (items) {
    var value = items.reduce(function (n, x) { return n + x.price * x.quantity; }, 0);
    track("begin_checkout", { currency: "USD", value: value, items: items });
    store("kl_pending", { items: items, value: value });
  };
  return { money: money, parse: parse, rect: rect, track: track, item: item, store: store, beginCheckout: beginCheckout };
})();

/* 02 Size and material picker ---------------------------------------------- */
/* Updates the price, what one print costs to ship, the order link and the cart button when the
   size or material changes. ?size=48x16&material=metal in the address opens the page on that
   print (Google's product listings link to these). Every element is optional, so an older cached
   page keeps working with this script. */
(function () {
  "use strict";
  var form = document.querySelector("[data-picker]");
  if (!form) return;
  var data = KL.parse(form, "data-picker");
  if (!data || !data.variants) return;
  var priceEl = form.querySelector("[data-price]");
  var choiceEl = form.querySelector("[data-choice]");
  var noteEl = form.querySelector("[data-ship-note]");
  var rowEls = form.querySelectorAll("[data-ship-row]");
  var rateEls = form.querySelectorAll("[data-ship]");
  var buy = form.querySelector("[data-buy]");
  var add = form.querySelector("[data-add]");
  var more = form.querySelector("[data-more-sizes]");
  var each = function (list, fn) { Array.prototype.forEach.call(list, fn); };
  var squash = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); };

  /* The chosen size and material. A size sold in one material only (the matted print) needs no
     material choice. */
  function current() {
    var size = form.querySelector('input[name="size"]:checked');
    var mat = form.querySelector('input[name="material"]:checked');
    if (!size) return null;
    var same = data.variants.filter(function (v) { return v.size === size.value; });
    if (same.length === 1) return same[0];
    for (var i = 0; i < same.length; i++) {
      if (mat && same[i].material === mat.value) return same[i];
    }
    return null;
  }

  var label = function (v) { return v.material === "matted" ? v.size + " print, 11 x 14 mat" : v.size + " in, " + v.material; };

  /* Each size card shows its price in the material that's chosen. */
  function cardPrices() {
    var mat = form.querySelector('input[name="material"]:checked');
    var m = mat ? mat.value : "metal";
    each(form.querySelectorAll("[data-tier-price]"), function (el) {
      var size = el.getAttribute("data-tier-price"), hit = null;
      data.variants.forEach(function (x) { if (x.size === size && x.material === m) hit = x; });
      el.textContent = hit ? KL.money(hit.price) : "";
    });
  }

  /* A value that matches no size, or a size and material that isn't sold, leaves the default. */
  function preselect() {
    var q, hit = false;
    try { q = new URLSearchParams(window.location.search); } catch (e) { return false; }
    ["size", "material"].forEach(function (name) {
      var want = squash(q.get(name));
      if (!want) return;
      each(form.querySelectorAll('input[name="' + name + '"]'), function (r) {
        if (squash(r.value) === want) { r.checked = true; hit = true; }
      });
    });
    if (hit && !current()) {
      each(form.querySelectorAll('input[type="radio"]'), function (r) { r.checked = r.defaultChecked; });
      hit = false;
    }
    return hit;
  }

  function shipping(v) {
    var ok = !!(v.ships && v.rates);
    each(rowEls, function (el) { el.hidden = !ok; });
    if (ok) each(rateEls, function (el) {
      var n = v.rates[el.getAttribute("data-ship")];
      if (typeof n === "number") el.textContent = KL.money(n);
    });
    if (noteEl) {
      noteEl.textContent = v.ships ? "" : (noteEl.getAttribute("data-text") || "Pickup on Oʻahu only");
      if (noteEl.hasAttribute("data-text")) noteEl.hidden = !!v.ships;
    }
  }

  function update() {
    var v = current();
    if (!v) return;
    if (priceEl) priceEl.textContent = KL.money(v.price);
    if (choiceEl) choiceEl.textContent = label(v);
    form.classList.toggle("is-matted", v.material === "matted");
    cardPrices();
    shipping(v);
    if (more && !more.open) {
      var s = form.querySelector('input[name="size"]:checked');
      if (s && more.contains(s)) more.open = true;
    }
    if (add) add.setAttribute("data-id", v.id);
    if (buy) {
      buy.href = v.link ? v.link : "mailto:" + data.email + "?subject=" +
        encodeURIComponent("Print order: " + data.title + ", " + (v.material === "matted" ? v.size + " matted print" : v.size + " in " + v.material));
    }
    document.dispatchEvent(new CustomEvent("variant:change", { detail: v }));
  }

  var picked = preselect();
  form.addEventListener("change", update);
  update();
  KL.product = { title: data.title, current: current, defaultId: data["default"] || null, picked: picked };

  var v0 = current();
  if (v0) KL.track("view_item", { currency: "USD", value: v0.price, items: [KL.item(v0.id, data.title, v0.size, v0.material, v0.price)] });
  if (buy) buy.addEventListener("click", function () {
    var v = current();
    if (v && v.link) KL.beginCheckout([KL.item(v.id, data.title, v.size, v.material, v.price)]);
  });
})();

/* 03 Room preview (to scale) ------------------------------------------------ */
/* Canvas and metal show in the living room. The matted print shows in its mat on the side table
   scene, where an 11 x 14 reads at a natural size; switching scenes jumps rather than slides. */
(function () {
  "use strict";
  var room = document.querySelector("[data-room]");
  if (!room) return;
  var cfg = KL.parse(room, "data-room");
  var print = room.querySelector("[data-room-print]");
  var photo = room.querySelector("[data-room-photo]");
  var caption = document.querySelector("[data-room-caption]");
  var title = document.querySelector(".info-head h1");
  if (!cfg || !print) return;
  if (!cfg.scenes) cfg = { scenes: { main: cfg }, main: "main", matted: null };   /* a page from before two scenes */
  var imgs = room.querySelectorAll("[data-scene-img]");
  var shown = cfg.main;

  function show(v, instant) {
    var matted = v.material === "matted" && v.mat && cfg.matted && cfg.scenes[cfg.matted];
    var id = matted ? cfg.matted : cfg.main, sc = cfg.scenes[id];
    var jump = instant || id !== shown;
    var r = KL.rect(sc, matted ? v.mat.w : v.w, matted ? v.mat.h : v.h);
    if (jump) print.style.transition = "none";
    print.style.left = r.left + "%";
    print.style.top = r.top + "%";
    print.style.width = r.width + "%";
    print.style.height = r.height + "%";
    Array.prototype.forEach.call(imgs, function (el) { el.hidden = el.getAttribute("data-scene-img") !== id; });
    shown = id;
    if (photo) {
      var m = matted ? v.mat : null;
      photo.style.left = m ? (m.w - m.open_w) / 2 / m.w * 100 + "%" : "";
      photo.style.top = m ? (m.h - m.open_h) / 2 / m.h * 100 + "%" : "";
      photo.style.width = m ? m.open_w / m.w * 100 + "%" : "";
      photo.style.height = m ? m.open_h / m.h * 100 + "%" : "";
    }
    room.classList.toggle("is-metal", v.material === "metal");
    room.classList.toggle("is-canvas", v.material === "canvas");
    room.classList.toggle("is-matted", !!matted);
    if (jump) { void print.offsetWidth; print.style.transition = ""; }
    if (caption) {
      caption.textContent = (title ? title.textContent : "This print") + " at " +
        (matted ? v.size + " in, in an 11 x 14 mat" : v.size + " in, " + v.material) + ", " + (sc.tail || "shown to scale") + ".";
    }
  }

  document.addEventListener("variant:change", function (e) { show(e.detail); });
  /* The picker ran first. If the page opened on another print than the one the build drew
     (a ?size= link, or a form the browser restored), catch up without animating. */
  var v0 = KL.product && KL.product.current && KL.product.current();
  if (v0 && KL.product.defaultId && v0.id !== KL.product.defaultId) show(v0, true);
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
  var units = [], matted = 0, i, j, it;
  for (i = 0; i < items.length; i++) {
    it = items[i];
    if (it.material === "matted") { matted += it.qty; continue; }
    for (j = 0; j < it.qty; j++) {
      units.push({ w: it.w, h: it.h, material: it.material, area: it.w * it.h });
    }
  }
  // Matted prints ship from Kawika, not the lab: up to model.matted.per_mailer to a mailer, each
  // mailer a flat charge (already marked up) added to whatever the lab part of the order costs.
  var mm = model.matted || { per_mailer: 3, hi: 0, mainland: 0 };
  var mailers = matted ? Math.ceil(matted / mm.per_mailer) : 0;
  var oversize = function (u) {
    return Math.max(u.w, u.h) > model.max_long_edge_in || Math.min(u.w, u.h) > model.max_short_edge_in ||
      u.area > model.mainland_box_max_sq_in;
  };
  for (i = 0; i < units.length; i++) {
    if (oversize(units[i])) return { ships: false, pickupOnly: true, boxes: [], mailers: mailers };
  }
  if (!units.length && !mailers) return { ships: false, pickupOnly: false, boxes: [], mailers: 0 };
  if (!units.length) {
    return { ships: true, pickupOnly: false, hi: mailers * mm.hi, mainland: mailers * mm.mainland, hiQuote: 0,
      mainlandQuote: 0, boxes: [], mailers: mailers };
  }

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
  return { ships: true, pickupOnly: false, hi: charge(hq) + mailers * mm.hi, mainland: charge(mq) + mailers * mm.mainland,
    hiQuote: hq, mainlandQuote: mq, boxes: boxes, mailers: mailers };
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
    var v = KL.product && KL.product.current();
    if (v) KL.track("add_to_cart", { currency: "USD", value: v.price, items: [KL.item(v.id, KL.product.title, v.size, v.material, v.price)] });
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
  var ack = root.querySelector("[data-terms-ack]");
  var ready = function () { return !ack || ack.checked; };
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
      info.appendChild(el("p", "cart-meta", (v.material === "matted" ? v.size + " print, in an 11 x 14 mat" : v.size + " in, " + v.material) +
        (v.ships ? "" : ". Pickup on Oʻahu only")));
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
    go.disabled = !ready();
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
    go.disabled = !ready();
    status.textContent = "Your cart changed. Check out again when you're ready.";
  }

  function checkout() {
    var ls = lines();
    if (!ls.length || started || !ready()) return;
    started = true;
    go.disabled = true;
    KL.beginCheckout(ls.map(function (x) { return KL.item(x.id, x.v.title, x.v.size, x.v.material, x.v.price, x.qty); }));
    status.textContent = "Opening secure checkout...";
    status.classList.remove("is-error");
    Promise.all([
      post({ action: "create", terms_ack: true, items: ls.map(function (x) { return { id: x.id, qty: x.qty }; }) }),
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

      // Price shipping as soon as the address has a state and ZIP (the form only calls the
      // address "complete" once the phone is in too, which is too late). Re-price when the
      // state changes; one request at a time, catching up to the latest address after.
      var priced = null, wanted = null, busy = false;
      var shipNote = document.querySelector("[data-ship-status]");
      function price() {
        if (busy || !wanted || wanted.key === priced) return;
        busy = true;
        var want = wanted, reply = null;
        shipNote.classList.remove("is-error");
        shipNote.textContent = "Finding shipping for " + want.addr.state + "...";
        sdk.loadActions().then(function (r) {
          if (r.type !== "success") throw new Error("actions");
          var a = r.actions;
          return a.runServerUpdate(function () {
            return post({ action: "shipping", session_id: a.getSession().id, address: want.addr })
              .then(function (out) { if (out.type === "error") throw new Error(out.message); reply = out; return out; });
          });
        }).then(function () {
          priced = want.key;
          var msg = reply && reply.value && reply.value.message;
          shipNote.classList.toggle("is-error", !!msg);
          shipNote.textContent = msg || "";
        }).catch(function (e) {
          shipNote.classList.add("is-error");
          shipNote.textContent = e && e.message && e.message !== "actions" ? e.message
            : "Shipping didn't load. Check the address, or choose free pickup.";
        }).then(function () {
          busy = false;
          if (wanted.key !== priced && wanted !== want) price();
        });
      }
      form.on("change", function (ev) {
        var sa = ev.value && ev.value.shippingAddress;
        var addr = sa && sa.address;
        if (!addr || !addr.country || !addr.state || !/^\d{5}/.test(addr.postal_code || "")) return;
        wanted = { key: addr.country + "|" + addr.state + "|" + addr.postal_code.slice(0, 5), addr: addr };
        price();
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
      if (ack) {
        go.disabled = !ack.checked;
        ack.addEventListener("change", function () { if (!started) go.disabled = !ack.checked; });
      }
    })
    .catch(function () {
      empty.hidden = false;
      empty.textContent = "The cart couldn't load. Please refresh the page.";
    });
})();

/* 08 Analytics events ---------------------------------------------------------- */
/* view_item, add_to_cart and begin_checkout fire in blocks 02, 06 and 07. The purchase fires here,
   on the thank-you page Stripe returns to, from what begin_checkout remembered. Each Stripe
   session is reported once, even if the page is reloaded. */
(function () {
  "use strict";
  if (!document.querySelector("[data-cart-clear]")) return;
  var m = /[?&]session_id=(cs_[A-Za-z0-9_]+)/.exec(location.search);
  if (!m) return;
  var done = KL.store("kl_purchased") || [];
  if (done.indexOf(m[1]) >= 0) return;
  var pending = KL.store("kl_pending");
  if (pending && pending.items) {
    KL.track("purchase", { transaction_id: m[1], currency: "USD", value: pending.value, items: pending.items });
  }
  done.push(m[1]);
  KL.store("kl_purchased", done.slice(-20));
  try { localStorage.removeItem("kl_pending"); } catch (e) { /* nothing to clear */ }
})();
