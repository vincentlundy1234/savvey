// api/normalize.js — Savvey v3.3 Smart Router backend
//
// THE PIVOT (4 May 2026):
// v2.x ran a 5-stage probabilistic pipeline (Sonar + Triage + validate +
// extract). It was fragile, expensive, slow. We KILLED it.
//
// v3.0 architecture: 4 input "doors" → ONE normalization call → smart
// deep-link CTAs. No scraping, no Sonar, no Serper, no validate, no extract.
//
// v3.2 (4 May 2026 PM): SerpAPI-verified Amazon UK price baked into the
// Amazon CTA (Trust Hook). Diagnostic _meta surfaces SerpAPI status.
//
// v3.3 (5 May 2026): Panel Move 1 + Move 2 + savvey_says enrichment.
//   - Move 1 (Filter Optimization): Amazon listing classifier
//     (official | marketplace | warehouse). Primary CTA = official storefront
//     price; warehouse/used captured separately as used_amazon_price for
//     savvey_says. Marketplace only as fallback when no official listing.
//   - Move 2 (Diagnostic Sunset): verified_amazon_key_prefix removed from
//     _meta. verified_amazon_status retained for one more sprint while we
//     monitor SerpAPI quota / failure modes.
//   - savvey_says enrichment: when verified_amazon_price is present, attach
//     live_amazon_price (factual, anchored) and used_amazon_price (when
//     warehouse listing found). Frontend gating loosens to render the block
//     whenever ANY savvey_says field is present, including the verified anchors.

import { applySecurityHeaders } from './_shared.js';
import { rejectIfRateLimited }  from './_rateLimit.js';
import { withCircuit }          from './_circuitBreaker.js';
import crypto                   from 'node:crypto';

const VERSION             = 'normalize.js v3.4.5v74';
const ORIGIN              = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';
const ANTHROPIC_ENDPOINT  = 'https://api.anthropic.com/v1/messages';
const MODEL               = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS          = 8000;
const MAX_TOKENS_VISION   = 380; // Wave II
const MAX_TOKENS_TEXT     = 320; // Wave II
const RATE_LIMIT_PER_HOUR = 60;
const MAX_IMAGE_BYTES     = 4 * 1024 * 1024;
const KV_TTL_SECONDS      = 86400;
const KV_TIMEOUT_MS       = 1500;

let _kv = null;
let _kvFailed = false;
async function _getKv() {
  if (_kvFailed) return null;
  if (_kv) return _kv;
  try {
    const mod = await import('@vercel/kv');
    _kv = mod.kv;
    return _kv;
  } catch (e) {
    _kvFailed = true;
    return null;
  }
}
async function kvGet(key) {
  const kv = await _getKv();
  if (!kv) return null;
  try {
    return await Promise.race([
      kv.get(key),
      new Promise((r) => setTimeout(() => r(null), KV_TIMEOUT_MS)),
    ]);
  } catch { return null; }
}
async function kvSet(key, value, ttl) {
  const kv = await _getKv();
  if (!kv) return;
  try { await kv.set(key, value, { ex: ttl }); } catch {}
}

// V.52 — bump this prefix to invalidate all KV cache entries (e.g. when a
// fix changes the response shape or fixes a data bug). Old entries become
// unreachable; new entries get the new salt.
const CACHE_PREFIX = 'sav-v56';

function cacheKey(inputType, payload) {
  const h = crypto.createHash('sha256');
  h.update(CACHE_PREFIX);
  h.update('|');
  h.update(inputType);
  h.update('|');
  if (inputType === 'image') {
    // Wave FF — hash all frames (or single image) so multi-shot requests get a
    // stable, request-unique cache key. Without this, every frames request
    // hashes to the same key and cache is poisoned.
    const frames = Array.isArray(payload.image_base64_frames) ? payload.image_base64_frames : null;
    if (frames && frames.length > 0) {
      for (const f of frames) h.update(typeof f === 'string' ? f : '');
    } else {
      h.update(payload.image_base64 || '');
    }
  } else if (inputType === 'url') {
    h.update(String(payload.url || '').trim().toLowerCase());
  } else if (inputType === 'barcode') {
    h.update(String(payload.ean || '').trim().replace(/\D/g, ''));
  } else {
    h.update(String(payload.text || '').trim().toLowerCase());
  }
  // Wave FF cache key bump: ensures pre-FF cached entries miss + re-fetch with
  // specificity flag and retailer_deep_links populated.
  return 'savvey:normalize:v3_kk2:' + h.digest('hex').slice(0, 24);
}

const COMMON_SCHEMA_DOC = `Return ONLY this JSON, no preamble, no markdown fences:
{
  "canonical_search_string": "Ninja AF400UK" | "Bose QuietComfort 45" | "Apple iPhone 15 128GB",
  "confidence": "high" | "medium" | "low",
  "alternative_string": "Ninja AF300UK" | null,
  "alternatives_array": ["Russell Hobbs Velocity 26480", "Smeg KLF03", "Tefal Avanti Classic 1.7L"] | [],
  "alternatives_meta": [
    {"typical_price_gbp": 24.99, "pack_size": "1.7L", "tier_label": "Mid-tier"},
    {"typical_price_gbp": 169.00, "pack_size": "1.5L", "tier_label": "Premium"},
    {"typical_price_gbp": 19.99, "pack_size": "1.7L", "tier_label": "Budget"}
  ] | [],
  "category": "tech" | "home" | "toys" | "diy" | "beauty" | "grocery" | "health" | "generic",
  "mpn": "AF400UK" | "QC45" | null,
  "amazon_search_query": "AF400UK" | "Bose QuietComfort 45",
  "savvey_says": {
    "timing_advice": "Buy now, price is stable" | "Wait — Prime Day deals likely" | null,
    "consensus": "Excellent air fryer, but huge footprint." | null,
    "confidence": "high" | "medium" | "low"
  }
}

Field rules:
- canonical_search_string: cleanest brand + family + model.
- confidence: "high" if certain on brand+model+category. "medium" if model ambiguous. "low" if unclear.
- alternative_string: ONLY when confidence < high. NULL when high.
- alternatives_array: 0-3 ADDITIONAL plausible product candidates. Two cases:
  (a) MEDIUM confidence on a specific product: list specific variants of the canonical (different model numbers, sizes, sub-families). Example: canonical "Apple iPhone 15 128GB" -> alternatives_array ["Apple iPhone 15 Plus", "Apple iPhone 15 Pro", "Apple iPhone 15 Pro Max"].
  (b) LOW confidence on a vague brand+category query: list 3 POPULAR UK products in that category. Use concrete model names a UK shopper would recognise. Example: canonical "Logitech mouse" -> alternatives_array ["Logitech MX Master 3S", "Logitech M185", "Logitech G502 HERO"]. Example: canonical "Kettle" -> alternatives_array ["Russell Hobbs Velocity 26480", "Smeg KLF03", "Tefal Avanti Classic 1.7L"].
  Empty array [] ONLY when you genuinely can't suggest anything useful (very obscure category, no UK retail presence). Total disambiguation pool capped at 4 items.
- alternatives_meta: parallel array (same length as alternatives_array). For each candidate provide:
  - typical_price_gbp: typical UK retail price as a number, no currency symbol. Ballpark from your training. Use null if you have no idea.
  - pack_size: descriptor of unit count or volume — examples: "9 Pack", "500ml", "415g", "1 unit", "4 Pack", "1.7L". Use null if pack/unit context doesn't apply (e.g. electronics, single-item products).
  - tier_label: ONE of "Premium", "Mid-tier", "Budget" — your read of the brand/product position in the UK market. Use null if you can't classify.
  This metadata powers the disambig screen's cost-per-unit + tier badges. Empty array [] when alternatives_array is empty.
- category — STRICT enum: tech | home | toys | diy | beauty | grocery | health | generic.
  - tech: phones, laptops, headphones, gaming, computer accessories, smart-home electronics.
  - home: kitchen appliances, furniture, bedding, larger household items.
  - toys: toys, board games, kids' products.
  - diy: tools, garden, hardware, building materials.
  - beauty: cosmetics, skincare, haircare, makeup, fragrance, hair tools.
  - grocery: food, drink, household consumables (cleaning sprays, dishwasher tabs, etc.).
  - health: OTC medicine, oral care (mouthwash/toothpaste), vitamins, supplements, wellness.
  - generic: only when nothing above clearly fits.
- mpn: raw manufacturer part number. NULL if not extractable.
- amazon_search_query: STRICTEST search string for Amazon A9. Prefer MPN.
- savvey_says: 'BS-Filter' qualitative summary. ALL fields nullable. null > hallucination.
  - timing_advice: ONLY suggest waiting if you have a real reason (Prime Day, end-of-cycle). NULL otherwise.
  - consensus: ONE short sentence summarising mainstream review consensus. NULL if niche/unreviewed.
  - confidence: "high" only if both fields populated AND product well-known.
  - DO NOT emit a typical_price_range field — pricing comes from a verified live source downstream.
  - DO NOT quote "current price" or any specific GBP figures. Pricing is handled outside this call.
  - For generic/no-name/grocery items, return all savvey_says fields null + confidence: "low".

EXAMPLES (showing exact JSON output shape for typical inputs):

Example 1 — vague brand+category (low conf, populate alternatives_array with popular UK options):
INPUT: "kettle"
OUTPUT: {"canonical_search_string": "Kettle", "confidence": "low", "alternative_string": null, "alternatives_array": ["Russell Hobbs Velocity 26480", "Smeg KLF03", "Tefal Avanti Classic 1.7L"], "category": "home", "mpn": null, "amazon_search_query": "kettle", "savvey_says": {"timing_advice": null, "consensus": null, "confidence": "low"}}

Example 2 — specific high-confidence:
INPUT: "Bose QC45"
OUTPUT: {"canonical_search_string": "Bose QuietComfort 45", "confidence": "high", "alternative_string": null, "alternatives_array": [], "category": "tech", "mpn": "QC45", "amazon_search_query": "Bose QuietComfort 45", "savvey_says": {"timing_advice": null, "consensus": "Best-in-class noise cancellation, comfortable for long sessions.", "confidence": "high"}}

Example 3 — specific medium-confidence (variants):
INPUT: "iPhone 15"
OUTPUT: {"canonical_search_string": "Apple iPhone 15 128GB", "confidence": "medium", "alternative_string": "Apple iPhone 15 Plus", "alternatives_array": ["Apple iPhone 15 Pro", "Apple iPhone 15 Pro Max"], "category": "tech", "mpn": null, "amazon_search_query": "Apple iPhone 15 128GB", "savvey_says": {"timing_advice": null, "consensus": "Apple's mainline 2023 phone, USB-C and 48MP camera.", "confidence": "high"}}

Example 4 — brand+category vague (low conf, popular UK products):
INPUT: "Logitech mouse"
OUTPUT: {"canonical_search_string": "Logitech mouse", "confidence": "low", "alternative_string": null, "alternatives_array": ["Logitech MX Master 3S", "Logitech M185", "Logitech G502 HERO"], "category": "tech", "mpn": null, "amazon_search_query": "Logitech mouse", "savvey_says": {"timing_advice": null, "consensus": null, "confidence": "low"}}

Example 5 — UK grocery:
INPUT: "Heinz beans"
OUTPUT: {"canonical_search_string": "Heinz Baked Beans 415g", "confidence": "high", "alternative_string": null, "alternatives_array": [], "category": "grocery", "mpn": null, "amazon_search_query": "Heinz Baked Beans 415g", "savvey_says": {"timing_advice": null, "consensus": null, "confidence": "low"}}
`;

