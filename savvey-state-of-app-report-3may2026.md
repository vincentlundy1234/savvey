# Savvey — State of the App Report

Generated 3 May 2026 (post Wave 88). Brutal, objective. Pickup point for tomorrow's session.

## 1. Executive Summary

**Visual Design: 7/10**
**Functional Stability: 6/10**

Visual design moved up a notch this session — Snap pill clash fixed, trending tiles removed, retailer rows stagger in, Savvey Says panel is genuinely strong, counter shows "spotted across N checks" context, bottom nav padding is right. But "polished" is being mistaken for "designed." The home screen is cleaner only because we removed something, not because we designed something better in its place. Result hero is still doing five things at once. There is no type ramp, no spacing scale, no design tokens — typography is still set per-component by hand, which means future changes will keep introducing visual drift.

Functional stability *regressed* from the last audit's 5.5 because Wave 86's category-page filter over-fires: live test confirmed "cordless vacuum cleaner" now returns ZERO results post-Wave 86 — a flagship query the team has been using to validate the budget-tier surfacing dies on its face. Wave 83's price-anomaly floor missed yoga-mat-Amazon-£9.99 (the primary trust-erosion case for that category). PS5 still surfaces only AO £575 when real UK price is £389-449. Stanley flask returns two wrong-product listings that look authoritative. The "best price" promise — the entire reason the app exists — fails on at least 4 of 20 stress-test queries.

Why it still feels unpolished: every change since last audit has been *bug-driven, reactive, regex-based*. Add a category-URL pattern → over-filter → walk it back. Add Lakeland → forget the frontend retailer map → click-through breaks. Add Haiku grading → forget to surface the field in the response. The system has no end-to-end test, no telemetry that actually tells us what users see, and no real-device QA. We're shipping into a black box. The Wave 86 cordless vacuum regression went un-noticed for 30+ minutes because nobody re-ran the canonical test queries after the deploy.

## 2. The Major Issues Log

### UI / UX & Design Debt

**Result hero is still overloaded.** Verdict pip strip + wit line + £X below typical + retailer subline + Buy CTA + Share + Check another product + AI Savvey Says panel + ALL PRICES list + Got the shelf price prompt + View on Amazon CTA + Save for later + affiliate disclosure footer. Each individually is justified. As a stack, it reads as a "control panel" not a "verdict." The 30-second mission needs the verdict to be the focal point and everything else subordinate; right now they're competing.

**Typography is still unranked.** No type token sweep was done. Hero headline is one weight, eyebrow caps another, AI strip another, retailer rows another. Three different Nunito weights compete on the result screen. New visible drift today: "SAVVEY SAYS" eyebrow uses a different opacity than "BELOW TYPICAL UK PRICE" eyebrow on the same card.

**The Save Score number isn't anchored to a price story.** "£5 BELOW TYPICAL UK PRICE" works for a clear winner; for an amber score it reads "£0 below" which is awkward. The hero copy doesn't degrade gracefully — at score 3, the £-saved framing is still trying to be the headline when it shouldn't be.

**Counter subtitle "spotted across N checks" is set without internationalisation thinking.** Says "26 checks" — singular/plural aside, what does "check" mean to a first-time user? They haven't done any. Empty state for the counter at £0/0 checks reads as "broken."

**Loading screen still untested on actual device.** Reported broken 5+ times in this session alone. Wave 66 fix was the last serious change; no real-device verification since.

**Snap screen UI untested on real device since pre-Wave 70.** Camera capture, AI vision result rendering, Snap-to-results transition — all untested on actual phone since multiple variant-filter waves shipped.

**Empty state hero (renderNoResults) is fine but inconsistent.** Different padding, different headline weight, different button order versus the success hero. Reads as a different page rather than a graceful degrade.

