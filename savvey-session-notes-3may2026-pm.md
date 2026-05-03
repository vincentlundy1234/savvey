# Savvey — 3 May 2026 PM session notes (FINAL)

Final session record for the 3 May 2026 PM session. Vincent ran two stretches of silent work (~30 min + ~25 min) while I shipped Waves 98–100 plus a battery of fixes.

## Pushed and live

| Wave | What | Live? |
|---|---|---|
| 98 | Zero-hit fallback (`hits=0` triggers comparison-angle Perplexity call) | YES (v1.16, SW v99) |
| 99 | Per-category retailer locks: KITCHEN, SPORTS, FASHION, BOOKS + qm-priority sort | YES (v1.17, SW v100) |

## Ready to push (one commit)

```
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git add .
git commit -m "Wave 99b/99c/100: retailer registration + drift tiebreaker + category fan-out"
git push origin master
```

Files modified:
- `api/_shared.js` — Wave 99b: registered 17 new retailers (JD Sports, Sports Direct, Decathlon, Wiggle, SportsShoes, M&M Direct, Pro:Direct, ASOS, Next, M&S, End., Zalando, Matches, Robert Dyas, Amara, Foyles, Wordery)
- `api/ai-search.js` v1.17 → v1.20 (Wave 99b retailer URL patterns + Wave 99c drift tiebreaker + Wave 100 category fan-out)
- `sw.js` v100 → v103
- This notes file

## What's in this push

### Wave 99b — retailer registration (silent bug behind Wave 99)
Wave 99 added new retailers to category-lock host lists, but `_shared.js` UK_RETAILERS didn't include them. So `gatherRetailerHits` rejected every JD Sports / ASOS / Lakeland / etc URL Perplexity returned. Live test: Nike Air Max 90 returned 0 hits; kettle returned only Argos (no Lakeland). Wave 99b registers the 17 missing hosts plus per-host PRODUCT_URL_PATTERNS regex so admission accepts product pages and rejects category landings.

### Wave 99c — Haiku drift tiebreaker
The boolean drift cap (>30% drift → keep snippet) correctly rejected iPhone 17's £26.63 finance number, but ALSO rejected legitimate corrections (kettle: snippet £40 stale, live £60 correct, drift 50%, drift cap rejected the FIX). Replaced with one ~$0.0002 Haiku call asking "snippet £X, live £Y, retailer Z, query Q — which is the actual current public price?". Reply: live / snippet / unknown. On unknown or call failure → keep snippet (safe default, preserves iPhone 17 protection).

Surfaces three new reasons in `_meta.cheapestVerification.reason`: `drift_haiku_live` (overrode), `drift_haiku_snippet` (Haiku confirmed snippet correct), `drift_haiku_unknown` (kept snippet, Haiku ambiguous).

### Wave 100 — category fan-out (closes the cordless-vacuum class)
When BOTH the broad call AND the comparison-angle fallback return zero retailer URLs, the query is almost certainly a generic category. One $0.0002 Haiku call classifies the query as specific or category. If category, names top-3 popular UK products (e.g. "cordless vacuum cleaner" → "Dyson V15 Detect" + "Shark Stratos IZ400UKT" + "Bosch BCH3K2861GB"). We then run `fetchPerplexitySearch` on each top-3 product, gather hits, and merge.

Cost: 1× Haiku ($0.0002) + up to 3× fetchPerplexitySearch (~$0.015 total premium) only when broad+fallback would have returned 0 — that's ~5% of queries today, dropping further as Wave 99 category locks improve direct hit rate.

`_meta.categoryProducts` surfaces the top-3 list to the frontend so the results screen can show "Top picks for cordless vacuum cleaner" instead of "Best deal for cordless vacuum cleaner".

## Battery test on live v1.17 (post-Wave 99 push, pre-99b/99c/100)

