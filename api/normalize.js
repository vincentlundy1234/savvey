// api/normalize.js — Savvey v3.1 Smart Router backend
//
// THE PIVOT (4 May 2026):
// v2.x ran a 5-stage probabilistic pipeline (Sonar + Triage + validate +
// extract). It was fragile, expensive, slow. We KILLED it.
//
// v3.0 architecture: 4 input "doors" → ONE normalization call → smart
// deep-link CTAs. No scraping, no Sonar, no Serper, no validate, no extract.
//
// All four doors return ONE shape:
//   {
//     canonical_search_string,   // "Ninja AF400UK" — what the user is looking for
//     confidence,                // high | medium | low
//     alternative_string | null, // second-best guess for confidence-confirm UI
//     category,                  // tech | home | toys | diy | generic
//     mpn | null,                // raw model number if cleanly extracted
//     amazon_search_query,       // strict MPN-only string for Amazon A9 deep-link
//     savvey_says: {             // v3.1 — knowledge-derived advisory block
//       typical_price_range,     //   "£180–£220" — TYPICAL UK retail, NOT today's price
//       timing_advice,           //   "Wait for Prime Day" / "Buy now, price stable"
//       consensus,               //   one-line review summary
//       confidence               //   high|medium|low — frontend gates the block
//     }
//   }
//
// Frontend renders 3 retailer CTAs from a hardcoded category map.
// Amazon ALWAYS first (affiliate path).
//
// Door 1 (image):   Haiku Vision reads box, extracts MPN
// Door 2 (url):     Haiku Text reads URL slug. NO fetch.
// Door 3 (text):    Haiku Text fixes typos, normalizes
// Door 4 (barcode): client-side Html5-Qrcode decodes EAN locally → Haiku Text matches UK SKU

import { applySecurityHeaders } from './_shared.js';
import { rejectIfRateLimited }  from './_rateLimit.js';
import { withCircuit }          from './_circuitBreaker.js';
import crypto                   from 'node:crypto';

const VERSION             = 'normalize.js v3.2.0';
const ORIGIN              = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';
const ANTHROPIC_ENDPOINT  = 'https://api.anthropic.com/v1/messages';
const MODEL               = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS          = 8000;
const MAX_TOKENS_VISION   = 600;   // bumped for savvey_says output
const MAX_TOKENS_TEXT     = 500;   // bumped for savvey_says output
const RATE_LIMIT_PER_HOUR = 60;
const MAX_IMAGE_BYTES     = 4 * 1024 * 1024;
const KV_TTL_SECONDS      = 86400; // 24h — savvey_says is knowledge-derived
const KV_TIMEOUT_MS       = 1500;

// ─────────────────────────────────────────────────────────────────────────
// VERCEL KV — best-effort cache. Lazily-loaded; fails graceful if unset.
// ─────────────────────────────────────────────────────────────────────────
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
  return 'savvey:normalize:' + h.digest('hex').slice(0, 24);
}

// ─────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPTS — four doors, one schema out.
// ─────────────────────────────────────────────────────────────────────────

