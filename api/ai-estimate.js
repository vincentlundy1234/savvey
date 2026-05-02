// api/ai-estimate.js — Savvey AI Price Estimator v1.1
//
// When the price-search pipeline returns thin coverage (future products,
// niche items, AI mis-IDs, fewer than 3 retailers), this endpoint asks
// Claude Haiku 4.5 to estimate a typical UK price range for the product
// family. The frontend renders that as an "AI estimate" panel with
// retailer search shortcuts so the user always gets value.
//
// v1.1 (Wave 67) — current-date anchoring. Haiku's pre-training cutoff
// would otherwise make it claim "iPhone 17 unreleased" in May 2026,
// seven months after the actual launch. We now pass today's date and
// force Haiku to assume products are released unless it has positive
// evidence otherwise. Also tightened the "say so plainly" rule for
// uncertain queries — better to admit a low confidence than fabricate
// a Pro-tier price for a base-tier query.
//
// Cost: ~£0.001 per call. Only fires on no-results, so utilisation is
// bounded by the empty-state rate (single-digit percent of searches).
//
// Hardening parity with ai-search.js / ai-wit.js:
//   - applySecurityHeaders from _shared
//   - rate limit 30/IP/hour via _rateLimit
//   - circuit breaker on Anthropic via _circuitBreaker
//   - 4s timeout

import { applySecurityHeaders } from './_shared.js';
import { rejectIfRateLimited }  from './_rateLimit.js';
import { withCircuit }          from './_circuitBreaker.js';

const VERSION    = 'ai-estimate.js v1.1';
const ORIGIN     = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL              = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS         = 4000;
const MAX_TOKENS         = 280;
const RATE_LIMIT_PER_HOUR = 30;

// Build the system prompt with TODAY'S date anchored. Haiku's training
// cutoff is months behind the live world, so we explicitly tell it the
// current date and force it to assume products are released unless it
// has positive evidence otherwise. Vincent's iPhone 17 case (May 2026,
// seven months post-launch) was being labelled "unreleased" because
// Haiku defaulted to its training-snapshot worldview.
function buildSystemPrompt(){
  const today = new Date();
  const todayStr = today.toISOString().slice(0,10); // YYYY-MM-DD
  const yearStr  = String(today.getUTCFullYear());
  return `You are Savvey, a UK price-comparison app. Today's date is ${todayStr} (${yearStr}). The user searched for a product but our retailer-price pipeline returned thin or no coverage. Your job: give them a useful AI estimate of what this product typically costs in the UK so they still get value from the search.

Output: ONLY a JSON object, no preamble, no markdown, no commentary:
{
  "family": "iPhone (base)" | "wireless headphones" | "kitchen mixer" | ...,
  "typical_low": 799,
  "typical_high": 999,
  "typical_avg": 849,
  "confidence": "high" | "medium" | "low",
  "reasoning": "iPhone 17 base launched £799 in September 2025; mid-storage tiers cluster £849–£899 across UK retailers.",
  "closest_comparable": "iPhone 17 256GB" | null,
  "buy_retailers": ["Apple", "Argos", "Currys", "John Lewis"],
  "future_release": false
}

CRITICAL DATE RULES:
- Today is ${todayStr}. Anything that has launched on or before this date IS RELEASED. Do not fabricate "unreleased" status because the product is past your training cutoff.
- For Apple: assume iPhone 17 / iPhone 17 Pro / iPhone 17 Pro Max launched September 2025, iPhone 18 expected September ${yearStr}. If asked about iPhone 17 in ${yearStr}, it is RELEASED.
- For Samsung Galaxy S: assume Galaxy S25 launched January 2025, Galaxy S26 expected January ${yearStr}.
- If you genuinely cannot tell whether a product is released yet, say so plainly in the reasoning ("Outside my training data — estimate based on prior generation pricing") and set confidence:"low". Do NOT default to future_release:true unless you're confident it's unreleased.

PRICING RULES:
- Prices are GBP, integer. Use the typical UK retail price for the SPECIFIC tier the user named — not a Pro tier when they asked for the base, not a base when they asked for Pro Max.
- "iPhone 17" alone means BASE iPhone 17, not Pro. Base iPhone launches at £799–£849 depending on storage. Do not return Pro pricing (£999+) for an "iPhone 17" query.
- Same logic for "Galaxy S26" (base, not Ultra), "MacBook Air" (not Pro), etc.
- typical_avg sits inside [typical_low, typical_high].
- Family is a short product-class label the user would recognise.

CONFIDENCE RULES:
- "high" — product class is well-known, pricing stable, you're confident on tier.
- "medium" — range is wide or you're uncertain on tier.
- "low" — query is too vague, gibberish, or you can't estimate. Set future_release based on what you actually know, not as a hedge.

REASONING:
- ONE sentence, max 28 words. Cite a real product or retail anchor.
- If the product is past your training cutoff, say so plainly. Don't fabricate a launch date.

closest_comparable: a specific real UK-buyable product name the user could SEARCH to get a real comparison. null if too generic.
buy_retailers: 2–4 UK retailers most likely to stock this. Pick from: Apple, Amazon UK, Argos, Currys, John Lewis, AO, Very, Box, Halfords, Tesco, Sainsbury's, B&Q, Wickes, Toolstation, Boots, Superdrug, eBay UK.

If the query is genuinely uninterpretable (random characters, gibberish), respond:
{ "family": null, "confidence": "low", "reasoning": "Couldn't identify a product class from this query." }`;
}