// V.69 - Shared system prefix injected as the cache_control:ephemeral block
// across all 4 doors (vision/url/text/barcode). Anthropic prompt cache matches
// by prefix; this means all 4 doors share ONE cache entry instead of four.
// Mode-specific tails (VISION_SYSTEM_PROMPT etc) become the second uncached
// system block. Cold-call TTFB drops ~150-250ms; input-token cost drops 30-50%.
const SHARED_SYSTEM_PREFIX = `You are Savvey, a UK retail product identifier.

When given an input you produce a clean canonical search string and metadata in the strict JSON shape below. Mode-specific guidance (PHOTO / URL / TEXT / BARCODE) is appended in a separate block after this one.

${COMMON_SCHEMA_DOC}`;

const VISION_SYSTEM_PROMPT = `You are the UK retail vision engine for Savvey. The user photographed a product. Identify the product and produce a clean search string for Amazon UK.

Look for: 1) MPN/Model on box. 2) Brand + family. 3) Shelf-edge label.

EMPTY PACKAGING IS A VALID INPUT. Empty bottles, finished tubes, used containers, cardboard inners, product remnants — the user is reordering. Identify what's visible from the brand and label, applying normal confidence rules: 'high' if a specific variant is readable, 'medium' if only brand+family is visible, 'low' if only the brand or category is visible (or just generic packaging like a blank cardboard inner). For LOW-confidence brand+category cases, return a generic canonical (e.g. "Toilet Roll", "Toothpaste", "Mouthwash") and populate alternatives_array with 3 popular UK products in that category.

CATEGORY examples (these are STRICT — match the right enum):
- Photo of Listerine bottle -> category="health" (oral-care/mouthwash, NOT generic)
- Photo of Colgate / Sensodyne / Oral-B -> category="health"
- Photo of L'Oreal / Aveda / Aesop / Cowshed / The Ordinary / shampoo bottle -> category="beauty"
- Photo of Heinz / Tesco / Sainsbury's / Walkers / branded grocery item -> category="grocery"
- Photo of Bose / Sony / Logitech / iPhone / laptop -> category="tech"
- Photo of Ninja air fryer / kettle / appliance -> category="home"
- Photo of LEGO / board game / kids toy -> category="toys"
- Photo of Bosch tools / Black+Decker / DIY item -> category="diy"`;

const URL_SYSTEM_PROMPT = `You are a UK retail URL parser. Extract product identity from the URL string ALONE — do NOT fetch the page. UK e-commerce URLs typically include the product name in the slug.

Infer category from the URL's domain.`;

const TEXT_SYSTEM_PROMPT = `You are a UK retail query normaliser. The user typed a search string. May have typos. Clean it up.

Examples:
- "nija air frier dual" → canonical="Ninja Dual Air Fryer", confidence="medium", alternative="Ninja Foodi Dual Air Fryer"
- "bose qc45" → canonical="Bose QuietComfort 45", confidence="high", mpn="QC45"
- "iphone 15" → canonical="Apple iPhone 15 128GB", confidence="medium", alternative="Apple iPhone 15 Plus"
- "kettle" → canonical="Kettle", confidence="low", category="home", savvey_says all null
- "Listerine" → canonical="Listerine Mouthwash", category="health" (mouthwash is oral-care/health, NOT generic)
- "L'Oreal shampoo" → canonical="L'Oreal Elvive Shampoo", category="beauty"
- "Heinz beans" → canonical="Heinz Baked Beans 415g", category="grocery" `;

const BARCODE_SYSTEM_PROMPT = `You are a UK retail barcode (EAN/UPC) → product identifier.

UK EAN prefixes: 50/502 = UK; 5060... = UK food/grocery; 5012... = UK consumer goods; 0/1/9 = US/global imports.

- "high" only if you genuinely recognise this exact EAN
- "medium" if you can guess from prefix
- "low" if unknown — return canonical_search_string="Unknown product", confidence="low"

Do NOT hallucinate.`;

async function callHaikuText(systemPrompt, userText) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS_TEXT,
        // Wave II — prompt caching cuts ~30-50% input tokens + 100-200ms TTFB.
        // V.69 - two-block system: shared schema cached, mode-tail uncached.
        system: [
          { type: 'text', text: SHARED_SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: systemPrompt },
        ],
        messages: [{ role: 'user', content: userText }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Anthropic ${r.status}: ${body.slice(0, 200)}`);
    }
    const j = await r.json();
    return ((j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
  } finally { clearTimeout(timer); }
}

// Wave FF (7 May 2026 evening, Vincent override of post-Wave-V engine-lock):
// callHaikuVision now accepts EITHER a single base64 string (backwards-compat
// for any caller still on the v3.4.5ee shape) OR an array of 1-3 base64 frames
// for multi-shot ensemble. When given multiple frames, all are bundled into a
// single Haiku content array — one API call, slightly more tokens, materially
// better identification because Haiku gets cross-frame evidence.
async function callHaikuVision(systemPrompt, imageBase64OrFrames, mediaType) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const framesIn = Array.isArray(imageBase64OrFrames) ? imageBase64OrFrames : [imageBase64OrFrames];
  const frames = framesIn.filter(f => typeof f === 'string' && f.length > 100).slice(0, 3);
  if (frames.length === 0) throw new Error('no valid image frames');
  const isMulti = frames.length > 1;
  const userContent = frames.map(data => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data },
  }));
  userContent.push({
    type: 'text',
    text: isMulti
      ? `These are ${frames.length} quick consecutive snaps of a SINGLE product taken from slightly different angles in the same moment. Identify the specific product (brand AND exact model where any frame reveals it). Use combined evidence across all frames — text or branding visible in any one frame counts. Return JSON only.`
      : 'Identify this product. Return JSON only.',
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS_VISION,
        // Wave II — prompt caching on vision system prompt.
        // V.69 - two-block system: shared schema cached, mode-tail uncached.
        system: [
          { type: 'text', text: SHARED_SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: systemPrompt },
        ],
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Anthropic ${r.status}: ${body.slice(0, 200)}`);
    }
    const j = await r.json();
    return ((j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
  } finally { clearTimeout(timer); }
}

