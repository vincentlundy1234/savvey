// api/scrape.js — Savvey Direct Scrape Mode v1.0
// Receives a retailer product URL, fetches it server-side (no CORS issues),
// extracts product name + price, returns {product, price, retailer, url}
//
// Supported extractors: Amazon UK, Currys, Argos, John Lewis, AO, Very,
//   Halfords, Richer Sounds, Box.co.uk, Boots, eBay UK
//
// Falls back gracefully — if extraction fails, returns {error:'no_price'}
// Frontend then falls back to keyword search with the URL's domain as context.

const ORIGIN = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

// ── Retailer extractor registry ──
// Each extractor receives the raw HTML string and returns {product, price} or null.
const EXTRACTORS = [

  // ── Amazon UK ──
  {
    test: url => url.includes('amazon.co.uk'),
    name: 'Amazon UK',
    extract(html) {
      const product = firstMatch(html, [
        /<span id="productTitle"[^>]*>\s*([\s\S]*?)\s*<\/span>/,
        /<h1[^>]*id="title"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/,
      ]);
      const price = firstMatch(html, [
        /<span class="a-price-whole">(\d[\d,]*)<\/span>/,
        /<span class="a-offscreen">£([\d,.]+)<\/span>/,
        /\\"priceAmount\\":(\d+\.?\d*)/,
      ]);
      if (!product || !price) return null;
      return { product: clean(product), price: parsePrice(price) };
    },
  },

  // ── Currys ──
  {
    test: url => url.includes('currys.co.uk'),
    name: 'Currys',
    extract(html) {
      const product = firstMatch(html, [
        /<h1[^>]*class="[^"]*product[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
        /<title>([^|<]+)/,
      ]);
      const price = firstMatch(html, [
        /"price":\s*"?([\d.]+)"?/,
        /class="[^"]*pricingLockup[^"]*"[^>]*>[\s\S]*?£([\d,.]+)/,
        /data-price="([\d.]+)"/,
      ]);
      if (!product || !price) return null;
      return { product: clean(product), price: parsePrice(price) };
    },
  },

  // ── Argos ──
  {
    test: url => url.includes('argos.co.uk'),
    name: 'Argos',
    extract(html) {
      const product = firstMatch(html, [
        /"name":\s*"([^"]+)"/,
        /<h1[^>]*>([\s\S]*?)<\/h1>/,
      ]);
      const price = firstMatch(html, [
        /"price":\s*"?([\d.]+)"?/,
        /"offers":\s*\{[\s\S]*?"price":\s*"?([\d.]+)"?/,
      ]);
      if (!product || !price) return null;
      return { product: clean(product), price: parsePrice(price) };
    },
  },

  // ── John Lewis ──
  {
    test: url => url.includes('johnlewis.com'),
    name: 'John Lewis',
    extract(html) {
      const product = firstMatch(html, [
        /"name":\s*"([^"]+)"/,
        /<h1[^>]*>([\s\S]*?)<\/h1>/,
      ]);
      const price = firstMatch(html, [
        /"price":\s*"?([\d.]+)"?/,
        /"currentPrice":\s*\{[\s\S]*?"price":\s*([\d.]+)/,
      ]);
      if (!product || !price) return null;
      return { product: clean(product), price: parsePrice(price) };
    },
  },

  // ── AO.com ──
  {
    test: url => url.includes('ao.com'),
    name: 'AO.com',
    extract(html) {
      const product = firstMatch(html, [
        /"name":\s*"([^"]+)"/,
        /<h1[^>]*>([\s\S]*?)<\/h1>/,
      ]);
      const price = firstMatch(html, [
        /"price":\s*"?([\d.]+)"?/,
        /class="[^"]*product-price[^"]*"[^>]*>[\s\S]*?£([\d,.]+)/i,
      ]);
      if (!product || !price) return null;
      return { product: clean(product), price: parsePrice(price) };
    },
  },

  // ── Halfords ──
  {
    test: url => url.includes('halfords.com'),
    name: 'Halfords',
    extract(html) {
      const product = firstMatch(html, [
        /"name":\s*"([^"]+)"/,
        /<h1[^>]*>([\s\S]*?)<\/h1>/,
      ]);
      const price = firstMatch(html, [
        /"price":\s*"?([\d.]+)"?/,
        /class="[^"]*price[^"]*"[^>]*>[\s\S]*?£([\d,.]+)/i,
      ]);
      if (!product || !price) return null;
      return { product: clean(product), price: parsePrice(price) };
    },
  },

  // ── Very / Littlewoods ──
  {
    test: url => url.includes('very.co.uk') || url.includes('littlewoods.com'),
    name: 'Very',
    extract(html) {
      const product = firstMatch(html, [
        /"name":\s*"([^"]+)"/,
        /<h1[^>]*>([\s\S]*?)<\/h1>/,
      ]);
      const price = firstMatch(html, [
        /"price":\s*"?([\d.]+)"?/,
        /class="[^"]*product-price[^"]*"[^>]*>\s*£([\d,.]+)/i,
      ]);
      if (!product || !price) return null;
      return { product: clean(product), price: parsePrice(price) };
    },
  },

  // ── eBay UK ─ item pages only (/itm/) ──
  {
    test: url => url.includes('ebay.co.uk') && url.includes('/itm/'),
    name: 'eBay UK',
    extract(html) {
      const product = firstMatch(html, [
        /<h1 class="[^"]*it-ttl[^"]*"[^>]*>([\s\S]*?)<\/h1>/i,
        /"name":\s*"([^"]+)"/,
      ]);
      const price = firstMatch(html, [
        /<span[^>]*itemprop="price"[^>]*content="([\d.]+)"/,
        /"price":\s*"?([\d.]+)"?/,
      ]);
      if (!product || !price) return null;
      return { product: clean(product), price: parsePrice(price) };
    },
  },

  // ── Richer Sounds ──
  {
    test: url => url.includes('richersounds.com'),
    name: 'Richer Sounds',
    extract(html) {
      const product = firstMatch(html, [
        /"name":\s*"([^"]+)"/,
        /<h1[^>]*>([\s\S]*?)<\/h1>/,
      ]);
      const price = firstMatch(html, [
        /"price":\s*"?([\d.]+)"?/,
        /class="[^"]*product-price[^"]*"[^>]*>[\s\S]*?£([\d,.]+)/i,
      ]);
      if (!product || !price) return null;
      return { product: clean(product), price: parsePrice(price) };
    },
  },

  // ── Boots ──
  {
    test: url => url.includes('boots.com'),
    name: 'Boots',
    extract(html) {
      const product = firstMatch(html, [
        /"name":\s*"([^"]+)"/,
        /<h1[^>]*>([\s\S]*?)<\/h1>/,
      ]);
      const price = firstMatch(html, [
        /"price":\s*"?([\d.]+)"?/,
        /class="[^"]*product-price[^"]*"[^>]*>[\s\S]*?£([\d,.]+)/i,
      ]);
      if (!product || !price) return null;
      return { product: clean(product), price: parsePrice(price) };
    },
  },
];

