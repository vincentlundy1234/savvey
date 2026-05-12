# SAVVEY — V.135 STATE & HANDOFF
*Session close: 11 May 2026. V.135 ships the routing recovery + loading layout fix + FSM teardown wiring after V.134's safe rollback.*

The Brain (backend) remains frozen at V.121. The Face (frontend) is at
V.135 — V.134's safe loading rollback retained, V.135 added the
routing defence + FSM teardown + loading card layout fix.

Next Claude: read this BEFORE touching anything. The "iOS Safari Burn
Book" in §2 lists 8 hard constraints learned at iPhone-iteration cost.

---

## 1. CURRENT ARCHITECTURE

### 1.1 Backend — `api/normalize.js`

**Status: FROZEN since V.121. Do not modify without explicit Panel
authorization to lift the freeze.**

- Version constant:   `'normalize.js v3.4.5v121'`
- Cache prefix:       `sav-v121-1` / `savvey:normalize:v3_121` / `savvey:canonical:v121`
- Architecture:
  - **Door 1** (image) — Haiku Vision → SerpAPI picker
  - **Door 2** (URL)   — Haiku URL parser → SerpAPI picker
  - **Door 3** (text)  — Haiku query normaliser → SerpAPI picker
  - **Door 4** (EAN)   — Haiku barcode lookup → SerpAPI picker
- **`callHaikuListingPicker` is authoritative**:
  - Evaluates top-5 SerpAPI Amazon UK candidates
  - Returns matched index OR null (rejects all)
  - V.96 lexical soft-match path was deleted in V.121
  - Null → honest null verified_amazon_price + V.111 amazon_search_fallback URL
  - 0% hallucinated prices, 100% safe routing on Crucible tests
- **`debug_trace`** array attached to every /api/normalize response —
  surfaces serpapi.fetch / picker.candidates_built / picker.picked /
  picker.rejected_all / soft_match steps. Used during V.121 diagnostics.
- SerpAPI timeout: 4000ms (V.121, was 2000ms)
- Picker max_tokens: 250 (V.121, was 120)
- Haiku canonical-string preservation rule active (V.120a): preserves
  multi-pack quantities, weights, colourways, condition modifiers.

### 1.2 Frontend — `index.html` (V.135)

#### Camera FSM (`window.__camFsm`)
States: IDLE → PERMISSION_PENDING → INITIALIZING → ACTIVE
        → CAPTURING → TEARING_DOWN → RELEASED → IDLE
- Allowed-transition table enforced
- `_hardRelease()` does the 7-step iOS-specific teardown:
    stop tracks → video.srcObject=null → removeAttribute('src')
    → video.load() → detach FSM listeners → hide overlays → null refs
- Global visibilitychange / pagehide / beforeunload listeners auto-fire
  teardown so iOS green-dot can't persist
- **V.135 — captureFrame now routes teardown through stopAllScanners()
  (which calls FSM._teardownInternal) instead of stopping tracks
  directly. Banner used to show FSM=CAPTURING during loading; now
  transitions CAPTURING → TEARING_DOWN → IDLE before callNormalize.**

#### Pinch (V.128 strict geometric protocol)
- Top-level IIFE owns its own state (initialDistance, initialScale)
- Listeners on `#screen-camera` with `{ passive: false }`
- `e.preventDefault()` when `e.touches.length === 2`
- `touch-action: none` on #screen-camera + #cam-zoom-layer + #cam-video
- Math: newScale = initialScale * (currentDist / initialDist), clamp 1.0–3.0
- Writes `--sav-cam-zoom` via `window._v128SetZoom` (drives CSS + HW zoom)
- `window._v128OnPinchEnd(finalScale)` snaps HW zoom + hides indicator

#### Canvas crop (V.129 geometry + V.130 robustness + V.131 audit)
- `_v129CropToBrackets(video)` is the primary capture path
- Bracket dimensions via `getComputedStyle(.v5-cam-cutout).width/height`
  (LAYOUT box, immune to transforms / display:none) — falls back to
  hardcoded 240×280 constants
- object-fit:cover visible source rect from videoRatio vs elementRatio
- Maps bracket CSS coords → intrinsic video pixels via cover-scale
- Divides by `--sav-cam-zoom` to simulate tighter framing
- DPR-aware canvas: `width = targetW * dpr`, `ctx.scale(dpr, dpr)`,
  destination in CSS pixels — NOT double-scaled
- Preserves bracket aspect (portrait → portrait canvas)

