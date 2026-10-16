/* Holiday gift boxes (Baker's Heart x Kawika Lopez): the order window and its checkout.
   Rules (days, spots, boxes, prints) come from assets/js/bh-pickup.js (window.BH). The window
   builds the order; "Continue to payment" sends it to the gift checkout (gas/gift-checkout.gs),
   which checks it again and returns a Stripe session for Stripe's payment form, shown in the
   window. Stripe returns to this page with ?session_id, and the window shows the order and its
   pickup. Test mode only: ?today=YYYY-MM-DD pretends it's that day in Hawaiʻi. */
(function () {
  "use strict";
  var co = document.getElementById("co");
  if (!co || !window.BH) return;
  var R = BH.RULES;
  var cfg = { endpoint: co.getAttribute("data-endpoint"), mode: co.getAttribute("data-mode"), pk: co.getAttribute("data-pk") };
  var root = co.getAttribute("data-root") || "";
  var params = new URLSearchParams(location.search);
  var fakeToday = params.get("today") || "";
  var today = cfg.mode === "test" && /^\d{4}-\d{2}-\d{2}$/.test(fakeToday) ? fakeToday : BH.today(Date.now());
  var src = function (p) { return root + "assets/img/prints/" + p.img + "-480.jpg"; };
  var $ = function (id) { return document.getElementById(id); };
  var grid = $("co-grid");
  var order = { team: {}, client: {} };
  var tab = "team", spot = null, picked = null, month = null, lastFocus = null, form = null;
  var closed = !BH.firstOpen("kalihi", today);

  var count = function (box) { return Object.keys(order[box]).reduce(function (a, k) { return a + order[box][k]; }, 0); };
  var boxes = function () { return count("team") + count("client"); };
  var total = function () { return count("team") * R.boxes.team.price + count("client") * R.boxes.client.price; };
  var plural = function (n) { return n + " " + (n === 1 ? "box" : "boxes"); };
  var printOf = function (id) { return R.prints.filter(function (p) { return p.id === id; })[0]; };
  var esc = function (t) { return String(t).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); };
  function track(name, extra) {
    if (typeof window.gtag === "function") window.gtag("event", name, Object.assign({ currency: "USD", value: total() }, extra || {}));
  }

  function tiles() {
    grid.innerHTML = R.prints.map(function (p) {
      return '<div class="tile" data-id="' + p.id + '">' +
        '<div class="art"><div class="mat ' + (p.h ? "h" : "v") + '"><div class="photo"><img src="' + src(p) + '" alt="" loading="lazy"></div></div></div>' +
        '<div class="nm">' + esc(p.name) + '</div><div class="sz">' + (p.h ? "8 x 12" : "8 x 10") + " print</div>" +
        '<div class="step"><button type="button" data-step="-1" aria-label="One less ' + esc(p.name) + '">−</button><output aria-live="polite">0</output>' +
        '<button type="button" data-step="1" aria-label="One more ' + esc(p.name) + '">+</button></div></div>';
    }).join("");
  }

  function linesHtml() {
    var html = "";
    ["team", "client"].forEach(function (box) {
      var n = count(box);
      if (!n) return;
      var b = R.boxes[box];
      html += '<div class="co-grp"><div class="co-gh"><span>' + (n === 1 ? b.name : b.plural) + ", " + n + "</span><span>$" + n * b.price + "</span></div>";
      R.prints.forEach(function (p) {
        var q = order[box][p.id];
        if (q) html += '<div class="co-ln" data-line="' + box + "-" + p.id + '"><img src="' + src(p) + '" alt="">' + esc(p.name) + '<span class="q">' + q + "</span></div>";
      });
      html += "</div>";
    });
    return html;
  }

  function render(flashId) {
    $("co-what").textContent = R.boxes[tab].what;
    document.querySelectorAll(".co-tabs [role=tab]").forEach(function (b) { b.setAttribute("aria-selected", String(b.getAttribute("data-box") === tab)); });
    document.querySelectorAll("[data-badge]").forEach(function (b) {
      var n = count(b.getAttribute("data-badge"));
      b.textContent = n;
      b.toggleAttribute("data-zero", n === 0);
    });
    grid.querySelectorAll(".tile").forEach(function (t) {
      var n = order[tab][t.getAttribute("data-id")] || 0;
      t.querySelector("output").textContent = n;
      t.querySelector('[data-step="-1"]').disabled = n === 0;
      t.classList.toggle("on", n > 0);
    });
    $("co-lines").innerHTML = linesHtml() || '<p class="co-empty">Nothing here yet. Add a photograph to start your order.</p>';
    if (flashId) {
      var l = document.querySelector('[data-line="' + flashId + '"]');
      if (l) { l.classList.remove("flash"); void l.offsetWidth; l.classList.add("flash"); }
    }
    var n = boxes(), sum = total();
    $("co-count").textContent = plural(n);
    $("co-sum").textContent = "$" + sum;
    $("co-clear").hidden = n === 0;
    $("co-pay").textContent = n ? "Continue to payment, $" + sum : "Continue to payment";
    $("co-pb").textContent = plural(n) + ", $" + sum;
    var mine = document.querySelector(".mine");
    if (mine) mine.innerHTML = n ? 'Your order <span class="n">' + n + "</span>" : "Order a gift box";
    renderPickup();
  }

  function renderPickup() {
    var cal = $("co-cal"), note = $("co-note"), field = $("co-field");
    if (!spot) { cal.hidden = true; note.hidden = true; field.textContent = "Pick a spot first"; field.classList.remove("set"); return; }
    var first = BH.firstOpen(spot, today);
    note.hidden = false;
    if (!first) {
      cal.hidden = true; field.textContent = "No pickup days left"; field.classList.remove("set");
      note.textContent = "There are no pickup days left at this spot this season.";
      return;
    }
    if (picked && !BH.open(picked, spot, today)) picked = null;
    field.textContent = picked ? BH.long(picked) : "Pick a date";
    field.classList.toggle("set", !!picked);
    var lastDay = BH.long(BH.lastOpen(spot, today)).split(", ")[1];
    note.textContent = spot === "pearl"
      ? "Pearl City pickups are on Wednesdays, " + R.spots.pearl.hours + ", through " + lastDay + ". We need five business days to get your order ready, so the earliest you can pick is " + BH.long(first) + "."
      : "Kalihi pickups are weekdays, " + R.spots.kalihi.hours + ", through " + lastDay + ", and we're closed Thanksgiving weekend. We need five business days to get your order ready, so the earliest you can pick is " + BH.long(first) + ".";
    if (!month) month = (picked || first).slice(0, 7);
    var minM = first.slice(0, 7), maxM = R.last.slice(0, 7);
    var label = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    var h = '<div class="cal-h"><button type="button" data-mon="-1" aria-label="Previous month"' + (month <= minM ? " disabled" : "") + ">‹</button><b>" + label +
      '</b><button type="button" data-mon="1" aria-label="Next month"' + (month >= maxM ? " disabled" : "") + '>›</button></div><div class="cal-g">';
    h += ["S", "M", "T", "W", "T", "F", "S"].map(function (w) { return '<span class="wd">' + w + "</span>"; }).join("");
    h += new Array(BH.weekday(month + "-01") + 1).join("<span></span>");
    for (var d = month + "-01"; d.slice(0, 7) === month; d = BH.shift(d, 1)) {
      var dn = Number(d.slice(8));
      h += BH.open(d, spot, today)
        ? '<button type="button" data-day="' + d + '" aria-pressed="' + (picked === d) + '" aria-label="' + BH.long(d) + '">' + dn + "</button>"
        : '<span class="off" aria-hidden="true">' + dn + "</span>";
    }
    cal.innerHTML = h + "</div>";
    cal.hidden = false;
  }

  function showPane(which) {
    $("co-build").hidden = which !== "build";
    $("co-paying").hidden = which !== "pay";
    $("co-done").hidden = which !== "done";
    $("co-pbar").hidden = which !== "build";
    $("co-title").textContent = which === "pay" ? "Payment" : which === "done" ? "Thank you" : "Build your order";
    co.setAttribute("data-pane", which);
  }

  function openCo(box, pick) {
    if (closed && !co.hasAttribute("data-returning")) return;
    if (box) tab = box;
    lastFocus = document.activeElement;
    co.hidden = false;
    document.body.style.overflow = "hidden";
    render();
    co.querySelector(".co-x").focus();
    if (pick) {
      var t = grid.querySelector('[data-id="' + pick + '"]');
      t.scrollIntoView({ block: "center" });
      t.classList.remove("pulse"); void t.offsetWidth; t.classList.add("pulse");
    }
  }
  function closeCo() {
    if (co.getAttribute("data-pane") === "pay") backToBuild();
    co.hidden = true;
    document.body.style.overflow = "";
    if (lastFocus) lastFocus.focus();
  }

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

  function pickupHtml(spotInfo, day) {
    return '<div class="co-pickup-sum"><b>Pickup ' + esc(BH.long(day)) + ", " + esc(spotInfo.hours) + "</b>" +
      esc(spotInfo.name) + ", " + esc(spotInfo.address) + "</div>";
  }

  function pay() {
    var msg = $("co-msg"), go = $("co-pay");
    var why = !boxes() ? "Add at least one box first."
      : !spot ? "Pick a pickup spot first."
      : !picked ? "Pick a pickup date first."
      : !$("co-ack").checked ? "Tick the box to confirm you've read the terms of sale."
      : null;
    var can = BH.canOrder(boxes(), today);
    if (!why && !can.ok) why = can.why;
    if (!why && !cfg.endpoint) why = "Checkout isn't switched on yet.";
    msg.hidden = !why;
    if (why) { msg.textContent = why; return; }
    var items = [];
    ["team", "client"].forEach(function (box) {
      Object.keys(order[box]).forEach(function (id) { items.push({ box: box, print: id, qty: order[box][id] }); });
    });
    go.disabled = true;
    go.textContent = "Opening secure checkout...";
    track("begin_checkout");
    Promise.all([post({ action: "create", terms_ack: true, spot: spot, date: picked, items: items }), stripeJs()]).then(function (res) {
      var d = res[0];
      if (!d || !d.client_secret) throw { user: d && d.error };
      $("co-review").innerHTML = linesHtml() + '<div class="co-tot"><span>' + plural(boxes()) + "</span><span>$" + total() + "</span></div>" + pickupHtml(R.spots[spot], picked);
      showPane("pay");
      var sdk = res[1](cfg.pk).initCheckoutFormSdk({
        clientSecret: d.client_secret,
        appearance: { theme: "stripe", variables: { colorPrimary: "#4f5e3f", borderRadius: "0px" } }
      });
      form = sdk.createForm({
        layout: "expanded",
        expressCheckout: { paymentMethods: { applePay: "never", googlePay: "never", amazonPay: "never", paypal: "never", link: "never" } }
      });
      form.mount($("co-stripe"));
      $("co-scroll").scrollTop = 0;
      sdk.loadActions().then(function (r) {
        if (r.type !== "success") return;
        form.on("confirm", function (ev) {
          r.actions.confirm({ formConfirmEvent: ev }).then(function (out) {
            if (out && out.type === "error") console.warn("checkout:", out.error && out.error.message);
          }).catch(function (e) { console.warn("checkout:", e && e.message); });
        });
      });
    }).catch(function (e) {
      msg.textContent = (e && e.user) || "Checkout didn't open. Please try again.";
      msg.hidden = false;
    }).then(function () {
      go.disabled = false;
      render();
    });
  }

  function backToBuild() {
    if (form && form.unmount) { try { form.unmount(); } catch (e) { /* already gone */ } }
    form = null;
    $("co-stripe").innerHTML = "";
    showPane("build");
  }

  function done(id) {
    co.setAttribute("data-returning", "");
    showPane("done");
    openCo();
    var body = $("co-done-body");
    body.innerHTML = "<p>Finding your order...</p>";
    post({ action: "status", session_id: id }).then(function (d) {
      if (!d || d.error || !d.spot) throw 0;
      if (!d.paid) {
        body.innerHTML = "<h3>Your payment didn't go through</h3><p>Nothing was charged. You can build the order again whenever you're ready.</p>" +
          '<button class="btn" type="button" data-rebuild>Start again</button>';
        return;
      }
      var html = "<h3>Thank you. Your order is in.</h3>";
      d.lines.forEach(function (l) {
        var b = R.boxes[l.box], p = printOf(l.print);
        if (b && p) html += '<div class="co-ln"><img src="' + src(p) + '" alt="">' + esc(l.qty === 1 ? b.name : b.plural) + " with " + esc(p.name) + '<span class="q">' + l.qty + "</span></div>";
      });
      html += pickupHtml(d.spot, d.date);
      html += "<p>Give your name at the Touch A Heart table when you pick up. Stripe is emailing your receipt now.</p>" +
        "<p>Questions? Write to info@kawikalopez.com or call (808) 204-4575.</p>" +
        '<button class="btn" type="button" data-close>Close</button>';
      body.innerHTML = html;
      var seen = [];
      try { seen = JSON.parse(localStorage.getItem("bh_purchased") || "[]"); } catch (e) { /* storage off */ }
      if (seen.indexOf(id) < 0) {
        var value = d.lines.reduce(function (a, l) { return a + (R.boxes[l.box] ? R.boxes[l.box].price * l.qty : 0); }, 0);
        if (typeof window.gtag === "function") window.gtag("event", "purchase", { transaction_id: id, currency: "USD", value: value });
        seen.push(id);
        try { localStorage.setItem("bh_purchased", JSON.stringify(seen.slice(-20))); } catch (e) { /* storage off */ }
      }
    }).catch(function () {
      body.innerHTML = "<h3>We couldn't load your order</h3><p>If you paid, your receipt from Stripe is in your email, with your pickup day and spot.</p>" +
        '<button class="btn" type="button" data-close>Close</button>';
    });
  }

  document.addEventListener("click", function (e) {
    var o = e.target.closest("[data-open]");
    if (o) { openCo(o.getAttribute("data-open") || null); return; }
    var pk = e.target.closest("[data-pick]");
    if (pk) { openCo(null, pk.getAttribute("data-pick")); return; }
    if (e.target.closest("[data-close]")) { closeCo(); return; }
    if (e.target.closest("[data-rebuild]")) { co.removeAttribute("data-returning"); showPane("build"); render(); return; }
    var tb = e.target.closest(".co-tabs [role=tab]");
    if (tb) { tab = tb.getAttribute("data-box"); render(); return; }
    var st = e.target.closest("[data-step]");
    if (st) {
      var id = st.closest(".tile").getAttribute("data-id"), d = Number(st.getAttribute("data-step"));
      var n = Math.max(0, (order[tab][id] || 0) + d);
      if (n) order[tab][id] = n; else delete order[tab][id];
      $("co-msg").hidden = true;
      render(d > 0 ? tab + "-" + id : null);
      return;
    }
    if (e.target.id === "co-clear") { order.team = {}; order.client = {}; $("co-msg").hidden = true; render(); return; }
    var mo = e.target.closest("[data-mon]");
    if (mo) {
      var mdate = BH.shift(month + "-15", Number(mo.getAttribute("data-mon")) * 30);
      month = mdate.slice(0, 7);
      renderPickup();
      return;
    }
    var dy = e.target.closest("[data-day]");
    if (dy) { picked = dy.getAttribute("data-day"); $("co-msg").hidden = true; renderPickup(); return; }
    if (e.target.id === "co-pb-go") { $("co-side").scrollIntoView({ behavior: "smooth", block: "start" }); return; }
    if (e.target.id === "co-pay") { pay(); return; }
    if (e.target.id === "co-back") { backToBuild(); return; }
  });
  document.addEventListener("change", function (e) {
    if (e.target.name === "spot") { spot = e.target.value; month = null; $("co-msg").hidden = true; renderPickup(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !co.hidden) closeCo();
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches('[data-pick] [role="button"]')) {
      e.preventDefault();
      openCo(null, e.target.closest("[data-pick]").getAttribute("data-pick"));
    }
  });

  // The two Order buttons keep drawing the eye (Kawika, 2026-10-15): a thin outline in Baker's
  // Heart gold with one spark circling it, plus a light sweep across the button. People who ask
  // their device for less motion get the still outline.
  var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  var NS = "http://www.w3.org/2000/svg";
  document.querySelectorAll(".btn-order").forEach(function (btn, i) {
    var clip = document.createElement("span");
    clip.className = "shine-clip"; clip.setAttribute("aria-hidden", "true");
    var shine = document.createElement("span");
    shine.className = "shine"; clip.appendChild(shine); btn.appendChild(clip);
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "trace"); svg.setAttribute("aria-hidden", "true");
    var base = document.createElementNS(NS, "rect"), spark = document.createElementNS(NS, "rect");
    base.setAttribute("class", "trace-base"); spark.setAttribute("class", "trace-spark");
    [base, spark].forEach(function (r) { r.setAttribute("pathLength", "100"); r.setAttribute("x", "1"); r.setAttribute("y", "1"); svg.appendChild(r); });
    btn.appendChild(svg);
    var fit = function () {
      var w = btn.offsetWidth + 12, h = btn.offsetHeight + 12;
      svg.setAttribute("width", w + 2); svg.setAttribute("height", h + 2); svg.setAttribute("viewBox", "0 0 " + (w + 2) + " " + (h + 2));
      [base, spark].forEach(function (r) { r.setAttribute("width", w); r.setAttribute("height", h); });
    };
    fit();
    if (window.ResizeObserver) new ResizeObserver(fit).observe(btn);
    if (closed) { btn.disabled = true; btn.firstChild.nodeValue = "Ordering is closed for this season"; }
    if (still || closed) { spark.style.display = "none"; return; }
    spark.animate([{ strokeDashoffset: 0 }, { strokeDashoffset: -100 }], { duration: 3000, iterations: Infinity, easing: "linear", delay: -1500 * i });
    shine.animate([
      { transform: "translateX(-130%) skewX(-20deg)", offset: 0 },
      { transform: "translateX(330%) skewX(-20deg)", offset: 0.3 },
      { transform: "translateX(330%) skewX(-20deg)", offset: 1 }
    ], { duration: 3600, iterations: Infinity, easing: "ease-in-out", delay: 400 + 600 * i });
  });
  if (closed) {
    var mine = document.querySelector(".mine");
    if (mine) mine.hidden = true;
  }

  tiles();
  render();
  var sid = /^cs_(test|live)_[A-Za-z0-9]+$/.test(params.get("session_id") || "") ? params.get("session_id") : null;
  if (sid) done(sid);
  window.__co = { order: order, open: openCo, state: function () { return { tab: tab, spot: spot, picked: picked, today: today, closed: closed }; } };
})();
