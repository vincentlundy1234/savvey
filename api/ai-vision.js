// api/ai-vision.js — Savvey AI Vision v1.0
//
// v1.0 (1 May 2026):
//   - Accepts a single base64 image data URL via POST { image }
//   - Calls Claude Haiku 4.5 vision with a UK-retail product-identification
//     system prompt. Haiku returns a structured JSON: product name,
//     confidence band, category, optional ambiguity note.
//   - Frontend uses the product name as the search query against
//     /api/ai-search, slotting into the same pipeline as a typed search.
//   - Cost: ~£0.005 per call. At 100 daily snaps = £15/month — same order
//     as ai-wit. Set MAX_IMAGE_BYTES low enough to keep cost predictable.
//
// Hardening parity with ai-search.js v1.5:
//   - applySecurityHeaders from _shared
//   - rate limit 30/IP/hour via _rateLimit
//   - circuit breaker on Anthropic via _circuitBreaker
//   - 4MB image cap (under Vercel's 4.5MB body limit)

import { applySecurityHeaders } from './_shared.js';
import { rejectIfRateLimited }  from './_rateLimit.js';
import { withCircuit }          from './_circuitBreaker.js';

const VERSION    = 'ai-vision.js v1.0';
const ORIGIN     = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL              = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS         = 8000;
const MAX_TOKENS         = 220;
const RATE_LIMIT_PER_HOUR = 30;
// 4MB binary; base64 encodes ~33% larger so ~5.4MB on the wire. Vercel
// hobby/pro have a 4.5MB serverless function body limit, so we accept up
// to that, then reject with 413.
const MAX_IMAGE_BYTES    = 4 * 1024 * 1024;

const SYSTEM_PROMPT = `You are a UK product identification tool for Savvey, a price-comparison app. The user has just taken a photo of a product they want to compare prices on across UK retailers (Amazon UK, Argos, John Lewis, Currys, Tesco, etc.).

Your task: identify the product in the image and return the most-searchable UK retail product name. The name will be fed directly into a search engine across UK retailers, so it must be specific enough to retrieve the correct product but not so over-specific that no listing matches.

Identification rules:
- Be specific: include brand AND model where visible (e.g. "Sony WH-1000XM5", not "wireless headphones").
- For groceries / consumables: include brand and pack size where visible (e.g. "Heinz Baked Beans 415g", "Cadbury Dairy Milk 110g").
- For clothing / fashion: include brand, type, and primary colour (e.g. "Nike Air Max 90 Black").
- For homeware / appliances: include brand, model, and key spec (e.g. "Ninja Foodi 7-in-1 Multi-Cooker OP300UK").
- Do NOT include retailer names ("from Argos") — that's the comparison the user wants done FOR them.
- Do NOT include subjective marketing words ("amazing", "premium") unless they're literally part of the product name.
- If you can read a barcode in the image, do NOT return the barcode digits — return the product name visible on the packaging.

Confidence levels:
- "high"   — brand + specific model are clearly visible and legible.
- "medium" — brand visible OR specific model visible, not both. Searchable but may surface variants.
- "low"    — generic identification only (e.g. "wireless earbuds, black"). Search likely to be noisy.
- "none"   — image is not a product (face, document, blank surface, etc.) — set product to null.

Categories (pick one): "electronics" | "grocery" | "fashion" | "homeware" | "beauty" | "toy" | "other"

Return ONLY a JSON object, no preamble or markdown:
{
  "product": "Sony WH-1000XM5" | null,
  "confidence": "high" | "medium" | "low" | "none",
  "category": "electronics",
  "notes": "optional one-line note about ambiguity, omitted if none"
}`;

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
            { type: 'text',  text: 'Identify this product.' },
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

// Parse a data URL of the form "data:image/jpeg;base64,/9j/...". Returns
// { mediaType, data } or null. Rejects non-image data, unsupported formats.
function parseDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return null;
  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return null;
  // Anthropic accepts: image/jpeg, image/png, image/gif, image/webp.
  // Normalise jpg → jpeg for media_type compliance.
  const mediaType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  return { mediaType, data: match[2] };
}

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

  // Base64 expands binary by ~33%. Convert back for the size check.
  const approxBinaryBytes = Math.floor((parsed.data.length * 3) / 4);
  if (approxBinaryBytes > MAX_IMAGE_BYTES) {
    return res.status(413).json({
      error:   'image_too_large',
      message: 'Image must be under 4MB. Lower the camera quality and retry.',
    });
  }

  try {
    const result = await withCircuit(
      'anthropic',
      () => callHaikuVision(parsed.data, parsed.mediaType, ANTHROPIC_KEY),
      { onOpen: () => null }
    );

    if (!result) {
      return res.status(503).json({ error: 'anthropic_circuit_open' });
    }
    if (!result.product || result.confidence === 'none') {
      return res.status(200).json({
        product:    null,
        confidence: 'none',
        category:   result.category || 'other',
        notes:      result.notes || 'no_product_recognised',
      });
    }
    console.log(`[${VERSION}] identified: "${result.product}" (${result.confidence}, ${result.category || 'other'})`);
    return res.status(200).json({
      product:    String(result.product).slice(0, 200),
      confidence: ['high','medium','low','none'].includes(result.confidence) ? result.confidence : 'unknown',
      category:   result.category || 'other',
      notes:      result.notes || '',
      model:      MODEL,
    });
  } catch (e) {
    console.error(`[${VERSION}] error:`, e.message);
    return res.status(502).json({ error: 'vision_failed', message: e.message });
  }
}
