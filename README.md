# kawikalopez.com

Kawika Lopez's fine art print store: landscape and aerial prints of Hawaiʻi on canvas or metal, printed to order by Pictures Plus in Kapolei. The primary job of this site is search: bring in buyers from Google without ads or posting, then turn that traffic into print sales.

Static HTML on GitHub Pages. The pages are rendered by a small Python build and the rendered HTML is committed, because Pages has no build step.

- Staging: https://darthkanaka.github.io/kawikalopez-site/ (every page carries noindex)
- Production: https://kawikalopez.com/ (after cutover; see DNS below)
- Project hub: `~/Documents/Obsidian/projects/kawikalopez-site.md`
- Build plan: `~/.claude/plans/ok-can-you-properly-magical-mochi.md`

## Layout

| Path | What it is |
|---|---|
| `index.html`, `store/`, `*-prints.html`, `fine-art.html`, `landscape-1.html`, `prints.html`, `about.html`, `contact.html`, `privacy.html`, `thank-you.html`, `404.html` | Rendered pages. Never edit by hand; edit the template or the data and rebuild |
| `gas/contact-notify.gs` | The contact form's Apps Script |
| `home.html`, `images.html`, `portfolio.html` and friends | Redirect pages for old Squarespace paths (`data/redirects.yml`) |
| `templates/` | Jinja2 page structure. `base.html` holds the head, header and footer |
| `assets/css/site.css` | The one stylesheet, sectioned and numbered |
| `assets/js/site.js` | The one script: shared helpers, then one block per feature |
| `assets/fonts/` | Instrument Serif and Inter, subset to Latin plus kahakō and ʻokina, with their licenses |
| `assets/img/` | Generated images. `prints/` per print and width, `og/` share images, `scenes/` rooms, `site/` logo, favicons, diagrams, hero |
| `data/` | Everything the build reads. See below |
| `tools/` | Build, image pipeline, scenes, preview server, checks |
| `harvest/` | The old Squarespace site, pulled 2026-09-25. Source images and copy. Read `harvest/manifest.md` |

### Data

