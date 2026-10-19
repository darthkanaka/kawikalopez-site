#!/usr/bin/env python3
"""Instagram story images (1080 x 1920) for kawikalopez.com, made from the site's own prints and room
scenes, so every print shows on a wall at its real size the way the store shows it.

  python3 tools/stories.py <out-dir>          writes <out-dir>/<set>/<NN-name>.png (needs tools/node_modules/playwright)
  python3 tools/stories.py <out-dir> --video  writes the VIDEOS as MP4 story videos instead (also needs ffmpeg)

Every run also checks the layout: words inside the 80 px side margins and Instagram's safe area,
words clear of the pictures, and each print with room around it inside its picture. Problems print
as FIX lines.

The slides are the SETS list below: the realtor program from October 2026, three sets of two or three
slides, each written to be viewed in order. Each set goes in its own folder, numbered 01, 02, 03. Instagram covers about the top 250 and bottom 340 pixels of a story with
its own bars and the link sticker, so words stay between those.
"""

import json
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent

# Each set is two or three slides posted together and meant to be viewed in order. Each one loosely
# follows StoryBrand: the realtor is the hero, the gift that's gone by the weekend is the problem,
# Kawika is the guide, three steps are the plan, signing up is the call to action, and buyers who
# think of their agent every time they see the print are the success.
SETS = [
    ("set-1-announcement", [
        {"name": "announce", "kind": "room", "theme": "ocean", "print": "leahikahiko", "size": [36, 24], "crop": [175, -37.5, -36],
         "eyebrow": "New on kawikalopez.com", "head": "Hawaiʻi realtors now get 15% off every print",
         "sub": "Give your buyers a closing gift they'll keep, made here on Oʻahu.",
         "caption": "Lēʻahi Kahiko, 36 x 24 metal"},
        {"name": "prices", "kind": "prices", "theme": "ocean",
         "eyebrow": "Realtor price", "head": "15% off every print, every time you order",
         "rows": [["Matted print", 55, 47], ["24 x 16 metal", 360, 306], ["48 x 16 panorama", 950, 808]],
         "sub": "Pickup on Oʻahu is free, so it's ready for the closing table."},
        {"name": "sign-up", "kind": "cta", "theme": "ocean",
         "eyebrow": "How it works", "head": "Three steps, and your 15% is set up",
         "steps": ["Sign up with your brokerage email", "Tap the link we email you", "Shop signed in, and 15% comes off"],
         "url": "kawikalopez.com/realtors", "tap": "Tap the link to sign up"},
    ]),
    ("set-2-closing-gift", [
        {"name": "problem", "kind": "room", "print": "kaimana", "size": [48, 16], "crop": [175, -37.5, -36],
         "eyebrow": "For Hawaiʻi realtors", "head": "The wine is gone by the weekend",
         "sub": "A print of their new neighborhood stays on the wall for years.", "caption": "Kaimana, 48 x 16 metal"},
        {"name": "guide", "kind": "stack", "prints": [["naniwaikiki", "Waikīkī"], ["malie", "North Shore"], ["kaaawavalley", "Windward side"]],
         "eyebrow": "Their side of the island", "head": "Their new neighborhood",
         "sub": "You helped them find home. A print of it says the rest."},
        {"name": "success", "kind": "room", "print": "naniwaikiki", "size": [48, 16], "crop": [175, -37.5, -36],
         "eyebrow": "15% off for Hawaiʻi realtors", "head": "They'll think of you every time they see it",
         "sub": "Sign up with your brokerage email and give your buyers a print of home.",
         "caption": "Nani Waikīkī, 48 x 16 metal", "url": "kawikalopez.com/realtors"},
    ]),
    ("set-3-every-buyer", [
        {"name": "thank-you", "kind": "matted", "print": "leahikahiko",
         "eyebrow": "For Hawaiʻi realtors", "head": "A $47 thank-you for every buyer",
         "sub": "Diamond Head in a mat that fits any 11 x 14 frame, at your realtor price.",
         "url": "kawikalopez.com/realtors"},
        {"name": "ideas", "kind": "room", "print": "043", "size": [48, 16], "crop": [175, -37.5, -36],
         "eyebrow": "New on the blog", "head": "Closing gift ideas for Oʻahu realtors",
         "sub": "What to spend, how to time it, and how to give a gift that stays on the wall.",
         "caption": "Mauka i Makai, 48 x 16 metal", "url": "kawikalopez.com/blog"},
    ]),
]

