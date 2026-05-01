// api/_shared.js — Savvey shared core v1.0
//
// Single source of truth for retailer config, price bounds, and the helpers
// used across ai-search.js, ai-wit.js, search.js, and scrape.js. Eliminates
// the "three retailer lists" drift bug class permanently.
//
// Imported into each endpoint via:  import { ... } from './_shared.js';
//
// Adding a retailer = ONE edit to UK_RETAILERS below. Adding a price floor
// or ceiling = ONE edit to the constants. No more hunting across four files.

// ─────────────────────────────────────────────────────────────
// Retailer config
//
// host:     hostname substring used for URL matching
// name:     display name shown to users
// srcTerms: lowercase substrings used when matching against Google
//           Shopping `source` strings (e.g. "eBay - sellerName" → eBay UK).
// ─────────────────────────────────────────────────────────────
export const UK_RETAILERS = [
  { host: 'amazon.co.uk',      name: 'Amazon UK',      srcTerms: ['amazon'] },
  { host: 'currys.co.uk',      name: 'Currys',         srcTerms: ['currys'] },
  { host: 'argos.co.uk',       name: 'Argos',          srcTerms: ['argos'] },
  { host: 'johnlewis.com',     name: 'John Lewis',     srcTerms: ['john lewis', 'johnlewis'] },
  { host: 'ao.com',            name: 'AO.com',         srcTerms: ['ao.com'] },
  { host: 'very.co.uk',        name: 'Very',           srcTerms: ['very.co.uk', 'very '] },
  { host: 'richersounds.com',  name: 'Richer Sounds',  srcTerms: ['richer sounds', 'richersounds'] },
  { host: 'box.co.uk',         name: 'Box.co.uk',      srcTerms: ['box.co.uk', 'box.com'] },
  { host: 'ebay.co.uk',        name: 'eBay UK',        srcTerms: ['ebay'] },
  { host: 'ebay.com',          name: 'eBay',           srcTerms: ['ebay'] },
  { host: 'halfords.com',      name: 'Halfords',       srcTerms: ['halfords'] },
  { host: 'screwfix.com',      name: 'Screwfix',       srcTerms: ['screwfix'] },
  { host: 'boots.com',         name: 'Boots',          srcTerms: ['boots'] },
  { host: 'costco.co.uk',      name: 'Costco UK',      srcTerms: ['costco'] },
  { host: 'selfridges.com',    name: 'Selfridges',     srcTerms: ['selfridges'] },
  { host: 'mcgrocer.com',      name: 'McGrocer',       srcTerms: ['mcgrocer'] },
  { host: 'harveynichols.com', name: 'Harvey Nichols', srcTerms: ['harvey nichols'] },
];

// ─────────────────────────────────────────────────────────────
// Price bounds
// Hard ceiling £5,000 (covers any UK consumer product).
// Floor £0.50 (anything below is noise / accessory).
// ─────────────────────────────────────────────────────────────
export const PRICE_CEILING_HARD = 5000;
export const PRICE_FLOOR        = 0.50;

export function admitPrice(val) {
  const n = Math.round(parseFloat(String(val).replace(/[^\d.]/g, '')) * 100) / 100;
  if (isNaN(n) || n < PRICE_FLOOR || n > PRICE_CEILING_HARD) return null;
  return n;
}

// Match a URL against the retailer host allowlist. Returns the retailer
// record or null. Used by every endpoint that ingests external URLs.
export function matchRetailerByHost(url) {
  if (!url) return null;
  const u = String(url).toLowerCase();
  for (const r of UK_RETAILERS) {
    if (u.includes(r.host)) return r;
  }
  return null;
}

// Match a free-text source string (e.g. "eBay - sellerName") against the
// retailer source-term list. Used when the URL is a Google aggregator
// and only the source field carries reliable retailer info.
export function matchRetailerBySource(source) {
  if (!source) return null;
  const s = String(source).toLowerCase();
  for (const r of UK_RETAILERS) {
    if ((r.srcTerms || []).some(t => s.includes(t))) return r;
  }
  return null;
}

// Try host match first (more reliable when URL is a real retailer URL),
// then fall back to source matching.
export function matchRetailer(urlOrSource) {
  return matchRetailerByHost(urlOrSource) || matchRetailerBySource(urlOrSource);
}

// Extract a clean hostname from a URL or Serper-style displayLink.
export function extractRetailerName(link, displayLink) {
  const raw = String(displayLink || link || '');
  if (!raw) return 'Unknown';
  const noProto = raw.replace(/^https?:\/\//i, '');
  const noWww   = noProto.replace(/^www\./i, '');
  const host    = noWww.split('/')[0];
  return host || 'Unknown';
}

// Standard CORS + security headers used by every endpoint.
export function applySecurityHeaders(res, allowedOrigin) {
  res.setHeader('Access-Control-Allow-Origin',  allowedOrigin);
  res.setHeader('Vary',                          'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options',       'nosniff');
  res.setHeader('Strict-Transport-Security',    'max-age=31536000; includeSubDomains');
}
