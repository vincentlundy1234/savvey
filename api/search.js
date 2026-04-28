const UK_RETAILERS = {
  'amazon.co.uk':     { name: 'Amazon UK',    aff: '?tag=savvey-21' },
  'currys.co.uk':     { name: 'Currys',        aff: '' },
  'johnlewis.com':    { name: 'John Lewis',   aff: '' },
  'argos.co.uk':      { name: 'Argos',         aff: '' },
  'ao.com':           { name: 'AO.com',        aff: '' },
  'very.co.uk':       { name: 'Very',          aff: '' },
  'richersounds.com': { name: 'Richer Sounds', aff: '' },
  'box.co.uk':        { name: 'Box.co.uk',     aff: '' },
  'halfords.com':     { name: 'Halfords',      aff: '' },
  'screwfix.com':     { name: 'Screwfix',      aff: '' },
  'toolstation.com':  { name: 'Toolstation',   aff: '' },
  'boots.com':        { name: 'Boots',         aff: '' },
  'costco.co.uk':     { name: 'Costco UK',     aff: '' },
  'dunelm.com':       { name: 'Dunelm',        aff: '' },
  'wayfair.co.uk':    { name: 'Wayfair UK',    aff: '' },
  'robertdyas.co.uk': { name: 'Robert Dyas',   aff: '' },
  'bq.co.uk':         { name: 'B&Q',           aff: '' },
  'tesco.com':        { name: 'Tesco',         aff: '' },
  'asda.com':         { name: 'Asda',          aff: '' },
  'ebay.co.uk':       { name: 'eBay UK',       aff: '' },
};

function matchRetailer(url) {
  if (!url) return null;
  for (const [domain, data] of Object.entries(UK_RETAILERS)) {
    if (url.includes(domain)) return { domain, ...data };
  }
  return null;
}

function extractPrice(str) {
  if (!str) return null;
  const m = String(str).match(/[£]?\s?([\d,]+(?:\.\d{1,2})?)/);
  if (m) { const v = parseFloat(m[1].replace(',', '')); if (v > 0) return v; }
  return null;
}

function isPlausiblePrice(price, allPrices) {
  if (!price || price < 1) return false;
  if (allPrices.length < 2) return true;
  const sorted = [...allPrices].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return price >= median * 0.2 && price <= median * 5;
}

async function fetchSerper(q) {
  const key = process.env.SERPER_KEY;
  if (!key) throw new Error('SERPER_KEY not set');
  const [shopRes, orgRes] = await Promise.allSettled([
    fetch('https://google.serper.dev/shopping', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: q + ' UK', gl: 'uk', hl: 'en', num: 10 }),
    }),
    fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: q + ' price UK buy', gl: 'uk', hl: 'en', num: 10 }),
    }),
  ]);
  const items = [];
  if (shopRes.status === 'fulfilled' && shopRes.value.ok) {
    const d = await shopRes.value.json();
    for (const item of (d.shopping || [])) {
      const price = extractPrice(item.price) || extractPrice(String(item.extracted_price || ''));
      const retailer = matchRetailer(item.link || item.source || '');
      if (price && price > 1 && retailer) {
        items.push({ retailer: retailer.name, domain: retailer.domain, aff: retailer.aff, price, link: item.link || '', sub: item.delivery || '' });
      }
    }
  }
  if (orgRes.status === 'fulfilled' && orgRes.value.ok) {
    const d = await orgRes.value.json();
    for (const item of (d.organic || [])) {
      const retailer = matchRetailer(item.link || '');
      if (!retailer) continue;
      const price = extractPrice(item.snippet || '') || extractPrice(item.title || '');
      if (price && price > 1) {
        items.push({ retailer: retailer.name, domain: retailer.domain, aff: retailer.aff, price, link: item.link || '', sub: '' });
      }
    }
  }
  return items;
}