# Story videos: one room zooms in slowly toward the print the whole time, and the photograph in the
# frame changes every `beat` seconds. The words come in at the start, the highlighted words catch a
# slow glint over and over, and the caption under the room follows the photograph.
VIDEOS = [
    {"name": "set-1-announcement/01-announce", "theme": "ocean", "beat": 2.3, "fps": 30, "zoom": 1.3,
     "crop": [175, -37.5, -36], "size": [36, 24],
     "eyebrow": "New on kawikalopez.com", "head": "Hawaiʻi realtors now get 15% off every print",
     "sub": "Give your buyers a closing gift they'll keep, made here on Oʻahu.", "highlight": ["15%", "off"],
     # One room, one 36 x 24 frame: only the photograph in it changes. All horizontal prints, so each
     # fills the same frame, from five sides of the island.
     "prints": ["leahikahiko", "malie", "makapuubeach-h", "kaaawasunrise", "hanohanohakipuu"]},
]

CSS = """
html, body { margin: 0; background: #2f2e2c; }
.slide { width: 1080px; height: 1920px; position: relative; overflow: hidden; background: var(--paper); color: var(--ink);
  font-family: var(--sans); -webkit-font-smoothing: antialiased; }
.s-logo { position: absolute; top: 236px; left: 80px; height: 64px; width: auto; }
.s-text { position: absolute; left: 80px; right: 80px; top: 340px; }
.s-eyebrow { font-size: 30px; line-height: 1.2; letter-spacing: 0.16em; text-transform: uppercase; color: var(--ink-2); font-weight: 500; margin: 0; }
.s-head { font-family: var(--serif); font-weight: 400; font-size: 112px; line-height: 1.0; margin: 26px 0 0; text-wrap: balance; letter-spacing: -0.005em; }
.s-sub { font-size: 40px; line-height: 1.38; margin: 30px 0 0; max-width: 24em; text-wrap: pretty; }
.s-room { position: absolute; left: 0; right: 0; top: 930px; height: 608px; }
.s-room .g-room { position: absolute; inset: 0; }
.s-caption { position: absolute; left: 80px; top: 1556px; font-size: 26px; color: var(--ink-2); margin: 0; }
.s-url { font-size: 44px; font-weight: 600; color: var(--accent); margin: 28px 0 0; }

/* The announcement set: the site's deep ocean blue, so the dark living room reads against it. */
.slide.ocean { background: var(--accent); color: #f4f2ed; }
.slide.ocean .s-logo { filter: brightness(0) invert(1); }
.slide.ocean .s-eyebrow, .slide.ocean .s-caption { color: #bfdde3; }
.slide.ocean .s-url, .slide.ocean .s-now, .slide.ocean .s-cta-url, .slide.ocean .s-steps li::before { color: #f3e3b5; }
.slide.ocean .s-row { border-bottom-color: rgba(244, 242, 237, .24); }
.slide.ocean .s-was, .slide.ocean .s-tap { color: #bfdde3; }
.slide.ocean .s-steps li { background: rgba(244, 242, 237, .1); }
.slide.ocean .s-room { box-shadow: 0 -1px 0 rgba(244, 242, 237, .14), 0 1px 0 rgba(244, 242, 237, .14); }

/* Three prints stacked on a wall, each with the part of town it shows. */
.s-wall { position: absolute; left: 0; right: 0; top: 800px; height: 840px; background: linear-gradient(180deg, var(--wall), var(--wall-2));
  display: grid; align-content: center; justify-items: center; gap: 22px; padding: 0 120px; }
.s-print { position: relative; box-shadow: 0 18px 30px rgba(30, 26, 20, .28), 0 3px 6px rgba(30, 26, 20, .18); }
.s-print img { display: block; width: 100%; height: 100%; object-fit: cover; }
.s-print-wrap { display: grid; justify-items: center; gap: 12px; }
.s-label { font-size: 28px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink); font-weight: 500; }

/* Price rows. */
.s-prices { position: absolute; left: 80px; right: 80px; top: 820px; margin: 0; }
.s-row { display: grid; grid-template-columns: 1fr auto auto; align-items: baseline; gap: 34px; padding: 26px 0;
  border-bottom: 2px solid var(--rule); font-variant-numeric: tabular-nums; }
.s-row dt { font-family: var(--serif); font-size: 58px; line-height: 1.05; }
.s-was { font-size: 38px; color: var(--ink-2); text-decoration: line-through; text-decoration-thickness: 2px; }
.s-now { font-size: 58px; font-weight: 600; color: var(--accent); min-width: 3.4ch; text-align: right; }
.s-prices + .s-sub { position: absolute; left: 80px; right: 80px; top: 1260px; }

/* Matted print above the side table. */
.s-nook { position: absolute; left: 0; right: 0; top: 900px; height: 760px; }
.s-nook .g-room { position: absolute; inset: 0; }

/* Sign-up steps. */
.s-steps { position: absolute; left: 80px; right: 80px; top: 860px; margin: 0; padding: 0; list-style: none; counter-reset: s; display: grid; gap: 22px; }
.s-steps li { counter-increment: s; display: grid; grid-template-columns: 76px 1fr; align-items: center; gap: 22px; padding: 26px 30px;
  background: var(--paper-2); font-size: 42px; line-height: 1.25; }
.s-steps li::before { content: counter(s); font-family: var(--serif); font-size: 76px; line-height: 1; color: var(--accent); }
.s-cta-url { position: absolute; left: 80px; right: 80px; top: 1300px; font-size: 56px; font-weight: 600; color: var(--accent); margin: 0; }
.s-tap { position: absolute; left: 80px; right: 80px; top: 1384px; font-size: 34px; color: var(--ink-2); margin: 0; }
"""

