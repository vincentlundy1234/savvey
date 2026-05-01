# Savvey — Session Notes
## 2nd May 2026 — Amazon reality check, per-retailer fan-out, barcode lookup, strategy framework

---

## Headline outcomes
1. **Amazon Associates approved (`savvey-21`)** — but PAAPI access requires 10 qualifying sales in trailing 30 days as a **prerequisite** (policy changed). Creators API has the same gate. PAAPI work is on hold until those sales materialise organically.
2. **Per-retailer Serper fan-out shipped (v6.14)** — Sony WH-1000XM5 went from "1 eBay listing, limited coverage" to "Selfridges £229, Richer Sounds £229, Currys £399" (3 real UK retailers, coverage='good', 1.6s response). This was the 90/10 unlock that made multi-retailer comparison actually work.
3. **Always-on Amazon UK affiliate card (v6.14)** — every result screen now has a tappable "Also search Amazon UK" card carrying the `savvey-21` tag. No PAAPI required, commission tracking active immediately.
4. **Barcode lookup hardened (v6.15)** — `/api/search` accepts `{barcode}` and resolves via Serper. In-store flow now has three fallbacks: Open Food Facts → UPCitemdb → Serper. Most non-grocery barcodes that previously dead-ended will now resolve to a product name.
5. **Strategy framework saved.** Vincent shared a 90/10 / boring backend / Build-Measure-Learn / strategic integration framework. Saved to memory, applied to subsequent decisions.

## The strategic decision
Vincent asked the killer question: *"If you had to launch a version of this app tomorrow that only did ONE thing perfectly, what would that one thing be?"*

Answer: **In-store barcode scan → fair-price verdict in under 30 seconds.**

Reasoning: search and paste flows are commodity (user could Google manually). The in-store flow is where Savvey is uniquely valuable — user is physically holding a product, can't easily compare, and Savvey closes the loop in 15 seconds with the Savvey Score actually meaning something (because there's a real shelf price to score against).

What was blocking that flow: barcode → product name resolution. Open Food Facts is food-only; UPCitemdb's free trial misses most non-grocery items. v6.15's Serper fallback addresses this.

## Amazon path — what we know now

- Vincent's Associates account is approved, partner tag `savvey-21`.
- Buy buttons and the always-on Amazon card now carry the tag — affiliate commission active immediately on Amazon-UK click-through.
- PAAPI 5.0 access (programmatic product data) gated behind 10 qualifying sales / 30 days. New policy.
- Creators API is the same thing rebranded — same 10-sales gate.
- The `AmazonProductProvider` class (v6.13) sits dormant in `api/search.js`, ready to activate when Amazon Associates dashboard exposes the access keys (i.e. once the 10-sales gate is met).
- **Don't try to manufacture sales.** Coordinated artificial purchases through your own affiliate link is a textbook violation of the Operating Agreement and Amazon's fraud detection flags exactly this pattern. Termination + permanent ban is the realistic outcome.
- **What's allowed:** organic sharing — friends, social, anyone shopping anyway. The 10 qualifying sales should come naturally from real Savvey users once the app delivers value.

## Architecture: where Savvey gets its data now

```
Tier 1 (primary, structured):
  • Amazon PAAPI    — DORMANT, awaiting 10 qualifying sales
  • Awin Product Feed — DORMANT, can't apply until app delivers value

Tier 2 (active today):
  • Serper shopping endpoint        — Google Shopping aggregator
  • Serper UK-sites OR'd query      — broad UK retailer pass
  • Serper per-retailer fan-out (NEW v6.14)  — 9 targeted searches in parallel
  • Always-on Amazon affiliate card — link-only, no price, monetisation path

Tier 3 (gap fillers):
  • Google CSE — circuit-breaker protected, low quota
  • scrape.js (URL paste mode) — direct retailer page parsing for known URLs
```

Tier 2 plus the always-on Amazon card is the working baseline as of v6.15.

