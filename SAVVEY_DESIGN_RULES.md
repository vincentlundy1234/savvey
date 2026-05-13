# SAVVEY DESIGN RULES — The Memory Vault

> **Authority:** Savvey Product Panel mandate V.191 (13 May 2026).
> **Scope:** All UI, motion, and interaction work on the Savvey PWA.
> **Status:** Immutable. Do not regress.

Savvey is a kinetic, native-feeling iOS-grade application. It is not a website. Every visible surface and every tap must feel like a first-party Apple product. The rules below are not preferences — they are the architecture.

---

## 1. The Canvas Engine — V.181 Aurora

The `v180-aurora` `<canvas>` element is the **permanent background** of the application. It is mounted as the first child of `<body>` on init and never removed.

- ID: `#v180-aurora`
- Z-index: `-1` (sits behind everything; `pointer-events: none`)
- Composite mode: `globalCompositeOperation = 'multiply'`
- Palette: soft pastels (peach, sky, mint, rose, lavender, pale lime) tuned so dark text remains legible on the cream underlay
- Animation loop: `requestAnimationFrame`, DPR-aware (`Math.min(window.devicePixelRatio, 1.5)`)
- **Battery:** the loop **MUST** pause when `document.hidden === true` and resume on `visibilitychange`. Never run blob animation in a backgrounded tab.

No flat backgrounds. No solid gradients masquerading as canvas. The aurora is the soul.

---

## 2. The Glassmorphic UI — V.181 Glass Material

All cards, nav bars, modals, sheets, and floating buttons **MUST** use the standard glass material.

- Class: `.v181-glass` (light) or `.v181-glass-dark` (dark surfaces)
- Tokens:
  - `background: rgba(255, 255, 255, 0.62)`
  - `backdrop-filter: blur(20px) saturate(150%)`
  - `-webkit-backdrop-filter: blur(20px) saturate(150%)`
  - `border: 1px solid rgba(255, 255, 255, 0.55)`
  - Top rim-light: `box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7)`
  - Outer drop shadow: `0 10px 25px -5px rgba(0, 0, 0, 0.10), 0 8px 10px -6px rgba(0, 0, 0, 0.10)`
- Radii: `16px` for cards, `24px` or full-rounded for pills.
- Typography stack: `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto`. Title weights `800`, subtitles `600`.

**Banned:** flat fills, opaque card backgrounds, sharp corners, web-standard form controls without glass styling.

---

## 3. Tactile Physics — Critically-Damped Spring Solver

Standard CSS `:active` scales are **banned** for primary touch targets. All taps **MUST** route through the custom JS critically-damped spring physics solver.

- Constants: `TENSION 340`, `FRICTION 18`, `MASS 1`, `EPS 0.0005`
- State: per-element `WeakMap` with auto-GC
- Target selector: `SPRING_TARGETS` — heroes, CTAs, retailer rows, tab bar items, type-go submit, recent chips
- Pre-mount: `.v181-spring` class applied at init via `v182PreMountSprings()`. **Never** mutate spring classes during a pointer event (iOS treats that as element movement and suppresses synthetic click).
- Squish target on `pointerdown`: `0.94`. Release target on `pointerup`: `1.0`.

Direct CSS `transform: scale(0.96)` on `:active` is acceptable **only** for incidental controls (e.g. a Close X) and is fired with a `cubic-bezier(0.32, 0.72, 0, 1)` curve.

---

## 4. Event Integrity — Click Must Survive

The Spring Physics listeners are capture-phase but **pass-through**. They must never call `preventDefault()` or `stopPropagation()` on actionable elements.

- `pointerdown` records `{el, x, y, t, fired:false}` and schedules the spring squish on the next animation frame.
- A one-shot capture-phase click listener flips `fired = true` if the native click wins.
- `pointerup` releases the spring and, after 80–90 ms, fires `el.click()` **only if** (a) pointerdown was on the same element, (b) the user did not drag > 10 px, (c) tap duration < 1000 ms, and (d) no native click fired.
- A business-logic failsafe inspects the tapped element's class list and manually invokes the correct routing function (`v172SubmitType`, `v172OpenTypeSheet`, `goSnap`) if the synthetic `.click()` is somehow swallowed.

The UI yields to the business logic. The user **always** reaches Savvey Says.

---

## 5. Global Anchor Navigation — V.183 Tab Bar

The full-width frosted glass bottom tab bar is the **primary navigation surface**.

