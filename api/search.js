/**
 * Savvey — /api/search.js  v5.0
 *
 * Production hardening vs v4:
 *  - Circuit breaker: CSE 429/403 → Awin fallback (when key is set)
 *  - Security headers: X-Content-Type-Options, Strict-Transport-Security
 *  - AwinProductProvider class: swap in real credentials later
 *  - clean() sanitiser + normalisePrice() at intake (no string prices in pipeline)
 *  - Sanity filter uses lowest×3 anchor, runs on final combined array
 *  - All API keys from process.env only — none hardcoded
 *  - Forensic per-item filter logs for Vercel Function Log debugging
 */

const VERSION      = 'search.js v5.0';
const ABSOLUTE_MAX = 2500; // hard cap — reject anything above this regardless

// ── Price sanitiser ───────────────────────────────────────────
// Strips all non-digit/dot chars then parseFloat.
// Handles: '£1,000.00' → 1000, '£229.99' → 229.99, null → NaN
const clean = v => parseFloat(String(v).replace(/[^\d.]/g, ''));

// ── Retailer map ──────────────────────────────────────────────
const UK_RETAILERS = {
  'amazon.co.uk':     { name: 'Amazon UK',    aff: '?tag=savvey-21' },
  'currys.co.uk':     { name: 'Currys',        aff: '' },
  'johnlewis.com':    { name: 'John Lewis',    aff: '' },
  'argos.co.uk':      { name: 'Argos',         aff: '' },
  'ao.com':           { name: 'AO.com',        aff: '' },
  'very.co.uk':       { name: 'Very',          aff: '' },
  'richersounds.com': { name: 'Richer Sounds', aff: '' },
  'box.co.uk':        { name: 'Box.co.uk',     aff: '' },
  'ebay.co.uk':       { name: 'eBay UK',       aff: '' },
  'halfords.com':     { name: 'Halfords',      aff: '' },
  'screwfix.com':     { name: 'Screwfix',      aff: '' },
  'boots.com':        { name: 'Boots',         aff: '' },
  'costco.co.uk':     { name: 'Costco UK',     aff: '' },
  'toolstation.com':  { name: 'Toolstation',   aff: '' },
  'dunelm.com':       { name: 'Dunelm',        aff: '' },
  'wayfair.co.uk':    { name: 'Wayfair UK',    aff: '' },
  'bq.co.uk':         { name: 'B&Q',           aff: '' },
  'tesco.com':        { name: 'Tesco',         aff: '' },
  'asda.com':         { name: 'Asda',          aff: '' },
};

function matchRetailer(url) {
  if (!url) return null;
  for (const [domain, data] of Object.entries(UK_RETAILERS)) {
    if (url.includes(domain)) return { domain, ...data };
  }
  return null;
}

// Extract £price from prose text (snippets, titles)
function extractPriceFromText(str) {
  if (!str) return null;
  const m = str.match(/£\s?([\d,]+(?:\.\d{1,2})?)/);
  return m ? clean(m[1]) : null;
}

// Normalise any raw price to a clean float, or null if implausible
function normalisePrice(raw) {
  const n = clean(raw);
  return (isNaN(n) || n <= 0 || n > ABSOLUTE_MAX) ? null : n;
}

// ── URL validator ─────────────────────────────────────────────
// Rejects category/search/browse pages that show aggregate "from" prices.
function isValidProductUrl(url, provider) {
  if (!url) return false;
  try {
    const path = new URL(url).pathname;
    if (provider === 'amazon') {
      if (['/s?', '/b?', '/Best-Sellers', '/stores/'].some(p => url.includes(p))) return false;
      return path.includes('/dp/') || path.includes('/gp/product/');
    }
    if (provider === 'ebay') {
      if (['/sch/', '/deals/', '/usr/'].some(p => path.includes(p))) return false;
      const segs = path.split('/').filter(Boolean);
      if (segs[0] === 'b' || segs[0] === 'shop') return false;
      return path.includes('/itm/');
    }
    return !['/search', '/browse', '/category', '/c/', '?q='].some(p => url.includes(p));
  } catch { return false; }
}

