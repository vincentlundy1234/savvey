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

const VERSION = 'ai-search.js v1.7';
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

// Two parallel Perplexity calls:
//   - Broad: all UK retailers EXCEPT Amazon, OR'd together (10 results)
//   - Amazon-locked: site:amazon.co.uk ONLY (10 results)
//
// Merge by URL (dedup) so a single result that appears in both buckets
// only counts once. If either call fails, the other still wins — graceful
// degrade rather than 502'ing the whole search.
async function fetchPerplexitySearch(query, apiKey) {
  const broadHosts = UK_RETAILERS
    .filter(r => r.host !== 'amazon.co.uk')
    .map(r => `site:${r.host}`)
    .join(' OR ');
  const broadQuery  = `${query} buy UK price (${broadHosts})`;
  // inurl:dp forces Perplexity to return ASIN product URLs only — without
  // it we get music.amazon.co.uk and other non-retail subdomain pages.
  const amazonQuery = `${query} buy UK price site:amazon.co.uk inurl:dp`;

  const [broadSettled, amazonSettled] = await Promise.allSettled([
    callPerplexity(broadQuery,  apiKey, 10),
    callPerplexity(amazonQuery, apiKey, 10),
  ]);

  // Surface fatal errors only when BOTH calls failed. Single-call failure
  // just means we operate with the surviving call's results.
  if (broadSettled.status === 'rejected' && amazonSettled.status === 'rejected') {
    throw broadSettled.reason; // either failure is representative
  }

  const broadData  = broadSettled.status  === 'fulfilled' ? broadSettled.value  : null;
  const amazonData = amazonSettled.status === 'fulfilled' ? amazonSettled.value : null;

  // Diagnostic logging — track which call contributed what.
  const broadCount  = rawResultsOf(broadData).length;
  const amazonCount = rawResultsOf(amazonData).length;
  if (broadSettled.status === 'rejected') {
    console.warn(`[${VERSION}] broad Perplexity call failed:`, broadSettled.reason?.message || broadSettled.reason);
  }
  if (amazonSettled.status === 'rejected') {
    console.warn(`[${VERSION}] amazon Perplexity call failed:`, amazonSettled.reason?.message || amazonSettled.reason);
  }
  console.log(`[${VERSION}] perplexity dual: broad=${broadCount} amazon=${amazonCount}`);

  // Merge + dedup by URL. Order: broad first, then Amazon, so broad's
  // canonical hit wins if there's overlap (rare since broad excludes Amazon).
  const seen     = new Set();
  const combined = [];
  for (const r of [...rawResultsOf(broadData), ...rawResultsOf(amazonData)]) {
    const url = r.url || r.link || '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    combined.push(r);
  }

  // Return in the same shape the rest of the pipeline expects.
  return { results: combined, _amazonCallSucceeded: amazonSettled.status === 'fulfilled', _amazonHitCount: amazonCount };
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
  'currys.co.uk':      /\/products\/[a-z0-9-]+-\d{6,}/i,    // /products/sony-...-10245678
  'argos.co.uk':       /\/product\/\d{6,}/i,                // /product/8447423
  'johnlewis.com':     /\/p\d{6,}/i,                        // /sony.../p7060324
  'ao.com':            /\/product\/[a-z0-9-]+\/\w+\.aspx/i, // /product/lg-c4-tv/lgc4-65inch.aspx (variants)
  'very.co.uk':        /\/[a-z0-9-]+\.prd/i,                // /sony-headphones.prd
  'richersounds.com':  /\/product\/[a-z0-9-]+/i,            // /product/sony-wh-1000xm5
  'box.co.uk':         /\/details\/[a-z0-9-]+\/\d+/i,       // /details/sony-headphones/123456
  'halfords.com':      /\/[a-z0-9-]+-\d{6,}\.html/i,        // /...-456789.html
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
  // ebay.co.uk / ebay.com — already handled separately by the /itm/ check
  'ebay.co.uk':        /\/itm\/\d+/i,
  'ebay.com':          /\/itm\/\d+/i,
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
- Strike-through "was £X" prices — pick the current price, not the old one
- Prices for unrelated/wrong-model products in the snippet
- Membership-, club-, loyalty-, or subscription-gated prices: skip "AO Member", "Currys PerksPlus", "John Lewis My JL", "Boots Advantage", "Tesco Clubcard", "Nectar price", "Member price", "Trade price", "Student price", "Blue Light", "NHS price", "with subscription", "with Prime" — these are NOT the public price. If a snippet shows BOTH a member price and a higher standard price, return the standard / non-member price.
- Trade-in or part-exchange contingent prices ("£X with trade-in", "after trade-in")
- Pre-order deposits ("£100 pre-order, £X balance")

Return ONLY a JSON array, one entry per result: {"index": N, "price": number_or_null, "plausible": boolean}
- price = the actual current PUBLIC £ price as a plain number (e.g. 229.99), null if only conditional / member prices visible or you can't tell
- plausible = true if this is genuinely the product the user searched for at a reasonable retail price AND the price is unconditional (no membership, finance, bundle); false if accessory, mis-listing, member-only, finance-only, or wildly off-market

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
    const p = admitPrice(meta.price);
    if (p === null) continue;
    items.push({ source: h.retailer.name, price: p, link: h.url, title: h.title.slice(0, 200), delivery: '' });
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

  const results = dedup(items);
  const cov     = computeCoverage(results);

  console.log(`[${VERSION}] "${q}" raw=${rawResultsOf(raw).length} hits=${hits.length} plausible=${combineHitsWithPrices(hits, priceData).length} verified=${items.length} final=${results.length} cheapest=£${results[0]?.price ?? 'n/a'}`);

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
      source:   r.source,
      price:    `£${r.price.toFixed(2)}`,
      link:     tagAmazonUrl(r.link),  // Amazon URLs get ?tag=savvey-21 appended
      title:    r.title,
      delivery: r.delivery,
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
    },
    _debug: debugEnvelope,
  });
}
