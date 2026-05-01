// api/search.js — Savvey Search Proxy v6.7
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
// v6.4:
//   - eBay/Amazon hygiene: condition blocklist (refurb/used/spares/broken/etc.)
//     extended into ACCESSORY_TERMS so non-New listings get killed by identityFilter
//   - hardenEbayUrl(): defensive LH_ItemCondition=3 query param on outbound eBay links
//   - Serper resilience: 8s per-attempt timeout via AbortController + one retry
//     on transient failures (5xx / network abort), no retry on 4xx
// v6.5:
//   - trustedSourceFilter(): new pipeline stage — drops non-UK / peer-to-peer
//     marketplaces (Mercari, Poshmark, Reverb, Crutchfield, Phonesrefurb, etc.)
//     before the dynamic ceiling anchors. TRUSTED_DOMAINS mirrors frontend
//     UK_RETAILERS list (13 retailers).
//   - ACCESSORY_TERMS extended with refurb euphemisms (grade b/c, pristine
//     condition, scratched, blemished, cosmetic damage, dented, cracked,
//     tested working) — kills the £89.99 "best price" knockoff problem.
// v6.6:
//   - Serper timeout reduced 8s → 5s; retry removed entirely (was compounding
//     to 16s per call × 2 parallel from frontend, breaching Vercel's 15s
//     function limit on cold starts and causing CDP timeouts during testing).
//   - Frontend now fires a single /api/search call (shopping only); the
//     second call was unused by the mapping step.
// v6.6.1:
//   - Debug envelope (?debug=true): per-stage pipeline counts + raw/identity
//     samples for diagnosing zero-result queries without crawling Vercel logs.
// v6.7:
//   - Trust filter rewritten as two-tier: TLD-based (.co.uk/.uk) + explicit
//     allowlist for UK-trading .com brands (Selfridges, McGrocer, Harvey
//     Nichols, M&S, Next, Fortnum & Mason) + eBay global. Diagnostic via
//     debug envelope showed v6.5/v6.6 trust filter rejected legitimate UK
//     retailers like Selfridges/McGrocer because they weren't enumerated;
//     TLD-based rule covers the long tail correctly.

const VERSION = 'search.js v6.7';
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
//   admitPrice (intake) → nuclearFilter → identityFilter → trustedSourceFilter → dynamicCeilingFilter → dedup
//   Dynamic ceiling runs AFTER identityFilter and trust filter so accessories
//   and untrusted-source listings cannot become the anchor.
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
// ─────────────────────────────────────────────────────────────

const CONFIDENCE_THRESHOLD = 0.60;

const STOP_WORDS = new Set([
  'a','an','the','and','or','for','with','in','on','at','to','of',
  'inch','cm','mm','gb','tb','mb','hz','ghz','mhz','w','kg','g',
  'buy','uk','price','cheap','best','new','deal','sale',
]);

const ACCESSORY_TERMS = [
  // Accessories — different product class
  'remote','cable','case','bracket','stand','mount','adapter','adaptor',
  'charger','lead','strap','skin','cover','screen protector','pouch',
  'bag','holder','clip','hook','wall plate','replacement','spare',
  // Condition — non-New listings
  'refurbished','refurb','used','pre-owned','preowned','open box',
  'broken','faulty','damaged','spares or repair','for parts','not working',
  // Refurb euphemisms + physical defects
  'grade b','grade c','scratched','blemished','pristine condition',
  'cosmetic damage','dented','cracked','tested working',
];

