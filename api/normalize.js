// api/normalize.js — Savvey v3.0 Smart Router backend
//
// THE PIVOT (4 May 2026 evening):
// v2.x ran a 5-stage probabilistic pipeline (Sonar + Triage + validate +
// extract). It was fragile, expensive, slow, and after 3 hours of v2.9.x
// tuning produced no user-visible improvement. We KILLED it.
//
// v3.0 architecture: three input "doors" → ONE normalization call → smart
// deep-link CTAs. No scraping, no Sonar, no Serper, no validate, no extract.
//
// Three doors all return ONE shape:
//   {
//     canonical_search_string,   // "Ninja AF400UK" — what the user is looking for
//     confidence,                // high | medium | low — drives disambiguation UX
//     alternative_string | null, // second-best guess for confidence-confirm UI
//     category,                  // tech | home | toys | diy | generic — drives CTA map
//     mpn | null,                // raw model number if cleanly extracted
//     amazon_search_query        // strict MPN-only string for Amazon A9 deep-link
//   }
//
// Frontend then renders 3 retailer CTAs from a hardcoded category map.
// Amazon ALWAYS first (affiliate path).
//
// Door 1 (image): Haiku Vision reads the box, extracts MPN.
// Door 2 (url):   Haiku Text reads the URL slug. NO fetch. e.g.
//                 amazon.co.uk/Ninja-Foodi-Dual-Zone-Fryer/dp/B08XYZ
//                 → "Ninja Foodi Dual Zone Fryer".
// Door 3 (text):  Haiku Text fixes typos, normalizes, extracts category.
//                 e.g. "nija air frier dual" → "Ninja Dual Air Fryer".

import { applySecurityHeaders } from './_shared.js';
import { rejectIfRateLimited }  from './_rateLimit.js';
import { withCircuit }          from './_circuitBreaker.js';
import crypto                   from 'node:crypto';

const VERSION             = 'normalize.js v3.0.1';
const ORIGIN              = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';
const ANTHROPIC_ENDPOINT  = 'https://api.anthropic.com/v1/messages';
const MODEL               = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS          = 8000;
const MAX_TOKENS_VISION   = 350;
const MAX_TOKENS_TEXT     = 250;
const RATE_LIMIT_PER_HOUR = 60;   // higher than v2 — single endpoint, low cost
const MAX_IMAGE_BYTES     = 4 * 1024 * 1024;
const KV_TTL_SECONDS      = 21600; // 6h
const KV_TIMEOUT_MS       = 1500;

// ─────────────────────────────────────────────────────────────────────────
// VERCEL KV — best-effort cache. Lazily-loaded so we don't crash on cold
// boot if env vars missing. Same pattern as v2.9 cache.
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

// Build a cache key from the input. Image inputs hash the base64 (so the
// same photo retried hits cache); text/URL hash the trimmed lowercase string.
function cacheKey(inputType, payload) {
  const h = crypto.createHash('sha256');
  h.update(inputType);
  h.update('|');
  if (inputType === 'image') {
    // Hash the actual image bytes — repeat photos hit cache deterministically.
    h.update(payload.image_base64 || '');
  } else if (inputType === 'url') {
    h.update(String(payload.url || '').trim().toLowerCase());
  } else {
    h.update(String(payload.text || '').trim().toLowerCase());
  }
  return 'savvey:normalize:' + h.digest('hex').slice(0, 24);
}

// ─────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPTS — three, one per door. All return the SAME schema.
// ─────────────────────────────────────────────────────────────────────────

const COMMON_SCHEMA_DOC = `Return ONLY this JSON, no preamble, no markdown fences:
{
  "canonical_search_string": "Ninja AF400UK" | "Bose QuietComfort 45" | "Apple iPhone 15 128GB",
  "confidence": "high" | "medium" | "low",
  "alternative_string": "Ninja AF300UK" | null,
  "category": "tech" | "home" | "toys" | "diy" | "generic",
  "mpn": "AF400UK" | "QC45" | null,
  "amazon_search_query": "AF400UK" | "Bose QuietComfort 45" | "iPhone 15 128GB"
}

Field rules:
- canonical_search_string: the cleanest, most identifying name + model. Brand + family + exact model where available. e.g. "Ninja AF400UK", "Bose QuietComfort 45", "Sony WH-1000XM5", "Lego Star Wars Millennium Falcon 75192", "Cathedral City Mature Cheddar 350g".
- confidence:
  - "high" — you're certain about brand AND model AND category (e.g. clear MPN visible on box, or specific model named in text).
  - "medium" — brand certain, model probable but ambiguous (Bose headphones could be QC45 or QC Ultra without clearer signal).
  - "low" — significant ambiguity OR missing key identifier.
- alternative_string: ONLY when confidence < high — the second-most-likely interpretation, used by UX to disambiguate. e.g. for confidence=medium on "Bose QC", alternative_string="Bose QuietComfort Ultra" if QC45 is the canonical guess. NULL when confidence=high.
- category — STRICT enum (drives which UK retailers we deep-link):
  - "tech": phones, laptops, headphones, audio, TVs, cameras, gaming, wearables, smart home tech
  - "home": kitchen appliances (air fryer, vacuum, kettle, coffee machine), homeware, cookware, white goods
  - "toys": Lego, board games, action figures, kids' toys, baby gifts
  - "diy": power tools, hand tools, paint, hardware, garden tools, building supplies
  - "generic": anything else (groceries, beauty, books, clothes, niche items) — falls back to broad retailer set
- mpn: the raw manufacturer part number / SKU code. Strict — only what's printed on the product. NULL if not extractable.
- amazon_search_query: the STRICTEST possible search string for Amazon UK's A9 search engine. PRIORITISE MPN/model number over descriptive words. Amazon A9 returns sponsored knock-offs for semantic strings — return "AF400UK" not "Ninja Dual Air Fryer 5.2L". Format: bare MPN if available, otherwise [Brand] [Exact Model]. Examples: "AF400UK", "Bose QuietComfort 45", "WH-1000XM5", "iPhone 15 128GB".
`;