## v6.13 → v6.15 changes shipped (in three pushes today)

### v6.13 (`4456d14`)
- `AmazonProductProvider` class — full PAAPI 5.0 SearchItems support with manual AWS SigV4 signing (no aws-sdk dependency). Activates the moment `AMAZON_ACCESS_KEY` + `AMAZON_SECRET_KEY` + `AMAZON_PARTNER_TAG` env vars are present in Vercel. Inactive today (PAAPI gated) but ready.
- `AFFILIATE_TAGS` constant + Amazon search URL with `&tag=savvey-21` baked in. Buy buttons and retailer search fallback now carry the tag.

### v6.14 (`f6b6952`)
- `fetchSerperPerRetailer` — 9 parallel `site:retailer.co.uk {query}` Serper calls. One targeted search per major UK retailer (Currys, Argos, John Lewis, AO.com, Very, Halfords, Boots, Selfridges, Richer Sounds). Each retailer gets its own dedicated query so Google's index reliably returns the top hit. Wall-clock ~5s (parallel).
- Always-on Amazon affiliate card on results screen. Visible regardless of whether Amazon surfaced in the result set. `searchAmazon()` opens the tagged search URL.
- Live test confirmed: Sony WH-1000XM5 → 3 real UK retailers (Selfridges, Richer Sounds, Currys), coverage='good'.

### v6.15 (this push)
- Backend `/api/search` extended to accept `{barcode}` body. Returns `{product, resolvedFrom}` after resolving the barcode via Serper organic search and cleaning the title. Single ~1s round trip, no price pipeline.
- Frontend `confirmScan` adds Serper as third barcode fallback after Open Food Facts and UPCitemdb. Most non-grocery barcodes that previously hit "Product not recognised" should now resolve.
- SW cache v18 → v19.

## Remaining suggestions (parked for next session)

1. **Test barcode hit rate.** Walk into 5 different shops, scan 10 random barcodes (mix of grocery, electronics, clothing, books). Anything below ~70% recognition rate means we should consider Barcodelookup.com paid tier (£30/month, comprehensive UK coverage).
2. **PWA install prompt.** When a user is in-store, having Savvey on their home screen matters. Vercel + sw.js are PWA-ready; need an install banner CTA. ~30 min of work.
3. **Delete `PASTE_RETAILERS`.** The hardcoded demo prices block in index.html (~line 1925) is orphan code that doesn't serve any current journey.
4. **Verify the in-store journey end-to-end.** A lot has changed in the last 36 hours (price screen routing, Discovery/Validation, average price, top-3 retailers, barcode fallback). Walk the path: welcome → scan → barcode lookup → price entry → results → buy. Confirm 30-second target.
5. **End-to-end live testing across 10+ products.** Past testing has been per-query; need a sweep to characterise overall coverage and identify residual mis-listings.

## Brand voice reminders (still valid)
- "spend smart." — never accusatory
- Currys: "Currys, more worries 😢" / John Lewis: "aspirational pricing. As ever."
- Never: "ripped off", "rip-off"
- Buy button always green — positive action

## Cost / running fees
**Still £0/month** — Vercel free, Supabase free, Serper free tier, Google CSE free 100/day.

The per-retailer fan-out increased Serper usage by ~9x per query (one fan-out call per retailer). At Serper's free tier (2,500 queries/month) this gives ~270 user searches/month before hitting the limit. Worth monitoring; upgrade to paid Serper (£40/month for 10k queries) becomes necessary at moderate user adoption.

## Commit chain
| Commit | Version | Purpose |
|---|---|---|
| `4456d14` | v6.13 | AmazonProductProvider scaffold (dormant) + savvey-21 affiliate tag on Amazon URLs |
| `f6b6952` | v6.14 | Per-retailer Serper fan-out + always-on Amazon UK card |
| (this push) | v6.15 | Barcode lookup via Serper as third fallback |
