// api/ai-search.js — Savvey AI Search v1.6
//
// v1.6 (2 May 2026, post-launch user feedback):
//   - Per-retailer URL admission. Some Perplexity hits returned retailer
//     homepages or category pages instead of product pages — clicking the
//     "Buy" button landed users on currys.co.uk instead of the actual TV.
//     Now: PRODUCT_URL_PATTERNS regex per retailer (Currys, Argos, JL, AO,
//     Very, Richer Sounds, Box, Halfords, Screwfix, Boots, Selfridges,
//     Costco, Harvey Nichols). Hits without a recognisable product-page
//     URL pattern are dropped before they reach Haiku.
//   - Member/loyalty price filter in Haiku prompt. AO showed an "AO Member"
//     price + a higher standard price; we were picking the member price as
//     the "current" price, making AO falsely cheapest. Updated prompt
//     explicitly tells Haiku to skip subscription/membership-gated prices
//     and only return the public list price (or the lower of two
//     unconditional prices).
//
// v1.5 (1 May 2026, post-v1.4 verification):
//   - Amazon-locked query now includes `inurl:dp` to force ASIN product
//     URLs. v1.4 verification revealed Perplexity was returning
//     music.amazon.co.uk catalogue pages for Sony WH-1000XM5 (Amazon Music
//     surfaces artist pages on the same domain). inurl:dp pins it to
//     /dp/ASIN URLs, which is what we actually want.
//   - gatherRetailerHits now applies a per-host admission check via the
//     new isAdmissibleAmazonUrl(): rejects anything on amazon.co.uk that
//     isn't on www.amazon.co.uk AND on a /dp/ASIN or /gp/product/ASIN path.
//     Stops music/aws/business subdomain pages reaching Haiku, saving
//     extraction cost AND preventing a music page being mis-priced.
//
// v1.4 (1 May 2026, post-v1.3 verification):
//   - Dual Perplexity call: one broad (all UK retailers EXCLUDING Amazon),
//     one Amazon-locked (site:amazon.co.uk only). Run in parallel, merge by
//     URL. v1.3 verification showed Perplexity's OR-chain de-prioritises
//     Amazon below sites with richer crawlable snippets (Argos/JL) — even
//     for Amazon-exclusive products like Kindle. The locked call guarantees
//     Amazon coverage when Amazon has the product.
//   - Cost: 2× Perplexity per search (~£0.005 → ~£0.010 per query). Latency
//     unchanged (calls run in Promise.all). Still single Haiku extraction
//     across the combined hit set.
//
// v1.3 (1 May 2026):
//   - TRUSTED_NO_HEAD bypass: Amazon, John Lewis, Argos URLs that match a
//     structural product-page pattern (/dp/ASIN, /p/PID, /product/PID) skip
//     the HEAD verification step. These retailers' product pages don't 404
//     once live, but their bot defences return 503/429 to bare HEAD requests
//     from Vercel IPs — so HEAD verification was silently dropping every
//     Amazon hit. (Standalone fix wasn't enough — see v1.4.)
//   - Amazon affiliate tag injection: any amazon.co.uk product URL gets
//     ?tag=$AMAZON_ASSOCIATE_TAG appended (defaults to "savvey-21"). Untagged
//     tag IDs don't break links — they just don't track until Associates is
//     active. Setting AMAZON_ASSOCIATE_TAG to empty string disables tagging.
//
// v1.2 (2 May 2026 evening):
//   - Imports shared retailer + price config from _shared.js (eliminates
//     "three retailer lists drift" bug class — issue C3 from audit)
//   - Rate limit: 30 requests/IP/hour via _rateLimit.js (kills C1)
//   - Circuit breaker on Perplexity + Anthropic via _circuitBreaker.js
//     (kills C2 — runaway cost when provider has an incident)
//   - URL HEAD verification: every result URL is HEAD-checked in parallel
//     before render. Dead links never reach the user. Adds ~1s latency.
//     (kills H4 — the "Buy on Currys → 404" trust killer)

import {
  UK_RETAILERS,
  admitPrice,
  matchRetailerByHost,
  applySecurityHeaders,
} from './_shared.js';
import { rejectIfRateLimited } from './_rateLimit.js';
import { withCircuit }         from './_circuitBreaker.js';

const VERSION = 'ai-search.js v1.12';

