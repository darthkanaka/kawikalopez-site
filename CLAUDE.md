# kawikalopez.com

Kawika's fine art print store. The primary goal is search: passive traffic from Google that turns into print sales. Every change should be judged by whether it helps a buyer find a print, trust it, or buy it.

Read `README.md` first (layout, data files, commands). The project hub with decisions and open questions is `~/Documents/Obsidian/projects/kawikalopez-site.md`; the approved build plan is `~/.claude/plans/ok-can-you-properly-magical-mochi.md`. The old site's content is in `harvest/` (start at `harvest/manifest.md`).

## Stack

- Python build (`tools/build.py`, Jinja2) renders every page into the repo root; the HTML is committed and GitHub Pages serves it. System Python 3.9 has everything the build needs.
- Hand-written `assets/css/site.css` and `assets/js/site.js`, no framework, no bundler.
- Images from `tools/images.py` (Pillow, WebP plus JPEG, capped at 2000 px). Rooms from `tools/scenes.py`.
- Checks in `tools/verify.mjs` and `tools/a11y.mjs` (Playwright, axe) against `tools/serve.py`.
- Same conventions as `~/Documents/Developer/elevate-site`, which is the reference when something here is unclear.

## Rules

1. Never edit rendered HTML. Change `templates/` or `data/` and run `python3 tools/build.py`.
2. Kawika's own words (the print descriptions) are kept. Only spelling is corrected, through `fixes:` in `data/overrides.yml`.
3. Alt text describes the photograph: place, light, what is in the frame. Never "image of".
4. Titles stay under about 60 characters and descriptions under 155. The build warns; `verify.mjs` fails.
5. Keep `viz_rect()` in `tools/build.py` and `KL.rect` in `assets/js/site.js` identical. The room preview must look the same with and without JavaScript.
6. Product URLs are `/store/<urlId>` forever.
7. Nothing larger than 2000 px on the long edge is ever published.
8. No em dashes anywhere. Customer copy is spoken and plain, contractions on, no corporate verbs, and no colons in sentences. Periods and commas, the way Kawika talks out loud (his rule, 2026-09-28). Titles and labels, like page titles and product names, keep the colon as a separator.
9. **The site is live (cutover 2026-09-27) and this repo is production: every push to main goes to kawikalopez.com.** Always build with `python3 tools/build.py --production` before committing. A plain `build.py` makes a noindex staging build with test Stripe links; never push one. Preview locally with `python3 tools/serve.py 8781` and `cd tools && BASE=http://localhost:8781 EXPECT_NOINDEX=0 node verify.mjs`.
10. Never name the print lab on the site. Say the prints are made locally on Oʻahu (Kawika, 2026-09-25). The lab is on record in `data/site.yml` as `printer.lab`, which no template uses.

## Swap points

| What | Where |
|---|---|
| Checkout on | `data/payment-links-test.json` (staging) and `data/payment-links-live.json` (production) from `tools/stripe_catalog.py`, then `features.checkout: true` in `data/site.yml` |
| Cart on | deploy `gas/checkout.gs`, put its `/exec` URL in `data/site.yml` as `checkout.endpoint`; `node tools/test_shipping.mjs` after any change to shipping |
| Contact form endpoint | `contact.endpoint` in `data/site.yml` |
| Shipping amounts | `data/shipping.yml` (`rates_confirmed: true` once Kawika supplies them) |
| Room scenes | `data/scenes.json`, images through `tools/scenes.py` |
| Featured prints on home | `featured_order` in `data/site.yml` |
| Analytics | `ga4` in `data/site.yml` (production builds only) |
| Custom domain | `CNAME` file and `--production`, at cutover |

## Commands

```
python3 tools/images.py && python3 tools/build.py
python3 tools/serve.py 8779 --prefix /kawikalopez-site
cd tools && node verify.mjs && node a11y.mjs
```

## Commits

Small, one idea each, present tense. End with the co-author trailer. Push `main` to deploy to kawikalopez.com (production build only; see rule 9).

## Reporting to Kawika

Short, answer first, plain lists, one decision per message, links to files. He reads on his phone.
