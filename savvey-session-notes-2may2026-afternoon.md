# Savvey — Session notes, 2 May 2026 afternoon

In-store + couch test surfaced 12+ real bugs and one critical missing
feature. This session shipped Waves 29a, 29b, 29c, 29d, 30, 31, 32.
Service worker now `savvey-static-v59`.

---

## What Vincent reported (high level)

1. Counter shows £0.00 and never ticks
2. Counter MUST be shareable — key marketing/influencer hook
3. Loading screen "looks terrible no brand logos"
4. Search bar shows one product, body shows a totally different one
   (sticky-state contamination between searches)
5. £ hero card overflows the right edge of the screen
6. eBay-only results show "5/5 Best price" — misleading
7. Snap returns junk strings ("Cartera push bike £350 Ono - Facebook")
8. Popular Searches tiles missing labels
9. Scan UI state doesn't reset after detection
10. "What's the shelf price?" creates friction — should give a Save Score
    against the UK average without requiring shelf entry first
11. Halfords/Home Bargains/Lidl not pulling
12. iPhone 17 search broken (product not yet released)
13. Argos result link landed on a 404

---

## What shipped

### Wave 29a — sticky-state contamination + hero overflow
`globalReset()` now ALSO clears the results-screen refine-input,
hidden product label, hero wit text, and hides the hero image wrap.
`renderNoResults()` writes the current query into the refine-input
so the header and body always tell the same story. No more "iPhone
15 Pro" up top while body talks about "Cartera push bike".

Savings hero rebuilt with `width:100% + max-width:100% + box-sizing:
border-box + min-width:0 + overflow:hidden`. Reduced font sizes
(£ 32→28, num 56→48). It physically can't overflow now.

### Wave 29b — Discovery counter ticks (#1 ask)
`recordSaving()` fires on BOTH input modes:
- Validation (scan + shelf, paste + reference): saving = shelf − cheapest
- Discovery (search/snap, no shelf): saving = avgPrice − cheapest

`buildScenV3` returns `scoreBasis` ('shelf' | 'average' |
'single-retailer') and `savingVsAvg`. Both Validation and Discovery
produce a real saving the counter can tick. Single-retailer never
ticks (no comparison) and never claims 5/5.

### Wave 29c — Vision/barcode query cleaning
New helper `cleanLookupName()` strips:
- "- Facebook", "- PubChem", "- Patent", "- eBay UK", "- Reviews"
  source-suffix tags
- Pipe-separated metadata after the first `|`
- "£XX Ono" / "OBO" haggle markers
- "Re-furb" / "Refurbished" / "Used"
- Parenthetical clutter and brackets

Caps result at 8 words / 80 chars. Returns empty string for
all-digit / too-short results so we don't hand garbage to Perplexity.

Wired into:
- `onBarcodeDetected()` after the OFF/UPCitemdb/Serper barcode lookup
- `captureSnap()` after the Haiku Vision response
- `useScannedProduct()` before navigating to price entry

### Wave 29d — popular-search labels + scan state reset
`.trend-tile` got an explicit `height:108px` (was min-height:96px) so
labels can't be clipped at the bottom-nav padding boundary.

`goTo('scan')` resets all scanner UI on every entry: clears the
detected card, lockon glow, trouble panel, scannedBarcode,
scannedProductName, CTA. No more sticky product card from a
previous scan session.

### Wave 30 — SHAREABLE SAVINGS COUNTER (key marketing hook)
The £ counter on home is now a tap-to-share button.

Tap → share-overlay opens with a dedicated 640×820 canvas card:
- Big SAVVEY wordmark top (with amber Y)
- "SAVVEY SAVINGS FOUND" eyebrow
- Massive £ amount centred
- "spotted across N checks" subline
- Milestone-aware congratulatory line
  (different copy at £0, <£10, <£50, <£150, <£500, <£1500, £1500+)
- "Try it free — savvey.app" CTA panel

Channels: native Web Share (file + text), WhatsApp, Twitter, Copy,
Save Image. Falls through gracefully when Web Share isn't supported.

This is the influencer/word-of-mouth marketing tool Vincent flagged
as priority. Friends see "£127 saved across 14 checks" → tap the
URL → land in Savvey → install.

