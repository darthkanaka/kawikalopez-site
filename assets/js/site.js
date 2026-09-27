/* kawikalopez.com
   Hand written, no dependencies, loaded with defer. One IIFE per feature; each can be
   deleted on its own. The page works without any of this: prices and sizes are in the
   table, and the order link carries the default size.

   01 Shared
   02 Size and material picker
   03 Room preview (to scale)
   04 Contact form
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
        v.material + ", shown to scale above a 9 foot sofa.";
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