| File | Edited by | Holds |
|---|---|---|
| `data/products.json` | `tools/harvest_to_data.py`, then by hand | The catalog: every print, size, material and price |
| `data/overrides.yml` | Hand | Titles, subtitles, alt text, places, spelling fixes, sort, featured, removed and pending prints |
| `data/pricing.yml` | Hand | Price matrix per orientation; new prints inherit it |
| `data/locations.yml` | Hand | The places prints come from, with the search phrase each place page targets |
| `data/site.yml` | Hand | Site facts, nav, feature flags, contact, featured order |
| `data/shipping.yml` | Hand (Kawika's numbers) | Pickup, zones, size tiers, the pickup-only rule over 60 inches |
| `data/scenes.json` | `tools/scenes.py` and hand | Rooms for the to-scale wall preview: wall rectangle, pixels per inch, anchor |
| `data/images.json`, `data/pages.json`, `data/lastmod.json` | Tools only | What was generated, what was rendered, when each page last changed |

## Contact form

The form on /contact posts to a Google Apps Script web app whose source is `gas/contact-notify.gs`. It logs every message to a Google Sheet, then emails kawika@elevatemediahi.com with Reply-To set to the sender. Until the script is deployed and its `/exec` URL is in `data/site.yml` as `contact.endpoint`, the form opens the visitor's email app with the message filled in, so nothing is lost. Deploy steps are at the top of the script. To change it later: Manage deployments, New version, never New deployment.

## Logo

`tools/logo.py` traces Kawika's logo from the old site's PNG into `assets/img/site/logo.svg` (the stacked original, used in the footer and as a sign-off) and `logo-horizontal.svg` (signature beside the wordmark, used in the header), plus PNGs of the lockup for share images. Rerun it with `uv run tools/logo.py` only if the source art changes, then `python3 tools/images.py --force` to redo the share images.

## Place pages and posts

The writing lives in the Obsidian vault at `~/Documents/Obsidian/kawikalopez/` (`places/` and `posts/`, with a README for Kawika). `python3 tools/sync_content.py` copies it into `content/`, which is what the build reads and what gets committed. Notes marked `status: draft` render on staging with a draft label and stay out of production builds and the sitemap; `status: published` is the approval. Shorthand links (`print:`, `place:`, `page:`) and print cards (`[print:id]`, `[prints: a, b]`) are explained in `tools/content.py` and in the vault README.

Place pages live at `/hawaii-prints/<place>` (the key in `data/locations.yml`), posts at `/blog/<slug>`. Print pages link to their place page once it exists.

## Local preview

```
python3 tools/sync_content.py    # copy place pages and posts from the vault
python3 tools/images.py          # only when a source image changed; skips what is current
python3 tools/scenes.py          # only when a scene changed
python3 tools/build.py           # staging build
python3 tools/serve.py 8779 --prefix /kawikalopez-site
```

Then open http://localhost:8779/kawikalopez-site/. The server maps `/store/kaimana` to `store/kaimana.html` and serves the 404 page for unknown paths, like GitHub Pages does. The Python tools run on the system Python (jinja2, markdown, Pillow, PyYAML); each also carries inline dependencies so `uv run tools/<tool>.py` works too.

## Changing things

- **A print's title, subtitle, alt text or place:** `data/overrides.yml`, then `python3 tools/build.py`.
- **A typo in Kawika's description:** add a `fixes:` pair under the print in `overrides.yml`. The build warns if the wrong text is no longer found.
- **A better image for a print:** drop a 2000 px long-edge sRGB JPEG at `harvest/images/originals/<urlId>.jpg`, then `python3 tools/images.py && python3 tools/build.py`. Nothing on the site is larger than 2000 px, on purpose.
- **A new print:** add it to `overrides.yml` with `title`, `orientation`, `alt`, `location`, and put its image in `originals/`. Prices come from `pricing.yml`. Remove `status: pending` once the image is in.
- **Remove a print:** `status: removed` in `overrides.yml`.
- **Prices:** per print in `data/products.json`, or for a whole orientation in `pricing.yml`.

## Checks

```
cd tools && npm install          # once: Playwright and axe, pinned
node verify.mjs                  # every page: errors, one h1, alt, links, JSON-LD, canonical, noindex, lengths, picker, no-JS, mobile, reduced motion
node a11y.mjs                    # axe WCAG 2.1 AA at 1440, 1024 and 390
```

Both expect the preview running on port 8779 with the staging prefix. For a production build, run verify with `EXPECT_NOINDEX=0`.

## Deploy

Push `main`. GitHub Pages serves the repo root in about a minute.

## DNS (at cutover, not before)

1. `python3 tools/build.py --production`, add a `CNAME` file containing `kawikalopez.com`, commit, push.
2. At Squarespace Domains: remove the Squarespace site records, add four A records on `@` for 185.199.108.153, 185.199.109.153, 185.199.110.153, 185.199.111.153, and a `www` CNAME to `darthkanaka.github.io`. Leave any MX records alone.
3. In the repo's Pages settings, set the custom domain, wait for the certificate, tick Enforce HTTPS.
4. Search Console: submit `https://kawikalopez.com/sitemap.xml`, request indexing for home, store and one product.
5. Only after the site is live and indexed: cancel the Squarespace site plan. Keep the domain.

## Rules this codebase keeps

1. Rendered HTML is only ever produced by `tools/build.py`. Fix the template or the data.
2. Links are relative and extensionless (`../store/kaimana`), so staging on a subpath and the custom domain both work. The 404 page is the one exception.
3. Every image has real alt text that describes the photograph, from `overrides.yml`.
4. Product URLs stay `/store/<urlId>`, numeric ids included. They carry whatever search history the old site had.
5. Web images are capped at 2000 px. Print files never enter this repo.
6. The site works without JavaScript: prices, sizes and the order link are all in the HTML.
7. No em dashes anywhere, in copy or in comments.
