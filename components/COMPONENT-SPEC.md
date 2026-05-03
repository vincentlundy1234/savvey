# Savvey Component Spec

This is the canonical contract for each extracted ES module under
`/components/`. When a module is added/changed, update the relevant
section here.

Goals:
1. Every module is data-shape agnostic — it does NOT reach into globals
   or `window.liveScen` etc. Caller pre-resolves and passes data in.
2. Every module returns a value (DOM nodes, fragments, drawing side
   effects) — caller appends/uses. No "magic globals being set."
3. Every module exposes a `window.SavveyXxx` bridge so the classic-script
   monolith can call without converting to a module.
4. Modules use `textContent` + `addEventListener` over `innerHTML` +
   inline `onclick`. Apostrophe-bearing retailer names ("Sainsbury's")
   must render correctly.

---

## Module: `loading-screen.js` → `window.SavveyLoader`

**Purpose**: Pill-cycling marquee + counter + ring-restart animation
that runs while a price search is in flight.

**API**:
```js
SavveyLoader.start({ query, generation })   // begin pill cascade
SavveyLoader.stop()                          // cancel pending timers
SavveyLoader.reset()                         // stop + clear DOM lit/done state
```

**Owns**:
- internal `chipTimers` array
- internal `currentGen` for stale-callback guard

**DOM contract** (HTML must provide these IDs):
- `#searching-product` — text node, replaced on `start()`
- `#srch-counter-num` — text node, updated as pills tick
- `.srch-ring-progress` — animation restart on every `start()`
- `#rc-0` … `#rc-15` — 16 pill elements that get `lit` then `done` class

**State**: NONE shared with caller. `start()` is idempotent — calling
twice cancels the first.

---

## Module: `result-banners.js` → `window.SavveyResultBanners`

**Purpose**: Mutually-exclusive explainer banners that sit ABOVE the
hero verdict card. Two variants: snap-generic and top-picks.

**API**:
```js
SavveyResultBanners.render(heroCardEl, sc)  // render appropriate banner
SavveyResultBanners.clear(heroCardEl)        // remove any active banner
```

**Banner selection logic** (mutually exclusive):
1. If `sc.snapMatch?.isGenericMatch` → "Generic match" banner
2. Else if `sc.categoryProducts?.length > 0` → "Top picks for X" banner
3. Else → no banner (existing one is removed)

**DOM contract**: `heroCardEl` is the parent the banner is inserted
into (always at top of children). CSS class `.snap-generic-banner`
must exist for visual styling.

**Required `sc` fields**:
- `sc.query` — fallback to `window.liveQuery` if absent
- `sc.snapMatch` — `{ isGenericMatch, cleanedProduct }` for snap variant
- `sc.categoryProducts` — array of product strings for top-picks variant

---

## Module: `share-canvas.js` → `window.SavveyShareCanvas`

**Purpose**: Programmatic 640×820 PNG generation for share overlays.
Two variants: result-share and savings-counter.

**API**:
```js
SavveyShareCanvas.drawCard(sc)              // result-share canvas
SavveyShareCanvas.drawSavingsCard(total, count)   // savings card
SavveyShareCanvas.fmtSavingsTotal(v)        // pence under £100, comma above
```

**DOM contract**: `#share-canvas` 640×820 canvas element exists.

**Required `sc` fields for `drawCard`**:
- `sc.spc` — 'red' | 'amber' | 'green'
- `sc.score` — 1-5
- `sc.vTitle` — verdict copy
- `sc.query` — what the user searched for (caller resolves liveQuery)
- `sc.witLine` — wit copy (caller resolves witLine() before calling)
- `sc.bestPrice`, `sc.bestRetailer`, `sc.saving`

**Internal helpers** (not exported): `rr`, `roundRect`, `wrapText`,
`wrapTextLines`, `guessProductEmoji`, `savingsCongratLine`.

**State**: NONE. Pure draw functions.

---

## Module: `result-rows.js` → `window.SavveyResultRows`

**Purpose**: Per-retailer rows on the results screen.

**API**:
```js
SavveyResultRows.renderRetailerList(items, onRowClick) → DocumentFragment
```

**Item shape**:
```js
{
  name:     string,    // retailer display name (e.g. "Sainsbury's")
  brandKey: string,    // CSS data-brand attribute value
  sub:      string,    // sub-line (delivery / "View at host")
  price:    string,    // pre-formatted "£123.45"
  diff:     string,    // optional diff label (e.g. "+£40 vs cheapest")
  isBest:   bool,      // adds .best class + ✓ badge
  isHigh:   bool,      // adds .high class + .over diff styling
  link:     string,    // URL to open on click
}
```

**Pattern**: createElement + textContent + addEventListener +
DocumentFragment. Zero string-injection surface. Single layout pass.

**Click handler**: caller passes `onRowClick(name, link)` callback.
Module never reaches into `window` for handlers.

---

## Bridge pattern — when to drop it

Every module currently exposes `window.SavveyXxx` so the classic-script
monolith in `index.html` can invoke without an `import`. This is a
transitional crutch.

**Drop the bridge when** the calling code has been moved into a module
context (i.e. when the main script tag becomes `type="module"`). At
that point, replace `window.SavveyLoader.start(...)` with
`import { start } from './components/loading-screen.js'; start(...)`.

Until then, the bridge is acceptable. Don't add anything to it that's
not also exported as an ES module export — the bridge is the secondary
API surface, not the primary.

---

## Naming convention

- Filename: `kebab-case.js` (e.g. `loading-screen.js`)
- Bridge namespace: `SavveyXxx` (PascalCase) on `window`
- Exports: `camelCase` for functions, `UPPER_SNAKE_CASE` for constants

---

## Adding a new module

1. Pick a self-contained component with one entry / one exit
2. Pre-cache in `sw.js` STATIC_ASSETS array
3. Add `<script type="module" src="/components/foo.js">` to `<head>`
4. Use `createElement + textContent + addEventListener` (not innerHTML
   string interpolation, not inline onclick)
5. Document this file with the module's API + DOM contract
6. Bump `sw.js` STATIC_VER so old SWs invalidate
