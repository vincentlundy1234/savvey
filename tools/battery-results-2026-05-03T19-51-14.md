# Savvey v2 identity-accuracy battery — 2026-05-03T19:51 UTC

- **Endpoint**: https://savvey.vercel.app
- **Battery version**: v2.0 — created 3 May 2026
- **Pass rate**: 14/20 = **70.0%** **✗ below 90% gate**
- **Latency**: avg 11127ms · p95 15256ms

## Results

| ID | Query | Pass | n | Cheapest | Reason |
|---|---|---|---|---|---|
| `bosch-leaf-blower-18v` | Bosch Cordless Leaf Blower 18V | ✗ | 2 | £72 | Top title "Buy Einhell Cordless Leaf Blower - 18V | Leaf blowers and garden vacuums | Argos" missing brand "Bosch" |
| `sennheiser-hd-660s` | Sennheiser HD 660S | ✗ | 4 | £329.99 | Top title "Sennheiser HD660S2 Open Back Audiophile Headphones" missing qualifier signals (expected one of: HD 660S) |
| `sennheiser-hd-660s2` | Sennheiser HD 660S2 | ✓ | 5 | £385 | Brand + qualifier match + price in band |
| `wahoo-kickr-core` | Wahoo Kickr Core | ✓ | 2 | £359.99 | Brand + qualifier match + price in band |
| `dyson-v15-detect` | Dyson V15 Detect | ✓ | 4 | £549.99 | Brand + qualifier match + price in band |
| `iphone-17-base` | iPhone 17 | ✗ | 1 | £799 | Top title "Buy iPhone 17" missing brand "Apple" |
| `iphone-17-pro` | iPhone 17 Pro | ✗ | 1 | £1399 | Top title "iPhone 17 Pro" missing brand "Apple" |
| `macbook-air-m3` | MacBook Air M3 | ✓ | 4 | £999 | Brand + qualifier match + price in band |
| `samsung-65-qled` | Samsung 65 inch QLED | ✓ | 2 | £579 | Brand + qualifier match + price in band |
| `le-creuset-24cm` | Le Creuset Signature 24cm casserole | ✗ | 6 | £153 | Cheapest £153 outside expected band 239-349 (±30%) |
| `bosch-leaf-blower-vague` | Bosch leaf blower | ✓ | 2 | £95 | Cheapest in expected band; variants tolerable |
| `sage-bambino-base` | Sage Bambino | ✓ | 6 | £319.99 | Brand + qualifier match + price in band |
| `sage-bambino-plus` | Sage Bambino Plus | ✓ | 3 | £329 | Brand + qualifier match + price in band |
| `lego-millennium-falcon` | Lego Millennium Falcon | ✓ | 4 | £734.99 | Variant spread surfaced |
| `cordless-vacuum-cleaner` | cordless vacuum cleaner | ✓ | 3 | £239 | Category fan-out fired (Wave 100) |
| `kettle` | kettle | ✗ | 0 | — | API error: HTTP 504 |
| `air-fryer` | air fryer | ✓ | 4 | £55.99 | Category fan-out fired (Wave 100) |
| `rado-captain-cook` | Rado Captain Cook | ✓ | 5 | £1820 | Brand + qualifier match + price in band |
| `brompton-electric` | Brompton Electric | ✓ | 4 | £2900 | Brand + qualifier match + price in band |
| `wahoo-kickr-core-2` | Wahoo Kickr Core 2 | ✓ | 2 | £399 | Brand + qualifier match + price in band |

## Failures detail

### bosch-leaf-blower-18v
- Query: Bosch Cordless Leaf Blower 18V
- Reason: Top title "Buy Einhell Cordless Leaf Blower - 18V | Leaf blowers and garden vacuums | Argos" missing brand "Bosch"
- Cheapest: £72 at Argos
- Top title: Buy Einhell Cordless Leaf Blower - 18V | Leaf blowers and garden vacuums | Argos
- Reasoning: —

### sennheiser-hd-660s
- Query: Sennheiser HD 660S
- Reason: Top title "Sennheiser HD660S2 Open Back Audiophile Headphones" missing qualifier signals (expected one of: HD 660S)
- Cheapest: £329.99 at HBH Woolacotts
- Top title: Sennheiser HD660S2 Open Back Audiophile Headphones
- Reasoning: —

### iphone-17-base
- Query: iPhone 17
- Reason: Top title "Buy iPhone 17" missing brand "Apple"
- Cheapest: £799 at Apple
- Top title: Buy iPhone 17
- Reasoning: The iPhone 17 is available from Apple at £799.

### iphone-17-pro
- Query: iPhone 17 Pro
- Reason: Top title "iPhone 17 Pro" missing brand "Apple"
- Cheapest: £1399 at Apple
- Top title: iPhone 17 Pro
- Reasoning: The iPhone 17 Pro is available at Apple for £1099.

### le-creuset-24cm
- Query: Le Creuset Signature 24cm casserole
- Reason: Cheapest £153 outside expected band 239-349 (±30%)
- Cheapest: £153 at Cookwarestore
- Top title: Casserole Le Creuset Signature Matte Black 24 cm
- Reasoning: —

### kettle
- Query: kettle
- Reason: API error: HTTP 504
- Cheapest: — at —
- Top title: —
- Reasoning: —