// Wave 93 — landing-page price verification (mirrors search.js v6.25).
// For the cheapest result only, fetch the actual product page and parse
// the live price. If snippet differs from live by >2%, override snippet
// with live so the user sees the price they'll actually find when they
// tap through. 3s timeout, graceful failure.
const VERIFY_TIMEOUT_MS = 3000;
const VERIFY_MAX_DRIFT_PCT = 0.02;
const VERIFY_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-GB,en;q=0.9',
};
function extractLivePriceFromHtml(url, html){
  const u = String(url || '').toLowerCase();
  const m = (re) => { const x = html.match(re); return x ? x[1] : null; };
  let raw = null;
  if(u.includes('amazon.co.uk')){
    raw = m(/<span class="a-price-whole">(\d[\d,]*)<\/span>/) || m(/<span class="a-offscreen">£([\d,.]+)<\/span>/) || m(/\\"priceAmount\\":(\d+\.?\d*)/);
  } else if(u.includes('currys.co.uk')){
    raw = m(/"price":\s*"?([\d.]+)"?/) || m(/data-price="([\d.]+)"/);
  } else if(u.includes('argos.co.uk')){
    raw = m(/"price":\s*"?([\d.]+)"?/);
  } else if(u.includes('johnlewis.com')){
    raw = m(/"price":\s*"?([\d.]+)"?/) || m(/£([\d,]+\.\d{2})/);
  } else if(u.includes('ao.com')){
    raw = m(/"price":\s*"?([\d.]+)"?/) || m(/itemprop="price"[^>]*content="([\d.]+)"/);
  } else if(u.includes('very.co.uk')){
    raw = m(/"price":\s*"?([\d.]+)"?/) || m(/<span[^>]*class="[^"]*price[^"]*"[^>]*>£([\d,.]+)/);
  } else if(u.includes('halfords.com') || u.includes('selfridges.com') || u.includes('boots.com')){
    raw = m(/"price":\s*"?([\d.]+)"?/) || m(/data-price="([\d.]+)"/);
  } else if(u.includes('apple.com')){
    raw = m(/"currentPrice"[^"]*":[^"]*"([\d.]+)"/) || m(/£([\d,]+\.\d{2})/);
  }
  if(!raw) return null;
  const n = parseFloat(String(raw).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}
async function verifyLivePrice(item){
  if(!item || !item.link) return { verified: false, reason: 'no_link' };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), VERIFY_TIMEOUT_MS);
  try {
    const r = await fetch(item.link, { headers: VERIFY_BROWSER_HEADERS, redirect: 'follow', signal: ac.signal });
    if(!r.ok) return { verified: false, reason: 'upstream_' + r.status };
    const html = await r.text();
    const live = extractLivePriceFromHtml(item.link, html);
    if(live === null) return { verified: false, reason: 'no_extractor_or_no_match' };
    const snippet = item.price;
    const drift = snippet > 0 ? Math.abs(live - snippet) / snippet : 0;
    return { verified: true, live, snippet, drift };
  } catch (e){
    return { verified: false, reason: 'exception_' + (e.name || 'unknown') };
  } finally { clearTimeout(timer); }
}
const ORIGIN  = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

const PERPLEXITY_TIMEOUT_MS = 8000;
const PERPLEXITY_ENDPOINT   = 'https://api.perplexity.ai/search';
const ANTHROPIC_ENDPOINT    = 'https://api.anthropic.com/v1/messages';
const HAIKU_MODEL           = 'claude-haiku-4-5-20251001';
const HAIKU_TIMEOUT_MS      = 5000;
const HEAD_VERIFY_TIMEOUT_MS = 1500;

const RATE_LIMIT_PER_HOUR = 30;

// Hosts whose product URLs we trust without HEAD verification. These retailers
// have aggressive bot detection that 503s bare HEAD requests from cloud IPs,
// so verifying their URLs throws away legitimate results. Their product-page
// URLs (matched against TRUSTED_PRODUCT_PATTERNS below) are structurally
// stable — once a product is live, the URL doesn't 404.
const TRUSTED_NO_HEAD = new Set([
  'amazon.co.uk',
  'johnlewis.com',
  'argos.co.uk',
]);

// URL must match one of these patterns to be trusted-skipped. A bare
// homepage/search URL still goes through HEAD because there's no ASIN/PID
// stability to lean on.
const TRUSTED_PRODUCT_PATTERNS = [
  /amazon\.co\.uk\/(?:[^\/]+\/)?(?:dp|gp\/product)\/[A-Z0-9]{10}/i,  // Amazon ASIN
  /johnlewis\.com\/.+\/p\d+/i,                                        // JL /p123456
  /argos\.co\.uk\/product\/\d+/i,                                     // Argos /product/123
];

// Amazon Associates tag. Set AMAZON_ASSOCIATE_TAG in Vercel env vars; falls
// back to "savvey-21" (the registered tag) if not present. To fully disable,
// set AMAZON_ASSOCIATE_TAG to an empty string explicitly. Untagged links from
// non-approved partners still work for users — the tag just doesn't track
// until Associates approves.
const AMAZON_TAG = (process.env.AMAZON_ASSOCIATE_TAG !== undefined)
  ? process.env.AMAZON_ASSOCIATE_TAG
  : 'savvey-21';

function rawResultsOf(data) {
  return (data && data.results) ||
         (data && data.search_results) ||
         (data && data.web_results) ||
         (data && data.data && data.data.results) ||
         [];
}

// Single Perplexity /search call. Caller passes the fully-formed augmented
// query (including any site: filter). Throws on non-2xx.
async function callPerplexity(augmentedQuery, apiKey, maxResults = 10) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), PERPLEXITY_TIMEOUT_MS);
  try {
    const r = await fetch(PERPLEXITY_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: augmentedQuery, max_results: maxResults, max_tokens_per_page: 256 }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw Object.assign(new Error('Perplexity error'), { status: r.status, body: txt.slice(0, 200) });
    }
    return await r.json();
  } finally { clearTimeout(timer); }
}

// ── Category detection (Wave 26) ──
//
// Lightweight keyword classifier to detect grocery / beauty / DIY queries.
// When a category matches, we fire an additional Perplexity call locked to
// that category's retailers only — same architectural pattern as the
// Amazon-locked call, which solved Perplexity's thin-index problem there.
// Default = no category match = no extra call (no waste).
const GROCERY_KEYWORDS = /\b(heinz|cadbury|nestle|kelloggs|weetabix|warburtons|hovis|pepsi|coca[\s-]?cola|coke|pringles|walkers|mcvities|hobnobs|baked beans|cornflakes|cereal|biscuits?|crisps|chocolate|pasta|rice|bread|milk|butter|cheese|yog[hou]+rt|bacon|sausage|mince|chicken|coffee|tea bags|flour|sugar|olive oil|tomato|tinned|frozen|beer|wine|cider|vodka|whisky|gin|rum)\b/i;
const BEAUTY_KEYWORDS = /\b(lipstick|mascara|foundation|concealer|blusher|bronzer|eyeshadow|eyeliner|nail polish|nail varnish|perfume|fragrance|cologne|aftershave|shampoo|conditioner|hair (?:dye|colour|spray)|cleanser|moisturi[sz]er|serum|toner|sunscreen|spf\s*\d|exfoliat|face mask|body wash|deodorant|razor|shaver|charlotte tilbury|chanel|dior|ysl|estee lauder|clinique|mac\b|maybelline|loreal|l'oreal|nivea|olay|nyx|fenty|elf cosmetics|drunk elephant|the ordinary|cerave|la roche|paula's choice)\b/i;
const DIY_KEYWORDS = /\b(drill|saw|hammer|screwdriver|wrench|spanner|paint|brush|roller|sandpaper|nail|screw|bolt|lawnmower|lawn mower|strimmer|hedge trimmer|leaf blower|hose|wheelbarrow|spade|fork|secateurs|cement|grout|silicone|polyfilla|filler|wallpaper|tile|laminate|decking|flymo|bosch (?:drill|saw)|dewalt|makita|stanley|black\s*\+?\s*decker)\b/i;
// Wave 59 — household / "budget-tier eligible" keywords. Any of these plus
// generic adjectives ("cheap", "budget", "cordless") will trigger an extra
// Perplexity call locked to the discount + own-brand retailers (B&M, Aldi,
// Wilko, Home Bargains, Argos own-brand). Vincent reported a £199-cheapest
// result for "cordless vacuum cleaner" when these retailers stock them
// from £40-£100. The category-locked call surfaces those hits.
const BUDGET_KEYWORDS = /\b(vacuum|hoover|cordless vacuum|stick vacuum|kettle|toaster|microwave|iron(?:ing board)?|fan heater|fan|hair ?dryer|mixer|blender|food processor|slow cooker|air fryer|sandwich (?:maker|toaster)|coffee maker|tea pot|teapot|kitchen scales?|chopping board|knife set|saucepan|frying pan|dustbin|laundry basket|drying rack|clothes airer|mop|bucket|cleaning|duster|towels?|bedding|duvet|pillow|mattress|cushion|throw|rug|curtain|blind|cheap|budget|basic|own[\s-]?brand|value)\b/i;