// ── Helpers ──
function firstMatch(html, patterns) {
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  }
  return null;
}

function clean(str) {
  return str
    .replace(/<[^>]+>/g, '')          // strip any HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parsePrice(str) {
  if (!str) return null;
  const n = parseFloat(String(str).replace(/[^0-9.]/g, ''));
  return isNaN(n) || n <= 0 || n > 25000 ? null : Math.round(n * 100) / 100;
}

// ── Handler ──
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', ORIGIN);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });

  // Only allow known UK retailer domains — block arbitrary URL scraping
  const ALLOWED_DOMAINS = [
    'amazon.co.uk','currys.co.uk','argos.co.uk','johnlewis.com',
    'ao.com','very.co.uk','littlewoods.com','halfords.com',
    'richersounds.com','box.co.uk','boots.com','ebay.co.uk',
  ];
  const allowed = ALLOWED_DOMAINS.some(d => url.includes(d));
  if (!allowed) {
    return res.status(422).json({ error: 'unsupported_domain', message: 'Domain not in UK retailer allowlist' });
  }

  // Find extractor
  const extractor = EXTRACTORS.find(e => e.test(url));
  if (!extractor) return res.status(422).json({ error: 'no_extractor' });

  // Fetch the page server-side
  let html;
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Savvey/1.0; price-check bot; savvey.app)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    if (!r.ok) return res.status(502).json({ error: 'upstream_error', status: r.status });
    html = await r.text();
  } catch (err) {
    console.error('[scrape] fetch error', err.message);
    return res.status(504).json({ error: 'fetch_timeout' });
  }

  // Extract
  const result = extractor.extract(html);
  if (!result || !result.product || !result.price) {
    console.warn('[scrape] extraction failed for', url.slice(0, 80));
    return res.status(200).json({ error: 'no_price', retailer: extractor.name });
  }

  console.log(`[scrape v1.0] ${extractor.name} | "${result.product}" | £${result.price}`);
  return res.status(200).json({
    product: result.product,
    price: result.price,
    retailer: extractor.name,
    url,
  });
}
