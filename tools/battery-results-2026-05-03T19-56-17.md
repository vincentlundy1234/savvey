# Savvey v2 identity-accuracy battery — 2026-05-03T19:56 UTC

- **Endpoint**: https://savvey.vercel.app
- **Battery version**: v2.0 — created 3 May 2026
- **Pass rate**: 17/20 = **85.0%** **✗ below 90% gate**
- **Latency**: avg 11391ms · p95 15742ms

## Results

| ID | Query | Pass | n | Cheapest | Reason |
|---|---|---|---|---|---|
| `bosch-leaf-blower-18v` | Bosch Cordless Leaf Blower 18V | ✓ | 1 | £140 | Brand + qualifier match + price in band |
| `sennheiser-hd-660s` | Sennheiser HD 660S | ✗ | 4 | £329.99 | Top title "Sennheiser HD660S2 Open Back Audiophile Headphones" missing qualifier signals (expected one of: HD 660S) |
| `sennheiser-hd-660s2` | Sennheiser HD 660S2 | ✓ | 4 | £385 | Brand + qualifier match + price in band |
| `wahoo-kickr-core` | Wahoo Kickr Core | ✓ | 2 | £359.99 | Brand + qualifier match + price in band |
| `dyson-v15-detect` | Dyson V15 Detect | ✓ | 4 | £549.99 | Brand + qualifier match + price in band |
| `iphone-17-base` | iPhone 17 | ✓ | 2 | £799 | Brand + qualifier match + price in band |
| `iphone-17-pro` | iPhone 17 Pro | ✓ | 1 | £1399 | Brand + qualifier match + price in band |
| `macbook-air-m3` | MacBook Air M3 | ✓ | 4 | £1029 | Brand + qualifier match + price in band |
| `samsung-65-qled` | Samsung 65 inch QLED | ✓ | 2 | £579 | Brand + qualifier match + price in band |
| `le-creuset-24cm` | Le Creuset Signature 24cm casserole | ✓ | 3 | £239 | Brand + qualifier match + price in band |
| `bosch-leaf-blower-vague` | Bosch leaf blower | ✓ | 1 | £95 | Cheapest in expected band; variants tolerable |
| `sage-bambino-base` | Sage Bambino | ✓ | 5 | £329 | Brand + qualifier match + price in band |
| `sage-bambino-plus` | Sage Bambino Plus | ✓ | 3 | £329 | Brand + qualifier match + price in band |
| `lego-millennium-falcon` | Lego Millennium Falcon | ✓ | 4 | £734.99 | Variant spread surfaced |
| `cordless-vacuum-cleaner` | cordless vacuum cleaner | ✗ | 0 | — | API error: HTTP 504 |
| `kettle` | kettle | ✓ | 5 | £20 | Category fan-out fired (Wave 100) |
| `air-fryer` | air fryer | ✗ | 0 | — | API error: HTTP 504 |
| `rado-captain-cook` | Rado Captain Cook | ✓ | 1 | £1820 | Brand + qualifier match + price in band |
| `brompton-electric` | Brompton Electric | ✓ | 4 | £2900 | Brand + qualifier match + price in band |
| `wahoo-kickr-core-2` | Wahoo Kickr Core 2 | ✓ | 2 | £399.99 | Brand + qualifier match + price in band |

## Failures detail

### sennheiser-hd-660s
- Query: Sennheiser HD 660S
- Reason: Top title "Sennheiser HD660S2 Open Back Audiophile Headphones" missing qualifier signals (expected one of: HD 660S)
- Cheapest: £329.99 at HBH Woolacotts
- Top title: Sennheiser HD660S2 Open Back Audiophile Headphones
- Reasoning: —

### cordless-vacuum-cleaner
- Query: cordless vacuum cleaner
- Reason: API error: HTTP 504
- Cheapest: — at —
- Top title: —
- Reasoning: —

### air-fryer
- Query: air fryer
- Reason: API error: HTTP 504
- Cheapest: — at —
- Top title: —
- Reasoning: —
