# Savvey session notes — 3 May 2026 (PM)
## Iterations 1, 2, 3 — foundation laid

**Outcome:** 14 deploys (v1.30 → v1.40, sw v118 → v129). Iteration 1 substantially complete; Iteration 2 backend complete; Iteration 3 foundation in place. Frontend wires up next session.

---

## Architecture as of v1.40

The price-search pipeline went from a fragile keyword-only routing system to a coherent **discover / validate / safety-net** architecture:

```
[Request]
    ↓
   ┌─────────────────────────────────────┐
   │ Sonar Pro (chat/completions)        │  ← Discovery layer
   │  - structured json_schema output     │
   │  - search_context_size: high         │
   │  - 9s timeout                        │
   │  - returns 5-8 retailers + prices    │
   └────────────┬────────────────────────┘
                │ chained:
                ↓
   ┌─────────────────────────────────────┐
   │ validateSonarPro (Haiku)            │  ← Validation layer
   │  - HAIKU_EXTRACT_SYSTEM_PROMPT       │
   │  - Wave 102 price-tier sanity        │
   │  - drops implausible-low (refurb)    │
   └────────────┬────────────────────────┘
                │
                ↓ in parallel with ↓
   ┌─────────────────────────────────────┐
   │ fetchPerplexitySearch (Search quad) │  ← Safety net
   │  - regex/AI category routing         │
   │  - aiCategoryLock for long-tail      │
   │  - admits AI-suggested hosts         │
   │  - extractPricesViaHaiku grades      │
   └────────────┬────────────────────────┘
                │
                ↓ merge by URL/host (lower price wins)
                ↓
   [verifyUrls + dedup + verifyLivePrice + reasoning + confidence]
                ↓
              [response]
```

---

## Iteration 1 — accuracy & consistency (Wave 200 + 201 chains)

The core problem: long-tail queries returned 0-1 results. Sennheiser HD 660S, Wahoo Kickr Core, Rado Captain Cook, Sage Bambino all failed yesterday. Now they all return 3-8 verified retailers.

### Wave 200 series — long-tail routing (5 deploys)
- **200**: aiCategoryLock — Haiku picks 5-7 UK retailer hosts when no regex matches. Long-tail queries (Wahoo Kickr, Rado, Sennheiser) get specialist routing instead of broad UK_RETAILERS dump.
- **200b**: synthetic-retailer admission — gatherRetailerHits accepts URLs from AI-suggested hosts even when not in UK_RETAILERS. Fixes the "Pro suggested wiggle.co.uk but it wasn't registered" class.
- **200c**: keyword regex fixes — `wahoo`/`kickr`/`garmin edge`/`turbo trainer` moved from SPORTS to BIKE. Sigma Sports + Cyclestore added to BIKE_HOSTS.
- **200d**: bike specialist URL patterns + loosened generic admission (.htm + trailing _NNNN IDs). Tredz Wahoo URLs now admit.
- **200e**: TRUSTED_NO_HEAD expanded to bike specialists. verifyUrls accepts 405/429 (HEAD not allowed / rate limited). Tredz Kickr Core hit no longer dropped at HEAD verification.

