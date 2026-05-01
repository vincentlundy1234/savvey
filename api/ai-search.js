// api/ai-search.js — Savvey AI Search v1.2
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

const VERSION = 'ai-search.js v1.2';
const ORIGIN  = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';

const PERPLEXITY_TIMEOUT_MS = 8000;
const PERPLEXITY_ENDPOINT   = 'https://api.perplexity.ai/search';
const ANTHROPIC_ENDPOINT    = 'https://api.anthropic.com/v1/messages';
const HAIKU_MODEL           = 'claude-haiku-4-5-20251001';
const HAIKU_TIMEOUT_MS      = 5000;
const HEAD_VERIFY_TIMEOUT_MS = 1500;

const RATE_LIMIT_PER_HOUR = 30;

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
    const retailer = matchRetailerByHost(url);
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

// HEAD-check every URL in parallel. Drop any that 4xx/5xx or time out.
// Eliminates dead-link Buy buttons (audit issue H4).
async function verifyUrls(items) {
  if (!items || items.length === 0) return items;
  const checks = items.map(async (item) => {
    if (!item.link) return null;
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

  // URL HEAD verification — drop any link that's dead BEFORE the user sees it.
  // Optional via { verify: false } in request body for testing/debug paths.
  const beforeVerify = items.length;
  if (verify) items = await verifyUrls(items);
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
    rawSample: rawResultsOf(raw).slice(0, 8).map(r => ({ url: r.url || r.link, title: (r.title || r.name || '').slice(0, 80) })),
    priceDataSample: priceData.slice(0, 8),
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
      verified:          verify,
      verifiedDropped,
    },
    _debug: debugEnvelope,
  });
}
