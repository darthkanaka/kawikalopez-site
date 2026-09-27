# How the Pictures Plus shipping calculator prices

Probed 2026-09-26 on the Upload Your Image product page (estimate only, nothing added to cart), Metal, custom sizes, quantity 1 to 4. Per size quotes for the store's own sizes are in `shipping-quotes.csv`.

## What drives it

The price comes from the **total square inches in the order** (width x height x quantity). The destination ZIP barely matters:

- Every mainland ZIP (LA, Seattle, Phoenix, Anchorage, Denver, Dallas, Chicago, Billings, New York, Miami, Boston, Portland ME) gets the same "US Domestic" price.
- Every Hawaiʻi ZIP (Honolulu, Hilo, Kahului, Līhuʻe) gets the same "Shipping within Hawaii" price.
- Quantity 2 of a 16 x 16 (512 sq in) costs what one 20 x 25 (500 sq in) costs. Four 24 x 16s cost what one 60 x 30 costs.
- Canvas wrap depth (3/4" or 1 1/2") does not change it; canvas is 6 cents more than metal in Hawaiʻi and the same on the mainland.

## Hawaiʻi: a formula

`$20.00 + $0.06 per square inch + $0.06 per print` (canvas adds another 6 cents). It matched every lookup to the cent, for example:

| Order | Sq in | Quote |
|---|---|---|
| 1 x 16 x 16 | 256 | $35.42 |
| 2 x 16 x 16 | 512 | $50.84 |
| 3 x 16 x 16 | 768 | $66.26 |
| 1 x 36 x 24 | 864 | $71.90 |
| 2 x 24 x 30 | 1,440 | $106.52 |
| 1 x 60 x 30 | 1,800 | $128.06 |

## Mainland: a step table on total square inches

Steps fall somewhere between the probed points.

| Total sq in (probed) | US Domestic |
|---|---|
| 25 to 50 | $40 |
| 100 | $55 |
| 150 | $65 |
| 180 | $74 |
| 192 to 210 | $78 |
| 216 to 420 | $85 |
| 450 | $90 |
| 480 to 550 | $95 |
| 576 to 650 | $100 |
| 700 to 780 | $105 |
| 800 to 820 | $115 |
| 850 | $138 |
| 864 to 1,000 | $145 |
| 1,100 | $150 |
| 1,200 to 1,320 | $155 |
| 1,350 to 1,800 | $410 |
| 2,400 | $425 |
| 3,600 | $750 |

The jump between 1,320 and 1,350 sq in ($155 to $410) looks like an oversize or freight surcharge. It applies to combined orders too: two 24 x 30s (1,440) or four 24 x 16s (1,536) both quote $410.

## Not confirmed

- Whether the cart adds up different sizes the same way the quantity box does. That needs items in the cart, which we did not do.
- Whether the estimate is what the lab actually bills a trade account when it ships. Worth asking the client specialist.
