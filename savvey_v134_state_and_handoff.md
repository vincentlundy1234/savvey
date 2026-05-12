# SAVVEY — V.134 STATE & HANDOFF
*Session close: 11 May 2026. Founder confirmed V.134 stable on physical iPhone PWA.*

The "Brain" (backend) and the "Face" (frontend rendering) are both
in a known-good state. Next Claude: read this file BEFORE touching
anything. The "iOS Safari Burn Book" in Section 2 is the most
important part — it catalogues mistakes that already cost us 13
deploy iterations (V.122 → V.134).

---

## 1. CURRENT ARCHITECTURE

### 1.1 Backend — `api/normalize.js`

**Status: FROZEN since V.121. Do not modify without explicit Panel
authorization to lift the freeze.**

- Version constant:   `'normalize.js v3.4.5v121'`
- Cache prefix:       `sav-v121-1` / `savvey:normalize:v3_121` / `savvey:canonical:v121`
- Architecture:
  - **Door 1** (image) — Haiku Vision identifies product → SerpAPI picker
  - **Door 2** (URL)   — Haiku URL parser → SerpAPI picker
  - **Door 3** (text)  — Haiku query normaliser → SerpAPI picker
  - **Door 4** (EAN)   — Haiku barcode lookup → SerpAPI picker
- **The picker is AUTHORITATIVE** (V.121 Engine Purge):
  - `callHaikuListingPicker` evaluates top-5 SerpAPI Amazon UK candidates
  - Returns matched index OR null (reject all)
  - V.96 lexical soft-match path was deleted — picker null means honest
    null + V.111 `amazon_search_fallback` URL goes to the client
  - Result: 0% hallucinated prices, 100% safe routing on Crucible tests
- **debug_trace** is in the response payload — pipeline events every
  serpapi.fetch / picker.candidates_built / picker.picked / picker.rejected_all
  step. Used during V.121 diagnostics.
- SerpAPI timeout: 4000ms (V.121 bumped from 2000ms)
- Picker max_tokens: 250 (V.121 bumped from 120 — V.120a parse-error fix)
- Haiku canonical-string preservation rule active (V.120a): preserves
  multi-pack quantities, weights, colourways, condition modifiers.

### 1.2 Frontend — `index.html` (V.134)

#### Camera (Door 1, Door 3)
- **FSM** (V.122, `window.__camFsm`):
  - States: IDLE → PERMISSION_PENDING → INITIALIZING → ACTIVE
            → CAPTURING → TEARING_DOWN → RELEASED → IDLE
  - Allowed-transition table enforced
  - `_hardRelease()` does the 7-step iOS-specific teardown:
      stop tracks → video.srcObject=null → removeAttribute('src')
      → video.load() → detach FSM listeners → hide overlays → clear refs
  - Global visibilitychange / pagehide / beforeunload listeners auto-fire
    teardown so iOS green-dot can't persist
- **Pinch (V.128 strict geometric protocol)**:
  - Top-level IIFE owns its own state (initialDistance, initialScale)
  - Listeners on `#screen-camera` with `{ passive: false }`
  - `e.preventDefault()` when `e.touches.length === 2`
  - `touch-action: none` on #screen-camera + #cam-zoom-layer + #cam-video
  - Math: newScale = initialScale * (currentDist / initialDist), clamp 1.0–3.0
  - Writes `--sav-cam-zoom` via `window._v128SetZoom` (drives CSS + HW zoom)
  - `window._v128OnPinchEnd(finalScale)` snaps HW zoom + hides indicator
- **Canvas crop (V.129 geometry + V.130 robustness + V.131 audit)**:
  - `_v129CropToBrackets(video)` is the primary capture path
  - Bracket dimensions read via `getComputedStyle(.v5-cam-cutout).width/height`
    (LAYOUT box, immune to transforms / display:none) — falls back to
    hardcoded 240×280 constants
  - object-fit:cover visible source rect computed from videoRatio vs elementRatio
  - Maps bracket CSS coords → intrinsic video pixels via cover-scale ratio
  - Divides by `--sav-cam-zoom` to simulate tighter framing at higher zoom
  - DPR-aware canvas: `width = targetW * dpr`, `ctx.scale(dpr, dpr)`,
    destination in CSS pixels — NOT double-scaled
  - Preserves bracket aspect (portrait → portrait canvas, NOT forced square)

#### Loading State (V.134)
- **NO frosted glass, NO video.pause(), NO bracket-hole technique.**
  All three were tried V.122–V.133 and failed on iOS Safari memory path.
