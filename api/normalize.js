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

const VERSION             = 'normalize.js v3.3.3';
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
    h.update(payload.image_base64 || '');
  } else if (inputType === 'url') {
    h.update(String(payload.url || '').trim().toLowerCase());
  } else if (inputType === 'barcode') {
    h.update(String(payload.ean || '').trim().replace(/\D/g, ''));
  } else {
    h.update(String(payload.text || '').trim().toLowerCase());
  }
  // v3.3 cache key bump: ensures v3.2 entries miss and re-fetch with the richer shape.
  return 'savvey:normalize:v3_3:' + h.digest('hex').slice(0, 24);
}

const COMMON_SCHEMA_DOC = `Return ONLY this JSON, no preamble, no markdown fences:
{
  "canonical_search_string": "Ninja AF400UK" | "Bose QuietComfort 45" | "Apple iPhone 15 128GB",
  "confidence": "high" | "medium" | "low",
  "alternative_string": "Ninja AF300UK" | null,
  "category": "tech" | "home" | "toys" | "diy" | "generic",
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
- category — STRICT enum: tech | home | toys | diy | generic.
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

async function callHaikuVision(systemPrompt, imageBase64, mediaType) {
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
        max_tokens: MAX_TOKENS_VISION,
        system: systemPrompt,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: 'Identify this product. Return JSON only.' },
          ],
        }],
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
    let primary = null;
    let used    = null;
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
      if (!primary) primary = item;
      if (primary && used) break;
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
  const category = ['tech','home','toys','diy','generic'].includes(parsed.category) ? parsed.category : 'generic';
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
    console.log(`[${VERSION}] cache HIT ${cKey.slice(-12)} (${inputType})`);
    return res.status(200).json({
      ...cached,
      _meta: { ...(cached._meta || {}), cache: 'hit', latency_ms: Date.now() - t0 }
    });
  }

  let rawText;
  try {
    if (inputType === 'image') {
      const imageBase64 = body.image_base64;
      const mediaType = body.media_type || 'image/jpeg';
      if (!imageBase64) return res.status(400).json({ error: 'image_base64 required' });
      const approxBytes = imageBase64.length * 0.75;
      if (approxBytes > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'image too large (>4MB)' });
      rawText = await withCircuit('anthropic',
        () => callHaikuVision(VISION_SYSTEM_PROMPT, imageBase64, mediaType),
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
      rawText = await withCircuit('anthropic',
        () => callHaikuText(BARCODE_SYSTEM_PROMPT, `EAN/UPC: ${ean}`),
        { onOpen: () => null }
      );
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

  let verified_amazon_price = null;
  if (parsed.canonical_search_string && parsed.confidence !== 'low') {
    verified_amazon_price = await fetchVerifiedAmazonPrice(parsed.canonical_search_string);
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
  }

  const responseBody = {
    ...parsed,
    verified_amazon_price,
    _meta: {
      version: VERSION,
      input_type: inputType,
      latency_ms: Date.now() - t0,
      cache: 'miss',
      verified_amazon_status: _lastSerpStatus,
    }
  };
  kvSet(cKey, responseBody, KV_TTL_SECONDS).catch(() => {});
  return res.status(200).json(responseBody);
}
