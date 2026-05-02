# Savvey — Session notes, 2 May 2026 morning

Last commits pushed by Vincent before pause.
Service worker now `savvey-static-v57`.
Three waves landed this session: 28c, 28d, 28e. All live.

---

## What shipped

### Wave 28c — savings hero count-up reliability
Earlier 28b animation could leave the number stuck at "0" on phones where
`requestAnimationFrame` got throttled. `renderSavingsHero()` now sets the
final value synchronously first, then plays count-up as polish. A 1.5s
setTimeout safety net forces the final value if rAF never fires.

### Wave 28d — always-on £0.00 hero + scan/snap footer un-blocked
Three things:

**Hero is visible from first launch.** The Wave 28b version hid the hero at
zero savings and showed a welcome card instead. Vincent's call: show the
ticker from the get-go so users see it grow ("I saved £X — better return
to Savvey" retention loop, Revolut-balance pattern). Default markup now
reads "£0.00" with the soft prompt "your savings tick up here as you check
prices". Counter ticks every Validation-mode check that finds something
cheaper. The legacy welcome card markup is hidden in DOM but kept for
back-compat.

**Scan footer no longer obscured by the bottom nav.** `.cam-foot`
padding-bottom bumped from 36px to 96px so "Point at any barcode" + the
"No barcode? Snap a photo" / "Search by name" helper buttons clear the
floating liquid-glass nav.

**Snap shutter no longer obscured by the bottom nav.** `.snap-capture-btn`
lifted from `bottom:40px` to `bottom:110px`. `.snap-hint` lifted in
lockstep to `bottom:210px`. Same root cause as the cam-foot — the
floating nav sits at `bottom:12+safe-area + 58px tall` and was clipping
content too close to the screen edge.

### Wave 28e — M&S-style scanner cutout
Visual differentiator between Scan and Snap. Per Vincent's M&S
reference photo:

- `.vf` (the 280x180 scan rectangle) gets `box-shadow:0 0 0 9999px
  rgba(0,0,0,0.55)` — paints darkness everywhere except inside the
  rectangle. No clip-path or SVG mask needed = bulletproof browser
  support.
- Re-enabled the four `.vf-c` corner brackets (22px arms, 3px white
  stroke, 6px radius) at each corner. These were `display:none` legacy
  from Wave 23.
- Green `.vf-lock` glow still fires inside the same rectangle on
  detection.

Net effect: Scan reads as a true framed barcode lens (M&S, Co-op,
Sainsbury's pattern). Snap stays whole-frame with shutter — strong
visual differentiation between the two camera modes.

---

## Service worker

Bumped from v55 to v57 across the three waves. On phones, Vincent should
hard-reload twice on the test device — first reload swaps the SW, second
reload pulls fresh shell.

---

## What Vincent is testing this afternoon

- **Scan flow** on a real product barcode: cutout visible and well-framed,
  ZXing/native locks on, price-entry takes the shelf price, the
  Validation-mode result ticks the savings counter on the home screen.
- **Snap flow** on a packaged product: Haiku 4.5 Vision identifies it,
  result renders.
- **Home**: `£0.00` hero visible from first launch and ticks up after the
  first cheaper-than-shelf check.

---

## Likely things that come back from testing — and how to address each

**"The counter doesn't tick when I scan something."**
By design, `recordSaving()` only fires when:
1. `sc.spc !== 'green'` — Savvey found cheaper
2. `sc.saving > 0`
3. We're in Validation mode (a reference price was given)

If a Discovery-mode search (no shelf price) doesn't tick the counter
that's correct behaviour, but if it confuses Vincent we may want a
secondary "checks done" counter shown below the £ amount.

**"The cutout is too dark / too light."**
Tweak the alpha on `.vf` `box-shadow:0 0 0 9999px rgba(0,0,0,0.55);`.
0.55 is the M&S-equivalent. Drop to 0.40 for lighter, push to 0.70 for
darker.

**"The cutout rectangle doesn't fit my barcode."**
Currently 280x180, ~1.55:1 ratio — sized for EAN-13/UPC-A on standard
consumer packaging. If products feel cramped, widen to 300x160 or
320x170. `.vf{width:280px;height:180px;...}`.

**"ZXing decode is slow."**
Wave 12 already set TRY_HARDER + locked to four UK retail formats. Next
lever is upgrading from CDN-loaded ZXing to a paid SDK (Dynamsoft,
Scandit). Only worth it if real users complain — cost/value gate.

**"Native BarcodeDetector unavailable on my phone."**
That's fine — `loadScannerEngine()` falls through to ZXing. 6s import
timeout. If ZXing CDN itself is blocked on Vincent's network, the
"Scanner failed to load" surface is the right error.

**"Snap identified the wrong product."**
Haiku 4.5 vision has an accuracy ceiling on small/dim/partial
photographs. The downscale-to-1024px-long-edge code path is in
`captureSnap()`. Could test a higher resolution (1536px) — bigger
payload, bigger token cost (~£0.008 vs £0.005), maybe better accuracy.

---

## Local task list state at session pause

- #53 Wave 28c: completed
- #54 Wave 28d: completed
- #55 Wave 28e: completed
- No in-progress tasks

---

## Next session priority order

1. Address any scan/snap real-world failures Vincent reports
2. If counter behaves correctly: prep the 5-friend phone test pack
3. Check Amazon Associates application status — if approved, set
   `AMAZON_ASSOCIATE_TAG` env var in Vercel (already defaults to
   `savvey-21`, so this is informational unless registering a different
   tag)
4. Domain purchase: `savvey.app` (~£15/yr Namecheap) — buy
   protectively
5. Trademark: £200 UK lawyer consult before public launch (ShopSavvy
   US exists; SAVVEY SAVERS NETWORK LIMITED at UK Companies House)
6. Secrets rotation: SERPER_KEY + Supabase anon key were in chat
   earlier — rotate before any public press / Reddit launch

---

## Files in deploy folder (`C:\Users\vince\OneDrive\Desktop\files for live\`)

```
files for live\
+-- index.html      <- full frontend, all screens, all JS
+-- sw.js           <- service worker v57
+-- vercel.json     <- 256MB memory, 15s timeout (do not touch)
+-- manifest.json   <- PWA manifest (do not touch)
+-- CLAUDE.md       <- Cowork brief
+-- savvey-debrief-1may2026.md          <- comprehensive Phase 1 debrief
+-- savvey-session-notes-1may-final.md  <- engineering pass
+-- savvey-session-notes-1may-ux.md     <- UX pass
+-- savvey-session-notes-1may-strategy.md  <- strategy + architecture
+-- savvey-session-notes-2may2026-morning.md  <- THIS FILE
+-- api\
    +-- search.js     <- price search proxy v6.3
    +-- scrape.js     <- direct URL scraper v1.0
    +-- ai-search.js  <- Perplexity + Haiku v1.8
    +-- ai-vision.js  <- Haiku 4.5 vision
    +-- ai-wit.js     <- Haiku 4.5 wit lines
```

---

End of session notes.