PAGE = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="{{ root }}assets/css/site.css"><style>{{ css }}</style></head><body>
{% import "partials/gifts.html" as gx with context %}
<div class="slide{% if s.get('theme') %} {{ s.theme }}{% endif %}">
  <img class="s-logo" src="{{ root }}assets/img/site/logo-horizontal.svg" alt="">
  <div class="s-text">
    <p class="s-eyebrow">{{ s.eyebrow }}</p>
    <h1 class="s-head">{{ s.head }}</h1>
    {% if s.kind in ("room", "stack", "matted", "cta") and s.get("sub") %}<p class="s-sub">{{ s.sub }}</p>{% endif %}
    {% if s.kind in ("room", "matted") and s.get("url") %}<p class="s-url">{{ s.url }}</p>{% endif %}
  </div>
  {% if s.kind == "room" %}
  <div class="s-room">{{ gx.metal_room(room, "", s.crop, "1080px", eager=True) }}</div>
  <p class="s-caption">{{ s.caption }}</p>
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
    <div class="s-row"><dt>{{ name }}</dt><dd class="s-was">${{ was }}</dd><dd class="s-now">${{ now }}</dd></div>
    {% endfor %}
  </dl>
  <p class="s-sub">{{ s.sub }}</p>
  {% elif s.kind == "matted" %}
  <div class="s-nook">{{ gx.matted_room(matted, "", [150, -25, -15], "1080px", eager=True) }}</div>
  {% elif s.kind == "cta" %}
  <ol class="s-steps">{% for t in s.steps %}<li>{{ t }}</li>{% endfor %}</ol>
  <p class="s-cta-url">{{ s.url }}</p>
  <p class="s-tap">{{ s.tap }}</p>
  {% endif %}
