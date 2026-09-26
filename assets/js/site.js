/* kawikalopez.com
   Hand written, no dependencies, loaded with defer. One IIFE per feature; each can be
   deleted on its own. The page works without any of this: prices and sizes are in the
   table, and the order link carries the default size.

   01 Shared
   02 Size and material picker
   03 Room preview (to scale)
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
        v.material + ", shown to scale above a sofa.";
    }
  });
})();
