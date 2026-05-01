// api/ai-wit.js — Savvey AI Wit Generator v1.1
//
// v1.1 (2 May 2026 evening):
//   - Imports applySecurityHeaders from _shared.js
//   - Rate limit: 60 calls/IP/hour (higher than ai-search since wit fires
//     async after every render; budget reflects realistic usage pattern)
//   - Circuit breaker on Anthropic shared with ai-search — if Anthropic
//     trips for any endpoint, wit also bypasses. Returns null wit so the
//     frontend hardcoded fallback takes over. App never breaks.
//
// Cost: ~£0.0005 per call. At 1000 daily user searches = £15/month.

import { applySecurityHeaders }            from './_shared.js';
import { rejectIfRateLimited }             from './_rateLimit.js';
import { withCircuit }                     from './_circuitBreaker.js';

const VERSION   = 'ai-wit.js v1.1';
const ORIGIN    = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL              = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS         = 4000;
const MAX_TOKENS         = 80;
const RATE_LIMIT_PER_HOUR = 60;

const SYSTEM_PROMPT = `You are Savvey, a UK price-comparison app with a dry mate-down-the-pub voice. Write ONE punchy verdict line about a price comparison the user just made.

Brand rules:
- Address the user as "you" — they are the savvey one who spotted the deal. Never blame them.
- The retailer being expensive is the foil — but be playful, not cruel.
- Use UK-cultural reference units when measuring savings: Tesco meal deal (£3.50), Greggs sausage roll (£1.30), pint (£5), Netflix subscription (£10/mo), tank of petrol (£70), train fare to Manchester (£40), weekend in Edinburgh (£200), flight to Italy (£150).
- Per-retailer character if relevant:
  * Currys = bumbling overcharge ("Currys, more worries")
  * John Lewis = aspirational pricing
  * Argos = caught out, surprised
  * Amazon = clever-algorithm-gone-wrong
  * Very = catalogue-pricing nostalgia
  * AO = sneaky pricing
  * Selfridges = paying for the postcode
  * eBay = wild-west seller
- Maximum 18 words. Brevity is the voice. ONE line.
- Never say "ripped off" or "rip-off". Never moralise.
- It should feel like a friend texting you, not a corporate slogan.

Example tone calibration (don't copy verbatim — riff):
- "You'd save eight Tesco meal deals. Currys priced this with the heating on."
- "You spotted it — Argos hoped you'd still be using the laminated catalogue."
- "Bezos doesn't need your £80. AO does."
- "Rare moment — you found the actual best UK price. Buy with confidence."

Output: ONLY the wit line, no preamble, no quotes, no explanation.`;

async function callAnthropic(userPrompt, apiKey) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM_PROMPT, messages: [{ role: 'user', content: userPrompt }] }),
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

function clean(text) {
  if (!text) return '';
  let t = String(text).trim();
  t = t.replace(/^(sure[,!]?|here'?s|certainly[,!]?|verdict[:!]?|line[:!]?)\s+/i, '').trim();
  t = t.replace(/^["'`""]+|["'`""]+$/g, '').trim();
  if (t.length > 200) t = t.slice(0, 200);
  return t;
}

export default async function handler(req, res) {
  applySecurityHeaders(res, ORIGIN);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  if (rejectIfRateLimited(req, res, 'ai-wit', RATE_LIMIT_PER_HOUR)) return;

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return res.status(503).json({ error: 'anthropic_not_configured' });

  const { product, retailer, bestRetailer, bestPrice, saving, score, spc } = req.body || {};
  if (!product || !spc) return res.status(400).json({ error: 'missing_fields' });

  const userPrompt = [
    `Product: ${product}`,
    `Verdict colour: ${spc} (red=overpaying, amber=close, green=best price)`,
    score != null ? `Savvey Score: ${score}/5` : null,
    typeof bestPrice === 'number' ? `Cheapest UK price: £${bestPrice}` : null,
    bestRetailer ? `Cheapest retailer: ${bestRetailer}` : null,
    typeof saving === 'number' && saving > 0 ? `User overpaying by: £${saving}` : null,
    retailer && spc !== 'green' ? `Retailer being expensive: ${retailer}` : null,
    '',
    'Write the wit line now — single sentence, max 18 words, in Savvey voice.',
  ].filter(Boolean).join('\n');

  try {
    const raw = await withCircuit('anthropic',
      () => callAnthropic(userPrompt, ANTHROPIC_KEY),
      { onOpen: () => '' }   // circuit open → return empty, frontend uses hardcoded
    );
    const wit = clean(raw);
    if (!wit) return res.status(200).json({ wit: null, error: 'empty_response' });
    console.log(`[${VERSION}] "${product}" → "${wit}"`);
    return res.status(200).json({ wit, model: MODEL });
  } catch (e) {
    console.error(`[${VERSION}] error:`, e.message);
    return res.status(200).json({ wit: null, error: e.message });
  }
}