function tokenise(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function isNumericToken(tok) {
  return /\d/.test(tok);
}

function accessoryBlock(query, title) {
  const qLower = query.toLowerCase();
  const tLower = title.toLowerCase();
  for (const term of ACCESSORY_TERMS) {
    if (tLower.includes(term) && !qLower.includes(term)) return term;
  }
  return null;
}

function keywordScore(query, title) {
  const qTokens = tokenise(query);
  if (qTokens.length === 0) return 1.0;

  const tNorm = title.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');

  const numericTokens = qTokens.filter(isNumericToken);
  const textTokens    = qTokens.filter(t => !isNumericToken(t));

  for (const tok of numericTokens) {
    const re = new RegExp(`(?<![a-z0-9])${tok}(?![a-z0-9])`);
    if (!re.test(tNorm)) return 0;
  }

  if (textTokens.length === 0) return 1.0;
  const matched = textTokens.filter(tok => tNorm.includes(tok)).length;
  return matched / textTokens.length;
}

function identityFilter(items, query) {
  const before = items.length;
  const passed = items.filter(item => {
    const title = item.title || item.source || '';

    const blocked = accessoryBlock(query, title);
    if (blocked) {
      console.log(`[${VERSION}] IDENTITY BLOCK (accessory "${blocked}"): "${title}"`);
      return false;
    }

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
// TRUSTED SOURCE FILTER — two-tier
//
// Tier 1 — TLD allowlist
//   Any URL whose hostname ends in .co.uk, .uk, or .com.gb is treated as
//   UK-shoppable. This naturally excludes US-only marketplaces (Mercari,
//   Poshmark, Whatnot, Crutchfield, Phonesrefurb, Unclaimed Baggage, Impulse,
//   Reverb) without needing to enumerate every reject. The trade-off is that
//   peer-to-peer .co.uk sellers could slip through; identityFilter's condition
//   blocklist (refurb / grade b / scratched / pristine condition / etc.)
//   handles the residual quality risk.
//
// Tier 2 — explicit .com brands
//   UK-trading retailers and global brands worth surfacing despite the .com
//   TLD: Selfridges (UK luxury department store), McGrocer (UK grocery),
//   Harvey Nichols (UK luxury), Marks & Spencer global, John Lewis global,
//   Next, Fortnum & Mason, and eBay global (eBay's product URLs are often
//   ebay.com even on UK-targeted Serper results; the LH_ItemCondition=3
//   hardening + condition blocklist do the quality work).
// ─────────────────────────────────────────────────────────────

// Tier 1: anything on these TLDs is UK-shoppable by definition
const UK_TLDS = ['.co.uk', '.uk', '.com.gb'];

// Tier 2: explicit .com domains for UK-trading brands + global retailers
const TRUSTED_DOMAINS = [
  // Frontend-affiliated UK retailers (full set, retained from prior version)
  'amazon.co.uk', 'currys.co.uk', 'johnlewis.com', 'argos.co.uk',
  'ao.com', 'very.co.uk', 'richersounds.com', 'box.co.uk',
  'ebay.co.uk', 'halfords.com', 'screwfix.com', 'boots.com', 'costco.co.uk',
  // Global brands that operate in UK and surface on Serper UK shopping
  'ebay.com',                  // eBay global — listings often have .com URLs
  'amazon.com',                // rare on UK searches but possible
  // UK-trading .com retailers
  'selfridges.com',            // UK luxury department store
  'mcgrocer.com',              // UK grocery
  'harveynichols.com',         // UK luxury
  'marksandspencer.com',       // M&S global
  'next.com',                  // Next global
  'fortnumandmason.com',       // Fortnum & Mason
];

function extractHostname(url) {
  if (!url) return '';
  const m = String(url).match(/^https?:\/\/(?:www\.)?([^\/]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function isTrustedSource(item) {
  const host = extractHostname(item.link || '');
  // Tier 1: UK TLD?
  if (host && UK_TLDS.some(tld => host.endsWith(tld))) return true;
  // Tier 2: explicit allowlist (matched against link + source for resilience)
  const haystack = `${item.link || ''} ${item.source || ''}`.toLowerCase();
  return TRUSTED_DOMAINS.some(d => haystack.includes(d));
}

function trustedSourceFilter(items) {
  const before = items.length;
  const passed = items.filter(item => {
    const ok = isTrustedSource(item);
    if (!ok) {
      console.log(`[${VERSION}] TRUST BLOCK (untrusted source "${item.source}"): "${item.title || ''}"`);
    }
    return ok;
  });
  console.log(`[${VERSION}] trustedSourceFilter: ${before} in → ${passed.length} out`);
  return passed;
}

// eBay listing pages support a condition filter via LH_ItemCondition=3 (New).
// Many Serper-surfaced eBay /itm/ URLs land on the listing without that filter,
// so we append it defensively. Harmless on listings that already have a
// condition or for non-eBay URLs (we only touch ebay.* hosts).
function hardenEbayUrl(url) {
  if (!url || !/ebay\./i.test(url)) return url;
  if (/[?&]LH_ItemCondition=/i.test(url)) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}LH_ItemCondition=3`;
}

// ─────────────────────────────────────────────────────────────
// CIRCUIT BREAKER — Google CSE
// ─────────────────────────────────────────────────────────────
let cseCircuitOpen   = false;
let cseCircuitOpenAt = 0;
const CSE_COOLDOWN_MS = 60 * 60 * 1000;

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
        .filter(p => p.price !== null);
    } catch (e) {
      console.error(`[${VERSION}] Awin error:`, e.message);
      return [];
    }
  }
}

// ─────────────────────────────────────────────────────────────
// SERPER
// ─────────────────────────────────────────────────────────────
const SERPER_TIMEOUT_MS = 5000;

async function fetchSerper(query, type, apiKey) {
  const endpoint = type === 'search'
    ? 'https://google.serper.dev/search'
    : 'https://google.serper.dev/shopping';

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SERPER_TIMEOUT_MS);
  try {
    const r = await fetch(endpoint, {
      method:  'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q: query, gl: 'uk', hl: 'en', num: 10 }),
      signal:  ac.signal,
    });
    if (!r.ok) throw Object.assign(new Error('Serper error'), { status: r.status });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function normaliseSerperShopping(data, query) {
  const shopping = data.shopping || [];
  return shopping
    .filter(item => isValidProductUrl(item.link))
    .map(item => {
      const price = admitPrice(item.price);
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

function normaliseSerperOrganic(data, query) {
  const organic = data.organic || [];
  return organic
    .filter(item => isValidProductUrl(item.link))
    .map(item => {
      const raw   = item.snippet || item.title || '';
      const match = raw.match(/£\s?([\d,]+(?:\.\d{1,2})?)/);
      if (!match) return null;
      const price = admitPrice(match[1]);
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
// GOOGLE CSE
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
        const price = admitPrice(match[1]);
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

  // 3. CSE top-up
  const cseItems = await fetchCSE(q);
  rawItems.push(...cseItems);
  console.log(`[${VERSION}] CSE: ${cseItems.length} items`);

  // ── Pipeline ──────────────────────────────────────────────
  const safe       = nuclearFilter(rawItems);
  const identified = identityFilter(safe, q);
  const trusted    = trustedSourceFilter(identified);
  const priced     = dynamicCeilingFilter(trusted);
  const results    = dedup(priced);

  console.log(`[${VERSION}] Final: ${results.length} items | cheapest=£${results[0]?.price ?? 'n/a'} | hard=£${PRICE_CEILING_HARD} | dynamic=lowest×${PRICE_MULTIPLIER}`);

  // Debug envelope — exposes per-stage pipeline counts and the raw item set.
  // Triggered by { debug: true } in request body.
  const debug = req.body && req.body.debug === true;
  const debugEnvelope = debug ? {
    counts: {
      raw:        rawItems.length,
      nuclear:    safe.length,
      identity:   identified.length,
      trusted:    trusted.length,
      priced:     priced.length,
      final:      results.length,
    },
    rawSample:  rawItems.slice(0, 12).map(i => ({ source: i.source, title: i.title, link: i.link, price: i.price })),
    identitySample: identified.slice(0, 12).map(i => ({ source: i.source, title: i.title, link: i.link, price: i.price })),
  } : undefined;

  return res.status(200).json({
    shopping: results.map(r => ({
      source:   r.source,
      price:    `£${r.price.toFixed(2)}`,
      link:     hardenEbayUrl(r.link),
      title:    r.title,
      delivery: r.delivery,
    })),
    organic: [],
    _meta: {
      version:      VERSION,
      itemCount:    results.length,
      priceCeilingHard: PRICE_CEILING_HARD,
      priceMultiplier: PRICE_MULTIPLIER,
      cheapest:     results[0]?.price ?? null,
    },
    _debug: debugEnvelope,
  });
}
