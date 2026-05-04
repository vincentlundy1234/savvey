// api/ai-vision.js — Savvey AI Vision v2.0
//
// v2.0 (4 May 2026) — v2.9 panel-locked schema upgrade:
//   - Adds shelf-edge OCR: extracts in_store_price + in_store_retailer
//     from the photo when a UK retailer shelf-edge label is visible.
//   - Adds image_type classification: box | box_and_shelf_label | shelf_label | generic | unclear
//   - Adds captured_at timestamp (server-side ISO 8601).
//   - NO geo_coarse / NO Location permission (panel cut: tanks first-snap conversion).
//   - Backward-compatible: still returns `product` field derived from
//     brand+family+model+qualifiers so the existing frontend keeps working
//     during the rolling Day 2 deploy.
//
// v1.0 (1 May 2026) — original product identifier.
//
// Hardening parity unchanged from v1.0:
//   - applySecurityHeaders from _shared
//   - rate limit 30/IP/hour via _rateLimit
//   - circuit breaker on Anthropic via _circuitBreaker
//   - 4MB image cap

import { applySecurityHeaders } from './_shared.js';
import { rejectIfRateLimited }  from './_rateLimit.js';
import { withCircuit }          from './_circuitBreaker.js';

const VERSION    = 'ai-vision.js v2.0';
const ORIGIN     = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL              = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS         = 8000;
const MAX_TOKENS         = 380;             // bumped from 220 for richer schema
const RATE_LIMIT_PER_HOUR = 30;
const MAX_IMAGE_BYTES    = 4 * 1024 * 1024;

const SYSTEM_PROMPT = `You are the UK retail vision engine for Savvey, a price-comparison app. The user has photographed a product in a UK shop (Currys, Tesco, Argos, John Lewis, B&Q, Sainsbury's, Wickes, Screwfix, Lakeland, Boots etc.) or at home. Your job: extract everything we need to find the best price.

Return ONLY a JSON object, no preamble or markdown. The exact schema is:

{
  "brand": "Ninja" | null,
  "family": "Air Fryer" | null,
  "model": "AF400UK" | null,
  "qualifiers": ["5.2L", "Single Drawer"],
  "confidence": "high" | "medium" | "low" | "none",
  "category": "electronics" | "grocery" | "fashion" | "homeware" | "beauty" | "toy" | "diy" | "other",
  "image_type": "box" | "box_and_shelf_label" | "shelf_label" | "generic" | "unclear",
  "in_store_price": 199.00 | null,
  "in_store_retailer": "Currys" | "Tesco" | "Argos" | "John Lewis" | "B&Q" | "Sainsbury's" | "Wickes" | "Screwfix" | "Lakeland" | "Boots" | "Asda" | "Morrisons" | null,
  "notes": "optional one-line note about ambiguity, omitted if none"
}

PRODUCT IDENTIFICATION RULES (brand / family / model / qualifiers):
- brand: manufacturer (Ninja, Dyson, Apple, Bosch). Null if not visible.
- family: product type (Air Fryer, Cordless Vacuum, Drill, Toaster). Generic enough to be searchable.
- model: exact model code printed on the box (AF400UK, V15 Detect, DCD796N). Null if illegible.
- qualifiers: capacity, colour, kit type, voltage. Examples: ["5.2L", "Black"], ["18V", "Bare Unit"], ["64GB", "Wi-Fi"]. Empty array if none.
- For groceries / consumables: brand+family+pack-size in qualifiers (e.g. brand:"Heinz", family:"Baked Beans", model:null, qualifiers:["415g"]).
- For fashion: brand+family+colour (e.g. brand:"Nike", family:"Air Max 90", model:null, qualifiers:["Black"]).
- DO NOT include retailer names in product fields.
- DO NOT include subjective marketing words.

CONFIDENCE:
- "high"   — brand AND model clearly visible and legible.
- "medium" — brand visible OR model visible, not both.
- "low"    — generic identification only (e.g. unbranded kettle).
- "none"   — image is not a product (face, document, blank surface). Set brand/family/model to null.

IMAGE_TYPE classification (very important — drives downstream UI):
- "box"                  — only the product box visible, no shelf label
- "box_and_shelf_label"  — both visible (best case for shelf-edge OCR)
- "shelf_label"          — only a shelf-edge label visible (no product box)
- "generic"              — generic item without clear branding (a kettle, a cable, a basic remote)
- "unclear"              — too dark, too blurred, occluded, or not identifiable

SHELF-EDGE OCR (in_store_price + in_store_retailer):
If the image contains a UK retailer shelf-edge price label (typically below or beside the product), extract:
- in_store_price: numeric pounds value (e.g. 199.00, 169.99). If only £ amount visible without pence, use .00. NEVER guess if illegible — return null.
- in_store_retailer: identify the retailer from the label colour/logo/wordmark. UK label conventions:
   • Currys      — red and yellow "Currys" wordmark band
   • Tesco       — blue "Tesco" wordmark, or yellow "Special" / "Clubcard Price" labels
   • Argos       — red label with Argos wordmark and a 3- or 7-digit catalogue number
   • John Lewis  — black-and-white minimal label, "Never Knowingly Undersold" or "John Lewis" footer
   • B&Q         — orange band with "B&Q" wordmark
   • Sainsbury's — orange "Nectar Price" tags or standard Sainsbury's wordmark
   • Wickes      — red "Wickes" wordmark
   • Screwfix    — yellow and blue "Screwfix" branding
   • Lakeland    — blue Lakeland wordmark
   • Boots       — Boots blue wordmark
   • Asda        — green Asda wordmark
   • Morrisons   — yellow Morrisons wordmark
- If the shelf label is not present, illegible, or you can't identify the retailer — return null for that field. NEVER hallucinate.

Return ONLY the JSON. No code fences, no preamble.`;