const COMMON_SCHEMA_DOC = `Return ONLY this JSON, no preamble, no markdown fences:
{
  "canonical_search_string": "Ninja AF400UK" | "Bose QuietComfort 45" | "Apple iPhone 15 128GB",
  "confidence": "high" | "medium" | "low",
  "alternative_string": "Ninja AF300UK" | null,
  "category": "tech" | "home" | "toys" | "diy" | "generic",
  "mpn": "AF400UK" | "QC45" | null,
  "amazon_search_query": "AF400UK" | "Bose QuietComfort 45",
  "savvey_says": {
    "typical_price_range": "£180–£220" | null,
    "timing_advice": "Buy now, price is stable" | "Wait — Prime Day deals likely" | null,
    "consensus": "Excellent air fryer, but huge footprint." | null,
    "confidence": "high" | "medium" | "low"
  }
}

Field rules:
- canonical_search_string: cleanest brand + family + model. e.g. "Ninja AF400UK", "Bose QuietComfort 45".
- confidence: "high" if certain on brand+model+category. "medium" if model ambiguous. "low" if unclear.
- alternative_string: ONLY when confidence < high. Second-most-likely interpretation. NULL when high.
- category — STRICT enum:
  - "tech": phones, laptops, headphones, audio, TVs, cameras, gaming, wearables
  - "home": kitchen appliances (air fryer, vacuum, kettle), homeware, white goods
  - "toys": Lego, board games, kids' toys
  - "diy": power tools, hand tools, paint, hardware, garden tools
  - "generic": anything else (groceries, beauty, books, niche items)
- mpn: raw manufacturer part number. NULL if not extractable.
- amazon_search_query: STRICTEST search string for Amazon A9. Prefer MPN over descriptive words. e.g. "AF400UK" not "Ninja Dual Air Fryer".
- savvey_says: 'BS-Filter' summary. ALL fields nullable. Only populate fields you're genuinely confident about — null > hallucination.
  - typical_price_range: TYPICAL UK retail range (NOT today's price — your training data isn't real-time). Use "£X–£Y". NULL if unsure or fast-moving market.
  - timing_advice: one short clause. ONLY suggest waiting if you have a real reason. NULL if you genuinely don't know.
  - consensus: ONE short sentence summarising mainstream review consensus. NULL if niche/unreviewed.
  - confidence: "high" only if all three fields populated AND product well-known. "low" if guessing — frontend HIDES the block at low confidence.
  - CRITICAL: for generic/no-name/grocery items, return all savvey_says fields null + confidence: "low".
  - CRITICAL: NEVER quote a "current price". Always frame as "typical UK retail" — training cutoff is months/years stale.
`;

const VISION_SYSTEM_PROMPT = `You are the UK retail vision engine for Savvey. The user photographed a product (in a UK shop or at home — Currys, Tesco, Argos, John Lewis, B&Q, Lakeland, Boots etc.). Identify the product and produce a clean search string for Amazon UK.

Look for:
1. The MPN / Model Number / EAN printed on the box (most reliable).
2. Brand + family in marketing text.
3. Shelf-edge label if visible.

${COMMON_SCHEMA_DOC}`;

const URL_SYSTEM_PROMPT = `You are a UK retail URL parser. The user pasted a UK retailer product URL. Extract product identity from the URL string ALONE — do NOT fetch the page. UK e-commerce URLs typically include the product name in the slug: amazon.co.uk/Ninja-AF400UK-Dual-Zone-Air-Fryer/dp/B09BMC68FV → "Ninja AF400UK Dual Zone Air Fryer".

Also infer category from URL's domain (currys.co.uk → tech/home; smythstoys.com → toys; screwfix.com → diy).

${COMMON_SCHEMA_DOC}`;

const TEXT_SYSTEM_PROMPT = `You are a UK retail query normaliser. The user typed a search string. May have typos, be incomplete, or use informal product names. Clean it up.

Examples:
- "nija air frier dual" → canonical="Ninja Dual Air Fryer", confidence="medium", alternative="Ninja Foodi Dual Air Fryer"
- "bose qc45" → canonical="Bose QuietComfort 45", confidence="high", mpn="QC45"
- "iphone 15" → canonical="Apple iPhone 15 128GB", confidence="medium", alternative="Apple iPhone 15 Plus"
- "kettle" → canonical="Kettle", confidence="low", category="home", savvey_says all null

${COMMON_SCHEMA_DOC}`;

const BARCODE_SYSTEM_PROMPT = `You are a UK retail barcode (EAN/UPC) → product identifier. The user scanned a 12-13 digit barcode. Map it to the exact UK product if you recognise it.

Common UK EAN prefixes: 50/502 = UK; 5060... = many UK food/grocery brands; 5012... = UK consumer goods; 0/1/9 = US/global imports.

Be honest about confidence:
- "high" only if you genuinely recognise this exact EAN as a specific UK product
- "medium" if you can guess from prefix + general knowledge
- "low" if you don't know — return canonical_search_string="Unknown product", confidence="low"

Do NOT hallucinate. If unsure, say so.

${COMMON_SCHEMA_DOC}`;

// ─────────────────────────────────────────────────────────────────────────
// CALL ANTHROPIC
// ─────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────
// PARSE + SANITY-DEFAULT
// ─────────────────────────────────────────────────────────────────────────