#### Loading State (V.134 safe rollback + V.135 layout fix)
- **No frosted glass, no video.pause(), no bracket-hole technique.**
  All three failed on iOS Safari memory path in V.122-V.133.
- `showV104Tension` / `hideV104Tension` are NO-OPS (kept for back-compat)
- Flow: shutter → captureFrame (3 frames over ~240ms) →
  stopAllScanners (now FSM-routed) → callNormalize → show('loading')
- **`#screen-loading` styling (V.135):**
  - White card (#FFFFFF, #1C1C1E dark mode)
  - 16px border-radius
  - Diffused shadow `0 10px 25px -5px rgba(0,0,0,.10), 0 8px 10px -6px rgba(0,0,0,.10)`
  - max-width 440px, padding 28px 20px 24px (V.135 wider than V.134's 380px)
  - `display: flex; flex-direction: column; align-items: center; gap: 18px`
  - iOS-native circular spinner (`.v134-loading-spinner`) at top:
    36px ring, green top-arc, 0.9s rotate
  - V.77 phase timeline below (4 nodes, max-width 360px)
  - Narration text in 600-weight system-ui sans
  - Footer text in 12px ink-mute

#### Result + Confirm Routing (V.135 defence)
- Defensive CSS block at end of `<style>` guarantees `.active` screens
  render:
    `body #screen-result.active, body #screen-confirm.active,
     body #screen-error.active { display: block !important;
     visibility: visible !important; opacity: 1 !important }`
- Also covers `body.v132-loading` and `body.v129-tensing` parent
  selectors — catches the case where a stale cached PWA shell still
  has those classes on body from a V.132/V.133 session.

#### Barcode Scanner (V.130 + V.131 + V.133)
- Pure CSS cutout (`.v123-bc-cutout`):
  - 80% wide, 150px tall, 16px radius
  - `box-shadow: 0 0 0 4000px rgba(0,0,0,0.85)` opaque surround
  - z-index: 50 (above html5-qrcode overlay)
  - `overflow: hidden` — laser stays inside
- Library suppression CSS (V.133):
  - `#qr-shaded-region { display: none !important }`
  - `#barcode-reader > *` strips inline borders/backgrounds
  - `#barcode-reader video` forced display:block + 100% + object-fit:cover
  - DOES NOT use the blanket `#barcode-reader div { display: none }`
    that killed the video wrapper in V.132 (friendly fire)

#### Visual Design (V.122 + V.125 brute-force)
- Radii / shadows HARDCODED `!important` on real selectors in the
  final `<style>` block ("V.125 BRUTE FORCE"). No CSS-variable
  lookups for critical visuals.
- body bg `#F2F2F7` (light) / `#000000` (dark)
- Cards (.v5-door, .v5-savvey-says, .v5-confirm-card, .recent-chip,
  .cta:not(.primary)):
    bg #FFFFFF (#1C1C1E dark)
    border-radius: 16px
    box-shadow: panel-mandated diffused pair
- Primary CTA pill (.cta.primary): border-radius 24px + green-tinted shadow
- Inputs: 12px radius, #E5E5EA border, 17px font (iOS HIG body, prevents auto-zoom)

#### On-Screen Debug Banner (V.126, still live)
- Red banner at z-index 99999 at top of body
- Updates every 2s + on every shutter press
- Lines: footer version · DPR · timestamp · door radius/bg/shadow ·
  savvey says · body bg · FSM state · SW controller · pinch state ·
  crop dimensions (bracket CSS, capture src, aspect check)
- × close button to dismiss
- One-shot cache-nuker IIFE: detects stale `savvey-static-*` caches,
  deletes them + unregisters SWs + force-reloads (sessionStorage-guarded)

### 1.3 Service Worker — `sw.js`

- `STATIC_VER = 'savvey-static-v345v135'`
- Activate handler:
  - Purges every cache not in `KEEP = [STATIC_VER, FONT_VER]`
  - Explicitly deletes `/` and `/index.html` from new cache
  - `self.clients.claim()` takes over uncontrolled PWAs
  - Posts `SW_UPDATED { version, purged_count, purged_keys, ts }`
- Fetch: navigate network-first; static cache-first; /api/* never cached

### 1.4 Deploy Workflow

- Edit files in `C:\Users\vince\OneDrive\Desktop\files for live\`
  (index.html, api/normalize.js, sw.js, vercel.json, manifest.json,
  privacy.html, terms.html)
- Write commit message to `.commit-msg.txt` in the same folder
- PowerShell watcher at `C:\Users\vince\OneDrive\Desktop\auto-push-savvey.ps1`
  detects the marker, runs:
    `git add -A && git commit -F .commit-msg.txt && git push origin master`
  deletes the marker after push
- Vercel auto-deploys, ~30s to READY
- Manual fallback (if watcher dead):
    `cd "C:\Users\vince\OneDrive\Desktop\files for live"`
    `git add . ; git commit -m "msg" ; git push origin master`
  (Never plain `git push` — it silently fails)

---

## 2. iOS SAFARI BURN BOOK — HARD CONSTRAINTS

Each item below cost a real iPhone iteration to discover. **Do not
repeat these mistakes.**

### 2.1 DO NOT use CSS variables for critical radii / shadows.

V.122 / V.122a / V.122b / V.124 / V.125 defined design tokens
(`--sav-radius-card`, `--sav-shadow-elev-card`) and relied on cascade
resolution. Chrome MCP showed the tokens resolving correctly; iPhone
PWA crushed the cascade or dropped them from the parsed-stylesheet
cache. Visuals never landed until V.125 brute-forced hardcoded values
with `!important` directly on `.v5-door`, `.v5-savvey-says`,
`.cta.primary`, input selectors.

**Rule**: any visible token MUST have a hardcoded `!important`
declaration on the real selector in the final `<style>` block.

### 2.2 DO NOT use `<svg>` for camera/barcode overlays.

V.106 used SVG with `viewBox="0 0 100 100"` + `preserveAspectRatio="none"`
for the barcode mask. Misaligned on every dvh swing (iOS URL bar
show/hide) because the SVG element was `width: 100%` and the cutout
was `%` within `viewBox` — two layers of relative units that drift.

**Rule**: barcode scanner UI is a single `.v123-bc-cutout` div with
`box-shadow: 0 0 0 4000px rgba(0,0,0,0.85)` for dark surround +
`overflow: hidden` for the laser. Aspect cannot drift — one element,
known dimensions.

### 2.3 DO NOT call `video.pause()` to freeze a frame.

V.132 / V.133 paused the live video and overlaid frosted glass with
a transparent bracket-hole to show the framed product. On a physical
iPhone the paused video rendered **solid black**. Root cause: iOS
Safari's memory-pressure path drops the last-rendered frame buffer
when video is paused.

**Rule**: when shutter is pressed, run `stopAllScanners()` to tear
down hardware immediately AFTER the canvas is built. Route UI to
`#screen-loading` (standard white card). Never keep a paused video
frame visible.

### 2.4 DO NOT use CSS pixels as if they were intrinsic video pixels.

V.123 / V.125 / V.128 / V.129 stumbled over cover-scale + DPR math:
- `getBoundingClientRect()` returns CSS pixels and VISUAL rect, which
  collapses to 0 if any ancestor is mid-transition — V.130 caught
  this on iPhone (`bracket CSS: 1×1`).
- `getComputedStyle().width` returns LAYOUT box, stable through
  transforms / display:none — use this for bracket dimensions.
- `video.videoWidth/Height` are intrinsic media pixels, DPR-independent.
- With `object-fit: cover`, visible source rect maps to full element
  CSS box: `intX = visX + (cssX / elementW) * visW`.
- `--sav-cam-zoom` shrinks captured region by 1/N (centered).
- Canvas backing: `canvas.width = targetW * dpr`, `ctx.scale(dpr, dpr)`,
  drawImage destination in CSS pixels → fills backing exactly. NO
  double-scale.

**Rule**: `_v129CropToBrackets` is authoritative. Do not "simplify"
without reading its 14-line comment block.

### 2.5 DO NOT trust Chrome MCP for iOS rendering confirmation.

Headless desktop Chrome rendered V.122–V.125 tokens correctly. The
iPhone home-screen PWA didn't. Calling probes "verified live" shipped
4 waves the founder couldn't see. The on-screen debug banner
(`#v126-debug`) is the only reliable visual verifier on real iOS.

**Rule**: any wave that changes visible CSS / camera rendering must
be screenshot-confirmed from the founder's iPhone PWA. Chrome MCP
probes are useful for JS state + computed values but NOT for visual
verification.

### 2.6 DO NOT use blanket `#barcode-reader div { display: none !important }`.

The html5-qrcode library wraps its `<video>` in a parent div. The
blanket rule killed the wrapper → black screen (V.132 friendly fire).

**Rule**: target only `#qr-shaded-region` for display:none. Strip
borders/backgrounds on `#barcode-reader > *` without hiding them.
Use `.v123-bc-cutout` z-index 50 + 0.85-opacity surround to
physically cover any other rogue UI.

### 2.7 DO NOT skip `touch-action: none` + `{passive: false}` pair.

V.122b set `touch-action: none` but kept `{passive: true}` listeners.
iOS Safari still claimed the multi-touch gesture as system zoom.
Both gates required.

**Rule**: `touch-action: none` CSS + `{passive: false}` listener +
explicit `e.preventDefault()` when `e.touches.length === 2`.

### 2.8 DO NOT bypass the FSM teardown on capture.

V.134 captureFrame called `camStream.getTracks().forEach(stop)` directly,
bypassing `__camFsm._teardownInternal()`. Debug banner caught FSM stuck
in CAPTURING during loading screen. V.135 fixed by routing through
`stopAllScanners()`.

**Rule**: when capture completes, call `stopAllScanners()` (which
goes through FSM teardown) — never `camStream.getTracks().forEach(stop)`
directly.

---

## 3. NEXT SESSION PRIORITIES

**The Brain is stable.** Backend frozen at V.121. 0% hallucination,
100% safe routing on the V.121 Crucible test (9 honest nulls, 6
verified prices, no decoy serving).

**The Face is stable at V.135.** Camera screen + barcode screen +
loading screen + result/confirm routing all visually-confirmed via
on-screen banner. iPhone PWA rendering pipeline is solid.

### Likely next-session focus: 10-PRODUCT CRUCIBLE TEST

The Panel has signalled this is the V.136 priority. Recommended approach:

1. **Generate a fresh Panel-approved 10-product list** with the same
   discipline as V.120's Crucible-15:
   - Mix of UK retailer-own brands (M&S, Waitrose, Aldi)
   - Variant trappable products (PS5 Slim/Pro, iPhone 15/Plus/Pro)
   - High-confidence brand+MPN (Sage BES876, Wahl 9649-017)
   - Low-confidence category nouns (kettle, dishwasher)
   - Edge multipack/refill products (Pukka 6-pack, replacement filters)

2. **Run the test via the user-facing app** (snap or text query),
   not the API directly — that's been the gap. We've tested the
   pipeline output via curl-style probes, but never validated that
   the full user journey (snap → result screen → CTA) lands correctly.

3. **Use the V.126 debug banner** to capture per-product:
   - bracket CSS, capture src, aspect check (snap door)
   - FSM transitions (CAPTURING → IDLE)
   - Resulting verdict + price + retailer

4. **Check the verdict pill rendering** on the result screen — the
   Phase A polish was applied but not visually audited on real device.

### Other deferred items

- **Result-screen UI polish** — Phase A baseline is applied but not
  visually verified at device resolution. Verdict pill micro-typography,
  retailer row spacing, price/verdict size ratio all unaudited.

- **debug_trace cleanup** — once founder is confident production is
  stable, gate the `debug_trace` field in /api/normalize response on
  `?debug=1` query param to reduce happy-path payload size.

- **Red debug banner removal** — V.126 on-screen debugger is temporary.
  Vincent will signal when it can come down.

- **Frosted glass revival (if Panel ever wants it)** — only safe
  approach on iOS is to NOT pause video. Render loading card OVER the
  still-playing live video (video stays alive → no memory-pressure
  black-out). Alternatively: snapshot a freeze-frame to a `<canvas>`
  element (not `<img>`) and render that. Both unverified.

### Specific code to PRESERVE (do not "simplify")

- `_v129CropToBrackets` — bracket-bounded canvas math (V.129)
- `window._v128SetZoom` / `window._v128OnPinchEnd` bridges (V.128)
- The `body.v132-loading` / `body.v129-tensing` defensive scrub in
  hideV104Tension (V.134 — no-op now, but catches stale-cache state)
- `.v123-bc-cutout` z-index 50 + box-shadow 0.85 alpha (V.133)
- V.135 routing-defence CSS block (the `body #screen-result.active`
  override at end of `<style>`)
- captureFrame teardown via `stopAllScanners()` (V.135)

**If touching camera or capture logic: screenshot-verify on Vincent's
iPhone PWA BEFORE marking any task complete.**

---

*Saved by Claude (V.135 session) — 11 May 2026, ~23:10 UTC*
*Vincent: vincentlundy@outlook.com · GitHub: vincentlundy1234/savvey · Vercel: savvey.vercel.app*
*Footer label on live: Beta · v3.4.5v135 · SW cache: savvey-static-v345v135*
