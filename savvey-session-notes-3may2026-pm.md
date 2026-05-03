# Savvey — 3 May 2026 PM session notes

## What shipped (ready to push)

### Wave 98 — zero-hit fallback (ai-search.js v1.15 → v1.16, sw v98 → v99)

The Wave 86 cordless vacuum regression that yesterday's notes flagged as TOP PRIORITY was traced to an early-return at `ai-search.js:728`:

```js
const hits = gatherRetailerHits(raw, q);
if (hits.length === 0) {
  return res.status(200).json({ shopping: [], _meta: {...} });
}
```

The bug: Wave 97 added a comparison-angle top-up (`${q} review price comparison UK 2026 cheapest`) but it only fired AFTER Haiku, when `items.length < 3`. Generic queries — "cordless vacuum cleaner", "kettle", "air fryer" — fail at the first hurdle: Perplexity returns review articles (Which?, Trusted Reviews) with no retailer-product URLs, gatherRetailerHits filters everything out, hits=0, and we return without ever trying the comparison angle.

Fix: when `hits.length === 0`, fire the comparison query before declaring no results. `usedFallback` flag in `_meta` shows when this fires. ~$0.005 extra Perplexity cost only on zero-hit cases (rare).

To deploy:
```
cd "C:\Users\vince\OneDrive\Desktop\files for live"
git add .
git commit -m "Wave 98: zero-hit fallback rescues generic-category queries"
git push origin master
```

## Battery test findings on live v98 (pre-Wave 98)

| Query | Result | Status |
|---|---|---|
| AirPods Pro 2 | Argos £169 (verified) | GREEN |
| Sony WH-1000XM5 | JL £229, 3 retailers | GREEN |
| Stanley flask 750ml | JL £52 | GREEN (snippet kept) |
| KitchenAid stand mixer | Argos £379 (drift override fired £349→£379) | GREEN |
| iPhone 17 | Apple £799 (drift cap rejected £26.63 finance number) | GREEN |
| Birkenstock Boston | Very £96 | GREEN |
| Le Creuset casserole | JL £149 (qm:similar) | AMBER — honest about loose match |
| Bose QC Ultra | JL £199 (qm:similar — likely QC45) | AMBER — wrong-product risk |
| Garmin Forerunner 265 | JL £329, verify exception_AbortError 8s | AMBER — JL slow |
| GHD Platinum+ | JL £199, verify exception_AbortError 8s | AMBER — JL slow |
| Kettle | Argos £40 snippet, live £60, drift cap rejected | RED — inverse drift bug |
| Air fryer | Argos £60, upstream_404 | RED — URL dead |
| Cordless vacuum cleaner | 0 hits | RED → fixed by Wave 98 |

13/14 specific products land plausibly. Generic-category queries are where the system breaks — and Wave 98 directly addresses that.

## Outstanding bugs (still open after Wave 98 push)

### Drift cap is bidirectional (kettle £40 case)
Snippet £40, live £60, drift 50%, drift cap rejected the verification because >30% drift normally means extractor matched the wrong number (iPhone 17 finance £26.63). Here the snippet was the stale one. Boolean cap can't distinguish.

**Streamline**: replace cap with one Haiku tiebreaker call:
> "Snippet says £40, live page extracted £60. For [product], which number is the actual current price? Reply with just the price or 'unknown'."

One $0.0002 call resolves both directions correctly. Kills the inverse bug AND keeps the iPhone protection.

### JL verification timeouts (Garmin, GHD, Stanley)
Even at 8s, JL pages with heavy JS sometimes don't return body in time. Bumping further pushes against the 15s Vercel ceiling.

**Streamline (Path 1)**: replace live-page scrape with Perplexity URL verification:
> "What is the current UK price shown on this page: {url}? Reply with just the price."

Costs ~$0.005, handles JL slowness, Apple multi-variant, Birkenstock 403, Argos 404 — all in one consistent call. Removes 9 retailer-specific regex extractors + browser-header spoofing + timeout management.

### qm:similar hits surface as cheapest
Bose QuietComfort Ultra (£349 retail) returned JL £199 graded `qm:similar` — likely the previous-gen QC45. We surface it as the cheapest match.

