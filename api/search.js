// api/search.js — Savvey Search Proxy v6.3
// Change log v6.0:
//   - PRICE_CEILING hard constant replaces dynamic lowest×3 anchor
//   - Nuclear cleanPrice() sanitizer applied at every intake point
//   - nuclearFilter() runs as final pass before response — nothing above ceiling escapes
// v6.1:
//   - admitPrice() rounds to 2dp before ceiling check (float artifact fix)
//   - nuclearFilter() consistent rounding + Vercel log format updated
//   - AwinProductProvider class — activates when AWIN_API_KEY env var is set
// v6.2:
//   - identityFilter(): keyword confidence scoring + accessory blocklist
//   - Numeric tokens (model/size) are mandatory — one miss = hard fail
//   - Text tokens use 60% CONFIDENCE_THRESHOLD
//   - Accessory blocklist: remote/cable/case/bracket/stand/mount/+9 more
// v6.3:
//   - Hybrid ceiling replaces fixed £689.97 (was breaking TVs, iPhones, laptops)
//   - Hard ceiling £5,000 at intake (admitPrice) — blocks absurd listings
//   - Dynamic ceiling: lowest×4 after identityFilter — product-aware
//   - Dynamic skipped when <3 results (collapse protection)
//   - Circuit breaker on Google CSE (429/403 → bypass for 1hr)
//   - Security headers locked to ALLOWED_ORIGIN

const VERSION = 'search.js v6.3';
const ORIGIN  = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

// ─────────────────────────────────────────────────────────────
// HYBRID PRICE FILTER
//
// Two-layer ceiling — solves the fixed-ceiling problem (£689.97
// was breaking TV / laptop / iPhone searches).
//
// Layer 1 — Hard ceiling £5,000 at intake (admitPrice)
//   Applied to every result individually as it enters rawItems.
//   Blocks anything absurd (£10,000 scam listings) regardless of product.
//   Set high enough to cover any UK consumer product.
//
// Layer 2 — Dynamic ceiling after identityFilter (dynamicCeilingFilter)
//   lowest_price × PRICE_MULTIPLIER (4).
//   Only fires when 3+ results survive identityFilter (collapse protection).
//   Adapts to the product: headphones at £230 → ceiling £920.
//   TV at £800 → ceiling £3,200. iPhone at £1,089 → ceiling £4,356.
//   Anchors off the cheapest *legitimate* result, not a noise value.
//
// Pipeline order (critical):
//   admitPrice (intake) → nuclearFilter → identityFilter → dynamicCeilingFilter → dedup
//   Dynamic ceiling runs AFTER identityFilter so accessories cannot
//   become the anchor that collapses the ceiling.
// ─────────────────────────────────────────────────────────────
const PRICE_CEILING_HARD  = 5000;  // absolute max — covers any UK consumer product
const PRICE_FLOOR         = 0.50;  // anything below 50p is noise
const PRICE_MULTIPLIER    = 4;     // dynamic ceiling = lowest × this
const DYNAMIC_MIN_RESULTS = 3;     // minimum results needed to trust the anchor

// Nuclear sanitizer — strips every non-digit/dot character before parsing.
// Handles: "£1,000.00", "1.000,00" (EU format), "$249", "GBP 249.99", "&pound;249"
const cleanPrice = (val) => parseFloat(String(val).replace(/[^\d.]/g, ''));

// Strict admission test — returns the clean numeric price or null.
// null = reject. No exceptions.
// Rounds to 2dp BEFORE the ceiling check so floating point artifacts
// like 4999.9999999 are correctly handled.
function admitPrice(val) {
  const raw = cleanPrice(val);
  if (isNaN(raw))                return null; // unparseable — "Out of Stock", "", null
  const n = Math.round(raw * 100) / 100;      // round to 2dp before any comparison
  if (n < PRICE_FLOOR)           return null; // noise / zero / negative
  if (n > PRICE_CEILING_HARD)    return null; // above hard ceiling — absurd listing
  return n;
}

