# Savvey — Session Notes
## 2nd May 2026 — End of Day (AI-native pivot + brand alignment + share/wit overhaul)

---

## Headline

Savvey is now AI-native. The Perplexity + Claude Haiku architecture replaces the Serper-as-primary pipeline. Real UK retailer prices (Currys, Argos, John Lewis, AO, Selfridges, Richer Sounds, Very) returned in ~2.3 seconds with real product page URLs (no Google aggregator junk). AI-written wit lines in genuine Savvey voice. Three customer journeys clean, app never breaks because Serper remains as Tier-2 fallback.

This is the strategic pivot from "fight the API gatekeepers (Amazon, Awin)" to "let AI do the discovery, gatekeepers become bonus revenue when they want us." Chicken-and-egg trap broken.

---

## Live state — end of session

- **Live URL:** https://savvey.vercel.app
- **Last commit deployed:** `3aa42fb` — ai-search v1.1 with Haiku batched price extraction
- **Function response time:** ~2.3 seconds typical (1s Perplexity + 1.3s Haiku batched)
- **Cost projection:** ~£2-40/month from 100 to 2000 MAU

End-of-session test confirmation (Sony WH-1000XM5, validation flow with £329 user-paid price):
- Cheapest: £229 at John Lewis (real)
- Argos £230, Very £249 (both real)
- Average: £236 across 3 retailers
- Savvey Score: 1/5, "Walk away.", saving £100
- AI wit: "You're paying for Argos's catalogue nostalgia—John Lewis has them for a hundred quid less."
- Source: perplexity, Coverage: partial

This is the real product comparison Savvey was supposed to deliver.

---

## What shipped today

### Brand alignment
- Strapline "spend smart." → **"shop smart."** across `index.html` (title, welcome, home, share canvas), `manifest.json`, `CLAUDE.md`
- Score renamed "Savvey Signal" → **"Savvey Score"** across all user-visible copy (verdict banner, share card, hidden labels)
- Logo description updated: **all-green** (no red dot — earlier "red full stop" was a brand-doc description that never made it into code, now obsolete)
- Internal CSS class names (`.signal`, `.signal-lbl`) and JS `.signal` API kept — non-user-facing

### Wit & share overhaul (50+ contextual lines + multi-channel)
- Hardcoded `witLine()` expanded to 50+ UK-cultural lines mapped per retailer + saving tier
- Reframed in second person ("You'd save eighty quid—that's sixteen pints. Currys priced these with the heating cranked to full.") — makes the user the savvey one
- Multi-channel share: WhatsApp intent, X/Twitter intent, Copy clipboard, native share, save image
- Deep-link `?q=` auto-search on page load — viral mechanic for shared links
- Share text leans on the wit line as the social object

### AI architecture (the big one)

Three new files / endpoints:

**`/api/ai-search` (v1.1)** — Perplexity Sonar `/search` endpoint finds UK retailer hits, then Claude Haiku 4.5 reads snippets in a batched call and returns structured `{index, price, plausible}` per item. Replaces the regex extractor that grabbed monthly-finance / bundle / accessory prices.

**`/api/ai-wit`** — Claude Haiku 4.5 generates contextual UK-voice wit per result (per-retailer character, second-person, UK-cultural reference units). Falls back to hardcoded `witLine()` if Anthropic fails.

**Frontend (`fetchPrices`)** — calls `/api/ai-search` first; if it returns ≥2 retailers uses that, else falls back to `/api/search` (existing Serper pipeline). `renderResults` async-fires `/api/ai-wit` after results render and swaps the AI line in over the hardcoded fallback.

### Infrastructure
- Service worker bumped through versions v22-v27 across the day for cache-busting
- Trust filter dedup prefers real retailer URLs over Google aggregator URLs
- Scrape User-Agent updated to real Chrome (didn't fix WAF blocks but doesn't hurt)
- URL-slug fallback for failed scrapes (graceful degrade instead of dead-end)
- Refine-search input on results screen (pre-filled with current query)
- Always-on Amazon UK affiliate card with `savvey-21` tag
- PWA install banner on welcome screen
- Empty-state copy made honest ("Couldn't reach the price data" instead of misleading "no UK retailers")
- `renderResults` recovers cleanly from `renderNoResults` mutating the DOM