**Fix**: in the sort, demote `qm:similar` below `qm:exact` regardless of price. Only show "similar" hits when there's no exact match.

### Wave 86 cordless vacuum (FIXED in Wave 98 — verify post-push)

## Highest-impact next move

Ship Wave 99: **Path 1 Perplexity URL verification** replacing the live-scrape rig. One change addresses (a) JL timeouts, (b) Apple multi-variant catastrophic mis-extraction, (c) Birkenstock 403 / Argos 404, (d) the kettle drift inverse-bug (Perplexity sees the actual page, not a regex match).

Estimated effort: 1-2 hours. Estimated impact: kills 4-6 separate failure modes with one architectural simplification.

## End-of-session reflection (per saved memory pattern)

**1. Are we doing the correct things to progress to in-store / on-product → fair-price verdict in 30s?**

Mostly yes. The mission is "fair-price verdict in 30s on the shop floor." Today's Wave 98 fixes the worst symptom of generic queries (zero results), which is exactly the failure mode that would lose a user mid-aisle. But we're still patching with regex and retailer-specific code when one Perplexity call replaces three of those patches at once. We should be moving toward fewer, smarter calls.

**2. What's working well right now?**

- Tier 1 Perplexity carries the load reliably for specific products (13/14 in battery returned plausible cheapest)
- Drift override mechanism is the single best feature — KitchenAid £349→£379 caught live, AirTag £35→£29 caught yesterday
- Drift cap correctly rejected iPhone 17's £26 finance-number disaster
- Haiku query_match grading flagged Le Creuset and Bose Ultra as `similar` — system was honest even when wrong
- Wave 96 economy mode is keeping Tier 2 quiescent while Serper is at -42 credits

**3. Where could things work better / more efficiently?**

- **One Perplexity URL-verification call replaces 9 retailer regex extractors + headers + timeouts.** This is the biggest architectural win available.
- **Drift cap should be a Haiku tiebreaker, not a boolean.** Saves us from the kettle-style inverse bug.
- **qm:similar hits should sort below qm:exact.** Stops the Bose QC Ultra → QC45 confusion.
- **Generic-category coverage** is now half-fixed by Wave 98 fallback — needs verification post-push.
- **JL pages are pathologically slow** for verification — at 8s budget we still hit AbortError repeatedly. Live-scrape is the wrong tool for these.

**4. Where could AI replace or simplify a stack of patches we've added?**

Three concrete swaps, in order of impact:

1. **Perplexity URL verification** replaces the live-scrape rig (4+ failure modes addressed at once)
2. **Haiku tiebreaker** replaces boolean drift cap (kills inverse bug)
3. **Haiku-curated retailer list** could replace the 25-retailer hardcoded list — let it pick the 5-6 best retailers for THIS query (sportswear → JD/Decathlon/Sports Direct, not Argos/Currys)

We have ~14 patches in the search pipeline. AI-native architecture would be 3-4 well-defined calls. The cost would actually drop (~$0.022 → ~$0.012 per search) while reliability improves.

**Anything I'm not flagging?**

- **Serper is still at -42 credits.** We're running on Tier 1 only. If Perplexity has a bad day, Wave 96 circuit breaker keeps app stable but coverage degrades. Worth deciding: top up Serper for resilience, or accept Perplexity-only and put effort into Tier 1 quality.
- **No retailer list curation per category.** Searching "kettle" surfaces the same 25 retailers we'd hit for a TV. Lakeland or Robert Dyas would be more useful for kitchen.
- **The CLAUDE.md "shop smart" tagline rename** (2 May) doesn't appear consistently — worth a sweep.
- **Kettle £40 still showing wrong** post-push — Wave 98 fixes the zero-hit case but doesn't touch the drift-inverse bug. Highest user-visible bug after Wave 98 lands.

## Summary

Battery passed 13/14 on specific products. Wave 98 patches the generic-category zero-hit failure that was Wave 86's open regression. Three streamlining opportunities documented for the next session, with Path 1 (Perplexity URL verification) as the highest-impact single change available.