async function callHaikuVision(imageBase64, mediaType, apiKey) {
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
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text',  text: 'Identify this product. Return the JSON schema only.' },
          ],
        }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw Object.assign(new Error('Anthropic error'), { status: r.status, body: txt.slice(0, 200) });
    }
    const data = await r.json();
    const text = ((data.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[${VERSION}] Haiku response not parseable:`, text.slice(0, 200));
      throw new Error('haiku_unparseable');
    }
    return JSON.parse(jsonMatch[0]);
  } finally { clearTimeout(timer); }
}

function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  const mediaType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  return { mediaType, data: match[2] };
}

// Build the legacy `product` string from the new schema for backward compat.
// Old frontend code reads `result.product` — we keep this alive until the
// frontend is updated in Day 2 to consume `brand`/`family`/`model` directly.
function legacyProductString(r) {
  const parts = [r.brand, r.family, r.model].filter(Boolean);
  const qual = Array.isArray(r.qualifiers) ? r.qualifiers.filter(Boolean).join(' ') : '';
  const base = parts.join(' ').trim();
  return [base, qual].filter(Boolean).join(' ').trim() || null;
}

// Validate retailer is on the allow-list. Treat anything else as null
// to avoid surfacing hallucinated retailer names downstream.
const RETAILER_ALLOWLIST = new Set([
  'Currys', 'Tesco', 'Argos', 'John Lewis', 'B&Q', "Sainsbury's",
  'Wickes', 'Screwfix', 'Lakeland', 'Boots', 'Asda', 'Morrisons',
]);

function sanitiseRetailer(r) {
  if (!r || typeof r !== 'string') return null;
  const trimmed = r.trim();
  return RETAILER_ALLOWLIST.has(trimmed) ? trimmed : null;
}

function sanitisePrice(p) {
  if (p === null || p === undefined) return null;
  const n = typeof p === 'number' ? p : parseFloat(String(p).replace(/[£,\s]/g, ''));
  if (!isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}

const IMAGE_TYPE_ALLOWLIST = new Set(['box', 'box_and_shelf_label', 'shelf_label', 'generic', 'unclear']);
const CONFIDENCE_ALLOWLIST = new Set(['high', 'medium', 'low', 'none']);

export default async function handler(req, res) {
  applySecurityHeaders(res, ORIGIN);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  if (rejectIfRateLimited(req, res, 'ai-vision', RATE_LIMIT_PER_HOUR)) return;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'anthropic_not_configured' });

  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'missing_image' });

  const parsed = parseDataUrl(image);
  if (!parsed) {
    return res.status(400).json({
      error:   'invalid_image_format',
      message: 'Expected data URL: data:image/(jpeg|png|webp|gif);base64,...',
    });
  }

  const approxBinaryBytes = Math.floor((parsed.data.length * 3) / 4);
  if (approxBinaryBytes > MAX_IMAGE_BYTES) {
    return res.status(413).json({
      error:   'image_too_large',
      message: 'Image must be under 4MB. Lower the camera quality and retry.',
    });
  }

  const captured_at = new Date().toISOString();

  try {
    const raw = await withCircuit(
      'anthropic',
      () => callHaikuVision(parsed.data, parsed.mediaType, ANTHROPIC_KEY),
      { onOpen: () => null }
    );

    if (!raw) {
      return res.status(503).json({ error: 'anthropic_circuit_open' });
    }

    // Sanitise + normalise the new schema
    const result = {
      brand:      raw.brand ? String(raw.brand).slice(0, 60) : null,
      family:     raw.family ? String(raw.family).slice(0, 60) : null,
      model:      raw.model ? String(raw.model).slice(0, 60) : null,
      qualifiers: Array.isArray(raw.qualifiers)
        ? raw.qualifiers.filter(q => typeof q === 'string').map(q => q.slice(0, 40)).slice(0, 6)
        : [],
      confidence: CONFIDENCE_ALLOWLIST.has(raw.confidence) ? raw.confidence : 'low',
      category:   raw.category || 'other',
      image_type: IMAGE_TYPE_ALLOWLIST.has(raw.image_type) ? raw.image_type : 'unclear',
      in_store_price:    sanitisePrice(raw.in_store_price),
      in_store_retailer: sanitiseRetailer(raw.in_store_retailer),
      captured_at,
      notes:      raw.notes ? String(raw.notes).slice(0, 200) : '',
      model_id:   MODEL,
    };

    // Backward-compat: derive legacy `product` field
    result.product = legacyProductString(result);

    // Empty-product handling — no product detected
    if (!result.product || result.confidence === 'none' || result.image_type === 'unclear') {
      console.log(`[${VERSION}] no product (image_type=${result.image_type}, confidence=${result.confidence})`);
      return res.status(200).json({
        ...result,
        product:    null,
        confidence: 'none',
        notes:      result.notes || 'no_product_recognised',
      });
    }

    console.log(`[${VERSION}] identified: "${result.product}" (${result.confidence}, ${result.image_type}, in_store_price=${result.in_store_price}, retailer=${result.in_store_retailer})`);
    return res.status(200).json(result);
  } catch (e) {
    console.error(`[${VERSION}] error:`, e.message);
    return res.status(502).json({ error: 'vision_failed', message: e.message });
  }
}
OWLIST = new Set([
  'Currys', 'Tesco', 'Argos', 'John Lewis', 'B&Q', "Sainsbury's",
  'Wickes', 'Screwfix', 'Lakeland', 'Boots', 'Asda', 'Morrisons',
]);

function sanitiseRetailer(r) {
  if (!r || typeof r !== 'string') return null;
  const trimmed = r.trim();
  return RETAILER_ALLOWLIST.has(trimmed) ? trimmed : null;
}

function sanitisePrice(p) {
  if (p === null || p === undefined) return null;
  const n = typeof p === 'number' ? p : parseFloat(String(p).replace(/[£,\s]/g, ''));
  if (!isFinite(n) || n <= 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}

const IMAGE_TYPE_ALLOWLIST = new Set(['box', 'box_and_shelf_label', 'shelf_label', 'generic', 'unclear']);
const CONFIDENCE_ALLOWLIST = new Set(['high', 'medium', 'low', 'none']);

export default async function handler(req, res) {
  applySecurityHeaders(res, ORIGIN);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  if (rejectIfRateLimited(req, res, 'ai-vision', RATE_LIMIT_PER_HOUR)) return;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'anthropic_not_configured' });

  const { image } = req.body || {};
  if (!image) return res.status(400).json({ error: 'missing_image' });

  const parsed = parseDataUrl(image);
  if (!parsed) {
    return res.status(400).json({
      error:   'invalid_image_format',
      message: 'Expected data URL: data:image/(jpeg|png|webp|gif);base64,...',
    });
  }

  const approxBinaryBytes = Math.floor((parsed.data.length * 3) / 4);
  if (approxBinaryBytes > MAX_IMAGE_BYTES) {
    return res.status(413).json({
      error:   'image_too_large',
      message: 'Image must be under 4MB. Lower the camera quality and retry.',
    });
  }

  const captured_at = new Date().toISOString();

  try {
    const raw = await withCircuit(
      'anthropic',
      () => callHaikuVision(parsed.data, parsed.mediaType, ANTHROPIC_KEY),
      { onOpen: () => null }
    );

    if (!raw) {
      return res.status(503).json({ error: 'anthropic_circuit_open' });
    }

    const result = {
      brand:      raw.brand ? String(raw.brand).slice(0, 60) : null,
      family:     raw.family ? String(raw.family).slice(0, 60) : null,
      model:      raw.model ? String(raw.model).slice(0, 60) : null,
      qualifiers: Array.isArray(raw.qualifiers)
        ? raw.qualifiers.filter(q => typeof q === 'string').map(q => q.slice(0, 40)).slice(0, 6)
        : [],
      confidence: CONFIDENCE_ALLOWLIST.has(raw.confidence) ? raw.confidence : 'low',
      category:   raw.category || 'other',
      image_type: IMAGE_TYPE_ALLOWLIST.has(raw.image_type) ? raw.image_type : 'unclear',
      in_store_price:    sanitisePrice(raw.in_store_price),
      in_store_retailer: sanitiseRetailer(raw.in_store_retailer),
      captured_at,
      notes:      raw.notes ? String(raw.notes).slice(0, 200) : '',
      model_id:   MODEL,
    };

    result.product = legacyProductString(result);

    if (!result.product || result.confidence === 'none' || result.image_type === 'unclear') {
      console.log(`[${VERSION}] no product (image_type=${result.image_type}, confidence=${result.confidence})`);
      return res.status(200).json({
        ...result,
        product:    null,
        confidence: 'none',
        notes:      result.notes || 'no_product_recognised',
      });
    }

    console.log(`[${VERSION}] identified: "${result.product}" (${result.confidence}, ${result.image_type}, in_store_price=${result.in_store_price}, retailer=${result.in_store_retailer})`);
    return res.status(200).json(result);
  } catch (e) {
    console.error(`[${VERSION}] error:`, e.message);
    return res.status(502).json({ error: 'vision_failed', message: e.message });
  }
}
atch (e) {
    console.error(`[${VERSION}] error:`, e.message);
    return res.status(502).json({ error: 'vision_failed', message: e.message });
  }
}