---

## Strategic decisions made

1. **Don't pivot the brand name yet.** Trademark check found an active "SAVVEY SAVERS NETWORK LIMITED" at Companies House (cashback club, different category). ShopSavvy is US-focused. Both manageable. Worth a £200 trademark lawyer call before any spend on growth — not a pivot trigger.

2. **Premium domains (spend.ai, spend.app) cost $50k-$157k.** Not viable for MVP. savvey.app stays as the working domain.

3. **AI as primary, not enhancement.** The cost math at small scale (£2-15/month for 100-1000 MAU) makes "Option B (AI primary)" affordable. Serper kept as Tier-2 fallback so app never breaks.

4. **Don't wait for Amazon PAAPI / Awin.** PAAPI requires 10 sales / 30 days as a precondition (policy changed). Creators API has the same gate. Manual affiliate links via search URLs are good enough for now (savvey-21 tag is active on every Amazon URL).

5. **Don't manufacture sales to game PAAPI.** Coordinated artificial purchases are an Operating Agreement violation. Permanent ban risk. Wait for organic 10 sales/30 days from real users.

---

## Cost projections (verified at end of session)

Assuming 5 searches per active user per month:

| MAU | Searches/day | AI cost/month | Total infra/mo |
|---|---|---|---|
| 100 (friends) | 17 | £2 | £2 |
| 300 | 50 | £6 | £6 |
| 500 | 85 | £10 | £10 |
| 1,000 | 170 | £20 | £20 |
| 2,000 | 340 | £40 | £85 (+Vercel/Supabase Pro) |

Anthropic and Perplexity both have $5-50 minimum top-ups but small enough to be infrastructure-investment, not blocker.

---

## What's still imperfect (parked for next session)

1. **AI wit prompt — Validation mode context.** Wit currently picks `overpayingRetailer` from the result list (first non-best retailer), which can be misleading in Validation mode where the actual overpayer is the user's pasted/scanned retailer. Wit reads well anyway; refine the prompt when iterating.

2. **No cache layer yet.** Supabase cache table for AI results would cut costs 70%+ at scale. Not blocking for sub-300 MAU.

3. **Region plumbing untested.** `?region=` parameter accepted but only `uk` works currently. Wire and test for `de` etc. when expanding.

4. **OneDrive write reliability.** Write tool kept truncating `api/ai-search.js` mid-write. Workaround: write to `/tmp/` first, then `cp` to OneDrive path via bash (single atomic operation). Note for future sessions.

5. **Domain savvey.app not yet purchased** (~£15/yr Namecheap). Only matters when ready to share publicly.

6. **Scrape flow still 502s** for major retailers (Cloudflare WAF blocking Vercel IPs). Graceful URL-slug fallback in place. Real fix is paid scraping infrastructure (£50+/mo) — not justified until revenue.

---

## Next priorities (90/10 ordered)

**This week (low cost, high impact):**
1. Test with 5 friends. Measure what they do (Build-Measure-Learn loop).
2. £200 UK trademark lawyer call for clearance on Savvey + Class 9/35.
3. Tighten AI wit prompt for Validation mode context.

**Within 2 weeks:**
4. Add Supabase cache layer (24h TTL on top-100 products) to cut AI costs.
5. Plausible analytics (£9/mo) for funnel measurement.
6. Apply to Awin (the working app + AI architecture is a credible pitch).

**When you've got 100+ active users:**
7. Buy savvey.app domain (~£15/yr).
8. App Store / Google Play submission prep.
9. Press pitch: "the AI-native UK price comparison app that doesn't need affiliate APIs."