const SERPAPI_TIMEOUT_MS = 2000; // V.69 - was 4000ms; SerpAPI p95 ~1.4s
const AMAZON_TAG = process.env.AMAZON_TAG || 'savvey-21';
let _lastSerpStatus = null;

// v3.4.0 — Haiku price_take + structured verdict. ONE Haiku call after SerpAPI
// returns. Inputs: canonical + verified price + used price + category + rating
// + reviews. Outputs: short price_take sentence AND a structured verdict enum
// (good_buy | fair | wait | check_elsewhere). The verdict is the panel-mandated
// "permission to buy" closure moment — rendered as a coloured pill at the top
// of the result screen.
//
// SAFETY: when the verified price looks implausibly low for the canonical
// product family, Haiku is instructed to return verdict='check_elsewhere'
// with a price_take that warns the user the listing may be an accessory or
// related item, NOT the canonical product. This catches the failure mode
// surfaced by the v3.3.4 battery (Dyson V15 Detect verified at £170.99
// when actual is £449-£599 — likely a Dyson V15 accessory hijacking the
// top organic slot).
async function callHaikuPriceTake({ canonical, price_str, used_price_str, category, rating, reviews }) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return null;
  if (!canonical || !price_str) return null;

  const sys = `You are Savvey, a UK retail price assistant. The user is looking at a verified live Amazon UK listing for a product. Your job: produce a structured assessment with TWO fields.

Output JSON ONLY, no preamble:
{"verdict": "good_buy" | "fair" | "wait" | "check_elsewhere", "price_take": "Solid baseline — Echo Dot typical UK £45-£60." | null}

Verdict semantics:
- "good_buy"        — verified price is at or below typical UK retail floor for this product. Tell the user to buy.
- "fair"            — verified price is within typical UK retail band. Reasonable purchase.
- "wait"            — price is normal but a known sale event is imminent (Prime Day, Black Friday, end-of-product-cycle).
- "check_elsewhere" — verified price is implausibly LOW for this product family (likely an accessory, replacement part, or wrong-SKU surfacing as the top organic listing) OR implausibly HIGH (3rd-party seller markup) OR the verified listing's TITLE doesn't clearly match the canonical product (e.g. canonical "Dyson V15 Detect" but title is just "Dyson V15" or "Dyson Replacement Wand"). The user should NOT trust this listing as the canonical product — recommend checking the listing carefully or another retailer.
- BIAS toward check_elsewhere when ANY of these signal: price <50% of typical retail floor, title missing key product identifiers, rating low (<4.0) and reviews <50. Better to warn unnecessarily than to miss a wrong-SKU.

CRITICAL — accessory/wrong-SKU detection:
- If the canonical product family is "Dyson V15 Detect" and verified price is £170, that is implausibly low for V15 Detect (real range £449-£599). Verdict = "check_elsewhere", price_take = "This price suggests a replacement part or accessory, not the V15 Detect itself — verify the listing before buying."
- If canonical is a current iPhone Pro and verified is £200, that is implausibly low. Verdict = "check_elsewhere".
- Use UK retail knowledge for the product family to judge plausibility. Be cautious — false-positive on a legit sale is less damaging than false-negative on a wrong-SKU.

price_take rules:
- ONE sentence, max 10 words (HARD limit — server-side cap will truncate mid-clause if exceeded). Plain prose, no emojis. End with a full stop, not a dangling clause.
- ALWAYS anchor the verdict in a visible UK price reference where you know the band — formats: "typical £45-£60", "averages £279", "retails £449-£599", "high street £550-£600". The user must see WHY this verdict was given, not just the verdict itself. Only omit the reference if you genuinely don't know the typical UK band — in that case return price_take=null instead of guessing.
- Anchor in the verified price you were given. Do NOT quote a different price.
- For "check_elsewhere", the take MUST explain why (accessory suspicion, 3P markup).
- For "good_buy" / "fair" / "wait", the take frames the price in market context.
- For products you genuinely don't recognise, return verdict="fair" + price_take=null. Don't bluff.

NEVER hallucinate a competing retailer price. NEVER cite a specific GBP figure other than the verified price you were given.`;

  const userMsg = `Product: ${canonical}
Verified Amazon UK price: ${price_str}` +
    (used_price_str ? `\nAlso seen used at ${used_price_str}` : '') +
    (rating ? `\nAmazon rating: ${rating}/5 from ${reviews || '?'} reviews` : '') +
    (category ? `\nCategory: ${category}` : '') +
    `\n\nProduce the JSON.`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 180,
        // Wave II — prompt caching on price_take system prompt.
        system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMsg }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = ((j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { return null; }
    const allowedVerdicts = ['good_buy', 'fair', 'wait', 'check_elsewhere'];
    const verdict = (parsed && allowedVerdicts.includes(parsed.verdict)) ? parsed.verdict : null;
    const take = (parsed && typeof parsed.price_take === 'string' && parsed.price_take.trim())
      ? parsed.price_take.trim().slice(0, 200) : null;
    return { verdict, price_take: take };
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

// SerpAPI Amazon engine (v3.3.2 — 5 May 2026).
// Switched from engine=google_shopping (returned Google `aclk` redirect URLs
// that broke affiliate-tag propagation and didn't deep-link to actual
// listings) to engine=amazon with amazon_domain=amazon.co.uk.
// Native Amazon search returns ASIN + price + rating directly, so we can
// build canonical /dp/ASIN URLs with the affiliate tag baked in — no
// redirect-chasing, no Google middleware.
async function fetchVerifiedAmazonPrice(query) {
  _lastSerpStatus = null;
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    _lastSerpStatus = 'no_key';
    return null;
  }
  if (!query || typeof query !== 'string' || query.length < 2) return null;

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine',         'amazon');
  url.searchParams.set('amazon_domain',  'amazon.co.uk');
  url.searchParams.set('k',              query.slice(0, 150));
  url.searchParams.set('api_key',        apiKey);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), SERPAPI_TIMEOUT_MS);
  try {
    const r = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    _lastSerpStatus = r.status;
    if (!r.ok) {
      console.warn(`[${VERSION}] SerpAPI HTTP ${r.status} for "${query.slice(0, 60)}"`);
      return null;
    }
    const j = await r.json();
    const results = Array.isArray(j.organic_results) ? j.organic_results : [];

    // Find first organic (non-sponsored) listing with a valid price.
    // Used / refurbished items are surfaced separately for savvey_says.
    // v3.4.5 — lexical accessory guard. Tokenise the canonical query and
    // skip any organic result whose title doesn't share enough tokens with
    // the canonical product. Stops accessory listings (e.g. "Dyson V15 Brush
    // Head") from reaching Haiku/CTA when the user searched "Dyson V15 Detect".
    // v3.4.5c — both tokens and title are normalised by stripping ALL
    // non-alphanumeric chars (including spaces), so "24cm" matches "24 cm"
    // in real Amazon titles. Threshold unchanged at 50% per panel verdict.
    const _norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const canonicalTokens = String(query).toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3)
      .map(t => _norm(t));
    const minTokensRequired = canonicalTokens.length >= 2
      ? Math.ceil(canonicalTokens.length * 0.5)
      : 0;
    let primary = null;
    let used    = null;
    let _skippedLexical = 0;
    for (const item of results) {
      const price = Number(item.extracted_price);
      if (!(price > 0)) continue;
      const cond  = String(item.condition || '').toLowerCase();
      const title = String(item.title     || '').toLowerCase();
      const isUsed = /(used|refurb|renewed|open[\s-]?box|pre[\s-]?owned)/i.test(cond + ' ' + title);
      if (isUsed) {
        if (!used) used = item;
        continue;
      }
      if (item.sponsored) continue; // skip top-of-list sponsored slots
      // Lexical guard — only applies to candidates for `primary`.
      if (minTokensRequired > 0) {
        const titleNorm = _norm(title);
        const matched = canonicalTokens.filter(t => titleNorm.includes(t)).length;
        if (matched < minTokensRequired) {
          _skippedLexical++;
          continue;
        }
      }
      if (!primary) primary = item;
      if (primary && used) break;
    }
    if (_skippedLexical > 0) {
    }

    if (!primary) {
      _lastSerpStatus = 'no_amazon_match';
      return null;
    }

    const asin = (typeof primary.asin === 'string' && /^[A-Z0-9]{8,12}$/i.test(primary.asin)) ? primary.asin : null;

    // Build the deep link. ASIN-based /dp/ URL is the canonical Amazon
    // Associates pattern — it's stable, indexable, and the affiliate tag
    // is the FIRST query param so attribution is unambiguous.
    let directLink = null;
    if (asin) {
      directLink = `https://www.amazon.co.uk/dp/${asin}?tag=${encodeURIComponent(AMAZON_TAG)}`;
    } else if (primary.link && /^https?:\/\/(www\.)?amazon\.co\.uk\//i.test(primary.link)) {
      try {
        const u = new URL(primary.link);
        u.searchParams.set('tag', AMAZON_TAG);
        directLink = u.toString().slice(0, 500);
      } catch (e) { /* skip */ }
    }

    // v3.3.3 — pass through rating, reviews count, prime eligibility, and the
    // SerpAPI-returned product thumbnail. All defensive (nullable). These build
    // trust without adding any extra API call cost — they're already in the
    // organic_results we just fetched.
    const ratingVal = (typeof primary.rating === 'number' && primary.rating > 0 && primary.rating <= 5)
      ? Number(primary.rating.toFixed(1)) : null;
    const reviewsVal = (typeof primary.reviews === 'number' && primary.reviews > 0)
      ? Math.floor(primary.reviews) : null;
    const isPrime = primary.is_prime === true || primary.prime === true;
    const thumb   = (typeof primary.thumbnail === 'string' && /^https?:\/\//i.test(primary.thumbnail))
      ? primary.thumbnail.slice(0, 500) : null;

    // V.70 - PRICE-HISTORY LOGGING (panel-mandated, fire-and-forget).
    // Non-blocking: async kvSet without await, errors swallowed.
    // 90-day TTL keeps KV bounded while building 12-month history dataset.
    try {
      const _logTs = Date.now();
      const _logHash = (_logTs + String(query)).slice(-12).replace(/[^a-z0-9]/gi, '');
      const _logKey = 'savvey:pricelog:' + _logTs + ':' + _logHash;
      const _logVal = {
        canonical: String(query).slice(0, 200),
        asin: (typeof primary.asin === 'string') ? primary.asin : null,
        price: Number(primary.extracted_price),
        retailer: 'amazon.co.uk',
        rating: (typeof primary.rating === 'number') ? primary.rating : null,
        reviews: (typeof primary.reviews === 'number') ? primary.reviews : null,
        ts: new Date(_logTs).toISOString(),
      };
      kvSet(_logKey, _logVal, 7776000).catch(() => {});
    } catch (_e) { /* swallow - non-critical */ }

    return {
      price:           Number(primary.extracted_price),
      // V.50 — Amazon UK is always GBP. SerpAPI's primary.price field can include
      // "EUR" / "USD" prefix when the listing geo-mismatches; force £ prefix from
      // extracted_price so users always see "£218.69" not "EUR 218.69".
      price_str:       (Number.isFinite(Number(primary.extracted_price)) ? `£${Number(primary.extracted_price).toFixed(2)}` : String(primary.price || '').slice(0, 30)),
      currency:        'GBP',
      source:          'amazon.co.uk',
      source_type:     'organic',
      asin,
      title:           primary.title ? String(primary.title).slice(0, 200) : null,
      link:            directLink,
      thumbnail:       thumb,
      rating:          ratingVal,
      reviews:         reviewsVal,
      is_prime:        isPrime,
      used_price:      used ? Number(used.extracted_price) : null,
      // V.50 — same currency-safety as price_str above.
      used_price_str:  used ? (Number.isFinite(Number(used.extracted_price)) ? `£${Number(used.extracted_price).toFixed(2)}` : String(used.price || '').slice(0, 30)) : null,
      fetched_at:      new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timeout);
    _lastSerpStatus = 'fetch_error';
    console.warn(`[${VERSION}] SerpAPI fetch error for "${query.slice(0, 60)}":`, err.message);
    return null;
  }
}