### Wave 31 — loading screen redesigned
Killed the wallpaper layout. Replaced with a tight centred
composition:
- SAVVEY wordmark top
- Big pulsing Savvey badge in the middle
- Product-name pill ("🔍 Sony WH-1000XM5") below the badge
- "Across the UK's biggest retailers" tagline
- 4×4 retailer brand-tile grid filling the lower half
- "UK retailer prices · live check" footer

Each retailer tile turns into the brand's CORPORATE COLOUR when lit
(Argos red, Currys purple, Halfords red, AO blue, John Lewis black
etc). Settles into a tinted "done" state with a ✓.

Replaced Cult Beauty + Waterstones with Halfords + eBay since
Vincent flagged Halfords as a needed retailer.

### Wave 32 — Discovery Save Score against UK average
Both Validation AND Discovery now produce a Savvey Score. Pips show
in both modes (when ≥2 retailers found). Verdict copy adapts:
- Validation: "Walk away.", "Pretty good.", "Best price." etc
- Discovery: "£X below the UK average across N retailers."
- Single retailer: "Only one retailer found" (pips muted)

The hero "saving number" reads:
- Validation: "£X cheaper elsewhere"
- Discovery: "£X below the UK average"
- Single retailer: "only result found"

---

## What's NOT fixed yet (parked)

1. **Halfords/Home Bargains/Lidl real data coverage.** Halfords IS in the
   retailer list and has a URL admission pattern — should appear when
   Perplexity surfaces it. If it still doesn't show, the pattern may
   need widening or a Halfords-specific Perplexity hint added. Home
   Bargains + Lidl aren't in the retailer list at all — adding them
   means changes to `_shared.js` + URL patterns + per-retailer
   handling.

