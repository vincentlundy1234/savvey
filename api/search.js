// api/search.js — Savvey Search Proxy v6.13
import { createHash, createHmac } from 'node:crypto';
//
// Reverse-chronological change log up top:
//
// v6.13:
//   - AmazonProductProvider class (PAAPI 5.0 SearchItems with AWS SigV4
//     signing). Activates when AMAZON_ACCESS_KEY + AMAZON_SECRET_KEY +
//     AMAZON_PARTNER_TAG are set in Vercel env vars. Becomes Tier 1
//     primary data alongside Awin (when Awin lands) — Serper drops to
//     fallback. Returns structured Amazon UK pricing with affiliate
//     tag baked into DetailPageURL.
//
//
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

const VERSION = 'search.js v6.20';
const ORIGIN  = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

// Wave 82 — Haiku grading constants. Used by gradeResultsViaHaiku to
// extend the Wave 79 broad-fix to Tier 2 (Serper) results, which
// previously had NO semantic title-vs-query matching. Live testing
// surfaced eBay £10.99 Olaplex (counterfeit), Selfridges £75 memory
// foam mattress (wrong-product), Stanley flask Very £329 (mis-match)
// all leaking through. Same Haiku model + same grading rules as
// ai-search.js so the broad-fix is uniform across both tiers.
const HAIKU_MODEL_FOR_GRADING = 'claude-haiku-4-5-20251001';
const HAIKU_GRADING_TIMEOUT_MS = 4500;
const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

// Wave 82 — eBay demotion. eBay UK is a marketplace not a retailer;
// many listings are used/counterfeit/wrong-variant. We DEMOTE eBay
// from results unless the user's query explicitly indicates they want
// used/marketplace listings. Demote = drop the eBay row entirely from
// Tier 2 results (Tier 1 ai-search was already handling this via the
// refurb regex but Tier 2 wasn't). When eBay is the ONLY result we
// keep it (better than nothing) and rely on the existing onlyEbay
// coverage flag to warn the user.
const USED_INTENT_RE = /\b(used|refurb|refurbished|second[-\s]?hand|pre[-\s]?owned|reconditioned|open[-\s]?box|renewed|vintage|broken)\b/i;
function demoteEbayIfNotUsed(items, query){
  const wantsUsed = USED_INTENT_RE.test(query || '');
  if (wantsUsed) return items;
  const isEbayItem = (it) => {
    const src = String(it.source || '').toLowerCase();
    const link = String(it.link || '').toLowerCase();
    return src.includes('ebay') || link.includes('ebay.co.uk') || link.includes('ebay.com');
  };
  const ebayItems = items.filter(isEbayItem);
  const otherItems = items.filter(i => !isEbayItem(i));
  // Keep eBay only when it's the only signal we have (better than empty).
  if (otherItems.length === 0) return items;
  if (ebayItems.length > 0) {
    console.log(`[${VERSION}] demoting ${ebayItems.length} eBay listing(s); query had no used-intent keywords`);
  }
  return otherItems;
}

// Wave 83 — price-anomaly floor. Deterministic backstop after Haiku
// grading. Drops listings graded "similar" (not exact) whose price is
// suspiciously low vs the cluster median — almost always a clone,
// accessory, or wrong-product. "exact" listings are trusted regardless
// of price (legit budget retailers like Lakeland £40 cordless vacuum).
// Skips when fewer than 3 items in cluster (no reliable median).
function priceAnomalyFloorPostHaiku(items){
  if (!items || items.length < 3) return items;
  const prices = items.map(i => i.price).filter(p => typeof p === 'number' && p > 0).sort((a, b) => a - b);
  if (prices.length < 3) return items;
  const median = prices[Math.floor(prices.length / 2)];
  if (median <= 0) return items;
  const floor = median * 0.25; // 25% of median = lower bound
  const filtered = items.filter(it => {
    if (it.query_match === 'exact') return true; // trust Haiku exacts
    if (typeof it.price !== 'number' || it.price >= floor) return true;
    console.log(`[${VERSION}] price-anomaly drop: ${it.source} £${it.price.toFixed(2)} (median £${median.toFixed(0)}, floor £${floor.toFixed(2)}) — graded "${it.query_match}"`);
    return false;
  });
  return filtered;
}

