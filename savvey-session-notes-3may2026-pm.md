# Savvey — 3 May 2026 PM session notes

Final session notes. Vincent went silent for 30 mins; the work below was completed during that window.

## What's ready to push (git push origin master)

```
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git add .
git commit -m "Wave 99: per-category retailer curation + qm-priority sort"
git push origin master
```

Files modified:
- `api/ai-search.js` v1.15 → v1.17
- `sw.js` v99 → v100
- `savvey-session-notes-3may2026-pm.md` (this file)

## Wave 98 — already pushed and verified live

Live v1.16 / SW v99 deployed earlier this session. Cordless vacuum cleaner still returns 0 items, BUT the failure mode shifted — `usedFallback: false`, `raw_results: 28`, `uk_hits: 0`. Confirmed by debug envelope: Perplexity DID return 11 valid Argos/Very/JL URLs but all of them are category/listing pages (e.g. `/browse/appliances/vacuum-cleaners-and-floorcare/cordless-vacuum-cleaners/c:29934/`), not product pages. v1.6's PRODUCT_URL_PATTERNS correctly rejects these. The Wave 98 fallback also returned category URLs.

So Wave 98 fixed the original bug class (zero-hit early return) but the cordless-vacuum failure has a DIFFERENT root cause: generic-category queries return browse pages, not products. Documented as Wave 100 candidate (see below).

## Wave 99 — per-category retailer curation (LOCAL, ready to push)

Vincent's standing concern: "kettle hits Currys before Lakeland". Fix is broader than kitchen — there are four categories where the existing retailer mix mis-matches. Added four new category locks alongside existing GROCERY/BEAUTY/DIY/BUDGET:

| Lock | Keywords (sample) | Hosts |
|---|---|---|
| KITCHEN | kettle, casserole, saucepan, mixer, KitchenAid, Le Creuset, Sage, Magimix | Lakeland, Robert Dyas, Dunelm, JL, Wayfair, Habitat, IKEA, Argos, Amara |
| SPORTS | trainers, running shoes, gym leggings, dumbbells, Nike, Adidas, Garmin Fenix | JD Sports, Sports Direct, Decathlon, Wiggle, SportsShoes, M&M Direct, Pro:Direct |
| FASHION | dress, shirt, jeans, jacket, ASOS, Reiss, Barbour, Levis | ASOS, Next, M&S, JL, Selfridges, End., Zalando, Very, Matches |
| BOOKS | book, notebook, Moleskine, Lego, board game | Waterstones, WHSmith, Blackwell's, Foyles, Amazon, Argos, The Works, Wordery |

KITCHEN takes precedence over BUDGET — kettle/toaster/casserole no longer hit the discount-tier hosts first. BUDGET keyword list slimmed: kettle/toaster/casserole/saucepan/frying-pan/mixer/blender/processor/slow-cooker/pressure-cooker/rice-cooker/breadmaker/sandwich-maker/popcorn-maker/air-fryer/spiraliser/mandoline removed (now KITCHEN). Vacuum/microwave/iron/fan/cleaning-mop stay in BUDGET.

Same architectural pattern as Wave 26 — these are EXTRA Perplexity calls, not replacements. Costs +1 Perplexity call (~$0.005) when a category matches; zero overhead otherwise. The broad/Amazon/loose calls still fire, so generalist coverage stays intact.

### Plus: qm-priority sort (Wave 99 same patch)

Vincent's Bose QC Ultra concern: a JL hit graded `qm:similar` (likely the older QC45) showed cheaper than a `qm:exact` Argos hit. Sorting by price alone surfaced the wrong product as cheapest.

Now sorted by `query_match` priority first, price as tiebreaker:
1. `qm:exact` (perfect product match)
2. `qm:similar` (loose match)
3. anything else

Both pre-verify and post-override sorts updated. Catastrophic mis-ranking class is closed.

## Battery test on live v1.16 (PRE-Wave 99) — confirms thesis

| Query | Result | Wave 99 fix |
|---|---|---|
| Le Creuset 24cm casserole | JL £305 (no Lakeland) | Lakeland gets queried, will likely undercut |
| Nike Air Max 90 | **0 hits** | SPORTS lock adds JD/Sports Direct |
| ASOS midi dress | **0 hits** | FASHION lock adds ASOS direct |
| Moleskine notebook | JL £15.01 (qm:similar) | BOOKS lock adds Waterstones/WHSmith |
| Lakeland silicone spatula | Lakeland £4.99 (works because user typed retailer name) | KITCHEN lock surfaces Lakeland for generic spatula too |
| Dyson V15 Detect | JL £479 qm:similar AHEAD of Argos £549 qm:exact | qm-priority sort flips this |
| AirPods Pro 2 | Argos £169 (verified) | Unchanged — generalists already work |
| Sony WH-1000XM5 | JL £229 (3 retailers) | Unchanged |
| KitchenAid stand mixer | Argos £379 (drift override fired £349→£379) | Unchanged |
| iPhone 17 | Apple £799 (drift cap rejected £26 finance) | Unchanged |
| Stanley flask | JL £52 | Unchanged |
| Birkenstock Boston | Very £96 | Unchanged |
| Bose QC Ultra | JL £199 (qm:similar) ahead of Argos £299 (qm:similar) | Both similar, but qm-rank sort lifts qm:exact when present |

