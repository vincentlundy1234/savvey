// api/ai-search.js — Savvey AI Search v1.1
// Perplexity Sonar /search + Claude Haiku price extraction.
// v1.1 (2 May 2026): replaced regex price extraction with Haiku batched
//   structured extraction (kills monthly/bundle price misreads).

const VERSION = 'ai-search.js v1.1';
const ORIGIN  = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

const PERPLEXITY_TIMEOUT_MS = 8000;
const PERPLEXITY_ENDPOINT   = 'https://api.perplexity.ai/search';

const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
const HAIKU_MODEL        = 'claude-haiku-4-5-20251001';
const HAIKU_TIMEOUT_MS   = 5000;

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

function matchRetailer(url) {
  if (!url) return null;
  const u = String(url).toLowerCase();
  for (const r of UK_RETAILERS) {
    if (u.includes(r.host)) return r;
  }
  return null;
}

function rawResultsOf(data) {
  return (data && data.results) ||
         (data && data.search_results) ||
         (data && data.web_results) ||
         (data && data.data && data.data.results) ||
         [];
}

async function fetchPerplexitySearch(query, apiKey) {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(), PERPLEXITY_TIMEOUT_MS);
  const ukSites = UK_RETAILERS.map(r => `site:${r.host}`).join(' OR ');
  const augmentedQuery = `${query} buy UK price (${ukSites})`;
  try {
    const r = await fetch(PERPLEXITY_ENDPOINT, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: augmentedQuery, max_results: 10, max_tokens_per_page: 256 }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw Object.assign(new Error('Perplexity error'), { status: r.status, body: txt.slice(0, 200) });
    }
    return await r.json();
  } finally { clearTimeout(timer); }
}

function gatherRetailerHits(data, query) {
  const results = rawResultsOf(data);
  const hits = [];
  for (const r of results) {
    const url     = r.url || r.link || '';
    const title   = r.title || r.name || query;
    const snippet = r.snippet || r.content || r.description || r.text || '';
    const retailer = matchRetailer(url);
    if (!retailer) continue;
    hits.push({ url, title, snippet, retailer });
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

Below are search results from UK retailers. For each one, identify the actual CURRENT selling price of the product matching the user's query. Skip:
- Monthly finance prices (£X/month, £X per month)
- Bundle prices (with warranty / with extras)
- Accessory or kit prices (cases, cables, replacement parts)
- Strike-through "was £X" prices — pick the current price, not the old one
- Prices for unrelated/wrong-model products in the snippet

Return ONLY a JSON array, one entry per result: {"index": N, "price": number_or_null, "plausible": boolean}
- price = the actual current £ price as a plain number (e.g. 229.99), null if you can't tell
- plausible = true if this is genuinely the product the user searched for at a reasonable retail price; false if accessory, mis-listing, or wildly off-market

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
      console.error(`[${VERSION}] Haiku ${r.status}:`, txt.slice(0, 200));
      return hits.map((_, i) => ({ index: i, price: null, plausible: false }));
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
  } catch (e) {
    console.error(`[${VERSION}] Haiku price extraction error:`, e.message);
    return hits.map((_, i) => ({ index: i, price: null, plausible: false }));
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

export default async function handler(req, res) {
  console.log(`[${VERSION}] ${req.method} ${req.url}`);
  res.setHeader('Access-Control-Allow-Origin',  ORIGIN);
  res.setHeader('Vary',                          'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options',       'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const PERPLEXITY_KEY = process.env.PERPLEXITY_API_KEY;
  const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
  if (!PERPLEXITY_KEY) return res.status(503).json({ error: 'perplexity_not_configured' });
  if (!ANTHROPIC_KEY)  return res.status(503).json({ error: 'anthropic_not_configured', message: 'AI price extraction requires Anthropic key' });

  const { q, region = 'uk', debug = false } = req.body || {};
  if (!q) return res.status(400).json({ error: 'Missing query' });
  if (region !== 'uk') return res.status(400).json({ error: 'unsupported_region', message: `region "${region}" not yet supported` });

  let raw;
  try {
    raw = await fetchPerplexitySearch(q, PERPLEXITY_KEY);
  } catch (e) {
    console.error(`[${VERSION}] Perplexity failed:`, e.message, e.body || '');
    return res.status(502).json({ error: 'perplexity_error', message: e.message, status: e.status });
  }

  const hits      = gatherRetailerHits(raw, q);
  const priceData = await extractPricesViaHaiku(hits, q, ANTHROPIC_KEY);
  const items     = combineHitsWithPrices(hits, priceData);
  const results   = dedup(items);
  const cov       = computeCoverage(results);

  console.log(`[${VERSION}] "${q}" raw=${rawResultsOf(raw).length} hits=${hits.length} plausible=${items.length} final=${results.length} cheapest=£${results[0]?.price ?? 'n/a'}`);

  const debugEnvelope = debug ? {
    counts: { raw_results: rawResultsOf(raw).length, uk_hits: hits.length, ai_plausible: items.length, final: results.length },
    rawSample: rawResultsOf(raw).slice(0, 8).map(r => ({ url: r.url || r.link, title: (r.title || r.name || '').slice(0, 80) })),
    priceDataSample: priceData.slice(0, 8),
  } : undefined;

  return res.status(200).json({
    shopping: results.map(r => ({ source: r.source, price: `£${r.price.toFixed(2)}`, link: r.link, title: r.title, delivery: r.delivery })),
    organic: [],
    _meta: { version: VERSION, itemCount: results.length, cheapest: results[0]?.price ?? null, coverage: cov.coverage, onlyEbay: cov.onlyEbay, source: 'perplexity', region },
    _debug: debugEnvelope,
  });
}