const GROCERY_HOSTS = ['tesco.com', 'sainsburys.co.uk', 'asda.com', 'groceries.asda.com', 'morrisons.com', 'groceries.morrisons.com', 'waitrose.com'];
const BEAUTY_HOSTS  = ['superdrug.com', 'cultbeauty.co.uk', 'lookfantastic.com', 'spacenk.com', 'theperfumeshop.com', 'beautybay.com', 'boots.com'];
const DIY_HOSTS     = ['diy.com', 'wickes.co.uk', 'toolstation.com', 'screwfix.com'];
const BUDGET_HOSTS  = ['homebargains.co.uk', 'lidl.co.uk', 'aldi.co.uk', 'wilko.com', 'theworks.co.uk', 'poundland.co.uk', 'argos.co.uk', 'wilko.com'];

function detectCategoryLock(query) {
  const q = String(query || '');
  if (GROCERY_KEYWORDS.test(q)) return { name: 'grocery', hosts: GROCERY_HOSTS };
  if (BEAUTY_KEYWORDS.test(q))  return { name: 'beauty',  hosts: BEAUTY_HOSTS };
  if (DIY_KEYWORDS.test(q))     return { name: 'diy',     hosts: DIY_HOSTS };
  if (BUDGET_KEYWORDS.test(q))  return { name: 'budget',  hosts: BUDGET_HOSTS };
  return null;
}

// Multi parallel Perplexity calls:
//   - Broad: all UK retailers EXCEPT Amazon, OR'd together (10 results)
//   - Amazon-locked: site:amazon.co.uk ONLY (10 results)
//   - Category-locked (optional, Wave 26): if query matches grocery/beauty/DIY
//     keywords, fire a third call locked to that category's retailers
//
// Merge by URL (dedup) so a single result that appears in multiple buckets
// only counts once. If a call fails, the others still win — graceful degrade.
async function fetchPerplexitySearch(query, apiKey) {
  const broadHosts = UK_RETAILERS
    .filter(r => r.host !== 'amazon.co.uk')
    .map(r => `site:${r.host}`)
    .join(' OR ');
  const broadQuery  = `${query} buy UK price (${broadHosts})`;
  // inurl:dp forces Perplexity to return ASIN product URLs only — without
  // it we get music.amazon.co.uk and other non-retail subdomain pages.
  const amazonQuery = `${query} buy UK price site:amazon.co.uk inurl:dp`;

  // Wave 26 — category-locked call (only when category detected)
  const categoryLock = detectCategoryLock(query);
  let categoryQuery = null;
  if (categoryLock) {
    const catSites = categoryLock.hosts.map(h => `site:${h}`).join(' OR ');
    categoryQuery = `${query} buy UK (${catSites})`;
  }

  // Wave 63 — LOOSE coverage call. Live test (Sony WH-1000XM5) showed the
  // 30+ host OR clause in the broad query can return zero hits when
  // Perplexity's index doesn't have those exact site:operators matched
  // for the product. The loose call is "${query} buy UK price" with no
  // site: filters at all — Perplexity finds whatever it finds, our
  // matchRetailer step in processSearchResponse rejects anything that
  // doesn't match a known UK retailer host. Strict admission stays;
  // the source corpus widens. Costs +1 Perplexity per query (~£0.005).
  const looseQuery = `${query} buy UK price comparison`;

  const calls = [
    callPerplexity(broadQuery,  apiKey, 10),
    callPerplexity(amazonQuery, apiKey, 10),
    callPerplexity(looseQuery,  apiKey, 10),
  ];
  if (categoryQuery) calls.push(callPerplexity(categoryQuery, apiKey, 10));

  const settled = await Promise.allSettled(calls);
  const [broadSettled, amazonSettled, looseSettled, categorySettled] = settled;

  // Surface fatal errors only when ALL calls failed.
  if (settled.every(s => s.status === 'rejected')) {
    throw broadSettled.reason;
  }

  const broadData    = broadSettled?.status    === 'fulfilled' ? broadSettled.value    : null;
  const amazonData   = amazonSettled?.status   === 'fulfilled' ? amazonSettled.value   : null;
  const looseData    = looseSettled?.status    === 'fulfilled' ? looseSettled.value    : null;
  const categoryData = categorySettled?.status === 'fulfilled' ? categorySettled.value : null;

  // Diagnostic logging
  const broadCount    = rawResultsOf(broadData).length;
  const amazonCount   = rawResultsOf(amazonData).length;
  const looseCount    = rawResultsOf(looseData).length;
  const categoryCount = rawResultsOf(categoryData).length;
  if (broadSettled?.status === 'rejected') {
    console.warn(`[${VERSION}] broad Perplexity failed:`, broadSettled.reason?.message);
  }
  if (amazonSettled?.status === 'rejected') {
    console.warn(`[${VERSION}] amazon Perplexity failed:`, amazonSettled.reason?.message);
  }
  if (looseSettled?.status === 'rejected') {
    console.warn(`[${VERSION}] loose Perplexity failed:`, looseSettled.reason?.message);
  }
  if (categorySettled?.status === 'rejected') {
    console.warn(`[${VERSION}] ${categoryLock.name} Perplexity failed:`, categorySettled.reason?.message);
  }
  if (categoryLock) {
    console.log(`[${VERSION}] perplexity quad: broad=${broadCount} amazon=${amazonCount} loose=${looseCount} ${categoryLock.name}=${categoryCount}`);
  } else {
    console.log(`[${VERSION}] perplexity tri: broad=${broadCount} amazon=${amazonCount} loose=${looseCount}`);
  }

  // Merge + dedup by URL.
  const seen     = new Set();
  const combined = [];
  const sources = [
    ...rawResultsOf(broadData),
    ...rawResultsOf(amazonData),
    ...rawResultsOf(looseData),
    ...rawResultsOf(categoryData),
  ];
  for (const r of sources) {
    const url = r.url || r.link || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    combined.push(r);
  }

  return {
    results: combined,
    _amazonCallSucceeded: amazonSettled?.status === 'fulfilled',
    _amazonHitCount: amazonCount,
    _looseHitCount: looseCount,
    _categoryLock: categoryLock?.name || null,
    _categoryHitCount: categoryCount,
  };
}

