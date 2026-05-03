// api/ai-search.js — Savvey AI Search v1.20
//
// v1.20 (3 May 2026 PM — Wave 100 category fan-out):
//   - Closes the long-running Wave 86 cordless-vacuum class. When BOTH
//     the broad call AND the comparison-angle fallback return zero
//     retailer URLs (signature of a generic-category query), Haiku
//     classifies the query and names top-3 popular UK products in that
//     category. We then run fetchPerplexitySearch on each top-3 product,
//     gather hits, and merge. Cordless vacuum cleaner → "Dyson V15
//     Detect" + "Shark Stratos IZ400UKT" + "Bosch BCH3K2861GB" → real
//     retailer hits with real prices.
//   - Cost: 1× Haiku ($0.0002) + up to 3× fetchPerplexitySearch (~$0.015
//     total premium) — only when broad+fallback would have returned 0.
//     ~5% of queries today; will drop further as Wave 99 category locks
//     improve direct hit rate.
//   - _meta.categoryProducts surfaces the top-3 product list to the
//     frontend so the results screen can show "Top picks for cordless
//     vacuum cleaner" instead of "Best deal for cordless vacuum cleaner".
//
// v1.19 (3 May 2026 PM — Wave 99c drift tiebreaker):
//   - The boolean drift cap (>30% drift → keep snippet) was correctly
//     rejecting iPhone 17's £26.63 finance number, but ALSO rejecting
//     legitimate corrections (kettle: snippet £40 stale, live £60 correct,
//     drift 50%, drift cap rejected the FIX). Replaced with one Haiku
//     tiebreaker call (~$0.0002) that asks: "snippet £X, live £Y, retailer Z,
//     query Q — which is the actual current public price?". Reply: live /
//     snippet / unknown. On unknown or call failure → keep snippet (safe
//     default, preserves iPhone 17 protection).
//   - Wave 99c reason values surfaced in _meta.cheapestVerification.reason:
//     drift_haiku_live (overrode), drift_haiku_snippet (kept snippet),
//     drift_haiku_unknown (kept snippet, ambiguous).
//
// v1.18 (3 May 2026 PM — Wave 99b retailer registration):
//   - Wave 99 added category locks for KITCHEN/SPORTS/FASHION/BOOKS but
//     the new retailer hosts (JD Sports, Sports Direct, Decathlon, Wiggle,
//     SportsShoes, M&M Direct, Pro:Direct, ASOS, Next, M&S, End., Zalando,
//     Matches, Robert Dyas, Amara, Foyles, Wordery) weren't registered in
//     UK_RETAILERS. So gatherRetailerHits dropped them at host admission
//     even when Perplexity returned valid product URLs. Live test: Nike
//     Air Max 90 returned 0 hits, kettle returned only Argos (no Lakeland).
//   - Wave 99b: registered all new hosts in _shared.js UK_RETAILERS plus
//     PRODUCT_URL_PATTERNS regex per host so admission accepts product
//     pages and rejects category/listing landings.
//
// v1.17 (3 May 2026 PM — per-category retailer curation):
//   - Wave 99 adds KITCHEN, SPORTS, FASHION, BOOKS category locks alongside
//     the existing GROCERY/BEAUTY/DIY/BUDGET. Vincent's standing concern:
//     "kettle hits Currys before Lakeland". Kitchen lock now takes
//     precedence over BUDGET so kettle/toaster/casserole queries fire an
//     additional Perplexity call locked to specialist hosts (Lakeland,
//     Robert Dyas, Dunelm, JL, Wayfair, Habitat, IKEA, Argos, Amara).
//     Same architectural pattern as Wave 26 grocery — an EXTRA call, not
//     a replacement, so generalist coverage is preserved.
//   - Sports lock: trainers/running shoes/gym kit → JD Sports, Sports
//     Direct, Decathlon, Wiggle, SportsShoes, M&M Direct, Pro:Direct.
//   - Fashion lock: dress/jeans/jacket/shoes → ASOS, Next, M&S, JL,
//     Selfridges, End., Zalando, Very, Matches.
//   - Books/stationery/games/toys → Waterstones, WHSmith, Blackwell's,
//     Foyles, Amazon, Argos, The Works, Wordery.
//   - BUDGET keywords slimmed: kettle/toaster/casserole/saucepan moved
//     to KITCHEN; vacuum/microwave/iron/fan/cleaning stay in BUDGET.
//   - Cost: zero overhead when no category matches. ~$0.005 extra
//     Perplexity per query when a category does match. Exact same shape
//     as the existing grocery/beauty extras.
//
// v1.16 (3 May 2026 — battery-test learnings):
//   - Wave 98 zero-hit fallback. Generic-category queries ("cordless
//     vacuum cleaner", "kettle", "air fryer") were hitting hits.length===0
//     because Perplexity's broad call surfaced review articles instead of
//     direct retailer product URLs. We had a comparison-angle top-up
//     downstream (Wave 97), but it only fired when items.length<3 AFTER
//     Haiku — so a zero-hit broad call returned 0 to the user without
//     ever trying the comparison angle. Now: if hits.length===0 from the
//     broad call, fall through to the comparison query before declaring
//     no results. usedFallback=true surfaced in _meta when this fires.
//   - _debug envelope now also returned on the zero-hit path so we can
//     diagnose when both calls produce nothing.
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