**Don't do:**
- More Serper filter tuning (we're past it — AI handles this now).
- Fight retailer WAFs without proxy infrastructure.
- Pivot to Spend.ai or similar premium domain (£50k+ — not justified).
- Manufacture Amazon affiliate sales to game PAAPI (TOS violation).

---

## Architecture diagram

```
USER SEARCH
     │
     ▼
/api/ai-search ──→ Perplexity Sonar /search (1s)
                       │
                       ▼ (snippets + URLs)
                   Claude Haiku batched extraction (1.3s)
                       │
                       ▼ (clean prices, plausibility flags)
                   UK retailer dedup
                       │
                       ▼
                 If ≥2 retailers → use AI results
                 Else            → fall back to /api/search (Serper)
                       │
                       ▼
                  Frontend renders (~2.3s end-to-end)
                       │
                       ▼ (async, non-blocking)
                  /api/ai-wit ── Claude Haiku ── (~1s)
                       │
                       ▼
                  AI wit swaps in over hardcoded fallback
```

---

## Commit chain — today's session

| Commit | Purpose |
|---|---|
| `bfb807d` (start of day) | Was at v6.10.2 — ULT WEAR blocklist + price-anomaly floor |
| `ffe7efc` | v6.11 — eBay sellers collapsed, anomaly floor 30%→50%, coverage flags |
| `af753ca` | v6.11.1 — source-only matching everywhere + retailer search URLs |
| `2b68682` | v6.12 — drop dynamic ceiling, Discovery vs Validation UI split |
| `4b3571e` | brand: shop smart. + Savvey Score + all-green logo |
| `3cda5e0` | refine search input on results screen |
| `5541306` | renderResults restores hero-actions after empty state (crash fix) |
| `a1e2134` | v6.16 — dedup prefers real URLs + scrape User-Agent fix |
| `14867f1` | URL-slug fallback when scrape WAF-blocks |
| `50bf92a` | fun: 50+ wit lines, multi-channel share, deep-link ?q= |
| `7344f7f` | AI-native v1.0: /api/ai-search + /api/ai-wit live |
| `3aa42fb` | ai-search v1.1: Haiku batched price extraction (kills regex misreads) |

12 commits across the day. Major architecture pivot. Genuinely AI-native shipped.

---

## Memory files (in user's auto-memory)

Three memory files persist across sessions:
- `MEMORY.md` — index pointing at the others
- `savvey_outstanding_bug.md` — current state, AI architecture, brand decisions, what not to revert
- `savvey_strategy_framework.md` — Vincent's 90/10 + boring-backend execution rules
- `savvey_deploy_folder_mismatch.md` — folder mount notes
- `savvey_security_rotations.md` — secret rotation reminders

All updated end-of-session for tomorrow's pickup.

---

## Brand voice reminders (still valid)

- "shop smart." — never accusatory of the user
- Currys: "Currys, more worries 😢"
- John Lewis: "aspirational pricing. As ever."
- Argos: caught-out / catalogue nostalgia
- Amazon: clever-algorithm-gone-wrong
- Never: "ripped off", "rip-off"
- Buy button always green — positive action
- AI wit pick UK-cultural reference units: Tesco meal deal, Greggs, pints, train fare, tank of petrol, Netflix sub

---

## Cost summary

**Monthly running cost as of end of session: ~£0-5/month.**
- Vercel free tier — covers current load
- Supabase free tier — price alerts table (unused at scale)
- Serper free tier — Tier-2 fallback only, well under quota
- Google CSE free 100/day — Tier-3 fallback
- Perplexity API — $50 minimum top-up, lasts months at 100 MAU
- Anthropic API — $5 minimum top-up, lasts months at 100 MAU

By 1000 MAU: ~£20-30/month total. By 2000 MAU: ~£85/month. Comfortably affordable from personal funds during bootstrap. Affiliate revenue at 2000 MAU plausibly £400-600/month — positive unit economics from month one of monetization.