// ── Sanity filter ─────────────────────────────────────────────
// Anchors to LOWEST price across ALL sources (not median).
// Runs once on the final combined deduplicated array.
// item.price is a clean Number at this point — guaranteed by admit().
function sanityFilter(items, query) {
  if (items.length < 2) return items;
  const lowest  = Math.min(...items.map(i => i.price));
  const ceiling = lowest * 3.0;
  const floor   = lowest * 0.5;
  console.log(`[${VERSION}][SANITY] query="${query}" lowest=£${lowest} ceiling=£${ceiling}`);
  return items.filter(item => {
    const p    = item.price;
    const pass = p >= floor && p <= ceiling;
    console.log(
      `[${VERSION}][FILTER] [${item.source}] ${item.retailer}` +
      ` | price=${p} typeof=${typeof p}` +
      ` | ${p} <= ${ceiling}: ${p <= ceiling}` +
      ` | ${pass ? 'PASS ✅' : 'FAIL ❌'}`
    );
    return pass;
  });
}

// ──────────────────────────────────────────────────────────────
//  AwinProductProvider
//  Swap in real credentials by setting AWIN_API_KEY in Vercel env vars.
//  No code change required — the class self-activates when the key exists.
// ──────────────────────────────────────────────────────────────
class AwinProductProvider {
  constructor() {
    this.apiKey  = process.env.AWIN_API_KEY || null;
    this.baseUrl = 'https://productdata.awin.com/datafeed/list/apikey';
    this.enabled = !!this.apiKey;
  }

  isEnabled() { return this.enabled; }