const VERSION = 'ai-search.js v1.20';

// Wave 93 — landing-page price verification (mirrors search.js v6.25).
// For the cheapest result only, fetch the actual product page and parse
// the live price. If snippet differs from live by >2%, override snippet
// with live so the user sees the price they'll actually find when they
// tap through. 3s timeout, graceful failure.
// Wave 97b — bumped 5s → 8s. JL was STILL timing out at 5s on heavy pages.
// Stanley flask test: snippet £52, live £24, verification timed out, user
// would have seen wrong price. JL is the most common cheapest retailer
// and absolutely worth the extra 3s headroom (Vercel function still has
// 15s overall ceiling, comfortable budget for one slow scrape).
const VERIFY_TIMEOUT_MS = 8000;
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
const BUDGET_KEYWORDS = /\b(vacuum|hoover|cordless vacuum|stick vacuum|microwave|iron(?:ing board)?|fan heater|fan|hair ?dryer|dustbin|laundry basket|drying rack|clothes airer|mop|bucket|cleaning|duster|cheap|budget|basic|own[\s-]?brand|value)\b/i;

// Wave 99 — kitchen/cookware specialist lock. Vincent's kettle case (3 May
// 2026) surfaced JL/Argos before Lakeland/Robert Dyas/Dunelm. Those three
// plus IKEA/Wayfair/Habitat consistently undercut the generalists on
// kitchenware and small homeware. Kitchen lock now takes precedence over
// BUDGET so kettle/toaster/casserole hit the specialists first.
const KITCHEN_KEYWORDS = /\b(kettle|toaster|casserole(?:\s+dish)?|saucepan|frying pan|fry pan|stockpot|wok|skillet|baking (?:tray|dish|tin)|roasting tin|cake tin|loaf tin|knife (?:set|block)|chopping board|kitchen scales?|measuring jug|colander|sieve|grater|mixing bowl|tea pot|teapot|coffee (?:maker|press|grinder|machine)|cafetiere|french press|moka pot|espresso (?:machine)?|stand mixer|hand mixer|blender|food processor|slow cooker|pressure cooker|rice cooker|breadmaker|sandwich (?:maker|toaster)|waffle maker|toastie|popcorn maker|air fryer|deep fryer|spiraliser|mandoline|le creuset|denby|emma bridgewater|joseph joseph|sage\s+(?:barista|appliance)|kitchenaid|smeg|magimix|cuisinart|delonghi|lavazza|nespresso|tassimo|dualit|breville|russell hobbs|morphy richards|ninja foodi|ninja kitchen|tower\s+(?:vortx|kitchen)|towel rail|tea towel|oven glove|apron|placemat|coaster|tablecloth|napkin)\b/i;
const KITCHEN_HOSTS    = ['lakeland.co.uk', 'robertdyas.co.uk', 'dunelm.com', 'johnlewis.com', 'wayfair.co.uk', 'habitat.co.uk', 'ikea.com', 'argos.co.uk', 'amara.com'];