async function callAnthropic(userPrompt, apiKey) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system:     buildSystemPrompt(),
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw Object.assign(new Error('Anthropic error'), { status: r.status, body: txt.slice(0, 200) });
    }
    const data = await r.json();
    const blocks = (data && data.content) || [];
    return blocks.filter(b => b && b.type === 'text').map(b => b.text || '').join(' ').trim();
  } finally { clearTimeout(timer); }
}

function tryParseJson(raw) {
  if (!raw) return null;
  let t = String(raw).trim();
  // Strip markdown fences if Haiku wrapped the JSON
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  // Find the first { ... } block
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export default async function handler(req, res) {
  applySecurityHeaders(res, ORIGIN);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  if (rejectIfRateLimited(req, res, 'ai-estimate', RATE_LIMIT_PER_HOUR)) return;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'anthropic_not_configured' });

  const { product } = req.body || {};
  if (!product || typeof product !== 'string') {
    return res.status(400).json({ error: 'missing_product' });
  }
  const trimmed = product.trim().slice(0, 120);
  if (trimmed.length < 2) return res.status(400).json({ error: 'product_too_short' });

  const userPrompt = `Query: "${trimmed}"\n\nReturn the AI estimate JSON now.`;

  try {
    const raw = await withCircuit('anthropic',
      () => callAnthropic(userPrompt, ANTHROPIC_KEY),
      { onOpen: () => '{}' }
    );
    const parsed = tryParseJson(raw);
    if (!parsed) {
      console.warn(`[${VERSION}] "${trimmed}" → unparseable response: ${raw.slice(0, 120)}`);
      return res.status(200).json({ estimate: null, error: 'parse_failed' });
    }
    // Sanity-clamp the numbers — Haiku occasionally returns silly values.
    const lo = Number(parsed.typical_low);
    const hi = Number(parsed.typical_high);
    const avg = Number(parsed.typical_avg);
    const safe = {
      family: typeof parsed.family === 'string' ? parsed.family.slice(0, 60) : null,
      typical_low:  Number.isFinite(lo)  && lo  > 0 && lo  < 100000 ? Math.round(lo)  : null,
      typical_high: Number.isFinite(hi)  && hi  > 0 && hi  < 100000 ? Math.round(hi)  : null,
      typical_avg:  Number.isFinite(avg) && avg > 0 && avg < 100000 ? Math.round(avg) : null,
      confidence:   ['high','medium','low'].includes(parsed.confidence) ? parsed.confidence : 'low',
      reasoning:    typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 220) : '',
      closest_comparable: typeof parsed.closest_comparable === 'string' ? parsed.closest_comparable.slice(0, 80) : null,
      buy_retailers: Array.isArray(parsed.buy_retailers) ? parsed.buy_retailers.filter(s => typeof s === 'string').slice(0, 6) : [],
      future_release: !!parsed.future_release,
    };
    console.log(`[${VERSION}] "${trimmed}" → ${safe.family} £${safe.typical_low}-${safe.typical_high} (${safe.confidence})`);
    return res.status(200).json({ estimate: safe, model: MODEL });
  } catch (e) {
    console.error(`[${VERSION}] error:`, e.message);
    return res.status(200).json({ estimate: null, error: e.message });
  }
}
