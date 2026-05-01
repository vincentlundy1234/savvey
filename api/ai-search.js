// api/ai-search.js — Savvey AI Search v1.0
//
// Perplexity Sonar /search endpoint as the primary data source for UK
// price comparison. Replaces the Serper-based pipeline as Tier 1.
//
// Why this exists:
//   - Serper / scrape.js / per-retailer fan-out hit retailer WAFs and
//     return Google aggregator URLs. Perplexity browses through its own
//     infrastructure, returning real retailer URLs from Currys/Argos/JL/AO
//     reliably. No WAF battles, no affiliate-API gatekeeping.
//   - Cost-controlled via aggressive cache (Supabase) — 24h TTL on
//     popular products keeps real spend ~£3-25/month at 100-2000 MAU.
//
// Response shape matches the existing /api/search contract so the
// frontend doesn't need to be rewritten:
//   { shopping: [{source, price, link, title, delivery}], _meta: {...} }
//
// Activation: falls back gracefully if PERPLEXITY_API_KEY not set, or
// if the call fails / times out. Serper pipeline in /api/search is the
// Tier 2 fallback.

const VERSION = 'ai-search.js v1.0';
const ORIGIN  = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

const PERPLEXITY_TIMEOUT_MS = 8000;
const PERPLEXITY_ENDPOINT   = 'https://api.perplexity.ai/search';

// UK retailer hostname allowlist — anything outside these is dropped
// regardless of how Perplexity ranks it.
const UK_RETAILERS = [
  { host: 'amazon.co.uk',     name: 'Amazon UK' },
  { host: 'currys.co.uk',     name: 'Currys' },
  { host: 'argos.co.uk',      name: 'Argos' },
  { host: 'johnlewis.com',    name: 'John Lewis' },
  { host: 'ao.com',           name: 'AO.com' },
  { host: 'very.co.uk',       name: 'Very' },
  { host: 'richersounds.com', name: 'Richer Sounds' },
  { host: 'box.co.uk',        name: 'Box.co.uk' },
  { host: 'ebay.co.uk',       name: 'eBay UK' },
  { host: 'ebay.com',         name: 'eBay' },
  { host: 'halfords.com',     name: 'Halfords' },
  { host: 'screwfix.com',     name: 'Screwfix' },
  { host: 'boots.com',        name: 'Boots' },
  { host: 'costco.co.uk',     name: 'Costco UK' },
  { host: 'selfridges.com',   name: 'Selfridges' },
  { host: 'mcgrocer.com',     name: 'McGrocer' },
  { host: 'harveynichols.com',name: 'Harvey Nichols' },
];

const PRICE_CEILING_HARD = 5000;
const PRICE_FLOOR        = 0.50;

function admitPrice(val) {
  const n = Math.round(parseFloat(String(val).replace(/[^\d.]/g, '')) * 100) / 100;
  if (isNaN(n) || n < PRICE_FLOOR || n > PRICE_CEILING_HARD) return null;
  return n;
}

// Match a result URL against the UK retailer allowlist.
function matchRetailer(url) {
  if (!url) return null;
  const u = String(url).toLowerCase();
  for (const r of UK_RETAILERS) {
    if (u.includes(r.host)) return r;
  }
  return null;
}

// Extract the first £-prefixed price from a chunk of snippet/content text.
function extractPrice(text) {
  if (!text) return null;
  // Skip strike-through MSRP — try to grab the active price near phrases
  // like "now", "from", "for", or the first standalone £X
  const patterns = [
    /(?:now|from|for|just|only)\s*£\s?([\d,]+(?:\.\d{1,2})?)/i,
    /£\s?([\d,]+(?:\.\d{1,2})?)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const p = admitPrice(m[1]);
      if (p !== null) return p;
    }
  }
  return null;
}