async function fetchGoogleCSE(q) {
  const key = process.env.GOOGLE_CSE_KEY;
  const cx  = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) throw new Error('Google CSE not configured');
  const params = new URLSearchParams({ key, cx, q: q + ' price UK', gl: 'uk', hl: 'en', num: '10' });
  const r = await fetch('https://www.googleapis.com/customsearch/v1?' + params);
  if (!r.ok) throw new Error('Google CSE HTTP ' + r.status);
  const d = await r.json();
  const items = [];
  for (const item of (d.items || [])) {
    const retailer = matchRetailer(item.link || '');
    if (!retailer) continue;
    const priceStr = [
      item.pagemap && item.pagemap.offer && item.pagemap.offer[0] && item.pagemap.offer[0].price,
      item.pagemap && item.pagemap.product && item.pagemap.product[0] && item.pagemap.product[0].price,
      item.pagemap && item.pagemap.aggregateoffer && item.pagemap.aggregateoffer[0] && item.pagemap.aggregateoffer[0].lowprice,
      item.snippet,
      item.title,
    ].filter(Boolean).join(' ');
    const price = extractPrice(priceStr);
    if (price && price > 1) {
      items.push({ retailer: retailer.name, domain: retailer.domain, aff: retailer.aff, price, link: item.link || '', sub: '' });
    }
  }
  return items;
}

async function fetchEbay(q) {
  const appId  = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) throw new Error('eBay not configured');
  const tokenRes = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(appId + ':' + certId).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!tokenRes.ok) throw new Error('eBay token HTTP ' + tokenRes.status);
  const { access_token } = await tokenRes.json();
  const params = new URLSearchParams({ q, filter: 'conditionIds:{1000},buyingOptions:{FIXED_PRICE},deliveryCountry:GB', sort: 'price', limit: '10', marketplace_id: 'EBAY_GB' });
  const r = await fetch('https://api.ebay.com/buy/browse/v1/item_summary/search?' + params, {
    headers: { 'Authorization': 'Bearer ' + access_token, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_GB' },
  });
  if (!r.ok) throw new Error('eBay search HTTP ' + r.status);
  const d = await r.json();
  const items = [];
  for (const item of (d.itemSummaries || [])) {
    if (!item.price || item.price.currency !== 'GBP') continue;
    const price = parseFloat(item.price.value);
    if (price > 1) {
      items.push({ retailer: 'eBay UK', domain: 'ebay.co.uk', aff: '', price, link: item.itemWebUrl || '', sub: item.condition || 'New' });
    }
  }
  return items;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { q } = req.body || {};
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const [serperResult, googleResult, ebayResult] = await Promise.allSettled([
    fetchSerper(q),
    fetchGoogleCSE(q),
    fetchEbay(q),
  ]);

  const rawItems = [
    ...(serperResult.status === 'fulfilled' ? serperResult.value : []),
    ...(googleResult.status === 'fulfilled' ? googleResult.value : []),
    ...(ebayResult.status  === 'fulfilled' ? ebayResult.value  : []),
  ].filter(i => i.retailer && i.price > 1);

  const byRetailer = {};
  for (const item of rawItems) {
    if (!byRetailer[item.retailer] || item.price < byRetailer[item.retailer].price) {
      byRetailer[item.retailer] = item;
    }
  }

  let deduped = Object.values(byRetailer);
  const allPrices = deduped.map(i => i.price);
  deduped = deduped.filter(i => isPlausiblePrice(i.price, allPrices));
  deduped.sort((a, b) => a.price - b.price);

  const shopping = deduped.map(item => ({
    title:    item.retailer,
    link:     item.link + (item.link.includes('amazon') && item.aff ? item.aff : ''),
    source:   item.domain,
    price:    '£' + item.price.toFixed(2),
    delivery: item.sub || '',
  }));

  console.log('Savvey v3:', {
    q,
    serper: serperResult.status === 'fulfilled' ? serperResult.value.length + ' items' : String(serperResult.reason),
    google: googleResult.status === 'fulfilled' ? googleResult.value.length + ' items' : String(googleResult.reason),
    ebay:   ebayResult.status  === 'fulfilled' ? ebayResult.value.length  + ' items' : String(ebayResult.reason),
    raw: rawItems.length, final: deduped.length,
    top: deduped[0] ? deduped[0].retailer + ' £' + deduped[0].price : 'none',
  });

  return res.status(200).json({ shopping, organic: [], debug: { raw: rawItems.length, final: deduped.length } });
}