// ── SerpAPI: verified Amazon UK price (Move 2 — Panel-approved 4 May 2026) ──
//
// Fetches Google Shopping results for the canonical product, filters to Amazon
// UK, and returns the first matching listing's extracted_price. Defensive: if
// SERPAPI_KEY is not set or any step fails, returns null so the response gracefully
// falls back to the existing CTA behaviour.
//
// Latency budget: 4s timeout via AbortController. Real cost ~£0.001 per fresh
// call (free trial: 100/mo). KV cache wraps the whole normalize response so this
// only fires for unique products within the 24h cache window.
const SERPAPI_TIMEOUT_MS = 4000;
async function fetchVerifiedAmazonPrice(query) {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    return null; // env not set — feature simply off, no error
  }
  if (!query || typeof query !== 'string' || query.length < 2) return null;

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_shopping');
  url.searchParams.set('q',      query.slice(0, 150));
  url.searchParams.set('gl',     'uk');
  url.searchParams.set('hl',     'en');
  url.searchParams.set('api_key', apiKey);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), SERPAPI_TIMEOUT_MS);
  try {
    const r = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) {
      console.warn(`[${VERSION}] SerpAPI HTTP ${r.status} for "${query.slice(0, 60)}"`);
      return null;
    }
    const j = await r.json();
    const results = Array.isArray(j.shopping_results) ? j.shopping_results : [];
    // Find first Amazon UK match. SerpAPI's "source" field is the merchant name
    // ("Amazon.co.uk", "Amazon UK", sometimes just "Amazon"); the link contains
    // amazon.co.uk for UK results. Both checked for safety.
    const match = results.find(item => {
      const src  = String(item.source || '').toLowerCase();
      const link = String(item.link   || '').toLowerCase();
      return (src.includes('amazon') || link.includes('amazon.co.uk'))
             && (Number(item.extracted_price) > 0);
    });
    if (!match) return null;

    return {
      price:        Number(match.extracted_price),
      price_str:    String(match.price || `£${match.extracted_price}`).slice(0, 30),
      currency:     'GBP',
      source:       'amazon.co.uk',
      title:        match.title ? String(match.title).slice(0, 200) : null,
      link:         match.link  ? String(match.link).slice(0, 500)  : null,
      fetched_at:   new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timeout);
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

  // v3.1 — Savvey Says block. All fields nullable. Frontend uses
  // savvey_says.confidence as gate: if !== 'high', hide the entire block.
  const ss = parsed.savvey_says && typeof parsed.savvey_says === 'object' ? parsed.savvey_says : {};
  const ssStr = (v) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 200) : null;
  const savvey_says = {
    typical_price_range: null, // PANEL KILL 4 May 2026 — hallucination liability; SerpAPI-verified price will populate in v3.2 (Move 2)
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

// ─────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────

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

  // KV cache check
  const cKey = cacheKey(inputType, body);
  const cached = await kvGet(cKey);
  if (cached && typeof cached === 'object' && cached.canonical_search_string) {
    console.log(`[${VERSION}] cache HIT ${cKey.slice(-12)} (${inputType})`);
    // Sanitize legacy cache: v3.1.0 entries may have hallucinated typical_price_range.
    // Strip it on the way out so old cache hits respect the v3.1.1 panel kill.
    const sanitized = { ...cached };
    if (sanitized.savvey_says) {
      sanitized.savvey_says = { ...sanitized.savvey_says, typical_price_range: null };
    }
    return res.status(200).json({
      ...sanitized,
      _meta: { ...(sanitized._meta || {}), cache: 'hit', latency_ms: Date.now() - t0 }
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
      const url = String(body.url || '').trim();
      if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'valid url required' });
      rawText = await withCircuit('anthropic',
        () => callHaikuText(URL_SYSTEM_PROMPT, `URL: ${url}`),
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

  // Move 2 — fetch verified Amazon UK price for the canonical product.
  // Adds ~500ms-1s latency on cache miss; null-safe if SerpAPI fails or key
  // is missing. Only fires for high-confidence canonicals (skip on low to
  // avoid wasted credits on hallucinated names).
  let verified_amazon_price = null;
  if (parsed.canonical_search_string && parsed.confidence !== 'low') {
    verified_amazon_price = await fetchVerifiedAmazonPrice(parsed.canonical_search_string);
  }

  const responseBody = {
    ...parsed,
    verified_amazon_price,
    _meta: { version: VERSION, input_type: inputType, latency_ms: Date.now() - t0, cache: 'miss' }
  };
  kvSet(cKey, responseBody, KV_TTL_SECONDS).catch(() => {});
  return res.status(200).json(responseBody);
}
