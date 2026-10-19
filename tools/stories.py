#!/usr/bin/env python3
"""Instagram stories (1080 x 1920) for kawikalopez.com, made from the site's own prints and room scenes,
so every print shows on a wall at its real size the way the store shows it.

  python3 tools/stories.py <out-dir>          writes <out-dir>/<set>/<NN-name>.png, the still of each slide
  python3 tools/stories.py <out-dir> --video  also writes <NN-name>.mp4, the moving version (needs ffmpeg)

Needs tools/node_modules/playwright. Every run checks the layout of the stills: words inside the 80 px
side margins and clear of the top 230 and bottom 320 pixels Instagram covers, words clear of the
pictures, and room around each print inside its picture. Problems print as FIX lines.

The slides are the SETS list below: the realtor program from October 2026, three sets of two or three
slides, each written to be viewed in order. Each set goes in its own folder, numbered 01, 02, 03.

Motion: every slide is one page with a timeline, window.at(t) (frame(t) inside the page). The still is the same page settled at
the end of its motion with the first photograph showing. Each slide picks its own headline motion
(fx): rise (words rise in), drop (words drop in with a little bounce), mask (words slide up out of a
mask), or chars (letters fade up one by one). On top of that a slide can have words that glint, a
price that counts down to the realtor price, a word that fades away, or an underline that keeps
redrawing. Rooms zoom slowly toward the print while the photograph in the frame changes every beat.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

PANOS = ["kaimana", "naniwaikiki", "043", "kaaawavalley", "038"]

# Each set is two or three slides posted together and meant to be viewed in order. Each one loosely
# follows StoryBrand: the realtor is the hero, the gift that's gone by the weekend is the problem,
# Kawika is the guide, three steps are the plan, signing up is the call to action, and buyers who
# think of their agent every time they see the print are the success.
SETS = [
    ("set-1-announcement", [
        {"name": "announce", "kind": "room", "theme": "ocean", "fx": "rise", "glint": ["15%", "off"],
         "prints": ["leahikahiko", "malie", "makapuubeach-h", "kaaawasunrise", "hanohanohakipuu"], "size": [36, 24],
         "eyebrow": "New on kawikalopez.com", "head": "Hawaiʻi realtors now get 15% off every print",
         "sub": "Give your buyers a closing gift they'll keep, made here on Oʻahu."},
        {"name": "prices", "kind": "prices", "theme": "ocean", "fx": "mask", "seconds": 8,
         "eyebrow": "Realtor price", "head": "15% off every print, every time you order",
         "rows": [["Matted print", 55, 47], ["24 x 16 metal", 360, 306], ["48 x 16 panorama", 950, 808]],
         "sub": "Pickup on Oʻahu is free, so it's ready for the closing table."},
        {"name": "sign-up", "kind": "cta", "theme": "ocean", "fx": "drop", "seconds": 8,
         "eyebrow": "How it works", "head": "Three steps, and your 15% is set up",
         "steps": ["Sign up with your brokerage email", "Tap the link we email you", "Shop signed in, and 15% comes off"],
         "url": "kawikalopez.com/realtors", "tap": "Tap the link to sign up"},
    ]),
    ("set-2-closing-gift", [
        {"name": "problem", "kind": "room", "fx": "rise", "fade": ["gone"],
         "prints": PANOS, "size": [48, 16],
         "eyebrow": "For Hawaiʻi realtors", "head": "The wine is gone by the weekend",
         "sub": "A print of their new neighborhood stays on the wall for years."},
        {"name": "guide", "kind": "stack", "fx": "chars", "seconds": 8,
         "prints": [["naniwaikiki", "Waikīkī"], ["malie", "North Shore"], ["kaaawavalley", "Windward side"]],
         "eyebrow": "Their side of the island", "head": "Their new neighborhood",
         "sub": "You helped them find home. A print of it says the rest."},
        {"name": "success", "kind": "room", "fx": "rise", "underline": ["every", "time"],
         "prints": ["naniwaikiki", "kaaawavalley", "kaimana", "038", "043"], "size": [48, 16],
         "eyebrow": "15% off for Hawaiʻi realtors", "head": "They'll think of you every time they see it",
         "sub": "Sign up with your brokerage email and give your buyers a print of home.",
         "url": "kawikalopez.com/realtors"},
    ]),
    ("set-3-every-buyer", [
        {"name": "thank-you", "kind": "matted", "fx": "rise", "glint": ["$47"], "tick": {"$47": [55, 47]},
         "prints": ["leahikahiko", "malie", "makapuubeach-h", "kaaawasunrise"],
         "eyebrow": "For Hawaiʻi realtors", "head": "A $47 thank-you for every buyer",
         "sub": "Diamond Head in a mat that fits any 11 x 14 frame, at your realtor price.",
         "url": "kawikalopez.com/realtors"},
        {"name": "ideas", "kind": "room", "fx": "mask", "dot": True, "underline_url": True,
         "prints": ["043", "naniwaikiki", "kaaawavalley", "kaimana", "038"], "size": [48, 16],
         "eyebrow": "New on the blog", "head": "Closing gift ideas for Oʻahu realtors",
         "sub": "What to spend, how to time it, and how to give a gift that stays on the wall.",
         "url": "kawikalopez.com/blog"},
    ]),
]

BEAT = 2.3     # seconds each photograph shows in a room
FPS = 30

CSS = """
html, body { margin: 0; background: #2f2e2c; }
.slide { width: 1080px; height: 1920px; position: relative; overflow: hidden; background: var(--paper); color: var(--ink);
  font-family: var(--sans); -webkit-font-smoothing: antialiased; --hl: var(--accent); --band: #63b6c6; --line: #c9a24a; }
.s-logo { position: absolute; top: 236px; left: 80px; height: 64px; width: auto; }
.s-text { position: absolute; left: 80px; right: 80px; top: 340px; }
.s-eyebrow { font-size: 30px; line-height: 1.2; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-2); font-weight: 500; margin: 0;
  display: flex; align-items: center; gap: 16px; }
.s-dot { width: 16px; height: 16px; border-radius: 50%; background: var(--line); flex: none; }
.s-head { font-family: var(--serif); font-weight: 400; font-size: 112px; line-height: 1.0; margin: 26px 0 0; text-wrap: balance;
  letter-spacing: -0.005em; position: relative; }
.s-sub { font-size: 40px; line-height: 1.38; margin: 30px 0 0; max-width: 24em; text-wrap: pretty; }
.s-url { font-size: 44px; font-weight: 600; color: var(--accent); margin: 28px 0 0; position: relative; display: inline-block; }
.s-room { position: absolute; left: 0; right: 0; top: 930px; height: 608px; }
.s-room .g-room, .s-nook .g-room { position: absolute; inset: 0; }
.s-caps { position: absolute; left: 80px; right: 80px; top: 1556px; height: 40px; }
.s-caption { position: absolute; left: 0; top: 0; font-size: 26px; color: var(--ink-2); margin: 0; white-space: nowrap; }
.s-swap { position: absolute; inset: 0; }
.s-swap picture, .s-swap img { display: block; width: 100%; height: 100%; object-fit: cover; }

/* Headline pieces the timeline moves. */
.s-word, .s-mw, .s-wc { display: inline-block; }
.s-mw { overflow: hidden; vertical-align: top; padding-bottom: 0.12em; margin-bottom: -0.12em; }
.s-ch { display: inline-block; }
.s-hl { color: transparent; -webkit-background-clip: text; background-clip: text; background-repeat: no-repeat;
  background-image: linear-gradient(105deg, var(--hl) 0%, var(--hl) 38%, var(--band) 47%, var(--band) 53%, var(--hl) 62%, var(--hl) 100%); }
.s-line { position: absolute; height: 7px; background: var(--line); transform-origin: left center; border-radius: 4px; }
.s-caret { display: inline-block; width: 4px; height: 0.95em; background: currentColor; margin-left: 4px; vertical-align: -0.12em; }

/* The announcement set: the site's deep ocean blue, so the dark living room reads against it. */
.slide.ocean { background: var(--accent); color: #f4f2ed; --hl: #f3e3b5; --band: #ffffff; --line: #f3e3b5; }
.slide.ocean .s-logo { filter: brightness(0) invert(1); }
.slide.ocean .s-eyebrow, .slide.ocean .s-caption { color: #bfdde3; }
.slide.ocean .s-url, .slide.ocean .s-now, .slide.ocean .s-cta-url, .slide.ocean .s-steps li::before { color: #f3e3b5; }
.slide.ocean .s-row { border-bottom-color: rgba(244, 242, 237, .24); }
.slide.ocean .s-was, .slide.ocean .s-tap { color: #bfdde3; }
.slide.ocean .s-steps li { background: rgba(244, 242, 237, .1); }
.slide.ocean .s-room { box-shadow: 0 -1px 0 rgba(244, 242, 237, .14), 0 1px 0 rgba(244, 242, 237, .14); }

/* Three prints hung on a wall, each with the part of the island it shows. */
.s-wall { position: absolute; left: 0; right: 0; top: 800px; height: 840px; background: linear-gradient(180deg, var(--wall), var(--wall-2));
  display: grid; align-content: center; justify-items: center; gap: 22px; padding: 0 120px; }
.s-print { position: relative; transform-origin: 50% -40px; box-shadow: 0 18px 30px rgba(30, 26, 20, .28), 0 3px 6px rgba(30, 26, 20, .18); }
.s-print img { display: block; width: 100%; height: 100%; object-fit: cover; }
.s-print-wrap { display: grid; justify-items: center; gap: 12px; }
.s-label { font-size: 28px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink); font-weight: 500; }

/* Price rows: the regular price gets crossed out and the realtor price counts down to its figure. */
.s-prices { position: absolute; left: 80px; right: 80px; top: 820px; margin: 0; }
.s-row { display: grid; grid-template-columns: 1fr auto auto; align-items: baseline; gap: 34px; padding: 26px 0;
  border-bottom: 2px solid var(--rule); font-variant-numeric: tabular-nums; }
.s-row dt { font-family: var(--serif); font-size: 58px; line-height: 1.05; }
.s-row dd { margin: 0; }
.s-was { font-size: 38px; color: var(--ink-2); position: relative; }
.s-strike { position: absolute; left: -4px; right: -4px; top: 54%; height: 3px; background: currentColor; transform-origin: left center; }
.s-now { font-size: 58px; font-weight: 600; color: var(--accent); min-width: 3.4ch; text-align: right; }
.s-prices + .s-sub { position: absolute; left: 80px; right: 80px; top: 1260px; }

/* Matted print above the side table. */
.s-nook { position: absolute; left: 0; right: 0; top: 900px; height: 760px; }

/* Sign-up steps, and the address that types itself. */
.s-steps { position: absolute; left: 80px; right: 80px; top: 860px; margin: 0; padding: 0; list-style: none; counter-reset: s; display: grid; gap: 22px; }
.s-steps li { counter-increment: s; display: grid; grid-template-columns: 76px 1fr; align-items: center; gap: 22px; padding: 26px 30px;
  background: var(--paper-2); font-size: 42px; line-height: 1.25; }
.s-steps li::before { content: counter(s); font-family: var(--serif); font-size: 76px; line-height: 1; color: var(--accent); }
.s-cta-url { position: absolute; left: 80px; right: 80px; top: 1300px; font-size: 56px; font-weight: 600; color: var(--accent); margin: 0; white-space: nowrap; }
.s-tap { position: absolute; left: 80px; right: 80px; top: 1384px; font-size: 34px; color: var(--ink-2); margin: 0; }
"""

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="{{ root }}assets/css/site.css"><style>{{ css }}</style></head><body>
{% import "partials/gifts.html" as gx with context %}
{% macro headline(s) -%}
{%- for w in s.head.split() -%}
  {%- set cls = "s-word" ~ (" s-hl" if w in s.get("glint", []) else "") ~ (" s-fade" if w in s.get("fade", []) else "") ~ (" s-under" if w in s.get("underline", []) else "") -%}
  {%- set inner -%}
    {%- if w in s.get("tick", {}) -%}{{ w[0] }}<span class="s-num" data-from="{{ s.tick[w][0] }}" data-to="{{ s.tick[w][1] }}" data-at="1.25">{{ s.tick[w][1] }}</span>
    {%- elif s.fx == "chars" -%}{% for c in w %}<span class="s-ch">{{ c }}</span>{% endfor %}
    {%- else -%}{{ w }}{%- endif -%}
  {%- endset -%}
  {%- if s.fx == "mask" -%}<span class="s-mw"><span class="{{ cls }}">{{ inner }}</span></span>
  {%- elif s.fx == "chars" -%}<span class="s-wc {{ cls }}">{{ inner }}</span>
  {%- else -%}<span class="{{ cls }}">{{ inner }}</span>{%- endif %} {% endfor -%}
{%- endmacro %}
<div class="slide{% if s.get('theme') %} {{ s.theme }}{% endif %}">
  <img class="s-logo s-in" data-in="-0.3" src="{{ root }}assets/img/site/logo-horizontal.svg" alt="">
  <div class="s-text">
    <p class="s-eyebrow s-in" data-in="-0.15">{% if s.get("dot") %}<span class="s-dot"></span>{% endif %}<span>{{ s.eyebrow }}</span></p>
    <h1 class="s-head">{{ headline(s) }}</h1>
    {% if s.kind in ("room", "stack", "matted", "cta") and s.get("sub") %}<p class="s-sub s-in" data-in="0.83">{{ s.sub }}</p>{% endif %}
    {% if s.kind in ("room", "matted") and s.get("url") %}<p class="s-url s-in{% if s.get('underline_url') %} s-under{% endif %}" data-in="1.1">{{ s.url }}</p>{% endif %}
  </div>
  {% if s.kind == "room" %}
  <div class="s-room">
    <div class="g-room">
      <div class="g-room-in" style="width:175%;left:-37.5%;top:-36%;transform-origin:{{ room.origin }}">
        {{ gx.scene_img(room.scene, "1080px", True) }}
        <div class="g-room-print g-metal" style="left:{{ room.rect.left }}%;top:{{ room.rect.top }}%;width:{{ room.rect.width }}%;height:{{ room.rect.height }}%">
          {% for p in prints %}<div class="s-swap">{{ picture(p, "900px", alt="") }}</div>{% endfor %}
        </div>
      </div>
    </div>
  </div>
  <div class="s-caps">{% for p in prints %}<p class="s-caption">{{ p.title }}, {{ room.w }} x {{ room.h }} metal</p>{% endfor %}</div>
  {% elif s.kind == "matted" %}
  <div class="s-nook">
    <div class="g-room">
      <div class="g-room-in" style="width:150%;left:-25%;top:-15%;transform-origin:{{ mat.origin }}">
        {{ gx.scene_img(mat.scene, "1080px", True) }}
        <div class="g-room-print g-matted" style="left:{{ mat.rect.left }}%;top:{{ mat.rect.top }}%;width:{{ mat.rect.width }}%;height:{{ mat.rect.height }}%">
          <div class="g-opening" style="left:{{ '%.3f' % mat.opening.left }}%;top:{{ '%.3f' % mat.opening.top }}%;width:{{ '%.3f' % mat.opening.width }}%;height:{{ '%.3f' % mat.opening.height }}%">
            {% for p in prints %}<div class="s-swap">{{ picture(p, "600px", alt="") }}</div>{% endfor %}
          </div>
        </div>
      </div>
    </div>
  </div>
  {% elif s.kind == "stack" %}
  <div class="s-wall">
    {% for x in stack %}
    <div class="s-print-wrap">
      <div class="s-print" style="width:{{ x.w }}px;height:{{ x.h }}px">{{ picture(x.p, "900px", alt="") }}</div>
      <span class="s-label">{{ x.label }}</span>
    </div>
    {% endfor %}
  </div>
  {% elif s.kind == "prices" %}
  <dl class="s-prices">
    {% for name, was, now in s.rows %}
    <div class="s-row"><dt>{{ name }}</dt><dd class="s-was">$<span class="s-num">{{ was }}</span><span class="s-strike"></span></dd><dd class="s-now"><span class="s-glint">$<span class="s-num" data-from="{{ was }}" data-to="{{ now }}">{{ now }}</span></span></dd></div>
    {% endfor %}
  </dl>
  <p class="s-sub">{{ s.sub }}</p>
  {% elif s.kind == "cta" %}
  <ol class="s-steps">{% for t in s.steps %}<li>{{ t }}</li>{% endfor %}</ol>
  <p class="s-cta-url"><span class="s-glint"><span class="s-type" data-text="{{ s.url }}">{{ s.url }}</span></span><span class="s-caret"></span></p>
  <p class="s-tap">{{ s.tap }}</p>
  {% endif %}
</div>
<script>
const FX = {{ s.fx | tojson }}, KIND = {{ s.kind | tojson }}, BEAT = {{ beat }}, LENGTH = {{ seconds }};
const $$ = q => [...document.querySelectorAll(q)];
const cl = x => x < 0 ? 0 : x > 1 ? 1 : x;
const out3 = x => 1 - Math.pow(1 - cl(x), 3);
const glide = x => { x = cl(x); return x * x * (3 - 2 * x); };
const back = x => { x = cl(x); const c = 1.9; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };

// Everything measured from the text is laid out once, on the first frame, after the fonts have loaded.
let hl = [], hlSpan = [0, 0], hlW = 0, gl = [], unders = [];
function setup() {
if (typer) typer.textContent = typer.dataset.text;   // measure the address at its full length
// Glint: the highlighted headline words share one strip of light; every .s-glint gets its own.
hl = $$(".s-hl");
hlSpan = hl.length ? [Math.min(...hl.map(e => e.offsetLeft)), Math.max(...hl.map(e => e.offsetLeft + e.offsetWidth))] : [0, 0];
hlW = hlSpan[1] - hlSpan[0];
hl.forEach(e => { e.style.backgroundSize = (hlW * 3) + "px 100%"; });
gl = $$(".s-glint");
gl.forEach(e => {
  const c = getComputedStyle(e).color, band = getComputedStyle(document.querySelector(".slide")).getPropertyValue("--band");
  e.style.color = "transparent"; e.style.webkitBackgroundClip = "text"; e.style.backgroundClip = "text"; e.style.backgroundRepeat = "no-repeat";
  e.style.backgroundImage = `linear-gradient(105deg, ${c} 0%, ${c} 38%, ${band} 47%, ${band} 53%, ${c} 62%, ${c} 100%)`;
  e.style.backgroundSize = (e.offsetWidth * 3) + "px 100%";
});
// Underlines: one line under each underlined word.
unders = $$(".s-under").map(w => {
  const line = document.createElement("div"); line.className = "s-line";
  line.style.left = w.offsetLeft + "px"; line.style.width = w.offsetWidth + "px";
  line.style.top = (w.offsetTop + w.offsetHeight - (w.classList.contains("s-url") ? 2 : 10)) + "px";
  w.offsetParent.appendChild(line);
  return line;
});
}
// Where the light is, as a share of the words' width from their left edge; -0.45 means no light.
const pass = (t, start) => { const g = (t - start) % 3; return t < start || g > 1.4 ? -0.45 : -0.4 + glide(g / 1.4) * 1.8; };

const swaps = $$(".s-swap"), caps = $$(".s-caption");
const zoomer = document.querySelector(".s-room .g-room-in, .s-nook .g-room-in");
const typer = document.querySelector(".s-type");

function words(t) {
  if (FX === "chars") {
    $$(".s-ch").forEach((c, j) => {
      const k = out3((t + 0.1 - j * 0.045) / 0.75);
      c.style.opacity = k; c.style.transform = `translateY(${(1 - k) * 34}px)`; c.style.filter = `blur(${(1 - k) * 8}px)`;
    });
    return;
  }
  $$(".s-word").forEach((w, i) => {
    if (FX === "rise") { const k = out3((t + 0.18 - i * 0.083) / 0.57); w.style.opacity = k; w.style.transform = `translateY(${(1 - k) * 46}px)`; }
    if (FX === "drop") { const x = (t + 0.1 - i * 0.09) / 0.6; w.style.opacity = cl(x * 2.5); w.style.transform = `translateY(${-(1 - back(x)) * 80}px)`; }
    if (FX === "mask") { const k = out3((t + 0.15 - i * 0.075) / 0.7); w.style.transform = `translateY(${(1 - k) * 112}%)`; }
  });
}

let measured = false;
function frame(t, still) {
  if (!measured) { measured = true; frame(0, false); setup(); }
  words(t);
  $$(".s-in").forEach(el => {
    const k = out3((t - Number(el.dataset.in)) / 0.75);
    el.style.opacity = k; el.style.transform = `translateY(${(1 - k) * 28}px)`;
  });
  // A price that counts down to the realtor price.
  $$(".s-head .s-num").forEach(n => {
    const k = out3((t - Number(n.dataset.at)) / 1.1);
    n.textContent = Math.round(Number(n.dataset.from) + (Number(n.dataset.to) - Number(n.dataset.from)) * k);
  });
  // A word that fades away (the wine that's gone by the weekend).
  $$(".s-fade").forEach(w => {
    const k = glide((t - 1.7) / 1.6);
    w.style.opacity = Number(w.style.opacity || 1) * (1 - 0.68 * k);
    w.style.letterSpacing = (0.07 * k) + "em"; w.style.filter = `blur(${1.6 * k}px)`;
  });
  // Underlines that draw, hold, fade and draw again.
  unders.forEach((line, i) => {
    const start = 1.6 + i * 0.22, c = still ? 1.2 : (t - start) % 3.2;
    const draw = !still && t < start ? 0 : glide(c / 0.6), fade = still ? 0 : glide((c - 2.5) / 0.45);
    line.style.transform = `scaleX(${draw})`; line.style.opacity = 1 - fade;
  });
  // Glints, once the words have landed.
  hl.forEach(e => { e.style.backgroundPosition = `${((still ? -0.45 : pass(t, 1.3)) - 1.5) * hlW - (e.offsetLeft - hlSpan[0])}px 0`; });

  if (KIND === "room" || KIND === "matted") {
    // One room, zooming in toward the print the whole time; the photograph in the frame changes every beat.
    zoomer.style.transform = `scale(${still ? 1 : 1 + ({{ zoom }} - 1) * glide(t / LENGTH)})`;
    const now = Math.min(swaps.length - 1, Math.floor(t / BEAT));
    swaps.forEach((s, i) => {
      s.style.zIndex = i;
      s.style.opacity = still ? (i === 0 ? 1 : 0) : (i === 0 ? 1 : glide((t - i * BEAT) / 0.35));
      if (caps[i]) caps[i].style.opacity = still ? (i === 0 ? 1 : 0) : (i === now ? out3((t - 0.9) / 0.6) : 0);
    });
  }
  if (KIND === "stack") {
    // The wall comes up, then each print is hung and swings to a stop; the wall drifts closer.
    const wall = document.querySelector(".s-wall");
    wall.style.opacity = still ? 1 : out3((t - 0.5) / 0.6);
    wall.style.transform = `scale(${still ? 1 : 1 + 0.05 * glide(t / LENGTH)})`;
    $$(".s-print-wrap").forEach((w, i) => {
      const t0 = 1.0 + i * 0.6, k = out3((t - t0) / 0.55), d = Math.max(0, t - t0 - 0.2);
      const p = w.querySelector(".s-print"), label = w.querySelector(".s-label");
      p.style.opacity = still ? 1 : cl((t - t0) / 0.25);
      const swing = still ? 0 : (t < t0 + 0.2 ? -5 : 4.5 * Math.exp(-2.6 * d) * Math.cos(8.5 * d));
      p.style.transform = `translateY(${still ? 0 : -(1 - k) * 90}px) rotate(${swing}deg)`;
      label.style.opacity = still ? 1 : out3((t - t0 - 0.55) / 0.5);
    });
  }
  if (KIND === "prices") {
    $$(".s-row").forEach((r, i) => {
      const t0 = 1.4 + i * 0.55, k = out3((t - t0) / 0.6);
      r.style.opacity = k; r.style.transform = `translateY(${(1 - k) * 34}px)`;
      r.querySelector(".s-strike").style.transform = `scaleX(${glide((t - t0 - 0.45) / 0.35)})`;
      const n = r.querySelector(".s-now .s-num"), m = out3((t - t0 - 0.6) / 0.9);
      n.textContent = Math.round(Number(n.dataset.from) + (Number(n.dataset.to) - Number(n.dataset.from)) * m);
    });
    const sub = document.querySelector(".s-prices + .s-sub"), k = out3((t - 3.6) / 0.7);
    sub.style.opacity = k; sub.style.transform = `translateY(${(1 - k) * 28}px)`;
    gl.forEach((e, i) => { const W = e.offsetWidth; e.style.backgroundPosition = `${((still ? -0.45 : pass(t, 4.6 + i * 0.25)) - 1.5) * W}px 0`; });
  }
  if (KIND === "cta") {
    $$(".s-steps li").forEach((li, i) => {
      const k = out3((t - 1.5 - i * 0.5) / 0.6);
      li.style.opacity = k; li.style.transform = `translateX(${-(1 - k) * 90}px)`;
    });
    const full = typer.dataset.text, typed = 3.2 + full.length * 0.05;
    typer.textContent = full.slice(0, still ? full.length : Math.max(0, Math.min(full.length, Math.floor((t - 3.2) / 0.05))));
    const caret = document.querySelector(".s-caret");
    caret.style.opacity = still || t < 3.1 ? 0 : (t < typed ? 1 : (Math.floor((t - typed) / 0.5) % 2 ? 0 : 1));
    const tap = document.querySelector(".s-tap"), k = out3((t - typed - 0.2) / 0.6);
    tap.style.opacity = k; tap.style.transform = `translateY(${(1 - k) * 20}px)`;
    gl.forEach(e => { const W = e.offsetWidth; e.style.backgroundPosition = `${((still ? -0.45 : pass(t, typed + 0.8)) - 1.5) * W}px 0`; });
  }
  // The eyebrow's dot breathes.
  $$(".s-dot").forEach(d => { d.style.transform = `scale(${still ? 1 : 1 + 0.28 * Math.max(0, Math.sin(t * 3.4))})`; });
}
window.at = t => frame(t, false);
window.still = () => frame(LENGTH + 5, true);
</script></body></html>"""


def origin(rect):
    return f"{rect['left'] + rect['width'] / 2:.3f}% {rect['top'] + rect['height'] / 2:.3f}%"


def seconds_of(s):
    return BEAT * len(s["prints"]) if s["kind"] in ("room", "matted") else s.get("seconds", 8)


def render(b, s, root):
    ctx = {"s": s, "css": CSS, "root": root, "beat": BEAT, "seconds": seconds_of(s), "zoom": 1.3 if s["kind"] == "room" else 1.28}
    if s["kind"] in ("room", "matted"):
        prints = [b.gift_print(uid, s["name"]) for uid in s["prints"]]
        if len({p["orientation"] for p in prints}) > 1:
            raise SystemExit(f"{s['name']}: every print on one slide needs the same shape, so each fills the same frame")
        ctx["prints"] = prints
        if s["kind"] == "room":
            room = b.gift_room(prints[0], *s["size"])
            room["origin"] = origin(room["rect"])
            ctx["room"] = room
        else:
            mat = b.gift_matted(prints[0])
            mat["origin"] = origin(mat["rect"])
            ctx["mat"] = mat
    if s["kind"] == "stack":
        stack = []
        for uid, label in s["prints"]:
            p = b.gift_print(uid, s["name"])
            r = p.get("ratio") or 1.5
            w = 560 if p["orientation"] == "panoramic" else 260
            stack.append({"p": p, "label": label, "w": w, "h": round(w / r)})
        ctx["stack"] = stack
    return b.env.from_string(PAGE).render(**ctx)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = Path(args[0] if args else "stories").resolve()
    video = "--video" in sys.argv
    b = build.Builder(production=True, check=True)
    root = ROOT.as_uri() + "/"
    tmp = Path(tempfile.mkdtemp(prefix="kl-stories-"))
    jobs = []
    for folder, slides in SETS:
        (out / folder).mkdir(parents=True, exist_ok=True)
        for n, s in enumerate(slides, 1):
            name = f"{n:02d}-{s['name']}"
            page = tmp / f"{folder}-{name}.html"
            page.write_text(render(b, s, root))
            frames = tmp / f"{folder}-{name}-frames"
            frames.mkdir()
            jobs.append({"html": page.as_uri(), "png": str(out / folder / f"{name}.png"), "label": f"{folder}/{name}",
                         "frames": str(frames) if video else "", "fps": FPS, "seconds": seconds_of(s),
                         "mp4": str(out / folder / f"{name}.mp4")})
    script = ROOT / "tools" / ".stories-shot.mjs"
    script.write_text(SHOT)
    try:
        subprocess.run(["node", str(script), json.dumps(jobs)], cwd=ROOT / "tools", check=True)
    finally:
        script.unlink()
    if video:
        for j in jobs:
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(j["fps"]), "-i", j["frames"] + "/%04d.png",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", "-preset", "slow",
                            "-movflags", "+faststart", j["mp4"]], check=True)
            print(f"{j['label']}.mp4  {j['seconds']:.1f} s")


# Screenshots each slide's still, checks its layout, and steps through every frame for the videos.
SHOT = """
import { chromium } from "playwright";
const jobs = JSON.parse(process.argv[2]);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
let problems = 0;
for (const j of jobs) {
  await p.goto(j.html, { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() => window.still());
  await p.screenshot({ path: j.png, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
  const fix = await p.evaluate(() => {
    const out = [], r = el => el.getBoundingClientRect();
    const words = ".s-eyebrow, .s-head, .s-sub, .s-url, .s-caption, .s-cta-url, .s-tap, .s-row, .s-steps li";
    for (const el of document.querySelectorAll(words)) {
      if (getComputedStyle(el).opacity === "0") continue;
      const b = r(el), what = el.className + " '" + el.textContent.trim().slice(0, 24) + "'";
      if (b.left < 79 || b.right > 1001) out.push(what + " outside the side margins");
      if (b.top < 230 || b.bottom > 1600) out.push(what + " outside Instagram's safe area");
    }
    const text = document.querySelector(".s-text"), media = document.querySelector(".s-room, .s-nook, .s-wall, .s-prices, .s-steps");
    if (text && media && r(media).top - r(text).bottom < 24) out.push("words crowd the picture below them");
    const room = document.querySelector(".s-room"), print = document.querySelector(".s-room .g-room-print");
    if (room && print && r(print).top - r(room).top < 50) out.push("print sits too close to the top of its room picture");
    const nook = document.querySelector(".s-nook"), mat = document.querySelector(".s-nook .g-matted");
    if (nook && mat && r(mat).top - r(nook).top < 70) out.push("matted print sits too close to the top of its picture");
    const wall = document.querySelector(".s-wall");
    if (wall) {
      const items = [...wall.querySelectorAll(".s-print-wrap")];
      if (r(items[0]).top - r(wall).top < 36) out.push("top print sits too close to the top of the wall");
      if (r(wall).bottom - r(items[items.length - 1]).bottom < 36) out.push("bottom label sits too close to the bottom of the wall");
    }
    return out;
  });
  console.log(j.label + (fix.length ? "" : "  ok"));
  for (const f of fix) { console.log("  FIX " + f); problems++; }
  if (j.frames) {
    const n = Math.round(j.fps * j.seconds);
    for (let i = 0; i < n; i++) {
      await p.evaluate(t => window.at(t), i / j.fps);
      await p.screenshot({ path: `${j.frames}/${String(i).padStart(4, "0")}.png`, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
    }
  }
}
await b.close();
console.log(problems ? problems + " layout problem(s)" : "layout ok on every slide");
"""


if __name__ == "__main__":
    main()