const VISION_SYSTEM_PROMPT = `You are the UK retail vision engine for Savvey. The user photographed a product (in a UK shop or at home — Currys, Tesco, Argos, John Lewis, B&Q, Lakeland, Boots etc.). Your job: identify the product and produce a clean search string for Amazon UK.

Look for:
1. The MPN / Model Number / EAN printed on the box (most reliable).
2. Brand + family in marketing text.
3. Shelf-edge label if visible.

${COMMON_SCHEMA_DOC}`;

const URL_SYSTEM_PROMPT = `You are a UK retail URL parser. The user pasted a UK retailer product URL. Extract the product identity from the URL string ALONE — do NOT fetch the page. UK e-commerce URLs typically include the product name in the slug: e.g. amazon.co.uk/Ninja-AF400UK-Dual-Zone-Air-Fryer/dp/B09BMC68FV → "Ninja AF400UK Dual Zone Air Fryer". argos.co.uk/product/8447423/ninja-foodi-9-in-1-dual-zone-air-fryer → "Ninja Foodi 9 in 1 Dual Zone Air Fryer".

Also infer the category from the URL's path / domain (currys.co.uk → likely tech or home; smythstoys.com → toys; screwfix.com → diy).

${COMMON_SCHEMA_DOC}`;

const TEXT_SYSTEM_PROMPT = `You are a UK retail query normaliser. The user typed a search string. It may have typos, be incomplete, or use informal product names. Clean it up into a canonical search string.

Examples:
- "nija air frier dual" → canonical_search_string="Ninja Dual Air Fryer", confidence="medium", alternative_string="Ninja Foodi Dual Air Fryer"
- "bose qc45" → canonical_search_string="Bose QuietComfort 45", confidence="high", alternative_string=null, mpn="QC45"
- "iphone 15" → canonical_search_string="Apple iPhone 15 128GB", confidence="medium", alternative_string="Apple iPhone 15 Plus"
- "kettle" → canonical_search_string="Kettle", confidence="low", alternative_string=null, category="home"

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

function parseAndDefault(rawText) {
  if (!rawText) return null;
  // Tolerate markdown fences
  const cleaned = rawText.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    console.warn(`[${VERSION}] JSON parse failed: ${e.message}; raw-first-200="${rawText.slice(0, 200)}"`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  // Sanity defaults
  const canonical = (typeof parsed.canonical_search_string === 'string' && parsed.canonical_search_string.trim())
    ? parsed.canonical_search_string.trim().slice(0, 200) : null;
  if (!canonical) return null; // no usable result

  const confidence = ['high','medium','low'].includes(parsed.confidence) ? parsed.confidence : 'low';
  const alternative = (confidence !== 'high' && typeof parsed.alternative_string === 'string' && parsed.alternative_string.trim())
    ? parsed.alternative_string.trim().slice(0, 200) : null;
  const category = ['tech','home','toys','diy','generic'].includes(parsed.category) ? parsed.category : 'generic';
  const mpn = (typeof parsed.mpn === 'string' && parsed.mpn.trim()) ? parsed.mpn.trim().slice(0, 100) : null;
  const amazonQ = (typeof parsed.amazon_search_query === 'string' && parsed.amazon_search_query.trim())
    ? parsed.amazon_search_query.trim().slice(0, 200) : (mpn || canonical);

  return {
    canonical_search_string: canonical,
    confidence,
    alternative_string: alternative,
    category,
    mpn,
    amazon_search_query: amazonQ,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  applySecurityHeaders(req, res, ORIGIN);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  if (await rejectIfRateLimited(req, res, RATE_LIMIT_PER_HOUR, 'normalize')) return;

  const t0 = Date.now();
  const body = req.body || {};
  const inputType = body.input_type;

  if (!['image','url','text'].includes(inputType)) {
    return res.status(400).json({ error: 'input_type must be image|url|text' });
  }

  // KV cache check — repeat queries hit cache, ~$0 instead of $0.005.
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
      const url = String(body.url || '').trim();
      if (!url || !/^https?:\/\//i.test(url)) return res.status(400).json({ error: 'valid url required' });
      rawText = await withCircuit('anthropic',
        () => callHaikuText(URL_SYSTEM_PROMPT, `URL: ${url}`),
        { onOpen: () => null }
      );
    } else {
      // text
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

  const responseBody = {
    ...parsed,
    _meta: { version: VERSION, input_type: inputType, latency_ms: Date.now() - t0, cache: 'miss' }
  };
  // Cache on success — fire-and-forget, don't block response.
  kvSet(cKey, responseBody, KV_TTL_SECONDS).catch(() => {});
  return res.status(200).json(responseBody);
}
