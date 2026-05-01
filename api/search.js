// api/search.js — Savvey Search Proxy v6.10
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
// v6.5:
//   - trustedSourceFilter(): new pipeline stage — drops non-UK / peer-to-peer
//     marketplaces. ACCESSORY_TERMS extended with refurb euphemisms.
// v6.6:
//   - Serper timeout reduced 8s → 5s; retry removed entirely.
//   - Frontend now fires a single /api/search call (shopping only).
// v6.6.1:
//   - Debug envelope (?debug=true): per-stage pipeline counts.
// v6.7:
//   - SUPERSEDED — TLD-based trust filter rejected legitimate UK retailers
//     because Serper shopping links are all Google aggregator URLs.
// v6.8:
//   - Trust filter rewritten to match against the `source` field (retailer
//     name string from Google Shopping).
// v6.9:
//   - UK site-restricted search (fetchSerperUKSites) — second Serper call in
//     parallel with shopping, using site:currys.co.uk OR site:argos.co.uk
//     OR ... to guarantee UK retailer coverage when the shopping endpoint
//     biases toward US/global aggregators.
// v6.10:
//   - extractRetailerName(): clean hostname extraction from URL or
//     Serper displayLink. v6.9 occasionally surfaced "https:" as a source
//     name when displayLink came back as a full URL — broke the trust filter
//     and the frontend retailer-name display. Fix: parse protocol/www off
//     properly, take just the hostname before the first slash.

const VERSION = 'search.js v6.11';
const ORIGIN  = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

// ─────────────────────────────────────────────────────────────
// HYBRID PRICE FILTER
// ─────────────────────────────────────────────────────────────
const PRICE_CEILING_HARD  = 5000;
const PRICE_FLOOR         = 0.50;
const PRICE_MULTIPLIER    = 4;
const DYNAMIC_MIN_RESULTS = 3;

const cleanPrice = (val) => parseFloat(String(val).replace(/[^\d.]/g, ''));

function admitPrice(val) {
  const raw = cleanPrice(val);
  if (isNaN(raw))                return null;
  const n = Math.round(raw * 100) / 100;
  if (n < PRICE_FLOOR)           return null;
  if (n > PRICE_CEILING_HARD)    return null;
  return n;
}

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
  console.log(`[${VERSION}] nuclearFilter: ${before} in → ${passed.length} out`);
  return passed;
}

function dynamicCeilingFilter(items) {
  if (items.length < DYNAMIC_MIN_RESULTS) {
    console.log(`[${VERSION}] dynamicCeiling: skipped (${items.length} items < ${DYNAMIC_MIN_RESULTS})`);
    return items;
  }
  const prices  = items.map(i => i.price).sort((a, b) => a - b);
  const lowest  = prices[0];
  const ceiling = Math.round(lowest * PRICE_MULTIPLIER * 100) / 100;
  console.log(`[${VERSION}] dynamicCeiling: lowest=£${lowest} × ${PRICE_MULTIPLIER} = £${ceiling}`);
  const before  = items.length;
  const passed  = items.filter(item => {
    const ok = item.price <= ceiling;
    if (!ok) console.log(`[${VERSION}] Filtering out: ${item.title || item.source} £${item.price} > £${ceiling}`);
    return ok;
  });
  console.log(`[${VERSION}] dynamicCeiling: ${before} in → ${passed.length} out`);
  return passed;
}

// Price-anomaly floor — drops "too good to be true" outliers.
// Mis-listings (a TV remote sneaking into a TV search, an air-fryer basket
// into an air-fryer search) often pass identity filter on title tokens but
// cost a fraction of the real product.
//
// Two heuristics:
//   1. If there are 2+ results and the cheapest is less than
//      ANOMALY_FLOOR_RATIO of the second-cheapest, drop the cheapest.
//      Repeat up to 3 times to handle chains (e.g. £15 cable, £30 stand,
//      £45 mount, £800 TV — first three drops, TV survives).
//   2. If there is only ONE result and its source is a non-major retailer
//      (eBay individual seller etc.), we can't anchor against anything;
//      we keep it but flag in logs. Frontend can render with a "limited
//      coverage" indicator.
const ANOMALY_FLOOR_RATIO = 0.50;

function priceAnomalyFloor(items) {
  let working = items.slice().sort((a, b) => a.price - b.price);
  for (let pass = 0; pass < 3; pass++) {
    if (working.length < 2) break;
    const cheapest = working[0];
    const second   = working[1];
    if (cheapest.price < second.price * ANOMALY_FLOOR_RATIO) {
      console.log(`[${VERSION}] ANOMALY DROP: £${cheapest.price} (${cheapest.source}) is <${ANOMALY_FLOOR_RATIO * 100}% of next £${second.price} (${second.source}) — likely mis-listing "${cheapest.title || ''}"`);
      working = working.slice(1);
    } else {
      break;
    }
  }
  return working;
}