// Amazon-specific admission check: a URL claiming amazon.co.uk must be on
// the main retail subdomain (www.amazon.co.uk OR bare amazon.co.uk) AND on
// a product path (/dp/ASIN or /gp/product/ASIN). Without this, Perplexity's
// site:amazon.co.uk filter pulls in music.amazon.co.uk, business.amazon.co.uk,
// aws.amazon.co.uk pages that aren't sellable products.
function isAdmissibleAmazonUrl(url) {
  if (!url) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  // Reject any non-retail subdomain
  if (host !== 'www.amazon.co.uk' && host !== 'amazon.co.uk') return false;
  // Path must contain a product identifier
  return /\/(?:[^\/]+\/)?(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(parsed.pathname);
}

// ── Per-retailer product-URL patterns (v1.6) ──
//
// Vincent reported clicking a non-Amazon retailer link and landing on the
// company homepage instead of the actual product page. Cause: Perplexity
// sometimes returns the retailer's category or homepage URL, especially on
// vague queries. Without per-retailer URL admission, we'd send users
// straight to currys.co.uk/tv (a category) instead of the actual TV.
//
// Each pattern is the minimum path structure that signals "real product
// page" for that retailer — verified against live URL conventions. Hits
// from these retailers that don't match the pattern are dropped.
const PRODUCT_URL_PATTERNS = {
  // Wave 55 — Apple direct (apple.com/uk-buy-iphone, /shop/buy-mac, etc.)
  'apple.com':         /\/(uk|gb)\/(?:shop|buy)|\/(?:shop|buy)-/i,
  'currys.co.uk':      /\/products\/[a-z0-9-]+-\d{6,}/i,    // /products/sony-...-10245678
  'argos.co.uk':       /\/product\/\d{6,}/i,                // /product/8447423
  'johnlewis.com':     /\/p\d{6,}/i,                        // /sony.../p7060324
  'ao.com':            /\/product\/[a-z0-9-]+\/\w+\.aspx/i, // /product/lg-c4-tv/lgc4-65inch.aspx (variants)
  'very.co.uk':        /\/[a-z0-9-]+\.prd/i,                // /sony-headphones.prd
  'richersounds.com':  /\/product\/[a-z0-9-]+/i,            // /product/sony-wh-1000xm5
  'box.co.uk':         /\/details\/[a-z0-9-]+\/\d+/i,       // /details/sony-headphones/123456
  // Wave 39 — Halfords URLs come in three flavours:
  //   /search/...-123456.html   (Search-result canonicalised)
  //   /cycling/.../bike-name-123456.html   (Category-pathed)
  //   /motoring/.../battery-name-123456    (Sometimes no .html)
  // Plus the new B2B-shop URLs we don't want. Loosened to require a
  // numeric segment ≥5 digits anywhere after the slug.
  'halfords.com':      /\/[a-z0-9-]+-\d{5,}(\.html)?(?:[/?]|$)/i,
  'screwfix.com':      /\/p\/[a-z0-9-]+\/\d+/i,             // /p/product-name/12345
  'boots.com':         /\/[a-z0-9-]+-\d{6,}/i,              // /xxx-100123
  'costco.co.uk':      /\.product\.\d+\.html/i,             // .product.123456.html
  'selfridges.com':    /\/cat\/[^/]+\/[^/]+\/\d+\/?$/i,
  'mcgrocer.com':      /\/products\/[a-z0-9-]+/i,
  'harveynichols.com': /\/product\/[a-z0-9-]+/i,
  // DIY (Wave 24)
  'diy.com':           /\/details\/[a-z0-9-]+\/\d+/i,            // B&Q: /details/.../12345
  'wickes.co.uk':      /\/Product\/p\/\d+/i,                     // Wickes: /Product/p/123456
  'toolstation.com':   /\/[a-z0-9-]+\/p\d+/i,                    // Toolstation: /slug/p12345
  // Books (Wave 24)
  'waterstones.com':   /\/book\/[a-z0-9-]+\/[a-z0-9-]+\/\d+/i,   // Waterstones: /book/title/author/9780...
  'whsmith.co.uk':     /\/products\/[a-z0-9-]+\/[a-z0-9-]+/i,    // WHSmith: /products/title/9780...
  'worldofbooks.com':  /\/en-gb\/products\/[a-z0-9-]+/i,         // World of Books: /en-gb/products/title-isbn
  'blackwells.co.uk':  /\/bookshop\/product\/[a-z0-9-]+/i,       // Blackwell's
  // Beauty (Wave 25)
  'superdrug.com':     /\/[a-z0-9-]+\/p\/\d+/i,                  // /skincare/serum/p/812345
  'cultbeauty.co.uk':  /\/products\/[a-z0-9-]+/i,                // /products/charlotte-tilbury-...
  'lookfantastic.com': /\/[a-z0-9-]+\/\d+\.html/i,               // /serum-name/12345678.html
  'spacenk.com':       /\/en-gb\/[a-z0-9-]+\/[a-z0-9-]+/i,       // /en-gb/brand/product
  'theperfumeshop.com':/\/[a-z0-9-]+\/[a-z0-9-]+\/p\/\d+/i,      // /brand/product/p/12345
  'beautybay.com':     /\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/\d+\.html/i, // brand/cat/slug/123.html
  // Grocery (Wave 25)
  'tesco.com':         /\/groceries\/en-gb\/products\/\d+/i,      // /groceries/en-GB/products/123456789
  'sainsburys.co.uk':  /\/gol-ui\/product\/[a-z0-9-]+|\/groceries\/product\/details\/[a-z0-9-]+/i,
  'asda.com':          /\/product\/[a-z0-9-]+\/\d+|\/groceries\/product\/[a-z0-9-]+\/\d+/i,
  'groceries.asda.com':/\/product\/[a-z0-9-]+\/\d+|\/groceries\/product\/[a-z0-9-]+\/\d+/i,
  'morrisons.com':     /\/products\/[a-z0-9-]+-\d+/i,
  'groceries.morrisons.com': /\/products\/[a-z0-9-]+-\d+/i,
  'waitrose.com':      /\/ecom\/products\/[a-z0-9-]+\/\d+/i,
  // ebay.co.uk / ebay.com — already handled separately by the /itm/ check
  'ebay.co.uk':        /\/itm\/\d+/i,
  'ebay.com':          /\/itm\/\d+/i,
  // Wave 39 — discount + variety stores. Patterns are intentionally loose
  // because these retailers' URL conventions vary and they don't always
  // expose a stable product ID. Better to admit a soft category page than
  // drop legitimate listings.
  'homebargains.co.uk':/\/products\/[a-z0-9-]+|\/[a-z0-9-]+\/\d+/i,
  'lidl.co.uk':        /\/p\/[a-z0-9-]+|\/online-shopping\/[a-z0-9-]+/i,
  'aldi.co.uk':        /\/product\/[a-z0-9-]+|\/p\/[a-z0-9-]+/i,
  'theworks.co.uk':    /\/p\/[a-z0-9-]+|\/products\/[a-z0-9-]+/i,
  'wilko.com':         /\/[a-z0-9-]+-product\/[a-z0-9-]+/i,
  'poundland.co.uk':   /\/product\/[a-z0-9-]+|\/p\/[a-z0-9-]+/i,
};

// Returns true if the URL is plausibly a product page for the given
// retailer. If we don't have a pattern for the retailer (rare new addition)
// we fall back to a generic "has-a-path-with-digits" rule which catches
// most product URLs but lets some category pages through.
function isProductLikeUrl(url, retailer) {
  if (!url || !retailer) return false;
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  const path = parsed.pathname;
  // Reject obvious homepage / search / category-only landings
  if (!path || path === '/' || path.length < 4) return false;
  if (/^\/(search|browse|category|categories|c\/|cat\/)\b/i.test(path)) {
    // Selfridges legitimately uses /cat/ but its products end in /\d+/?$
    // — handled by its specific pattern. Other /cat/ paths are categories.
    if (retailer.host !== 'selfridges.com') return false;
  }
  const pattern = PRODUCT_URL_PATTERNS[retailer.host];
  if (pattern) return pattern.test(url);
  // Fallback: must have a numeric segment OR a product-id-looking segment
  return /\/\d{4,}|[a-z0-9-]{8,}\.(html|aspx|prd)$|\/product\/|\/p\d+/i.test(path);
}

function gatherRetailerHits(data, query) {
  const results = rawResultsOf(data);
  const hits = [];
  let droppedNonProduct = 0;
  for (const r of results) {
    const url     = r.url || r.link || '';
    const title   = r.title || r.name || query;
    const snippet = r.snippet || r.content || r.description || r.text || '';
    const retailer = matchRetailerByHost(url);
    if (!retailer) continue;
    // Tighten Amazon admission — see isAdmissibleAmazonUrl().
    if (retailer.host === 'amazon.co.uk') {
      if (!isAdmissibleAmazonUrl(url)) { droppedNonProduct++; continue; }
    } else {
      // Other retailers — require URL to look like a product page (v1.6)
      if (!isProductLikeUrl(url, retailer)) { droppedNonProduct++; continue; }
    }
    hits.push({ url, title, snippet, retailer });
  }
  if (droppedNonProduct > 0) {
    console.log(`[${VERSION}] dropped ${droppedNonProduct} non-product URLs at admission`);
  }
  return hits;
}

async function extractPricesViaHaiku(hits, query, anthropicKey) {
  if (!hits || hits.length === 0) return [];
  const numbered = hits.map((h, i) => ({
    index: i,
    title: (h.title || '').slice(0, 200),
    snippet: (h.snippet || '').slice(0, 500),
    url: (h.url || '').slice(0, 200),
  }));
  const userPrompt = `You are a price extraction tool for a UK price-comparison app. The user is searching for: "${query}"

Below are search results from UK retailers. For each one, identify the actual CURRENT PUBLIC selling price — the price ANY shopper would see and pay without conditions. Skip / never pick:
- Monthly finance prices (£X/month, £X per month, "from £X/mo")
- Bundle prices (with warranty, with cables, with installation)
- Accessory or kit prices (cases, replacement parts, screen protectors)
- Strike-through "was £X" prices — pick the current price, not the old one. CRITICAL: if a snippet shows BOTH "was £799" and "now £769" (or "-4% £769" / "£769" with a higher £799 nearby), the live deal price is the LOWER one. ALWAYS pick the lower current price when there's a clear was/now pair. Vincent's iPhone 17 test showed Amazon at £799 when the actual deal was £769 — that's exactly what to avoid.
- Prices for unrelated/wrong-model products in the snippet
- Membership-, club-, loyalty-, or subscription-gated prices: skip "AO Member", "Currys PerksPlus", "John Lewis My JL", "Boots Advantage", "Tesco Clubcard", "Nectar price", "Member price", "Trade price", "Student price", "Blue Light", "NHS price", "with subscription", "with Prime" — these are NOT the public price. If a snippet shows BOTH a member price and a higher standard price, return the standard / non-member price.
- Trade-in or part-exchange contingent prices ("£X with trade-in", "after trade-in")
- Pre-order deposits ("£100 pre-order, £X balance")

Wave 59 inclusion rules — DO accept and mark as plausible:
- Own-brand and store-brand products from Argos, Tesco, Sainsbury's, Asda, Wilko, B&M, Home Bargains, Lidl, Aldi (e.g. "Argos Pro 2-in-1 Cordless Vacuum", "Tesco Smart Kettle"). For category queries like "cordless vacuum cleaner", "kettle", "iron", "blender" the user CARES about budget-tier own-brand options — do not discriminate against them.
- Budget price points well below typical premium-brand prices (£15 kettles, £40 vacuums, £25 blenders) — these are real products at real prices, not errors. The user wants the FULL spectrum of UK retail.
- DO NOT accept refurbished, renewed, "Amazon Renewed", "Open box", "Used", "Pre-owned", or "Reconditioned" listings UNLESS the user's search query explicitly contains the word "refurbished" or "used". Vincent's iPhone 17 test surfaced an "Amazon Renewed" listing at £681 as the best price — it was a refurbished iPhone 16, totally misleading. Mark these as plausible:false.

Wave 70 — TIER / VARIANT MATCHING. The query specifies a tier; only accept listings that match that tier. Wrong-tier listings should be plausible:false.
- "iPhone 17" alone means the BASE iPhone 17 — NOT iPhone 17 Pro, NOT Pro Max, NOT Plus. If the listing title is "iPhone 17 Pro 256GB" and the query was "iPhone 17", mark plausible:false. The Pro is a different product at a different price tier and contaminates the average.
- "iPhone 17 Pro" means Pro — accept Pro listings, reject base and Pro Max.
- "Galaxy S26" means base S26, not S26+ or Ultra. Same logic.
- "MacBook Air" excludes "MacBook Pro" and vice versa.
- "Dyson V15" excludes "Dyson V12", "V11", "V8" — older / different models.
- For storage tiers: if the query specifies a storage capacity (e.g. "iPhone 17 256GB"), prefer that exact capacity. If the query has no storage spec, accept any capacity but prefer the base / lowest capacity.
- For TVs: query "Samsung 65 QLED" — only accept 65" QLED Samsung; reject 55" / 75" / OLED variants.
- The principle: when in doubt, prefer the exact tier match. A Pro listing at £999 inflating the "iPhone 17" average is a far worse outcome than dropping a few results.

Wave 78 — PRODUCT MATCH GRADING. For every listing, also grade how well its TITLE actually matches the user's search query semantically. This is the broad-fix that catches unknown patterns the explicit rules above miss (off-brand clones, wrong-generation models, accessory listings, mis-categorised products, fake/clone listings on marketplaces, etc).
- exact: title is unambiguously the same product the user asked for. Same brand, same model line, same tier. Pricing is comparable. Examples: query "Sony WH-1000XM5" → title "Sony WH-1000XM5 Wireless Headphones" = exact.
- similar: title is in the SAME category and roughly the same tier but not an identical product match. Same use case, comparable pricing band. Examples: query "cordless vacuum cleaner" → title "Beldray Cordless Stick Vacuum" = similar (category match, generic model). Query "iPhone 17" → title "iPhone 17 256GB" = exact (same product, just storage spec).
- different: title is clearly a different product, accessory, replacement part, fake/clone listing, wrong generation, wrong tier, or unrelated. Examples: query "Nintendo Switch" → title "Nintendo Switch 2 Console" = different. Query "AirPods Pro 2" → title "Apple AirPods Pro 2 Wireless Earbuds, Bluetooth Headphones, Bluetooth Earphones" at £70 from an unknown seller = different (clone listing). Query "Dyson V15" → title "Dyson V8 Replacement Battery" = different (accessory). Query "iPhone 17" → title "iPhone 17 Case Clear Cover" = different (case).

Be ASSERTIVE on "different". A wrong product surfacing as the cheapest option is far worse than dropping a borderline-similar listing. When in doubt between similar and different, choose different.

Return ONLY a JSON array, one entry per result: {"index": N, "price": number_or_null, "plausible": boolean, "query_match": "exact" | "similar" | "different"}
- price = the actual current PUBLIC £ price as a plain number (e.g. 229.99), null if only conditional / member prices visible or you can't tell
- plausible = true if this is genuinely the product the user searched for AT THE TIER THEY ASKED FOR (or a same-category own-brand alternative) at a reasonable retail price AND the price is unconditional (no membership, finance, bundle); false if accessory, mis-listing, member-only, finance-only, wrong tier (Pro when base was asked), wrong size, or wildly off-market
- query_match = "exact" | "similar" | "different" — see grading rules above

Results:
${JSON.stringify(numbered, null, 2)}

Output ONLY the JSON array.`;

  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), HAIKU_TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: 800, messages: [{ role: 'user', content: userPrompt }] }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      const err = Object.assign(new Error('Haiku error'), { status: r.status, body: txt.slice(0, 200) });
      throw err;
    }
    const data = await r.json();
    const text = ((data.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn(`[${VERSION}] Haiku response not parseable:`, text.slice(0, 200));
      return hits.map((_, i) => ({ index: i, price: null, plausible: false }));
    }
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return hits.map((_, i) => ({ index: i, price: null, plausible: false }));
    return parsed;
  } finally { clearTimeout(timer); }
}