**Retailer logos on loading screen are stale.** B&Q / Lakeland / Dunelm / Wayfair / IKEA / Habitat / Waterstones / WHSmith all added in last 4 waves to backend — none are on the loading-screen retailer-tile marquee. So when you search "lawn mower" the loading screen shows Currys / Argos / John Lewis logos but the actual results return Wayfair / B&Q / Wickes. Brand promise vs delivery mismatch.

**Affiliate disclosure copy now reads OK but is rendered too small and below the fold on most result screens.** Compliance disclosure that nobody can find isn't compliance.

### Functional Breaks & Incomplete Features

**WAVE 86 REGRESSION — UNRESOLVED.** Cordless vacuum cleaner now returns ZERO retailers. Live-tested 5 minutes after deploy and confirmed. The category-URL filter is dropping legitimate retailer URLs that contain `/featured/`, `/all-`, `/browse/`, `/_/N-` etc. The flagship "I was in Lidl and it felt good" query path is broken in production right now.

**Price-anomaly floor (Wave 83) doesn't trigger reliably.** Yoga mat: Amazon £9.99 still surfaces despite Wave 83 being deployed. Either Haiku graded it as "exact" (in which case the floor's exact-passes rule preserved it incorrectly), the function failed silently, or the threshold (25% of median) is too generous. Untested at the function-internal level.

**Books fan-out (Wave 84) returns only 1 retailer.** Atomic Habits → World of Books £14.89 only. Waterstones / WHSmith / Amazon should all stock it but none surfaced. The site:waterstones.com fan-out is being run but Google isn't returning indexable price snippets from those sites for that query. Coverage problem the fan-out doesn't fix.

**PS5 search returns only AO £575.** Real UK PS5 is £389-449 at Argos / Currys / Amazon / John Lewis. Either the query phrasing doesn't trigger product matches, the prices don't come through in snippets, or the PAAPI Amazon path isn't activating. Single-retailer £575 result is positively misleading.

**Snap photo flow not stress-tested post Wave 70+ filtering.** The variant filter / refurb filter / bundle filter / category-URL filter all run on Snap-derived queries too. We don't know if Snap → AI Vision → product name → search returns sensible results or hits the same regression patterns.

**Service worker update toast (Wave 74) untested in the wild.** Was shipped to handle stale-build problem but has not been verified to actually appear on a real new-version landing.

**Telemetry endpoint (Wave 75) is shipped but not consumed.** Events fire to /api/track which logs to Vercel function logs. Nobody is reading them. We have telemetry in the technical sense and zero observability in the practical sense.

**Image cache hydration (Wave 69) — quality varies wildly.** Sony WH-1000XM5 chip has correct headphones photo. iPhone 17 chip showed a barcode. Samsung 65 QLED TV chip showed a donut. /api/image hits Serper Images which returns garbage on category queries.

**Counter dedupe (Wave 75) untested in real-user conditions.** Day-keyed dedupe in localStorage — works in theory, but no validation that real users' multi-search behaviour produces sensible counts.

### Architectural & State Management Flaws

**index.html grew to ~9,200 lines this session.** Single inline `<script>` block. Adding any feature requires loading the whole thing. No module boundaries.

**Frontend UK_RETAILERS map manually mirrored to backend.** Drifted twice already (Wave 77 frontend missing Lakeland → Lakeland £40 result invisible to user; the same risk now exists for IKEA / Wayfair / Habitat).

**buildScenV3 is now ~120 lines** of dedupe + outlier guard + cluster anchor + avg + score + copy + retailer slice + saving narrative + share message. Each branch a foot-gun. Wave 77 outlier-guard restructure was bolted on; it's now even harder to refactor cleanly.

**Per-retailer Serper fan-out runs serial-ish over 25 retailers.** Promise.allSettled but each is a fresh HTTP call. When all 25 are slow that's a 5s wall-clock floor. Live test today: chrome-batched 6 queries timed out at 45s — that's per-API-call latency × queries.