// ─────────────────────────────────────────────────────────────
// IDENTITY FILTER
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
  // Cross-product mis-listings — sellers stuff popular model numbers into
  // titles for unrelated cheaper products to game search ranking. Add
  // distinctive product-line names that should NOT appear alongside the
  // search query unless the user explicitly asked for them.
  'ult wear',                  // Sony ULT WEAR — different cheaper headphone line
  'lite version','mini version','kids edition','junior',
  'replica','imitation','counterfeit','copy of',
  'compatible with','fits',    // accessory-style mis-listings
];

function tokenise(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function isNumericToken(tok) { return /\d/.test(tok); }

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
// ─────────────────────────────────────────────────────────────
function isValidProductUrl(url) {
  if (!url) return false;
  if (url.includes('amazon') && !url.includes('/dp/'))    return false;
  if (url.includes('ebay')   && !url.includes('/itm/'))   return false;
  return true;
}

// Pull a clean retailer hostname from any of the URL shapes Serper returns.
//   "www.currys.co.uk"                       → "currys.co.uk"
//   "https://www.currys.co.uk/products/sony" → "currys.co.uk"
//   "currys.co.uk"                           → "currys.co.uk"
//   "" / null / undefined                    → "Unknown"
function extractRetailerName(link, displayLink) {
  const raw = String(displayLink || link || '');
  if (!raw) return 'Unknown';
  const noProto = raw.replace(/^https?:\/\//i, '');
  const noWww   = noProto.replace(/^www\./i, '');
  const host    = noWww.split('/')[0];
  return host || 'Unknown';
}

// ─────────────────────────────────────────────────────────────
// TRUSTED SOURCE FILTER — source-name based
// ─────────────────────────────────────────────────────────────
const TRUSTED_SOURCE_TERMS = [
  'ebay', 'amazon', 'currys', 'argos', 'john lewis', 'ao.com',
  'very', 'richer sounds', 'richersounds', 'box.co.uk',
  'halfords', 'screwfix', 'boots', 'costco',
  'selfridges', 'mcgrocer', 'harvey nichols', 'fortnum',
  'marks & spencer', 'm&s', "sainsbury's", 'sainsburys', 'tesco',
  'asda', 'lidl', 'aldi', 'wickes', 'b&q', 'homebase',
];

const UK_TLDS = ['.co.uk', '.uk'];
const TRUSTED_DOMAINS = [
  'amazon.co.uk', 'currys.co.uk', 'johnlewis.com', 'argos.co.uk',
  'ao.com', 'very.co.uk', 'richersounds.com', 'box.co.uk',
  'ebay.co.uk', 'halfords.com', 'screwfix.com', 'boots.com', 'costco.co.uk',
  'ebay.com', 'selfridges.com', 'mcgrocer.com', 'harveynichols.com',
  'marksandspencer.com', 'next.com', 'fortnumandmason.com',
];

function extractHostname(url) {
  if (!url) return '';
  const m = String(url).match(/^https?:\/\/(?:www\.)?([^\/]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function isTrustedSource(item) {
  const src = String(item.source || '').toLowerCase();
  if (src && TRUSTED_SOURCE_TERMS.some(t => src.includes(t))) return true;
  const host = extractHostname(item.link || '');
  if (host && host !== 'google.com' && host !== 'www.google.com') {
    if (UK_TLDS.some(tld => host.endsWith(tld))) return true;
    const haystack = `${item.link || ''} ${item.source || ''}`.toLowerCase();
    if (TRUSTED_DOMAINS.some(d => haystack.includes(d))) return true;
  }
  return false;
}

function trustedSourceFilter(items) {
  const before = items.length;
  const passed = items.filter(item => {
    const ok = isTrustedSource(item);
    if (!ok) console.log(`[${VERSION}] TRUST BLOCK (untrusted "${item.source}"): "${item.title || ''}"`);
    return ok;
  });
  console.log(`[${VERSION}] trustedSourceFilter: ${before} in → ${passed.length} out`);
  return passed;
}

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

const UK_SITE_QUERY = [
  'site:amazon.co.uk', 'site:currys.co.uk', 'site:argos.co.uk',
  'site:johnlewis.com', 'site:ao.com', 'site:very.co.uk',
  'site:richersounds.com', 'site:box.co.uk', 'site:ebay.co.uk',
  'site:halfords.com', 'site:screwfix.com', 'site:boots.com',
  'site:costco.co.uk', 'site:selfridges.com', 'site:harveynichols.com',
].join(' OR ');

async function fetchSerperUKSites(query, apiKey) {
  const q = `${query} (${UK_SITE_QUERY})`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SERPER_TIMEOUT_MS);
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q, gl: 'uk', hl: 'en', num: 15 }),
      signal:  ac.signal,
    });
    if (!r.ok) throw Object.assign(new Error('Serper UK-sites error'), { status: r.status });
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
      if (price === null) return null;
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
        source:   extractRetailerName(item.link, item.displayLink),
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
          source:   extractRetailerName(item.link, item.displayLink),
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
//
// Two-stage:
//   1. canonicaliseSource() — collapses every flavour of an eBay listing
//      ("eBay", "eBay - sellerX", "ebay.co.uk", "ebay.com") into a single
//      "ebay" bucket. Same for Amazon, Currys etc. Otherwise the dedup
//      treats every eBay reseller as a unique retailer and a popular
//      product can return 6+ near-identical eBay rows with no comparison
//      retailers visible.
//   2. cheapest-per-bucket wins on collision.
// ─────────────────────────────────────────────────────────────
function canonicaliseSource(source, link) {
  const haystack = `${link || ''} ${source || ''}`.toLowerCase();
  // Order matters — most specific patterns first
  if (haystack.includes('ebay')) return 'ebay';
  if (haystack.includes('amazon')) return 'amazon';
  if (haystack.includes('currys')) return 'currys';
  if (haystack.includes('argos')) return 'argos';
  if (haystack.includes('john lewis') || haystack.includes('johnlewis')) return 'john lewis';
  if (haystack.includes('ao.com') || /\bao\b/.test(haystack)) return 'ao';
  if (haystack.includes('very')) return 'very';
  if (haystack.includes('richer sounds') || haystack.includes('richersounds')) return 'richer sounds';
  if (haystack.includes('box.co.uk') || haystack.includes('box.com')) return 'box';
  if (haystack.includes('halfords')) return 'halfords';
  if (haystack.includes('screwfix')) return 'screwfix';
  if (haystack.includes('boots')) return 'boots';
  if (haystack.includes('costco')) return 'costco';
  if (haystack.includes('selfridges')) return 'selfridges';
  if (haystack.includes('mcgrocer')) return 'mcgrocer';
  if (haystack.includes('harvey nichols')) return 'harvey nichols';
  if (haystack.includes('marks & spencer') || haystack.includes('marksandspencer') || haystack.includes('m&s')) return 'm&s';
  if (haystack.includes('fortnum')) return 'fortnum & mason';
  // Fallback to lowercased raw source for anything we don't recognise
  return String(source || '').toLowerCase();
}

function dedup(items) {
  const map = new Map();
  for (const item of items) {
    const key = canonicaliseSource(item.source, item.link);
    if (!map.has(key) || item.price < map.get(key).price) {
      // Keep the original source string for display, but bucket by canonical
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

  let rawItems = [];

  // 1. Awin (if AWIN_API_KEY set)
  const AWIN_KEY = process.env.AWIN_API_KEY;
  if (AWIN_KEY) {
    const awin  = new AwinProductProvider(AWIN_KEY);
    const awinR = await awin.search(q);
    rawItems.push(...awinR);
    console.log(`[${VERSION}] Awin: ${awinR.length} items`);
  }

  // 2. Serper — TWO parallel calls
  const [shoppingResult, ukSitesResult] = await Promise.allSettled([
    fetchSerper(q, type, SERPER_KEY),
    fetchSerperUKSites(q, SERPER_KEY),
  ]);

  if (shoppingResult.status === 'fulfilled') {
    const shopping = normaliseSerperShopping(shoppingResult.value, q);
    const organic  = normaliseSerperOrganic(shoppingResult.value, q);
    rawItems.push(...shopping, ...organic);
    console.log(`[${VERSION}] Serper shopping: ${shopping.length} shopping + ${organic.length} organic`);
  } else {
    console.error(`[${VERSION}] Serper shopping failed:`, shoppingResult.reason?.message);
  }

  if (ukSitesResult.status === 'fulfilled') {
    const ukOrganic = normaliseSerperOrganic(ukSitesResult.value, q);
    rawItems.push(...ukOrganic);
    console.log(`[${VERSION}] Serper UK-sites: ${ukOrganic.length} organic`);
  } else {
    console.error(`[${VERSION}] Serper UK-sites failed:`, ukSitesResult.reason?.message);
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
  const deduped    = dedup(priced);
  // Price-anomaly floor runs LAST — operates on the per-retailer cheapest set
  // so it's comparing apples to apples (one Currys vs one Argos vs one eBay).
  const results    = priceAnomalyFloor(deduped);

  console.log(`[${VERSION}] Final: ${results.length} items | cheapest=£${results[0]?.price ?? 'n/a'}`);

  const debug = req.body && req.body.debug === true;
  const debugEnvelope = debug ? {
    counts: {
      raw: rawItems.length, nuclear: safe.length, identity: identified.length,
      trusted: trusted.length, priced: priced.length, final: results.length,
    },
    rawSample:      rawItems.slice(0, 12).map(i => ({ source: i.source, title: i.title, link: i.link, price: i.price })),
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
      version: VERSION,
      itemCount: results.length,
      priceCeilingHard: PRICE_CEILING_HARD,
      priceMultiplier: PRICE_MULTIPLIER,
      cheapest: results[0]?.price ?? null,
      // Coverage flags for the frontend — let the UI tell users when the
      // result set is thin so they don't mistake "1 eBay listing" for
      // "the genuine UK best price".
      onlyEbay: results.length > 0 && results.every(r =>
        canonicaliseSource(r.source, r.link) === 'ebay'),
      coverage: results.length === 0 ? 'none'
              : results.length === 1 ? 'limited'
              : results.length <= 3  ? 'partial'
              : 'good',
    },
    _debug: debugEnvelope,
  });
}