- ID: `#v183-tab-bar`
- Position: `fixed; left: 0; right: 0; bottom: 0`
- Z-index: **80** (above legacy bottom-nav at 50; below modals at 100+)
- Safe area: `padding-bottom: calc(env(safe-area-inset-bottom) + 8px)`
- Three pillars, `flex: 1` each:
  - **Home** — house glyph + label, routes via `goHome()` after clearing search state
  - **Snap** — camera glyph, 30px (slightly larger), brand-green accent, routes via `goSnap()` — the primary action
  - **Type** — magnifier glyph, routes via `v172OpenTypeSheet()`
- Glass: `rgba(255, 255, 255, 0.45)` + `backdrop-filter: blur(25px) saturate(200%)` + `border-top: 1px solid rgba(255, 255, 255, 0.4)` rim light
- Active-state indicator: `.is-active` toggled by 400 ms poll inspecting current screen — lifts icon color to `var(--green-deep)` and stroke-width to `2.4`
- Keyboard avoidance: hidden via `body.v185-type-focus` while `#v172-type-input` owns focus
- All three tabs carry `.v181-spring` and live in `SPRING_TARGETS`

---

## 6. Modal Immersion — Camera & Scanner

The Camera (Snap) and Barcode scanner are **full-screen immersive modals**.

- Z-index: **90+** (above the tab bar at 80; below sheet overlays at 100+)
- Both `#screen-camera.active` and `#screen-barcode.active` use:
  - `position: fixed; inset: 0`
  - `width: 100%; height: 100dvh` (Dynamic Viewport Height — Safari URL-bar-safe)
  - `@supports not (height: 100dvh)` fallback to `100svh`
  - `margin: 0; padding: 0; background: #000; overflow: hidden`
- When the camera modal is active it **must completely cover** the V.183 tab bar via z-index occlusion, and the modal must seal to the bottom of the viewport — no bleed.
- The unified frosted-glass Close X (`.v171-cam-close` for camera, `.v188-bc-close` for barcode) sits in the bottom thumb zone at `z-index: 9999`, `52×52`, `rgba(20,22,24,0.55)` + `blur(18px) saturate(180%)` glass material.
- The legacy tiny top-left X (`.v5-cam-x`) on the barcode screen is **hidden**. One X per modal, always thumb-zone.

---

## 7. Zero-Friction Arrival — V.186 / V.187

**Multi-screen onboarding tutorials are permanently banned.**

First-time users experience a single seamless dissolve:
- Splash overlay `#v186-arrival` at `z-index: 200`, transparent background (aurora shows through), giant `SAVVE Y .` wordmark (64px, weight 800, `Y` in `var(--amber, #d68910)`, dot in `var(--green-dark)`), single glass CTA **"Shop Smart"**.
- While the splash is up, `body.v186-arrival-active` sets `#screen-home` and `#v183-tab-bar` to `display: none !important` — splash sits alone over the aurora.
- On tap of "Shop Smart": choreographed dissolve. CTA fades down (35 ms); logo flies up and scales down to land at the V.172 home header position (650 ms `cubic-bezier(0.32, 0.72, 0, 1)`); home + tab bar fade in via `body.v186-revealing` with a 250 ms delay; home header wordmark materialises at 550 ms delay (no double-logo flash).
- Display flip discipline: remove `.v186-arrival-active` → add `.v186-pre-reveal` → force reflow (`void document.body.offsetHeight`) → `requestAnimationFrame` → `.v186-revealing`. Browsers do not transition `display`; the pre-reveal frame is mandatory.
- Persistence: `localStorage.savvey_has_arrived = '1'` is set the **instant** the user taps. On boot, presence of the flag bypasses the splash and renders the home screen instantly.

### Contextual Camera Permissions

`navigator.mediaDevices.getUserMedia` **MUST NOT** fire on initial load, on the Arrival splash, or anywhere outside an explicit camera-init path. The OS permission prompt only appears when the user **physically taps the "Snap" hero card or the Snap tab bar icon for the first time**. Anything else is a regression.

---

## 8. Brand

- Name: **Savvey**
- Tagline: **shop smart.**
- Wordmark: `SAVVE` (green-deep) + `Y` (amber/brand-orange `#d68910`) + `.` (green-dark)
- Primary green: `#2a6b22`
- Green deep: `#143d10`
- Score: **Savvey Score** (1-2 red / 3 amber / 4-5 green)
- Verdicts: 1 *Walk away* / 2 *Better deal available* / 3 *Worth a look* / 4 *Pretty good* / 5 *Best price*
- Voice: consumer-first, dry wit, never accusatory
- Never say: "ripped off" or "rip-off"
- Buy button: always green regardless of verdict

---

## 9. The Oath of Compliance

> Before writing any new UI code or modifying existing layouts, I (Claude) will consult these rules. I will not introduce flat colors, standard CSS transitions for buttons, or web-standard navigation paradigms. Savvey is a kinetic, native-feeling iOS-grade application.

This file is the Memory Vault. It is locked.
