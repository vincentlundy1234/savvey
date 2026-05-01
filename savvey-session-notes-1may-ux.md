# Savvey — Session Notes (UX pass)
## 1st May 2026 — Late session, customer-journey fix

---

## Why this session
Vincent paused the engineering iteration after spotting two big regressions in the live app:
1. The "What's the price tag?" screen kept appearing on the text-search flow despite multiple past asks to remove it.
2. The "No UK prices found" empty state was misleading — it implied no UK retailer stocks the product, when the truth is just that Serper didn't surface them. Sony WH-1000XM5 is at Currys, Argos, JL, Amazon UK, AO — saying "not found" makes the app look broken.

Vincent asked for the customer journeys to be mapped properly before any more backend work.

## Customer journeys (the three flows)

**Journey 1 — In-store barcode scan.**
Welcome → "In-store checker" → camera → barcode scan → product identified → **price screen** ("What's the shelf price?") → results screen with verdict vs shelf price. Price entry IS valid here — user has a real number to validate.

**Journey 2 — Online search by name.**
Welcome → "Online checker" → home (search box + trending pills + paste card) → type name + tap Check → **searching → results, no price screen**. User is discovering, not validating; price entry would be friction.

**Journey 3 — URL paste.**
Welcome → "Online checker" → home → paste link OR open paste card → scrape extracts product+price → **searching → results, no price screen**. Price is implicit in the URL, no manual entry needed.

## Changes shipped — v6.9 (`8dfbd89`)

### Routing
- `doLiveSearch` (text search) — was `goTo('price')` → now `goTo('searching'); showResults(fetchPrices(query))`. Price screen bypassed.
- `trendSearch` (trending pill tap) — same fix.
- `goBackFromResults` (back button on results) — was routing back to price screen → now `goHome()`.
- `confirmScan` / `useScannedProduct` (in-store flow) — UNCHANGED, still routes to price screen. Only legitimate use of the price screen now.
- Welcome screen secondary button — was `goTo('paste')` → now `goTo('home')` so search + paste are both reachable.

### Copy
- Welcome subhead: "Scan a barcode, search by name, or paste a product link." (was: "Scan a barcode in any shop or paste a product link.")
- Price screen body: "What's the shelf price?" + "Type the price on the sticker — we'll tell you if it's a fair deal vs the cheapest UK online price." (was: generic "What's the price tag?")
- Price screen header: "In-store price check" (was: "What's the price tag say?")
- Empty state title: "Couldn't reach the price data." (was: "No UK prices found.")
- Empty state body: "This is a data-source hiccup, not a sign the product is unavailable. Most UK retailers stock popular items — try again in a moment, try a slightly different spelling, or paste a product link directly." (was: blaming "marketplace listings filtered out").

### Cache
- `sw.js` STATIC_VER v11 → v12 to force users onto the new index.html.

## Live verification (via Claude in Chrome)

Search flow test on live (`8dfbd89`):
- doLiveSearch('Sony WH-1000XM5') → currentScreen: 'results' (NOT 'price') ✓
- priceScreenVisible: false ✓
- resultsScreenVisible: true ✓
- liveScen.bestRetailer: 'eBay UK', bestPrice: 89.99, score: 5 ✓
- Total time: 3.4s

Welcome routing test:
- Primary button: `goTo('scan');startScanner()` ✓
- Secondary button: `goTo('home')` ✓ (was 'paste')

Empty-state test (deliberately nonsense query):
- Title: "Couldn't reach the price data." ✓
- Body matches new honest copy ✓

## What's still imperfect (not blockers)

1. **Sony WH-1000XM5 best price = £89.99 from eBay** — almost certainly a mis-listed Sony ULT WEAR (different cheaper product) where the title contains "WH-1000XM5" by accident. Identity filter passed it. Worth adding negative keywords (e.g., reject if title contains "ult wear" alongside WH-1000XM5).

2. **Single-retailer result** — when all hits are eBay variants, dedup collapses to one row. No comparison context. UX item: maybe show top 3 eBay sellers as separate rows, or surface a message like "Limited UK retailer coverage right now."

3. **Serper data quality is poor for popular products** — the structural fix is the Awin Product Feed. `AwinProductProvider` is wired in `search.js`; activates the moment `AWIN_API_KEY` lands in Vercel env vars.

4. **PASTE_RETAILERS demo prices** (lines ~1925) — hardcoded fake prices for retailer card taps without a URL. Likely confusing demo behaviour worth removing.

## What would be the right next moves (in order)

1. Buy `savvey.app` domain (£15/year, Namecheap or Porkbun).
2. Connect to Vercel, update `ALLOWED_ORIGIN` env var.
3. Apply to Awin Product Feed — needs live domain.
4. Apply to Amazon Associates — needs live domain.
5. Once Awin key is in Vercel, test data quality dramatically improves (structured UK retailer feed beats Serper Google Shopping aggregator).
6. Fix the Sony ULT WEAR mis-listing edge case.
7. Decide on UX for limited results (single-retailer state).

## Commit chain this session
- `8dfbd89` — v6.9 UX: kill price screen for search/trend/back, in-store-only price entry, honest empty-state copy, welcome→home routing

Builds on top of `d13b7eb` (1 May earlier session notes) and `048e3f3` (v6.8.1 frontend mapping fix).

## Operational note for future sessions
The disk-write reliability quirk hit again briefly mid-session — `git restore` resolved cleanly on Vincent's side once the session finished. Worth keeping the "trust but verify" pattern: every Edit, follow up with grep/node-check before pushing.