  async search(query) {
    if (!this.enabled) throw new Error('Awin not configured: AWIN_API_KEY not set');

    const params = new URLSearchParams({
      apikey:   this.apiKey,
      freetext: query,
      country:  'GB',
      currency: 'GBP',
      format:   'json',
      limit:    '20',
    });

    const res = await fetch(`${this.baseUrl}?${params}`, {
      headers: { Accept: 'application/json' },
    });

    if (res.status === 429 || res.status === 403) {
      throw new Error(`Awin rate limited: HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`Awin HTTP ${res.status}`);

    const data     = await res.json();
    const products = Array.isArray(data) ? data : (data.products || data.feed?.products || []);

    return products
      .map(p => {
        const url      = p.aw_deep_link || p.merchant_deep_link || '';
        const retailer = matchRetailer(url);
        return {
          retailer: retailer ? retailer.name : (p.merchant_name || 'Unknown'),
          domain:   retailer ? retailer.domain : '',
          aff:      retailer ? retailer.aff    : '',
          // Awin sends comma-formatted strings — clean() handles it
          price:    clean(p.display_price || p.search_price || '0'),
          link:     url,
          sub:      '',
        };
      })
      .filter(p => !isNaN(p.price) && p.price > 0 && p.link);
  }
}

// ── Circuit breaker state ─────────────────────────────────────
// Tracks whether Google CSE has tripped (429/403).
// Resets after CIRCUIT_RESET_MS to allow CSE to retry (e.g. next day).
// This is module-level state — persists across requests within the same
// Vercel function instance (typically minutes, not days).
const CIRCUIT_RESET_MS = 60 * 60 * 1000; // 1 hour
let cseCircuitOpen     = false;
let cseCircuitOpenedAt = 0;

function cseCircuitTripped() {
  if (!cseCircuitOpen) return false;
  if (Date.now() - cseCircuitOpenedAt > CIRCUIT_RESET_MS) {
    cseCircuitOpen = false;
    console.log(`[${VERSION}][CIRCUIT] CSE circuit reset after 1hr`);
    return false;
  }
  return true;
}

function tripCseCircuit() {
  cseCircuitOpen     = true;
  cseCircuitOpenedAt = Date.now();
  console.warn(`[${VERSION}][CIRCUIT] CSE circuit tripped — will retry after 1hr`);
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {

  // ── Security headers ──────────────────────────────────────
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Vary',                         'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Prevent MIME-type sniffing attacks
  res.setHeader('X-Content-Type-Options',       'nosniff');
  // Force HTTPS for 1 year (Vercel always serves HTTPS, belt-and-braces)
  res.setHeader('Strict-Transport-Security',    'max-age=31536000; includeSubDomains');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { q, type = 'shopping' } = req.body || {};
  if (!q) return res.status(400).json({ error: 'Missing query' });

  console.log(`[${VERSION}] ── START query="${q}" ──`);

  const awin         = new AwinProductProvider();
  const rawItems     = [];
  const sourceStatus = {};
  let   rateLimited  = false;

  // Centralised intake — all items must pass through here.
  // Ensures item.price is always a clean Number before entering rawItems.
  function admit(item, sourceLabel) {
    const price = normalisePrice(item.price);
    if (price === null) {
      console.log(`[${VERSION}][ADMIT] REJECTED ${item.retailer} raw="${item.price}"`);
      return;
    }
    rawItems.push({ ...item, price, source: sourceLabel });
  }

  // ── SOURCE 1: Awin (PRIMARY when key is set) ──────────────
  if (awin.isEnabled()) {
    try {
      const results = await awin.search(q);
      results.forEach(item => admit(item, 'awin'));
      sourceStatus.awin = `ok:${results.length}`;
      console.log(`[${VERSION}] Awin: ${results.length} raw → ${rawItems.length} admitted`);
    } catch (err) {
      sourceStatus.awin = `error:${err.message}`;
      console.warn(`[${VERSION}] Awin failed: ${err.message}`);
    }
  } else {
    sourceStatus.awin = 'disabled:no_key';
  }

  // ── SOURCE 2: Serper (PRIMARY fallback when Awin absent/empty) ──
  const needsSerper = !awin.isEnabled() || rawItems.length === 0;
  if (needsSerper) {
    try {
      const data        = await fetchSerper(q, type);
      const before      = rawItems.length;
      const urlProvider = url =>
        url.includes('amazon') ? 'amazon' : url.includes('ebay') ? 'ebay' : 'other';

      for (const item of (data.shopping || [])) {
        if (!isValidProductUrl(item.link, urlProvider(item.link || ''))) continue;
        const ret = matchRetailer(item.link || item.source || '');
        admit({
          retailer: ret ? ret.name   : (item.source || 'Unknown'),
          domain:   ret ? ret.domain : '',
          aff:      ret ? ret.aff    : '',
          price:    item.price,
          link:     item.link || '',
          sub:      item.delivery || '',
        }, 'serper-shopping');
      }

      for (const item of (data.organic || [])) {
        if (!isValidProductUrl(item.link, urlProvider(item.link || ''))) continue;
        const ret = matchRetailer(item.link || '');
        if (!ret) continue;
        admit({
          retailer: ret.name,
          domain:   ret.domain,
          aff:      ret.aff,
          price:    extractPriceFromText(item.snippet || item.title || ''),
          link:     item.link || '',
          sub:      '',
        }, 'serper-organic');
      }

      sourceStatus.serper = `ok:+${rawItems.length - before}`;
      console.log(`[${VERSION}] Serper done. Total admitted: ${rawItems.length}`);
    } catch (err) {
      sourceStatus.serper = `error:${err.message}`;
      console.warn(`[${VERSION}] Serper failed: ${err.message}`);
    }
  } else {
    sourceStatus.serper = 'skipped:awin_active';
  }

  // ── SOURCE 3: Google CSE (FALLBACK, circuit-breaker protected) ──
  // Circuit breaker: if CSE has returned 429 or 403 recently, skip it
  // and go straight to Awin fallback (even if Awin is the primary).
  // This prevents burning through Awin's quota retrying a broken CSE.
  if (rawItems.length < 2) {
    if (cseCircuitTripped()) {
      sourceStatus.googleCse = 'skipped:circuit_open';
      console.warn(`[${VERSION}] CSE circuit open — skipping`);

      // Circuit is open: if Awin is configured and we haven't tried it
      // as a fallback yet, try it now as the CSE replacement.
      if (awin.isEnabled() && rawItems.length === 0) {
        try {
          const results = await awin.search(q);
          results.forEach(item => admit(item, 'awin-circuit-fallback'));
          sourceStatus.awinFallback = `ok:${results.length}`;
          console.log(`[${VERSION}] Awin circuit-fallback: ${results.length} results`);
        } catch (err) {
          sourceStatus.awinFallback = `error:${err.message}`;
        }
      }
    } else {
      try {
        const data   = await fetchGoogleCSE(q);
        const before = rawItems.length;
        const urlP   = url =>
          url.includes('amazon') ? 'amazon' : url.includes('ebay') ? 'ebay' : 'other';

        for (const item of (data.items || [])) {
          if (!isValidProductUrl(item.link, urlP(item.link || ''))) continue;
          const ret = matchRetailer(item.link || '');
          if (!ret) continue;
          const text = [
            item.snippet, item.title,
            item.pagemap?.offer?.[0]?.price,
            item.pagemap?.product?.[0]?.price,
          ].filter(Boolean).join(' ');
          admit({
            retailer: ret.name,
            domain:   ret.domain,
            aff:      ret.aff,
            price:    extractPriceFromText(text),
            link:     item.link || '',
            sub:      '',
          }, 'google-cse');
        }

        sourceStatus.googleCse = `ok:+${rawItems.length - before}`;
      } catch (err) {
        // 429 or 403 — trip the circuit breaker
        if (err.message.includes('RATE_LIMITED') || err.message.includes('FORBIDDEN')) {
          tripCseCircuit();
          rateLimited = true;
          sourceStatus.googleCse = 'rate_limited:circuit_tripped';

          // Immediate fallback to Awin if available
          if (awin.isEnabled() && rawItems.length === 0) {
            try {
              const results = await awin.search(q);
              results.forEach(item => admit(item, 'awin-circuit-fallback'));
              sourceStatus.awinFallback = `ok:${results.length}`;
              console.log(`[${VERSION}] Awin circuit-fallback activated: ${results.length} results`);
            } catch (awinErr) {
              sourceStatus.awinFallback = `error:${awinErr.message}`;
            }
          }
        } else {
          sourceStatus.googleCse = `error:${err.message}`;
          console.warn(`[${VERSION}] CSE failed: ${err.message}`);
        }
      }
    }
  } else {
    sourceStatus.googleCse = 'skipped:enough_results';
  }

  // ── Deduplicate: lowest price per retailer ────────────────
  const byRetailer = {};
  for (const item of rawItems) {
    if (!byRetailer[item.retailer] || item.price < byRetailer[item.retailer].price) {
      byRetailer[item.retailer] = item;
    }
  }

  // Object.values returns a new array — not a reference to rawItems
  let deduped = Object.values(byRetailer);
  console.log(`[${VERSION}] After dedup: ${deduped.length} | ${deduped.map(i => i.retailer + ' £' + i.price).join(', ')}`);

  // ── Sanity filter (global, on final combined array) ───────
  deduped = sanityFilter(deduped, q);
  deduped.sort((a, b) => a.price - b.price);

  // ── Shape to frontend schema ──────────────────────────────
  // Price converted back to string AFTER filtering — no raw strings re-enter
  const shopping = deduped.map(item => ({
    title:    item.retailer,
    link:     item.link + (item.link.includes('amazon') && item.aff ? item.aff : ''),
    source:   item.domain,
    price:    '£' + item.price.toFixed(2),
    delivery: item.sub || '',
  }));

  console.log(
    `[${VERSION}] ── END: ${shopping.length} results` +
    ` | top: ${shopping[0] ? shopping[0].title + ' ' + shopping[0].price : 'none'}` +
    ` | sources: ${JSON.stringify(sourceStatus)} ──`
  );

  // All sources failed + rate limited = tell the frontend clearly
  if (rateLimited && shopping.length === 0) {
    return res.status(429).json({
      error:       'rate_limited',
      message:     'Service temporarily busy. Try again in a few minutes.',
      shopping:    [],
      organic:     [],
      rateLimited: true,
      debug:       { version: VERSION, sources: sourceStatus },
    });
  }

  return res.status(200).json({
    shopping,
    organic:     [],
    rateLimited: rateLimited && shopping.length > 0,
    debug: {
      version:    VERSION,
      sources:    sourceStatus,
      rawCount:   rawItems.length,
      finalCount: deduped.length,
      topResult:  deduped[0] ? `${deduped[0].retailer} £${deduped[0].price}` : 'none',
    },
  });
}

// ── Serper provider ───────────────────────────────────────────
async function fetchSerper(q, type) {
  const key = process.env.SERPER_KEY;
  if (!key) throw new Error('SERPER_KEY not set');
  const endpoint = type === 'search'
    ? 'https://google.serper.dev/search'
    : 'https://google.serper.dev/shopping';
  const r = await fetch(endpoint, {
    method:  'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ q, gl: 'uk', hl: 'en', num: 10 }),
  });
  if (!r.ok) throw new Error(`Serper HTTP ${r.status}`);
  return r.json();
}

// ── Google CSE provider ───────────────────────────────────────
// Throws 'RATE_LIMITED' on 429 or quota-exhausted 400.
// Throws 'FORBIDDEN' on 403.
// Both trigger the circuit breaker in the handler above.
async function fetchGoogleCSE(q) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx  = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) throw new Error('GOOGLE_CSE_KEY or GOOGLE_CSE_CX not set');

  const params = new URLSearchParams({ key, cx, q, gl: 'uk', hl: 'en', num: '10' });
  const r = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);

  if (r.status === 429) throw new Error('RATE_LIMITED');
  if (r.status === 403) throw new Error('FORBIDDEN');

  if (!r.ok) {
    let body = {};
    try { body = await r.json(); } catch {}
    const reason = body?.error?.errors?.[0]?.reason || '';
    if (reason === 'rateLimitExceeded' || reason === 'dailyLimitExceeded') {
      throw new Error('RATE_LIMITED');
    }
    throw new Error(`Google CSE HTTP ${r.status}`);
  }

  return r.json();
}
