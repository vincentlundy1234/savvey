// api/_shared.js — Savvey shared core v1.1 (Wave V.36 doc refresh)
//
// Single source of truth for retailer config, price bounds, and the helpers
// used by /api endpoints. The legacy v2 endpoints (ai-search.js, ai-wit.js,
// search.js, scrape.js) were removed during the v3.0 Smart Router pivot
// (3 May 2026); only normalize.js + health.js consume this module now.
//
// Imported via:  import { ... } from './_shared.js';
//
// Adding a retailer = ONE edit to UK_RETAILERS below. Adding a price floor
// or ceiling = ONE edit to the constants. The drift bug class this module
// was originally created to prevent (multiple endpoints with desynced
// retailer lists) is now structurally impossible — only one endpoint
// imports it.

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
  { host: 'apple.com',          name: 'Apple',         srcTerms: ['apple.com', 'apple uk', 'apple store'] },
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
  // DIY (added Wave 24)
  { host: 'diy.com',           name: 'B&Q',            srcTerms: ['b&q', 'diy.com', 'b and q'] },
  { host: 'wickes.co.uk',      name: 'Wickes',         srcTerms: ['wickes'] },
  { host: 'toolstation.com',   name: 'Toolstation',    srcTerms: ['toolstation'] },
  { host: 'homebase.co.uk',    name: 'Homebase',       srcTerms: ['homebase'] },
  // Wave 77 — Home + kitchen retailers Vincent flagged. Lakeland is huge
  // for kitchen gadgets / small appliances; Dunelm carries vacuums,
  // bedding, kitchen, lighting — both fill genuine coverage gaps the
  // electronics-led list misses.
  { host: 'lakeland.co.uk',    name: 'Lakeland',       srcTerms: ['lakeland'] },
  { host: 'dunelm.com',        name: 'Dunelm',         srcTerms: ['dunelm'] },
  // Wave 84 — Furniture / home category coverage. IKEA dominates UK
  // furniture; Wayfair has the broadest mattress / bedding catalogue;
  // Habitat (now Argos-owned) covers mid-market home.
  { host: 'ikea.com',          name: 'IKEA',           srcTerms: ['ikea'] },
  { host: 'wayfair.co.uk',     name: 'Wayfair',        srcTerms: ['wayfair'] },
  { host: 'habitat.co.uk',     name: 'Habitat',        srcTerms: ['habitat'] },
  // Books / media (added Wave 24)
  { host: 'waterstones.com',   name: 'Waterstones',    srcTerms: ['waterstones'] },
  { host: 'whsmith.co.uk',     name: 'WHSmith',        srcTerms: ['whsmith', 'wh smith'] },
  { host: 'worldofbooks.com',  name: 'World of Books', srcTerms: ['world of books', 'worldofbooks'] },
  { host: 'blackwells.co.uk',  name: 'Blackwell\'s',   srcTerms: ['blackwell'] },
  // Beauty (added Wave 25)
  { host: 'superdrug.com',         name: 'Superdrug',         srcTerms: ['superdrug'] },
  { host: 'cultbeauty.co.uk',      name: 'Cult Beauty',       srcTerms: ['cult beauty', 'cultbeauty'] },
  { host: 'lookfantastic.com',     name: 'Lookfantastic',     srcTerms: ['lookfantastic', 'look fantastic'] },
  { host: 'spacenk.com',           name: 'Space NK',          srcTerms: ['space nk', 'spacenk'] },
  { host: 'theperfumeshop.com',    name: 'The Perfume Shop',  srcTerms: ['perfume shop', 'theperfumeshop'] },
  { host: 'beautybay.com',         name: 'Beauty Bay',        srcTerms: ['beauty bay', 'beautybay'] },
  // Grocery — initial set (added Wave 25). Honest caveat: grocery prices
  // vary regionally + heavily by loyalty (Clubcard / Nectar). We surface
  // the public list price; loyalty discounts are explicitly skipped per the
  // Haiku prompt (Wave 21). Future: a "show member price too" toggle.
  { host: 'tesco.com',                  name: 'Tesco',         srcTerms: ['tesco'] },
  { host: 'sainsburys.co.uk',           name: 'Sainsbury\'s',  srcTerms: ['sainsbury'] },
  { host: 'asda.com',                   name: 'Asda',          srcTerms: ['asda'] },
  { host: 'groceries.asda.com',         name: 'Asda',          srcTerms: ['asda'] },
  { host: 'morrisons.com',              name: 'Morrisons',     srcTerms: ['morrisons'] },
  { host: 'groceries.morrisons.com',    name: 'Morrisons',     srcTerms: ['morrisons'] },
  { host: 'waitrose.com',               name: 'Waitrose',      srcTerms: ['waitrose'] },
  // Wave 39 — discount + variety stores Vincent specifically called out.
  // Home Bargains rotates stock fast and stocks niche items often missing
  // from major retailers. Lidl Plus + middle aisle = real price wins.
  { host: 'homebargains.co.uk',         name: 'Home Bargains', srcTerms: ['home bargains', 'homebargains'] },
  { host: 'lidl.co.uk',                 name: 'Lidl',          srcTerms: ['lidl'] },
  { host: 'aldi.co.uk',                 name: 'Aldi',          srcTerms: ['aldi'] },
  { host: 'theworks.co.uk',             name: 'The Works',     srcTerms: ['the works', 'theworks'] },
  { host: 'wilko.com',                  name: 'Wilko',         srcTerms: ['wilko'] },
  { host: 'poundland.co.uk',            name: 'Poundland',     srcTerms: ['poundland'] },
  // Wave 99 — kitchen / homeware specialists. Lakeland/Dunelm already
  // registered above (Wave 77/84). Adding Robert Dyas + Amara to round out
  // the kitchen lock so kettles/casseroles/saucepans hit specialists.
  { host: 'robertdyas.co.uk',           name: 'Robert Dyas',   srcTerms: ['robert dyas', 'robertdyas'] },
  { host: 'amara.com',                  name: 'Amara',         srcTerms: ['amara'] },
  // Wave 99 — sports / fitness retailers. Trainers, sportswear, gym kit,
  // running shoes — these specialists undercut JL/Argos consistently.
  { host: 'jdsports.co.uk',             name: 'JD Sports',     srcTerms: ['jd sports', 'jdsports'] },
  { host: 'sportsdirect.com',           name: 'Sports Direct', srcTerms: ['sports direct', 'sportsdirect'] },
  { host: 'decathlon.co.uk',            name: 'Decathlon',     srcTerms: ['decathlon'] },
  { host: 'wiggle.co.uk',               name: 'Wiggle',        srcTerms: ['wiggle'] },
  { host: 'sportsshoes.com',            name: 'SportsShoes',   srcTerms: ['sportsshoes', 'sports shoes'] },
  { host: 'mandmdirect.com',            name: 'M and M Direct',srcTerms: ['m and m direct', 'mandmdirect'] },
  { host: 'pro-direct.com',             name: 'Pro:Direct',    srcTerms: ['pro:direct', 'pro-direct', 'prodirect'] },
  // Wave 99 — fashion / apparel specialists.
  { host: 'asos.com',                   name: 'ASOS',          srcTerms: ['asos'] },
  { host: 'next.co.uk',                 name: 'Next',          srcTerms: ['next.co.uk', 'next '] },
  { host: 'marksandspencer.com',        name: 'M&S',           srcTerms: ['m&s', 'marks and spencer', 'marks & spencer', 'marksandspencer'] },
  { host: 'endclothing.com',            name: 'End.',          srcTerms: ['end clothing', 'endclothing', 'end.'] },
  { host: 'zalando.co.uk',              name: 'Zalando',       srcTerms: ['zalando'] },
  { host: 'matchesfashion.com',         name: 'Matches',       srcTerms: ['matches fashion', 'matchesfashion'] },
  // Wave 99 — books / media additions
  { host: 'foyles.co.uk',               name: 'Foyles',        srcTerms: ['foyles'] },
  { host: 'wordery.com',                name: 'Wordery',       srcTerms: ['wordery'] },
  // Wave 102 — luxury watch / jewellery retailers. Battery showed Rolex
  // Submariner / Tag Heuer Carrera return 0 because none of these are
  // stocked at JL/Argos/Currys.
  { host: 'watchesofswitzerland.co.uk', name: 'Watches of Switzerland', srcTerms: ['watches of switzerland', 'watchesofswitzerland'] },
  { host: 'goldsmiths.co.uk',           name: 'Goldsmiths',    srcTerms: ['goldsmiths'] },
  { host: 'mappinandwebb.co.uk',        name: 'Mappin & Webb', srcTerms: ['mappin', 'mappin and webb', 'mappin & webb'] },
  { host: 'ernestjones.co.uk',          name: 'Ernest Jones',  srcTerms: ['ernest jones', 'ernestjones'] },
  { host: 'hsamuel.co.uk',              name: 'H. Samuel',     srcTerms: ['h samuel', 'h. samuel', 'hsamuel'] },
  { host: 'beaverbrooks.co.uk',         name: 'Beaverbrooks',  srcTerms: ['beaverbrooks'] },
  // Wave 102 — toy retailers
  { host: 'smythstoys.com',             name: 'Smyths Toys',   srcTerms: ['smyths', 'smythstoys'] },
  { host: 'thetoyshop.com',             name: 'The Entertainer', srcTerms: ['the entertainer', 'thetoyshop'] },
  { host: 'hamleys.com',                name: 'Hamleys',       srcTerms: ['hamleys'] },
  // Wave 102 — addresses Selfridges/Harrods overlap in WATCH lock (selfridges already registered above)
  { host: 'harrods.com',                name: 'Harrods',       srcTerms: ['harrods'] },
  // Wave 103 — audio / hifi specialists (richersounds already registered above)
  { host: 'sevenoakssoundandvision.co.uk', name: 'Sevenoaks Sound & Vision', srcTerms: ['sevenoaks sound', 'sevenoakssound'] },
  { host: 'peterstyles.co.uk',          name: 'Peter Tyson',   srcTerms: ['peter tyson', 'peterstyles', 'petertyson'] },
  { host: 'henleyaudio.co.uk',          name: 'Henley Audio',  srcTerms: ['henley audio', 'henleyaudio'] },
  // Wave 103 — appliance specialists (ao.com, currys, jl, argos, marksandspencer all registered above)
  { host: 'directappliances.co.uk',     name: 'Direct Appliances', srcTerms: ['direct appliances', 'directappliances'] },
  { host: 'appliancesdirect.co.uk',     name: 'Appliances Direct', srcTerms: ['appliances direct', 'appliancesdirect'] },
  // Wave 103 — bike / cycling specialists
  { host: 'tredz.co.uk',                name: 'Tredz',         srcTerms: ['tredz'] },
  { host: 'evanscycles.com',            name: 'Evans Cycles',  srcTerms: ['evans cycles', 'evanscycles'] },
  { host: 'leisurelakesbikes.com',      name: 'Leisure Lakes Bikes', srcTerms: ['leisure lakes', 'leisurelakesbikes'] },
  { host: 'rutlandcycling.com',         name: 'Rutland Cycling', srcTerms: ['rutland cycling', 'rutlandcycling'] },
  // Wave 103 — pet specialists
  { host: 'petsathome.com',             name: 'Pets at Home',  srcTerms: ['pets at home', 'petsathome'] },
  { host: 'zooplus.co.uk',              name: 'Zooplus',       srcTerms: ['zooplus'] },
  { host: 'petplanet.co.uk',            name: 'PetPlanet',     srcTerms: ['petplanet'] },
  { host: 'jollyes.co.uk',              name: 'Jollyes',       srcTerms: ['jollyes'] },
  { host: 'fetch.co.uk',                name: 'Fetch',         srcTerms: ['fetch.co.uk'] },
  // Wave 103 — garden specialists
  { host: 'crocus.co.uk',               name: 'Crocus',        srcTerms: ['crocus'] },
  { host: 'thompson-morgan.com',        name: 'Thompson & Morgan', srcTerms: ['thompson morgan', 'thompson-morgan'] },
  { host: 'suttons.co.uk',              name: 'Suttons',       srcTerms: ['suttons'] },
  { host: 'gardenbuildingsdirect.co.uk', name: 'Garden Buildings Direct', srcTerms: ['garden buildings'] },
  { host: 'dobbies.com',                name: 'Dobbies',       srcTerms: ['dobbies'] },
  // Wave 103 — toy adjacency
  { host: 'verybaby.co.uk',             name: 'Very Baby',     srcTerms: ['very baby', 'verybaby'] },
];

// ─────────────────────────────────────────────────────────────
// Price bounds
// Hard ceiling £50,000 (covers Rolex/Patek/Audemars luxury watches,
// premium furniture, refurbished MacBook Pro Max, etc). Was £5,000
// pre-Wave 108 — that ceiling was rejecting every Rolex Submariner
// (~£9,500), Cartier Tank (~£3,000-£25,000), Patek Nautilus
// (~£25,000+). Haiku was returning the right prices; admitPrice was
// silently dropping them, so the WATCH lock looked broken.
// Floor £0.50 (anything below is noise / accessory).
// ─────────────────────────────────────────────────────────────
export const PRICE_CEILING_HARD = 50000;
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