function combineHitsWithPrices(hits, priceData) {
  const items = [];
  for (let i = 0; i < hits.length; i++) {
    const h    = hits[i];
    const meta = priceData.find(p => p.index === i);
    if (!meta || !meta.plausible || meta.price === null || meta.price === undefined) continue;
    // Wave 78 — broad-fix product match grading. If Haiku graded the
    // listing as "different" (wrong product / clone / accessory / wrong
    // tier we missed via regex), drop it. This is the catch-all that
    // handles unknown patterns the explicit rules don't cover. "exact"
    // and "similar" both pass through; the frontend can use the grade
    // for additional UX decisions (e.g. show Amazon-fallback CTA when
    // results are mostly "similar" rather than "exact").
    if (meta.query_match === 'different') {
      console.log(`[${VERSION}] dropping query_match=different: "${(h.title||'').slice(0,80)}"`);
      continue;
    }
    const p = admitPrice(meta.price);
    if (p === null) continue;
    items.push({
      source:      h.retailer.name,
      price:       p,
      link:        h.url,
      title:       h.title.slice(0, 200),
      delivery:    '',
      query_match: meta.query_match || 'exact', // default to exact when Haiku didn't grade
    });
  }
  return items;
}

// True when a URL belongs to a trusted-no-HEAD host AND matches a structural
// product-page pattern. These get a free pass past HEAD verification.
function isTrustedProductUrl(url) {
  if (!url) return false;
  const u = String(url).toLowerCase();
  for (const host of TRUSTED_NO_HEAD) {
    if (u.includes(host)) {
      return TRUSTED_PRODUCT_PATTERNS.some(p => p.test(url));
    }
  }
  return false;
}

