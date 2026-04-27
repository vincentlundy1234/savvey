/**
 * Savvey — /api/search.js
 * Multi-source price search proxy
 *
 * Sources (tried in parallel, merged):
 *   1. Serper Google Shopping  — best for mainstream electronics
 *   2. Google Custom Search    — free 100/day fallback, broad coverage
 *   3. eBay Browse API         — free structured data, broad UK stock
 *
 * Environment variables needed in Vercel:
 *   SERPER_KEY        — serper.dev API key
 *   GOOGLE_CSE_KEY    — Google Cloud API key (Custom Search JSON API)
 *   GOOGLE_CSE_CX     — Google Custom Search Engine ID
 *   EBAY_APP_ID       — eBay Developer App ID (Client ID)
 */

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { q, type = 'shopping' } = req.body || {};
  if (!q) return res.status(400).json({ error: 'Missing query' });

  // ── Run all sources in parallel, never let one failure block others ──
  const [serperResult, googleResult, ebayResult] = await Promise.allSettled([
    fetchSerper(q, type),
    fetchGoogleCSE(q),
    fetchEbay(q),
  ]);

  const shopping = [];
  const organic  = [];

  // Merge Serper results
  if (serperResult.status === 'fulfilled' && serperResult.value) {
    const d = serperResult.value;
    if (d.shopping) shopping.push(...d.shopping);
    if (d.organic)  organic.push(...d.organic);
  }

  // Merge Google CSE results — map to shopping/organic shape
  if (googleResult.status === 'fulfilled' && googleResult.value) {
    const items = googleResult.value.items || [];
    for (const item of items) {
      // Try to extract a price from the snippet or title
      const priceMatch = (item.snippet || item.title || '').match(/£\s?[\d,]+(?:\.\d{1,2})?/);
      if (priceMatch) {
        shopping.push({
          title:    item.title,
          link:     item.link,
          source:   item.displayLink,
          price:    priceMatch[0],
          snippet:  item.snippet,
        });
      } else {
        organic.push({
          title:   item.title,
          link:    item.link,
          snippet: item.snippet,
        });
      }
    }
  }

  // Merge eBay results — map to shopping shape
  if (ebayResult.status === 'fulfilled' && ebayResult.value) {
    const items = ebayResult.value.itemSummaries || [];
    for (const item of items) {
      if (!item.price) continue;
      const price = item.price;
      if (price.currency !== 'GBP') continue;
      shopping.push({
        title:       item.title,
        link:        item.itemWebUrl,
        source:      'ebay.co.uk',
        price:       '£' + parseFloat(price.value).toFixed(2),
        snippet:     item.condition || '',
        image:       item.image?.imageUrl || '',
        marketplace: true, // flag so front-end can filter if needed
      });
    }
  }

  // Log source health for debugging (visible in Vercel function logs)
  console.log('Search sources:', {
    query: q,
    serper:  serperResult.status === 'fulfilled' ? `ok (${(serperResult.value?.shopping||[]).length} shopping)` : `FAILED: ${serperResult.reason?.message}`,
    google:  googleResult.status === 'fulfilled' ? `ok (${(googleResult.value?.items||[]).length} items)` : `FAILED: ${googleResult.reason?.message}`,
    ebay:    ebayResult.status === 'fulfilled'   ? `ok (${(ebayResult.value?.itemSummaries||[]).length} items)` : `FAILED: ${ebayResult.reason?.message}`,
    merged:  `${shopping.length} shopping, ${organic.length} organic`,
  });

  return res.status(200).json({ shopping, organic, sources: {
    serper: serperResult.status,
    google: googleResult.status,
    ebay:   ebayResult.status,
  }});
}

// ─────────────────────────────────────────
// SOURCE 1 — Serper (Google Shopping)
// ─────────────────────────────────────────
async function fetchSerper(q, type) {
  const key = process.env.SERPER_KEY;
  if (!key) throw new Error('SERPER_KEY not set');

  const endpoint = type === 'search'
    ? 'https://google.serper.dev/search'
    : 'https://google.serper.dev/shopping';

  const r = await fetch(endpoint, {
    method:  'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ q: q + ' UK price', gl: 'uk', hl: 'en', num: 10 }),
  });

  if (!r.ok) throw new Error(`Serper HTTP ${r.status}`);
  return r.json();
}

// ─────────────────────────────────────────
// SOURCE 2 — Google Custom Search JSON API
// Free: 100 queries/day
// Setup: console.cloud.google.com → Custom Search API
//        cse.google.com → create engine → search the web → get CX id
// ─────────────────────────────────────────
async function fetchGoogleCSE(q) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx  = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) throw new Error('GOOGLE_CSE_KEY or GOOGLE_CSE_CX not set');

  const params = new URLSearchParams({
    key,
    cx,
    q:          q + ' price UK buy',
    gl:         'uk',
    hl:         'en',
    num:        '10',
    safe:       'active',
  });

  const r = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);
  if (!r.ok) throw new Error(`Google CSE HTTP ${r.status}`);
  return r.json();
}

// ─────────────────────────────────────────
// SOURCE 3 — eBay Browse API
// Free: generous rate limits for new apps
// Setup: developer.ebay.com → create app → get App ID (Client ID)
//        Use Production keys, not Sandbox
// ─────────────────────────────────────────
async function fetchEbay(q) {
  const appId = process.env.EBAY_APP_ID;
  if (!appId) throw new Error('EBAY_APP_ID not set');

  // Get an eBay OAuth token (client credentials flow — no user login needed)
  const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method:  'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(appId + ':' + process.env.EBAY_CERT_ID).toString('base64'),
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!tokenRes.ok) throw new Error(`eBay token HTTP ${tokenRes.status}`);
  const { access_token } = await tokenRes.json();

  // Search eBay UK for new items only (condition=NEW filters out used/refurb)
  const params = new URLSearchParams({
    q,
    filter:       'conditionIds:{1000},buyingOptions:{FIXED_PRICE},deliveryCountry:GB',
    sort:         'price',
    limit:        '10',
    marketplace_id: 'EBAY_GB',
  });

  const r = await fetch(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: {
      'Authorization':       `Bearer ${access_token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB',
      'Content-Type':        'application/json',
    },
  });

  if (!r.ok) throw new Error(`eBay search HTTP ${r.status}`);
  return r.json();
}
