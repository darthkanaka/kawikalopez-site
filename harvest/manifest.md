# Harvest of kawikalopez.com (Squarespace), 2026-09-25

Everything the live Squarespace site exposes publicly, pulled without a Squarespace login. Enough to rebuild the print store elsewhere. Squarespace site ID `57e6cc979de4bbd5509a028e`, created 2016-09-24.

## Method

- Any Squarespace page returns its full data as JSON with `?format=json` appended. `/store?format=json` lists every product; `/store/<urlId>?format=json` gives one product with variants, prices, SKUs, categories, description (`excerpt`) and image records.
- Images come from `images.squarespace-cdn.com`. The CDN serves WebP unless you send a browser user agent and `Accept: image/png,image/jpeg,image/*;q=0.8`. `?format=original` gives the largest size stored.
- The product's own `assetUrl` (on `static1.squarespace.com`) returns a 300x300 placeholder. The real image is `items[0].assetUrl` inside the product record.
- Store category pages (`/store/category/...`) return 404 as JSON. Categories are on each product instead.

## What is here

| Path | Contents |
| --- | --- |
| `products.json` | 38 products, normalized: urlId, title, description, categories, price range, 258 variants (size x material x price x SKU), image URLs |
| `products.md` | The same as a readable table |
| `copy.md` | Every line of text from the home, prints, contact, 5tips and other pages, plus all product descriptions |
| `json/store.json` | Raw store collection JSON |
| `json/product-<urlId>.json` | Raw JSON per product |
| `json/page-<name>.json` | Raw JSON per page (home, prints, contact, fine-art, landscape-1, adventure, images, portfolio, blog, the promo landing pages) |
| `images/products/<urlId>.jpg` | One image per product, the largest the CDN has |

## Catalog shape

- Two materials everywhere: Canvas and Metal.
- Horizontal (15 products): 18x12, 24x16, 30x20, 36x24. $210 to $780.
- Vertical (14): 16x20, 20x25, 24x30. $300 to $700.
- Square (1, Hanauma): 16x16, 24x24, 40x40. $240 to $1650.
- Panoramic (8): 30x10, 48x16, 72x24. $360 to $1950.
- Categories per product: an orientation (Horizontal, Vertical, Square, Panoramic) plus Landscape and/or Fine Art.
- Newsletter offer on /prints: 20% off first print, code NEW20OFF.

## Caveats to resolve before the build

1. **Product images are small squares.** The CDN holds 1000x1000 (29 products), 1500x1500 (8) and one 1200x1200. They are the photographs letterboxed into a square with white padding (checked on kaimana.jpg: a 3:1 panorama sitting in a 1500x1500 frame, so the real picture is about 1500x500). The padding can be trimmed automatically, which leaves usable thumbnails but nothing hero sized. A print store needs the real aspect ratios at 2500px or more, so the web images must come from Kawika's own files. The original filenames are recorded in `products.json` under `images[].filename` and in the CDN URL (for example `DJI_0921-Pano.jpg`, `Kualoa01.jpg`, `DiamnondHeadSunrise12.16.jpg`) to make them findable.
2. **Five panoramas had no title and no description** on Squarespace: urlIds 036, 037, 038, 041, 043. Named by Kawika 2026-09-25: 036 Maluna nā ao, 037 Wanaka, 038 Mokoliʻi Pano, 043 Mauka i Makai; 041 removed. Descriptions still to come. A new print, Olomana, is being added. Their source filenames: `_DSC1832 copy.jpg`, `_DSC5171-Pano.jpg`, `Chinaman'sHat.jpg`, `DSC06219-Pano.jpg`, `Palolo-Pano.jpg`. They were the last products added (lastmod 2025) and never finished.
3. **Ten products have numeric urlIds** (018, 032 to 038, 041, 043). Five of those have real titles (ʻĀlina, Kākau, Candlestick, Kai Emi, Pakele). Keeping the numeric URLs preserves whatever Google has indexed; adding readable paths would need redirects from the numeric ones.
4. One variant on Kaʻaʻawa Valley is sized "72 24" instead of "72 x 24". Typo in the Squarespace data.
5. The `/adventure` page still carries Squarespace template placeholder text ("These are example images"). The blog is five camera gear posts from 2016 to 2018 plus 40 tag pages. None of it belongs on a print store.
6. Nothing here covers orders, customers or the newsletter list. Those need a Squarespace login export, and Kawika has said he does not need them.

## Site images (`images/site/`, 51 files) and `images/products-web/`

Pulled from the home, images and promo pages. The useful ones:

- Non-square versions of the product photos at 1000x667, 800x1000 or 1500x500, one per product. Copied to `images/products-web/<urlId>.jpg` (36 of 38 matched by filename; 038, 041 exist only as the letterboxed square). Big enough for grid thumbnails, not for a hero or a product page.
- `home-hero-living-room-panorama.jpg`, 2000x1124, the home page hero: a living room mockup with a Honolulu panorama on the wall. Missed on the first pass because the CDN filename has no extension.
- `Logo+Text(gray).png` and `Logo+Text(white).png`, 2451x1177, the only logo artifacts. Raster, no vector anywhere on the site.
- `PanelOptions.jpg`, `PanoOptions.jpg`, `StandardOptions.jpg`, 2500x1655, the size and layout diagrams from the prints page.
- `MockUp.jpg` (1422x948) and `Mock03.jpg` (1200x848), room mockups from the home page.
- `Primary_SocialThumb.jpg`, the social share image.
- `DSC09338.jpg` and the decontrast version, 1500x1000, the wallpaper promo image.
