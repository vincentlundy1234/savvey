# Savvey — Session Notes
## 1st May 2026 — Engineering Session (Cowork + Claude in Chrome)

---

## Live details
- **URL:** https://savvey.vercel.app
- **GitHub:** github.com/vincentlundy1234/savvey
- **Vercel project ID:** prj_R2POD8WBfkySMOFsEbsusQayIpYc
- **Local files:** C:\Users\vince\OneDrive\Desktop\files for live\
- **Last commit deployed:** `048e3f3` — v6.8.1 frontend mapping fix

## Deploy process
```
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git add .
git commit -m "description"
git push origin master
```
Always `git push origin master` — plain `git push` has silently failed in past sessions.

---

## Headline outcome

The 36-hour-old DEMO_SCEN bug is dead. The live app now returns real data instead of the hardcoded Amazon £249 / Currys £279 / Argos £319 / John Lewis £329 demo scenario.

End-of-session live test for "Sony WH-1000XM5":
- `hasScen: true`, `bestRetailer: "eBay UK"`, `bestPrice: £89.99`
- `score: 5`, `spc: "green"`, `vTitle: "Best price."`
- Function response time ~1.5s (down from 45s+ timeout earlier in session)

---

## Eight deploys this session — what each did

### v6.4 — `7815e08`
**The actual fix to the demo-data bug.** Three edits to `index.html`:
1. `fetchPrices` now maps Serper `{source, price, link, title, delivery}` → `buildScenV3`'s expected `{retailer, price, link, sub}` shape via `matchRetailer()`. The missing mapping step was the root cause — `buildScenV3` was getting items with `retailer: undefined` for every entry, so the dedup `Set` collapsed to one undefined key, the result read as empty, and the frontend rendered DEMO_SCEN.
2. Deleted the redundant rebuild block in `showResults` that was masking the bug.
3. Hardened `skipPrice` with empty-query guard.

Plus eBay/Amazon hygiene in `api/search.js`: condition blocklist (refurb/used/spares/broken), `hardenEbayUrl()` appends `LH_ItemCondition=3`, and Serper resilience (8s timeout + one retry).

Also `goTo()` scroll-to-top, `sw.js` cache bumped v6→v7.

### v6.5 — `b2e3ebd`
Source allowlist (`trustedSourceFilter`) and expanded condition blocklist (grade b, scratched, pristine condition, dented, cracked, tested working). First version — used URL hostname matching against `TRUSTED_DOMAINS`.

### v6.5.1 — `ddd569b`
Killed all four DEMO_SCEN fallback paths in `index.html` (`buyNow`, email modal, `openShareCard`, `shareCard`). Empty state now renders honestly via new `renderNoResults(query)` instead of falling back to demo data. New `retrySearch()` button on the empty state.