// Wave 99 — sports / fitness lock. Trainers, sportswear, gym kit,
// running shoes — JD Sports, Sports Direct, Decathlon, Wiggle, SportsShoes
// are where the deals are. Currys/JL surface here today and that's wrong.
const SPORTS_KEYWORDS  = /\b(trainers?|running shoes?|football boots?|cleats?|gym (?:kit|shorts|wear|leggings)|tracksuit|joggers|hoodie|sports bra|leggings|yoga (?:mat|pants|block)|dumbbells?|kettlebell|barbell|weight (?:plates?|set|bench)|treadmill|exercise bike|spin bike|rowing machine|protein (?:powder|shake|bar)|football|basketball|tennis (?:racket|ball)|cricket bat|hockey stick|swimsuit|swim trunks|goggles|cycling (?:helmet|jersey|shorts|jacket)|bike (?:helmet|lights|lock|pump)|nike|adidas|puma|under armour|reebok|asics|new balance|brooks|on running|hoka|salomon|garmin (?:fenix|forerunner|venu|epix|edge)|polar (?:vantage|grit|pacer)|fitbit|whoop|wahoo)\b/i;
const SPORTS_HOSTS     = ['jdsports.co.uk', 'sportsdirect.com', 'decathlon.co.uk', 'wiggle.co.uk', 'sportsshoes.com', 'mandmdirect.com', 'pro-direct.com', 'wiggle.com', 'argos.co.uk', 'amazon.co.uk'];

// Wave 99 — fashion / apparel lock. Dress, shirt, jeans, jacket, etc.
// ASOS, Next, M&S, JL, Selfridges, Zalando, End. Currys is wrong here.
const FASHION_KEYWORDS = /\b(dress|skirt|blouse|jumper|cardigan|sweater|t[\s-]?shirt|tee|polo shirt|shirt|jeans|chinos|trousers|shorts|coat|jacket|blazer|parka|raincoat|gilet|suit|tie|belt|scarf|gloves|hat|beanie|cap|wallet|purse|handbag|backpack|tote bag|crossbody|bag|sunglasses|watch|necklace|ring|earrings|bracelet|boots?|loafers?|heels|stilettos?|sandals|flip[\s-]?flops|slippers|levis?|gap\s|zara|h&m|uniqlo|reiss|ted baker|barbour|north face|patagonia|carhartt|stone island|cos\s|arket|ralph lauren|tommy hilfiger|hugo boss|calvin klein|polo ralph)\b/i;
const FASHION_HOSTS    = ['asos.com', 'next.co.uk', 'marksandspencer.com', 'johnlewis.com', 'selfridges.com', 'endclothing.com', 'zalando.co.uk', 'verygoodthing.co.uk', 'very.co.uk', 'matchesfashion.com'];

// Wave 99 — books / stationery / media lock.
const BOOKS_KEYWORDS   = /\b(book|hardback|paperback|kindle edition|audiobook|cookbook|notebook|notepad|diary|journal|stationery|pen|pencil|fountain pen|fineliner|sharpie|highlighter|moleskine|leuchtturm|sticky notes?|envelopes?|gift wrap|wrapping paper|greetings? card|birthday card|board game|jigsaw|puzzle|lego|funko|action figure|barbie|hot wheels)\b/i;
const BOOKS_HOSTS      = ['waterstones.com', 'whsmith.co.uk', 'blackwells.co.uk', 'foyles.co.uk', 'amazon.co.uk', 'argos.co.uk', 'theworks.co.uk', 'wordery.com'];