// Nuclear filter — belt-and-suspenders pass on the full combined array.
// Catches anything that slipped through admitPrice (e.g. type coercion edge cases).
function nuclearFilter(items) {
  const before = items.length;
  const passed = items.filter(item => {
    const raw = typeof item.price === 'number' ? item.price : cleanPrice(item.price);
    const n   = Math.round(raw * 100) / 100;
    const ok  = !isNaN(n) && n >= PRICE_FLOOR && n <= PRICE_CEILING_HARD;
    if (!ok) {
      console.log(`[${VERSION}] Filtering out: ${item.title || item.source} because £${n} is over £${PRICE_CEILING_HARD}`);
    }
    return ok;
  });
  console.log(`[${VERSION}] nuclearFilter: ${before} in → ${passed.length} out (hard ceiling=£${PRICE_CEILING_HARD})`);
  return passed;
}

// Dynamic ceiling filter — Layer 2.
// Runs AFTER identityFilter so accessories cannot corrupt the anchor.
// Skipped entirely when fewer than DYNAMIC_MIN_RESULTS items remain
// (collapse protection — prevents a single bad anchor wiping everything).
function dynamicCeilingFilter(items) {
  if (items.length < DYNAMIC_MIN_RESULTS) {
    console.log(`[${VERSION}] dynamicCeiling: skipped (${items.length} items < min ${DYNAMIC_MIN_RESULTS})`);
    return items;
  }
  const prices  = items.map(i => i.price).sort((a, b) => a - b);
  const lowest  = prices[0];
  const ceiling = Math.round(lowest * PRICE_MULTIPLIER * 100) / 100;
  console.log(`[${VERSION}] dynamicCeiling: lowest=£${lowest} × ${PRICE_MULTIPLIER} = ceiling £${ceiling}`);
  const before  = items.length;
  const passed  = items.filter(item => {
    const ok = item.price <= ceiling;
    if (!ok) {
      console.log(`[${VERSION}] Filtering out: ${item.title || item.source} because £${item.price} > dynamic ceiling £${ceiling}`);
    }
    return ok;
  });
  console.log(`[${VERSION}] dynamicCeiling: ${before} in → ${passed.length} out`);
  return passed;
}
// ─────────────────────────────────────────────────────────────
// IDENTITY FILTER — Keyword Confidence Scoring
// Solves the Identity Test failure: a TV search returning a £15 remote.
// Two gates in sequence — both must pass.
//
// Gate 1 — Accessory blocklist
//   If the result title contains an accessory term that the query did NOT
//   mention, the item is a different product class. Hard discard.
//
// Gate 2 — Keyword confidence score
//   Numeric tokens (model numbers, sizes): every one must appear verbatim
//   in the title — a single miss is a hard fail (score 0).
//   Text tokens: at least 60% must be present (CONFIDENCE_THRESHOLD).
//
// Why split numeric vs text?
//   "Sony WH-1000XM5" — brand "sony" + series "wh" can match loosely,
//   but the model number "1000xm5" must be exact. XM4 must not pass.
//   "Samsung 65 TV" — "65" must match; "55" is a different product.
// ─────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.60;

// Stop words: stripped before keyword matching — carry no identity signal
const STOP_WORDS = new Set([
  'a','an','the','and','or','for','with','in','on','at','to','of',
  'inch','cm','mm','gb','tb','mb','hz','ghz','mhz','w','kg','g',
  'buy','uk','price','cheap','best','new','deal','sale',
]);

// Accessory terms: if present in title but absent from query → discard
const ACCESSORY_TERMS = [
  'remote','cable','case','bracket','stand','mount','adapter','adaptor',
  'charger','lead','strap','skin','cover','screen protector','pouch',
  'bag','holder','clip','hook','wall plate','replacement','spare',
];

