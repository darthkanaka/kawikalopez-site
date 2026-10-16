/* Holiday gift boxes (Baker's Heart x Kawika Lopez): the pickup and order rules.
   The page (assets/js/bh-gift.js) and the checkout script (gas/gift-checkout.gs) both use them,
   so the block between the BEGIN and END lines is copied into the script word for word, and
   tools/test_bh_pickup.mjs --drift fails if the two copies differ. Days are "YYYY-MM-DD" strings
   in Hawaiʻi time, which compare correctly as strings. Rules decided with Kawika, 2026-10-15. */
(function (root) {
"use strict";
/* BEGIN bhRules: identical in assets/js/bh-pickup.js and gas/gift-checkout.gs (tools/test_bh_pickup.mjs --drift checks) */
var BH_RULES = {
  first: "2026-11-16",       // first pickup day, the day Touch A Heart starts holiday pickups
  last: "2026-12-22",        // last pickup day
  leadDays: 5,               // business days between placing an order and picking it up
  closed: ["2026-11-26", "2026-11-27", "2026-12-24", "2026-12-25"],   // weekdays with no pickups
  bigOrder: 25,              // orders over this many boxes...
  bigLastDay: "2026-12-01",  // ...can be placed through this day only
  spots: {
    kalihi: { name: "Kalihi Union Church", address: "2214 N. King St., Honolulu", hours: "8 am to 1 pm", days: [1, 2, 3, 4, 5] },
    pearl: { name: "Pearl City Community Church", address: "933 Lehua Ave., Pearl City", hours: "1:30 to 3 pm", days: [3] }
  },
  boxes: {
    team: { name: "Team box", plural: "Team boxes", price: 80,
      what: "Every Team box has a matted print of the photograph you pick and a Baker's Heart Double Box, twelve lace cookies in three flavors." },
    client: { name: "Client box", plural: "Client boxes", price: 120,
      what: "Every Client box has a matted print of the photograph you pick and a Baker's Heart gift box of lace cookies and biscotti bites." }
  },
  prints: [
    { id: "mokulele", name: "Mokulele", h: false, img: "mokulele" },
    { id: "mokulua", name: "Mokulua", h: true, img: "mokulua-islands" },
    { id: "shoreline", name: "Shoreline Cascade", h: false, img: "shorelinecascade" },
    { id: "leahi", name: "Lēʻahi Kahiko", h: true, img: "leahikahiko" },
    { id: "kahana", name: "Kahana", h: false, img: "kahana" },
    { id: "malie", name: "Mālie", h: true, img: "malie" }
  ]
};

/* Today's date in Hawaiʻi (UTC minus 10, no daylight saving). */
function bhToday(nowMs) {
  return new Date(nowMs - 10 * 3600 * 1000).toISOString().slice(0, 10);
}
function bhShift(day, n) {
  var d = new Date(day + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function bhWeekday(day) {
  return new Date(day + "T00:00:00Z").getUTCDay();
}
function bhIsBusinessDay(day) {
  var w = bhWeekday(day);
  return w > 0 && w < 6 && BH_RULES.closed.indexOf(day) < 0;
}
/* The day that is `n` business days after `day`. */
function bhAddBusinessDays(day, n) {
  var d = day;
  while (n > 0) {
    d = bhShift(d, 1);
    if (bhIsBusinessDay(d)) n--;
  }
  return d;
}
/* Can `spot` hand out an order on `day`, when the order is placed on `today`? */
function bhOpen(day, spot, today) {
  var s = BH_RULES.spots[spot];
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return false;
  var floor = bhAddBusinessDays(today, BH_RULES.leadDays);
  if (floor < BH_RULES.first) floor = BH_RULES.first;
  return day >= floor && day <= BH_RULES.last && bhIsBusinessDay(day) && s.days.indexOf(bhWeekday(day)) >= 0;
}
/* The first day `spot` can do for an order placed `today`, or null when it has none left. */
function bhFirstOpen(spot, today) {
  for (var d = today; d <= BH_RULES.last; d = bhShift(d, 1)) {
    if (bhOpen(d, spot, today)) return d;
  }
  return null;
}
/* The last day `spot` can do for an order placed `today`, or null. */
function bhLastOpen(spot, today) {
  for (var d = BH_RULES.last; d >= today; d = bhShift(d, -1)) {
    if (bhOpen(d, spot, today)) return d;
  }
  return null;
}
/* Can an order of `boxes` boxes be placed `today`? {ok: true}, or {ok: false, why} in words for the buyer. */
function bhCanOrder(boxes, today) {
  if (!(boxes >= 1)) return { ok: false, why: "Add at least one box first." };
  if (!bhFirstOpen("kalihi", today)) return { ok: false, why: "Ordering is closed for this season." };
  if (boxes > BH_RULES.bigOrder && today > BH_RULES.bigLastDay) {
    return { ok: false, why: "Orders of more than " + BH_RULES.bigOrder + " boxes could be placed through December 1. You can still order up to " + BH_RULES.bigOrder + "." };
  }
  return { ok: true };
}
/* "Wednesday, December 9" */
function bhLong(day) {
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  var d = new Date(day + "T00:00:00Z");
  return DAYS[d.getUTCDay()] + ", " + MONTHS[d.getUTCMonth()] + " " + d.getUTCDate();
}
/* END bhRules */

var api = { RULES: BH_RULES, today: bhToday, shift: bhShift, weekday: bhWeekday, isBusinessDay: bhIsBusinessDay,
  addBusinessDays: bhAddBusinessDays, open: bhOpen, firstOpen: bhFirstOpen, lastOpen: bhLastOpen,
  canOrder: bhCanOrder, long: bhLong };
if (typeof module === "object" && module.exports) module.exports = api;
else root.BH = api;
})(this);