- `showV104Tension` / `hideV104Tension` are NO-OPS. They exist only for
  back-compat so historical callers don't throw.
- Capture flow: shutter → captureFrame builds 3 frames over ~240ms →
  stopAllScanners (existing teardown) → callNormalize → show('loading')
- `#screen-loading` styling:
  - White card (`#1C1C1E` in dark mode), 16px radius, Panel-mandated
    diffused shadow (0 10px 25px -5px + 0 8px 10px -6px rgba(0,0,0,.10))
  - iOS-native circular spinner (`.v134-loading-spinner`) at top:
    36px ring, green top-arc, 0.9s rotate
  - V.77 S-badge orbit hidden via `display: none !important`
  - Existing V.77 phase timeline + narration kept below the spinner

#### Barcode Scanner (V.130 + V.131 + V.133)
- Pure CSS cutout (`.v123-bc-cutout`):
  - 80% wide, 150px tall, 16px radius
  - `box-shadow: 0 0 0 4000px rgba(0,0,0,0.85)` for opaque surround (V.133)
  - z-index: 50 (above html5-qrcode injected overlay) (V.133)
  - `overflow: hidden` — laser stays inside, never bleeds
- Library suppression CSS (V.133, fixed friendly-fire from V.132):
  - `#qr-shaded-region { display: none !important }` — targeted
  - `#barcode-reader > *` strips inline borders/backgrounds
  - `#barcode-reader video` forced display:block + 100% + object-fit:cover
  - Does NOT use the blanket `#barcode-reader div { display: none }`
    rule that killed the video wrapper in V.132

#### Visual Design (V.122 + V.125 brute-force)
- All radii / shadows are HARDCODED `!important` on real selectors
  inside the final `<style>` block ("V.125 BRUTE FORCE"). No CSS-variable
  lookups for critical visuals.
- body bg `#F2F2F7` (light) / `#000000` (dark)
- Cards (.v5-door, .v5-savvey-says, .v5-confirm-card, .recent-chip,
  .cta:not(.primary)) all use:
    `background: #FFFFFF` (`#1C1C1E` dark)
    `border-radius: 16px`
    `box-shadow: 0 10px 25px -5px rgba(0,0,0,.10), 0 8px 10px -6px rgba(0,0,0,.10)`
- Primary CTA pill (.cta.primary): `border-radius: 24px` + green-tinted
  diffused shadow
- Text inputs: 12px radius, 1px #E5E5EA border, 17px font (iOS HIG
  body, also prevents auto-zoom-on-focus)

#### On-Screen Debug Banner (V.126, still live)
- Red banner at z-index 99999 at top of body
- Updates every 2s + on every shutter press
- Lines: footer version · DPR · timestamp · door radius / bg / shadow ·
  savvey says · body bg · FSM state · SW controller · pinch state ·
  crop dimensions (bracket CSS, capture src, aspect check)
- Has a × close button to dismiss
- One-shot cache-nuker IIFE: detects stale `savvey-static-*` caches,
  deletes them + unregisters SWs + force-reloads (sessionStorage
  guarded to prevent loop)

### 1.3 Service Worker — `sw.js`

- `STATIC_VER = 'savvey-static-v345v134'`
- Activate handler (V.124+):
  - Purges every cache not in `KEEP = [STATIC_VER, FONT_VER]`
  - Explicitly deletes `/` and `/index.html` from new cache → forces
    network on next navigate
  - `self.clients.claim()` → takes over uncontrolled PWAs
  - Posts `SW_UPDATED { version, purged_count, purged_keys, ts }`