2. **iPhone 17 (or any not-yet-released product).** Perplexity returns
   iPhone 16 listings as fallback when iPhone 17 doesn't exist, and
   the user sees those with "iPhone 17" in the search bar. Wave 29a's
   refine-input fix means the body and header now match, but the
   underlying mismatch (results don't match what user typed) remains.
   Fix would require AI-side query validation — Haiku could flag
   "this looks like a not-yet-released model" and we'd show a
   different empty state.

3. **Skip-shelf-price friction.** Vincent wants:
   "scan → seconds later, Save Score against avg. THEN optional shelf
    price entry for sharper signal."
   Today the price-entry screen still appears between scan and
   results. Could collapse: scan → loading + results immediately
   (Discovery mode), with a "Add shelf price for sharper score" pill
   on the results screen that, when tapped, reveals the price field.
   Bigger refactor — parked for next session.

4. **Argos URL 404 (IMG_1630).** Argos buy-link occasionally lands on
   a 404. Per-retailer URL admission is in place. If it persists,
   the fix is to fall back to retailer search URL on click rather
   than the Perplexity-returned URL.

---

## Push command

```
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git add .
git commit -m "Wave 29-32: tap-to-share counter, Discovery savings, sticky-state kill, loading redesign (SW v59)"
git push origin master
```

Vercel auto-deploys ~30 seconds after push. Hard-reload twice on the
test phone (first reload swaps SW, second pulls fresh shell).

---

## Files in deploy folder

```
files for live\
+-- index.html      <- Wave 29-32 + earlier waves
+-- sw.js           <- v59
+-- vercel.json
+-- manifest.json
+-- CLAUDE.md
+-- savvey-debrief-1may2026.md
+-- savvey-session-notes-1may-final.md
+-- savvey-session-notes-1may-ux.md
+-- savvey-session-notes-1may-strategy.md
+-- savvey-session-notes-2may2026-morning.md
+-- savvey-session-notes-2may2026-afternoon.md   <- THIS FILE
+-- api\
    +-- search.js
    +-- scrape.js
    +-- ai-search.js   v1.8 (no changes this session)
    +-- ai-vision.js
    +-- ai-wit.js
+-- _shared.js
```

---

# Second pass (same afternoon, Waves 33-36, SW v60)

Vincent reviewed the first pass and asked for another 30-60 min of
silent work — design still flawed, "Couldn't reach the price data"
still constant, shelf-price still creating friction, "rename to save
score" not done.

## What shipped in this pass

### Wave 33 — scan goes straight to results
`useScannedProduct()` skips the price-entry screen entirely. Scan →
loading → results in Discovery mode. Save Score against the UK
average appears within seconds.

A new pill on the results screen — "Got the shelf price? Add it for
a sharper Save Score" — lets users opt INTO Validation mode. Tapping
reveals an inline £ input. Submitting re-runs the search with the
entered price as the user's reference. So in-store users keep the
optionality without paying the friction up front.

The `#screen-price` is preserved but no longer reachable from scan.

### Wave 34 — empty state isn't an error any more
Old empty-state copy read like a broken app: "We had trouble pulling
fresh prices for X. This is a data-source hiccup..." Vincent saw it
constantly during testing.

New empty state:
- Title: "Let's check directly."
- Body: "We couldn't pull a fresh comparison for {query} — but here
  are direct retailer searches you can tap."
- 2-column grid of brand-coloured retailer chips (Amazon, Argos, JL,
  Currys, eBay, Halfords). Each links to that retailer's own search
  with the user's query.
- Tip: "Try a simpler name (just brand + model). Avoid SKU codes,
  sizes, or refurbished suffixes."
- Try-again + Search-something-else buttons preserved.

The user always has a path forward. Confidence in the app preserved
even when our pipeline came up empty.

### Wave 35 — "Savvey Score" → "Save Score"
Updated user-visible copy in:
- Hero verdict label (markup + JS)
- Empty-state label
- Price screen heading
- Signal label
- Demo shareMsg
- Web Share titles
- Canvas share-card heading

CSS class names (.signal, .signal-lbl, .hero-verdict-label) kept the
same — internal implementation detail.

### Wave 36 — design polish: brand-coloured retailer rails
Every retailer row in the results list now has a 3px brand-coloured
left rail (Amazon orange, Argos red, JL black, Currys purple, AO
blue, eBay red, Halfords red, etc). Painted via CSS `::before` driven
by a `data-brand` attribute on each row.

Instant retailer recognition without needing actual logo SVGs (which
would be a trademark/asset problem).

Tighter typography rhythm: row names bumped to weight 800, sub-text
spacing tightened, badge made uppercase + weight 800, price
letter-spacing tightened.

Best-price row keeps its full green-tint card highlight on top of
the green-coloured rail.

## Service worker now v60

## Still parked
1. Halfords/Home Bargains/Lidl real coverage — empirical fix only
2. iPhone 17 (and any future product) — AI-side query validation needed
3. Argos 404 — fall back to retailer search URL on click
4. Result hero density — could trim further if Vincent wants

## Push for Waves 33-36

```
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git add .
git commit -m "Wave 33-36: scan→results direct, action empty state, Save Score rename, brand rails (SW v60)"
git push origin master
```

---

# Third pass (same day, evening — Waves 37-41, SW v61)

Vincent's third feedback round: promote Snap, support QR, frame
fuzzy Snap matches as "similar products", add Home Bargains + Lidl,
detect future products like iPhone 17, fix Argos 404.

## What shipped

### Wave 37 — Snap is the primary input now
Bottom nav: **Home, Snap, Scan, Paste**. Home action tiles:
**Snap (AI-tagged), Search, Scan, Paste**. SWIPE_ROTATION:
`[paste, home, snap, scan]`. Snap gets the natural one-swipe-right
slot from home and is visually marked as the AI-first power move.

Scanner now reads QR codes too:
- Native `BarcodeDetector`: added `qr_code` to format list.
- ZXing fallback: added `F.QR_CODE`.
- Routing: QR with URL → paste pipeline. QR with numeric code →
  barcode lookup. QR with text → search query.
- Hint copy: "Point at any barcode or QR code".

### Wave 38 — Snap "similar products" framing
When Vision returns a low/medium-confidence ID (not a specific
model), the result screen makes the fuzzy nature explicit:
- Amber "Generic match" banner at top of hero card
- Wit/save copy reframed: "below similar products" instead of
  "below the UK average"
- Where line: "similar UK products across N retailers: £X" instead
  of "Average across..."

The Save Score still computes against the search-result average,
but the user knows we're comparing against the category, not the
exact item.

### Wave 39 — Home Bargains, Lidl, Aldi, Wilko, Poundland, The Works
Added to the retailer pool (`_shared.js`) plus URL admission
patterns in `ai-search.js`. Patterns are intentionally loose since
discount-store URL conventions are flaky.

Halfords URL pattern widened from `\d{6,}\.html` requirement to
`\d{5,}(\.html)?(?:[/?]|$)` — accepts 5-digit IDs, optional
`.html`, optional trailing slash/query. Cycling/automotive
products should now surface.

`retailerSearchUrl()` got entries for all new retailers plus
several grocery/DIY/books/beauty entries that were missing.

### Wave 40 — future-product detection
`detectFutureProduct()` regex-matches queries like:
- iPhone 17+ (current is 16)
- Galaxy S26+ (current is S25)
- Pixel 11+ (current is 10)
- PS6 / PlayStation 6
- Xbox Series Z
- MacBook M5+ (current is M4)
- Apple Watch Series 11+

When triggered on the empty state, the title becomes "iPhone 17 may
not be out yet." plus a tappable "closest comparable: iPhone 16 Pro
256GB" suggestion that re-runs the search.

### Wave 41 — Argos 404 fallback (and other volatile retailers)
New `PREFER_SEARCH_URL` regex covering Argos, AO, Currys, Wickes,
Toolstation, Home Bargains, Lidl, Aldi, The Works, Wilko,
Poundland. Both `openRetailerRow()` and `bestBuyUrl()` now route
through `retailerSearchUrl()` for these retailers — bypasses
potentially stale Perplexity URLs. Users land on the retailer's own
search results page where the canonical product is one tap away.

## SW now v61

## Push for Waves 37-41

```
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git add .
git commit -m "Wave 37-41: Snap-first + QR + similar-products framing + Home Bargains/Lidl + future-product detection + Argos 404 fix (SW v61)"
git push origin master
```

---

# Fourth pass (Waves 42-47, SW v62)

Vincent's instruction: "spend more time and care...work silently for a
while". Loading screen rebuilt from scratch, hero tightened, Snap
promoted on the welcome screen.

## Wave 42 — Loading screen V2 (the big one)
Killed the static brand tile grid. New layout:

1. **Circular progress ring around the Savvey badge** — SVG with
   animated stroke-dasharray fill that completes over ~3.6s. Amber
   stroke + soft drop-shadow glow. The badge breathes inside the ring.
   Ring re-fires its animation on every new search via reflow toggle.

2. **Animated retailer counter** — "Checking [N] / 16 UK retailers"
   below the ring. N ticks up live as each retailer's pill enters
   `.done` state. Amber pulsing dot signals active.

3. **Horizontal marquee of brand pills** — auto-scrolls 28s linear
   infinite. Two duplicated pill sets for seamless loop. Mask-image
   fades both edges. Each pill turns into the retailer's CORPORATE
   COLOUR when `.lit` and into a tinted "done" state with ✓.

## Wave 44 — hero density
- `.hero-num` font 52→44, letter-spacing tightened
- `.hero-lbl` size 13→11, weight bumped, uppercase letter-spacing
  increased for label rhythm
- `.hero-wit` padding/margin tightened
- `.hero-where` size 14→13.5, margins tightened
- Body padding 20→18

Hero card reads tighter and more premium without losing any content.

## Wave 47 — welcome Snap promotion
First-impression CTA on welcome is now:
- Title: "Snap any product"
- Sub: "AI identifies it · we check UK retailers"
- Routes to Snap mode

Reflects Wave 37's Snap-first reorganisation in the first thing new
users see.

## SW now v62

## Push for Waves 42-47

```
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git add .
git commit -m "Wave 42-47: loading screen V2 (ring + counter + marquee) + hero density + Snap on welcome (SW v62)"
git push origin master
```

## OR push the entire afternoon as one commit

```
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git add .
git commit -m "Wave 29-47: counter share + Discovery savings + Save Score + sticky-state kill + scan-direct + empty-state shortcuts + brand rails + Snap-first + QR + similar-products framing + retailer pool expansion + future-product detection + Argos fix + loading screen V2 + hero density + welcome Snap CTA (SW v62)"
git push origin master
```

End of session notes.