// HEAD-check every URL in parallel. Drop any that 4xx/5xx or time out.
// Eliminates dead-link Buy buttons (audit issue H4).
//
// Trusted retailers (Amazon/JL/Argos) with product-page URL patterns skip
// the HEAD step entirely — their bot defences return 503/429 to HEAD from
// Vercel IPs, which silently dropped every Amazon hit before v1.3.
async function verifyUrls(items) {
  if (!items || items.length === 0) return items;
  const checks = items.map(async (item) => {
    if (!item.link) return null;
    if (isTrustedProductUrl(item.link)) return item; // bypass — URL is structurally stable
    try {
      const ac = new AbortController();
      const t  = setTimeout(() => ac.abort(), HEAD_VERIFY_TIMEOUT_MS);
      const r  = await fetch(item.link, {
        method: 'HEAD',
        signal: ac.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Savvey/1.0; +https://savvey.app)' },
      });
      clearTimeout(t);
      // Some retailers (Cloudflare-protected) return 403 to HEAD but page is fine for users.
      // We accept 200-399 and 403 (Forbidden often signals "human only" gate).
      return (r.ok || r.status === 403) ? item : null;
    } catch (_) {
      return null; // timeout / network error — drop
    }
  });
  const verified = (await Promise.all(checks)).filter(Boolean);
  return verified;
}