- Fetch: navigate is network-first; static assets are cache-first;
  /api/* never cached

### 1.4 Deploy Workflow

- Edit files in `C:\Users\vince\OneDrive\Desktop\files for live\`
  (index.html, api/normalize.js, sw.js, vercel.json, manifest.json,
  privacy.html, terms.html)
- Write commit message to `.commit-msg.txt` in the same folder
- PowerShell watcher at `C:\Users\vince\OneDrive\Desktop\auto-push-savvey.ps1`
  (running in Windows Startup) detects the marker, runs:
    `git add -A && git commit -F .commit-msg.txt && git push origin master`
  then deletes the marker
- Vercel auto-deploys on push, ~30s to READY
- Manual fallback (if watcher dead):
    `cd "C:\Users\vince\OneDrive\Desktop\files for live"`
    `git add . ; git commit -m "msg" ; git push origin master`
  (Never plain `git push` — it has silently failed before)

---

## 2. iOS SAFARI BURN BOOK — HARD CONSTRAINTS

Each item below cost a real iPhone iteration to discover. **Do not
repeat these mistakes.**

### 2.1 DO NOT use CSS variables for critical radii / shadows.

V.122 / V.122a / V.122b / V.124 / V.125 all defined design tokens
(`--sav-radius-card`, `--sav-shadow-elev-card`, etc.) and relied on
cascade resolution to apply them on real selectors. Chrome MCP showed
the tokens resolving correctly; iPhone home-screen PWA either crushed
the cascade or dropped them in the parsed-stylesheet cache. The
visuals never landed until V.125 brute-forced hardcoded values with
`!important` directly on `.v5-door`, `.v5-savvey-says`, `.cta.primary`,
input selectors, etc.

**Rule**: for any visual the founder must see, the FINAL `<style>`
block has a hardcoded `!important` declaration on the real selector.
Tokens stay defined for documentation but are not the source of truth
on iOS.

### 2.2 DO NOT use `<svg>` for camera/barcode overlays.

V.106 used an SVG with `viewBox="0 0 100 100" preserveAspectRatio="none"`
for the barcode mask. It misaligned on every dvh swing (iOS URL bar
show/hide) because the SVG element was `width: 100%` and the cutout
was `%` within `viewBox` — two layers of relative units that drift.

**Rule**: barcode scanner UI is a single `.v123-bc-cutout` div with
`box-shadow: 0 0 0 4000px rgba(0,0,0,0.85)` for the dark surround +
`overflow: hidden` for the laser. Aspect ratio cannot drift because
there is exactly ONE element with known dimensions.

### 2.3 DO NOT call `video.pause()` to freeze a frame.

V.132 / V.133 tried to pause the live video and overlay a frosted
glass with a transparent bracket-hole so the framed product would
stay visible during the API wait. On a physical iPhone, the paused
video frame rendered as **solid black**. Root cause: iOS Safari's
memory-pressure path drops the last-rendered frame buffer when the
video element is paused.

**Rule**: when the shutter is pressed, run `stopAllScanners()` to
tear down the hardware immediately AFTER the canvas is built. Route
the UI to `#screen-loading` (the standard white card). Never attempt
to keep a paused video frame visible.

### 2.4 DO NOT use CSS pixels as if they were intrinsic video pixels.

V.123 / V.125 / V.128 / V.129 all stumbled over the cover-scale +
DPR math:
- `getBoundingClientRect()` returns CSS pixels (and the VISUAL rect,
  which collapses to 0 if any ancestor is mid-transition — V.130
  caught this on iPhone, banner showed `bracket CSS: 1×1`)
- `getComputedStyle().width` returns the LAYOUT box and is stable —
  use this for bracket dimensions
- `video.videoWidth/Height` are intrinsic media pixels — DPR-independent
- With `object-fit: cover`, the visible source rect maps to the full
  element CSS box; the mapping is:
    `intX = visX + (cssX / elementW) * visW`
- `--sav-cam-zoom` shrinks the captured region by 1/N (centered)
- Canvas backing-store: `canvas.width = targetW * dpr`, `ctx.scale(dpr, dpr)`,
  drawImage destination in CSS pixels → fills backing exactly. NO
  double-scale.

**Rule**: `_v129CropToBrackets` is the authoritative implementation.
Do not "simplify" it without re-reading the comment block above the
function — every step is there for a reason that took a wave to debug.

### 2.5 DO NOT trust Chrome MCP for visual confirmation on iOS-rendering-sensitive code.

Headless desktop Chrome rendered V.122–V.125 tokens correctly. The
iPhone home-screen PWA didn't. I called this "verified live" and
shipped 4 waves the founder couldn't see. The on-screen debug banner
(`#v126-debug`) is the only reliable visual verifier on real iOS.

**Rule**: any wave that changes visible CSS / camera rendering must
be screenshot-confirmed from the founder's iPhone PWA. Chrome MCP
probes are useful for JS state + computed-style values but NOT for
"does this actually render correctly."

### 2.6 DO NOT use the blanket `#barcode-reader div { display: none !important }`.

The html5-qrcode library wraps its `<video>` element in a parent div.
The blanket rule killed the wrapper → black screen (V.132 friendly fire).

**Rule**: target only `#qr-shaded-region` for display:none. Strip
borders/backgrounds on `#barcode-reader > *` without hiding them.
Use the `.v123-bc-cutout` z-index 50 + 0.85-opacity surround to
physically cover any other rogue UI the library injects.

### 2.7 DO NOT skip the `touch-action: none` + `{passive: false}` pair.

V.122b set `touch-action: none` on the camera screen but kept
`{passive: true}` listeners. iOS Safari still claimed the multi-touch
gesture as system zoom and never delivered touchmove. Both gates
required.

**Rule**: `touch-action: none` CSS + `{passive: false}` listener +
explicit `e.preventDefault()` when `e.touches.length === 2`. All
three required for iOS pinch to work.

### 2.8 DO NOT skip `clients.claim()` + cache prefix bump together.

V.122 / V.123 deployed without aggressive cache busting; the
founder's home-screen PWA served the old shell for hours despite
the new SW being installed. Required V.124's STATIC_VER bump +
explicit `clients.claim()` + `caches.delete('/')` to land the new
HTML on the device.

**Rule**: every wave bumps `STATIC_VER` in sw.js. Every wave bumps
the footer label. Cache-nuker in index.html watches for stale
`savvey-static-*` entries and force-reloads with sessionStorage
guard.

---

## 3. NEXT SESSION PRIORITIES

**The Brain is stable.** Backend frozen at V.121 with 0% hallucination,
100% safe routing. SerpAPI picker is authoritative. debug_trace exposes
every pipeline step. The mandate from the Panel after V.121 was a
backend code freeze. Honor that until the next Panel mandate explicitly
lifts it.

**The Face is stable.** V.134 ships:
- Camera screen (Snap door): pinch-to-zoom works on iPhone, bracket-
  bounded canvas crop produces correctly-framed captures.
- Barcode screen (Scan door): clean V.130 cutout, no library overlay
  leaks, opaque surround, contained laser animation.
- Loading screen: standard #screen-loading with Phase A polish + iOS
  spinner. No more frosted-glass attempts.
- Home screen, result screen, confirm screen: Phase A radii + shadow
  baseline. Brute-force CSS layer at end of `<style>` wins specificity.

**Likely next-session focus areas (Panel-pending):**

1. **Result-screen UI polish** — the "Savvey Says" intel box, retailer
   rows, verdict pill, CTA hierarchy. Phase A baseline is applied but
   has not been visually audited on real device. Likely needs:
   - Real-device screenshots to verify the elevated card actually
     reads as elevated against the light-gray body bg
   - Verdict pill micro-typography tuning
   - Retailer row spacing / hairline borders
   - The price block sizing relative to verdict (current ratio TBD)

2. **Edge-case product testing** — the V.120 Crucible Test produced
   2 genuine matches, 7 honest nulls. Worth re-running against the
   same 15 products on V.121 to confirm no regression, then expand
   with a new Crucible-15 covering edge cases the first test missed:
   - UK retailer-own brands (M&S, Waitrose) — partial coverage via V.78
   - Products with no Amazon UK listing — should null cleanly
   - Variant traps (size/colour) — V.118 picker should handle
   - Out-of-stock / pre-release / discontinued — V.110 market_status
     should surface

3. **Frosted glass — if the Panel ever wants it back**, the only
   safe approach on iOS is to NOT pause the video. Show the loading
   card OVER the still-playing video. The video stays live (no
   memory-pressure black-out) but the user sees the loading card
   on top. Alternatively: snapshot the freeze-frame onto a `<canvas>`
   (not `<img>`) and render that. Both are unverified on real iPhone
   and would need a fresh wave.

4. **debug_trace cleanup** — once Vincent is confident the picker
   behavior is stable in production, the `debug_trace` array in the
   /api/normalize response body can be opt-in (e.g. `?debug=1`) to
   reduce payload size on the happy path.

5. **Red debug banner removal** — the V.126 on-screen debugger is
   a temporary diagnostic. Vincent will tell us when it can come
   down. Until then keep it: it's saved us 3+ waves of guessing.

**Specific pinch / capture state to preserve on FIRST priority:**
DO NOT touch:
- `_v129CropToBrackets` math
- `window._v128SetZoom` / `window._v128OnPinchEnd` bridges
- The `body.v132-loading` legacy class scrub (it's a no-op now but
  defensively clears stale state from cached pages)
- The .v123-bc-cutout z-index:50 + box-shadow 0.85 alpha combo

If you must change camera or capture logic, screenshot-verify on
Vincent's iPhone PWA BEFORE marking a task complete.

---

*Saved by Claude (V.134 session) — 11 May 2026, ~22:50 UTC*
*Vincent: vincentlundy@outlook.com · GitHub: vincentlundy1234/savvey · Vercel: savvey.vercel.app*
