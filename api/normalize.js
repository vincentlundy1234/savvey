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

const VERSION             = 'normalize.js v3.4.5ff';
const ORIGIN              = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';
const ANTHROPIC_ENDPOINT  = 'https://api.anthropic.com/v1/messages';
const MODEL               = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS          = 8000;
const MAX_TOKENS_VISION   = 600;
const MAX_TOKENS_TEXT     = 500;
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

function cacheKey(inputType, payload) {
  const h = crypto.createHash('sha256');
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
  return 'savvey:normalize:v3_ff:' + h.digest('hex').slice(0, 24);
}

const COMMON_SCHEMA_DOC = `Return ONLY this JSON, no preamble, no markdown fences:
{
  "canonical_search_string": "Ninja AF400UK" | "Bose QuietComfort 45" | "Apple iPhone 15 128GB",
  "confidence": "high" | "medium" | "low",
  "alternative_string": "Ninja AF300UK" | null,
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
`;

const VISION_SYSTEM_PROMPT = `You are the UK retail vision engine for Savvey. The user photographed a product. Identify the product and produce a clean search string for Amazon UK.

Look for: 1) MPN/Model on box. 2) Brand + family. 3) Shelf-edge label.

CATEGORY examples (these are STRICT — match the right enum):
- Photo of Listerine bottle -> category="health" (oral-care/mouthwash, NOT generic)
- Photo of Colgate / Sensodyne / Oral-B -> category="health"
- Photo of L'Oreal / Aveda / Aesop / Cowshed / The Ordinary / shampoo bottle -> category="beauty"
- Photo of Heinz / Tesco / Sainsbury's / Walkers / branded grocery item -> category="grocery"
- Photo of Bose / Sony / Logitech / iPhone / laptop -> category="tech"
- Photo of Ninja air fryer / kettle / appliance -> category="home"
- Photo of LEGO / board game / kids toy -> category="toys"
- Photo of Bosch tools / Black+Decker / DIY item -> category="diy"

${COMMON_SCHEMA_DOC}`;

const URL_SYSTEM_PROMPT = `You are a UK retail URL parser. Extract product identity from the URL string ALONE — do NOT fetch the page. UK e-commerce URLs typically include the product name in the slug.

Infer category from the URL's domain.

${COMMON_SCHEMA_DOC}`;

const TEXT_SYSTEM_PROMPT = `You are a UK retail query normaliser. The user typed a search string. May have typos. Clean it up.

Examples:
- "nija air frier dual" → canonical="Ninja Dual Air Fryer", confidence="medium", alternative="Ninja Foodi Dual Air Fryer"
- "bose qc45" → canonical="Bose QuietComfort 45", confidence="high", mpn="QC45"
- "iphone 15" → canonical="Apple iPhone 15 128GB", confidence="medium", alternative="Apple iPhone 15 Plus"
- "kettle" → canonical="Kettle", confidence="low", category="home", savvey_says all null
- "Listerine" → canonical="Listerine Mouthwash", category="health" (mouthwash is oral-care/health, NOT generic)
- "L'Oreal shampoo" → canonical="L'Oreal Elvive Shampoo", category="beauty"
- "Heinz beans" → canonical="Heinz Baked Beans 415g", category="grocery" 

${COMMON_SCHEMA_DOC}`;

const BARCODE_SYSTEM_PROMPT = `You are a UK retail barcode (EAN/UPC) → product identifier.

UK EAN prefixes: 50/502 = UK; 5060... = UK food/grocery; 5012... = UK consumer goods; 0/1/9 = US/global imports.

- "high" only if you genuinely recognise this exact EAN
- "medium" if you can guess from prefix
- "low" if unknown — return canonical_search_string="Unknown product", confidence="low"

Do NOT hallucinate.

${COMMON_SCHEMA_DOC}`;

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
        system: systemPrompt,
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
        system: systemPrompt,
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