// Wave 82 — Haiku grading on Tier 2 results. Fires ONE Haiku call with
// all combined Serper items + the user's query, asks Haiku to grade
// each as exact / similar / different. Drops "different" items. Same
// rules as ai-search.js Wave 79. Falls back to passing items through
// unchanged if Haiku fails (graceful degrade — never breaks the app).
async function gradeResultsViaHaiku(items, query, anthropicKey){
  if (!anthropicKey) return items;
  if (!items || items.length === 0) return items;
  if (!query) return items;
  const numbered = items.map((it, i) => ({
    index: i,
    title: (it.title || '').slice(0, 200),
    source: it.source || '',
    price: it.price || null,
  }));
  const userPrompt = `You are a product match grader for a UK price-comparison app. The user searched for: "${query}"

For each listing below, grade how well its TITLE matches the user's query semantically:
- "exact": title is unambiguously the same product the user asked for. Same brand, same model line, same tier.
- "similar": title is in the SAME category and roughly the same tier but not an identical product match. Same use case, comparable pricing band. For generic category queries (e.g. "kettle", "cordless drill", "yoga mat") this is normal — most listings will be "similar".
- "different": title is clearly a different product, accessory, replacement part, fake/clone listing, wrong generation, wrong tier, or unrelated. Examples: query "Nintendo Switch" → "Nintendo Switch 2 Console" = different. Query "Stanley flask" → "Stanley Toolbox" = different. Query "yoga mat" → "yoga mat strap" or "yoga mat carrier" = different. Query "Atomic Habits book" → eBay listing for unrelated item = different.

Be ASSERTIVE on "different" — wrong products surfacing as cheapest is far worse than dropping borderline-similar listings. When in doubt between similar and different, choose different.

Return ONLY a JSON array, one entry per listing: {"index": N, "query_match": "exact" | "similar" | "different"}

Listings:
${JSON.stringify(numbered, null, 2)}

Output ONLY the JSON array.`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), HAIKU_GRADING_TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: HAIKU_MODEL_FOR_GRADING, max_tokens: 800, messages: [{ role: 'user', content: userPrompt }] }),
      signal: ac.signal,
    });
    if (!r.ok) {
      console.warn(`[${VERSION}] Haiku grading failed: ${r.status}`);
      return items;
    }
    const data = await r.json();
    const text = ((data.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return items;
    const grades = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(grades)) return items;
    const graded = items.map((it, i) => {
      const g = grades.find(x => x && x.index === i);
      return { ...it, query_match: (g && g.query_match) || 'similar' };
    });
    const beforeCount = graded.length;
    const filtered = graded.filter(it => it.query_match !== 'different');
    const dropped = beforeCount - filtered.length;
    if (dropped > 0) console.log(`[${VERSION}] Haiku grading dropped ${dropped} "different" listing(s)`);
    return filtered;
  } catch (e) {
    console.warn(`[${VERSION}] Haiku grading error:`, e.message);
    return items;
  } finally {
    clearTimeout(timer);
  }
}

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
  // Wave 77 — Vincent flagged Lakeland and Dunelm should be in the mix
  // for kitchen + home queries (Lakeland is huge for kitchen gadgets,
  // Dunelm for vacuums / home appliances).
  'lakeland', 'dunelm',
  // Wave 84 — books + home + furniture
  'waterstones', 'whsmith', 'wh smith', 'world of books', 'worldofbooks', 'blackwell',
  'ikea', 'wayfair', 'habitat',
];