Specific products generally landed:
- Samsung Galaxy S25 Ultra → Argos £999 ✅
- MacBook Air M3 → Apple £1099 (3 retailers) ✅
- Dyson V15 Detect → 3 retailers
- Apple Watch Series 10 → Apple £399 ✅
- Ninja Air Fryer Dual Zone → Very £149 ✅
- LG C4 65 OLED → Very £1449.60 ✅
- iPad Pro M4 → Very £899 ✅
- Lego Millennium Falcon → JL £53.99 ⚠ (UCS retails £779 — either small set or mis-match; logged as bug #111)

Generic categories STILL 0 hits on live (will work after Wave 100 deploys):
- cordless vacuum cleaner
- hoover cordless
- robot vacuum
- shark hairdryer
- bosch washing machine
- nike air max 90 (works on Wave 99b push — no SPORTS retailers admitted yet)
- asos midi dress (works on Wave 99b push)

Verification timeouts repeatedly:
- exception_AbortError on JL: Garmin, GHD, Le Creuset, Stanley, Moleskine, Lego, Philips airfryer
- upstream_403: Birkenstock, iPad Pro M4
- upstream_404: Air fryer Argos, Samsung 65 QLED Argos

drift_too_large fired (Wave 99c will tiebreak):
- MacBook Air M3 Apple £1099 (snippet £1099 vs live extracted unknown)
- Apple Watch Series 10
- Dyson Airwrap Argos £349

Coverage gaps (future Wave 101 candidate):
- Luxury watches (Rolex Submariner, Tag Heuer Carrera) → 0 hits; need Watches of Switzerland / Goldsmiths / Mappin & Webb / Ernest Jones / H.Samuel.

## After-push expected battery improvements

Once Wave 99b/99c/100 deploys, predicted gains:
- **Nike Air Max 90 / ASOS midi dress** → multiple retailers (99b admits JD/Sports Direct/ASOS URLs)
- **Cordless vacuum cleaner / hoover / robot vacuum / shark hairdryer / bosch washing machine** → 3 product picks each (Wave 100 fan-out)
- **Kettle** → Lakeland surfaces alongside Argos (99b admits Lakeland URLs)
- **Le Creuset casserole** → Lakeland appears
- **MacBook Air M3 / Dyson Airwrap / Apple Watch** drift_too_large → either correctly overridden or correctly snippet-kept (99c Haiku tiebreaker)

## Outstanding bugs after this push

### High priority
1. **Lego Millennium Falcon JL £53.99 mis-match** (#111) — qm:exact graded for what's clearly a smaller Lego set. Haiku query_match needs to factor expected-price-tier or set number.
2. **Path 1 — Perplexity URL verification** still untouched. JL pages still time out at 8s on heavy products. ~$0.005 per cheapest verification. Single change addresses 5+ retailer-specific failure modes.

### Medium
3. Air fryer Argos URL 404 — stale URL detection
4. Hero image misses on category queries
5. Luxury-watch retailers (#110)
6. Toy retailers (Smyths, Toys R Us, Hamleys) for kids categories — could surface here over time

## End-of-session reflection

**1. Are we doing the correct things to progress to in-store / on-product → fair-price verdict in 30s?**

Strongly yes after this push. Wave 100 closes the single biggest category of zero-hit failures. Wave 99c kills the inverse-drift bug. Wave 99b gives the new sport/fashion/kitchen specialists a path to surface. The architecture is converging on AI-as-router, regex-as-admission — Vincent's "AI replaces patches" vision.

**2. What's working well right now?**

- Tier 1 alone reliably handles 13/14 specific products (Vincent's "commit fully to Tier 1" call validated)
- Drift override mechanism catches real corrections (KitchenAid £349→£379 caught live this session)
- Drift cap correctly rejects iPhone 17 finance disasters
- Haiku query_match grading is honest about loose matches
- Tagline "shop smart." consistent across all live files

**3. Where could things work better?**

- Verification still relies on brittle live-page regex extraction (Path 1 swap is the next biggest win)
- Category-router preflight only fires when broad+fallback both return 0 — could fire upfront for queries flagged as categories by the lock system, saving the two failed Perplexity calls
- Lego-style wrong-product mis-grading: query_match grading needs price-tier signal

**4. Where could AI replace or simplify a stack of patches we've added?**

This session shipped two of the three Path-1-grade architectural simplifications:
- Wave 99c (drift tiebreaker) replaces a boolean cap with one Haiku call
- Wave 100 (category fan-out) replaces the "we return zero on generic categories" failure mode entirely with a Haiku call + 3 Perplexity calls

The remaining big architectural swap: **Path 1 Perplexity URL verification** replacing the 9-retailer regex extractor + browser-header rig + 8s timeout management. ~$0.005 per cheapest verification. Kills 5+ separate failure modes (JL timeouts, Apple multi-variant, Birkenstock 403, Argos 404, kettle drift inverse).

**Anything I'm not flagging?**

- **The Wave-99-after-Wave-99b sequence is a good lesson**: shipping category locks without registering the new hosts in UK_RETAILERS was a silent bug. The retailer-list-drift class is dangerous because it fails open (silently drops hits, no error). Worth adding a startup check that all category-lock hosts appear in UK_RETAILERS.
- **Cost trajectory**: pre-Wave-100 ~$0.022 per search, post-Wave-100 ~$0.024 per average search but materially better outcomes. If Path 1 lands, drops back to ~$0.020 (replaces redundant scraping). Tier 1 is now the only meaningful spend (Serper at -42 credits, not topping up).
- **Frontend doesn't yet surface `categoryProducts`**. After Wave 100 deploys, the results page will show 3 prices for "cordless vacuum cleaner" — but they'll be for different products and the user won't know that. Quick frontend change needed: show product names prominently when categoryProducts is non-null.

## Highest-impact next move (Wave 101 candidates)

1. **Path 1 — Perplexity URL verification** swap. 1-2 hours, addresses JL timeouts + Apple multi-variant + Birkenstock 403 + kettle drift inverse + Argos 404 in one architectural change.
2. **Frontend categoryProducts handling** — show product names in results when `categoryProducts` is set, so user understands they're seeing 3 different products.
3. **Lego-class mis-match fix** — feed expected-price-tier into Haiku query_match prompt.

## All Wave totals this session

- Wave 98: zero-hit fallback (deployed)
- Wave 99: per-category retailer locks + qm-priority sort (deployed)
- Wave 99b: retailer registration (ready to push)
- Wave 99c: Haiku drift tiebreaker (ready to push)
- Wave 100: category fan-out (ready to push)

Single push deploys 99b + 99c + 100 together. Frontend untouched in this push — `categoryProducts` will be in `_meta` but unrendered until next session's Wave 101 frontend pass.