function parseAndDefault(rawText) {
  if (!rawText) return null;
  const cleaned = rawText.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    console.warn(`[${VERSION}] JSON parse failed: ${e.message}; raw-first-200="${rawText.slice(0, 200)}"`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const canonical = (typeof parsed.canonical_search_string === 'string' && parsed.canonical_search_string.trim())
    ? parsed.canonical_search_string.trim().slice(0, 200) : null;
  if (!canonical) return null;

  const confidence = ['high','medium','low'].includes(parsed.confidence) ? parsed.confidence : 'low';
  const alternative = (confidence !== 'high' && typeof parsed.alternative_string === 'string' && parsed.alternative_string.trim())
    ? parsed.alternative_string.trim().slice(0, 200) : null;
  // Wave HH — extract alternatives_array (0-2 extra candidates) when low/medium confidence
  let alternatives_array = [];
  let alternatives_meta = [];
  if (confidence !== 'high' && Array.isArray(parsed.alternatives_array)) {
    alternatives_array = parsed.alternatives_array
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .map(s => s.trim().slice(0, 200))
      .slice(0, 3); // Wave HH.1 — up to 3 alternatives so vague brand+category queries get full 4-candidate disambig
    // Wave KK — extract alternatives_meta (parallel array) for disambig cost-per-unit + tier rendering
    if (Array.isArray(parsed.alternatives_meta)) {
      alternatives_meta = parsed.alternatives_meta.slice(0, alternatives_array.length).map(m => {
        if (!m || typeof m !== 'object') return null;
        const price = (typeof m.typical_price_gbp === 'number' && m.typical_price_gbp > 0 && m.typical_price_gbp < 10000)
          ? Number(m.typical_price_gbp.toFixed(2)) : null;
        const pack = (typeof m.pack_size === 'string' && m.pack_size.trim()) ? m.pack_size.trim().slice(0, 40) : null;
        const tier = ['Premium','Mid-tier','Budget'].includes(m.tier_label) ? m.tier_label : null;
        if (!price && !pack && !tier) return null;
        return { typical_price_gbp: price, pack_size: pack, tier_label: tier };
      });
    }
  }
  let category = ['tech','home','toys','diy','beauty','grocery','health','generic'].includes(parsed.category) ? parsed.category : 'generic';
  // v3.4.5q Wave F.1 — keyword-driven category override (defense-in-depth).
  // Beta finding 6 May 2026: Listerine snap returned with Currys/JL in alternatives, meaning Haiku
  // categorised it as 'home' or 'tech' instead of 'health'. Frontend CATEGORY_MAP routes by category
  // so a wrong category sends the user to the wrong retailers. This override catches misclassified
  // brands BEFORE they reach the routing layer. Updated as new mismatches are found.
  const _catKeywords = {
    // Wave II — brand whitelist expanded ~12 -> ~70 entries. Catches Vision
    // miscategorisations BEFORE they reach CATEGORY_MAP retailer routing.
    health:  /\b(listerine|colgate|sensodyne|oral[\s-]?b|corsodyl|macleans|aquafresh|pearl\s*drops|duraphat|nurofen|ibuprofen|paracetamol|panadol|calpol|gaviscon|rennie|berocca|centrum|vitamin|supplement|mouthwash|toothpaste|toothbrush|sudocrem|savlon|germolene|piriton|piriteze|voltarol|deep\s*heat|tcp|optrex|lemsip|strepsils|olbas|covonia|benadryl|clarityn)\b/i,
    beauty:  /\b(l['\u2019]?oreal|aveda|aesop|cowshed|the\s*ordinary|drunk\s*elephant|sol\s*de\s*janeiro|nivea|olay|garnier|maybelline|max\s*factor|rimmel|estee?\s*lauder|clinique|elemis|liz\s*earle|simple|cetaphil|cerave|la\s*roche[\s-]?posay|vichy|kerastase|matrix|wella|tresemme|pantene|head\s*&?\s*shoulders|aussie|herbal\s*essences|dove|palmolive|neutrogena|aveeno|no7|soap\s*and\s*glory|rituals|origins|charlotte\s*tilbury|fenty|nars|urban\s*decay|benefit|too\s*faced|shampoo|conditioner|moisturi[sz]er|serum|hand\s*(cream|wash|balm)|hair\s*(dry|straightener)|fragrance|perfume|aftershave)\b/i,
    grocery: /\b(heinz|kellogg|nestle|cadbury|walkers|pringles|coca[\s-]?cola|pepsi|robinsons|tetley|pg\s*tips|yorkshire\s*tea|twinings|lipton|lurpak|country\s*life|philadelphia|ben\s*and\s*jerry|magnum|haagen[\s-]?dazs|birds\s*eye|mccain|warburton|hovis|kingsmill|mcvitie|tunnocks|mr\s*kipling|kit\s*kat|aero|galaxy|wispa|twirl|flake|fanta|sprite|lucozade|red\s*bull|monster|innocent|tropicana|highland\s*spring|evian|volvic|baked\s*beans|cereal|biscuit|crisps|fizzy|squash|teabag)\b/i,
    tech:    /\b(apple|samsung|sony|bose|jbl|sennheiser|sonos|anker|logitech|razer|corsair|hyperx|steelseries|dell|hp|lenovo|asus|acer|msi|microsoft\s*surface|google\s*pixel|oneplus|xiaomi|fitbit|garmin|withings|kindle|fire\s*tablet|airpods|ps5|playstation|xbox|nintendo|switch)\b/i,
    home:    /\b(ninja\s+(af|bl|bn|fg|os|sf)|smeg|dualit|kenwood|breville|delonghi|de'longhi|krups|nespresso|tassimo|dolce\s*gusto|le\s*creuset|lodge|tefal|cuisinart|kitchenaid|magimix|nutribullet|vitamix|shark|bissell|miele|hoover|vax|sebo|henry\s*hoover|russell\s*hobbs|morphy\s*richards|swan|vonshef|salter|hotpoint|aeg|electrolux|whirlpool|beko|indesit)\b/i,
    diy:     /\b(dewalt|de[\s-]?walt|makita|milwaukee|stanley|black\s*&?\s*decker|black[\s-]?and[\s-]?decker|einhell|ryobi|festool|hilti|karcher|nilfisk|stihl|husqvarna|flymo|qualcast|webb|mountfield|cobra|hayter)\b/i,
    toys:    /\b(lego|playmobil|hasbro|mattel|fisher[\s-]?price|barbie|hot\s*wheels|nerf|monopoly|cluedo|risk|trivial\s*pursuit|scrabble|jigsaw\s*puzzle|board\s*game)\b/i,
  };
  if (canonical) {
    for (const [cat, rx] of Object.entries(_catKeywords)) {
      if (rx.test(canonical)) {
        if (category !== cat) {
          parsed._category_override = { from: category, to: cat, by: 'keyword' };
          category = cat;
        }
        break;
      }
    }
  }
  const mpn = (typeof parsed.mpn === 'string' && parsed.mpn.trim()) ? parsed.mpn.trim().slice(0, 100) : null;
  const amazonQ = (typeof parsed.amazon_search_query === 'string' && parsed.amazon_search_query.trim())
    ? parsed.amazon_search_query.trim().slice(0, 200) : (mpn || canonical);

  const ss = parsed.savvey_says && typeof parsed.savvey_says === 'object' ? parsed.savvey_says : {};
  const ssStr = (v) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 200) : null;
  const savvey_says = {
    typical_price_range: null, // PANEL KILL 4 May 2026 — superseded by live_amazon_price
    live_amazon_price:   null, // populated by handler from verified_amazon_price
    used_amazon_price:   null, // populated by handler from verified_amazon_price.used_price_str
    amazon_rating:       null, // v3.3.3 — populated by handler from verified rating + reviews
    price_take:          null, // v3.3.4 — populated by handler from second Haiku call grounded by verified price
    verdict:             null, // v3.4.0 — populated by handler: good_buy | fair | wait | check_elsewhere
    timing_advice:       ssStr(ss.timing_advice),
    consensus:           ssStr(ss.consensus),
    confidence:          ['high','medium','low'].includes(ss.confidence) ? ss.confidence : 'low',
  };

  return {
    canonical_search_string: canonical,
    confidence,
    alternative_string: alternative,
    alternatives_array, // Wave HH
    alternatives_meta, // Wave KK — typical_price_gbp + pack_size + tier_label per candidate
    category,
    mpn,
    amazon_search_query: amazonQ,
    savvey_says,
  };
}

// Wave FF — server-side specificity heuristic. Used by the frontend to decide
// whether to commit to a result page or route to disambig with the user's snap
// visible. The Nespresso miss (7 May beta) was a generic "Krups Nespresso U"
// landing on a result screen with the user's own snap as hero image — confidence-
// knock. With this flag set on the response, the frontend can route brand_only
// reads to disambig instead of a half-baked result.
//   "specific"   = canonical has model identifier (digits, "Pro/Max/Ultra/SE",
//                  3+ tokens after brand, or an MPN was extracted)
//   "brand_only" = canonical is brand + generic family, no model token
function assessSpecificity(canonical, mpn, confidence) {
  if (!canonical) return 'unknown';
  if (mpn && String(mpn).trim()) return 'specific';
  const stripped = String(canonical).trim();
  if (/\d/.test(stripped)) return 'specific';
  const tokens = stripped.split(/\s+/).filter(t => t.length > 1);
  if (tokens.length >= 4) return 'specific';
  if (/\b(pro|max|ultra|plus|mini|se|elite|premium|deluxe|essentials?|gen[\s-]?\d+)\b/i.test(stripped)) return 'specific'; // Wave II.2 — dropped 'air' (false-positive on 'Air Fryer')
  if (confidence === 'low') return 'brand_only';
  return tokens.length <= 2 ? 'brand_only' : 'specific';
}

// Wave KK — Layer 2 server-side safety sanitiser. Post-Vision canonical blacklist
// catches cases where Haiku tried to identify something that ISN'T a product
// (person, political symbol, drug, weapon, sensitive content). Layer 1 is
// Haiku's built-in safety which catches most upstream; this is defense-in-depth.
// On a hit, handler returns a clean redirect signal — frontend bounces to home
// with a friendly "not a product" toast (no shaming, no abusive labels).
const _SAFETY_BLOCK_RX = /\b(person|man|woman|child|baby|infant|toddler|face|portrait|selfie|naked|nude|breast|genital|penis|vagina|swastika|nazi|isis|terrorist|bomb|grenade|gun|pistol|rifle|knife|machete|cocaine|heroin|methamphet|cannabis|marijuana|weed|crack|opioid|fentanyl|noose|hanging|suicide|self[\s-]?harm|blood|gore|corpse|dead body|wound|injury)\b/i;
function _shouldSafetyBlock(canonical) {
  if (!canonical || typeof canonical !== 'string') return false;
  return _SAFETY_BLOCK_RX.test(canonical);
}

// Wave FF.1 — SerpAPI google_shopping engine call (permissive parser).
//
// HOTFIX over Wave FF: the original parser tried to extract direct merchant
// URLs from response.shopping_results[].link, but SerpAPI google_shopping
// returns Google `aclk` redirect URLs (host = google.com) which the hostname
// allow-list rejected -> retailer_deep_links empty on every fresh query.
//
// The Wave CC code comment in fetchVerifiedAmazonPrice explained this trap;
// I missed it. Switching to the merchant identity in `source` / `seller_name`
// (string field) and accepting the aclk URL as-is. Aclk redirects DO bounce
// the user to the merchant PDP, just via Google's click tracker. For non-
// Amazon retailers we don't care about affiliate-tag propagation, so this is
// fine. Vincent UX goal preserved: tap a retailer chip -> land on product
// page (one extra redirect hop, invisible to user).
//
// Returns a map of canonical retailer keys (e.g. 'currys.co.uk',
// 'johnlewis.com') -> { url, title, price }. Canonical key derives from
// seller_name via _SELLER_NAME_TO_HOST. Items with unknown sellers are
// dropped (still no random aggregator junk).
const GOOGLE_SHOPPING_TIMEOUT_MS = 2000; // V.69
const _SELLER_NAME_TO_HOST = (() => {
  const m = new Map();
  const add = (host, ...names) => names.forEach(n => m.set(n.toLowerCase(), host));
  add('currys.co.uk', 'Currys', 'Currys PC World');
  add('johnlewis.com', 'John Lewis', 'John Lewis & Partners', 'JohnLewis');
  add('argos.co.uk', 'Argos');
  add('boots.com', 'Boots', 'Boots UK');
  add('tesco.com', 'Tesco', 'Tesco Groceries', 'Tesco UK');
  add('sainsburys.co.uk', "Sainsbury's", 'Sainsburys');
  add('asda.com', 'Asda', 'ASDA Groceries');
  add('morrisons.com', 'Morrisons');
  add('waitrose.com', 'Waitrose', 'Waitrose & Partners');
  add('ocado.com', 'Ocado');
  add('diy.com', 'B&Q', 'B&Q DIY');
  add('screwfix.com', 'Screwfix');
  add('wickes.co.uk', 'Wickes');
  add('toolstation.com', 'Toolstation');
  add('halfords.com', 'Halfords');
  add('very.co.uk', 'Very', 'Very.co.uk');
  add('ao.com', 'AO', 'AO.com', 'ao.com');
  add('next.co.uk', 'Next');
  add('marksandspencer.com', 'M&S', 'Marks & Spencer', 'Marks and Spencer');
  add('superdrug.com', 'Superdrug');
  add('lookfantastic.com', 'Lookfantastic', 'LookFantastic');
  add('space.nk.com', 'Space NK');
  add('cultbeauty.co.uk', 'Cult Beauty', 'CultBeauty');
  add('wiggle.com', 'Wiggle');
  add('sigmasports.com', 'Sigma Sports');
  add('evanscycles.com', 'Evans Cycles', 'EvansCycles');
  add('chainreactioncycles.com', 'Chain Reaction Cycles', 'ChainReactionCycles');
  add('pets-at-home.com', 'Pets at Home', 'PetsAtHome');
  add('zooplus.co.uk', 'Zooplus', 'zooplus');
  add('smyths-toys.com', 'Smyths Toys', 'Smyths');
  add('theentertainer.com', 'The Entertainer');
  add('lego.com', 'LEGO', 'LEGO Shop');
  add('apple.com', 'Apple');
  add('samsung.com', 'Samsung');
  add('dell.com', 'Dell');
  add('hp.com', 'HP', 'HP Store');
  add('lenovo.com', 'Lenovo');
  add('microsoft.com', 'Microsoft');
  add('ikea.com', 'IKEA', 'Ikea');
  add('dunelm.com', 'Dunelm');
  add('wayfair.co.uk', 'Wayfair');
  add('made.com', 'Made.com', 'MADE');
  return m;
})();
function _resolveSeller(item) {
  const candidates = [item.source, item.seller_name, item.merchant && item.merchant.name].filter(Boolean);
  for (const raw of candidates) {
    const key = String(raw).trim().toLowerCase();
    if (_SELLER_NAME_TO_HOST.has(key)) return _SELLER_NAME_TO_HOST.get(key);
  }
  return null;
}
async function fetchGoogleShoppingDeepLinks(query, canonicalKey) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;
  if (!query || typeof query !== 'string' || query.length < 2) return null;
  const ck = `savvey:retailers:v2:${canonicalKey}`;
  const cached = await kvGet(ck);
  if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
    return cached;
  }
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_shopping');
  url.searchParams.set('q', query.slice(0, 150));
  url.searchParams.set('gl', 'uk');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('api_key', apiKey);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GOOGLE_SHOPPING_TIMEOUT_MS);
  try {
    const r = await fetch(url.toString(), { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) {
      console.warn(`[${VERSION}] google_shopping HTTP ${r.status} for "${query.slice(0, 60)}"`);
      return null;
    }
    const j = await r.json();
    const results = Array.isArray(j.shopping_results) ? j.shopping_results : [];
    const deepLinks = {};
    let _examined = 0;
    let _matchedSeller = 0;
    for (const item of results) {
      _examined++;
      const host = _resolveSeller(item);
      if (!host) continue;
      _matchedSeller++;
      if (host.includes('amazon.')) continue;
      if (deepLinks[host]) continue;
      // Use the aclk redirect URL (item.link). It bounces through Google to
      // the merchant PDP. product_link goes to Google's product page so we
      // prefer item.link. Fall back to product_link only if link missing.
      const url = item.link || item.product_link;
      if (!url || typeof url !== 'string') continue;
      deepLinks[host] = {
        url:   url.slice(0, 500),
        title: typeof item.title === 'string' ? item.title.slice(0, 200) : null,
        price: typeof item.price === 'string' ? item.price.slice(0, 30) : null,
      };
    }
    console.log(`[${VERSION}] google_shopping for "${query.slice(0,60)}": examined=${_examined} matched=${_matchedSeller} kept=${Object.keys(deepLinks).length}`);
    if (Object.keys(deepLinks).length === 0) return null;
    kvSet(ck, deepLinks, KV_TTL_SECONDS).catch(() => {});
    return deepLinks;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[${VERSION}] google_shopping fetch error for "${query.slice(0, 60)}":`, err.message);
    return null;
  }
}

// v3.4.5n — Open Food Facts lookup. Pre-resolves UK/EU grocery + toiletry
// barcodes to a product name BEFORE Haiku sees them. Lifts Door 3 (Scan)
// accuracy on the in-store-shopping use case. Free, no API key, generous
// rate limit. Returns null on miss / network fail / timeout — caller falls
// through to existing Haiku-from-digits behaviour. Panel-approved 6 May 2026.
async function lookupOpenFoodFacts(ean) {
  if (!ean || typeof ean !== 'string' || !/^\d{8,14}$/.test(ean)) return null;
  const url = `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(ean)}.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': `Savvey/${VERSION}` } });
    clearTimeout(timeout);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.status !== 'success' || !j.product) return null;
    const p = j.product;
    const brand = (typeof p.brands === 'string' && p.brands.trim()) ? p.brands.split(',')[0].trim() : '';
    const name  = (typeof p.product_name === 'string' && p.product_name.trim()) ? p.product_name.trim() :
                  (typeof p.product_name_en === 'string' && p.product_name_en.trim()) ? p.product_name_en.trim() : '';
    const qty   = (typeof p.quantity === 'string' && p.quantity.trim()) ? p.quantity.trim() : '';
    const composed = [brand, name, qty].filter(Boolean).join(' ').slice(0, 200);
    return composed || null;
  } catch (err) {
    clearTimeout(timeout);
    return null;
  }
}