function detectCategoryLock(query) {
  const q = String(query || '');
  if (GROCERY_KEYWORDS.test(q)) return { name: 'grocery', hosts: GROCERY_HOSTS };
  if (BEAUTY_KEYWORDS.test(q))  return { name: 'beauty',  hosts: BEAUTY_HOSTS };
  if (KITCHEN_KEYWORDS.test(q)) return { name: 'kitchen', hosts: KITCHEN_HOSTS };  // Wave 99 — kitchen above DIY/BUDGET
  if (SPORTS_KEYWORDS.test(q))  return { name: 'sports',  hosts: SPORTS_HOSTS };   // Wave 99
  if (FASHION_KEYWORDS.test(q)) return { name: 'fashion', hosts: FASHION_HOSTS };  // Wave 99
  if (BOOKS_KEYWORDS.test(q))   return { name: 'books',   hosts: BOOKS_HOSTS };    // Wave 99
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
  // Wave 99 — kitchen / homeware specialists
  'lakeland.co.uk':    /\/\d{4,}\/[a-z0-9-]+|\/products\/[a-z0-9-]+/i,           // /12345/product-slug or /products/slug
  'dunelm.com':        /\/product\/[a-z0-9-]+|\/[a-z0-9-]+\/\d{6,}/i,
  'robertdyas.co.uk':  /\/[a-z0-9-]+\.html|\/p\/\d+/i,
  'wayfair.co.uk':     /\/[a-z0-9-]+\/pdp\/[a-z0-9-]+/i,                          // /slug/pdp/product
  'habitat.co.uk':     /\/[a-z0-9-]+\/[a-z0-9-]+\/\d+/i,
  'ikea.com':          /\/p\/|\/products\/|-\d{8,}/i,                             // IKEA product IDs are 8 digits
  'amara.com':         /\/products\/[a-z0-9-]+/i,
  // Wave 99 — sports / fitness retailers (URL conventions vary widely; use
  // permissive patterns so we don't drop legitimate hits)
  'jdsports.co.uk':    /\/product\/[a-z0-9-]+\/\d+|\/p\/[a-z0-9-]+/i,             // /product/nike-air-max-90/123456
  'sportsdirect.com':  /\/[a-z0-9-]+\/\d{6,}|\/p\/\d+/i,                          // /nike-air-max-90/123456
  'decathlon.co.uk':   /\/p\/[a-z0-9-]+|\/[a-z0-9-]+-id_[a-z0-9-]+/i,             // /p/abc or /slug-id_xxx
  'wiggle.co.uk':      /\/[a-z0-9-]+\/?$|\/products\/[a-z0-9-]+/i,
  'sportsshoes.com':   /\/product\/[a-z0-9-]+/i,
  'mandmdirect.com':   /\/[a-z0-9-]+\/\d+\/[a-z0-9-]+/i,
  'pro-direct.com':    /\/[a-z0-9-]+\/[a-z0-9-]+\/\d+/i,
  // Wave 99 — fashion / apparel specialists
  'asos.com':          /\/prd\/\d+|\/[a-z0-9-]+\/[a-z0-9-]+\/prd\/\d+/i,          // /prd/12345
  'next.co.uk':        /\/style\/[a-z0-9-]+|\/g\d+/i,
  'marksandspencer.com':/\/p\/[a-z0-9-]+|\/(?:gb|en-gb)\/[a-z0-9-]+\/p\//i,
  'endclothing.com':   /\/gb\/[a-z0-9-]+|\/products\/[a-z0-9-]+/i,
  'zalando.co.uk':     /\/[a-z0-9-]+-[a-z0-9]{6,}\.html/i,
  'matchesfashion.com':/\/products\/[a-z0-9-]+-\d+/i,
  // Wave 99 — books / media additions
  'foyles.co.uk':      /\/witem\/[a-z0-9-]+|\/(?:childrens|fiction|non-fiction)\/[a-z0-9-]+/i,
  'wordery.com':       /\/[a-z0-9-]+-[0-9]{10,13}/i,                              // ISBN in slug
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

// Wave 99c — drift tiebreaker. When live-page extraction differs from the
// snippet by > 30%, the boolean drift cap conservatively kept the snippet
// (right call for iPhone 17's £26 finance number, wrong call for kettle
// where snippet £40 was stale and live £60 was correct). Ask Haiku which
// is the actual current public price. Returns "live" / "snippet" /
// "unknown". On any failure / ambiguity → "unknown" (caller keeps snippet,
// preserves the iPhone safety guarantee).
async function driftTiebreaker(snippet, live, retailer, query, anthropicKey){
  if (!anthropicKey || !snippet || !live) return 'unknown';
  const userPrompt = `Two prices were extracted for this product at this retailer. Which is the actual current public selling price a UK shopper would see and pay right now?

Query: "${query}"
Retailer: ${retailer}
Snippet (Google search result): £${snippet}
Live (current product page extraction): £${live}

Rules:
- If "live" looks like a monthly finance figure (£20-£40 for a £400+ product), choose "snippet".
- If "live" looks like an accessory or replacement-part price (e.g. £15 for a £300 vacuum, £30 for an iPhone), choose "snippet".
- If "snippet" looks like an old promo / pre-order / member-only price and "live" is a normal current price, choose "live".
- If both look like plausible standalone unit prices and you can't tell which is current, reply "unknown" (the caller will play safe).

Reply with exactly one word: "live", "snippet", or "unknown". No explanation.`;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method:'POST',
      headers:{'content-type':'application/json','x-api-key':anthropicKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: 12, messages: [{role:'user', content: userPrompt}] }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return 'unknown';
    const j = await r.json();
    const text = (j?.content?.[0]?.text || '').trim().toLowerCase();
    if (text.includes('live')) return 'live';
    if (text.includes('snippet')) return 'snippet';
    return 'unknown';
  } catch (e) {
    return 'unknown';
  }
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

// Wave 100 — Haiku category-router preflight. The biggest unsolved class
// of zero-hit failures comes from generic-category queries ("cordless
// vacuum cleaner", "kettle", "air fryer", "fan"). Perplexity returns
// review articles or category-LISTING URLs, none of which match
// PRODUCT_URL_PATTERNS, so admission rejects everything. Live test 3 May:
// cordless vacuum returned 28 raw, 0 UK_hits, 0 final.
//
// Fix: one $0.0002 Haiku call up front asking "is this a specific product
// or a category? If category, name 3 popular UK products in it right now."
// For category queries we then fan out and run normal flow on each top-3
// product, merge results, surface them. ~$0.0002 total premium for the
// router; the extra Perplexity calls only fire when we'd have returned
// zero anyway.
//
// Returns:
//   { kind: 'specific' }                — proceed normally
//   { kind: 'category', products: [...] } — fan out
//   { kind: 'specific' }                — on any failure (safe default)
async function classifyQueryViaHaiku(query, anthropicKey){
  if (!anthropicKey || !query) return { kind: 'specific' };
  const prompt = `Classify this UK shopping query.

Query: "${query}"

Reply STRICT JSON only, no other text:
{"kind": "specific"|"category", "products": ["...", "...", "..."]}

- "specific" = a particular product or model (e.g. "Dyson V15 Detect", "iPhone 17 Pro 256GB", "Nike Air Max 90", "Le Creuset signature 24cm").
  Reply: {"kind":"specific","products":[]}
- "category" = a generic category with many possible products (e.g. "cordless vacuum cleaner", "kettle", "running shoes", "air fryer", "casserole dish", "midi dress").
  Reply: {"kind":"category","products":["Top product 1","Top product 2","Top product 3"]}
  - Pick THREE products that are popular and currently widely available in the UK in 2026 IN THIS CATEGORY.
  - Use exact specific product names a UK shopper would type to find a single SKU (e.g. "Dyson V15 Detect", "Shark Stratos IZ400UKT", "Bosch BCH3K2861GB"; NOT "Dyson cordless").
  - Cover at least one budget-tier and one premium-tier option to give the user range.
- If unclear, default to "specific".`;

  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method:'POST',
      headers:{'content-type':'application/json','x-api-key':anthropicKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({ model: HAIKU_MODEL, max_tokens: 200, messages: [{role:'user', content: prompt}] }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return { kind: 'specific' };
    const j = await r.json();
    const text = (j?.content?.[0]?.text || '').trim();
    // Tolerate markdown fences
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(cleaned);
    if (parsed?.kind === 'category' && Array.isArray(parsed.products) && parsed.products.length > 0) {
      return { kind: 'category', products: parsed.products.slice(0, 3).map(s => String(s).trim()).filter(Boolean) };
    }
    return { kind: 'specific' };
  } catch (e) {
    return { kind: 'specific' };
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

  let hits = gatherRetailerHits(raw, q);

  // Wave 98 — when the broad call returns ZERO retailer URLs (common for
  // generic categories like "cordless vacuum cleaner" or "kettle" where
  // Perplexity surfaces review articles instead of retailer product pages),
  // fall through to the comparison-angle top-up before declaring no
  // results. Same call shape as the post-Haiku top-up at line ~761, just
  // moved earlier so it can rescue the zero-hit case.
  // Why: previously the early-return at this exact spot is what re-broke
  // cordless vacuum and the generic-category coverage gap (Wave 86).
  // Cost: one extra Perplexity call (~$0.005) only when broad returns zero.
  let usedFallback = false;
  if (hits.length === 0) {
    try {
      const fallbackQuery = `${q} review price comparison UK 2026 cheapest`;
      const fallbackData = await callPerplexity(fallbackQuery, PERPLEXITY_KEY, 10);
      const fallbackHits = gatherRetailerHits(fallbackData, q);
      if (fallbackHits.length > 0) {
        hits = fallbackHits;
        usedFallback = true;
        console.log(`[${VERSION}] zero-hit fallback rescued ${hits.length} retailer URLs`);
      }
    } catch (e) {
      console.warn(`[${VERSION}] zero-hit fallback failed: ${e.message}`);
    }
  }

  // Wave 100 — category fan-out. When BOTH the broad call and the
  // comparison fallback return zero retailer URLs, the query is almost
  // certainly a generic category ("cordless vacuum cleaner", "kettle",
  // "air fryer"). Ask Haiku to name top-3 specific products in that
  // category, then re-run the broad search for each. Merge product hits.
  // Cost: 1× Haiku ($0.0002) + up to 3× fetchPerplexitySearch (~$0.015
  // total) — only when we'd otherwise return 0. Closes the long-running
  // Wave 86 cordless-vacuum class.
  let categoryProducts = null;
  if (hits.length === 0) {
    try {
      const cls = await classifyQueryViaHaiku(q, ANTHROPIC_KEY);
      if (cls.kind === 'category' && cls.products && cls.products.length > 0) {
        categoryProducts = cls.products;
        console.log(`[${VERSION}] category fan-out: ${q} → ${categoryProducts.join(' | ')}`);
        const fanResults = await Promise.allSettled(
          categoryProducts.map(p => fetchPerplexitySearch(p, PERPLEXITY_KEY))
        );
        const fanHits = [];
        const seen = new Set();
        for (let i = 0; i < fanResults.length; i++) {
          const fr = fanResults[i];
          if (fr.status !== 'fulfilled' || !fr.value) continue;
          const productHits = gatherRetailerHits(fr.value, categoryProducts[i]);
          for (const h of productHits) {
            if (!seen.has(h.url)) { seen.add(h.url); fanHits.push({ ...h, fanProduct: categoryProducts[i] }); }
          }
        }
        if (fanHits.length > 0) {
          hits = fanHits;
          console.log(`[${VERSION}] category fan-out rescued ${hits.length} hits across ${categoryProducts.length} products`);
        }
      }
    } catch (e) {
      console.warn(`[${VERSION}] category fan-out failed: ${e.message}`);
    }
  }

  if (hits.length === 0) {
    return res.status(200).json({
      shopping: [],
      organic:  [],
      _meta: { version: VERSION, itemCount: 0, cheapest: null, coverage: 'none', onlyEbay: false, source: 'perplexity', region, usedFallback, categoryProducts },
      _debug: debug ? { counts: { raw_results: rawResultsOf(raw).length, uk_hits: 0, ai_plausible: 0, url_verified: 0, verified_dropped: 0, final: 0 }, rawSample: rawResultsOf(raw).slice(0, 12).map(r => ({ url: r.url || r.link, title: (r.title || r.name || '').slice(0, 80) })) } : undefined,
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

  // Wave 97 — thin-coverage top-up. When the broad/amazon/loose calls
  // returned <3 plausible items, fire ONE more Perplexity call at a
  // different angle ("review / comparison / best price") to surface
  // tech-blog and comparison-site results that often link to specific
  // retailer products with fresh prices. Costs ~$0.005 per thin search,
  // worth it because (a) it replaces the Serper Tier 2 fallback that
  // was burning quota and (b) the additional Perplexity result quality
  // is materially better than Serper snippets. Only fires when really
  // needed — common case (3+ items already) is unchanged.
  if (items.length < 3) {
    try {
      const topupQuery = `${q} review price comparison UK 2026 cheapest`;
      const topupData = await callPerplexity(topupQuery, PERPLEXITY_KEY, 10);
      const topupHits = gatherRetailerHits(topupData, q);
      if (topupHits.length > 0) {
        // Filter out duplicates already present
        const existingUrls = new Set(items.map(i => i.link));
        const newHits = topupHits.filter(h => !existingUrls.has(h.url));
        if (newHits.length > 0) {
          const topupPrices = await withCircuit('anthropic',
            () => extractPricesViaHaiku(newHits, q, ANTHROPIC_KEY),
            { onOpen: () => newHits.map((_, i) => ({ index: i, price: null, plausible: false })) }
          );
          const topupItems = combineHitsWithPrices(newHits, topupPrices);
          const beforeTopup = items.length;
          items.push(...topupItems);
          console.log(`[${VERSION}] thin-coverage top-up: ${beforeTopup} → ${items.length} (+${topupItems.length})`);
        }
      }
    } catch (e) {
      console.warn(`[${VERSION}] top-up call failed: ${e.message}`);
    }
  }

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
  // Wave 99 — qm:exact must rank above qm:similar regardless of price.
  // Reason: Bose QuietComfort Ultra (~£349 retail) returned a JL £199
  // graded `qm:similar` (likely the previous-gen QC45) AHEAD of the real
  // exact-match Argos hit. We were surfacing the wrong product as
  // cheapest. Sort tiers: exact first, similar second, anything else
  // last; ties broken by price ascending. price-only ranking is the
  // recipe for catastrophic mis-matches.
  const QM_RANK = { exact: 0, similar: 1 };
  const qmKey = (r) => QM_RANK[r.query_match] != null ? QM_RANK[r.query_match] : 2;
  dedupedResults.sort((a, b) => {
    const qa = qmKey(a), qb = qmKey(b);
    if (qa !== qb) return qa - qb;
    return (a.price || 0) - (b.price || 0);
  });
  let priceVerification = { verified: false, reason: 'skipped' };
  if(dedupedResults.length > 0 && dedupedResults[0].link){
    priceVerification = await verifyLivePrice(dedupedResults[0]);
    if(priceVerification.verified && priceVerification.drift > VERIFY_DROP_DRIFT_PCT){
      // Wave 99c — drift > 30% used to mean "extractor wrong, keep snippet"
      // (good for iPhone 17's £26 finance number). But sometimes the
      // SNIPPET is the stale one (kettle £40 snippet vs live £60). Ask
      // Haiku which is the real current price. ~$0.0002 per call, only
      // fires when drift > 30% (rare). Defaults to keeping snippet on
      // unknown / failure (preserves iPhone safety).
      const verdict = await driftTiebreaker(
        priceVerification.snippet,
        priceVerification.live,
        dedupedResults[0].source,
        q,
        ANTHROPIC_KEY
      );
      if (verdict === 'live') {
        console.log(`[${VERSION}] price-verify: ${dedupedResults[0].source} drift ${(priceVerification.drift*100).toFixed(1)}% — Haiku says LIVE (£${priceVerification.snippet} → £${priceVerification.live}), overriding`);
        dedupedResults[0].price = priceVerification.live;
        dedupedResults[0].priceVerified = true;
        dedupedResults[0].priceWasOverridden = true;
        priceVerification.reason = 'drift_haiku_live';
        dedupedResults.sort((a, b) => {
          const qa = qmKey(a), qb = qmKey(b);
          if (qa !== qb) return qa - qb;
          return (a.price || 0) - (b.price || 0);
        });
      } else {
        console.warn(`[${VERSION}] price-verify: ${dedupedResults[0].source} drift ${(priceVerification.drift*100).toFixed(1)}% TOO LARGE — Haiku verdict "${verdict}" — keeping snippet £${dedupedResults[0].price}, ignoring live £${priceVerification.live}`);
        priceVerification.reason = verdict === 'snippet' ? 'drift_haiku_snippet' : 'drift_haiku_unknown';
        priceVerification.verified = false;
      }
    } else if(priceVerification.verified && priceVerification.drift > VERIFY_MAX_DRIFT_PCT){
      console.log(`[${VERSION}] price-verify: ${dedupedResults[0].source} snippet £${priceVerification.snippet} → live £${priceVerification.live} (drift ${(priceVerification.drift*100).toFixed(1)}%) — overriding`);
      dedupedResults[0].price = priceVerification.live;
      dedupedResults[0].priceVerified = true;
      dedupedResults[0].priceWasOverridden = true;
      dedupedResults.sort((a, b) => {  // Wave 99 — keep qm-priority sort after override
        const qa = qmKey(a), qb = qmKey(b);
        if (qa !== qb) return qa - qb;
        return (a.price || 0) - (b.price || 0);
      });
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
      usedFallback,                                         // Wave 98 — true if zero-hit comparison fallback rescued the search
      categoryProducts,                                     // Wave 100 — top-3 product list when query was classified as category, else null
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