### v6.6 — `73df667`
**Performance fix.** Serper timeout reduced 8s → 5s, retry removed (was compounding to 16s per call × 2 parallel = 32s, breaching Vercel's 15s function ceiling). Frontend simplified to a single `/api/search` call (the second `type:'search'` request was unused dead weight). Function went from 45s+ timeouts to ~1.5s.

### v6.6.1 — `0800cf4`
Added `?debug=1` envelope to `/api/search` exposing per-stage pipeline counts (raw/nuclear/identity/trusted/priced/final) and raw/identity samples. Crucial for diagnosing the next problem.

### v6.7 — `6503e52`
Trust filter rewritten as TLD-based (.co.uk/.uk) plus expanded `.com` allowlist. Did not work — diagnostic later revealed Serper's links are all Google aggregator URLs, so hostname matching has zero signal.

### v6.8 — `f5172eb`
**The big learning.** Serper's shopping API surfaces every result with `link = https://www.google.com/search?...`, not the actual retailer URL. The reliable signal is the `source` field (e.g., "eBay", "eBay - thirdwavediscounts", "Selfridges", "Mercari"). Trust filter rewritten to match against `TRUSTED_SOURCE_TERMS` substrings — list of UK retailer name fragments. Backend now returns 6 real eBay listings for Sony WH-1000XM5.

### v6.8.1 — `048e3f3`
Frontend `matchRetailer` mirrors the same fix: each `UK_RETAILERS` entry now has `srcTerms` (lowercase substrings to match against `source`). Added Selfridges, McGrocer, Harvey Nichols. End-to-end now works: backend returns data, frontend maps it correctly, UI shows real prices.

---

## Critical learnings to carry forward

### Serper's `link` field is useless for trust filtering
Every shopping-API result has `link = https://www.google.com/search?...` (Google aggregator URL, ~211 chars). The actual retailer URL is hidden behind that redirect. **Don't try to filter by hostname.** The retailer-name string in the `source` field is the only reliable signal. Both `search.js` (`TRUSTED_SOURCE_TERMS`) and `index.html` (`UK_RETAILERS[].srcTerms`) now match this way.

### Serper's `gl: uk` doesn't filter geographically as much as expected
For "Sony WH-1000XM5" we saw sources like Best Buy (US), wafuu.com (Japan), KS Górnik Polkowice (Polish football club!), Crutchfield (US), Shiftwave, swappa.com. Trust filter has to enumerate *positive* UK retailers; can't rely on Serper to localise.

### Vercel function timeout is the binding constraint
15s ceiling. Frontend was firing two parallel `/api/search` calls. Each call had Serper retry compounding to 16s. Net worst case: 32s — way over the limit. Now: single call, 5s Serper timeout, no retry, fall through to organic/CSE on failure.

### Pipeline order matters
`admitPrice → nuclearFilter → identityFilter → trustedSourceFilter → dynamicCeilingFilter → dedup`. Trust filter must run AFTER identity (so accessories can't anchor) and BEFORE dynamic ceiling (so untrusted-source listings can't anchor a low ceiling). Don't reorder.

### Disk-write reliability quirk
Mid-session, `api/search.js` was silently truncated on disk after a series of Edit operations. The file lost ~100 lines despite Edit tool reporting success. Recovered by reading the last good commit via `git show HEAD:api/search.js > /tmp/search_good.js`, then writing the file fresh with `Write`. **Possible cause:** OneDrive sync racing with Cowork file writes. Watch for it.

---

## Current state at end of session

| File | Version | Status |
|---|---|---|
| `api/search.js` | v6.8 | Live, returns real data, ~1.5s response |
| `index.html` | v6.8.1 | Mapping correct, empty state honest, no DEMO_SCEN fallback |
| `sw.js` | static-v11 | Forces fresh index.html on first visit |
| `vercel.json` | unchanged | 256MB / 15s |

All 8 commits pushed. Vercel deployed. Confirmed via Claude in Chrome that `048e3f3` is Current Production.

---

## What's NOT a bug but is still imperfect

**Serper UK shopping coverage is poor.** For most popular consumer products (iPhone, Samsung TV, Dyson, Nintendo Switch, AirPods, air fryers), Serper returns mostly US/global marketplaces with occasional UK hits. Currys/Argos/JL/AO almost never surface. Sony WH-1000XM5 returned only eBay listings — no major UK retailer hits. This is a Serper data limitation, not a code bug.

**The £89.99 eBay "best price"** for Sony WH-1000XM5 is a mis-listed Sony ULT WEAR (different cheaper product). Identity filter passed it because "WH-1000XM5" appears in the title. Worth adding negative keywords (e.g., reject if title contains "ult wear" alongside WH-1000XM5).

**Selfridges and McGrocer hits get rejected by identity filter** when their titles drop the brand prefix ("WH-1000XM5 noise-cancelling headphones" lacks "Sony"). Consider: if all numeric tokens match verbatim, lower text-token threshold from 60% to 40% — model numbers are highly identifying on their own.

**Result screen shows only one retailer entry** when all hits are from the same source (e.g., all eBay variants collapse to "eBay UK £90"). No comparison context for the user.

---

## Next priorities (in order)

1. **Apply for Awin Product Feed.** This is the structural fix for UK retailer coverage. `AwinProductProvider` class is already wired in `search.js` — the moment `AWIN_API_KEY` lands in Vercel env vars, Awin becomes the primary source and Serper becomes fallback. Awin needs a working domain to apply.

2. **Buy savvey.app domain.** Namecheap or Porkbun, ~£15/year. Required for Awin and Amazon Associates applications.

3. **Connect domain to Vercel** — CNAME in DNS, update `ALLOWED_ORIGIN` env var to `https://savvey.app`.

4. **Apply to Amazon Associates** — provisional access usually instant.

5. **Apply to Awin** — needs live domain + working results.

6. **Rotate SERPER_KEY and Supabase anon key** — both were exposed in chat over the past few days. Do this before any wider distribution.

---

## Technical reference for next Claude session

### Pipeline (search.js v6.8)
```
Awin (if AWIN_API_KEY) + Serper + CSE
  → admitPrice (intake, hard ceiling £5,000)
  → nuclearFilter (belt + braces)
  → identityFilter (accessory blocklist + 60% text token + 100% numeric token)
  → trustedSourceFilter (TRUSTED_SOURCE_TERMS substring match on source)
  → dynamicCeilingFilter (lowest × 4, skipped if <3 items)
  → dedup (cheapest per source)
  → response { shopping[], _meta, _debug? }
```

### Key constants (search.js)
- `PRICE_CEILING_HARD = 5000`
- `PRICE_FLOOR = 0.50`
- `PRICE_MULTIPLIER = 4`
- `DYNAMIC_MIN_RESULTS = 3`
- `CONFIDENCE_THRESHOLD = 0.60`
- `SERPER_TIMEOUT_MS = 5000`

### Debug envelope
POST `/api/search` with body `{ q: "…", type: "shopping", debug: true }` returns `_debug: { counts: { raw, nuclear, identity, trusted, priced, final }, rawSample[12], identitySample[12] }`. Use this for diagnosing zero-result queries instead of crawling Vercel function logs.

### Frontend functions (index.html)
- `globalReset()` — first act of every search path
- `fetchPrices(query)` — single `/api/search` call, AbortController, generation guard
- `showResults(promise)` — awaits promise, generation re-check, renders OR calls `renderNoResults`
- `renderNoResults(query)` — clean empty state with retry button
- `retrySearch()` — restores DOM and refires
- `matchRetailer(input)` — URL match first, falls back to source-name substring via `srcTerms`
- `buildScenV3(items, uPrice, query)` — final result builder

### Vercel env vars
- `SERPER_KEY` ⚠️ ROTATE
- `GOOGLE_CSE_KEY`
- `GOOGLE_CSE_CX = c705dc5e7509f4982`
- `ALLOWED_ORIGIN = https://savvey.vercel.app`
- `AWIN_API_KEY` — not set; activates Awin automatically when added

### Brand voice reminders
- "spend smart." — never accusatory
- Currys gets a hard time ("Currys, more worries 😢")
- John Lewis = "aspirational pricing. As ever."
- Never: "ripped off", "rip-off"
- Buy button always green — positive action

---

## Cost summary
**£0/month running cost** — Vercel free, Supabase free, Serper free tier, Google CSE free 100/day.