// Fetch a single hero product image via Serper Images (v1.6+).
// Cheap (~£0.0005), fires in parallel with URL HEAD checks so it doesn't add
// to total latency. Returns { url, thumbnail } or null. Uses an AbortSignal
// timeout so a slow image API can't hold up the whole search.
async function fetchHeroImage(query, serperKey) {
  if (!serperKey || !query) return null;
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 3000);
    const r = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'X-API-KEY': serperKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query + ' product', gl: 'uk', num: 3 }),
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const d = await r.json();
    const img = (d && d.images && d.images[0]) || null;
    if (!img || !img.imageUrl) return null;
    return {
      url: img.imageUrl,
      thumbnail: img.thumbnailUrl || img.imageUrl,
      source: img.source || null,
    };
  } catch (e) {
    return null;
  }
}

// Append the Amazon Associates tag to any amazon.co.uk URL. No-op for other
// hosts and no-op if AMAZON_TAG is empty (operator disabled).
//
// Handles existing query strings, fragments, and any pre-existing tag (we
// override with our own — Perplexity sometimes returns URLs with seller
// affiliate tags from the page that linked to them).
function tagAmazonUrl(url) {
  if (!url || !AMAZON_TAG) return url;
  if (!/amazon\.co\.uk/i.test(url)) return url;
  try {
    const u = new URL(url);
    u.searchParams.set('tag', AMAZON_TAG);
    return u.toString();
  } catch (_) {
    // Malformed URL — fall back to a naive append rather than dropping the link
    const sep = url.includes('?') ? '&' : '?';
    return /[?&]tag=/.test(url)
      ? url.replace(/([?&])tag=[^&#]*/i, `$1tag=${AMAZON_TAG}`)
      : `${url}${sep}tag=${AMAZON_TAG}`;
  }
}

function dedup(items) {
  const map = new Map();
  for (const it of items) {
    const key = String(it.source || '').toLowerCase();
    if (!map.has(key) || it.price < map.get(key).price) map.set(key, it);
  }
  return [...map.values()].sort((a, b) => a.price - b.price);
}

function computeCoverage(items) {
  const onlyEbay = items.length > 0 && items.every(i => String(i.source || '').toLowerCase().includes('ebay'));
  const coverage = items.length === 0 ? 'none' : items.length === 1 ? 'limited' : items.length <= 3 ? 'partial' : 'good';
  return { onlyEbay, coverage };
}

// ─────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  console.log(`[${VERSION}] ${req.method} ${req.url}`);
  applySecurityHeaders(res, ORIGIN);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit BEFORE doing any expensive work.
  if (rejectIfRateLimited(req, res, 'ai-search', RATE_LIMIT_PER_HOUR)) return;

  const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
  const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
  if (!PERPLEXITY_KEY) return res.status(503).json({ error: 'perplexity_not_configured' });
  if (!ANTHROPIC_KEY)  return res.status(503).json({ error: 'anthropic_not_configured' });

  const { q, region = 'uk', debug = false, verify = true } = req.body || {};
  if (!q) return res.status(400).json({ error: 'Missing query' });
  if (region !== 'uk') return res.status(400).json({ error: 'unsupported_region', message: `region "${region}" not yet supported` });

  // Perplexity search via circuit breaker
  let raw;
  try {
    raw = await withCircuit('perplexity', () => fetchPerplexitySearch(q, PERPLEXITY_KEY));
  } catch (e) {
    console.error(`[${VERSION}] Perplexity failed:`, e.message, e.body || '');
    return res.status(502).json({ error: 'perplexity_error', message: e.message, status: e.status });
  }

  const hits = gatherRetailerHits(raw, q);
  if (hits.length === 0) {
    return res.status(200).json({
      shopping: [],
      organic:  [],
      _meta: { version: VERSION, itemCount: 0, cheapest: null, coverage: 'none', onlyEbay: false, source: 'perplexity', region },
    });
  }

  // Haiku price extraction via circuit breaker — falls back to all-not-plausible
  // if the circuit is open or the call fails. App degrades gracefully rather
  // than 500ing.
  let priceData;
  try {
    priceData = await withCircuit('anthropic',
      () => extractPricesViaHaiku(hits, q, ANTHROPIC_KEY),
      { onOpen: () => hits.map((_, i) => ({ index: i, price: null, plausible: false })) }
    );
  } catch (e) {
    console.error(`[${VERSION}] Haiku extraction failed:`, e.message);
    priceData = hits.map((_, i) => ({ index: i, price: null, plausible: false }));
  }

  let items = combineHitsWithPrices(hits, priceData);

  // URL HEAD verification + hero image fetch — fired in parallel so the
  // image API call doesn't add to total latency. Image is optional; null
  // if Serper returns nothing or fails.
  const beforeVerify = items.length;
  const SERPER_KEY_FOR_IMG = process.env.SERPER_API_KEY || process.env.SERPER_KEY || null;
  const [verifiedItems, heroImage] = await Promise.all([
    verify ? verifyUrls(items) : Promise.resolve(items),
    fetchHeroImage(q, SERPER_KEY_FOR_IMG),
  ]);
  items = verifiedItems;
  const verifiedDropped = beforeVerify - items.length;

  const dedupedResults = dedup(items);
  const cov     = computeCoverage(dedupedResults);

  // Wave 93 — verify cheapest live price (mirrors search.js v6.25).
  // Wave 93b HOT FIX — sanity-cap on overrides. iPhone 17 case: Apple
  // extractor matched a £26.63 monthly-finance number, drift was 96.7%
  // and we overrode £799 snippet with £26.63 — user saw iPhone at £26.
  // Rule: if drift > 30%, the extractor almost certainly grabbed the
  // wrong number (finance / accessory / trade-in). Reject the
  // verification and KEEP the snippet.
  const VERIFY_DROP_DRIFT_PCT = 0.30;
  dedupedResults.sort((a, b) => (a.price || 0) - (b.price || 0));
  let priceVerification = { verified: false, reason: 'skipped' };
  if(dedupedResults.length > 0 && dedupedResults[0].link){
    priceVerification = await verifyLivePrice(dedupedResults[0]);
    if(priceVerification.verified && priceVerification.drift > VERIFY_DROP_DRIFT_PCT){
      console.warn(`[${VERSION}] price-verify: ${dedupedResults[0].source} drift ${(priceVerification.drift*100).toFixed(1)}% TOO LARGE — likely extractor mis-match. Keeping snippet £${dedupedResults[0].price}, ignoring live £${priceVerification.live}`);
      priceVerification.reason = 'drift_too_large';
      priceVerification.verified = false;
    } else if(priceVerification.verified && priceVerification.drift > VERIFY_MAX_DRIFT_PCT){
      console.log(`[${VERSION}] price-verify: ${dedupedResults[0].source} snippet £${priceVerification.snippet} → live £${priceVerification.live} (drift ${(priceVerification.drift*100).toFixed(1)}%) — overriding`);
      dedupedResults[0].price = priceVerification.live;
      dedupedResults[0].priceVerified = true;
      dedupedResults[0].priceWasOverridden = true;
      dedupedResults.sort((a, b) => (a.price || 0) - (b.price || 0));
    } else if(priceVerification.verified){
      console.log(`[${VERSION}] price-verify: ${dedupedResults[0].source} snippet £${priceVerification.snippet} matches live (drift ${(priceVerification.drift*100).toFixed(1)}%)`);
      dedupedResults[0].priceVerified = true;
    } else {
      console.log(`[${VERSION}] price-verify: ${dedupedResults[0].source} ${priceVerification.reason}`);
    }
  }
  const results = dedupedResults;

  console.log(`[${VERSION}] "${q}" raw=${rawResultsOf(raw).length} hits=${hits.length} plausible=${combineHitsWithPrices(hits, priceData).length} verified=${items.length} final=${results.length} cheapest=£${results[0]?.price ?? 'n/a'} live_verified=${priceVerification.verified}`);

  const debugEnvelope = debug ? {
    counts: {
      raw_results:    rawResultsOf(raw).length,
      uk_hits:        hits.length,
      ai_plausible:   combineHitsWithPrices(hits, priceData).length,
      url_verified:   items.length,
      verified_dropped: verifiedDropped,
      final:          results.length,
    },
    perplexity: {
      amazonCallSucceeded: raw?._amazonCallSucceeded ?? null,
      amazonHitCount:      raw?._amazonHitCount      ?? null,
    },
    rawSample: rawResultsOf(raw).slice(0, 12).map(r => ({ url: r.url || r.link, title: (r.title || r.name || '').slice(0, 80) })),
    priceDataSample: priceData.slice(0, 12),
  } : undefined;

  return res.status(200).json({
    shopping: results.map(r => ({
      source:           r.source,
      price:            `£${r.price.toFixed(2)}`,
      link:             tagAmazonUrl(r.link),  // Amazon URLs get ?tag=savvey-21 appended
      title:            r.title,
      delivery:         r.delivery,
      query_match:      r.query_match || 'exact',  // Wave 79
      price_verified:   !!r.priceVerified,         // Wave 93
      price_was_overridden: !!r.priceWasOverridden, // Wave 93
    })),
    organic: [],
    _meta: {
      version:           VERSION,
      itemCount:         results.length,
      cheapest:          results[0]?.price ?? null,
      coverage:          cov.coverage,
      onlyEbay:          cov.onlyEbay,
      source:            'perplexity',
      region,
      verified:          verify,
      verifiedDropped,
      amazonTagged:      Boolean(AMAZON_TAG),
      heroImage:         heroImage,  // { url, thumbnail, source } or null
      // Wave 93 — live price verification telemetry
      cheapestVerification: {
        verified:   !!priceVerification.verified,
        reason:     priceVerification.reason || null,
        snippetPrice: priceVerification.snippet || null,
        livePrice:  priceVerification.live || null,
        driftPct:   priceVerification.drift != null ? Math.round(priceVerification.drift * 1000) / 10 : null,
        overridden: !!(results[0] && results[0].priceWasOverridden),
      },
    },
    _debug: debugEnvelope,
  });
}
