// api/ai-estimate.js — Savvey AI Price Estimator v1.0
//
// When the price-search pipeline returns no usable retailers (future
// products like "iPhone 17", obscure niche items, AI mis-IDs), this
// endpoint asks Claude Haiku 4.5 to estimate a typical UK price range
// for the product family. The frontend renders that as an "AI estimate"
// panel with retailer search shortcuts so the user always gets value.
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

const VERSION    = 'ai-estimate.js v1.0';
const ORIGIN     = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL              = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS         = 4000;
const MAX_TOKENS         = 280;
const RATE_LIMIT_PER_HOUR = 30;

const SYSTEM_PROMPT = `You are Savvey, a UK price-comparison app. The user searched for a product but our retailer-price pipeline came up empty. They could have typed an unreleased product (iPhone 17 before launch), a niche item, or a mis-identified Snap. Your job: give them a useful "AI estimate" panel of what this thing typically costs in the UK so they still get value from the search.

Output: ONLY a JSON object, no preamble, no markdown, no commentary:
{
  "family": "iPhone Pro" | "wireless headphones" | "kitchen mixer" | ...,
  "typical_low": 999,
  "typical_high": 1499,
  "typical_avg": 1199,
  "confidence": "high" | "medium" | "low",
  "reasoning": "Apple Pro tier consistently launches at £999-£1,199 with 256GB; previous generation £1,499 at top spec.",
  "closest_comparable": "iPhone 16 Pro 256GB" | null,
  "buy_retailers": ["Apple", "Argos", "Currys", "John Lewis"],
  "future_release": true | false
}

Rules:
- Prices are GBP, integer. Use the typical UK retail price range — not heavily-discounted clearance, not premium-tier maximum.
- typical_avg sits inside [typical_low, typical_high].
- Family is a short product-class label the user would recognise.
- Confidence: "high" when product class is well-known and stable in pricing; "medium" when range is wide; "low" when query is too vague to estimate.
- Reasoning: ONE sentence, max 25 words. Cite a comparable real product or retail anchor where helpful.
- closest_comparable: a specific real product name the user could SEARCH to get a real comparison. null if too generic.
- buy_retailers: 2–4 UK retailers most likely to stock this. Pick from: Apple, Amazon UK, Argos, Currys, John Lewis, AO, Very, Box, Halfords, Tesco, Sainsbury's, B&Q, Wickes, Toolstation, Boots, Superdrug, eBay UK.
- future_release: true if the query refers to an unreleased product (e.g. "iPhone 17" when 16 is current); false otherwise.

If the query is genuinely uninterpretable (random characters, gibberish), respond:
{ "family": null, "confidence": "low", "reasoning": "Couldn't identify a product class from this query." }`;

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
        system:     SYSTEM_PROMPT,
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