### Wave 201 series — Sonar Pro structured replacement (4 deploys)
- **201a**: `fetchSonarPro` opt-in probe via `sonar_pro:true` body flag. Surfaced in `_debug.sonarPro` for evaluation. Confirmed: Sennheiser HD 660S returned 8 structured products vs 0 from Search API. Validated promise.
- **201b**: Promoted Sonar Pro to PRIMARY. Parallel + merge with Search quad (Vincent's Option B call). Sonar Pro items skip Haiku extraction (already structured) and bypass HEAD verify (Pro confirmed in_stock during search).
- **201c**: Haiku price-tier sanity re-grade for Sonar Pro products. Caught Sennheiser UK £166 outlier (refurb at <30% MSRP). Haiku is now the universal quality gate across both paths.
- **201d**: 504 hotfix — Sonar Pro timeout dropped 13s → 9s; validateSonarPro chained INTO sonarProPromise so it overlaps Search quad instead of running serially. Net latency back under 13s.

### Iteration 1 battery (v1.38, post-200/201)
| Query | Before today | After v1.38 | Latency |
|---|---|---|---|
| Sennheiser HD 660S | 0 retailers | **3** valid (£349-£399) | 10.7s |
| Wahoo Kickr Core | 1 (Tredz only) | **3-5** retailers | 9.8s |
| Sage Bambino | 3 retailers | **6** retailers, cheaper found | 8.3s |
| Rado Captain Cook | 0 | **1** verified (£1,820) | 10s |

---

## Iteration 2 — useful context (Wave 210/211/213 — single deploy)

Backend additions to `_meta`:
- **210**: `reasoning` — Haiku-generated 1-sentence price-landscape line. Examples shipped:
  - `"All four retailers stock the HD 660S2 variant, ranging from £329.99 to £399, with HBH Woolacotts offering the lowest price."`
  - `"The Sage Bambino ranges from £297.99 to £329 across four retailers, with The Kitchen Draw Store offering the lowest price."`
- **211**: `shopping[].in_stock` — pass-through from Sonar Pro structured output. `true`/`false`/`null` (Search quad items return null).
- **213**: `confidence` — derived from query_match distribution of top 3. `high` (all exact) / `medium` (mix) / `low` (all similar) / `none`. Sennheiser HD 660S query → confidence `low` because results are HD 660S2 (similar, not exact).

Latency-safe: `generateReasoningLine` kicked off in parallel with `verifyLivePrice`, awaited just before response build. No incremental wall-time in common case. Cost ~$0.0005/query.

**Frontend wire-up pending**: Reasoning line above results, stock badges, confidence-aware copy (e.g. "Compared against similar products" when confidence=low).

---

## Iteration 3 — shop assistant foundation (Wave 220 — single deploy)

Backend accepts:
```json
{ "q": "Sennheiser HD 660S",
  "refine": { "previous_query": "Sennheiser HD 660S",
              "refinement_text": "show cheaper, in stock only" } }
```

Sonar Pro prompt incorporates the refinement contextually. Cache key includes refinement (independent from bare-query cache). Response echoes `_meta.refine: {applied, text}`.

**Frontend wire-up pending**: Small "Refine results" input below the result list. Submit calls `/api/ai-search` with `refine` payload. New reasoning line + refined results re-render.

---

## Where Iteration 3 picks up

Future-features parking lot remains intact (memory: `savvey_future_features.md`):
- **221** voice input (MediaRecorder + Whisper transcription) — bigger lift, separate session
- **222** personalised anchor (preferred retailers, max price, brand affinities) — needs persistence
- **223** drop alerts (daily Haiku check + notification) — needs Vercel cron + Supabase tables

Plus Iteration 1 backlog (lower priority now):
- **204** GTIN cross-retailer SKU verification
- **205** drift verify on top 3-5 results, not just cheapest

---

## Cost & latency snapshot

| Per-query cost | v1.40 (Iteration 1+2+3 combined) |
|---|---|
| Sonar Pro chat completion | $0.020-0.025 |
| Haiku validate (Sonar Pro products) | ~$0.0005 |
| Haiku extract (Search quad hits) | $0.001-0.002 |
| Search API quad (broad+amazon+category, conditional loose) | $0.015-0.020 |
| Haiku reasoning line | ~$0.0005 |
| verifyLivePrice (Perplexity Search) | $0.005 |
| Serper Images | $0.0005 |
| **Total** | **~$0.045/query** |

Latency budget: typical 8-11s, peak ~13s on slow Sonar Pro responses. Well under Vercel 15s ceiling.

Cost-per-query went up vs yesterday (~$0.025 → ~$0.045) but cost-per-USEFUL-result improved dramatically — long-tail queries returning 0 yesterday now return 3-8 verified retailers. Vincent's Option B parallel-merge call validated.

---

## Decisions captured to memory

- **Cost-vs-reliability**: Vincent picks parallel+merge over timeout-fallback. Cost-per-useful-result framing wins. Default to reliability-first in pipeline architecture. (`savvey_cost_vs_reliability.md`)
- **AI estimate panel design pattern** — kept untouched (`savvey_ai_estimate_pattern.md`)
- **90/10 strategy framework** — kept untouched (`savvey_strategy_framework.md`)