**Tier 1 / Tier 2 boundary still owned by frontend (`if length < 2 fall through`).** Backend doesn't know whether its result is "primary" or "fallback." Means Wave 79's Haiku grading runs in Tier 1 only; Tier 2 had no grading until Wave 82 added a separate path; the two graders aren't unified. Two near-identical Haiku prompts to maintain.

**globalReset() called from 9 places, never centralised.** Adding a 10th search path is a footgun.

**No end-to-end test or staging environment.** Every push goes straight to production. Wave 86 regression went live and the canonical query broke for 30+ minutes before being noticed.

**No error budget or alerting.** If /api/ai-search starts 500ing for 50% of users we'd find out via Vincent.

### PWA / Cross-Device / Performance

**Single 9,200-line HTML on every visit.** SW cache helps repeat visits; first visit on 4G is rough.

**Per-retailer fan-out latency unbounded by global timeout.** Each retailer call has 5s timeout but if 8 take 4s each, total can exceed Vercel's 15s function limit on the slow days.

**No real-device test matrix.** iOS Safari, Android Chrome, low-end Android — none verified in 88 waves.

**No measurement of LCP, CLS, INP.** Core Web Vitals invisible.

**Service Worker cache invalidation works for index.html but not for static assets like fonts.** Font weight changes silently won't reach existing users.

**Reduced-motion only honoured on a subset of animations.** The savings-counter count-up still animates regardless of `prefers-reduced-motion`.

**No focus indicators** in dark-mode contexts (loading screen, share overlay).

**Search input doesn't prevent autocomplete on iOS** — phantom suggestions overlay the placeholder.

## 3. Gaps Inventory

| Gap | Status |
| --- | --- |
| Cordless vacuum cleaner returning zero results post-Wave 86 | **REGRESSION — fix now** |
| Price-anomaly floor not catching yoga mat Amazon £9.99 | Failing silently |
| PS5 only surfacing AO £575 | Coverage failure for top-N query |
| Books fan-out only returning 1 retailer | Coverage failure |
| Real-device QA matrix | Never done |
| Snap flow real-device test | Never done |
| End-to-end test suite | Never done |
| Telemetry consumption / dashboard | Built in Wave 75, not piped to anything |
| Loading screen retailer logos updated for Wave 77/84 retailers | Stale |
| Frontend UK_RETAILERS sync with backend | Manual, drift-prone |
| Type ramp / spacing scale | Never done |
| buildScenV3 refactor | Got bigger, not smaller |
| globalReset() consolidation | 9 call sites |
| Awin / Skimlinks affiliate signup | Vincent's deliverable |
| iOS Web Share Level 2 | Falls back to text+URL |
| Counter dedupe real-user validation | Untested |
| AI estimate Haiku prompt — books category coverage | Generic |
| Loading screen — real-device verification | Reported broken 5+ times, last fix unverified |

## 4. Immediate Remediation Roadmap

| Wave | Task | Priority |
|---|---|---|
| **89** | Hot fix Wave 86 over-filter — restore cordless vacuum cleaner | TODAY |
| **90** | Debug Wave 83 price-anomaly silent failure (add debug flag) | TODAY |
| 91 | Loading screen retailer-logo refresh | This week |
| 92 | Frontend ↔ backend retailer sync test script | This week |
| 93 | Real-device QA pass (iOS Safari + Android Chrome) | This week |
| 94 | End-to-end test harness (20 canonical queries assert non-empty + plausible price) | This week |
| 95 | Result hero density audit — cut to verdict + wit + £-saved + ONE primary CTA | Soon |
| 96 | Type token sweep | Soon |
| 97 | Telemetry dashboard | Soon |
| 98 | Loading-screen real-device verification | This week |
| 99 | Awin / Skimlinks application (Vincent's deliverable) | Soon |
| 100 | buildScenV3 refactor (3 pure functions) | Soon |

**The honest meta-finding:** we have 88 waves of additive complexity and ZERO regression tests. Wave 94's end-to-end harness is the single biggest unlock for shipping confidence. Until then, every wave has the same structural risk.