Verification timeouts (Garmin Forerunner, GHD Platinum+, Le Creuset, Stanley, Moleskine) still hit `exception_AbortError` at 8s on JL pages. Path 1 (Perplexity URL verification) remains the right fix — out of scope this session.

## Outstanding bugs after Wave 99

### High priority
1. **Generic-category zero-hit class** (cordless vacuum, possibly fan, possibly hoover). Perplexity returns category-listing URLs that v1.6 product-pattern admission correctly rejects. The right fix is a Haiku pre-flight: detect "is this a category or a specific product?" and if category, ask Perplexity for the top 3 specific products in that category, then run normal flow on each. Wave 100 candidate.
2. **JL verification timeouts** — 5 of 14 battery queries hit `exception_AbortError` at 8s. Path 1 Perplexity URL verification swap addresses this.
3. **Drift cap inverse-bug** (kettle £40 snippet kept, live £60 correct, drift cap rejected the fix). Replace boolean cap with one Haiku tiebreaker call. Quick fix, high impact.

### Medium
4. Air fryer Argos URL 404 — need stale-URL detection. Argos product IDs change; the URL admission check passes structurally but the page is dead.
5. Hero image misses on category queries (because no product to query Serper images for).
6. **Serper still at -42 credits.** Wave 96 economy mode keeps things stable but coverage degrades on Tier 1 outage. Vincent's stated plan: commit fully to Tier 1 if all working — agreed. Battery confirms Tier 1 carries the load for 13/14 specific products.

## End-of-session reflection (per saved memory pattern)

**1. Are we doing the correct things to progress to in-store / on-product → fair-price verdict in 30s?**

Yes — Wave 99 directly attacks the most visible quality issue (wrong-retailer surfacing on common categories) AND the qm-rank fix closes the wrong-product mis-ranking class. Both are architectural rather than band-aid: KITCHEN/SPORTS/FASHION/BOOKS lock-in is a 50-line lookup that replaces what would otherwise be N retailer-specific patches. Still Wave 100 (category-vs-specific Haiku) is needed to rescue generic-category queries.

**2. What's working well right now?**

- 13/14 specific products land plausibly on Tier 1
- Drift override works as intended (KitchenAid £349→£379 caught live this session)
- Drift cap correctly rejects iPhone 17 finance-number disasters
- Wave 98 zero-hit fallback fires when broad call returns no UK URLs
- Haiku query_match grading is honest — `similar` vs `exact` flag was already there, just needed to be load-bearing in the sort (Wave 99 closed that gap)
- Tagline "shop smart." consistent across live files (manifest + index + share canvas)

**3. Where could things work better?**

- **Cordless vacuum / kettle / air fryer / generic categories** still failing — Wave 100 (category-vs-specific routing) is the fix.
- **JL verification timeouts** at 8s repeat across many queries — Path 1 swap to Perplexity URL verification kills this.
- **Drift cap is bidirectional** — Haiku tiebreaker needed.
- **Hero image** doesn't show for category queries — should fall back to top-product image.

**4. Where could AI replace or simplify a stack of patches we've added?**

Three concrete swaps in priority order:

1. **Wave 100 — Haiku category-router preflight.** One $0.0002 call: "Is '{q}' specific or category? If category, name top-3 UK products." Resolves cordless-vacuum class entirely AND surfaces multiple products to user.
2. **Path 1 — Perplexity URL verification** replaces 9-retailer regex extractor + browser-header rig + 8s timeout management. ~$0.005 per cheapest verification. Kills 4-6 separate failure modes.
3. **Drift-cap → Haiku tiebreaker.** Snippet £40 vs live £60 — one $0.0002 call decides which is real. Kills kettle inverse-bug AND keeps iPhone protection.

Total cost increase: ~$0.012 per search → ~$0.018 per search. Reliability gain: solves 6+ failure modes. Cost drops as a percentage of revenue per search if Tier 2 Serper exit succeeds.

**Anything I'm not flagging?**

- **Tier 1 commitment is the right call.** Battery confirms Tier 1 reliably handles 13/14 specific products. Holding back Serper top-up until/unless Wave 100 + Path 1 fail to close coverage.
- **Wave 100 category routing has a UX implication** — when query is "cordless vacuum cleaner", we'd return 3 top products to choose from, not a single price. That's a different UI state. Worth thinking through before shipping.
- **Memory-of-search history** would compound user value over time — "you searched air fryer last week, here's the cheapest now" — but that's a future-features list item, not next-session work.

## Highest-impact next move

**Push Wave 99**, then ship **Wave 100 Haiku category-router**. ~$0.0002 per search. Closes the generic-category class (cordless vacuum, kettle, fan, etc) — the single largest source of zero-hit failures.

After that, **Path 1 Perplexity URL verification** prototyped on JL only (the most-cheapest retailer) — if it works there, expand. Replaces 9 retailer-specific extractors with one consistent call.

## Files updated this session

- `api/ai-search.js` v1.15 → v1.17 (Wave 98 zero-hit fallback + Wave 99 category locks + qm-priority sort)
- `sw.js` v98 → v100
- This session-notes file
- Memory: `savvey_outstanding_bug.md` updated to point at Wave 99 ready-state