const SERPAPI_TIMEOUT_MS = 4000;
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
        system: sys,
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

    return {
      price:           Number(primary.extracted_price),
      price_str:       String(primary.price || `£${primary.extracted_price}`).slice(0, 30),
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
      used_price_str:  used ? String(used.price || `£${used.extracted_price}`).slice(0, 30) : null,
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
  let category = ['tech','home','toys','diy','beauty','grocery','health','generic'].includes(parsed.category) ? parsed.category : 'generic';
  // v3.4.5q Wave F.1 — keyword-driven category override (defense-in-depth).
  // Beta finding 6 May 2026: Listerine snap returned with Currys/JL in alternatives, meaning Haiku
  // categorised it as 'home' or 'tech' instead of 'health'. Frontend CATEGORY_MAP routes by category
  // so a wrong category sends the user to the wrong retailers. This override catches misclassified
  // brands BEFORE they reach the routing layer. Updated as new mismatches are found.
  const _catKeywords = {
    health:  /\b(listerine|colgate|sensodyne|oral[\s-]?b|corsodyl|nurofen|ibuprofen|paracetamol|panadol|calpol|gaviscon|rennie|berocca|centrum|vitamin|supplement|mouthwash|toothpaste|toothbrush)\b/i,
    beauty:  /\b(l['']?oreal|aveda|aesop|cowshed|the\s*ordinary|drunk\s*elephant|sol\s*de\s*janeiro|nivea|olay|garnier|maybelline|max\s*factor|rimmel|estee?\s*lauder|clinique|elemis|liz\s*earle|simple|cetaphil|cerave|la\s*roche[\s-]?posay|vichy|shampoo|conditioner|moisturi[sz]er|serum|hand\s*(cream|wash|balm)|hair\s*(dry|straightener))\b/i,
    grocery: /\b(heinz|kellogg|nestle|cadbury|walkers|pringles|coca[\s-]?cola|pepsi|robinsons|tetley|pg\s*tips|yorkshire\s*tea|warburton|hovis|mcvitie|baked\s*beans|cereal|biscuit|crisps)\b/i,
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
  if (/\b(pro|max|ultra|plus|mini|air|se|elite|premium|deluxe|essentials?|gen[\s-]?\d+)\b/i.test(stripped)) return 'specific';
  if (confidence === 'low') return 'brand_only';
  return tokens.length <= 2 ? 'brand_only' : 'specific';
}

// Wave FF — SerpAPI google_shopping engine call.
// Returns a map of UK retailer hostnames -> direct PDP URLs for the canonical
// product. Runs in PARALLEL with the Amazon engine call (Promise.all) so wall-
// clock latency is unchanged. Cached in KV per canonical (24h) so repeat snaps
// of the same product don't re-bill SerpAPI.
//
// Strategic intent (Vincent product-owner call 7 May 2026 evening):
// "if the links were all reliable the list of retailers updated dynamically and
// consistently depending on the product that would be a huge win".
const GOOGLE_SHOPPING_TIMEOUT_MS = 4000;
const _RETAILER_HOSTS_OF_INTEREST = new Set([
  'currys.co.uk', 'johnlewis.com', 'argos.co.uk', 'boots.com', 'tesco.com',
  'sainsburys.co.uk', 'asda.com', 'morrisons.com', 'waitrose.com', 'ocado.com',
  'diy.com', 'screwfix.com', 'wickes.co.uk', 'toolstation.com', 'bandq.co.uk',
  'halfords.com', 'very.co.uk', 'ao.com', 'next.co.uk', 'marksandspencer.com',
  'superdrug.com', 'lookfantastic.com', 'space.nk.com', 'cultbeauty.co.uk',
  'wiggle.com', 'sigmasports.com', 'evanscycles.com', 'chainreactioncycles.com',
  'pets-at-home.com', 'zooplus.co.uk', 'crocus.co.uk',
  'smyths-toys.com', 'theentertainer.com', 'lego.com', 'apple.com',
  'samsung.com', 'dell.com', 'hp.com', 'lenovo.com', 'microsoft.com',
  'ikea.com', 'dunelm.com', 'wayfair.co.uk', 'made.com',
]);
function _hostFromUrl(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return null; }
}
async function fetchGoogleShoppingDeepLinks(query, canonicalKey) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return null;
  if (!query || typeof query !== 'string' || query.length < 2) return null;
  const ck = `savvey:retailers:v1:${canonicalKey}`;
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
    for (const item of results) {
      const link = item.product_link || item.link;
      if (!link || typeof link !== 'string') continue;
      const host = _hostFromUrl(link);
      if (!host) continue;
      if (host.includes('amazon.')) continue;
      const matched = [..._RETAILER_HOSTS_OF_INTEREST].find(h => host === h || host.endsWith('.' + h));
      if (!matched) continue;
      if (deepLinks[matched]) continue;
      deepLinks[matched] = {
        url: link.slice(0, 500),
        title: typeof item.title === 'string' ? item.title.slice(0, 200) : null,
        price: typeof item.price === 'string' ? item.price.slice(0, 30) : null,
      };
    }
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
        () => callHaikuVision(VISION_SYSTEM_PROMPT, payload, mediaType),
        { onOpen: () => null }
      );
    } else if (inputType === 'url') {
      const u = String(body.url || '').trim();
      if (!u || !/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'valid url required' });
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

  // Wave FF — parallel SerpAPI fan-out: Amazon engine (price anchor) +
  // google_shopping (non-Amazon retailer PDP deep links). Wall-clock latency
  // unchanged because Promise.all waits for the slowest, and Amazon engine is
  // already the slowest of the two (verified-price gate).
  let verified_amazon_price = null;
  let retailer_deep_links = null;
  if (parsed.canonical_search_string && parsed.confidence !== 'low') {
    const canonicalKey = String(parsed.canonical_search_string).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
    const [amazonRes, retailersRes] = await Promise.all([
      fetchVerifiedAmazonPrice(parsed.canonical_search_string),
      fetchGoogleShoppingDeepLinks(parsed.canonical_search_string, canonicalKey),
    ]);
    verified_amazon_price = amazonRes;
    retailer_deep_links = retailersRes;
  }
  // v3.4.5i — fetch alternative's verified Amazon listing too when confidence
  // is medium and an alternative was produced. Powers disambig-screen
  // thumbnails so users compare visually instead of recalling model numbers
  // (panel-mandated 6 May 2026 beta finding — Logitech M235 vs M185 case).
  // Cost: ONE extra SerpAPI call per disambig case (~30% of queries).
  let alternative_amazon_price = null;
  if (parsed.alternative_string && parsed.confidence === 'medium') {
    alternative_amazon_price = await fetchVerifiedAmazonPrice(parsed.alternative_string);
  }


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
    // v3.4.0 — Haiku price_take + verdict grounded by the verified anchor.
    // Returns { verdict, price_take } structured object. Both nullable.
    // Verdict drives the result-screen pill; price_take is the explanatory line.
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
  const responseBody = {
    ...parsed,
    specificity: assessSpecificity(parsed.canonical_search_string, parsed.mpn, parsed.confidence),
    verified_amazon_price,
    alternative_amazon_price,
    retailer_deep_links,
    _meta: {
      version: VERSION,
      input_type: inputType,
      latency_ms: Date.now() - t0,
      cache: 'miss',
    }
  };
  kvSet(cKey, responseBody, KV_TTL_SECONDS).catch(() => {});
  return res.status(200).json(responseBody);
}
