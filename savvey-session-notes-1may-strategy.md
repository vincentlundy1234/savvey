# Savvey — Session Notes (Strategy + Data Architecture)
## 1st May 2026 — Late session, post-UX-pass through to v6.12

---

## Where Savvey is at end of session
- **Live URL:** https://savvey.vercel.app
- **Last commit deployed:** `2b68682` — v6.12
- **Function response time:** ~1.5s typical, ~3s cold start
- **Bug ledger:** empty for routing/UX. Outstanding work is data sourcing, not code.

## What was decided this session

### The strategic pivot
Halfway through the engineering iteration, we paused and treated this as a Lead Architect / Product Strategist review. Vincent's instinct was that we were over-engineering filter logic on a fundamentally weak data source (Serper) while declining to apply to the affiliate networks (Awin, Amazon Associates) that would actually fix the data.

The conclusion: **Amazon Associates is the right next move, before more filter tuning.** Reasoning:
- Amazon UK has the broadest single-retailer UK consumer catalogue.
- Amazon Associates accepts mobile apps and Vercel URLs — no domain required to apply.
- Product Advertising API (PAAPI 5.0) gives structured data: real product URLs, prices, images.
- Slots in cleanly alongside our existing `AwinProductProvider` class as a parallel data provider.
- Affiliate revenue starts on day 1 of acceptance.

After Amazon: extend `scrape.js` for Currys / Argos / John Lewis / AO direct search-page scraping. Then domain → App Store → Awin.

### The product simplification
Vincent's other key insight: the result UI was trying too hard to show "4 retailer comparison" when our data couldn't always deliver that. Better simpler product:
1. Cheapest UK price found
2. Average price (where applicable, for context)
3. Savvey Score — but only when the user has a reference price to score against (in-store shelf price, or pasted URL price). For pure search, no score — show "Best UK price" instead.

This led to v6.12's **Discovery vs Validation** UI split (described below).

## Architecture decision: data tiers

The intended architecture going forward:

```
Tier 1 (primary, reliable, structured):
  • Amazon Product Advertising API   — pending Associates approval
  • Direct scrape: Currys / Argos / John Lewis / AO   — to be built

Tier 2 (gap fillers):
  • Awin Product Feed   — apply once domain + app live
  • Serper Google Shopping   — relegated from primary to fallback

Tier 3 (long tail):
  • Google CSE   — already wired, low quota, edge-case fallback
```

Right now we're 100% on Tier 2 + Tier 3. Goal of the next sessions is to populate Tier 1.

## v6.12 changes shipped (`2b68682`)

### Backend (`api/search.js`)
- **Dynamic ceiling removed.** It was killing legitimate Currys/Argos hits when an eBay variant anchored a tight `lowest × 4` ceiling. The remaining four layers (nuclearFilter £5k cap, identityFilter, trustedSourceFilter, priceAnomalyFloor) cover the same defensive ground without the false negatives.
- **Trust filter tightened.** Dropped the bare `.co.uk` / `.uk` TLD fallback that was letting random reseller domains pass and become "best price" for queries with no major retailer hit (the £45 Samsung TV bug). Now requires explicit match against `TRUSTED_SOURCE_TERMS` or hostname in `TRUSTED_DOMAINS`.

### Frontend (`index.html`) — the big UX change
**Discovery vs Validation modes** — `renderResults` now branches on whether the user has a reference price (`sc.uPrice`):

- **Discovery mode** (search flow, no userPrice): pips hidden. Verdict banner reads "Best UK Price · £X at [Retailer]". Body shows cheapest + "Average across N UK retailers: £Y". No score because there's nothing to score against.
- **Validation mode** (in-store scan or URL paste, with userPrice): full Savvey Signal — pip animation, verdict ("Walk away" / "Worth a look" / "Best price"), saving amount, "[Retailer] has it for £X right now."

Plus:
- Result list capped at top 3 retailers (was 4) — cheapest highlighted as `.best`.
- `avgPrice` and `retailerCount` computed in `buildScenV3` and shown on the results screen.

### Service worker
- `STATIC_VER` bumped v15 → v16 to force-refresh users to the new index.html.

## What's still imperfect (not blockers)

These are data-quality issues that the Tier 1 work will fix:

- For most popular products, results are still mostly eBay listings + occasional Selfridges/McGrocer/Currys hits. Not consistent multi-retailer comparison.
- The £89 / £138 eBay listings for Sony WH-1000XM5 are still likely mis-listings (an eBay seller stuffing the model number into the title for an unrelated cheaper product). Identity filter passed them because "WH-1000XM5" appears.
- `PASTE_RETAILERS` hardcoded demo prices (~line 1925) — orphan code, should be deleted.

Don't iterate on these before Amazon is wired. Tier 1 data makes them irrelevant.

## What "go" looks like after this session

1. **Vincent applies to Amazon Associates** — uses savvey.vercel.app as the website. Application form asks how traffic will be driven; describe the three customer journeys (in-store scan, online search, URL paste) as a "price-comparison utility for UK consumers."
2. **Approval typically 24-48 hours**, then he gets PAAPI access keys.
3. **Next session:** Claude scaffolds `AmazonProductProvider` class mirroring the existing `AwinProductProvider` pattern. Vincent drops in his `AWS_ACCESS_KEY` + `AWS_SECRET_KEY` + `AMAZON_ASSOCIATE_TAG` into Vercel env vars. The provider activates the moment those are present.
4. **Within that same next session:** extend `scrape.js` to take a query string and scrape Currys, Argos, JL, AO search pages. Four small parsers, no third-party approval needed.

After both: ~5-6 reliable UK retailer prices per query, structured data, real buy URLs. The app's core promise is delivered.

## Operational notes for next session

- Latest deploy folder content is current and committed. `git status` shows clean tree.
- Memory updated to reflect: bug ledger empty, Amazon Associates is next, don't propose Serper iteration before Tier 1 lands.
- Live verification approach for next session: when `AmazonProductProvider` is wired, debug envelope `{q:"...",debug:true}` will show Amazon items in `_debug.rawSample` with PAAPI-shaped fields. Confirm via that, then test end-to-end via Claude in Chrome.

## Commit chain summary, this session
| Commit | Version | Purpose |
|---|---|---|
| `8dfbd89` | v6.9 (UX) | Kill price screen for search/trend, in-store-only price entry, honest empty state, welcome→home routing |
| `33d2959` | docs | Earlier session notes (v6.4→v6.8.1) |
| `3858bec` | v6.10 | UK site-restricted Serper search in parallel with shopping |
| `15a0ab5` | v6.10.1 | extractRetailerName helper — fixes 'https:' source bug |
| `bfb807d` | v6.10.2 | ULT WEAR + cross-product mis-listing blocklist + price-anomaly floor |
| `ffe7efc` | v6.11 | Collapse eBay sellers + 50% anomaly floor + coverage flags + frontend honesty banner |
| `af753ca` | v6.11.1 | Critical fix — canonicaliseSource and frontend matchRetailer must use source field only |
| `2b68682` | v6.12 | Drop dynamic ceiling, tighten trust filter, Discovery vs Validation mode, average price, top 3 retailers |

## Brand voice reminders (from earlier sessions, still valid)
- "spend smart." — never accusatory
- Currys: "Currys, more worries 😢"
- John Lewis: "aspirational pricing. As ever."
- Never: "ripped off", "rip-off"
- Buy button always green — positive action

## Cost / running fees
**£0/month** — Vercel free, Supabase free, Serper free tier, Google CSE free 100/day. No change.