const UK_TLDS = ['.co.uk', '.uk'];
const TRUSTED_DOMAINS = [
  'amazon.co.uk', 'currys.co.uk', 'johnlewis.com', 'argos.co.uk',
  'ao.com', 'very.co.uk', 'richersounds.com', 'box.co.uk',
  'ebay.co.uk', 'halfords.com', 'screwfix.com', 'boots.com', 'costco.co.uk',
  'ebay.com', 'selfridges.com', 'mcgrocer.com', 'harveynichols.com',
  'marksandspencer.com', 'next.com', 'fortnumandmason.com',
  // Wave 77 — DIY + home + kitchen retailers
  'diy.com',         // B&Q
  'wickes.co.uk',
  'screwfix.com',
  'lakeland.co.uk',
  'dunelm.com',
  'homebase.co.uk',
  // Wave 84 — books + furniture retailers
  'waterstones.com',
  'whsmith.co.uk',
  'worldofbooks.com',
  'blackwells.co.uk',
  'ikea.com',
  'wayfair.co.uk',
  'habitat.co.uk',
];

function extractHostname(url) {
  if (!url) return '';
  const m = String(url).match(/^https?:\/\/(?:www\.)?([^\/]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function isTrustedSource(item) {
  // Tier 1: source name matches a known UK retailer (most reliable signal —
  // this is the retailer-name string Google Shopping populates).
  const src = String(item.source || '').toLowerCase();
  if (src && TRUSTED_SOURCE_TERMS.some(t => src.includes(t))) return true;

  // Tier 2: link hostname matches an EXPLICIT trusted domain. We dropped
  // the bare ".co.uk / .uk TLD" tier in v6.12 — it was too permissive,
  // letting random reseller domains pass and end up as the user's "best
  // price" with no comparison context (e.g. a £45 TV from an unknown
  // .co.uk store was passing because the TLD alone was treated as trust).
  // The explicit TRUSTED_DOMAINS list covers ~20 major UK retailers; any
  // genuinely useful long-tail retailer should be added there explicitly.
  const host = extractHostname(item.link || '');
  if (host && host !== 'google.com' && host !== 'www.google.com') {
    if (TRUSTED_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return true;
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
// AMAZON PRODUCT PROVIDER — PAAPI 5.0
//
// Activates the moment all three env vars are present in Vercel:
//   AMAZON_ACCESS_KEY    — generated in Associates Central → Tools →
//                          Product Advertising API → Manage Credentials
//   AMAZON_SECRET_KEY    — paired secret from same screen
//   AMAZON_PARTNER_TAG   — your Associates ID, e.g. "savvey-21"
//
// PAAPI 5.0 docs: https://webservices.amazon.co.uk/paapi5/documentation/
// Endpoint:       https://webservices.amazon.co.uk/paapi5/searchitems
// Region:         eu-west-1
// Service:        ProductAdvertisingAPI
//
// Rate limit: starts at 1 request/second. Doubles after a few sales
// flow through the Associates account. We cap to 5 items per request
// to keep payloads small and fall through gracefully on rate-limit
// (429/503) so the rest of the search pipeline still produces results.
//
// The DetailPageURL Amazon returns already includes the partner tag —
// commission tracking is automatic on click-through.
// ─────────────────────────────────────────────────────────────
class AmazonProductProvider {
  constructor(accessKey, secretKey, partnerTag) {
    this.accessKey   = accessKey;
    this.secretKey   = secretKey;
    this.partnerTag  = partnerTag;
    this.host        = 'webservices.amazon.co.uk';
    this.region      = 'eu-west-1';
    this.service     = 'ProductAdvertisingAPI';
    this.path        = '/paapi5/searchitems';
    this.target      = 'com.amazon.paapi5.v1.ProductAdvertisingAPIv1.SearchItems';
    this.marketplace = 'www.amazon.co.uk';
  }

  async search(query) {
    try {
      const body = JSON.stringify({
        PartnerTag:   this.partnerTag,
        PartnerType:  'Associates',
        Marketplace:  this.marketplace,
        Keywords:     query,
        SearchIndex:  'All',
        ItemCount:    5,
        Resources: [
          'ItemInfo.Title',
          'Offers.Listings.Price',
          'Images.Primary.Medium',
        ],
      });

      const headers = this._signRequest(body);

      const r = await fetch(`https://${this.host}${this.path}`, {
        method:  'POST',
        headers,
        body,
      });

      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        console.error(`[${VERSION}] Amazon PAAPI ${r.status}:`, errText.slice(0, 240));
        return [];
      }

      const data  = await r.json();
      const items = (data && data.SearchResult && data.SearchResult.Items) || [];

      return items.map(it => {
        const listing     = it && it.Offers && it.Offers.Listings && it.Offers.Listings[0];
        const priceAmount = listing && listing.Price && listing.Price.Amount;
        if (priceAmount === undefined || priceAmount === null) return null;
        const price = admitPrice(priceAmount);
        if (price === null) return null;
        return {
          source:   'Amazon UK',
          price,
          link:     (it && it.DetailPageURL) || '', // already carries partner tag
          title:    (it && it.ItemInfo && it.ItemInfo.Title && it.ItemInfo.Title.DisplayValue) || query,
          delivery: '',
        };
      }).filter(Boolean);
    } catch (e) {
      console.error(`[${VERSION}] Amazon PAAPI error:`, e.message);
      return [];
    }
  }

  // AWS Signature v4 — manual implementation so we don't pull in the
  // ~5 MB aws-sdk just for this one signed call. Standard SigV4 flow:
  //   1. canonical request → 2. string to sign → 3. derived signing key →
  //   4. HMAC-SHA256 signature → 5. Authorization header.
  _signRequest(body) {
    const now       = new Date();
    const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, ''); // 20240101T120000Z
    const dateShort = amzDate.slice(0, 8);                              // 20240101

    const headersToSign = {
      'content-encoding': 'amz-1.0',
      'content-type':     'application/json; charset=utf-8',
      'host':             this.host,
      'x-amz-date':       amzDate,
      'x-amz-target':     this.target,
    };

    const sortedKeys     = Object.keys(headersToSign).sort();
    const signedHeaders  = sortedKeys.join(';');
    const canonHeaders   = sortedKeys.map(k => `${k}:${headersToSign[k]}`).join('\n') + '\n';
    const payloadHash    = createHash('sha256').update(body).digest('hex');

    const canonicalRequest = [
      'POST',
      this.path,
      '',                  // empty query string
      canonHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateShort}/${this.region}/${this.service}/aws4_request`;

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const kDate    = createHmac('sha256', `AWS4${this.secretKey}`).update(dateShort).digest();
    const kRegion  = createHmac('sha256', kDate).update(this.region).digest();
    const kService = createHmac('sha256', kRegion).update(this.service).digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    return {
      ...headersToSign,
      'Authorization': `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }
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
  // Wave 77 — bumped num 10→40 for shopping. Vincent's "cordless vacuum
  // cleaner" test surfaced only 5 retailer rows from Serper Shopping
  // when Google Shopping itself has dozens of budget Amazon listings
  // sub-£50 (Cryfokt £38). At num:10 we were getting a thin slice of
  // Google Shopping's full result set; budget tier was systematically
  // missing because Google's default sort puts headline/branded items
  // first. num:40 widens the pool so budget listings have a chance to
  // appear. Search endpoint stays at 10 (organic results don't suffer
  // the same headline-bias issue).
  const numResults = type === 'shopping' ? 40 : 10;
  try {
    const r = await fetch(endpoint, {
      method:  'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q: query, gl: 'uk', hl: 'en', num: numResults }),
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
  // Wave 77 — DIY + home + kitchen
  'site:diy.com', 'site:wickes.co.uk', 'site:lakeland.co.uk', 'site:dunelm.com',
  // Wave 84 — books + home + furniture coverage
  'site:waterstones.com', 'site:whsmith.co.uk', 'site:worldofbooks.com', 'site:blackwells.co.uk',
  'site:ikea.com', 'site:wayfair.co.uk', 'site:habitat.co.uk', 'site:homebase.co.uk',
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

// Per-retailer site-restricted Serper search.
//
// Why: the OR'd UK_SITE_QUERY in fetchSerperUKSites returns at most 15 mixed
// results across 15 sites — Google often returns 5+ results from one big
// retailer (eBay) and 0 from the others. Hitting each retailer with its
// own targeted query guarantees Google's index has surfaced that retailer's
// top hit for the query, then we extract the price from the snippet.
//
// Each retailer is fired in parallel so total wall-clock is ~5s (the per-call
// timeout), not 5×N. Failure of one retailer doesn't block the others.
// Wave 77 — Amazon UK ADDED to per-retailer fan-out. Vincent's live test
// on "cordless vacuum cleaner" showed Halfords/Very/AO surfacing but no
// Amazon — yet Amazon UK has £30-50 budget cordless vacuums (Cryfokt
// £38) that any real shopper would expect to see. Without Amazon in the
// fan-out, Tier 2 totally misses budget-tier listings on the biggest UK
// retailer. Amazon is hit early in the array so it joins the parallel
// fan-out without delaying others.
const PER_RETAILER_SITES = [
  { source: 'Amazon UK',    site: 'amazon.co.uk' },
  { source: 'Currys',       site: 'currys.co.uk' },
  { source: 'Argos',        site: 'argos.co.uk' },
  { source: 'John Lewis',   site: 'johnlewis.com' },
  { source: 'AO.com',       site: 'ao.com' },
  { source: 'Very',         site: 'very.co.uk' },
  { source: 'Halfords',     site: 'halfords.com' },
  { source: 'Boots',        site: 'boots.com' },
  { source: 'Selfridges',   site: 'selfridges.com' },
  { source: 'Richer Sounds',site: 'richersounds.com' },
  // Wave 77 — Vincent flagged: B&Q, Lakeland, Dunelm should be included
  // for home / kitchen / DIY queries. Especially Dunelm and Lakeland —
  // they carry vacuums, kitchen appliances, and home goods that the
  // electronics-heavy retailer list above misses entirely.
  { source: 'B&Q',          site: 'diy.com' },
  { source: 'Wickes',       site: 'wickes.co.uk' },
  { source: 'Screwfix',     site: 'screwfix.com' },
  { source: 'Lakeland',     site: 'lakeland.co.uk' },
  { source: 'Dunelm',       site: 'dunelm.com' },
  // Wave 84 — Books fan-out. Live test on "Atomic Habits book" only
  // surfaced eBay; the book retailers weren't in the per-retailer
  // search list. Adding Waterstones / WHSmith / World of Books /
  // Blackwell's so any book query gets full UK book retailer coverage.
  { source: 'Waterstones',   site: 'waterstones.com' },
  { source: 'WHSmith',       site: 'whsmith.co.uk' },
  { source: 'World of Books',site: 'worldofbooks.com' },
  { source: "Blackwell's",   site: 'blackwells.co.uk' },
  // Wave 84 — Home / furniture / bedding fan-out. IKEA dominates UK
  // furniture; Wayfair has huge mattress + bedding catalogue; Habitat
  // (now Argos-owned but distinct site) covers mid-market home.
  { source: 'IKEA',          site: 'ikea.com' },
  { source: 'Wayfair',       site: 'wayfair.co.uk' },
  { source: 'Habitat',       site: 'habitat.co.uk' },
  { source: 'Homebase',      site: 'homebase.co.uk' },
];

async function fetchSerperOneRetailer(query, retailer, apiKey) {
  const q  = `${query} site:${retailer.site}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), SERPER_TIMEOUT_MS);
  try {
    const r = await fetch('https://google.serper.dev/search', {
      method:  'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ q, gl: 'uk', hl: 'en', num: 3 }),
      signal:  ac.signal,
    });
    if (!r.ok) return [];
    const data = await r.json();
    // Extract first valid result with a price; force the source name to the
    // canonical retailer name (Google's `displayLink` can be inconsistent
    // — e.g. 'm.currys.co.uk' instead of 'currys.co.uk').
    const items = normaliseSerperOrganic(data, query)
      .map(it => ({ ...it, source: retailer.source }))
      .slice(0, 1);
    return items;
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSerperPerRetailer(query, apiKey) {
  const results = await Promise.allSettled(
    PER_RETAILER_SITES.map(r => fetchSerperOneRetailer(query, r, apiKey))
  );
  const items = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items.push(...r.value);
  }
  console.log(`[${VERSION}] Per-retailer fan-out: ${items.length} hits across ${PER_RETAILER_SITES.length} retailers`);
  return items;
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
  // CRITICAL: Only check the SOURCE field for retailer matching, not the link.
  // Serper shopping/site-restricted links are Google aggregator URLs like
  //   https://www.google.com/search?q=Sony+WH+site:ebay.co.uk+OR+site:currys.co.uk+...
  // — they encode the entire UK_SITE_QUERY in the URL. If we naively
  // haystack.includes('ebay') against that URL, EVERY result collapses to
  // 'ebay' regardless of actual retailer. (This was the v6.11 regression.)
  // Source is the small retailer-name string Google Shopping populates
  // ("eBay", "Selfridges", "Currys", etc.) — that's the reliable signal.
  // For organic-snippet results where link IS a real retailer URL, we use
  // the hostname instead (already cleaned by extractRetailerName upstream).
  const src = String(source || '').toLowerCase();
  if (!src) return '';
  // Order matters — most specific patterns first
  if (src.includes('ebay')) return 'ebay';
  if (src.includes('amazon')) return 'amazon';
  if (src.includes('currys')) return 'currys';
  if (src.includes('argos')) return 'argos';
  if (src.includes('john lewis') || src.includes('johnlewis')) return 'john lewis';
  if (src.includes('ao.com') || /\bao\b/.test(src)) return 'ao';
  if (src.includes('very.co.uk') || /\bvery\b/.test(src)) return 'very';
  if (src.includes('richer sounds') || src.includes('richersounds')) return 'richer sounds';
  if (src.includes('box.co.uk') || src.includes('box.com')) return 'box';
  if (src.includes('halfords')) return 'halfords';
  if (src.includes('screwfix')) return 'screwfix';
  if (src.includes('boots')) return 'boots';
  if (src.includes('costco')) return 'costco';
  if (src.includes('selfridges')) return 'selfridges';
  if (src.includes('mcgrocer')) return 'mcgrocer';
  if (src.includes('harvey nichols')) return 'harvey nichols';
  if (src.includes('marks & spencer') || src.includes('marksandspencer') || src.includes('m&s')) return 'm&s';
  if (src.includes('fortnum')) return 'fortnum & mason';
  // Fallback to lowercased raw source for anything we don't recognise
  return src;
}

function isGoogleAggregator(link) {
  return /^https?:\/\/(?:www\.)?google\./i.test(String(link || ''));
}

function dedup(items) {
  const map = new Map();
  for (const item of items) {
    const key = canonicaliseSource(item.source, item.link);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, item);
      continue;
    }
    // Both items in the same canonical-source bucket. Two factors decide
    // the winner — and they're not equal:
    //
    //   1. Link type: a real retailer URL (currys.co.uk/products/...)
    //      always beats a Google aggregator URL (google.com/search?...).
    //      The user-experience cost of landing on Google's search page
    //      vs the actual retailer product page is much larger than the
    //      price discrepancy will ever be.
    //
    //   2. Within the same link-type, prefer the cheaper price.
    const existingIsAgg = isGoogleAggregator(existing.link);
    const incomingIsAgg = isGoogleAggregator(item.link);
    if (existingIsAgg && !incomingIsAgg) {
      map.set(key, item);   // upgrade — real URL beats Google URL
    } else if (!existingIsAgg && incomingIsAgg) {
      // keep existing — already on a real URL
    } else if (item.price < existing.price) {
      map.set(key, item);   // same link-type, cheaper wins
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

  const { q, type = 'shopping', barcode } = req.body || {};

  // ─── Barcode lookup mode ────────────────────────────────────
  // Frontend sends { barcode: "5054697471236" } when QuaggaJS reads a
  // barcode and Open Food Facts + UPCitemdb both fail. We resolve the
  // barcode to a product name via Serper organic search (Google's index
  // typically returns the right product page on the first hit) and
  // return just the name. Frontend then re-fires a normal price search
  // with the resolved name.
  // No price pipeline runs in this branch — single Serper call,
  // ~1s round trip, doesn't burn the rest of the search budget.
  if (barcode) {
    const code = String(barcode).replace(/[^0-9]/g, '');
    if (!code || code.length < 6) {
      return res.status(400).json({ error: 'invalid_barcode' });
    }
    try {
      const data  = await fetchSerper(code, 'search', SERPER_KEY);
      const items = (data && data.organic) || [];
      const top   = items[0];
      if (!top || !top.title) {
        return res.status(200).json({ product: null, resolvedFrom: code });
      }
      // Clean common Google-style title suffixes ("— Amazon UK", "| Argos", etc.)
      const cleanTitle = String(top.title)
        .replace(/\s*[\|\-—–:]\s*Amazon(?:\s+UK)?(?:[^|]*)$/i, '')
        .replace(/\s*[\|\-—–:]\s*eBay(?:[^|]*)$/i, '')
        .replace(/\s*[\|\-—–:]\s*(Currys|Argos|John Lewis|AO\.com|Very|Halfords|Boots|Selfridges|Richer Sounds|Costco)(?:[^|]*)$/i, '')
        .replace(/\s+\.\.\.$/, '')
        .trim();
      console.log(`[${VERSION}] Barcode ${code} resolved to: "${cleanTitle}"`);
      return res.status(200).json({ product: cleanTitle, resolvedFrom: code });
    } catch (e) {
      console.error(`[${VERSION}] Barcode lookup error:`, e.message);
      return res.status(200).json({ product: null, resolvedFrom: code });
    }
  }

  if (!q) return res.status(400).json({ error: 'Missing query' });

  let rawItems = [];

  // 1. Tier 1 sources — Amazon PAAPI + Awin in parallel.
  //    Both stay dormant until their env vars are set, so this no-ops
  //    safely on a fresh deploy.
  const AMAZON_KEY    = process.env.AMAZON_ACCESS_KEY;
  const AMAZON_SECRET = process.env.AMAZON_SECRET_KEY;
  const AMAZON_TAG    = process.env.AMAZON_PARTNER_TAG;
  const AWIN_KEY      = process.env.AWIN_API_KEY;

  const tier1Promises = [];
  if (AMAZON_KEY && AMAZON_SECRET && AMAZON_TAG) {
    const amazon = new AmazonProductProvider(AMAZON_KEY, AMAZON_SECRET, AMAZON_TAG);
    tier1Promises.push(amazon.search(q).then(items => ({ name: 'Amazon', items })));
  }
  if (AWIN_KEY) {
    const awin = new AwinProductProvider(AWIN_KEY);
    tier1Promises.push(awin.search(q).then(items => ({ name: 'Awin', items })));
  }

  if (tier1Promises.length > 0) {
    const tier1Results = await Promise.allSettled(tier1Promises);
    for (const r of tier1Results) {
      if (r.status === 'fulfilled') {
        rawItems.push(...r.value.items);
        console.log(`[${VERSION}] ${r.value.name}: ${r.value.items.length} items`);
      } else {
        console.error(`[${VERSION}] tier-1 source failed:`, r.reason?.message);
      }
    }
  }

  // 2. Serper — three sources in parallel:
  //      a) shopping endpoint (Google Shopping aggregator)
  //      b) UK-sites OR'd query (one search across all UK retailers)
  //      c) per-retailer fan-out (one search per retailer — max coverage)
  //    Total wall clock bounded by the per-call timeout (~5s).
  const [shoppingResult, ukSitesResult, perRetailerItems] = await Promise.allSettled([
    fetchSerper(q, type, SERPER_KEY),
    fetchSerperUKSites(q, SERPER_KEY),
    fetchSerperPerRetailer(q, SERPER_KEY),
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

  if (perRetailerItems.status === 'fulfilled') {
    rawItems.push(...perRetailerItems.value);
  } else {
    console.error(`[${VERSION}] Per-retailer fan-out failed:`, perRetailerItems.reason?.message);
  }

  // 3. CSE top-up
  const cseItems = await fetchCSE(q);
  rawItems.push(...cseItems);
  console.log(`[${VERSION}] CSE: ${cseItems.length} items`);

  // ── Pipeline ──────────────────────────────────────────────
  // Dynamic ceiling REMOVED in v6.12 — it was too aggressive in practice.
  // When the cheapest trusted item was an eBay variant, the lowest×4 ceiling
  // ate legitimate Currys/Argos/JL listings priced 5-7× higher. The remaining
  // four layers (nuclearFilter £5k cap, identityFilter, trustedSourceFilter,
  // priceAnomalyFloor) cover the same defensive ground without the false
  // negatives.
  const safe       = nuclearFilter(rawItems);
  const identified = identityFilter(safe, q);
  const trusted    = trustedSourceFilter(identified);
  const deduped    = dedup(trusted);
  // Price-anomaly floor runs LAST — operates on the per-retailer cheapest set
  // so it's comparing apples to apples (one Currys vs one Argos vs one eBay).
  const anomaly    = priceAnomalyFloor(deduped);
  // Wave 82 — eBay demotion + Haiku grading layer.
  // demoteEbayIfNotUsed: drop eBay listings unless query asked for used.
  // gradeResultsViaHaiku: ONE Haiku call grading each remaining item's
  // title-vs-query match (exact / similar / different) and dropping
  // "different" items. Both gracefully no-op if dependencies missing.
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const ebayDemoted  = demoteEbayIfNotUsed(anomaly, q);
  const haikuGraded  = await gradeResultsViaHaiku(ebayDemoted, q, ANTHROPIC_KEY);
  // Wave 83 — price-anomaly floor on post-Haiku items. Haiku is the
  // smart layer; this is the deterministic backstop. Rule: if a
  // listing is graded "similar" (not exact) AND its price is below
  // 25% of the cluster median, drop it as suspect — almost always
  // a clone, accessory, or wrong-product. "exact" listings are
  // trusted regardless of price (Lakeland £40 cordless vacuum is
  // legitimately budget; Haiku graded it as the right product).
  // Catches the cases Haiku was too generous on (Dunelm £3.95 yoga
  // mat strap, Selfridges £5 wrong-product, etc).
  const results = priceAnomalyFloorPostHaiku(haikuGraded);
  const priced       = trusted; // backwards-compat alias for debug envelope

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
      source:      r.source,
      price:       `£${r.price.toFixed(2)}`,
      link:        hardenEbayUrl(r.link),
      title:       r.title,
      delivery:    r.delivery,
      query_match: r.query_match || 'similar',  // Wave 82 — surface Haiku grade for frontend UX decisions
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