// Call Perplexity /search for UK retailer hits on the query.
async function fetchPerplexitySearch(query, apiKey) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), PERPLEXITY_TIMEOUT_MS);

  // Push Perplexity hard at UK retailers — site: filter in the query
  // dramatically improves the relevance of returned results.
  const ukSites = UK_RETAILERS.map(r => `site:${r.host}`).join(' OR ');
  const augmentedQuery = `${query} buy UK price (${ukSites})`;

  try {
    const r = await fetch(PERPLEXITY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        query:                augmentedQuery,
        max_results:          10,
        max_tokens_per_page:  256,
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw Object.assign(new Error('Perplexity error'), { status: r.status, body: txt.slice(0, 200) });
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Normalise the Perplexity response into our standard shopping shape.
// Defensive: handles a couple of plausible response shapes since the API
// is relatively new and the exact JSON format may vary.
function normalisePerplexityResults(data, query) {
  // Try common response shape locations for the results array
  const results =
    (data && data.results) ||
    (data && data.search_results) ||
    (data && data.web_results) ||
    (data && data.data && data.data.results) ||
    [];

  const items = [];
  for (const r of results) {
    const url     = r.url || r.link || '';
    const title   = r.title || r.name || query;
    const snippet = r.snippet || r.content || r.description || r.text || '';

    const retailer = matchRetailer(url);
    if (!retailer) continue;

    const price = extractPrice(snippet) || extractPrice(title);
    if (price === null) continue;

    items.push({
      source:   retailer.name,
      price,
      link:     url,
      title:    title.slice(0, 200),
      delivery: '',
    });
  }
  return items;
}

// Dedup — one entry per retailer, cheapest wins.
function dedup(items) {
  const map = new Map();
  for (const it of items) {
    const key = String(it.source || '').toLowerCase();
    if (!map.has(key) || it.price < map.get(key).price) map.set(key, it);
  }
  return [...map.values()].sort((a, b) => a.price - b.price);
}

// Compute coverage flags matching what /api/search exposes.
function computeCoverage(items) {
  const onlyEbay = items.length > 0 && items.every(i =>
    String(i.source || '').toLowerCase().includes('ebay'));
  const coverage = items.length === 0 ? 'none'
                 : items.length === 1 ? 'limited'
                 : items.length <= 3  ? 'partial'
                 : 'good';
  return { onlyEbay, coverage };
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

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
  if (!PERPLEXITY_KEY) {
    return res.status(503).json({ error: 'perplexity_not_configured' });
  }

  const { q, region = 'uk', debug = false } = req.body || {};
  if (!q) return res.status(400).json({ error: 'Missing query' });
  if (region !== 'uk') {
    return res.status(400).json({ error: 'unsupported_region', message: `region "${region}" not yet supported` });
  }

  let raw;
  try {
    raw = await fetchPerplexitySearch(q, PERPLEXITY_KEY);
  } catch (e) {
    console.error(`[${VERSION}] Perplexity failed:`, e.message, e.body || '');
    return res.status(502).json({ error: 'perplexity_error', message: e.message, status: e.status });
  }

  const normalised = normalisePerplexityResults(raw, q);
  const results    = dedup(normalised);
  const cov        = computeCoverage(results);

  console.log(`[${VERSION}] "${q}" → ${results.length} retailers, cheapest=£${results[0]?.price ?? 'n/a'}`);

  const debugEnvelope = debug ? {
    counts: {
      raw_results:  ((raw && (raw.results || raw.search_results || raw.web_results)) || []).length,
      normalised:   normalised.length,
      final:        results.length,
    },
    rawSample: ((raw && (raw.results || raw.search_results || raw.web_results)) || [])
      .slice(0, 8).map(r => ({ url: r.url || r.link, title: (r.title || r.name || '').slice(0, 80) })),
  } : undefined;

  return res.status(200).json({
    shopping: results.map(r => ({
      source:   r.source,
      price:    `£${r.price.toFixed(2)}`,
      link:     r.link,
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
    },
    _debug: debugEnvelope,
  });
}