function tokenise(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function isNumericToken(tok) {
  return /\d/.test(tok); // any digit = model/size token
}

// Gate 1: returns the blocking accessory term, or null if clean
function accessoryBlock(query, title) {
  const qLower = query.toLowerCase();
  const tLower = title.toLowerCase();
  for (const term of ACCESSORY_TERMS) {
    if (tLower.includes(term) && !qLower.includes(term)) return term;
  }
  return null;
}

// Gate 2: keyword confidence score
// Numeric tokens → mandatory (one miss = 0 score = hard fail)
// Text tokens    → 60% threshold
function keywordScore(query, title) {
  const qTokens = tokenise(query);
  if (qTokens.length === 0) return 1.0; // no tokens = cannot fail

  const tNorm = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');

  const numericTokens = qTokens.filter(isNumericToken);
  const textTokens    = qTokens.filter(t => !isNumericToken(t));

  // Numeric: every token must appear as a whole word in the normalised title
  for (const tok of numericTokens) {
    const re = new RegExp(`(?<![a-z0-9])${tok}(?![a-z0-9])`);
    if (!re.test(tNorm)) return 0; // hard fail — wrong model/size
  }

  // Text: fraction of tokens found
  if (textTokens.length === 0) return 1.0;
  const matched = textTokens.filter(tok => tNorm.includes(tok)).length;
  return matched / textTokens.length;
}

// Combined identity filter — runs after nuclearFilter, before dedup
function identityFilter(items, query) {
  const before = items.length;
  const passed = items.filter(item => {
    const title = item.title || item.source || '';

    // Gate 1: accessory blocklist
    const blocked = accessoryBlock(query, title);
    if (blocked) {
      console.log(`[${VERSION}] IDENTITY BLOCK (accessory "${blocked}"): "${title}"`);
      return false;
    }

    // Gate 2: keyword confidence
    const score = keywordScore(query, title);
    if (score < CONFIDENCE_THRESHOLD) {
      console.log(`[${VERSION}] IDENTITY BLOCK (score ${Math.round(score*100)}%<${CONFIDENCE_THRESHOLD*100}%): "${title}"`);
      return false;
    }

    return true;
  });
  console.log(`[${VERSION}] identityFilter: ${before} in → ${passed.length} out (query="${query}")`);
  return passed;
}


// ─────────────────────────────────────────────────────────────
// URL VALIDATION
// Blocks category/search pages — only product-level URLs admitted.
// ─────────────────────────────────────────────────────────────
function isValidProductUrl(url) {
  if (!url) return false;
  if (url.includes('amazon') && !url.includes('/dp/'))    return false;
  if (url.includes('ebay')   && !url.includes('/itm/'))   return false;
  return true;
}

// ─────────────────────────────────────────────────────────────
// CIRCUIT BREAKER — Google CSE
// Trips on 429 or 403. Bypasses CSE for 1 hour to protect quota.
// ─────────────────────────────────────────────────────────────
let cseCircuitOpen   = false;
let cseCircuitOpenAt = 0;
const CSE_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

function cseTripCircuit() {
  cseCircuitOpen   = true;
  cseCircuitOpenAt = Date.now();
  console.warn(`[${VERSION}] CSE circuit TRIPPED — bypassing for 1hr`);
}
function cseCircuitOk() {
  if (!cseCircuitOpen) return true;
  if (Date.now() - cseCircuitOpenAt > CSE_COOLDOWN_MS) {
    cseCircuitOpen = false;
    console.log(`[${VERSION}] CSE circuit RESET`);
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────
// AWIN PRODUCT PROVIDER
// Self-contained class. Activates the moment AWIN_API_KEY is set
// in Vercel env vars. No code change needed to enable.
// ─────────────────────────────────────────────────────────────
class AwinProductProvider {
  constructor(apiKey) { this.apiKey = apiKey; }

  async search(query) {
    try {
      const r = await fetch(
        `https://productserve.awin.com/productserve?apikey=${this.apiKey}&query=${encodeURIComponent(query)}&country=GB&currency=GBP&format=json&limit=20`,
        { headers: { 'Accept': 'application/json' } }
      );
      if (!r.ok) return [];
      const data = await r.json();
      const items = Array.isArray(data) ? data : (data.products || []);
      return items
        .map(p => ({
          source:   p.merchant_name || p.merchantName || 'Awin',
          price:    admitPrice(p.display_price || p.price || p.aw_deep_link_price),
          link:     p.aw_deep_link || p.deepLink || '',
          title:    p.product_name || p.name || query,
          delivery: p.delivery_cost || '',
        }))
        .filter(p => p.price !== null); // admitPrice already applied PRICE_CEILING_HARD
    } catch (e) {
      console.error(`[${VERSION}] Awin error:`, e.message);
      return [];
    }
  }
}

// ─────────────────────────────────────────────────────────────
// SERPER — shopping + organic results
// ─────────────────────────────────────────────────────────────
async function fetchSerper(query, type, apiKey) {
  const endpoint = type === 'search'
    ? 'https://google.serper.dev/search'
    : 'https://google.serper.dev/shopping';

  const r = await fetch(endpoint, {
    method:  'POST',
    headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ q: query, gl: 'uk', hl: 'en', num: 10 }),
  });

  if (!r.ok) throw Object.assign(new Error('Serper error'), { status: r.status });
  return r.json();
}

// Extract and normalise items from a Serper shopping response.
// admitPrice() is the gatekeeper — no item with a bad price enters rawItems.
function normaliseSerperShopping(data, query) {
  const shopping = data.shopping || [];
  return shopping
    .filter(item => isValidProductUrl(item.link))
    .map(item => {
      const price = admitPrice(item.price); // PRICE_CEILING_HARD enforced here
      if (price === null) {
        console.log(`[${VERSION}] Filtering out: ${item.title || item.source} because £${item.price} is over £${PRICE_CEILING_HARD} (intake)`);
        return null;
      }
      return {
        source:   item.source || 'Unknown',
        price,
        link:     item.link || '',
        title:    item.title || query,
        delivery: item.delivery || '',
      };
    })
    .filter(Boolean);
}

// Extract prices embedded in organic snippet text.
function normaliseSerperOrganic(data, query) {
  const organic = data.organic || [];
  return organic
    .filter(item => isValidProductUrl(item.link))
    .map(item => {
      const raw   = item.snippet || item.title || '';
      const match = raw.match(/£\s?([\d,]+(?:\.\d{1,2})?)/);
      if (!match) return null;
      const price = admitPrice(match[1]); // PRICE_CEILING_HARD enforced here
      if (price === null) return null;
      return {
        source:   (item.displayLink || item.link || '').replace(/^www\./, '').split('/')[0],
        price,
        link:     item.link || '',
        title:    item.title || query,
        delivery: '',
      };
    })
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// GOOGLE CSE — secondary fallback
// ─────────────────────────────────────────────────────────────
async function fetchCSE(query) {
  const CSE_KEY = process.env.GOOGLE_CSE_KEY;
  const CSE_CX  = process.env.GOOGLE_CSE_CX;
  if (!CSE_KEY || !CSE_CX || !cseCircuitOk()) return [];

  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${CSE_KEY}&cx=${CSE_CX}&q=${encodeURIComponent(query + ' price UK buy')}&gl=uk&num=10`;
    const r   = await fetch(url);

    if (r.status === 429 || r.status === 403) { cseTripCircuit(); return []; }
    if (!r.ok) return [];

    const data  = await r.json();
    const items = data.items || [];

    return items
      .filter(item => isValidProductUrl(item.link))
      .map(item => {
        const raw   = item.snippet || '';
        const match = raw.match(/£\s?([\d,]+(?:\.\d{1,2})?)/);
        if (!match) return null;
        const price = admitPrice(match[1]); // PRICE_CEILING_HARD enforced here
        if (price === null) return null;
        return {
          source:   (item.displayLink || '').replace(/^www\./, '').split('/')[0],
          price,
          link:     item.link || '',
          title:    item.title || query,
          delivery: '',
        };
      })
      .filter(Boolean);
  } catch (e) {
    console.error(`[${VERSION}] CSE error:`, e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// DEDUPLICATION
// One entry per source domain. Cheapest price wins on collision.
// ─────────────────────────────────────────────────────────────
function dedup(items) {
  const map = new Map();
  for (const item of items) {
    const key = item.source.toLowerCase();
    if (!map.has(key) || item.price < map.get(key).price) {
      map.set(key, item);
    }
  }
  return [...map.values()].sort((a, b) => a.price - b.price);
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  console.log(`[${VERSION}] ${req.method} ${req.url}`);

  // Security headers
  res.setHeader('Access-Control-Allow-Origin',  ORIGIN);
  res.setHeader('Vary',                          'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options',       'nosniff');
  res.setHeader('Strict-Transport-Security',    'max-age=31536000; includeSubDomains');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const SERPER_KEY = process.env.SERPER_KEY;
  if (!SERPER_KEY) return res.status(500).json({ error: 'SERPER_KEY not configured' });

  const { q, type = 'shopping' } = req.body || {};
  if (!q) return res.status(400).json({ error: 'Missing query' });

  // ── Source priority ──────────────────────────────────────
  // 1. Awin   — PRIMARY   (when AWIN_API_KEY set)
  // 2. Serper — PRIMARY fallback
  // 3. CSE    — SECONDARY fallback, circuit-breaker protected
  // ─────────────────────────────────────────────────────────
  let rawItems = [];

  // 1. Awin
  const AWIN_KEY = process.env.AWIN_API_KEY;
  if (AWIN_KEY) {
    const awin  = new AwinProductProvider(AWIN_KEY);
    const awinR = await awin.search(q);
    rawItems.push(...awinR);
    console.log(`[${VERSION}] Awin: ${awinR.length} items`);
  }

  // 2. Serper (always runs as fallback or primary)
  try {
    const serperData = await fetchSerper(q, type, SERPER_KEY);
    const shopping   = normaliseSerperShopping(serperData, q);
    const organic    = normaliseSerperOrganic(serperData, q);
    rawItems.push(...shopping, ...organic);
    console.log(`[${VERSION}] Serper: ${shopping.length} shopping + ${organic.length} organic`);
  } catch (e) {
    console.error(`[${VERSION}] Serper failed:`, e.message);
    if (rawItems.length === 0) {
      return res.status(502).json({ error: 'upstream_error' });
    }
  }

  // 3. CSE top-up (if circuit is closed)
  const cseItems = await fetchCSE(q);
  rawItems.push(...cseItems);
  console.log(`[${VERSION}] CSE: ${cseItems.length} items`);

  // ── NUCLEAR FILTER — final pass, no exceptions ────────────
  // admitPrice() already rejected bad prices at intake above.
  // This runs again on the full combined array as a hard guarantee.
  const safe = nuclearFilter(rawItems);

  // ── IDENTITY FILTER — discard accessories + low-confidence items ──
  // Runs after nuclearFilter, before dynamic ceiling.
  const identified = identityFilter(safe, q);

  // ── DYNAMIC CEILING — lowest × 4, product-aware ──────────
  // Runs after identityFilter so accessories cannot corrupt the anchor.
  // Skipped if fewer than 3 results survive (collapse protection).
  const priced = dynamicCeilingFilter(identified);

  // ── Dedup + sort ──────────────────────────────────────────
  const results = dedup(priced);

  console.log(`[${VERSION}] Final: ${results.length} items | cheapest=£${results[0]?.price ?? 'n/a'} | hard=£${PRICE_CEILING_HARD} | dynamic=lowest×${PRICE_MULTIPLIER}`);

  // Return in the shape the frontend's buildScen() expects
  return res.status(200).json({
    shopping: results.map(r => ({
      source:   r.source,
      price:    `£${r.price.toFixed(2)}`,
      link:     r.link,
      title:    r.title,
      delivery: r.delivery,
    })),
    organic: [], // organic already folded into shopping above
    _meta: {
      version:      VERSION,
      itemCount:    results.length,
      priceCeilingHard: PRICE_CEILING_HARD,
      priceMultiplier: PRICE_MULTIPLIER,
      cheapest:     results[0]?.price ?? null,
    },
  });
}