</div></body></html>"""


def render(b, s, root):
    ctx = {"s": s, "css": CSS, "root": root}
    if s["kind"] == "room":
        ctx["room"] = b.gift_room(b.gift_print(s["print"], s["name"]), *s["size"])
    if s["kind"] == "matted":
        ctx["matted"] = b.gift_matted(b.gift_print(s["print"], s["name"]))
    if s["kind"] == "stack":
        stack = []
        for uid, label in s["prints"]:
            p = b.gift_print(uid, s["name"])
            r = p.get("ratio") or 1.5
            w = 560 if p["orientation"] == "panoramic" else 260
            stack.append({"p": p, "label": label, "w": w, "h": round(w / r)})
        ctx["stack"] = stack
    return b.env.from_string(PAGE).render(**ctx)


VIDEO_PAGE = """<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="{{ root }}assets/css/site.css"><style>{{ css }}
.s-room .g-room { position: absolute; inset: 0; }
.s-room .g-room-in { will-change: transform; }
.s-swap { position: absolute; inset: 0; }
.s-swap picture, .s-swap img { display: block; width: 100%; height: 100%; object-fit: cover; }
.s-caps { position: absolute; left: 80px; right: 80px; top: 1556px; height: 40px; }
.s-caps .s-caption { left: 0; top: 0; }
.s-anim, .s-word { will-change: transform, opacity; }
.s-word { display: inline-block; }
.s-hl { color: transparent; -webkit-background-clip: text; background-clip: text;
  background-image: linear-gradient(105deg, #f3e3b5 0%, #f3e3b5 38%, #ffffff 47%, #ffffff 53%, #f3e3b5 62%, #f3e3b5 100%);
  background-repeat: no-repeat; }
</style></head><body>
{% import "partials/gifts.html" as gx with context %}
<div class="slide{% if v.get('theme') %} {{ v.theme }}{% endif %}">
  <img class="s-logo s-anim" data-in="-0.3" src="{{ root }}assets/img/site/logo-horizontal.svg" alt="">
  <div class="s-text">
    <p class="s-eyebrow s-anim" data-in="-0.15">{{ v.eyebrow }}</p>
    <h1 class="s-head">{% for w in v.head.split() %}<span class="s-word{% if w in v.get('highlight', []) %} s-hl{% endif %}">{{ w }}</span> {% endfor %}</h1>
    <p class="s-sub s-anim" data-in="0.83">{{ v.sub }}</p>
  </div>
  <div class="s-room">
    <div class="g-room">
      <div class="g-room-in" style="width:{{ v.crop[0] }}%;left:{{ v.crop[1] }}%;top:{{ v.crop[2] }}%;transform-origin:{{ room.origin }}">
        {{ gx.scene_img(room.scene, "1080px", True) }}
        <div class="g-room-print g-metal" style="left:{{ room.rect.left }}%;top:{{ room.rect.top }}%;width:{{ room.rect.width }}%;height:{{ room.rect.height }}%">
          {% for p in prints %}<div class="s-swap">{{ picture(p, "900px", alt="") }}</div>{% endfor %}
        </div>
      </div>
    </div>
  </div>
  <div class="s-caps">{% for p in prints %}<p class="s-caption">{{ p.title }}, {{ room.w }} x {{ room.h }} metal</p>{% endfor %}</div>
</div>
<script>
const BEAT = {{ v.beat }}, ZOOM = {{ v.zoom }}, LENGTH = BEAT * {{ prints | length }}, FADE = 0.35;
const swaps = [...document.querySelectorAll(".s-swap")], caps = [...document.querySelectorAll(".s-caps .s-caption")];
const inner = document.querySelector(".s-room .g-room-in");
const ease = x => x < 0 ? 0 : x > 1 ? 1 : 1 - Math.pow(1 - x, 3);
const glide = x => x < 0 ? 0 : x > 1 ? 1 : x * x * (3 - 2 * x);
// The glint runs across all the highlighted words together, as one strip of light.
const hl = [...document.querySelectorAll(".s-hl")];
const span = hl.length ? [Math.min(...hl.map(e => e.offsetLeft)), Math.max(...hl.map(e => e.offsetLeft + e.offsetWidth))] : [0, 0];
const strip = (span[1] - span[0]) * 3;
hl.forEach(e => { e.style.backgroundSize = strip + "px 100%"; });
window.at = t => {
  // Words, half again slower than a quick cut: the headline rises word by word from the first frame.
  document.querySelectorAll(".s-word").forEach((el, i) => {
    const k = ease((t + 0.18 - i * 0.083) / 0.57);
    el.style.opacity = k; el.style.transform = `translateY(${(1 - k) * 46}px)`;
  });
  document.querySelectorAll(".s-anim").forEach(el => {
    const k = ease((t - Number(el.dataset.in)) / 0.75);
    el.style.opacity = k; el.style.transform = `translateY(${(1 - k) * 28}px)`;
  });
  // A slow glint across the highlighted words: a 1.4 second pass every 3 seconds, after the headline
  // lands. The light band sits in the middle of a gradient three times the phrase's width; X is where
  // the band is, measured from the phrase's left edge.
  const W = span[1] - span[0], g = (t - 1.2) % 3;
  const X = t < 1.2 || g > 1.4 ? -0.45 * W : -0.4 * W + glide(g / 1.4) * 1.8 * W;
  hl.forEach(e => { e.style.backgroundPosition = `${X - 1.5 * W - (e.offsetLeft - span[0])}px 0`; });
  // One room, zooming in toward the print the whole time.
  inner.style.transform = `scale(${1 + (ZOOM - 1) * glide(t / LENGTH)})`;
  // The photograph in the frame changes every beat, with a short cross-fade inside the frame.
  swaps.forEach((s, i) => {
    const local = t - i * BEAT;
    const fadeIn = i === 0 ? 1 : glide(local / FADE);
    const show = local < 0 ? 0 : fadeIn;
    s.style.opacity = show;
    s.style.zIndex = i;
    caps[i].style.opacity = i === Math.min(swaps.length - 1, Math.floor(t / BEAT)) ? 1 : 0;
  });
};
window.at(0);
</script></body></html>"""


def render_video(b, v, root):
    prints = [b.gift_print(uid, v["name"]) for uid in v["prints"]]
    if len({p["orientation"] for p in prints}) > 1:
        raise SystemExit(f"{v['name']}: every print in a video needs the same shape, so each fills the same frame")
    room = b.gift_room(prints[0], *v["size"])
    room["origin"] = f"{room['rect']['left'] + room['rect']['width'] / 2:.3f}% {room['rect']['top'] + room['rect']['height'] / 2:.3f}%"
    return b.env.from_string(VIDEO_PAGE).render(v=v, room=room, prints=prints, css=CSS, root=root)


def videos(out, b, root):
    tmp = Path(tempfile.mkdtemp(prefix="kl-story-video-"))
    script = ROOT / "tools" / ".stories-video.mjs"
    script.write_text(VIDEO_SHOT)
    try:
        for v in VIDEOS:
            page = tmp / (v["name"].replace("/", "-") + ".html")
            page.write_text(render_video(b, v, root))
            frames = tmp / (v["name"].replace("/", "-") + "-frames")
            frames.mkdir()
            seconds = v["beat"] * len(v["prints"])
            subprocess.run(["node", str(script), page.as_uri(), str(frames), str(v["fps"]), str(seconds)],
                           cwd=ROOT / "tools", check=True)
            mp4 = out / (v["name"] + ".mp4")
            mp4.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(v["fps"]), "-i", str(frames / "%04d.png"),
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", "-preset", "slow",
                            "-movflags", "+faststart", str(mp4)], check=True)
            print(mp4, f"{seconds:.1f} s")
    finally:
        script.unlink()


# Steps the page through time with window.at(t) and screenshots every frame.
VIDEO_SHOT = """
import { chromium } from "playwright";
const [url, dir, fps, seconds] = process.argv.slice(2);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
await p.goto(url, { waitUntil: "networkidle" });
await p.evaluate(() => document.fonts.ready);
const n = Math.round(Number(fps) * Number(seconds));
for (let i = 0; i < n; i++) {
  await p.evaluate(t => window.at(t), i / Number(fps));
  await p.screenshot({ path: `${dir}/${String(i).padStart(4, "0")}.png`, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
}
await b.close();
"""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    out = Path(args[0] if args else "stories").resolve()
    b = build.Builder(production=True, check=True)
    root = ROOT.as_uri() + "/"
    if "--video" in sys.argv:
        videos(out, b, root)
        return
    tmp = Path(tempfile.mkdtemp(prefix="kl-stories-"))
    jobs = []
    for folder, slides in SETS:
        (out / folder).mkdir(parents=True, exist_ok=True)
        for n, s in enumerate(slides, 1):
            name = f"{n:02d}-{s['name']}"
            page = tmp / f"{folder}-{name}.html"
            page.write_text(render(b, s, root))
            jobs.append({"html": page.as_uri(), "png": str(out / folder / f"{name}.png"), "label": f"{folder}/{name}"})
    script = ROOT / "tools" / ".stories-shot.mjs"
    script.write_text(SHOT)
    try:
        subprocess.run(["node", str(script), json.dumps(jobs)], cwd=ROOT / "tools", check=True)
    finally:
        script.unlink()


# Screenshots each slide, then checks its layout.
SHOT = """
import { chromium } from "playwright";
const jobs = JSON.parse(process.argv[2]);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
let problems = 0;
for (const j of jobs) {
  await p.goto(j.html, { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.screenshot({ path: j.png, clip: { x: 0, y: 0, width: 1080, height: 1920 } });
  const fix = await p.evaluate(() => {
    const out = [], r = el => el.getBoundingClientRect();
    const words = ".s-eyebrow, .s-head, .s-sub, .s-url, .s-caption, .s-cta-url, .s-tap, .s-row, .s-steps li";
    for (const el of document.querySelectorAll(words)) {
      const b = r(el), what = el.className + " '" + el.textContent.trim().slice(0, 24) + "'";
      if (b.left < 79 || b.right > 1001) out.push(what + " outside the side margins");
      if (b.top < 230 || b.bottom > 1600) out.push(what + " outside Instagram's safe area");
      if (el.scrollWidth > el.clientWidth + 1) out.push(what + " runs past its box");
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
}
await b.close();
console.log(problems ? problems + " layout problem(s)" : "layout ok on every slide");
"""


if __name__ == "__main__":
    main()
