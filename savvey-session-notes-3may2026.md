# Savvey — session notes 3 May 2026

End-of-day state after Waves 67-88. Continues from `savvey-session-notes-2may2026-afternoon.md`.

## Live state
- **Frontend**: SW v89, index.html ~9,200 lines
- **Backend**: api/search.js v6.23, api/ai-search.js v1.10, api/ai-estimate.js v1.1
- **Live URL**: https://savvey.vercel.app

## Waves shipped this session

### Truthfulness + AI grading layer
- **Wave 67** — Single source of truth on result hero. AI estimate strip (Savvey Says) gated to thin coverage only. Haiku ai-estimate prompt date-anchored to today (no more "iPhone 17 unreleased" in May 2026). All "UK average across N retailers" copy migrated to "typical UK price."
- **Wave 79** — Haiku query_match grading (exact / similar / different) added to /api/ai-search. Catches unknown patterns the regex filters miss.
- **Wave 82** — Same Haiku grading extended to /api/search (Tier 2). Plus eBay demotion: drop eBay listings unless query mentions used/refurb (it's a marketplace, not a retailer).
- **Wave 83** — Price-anomaly floor on post-Haiku Tier 2 results. Drops "similar"-graded listings priced <25% of cluster median (catches yoga-mat-strap-style leaks).

### Variant + bundle filtering
- **Wave 70** — Tier/variant guard in Haiku prompt + frontend regex. iPhone 17 rejects Pro/Pro Max/Plus; MacBook Air/Pro mutually exclusive; iPad/AirPods/Apple Watch tiers separated.
- **Wave 78** — Extended variant guard: Nintendo Switch / Switch 2 / Switch Lite distinct, PS5 vs PS5 Pro vs PS4, Xbox Series X vs Series S. Plus bundle filter — drops "Pokémon console bundle / with N games / combo pack" unless explicitly asked.

### Retailer coverage expansion
- **Wave 77** — Amazon UK + B&Q + Wickes + Screwfix + Lakeland + Dunelm added to PER_RETAILER_SITES fan-out. Frontend UK_RETAILERS map synced. Top 5 retailer rows displayed (was 3). Outliers visible in list, only excluded from avg calc.
- **Wave 84** — Books fan-out (Waterstones, WHSmith, World of Books, Blackwell's). Furniture/home fan-out (IKEA, Wayfair, Habitat, Homebase). Frontend retailer map + search URLs + brand keys + brand colors all updated.
- **Wave 85** — Major UK supermarkets in fan-out (Tesco, ASDA, Sainsbury's, Morrisons) for non-grocery items.

### Category-page rejection
- **Wave 86** — CRITICAL. Reject category/listing/search-page URLs (Asda George `,sc.html` etc). Vincent's "kettle £24" case fixed at source.
- **Wave 87** — Extra patterns: B&Q `.cat?`, AO `/l/`, JL `/_/N-`, Selfridges `/cat/`, Wickes `/featured/`, faceted-filter query strings. Plus snippet backstop — drop titles containing "from £X / prices from / ranges from / starting at £X."

### UI polish
- **Wave 67** — Snap pill clash fixed. Trending tiles removed (home cleaner). Counter shows "spotted across N checks" subtitle.
- **Wave 73** — Bottom nav padding 132→148px (result footer no longer clipping).
- **Wave 74** — SW update toast (in-app refresh prompt on new SW).
- **Wave 75** — Retailer-row stagger animation. Counter dedupe by (query, day). Share-card race fix. Focus management on screen change. Telemetry endpoint /api/track.
- **Wave 76** — Outlier guard on cheapest-3 cluster (£426 AO drops out of typical-price calc). iPhone 17 / Apple Watch threshold updates (now released, not "future").
- **Wave 80** — Snap green-pill bug fixed (only Home highlights now). Amazon CTA reframed: "You can check Amazon here." Suppressed when user came from Amazon paste. Lakeland/Dunelm/Homebase added to retailerSearchUrl.
- **Wave 81** — Trending tiles markup removed. query_match field surfaced on API response.
- **Wave 88** — Affiliate disclosure rewrite: "Some retailer links earn Savvey a small commission — doesn't change what you pay."

## What's working well
- Cordless vacuum (when not broken — see Wave 86 regression below): Lakeland £40 best, full UK retailer spread including budget tier
- Air fryer: 11 retailers, Dunelm £30 to JL £50+
- Hair dryer: 6 retailers, Argos £15 to JL £50
- Olaplex No 3: counterfeit eBay £10.99 dropped, Amazon £20 / Very £23 / JL £46 surfaced
- Memory foam mattress: Selfridges £75 wrong-product dropped, real range £199-£740
- Atomic Habits book: World of Books £14.89 surfaced (was eBay-only)
- AirPods Pro 2: Very £179 + Argos £229 (clean)
- Sony WH-1000XM5: 4/5 score, £7 below typical
- Nintendo Switch: Switch 2 contamination filtered
- Snap pill bug: fixed, only Home highlights
- "Savvey Says" panel: Vincent confirmed loved (saved to memory as design pattern)

## CRITICAL outstanding issues (top of tomorrow's list)

### Wave 89 — HOT FIX
**Cordless vacuum cleaner returns ZERO results** post-Wave 86. The category-URL pattern set is over-aggressive — likely dropping legitimate retailer URLs containing `/featured/`, `/all-`, `/browse/`, `/_/N-`. Vincent's flagship canonical query is broken in production right now. First thing to fix tomorrow.

### Wave 90 — Diagnose price-anomaly floor silent failure
Yoga mat: Amazon £9.99 still surfaces despite Wave 83. Add `?debug=true` flag to /api/search returning per-stage counts so we can see what dropped where. Then fix the threshold or the bug.

### Other regressions / coverage gaps
- **PS5** — only AO £575 surfaces (real UK is £389-449). Coverage gap, possibly Google indexing.
- **Books fan-out (Wave 84)** — only World of Books for Atomic Habits; Waterstones/Amazon should appear but didn't.
- **Stanley flask** — 2 wrong-product results surfaced as authoritative.
- **Loading screen retailer logos** — stale: B&Q / Lakeland / Dunelm / Wayfair / IKEA / Habitat / Waterstones / WHSmith all in backend now but the loading-screen marquee tiles still show original 8 only.
- **Counter image hydration quality** — iPhone 17 chip showed barcode, Samsung 65 QLED chip showed donut. /api/image returns garbage on category queries.

## Audit findings (today's State of the App Report)

Visual Design: 7/10
Functional Stability: 6/10 (regressed from 5.5 because of Wave 86 over-filter)

Saved as `savvey-state-of-app-report-3may2026.md`.

Headline: "We have 88 waves of additive complexity and ZERO regression tests. The Wave 86 cordless vacuum failure is not a one-off; it's the first one we caught quickly. The next is being shipped right now and we won't notice until Vincent tries the canonical query and tells us. Wave 94's end-to-end harness is the single biggest unlock for shipping confidence."

## Tomorrow's roadmap (Waves 89-100)

| Wave | Task | Priority |
|---|---|---|
| **89** | Hot fix Wave 86 over-filter — restore cordless vacuum cleaner | TODAY |
| **90** | Debug Wave 83 price-anomaly silent failure (add debug flag) | TODAY |
| 91 | Loading screen retailer-logo refresh (add B&Q/Lakeland/Dunelm/Wayfair/IKEA/Habitat) | This week |
| 92 | Frontend ↔ backend retailer sync test script | This week |
| 93 | Real-device QA pass (iOS Safari + Android Chrome) | This week |
| 94 | End-to-end test harness (20 canonical queries assert non-empty + plausible price) | This week |
| 95 | Result hero density audit — cut to verdict + wit + £-saved + ONE primary CTA | Soon |
| 96 | Type token sweep (5 sizes / 3 weights / 6 spacing tokens) | Soon |
| 97 | Telemetry dashboard — pipe /api/track to Supabase + view | Soon |
| 98 | Loading-screen real-device verification | This week |
| 99 | Awin / Skimlinks application (Vincent's deliverable) | Soon |
| 100 | buildScenV3 refactor (now ~120 lines, 3 pure functions) | Soon |

## Tooling notes
- Edit at `C:\Users\vince\OneDrive\Desktop\files for live\`
- Push: `cd "C:\Users\vince\OneDrive\Desktop\files for live"` → `git add .` → `git commit` → `git push origin master`
- Always `git push origin master` not bare `git push`
- Vercel auto-deploys on push (~30s)
- Live verify via Chrome MCP — test the canonical query battery (kettle, vacuum, lawn mower, air fryer, electric toothbrush, hair dryer, AirPods Pro 2, iPhone 17, Atomic Habits, yoga mat, memory foam mattress, PS5)

## Brand / voice (no change)
- Name: Savvey
- Tagline: shop smart.
- Primary colour: #2a6b22
- Score name: Save Score
- Pips: 1-2 red / 3 amber / 4-5 green
- Verdicts: 1=Walk away / 2=Better deal available / 3=Worth a look / 4=Pretty good / 5=Best price
- Voice: consumer-first, dry wit, never accusatory
- "Savvey Says" panel: orange eyebrow + family + price band + dated reasoning + retailer pills + comparable CTA — Vincent confirmed loved, do not refactor away
- Affiliate disclosure: "Some retailer links earn Savvey a small commission — doesn't change what you pay."