// V.73 — Mobile-CLIP V2: when frontend sends category_hint from on-device
// classifier, inject as soft constraint at the END of the Vision tail prompt.
// SOFT (not strict) so misclassifications don't poison high-confidence Haiku
// reads of explicit MPN/brand text on the package. Empirical bias only.
function _buildVisionPromptWithHint(basePrompt, hint) {
  if (!hint || typeof hint !== 'string') return basePrompt;
  const allowed = ['tech','home','toys','diy','beauty','grocery','health','generic'];
  if (!allowed.includes(hint)) return basePrompt;
  if (hint === 'generic') return basePrompt;
  return basePrompt + `

ON-DEVICE CLASSIFIER HINT (soft signal, not authoritative):
The user's phone classifier suggests this image is in the "${hint}" category.
- If readable brand/model on the package matches a different category, TRUST the package text and IGNORE this hint.
- If the package is ambiguous (empty container, partial label, generic packaging), this hint can break ties.
- Do NOT bias category enum solely on this hint without supporting evidence.`;
}

export default async function handler(req, res) {
  applySecurityHeaders(res, ORIGIN);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  if (rejectIfRateLimited(req, res, 'normalize', RATE_LIMIT_PER_HOUR)) return;

  const t0 = Date.now();
  const body = req.body || {};
  const inputType = body.input_type;

  if (!['image','url','text','barcode'].includes(inputType)) {
    return res.status(400).json({ error: 'input_type must be image|url|text|barcode' });
  }

  const cKey = cacheKey(inputType, body);
  const cached = await kvGet(cKey);
  if (cached && typeof cached === 'object' && cached.canonical_search_string) {
    return res.status(200).json({
      ...cached,
      _meta: { ...(cached._meta || {}), cache: 'hit', latency_ms: Date.now() - t0 }
    });
  }

  let rawText;
  try {
    if (inputType === 'image') {
      // Wave FF — prefer image_base64_frames (array, 1-3) for multi-shot ensemble.
      // Falls back to image_base64 (single) for backwards compat with the v3.4.5ee
      // frontend. When both are provided, frames win.
      const framesIn = Array.isArray(body.image_base64_frames) ? body.image_base64_frames : null;
      const single = body.image_base64;
      const mediaType = body.media_type || 'image/jpeg';
      let payload;
      if (framesIn && framesIn.length > 0) {
        payload = framesIn.slice(0, 3).filter(f => typeof f === 'string' && f.length > 100);
        if (payload.length === 0) return res.status(400).json({ error: 'image_base64_frames invalid' });
        const totalBytes = payload.reduce((s, f) => s + f.length * 0.75, 0);
        if (totalBytes > MAX_IMAGE_BYTES * 2) return res.status(413).json({ error: 'frames total too large (>8MB)' });
      } else if (single) {
        const approxBytes = single.length * 0.75;
        if (approxBytes > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'image too large (>4MB)' });
        payload = single;
      } else {
        return res.status(400).json({ error: 'image_base64 or image_base64_frames required' });
      }
      rawText = await withCircuit('anthropic',
        () => callHaikuVision(_buildVisionPromptWithHint(VISION_SYSTEM_PROMPT, body && body.category_hint), payload, mediaType),
        { onOpen: () => null }
      );
    } else if (inputType === 'url') {
      const rawUrl = String(body.url || '').trim();
      if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return res.status(400).json({ error: 'valid url required' });
      // Wave II.2 — Panel audit (defense-in-depth): strip tracking and analytics
      // params BEFORE sending the URL slug to Haiku. URL_SYSTEM_PROMPT already
      // tells Haiku to ignore non-slug params, but stripping at the source
      // means cleaner inputs and zero risk of Haiku weighting a tracking
      // string as product context.
      let u = rawUrl;
      try {
        const _u = new URL(rawUrl);
        const _drop = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id','utm_name','utm_referrer','gclid','fbclid','msclkid','dclid','yclid','mc_eid','mc_cid','_ga','_gl','vero_id','vero_conv','wickedid','sm_guid','rb_clickid','referrer','redirected_from'];
        for (const k of _drop) _u.searchParams.delete(k);
        u = _u.toString();
      } catch {}
      rawText = await withCircuit('anthropic',
        () => callHaikuText(URL_SYSTEM_PROMPT, `URL: ${u}`),
        { onOpen: () => null }
      );
    } else if (inputType === 'barcode') {
      const ean = String(body.ean || '').trim().replace(/\D/g, '');
      if (!ean) return res.status(400).json({ error: 'ean required' });
      if (ean.length < 8 || ean.length > 14) return res.status(400).json({ error: 'invalid ean length' });
      // v3.4.5n — Open Food Facts pre-resolution. UK/EU groceries + toiletries
      // are reliably mapped from EAN -> product name BEFORE Haiku sees them.
      // On hit: feed the resolved string through TEXT_SYSTEM_PROMPT so Door 3
      // inherits the higher-accuracy Type-door pipeline. On miss: fall through
      // to the existing barcode-via-Haiku behaviour.
      const resolvedName = await lookupOpenFoodFacts(ean);
      if (resolvedName) {
        rawText = await withCircuit('anthropic',
          () => callHaikuText(TEXT_SYSTEM_PROMPT, `Query: "${resolvedName}"`),
          { onOpen: () => null }
        );
      } else {
        rawText = await withCircuit('anthropic',
          () => callHaikuText(BARCODE_SYSTEM_PROMPT, `EAN/UPC: ${ean}`),
          { onOpen: () => null }
        );
      }
    } else {
      const text = String(body.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      if (text.length > 200) return res.status(400).json({ error: 'text too long (>200 chars)' });
      rawText = await withCircuit('anthropic',
        () => callHaikuText(TEXT_SYSTEM_PROMPT, `Query: "${text}"`),
        { onOpen: () => null }
      );
    }
  } catch (err) {
    console.error(`[${VERSION}] ${inputType} call failed:`, err.message);
    return res.status(502).json({
      error: 'identification_failed',
      message: err.message.slice(0, 300),
      _meta: { version: VERSION, input_type: inputType, latency_ms: Date.now() - t0 }
    });
  }

  const parsed = parseAndDefault(rawText);
  if (!parsed) {
    return res.status(200).json({
      error: 'no_match',
      _meta: { version: VERSION, input_type: inputType, latency_ms: Date.now() - t0 }
    });
  }

  // Wave KK — Layer 2 safety block. Short-circuit before any caching/SerpAPI
  // when canonical matches the blacklist. Frontend handles 'safety_block' as
  // a clean redirect to home with a friendly toast.
  if (_shouldSafetyBlock(parsed.canonical_search_string)) {
    console.log(`[${VERSION}] Layer 2 safety block fired: "${(parsed.canonical_search_string||'').slice(0,80)}"`);
    return res.status(200).json({
      error: 'safety_block',
      message: 'That does not look like a product. Try snapping the packaging.',
      _meta: { version: VERSION, input_type: inputType, latency_ms: Date.now() - t0 }
    });
  }

  // Wave II — canonical-keyed cache lookup. Different input phrasings that
  // resolve to the SAME canonical hit one shared cache entry, skipping
  // SerpAPI Amazon engine + google_shopping + price_take Haiku call.
  const _canonicalKey = `savvey:canonical:v3:${String(parsed.canonical_search_string || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80)}`;
  if (_canonicalKey.length > 22) {
    const canonHit = await kvGet(_canonicalKey);
    if (canonHit && typeof canonHit === 'object' && canonHit.canonical_search_string) {
      console.log(`[${VERSION}] canonical cache HIT for "${parsed.canonical_search_string}"`);
      kvSet(cKey, canonHit, KV_TTL_SECONDS).catch(() => {});
      return res.status(200).json({
        ...canonHit,
        _meta: { ...(canonHit._meta || {}), cache: 'canonical_hit', latency_ms: Date.now() - t0, version: VERSION, category_hint_received: (body && body.category_hint) || null }
      });
    }
  }

  // Wave FF — parallel SerpAPI fan-out: Amazon engine (price anchor) +
  // google_shopping (non-Amazon retailer PDP deep links). Wall-clock latency
  // unchanged because Promise.all waits for the slowest, and Amazon engine is
  // already the slowest of the two (verified-price gate).
  // V.69 - alternative_amazon_price now rides the existing Promise.all batch
  // (was sequential before; ~600-900ms latency leak on medium-conf queries).
  // Powers disambig-screen thumbnails so users compare visually instead of
  // recalling model numbers (panel mandate 6 May 2026 beta - Logitech M235 vs
  // M185 case). Cost still ONE extra SerpAPI call per disambig (~30% queries).
  let verified_amazon_price = null;
  let retailer_deep_links = null;
  let alternative_amazon_price_v69 = null;
  if (parsed.canonical_search_string && parsed.confidence !== 'low') {
    const canonicalKey = String(parsed.canonical_search_string).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
    const fetchAlt = (parsed.alternative_string && parsed.confidence === 'medium')
      ? fetchVerifiedAmazonPrice(parsed.alternative_string)
      : Promise.resolve(null);
    const [amazonRes, retailersRes, altAmazonRes] = await Promise.all([
      fetchVerifiedAmazonPrice(parsed.canonical_search_string),
      fetchGoogleShoppingDeepLinks(parsed.canonical_search_string, canonicalKey),
      fetchAlt,
    ]);
    verified_amazon_price = amazonRes;
    retailer_deep_links = retailersRes;
    alternative_amazon_price_v69 = altAmazonRes;
  }
  // V.69 - alternative_amazon_price now resolved via the parallel batch above.
  const alternative_amazon_price = alternative_amazon_price_v69;


  if (verified_amazon_price && parsed.savvey_says) {
    if (Number(verified_amazon_price.price) > 0) {
      parsed.savvey_says.live_amazon_price = verified_amazon_price.price_str
        || `£${Number(verified_amazon_price.price).toFixed(2)}`;
    }
    if (verified_amazon_price.used_price_str) {
      parsed.savvey_says.used_amazon_price = verified_amazon_price.used_price_str;
    }
    // v3.3.3 — surface rating + reviews so savvey_says block carries
    // social-proof context, not just price.
    if (verified_amazon_price.rating && verified_amazon_price.reviews) {
      const reviewsFmt = verified_amazon_price.reviews >= 1000
        ? (verified_amazon_price.reviews / 1000).toFixed(verified_amazon_price.reviews >= 10000 ? 0 : 1) + 'k'
        : String(verified_amazon_price.reviews);
      parsed.savvey_says.amazon_rating = `${verified_amazon_price.rating}★ · ${reviewsFmt} reviews`;
    } else if (verified_amazon_price.rating) {
      parsed.savvey_says.amazon_rating = `${verified_amazon_price.rating}★`;
    }
    // v3.4.0 / Wave II — Haiku price_take + verdict grounded by verified anchor.
    // Wave II skip: rating >= 4.6 AND reviews >= 200 AND price > 0 -> verdict='good_buy'
    // deterministically, skip the second Haiku call entirely. Saves ~600ms on
    // the most common high-confidence cases (top-rated Amazon listings).
    const _isSlamDunk =
      Number(verified_amazon_price.rating || 0) >= 4.6 &&
      Number(verified_amazon_price.reviews || 0) >= 200 &&
      Number(verified_amazon_price.price || 0) > 0;
    if (_isSlamDunk) {
      parsed.savvey_says.verdict = 'good_buy';
      parsed.savvey_says.price_take = null;
      console.log(`[${VERSION}] slam-dunk skip Haiku price_take for "${parsed.canonical_search_string}"`);
    } else {
      try {
        const ai = await callHaikuPriceTake({
          canonical:      parsed.canonical_search_string,
          price_str:      verified_amazon_price.price_str,
          used_price_str: verified_amazon_price.used_price_str,
          category:       parsed.category,
          rating:         verified_amazon_price.rating,
          reviews:        verified_amazon_price.reviews,
        });
        if (ai) {
          if (ai.price_take) parsed.savvey_says.price_take = ai.price_take;
          if (ai.verdict)    parsed.savvey_says.verdict    = ai.verdict;
        }
      } catch (e) { /* non-critical */ }
    }
    // v3.4.5d — deterministic fallback. If Haiku didn't recognise the canonical
    // (returned null verdict despite a verified Amazon match), the worst-case
    // is a confident-looking green CTA on a wrong-SKU listing (e.g. Bosch
    // canonical 'UniversalGardenTidy' surfacing a £27.99 Bosch battery as if
    // it were the leaf blower). Force check_elsewhere so the user is warned.
    // Pure stateless guardrail — no prompt tinkering, no extra API call.
    if (!parsed.savvey_says.verdict && verified_amazon_price && Number(verified_amazon_price.price) > 0) {
      parsed.savvey_says.verdict = 'check_elsewhere';
      if (!parsed.savvey_says.price_take) {
        parsed.savvey_says.price_take = "Couldn't fully verify this listing matches the product — confirm details before buying.";
      }
    }
  }

  // v3.4.5n SA panel veto guard (6 May 2026): if no verified Amazon anchor
  // was returned by SerpAPI for this query, NULL any £/$/GBP/€ patterns that
  // may have leaked into savvey_says fields. Defense-in-depth — the existing
  // flow already gates price_take behind verified_amazon_price, but this
  // catches future regressions (a Haiku field accidentally introducing a
  // price claim, a future schema field forgetting to gate). 'Product
  // Identified' state without an invented price band is the panel-mandated
  // pivot until Keepa lands — accuracy over UI completeness.
  if (!verified_amazon_price && parsed.savvey_says && typeof parsed.savvey_says === 'object') {
    const _hasGbp = (s) => typeof s === 'string' && /(?:£|GBP|€|\$)\s*\d/i.test(s);
    for (const k of ['price_take', 'consensus', 'timing_advice', 'review_consensus']) {
      if (_hasGbp(parsed.savvey_says[k])) {
        parsed.savvey_says[k] = null;
      }
    }
  }

  // v3.4.5e — server-side word cap on Savvey Says copy (panel-mandated 5 May
  // 2026 PM, Product Owner ruling). Haiku occasionally returns 25-40 word
  // ramble that breaks the result-card layout on phones and undermines the
  // "brutal honesty in 10 words" brand commitment. Hard cap at 10 words with
  // ellipsis fallback. Applies after all upstream Haiku writes + deterministic
  // fallback so the cap is the final word.
  const _capWords = (s, n = 10) => {
    if (typeof s !== 'string') return s;
    const t = s.trim();
    if (!t) return s;
    const words = t.split(/\s+/);
    if (words.length <= n) return t;
    return words.slice(0, n).join(' ').replace(/[.,;:!?]+$/, '') + '…';
  };
  if (parsed.savvey_says && typeof parsed.savvey_says === 'object') {
    if (parsed.savvey_says.price_take)       parsed.savvey_says.price_take       = _capWords(parsed.savvey_says.price_take);
    if (parsed.savvey_says.timing_advice)    parsed.savvey_says.timing_advice    = _capWords(parsed.savvey_says.timing_advice);
    if (parsed.savvey_says.review_consensus) parsed.savvey_says.review_consensus = _capWords(parsed.savvey_says.review_consensus);
  }

  // Wave FF — emit specificity flag + retailer_deep_links on the response
  // root. specificity drives frontend confidence-gated routing (specific →
  // result page, brand_only → disambig). retailer_deep_links is a
  // hostname → {url,title,price} map, populated from google_shopping when
  // available, null otherwise.
  // Wave HH — build disambig_candidates array (2-4 items). Emitted on
  // response root. Frontend uses this when specificity==='brand_only' OR
  // confidence!=='high' to render dynamic candidate list (replaces legacy
  // 2-option flow). Order: canonical, alternative_string, alternatives_array.
  // Deduped (case-insensitive trim), capped at 4.
  const _specificity = assessSpecificity(parsed.canonical_search_string, parsed.mpn, parsed.confidence);
  let disambig_candidates = null;
  let disambig_candidates_meta = null; // Wave KK — parallel array, [{typical_price_gbp, pack_size, tier_label}|null, ...]
  const _shouldDisambig = (parsed.confidence !== 'high') || (_specificity === 'brand_only');
  if (_shouldDisambig && parsed.canonical_search_string) {
    // Wave HH.2 — when canonical is brand_only AND we have 2+ specific
    // alternatives, drop the canonical from disambig.
    const _altPool = [];
    const _altMetaPool = [];
    if (parsed.alternative_string) {
      _altPool.push(parsed.alternative_string);
      _altMetaPool.push(null); // alternative_string has no meta yet
    }
    if (Array.isArray(parsed.alternatives_array)) {
      for (let i = 0; i < parsed.alternatives_array.length; i++) {
        _altPool.push(parsed.alternatives_array[i]);
        _altMetaPool.push((parsed.alternatives_meta && parsed.alternatives_meta[i]) || null);
      }
    }
    const _specAlts = _altPool.filter(s => assessSpecificity(s, null, 'medium') === 'specific');
    const _skipCanonical = (_specificity === 'brand_only') && (_specAlts.length >= 2);

    const seen = new Set();
    const pool = [];
    const metaPool = [];
    if (!_skipCanonical) {
      pool.push(parsed.canonical_search_string);
      metaPool.push(null); // canonical has no meta in this wave
    }
    for (let i = 0; i < _altPool.length; i++) {
      pool.push(_altPool[i]);
      metaPool.push(_altMetaPool[i]);
    }

    const uniq = [];
    const uniqMeta = [];
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (typeof s !== 'string') continue;
      const k = s.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      uniq.push(s.trim().slice(0, 200));
      uniqMeta.push(metaPool[i]);
      if (uniq.length >= 4) break;
    }
    if (uniq.length >= 2) {
      disambig_candidates = uniq;
      // Wave KK — emit meta only if at least one entry has data
      if (uniqMeta.some(m => m !== null)) {
        disambig_candidates_meta = uniqMeta;
      }
    }
  }

  const responseBody = {
    ...parsed,
    specificity: _specificity,
    verified_amazon_price,
    alternative_amazon_price,
    retailer_deep_links,
    disambig_candidates, // Wave HH
    disambig_candidates_meta, // Wave KK — parallel array with typical_price_gbp + pack_size + tier_label per candidate
    _meta: {
      version: VERSION,
      input_type: inputType,
      latency_ms: Date.now() - t0,
      cache: 'miss',
    }
  };
  kvSet(cKey, responseBody, KV_TTL_SECONDS).catch(() => {});
  // Wave II — also write to canonical-keyed cache so different input
  // phrasings resolving to the same canonical share the cached response.
  if (_canonicalKey && _canonicalKey.length > 22) {
    kvSet(_canonicalKey, responseBody, KV_TTL_SECONDS).catch(() => {});
  }
  return res.status(200).json(responseBody);
}
