// api/normalize.js — Savvey v3.3 Smart Router backend
//
// THE PIVOT (4 May 2026):
// v2.x ran a 5-stage probabilistic pipeline (Sonar + Triage + validate +
// extract). It was fragile, expensive, slow. We KILLED it.
//
// v3.0 architecture: 4 input "doors" → ONE normalization call → smart
// deep-link CTAs. No scraping, no Sonar, no Serper, no validate, no extract.
//
// v3.2 (4 May 2026 PM): SerpAPI-verified Amazon UK price baked into the
// Amazon CTA (Trust Hook). Diagnostic _meta surfaces SerpAPI status.
//
// v3.3 (5 May 2026): Panel Move 1 + Move 2 + savvey_says enrichment.
//   - Move 1 (Filter Optimization): Amazon listing classifier
//     (official | marketplace | warehouse). Primary CTA = official storefront
//     price; warehouse/used captured separately as used_amazon_price for
//     savvey_says. Marketplace only as fallback when no official listing.
//   - Move 2 (Diagnostic Sunset): verified_amazon_key_prefix removed from
//     _meta. verified_amazon_status retained for one more sprint while we
//     monitor SerpAPI quota / failure modes.
//   - savvey_says enrichment: when verified_amazon_price is present, attach
//     live_amazon_price (factual, anchored) and used_amazon_price (when
//     warehouse listing found). Frontend gating loosens to render the block
//     whenever ANY savvey_says field is present, including the verified anchors.

import { applySecurityHeaders } from './_shared.js';
import { rejectIfRateLimited }  from './_rateLimit.js';
import { withCircuit }          from './_circuitBreaker.js';
import crypto                   from 'node:crypto';

const VERSION             = 'normalize.js v3.4.5v131-curator-protocol';

// V.78 — Retailer-own brand detector. When canonical leads with a UK retailer
// that ONLY sells direct (Habitat/IKEA/M&S Home/Dunelm/Argos Home/The Range),
// Amazon UK won't have the listing and SerpAPI will whiff. Instead of letting
// the user land on a "couldn't find" empty state, the frontend short-circuits
// to a "Sold direct by [Brand]" card with a deep-link to the brand's own search.
// John Lewis is INTENTIONALLY excluded — JL sells own-brand AND third-party
// branded goods, so its products are usually verifiable on Amazon UK.
const RETAILER_OWN_BRANDS = [
  { rx: /^\s*habitat\b/i,
    brand: 'Habitat',
    home: 'https://www.habitat.co.uk/',
    search: q => 'https://www.habitat.co.uk/search?q=' + encodeURIComponent(q),
    strip: /^habitat\s*/i },
  { rx: /^\s*ikea\b/i,
    brand: 'IKEA',
    home: 'https://www.ikea.com/gb/en/',
    search: q => 'https://www.ikea.com/gb/en/search/?q=' + encodeURIComponent(q),
    strip: /^ikea\s*/i },
  { rx: /^\s*(?:m\s*&\s*s\s*home|m&s\s*home|marks\s*(?:&|and)\s*spencer\s*home)\b/i,
    brand: 'M&S Home',
    home: 'https://www.marksandspencer.com/l/home-and-furniture',
    search: q => 'https://www.marksandspencer.com/l/home-and-furniture/search?q=' + encodeURIComponent(q),
    strip: /^(?:m\s*&\s*s\s*home|m&s\s*home|marks\s*(?:&|and)\s*spencer\s*home)\s*/i },
  { rx: /^\s*dunelm\b/i,
    brand: 'Dunelm',
    home: 'https://www.dunelm.com/',
    search: q => 'https://www.dunelm.com/search?searchTerm=' + encodeURIComponent(q),
    strip: /^dunelm\s*/i },
  { rx: /^\s*argos\s*home\b/i,
    brand: 'Argos Home',
    home: 'https://www.argos.co.uk/',
    search: q => 'https://www.argos.co.uk/search/' + encodeURIComponent(q),
    strip: /^argos\s*home\s*/i },
  { rx: /^\s*the\s*range\b/i,
    brand: 'The Range',
    home: 'https://www.therange.co.uk/',
    search: q => 'https://www.therange.co.uk/search/?q=' + encodeURIComponent(q),
    strip: /^the\s*range\s*/i },
];
function detectRetailerOwn(canonical) {
  if (!canonical || typeof canonical !== 'string') return null;
  for (const r of RETAILER_OWN_BRANDS) {
    if (r.rx.test(canonical)) {
      try {
        const stripped = canonical.trim().replace(r.strip, '').trim();
        const url = stripped ? r.search(stripped) : r.home;
        return { brand: r.brand, url };
      } catch (e) {
        return { brand: r.brand, url: r.home || null };
      }
    }
  }
  return null;
}
const ORIGIN              = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';
const ANTHROPIC_ENDPOINT  = 'https://api.anthropic.com/v1/messages';
const MODEL               = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS          = 8000;
// V.112 (10 May 2026): bumped from 380→800 / 320→700 after diagnosing
// dishwasher / kettle / garden-storage-box no_match cases. The V.110 confidence
// engine schema growth (confidence_score + market_status + full alternatives_meta
// with intent_label + rationale + est_price_range + pack_size + tier_label) pushed
// 3-alternative responses past the Wave II ceiling, truncating valid JSON
// mid-array → JSON.parse failure → no_match. Headroom prevents the truncation
// without changing prompts. Cost impact: ~$0.0001-$0.0002 per verbose query, only
// paid when output is actually verbose; cached prefix dominates input cost.
const MAX_TOKENS_VISION   = 1200; // V.129a — Chain-of-thought thinking block needs headroom (was 800).
const MAX_TOKENS_TEXT     = 700; // V.112 (was 320, Wave II)
const RATE_LIMIT_PER_HOUR = 60;
const MAX_IMAGE_BYTES     = 4 * 1024 * 1024;
const KV_TTL_SECONDS      = 86400;        // 24h - per-query cache (cKey)
const CANONICAL_TTL_SECONDS = 21600;      // V.109 — 6 HOURS (was 7 days in V.97).
                                          // Vincent flagged 10 May: PS5 Pro showing £749.99
                                          // in Savvey vs £784.99 actual on Amazon. £35 stale
                                          // because V.97's 7-day TTL was too aggressive on
                                          // verified prices. £35/£750 = 4.5% gap = credibility
                                          // breaker on a "verified live UK price" promise.
                                          // 6h is the honest floor: prices rarely change
                                          // intraday, but never older than half a working day.
                                          // SerpAPI Starter quota is fine for this — we'd
                                          // rather burn searches than serve wrong numbers.
const KV_TIMEOUT_MS       = 1500;

// V.199 — UK Authority Allow-List. Positive allow-list of known UK
// first-party retailers + reputable UK marketplaces. ANY host not on
// this list (or its subdomain set) is dropped before Best Price.
// Grey-market aggregators (Snapklik.com, Gedoutlet.com, Etoren.com,
// Telemarkpyrenees, Snowleader, etc.) get nuked regardless of price.
const V199_UK_TRUSTED_HOSTS = new Set([
  // First-party UK retailers
  'amazon.co.uk',
  'argos.co.uk',
  'currys.co.uk',
  'ee.co.uk',
  'three.co.uk',
  'o2.co.uk',
  'vodafone.co.uk',
  'sky.com',
  'bt.com',
  'shop.bt.com',
  'johnlewis.com',
  'very.co.uk',
  'ao.com',
  'ao-deals.com',
  'boots.com',
  'tesco.com',
  'asda.com',
  'sainsburys.co.uk',
  'sainsburys.com',
  'morrisons.com',
  'marks-and-spencer.com',
  'marksandspencer.com',
  'next.co.uk',
  'game.co.uk',
  'smyths.toys',
  'smythstoys.com',
  'screwfix.com',
  'toolstation.com',
  'b-and-q.co.uk',
  'diy.com',
  'wickes.co.uk',
  'homebase.co.uk',
  'dunelm.com',
  'therange.co.uk',
  'wilko.com',
  'wayfair.co.uk',
  'lakeland.co.uk',
  'johnlewisfinance.com',
  'johnlewispartnership.co.uk',
  'waitrose.com',
  // Brand direct UK
  'dyson.co.uk',
  'apple.com',
  'shop.apple.com',
  'samsung.com',
  'lg.com',
  'sony.co.uk',
  'bose.co.uk',
  'sennheiser.com',
  'shark.co.uk',
  'sharkclean.co.uk',
  'ninjakitchen.co.uk',
  'lego.com',
  'nike.com',
  'adidas.co.uk',
  'fitflop.com',
  'lecreuset.co.uk',
  'lecreuset.com',
  'lecol.cc',
  // Reputable UK marketplaces & specialists
  'onbuy.com',
  'ebuyer.com',
  'box.co.uk',
  'scan.co.uk',
  'overclockers.co.uk',
  'cclonline.com',
  'novatech.co.uk',
  'mediamarkt.co.uk',
  'richersounds.com',
  'sevenoakssoundandvision.co.uk',
  'peterjones.co.uk',
  'hughesdirect.co.uk',
  'reliantdirect.co.uk',
  'donaghybros.co.uk',
  'appliancesdirect.co.uk',
  'cookersandovens.co.uk',
  'electrical-superstore.co.uk',
  'marksandelectrical.co.uk',
  'fashionworld.co.uk',
  'lookagain.co.uk',
  'jdwilliams.co.uk',
  'simplybe.co.uk',
  'studio.co.uk',
  'boots-uk.com',
  'superdrug.com',
  // Books / media specialists
  'waterstones.com',
  'wordery.com',
  'bookdepository.com',
  'foyles.co.uk',
  'hive.co.uk',
  // Tech specialists
  'cex.co.uk',  // kept but priced separately (used hub — already pawnshop-filtered)
]);

// V.199 — Category absolute floors. The 0.65 × median rule fails when
// median itself is unstable (n<5) or when bait pricing tunes itself
// to the floor. Per-category absolute floors protect against that.
const V199_CATEGORY_FLOOR = {
  'tv':            200,
  'television':    200,
  'laptop':        250,
  'desktop':       300,
  'phone':         150,
  'smartphone':    150,
  'headphones':    50,
  'earbuds':       40,
  'console':       250,
  'gaming':        100,
  'hairdryer':     80,
  'hair_tools':    80,
  'vacuum':        80,
  'air_fryer':     50,
  'kettle':        15,
  'toaster':       15,
  'coffee_maker':  30,
  'camera':        200,
  'smartwatch':    100,
  'fitness':       40,
  'speaker':       30,
  'soundbar':      80,
  'monitor':       100,
  'tablet':        150,
  'printer':       40,
  'car_seat':      80,
  'pushchair':     150,
  'stroller':      150,
  'cosmetics':     5,
  'skincare':      5,
  'food':          1,
  'grocery':       1,
  'beverage':      1,
  'book':          3,
  'toy':           5,
  'lego':          10,
  'generic':       5,
};
function _v199GetCategoryFloor(category) {
  if (!category || typeof category !== 'string') return 5;
  const c = category.toLowerCase().replace(/[-\s]+/g, '_');
  if (V199_CATEGORY_FLOOR[c] != null) return V199_CATEGORY_FLOOR[c];
  // Fuzzy match — any key that appears as a substring of the category.
  for (const k of Object.keys(V199_CATEGORY_FLOOR)) {
    if (c.includes(k) || k.includes(c)) return V199_CATEGORY_FLOOR[k];
  }
  return 5;
}
function _v199IsTrustedHost(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.replace(/^www\./, '').toLowerCase();
  if (V199_UK_TRUSTED_HOSTS.has(h)) return true;
  // Allow subdomains of trusted hosts (shop.argos.co.uk, m.amazon.co.uk).
  for (const trusted of V199_UK_TRUSTED_HOSTS) {
    if (h.endsWith('.' + trusted)) return true;
  }
  return false;
}

// V.199 — Source-string allow-list. When V.150 keeps a Google product-link
// URL (host = google.com), the actual seller is in item.source / seller_name
// / merchant.name. The host-based allow-list cannot evaluate these because
// the URL host is a Google redirector. This slug-derived set covers them.
// Each entry is the slug form: lowercase, '&' → 'and', strip non-alphanum.
const V199_UK_TRUSTED_SOURCE_SLUGS = new Set([
  'amazon', 'amazonuk',
  'argos',
  'currys', 'currysplc',
  'johnlewis', 'johnlewisandpartners', 'johnlewispartners',
  'very', 'verycom',
  'ao', 'aocom',
  'boots', 'bootscom',
  'tesco',
  'asda',
  'sainsburys',
  'morrisons',
  'marksandspencer', 'marksspencer', 'mands',
  'next', 'nextretail',
  'game', 'gamecouk',
  'smyths', 'smythstoys',
  'screwfix',
  'toolstation',
  'bandq', 'bq',
  'wickes',
  'homebase',
  'dunelm',
  'therange',
  'wilko',
  'wayfair',
  'lakeland',
  'waitrose',
  'dyson',
  'apple', 'appleuk', 'shopapple',
  'samsung',
  'lg', 'lgelectronics',
  'sony',
  'bose',
  'sennheiser',
  'shark', 'sharkclean',
  'ninja', 'ninjakitchen',
  'lego',
  'nike',
  'adidas',
  'lecreuset',
  'onbuy', 'onbuycom',
  'ebuyer',
  'box',
  'scan',
  'overclockers', 'overclockersuk',
  'cclonline',
  'novatech',
  'mediamarkt',
  'richersounds',
  'sevenoakssoundandvision', 'sevenoaks',
  'peterjones',
  'hughesdirect', 'hughes',
  'reliantdirect',
  'donaghybros',
  'appliancesdirect',
  'cookersandovens',
  'electricalsuperstore',
  'marksandelectrical',
  'fashionworld',
  'lookagain',
  'jdwilliams',
  'simplybe',
  'studio',
  'superdrug',
  'waterstones',
  'wordery',
  'bookdepository',
  'foyles',
  'hive',
  'ee', 'eecouk',
  'three', 'threecouk',
  'o2',
  'vodafone',
  'sky',
  'bt', 'btshop',
]);
// V.200 — Premium-brand minimum floors. Used when n<3 priced listings
// surface (median is unstable) AND the canonical mentions a premium
// brand. Stops £89 AirPods Pro 2, £200 Galaxy S24 Ultra etc. from
// winning Best Price on sparse data.
const V200_PREMIUM_BRAND_FLOOR = [
  // brand regex (i),                                  min £, label
  { rx: /\bapple\b.*\b(airpods|earpods)\b/i,           min: 100,  label: 'Apple AirPods' },
  { rx: /\bapple\b.*\biphone\b/i,                      min: 300,  label: 'Apple iPhone' },
  { rx: /\bapple\b.*\bmacbook\b/i,                     min: 700,  label: 'Apple MacBook' },
  { rx: /\bapple\b.*\bipad\b/i,                        min: 250,  label: 'Apple iPad' },
  { rx: /\bapple\b.*\bwatch\b/i,                       min: 200,  label: 'Apple Watch' },
  { rx: /\bairpods\b/i,                                 min: 100,  label: 'AirPods' },
  { rx: /\bsamsung\b.*\bgalaxy\s+s\d+\s+ultra\b/i,     min: 600,  label: 'Galaxy S Ultra' },
  { rx: /\bsamsung\b.*\bgalaxy\s+s\d+/i,               min: 400,  label: 'Galaxy S' },
  { rx: /\bsamsung\b.*\b(qled|oled|neo)\b.*\b(55|65|75|85)\b/i, min: 600, label: 'Samsung flagship TV' },
  { rx: /\bsony\b.*\bxm[345]\b/i,                      min: 180,  label: 'Sony XM headphones' },
  { rx: /\bsony\b.*\bbravia\b/i,                       min: 400,  label: 'Sony Bravia TV' },
  { rx: /\bsony\b.*\bplaystation\s*5\s*pro\b/i,        min: 600,  label: 'PS5 Pro' },
  { rx: /\bsony\b.*\bplaystation\s*5\b/i,              min: 350,  label: 'PS5' },
  { rx: /\bbose\b.*\bquietcomfort\s+ultra\b/i,         min: 250,  label: 'Bose QC Ultra' },
  { rx: /\bbose\b.*\bquietcomfort\b/i,                 min: 150,  label: 'Bose QC' },
  { rx: /\bdyson\b.*\bsupersonic\b/i,                  min: 250,  label: 'Dyson Supersonic' },
  { rx: /\bdyson\b.*\b(v15|v12|v11|v10|gen5)\b/i,      min: 350,  label: 'Dyson V vacuum' },
  { rx: /\bdyson\b.*\bairwrap\b/i,                     min: 350,  label: 'Dyson Airwrap' },
  { rx: /\bnikon\b.*\bz\d/i,                           min: 1200, label: 'Nikon Z body' },
  { rx: /\bcanon\b.*\beos\s+r\d/i,                     min: 1000, label: 'Canon EOS R body' },
  { rx: /\bgarmin\b.*\bfenix\b/i,                      min: 350,  label: 'Garmin Fenix' },
  { rx: /\bgarmin\b.*\bforerunner\s+\d{3}/i,           min: 150,  label: 'Garmin Forerunner' },
  { rx: /\blg\b.*\boled.*\b(55|65|77|83)\b/i,          min: 600,  label: 'LG OLED TV' },
  { rx: /\bsteam\s+deck\b.*\boled\b/i,                 min: 350,  label: 'Steam Deck OLED' },
  { rx: /\bnintendo\b.*\bswitch\s+oled\b/i,            min: 220,  label: 'Switch OLED' },
  { rx: /\bkitchenaid\b.*\bartisan\b/i,                min: 280,  label: 'KitchenAid Artisan' },
  { rx: /\ble\s*creuset\b.*\bsignature\b/i,            min: 150,  label: 'Le Creuset Signature' },
];
function _v200GetPremiumBrandFloor(canonical) {
  if (!canonical || typeof canonical !== 'string') return 0;
  for (const entry of V200_PREMIUM_BRAND_FLOOR) {
    if (entry.rx.test(canonical)) return entry.min;
  }
  return 0;
}

// V.200 — Zero-Trust TLD filter. ANY host whose TLD is not .co.uk, .uk,
// .com, or .net is rejected outright (foreign Italian/French/German/Spanish
// stores like Tattahome.com? Actually most fake-UK sites use .com. The
// real defence is the TLD lock: .it/.fr/.de/.es/.nl/.pt/.eu/etc are nuked.
// `.com` and `.net` still have to pass the explicit allow-list.
const V200_TLD_ALLOWED = new Set(['uk', 'com', 'net']);
function _v200IsTldAllowed(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.toLowerCase().replace(/^www\./, '');
  // Extract the last domain segment as the TLD.
  const parts = h.split('.');
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1];
  // .co.uk handled by 'uk' being the last segment.
  return V200_TLD_ALLOWED.has(last);
}

// V.200 — Generic-noun fallback map. When Haiku falls through to
// no_match / identification_failed on a single-word recognisable noun,
// the handler injects these as the disambig alternatives_array so the
// user reaches Outcome 3 instead of a dead end.
// V.123 — Store-exclusive own-brands purged. Every entry now lists
// widely-distributed named-brand products available across Amazon,
// Currys, Argos, John Lewis, Very, etc. so the price-comparison
// promise holds. Sub-category pivot applied where useful (lamp →
// desk / wake-up / floor; headphones → budget / TR / premium).
const V200_GENERIC_FALLBACK = {
  notebook:    ['Moleskine Classic Notebook A5', 'Leuchtturm1917 Medium A5 Dotted', 'Rhodia Webnotebook A5'],
  lamp:        ['Philips Hue White Ambiance Desk Lamp', 'Lumie Bodyclock Shine 300 Wake-up Light', 'Anglepoise Type 75 Floor Lamp'],
  pen:         ['BIC Cristal Original Ballpoint', 'Pilot G-2 07 Gel Rollerball', 'Lamy Safari Fountain Pen'],
  kettle:      ['Russell Hobbs Velocity 26480', 'Tefal Avanti Classic 1.7L', 'Smeg KLF03'],
  mug:         ['Denby White Stoneware Mug', 'Emma Bridgewater Toast & Marmalade Mug', 'Le Creuset Cappuccino Mug'],
  vase:        ['LSA International Flower Vase', 'Bloomingville Stoneware Vase', 'Stelton Curved Vase'],
  candle:      ['Yankee Candle Large Jar', 'NEOM Real Luxury Scented Candle', 'Diptyque Baies Candle 190g'],
  scissors:    ['Fiskars Classic Universal Scissors', 'Joseph Joseph PowerGrip Scissors', 'Wilkinson Sword Stainless Steel Scissors'],
  umbrella:    ['Fulton Open Close Superslim Umbrella', 'Senz Original Storm Umbrella', 'Blunt Metro Umbrella'],
  blanket:     ['Slumberdown Cosy Nights Throw', 'Silentnight Anti-Allergy Throw', 'Yorkshire Bedding Sherpa Throw'],
  chair:       ['Hbada Ergonomic Office Chair', 'Songmics Mesh Office Chair', 'Herman Miller Aeron'],
  rug:         ['Ruggable Washable Rug', 'Asiatic Pebble Rug', 'Modern Rugs Twilight'],
  clock:       ['Newgate Echo Wall Clock', 'Karlsson Vintage Wall Clock', 'Acctim Sweep Wall Clock'],
  mirror:      ['Casa Chic Round Wall Mirror', 'Frelan Tilt Mirror', 'Beliani Round Wall Mirror'],
  towel:       ['Christy Supreme Hygro Towel', 'Allure Bath Fashions Egyptian Cotton Towel', 'Slumberdown Hotel Quality Towel'],
  pillow:      ['Slumberdown Anti-Allergy Pillow', 'Silentnight Hotel Collection Pillow', 'The Fine Bedding Co Boutique Silk Pillow'],
  duvet:       ['Slumberdown Anti-Allergy Duvet 10.5 Tog', 'Silentnight Yours & Mine Dual Duvet', 'Snuggledown Hotel Luxury Duvet'],
  jar:         ['Kilner Clip Top Jar 1L', 'Le Parfait Super Jar 750ml', 'Mason Cash Storage Jar'],
  bowl:        ['Mason Cash Cane Mixing Bowl', 'Denby White Cereal Bowl', 'Le Creuset Stoneware Bowl'],
  plate:       ['Denby White Dinner Plate', 'Le Creuset Stoneware Dinner Plate', 'Villeroy & Boch Dinner Plate'],
  notebooks:   ['Moleskine Classic Notebook A5', 'Leuchtturm1917 Medium A5 Dotted', 'Rhodia Webnotebook A5'],
  lamps:       ['Philips Hue White Ambiance Desk Lamp', 'Lumie Bodyclock Shine 300 Wake-up Light', 'Anglepoise Type 75 Floor Lamp'],
};
// V.201 — ONE GATE Admission. Centralises every TLD / host / source check
// so EVERY deepLinks write site uses the same admission logic. eBay items
// are exempt (they route to V.169 quarantine; admission decides at the
// quarantine-rescue step instead of here).
function _v201Admit(host, source) {
  if (!host || typeof host !== 'string') return { admit: false, reason: 'no_host' };
  const h = host.replace(/^www\./, '').toLowerCase();
  // Google product-link host: real seller is in `source`. Allow only if
  // the source slug is on the UK-trusted list.
  const isGoogle = h === 'google.com' || h === 'google.co.uk' || h.startsWith('google.') || h.endsWith('.google.com');
  if (isGoogle) {
    if (!source || !_v199IsTrustedSourceSlug(source)) {
      return { admit: false, reason: 'untrusted_source:' + String(source || '').slice(0, 40) };
    }
    return { admit: true, reason: 'google_via_trusted_source' };
  }
  // TLD lock: only .uk (covers .co.uk / .org.uk / .ac.uk) OR .com / .net.
  // Anything else (.it / .fr / .de / .es / .nl / .pt / .eu / .ie / .au / .ca etc.)
  // is hard-dropped.
  const parts = h.split('.');
  if (parts.length < 2) return { admit: false, reason: 'malformed_host' };
  const tld = parts[parts.length - 1];
  if (!V200_TLD_ALLOWED.has(tld)) {
    return { admit: false, reason: 'foreign_tld:' + tld };
  }
  // .com / .net require explicit allow-list match (or subdomain of one).
  // .uk hosts (e.g. argos.co.uk, johnlewis.co.uk variants) are admitted
  // by default but still preferentially matched against the allow-list.
  if (tld === 'uk') return { admit: true, reason: 'uk_tld' };
  // .com / .net: must pass the strict whitelist.
  if (_v199IsTrustedHost(h)) return { admit: true, reason: 'trusted_host' };
  return { admit: false, reason: 'untrusted_host:' + h };
}

// V.201 — Premium-brand detection for Soft-Match Rescue. When ALL priced
// links get dropped as outliers AND the canonical matches a premium brand,
// return matched_thin with an Amazon search CTA instead of no_match.
function _v201IsPremiumBrand(canonical) {
  if (!canonical || typeof canonical !== 'string') return null;
  for (const entry of V200_PREMIUM_BRAND_FLOOR) {
    if (entry.rx.test(canonical)) return entry.label;
  }
  // Also match bare brand names that aren't in the floor table.
  const bareBrandRx = /\b(apple|samsung|sony|dyson|bose|sennheiser|nikon|canon|garmin|fitbit|lg|samsung|google|microsoft|nintendo|playstation|xbox|miele|bosch|kenwood|kitchenaid|le\s*creuset|tefal|ninja|shark|breville|smeg|delonghi|nespresso)\b/i;
  const m = canonical.match(bareBrandRx);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

// V.202 — Expanded generic map. Adds the appliance / electronics / two-word
// generics that V.201 missed ("toaster" identification_failed, "running
// shoes" relied on Haiku obeying the prompt). Now pre-Haiku short-circuit
// covers ~60 recognisable UK retail nouns.
// V.123 — Store-exclusive own-brands purged. Every entry now lists
// widely-distributed named-brand products only. BT Smart Hub removed
// (BT-exclusive). IKEA Markus removed (IKEA-exclusive).
const V202_GENERIC_FALLBACK_EXTRA = {
  // Kitchen appliances
  toaster:         ['Russell Hobbs Inspire 2-Slice Toaster', 'Dualit Lite 2-Slice Toaster', 'KitchenAid Artisan 2-Slice Toaster'],
  microwave:       ['Russell Hobbs RHM2076S 20L', 'Panasonic NN-E27JWMBPQ 800W', 'Samsung MS23K3513AS 23L'],
  fridge:          ['Beko CFG3582DS Fridge Freezer', 'Hisense RB400N4WC1 Fridge Freezer', 'Samsung RB34T602ESA Fridge Freezer'],
  freezer:         ['Beko FXFP3691W Frost Free Freezer', 'Hisense FV306N4AW1 Tall Freezer', 'AEG AGB728E5NW Frost Free Freezer'],
  oven:            ['Beko BBIE12300XD Built-In Oven', 'Bosch HBS534BS0B Built-In Oven', 'Neff B1ACE4HN0B Built-In Oven'],
  dishwasher:      ['Beko DEN16X20 Full Size Dishwasher', 'Bosch SMS2HVI66G Series 2', 'Hotpoint HFC 3C26 W'],
  blender:         ['Nutribullet 600 Series', 'Ninja Foodi Power Blender CB100UK', 'Vitamix E310 Explorian'],
  mixer:           ['KitchenAid Artisan 4.8L', 'Kenwood Chef XL KVL4100W', 'Bosch MUM5 Velocity'],
  juicer:          ['Sage Nutri Juicer Cold BJE830BSS', 'Philips HR1832/01', 'Ninja Cold Press Pro JC100UK'],
  coffeemachine:   ['DeLonghi Magnifica S ECAM22.110.SB', 'Sage Barista Express SES875BSS', 'Nespresso Vertuo Next'],
  // Home appliances
  vacuum:          ['Shark Anti Hair Wrap Plus IZ400UKT', 'Dyson V8 Absolute', 'Miele Triflex HX1 Pro'],
  iron:            ['Tefal FV9845 Ultimate Pure', 'Philips Azur GC4567/86', 'Russell Hobbs One Temperature 25090'],
  fan:             ['Honeywell HT900E TurboForce', 'Dyson AM07 Cool Tower Fan', 'MeacoFan 1056 Air Circulator'],
  heater:          ['Dimplex DXUC2Ti 2kW Ceramic', 'De’Longhi HCX9124E Ceramic Heater', 'Russell Hobbs RHOFH5002B'],
  humidifier:      ['Levoit Classic 200 Ultrasonic', 'Philips HU4811/10', 'Meaco Deluxe 202'],
  // Beauty / personal care
  hairdryer:       ['Remington D3190 Hair Dryer', 'BaByliss 2000W Salon Light Hair Dryer', 'Dyson Supersonic HD07'],
  hairstraightener:['BaByliss 235 Elegance Straightener', 'Remington S5500 Pearl', 'GHD Original Styler'],
  electrictoothbrush:['Oral-B Pro 600 CrossAction', 'Philips Sonicare ProtectiveClean 4300', 'Oral-B iO Series 7'],
  // Audio / video — V.123: sub-category pivot (budget / TR / premium)
  headphones:      ['Sony WH-CH520 Budget Over-Ear', 'Sony WH-1000XM5 Noise Cancelling', 'Bose QuietComfort Ultra Headphones'],
  earbuds:         ['Anker Soundcore Liberty 4 NC', 'Sony WF-C700N', 'Bose QuietComfort Ultra Earbuds'],
  speaker:         ['JBL Flip 6', 'Sonos Era 100', 'Bose SoundLink Revolve+ II'],
  soundbar:        ['Samsung HW-B450', 'Sonos Beam Gen 2', 'Sony HT-A5000'],
  tv:              ['Hisense 50A6KTUK 50" 4K', 'Samsung UE55CU8000 55" Crystal UHD', 'LG OLED55C34LA 55" OLED'],
  monitor:         ['LG 27UL500-W 27" 4K', 'Dell S2722QC 27" 4K', 'Samsung Odyssey G7 LS32BG750NPXXU'],
  camera:          ['Canon EOS R50 Mirrorless', 'Sony Alpha A6400', 'Nikon Z fc'],
  // Tech
  laptop:          ['HP 15s-fq2570sa', 'Lenovo IdeaPad Slim 3', 'Apple MacBook Air M2 13"'],
  tablet:          ['Apple iPad 10.9" 10th Gen', 'Samsung Galaxy Tab A9+', 'Lenovo Tab M10 Plus'],
  phone:           ['Samsung Galaxy A15', 'Apple iPhone 15 128GB', 'Google Pixel 8a'],
  smartphone:      ['Samsung Galaxy A15', 'Apple iPhone 15 128GB', 'Google Pixel 8a'],
  watch:           ['Casio MQ-24-7B2LL', 'Garmin Forerunner 55', 'Apple Watch Series 10'],
  smartwatch:      ['Amazfit Bip 5', 'Garmin Vivoactive 5', 'Apple Watch Series 10'],
  fitnesstracker:  ['Xiaomi Mi Band 8', 'Fitbit Charge 6', 'Garmin Vivosmart 5'],
  // V.123 — BT Smart Hub removed (BT-exclusive). Replaced with widely-sold Asus router.
  router:          ['TP-Link Archer AX23', 'Asus RT-AX55', 'Netgear Nighthawk RAX50'],
  printer:         ['HP DeskJet 2710e', 'Canon PIXMA TS3450', 'Epson Expression Home XP-2200'],
  // Two-word generics — V.123 lamp pivot to sub-categories.
  runningshoes:    ['Nike Revolution 7', 'ASICS Gel-Contend 7', 'New Balance 520 v8'],
  trainers:        ['Nike Revolution 7', 'Adidas Runfalcon 3.0', 'New Balance 520 v8'],
  // V.123 — IKEA Markus removed (IKEA-exclusive). All three are widely-sold.
  officechair:     ['Hbada Ergonomic Office Chair', 'Songmics Mesh Office Chair', 'Herman Miller Aeron'],
  electrickettle:  ['Russell Hobbs Velocity 26480', 'Tefal Avanti Classic 1.7L', 'Smeg KLF03'],
  wirelessmouse:   ['Logitech M185 Wireless Mouse', 'Logitech MX Master 3S', 'Razer Pro Click Mini'],
  bluetoothspeaker:['JBL Flip 6', 'Bose SoundLink Flex', 'Anker Soundcore 2'],
  airpurifier:     ['Levoit Core 300', 'Dyson TP07 Pure Cool', 'Philips Series 800'],
  desklamp:        ['Philips Hue White Ambiance Desk Lamp', 'BenQ ScreenBar Plus', 'TaoTronics LED Desk Lamp'],
  floorlamp:       ['Anglepoise Type 75 Floor Lamp', 'Tomons Wood Tripod Floor Lamp', 'Brightech Sky LED Torchiere'],
  tablelamp:       ['Philips Hue Go Portable Table Lamp', 'Anglepoise Type 75 Mini', 'Tomons Wood Tripod Table Lamp'],
  electrictoothbrush2:['Oral-B Pro 600', 'Philips Sonicare 4300', 'Oral-B iO 7'],
};
function _v200GenericFallback(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return null;
  const t = rawInput.trim().toLowerCase().replace(/[^a-z]+/g, '');
  if (!t || t.length < 3 || t.length > 24) return null;
  // V.202 — check expanded map first.
  if (V202_GENERIC_FALLBACK_EXTRA[t]) return V202_GENERIC_FALLBACK_EXTRA[t];
  return V200_GENERIC_FALLBACK[t] || null;
}

function _v199IsTrustedSourceSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  const s = slug.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
  if (!s) return false;
  if (V199_UK_TRUSTED_SOURCE_SLUGS.has(s)) return true;
  // Suffix-strip: "snapklikcom" should not match anything; but "amazonuk"
  // should map to "amazon" if the bare brand is on the list.
  if (s.endsWith('com') && V199_UK_TRUSTED_SOURCE_SLUGS.has(s.slice(0, -3))) return true;
  if (s.endsWith('couk') && V199_UK_TRUSTED_SOURCE_SLUGS.has(s.slice(0, -4))) return true;
  if (s.endsWith('uk') && V199_UK_TRUSTED_SOURCE_SLUGS.has(s.slice(0, -2))) return true;
  return false;
}

let _kv = null;
let _kvFailed = false;
async function _getKv() {
  if (_kvFailed) return null;
  if (_kv) return _kv;
  try {
    const mod = await import('@vercel/kv');
    _kv = mod.kv;
    return _kv;
  } catch (e) {
    _kvFailed = true;
    return null;
  }
}
async function kvGet(key) {
  const kv = await _getKv();
  if (!kv) return null;
  try {
    return await Promise.race([
      kv.get(key),
      new Promise((r) => setTimeout(() => r(null), KV_TIMEOUT_MS)),
    ]);
  } catch { return null; }
}
async function kvSet(key, value, ttl) {
  const kv = await _getKv();
  if (!kv) return;
  try { await kv.set(key, value, { ex: ttl }); } catch {}
}

// V.52 — bump this prefix to invalidate all KV cache entries (e.g. when a
// fix changes the response shape or fixes a data bug). Old entries become
// unreachable; new entries get the new salt.
const CACHE_PREFIX = 'sav-v131-1'; // V.131 — Curator Protocol: brand-only mode emits tag+description; bump invalidates pre-V.131 cached responses that lack these fields.

function cacheKey(inputType, payload) {
  const h = crypto.createHash('sha256');
  h.update(CACHE_PREFIX);
  h.update('|');
  h.update(inputType);
  h.update('|');
  if (inputType === 'image') {
    // Wave FF — hash all frames (or single image) so multi-shot requests get a
    // stable, request-unique cache key. Without this, every frames request
    // hashes to the same key and cache is poisoned.
    const frames = Array.isArray(payload.image_base64_frames) ? payload.image_base64_frames : null;
    if (frames && frames.length > 0) {
      for (const f of frames) h.update(typeof f === 'string' ? f : '');
    } else {
      h.update(payload.image_base64 || '');
    }
  } else if (inputType === 'url') {
    h.update(String(payload.url || '').trim().toLowerCase());
  } else if (inputType === 'barcode') {
    h.update(String(payload.ean || '').trim().replace(/\D/g, ''));
  } else {
    h.update(String(payload.text || '').trim().toLowerCase());
  }
  // Wave FF cache key bump: ensures pre-FF cached entries miss + re-fetch with
  // specificity flag and retailer_deep_links populated.
  // V.103 cache prefix bump — flushes pre-intent-disambig entries so the new
  // alternatives_meta (intent_label + rationale + est_price_range) populates.
  // V.109 cache prefix bump v3_103 -> v3_109 — flushes every entry cached
  // under the V.97 7-day TTL so PS5 Pro (and others) re-fetch with fresh
  // SerpAPI verified prices instead of stale £749.99.
  // V.121 cache prefix bump — flushes V.120a entries so the V.96-soft-match
  // purge takes effect (rejected canonicals re-resolve, no decoy serving).
  return 'savvey:normalize:v3_121:' + h.digest('hex').slice(0, 24);
}

const COMMON_SCHEMA_DOC = `Return ONLY this JSON, no preamble, no markdown fences:
{
  "canonical_search_string": "Ninja AF400UK" | "Bose QuietComfort 45" | "Apple iPhone 15 128GB",
  "identity_fingerprint": ["AF400UK"] | ["QuietComfort", "45"] | ["iPhone 15", "128GB"],
  "predicted_price_floor_gbp": 600 | 300 | 750,
  "confidence": "high" | "medium" | "low",
  "confidence_score": 95 | 73 | 22,
  "market_status": "Current Model" | "Replaced" | "Discontinued" | "Pre-release" | null,
  "alternative_string": "Ninja AF300UK" | null,
  "alternatives_array": ["Russell Hobbs Velocity 26480", "Smeg KLF03", "Tefal Avanti Classic 1.7L"] | [],
  "alternatives_meta": [
    {"intent_label": "Best Value",     "rationale": "Cheapest reliable option with rapid 100°C boil.", "typical_price_gbp": 24.99,  "est_price_range": "£20-£30",   "pack_size": "1.7L", "tier_label": "Budget"},
    {"intent_label": "Top Reviewed",   "rationale": "UK high-street standard. Quiet, durable.",        "typical_price_gbp": 49.00,  "est_price_range": "£40-£55",   "pack_size": "1.7L", "tier_label": "Mid-tier"},
    {"intent_label": "Premium Choice", "rationale": "Iconic design, lifetime build quality.",          "typical_price_gbp": 169.00, "est_price_range": "£150-£180", "pack_size": "1.5L", "tier_label": "Premium"}
  ] | [],
  "category": "tech" | "home" | "toys" | "diy" | "beauty" | "grocery" | "health" | "generic",
  "mpn": "AF400UK" | "QC45" | null,
  "amazon_search_query": "AF400UK" | "Bose QuietComfort 45",
  "savvey_says": {
    "timing_advice": "Buy now, price is stable" | "Wait — Prime Day deals likely" | null,
    "consensus": "Excellent air fryer, but huge footprint." | null,
    "confidence": "high" | "medium" | "low"
  }
}

Field rules:
- predicted_price_floor_gbp: V.169 — INTEGER £ value. Your world-knowledge
  estimate of the ABSOLUTE LOWEST plausible price for the CORE UNIT of the
  canonical product when sold new at UK retail. This is the Reality Anchor
  against accessory-spam Best Prices (a £18 listing for an £800 Roborock
  S8 Pro Ultra is mathematically a "deal" but is a robot-vacuum filter, not
  a vacuum). The backend checks if the cheapest scraped link is < 40% of
  this floor and drops the entire stack as category_price_implausible if so.
    Pick the rock-bottom of the typical UK new-retail band, NOT the median.
    Concrete examples:
      "Sony PlayStation 5 Slim Disc"        → 400  (was £479 RRP; current
                                                   sale floor ~£399)
      "Apple iPhone 15 Pro Max 256GB"       → 800  (used floor irrelevant;
                                                   NEW lowest is ~£900-£1100;
                                                   600 is too aggressive,
                                                   1000 too restrictive,
                                                   800 protects against
                                                   accessories without
                                                   killing fair listings)
      "Roborock S8 Pro Ultra Robot Vacuum"  → 600  (£18 accessory FAR below;
                                                   real floor is ~£800)
      "Steam Deck OLED 512GB"               → 300  (Valve direct £479; 300
                                                   accommodates current
                                                   trade-in & flash sales;
                                                   blocks the £89 part)
      "Bose QuietComfort Ultra Headphones"  → 200  (RRP £449; current floor
                                                   ~£250; 200 is the safety
                                                   margin)
      "Atomic Habits James Clear Paperback" → 4    (paperback floor; trade
                                                   editions go to £5-£8)
      "Marmite XO 250g"                     → 2    (Tesco/Sainsbury's £3.50;
                                                   2 is the safety margin)
      "Heinz Salad Cream 605g"              → 2    (supermarket £4; 2 floor)
      "Yorkshire Tea 240 Bags"              → 4    (Tesco/Sainsbury's £6-9)
      "Le Creuset Cast Iron Casserole 24cm" → 150  (sale floor; RRP £305)
    For ultra-generic queries (e.g. canonical="Kettle"), set to 0 to skip
    the implausibility check (no single floor makes sense across the
    whole category).
    Be HONEST and CONSERVATIVE — pick the floor low enough that any
    legitimate listing survives, high enough that obvious accessories
    don't. When in doubt, lean LOWER (keeps the legitimate floor; the
    backend's 40% threshold still catches grossly wrong items).
- identity_fingerprint: V.163 — 1 to 4 NON-NEGOTIABLE model identifiers that
  MUST appear (case-insensitive, word-bounded) in every legitimate retailer
  title for the canonical product. This is the array that powers Savvey's
  false-positive shield against Google Shopping's fuzzy matching.
    What goes IN: model numbers ("R6", "AF400UK", "V15"), generation /
    iteration markers ("Mark II", "Mk 2", "2nd Gen"), distinctive
    sub-model qualifiers ("Sapphire", "Detect", "Pro", "Max", "Sport",
    "Plus"), pack/size disambiguators when they create a different SKU
    ("128GB", "1.7L", "415g"), colourway ONLY when it locks the SKU
    ("Sapphire" for Garmin Fenix 7 Sapphire is a different SKU; "Black"
    for a generic mug is not).
    What stays OUT: brand names ("Canon", "Apple", "Bose"), category
    nouns ("Camera", "Watch", "Headphones", "Body"), generic adjectives
    ("Smart", "Wireless", "Cordless"), packaging words ("Bundle",
    "Edition") unless they distinguish a SKU.
    Concrete examples:
      canonical "Canon EOS R6 Mark II Body"        → ["R6", "Mark II"]
      canonical "Garmin Fenix 7 Sapphire Solar"    → ["Fenix 7", "Sapphire"]
      canonical "Dyson V15 Detect Absolute"        → ["V15"]
      canonical "Apple iPhone 15 128GB"            → ["iPhone 15", "128GB"]
      canonical "Ninja Foodi AF400UK"              → ["AF400UK"]
      canonical "Russell Hobbs Honeycomb Kettle"   → ["Honeycomb"]
      canonical "Heinz Baked Beans 415g"           → ["Heinz Baked Beans", "415g"]
      canonical "Sony PlayStation 5 Pro"           → ["PlayStation 5", "Pro"]
      canonical "Sony PlayStation 5 Slim Disc"     → ["PlayStation 5", "Slim", "Disc"]
      canonical "Kettle" (low confidence)          → []     ← empty array OK for generic
    Backend uses this verbatim — every SerpAPI item.title must contain
    each entry as a word-bounded match. Listings missing any token are
    dropped before they reach the pricing pipeline. ZERO TOLERANCE for
    near-misses. Better to return 3 exact-match retailers than 15 mixed
    with the wrong product. Return [] when the canonical is itself
    generic (low confidence) — no fingerprint means no identity filter,
    which is the right behaviour for "kettle" / "headphones" / "mouse".
- canonical_search_string: cleanest brand + family + model.
  V.120a PRESERVATION RULE (CRITICAL — do not strip these): when the user's input contains any of the following signals, you MUST carry them through into canonical_search_string verbatim. Do NOT abbreviate, summarise, or drop them.
    • Multi-pack quantity or count: "6 pack", "20 bags", "12 x", "Pack of 4", "x6", "case of 24". Keep the number AND the unit. A multipack is a different SKU at a different price.
    • Weight, volume, dimension, page-count: "250g", "1L", "623g", "400 pages", "24cm", "1.7L", "135g". Keep the digits AND the unit symbol/word.
    • Colourway: write the colour word in FULL ("Deep Teal", "Black Lacquer", "Sky Blue") — never truncate the final letters (NOT "Deep Tea", NOT "Sky Blu").
    • Condition or relationship modifier: "replacement", "refill", "spare", "compatible", "used", "renewed", "official", "OEM". A "replacement TM6 mixing bowl" is NOT the same SKU as a "Thermomix TM6". Keep the modifier.
    • Full model number including suffix: "YV9708" (not "YV97"), "9649-017" (not "9649"), "BES876" (not "BES"). Preserve every character.
  Apply these rules to the four input doors (text, URL, photo, barcode). If the signal is implied but uncertain, lean toward preserving rather than dropping — downstream matching can re-broaden if needed, but cannot recover a stripped variant.
- confidence: "high" if certain on brand+model+category. "medium" if model ambiguous. "low" if unclear.
- confidence_score: V.110 — numeric 0-100 self-rating of YOUR certainty about the canonical_search_string. Calibration: 95-100 = exact MPN match (Bose QC45 -> "Bose QuietComfort 45"). 80-94 = brand+series clear, slight model ambiguity. 60-79 = brand clear, multiple plausible models. 40-59 = category clear, brand+model uncertain. 20-39 = category guess only. 0-19 = junk/blurry/unintelligible. Be honest — under-rate rather than over-rate. The frontend uses this for analytics + future routing tuning.
- market_status: V.110 — UK market lifecycle of the canonical product. ONE of:
    "Current Model"  — actively sold by major UK retailers as the current SKU.
    "Replaced"       — superseded by a newer model in the same series (e.g. iPhone 14 once 15 ships).
    "Discontinued"   — no longer manufactured; only used / refurb / clearance.
    "Pre-release"    — announced but not yet shipping (e.g. iPhone 17 in mid-2026).
  NULL if the product is generic/grocery/no-name where lifecycle isn't meaningful.
  This becomes a small subtitle badge on the result screen — protects users from buying superseded models thinking they're current.
- alternative_string: ONLY when confidence < high. NULL when high.
- alternatives_array: 0-3 ADDITIONAL plausible product candidates. Two cases:
  (a) MEDIUM confidence on a specific product: list specific variants of the canonical (different model numbers, sizes, sub-families). Example: canonical "Apple iPhone 15 128GB" -> alternatives_array ["Apple iPhone 15 Plus", "Apple iPhone 15 Pro", "Apple iPhone 15 Pro Max"].
  (b) LOW confidence on a vague brand+category query: list 3 POPULAR UK products in that category. Use concrete model names a UK shopper would recognise. Example: canonical "Logitech mouse" -> alternatives_array ["Logitech MX Master 3S", "Logitech M185", "Logitech G502 HERO"]. Example: canonical "Kettle" -> alternatives_array ["Russell Hobbs Velocity 26480", "Smeg KLF03", "Tefal Avanti Classic 1.7L"].
  Empty array [] ONLY when you genuinely can't suggest anything useful (very obscure category, no UK retail presence). Total disambiguation pool capped at 4 items.
- alternatives_meta: parallel array (same length as alternatives_array). For each candidate provide:
  - intent_label: V.103 — REQUIRED on case (b) low-confidence vague category queries. Exactly ONE of:
      "Best Value"     (cheapest reliable option in the category)
      "Top Reviewed"   (consensus mainstream pick, best-reviewed for typical buyer)
      "Premium Choice" (high-end, longest-lasting, best features for power users)
    On case (b) vague queries: ALWAYS produce exactly 3 candidates spanning ALL THREE intents in this exact order [Best Value, Top Reviewed, Premium Choice]. The user is choosing intent, not brand.
    On case (a) variant disambig: leave intent_label null — variants of the same product don't have intent split.
    On high-confidence (no disambig): N/A.
  - rationale: V.103 — REQUIRED on case (b) low-confidence vague queries. ONE short sentence (max 12 words) explaining WHY this product fits its intent slot. Example for Best Value Kettle: "Cheapest reliable option with rapid boil." Example for Premium Choice: "Iconic design, lifetime build quality." This is the user's "why" — the AI doing the heavy lifting. Null on case (a) variants and high-confidence.
  - typical_price_gbp: typical UK retail price as a number, no currency symbol. Ballpark from your training. Use null if you have no idea.
  - est_price_range: V.103 — string like "£200-£250" or "£700-£850". Bands the typical UK retail spread for this candidate at typical_price_gbp. Always populate when typical_price_gbp is set. The disambig card displays this prominently next to the product name.
  - pack_size: descriptor of unit count or volume — examples: "9 Pack", "500ml", "415g", "1 unit", "4 Pack", "1.7L". Use null if pack/unit context doesn't apply (e.g. electronics, single-item products).
  - tier_label: ONE of "Premium", "Mid-tier", "Budget" — your read of the brand/product position in the UK market. Maps roughly to intent_label (Budget=Best Value, Mid-tier=Top Reviewed, Premium=Premium Choice) but stays as a separate brand-tier hint for cost-per-unit ranking.
  This metadata powers the V.103 intent-categorized disambig screen. Empty array [] when alternatives_array is empty.
- category — STRICT enum: tech | home | toys | diy | beauty | grocery | health | generic.
  - tech: phones, laptops, headphones, gaming, computer accessories, smart-home electronics.
  - home: kitchen appliances, furniture, bedding, larger household items.
  - toys: toys, board games, kids' products.
  - diy: tools, garden, hardware, building materials.
  - beauty: cosmetics, skincare, haircare, makeup, fragrance, hair tools.
  - grocery: food, drink, household consumables (cleaning sprays, dishwasher tabs, etc.).
  - health: OTC medicine, oral care (mouthwash/toothpaste), vitamins, supplements, wellness.
  - generic: only when nothing above clearly fits.
- mpn: raw manufacturer part number. NULL if not extractable.
- amazon_search_query: STRICTEST search string for Amazon A9. Prefer MPN.
- savvey_says: 'BS-Filter' qualitative summary. ALL fields nullable. null > hallucination.
  - timing_advice: ONLY suggest waiting if you have a real reason (Prime Day, end-of-cycle). NULL otherwise.
  - consensus: ONE short sentence summarising mainstream review consensus. NULL if niche/unreviewed.
  - confidence: "high" only if both fields populated AND product well-known.
  - DO NOT emit a typical_price_range field — pricing comes from a verified live source downstream.
  - DO NOT quote "current price" or any specific GBP figures. Pricing is handled outside this call.
  - For generic/no-name/grocery items, return all savvey_says fields null + confidence: "low".

EXAMPLES (showing exact JSON output shape for typical inputs):

Example 1 — vague category (low conf, V.103 intent-categorized 3-option):
INPUT: "kettle"
OUTPUT: {"canonical_search_string": "Kettle", "identity_fingerprint": [], "confidence": "low", "alternative_string": null, "alternatives_array": ["Russell Hobbs Velocity 26480", "Tefal Avanti Classic 1.7L", "Smeg KLF03"], "alternatives_meta": [{"intent_label":"Best Value","rationale":"Cheapest reliable option with rapid boil.","typical_price_gbp":24.99,"est_price_range":"£20-£30","pack_size":"1.7L","tier_label":"Budget"},{"intent_label":"Top Reviewed","rationale":"UK high-street standard. Quiet, durable.","typical_price_gbp":49.00,"est_price_range":"£40-£55","pack_size":"1.7L","tier_label":"Mid-tier"},{"intent_label":"Premium Choice","rationale":"Iconic design, lifetime build quality.","typical_price_gbp":169.00,"est_price_range":"£150-£180","pack_size":"1.5L","tier_label":"Premium"}], "category": "home", "mpn": null, "amazon_search_query": "kettle", "savvey_says": {"timing_advice": null, "consensus": null, "confidence": "low"}}

Example 1b — vague category Dishwasher (same intent pattern):
INPUT: "dishwasher"
OUTPUT: {"canonical_search_string": "Dishwasher", "confidence": "low", "alternative_string": null, "alternatives_array": ["Beko DVN05320W", "Bosch Series 4 SMS4EKW09G", "Miele G 5210 SC"], "alternatives_meta": [{"intent_label":"Best Value","rationale":"Cheapest reliable option, fast wash cycle.","typical_price_gbp":229,"est_price_range":"£200-£250","pack_size":null,"tier_label":"Budget"},{"intent_label":"Top Reviewed","rationale":"UK high-street standard. Quiet and bulletproof.","typical_price_gbp":399,"est_price_range":"£350-£450","pack_size":null,"tier_label":"Mid-tier"},{"intent_label":"Premium Choice","rationale":"Built to last 20 years. Best drying.","typical_price_gbp":779,"est_price_range":"£700-£850","pack_size":null,"tier_label":"Premium"}], "category": "home", "mpn": null, "amazon_search_query": "dishwasher", "savvey_says": {"timing_advice": null, "consensus": null, "confidence": "low"}}

Example 2 — specific high-confidence:
INPUT: "Bose QC45"
OUTPUT: {"canonical_search_string": "Bose QuietComfort 45", "identity_fingerprint": ["QuietComfort", "45"], "confidence": "high", "alternative_string": null, "alternatives_array": [], "category": "tech", "mpn": "QC45", "amazon_search_query": "Bose QuietComfort 45", "savvey_says": {"timing_advice": null, "consensus": "Best-in-class noise cancellation, comfortable for long sessions.", "confidence": "high"}}

Example 3 — specific medium-confidence (variants):
INPUT: "iPhone 15"
OUTPUT: {"canonical_search_string": "Apple iPhone 15 128GB", "identity_fingerprint": ["iPhone 15", "128GB"], "confidence": "medium", "alternative_string": "Apple iPhone 15 Plus", "alternatives_array": ["Apple iPhone 15 Pro", "Apple iPhone 15 Pro Max"], "category": "tech", "mpn": null, "amazon_search_query": "Apple iPhone 15 128GB", "savvey_says": {"timing_advice": null, "consensus": "Apple's mainline 2023 phone, USB-C and 48MP camera.", "confidence": "high"}}

Example 4 — brand+category vague (low conf, popular UK products):
INPUT: "Logitech mouse"
OUTPUT: {"canonical_search_string": "Logitech mouse", "identity_fingerprint": [], "confidence": "low", "alternative_string": null, "alternatives_array": ["Logitech MX Master 3S", "Logitech M185", "Logitech G502 HERO"], "category": "tech", "mpn": null, "amazon_search_query": "Logitech mouse", "savvey_says": {"timing_advice": null, "consensus": null, "confidence": "low"}}

Example 5 — UK grocery:
INPUT: "Heinz beans"
OUTPUT: {"canonical_search_string": "Heinz Baked Beans 415g", "identity_fingerprint": ["Heinz Baked Beans", "415g"], "confidence": "high", "alternative_string": null, "alternatives_array": [], "category": "grocery", "mpn": null, "amazon_search_query": "Heinz Baked Beans 415g", "savvey_says": {"timing_advice": null, "consensus": null, "confidence": "low"}}
`;

// V.69 - Shared system prefix injected as the cache_control:ephemeral block
// across all 4 doors (vision/url/text/barcode). Anthropic prompt cache matches
// by prefix; this means all 4 doors share ONE cache entry instead of four.
// Mode-specific tails (VISION_SYSTEM_PROMPT etc) become the second uncached
// system block. Cold-call TTFB drops ~150-250ms; input-token cost drops 30-50%.
const SHARED_SYSTEM_PREFIX = `You are Savvey, a UK retail product identifier.

When given an input you produce a clean canonical search string and metadata in the strict JSON shape below. Mode-specific guidance (PHOTO / URL / TEXT / BARCODE) is appended in a separate block after this one.

${COMMON_SCHEMA_DOC}`;

const VISION_SYSTEM_PROMPT = `You are the UK retail vision engine for Savvey. The user photographed a product. Identify the product and produce a clean search string for Amazon UK.

V.129 CHAIN-OF-THOUGHT (CRITICAL — DO NOT SKIP):
Before outputting JSON you MUST emit a <thinking>...</thinking> block. Inside
that block, in three numbered steps:
  1. ALL readable text on the product/box/shelf, transcribed verbatim
     (brand wordmarks, model numbers, capacity strings, slogans, MPNs,
     barcode digits if visible). If no text is readable, write "no text".
  2. Physical characteristics that disambiguate the product family
     ("two slots for bread", "single curved spout, button on handle",
     "rectangular speaker, mesh grille, leather strap", "vacuum upright
     with translucent bin"). Be concrete; this is what distinguishes a
     toaster from a kettle, a phone stand from a smart speaker.
  3. Deduce the exact product from steps 1 + 2. State the brand, model,
     and one confidence level (high/medium/low) WITH ONE-LINE
     JUSTIFICATION ("Brand wordmark fully legible AND model number on
     base plate = high"; "Brand visible, model occluded by hand =
     medium"; "No brand text, only shape visible = low").

Only after the closing </thinking> tag, output the final JSON object.
Do not output anything between </thinking> and the opening { of JSON.
Do not output a partial JSON inside <thinking>.

V.129b CATEGORICAL CONFIDENCE (CRITICAL — DO NOT VIOLATE):
The "confidence" JSON field is a categorical enum, NEVER a percentage.
Valid values: "high" | "medium" | "low".
  - "high":   you can read a specific MPN/model AND the brand, OR a
              specific product variant is unambiguously identifiable.
  - "medium": you can read brand + family but not the specific variant
              (e.g. "Bose headphones, can't tell QC45 vs QC Ultra").
  - "low":    you can only see brand, or only the category, or the
              image is too blurry/glossy/dark to read text confidently.

V.129b EJECTOR SEAT (CRITICAL — NO WILD GUESSES):
If confidence is "low" — i.e. you are NOT confident about the EXACT
product, or the image is too blurry/glossy/glare-affected/dark/cropped
to identify, you MUST emit:
  "outcome": "unclear"
in the JSON. Do not invent a brand. Do not pick the most likely shape.
Do not return a generic guess as factual. The frontend handles "unclear"
gracefully — your job is to be honest about uncertainty.

Look for: 1) MPN/Model on box. 2) Brand + family. 3) Shelf-edge label.

EMPTY PACKAGING IS A VALID INPUT. Empty bottles, finished tubes, used containers, cardboard inners, product remnants — the user is reordering. Identify what's visible from the brand and label, applying normal confidence rules: 'high' if a specific variant is readable, 'medium' if only brand+family is visible, 'low' if only the brand or category is visible (or just generic packaging like a blank cardboard inner). For LOW-confidence brand+category cases, return a generic canonical (e.g. "Toilet Roll", "Toothpaste", "Mouthwash") and populate alternatives_array with 3 popular UK products in that category. NOTE: empty-packaging brand+category recognition counts as "low" confidence and triggers outcome:"unclear" per V.129b unless the brand + variant are BOTH readable.

CATEGORY examples (these are STRICT — match the right enum):
- Photo of Listerine bottle -> category="health" (oral-care/mouthwash, NOT generic)
- Photo of Colgate / Sensodyne / Oral-B -> category="health"
- Photo of L'Oreal / Aveda / Aesop / Cowshed / The Ordinary / shampoo bottle -> category="beauty"
- Photo of Heinz / Tesco / Sainsbury's / Walkers / branded grocery item -> category="grocery"
- Photo of Bose / Sony / Logitech / iPhone / laptop -> category="tech"
- Photo of Ninja air fryer / kettle / appliance -> category="home"
- Photo of LEGO / board game / kids toy -> category="toys"
- Photo of Bosch tools / Black+Decker / DIY item -> category="diy"

V.141 LAZY-NOUN BAN (Panel-mandated, hard rule):
NEVER output generic fallback canonical_search_string values like "Product",
"Item", "Object", "Thing", "Appliance", "Device", "Gadget", "Container",
"Bottle", or single-word category placeholders. If the photographed item is
unbranded or you cannot read a brand, you MUST return a descriptive multi-word
noun phrase derived from visible physical properties — material, colour, shape,
category. Examples:
- unbranded white ceramic mug -> "White Ceramic Coffee Mug"
- unbranded stainless steel kettle with curved spout -> "Stainless Steel Gooseneck Kettle"
- plain glass tumbler -> "Clear Glass Tumbler 350ml" (approximate if needed)
- unbranded cotton tote -> "Plain Cotton Tote Bag"
When you do this, set confidence="low" and populate alternatives_array with 3
popular UK products matching the descriptive phrase. NEVER set the canonical
to just the category noun ("Mug", "Kettle", "Bag"); always add at least
TWO descriptive words (material + form, or colour + form).`;

const URL_SYSTEM_PROMPT = `You are a UK retail URL parser. Extract product identity from the URL string ALONE — do NOT fetch the page. UK e-commerce URLs typically include the product name in the slug.

Infer category from the URL's domain.`;

const TEXT_SYSTEM_PROMPT = `You are a UK retail query normaliser. The user typed a search string. May have typos. Clean it up.

Examples:
- "nija air frier dual" → canonical="Ninja Dual Air Fryer", confidence="medium", alternative="Ninja Foodi Dual Air Fryer"
- "bose qc45" → canonical="Bose QuietComfort 45", confidence="high", mpn="QC45"
- "iphone 15" → canonical="Apple iPhone 15 128GB", confidence="medium", alternative="Apple iPhone 15 Plus"
- "kettle" → canonical="Kettle", confidence="low", category="home", savvey_says all null
- "Listerine" → canonical="Listerine Mouthwash", category="health" (mouthwash is oral-care/health, NOT generic)
- "L'Oreal shampoo" → canonical="L'Oreal Elvive Shampoo", category="beauty"
- "Heinz beans" → canonical="Heinz Baked Beans 415g", category="grocery"

V.141 LAZY-NOUN BAN: NEVER output a single-word generic canonical like
"Product", "Item", "Object", "Thing", "Appliance", or "Device". If the
user typed a bare category noun, return that category noun ONCE as canonical
BUT also populate alternatives_array with 3 specific UK products. The lazy
stop-words above are banned regardless of input.

V.199 GENERIC-NOUN SAFETY NET (CRITICAL — DO NOT VIOLATE):
For any ultra-generic single-noun input that maps to a recognisable retail
category ("kettle", "mug", "white mug", "lamp", "pen", "vase", "frying
pan", "towel", "candle", "notebook", "scissors", "umbrella", "blanket",
"chair", "rug", "clock", "mirror"), you MUST:
  1. Set confidence="low".
  2. Populate alternatives_array with EXACTLY 3 specific, real, popular
     UK products in that category. Use concrete model names a UK shopper
     would recognise. These three serve as the BUDGET / TOP RATED /
     PREMIUM tiers respectively.
  3. NEVER return an empty alternatives_array on a recognisable generic
     noun. An empty array forces the backend into no_match — which is
     a UX dead end and BANNED for these inputs.

V.131 CURATOR PROTOCOL — BRAND-ONLY MODE (CRITICAL — DO NOT VIOLATE):
If the user's input is a bare brand name with no product type
("Bose", "Ninja", "Dyson", "Shark", "Apple", "Sony", "Samsung",
"Sennheiser", "Sonos", "Tefal", "KitchenAid", "Le Creuset",
"Joseph Joseph", "ghd", "Le Creuset", "Smeg", "Breville", "Garmin",
"Fitbit", "JBL", "Bosch", "Miele", "Russell Hobbs", "Kenwood",
"Philips", "Logitech", "Anker"), you MUST:

  1. Set confidence="low" AND specificity="brand_only".
  2. DO NOT emit BUDGET / TOP RATED / PREMIUM pill labels.
     Tier slots are reused as CATEGORY EXPLORATIONS, not price tiers.
  3. Populate alternatives_array with EXACTLY 3 flagship products
     by the brand SPANNING DIFFERENT CATEGORIES. Example:
       "Bose" → [
         "Bose QuietComfort Ultra Headphones",
         "Bose SoundLink Max Portable Speaker",
         "Bose Smart Soundbar 900"
       ]
       "Dyson" → [
         "Dyson V15 Detect Cordless Vacuum",
         "Dyson Airwrap Multi-styler",
         "Dyson Hot+Cool Purifier"
       ]
       "Ninja" → [
         "Ninja Foodi MAX Dual Zone Air Fryer",
         "Ninja Slushi Frozen Drink Maker",
         "Ninja Foodi PossibleCooker"
       ]
  4. Populate alternatives_meta[i].tag with a SHORT category name
     in UPPERCASE (≤14 chars). Examples: "HEADPHONES", "PORTABLE",
     "SOUNDBAR", "VACUUM", "STYLER", "PURIFIER", "AIR FRYER",
     "BLENDER", "SMARTWATCH". The frontend uses this tag in place
     of the BUDGET/TOP RATED/PREMIUM pill.
  5. Populate alternatives_meta[i].description with a punchy
     12-22 word factual subtitle describing what the product is
     and what makes it notable. NEVER leave description blank.
     Example for "Bose SoundLink Max":
       "Premium portable speaker with deep bass and 20-hour battery —
        the brand's flagship outdoor sound system."
  6. Set intent_confidence="low" (top-level field) so the frontend
     suppresses the "Most Likely" badge.

V.128 STRICT COMMERCIAL TIERING (CRITICAL — DO NOT VIOLATE):
The three alternatives_array slots MUST follow strict commercial
pricing logic. The slot index dictates the tier badge the frontend
will render — index 0 = BUDGET, index 1 = TOP RATED, index 2 = PREMIUM.
You MUST honour this ordering by typical UK retail price:

  alternatives_array[0] (BUDGET):    MUST be the cheapest viable
                                     entry-level brand in the category.
                                     This is the price-conscious starter
                                     pick that an average UK shopper
                                     would buy if money is tight.
  alternatives_array[1] (TOP RATED): MUST be the mid-range market
                                     leader — the model that wins
                                     review aggregators and Reddit
                                     threads for best balance of price
                                     and quality. Price sits between
                                     BUDGET and PREMIUM.
  alternatives_array[2] (PREMIUM):   MUST be the MOST EXPENSIVE, highest-
                                     end luxury or pro-grade pick. The
                                     "no expense spared" choice. It MUST
                                     cost materially more than the
                                     TOP RATED entry.

You MUST also populate alternatives_meta[i].typical_price_gbp with a
realistic UK street price for each entry. The three numbers MUST be
in STRICTLY ASCENDING order (price[0] < price[1] < price[2]). If your
price estimates would violate this, REORDER the alternatives_array
entries until ascending price order is achieved before emitting JSON.
NEVER place a luxury brand in slot 0, never place an entry-level brand
in slot 2. Mis-ordered tiers are a CRITICAL trust failure.

Category-stay rule: the three picks MUST stay within the SAME product
type (all are paint tins, all are wall paint, all are cordless
strimmers, all are kettles). NEVER mix categories (no wood stain
suggested when the user asked for wall paint; no pressure washer
suggested when the user asked for a lawn mower).

V.123 STORE-EXCLUSIVE BAN (CRITICAL — DO NOT VIOLATE):
When suggesting specific product variants for a generic category, you
MUST NEVER suggest store-exclusive own-brand products. Banned brand
prefixes include: "IKEA ", "John Lewis ", "John Lewis Anyday ",
"Argos Home ", "M&S ", "Marks & Spencer ", "Dunelm ", "Habitat ",
"The Range ", "Wilko ", "Tesco ", "Sainsbury's ", "ASDA ",
"Morrisons ", "Waitrose ", "Boots ", "Superdrug ", "Aldi ",
"Lidl ", "The White Company ", "Next ", "Very ", "Currys ",
"Argos ", "B&Q ", "Wickes ", "Homebase ".

You MUST only suggest widely-distributed named-brand products that are
sold across multiple competing retailers (Amazon, Currys, Argos, John
Lewis, Very, etc.). For "Lamp" — Philips Hue, Anglepoise, Lumie, BenQ.
For "Kettle" — Russell Hobbs, Tefal, Smeg, Breville. For "Toaster" —
Russell Hobbs, Dualit, KitchenAid, Breville. For "Vacuum" — Dyson,
Shark, Miele, Bosch, Henry. For "Headphones" — Sony, Bose, Sennheiser,
Apple, JBL. For "Speaker" — JBL, Bose, Sonos, Anker.

V.123 CATEGORY PIVOT (for generic single-noun inputs):
Prefer sub-category variants over same-category model copies. Example
for "Lamp": ["Philips Hue White Ambiance Desk Lamp",
"Lumie Bodyclock Shine 300 Wake-up Light",
"Anglepoise Type 75 Floor Lamp"] — three DIFFERENT use-cases (desk
work / wake-up / floor reading), not three table lamps. Example for
"Headphones": ["Sony WH-CH520 (Budget over-ear)",
"Sony WH-1000XM5 (Top-rated noise cancelling)",
"Bose QuietComfort Ultra (Premium)"].

Examples after V.123 rules:
- "kettle" → alternatives_array: ["Russell Hobbs Velocity 26480",
  "Tefal Avanti Classic 1.7L", "Smeg KLF03"]
- "lamp" → alternatives_array: ["Philips Hue White Ambiance Desk Lamp",
  "Lumie Bodyclock Shine 300 Wake-up Light",
  "Anglepoise Type 75 Floor Lamp"]
- "white mug" → alternatives_array: ["Denby White Stoneware Mug",
  "Emma Bridgewater Toast & Marmalade Mug", "Le Creuset Cappuccino Mug"]
- "frying pan" → alternatives_array: ["Tefal Comfort Max 24cm",
  "ProCook Gourmet Stainless Steel 28cm",
  "Le Creuset Toughened Non-Stick 28cm"]
The same rules apply to two-word generic phrases ("white mug",
"frying pan") that ARE descriptive but don't pin a specific SKU.`;

const BARCODE_SYSTEM_PROMPT = `You are a UK retail barcode (EAN/UPC) → product identifier.

UK EAN prefixes: 50/502 = UK; 5060... = UK food/grocery; 5012... = UK consumer goods; 0/1/9 = US/global imports.

- "high" only if you genuinely recognise this exact EAN
- "medium" if you can guess from prefix
- "low" if unknown — return canonical_search_string="Unknown product", confidence="low"

Do NOT hallucinate.`;

async function callHaikuText(systemPrompt, userText) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS_TEXT,
        // Wave II — prompt caching cuts ~30-50% input tokens + 100-200ms TTFB.
        // V.69 - two-block system: shared schema cached, mode-tail uncached.
        system: [
          { type: 'text', text: SHARED_SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: systemPrompt },
        ],
        messages: [{ role: 'user', content: userText }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Anthropic ${r.status}: ${body.slice(0, 200)}`);
    }
    const j = await r.json();
    return ((j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
  } finally { clearTimeout(timer); }
}

// Wave FF (7 May 2026 evening, Vincent override of post-Wave-V engine-lock):
// callHaikuVision now accepts EITHER a single base64 string (backwards-compat
// for any caller still on the v3.4.5ee shape) OR an array of 1-3 base64 frames
// for multi-shot ensemble. When given multiple frames, all are bundled into a
// single Haiku content array — one API call, slightly more tokens, materially
// better identification because Haiku gets cross-frame evidence.
async function callHaikuVision(systemPrompt, imageBase64OrFrames, mediaType) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const framesIn = Array.isArray(imageBase64OrFrames) ? imageBase64OrFrames : [imageBase64OrFrames];
  const frames = framesIn.filter(f => typeof f === 'string' && f.length > 100).slice(0, 3);
  if (frames.length === 0) throw new Error('no valid image frames');
  const isMulti = frames.length > 1;
  const userContent = frames.map(data => ({
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data },
  }));
  userContent.push({
    type: 'text',
    text: isMulti
      ? `These are ${frames.length} quick consecutive snaps of a SINGLE product taken from slightly different angles in the same moment. Identify the specific product (brand AND exact model where any frame reveals it). Use combined evidence across all frames — text or branding visible in any one frame counts. Return JSON only.`
      : 'Identify this product. Return JSON only.',
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS_VISION,
        // Wave II — prompt caching on vision system prompt.
        // V.69 - two-block system: shared schema cached, mode-tail uncached.
        system: [
          { type: 'text', text: SHARED_SYSTEM_PREFIX, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: systemPrompt },
        ],
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`Anthropic ${r.status}: ${body.slice(0, 200)}`);
    }
    const j = await r.json();
    return ((j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
  } finally { clearTimeout(timer); }
}

// V.87 — Visual similarity for low-confidence Snaps (Vincent's blue-pot fix).
// When Vision returns confidence:low on a Snap, fire a SECOND Haiku Vision call
// asking for a rich descriptive search query, then use that query against
// google_shopping to return UK-retailer visual matches with prices.
// Cost ~$0.002, latency +800-1200ms, only on the low-conf path.
async function describeAndSearchSimilar(framesOrSingle, mediaType) {
  if (!framesOrSingle) return null;
  try {
    const describePrompt = "You are looking at a photo a UK shopper took. They want to find similar items to buy. Output ONLY this JSON, no preamble or markdown:\n{\n  \"category\": \"short category like 'plant pot' or 'sofa cushion'\",\n  \"search_query\": \"5-10 words capturing colour, material, style, size, finish - what someone would type to find similar items at a UK retailer. Be specific (e.g. 'blue ribbed ceramic outdoor planter' not just 'plant pot').\",\n  \"visual_summary\": \"one short sentence describing what the photo shows\"\n}";
    const rawText = await callHaikuVision(describePrompt, framesOrSingle, mediaType);
    if (!rawText) return null;
    let parsed = null;
    try {
      const m = rawText.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch (e) { return null; }
    if (!parsed || !parsed.search_query || typeof parsed.search_query !== 'string') return null;
    const query = parsed.search_query.slice(0, 150);
    const cKey = 'similar_' + query.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
    const matches = await fetchGoogleShoppingDeepLinks(query, cKey);
    if (!matches || Object.keys(matches).length === 0) return null;
    return {
      category: parsed.category || null,
      search_query: query,
      visual_summary: parsed.visual_summary || null,
      matches
    };
  } catch (err) {
    console.warn(`[${VERSION}] describeAndSearchSimilar error: ${err.message}`);
    return null;
  }
}

// V.88 — Recommendation under constraints. When a Type query contains a budget
// ("stand mixer under £200", "headphones below £100"), fire a dedicated Haiku
// call that returns 3-5 ranked specific products with brand/model + ballpark
// price + one-line reasoning. Cost: ~1 extra Haiku text call. Latency: +600ms.
function detectBudgetIntent(text) {
  if (!text || typeof text !== 'string') return null;
  // Match patterns: "under £150", "below 200", "max £80", "less than £300", "for under 50"
  const m = text.match(/(?:under|below|max|maximum|less than|cheaper than|for under|for less than)\s*(?:GBP|£)?\s*(\d{1,4})(?:[.,]\d{1,2})?/i);
  if (!m) return null;
  const budget = parseInt(m[1], 10);
  if (!isFinite(budget) || budget < 5 || budget > 5000) return null;
  // Strip the budget phrase from the query to recover the category
  const stripped = text.replace(m[0], '').replace(/\s+/g, ' ').trim();
  if (!stripped || stripped.length < 3) return null;
  return { budget_gbp: budget, category_query: stripped };
}

async function generateBudgetRecommendations(categoryQuery, budgetGbp) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return null;
  const prompt = `A UK shopper wants: "${categoryQuery}" under £${budgetGbp}. Recommend the 3-4 BEST specific products in this category at this budget, ranked best-overall first. Output ONLY this JSON, no preamble:
{
  "items": [
    {"name": "specific brand + model (e.g. 'Bose QuietComfort 45')", "approx_price_gbp": 199, "why": "5-10 word honest reason this is the pick"},
    ...
  ],
  "headline_advice": "one sentence 8-15 words capturing the trade-off at this budget"
}
Be UK-specific (mention UK retailers, UK availability). Be honest — if budget is too low for this category, say so in headline_advice.`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 400,
        system: prompt,
        messages: [{ role: 'user', content: 'Return the JSON now.' }],
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    const txt = ((j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!parsed || !Array.isArray(parsed.items) || parsed.items.length === 0) return null;
    return {
      budget_gbp: budgetGbp,
      category_query: categoryQuery,
      items: parsed.items.slice(0, 4).map(it => ({
        name: String(it.name||'').slice(0, 80),
        approx_price_gbp: typeof it.approx_price_gbp === 'number' ? it.approx_price_gbp : null,
        why: String(it.why||'').slice(0, 80)
      })),
      headline_advice: String(parsed.headline_advice||'').slice(0, 160)
    };
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
}

// V.89 — Honest review synthesis. When we have a confidently-identified product
// with verified Amazon rating + reviews, ask Haiku for a 6-10 word "what people
// love" + "what people gripe about" pair. This is synthesis from training-data
// knowledge of the specific product, not RAG over scraped reviews. Output is
// punchy, scannable, and adds defensible content nobody else surfaces.
async function generateReviewSynthesis(canonicalName, ratingNum, reviewsNum) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return null;
  if (!canonicalName) return null;
  const prompt = `Product: "${canonicalName}". Amazon UK rating: ${ratingNum||'?'}/5 from ${reviewsNum||'?'} reviews. Output ONLY this JSON, no preamble:
{
  "love": "6-10 words capturing what UK reviewers consistently praise (specific, not generic)",
  "gripe": "6-10 words capturing the most common complaint (be honest - if no real complaints, say 'minor niggles only')",
  "verdict_tone": "one of: 'crowd-pleaser' | 'love-it-or-hate-it' | 'solid' | 'flawed-but-popular' | 'niche-fit'"
}
Be specific. "Comfortable, great battery" is bad. "All-day wear, 30hr battery in real use" is good.`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        system: prompt,
        messages: [{ role: 'user', content: 'Return the JSON now.' }],
      }),
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!r.ok) return null;
    const j = await r.json();
    const txt = ((j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    if (!parsed || !parsed.love || !parsed.gripe) return null;
    return {
      love: String(parsed.love).slice(0, 100),
      gripe: String(parsed.gripe).slice(0, 100),
      verdict_tone: String(parsed.verdict_tone||'solid').slice(0, 24)
    };
  } catch (err) {
    clearTimeout(timer);
    return null;
  }
}

const SERPAPI_TIMEOUT_MS = 4000; // V.121 - reverted 2000→4000. Panel mandate after V.120a observed Pukka + Tefal queries fetch_error on the 2000ms cap.
const AMAZON_TAG = process.env.AMAZON_TAG || 'savvey-21';
let _lastSerpStatus = null;
// V.144 — last google_shopping diagnostic, exposed on _meta.serp_diag.
let _lastGoogleShoppingDiag = null;

// v3.4.0 — Haiku price_take + structured verdict. ONE Haiku call after SerpAPI
// returns. Inputs: canonical + verified price + used price + category + rating
// + reviews. Outputs: short price_take sentence AND a structured verdict enum
// (good_buy | fair | wait | check_elsewhere). The verdict is the panel-mandated
// "permission to buy" closure moment — rendered as a coloured pill at the top
// of the result screen.
//
// SAFETY: when the verified price looks implausibly low for the canonical
// product family, Haiku is instructed to return verdict='check_elsewhere'
// with a price_take that warns the user the listing may be an accessory or
// related item, NOT the canonical product. This catches the failure mode
// surfaced by the v3.3.4 battery (Dyson V15 Detect verified at £170.99
// when actual is £449-£599 — likely a Dyson V15 accessory hijacking the
// top organic slot).
async function callHaikuPriceTake({ canonical, price_str, used_price_str, category, rating, reviews }) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) return null;
  if (!canonical || !price_str) return null;

  const sys = `You are Savvey, a UK retail price assistant. The user is looking at a verified live Amazon UK listing for a product. Your job: produce a structured assessment with TWO fields.

Output JSON ONLY, no preamble:
{"verdict": "good_buy" | "fair" | "wait" | "check_elsewhere", "price_take": "Solid baseline — Echo Dot typical UK £45-£60." | null}

Verdict semantics:
- "good_buy"        — verified price is at or below typical UK retail floor for this product. Tell the user to buy.
- "fair"            — verified price is within typical UK retail band. Reasonable purchase.
- "wait"            — price is normal but a known sale event is imminent (Prime Day, Black Friday, end-of-product-cycle).
- "check_elsewhere" — verified price is implausibly LOW for this product family (likely an accessory, replacement part, or wrong-SKU surfacing as the top organic listing) OR implausibly HIGH (3rd-party seller markup) OR the verified listing's TITLE doesn't clearly match the canonical product (e.g. canonical "Dyson V15 Detect" but title is just "Dyson V15" or "Dyson Replacement Wand"). The user should NOT trust this listing as the canonical product — recommend checking the listing carefully or another retailer.
- BIAS toward check_elsewhere when ANY of these signal: price <50% of typical retail floor, title missing key product identifiers, rating low (<4.0) and reviews <50. Better to warn unnecessarily than to miss a wrong-SKU.

CRITICAL — accessory/wrong-SKU detection:
- If the canonical product family is "Dyson V15 Detect" and verified price is £170, that is implausibly low for V15 Detect (real range £449-£599). Verdict = "check_elsewhere", price_take = "This price suggests a replacement part or accessory, not the V15 Detect itself — verify the listing before buying."
- If canonical is a current iPhone Pro and verified is £200, that is implausibly low. Verdict = "check_elsewhere".
- Use UK retail knowledge for the product family to judge plausibility. Be cautious — false-positive on a legit sale is less damaging than false-negative on a wrong-SKU.

price_take rules:
- ONE sentence, max 10 words (HARD limit — server-side cap will truncate mid-clause if exceeded). Plain prose, no emojis. End with a full stop, not a dangling clause.
- ALWAYS anchor the verdict in a visible UK price reference where you know the band — formats: "typical £45-£60", "averages £279", "retails £449-£599", "high street £550-£600". The user must see WHY this verdict was given, not just the verdict itself. Only omit the reference if you genuinely don't know the typical UK band — in that case return price_take=null instead of guessing.
- Anchor in the verified price you were given. Do NOT quote a different price.
- For "check_elsewhere", the take MUST explain why (accessory suspicion, 3P markup).
- For "good_buy" / "fair" / "wait", the take frames the price in market context.
- For products you genuinely don't recognise, return verdict="fair" + price_take=null. Don't bluff.

NEVER hallucinate a competing retailer price. NEVER cite a specific GBP figure other than the verified price you were given.`;

  const userMsg = `Product: ${canonical}
Verified Amazon UK price: ${price_str}` +
    (used_price_str ? `\nAlso seen used at ${used_price_str}` : '') +
    (rating ? `\nAmazon rating: ${rating}/5 from ${reviews || '?'} reviews` : '') +
    (category ? `\nCategory: ${category}` : '') +
    `\n\nProduce the JSON.`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 180,
        // Wave II — prompt caching on price_take system prompt.
        system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMsg }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = ((j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch { return null; }
    const allowedVerdicts = ['good_buy', 'fair', 'wait', 'check_elsewhere'];
    const verdict = (parsed && allowedVerdicts.includes(parsed.verdict)) ? parsed.verdict : null;
    const take = (parsed && typeof parsed.price_take === 'string' && parsed.price_take.trim())
      ? parsed.price_take.trim().slice(0, 200) : null;
    return { verdict, price_take: take };
  } catch (e) {
    return null;
  } finally { clearTimeout(timer); }
}

// ═══════════════════════════════════════════════════════════════════════
// V.138 — MEGA-SYNTHESIS PROMPT (Panel-mandated, replaces N separate calls)
// ═══════════════════════════════════════════════════════════════════════
// One Haiku call that returns ALL AI-derived text fields needed by the
// V.137 frontend in a single JSON object. Replaces the per-field strategy
// (separate calls for eyebrow, sentiment, tier blurbs) that the Panel
// hard-vetoed in V.137 review.
//
// Two operating modes auto-detected from the input shape:
//   Pillars mode  — INPUT.amazon present  → returns verdict_label,
//                   verdict_summary, category_eyebrow. tier_blurbs=null.
//   Tiers mode    — INPUT.alternatives[3] → returns tier_blurbs[3].
//                   All other fields=null.
//
// Latency budget: 4000ms with abort. Falls back to {nulls} on
// timeout / parse error / no-key so the response shape stays stable.
async function callHaikuMegaSynthesis({ canonical, category, market_status, amazon, retailers, alternatives, trace }) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const EMPTY = { verdict_label: null, verdict_summary: null, category_eyebrow: null, tier_blurbs: null };
  if (!ANTHROPIC_KEY) return EMPTY;
  if (!canonical) return EMPTY;

  // Build the user-message payload from whatever signals are available.
  const input = {
    canonical: String(canonical).slice(0, 200),
    category: category || null,
    market_status: market_status || null,
  };
  if (amazon && Number(amazon.price) > 0) {
    input.amazon = {
      price: Number(amazon.price),
      price_str: amazon.price_str || null,
      rating: amazon.rating || null,
      reviews: amazon.reviews || null,
      title: amazon.title ? String(amazon.title).slice(0, 150) : null,
      used_price_str: amazon.used_price_str || null,
    };
  }
  if (retailers && Array.isArray(retailers) && retailers.length > 0) {
    // V.160b — sanitize retailer names before Haiku sees them.
    const _v160NormalizeName = (raw) => {
      if (!raw) return '';
      let n = String(raw).slice(0, 60);
      n = n.replace(/\.(?:via-google|redirect)$/i, '');
      n = n.replace(/(couk|com|net|org)$/i, '').trim();
      return n.charAt(0).toUpperCase() + n.slice(1);
    };
    // V.160c — robust price coercion. synthesis_payload.retailers carries
    // `price` as a £-prefixed string ("£13.46") because that's what the
    // /api/identify response wrapper formats for display. Number() on
    // those returns NaN, which was nulling every retailer price the LLM
    // saw and breaking the market_context computation. Now parse £/$/€
    // prefixes and comma thousands separators.
    const _v160ParsePrice = (raw) => {
      if (raw == null) return null;
      if (typeof raw === 'number' && raw > 0 && isFinite(raw)) return raw;
      if (typeof raw !== 'string') return null;
      const cleaned = raw.replace(/[£$€,\s]/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
      if (!cleaned) return null;
      const v = parseFloat(cleaned[0]);
      return (isFinite(v) && v > 0) ? v : null;
    };
    input.retailers = retailers.slice(0, 8).map(r => ({
      name:  _v160NormalizeName(r.name),
      price: _v160ParsePrice(r.price),
    }));
    // V.160 — compute market-context stats from the FULL retailers array
    // (NOT the .slice(0,8) view). Haiku quotes `retailer_count` in
    // verdict_summary, and we need that to match the count the frontend
    // shows in Pillar 3 (avg_market.retailer_count).
    const _v160Prices = retailers
      .map(r => _v160ParsePrice(r && r.price))
      .filter(p => p != null)
      .sort((a, b) => a - b);
    if (_v160Prices.length >= 2) {
      const lo = _v160Prices[0];
      const hi = _v160Prices[_v160Prices.length - 1];
      const mid = Math.floor(_v160Prices.length / 2);
      const median = (_v160Prices.length % 2 === 0)
        ? (_v160Prices[mid - 1] + _v160Prices[mid]) / 2
        : _v160Prices[mid];
      input.market_context = {
        retailer_count: _v160Prices.length,
        low_gbp:        Number(lo.toFixed(2)),
        median_gbp:     Number(median.toFixed(2)),
        high_gbp:       Number(hi.toFixed(2)),
        spread_pct:     (lo > 0) ? Number((((hi - lo) / lo) * 100).toFixed(0)) : 0,
      };
    }
  }
  if (alternatives && Array.isArray(alternatives) && alternatives.length >= 2 && alternatives.length <= 4) {
    // V.139 — accept 2-4 alternatives. The frontend tier render either
    // pads with a placeholder (when 2) or truncates (when 4). Haiku only
    // generates blurbs for the real alts; placeholder gets its own copy.
    input.alternatives = alternatives.slice(0, 3).map((a, i) => ({
      tier: ['basic', 'top_rated', 'premium'][i],
      name: String(a.name || '').slice(0, 120),
      typical_price_gbp: (a.typical_price_gbp != null) ? Number(a.typical_price_gbp) : null,
      rating: a.rating || null,
      reviews: a.reviews || null,
      pack_size: a.pack_size || null,
    }));
  }

  const sys = `You are Savvey's result-text synthesizer for UK shoppers. Given a verified product (Pillars mode) or a low-confidence query with 3 tier alternatives (Tiers mode), return strictly formatted JSON.

V.179 CRITICAL — STRICT DATA BINDING (overrides every other rule):

CRITICAL: You are provided a list of exact prices and retailers. You MUST
NOT invent, guess, or mention any price, retailer, or saving amount that
cannot be mathematically derived from the provided list. If a retailer is
not in the list, do not mention them.

Concretely this means:
  - Every £ figure you write must equal a price from INPUT.amazon.price,
    INPUT.retailers[*].price, or INPUT.market_context.low_gbp / median_gbp
    / high_gbp. No other £ figures allowed.
  - Every retailer name you mention must equal INPUT.amazon (call it
    "Amazon") or appear in INPUT.retailers[*].name. No other retailer
    names allowed.
  - Saving amounts must be the literal arithmetic difference between
    two prices both present in INPUT. "Saving £30" requires you to be
    able to point at the two prices (£X and £X+30) that produced it.
  - If you can't anchor a sentence in INPUT, REWRITE THE SENTENCE.

This rule overrides the V.173 "name 1-2 retailers" guidance — if the
list of retailers you were given is empty or sparse, name fewer, not
more. The verdict_summary may be short. It may not lie.

V.173 CONSUMER VOICE — non-negotiable, applies to every verdict_summary
and tier_blurb you write:

  YOU ARE A HELPFUL SHOPPING ASSISTANT. You speak to a UK shopper standing
  in a store, holding their phone. You are NOT a financial analyst, you
  are NOT an engineer, you are NOT a data scientist.

  BANNED VOCABULARY (these reveal you're an AI and break the illusion):
    "data variance" · "fair value" · "price band" · "median" · "spread" ·
    "outliers" · "SKU" · "data point" · "sample size" · "matched_thin" ·
    "coverage" · "indexed" · "scraped" · "fetched" · "retailer count" ·
    "the AI" · "I searched" · "I found" · "I couldn't find" · "my data" ·
    "my analysis" · "data variance" · "implausible" · "category-implausible"
    Replace these with plain shopper language. NEVER refer to your own
    process or struggles.

  REQUIRED VOICE:
    - Talk about the PRODUCT and the PRICE, not about your search process.
    - When you cite a number, use it naturally: "Most shops list this
      around £450" — not "the market median is £450".
    - Name 1-2 specific retailers when explaining a deal: "Argos and
      Currys are typically £20 more" — not "the spread suggests £20".
    - Lead with the deal verdict in plain English: is it a good price or
      not, and why, in one breath.
    - Keep it warm, confident, brief. A shopper has 6 seconds before they
      tap away.

  WHY-IT'S-A-DEAL FORMULA (use when verdict is good_buy):
    "<plain positioning>. At £X, that's <plain comparison vs typical
    £Y> — <retailer or two who usually charge more>."
    Example: "Solid mid-range air fryer. At £119, you're paying £40-50
    less than Currys and John Lewis typically charge for this model."

  WHY-TO-WAIT FORMULA (use when verdict is wait):
    "Plain positioning. <one short sale-cycle clue>."
    Example: "Brand-new model. Prices usually settle around £80 once
    Argos and Currys start running their Spring deals in April."

V.160 HARD RULE — PILLARS MODE (INPUT.alternatives absent):
  - verdict_label MUST be one of: "good_buy" | "fair" | "wait" | "check_elsewhere".
    null is FORBIDDEN here. If unsure, default to "fair".
  - verdict_summary MUST be a non-empty string ≤28 words.
    null is FORBIDDEN here. If amazon is absent, you MUST cite
    INPUT.market_context numbers (retailer_count, low_gbp, median_gbp,
    high_gbp, spread_pct) instead. Those numbers are GROUND TRUTH —
    cite them, don't invent others.
  - INPUT.retailers is a SAMPLE (up to 8 entries). The authoritative
    total is INPUT.market_context.retailer_count. NEVER quote the
    sample length as the retailer count — always quote the
    market_context.retailer_count field.
  - NEVER claim "price data unavailable" when INPUT.market_context is
    populated. If market_context exists, prices ARE available — use them.

V.173 THIN-COVERAGE RULE (replaces V.168) — when INPUT.retailers has only
  1 or 2 entries, acknowledge scarcity in PLAIN LANGUAGE. No "indexed",
  no "verified UK retailer", no "spread", no jargon.
  Pattern: "<plain positioning>. <plain note about why this product is
  hard to compare>."
  Examples (consumer voice, no jargon):
    1 retailer: "Standard supermarket pricing at £8.50. Yorkshire Tea is
                 a Tesco/Sainsbury's regular — the cheapest place is
                 usually your nearest big shop."
    2 retailers: "£12 paperback pricing — Amazon's the cheapest live
                  listing, but Waterstones and Blackwell's usually match it
                  in store."
  Still produce a valid verdict_label. With 1-2 retailers lean "fair" or
  "good_buy". Lean "check_elsewhere" only if the price looks wrong for
  the product.

OUTPUT JSON ONLY, no preamble, no markdown fences:
{
  "verdict_label": "good_buy" | "fair" | "wait" | "check_elsewhere" | null,
  "verdict_summary": "1-2 sentence max 28-word review-data synthesis" | null,
  "category_eyebrow": "Category · KeySpec · KeySpec, max 40 chars" | null,
  "tier_blurbs": ["basic blurb", "top_rated blurb", "premium blurb"] | null
}

PILLARS MODE (INPUT.alternatives ABSENT — fires when amazon OR retailers present):
  verdict_label semantics:
    good_buy        = verified price at/below typical UK floor + decent rating,
                      OR retailer-only path where spread_pct is wide (>40%) AND
                      the user has a clear "best price" choice well below median.
    fair            = within typical UK retail band, OR retailer-only path with
                      tight spread (<25%) — competitive market, no obvious win.
    wait            = price normal but a known UK sale event imminent
                      (Prime Day, Black Friday, end-of-product-cycle).
    check_elsewhere = implausibly LOW for product family (likely accessory
                      / wrong-SKU surfaced as top organic) OR implausibly
                      HIGH (3P markup) OR title doesn't match canonical.
                      Bias toward check_elsewhere when in doubt.

  verdict_summary: ALWAYS produce non-null. 1-2 sentences, max 28 words.
    Three modes depending on what INPUT carries:

    (a) When INPUT.amazon.rating + reviews present: cite a concrete
        observation reviewers actually make. Honest + brutal voice. Examples:
        "Highly rated for cooking speed and dual-zone capacity. Most
         reviewers mention the non-stick basket is fiddly to clean —
         soak after every cook."
        "Best-in-class noise cancellation. Comfort drops past 4-hour
         sessions per long-haul flight reviewers."

    (b) When INPUT.amazon present but rating/reviews missing or sparse
        (new launches, etc.): write 1 sentence of honest price-context —
        model lifecycle, launch RRP, typical UK price band, sale-window
        expectation. Examples:
        "Launch RRP £699 for the flagship console. Stock fluid in the
         first 6 months; expect occasional Currys/Game discounts by Q3."
        "Top-end iPhone tier — Apple holds price firmly until the
         September refresh."

    (c) V.173 — When INPUT.amazon is ABSENT and INPUT.retailers is present
        (long-tail / specialist gear / niche imports), explain the deal
        in plain language. Use INPUT.market_context numbers as ground
        truth but TRANSLATE them into shopper-friendly sentences. No
        "spread", no "market_context", no "verified retailers" — just
        plain "you'll find this anywhere from £X to £Y, and £A is the
        best you'll see today."
        Examples (consumer voice):
        "Specialist climbing gear — UK stockists run £36-£142 for this
         carabiner, so the £36 listing is a strong deal."
        "Outdoor-shop pricing typically lands £10-£40 for this clip.
         Worth checking gate type before you buy."
        "Most stockists cluster £18-£22 for this size. Plenty of shops
         in stock, so grab the cheapest with confidence."

    NEVER invent specific reviewer quotes, rating numbers, or review
    counts that aren't in INPUT. ALWAYS write in plain shopper voice.
    NEVER mention "the market", "data", or your own search.

  category_eyebrow: derive from canonical + obvious specs in the name.
    e.g. "Ninja Foodi Dual Zone AF300UK" → "Air Fryer · 7.6L · 2400W"
    Use ONLY specs visible in the canonical or amazon.title. Don't
    invent numbers. Format: "Category · Spec1 · Spec2". Max 40 chars.
    Return null if not derivable.

  tier_blurbs: return null.

TIERS MODE (INPUT.alternatives present with 2-3 entries):
  verdict_label: null
  verdict_summary: null
  category_eyebrow: null
  tier_blurbs: array of N blurbs matching the input alternatives count
    (max 14 words each), in this exact order: [basic, top_rated, premium].
    If only 2 alternatives were provided, return ONLY 2 blurbs (no padding).

    basic[0] — "cheap + reliable + does the job" angle. Plain spoken.
      Example: "Cheap, reliable, dishwasher-safe. Job done."

    top_rated[1] — CRITICAL OBJECTIVITY RULE (Panel mandate):
      MUST cite the exact review count and/or star rating from
      INPUT.alternatives[1].rating / .reviews. NO editorial value
      judgements (forbidden phrases: "buy it once", "best value",
      "worth the money", "the smart pick").
      Format: "<stars>★ from <count> reviews. Reviewers cite '<concrete observation>'"
      Example: "4.6★ from 2,847 reviews. Reviewers cite 'perfect weight' and 'beautiful glaze.'"
      If rating + reviews are missing in the input, frame as "highest-
      rated of the three" without inventing numbers.

    premium[2] — premium signals (provenance, craft, materials, longevity).
      No price-anchor judgements. Example: "Hand-decorated in Stoke-on-Trent. Heirloom-grade."

CRITICAL RULES (apply to ALL modes):
  - Never invent specific GBP figures, retailer prices, or review counts
    that aren't in INPUT.
  - Never quote song lyrics, copyrighted text, or persuasive marketing copy.
  - Output VALID JSON only. No prose preamble. No trailing text.
  - When a field can't be filled honestly from INPUT, return null.
  - Be concise. Total response max ~200 tokens.`;

  const userMsg = `INPUT:\n${JSON.stringify(input)}\n\nProduce the JSON now.`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  // V.191 — granular Haiku mega-synth timing.
  const _v191HaikuStart = Date.now();
  console.log(`[V.191][timer] haiku.mega_synth START`);
  try {
    if (trace) trace.push({step:'mega_synthesis.start', mode: input.alternatives ? 'tiers' : 'pillars', has_amazon: !!input.amazon, has_alts: !!input.alternatives});
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 420,
        system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMsg }],
      }),
      signal: ac.signal,
    });
    console.log(`[V.191][timer] haiku.mega_synth DONE ${Date.now()-_v191HaikuStart}ms status=${r.status}`);
    if (!r.ok) {
      console.warn(`[${VERSION}] callHaikuMegaSynthesis HTTP ${r.status}`);
      if (trace) trace.push({step:'mega_synthesis.http_error', status: r.status});
      return EMPTY;
    }
    const j = await r.json();
    const text = ((j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) {
      console.warn(`[${VERSION}] callHaikuMegaSynthesis JSON parse failed: ${e.message}`);
      if (trace) trace.push({step:'mega_synthesis.parse_error', snippet: text.slice(0,120)});
      return EMPTY;
    }
    const allowedVerdicts = ['good_buy', 'fair', 'wait', 'check_elsewhere'];
    const out = {
      verdict_label: (parsed && allowedVerdicts.includes(parsed.verdict_label)) ? parsed.verdict_label : null,
      verdict_summary: (parsed && typeof parsed.verdict_summary === 'string' && parsed.verdict_summary.trim())
                        ? parsed.verdict_summary.trim().slice(0, 220) : null,
      category_eyebrow: (parsed && typeof parsed.category_eyebrow === 'string' && parsed.category_eyebrow.trim())
                        ? parsed.category_eyebrow.trim().slice(0, 60) : null,
      tier_blurbs: (parsed && Array.isArray(parsed.tier_blurbs) && parsed.tier_blurbs.length >= 2 && parsed.tier_blurbs.length <= 3)
                    ? parsed.tier_blurbs.map(b => (typeof b === 'string' && b.trim()) ? b.trim().slice(0, 140) : null)
                    : null,
    };
    if (trace) trace.push({step:'mega_synthesis.done', verdict: out.verdict_label, has_summary: !!out.verdict_summary, has_eyebrow: !!out.category_eyebrow, has_tiers: !!out.tier_blurbs});
    // V.160a — when the parsed output is structurally empty (Haiku gave
    // null on both verdict_label and verdict_summary), surface the raw
    // text snippet on the trace so the Panel can see exactly what Haiku
    // produced. Truncated to 400 chars to keep response size sane.
    if (trace && !out.verdict_label && !out.verdict_summary) {
      trace.push({step:'mega_synthesis.empty_output_audit', raw_text_snippet: (text || '').slice(0, 400)});
    }
    return out;
  } catch (e) {
    console.warn(`[${VERSION}] callHaikuMegaSynthesis error: ${e.message}`);
    if (trace) trace.push({step:'mega_synthesis.exception', message: String(e.message||e).slice(0,160)});
    return EMPTY;
  } finally { clearTimeout(timer); }
}

// V.140 — callHaikuTierFallback REMOVED. The V.139 sequential-LLM
// chain caused Vercel function timeouts (504) under load. Panel
// reverted to strict one-LLM-call policy. When the primary parse
// returns <2 alternatives we accept defeat and route to no_match
// (the frontend renders the Amazon-search fallback CTA).

// V.118 (11 May 2026) — Haiku-validates-top-5 SerpAPI listing picker.
// Replaces the V.96 lexical-overlap heuristic with semantic validation.
// Panel mandate after Crucible Test surfaced wrong-listing bias: SerpAPI's
// top organic result is ~70% trustworthy on fresh queries — Haiku picks
// the correct match from the top 5 instead of taking #1 blindly.
//
// Input shape: { canonical, candidates: [{ index, title, price, asin, rating, reviews }] }
// Output: { index: 0-4 | null, reason: string }
//   - index === null when NONE of the 5 candidates is the canonical product
//     (decoy listings only: replacement parts, multi-packs, wrong variants).
//   - index 0-4 picks the best semantic match.
//
// Latency budget: 4000ms with abort. Falls through to V.96 lexical guard
// on null / timeout / parse error so we never lose the safety net.
async function callHaikuListingPicker({ canonical, candidates, trace = null }) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) { if (trace) trace.push({step:'picker.skip', reason:'no_api_key'}); return null; }
  if (!canonical || !Array.isArray(candidates) || candidates.length === 0) {
    if (trace) trace.push({step:'picker.skip', reason:'no_candidates', candidates_in: Array.isArray(candidates) ? candidates.length : 0});
    return null;
  }
  if (trace) trace.push({step:'picker.start', candidate_count: candidates.length, canonical: String(canonical).slice(0,80)});

  const sys = `You are a UK retail product matcher. Given a canonical product query and up to 5 Amazon UK listing candidates, pick the ONE listing that best matches the canonical product, or reject all of them.

REJECT a candidate if it is:
- A replacement part, accessory, or component (e.g. "Dyson V15 brush head" when canonical is "Dyson V15 Detect")
- A multi-pack when the canonical implies single unit (or vice versa)
- A wrong colour, size, or variant of the same family
- A used / refurb / renewed listing
- A different model in the same range (e.g. canonical "Sony WH-1000XM5" but title is "WH-1000XM4")
- A bundle that primarily sells something else

ACCEPT a candidate if:
- The brand, model identifier, and variant tokens in the canonical appear in the title
- The price is plausible for that product family in UK retail
- It is the headline product, not an accessory to it

Output JSON ONLY, no preamble:
{"index": 0 | 1 | 2 | 3 | 4 | null, "reason": "short justification, max 20 words"}

If NONE of the candidates is the canonical product, return index=null. Better to reject all than return a decoy.`;

  const userMsg = `Canonical: ${String(canonical).slice(0, 200)}

Candidates:
${candidates.map((c, i) => `[${i}] £${Number(c.price).toFixed(2)} — ${String(c.title || '').slice(0, 180)}`).join('\n')}

Pick the index or return null. Produce the JSON.`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(ANTHROPIC_ENDPOINT, {
      method: 'POST',
      headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        // V.121 — bumped 120→250. V.120a Yankee Candle trace showed Haiku's
        // reason field overflowed 120 tokens and produced truncated JSON →
        // picker.parse_error → soft-match override → wrong listing.
        max_tokens: 250,
        system: [{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMsg }],
      }),
      signal: ac.signal,
    });
    if (!r.ok) {
      console.warn(`[${VERSION}] callHaikuListingPicker HTTP ${r.status}`);
      if (trace) trace.push({step:'picker.http_error', status: r.status});
      return null;
    }
    const j = await r.json();
    const text = ((j.content || []).filter(b => b && b.type === 'text').map(b => b.text || '').join(' ')).trim();
    const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); } catch {
      if (trace) trace.push({step:'picker.parse_error', raw_snippet: text.slice(0,120)});
      return null;
    }
    const idx = parsed && (parsed.index === null ? null
      : (Number.isInteger(parsed.index) && parsed.index >= 0 && parsed.index < candidates.length ? parsed.index : null));
    const reason = (parsed && typeof parsed.reason === 'string') ? parsed.reason.slice(0, 200) : '';
    if (trace) {
      if (idx === null) trace.push({step:'picker.rejected_all', reason: reason});
      else trace.push({step:'picker.picked', index: idx, reason: reason, picked_title: String(candidates[idx].title||'').slice(0,120), picked_price: candidates[idx].price});
    }
    return { index: idx, reason };
  } catch (e) {
    console.warn(`[${VERSION}] callHaikuListingPicker error: ${e.message}`);
    if (trace) trace.push({step:'picker.exception', message: String(e.message||e).slice(0,160)});
    return null;
  } finally { clearTimeout(timer); }
}

// SerpAPI Amazon engine (v3.3.2 — 5 May 2026).
// Switched from engine=google_shopping (returned Google `aclk` redirect URLs
// that broke affiliate-tag propagation and didn't deep-link to actual
// listings) to engine=amazon with amazon_domain=amazon.co.uk.

// V.92 — Defensive rating/reviews coercion. SerpAPI's Amazon engine has been
// observed returning rating as a string ("4.5", "4.5 out of 5 stars") rather
// than a number for some products, and reviews count under various field names
// (reviews / review_count / rating_count / reviews_count / ratings_total).
// V.89 review synthesis was failing silently because the strict typeof === 'number'
// gate dropped these. These helpers accept both numeric and string forms.
function _coerceRating(v) {
  if (typeof v === 'number' && v > 0 && v <= 5) return Number(v.toFixed(1));
  if (typeof v === 'string') {
    const m = v.match(/(\d+(?:\.\d+)?)/);
    if (m) {
      const n = parseFloat(m[1]);
      if (n > 0 && n <= 5) return Number(n.toFixed(1));
    }
  }
  return null;
}
function _coerceReviews(v) {
  if (typeof v === 'number' && v > 0 && isFinite(v)) return Math.floor(v);
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^0-9]/g, '');
    if (!cleaned) return null;
    const n = parseInt(cleaned, 10);
    if (n > 0 && isFinite(n)) return n;
  }
  return null;
}
function _extractAmazonRating(item) {
  // Try documented field first, then known alternates seen in practice
  return _coerceRating(item.rating)
      || _coerceRating(item.rating_value)
      || _coerceRating(item.rating_score)
      || _coerceRating(item.stars)
      || null;
}
function _extractAmazonReviews(item) {
  // Multiple field names seen across SerpAPI Amazon engine responses
  return _coerceReviews(item.reviews)
      || _coerceReviews(item.review_count)
      || _coerceReviews(item.rating_count)
      || _coerceReviews(item.reviews_count)
      || _coerceReviews(item.ratings_total)
      || null;
}
// Native Amazon search returns ASIN + price + rating directly, so we can
// build canonical /dp/ASIN URLs with the affiliate tag baked in — no
// redirect-chasing, no Google middleware.
async function fetchVerifiedAmazonPrice(query, trace = null) {
  _lastSerpStatus = null;
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    _lastSerpStatus = 'no_key';
    if (trace) trace.push({step:'serpapi.skip', reason:'no_api_key'});
    return null;
  }
  if (!query || typeof query !== 'string' || query.length < 2) {
    if (trace) trace.push({step:'serpapi.skip', reason:'empty_query'});
    return null;
  }
  if (trace) trace.push({step:'serpapi.fetch', query: query.slice(0,120)});

  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine',         'amazon');
  url.searchParams.set('amazon_domain',  'amazon.co.uk');
  url.searchParams.set('k',              query.slice(0, 150));
  url.searchParams.set('api_key',        apiKey);

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), SERPAPI_TIMEOUT_MS);
  // V.191 — granular SerpAPI timing. Logs are surfaced in Vercel runtime
  // logs so we can identify which third-party leg is hanging.
  const _v191SerpStart = Date.now();
  console.log(`[V.191][timer] serpapi.amazon START q="${query.slice(0,60)}"`);
  try {
    const r = await fetch(url.toString(), { signal: controller.signal });
    clearTimeout(timeout);
    console.log(`[V.191][timer] serpapi.amazon DONE ${Date.now()-_v191SerpStart}ms status=${r.status}`);
    _lastSerpStatus = r.status;
    if (!r.ok) {
      console.warn(`[${VERSION}] SerpAPI HTTP ${r.status} for "${query.slice(0, 60)}"`);
      if (trace) trace.push({step:'serpapi.http_error', status: r.status});
      return null;
    }
    const j = await r.json();
    const results = Array.isArray(j.organic_results) ? j.organic_results : [];
    if (trace) trace.push({step:'serpapi.results', total: results.length, sponsored_skipped: results.filter(it => it.sponsored).length});

    // V.121 — `primary` is set ONLY by the V.118 Haiku picker. No lexical/soft
    // -match fallback. `used` is collected by a separate slim loop further down
    // for the used_amazon_price field. The V.96-era token-overlap heuristic
    // has been purged per Panel mandate.
    let primary = null;
    let used    = null;
    let _organicChecked = 0; // diagnostic counter retained

    // V.118 — Haiku-validates-top-5. Collect first 5 non-sponsored, non-used
    // organic candidates with valid prices, pass to Haiku for semantic selection.
    // If Haiku picks an index, use it as `primary`. Otherwise we return null.
    const _v118TopCandidates = [];
    for (const it of results) {
      if (_v118TopCandidates.length >= 5) break;
      const p = Number(it.extracted_price);
      if (!(p > 0)) continue;
      if (it.sponsored) continue;
      const c = String(it.condition || '').toLowerCase();
      const t = String(it.title || '').toLowerCase();
      if (/(used|refurb|renewed|open[\s-]?box|pre[\s-]?owned)/i.test(c + ' ' + t)) continue;
      _v118TopCandidates.push({
        title: String(it.title || '').slice(0, 200),
        price: p,
        asin: (typeof it.asin === 'string') ? it.asin : null,
        _ref: it,
      });
    }
    // V.121 — picker is now AUTHORITATIVE. `primary` is set only by V.118.
    // V.96 lexical/soft-match for `primary` is REMOVED. Panel mandate after
    // V.120a observed soft-match overriding explicit picker rejections
    // (Aldi Manuka → NZ Honey Co., Brompton bike → £22.99 wheels, etc).
    // _v118Decision values: 'matched' | 'rejected_all' | 'error' | 'no_candidates'.
    let _v118Picked = null;
    let _v118Reason = '';
    let _v118Decision = 'no_candidates';
    let _v118PickedIdx = null;
    if (_v118TopCandidates.length > 0) {
      if (trace) trace.push({step:'picker.candidates_built', count: _v118TopCandidates.length, titles: _v118TopCandidates.map(c => ({t: c.title.slice(0,120), p: c.price}))});
      try {
        const picker = await callHaikuListingPicker({
          canonical: query,
          candidates: _v118TopCandidates,
          trace,
        });
        if (picker && Number.isInteger(picker.index) && picker.index >= 0 && picker.index < _v118TopCandidates.length) {
          _v118Picked = _v118TopCandidates[picker.index]._ref;
          _v118Reason = picker.reason || '';
          _v118PickedIdx = picker.index;
          primary = _v118Picked;
          _v118Decision = 'matched';
          console.log(`[${VERSION}] V.118 Haiku picked candidate ${picker.index}/${_v118TopCandidates.length-1} for "${query.slice(0,60)}" — reason: ${_v118Reason.slice(0,100)}`);
        } else if (picker && picker.index === null) {
          _v118Decision = 'rejected_all';
          console.warn(`[${VERSION}] V.121: V.118 Haiku REJECTED all ${_v118TopCandidates.length} candidates for "${query.slice(0,60)}" — reason: ${(picker.reason||'').slice(0,100)}. Returning null (V.96 soft-match purged).`);
        } else {
          // picker returned null entirely (http/parse/exception inside the picker call)
          _v118Decision = 'error';
          console.warn(`[${VERSION}] V.121: V.118 picker returned null (http/parse/timeout). Returning null. (V.96 soft-match purged.)`);
        }
      } catch (e) {
        _v118Decision = 'error';
        console.warn(`[${VERSION}] V.121: V.118 picker outer exception: ${e.message}. Returning null.`);
        if (trace) trace.push({step:'picker.outer_exception', message: String(e.message||e).slice(0,160)});
      }
    } else {
      _v118Decision = 'no_candidates';
      if (trace) trace.push({step:'picker.no_candidates', reason:'no priced non-sponsored non-used organic results', total_organic: results.length});
    }

    // V.121 — slim `used`-only collection loop. Replaces the V.96 lexical
    // primary-finding loop. The Panel mandate forbids any path that lets an
    // organic result become `primary` without going through the picker, so
    // here we ONLY look for the first used/refurb listing to populate
    // used_amazon_price for the savvey_says block downstream.
    for (const item of results) {
      const price = Number(item.extracted_price);
      if (!(price > 0)) continue;
      if (item.sponsored) continue;
      const cond  = String(item.condition || '').toLowerCase();
      const title = String(item.title     || '').toLowerCase();
      const isUsed = /(used|refurb|renewed|open[\s-]?box|pre[\s-]?owned)/i.test(cond + ' ' + title);
      if (isUsed && !used) {
        used = item;
        if (primary) break;
      }
      _organicChecked++;
    }

    // V.121 — strict pipeline gate. If V.118 didn't pick, return null. No exceptions.
    if (!primary) {
      _lastSerpStatus = (_v118Decision === 'rejected_all') ? 'picker_rejected'
                      : (_v118Decision === 'error') ? 'picker_error'
                      : (_v118Decision === 'no_candidates') ? 'no_usable_candidates'
                      : (_lastSerpStatus || 'no_amazon_match');
      if (trace) trace.push({step:'serpapi.final', outcome:'no_match', v118_decision: _v118Decision, last_status: _lastSerpStatus});
      console.warn(`[${VERSION}] V.121 final no_match: v118_decision=${_v118Decision}, last_status=${_lastSerpStatus}, organic_checked=${_organicChecked}, total_results=${results.length}`);
      return null;
    }
    if (trace) trace.push({step:'serpapi.final', outcome:'matched', v118_decision: _v118Decision, v118_picked_idx: _v118PickedIdx, last_status: _lastSerpStatus, source: 'v118_haiku_picker', picked_title: String(primary.title||'').slice(0,120), picked_price: Number(primary.extracted_price)});

    const asin = (typeof primary.asin === 'string' && /^[A-Z0-9]{8,12}$/i.test(primary.asin)) ? primary.asin : null;

    // Build the deep link. ASIN-based /dp/ URL is the canonical Amazon
    // Associates pattern — it's stable, indexable, and the affiliate tag
    // is the FIRST query param so attribution is unambiguous.
    let directLink = null;
    if (asin) {
      directLink = `https://www.amazon.co.uk/dp/${asin}?tag=${encodeURIComponent(AMAZON_TAG)}`;
    } else if (primary.link && /^https?:\/\/(www\.)?amazon\.co\.uk\//i.test(primary.link)) {
      try {
        const u = new URL(primary.link);
        u.searchParams.set('tag', AMAZON_TAG);
        directLink = u.toString().slice(0, 500);
      } catch (e) { /* skip */ }
    }

    // v3.3.3 — pass through rating, reviews count, prime eligibility, and the
    // SerpAPI-returned product thumbnail. All defensive (nullable). These build
    // trust without adding any extra API call cost — they're already in the
    // organic_results we just fetched.
    // V.92 — defensive extraction supports string-rating + alternate field names
    const ratingVal = _extractAmazonRating(primary);
    const reviewsVal = _extractAmazonReviews(primary);
    const isPrime = primary.is_prime === true || primary.prime === true;
    const thumb   = (typeof primary.thumbnail === 'string' && /^https?:\/\//i.test(primary.thumbnail))
      ? primary.thumbnail.slice(0, 500) : null;

    // V.70 - PRICE-HISTORY LOGGING (panel-mandated, fire-and-forget).
    // Non-blocking: async kvSet without await, errors swallowed.
    // 90-day TTL keeps KV bounded while building 12-month history dataset.
    try {
      const _logTs = Date.now();
      const _logHash = (_logTs + String(query)).slice(-12).replace(/[^a-z0-9]/gi, '');
      const _logKey = 'savvey:pricelog:' + _logTs + ':' + _logHash;
      const _logVal = {
        canonical: String(query).slice(0, 200),
        asin: (typeof primary.asin === 'string') ? primary.asin : null,
        price: Number(primary.extracted_price),
        retailer: 'amazon.co.uk',
        rating: ratingVal, // V.92 - was raw primary.rating; now uses coerced value
        reviews: reviewsVal, // V.92 - same
        ts: new Date(_logTs).toISOString(),
      };
      kvSet(_logKey, _logVal, 7776000).catch(() => {});
    } catch (_e) { /* swallow - non-critical */ }

    return {
      price:           Number(primary.extracted_price),
      // V.50 — Amazon UK is always GBP. SerpAPI's primary.price field can include
      // "EUR" / "USD" prefix when the listing geo-mismatches; force £ prefix from
      // extracted_price so users always see "£218.69" not "EUR 218.69".
      price_str:       (Number.isFinite(Number(primary.extracted_price)) ? `£${Number(primary.extracted_price).toFixed(2)}` : String(primary.price || '').slice(0, 30)),
      currency:        'GBP',
      source:          'amazon.co.uk',
      source_type:     'organic',
      asin,
      title:           primary.title ? String(primary.title).slice(0, 200) : null,
      link:            directLink,
      thumbnail:       thumb,
      rating:          ratingVal,
      reviews:         reviewsVal,
      is_prime:        isPrime,
      used_price:      used ? Number(used.extracted_price) : null,
      // V.50 — same currency-safety as price_str above.
      used_price_str:  used ? (Number.isFinite(Number(used.extracted_price)) ? `£${Number(used.extracted_price).toFixed(2)}` : String(used.price || '').slice(0, 30)) : null,
      fetched_at:      new Date().toISOString(),
    };
  } catch (err) {
    clearTimeout(timeout);
    _lastSerpStatus = 'fetch_error';
    const msg = String(err && err.message || err).slice(0, 200);
    const isAbort = (err && (err.name === 'AbortError' || /aborted|timeout/i.test(msg)));
    console.warn(`[${VERSION}] SerpAPI fetch error for "${query.slice(0, 60)}":`, msg);
    // V.121 — explicit trace entry. Panel mandate: no silent swallowing.
    if (trace) trace.push({step:'serpapi.fetch_error', message: msg, reason: isAbort ? 'timeout_or_abort' : 'network_or_other', timeout_ms: SERPAPI_TIMEOUT_MS});
    return null;
  }
}

// V.146 — VARIANT-FAMILY DETECTOR (Panel-mandated safety net).
// Deterministic backup for when Haiku ignores the prompt rule and picks
// a single variant from a known multi-variant family. Null-safe: returns
// null on any non-string input, never throws.
const V146_VARIANT_FAMILIES = [
  // V.152 — regex broadened to catch typed variations Haiku canonicalises
  // differently (e.g. "playstation 5" → "PlayStation 5 Console", missing the
  // strict "Sony" prefix). All families now accept optional brand prefix +
  // permissive whitespace + common abbreviations + dot/space-insensitive.
  { rx: /^(?:Sony\s+)?(?:Play[\s-]?Station|PS)\s*5(?!\s*(?:Slim|Pro|Digital|Disc)\b)/i,
    variants: ['Sony PlayStation 5 Slim Disc Edition', 'Sony PlayStation 5 Slim Digital Edition', 'Sony PlayStation 5 Pro'] },
  { rx: /^(?:Microsoft\s+)?Xbox\s*Series(?!\s*(?:S|X)\b)/i,
    variants: ['Xbox Series S 512GB', 'Xbox Series S 1TB', 'Xbox Series X 1TB'] },
  { rx: /^(?:Apple\s+)?(?:iPhone)\s*16(?!\s*(?:Plus|Pro|Pro\s*Max|Mini)\b)/i,
    variants: ['Apple iPhone 16 128GB', 'Apple iPhone 16 Plus 128GB', 'Apple iPhone 16 Pro 128GB'] },
  { rx: /^(?:Apple\s+)?(?:iPhone)\s*15(?!\s*(?:Plus|Pro|Pro\s*Max|Mini)\b)/i,
    variants: ['Apple iPhone 15 128GB', 'Apple iPhone 15 Plus 128GB', 'Apple iPhone 15 Pro 128GB'] },
  { rx: /^(?:Samsung\s+)?Galaxy\s*S25(?!\s*(?:Plus|Ultra|FE)\b)/i,
    variants: ['Samsung Galaxy S25 128GB', 'Samsung Galaxy S25 Plus 256GB', 'Samsung Galaxy S25 Ultra 256GB'] },
  { rx: /^(?:Samsung\s+)?Galaxy\s*S24(?!\s*(?:Plus|Ultra|FE)\b)/i,
    variants: ['Samsung Galaxy S24 128GB', 'Samsung Galaxy S24 Plus 256GB', 'Samsung Galaxy S24 Ultra 256GB'] },
  { rx: /^(?:Apple\s+)?AirPods(?!\s*(?:Pro|Max|4|3|2)\b)/i,
    variants: ['Apple AirPods 4', 'Apple AirPods Pro 2', 'Apple AirPods Max'] },
  { rx: /^(?:Nintendo\s+)?Switch(?!\s*(?:OLED|Lite|2)\b)/i,
    variants: ['Nintendo Switch OLED', 'Nintendo Switch Lite', 'Nintendo Switch (standard)'] },
  { rx: /^(?:Apple\s+)?MacBook\s*(?:Air|Pro)?(?!.*(?:13|14|15|16))/i,
    variants: ['Apple MacBook Air 13\" M3', 'Apple MacBook Pro 14\" M4', 'Apple MacBook Pro 16\" M4 Pro'] },
  { rx: /^(?:Google\s+)?Pixel\s*9(?!\s*(?:Pro|Pro\s*XL|XL|a)\b)/i,
    variants: ['Google Pixel 9 128GB', 'Google Pixel 9 Pro 128GB', 'Google Pixel 9 Pro XL 256GB'] },
  { rx: /^(?:Amazon\s+)?Kindle(?!\s*(?:Paperwhite|Oasis|Scribe|Colorsoft|Kids)\b)/i,
    variants: ['Amazon Kindle Paperwhite', 'Amazon Kindle Colorsoft', 'Amazon Kindle Scribe'] },
];
function _v146DetectVariantFamily(canonical) {
  try {
    if (!canonical || typeof canonical !== 'string') return null;
    for (const fam of V146_VARIANT_FAMILIES) {
      if (fam && fam.rx && fam.rx.test(canonical)) return fam.variants;
    }
  } catch (e) {
    // Defensive: never let a regex panic crash the request.
    console.warn(`[${VERSION}] V.147 _v146DetectVariantFamily exception:`, e && e.message);
  }
  return null;
}

function parseAndDefault(rawText) {
  if (!rawText) return null;
  // V.129a — strip the chain-of-thought <thinking>...</thinking> block (and
  // any stray <thinking>-only fragment) BEFORE we try to find the JSON.
  // Haiku now emits a thinking block per V.129a, and JSON.parse on the
  // whole response would fail. The fence-cleanup and curly-extraction
  // downstream still work because <thinking> is now stripped at source.
  const _v129Stripped = String(rawText)
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<thinking>[\s\S]*$/i, '') // unclosed thinking → drop trailing
    .replace(/<\/?thinking>/gi, '')      // bare tags → drop
    .trim();
  const cleaned = _v129Stripped.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    console.warn(`[${VERSION}] JSON parse failed: ${e.message}; raw-first-200="${rawText.slice(0, 200)}"`);
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    console.warn(`[${VERSION}] V.112-DIAG parsed-not-object; raw-first-300=${String(rawText).slice(0, 300).replace(/\n/g,'\\n')}`);
    return null;
  }

  const canonical = (typeof parsed.canonical_search_string === 'string' && parsed.canonical_search_string.trim())
    ? parsed.canonical_search_string.trim().slice(0, 200) : null;
  if (!canonical) {
    // V.112 — diagnostic: when Haiku returns JSON but with no/empty canonical_search_string,
    // log the keys + a stringified preview so we can see exactly what shape it's returning.
    // This reveals whether Haiku is (a) emitting {"error":...} (b) emitting null canonical
    // (c) emitting a confidence:low payload that should be passed through anyway, etc.
    try {
      const _keys = Object.keys(parsed).join(',');
      const _canonRaw = JSON.stringify(parsed.canonical_search_string);
      const _conf = JSON.stringify(parsed.confidence);
      const _alts = Array.isArray(parsed.alternatives_array) ? parsed.alternatives_array.length : null;
      const _preview = JSON.stringify(parsed).slice(0, 400).replace(/\n/g,'\\n');
      console.warn(`[${VERSION}] V.112-DIAG no-canonical; keys=[${_keys}] canonical=${_canonRaw} confidence=${_conf} alts_len=${_alts} parsed-first-400=${_preview}`);
    } catch (_) { /* never break the parse path on a logging error */ }
    return null;
  }

  const confidence = ['high','medium','low'].includes(parsed.confidence) ? parsed.confidence : 'low';
  // V.110 — confidence_score 0-100. Defensive: derive from enum when missing
  // (high≈92, medium≈65, low≈30) so cached pre-V.110 responses still have a number.
  const _scoreFromEnum = confidence === 'high' ? 92 : confidence === 'medium' ? 65 : 30;
  const confidence_score = (typeof parsed.confidence_score === 'number'
    && parsed.confidence_score >= 0
    && parsed.confidence_score <= 100)
    ? Math.round(parsed.confidence_score)
    : _scoreFromEnum;
  // V.110 — market_status. Strict enum; null is the honest "doesn't apply" answer
  // (grocery, no-name, generic items where lifecycle is meaningless).
  const market_status = ['Current Model','Replaced','Discontinued','Pre-release'].includes(parsed.market_status)
    ? parsed.market_status
    : null;
  const alternative = (confidence !== 'high' && typeof parsed.alternative_string === 'string' && parsed.alternative_string.trim())
    ? parsed.alternative_string.trim().slice(0, 200) : null;
  // Wave HH — extract alternatives_array (0-2 extra candidates) when low/medium confidence
  let alternatives_array = [];
  let alternatives_meta = [];
  if (confidence !== 'high' && Array.isArray(parsed.alternatives_array)) {
    alternatives_array = parsed.alternatives_array
      .filter(s => typeof s === 'string' && s.trim().length > 0)
      .map(s => s.trim().slice(0, 200))
      .slice(0, 3); // Wave HH.1 — up to 3 alternatives so vague brand+category queries get full 4-candidate disambig
    // Wave KK — extract alternatives_meta (parallel array) for disambig cost-per-unit + tier rendering
    if (Array.isArray(parsed.alternatives_meta)) {
      alternatives_meta = parsed.alternatives_meta.slice(0, alternatives_array.length).map(m => {
        if (!m || typeof m !== 'object') return null;
        const price = (typeof m.typical_price_gbp === 'number' && m.typical_price_gbp > 0 && m.typical_price_gbp < 10000)
          ? Number(m.typical_price_gbp.toFixed(2)) : null;
        const pack = (typeof m.pack_size === 'string' && m.pack_size.trim()) ? m.pack_size.trim().slice(0, 40) : null;
        const tier = ['Premium','Mid-tier','Budget'].includes(m.tier_label) ? m.tier_label : null;
        // V.103 — extract intent_label, rationale, est_price_range
        const intent = ['Best Value','Top Reviewed','Premium Choice'].includes(m.intent_label) ? m.intent_label : null;
        const rationale = (typeof m.rationale === 'string' && m.rationale.trim())
          ? m.rationale.trim().slice(0, 140) : null;
        const range = (typeof m.est_price_range === 'string' && m.est_price_range.trim())
          ? m.est_price_range.trim().slice(0, 24) : null;
        // V.131 — extract description + tag fields for Curator Protocol.
        // description: 12-22 word factual subtitle (160-char hard cap)
        // tag: short UPPERCASE category label, ≤14 chars (e.g. HEADPHONES, VACUUM)
        const description = (typeof m.description === 'string' && m.description.trim())
          ? m.description.trim().slice(0, 160) : null;
        const tagRaw = (typeof m.tag === 'string' && m.tag.trim()) ? m.tag.trim() : null;
        const tag = tagRaw ? tagRaw.toUpperCase().replace(/[^A-Z0-9 &/+-]/g, '').slice(0, 14) : null;
        if (!price && !pack && !tier && !intent && !rationale && !range && !description && !tag) return null;
        return {
          intent_label: intent,
          rationale: rationale,
          typical_price_gbp: price,
          est_price_range: range,
          pack_size: pack,
          tier_label: tier,
          description: description, // V.131 — punchy 12-22 word product subtitle
          tag: tag,                 // V.131 — UPPERCASE category tag (HEADPHONES, etc.)
        };
      });
    }
  }
  let category = ['tech','home','toys','diy','beauty','grocery','health','generic'].includes(parsed.category) ? parsed.category : 'generic';
  // v3.4.5q Wave F.1 — keyword-driven category override (defense-in-depth).
  // Beta finding 6 May 2026: Listerine snap returned with Currys/JL in alternatives, meaning Haiku
  // categorised it as 'home' or 'tech' instead of 'health'. Frontend CATEGORY_MAP routes by category
  // so a wrong category sends the user to the wrong retailers. This override catches misclassified
  // brands BEFORE they reach the routing layer. Updated as new mismatches are found.
  const _catKeywords = {
    // Wave II — brand whitelist expanded ~12 -> ~70 entries. Catches Vision
    // miscategorisations BEFORE they reach CATEGORY_MAP retailer routing.
    health:  /\b(listerine|colgate|sensodyne|oral[\s-]?b|corsodyl|macleans|aquafresh|pearl\s*drops|duraphat|nurofen|ibuprofen|paracetamol|panadol|calpol|gaviscon|rennie|berocca|centrum|vitamin|supplement|mouthwash|toothpaste|toothbrush|sudocrem|savlon|germolene|piriton|piriteze|voltarol|deep\s*heat|tcp|optrex|lemsip|strepsils|olbas|covonia|benadryl|clarityn)\b/i,
    beauty:  /\b(l['\u2019]?oreal|aveda|aesop|cowshed|the\s*ordinary|drunk\s*elephant|sol\s*de\s*janeiro|nivea|olay|garnier|maybelline|max\s*factor|rimmel|estee?\s*lauder|clinique|elemis|liz\s*earle|simple|cetaphil|cerave|la\s*roche[\s-]?posay|vichy|kerastase|matrix|wella|tresemme|pantene|head\s*&?\s*shoulders|aussie|herbal\s*essences|dove|palmolive|neutrogena|aveeno|no7|soap\s*and\s*glory|rituals|origins|charlotte\s*tilbury|fenty|nars|urban\s*decay|benefit|too\s*faced|shampoo|conditioner|moisturi[sz]er|serum|hand\s*(cream|wash|balm)|hair\s*(dry|straightener)|fragrance|perfume|aftershave)\b/i,
    grocery: /\b(heinz|kellogg|nestle|cadbury|walkers|pringles|coca[\s-]?cola|pepsi|robinsons|tetley|pg\s*tips|yorkshire\s*tea|twinings|lipton|lurpak|country\s*life|philadelphia|ben\s*and\s*jerry|magnum|haagen[\s-]?dazs|birds\s*eye|mccain|warburton|hovis|kingsmill|mcvitie|tunnocks|mr\s*kipling|kit\s*kat|aero|galaxy|wispa|twirl|flake|fanta|sprite|lucozade|red\s*bull|monster|innocent|tropicana|highland\s*spring|evian|volvic|baked\s*beans|cereal|biscuit|crisps|fizzy|squash|teabag)\b/i,
    tech:    /\b(apple|samsung|sony|bose|jbl|sennheiser|sonos|anker|logitech|razer|corsair|hyperx|steelseries|dell|hp|lenovo|asus|acer|msi|microsoft\s*surface|google\s*pixel|oneplus|xiaomi|fitbit|garmin|withings|kindle|fire\s*tablet|airpods|ps5|playstation|xbox|nintendo|switch)\b/i,
    home:    /\b(ninja\s+(af|bl|bn|fg|os|sf)|smeg|dualit|kenwood|breville|delonghi|de'longhi|krups|nespresso|tassimo|dolce\s*gusto|le\s*creuset|lodge|tefal|cuisinart|kitchenaid|magimix|nutribullet|vitamix|shark|bissell|miele|hoover|vax|sebo|henry\s*hoover|russell\s*hobbs|morphy\s*richards|swan|vonshef|salter|hotpoint|aeg|electrolux|whirlpool|beko|indesit)\b/i,
    diy:     /\b(dewalt|de[\s-]?walt|makita|milwaukee|stanley|black\s*&?\s*decker|black[\s-]?and[\s-]?decker|einhell|ryobi|festool|hilti|karcher|nilfisk|stihl|husqvarna|flymo|qualcast|webb|mountfield|cobra|hayter)\b/i,
    toys:    /\b(lego|playmobil|hasbro|mattel|fisher[\s-]?price|barbie|hot\s*wheels|nerf|monopoly|cluedo|risk|trivial\s*pursuit|scrabble|jigsaw\s*puzzle|board\s*game)\b/i,
  };
  if (canonical) {
    for (const [cat, rx] of Object.entries(_catKeywords)) {
      if (rx.test(canonical)) {
        if (category !== cat) {
          parsed._category_override = { from: category, to: cat, by: 'keyword' };
          category = cat;
        }
        break;
      }
    }
  }
  const mpn = (typeof parsed.mpn === 'string' && parsed.mpn.trim()) ? parsed.mpn.trim().slice(0, 100) : null;
  const amazonQ = (typeof parsed.amazon_search_query === 'string' && parsed.amazon_search_query.trim())
    ? parsed.amazon_search_query.trim().slice(0, 200) : (mpn || canonical);

  const ss = parsed.savvey_says && typeof parsed.savvey_says === 'object' ? parsed.savvey_says : {};
  const ssStr = (v) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 200) : null;
  const savvey_says = {
    typical_price_range: null, // PANEL KILL 4 May 2026 — superseded by live_amazon_price
    live_amazon_price:   null, // populated by handler from verified_amazon_price
    used_amazon_price:   null, // populated by handler from verified_amazon_price.used_price_str
    amazon_rating:       null, // v3.3.3 — populated by handler from verified rating + reviews
    price_take:          null, // v3.3.4 — populated by handler from second Haiku call grounded by verified price
    verdict:             null, // v3.4.0 — populated by handler: good_buy | fair | wait | check_elsewhere
    timing_advice:       ssStr(ss.timing_advice),
    consensus:           ssStr(ss.consensus),
    confidence:          ['high','medium','low'].includes(ss.confidence) ? ss.confidence : 'low',
  };

  // V.146 — variant-family backstop. If Haiku ignored the prompt rule
  // and gave us a single-variant canonical for a known family with empty
  // alternatives_array, synthesise the variant list and downgrade confidence
  // to 'medium' so the V.139 disambig gate fires and the user gets to choose.
  let _v146FamilyApplied = false;
  if (alternatives_array.length < 2) {
    const _famVariants = _v146DetectVariantFamily(canonical);
    if (_famVariants && _famVariants.length >= 2) {
      alternatives_array = _famVariants.slice(0, 3);
      alternatives_meta = []; // mega-synth will populate blurbs from these
      _v146FamilyApplied = true;
      console.log(`[${VERSION}] V.146 family backstop applied: "${canonical}" -> ${alternatives_array.join(' | ')}`);
    }
  }
  // V.146 — when family backstop fires AND Haiku said 'high', downgrade
  // to 'medium' so the V.139 disambig gate doesn't short-circuit.
  const _finalConfidence = (_v146FamilyApplied && confidence === 'high') ? 'medium' : confidence;

  // V.163 — extract the AI-generated identity_fingerprint. This is the
  // dynamic, per-query non-negotiable identifier list the AI emitted in
  // the Haiku canonicalisation call. Strictly validated — only strings
  // up to 30 chars, max 4 entries. Empty array is a valid signal that
  // the canonical itself is generic (e.g. "Kettle") and no identity
  // filter should be applied downstream.
  let identity_fingerprint = [];
  if (Array.isArray(parsed.identity_fingerprint)) {
    identity_fingerprint = parsed.identity_fingerprint
      .filter(s => typeof s === 'string')
      .map(s => s.trim())
      .filter(s => s.length >= 1 && s.length <= 30)
      .slice(0, 4);
  }

  // V.169 — extract the AI-generated predicted_price_floor_gbp. This is
  // the world-knowledge anchor against accessory-spam Best Prices. The
  // backend uses 0.40 × this value as the implausibility threshold: if
  // links[0].price_gbp < threshold, the whole stack is dropped as
  // category_price_implausible. Strictly validated as a positive integer
  // (or 0 to opt out for ultra-generic categories like "Kettle").
  let predicted_price_floor_gbp = 0;
  if (typeof parsed.predicted_price_floor_gbp === 'number' &&
      isFinite(parsed.predicted_price_floor_gbp) &&
      parsed.predicted_price_floor_gbp >= 0 &&
      parsed.predicted_price_floor_gbp < 100000) {
    predicted_price_floor_gbp = Math.round(parsed.predicted_price_floor_gbp);
  }

  return {
    canonical_search_string: canonical,
    confidence: _finalConfidence,
    confidence_score, // V.110 — numeric 0-100, defensively derived from enum if Haiku omitted it
    market_status,    // V.110 — Current Model | Replaced | Discontinued | Pre-release | null
    alternative_string: alternative,
    alternatives_array, // Wave HH (+ V.146 family backstop)
    alternatives_meta, // Wave KK — typical_price_gbp + pack_size + tier_label per candidate
    category,
    mpn,
    amazon_search_query: amazonQ,
    savvey_says,
    identity_fingerprint, // V.163 — AI-generated false-positive shield tokens
    predicted_price_floor_gbp, // V.169 — AI-generated Reality Anchor (£ integer; 0 = skip check)
    _v146_family_applied: _v146FamilyApplied, // diagnostic
  };
}

// Wave FF — server-side specificity heuristic. Used by the frontend to decide
// whether to commit to a result page or route to disambig with the user's snap
// visible. The Nespresso miss (7 May beta) was a generic "Krups Nespresso U"
// landing on a result screen with the user's own snap as hero image — confidence-
// knock. With this flag set on the response, the frontend can route brand_only
// reads to disambig instead of a half-baked result.
//   "specific"   = canonical has model identifier (digits, "Pro/Max/Ultra/SE",
//                  3+ tokens after brand, or an MPN was extracted)
//   "brand_only" = canonical is brand + generic family, no model token
function assessSpecificity(canonical, mpn, confidence) {
  if (!canonical) return 'unknown';
  if (mpn && String(mpn).trim()) return 'specific';
  const stripped = String(canonical).trim();
  if (/\d/.test(stripped)) return 'specific';
  const tokens = stripped.split(/\s+/).filter(t => t.length > 1);
  if (tokens.length >= 4) return 'specific';
  if (/\b(pro|max|ultra|plus|mini|se|elite|premium|deluxe|essentials?|gen[\s-]?\d+)\b/i.test(stripped)) return 'specific'; // Wave II.2 — dropped 'air' (false-positive on 'Air Fryer')
  if (confidence === 'low') return 'brand_only';
  return tokens.length <= 2 ? 'brand_only' : 'specific';
}

// Wave KK — Layer 2 server-side safety sanitiser. Post-Vision canonical blacklist
// catches cases where Haiku tried to identify something that ISN'T a product
// (person, political symbol, drug, weapon, sensitive content). Layer 1 is
// Haiku's built-in safety which catches most upstream; this is defense-in-depth.
// On a hit, handler returns a clean redirect signal — frontend bounces to home
// with a friendly "not a product" toast (no shaming, no abusive labels).
const _SAFETY_BLOCK_RX = /\b(person|man|woman|child|baby|infant|toddler|face|portrait|selfie|naked|nude|breast|genital|penis|vagina|swastika|nazi|isis|terrorist|bomb|grenade|gun|pistol|rifle|knife|machete|cocaine|heroin|methamphet|cannabis|marijuana|weed|crack|opioid|fentanyl|noose|hanging|suicide|self[\s-]?harm|blood|gore|corpse|dead body|wound|injury)\b/i;
function _shouldSafetyBlock(canonical) {
  if (!canonical || typeof canonical !== 'string') return false;
  return _SAFETY_BLOCK_RX.test(canonical);
}

// Wave FF.1 — SerpAPI google_shopping engine call (permissive parser).
//
// HOTFIX over Wave FF: the original parser tried to extract direct merchant
// URLs from response.shopping_results[].link, but SerpAPI google_shopping
// returns Google `aclk` redirect URLs (host = google.com) which the hostname
// allow-list rejected -> retailer_deep_links empty on every fresh query.
//
// The Wave CC code comment in fetchVerifiedAmazonPrice explained this trap;
// I missed it. Switching to the merchant identity in `source` / `seller_name`
// (string field) and accepting the aclk URL as-is. Aclk redirects DO bounce
// the user to the merchant PDP, just via Google's click tracker. For non-
// Amazon retailers we don't care about affiliate-tag propagation, so this is
// fine. Vincent UX goal preserved: tap a retailer chip -> land on product
// page (one extra redirect hop, invisible to user).
//
// Returns a map of canonical retailer keys (e.g. 'currys.co.uk',
// 'johnlewis.com') -> { url, title, price }. Canonical key derives from
// seller_name via _SELLER_NAME_TO_HOST. Items with unknown sellers are
// dropped (still no random aggregator junk).
const GOOGLE_SHOPPING_TIMEOUT_MS = 3500; // V.193 — Ruthless circuit breaker. Was 8000ms; Panel mandate is "partial stack in 3.5s beats complete stack in 8s". Any competitor we don't have by 3.5s is dropped; the frontend gracefully renders Amazon + whatever else returned.
const _SELLER_NAME_TO_HOST = (() => {
  const m = new Map();
  const add = (host, ...names) => names.forEach(n => m.set(n.toLowerCase(), host));
  add('currys.co.uk', 'Currys', 'Currys PC World');
  add('johnlewis.com', 'John Lewis', 'John Lewis & Partners', 'JohnLewis');
  add('argos.co.uk', 'Argos');
  add('boots.com', 'Boots', 'Boots UK');
  add('tesco.com', 'Tesco', 'Tesco Groceries', 'Tesco UK');
  add('sainsburys.co.uk', "Sainsbury's", 'Sainsburys');
  add('asda.com', 'Asda', 'ASDA Groceries');
  add('morrisons.com', 'Morrisons');
  add('waitrose.com', 'Waitrose', 'Waitrose & Partners');
  add('ocado.com', 'Ocado');
  add('diy.com', 'B&Q', 'B&Q DIY');
  add('screwfix.com', 'Screwfix');
  add('wickes.co.uk', 'Wickes');
  add('toolstation.com', 'Toolstation');
  add('halfords.com', 'Halfords');
  add('very.co.uk', 'Very', 'Very.co.uk');
  add('ao.com', 'AO', 'AO.com', 'ao.com');
  add('next.co.uk', 'Next');
  add('marksandspencer.com', 'M&S', 'Marks & Spencer', 'Marks and Spencer');
  add('superdrug.com', 'Superdrug');
  add('lookfantastic.com', 'Lookfantastic', 'LookFantastic');
  add('space.nk.com', 'Space NK');
  add('cultbeauty.co.uk', 'Cult Beauty', 'CultBeauty');
  add('wiggle.com', 'Wiggle');
  add('sigmasports.com', 'Sigma Sports');
  add('evanscycles.com', 'Evans Cycles', 'EvansCycles');
  add('chainreactioncycles.com', 'Chain Reaction Cycles', 'ChainReactionCycles');
  add('pets-at-home.com', 'Pets at Home', 'PetsAtHome');
  add('zooplus.co.uk', 'Zooplus', 'zooplus');
  add('smyths-toys.com', 'Smyths Toys', 'Smyths');
  add('theentertainer.com', 'The Entertainer');
  add('lego.com', 'LEGO', 'LEGO Shop');
  add('apple.com', 'Apple');
  add('samsung.com', 'Samsung');
  add('dell.com', 'Dell');
  add('hp.com', 'HP', 'HP Store');
  add('lenovo.com', 'Lenovo');
  add('microsoft.com', 'Microsoft');
  add('ikea.com', 'IKEA', 'Ikea');
  add('dunelm.com', 'Dunelm');
  add('wayfair.co.uk', 'Wayfair');
  add('made.com', 'Made.com', 'MADE');
  return m;
})();
function _resolveSeller(item) {
  const candidates = [item.source, item.seller_name, item.merchant && item.merchant.name].filter(Boolean);
  for (const raw of candidates) {
    const key = String(raw).trim().toLowerCase();
    if (_SELLER_NAME_TO_HOST.has(key)) return _SELLER_NAME_TO_HOST.get(key);
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// V.163 — STRICT IDENTITY ENFORCEMENT
// ═══════════════════════════════════════════════════════════════════════
// Panel mandate: Google Shopping's fuzzy search surfaces near-misses for
// keyword-stuffed merchant titles. "Canon EOS R6 Mark II" was matching
// listings for the cheaper "Canon EOS RP" and "Canon EOS R5". Their prices
// then corrupted the median and the wrong product won the Best Price Crown.
//
// Algorithm — extract canonical "must-match" tokens (model numbers,
// generations, distinctive suffixes), then require ALL of them to be
// present (word-bound, case-insensitive) in item.title before the item
// can enter the pricing pipeline.
//
// Token classes that qualify as "must-match":
//   - Any token containing a digit  (R6, AF180UK, V15, 4K, GR3X)
//   - Roman numerals                 (II, III, IV, V, VI…)
//   - Distinctive product markers    (Pro, Max, Plus, Mini, Lite, Ultra)
// Plain English nouns ("Canon", "Camera", "Body") are NOT required to
// match — those are common to every result and would over-prune.
//
// Roman-numeral matching is generation-aware: "II" matches "II", "Mark II",
// "Mk II", "Mark 2", "Mk 2", and bare "2" when it's a word on its own.
// "Mark II" alone matches "II", "Mark II", "Mk II", "Mark 2", "Mk 2".
// ─────────────────────────────────────────────────────────────────────
const _V163_ROMAN_TO_ARABIC = { II:2, III:3, IV:4, V:5, VI:6, VII:7, VIII:8, IX:9, X:10 };
const _V163_NOISE_WORDS = new Set([
  'mark','mk','ed','edition','version','model','series','gen','generation',
  'and','the','with','for','of','in','on','at','by','to','from',
]);

function _v163ExtractCanonicalTokens(canonical) {
  if (!canonical || typeof canonical !== 'string') return [];
  const tokens = [];
  const seen = new Set();
  // Split on any non-alphanumeric (so "EOS R6 Mark II" → ['EOS','R6','Mark','II']).
  const words = canonical.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const w of words) {
    const wU = w.toUpperCase();
    if (seen.has(wU)) continue;
    if (_V163_NOISE_WORDS.has(w.toLowerCase())) continue;
    const isRoman = /^(II|III|IV|V|VI|VII|VIII|IX|X)$/.test(wU);
    const hasDigit = /\d/.test(w);
    const isMarker = /^(Pro|Max|Plus|Mini|Lite|Ultra|Sport|Premium|Air|Slim|Light|Pure|Black|White|Silver)$/i.test(w);
    if (hasDigit || isRoman || isMarker) {
      seen.add(wU);
      tokens.push({ raw: w, isRoman, hasDigit, isMarker });
    }
  }
  return tokens;
}

function _v163ItemMatchesIdentity(title, requiredTokens) {
  if (!requiredTokens || requiredTokens.length === 0) return { pass: true, missing: [] };
  if (!title || typeof title !== 'string') return { pass: false, missing: ['(no_title)'] };
  const T = title;
  const missing = [];
  for (const tok of requiredTokens) {
    let matched = false;
    // V.163b — generation/iteration tokens (Mark II, Mk 2, 2nd Gen, II, etc.)
    // Recognise the AI's natural phrasing AND the merchant's common shorthand.
    // A fingerprint of "Mark II" should accept all of: "Mark II", "Mk II",
    // "Mark 2", "Mk 2", "II", "2" (bare standalone digit/numeral).
    const markRomanMatch = tok.raw.match(/^(?:Mark|Mk)\s+(II|III|IV|V|VI|VII|VIII|IX|X|\d+)$/i);
    if (markRomanMatch) {
      const tail = markRomanMatch[1].toUpperCase();
      const arab = _V163_ROMAN_TO_ARABIC[tail] || (/^\d+$/.test(tail) ? Number(tail) : null);
      const alternates = [tail];
      if (arab && !alternates.includes(String(arab))) alternates.push(String(arab));
      // Build a regex that accepts:
      //   (Mark|Mk)\s*<roman|arab>   ← explicit phrasing
      //   \b<roman|arab>\b            ← bare shorthand the merchant used
      const escAlts = alternates.join('|');
      const rx = new RegExp(
        '(?:Mark|Mk)\\s*(?:' + escAlts + ')\\b' +
        '|' +
        '\\b(?:' + escAlts + ')\\b',
        'i'
      );
      matched = rx.test(T);
    } else if (tok.isRoman) {
      const romanU = tok.raw.toUpperCase();
      const arab = _V163_ROMAN_TO_ARABIC[romanU];
      const romanRx = new RegExp('\\b' + romanU + '\\b', 'i');
      const arabRx  = arab ? new RegExp('\\b' + arab + '\\b') : null;
      const markRx = new RegExp(
        '(?:Mark|Mk)\\s*0*(?:' + romanU + (arab ? ('|' + arab) : '') + ')\\b',
        'i'
      );
      matched = romanRx.test(T) || (arabRx && arabRx.test(T)) || markRx.test(T);
    } else {
      // V.164 — STORAGE / UNIT WHITESPACE TOLERANCE. Real-world merchant
      // titles write storage as both "256GB" and "256 GB" (also "1TB" /
      // "1 TB", "415g" / "415 g", "1.7L" / "1.7 L"). The fingerprint and
      // title can disagree on whitespace presence yet refer to the same
      // SKU. Detect the storage/unit shape and emit a flexible regex that
      // accepts either spacing.
      const _v164StorageMatch = tok.raw.match(/^(\d+(?:\.\d+)?)\s*(GB|MB|TB|KB|G|L|ML|KG|MG|MM|CM|M|PC|PCS|PACK)$/i);
      if (_v164StorageMatch) {
        const num  = _v164StorageMatch[1];
        const unit = _v164StorageMatch[2];
        // `\b<num>\s*<unit>\b` — `\s*` allows 0..N whitespace between
        // number and unit, so "256GB" and "256 GB" both pass.
        const rx = new RegExp('\\b' + num.replace(/\./g, '\\.') + '\\s*' + unit + '\\b', 'i');
        matched = rx.test(T);
      } else {
        // Alphanumeric model token — word-bound, case-insensitive.
        // Multi-word phrases (e.g. "iPhone 15", "PlayStation 5") match as a
        // single span — the literal whitespace must be present in the title.
        const esc = tok.raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rx  = new RegExp('\\b' + esc + '\\b', 'i');
        matched = rx.test(T);
      }
    }
    if (!matched) missing.push(tok.raw);
  }
  return { pass: missing.length === 0, missing };
}
async function fetchGoogleShoppingDeepLinks(query, canonicalKey, _diagOut = null, _forceFresh = false, _identityFingerprint = null) {
  // V.156 — diag-write on every bail path. Ensures _v153LocalDiag is
  // ALWAYS populated so the response carries telemetry even when SerpAPI
  // returned 0 results / errored / hit quota / aborted. No more silent
  // blackouts on the response payload.
  const _v156Bail = (reason, extra) => {
    if (_diagOut) Object.assign(_diagOut, {
      examined: 0, kept: 0, priced: 0,
      dropped_no_url: 0, dropped_no_price: 0, dropped_redirector: 0,
      samples: [], dropped_samples: [], raw_samples: [],
      cache_hit: false,
      bail_reason: reason,
      ...(extra || {}),
    });
    return null;
  };
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) return _v156Bail('no_apikey');
  if (!query || typeof query !== 'string' || query.length < 2) return _v156Bail('empty_query');
  const ck = `savvey:retailers:v128:${canonicalKey}`;
  if (!_forceFresh) {
    // V.194 — Cache-first delivery. The KV lookup is the cheapest possible
    // path; we log it explicitly so the Panel can audit hit-rate per query.
    const _v194CacheStart = Date.now();
    const cached = await kvGet(ck);
    const _v194CacheMs = Date.now() - _v194CacheStart;
    if (cached && typeof cached === 'object' && Object.keys(cached).length > 0) {
      try { console.log(`[V.194][cache] HIT key="${canonicalKey.slice(0,60)}" entries=${Object.keys(cached).length} ms=${_v194CacheMs}`); } catch (e) {}
      const _cachedCount = Object.keys(cached).length;
      // V.153 — populate diag for the cache_hit path so we never leak
      // stale module-level state across requests.
      if (_diagOut) Object.assign(_diagOut, {
        examined: _cachedCount,
        kept: _cachedCount,
        priced: Object.values(cached).filter(r => r && r.price_gbp != null).length,
        dropped_no_url: 0,
        dropped_no_price: 0,
        dropped_redirector: 0,
        samples: [],
        dropped_samples: [],
        raw_samples: [],
        cache_hit: true,
      });
      // V.153 SMART CACHE BUSTING — if the cached entry is "poor" (0 or 1
      // competitor that survived), it likely predates a parser improvement.
      // Force a fresh SerpAPI fetch and overwrite the cache.
      const _pricedSurvivors = Object.values(cached).filter(r => r && r.price_gbp != null && Number(r.price_gbp) > 0).length;
      if (_pricedSurvivors < 2) {
        console.log(`[${VERSION}] V.153 poor-cache bust: only ${_pricedSurvivors} priced competitors in cache, forcing fresh fetch for "${query.slice(0,60)}"`);
        // Fall through to the fresh-fetch path below.
      } else {
        return cached;
      }
    } else {
      try { console.log(`[V.194][cache] MISS key="${canonicalKey.slice(0,60)}" ms=${_v194CacheMs}`); } catch (e) {}
    }
  }
  const url = new URL('https://serpapi.com/search.json');
  url.searchParams.set('engine', 'google_shopping');
  url.searchParams.set('q', query.slice(0, 150));
  url.searchParams.set('gl', 'uk');
  url.searchParams.set('hl', 'en');
  url.searchParams.set('api_key', apiKey);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), GOOGLE_SHOPPING_TIMEOUT_MS);
  // V.191 — granular google_shopping timing.
  const _v191GshopStart = Date.now();
  console.log(`[V.191][timer] serpapi.google_shopping START q="${query.slice(0,60)}"`);
  try {
    const r = await fetch(url.toString(), { signal: ac.signal });
    clearTimeout(timer);
    console.log(`[V.191][timer] serpapi.google_shopping DONE ${Date.now()-_v191GshopStart}ms status=${r.status}`);
    if (!r.ok) {
      console.warn(`[${VERSION}] google_shopping HTTP ${r.status} for "${query.slice(0, 60)}"`);
      return _v156Bail('serpapi_http_' + r.status, { http_status: r.status });
    }
    const j = await r.json();
    const results = Array.isArray(j.shopping_results) ? j.shopping_results : [];
    const deepLinks = {};
    let _examined = 0;
    let _droppedNoUrl = 0;
    let _droppedNoPrice = 0;
    let _droppedRedirector = 0;
    let _droppedUsed = 0;       // V.161 — condition !== new
    let _squashedEbay = 0;      // V.161 — eBay dedup count (legacy alias)
    let _droppedIdentity = 0;   // V.163 — strict identity filter
    let _v169EbayQuarantineCount = 0;   // V.169 — eBay items routed to quarantine
    let _v169EbayRescued = false;       // V.169 — was the quarantine promoted?
    const _v169EbayQuarantine = {};     // V.169 — host-keyed quarantine bucket
    const _droppedSamples = [];
    // V.163 — AI-generated identity fingerprint is the PRIMARY source.
    // Haiku emits identity_fingerprint in its canonicalisation response
    // (parsed.identity_fingerprint), the handler threads it down to this
    // call. Each entry becomes a non-negotiable must-match token in every
    // SerpAPI item.title.
    //
    // Deterministic _v163ExtractCanonicalTokens(query) is the FALLBACK,
    // used only if the AI returned an empty/missing fingerprint AND the
    // canonical itself contains model-like tokens. Empty fingerprint on
    // a generic canonical (e.g. "Kettle") legitimately skips the filter.
    let _v163Required = [];
    let _v163Source   = 'none';
    if (Array.isArray(_identityFingerprint) && _identityFingerprint.length > 0) {
      // Convert AI strings into the same { raw, isRoman, hasDigit, isMarker }
      // shape _v163ItemMatchesIdentity already understands. Multi-word
      // entries (e.g. "Mark II", "iPhone 15", "PlayStation 5") are kept as
      // a single token — the matcher uses word-bounded regex so the whole
      // phrase must appear in order.
      for (const raw of _identityFingerprint) {
        if (typeof raw !== 'string') continue;
        const r = raw.trim();
        if (!r) continue;
        const isRoman = /^(II|III|IV|V|VI|VII|VIII|IX|X)$/i.test(r);
        _v163Required.push({
          raw:      r,
          isRoman,
          hasDigit: /\d/.test(r),
          isMarker: /^(Pro|Max|Plus|Mini|Lite|Ultra|Sport|Premium|Air|Slim)$/i.test(r),
        });
      }
      _v163Source = 'ai';
    }
    if (_v163Required.length === 0) {
      _v163Required = _v163ExtractCanonicalTokens(query);
      if (_v163Required.length > 0) _v163Source = 'deterministic_fallback';
    }
    if (_v163Required.length > 0) {
      try { console.log(`[${VERSION}] V.163 identity tokens for "${query.slice(0,60)}" [source=${_v163Source}]: ${_v163Required.map(t => t.raw).join(', ')}`); } catch (e) {}
    }
    // V.164 — EXPANDED USED/REFURB REGEX. The HP ProBook £255 Cash Generator
    // case proved V.161's regex was missing real-world condition markers.
    // Expanded vocabulary: 'used', 'refurb*', 'pre-owned' (any spacing/case),
    // 'preowned' (compounded), 'second-hand', 'second hand', 'secondhand',
    // 'open box', 'open-box', 'openbox', 'renewed', 'reconditioned',
    // 'previously owned', 'ex-display', 'ex display', 'ex-demo', 'graded',
    // 'CPO' (certified pre-owned), 'A-grade'/'B-grade' (eBay/CEX grading).
    // All case-insensitive via /i.
    const _v164UsedRx = /\b(?:used|refurb(?:ished|ed)?|pre[\-\s]?owned|preowned|second[\-\s]?hand|secondhand|open[\-\s]?box|openbox|renewed|reconditioned|previously\s+owned|ex[\-\s]?display|ex[\-\s]?demo|graded|cpo|certified\s+pre[\-\s]?owned|[abc][\-\s]?grade|grade[\-\s]?[abc])\b/i;
    // V.164 — pawn-shop / second-hand specialist domains. These merchants
    // sell almost exclusively used / refurbished electronics. The HP ProBook
    // £255 "Cash Generator" leak slipped past V.161 because the Pre-owned
    // marker was buried in item.title where V.161 wasn't looking. V.164
    // expands the field perimeter AND treats these hosts as condition-guilty
    // by default for electronics queries. The user can still find used
    // gear via eBay (which the V.161 squasher already collapses).
    const _v164PawnShopRx = /\b(?:cash\s*generator|cashgenerator|cash\s*converters|cashconverters|cex|musicmagpie|music\s*magpie|webuyany|envirophone|smartphonechecker|gizmogrind|reboxed|backmarket|back\s*market|swappa|gazelle|decluttr|mazumamobile|gamestop\s*used)\b/i;
    // V.161 alias kept for back-compat (downstream telemetry reads
    // dropped_used; the field name doesn't change).
    const _v161UsedRx = _v164UsedRx;
    // V.144 — FILTER NUKE. Panel mandate: any SerpAPI shopping result with a
    // valid GBP price and a URL is accepted. NO retailer-name map check,
    // NO TLD whitelist (we just reject Google's own redirector hosts), NO
    // strict-seller skip. Host is derived directly from product_link / link;
    // price is parsed via _v143ParsePrice so '£499.99' becomes 499.99 here
    // rather than NaN'ing two functions down the chain. Pretty display name
    // derived from host (game.co.uk → 'Game').
    for (const item of results) {
      _examined++;
      // V.164 — CONDITION FILTER (EXPANDED FIELD PERIMETER).
      // V.161 only checked condition / title / stock_state. The Cash
      // Generator HP ProBook leak proved that's not enough — SerpAPI
      // surfaces "Pre-owned" / "Used" markers in any of:
      //   item.condition       — structured field, usually populated
      //   item.title           — inline marker in the merchant headline
      //   item.snippet         — Google's blurb under the title
      //   item.details         — extra-info block on some cards
      //   item.source          — merchant / seller string
      //   item.seller_name     — alternate seller-string location
      //   item.delivery        — sometimes carries "Pre-owned · Free returns"
      //   item.stock_state     — V.161 original signal
      //   item.merchant.name   — nested merchant identifier
      // V.164 reads all nine and OR's them through the expanded regex.
      const _condParts = [
        item.condition,
        item.title,
        item.snippet,
        item.details,
        item.source,
        item.seller_name,
        item.delivery,
        item.stock_state,
        item.merchant && item.merchant.name,
      ].filter(s => typeof s === 'string' && s.length > 0);
      const _condBlob = _condParts.join(' · ');
      const _matchedUsed   = _v164UsedRx.test(_condBlob);
      const _matchedPawn   = _v164PawnShopRx.test(_condBlob);
      // Pawn-shop hosts are condition-guilty by default. Any item whose
      // source / seller_name / merchant.name matches a known second-hand
      // specialist gets dropped even when no explicit "used" word appears
      // in the title — those merchants only sell pre-owned stock anyway.
      if (_matchedUsed || _matchedPawn) {
        _droppedUsed++;
        if (_droppedSamples.length < 8) {
          const _reason = _matchedUsed ? 'used' : 'pawnshop';
          const _sample = _matchedPawn
            ? (item.source || item.seller_name || (item.merchant && item.merchant.name) || '(no_source)')
            : _condBlob;
          _droppedSamples.push(_reason + ':' + String(_sample).slice(0, 40));
        }
        continue;
      }
      // V.163 — STRICT IDENTITY ENFORCEMENT. Drop any SerpAPI item whose
      // title doesn't contain EVERY canonical must-match token. This is
      // the false-positive shield: "Canon EOS R6 Mark II" required tokens
      // ["R6","II"] reject any title that's missing either — so "Canon
      // EOS RP" (no R6, no II) and "Canon EOS R5" (no R6, no II) drop
      // outright. Empty titles also drop — we can't verify identity
      // without a title and false-positive risk is unacceptable.
      if (_v163Required.length > 0) {
        const _match = _v163ItemMatchesIdentity(item.title, _v163Required);
        if (!_match.pass) {
          _droppedIdentity++;
          if (_droppedSamples.length < 8) {
            _droppedSamples.push(
              'identity:' + (item.title || '(no_title)').slice(0, 38) +
              ' [missing: ' + _match.missing.join(',') + ']'
            );
          }
          continue;
        }
      }
      // Pick the best URL. product_link is the merchant PDP and is preferred;
      // item.link is the Google aclk redirector which still works but is uglier.
      // V.150 — declared with `let` so the redirector-unwrap branch can
      // reassign to the rescued merchant URL.
      let url = item.product_link || item.link;
      if (!url || typeof url !== 'string') {
        _droppedNoUrl++;
        continue;
      }
      // Derive host from URL. We do NOT care about TLD — any merchant is fine.
      let host = null;
      try {
        const u = new URL(String(url));
        host = u.hostname.replace(/^www\./, '').toLowerCase();
      } catch (e) {
        _droppedNoUrl++;
        continue;
      }
      // V.199 — UK AUTHORITY ALLOW-LIST. Positive gate: only hosts on the
      // V199_UK_TRUSTED_HOSTS list (or their subdomains) survive past this
      // point. eBay quarantine runs after — its bucket is exempt from this
      // gate because eBay is the long-tail saviour for groceries / very
      // obscure SKUs (V.169 design). Snapklik, Gedoutlet, Etoren, Snowleader,
      // Telemarkpyrenees, and all non-UK aggregators get dropped here.
      // When the host is a Google product-link (V.150 fallback), we ALSO
      // check the source/seller_name slug against V199_UK_TRUSTED_SOURCE_SLUGS
      // because the real seller identity is in item.source, not in the host.
      const _v201EbayCheck = /\bebay\./i.test(host || '');
      if (!_v201EbayCheck) {
        // V.201 — ONE GATE admission. Single check, single source of truth.
        const _v201Src = (typeof item.source === 'string' && item.source)
                      || (typeof item.seller_name === 'string' && item.seller_name)
                      || (item.merchant && item.merchant.name)
                      || '';
        const _v201Verdict = _v201Admit(host, _v201Src);
        if (!_v201Verdict.admit) {
          if (_droppedSamples.length < 8) {
            _droppedSamples.push(_v201Verdict.reason);
          }
          _droppedRedirector++;
          continue;
        }
      }
      // V.169 — EBAY QUARANTINE (Panel-revised mandate, supersedes the
      // briefly-considered Nuclear Ban).  Any item whose source /
      // seller_name / merchant.name / host carries an "ebay" token is
      // forced into a SEPARATE quarantine map instead of the primary
      // deepLinks map. After the main loop ends, IF AND ONLY IF deepLinks
      // is empty, the cheapest quarantine entry is promoted back into
      // deepLinks to save the long-tail (groceries / discontinued SKUs
      // where eBay is genuinely the only UK indexed source).
      //
      // The cheapest-wins dedup inside the quarantine is identical to the
      // primary path — V.161's host-collapsed eBay logic is preserved,
      // just routed to a different bucket. Zero added network calls,
      // sub-millisecond extra CPU per request, no impact on the 8 s
      // SerpAPI timeout budget.
      const _v169SrcStr = (typeof item.source === 'string' ? item.source : '')
                        + ' ' + (typeof item.seller_name === 'string' ? item.seller_name : '')
                        + ' ' + ((item.merchant && typeof item.merchant.name === 'string') ? item.merchant.name : '');
      const _v169IsEbay = /\bebay\b/i.test(_v169SrcStr) || /\bebay\./i.test(host || '');
      if (_v169IsEbay) {
        // Re-derive a clean eBay host for the quarantine bucket so the
        // cheapest-wins dedup collapses every eBay variant into one entry.
        host = 'ebay.co.uk';
        _v169EbayQuarantineCount++;
        // Apply the same V.146 deep-price extraction the primary path uses,
        // then write to the quarantine map with cheapest-wins semantics.
        const _qPrice = _v146ExtractPrice(item);
        const _qParsed = _qPrice ? _qPrice.price : null;
        if (_qParsed != null) {
          const _existing = _v169EbayQuarantine['ebay.co.uk'];
          if (!_existing || _qParsed < _existing.price_gbp) {
            const _qThumb = (typeof item.thumbnail === 'string' && /^https?:\/\//i.test(item.thumbnail))
              ? item.thumbnail.slice(0, 500)
              : ((typeof item.serpapi_thumbnail === 'string' && /^https?:\/\//i.test(item.serpapi_thumbnail))
                  ? item.serpapi_thumbnail.slice(0, 500)
                  : null);
            _v169EbayQuarantine['ebay.co.uk'] = {
              url:          ((typeof item.product_link === 'string' && item.product_link) || (typeof item.link === 'string' && item.link) || url || '').slice(0, 500),
              title:        typeof item.title === 'string' ? item.title.slice(0, 200) : null,
              price:        _qPrice.raw,
              price_gbp:    _qParsed,
              price_source: _qPrice.source,
              name:         'eBay',
              thumbnail:    _qThumb,
            };
          }
        }
        continue;
      }
      // V.150 — before banning a Google redirector host, attempt to unwrap
      // it (the real merchant URL is wrapped in adurl=/url=/q=/dest=).
      // V.145's blanket ban was dropping ~75% of sponsored cards on hot
      // queries; unwrap rescues them with their actual merchant host.
      const _isGoogleHost = !host
          || host === 'google.com' || host === 'google.co.uk'
          || host === 'google.de'  || host === 'google.fr'
          || host.startsWith('google.')
          || host.endsWith('.google.com')
          || host.endsWith('.google.co.uk')
          || host.endsWith('.googleusercontent.com')
          || host.includes('googleadservices')
          || host.includes('googleshopping')
          || host.includes('aclk')
          || host.includes('doubleclick')
          || host === 'shopping.google.com';
      if (_isGoogleHost) {
        // V.150 — prefer the unwrapped merchant URL when present.
        const _unwrap = _v150UnwrapGoogleRedirect(item.link)
                     || _v150UnwrapGoogleRedirect(item.product_link)
                     || _v150UnwrapGoogleRedirect(url);
        if (_unwrap && _unwrap.host) {
          host = _unwrap.host;
          url = _unwrap.url;
        } else {
          // V.159c — Panel mandate (final). The ONLY thing banned is URL
          // synthesis on our side (V.152 + V.156 paths — already excised in
          // V.159a). SerpAPI google_shopping legitimately returns Google
          // Shopping product URLs of the shape:
          //   google.<tld>/search?ibp=gwp;0,7&q=<title>&prds=pid:<id>
          // These ARE specific product listings (ibp=gwp + prds=pid is
          // Google's product-page protocol — they route to the product, not
          // a generic search results page). Keeping them is correct under
          // the mandate's intent: real merchant-linked URLs that the user
          // can click and reach the product. The display host is re-derived
          // from item.source so the Retailer Stack shows the merchant name
          // (Telemarkpyrenees, Snowleader, etc.) rather than 'google.com'.
          const _candidate = (typeof item.product_link === 'string' && item.product_link)
                          || (typeof item.link === 'string' && item.link)
                          || url
                          || '';
          if (!_candidate) {
            _droppedRedirector++;
            continue;
          }
          // Sanity-check: must parse as a URL. Reject malformed.
          try { new URL(_candidate); } catch (e) {
            _droppedRedirector++;
            continue;
          }
          url = _candidate;
          // Re-derive friendly host from the source string for dedup +
          // display. Without this, every Google-served product collapses
          // to a single 'google.com' dedup key and the Retailer Stack
          // shows only one entry.
          const _srcKey = (typeof item.source === 'string' && item.source)
                       || (typeof item.seller_name === 'string' && item.seller_name)
                       || (item.merchant && typeof item.merchant.name === 'string' && item.merchant.name)
                       || null;
          if (_srcKey) {
            const _slug = _srcKey.toLowerCase()
              .replace(/&/g, 'and')
              .replace(/[^a-z0-9]+/g, '')
              .slice(0, 30);
            if (_slug && _slug.length >= 2) host = _slug + '.via-google';
          }
        }
      }
      // V.146 — deep price extraction. Probes extracted_price, price string,
      // price_range.lower, offers[].price, lowest_price, minimum_price in
      // priority order. Aggregator cards now produce prices via the
      // price_range.lower branch instead of being silently dropped.
      const _v146Extract = _v146ExtractPrice(item);
      const parsedPrice = _v146Extract ? _v146Extract.price : null;
      const rawPrice = _v146Extract ? _v146Extract.raw
                     : (typeof item.price === 'string' ? item.price
                        : (typeof item.extracted_price === 'number' ? item.extracted_price : null));
      const priceSource = _v146Extract ? _v146Extract.source : 'none';
      if (parsedPrice == null) {
        _droppedNoPrice++;
        if (_droppedSamples.length < 5) _droppedSamples.push(host + ':' + String(rawPrice).slice(0, 20));
      }
      // Deduplicate by host (cheapest wins).
      if (deepLinks[host]) {
        const existing = deepLinks[host].price_gbp;
        if (parsedPrice != null && (existing == null || parsedPrice < existing)) {
          // overwrite with cheaper
        } else {
          continue;
        }
      }
      // Display name: from V138_RETAILER_NAMES if mapped, else derive from host.
      const _hostKey = host.split('.')[0]; // 'game.co.uk' → 'game'
      const _mappedName = V138_RETAILER_NAMES[host] || V138_RETAILER_NAMES[_hostKey];
      const displayName = _mappedName
        || (_hostKey.charAt(0).toUpperCase() + _hostKey.slice(1));
      // V.159 — IMAGE EXTRACTION AUDIT. Capture the product thumbnail from
      // every google_shopping item so the long-tail / non-Amazon path has
      // a real image to show in Pillar 1 of the result UI. Previously this
      // field was silently dropped, so anything Amazon didn't verify
      // (Petzl carabiners, Yuzu Kosho paste, niche imports) rendered with
      // a blank placeholder. Defensive — only accept http(s) URLs.
      const _v159Thumb = (typeof item.thumbnail === 'string' && /^https?:\/\//i.test(item.thumbnail))
        ? item.thumbnail.slice(0, 500)
        : (typeof item.serpapi_thumbnail === 'string' && /^https?:\/\//i.test(item.serpapi_thumbnail))
          ? item.serpapi_thumbnail.slice(0, 500)
          : null;
      deepLinks[host] = {
        url:          url.slice(0, 500),
        title:        typeof item.title === 'string' ? item.title.slice(0, 200) : null,
        price:        (typeof rawPrice === 'string' || typeof rawPrice === 'number') ? rawPrice : null,
        price_gbp:    parsedPrice,
        price_source: priceSource,
        name:         displayName,
        thumbnail:    _v159Thumb,
      };
    }
    // V.170 — FINGERPRINT RELAXATION FALLBACK.
    //
    // The V.169 blind audit flagged the "Apple AirPods Pro 2nd Gen USB-C"
    // case: the strict V.163 identity filter dropped every SerpAPI listing
    // because merchant titles abbreviate "2nd Gen" as "2", "2nd", "Gen 2",
    // "Generation 2", etc. — none of which match the literal "2nd Gen"
    // token via the existing word-bound regex.
    //
    // Fallback algorithm (only fires when primary deepLinks is empty AND
    // the strict pass dropped ≥1 identity victim):
    //   - Re-evaluate the SAME results array (no new network call)
    //   - Accept any item whose title matches (requiredTokens.length - 1)
    //     of the N required tokens, instead of all N
    //   - Generation tokens like "2nd Gen", "3rd Gen", "Gen 2" are treated
    //     equivalently via _v170NormalizeGenerationToken
    //   - All other filters (condition, eBay quarantine, URL extraction,
    //     V.150 unwrap, V.145 median floor) still apply
    //   - Counter _v170RelaxedRescuedCount surfaces in diag for audit
    //   - Skipped for N <= 1 (single-token fingerprints already match
    //     "Yorkshire Tea 240" against any "Yorkshire Tea" title; nothing
    //     to relax)
    let _v170RelaxedRescuedCount = 0;
    // V.128 — SCRAPER CHOKEHOLD FIX. Trigger relaxation when survivors < 2
    // (was ===0) AND when only one required token (was >=2). Real-world
    // case: a single-token fingerprint like ["DUR181Z"] paired with a
    // 40-result SerpAPI page where merchants append batteries/charger
    // combos to titles. Previously V.170 only fired with N>=2 required —
    // so single-SKU strimmers / kettles / chargers couldn't get rescued.
    // Now we always fire when strict pass left us with < 2 surviving
    // retailers AND any identity victim was dropped.
    if (Object.keys(deepLinks).length < 2 && _droppedIdentity > 0 && _v163Required.length >= 1) {
      try { console.log(`[${VERSION}] V.170/V.128 fingerprint relaxation fallback firing for "${query.slice(0,60)}" — strict pass dropped ${_droppedIdentity} identity victims, only ${Object.keys(deepLinks).length} primary survivor(s). Allowing (N-1) of ${_v163Required.length} token matches (min 1).`); } catch (e) {}
      // Helper: match an item with relaxed (N-1)-of-N rule. Also expands
      // generation-token equivalence so "2nd Gen" matches "2" / "2nd" /
      // "Gen 2" / "Generation 2".
      const _v170MatchRelaxed = (title, required) => {
        if (!title || typeof title !== 'string') return false;
        const minRequired = Math.max(1, required.length - 1);
        let matched = 0;
        for (const tok of required) {
          const r = _v163ItemMatchesIdentity(title, [tok]);
          if (r.pass) { matched++; continue; }
          // V.170 — generation-token equivalence. "2nd Gen" ≡ "2" ≡ "2nd" ≡
          // "Gen 2" ≡ "Generation 2".
          const _genMatch = tok.raw.match(/^(\d+)(?:st|nd|rd|th)?\s*(?:Gen(?:eration)?)?$/i);
          if (_genMatch) {
            const n = _genMatch[1];
            const ord = n + (n === '1' ? 'st' : n === '2' ? 'nd' : n === '3' ? 'rd' : 'th');
            const rx = new RegExp('\\b(?:' + n + '(?:st|nd|rd|th)?|Gen(?:eration)?\\s*' + n + '|' + ord + '\\s*Gen(?:eration)?)\\b', 'i');
            if (rx.test(title)) { matched++; continue; }
          }
        }
        return matched >= minRequired;
      };
      // Re-loop through the original SerpAPI results array. Skip used /
      // pawn-shop matches (V.164 still applies). Skip eBay (V.169 quarantine
      // already routed those; they don't need a second chance — the
      // quarantine rescue will fire later if deepLinks ends empty).
      // Otherwise relaxed-match the title and run the same URL + price
      // extraction the strict pass would have run.
      for (const item of results) {
        // Skip if already passed strict (V.163 wouldn't have dropped it).
        const _strict = _v163ItemMatchesIdentity(item.title, _v163Required);
        if (_strict.pass) continue;
        // Skip used / refurb / pawn shops.
        const _condParts = [item.condition, item.title, item.snippet, item.details, item.source, item.seller_name, item.delivery, item.stock_state, item.merchant && item.merchant.name].filter(s => typeof s === 'string' && s.length > 0);
        const _condBlob = _condParts.join(' · ');
        if (_v164UsedRx.test(_condBlob) || _v164PawnShopRx.test(_condBlob)) continue;
        // Skip eBay (handled by quarantine).
        const _ebaySrc = (typeof item.source === 'string' ? item.source : '')
                       + ' ' + (typeof item.seller_name === 'string' ? item.seller_name : '')
                       + ' ' + ((item.merchant && typeof item.merchant.name === 'string') ? item.merchant.name : '');
        if (/\bebay\b/i.test(_ebaySrc)) continue;
        // Relaxed match — accept (N-1)-of-N tokens with generation equivalence.
        if (!_v170MatchRelaxed(item.title, _v163Required)) continue;
        // Run the V.150 / price extraction pipeline (compact inline since
        // we can't easily reuse the loop body).
        let _url = item.product_link || item.link;
        if (!_url || typeof _url !== 'string') continue;
        let _host = null;
        try { _host = new URL(String(_url)).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { continue; }
        // Reuse V.150 unwrap for Google hosts.
        const _isGoogle = !_host || /\b(?:google\.|aclk|doubleclick|googleshopping)/i.test(_host) || _host === 'shopping.google.com';
        if (_isGoogle) {
          const _u = _v150UnwrapGoogleRedirect(item.link) || _v150UnwrapGoogleRedirect(item.product_link) || _v150UnwrapGoogleRedirect(_url);
          if (_u && _u.host) { _host = _u.host; _url = _u.url; }
          else {
            // V.159c — keep real SerpAPI URL; re-derive host slug from source.
            const _src = item.source || item.seller_name || (item.merchant && item.merchant.name);
            if (_src) {
              const _slug = String(_src).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '').slice(0, 30);
              if (_slug && _slug.length >= 2) _host = _slug + '.via-google';
            }
          }
        }
        // V.201 — ONE GATE admission applied to the V.170 relaxed pass.
        const _v201RelaxedSrc = item.source || item.seller_name || (item.merchant && item.merchant.name) || '';
        const _v201HostForAdmit = (_host && _host.endsWith('.via-google')) ? 'google.com' : _host;
        const _v201RelaxedVerdict = _v201Admit(_v201HostForAdmit, _v201RelaxedSrc);
        if (!_v201RelaxedVerdict.admit) continue;
        const _px = _v146ExtractPrice(item);
        if (!_px || _px.price == null) continue;
        if (deepLinks[_host]) {
          if (_px.price >= deepLinks[_host].price_gbp) continue;
        }
        const _hostKey = _host ? _host.split('.')[0] : null;
        const _mapped = V138_RETAILER_NAMES[_host] || (_hostKey && V138_RETAILER_NAMES[_hostKey]);
        const _disp = _mapped || (_hostKey ? (_hostKey.charAt(0).toUpperCase() + _hostKey.slice(1)) : 'Retailer');
        deepLinks[_host] = {
          url:          (_url || '').slice(0, 500),
          title:        typeof item.title === 'string' ? item.title.slice(0, 200) : null,
          price:        _px.raw,
          price_gbp:    _px.price,
          price_source: _px.source,
          name:         _disp,
          thumbnail:    (typeof item.thumbnail === 'string' && /^https?:\/\//i.test(item.thumbnail)) ? item.thumbnail.slice(0, 500) : null,
          _v170_relaxed: true,
        };
        _v170RelaxedRescuedCount++;
      }
    }

    // V.199 — SUPER-RELAXED FALLBACK. Fires AFTER V.170 still produces an
    // empty primary stack. Strips size-suffix tokens entirely (e.g. "55",
    // "55 inch") and matches the remaining identity tokens with substring
    // semantics (no word boundary). This rescues flagship TV / monitor SKUs
    // where the merchant packs the size into a joined SKU like
    // "OLED55C34LA" — V.163's strict and V.170's word-bounded relaxation
    // both fail because "55" never appears word-bounded outside the joined
    // SKU, and "C3" is buried in "OLED55C34LA" without word edges.
    let _v199SuperRelaxedRescuedCount = 0;
    if (Object.keys(deepLinks).length === 0 && _v163Required.length >= 2) {
      try { console.log(`[${VERSION}] V.199 super-relaxed fallback firing for "${query.slice(0,60)}" — V.170 produced 0 results, stripping size tokens and matching substrings.`); } catch (e) {}
      // Identify and strip size-suffix tokens (pure digits 32-100, or
      // "<digits> inch"). These represent screen sizes that merchants
      // often embed in joined SKU codes without word boundaries.
      const _v199StrippedTokens = _v163Required.filter(t => {
        if (!t || !t.raw) return false;
        const r = String(t.raw).trim().toLowerCase();
        // Strip pure 2-3 digit size tokens that are likely TV/monitor inches.
        if (/^(?:[23456789]\d|100)$/.test(r)) return false;
        // Strip "55 inch", "55in", "55"" style.
        if (/^\d{2,3}\s*(?:inch|in|"|')$/.test(r)) return false;
        return true;
      });
      if (_v199StrippedTokens.length > 0 && _v199StrippedTokens.length < _v163Required.length) {
        try { console.log(`[${VERSION}] V.199 stripped ${_v163Required.length - _v199StrippedTokens.length} size token(s), now requiring: ${_v199StrippedTokens.map(t=>t.raw).join(', ')}`); } catch (e) {}
      }
      // Substring matcher — no word boundaries. Case-insensitive.
      const _v199SubstrMatch = (title, required) => {
        if (!title || typeof title !== 'string') return false;
        if (required.length === 0) return false;
        const T = title.toLowerCase();
        const minRequired = Math.max(1, required.length - 1);
        let matched = 0;
        for (const tok of required) {
          if (!tok || !tok.raw) continue;
          if (T.indexOf(String(tok.raw).toLowerCase()) !== -1) matched++;
        }
        return matched >= minRequired;
      };
      for (const item of results) {
        if (!item || typeof item !== 'object') continue;
        if (!item.title || typeof item.title !== 'string') continue;
        // Skip items already in deepLinks (host collision).
        // Used / pawn / eBay skip same as V.170.
        const _condParts = [item.condition, item.title, item.snippet, item.details, item.source, item.seller_name, item.delivery, item.stock_state, item.merchant && item.merchant.name].filter(s => typeof s === 'string' && s.length > 0);
        const _condBlob = _condParts.join(' · ');
        if (_v164UsedRx.test(_condBlob) || _v164PawnShopRx.test(_condBlob)) continue;
        const _ebSrc = (typeof item.source === 'string' ? item.source : '') + ' ' + (typeof item.seller_name === 'string' ? item.seller_name : '') + ' ' + ((item.merchant && typeof item.merchant.name === 'string') ? item.merchant.name : '');
        if (/\bebay\b/i.test(_ebSrc)) continue;
        if (!_v199SubstrMatch(item.title, _v199StrippedTokens)) continue;
        let _url = item.product_link || item.link;
        if (!_url || typeof _url !== 'string') continue;
        let _host = null;
        try { _host = new URL(String(_url)).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { continue; }
        // V.201 — ONE GATE admission applied to V.199 super-relaxed pass.
        const _v201SuperSrc = item.source || item.seller_name || (item.merchant && item.merchant.name) || '';
        const _v201SuperVerdict = _v201Admit(_host, _v201SuperSrc);
        if (!_v201SuperVerdict.admit) continue;
        const _v199GoogleHost = _host && (_host === 'google.com' || _host === 'google.co.uk' || _host.startsWith('google.') || _host.endsWith('.google.com'));
        if (_v199GoogleHost) {
          const _u = _v150UnwrapGoogleRedirect(item.link) || _v150UnwrapGoogleRedirect(item.product_link) || _v150UnwrapGoogleRedirect(_url);
          if (_u && _u.host) { _host = _u.host; _url = _u.url; }
        }
        if (deepLinks[_host]) continue;
        const _px = _v146ExtractPrice(item);
        if (!_px || _px.price == null) continue;
        const _disp = (typeof item.source === 'string') ? item.source : (typeof item.seller_name === 'string' ? item.seller_name : ((item.merchant && item.merchant.name) || _host));
        deepLinks[_host] = {
          url:          (_url || '').slice(0, 500),
          title:        item.title.slice(0, 200),
          price:        _px.raw,
          price_gbp:    _px.price,
          price_source: _px.source,
          name:         _disp,
          thumbnail:    (typeof item.thumbnail === 'string' && /^https?:\/\//i.test(item.thumbnail)) ? item.thumbnail.slice(0, 500) : null,
          _v199_super_relaxed: true,
        };
        _v199SuperRelaxedRescuedCount++;
      }
      if (_v199SuperRelaxedRescuedCount > 0) {
        try { console.log(`[${VERSION}] V.199 super-relaxed rescued ${_v199SuperRelaxedRescuedCount} listing(s).`); } catch (e) {}
      }
    }

    // V.169 — EBAY QUARANTINE RESCUE. If the primary deepLinks map is empty
    // after all standard retailers have been filtered, the canonical may
    // genuinely only exist on eBay (groceries / discontinued / vintage).
    // Promote the cheapest quarantine entry into deepLinks so the user
    // gets at least one verified UK source instead of a hard no_match.
    // Only fires when the primary stack would otherwise be zero — when
    // legitimate retailers exist, the quarantine stays sealed.
    if (Object.keys(deepLinks).length === 0 && Object.keys(_v169EbayQuarantine).length > 0) {
      const _eb = _v169EbayQuarantine['ebay.co.uk'];
      if (_eb) {
        deepLinks['ebay.co.uk'] = _eb;
        _v169EbayRescued = true;
        try { console.log(`[${VERSION}] V.169 eBay quarantine rescue fired for "${query.slice(0, 60)}" — promoted cheapest eBay listing £${_eb.price_gbp} (no other UK retailers indexed).`); } catch (e) {}
      }
    }
    const _kept = Object.keys(deepLinks).length;
    const _withPrice = Object.values(deepLinks).filter(r => r.price_gbp != null).length;
    console.log(`[${VERSION}] google_shopping for "${query.slice(0,60)}": examined=${_examined} kept=${_kept} priced=${_withPrice} dropped_no_url=${_droppedNoUrl} no_price=${_droppedNoPrice} redirector=${_droppedRedirector} samples=${_droppedSamples.slice(0,3).join('|')}`);
    // V.144 — stash diagnostic counts on the function so the handler can
    // bubble them to the frontend (_meta.serp_diag) for on-screen transparency.
    // V.146 — richer diagnostic samples. Each surviving deepLink contributes
    // a sample object so the Panel can audit data shape from the response JSON
    // (DevTools Network tab) without needing the Vercel runtime log.
    const _v146Samples = [];
    for (const [host, rec] of Object.entries(deepLinks)) {
      if (_v146Samples.length >= 8) break;
      _v146Samples.push({
        host,
        raw_price: (typeof rec.price === 'string' || typeof rec.price === 'number') ? rec.price : null,
        parsed:    rec.price_gbp,
        source:    rec.price_source || null,
      });
    }
    // V.152 — capture first 3 RAW SerpAPI items (truncated) so the
    // parser can be debugged from the response JSON without log access.
    const _rawSamples = results.slice(0, 3).map(it => {
      if (!it || typeof it !== 'object') return null;
      const trunc = (v, n) => (typeof v === 'string' && v.length > n) ? v.slice(0, n) + '…' : v;
      return {
        title:                 trunc(it.title, 100),
        source:                it.source || null,
        seller_name:           it.seller_name || null,
        merchant_name:         (it.merchant && it.merchant.name) || null,
        link:                  trunc(it.link, 200),
        product_link:          trunc(it.product_link, 200),
        price:                 it.price || null,
        extracted_price:       it.extracted_price || null,
        price_range:           it.price_range || null,
        offers_first:          (Array.isArray(it.offers) && it.offers[0]) || null,
        lowest_price:          it.lowest_price || null,
        minimum_price:         it.minimum_price || null,
        prices:                Array.isArray(it.prices) ? it.prices.slice(0, 3) : null,
        immersive_price:       (it.serpapi_immersive_product && it.serpapi_immersive_product.price) || null,
        sponsored:             it.sponsored || false,
        position:              it.position || null,
        product_id:            it.product_id || null,
        all_fields_present:    Object.keys(it).slice(0, 25),
      };
    }).filter(Boolean);
    const _v153Diag = {
      examined:           _examined,
      kept:               _kept,
      priced:             _withPrice,
      dropped_no_url:     _droppedNoUrl,
      dropped_no_price:   _droppedNoPrice,
      dropped_redirector: _droppedRedirector,
      dropped_used:       _droppedUsed,     // V.161 — used/refurb filter
      squashed_ebay:      _squashedEbay,    // V.161 — eBay squasher dedup count (legacy)
      dropped_identity:   _droppedIdentity, // V.163 — strict identity filter
      identity_tokens:    _v163Required.map(t => t.raw),  // V.163 — what we required
      identity_source:    _v163Source,      // V.163 — 'ai' | 'deterministic_fallback' | 'none'
      ebay_quarantined:   _v169EbayQuarantineCount, // V.169 — eBay items routed to quarantine
      ebay_rescued:       _v169EbayRescued, // V.169 — was the quarantine promoted (primary stack was empty)?
      relaxed_rescued:    _v170RelaxedRescuedCount, // V.170 — items rescued by (N-1) relaxed fingerprint match
      samples:            _v146Samples,
      dropped_samples:    _droppedSamples.slice(0, 8),   // V.163 — wider window for identity drops
      raw_samples:        _rawSamples,
      cache_hit:          false,
    };
    if (_diagOut) Object.assign(_diagOut, _v153Diag);
    // Module-level kept for back-compat callers that haven't migrated yet.
    _lastGoogleShoppingDiag = _v153Diag;
    if (Object.keys(deepLinks).length === 0) return null;
    kvSet(ck, deepLinks, KV_TTL_SECONDS).catch(() => {});
    return deepLinks;
  } catch (err) {
    clearTimeout(timer);
    console.warn(`[${VERSION}] google_shopping fetch error for "${query.slice(0, 60)}":`, err.message);
    const _isAbort = err && (err.name === 'AbortError' || /aborted|timeout/i.test(String(err.message || err)));
    return _v156Bail(_isAbort ? 'network_timeout' : 'network_error', { error: String(err && err.message || err).slice(0, 160) });
  }
}

// v3.4.5n — Open Food Facts lookup. Pre-resolves UK/EU grocery + toiletry
// barcodes to a product name BEFORE Haiku sees them. Lifts Door 3 (Scan)
// accuracy on the in-store-shopping use case. Free, no API key, generous
// rate limit. Returns null on miss / network fail / timeout — caller falls
// through to existing Haiku-from-digits behaviour. Panel-approved 6 May 2026.
async function lookupOpenFoodFacts(ean) {
  if (!ean || typeof ean !== 'string' || !/^\d{8,14}$/.test(ean)) return null;
  const url = `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(ean)}.json`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': `Savvey/${VERSION}` } });
    clearTimeout(timeout);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.status !== 'success' || !j.product) return null;
    const p = j.product;
    const brand = (typeof p.brands === 'string' && p.brands.trim()) ? p.brands.split(',')[0].trim() : '';
    const name  = (typeof p.product_name === 'string' && p.product_name.trim()) ? p.product_name.trim() :
                  (typeof p.product_name_en === 'string' && p.product_name_en.trim()) ? p.product_name_en.trim() : '';
    const qty   = (typeof p.quantity === 'string' && p.quantity.trim()) ? p.quantity.trim() : '';
    const composed = [brand, name, qty].filter(Boolean).join(' ').slice(0, 200);
    return composed || null;
  } catch (err) {
    clearTimeout(timeout);
    return null;
  }
}


// V.73 — Mobile-CLIP V2: when frontend sends category_hint from on-device
// classifier, inject as soft constraint at the END of the Vision tail prompt.
// SOFT (not strict) so misclassifications don't poison high-confidence Haiku
// reads of explicit MPN/brand text on the package. Empirical bias only.
function _buildVisionPromptWithHint(basePrompt, hint) {
  if (!hint || typeof hint !== 'string') return basePrompt;
  const allowed = ['tech','home','toys','diy','beauty','grocery','health','generic'];
  if (!allowed.includes(hint)) return basePrompt;
  if (hint === 'generic') return basePrompt;
  return basePrompt + `

ON-DEVICE CLASSIFIER HINT (soft signal, not authoritative):
The user's phone classifier suggests this image is in the "${hint}" category.
- If readable brand/model on the package matches a different category, TRUST the package text and IGNORE this hint.
- If the package is ambiguous (empty container, partial label, generic packaging), this hint can break ties.
- Do NOT bias category enum solely on this hint without supporting evidence.`;
}

// ═══════════════════════════════════════════════════════════════════════
// V.138 — JS PRICING MATH (Panel mandate: no AI math, never)
// ═══════════════════════════════════════════════════════════════════════
// Pure Node.js arithmetic over already-fetched SerpAPI data. Builds the
// pricing block + the links[] array of the V.138 schema. LLMs hallucinate
// math; this stays deterministic.
const V138_RETAILER_NAMES = {
  'amzn': 'Amazon UK',
  'curr': 'Currys',
  'argo': 'Argos',
  'jl':   'John Lewis',
  'tesc': 'Tesco',
  'sain': "Sainsbury's",
  'ebay': 'eBay',
  // V.161 — full-host alias so the eBay squasher (host:'ebay.co.uk')
  // resolves the friendly name directly without going through _hostKey.
  'ebay.co.uk': 'eBay',
  'bq':   'B&Q',
  'smyt': 'Smyths Toys',
  'scre': 'Screwfix',
  'asda': 'ASDA',
  'mors': 'Morrisons',
  'wait': 'Waitrose',
  'boot': 'Boots',
  'spec': 'Specsavers',
  'next': 'Next',
  'verylink': 'Very',
  'verycta': 'Very',
};
const V138_DELIVERY_NOTES = {
  'amzn': 'Verified live · Prime delivery',
  'curr': 'In stock · Free delivery',
  'argo': 'Same-day collection',
  'jl':   '2-year guarantee included',
  'tesc': 'Tesco Clubcard prices',
  'sain': 'Nectar prices · same-day delivery',
  'ebay': 'New, used, auctions',
  'bq':   'Click & collect',
  'smyt': 'In-store + online',
  'scre': 'Next-day delivery',
  'asda': 'Click & collect',
  'mors': 'Morrisons More',
  'wait': 'Free over £40',
  'boot': 'Advantage Card',
  'spec': '2-pair offers',
  'next': 'Next-day available',
  'verylink': 'Buy-now-pay-later',
  'verycta': 'Buy-now-pay-later',
};

// V.152b — RESCUE UK RETAILERS FROM item.source.
// Empirically (test_suite case B/C/D), SerpAPI's google_shopping returns
// Google-aggregator product_link URLs (www.google.com/search?ibp=...) with
// the actual merchant identity in `item.source` as a free-form string like
// "Amazon.co.uk - Amazon.co.uk-Seller", "Asda George", "eBay - ninja-kitchen".
// V.150 unwrap returned null on these because Google's aggregator URLs don't
// carry the merchant in adurl=/url= params. V.152b resolves the merchant
// from the source string against a known-UK-retailer table and builds a
// search URL on that merchant's domain (PDP isn't recoverable but search
// lands the user on the right merchant for affiliate routing).
const V152_SOURCE_RESOLVERS = [
  { rx: /^amazon/i,              host: 'amazon.co.uk',        name: 'Amazon UK',     pathT: q => '/s?k=' + encodeURIComponent(q) + '&tag=' + encodeURIComponent(AMAZON_TAG), origin: 'https://www.amazon.co.uk' },
  { rx: /currys/i,                host: 'currys.co.uk',        name: 'Currys',        pathT: q => '/search?q=' + encodeURIComponent(q), origin: 'https://www.currys.co.uk' },
  { rx: /argos/i,                 host: 'argos.co.uk',         name: 'Argos',         pathT: q => '/search/' + encodeURIComponent(q) + '/', origin: 'https://www.argos.co.uk' },
  { rx: /asda\s*george|\basda/i,host: 'asda.com',            name: 'ASDA',          pathT: q => '/search/' + encodeURIComponent(q), origin: 'https://direct.asda.com/george' },
  { rx: /\bebay/i,               host: 'ebay.co.uk',          name: 'eBay UK',       pathT: q => '/sch/i.html?_nkw=' + encodeURIComponent(q), origin: 'https://www.ebay.co.uk' },
  { rx: /smyth/i,                 host: 'smythstoys.com',      name: 'Smyths Toys',   pathT: q => '/uk/en-gb/search?text=' + encodeURIComponent(q), origin: 'https://www.smythstoys.com' },
  { rx: /\bgame\b/i,            host: 'game.co.uk',          name: 'Game',          pathT: q => '/en/search?searchTerm=' + encodeURIComponent(q), origin: 'https://www.game.co.uk' },
  { rx: /john\s*lewis/i,         host: 'johnlewis.com',       name: 'John Lewis',    pathT: q => '/search?search-term=' + encodeURIComponent(q), origin: 'https://www.johnlewis.com' },
  { rx: /\bvery\b/i,            host: 'very.co.uk',          name: 'Very',          pathT: q => '/e/q/' + encodeURIComponent(q) + '.end', origin: 'https://www.very.co.uk' },
  { rx: /\bao\b/i,              host: 'ao.com',              name: 'AO',            pathT: q => '/search/?searchTerm=' + encodeURIComponent(q), origin: 'https://ao.com' },
  { rx: /box\.co\.uk|^box(?:\s|$)/i, host: 'box.co.uk',     name: 'Box.co.uk',     pathT: q => '/Shop/SearchResults.aspx?Search=' + encodeURIComponent(q), origin: 'https://www.box.co.uk' },
  { rx: /\btesco/i,              host: 'tesco.com',           name: 'Tesco',         pathT: q => '/groceries/en-GB/search?query=' + encodeURIComponent(q), origin: 'https://www.tesco.com' },
  { rx: /sainsbury/i,             host: 'sainsburys.co.uk',    name: "Sainsbury's",   pathT: q => '/gol-ui/SearchResults/' + encodeURIComponent(q), origin: 'https://www.sainsburys.co.uk' },
  { rx: /screwfix/i,              host: 'screwfix.com',        name: 'Screwfix',      pathT: q => '/search?search=' + encodeURIComponent(q), origin: 'https://www.screwfix.com' },
  { rx: /b\s*&\s*q|^bq\b|diy\.com/i, host: 'diy.com',      name: 'B&Q',           pathT: q => '/search?term=' + encodeURIComponent(q), origin: 'https://www.diy.com' },
  { rx: /halfords/i,              host: 'halfords.com',        name: 'Halfords',      pathT: q => '/search?q=' + encodeURIComponent(q), origin: 'https://www.halfords.com' },
  { rx: /boots/i,                 host: 'boots.com',           name: 'Boots',         pathT: q => '/search?text=' + encodeURIComponent(q), origin: 'https://www.boots.com' },
  { rx: /superdrug/i,             host: 'superdrug.com',       name: 'Superdrug',     pathT: q => '/search?text=' + encodeURIComponent(q), origin: 'https://www.superdrug.com' },
  { rx: /\bnext\b/i,            host: 'next.co.uk',          name: 'Next',          pathT: q => '/search?w=' + encodeURIComponent(q), origin: 'https://www.next.co.uk' },
  { rx: /m\s*&\s*s|marks/i,     host: 'marksandspencer.com', name: 'M&S',           pathT: q => '/l/search?searchTerm=' + encodeURIComponent(q), origin: 'https://www.marksandspencer.com' },
  { rx: /apple\b/i,              host: 'apple.com',           name: 'Apple',         pathT: q => '/uk/search/' + encodeURIComponent(q), origin: 'https://www.apple.com' },
  { rx: /samsung/i,               host: 'samsung.com',         name: 'Samsung',       pathT: q => '/uk/search/searchMain?searchTerm=' + encodeURIComponent(q), origin: 'https://www.samsung.com' },
  { rx: /dyson/i,                 host: 'dyson.co.uk',         name: 'Dyson',         pathT: q => '/search?text=' + encodeURIComponent(q), origin: 'https://www.dyson.co.uk' },
  { rx: /\bao\.com|\bao\.co\.uk/i, host: 'ao.com',        name: 'AO',            pathT: q => '/search/?searchTerm=' + encodeURIComponent(q), origin: 'https://ao.com' },
  { rx: /pcworld/i,               host: 'currys.co.uk',        name: 'Currys',        pathT: q => '/search?q=' + encodeURIComponent(q), origin: 'https://www.currys.co.uk' },
  { rx: /littlewoods/i,           host: 'littlewoods.com',     name: 'Littlewoods',   pathT: q => '/web/search.html?Ntt=' + encodeURIComponent(q), origin: 'https://www.littlewoods.com' },
  { rx: /365\s*games/i,          host: '365games.co.uk',      name: '365 Games',     pathT: q => '/search?q=' + encodeURIComponent(q), origin: 'https://www.365games.co.uk' },
  { rx: /shopto/i,                host: 'shopto.net',          name: 'ShopTo',        pathT: q => '/search/?q=' + encodeURIComponent(q), origin: 'https://www.shopto.net' },
  { rx: /sevenoaks/i,             host: 'ssav.com',            name: 'Sevenoaks',     pathT: q => '/search?keyword=' + encodeURIComponent(q), origin: 'https://www.ssav.com' },
  { rx: /littlewoods/i,           host: 'littlewoods.com',     name: 'Littlewoods',   pathT: q => '/web/search.html?Ntt=' + encodeURIComponent(q), origin: 'https://www.littlewoods.com' },
  { rx: /pro\s*direct/i,         host: 'prodirectsport.com',  name: 'Pro:Direct',    pathT: q => '/search?w=' + encodeURIComponent(q), origin: 'https://www.prodirectsport.com' },
];
// V.156 — UNIVERSAL SOURCE-HOST FALLBACK. When V.152b's hardcoded
// retailer regex table misses (long-tail merchants: Lamp24, MOHD, ShopTo,
// Ocado, Iceland, Crema Coffee, Laptops Direct, etc.), V.156 derives a
// synthetic display host from the cleaned source string and builds a
// Google Shopping search URL filtered to that merchant + product. This
// is the "no retailer left behind" path — replaces the V.144 drop-as-
// redirector behaviour for unrecognised UK merchants.
function _v156UniversalSourceFallback(source, canonical) {
  try {
    if (!source || typeof source !== 'string' || !canonical) return null;
    // Clean the source name. Strip seller suffixes, parenthesised
    // qualifiers, redundant store/marketplace/seller tokens.
    let clean = String(source)
      .replace(/\s*[\-\u2013\u2014|\u00b7\u2022]\s*.*$/i, '')      // strip after dash/pipe
      .replace(/\s*\([^)]*\)\s*/g, '')                                  // strip parens
      .replace(/\s+(?:UK|Ltd|Limited|Inc|Store|Online|Marketplace|Seller|Shop)$/i, '')
      .trim();
    if (!clean || clean.length < 2 || clean.length > 60) return null;
    // Slug for hostname (lowercase alphanumerics only).
    const slug = clean.toLowerCase()
      .replace(/&/g, 'and')
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 30);
    if (!slug || slug.length < 2) return null;
    // Synthetic host. We can't know the actual TLD without an HTTP probe,
    // so we use `<slug>.co.uk` as a sensible UK default. The host is used
    // only as a dedup key + V.138_DELIVERY_NOTES lookup; the actual click
    // target is the Google Shopping search URL below.
    const host = slug + '.co.uk';
    // Build Google Shopping search URL filtered to merchant + product.
    // tbm=shop scopes results to Shopping rather than web; q includes
    // both the merchant name and the canonical so Google's algorithm
    // surfaces the exact listing first.
    const q = encodeURIComponent(clean + ' ' + canonical).slice(0, 250);
    const url = 'https://www.google.co.uk/search?q=' + q + '&tbm=shop';
    return {
      host:  host,
      url:   url,
      name:  clean,
      source: 'v156_universal_fallback',
    };
  } catch (e) {
    return null;
  }
}

function _v152ResolveFromSource(source, canonical) {
  if (!source || typeof source !== 'string' || !canonical) return null;
  for (const r of V152_SOURCE_RESOLVERS) {
    if (r.rx.test(source)) {
      try {
        const url = r.origin + r.pathT(String(canonical).slice(0, 100));
        return { host: r.host, url: url.slice(0, 500), name: r.name };
      } catch (e) { return null; }
    }
  }
  return null;
}

// V.150 — UNWRAP GOOGLE REDIRECTORS. SerpAPI's `item.link` field is the
// Google aclk / adservices redirector for sponsored carousel cards. The
// actual merchant URL is buried in the `adurl=` / `url=` / `q=` / `dest=`
// query parameter. V.145's host-ban dropped these as redirectors, losing
// 30+ sponsored cards on hot-product queries (PS5 Pro, iPhone 16, etc.).
// V.150 unwraps the redirector and returns the real merchant host + URL,
// so the listing flows into the Retailer Stack with its actual brand.
function _v150UnwrapGoogleRedirect(rawUrl) {
  try {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    // Only attempt unwrap on known Google redirector hosts.
    if (!(h.includes('google') || h.includes('aclk') || h.includes('doubleclick'))) {
      return null;
    }
    const wrapped = u.searchParams.get('adurl')
                 || u.searchParams.get('url')
                 || u.searchParams.get('q')
                 || u.searchParams.get('dest')
                 || u.searchParams.get('redirect');
    if (!wrapped) return null;
    let decoded = wrapped;
    try { decoded = decodeURIComponent(wrapped); } catch (e) { /* already decoded */ }
    const w = new URL(decoded);
    const wh = w.hostname.replace(/^www\./, '').toLowerCase();
    // Sanity: the unwrapped host must NOT also be a Google host
    // (some chains nest redirects). Reject if so.
    if (wh.startsWith('google.') || wh.endsWith('.google.com') ||
        wh.endsWith('.google.co.uk') || wh.includes('aclk') ||
        wh.includes('doubleclick') || wh.includes('googleadservices') ||
        wh.endsWith('.googleusercontent.com')) {
      return null;
    }
    return { host: wh, url: w.toString().slice(0, 500) };
  } catch (e) {
    return null;
  }
}

// V.146 — DEEP PRICE EXTRACTION. SerpAPI google_shopping returns three
// classes of shopping_results: (1) direct merchant offers with extracted_price
// + price string, (2) aggregator/comparison cards with no `price` but a
// `price_range.lower` or `lowest_price` field, (3) sponsored carousel cards.
// V.143's _v143ParsePrice handled (1) only — V.146 probes (2) so aggregator
// cards no longer count as unpriced and silently inflate dropped_no_price.
function _v146ExtractPrice(item) {
  // V.147 — full body wrapped in try/catch so any unexpected SerpAPI
  // payload shape (e.g. a non-object in offers[], a nested null) can
  // never crash the handler.
  try {
    if (!item || typeof item !== 'object') return null;
    if (typeof item.extracted_price === 'number' && item.extracted_price > 0) {
      return { price: item.extracted_price, raw: item.price || String(item.extracted_price), source: 'extracted_price' };
    }
    const fromStr = _v143ParsePrice(item.price);
    if (fromStr != null) return { price: fromStr, raw: item.price, source: 'price' };
    if (item.price_range && typeof item.price_range === 'object') {
      const loRaw = item.price_range.lower;
      const lo = (typeof loRaw === 'number') ? loRaw : _v143ParsePrice(loRaw);
      if (lo != null && lo > 0) return { price: lo, raw: 'range_lower:' + lo, source: 'price_range.lower' };
    }
    if (Array.isArray(item.offers) && item.offers.length > 0) {
      for (const offer of item.offers) {
        if (!offer) continue;
        const p = _v143ParsePrice(offer.price);
        if (p != null) return { price: p, raw: offer.price, source: 'offers[].price' };
      }
    }
    const lowest = _v143ParsePrice(item.lowest_price);
    if (lowest != null) return { price: lowest, raw: item.lowest_price, source: 'lowest_price' };
    const minimum = _v143ParsePrice(item.minimum_price);
    if (minimum != null) return { price: minimum, raw: item.minimum_price, source: 'minimum_price' };
    // V.150 — newer SerpAPI shapes seen on flagship-product queries.
    if (item.serpapi_immersive_product && typeof item.serpapi_immersive_product === 'object') {
      const imm = _v143ParsePrice(item.serpapi_immersive_product.price);
      if (imm != null) return { price: imm, raw: item.serpapi_immersive_product.price, source: 'serpapi_immersive_product.price' };
    }
    if (Array.isArray(item.prices) && item.prices.length > 0) {
      for (const pr of item.prices) {
        const p = (typeof pr === 'number') ? pr : _v143ParsePrice(pr);
        if (p != null && p > 0) return { price: p, raw: pr, source: 'prices[]' };
      }
    }
  } catch (e) {
    console.warn(`[${VERSION}] V.147 _v146ExtractPrice exception:`, e && e.message);
  }
  return null;
}

// V.143 — robust price-string parser. SerpAPI google_shopping returns
// `price` as a display-formatted string ('£499.99', '$599', 'EUR 549,99').
// Number() on these returns NaN; this helper strips currency prefixes,
// thousands separators, and trailing notes ('£499.99 + delivery') before
// parsing. Returns null on unparseable input.
function _v143ParsePrice(raw) {
  if (raw == null) return null;
  if (typeof raw === 'number') return (raw > 0 && raw < 1_000_000) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;

  // V.130 — PRICE EXTRACTOR HARDENING.
  //   (a) DROP used/refurb listings entirely. SerpAPI occasionally returns
  //       "Used: £49.99", "Refurbished from £349.00", "Pre-owned £29.99",
  //       "Open Box £199" inline in the price field. These should never
  //       become a "best price" — the user wants new-condition retail.
  //   (b) Strip leading qualifier words ("From", "Now", "Offer:", "Only",
  //       "Save", "Just", "Starting at") so the numeric run extractor can
  //       reach the digits.
  //   (c) Price-range handling ("£49.99 - £59.99"): the first-numeric-run
  //       regex already captures the lower bound, but we want this to be
  //       explicit and audited.
  //   (d) Commas: SerpAPI emits "£1,200" and "£1,200.00" — the European
  //       comma-decimal branch must not misread "£1,200" as 1.200.
  const _v130UsedRx = /\b(?:used|refurb(?:ished)?|pre[\s-]?owned|open[\s-]?box|second[\s-]?hand|grade\s*[a-d]|customer\s*return)\b/i;
  if (_v130UsedRx.test(s)) {
    // Drop entirely — these are not new-retail prices.
    return null;
  }
  // Strip leading qualifier words so the numeric regex isn't fooled by
  // adjacent non-numeric tokens. Multiple sequential qualifiers tolerated.
  s = s.replace(/^\s*(?:from|now|offer:?|only|save|just|starting\s+at|price:?|rrp:?|was)\s+/gi, '').trim();
  // Also strip any inline "from " / "starting at " between currency and digits
  // (some SerpAPI shapes embed it: "£ from 49.99")
  s = s.replace(/\b(?:from|starting\s+at)\s+/gi, '').trim();

  // First, extract the first numeric run (handles '£499.99 + £5.99 delivery',
  // '£49.99 - £59.99' price ranges → 49.99 as lower bound).
  const m = s.match(/(\d{1,3}(?:[, ]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  let num = m[1];

  // V.130 — Comma-vs-decimal disambiguation. UK retail prices use comma as
  // thousands separator ("£1,200.00"). European prices use comma as
  // decimal ("549,99"). Rule:
  //   - If contains BOTH "." and ",": comma is thousands, dot is decimal.
  //     → strip commas. ("1,200.00" → "1200.00")
  //   - If contains ONLY "," followed by exactly 1-2 digits at end: it's
  //     European decimal. ("549,99" → "549.99")
  //   - If contains ONLY "," followed by 3 digits or grouped: thousands.
  //     ("1,200" → "1200")
  //   - Otherwise commas are thousands separators.
  if (num.includes('.') && num.includes(',')) {
    num = num.replace(/,/g, '');
  } else if (!num.includes('.') && /^\d{1,3},\d{1,2}$/.test(num)) {
    // European decimal shape: 1-3 leading digits, comma, 1-2 trailing.
    num = num.replace(',', '.');
  } else {
    // Thousands-comma path.
    num = num.replace(/[, ]/g, '');
  }
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0 || n >= 1_000_000) return null;
  return Number(n.toFixed(2));
}

function _v138BuildPricingAndLinks({ verified_amazon_price, retailer_deep_links, category, canonical, predicted_price_floor_gbp }) {
  const links = [];
  const allPrices = [];

  // (1) Amazon link. V.162 — Panel mandate: Amazon NO LONGER gets an
  // automatic is_primary just for being verified. The Canon R6 Mark II
  // case (Amazon £1,699, Jessops £779 sitting silent below) made the app
  // look like a scam. Math wins. is_primary is now stamped on the cheapest
  // non-outlier survivor AFTER the median sanity floor — see step (3).
  if (verified_amazon_price && Number(verified_amazon_price.price) > 0) {
    const p = Number(verified_amazon_price.price);
    links.push({
      retailer:      'Amazon UK',
      retailer_key:  'amzn',
      is_primary:    false,                  // V.162 — was true
      url:           verified_amazon_price.link || null,
      price_gbp:     p,
      price_str:     verified_amazon_price.price_str || `£${p.toFixed(2)}`,
      stock_state:   'in_stock',
      delivery_note: V138_DELIVERY_NOTES.amzn,
      affiliate:     true,
      amazon_verified: true,                 // retained as a meta flag so the
                                             // UI can still render the "Verified
                                             // live · Prime delivery" subtitle
                                             // on the Amazon card wherever it
                                             // lands in the stack
    });
    allPrices.push(p);
  }

  // (2) Non-Amazon retailers from google_shopping fan-out
  // V.144 — assembler trusts pre-parsed price_gbp from fetchGoogleShoppingDeepLinks.
  // Falls back to _v143ParsePrice on r.price for older cached payloads.
  if (retailer_deep_links && typeof retailer_deep_links === 'object') {
    for (const key of Object.keys(retailer_deep_links)) {
      const r = retailer_deep_links[key];
      if (!r) continue;
      const _url = r.url || r.link || null;
      if (!_url) continue;
      // V.153 — relaxed Amazon dedup. When the retailer stack is sparse
      // (< 2 non-Amazon competitors after this loop), allow 3rd-party
      // Amazon sellers from google_shopping to populate the stack as
      // separate cards. Implemented via a deferred pass after the loop —
      // here we just count them and tag.
      if (typeof key === 'string' && key.toLowerCase().includes('amazon')) {
        // Stash for potential second pass.
        if (!retailer_deep_links.__v153_amazon_extras) retailer_deep_links.__v153_amazon_extras = [];
        retailer_deep_links.__v153_amazon_extras.push({ key, record: r });
        continue;
      }
      // V.144 — prefer pre-parsed price_gbp (set by fetchGoogleShoppingDeepLinks
      // on the way in). Fall back to parsing the raw r.price string for any
      // pre-V.144 cached entries that still have the old shape.
      const p = (r.price_gbp != null && Number(r.price_gbp) > 0)
        ? Number(r.price_gbp)
        : _v143ParsePrice(r.price);
      const _hostKey = (typeof key === 'string') ? key.split('.')[0] : key;
      const retailerName = V138_RETAILER_NAMES[key]
        || V138_RETAILER_NAMES[_hostKey]
        || r.name
        || (typeof _hostKey === 'string' ? (_hostKey.charAt(0).toUpperCase() + _hostKey.slice(1)) : String(key));
      links.push({
        retailer:      retailerName,
        retailer_key:  key,
        is_primary:    false,
        url:           _url,
        price_gbp:     p,
        price_str:     (p != null) ? `£${p.toFixed(2)}` : (typeof r.price === 'string' ? r.price.slice(0, 24) : null),
        stock_state:   'in_stock',
        delivery_note: V138_DELIVERY_NOTES[key] || V138_DELIVERY_NOTES[_hostKey] || null,
        affiliate:     false,
      });
      if (p != null) allPrices.push(p);
    }
  }

  // V.153 — RELAXED AMAZON DEDUP. When the non-Amazon retailer stack is
  // sparse (< 2 cards), promote any stashed 3rd-party Amazon listings to
  // separate cards so the user has comparison context. Label distinctly
  // as "Amazon UK (3rd-party)" so they're not confused for the verified
  // primary listing.
  const _v153NonAmazonLinks = links.filter(l => !l.is_primary).length;
  if (_v153NonAmazonLinks < 2 && retailer_deep_links && retailer_deep_links.__v153_amazon_extras) {
    const extras = retailer_deep_links.__v153_amazon_extras;
    let _addedAmz = 0;
    for (const e of extras) {
      if (_addedAmz >= 3) break;
      const r = e.record;
      const _url = r.url || r.link;
      if (!_url) continue;
      // Skip if this exact URL is already in links (don't double the primary).
      if (links.some(l => l.url === _url)) continue;
      const p = (r.price_gbp != null && Number(r.price_gbp) > 0)
        ? Number(r.price_gbp)
        : _v143ParsePrice(r.price);
      if (p == null) continue;
      links.push({
        retailer:      'Amazon UK (3rd-party)',
        retailer_key:  e.key,
        is_primary:    false,
        url:           _url,
        price_gbp:     p,
        price_str:     `£${p.toFixed(2)}`,
        stock_state:   'in_stock',
        delivery_note: 'Marketplace seller',
        affiliate:     false,
      });
      allPrices.push(p);
      _addedAmz++;
    }
    if (_addedAmz > 0) console.log(`[${VERSION}] V.153 relaxed-dedup: promoted ${_addedAmz} 3rd-party Amazon listings to retailer stack`);
  }
  // Clean up the stash so it doesn't leak into the response.
  if (retailer_deep_links && retailer_deep_links.__v153_amazon_extras) {
    delete retailer_deep_links.__v153_amazon_extras;
  }

  // V.145 — MEDIAN SANITY FLOOR. Panel-mandated outlier rejection.
  // The V.144 "force the absolute cheapest" rule paired with the filter-nuke
  // surfaced a £15.99 PS5 accessory (skin / HDMI cable) as the best_price.
  // Fix: compute the median of all priced listings (Amazon + retailers).
  // Discard any listing where price < 0.5 * median. Then re-pick best_price
  // and recompute avg_market from the surviving cluster. Only applies when
  // we have 3+ priced listings (median is unstable for n<3).
  let _v145Floor = null;
  let _v145Median = null;
  let _v145Outliers = 0;
  let _v195RejectedSample = [];
  if (allPrices.length >= 3) {
    const sorted = allPrices.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    _v145Median = (sorted.length % 2 === 0)
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    // V.199 — Bait-price floor tightened from 0.5x → 0.65x median PLUS a
    // per-category absolute floor. Median * 0.65 kills the ~£151 Bose bait
    // and ~£189 Dyson Supersonic outlet bait that slipped V.195's 0.5x.
    // Category floor catches the case where median itself is suppressed
    // by a cluster of suspiciously-cheap accessories.
    const _v199CatFloor = _v199GetCategoryFloor(typeof category === 'string' ? category : null);
    _v145Floor = Math.max(_v145Median * 0.65, _v199CatFloor);
    // Mark outlier links; filter allPrices in-place.
    for (const l of links) {
      if (l.price_gbp != null && l.price_gbp < _v145Floor) {
        l.is_outlier = true;
        _v145Outliers++;
        // V.195 — capture first 5 rejected SKUs for the Vercel runtime log
        // so the Panel can audit accessory-spam rejections without DOM access.
        if (_v195RejectedSample.length < 5) {
          _v195RejectedSample.push({
            retailer: l.retailer || l.retailer_key || 'unknown',
            price_gbp: l.price_gbp,
            title: (l.title || '').slice(0, 80),
          });
        }
      }
    }
    // V.195 — single-line Panel-readable summary of the BS-Detector pass.
    try {
      console.log(`[V.195][outlier] median=£${_v145Median.toFixed(2)} floor=£${_v145Floor.toFixed(2)} examined=${allPrices.length} rejected=${_v145Outliers} samples=${JSON.stringify(_v195RejectedSample)}`);
    } catch (e) {}
    // Rebuild allPrices excluding outliers.
    allPrices.length = 0;
    for (const l of links) {
      if (l.price_gbp != null && !l.is_outlier) allPrices.push(l.price_gbp);
    }
  } else if (allPrices.length > 0) {
    // V.200 — N<3 FLOOR. Median is unstable, but we still apply the
    // V199 category floor PLUS the V.200 premium-brand floor.
    // V.202 — Additionally apply an AI-anchored MSRP band when n=1.
    // If Haiku's predicted_price_floor_gbp is known, require the single
    // price to fall inside [floor * 0.65, floor * 4.0]. Out of band →
    // outlier → soft-match rescue kicks in downstream.
    const _v200CatFloor    = _v199GetCategoryFloor(typeof category === 'string' ? category : null);
    const _v200BrandFloor  = _v200GetPremiumBrandFloor(typeof canonical === 'string' ? canonical : null);
    _v145Floor = Math.max(_v200CatFloor, _v200BrandFloor);
    // V.202 — AI MSRP band (only when n=1 to avoid clobbering plausible spreads).
    let _v202AiLo = null;
    let _v202AiHi = null;
    const _v202AiFloor = Number(predicted_price_floor_gbp);
    if (allPrices.length === 1 && _v202AiFloor > 0) {
      _v202AiLo = _v202AiFloor * 0.65;
      _v202AiHi = _v202AiFloor * 4.0;
      _v145Floor = Math.max(_v145Floor, _v202AiLo);
    }
    if (_v145Floor > 0 || _v202AiHi != null) {
      for (const l of links) {
        if (l.price_gbp == null) continue;
        if (_v145Floor > 0 && l.price_gbp < _v145Floor) {
          l.is_outlier = true;
          _v145Outliers++;
          if (_v195RejectedSample.length < 5) {
            _v195RejectedSample.push({
              retailer: l.retailer || l.retailer_key || 'unknown',
              price_gbp: l.price_gbp,
              title: (l.title || '').slice(0, 80),
              reason: 'below_floor',
            });
          }
          continue;
        }
        // V.202 — AI MSRP ceiling check (only when n=1).
        if (_v202AiHi != null && l.price_gbp > _v202AiHi) {
          l.is_outlier = true;
          _v145Outliers++;
          if (_v195RejectedSample.length < 5) {
            _v195RejectedSample.push({
              retailer: l.retailer || l.retailer_key || 'unknown',
              price_gbp: l.price_gbp,
              title: (l.title || '').slice(0, 80),
              reason: 'above_ai_ceiling',
            });
          }
        }
      }
      try {
        if (_v202AiHi != null) {
          console.log(`[V.202][n1_ai_band] n=1 ai_floor=£${_v202AiFloor} band=[£${_v202AiLo.toFixed(2)}, £${_v202AiHi.toFixed(2)}] cat=£${_v200CatFloor} brand=£${_v200BrandFloor} effective_floor=£${_v145Floor.toFixed(2)} rejected=${_v145Outliers} samples=${JSON.stringify(_v195RejectedSample)}`);
        } else {
          console.log(`[V.200][nlt3] n=${allPrices.length} cat_floor=£${_v200CatFloor} brand_floor=£${_v200BrandFloor} effective=£${_v145Floor.toFixed(2)} rejected=${_v145Outliers} samples=${JSON.stringify(_v195RejectedSample)}`);
        }
      } catch (e) {}
      allPrices.length = 0;
      for (const l of links) {
        if (l.price_gbp != null && !l.is_outlier) allPrices.push(l.price_gbp);
      }
    } else {
      try { console.log(`[V.195][outlier] SKIP n=${allPrices.length} (no category/brand/ai floor configured)`); } catch (e) {}
    }
  } else {
    try { console.log(`[V.195][outlier] SKIP n=${allPrices.length} (no priced listings)`); } catch (e) {}
  }

  // (3) V.162 — STRICT BEST PRICE CROWN. The cheapest non-outlier retailer
  // in the post-median-floor cluster wins is_primary, regardless of whether
  // it's Amazon or any other UK merchant. Replaces the V.144→V.155 "Amazon
  // wins by default, retailer rescue only on Amazon-miss" rule.
  //
  // Clear any stale is_primary flags first so re-runs (cached payloads
  // re-entering this function) re-pick cleanly. Then sort all priced
  // non-outlier links by price ascending and crown links[0].
  for (const l of links) { l.is_primary = false; }
  const _v162PricedSurvivors = links
    .filter(l => l.price_gbp != null && Number(l.price_gbp) > 0 && !l.is_outlier)
    .sort((a, b) => a.price_gbp - b.price_gbp);
  if (_v162PricedSurvivors[0]) {
    _v162PricedSurvivors[0].is_primary = true;
    try { console.log(`[${VERSION}] V.162 best-price crown → ${_v162PricedSurvivors[0].retailer} £${_v162PricedSurvivors[0].price_gbp} (over ${_v162PricedSurvivors.length} priced survivors)`); } catch (e) {}
  }

  // (4) Best price = the primary link (already chosen above)
  const primary = links.find(l => l.is_primary);
  const best_price = primary ? {
    value_gbp:     primary.price_gbp,
    value_str:     primary.price_str,
    retailer:      primary.retailer,
    retailer_key:  primary.retailer_key,
    url:           primary.url,
    verified_at:   new Date().toISOString(),
    stock_state:   primary.stock_state,
    delivery_note: primary.delivery_note,
  } : null;

  // (5) V.145 — avg_market computed over the FILTERED (post-median) cluster.
  // V.155 — also expose `.n` alias so the frontend's existing read of
  // `pric.avg_market.n` works (was always returning 0 because backend
  // only emitted .retailer_count). Both fields point to the same count.
  let avg_market = null;
  if (allPrices.length >= 2) {
    const sum  = allPrices.reduce((a, b) => a + b, 0);
    const mean = sum / allPrices.length;
    avg_market = {
      value_gbp:       Number(mean.toFixed(2)),
      value_str:       `£${mean.toFixed(2)}`,
      retailer_count:  allPrices.length,
      n:               allPrices.length, // V.155 — alias for frontend back-compat
      sub:             `across ${allPrices.length} UK retailers`,
      method:          'mean_post_median_floor',
      median_gbp:      _v145Median != null ? Number(_v145Median.toFixed(2)) : null,
      outliers_rejected: _v145Outliers,
    };
  }

  // (6) Price band — min/max + spread%
  let price_band = null;
  if (allPrices.length >= 1) {
    const low  = Math.min(...allPrices);
    const high = Math.max(...allPrices);
    const spread_pct = (low > 0 && high > low) ? Number(((high - low) / low * 100).toFixed(1)) : 0;
    price_band = { low: Number(low.toFixed(2)), high: Number(high.toFixed(2)), spread_pct };
  }

  // V.162 — STRICT PRICE-ASCENDING SORT (Panel mandate "Math Wins").
  //   Primary order key:  price_gbp ascending (null prices last)
  //   Secondary key:      outliers always after non-outliers (will be
  //                       filtered out shortly anyway, but keeps the
  //                       transient order stable for any code that reads
  //                       `links` before V.159 outlier deletion)
  // Removed: the V.155 "is_primary first" rule. Now is_primary === the
  // entry that already sits at links[0] by price. The Canon R6 case
  // (Amazon £1,699 above Jessops £779) is mathematically impossible.
  links.sort((a, b) => {
    const aOut = a && a.is_outlier ? 1 : 0;
    const bOut = b && b.is_outlier ? 1 : 0;
    if (aOut !== bOut) return aOut - bOut;
    const aP = (a && a.price_gbp != null) ? Number(a.price_gbp) : Number.POSITIVE_INFINITY;
    const bP = (b && b.price_gbp != null) ? Number(b.price_gbp) : Number.POSITIVE_INFINITY;
    return aP - bP;
  });

  // V.159 — Panel mandate: outliers must be DELETED, not pushed to the
  // bottom of the list. The V.155 sort kept is_outlier=true entries in
  // the array so the frontend rendered £6.95 / £9.74 / £21.88 accessories
  // alongside the real £74 Bose Sport Earbuds Retailer Stack. Filter them
  // out here AFTER avg_market/median have been computed (so the diagnostic
  // counters in _meta.serp_diag are unaffected) but BEFORE the response is
  // returned. Also drop any link that somehow lacks a valid url (defence
  // in depth against partial-record bugs).
  const _v159BeforeCount = links.length;
  const _v159LinksFiltered = links.filter(l => {
    if (!l || typeof l !== 'object') return false;
    if (l.is_outlier === true) return false;
    if (!l.url || typeof l.url !== 'string') return false;
    if (l.price_gbp == null) return false;
    return true;
  });
  const _v159DroppedOutliers = _v159BeforeCount - _v159LinksFiltered.length;
  if (_v159DroppedOutliers > 0) {
    try { console.log('[V.159] filtered ' + _v159DroppedOutliers + ' outlier/empty links from response (median £' + (_v145Median != null ? _v145Median.toFixed(2) : '?') + ', floor £' + (_v145Floor != null ? _v145Floor.toFixed(2) : '?') + ')'); } catch (e) {}
  }

  return { pricing: { best_price, avg_market, price_band }, links: _v159LinksFiltered };
}

// ═══════════════════════════════════════════════════════════════════════
// V.138 — RESPONSE WRAPPER
// ═══════════════════════════════════════════════════════════════════════
// Assembles the Panel-approved schema (outcome / identity / pricing /
// verdict / links / tiers / disclosure) over the existing pipeline data
// + the mega-synthesis text fields. Additive — sits alongside the legacy
// V.121 fields in responseBody so cached analytics + frontend back-compat
// continue to work during the transition.
function _v138BuildResponse({
  parsed,
  verified_amazon_price,
  retailer_deep_links,
  alternative_amazon_price,
  mega,
  inputType,
  serpapi_status,
  rawInputText, // V.175 — raw user text so the bare-brand gate inspects
                //         the ORIGINAL query, not Haiku's resolved canonical
}) {
  const { pricing, links } = _v138BuildPricingAndLinks({
    verified_amazon_price,
    retailer_deep_links,
    category: (parsed && parsed.category) || null,            // V.199 — thread category for absolute floor
    canonical: (parsed && parsed.canonical_search_string) || null, // V.200 — premium brand floor needs canonical
    predicted_price_floor_gbp: (parsed && typeof parsed.predicted_price_floor_gbp === 'number') ? parsed.predicted_price_floor_gbp : null, // V.202 — n=1 AI band
  });

  // ── Outcome routing (V.139: Generic Item Pivot) ───────────────────
  // Panel-mandated broadening: if we can't verify a price, route to
  // disambig regardless of Haiku's stated confidence. The Teapot bug
  // had Haiku returning confidence='medium' for a generic noun, then
  // the prior gate (isLow && length===3) fell straight through to
  // no_match. New rule: !hasPrice + any 2-4 alternatives → disambig.
  let outcome = 'no_match';
  let outcome_reason = 'no_match';
  const hasPrice = !!(pricing && pricing.best_price && pricing.best_price.value_gbp);
  const altsLen  = (parsed && Array.isArray(parsed.alternatives_array)) ? parsed.alternatives_array.length : 0;
  const hasAlts  = altsLen >= 2 && altsLen <= 4;
  const isLow    = parsed && parsed.confidence === 'low';
  const brandOnly = parsed && parsed.specificity === 'brand_only';
  // V.152c — when V.146 family backstop fired (e.g. "playstation 5" →
  // 3 variant tiers), ALWAYS route to disambig regardless of whether
  // SerpAPI returned a verified Amazon price for the broad canonical.
  // Without this, V.152b's retailer-rescue makes hasPrice=true for hot
  // family queries and the matched-branch wins, hiding the variant UI.
  const familyApplied = !!(parsed && parsed._v146_family_applied);

  // V.173 — "Bare brand/family" detection. The Founder QA flagged that
  // "PS5", "Bose", "Nike" auto-resolved to a single product page instead
  // of showing variant choices. New rule: when the user's RAW input (or
  // the canonical) is short and obviously a brand/family token, AND
  // alternatives_array has ≥2 entries, ALWAYS route to disambig — even
  // if Haiku's confidence came back high.
  function _v173IsBareBrandOrFamily(rawText, canonical) {
    // V.175 — when both passed, prefer rawText (it's the user's actual
    // typed query, untouched by Haiku's canonical resolution). When only
    // canonical is passed, fall back to it.
    var probe = String((rawText && rawText.trim()) || canonical || '').trim().toLowerCase();
    if (!probe) return false;
    // Single token (no spaces) of ≤ 8 chars almost always means brand/family.
    if (!/\s/.test(probe) && probe.length <= 8) return true;
    // Word-count ≤ 2 AND known top-frequency family/brand bare keyword.
    var wc = probe.split(/\s+/).length;
    if (wc <= 2) {
      var bareList = /^(?:ps5|ps4|xbox|switch|nintendo|bose|sony|samsung|lg|dell|hp|apple|iphone|ipad|airpods|macbook|garmin|fitbit|dyson|shark|ninja|tefal|kettle|toaster|nike|adidas|puma|reebok|gucci|prada|chanel|dior|ysl|lego|playstation|playstation\s*5|nintendo\s*switch|google\s*pixel|pixel|tv|laptop|phone|watch|headphones|earbuds|vacuum|hairdryer|hair\s*dryer|kettle|fridge|oven|microwave)$/i;
      if (bareList.test(probe)) return true;
    }
    return false;
  }
  // V.175 — check BOTH the raw user input AND the resolved canonical.
  // If the user typed "PS5", Haiku resolves to "Sony PlayStation 5 Slim
  // Disc" with high confidence — the canonical no longer matches the
  // bare-brand regex, but the raw input does. Checking both closes the
  // gap.
  var _v173BareBrand = _v173IsBareBrandOrFamily(rawInputText, parsed && parsed.canonical_search_string)
                    || _v173IsBareBrandOrFamily(rawInputText, null);
  // V.175 — when alternatives_array has ≥2 entries AND confidence is
  // 'medium' (not just 'low'), the AI is uncertain enough that the user
  // should see the choice screen. Was previously only firing on 'low'.
  var isMedium = parsed && parsed.confidence === 'medium';
  var shouldDisambig = (familyApplied || isLow || isMedium || brandOnly || !hasPrice || _v173BareBrand) && hasAlts;

  // V.150 — when the Amazon picker fails but google_shopping returned 2+
  // priced retailers, promote to 'matched' instead of falling through to
  // no_match. The Four Pillars + Retailer Stack render fine without Amazon
  // as long as some priced links exist. PS5 Pro / new launches no longer
  // hit a total blackout just because Amazon picker is strict.
  const _v150HasRetailerPrices = !!(pricing && pricing.best_price && pricing.best_price.value_gbp)
    || (Array.isArray(links) && links.filter(l => l && l.price_gbp != null && !l.is_outlier).length >= 1);
  if (shouldDisambig) {
    outcome = 'disambig';
    outcome_reason = isLow ? 'low_confidence'
                   : brandOnly ? 'brand_only'
                   : 'no_price_with_alternatives';
  } else if (hasPrice) {
    outcome = 'matched';
    outcome_reason = 'high_confidence_with_price';
  } else if (_v150HasRetailerPrices) {
    // V.150 — rescue path: Amazon picker missed but retailers exist.
    outcome = 'matched';
    outcome_reason = 'retailer_priced_no_amazon';
  } else if (parsed && parsed.canonical_search_string) {
    outcome = 'no_match';
    outcome_reason = 'no_amazon_match';
  }

  // ──────────────────────────────────────────────────────────────────
  // V.168 — "MATCHED THIN" RESCUE.
  //
  // Panel mandate: the ≥3-link floor was rejecting legitimate matches
  // where Google Shopping genuinely only indexes 1 or 2 UK retailers
  // (groceries: "Yorkshire Tea" → Amazon UK only; books: "Atomic Habits"
  //  → Amazon + eBay). A user receiving 2 clean verified prices for a
  // book is a SUCCESS, not a failure.
  //
  // New routing (applied AFTER the existing outcome decision so the
  // V.139 disambig gate / V.146 family backstop still take precedence
  // for low-confidence + variant-family queries):
  //
  //   outcome=matched + links.length === 0  → outcome='not_found'
  //                                            (disambig screen, no
  //                                             price stack to show)
  //   outcome=matched + links.length 1 or 2 → outcome='matched_thin'
  //                                            (renders the Four Pillars,
  //                                             frontend surfaces a
  //                                             scarcity acknowledgment)
  //   outcome=matched + links.length >= 3   → outcome='matched' (unchanged)
  //
  //  All other outcomes (disambig, no_match from upstream Haiku
  //  low-confidence) are left as-is.
  // ──────────────────────────────────────────────────────────────────
  if (outcome === 'matched' && Array.isArray(links)) {
    const _v168PricedLinks = links.filter(l => l && l.price_gbp != null && !l.is_outlier).length;
    if (_v168PricedLinks === 0) {
      outcome = 'not_found';
      outcome_reason = 'matched_no_links_post_filter';
    } else if (_v168PricedLinks <= 2) {
      outcome = 'matched_thin';
      outcome_reason = 'matched_thin_' + _v168PricedLinks + '_link' + (_v168PricedLinks === 1 ? '' : 's');
    }
    // links.length >= 3 → outcome stays 'matched' (the original).
  }

  // V.201 — PREMIUM BRAND SOFT-MATCH RESCUE. When all priced links get
  // dropped as outliers (sparse data + bait pricing → zero survivors),
  // and the canonical matches a premium brand, we no longer fall through
  // to no_match. Return matched_thin with a synthetic Amazon-search CTA
  // so the user lands on the result screen with a clear next action.
  const _v201NoSurvivors = !Array.isArray(links) || links.filter(l => l && l.price_gbp != null && !l.is_outlier).length === 0;
  if (_v201NoSurvivors && (outcome === 'not_found' || outcome === 'no_match')) {
    const _v201CanonStr = parsed && parsed.canonical_search_string;
    const _v201Brand = _v201IsPremiumBrand(_v201CanonStr);
    if (_v201Brand) {
      try { console.log(`[V.201][soft_match] no priced survivors for "${_v201CanonStr}" but premium brand detected ("${_v201Brand}"); returning matched_thin soft-match CTA.`); } catch (e) {}
      outcome = 'matched_thin';
      outcome_reason = 'v201_premium_brand_soft_match';
      // Synthesise a CTA-only link so the frontend renders an actionable
      // card instead of a blank Best Price slot. Marked v201_soft_match
      // so the renderer can apply the "Verified UK prices unavailable"
      // copy treatment.
      const _v201AmazonSearchUrl = 'https://www.amazon.co.uk/s?k=' + encodeURIComponent(_v201CanonStr);
      const _v201SoftLink = {
        retailer:        'Amazon UK',
        retailer_key:    'amzn_search_fallback',
        is_primary:      true,
        is_outlier:      false,
        url:             _v201AmazonSearchUrl,
        price_gbp:       null,
        price_str:       null,
        stock_state:     'unknown',
        delivery_note:   'Search results · prices vary',
        affiliate:       false,
        v201_soft_match: true,
        soft_match_copy: 'Verified UK prices for ' + _v201CanonStr + ' currently unavailable. Tap to search Amazon UK safely.',
      };
      // Mutate the const links array in place so the existing closure
      // references stay valid. Clear it first, then push the soft-match
      // link as the sole entry.
      links.length = 0;
      links.push(_v201SoftLink);
      pricing.best_price = {
        value_gbp:       null,
        value_str:       'See Amazon',
        retailer:        'Amazon UK',
        retailer_key:    'amzn_search_fallback',
        url:             _v201AmazonSearchUrl,
        verified_at:     new Date().toISOString(),
        stock_state:     'unknown',
        delivery_note:   'Search results · prices vary',
        v201_soft_match: true,
        soft_match_copy: 'Verified UK prices for ' + _v201CanonStr + ' currently unavailable. Tap to search Amazon UK safely.',
      };
      pricing.avg_market = null;
      pricing.price_band = null;
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // V.169 — THE REALITY ANCHOR (category-price implausibility check).
  //
  // Panel mandate: an £18 Best Price for an £800 Roborock is a critical
  // trust-breaker. The V.145 median floor catches outliers WITHIN a
  // cluster, but when the entire cluster is accessories (filters / mop
  // pads / replacement parts that legitimately share the SKU name in
  // their title), the median itself is corrupted and V.145 has nothing
  // to compare against.
  //
  // Reality Anchor: the AI emitted predicted_price_floor_gbp at canonicalise
  // time as a world-knowledge estimate of the rock-bottom new-retail floor
  // for the CORE UNIT. If the cheapest scraped link is below 40% of that
  // floor, the entire stack is presumed accessory-spam and the outcome
  // flips to no_match.
  //
  // The 40% threshold is intentionally generous — legitimate flash sales,
  // grey-market imports, and refurb specialists still survive. It only
  // catches genuinely implausible prices (Steam Deck OLED 512GB £89.99 is
  // 18% of the £300 AI floor → 0.18 < 0.40 → dropped).
  //
  // Skipped entirely when:
  //   - predicted_price_floor_gbp === 0 (AI opted out for generic categories
  //     like "Kettle" where no single floor makes sense)
  //   - outcome is already not_found / no_match / disambig (nothing to drop)
  //   - pricing.best_price is missing (no cheapest to compare against)
  // ──────────────────────────────────────────────────────────────────
  const _v169Floor = (parsed && typeof parsed.predicted_price_floor_gbp === 'number')
                   ? parsed.predicted_price_floor_gbp : 0;
  // V.128 — SCAM FILTER REINFORCED. Panel mandate: any scraped price under
  // 50% of AI predicted MSRP is dropped entirely. Was 30% — a £24
  // accessory listing slipped through against a £299 Bose SoundLink Max
  // (24/299 = 8% — below 30%, so it tripped; but the rescue only
  // re-elected pricing without removing the £24 link from the response
  // stack — that's the bug we're closing below in V.128's outlier strip).
  const _v169Threshold = _v169Floor > 0 ? Math.round(_v169Floor * 0.50 * 100) / 100 : 0;
  const _v169BestPriceGbp = pricing && pricing.best_price && Number(pricing.best_price.value_gbp);
  const _v169IsMatchedish = (outcome === 'matched' || outcome === 'matched_thin');
  if (_v169IsMatchedish && _v169Floor > 0 && _v169BestPriceGbp > 0 && _v169BestPriceGbp < _v169Threshold) {
    try {
      console.log(`[${VERSION}] V.169 reality anchor TRIPPED for "${(parsed && parsed.canonical_search_string) || '?'}": ` +
                  `best_price £${_v169BestPriceGbp} < threshold £${_v169Threshold} ` +
                  `(30% of AI floor £${_v169Floor}). Dropping link and re-electing.`);
    } catch (e) {}
    // V.200 — ROUTING RESCUE. Instead of wiping the entire pricing block
    // and downgrading to no_match (which discards legitimate co-listed
    // competitors), mark the offending link as an outlier and re-elect
    // best_price from the remaining priced survivors.
    // V.128 — flag EVERY link below the 50% threshold (not just the
    // primary) so co-listed bait listings (e.g. £30 + £24 against a
    // £299 floor) don't just shuffle the throne; both die.
    if (Array.isArray(links)) {
      for (const l of links) {
        if (l && Number(l.price_gbp) > 0 && Number(l.price_gbp) < _v169Threshold) {
          l.is_primary = false;
          l.is_outlier = true;
          try { console.log(`[V.128][scam-filter] flagged ${l.retailer} £${l.price_gbp} (< 50% of AI floor £${_v169Floor}); will strip from response.links`); } catch (e) {}
        }
      }
      // Re-elect: cheapest non-outlier priced survivor wins.
      const _v200Survivors = links
        .filter(l => l && l.price_gbp != null && Number(l.price_gbp) > 0 && !l.is_outlier)
        .sort((a, b) => a.price_gbp - b.price_gbp);
      if (_v200Survivors[0]) {
        _v200Survivors[0].is_primary = true;
        const _new = _v200Survivors[0];
        pricing.best_price = {
          value_gbp:     _new.price_gbp,
          value_str:     _new.price_str || `£${Number(_new.price_gbp).toFixed(2)}`,
          retailer:      _new.retailer,
          retailer_key:  _new.retailer_key,
          url:           _new.url,
          verified_at:   new Date().toISOString(),
          stock_state:   _new.stock_state,
          delivery_note: _new.delivery_note,
        };
        // Recompute avg_market from survivors only.
        const _v200SurvivorPrices = _v200Survivors.map(l => Number(l.price_gbp)).filter(p => p > 0);
        if (_v200SurvivorPrices.length >= 1) {
          const _mean = _v200SurvivorPrices.reduce((a, b) => a + b, 0) / _v200SurvivorPrices.length;
          pricing.avg_market = {
            value_gbp:       Number(_mean.toFixed(2)),
            value_str:       `£${_mean.toFixed(2)}`,
            retailer_count:  _v200SurvivorPrices.length,
            n:               _v200SurvivorPrices.length,
            sub:             `across ${_v200SurvivorPrices.length} UK retailers`,
            method:          'mean_post_reality_anchor',
          };
          const _lo = Math.min(..._v200SurvivorPrices);
          const _hi = Math.max(..._v200SurvivorPrices);
          pricing.price_band = {
            low: Number(_lo.toFixed(2)),
            high: Number(_hi.toFixed(2)),
            spread_pct: (_lo > 0 && _hi > _lo) ? Number(((_hi - _lo) / _lo * 100).toFixed(1)) : 0,
          };
        }
        try { console.log(`[V.200][rescue] new best_price → ${_new.retailer} £${_new.price_gbp} (was £${_v169BestPriceGbp})`); } catch (e) {}
        // Keep outcome as matched/matched_thin — DO NOT wipe.
      } else {
        // No survivors — fall back to the original no_match path.
        outcome = 'no_match';
        outcome_reason = 'category_price_implausible';
        pricing.best_price = null;
        pricing.avg_market = null;
        pricing.price_band = null;
      }
    } else {
      outcome = 'no_match';
      outcome_reason = 'category_price_implausible';
      pricing.best_price = null;
      pricing.avg_market = null;
      pricing.price_band = null;
    }
    // V.128 — STRIP OUTLIERS FROM RESPONSE.LINKS. The V.200 rescue used
    // to mark is_outlier=true but kept the bad link in the response stack,
    // which is how the £24.95 Boseuk appeared in the retailer stack
    // under a £299 Bose SoundLink Max card. Splice them out so the
    // frontend never sees scam-flagged listings.
    if (Array.isArray(links)) {
      for (let _i = links.length - 1; _i >= 0; _i--) {
        if (links[_i] && links[_i].is_outlier === true) {
          try { console.log(`[V.128][strip] removing outlier from response.links → ${links[_i].retailer} £${links[_i].price_gbp}`); } catch (e) {}
          links.splice(_i, 1);
        }
      }
    }
  }

  // ── Identity block ────────────────────────────────────────────────
  // V.159 — IMAGE EXTRACTION AUDIT. Pillar 1 of the result UI requires a
  // product image. Previously identity.image was only populated when
  // Amazon returned a verified match with a thumbnail. For long-tail
  // items (Petzl Sm'D Twist-Lock, Yuzu Kosho paste, Aesop Marrakech)
  // Amazon verification typically fails — the response then carried
  // identity.image=null and the UI rendered a blank placeholder. Fix:
  // fall back to the first non-Amazon retailer thumbnail from the
  // google_shopping pass (already captured per-link by V.159).
  let _v159ImageBlock = null;
  if (verified_amazon_price && verified_amazon_price.thumbnail) {
    _v159ImageBlock = {
      thumbnail_url: verified_amazon_price.thumbnail,
      source:        'amazon',
      alt_text:      parsed && parsed.canonical_search_string ? parsed.canonical_search_string : null,
    };
  } else if (retailer_deep_links && typeof retailer_deep_links === 'object') {
    // First match in retailer_deep_links insertion order that has a
    // valid thumbnail. retailer_deep_links is the host-keyed object
    // built by fetchGoogleShoppingDeepLinks; each record now carries
    // its own thumbnail courtesy of the V.159 capture above.
    for (const _hostKey of Object.keys(retailer_deep_links)) {
      if (_hostKey === '__v153_amazon_extras') continue;
      const _rec = retailer_deep_links[_hostKey];
      if (_rec && typeof _rec.thumbnail === 'string' && /^https?:\/\//i.test(_rec.thumbnail)) {
        _v159ImageBlock = {
          thumbnail_url: _rec.thumbnail,
          source:        'google_shopping:' + _hostKey,
          alt_text:      parsed && parsed.canonical_search_string ? parsed.canonical_search_string : null,
        };
        break;
      }
    }
  }
  const identity = {
    canonical:        (parsed && parsed.canonical_search_string) || null,
    display_title:    (parsed && parsed.canonical_search_string) || null,
    category_eyebrow: (mega && mega.category_eyebrow) || null,
    mpn:              (parsed && parsed.mpn) || null,
    market_status:    (parsed && parsed.market_status) || null,
    image:            _v159ImageBlock,
  };

  // ── Verdict block ─────────────────────────────────────────────────
  const verdictPillMap = {
    good_buy:        { text: 'GOOD BUY',        cls: 'v136-verdict-good' },
    fair:            { text: 'FAIR',            cls: 'v136-verdict-fair' },
    wait:            { text: 'WAIT',            cls: 'v136-verdict-wait' },
    check_elsewhere: { text: 'CHECK ELSEWHERE', cls: 'v136-verdict-check' },
  };
  const vLabel = (mega && mega.verdict_label) || null;
  const vPill  = vLabel ? verdictPillMap[vLabel] : null;
  const verdict = {
    label:             vLabel,
    pill_text:         vPill ? vPill.text : null,
    pill_color_class:  vPill ? vPill.cls : null,
    summary:           (mega && mega.verdict_summary) || null,
    summary_max_words: 28,
    rating: (verified_amazon_price && verified_amazon_price.rating) ? {
      stars:        verified_amazon_price.rating,
      review_count: verified_amazon_price.reviews || null,
      display_str:  verified_amazon_price.reviews
                      ? `★ ${verified_amazon_price.rating} · ${
                          verified_amazon_price.reviews >= 1000
                            ? (verified_amazon_price.reviews / 1000).toFixed(verified_amazon_price.reviews >= 10000 ? 0 : 1) + 'k'
                            : String(verified_amazon_price.reviews)
                        } reviews`
                      : `★ ${verified_amazon_price.rating}`,
      source:       'amazon',
    } : null,
  };

  // ── Tiers block (V.139: 2–4 alternatives accepted) ────────────────
  // When Haiku returns 2 alternatives we pad to 3 with a synthetic
  // PREMIUM placeholder pointing at an Amazon search for the canonical.
  // When 4 are returned we truncate to 3. Never invent prices/reviews.
  let tiers = null;
  if (hasAlts) {
    const altsArr  = parsed.alternatives_array.slice(0, 4);
    const altsMeta = Array.isArray(parsed.alternatives_meta) ? parsed.alternatives_meta.slice(0, 4) : [];
    const tierKeys = ['basic', 'top_rated', 'premium'];
    const tierPillText = ['BUDGET', 'TOP RATED', 'PREMIUM'];

    // V.148/V.154 — disambig_kind: family (clean tap-to-research) vs
    // generic (BUDGET/TOP RATED/PREMIUM mockup). Family detection mirrors
    // the _v138BuildResponse logic so the tier metadata stays in sync with
    // the top-level disambig_kind.
    const _V154_BRANDS_INNER = /\b(?:bose|sony|apple|samsung|google|pixel|nest|amazon\s+echo|ring|arlo|jbl|sennheiser|sonos|anker|belkin|mophie|logitech|razer|corsair|beats|marshall|jabra|skullcandy|airpods|ninja|shark|dyson|bosch|tefal|breville|russell\s*hobbs|kitchenaid|smeg|de\s*longhi|delonghi|kenwood|cuisinart|vitamix|nutribullet|magimix|krups|nespresso|tassimo|miele|hoover|vax|sebo|black\s*[&+]?\s*decker|dewalt|makita|milwaukee|stanley|einhell|ryobi|festool|karcher|stihl|husqvarna|playstation|xbox|nintendo|switch|fitbit|garmin|withings|oura|kindle|fire\s+tablet|onepl?us|xiaomi|huawei|motorola|nokia|hp|dell|lenovo|asus|acer|msi|microsoft\s+surface|ghd|babyliss|remington|braun|philips|oral[\s-]?b|colgate|nivea|loreal|l['’]?or[ée]al)\b/i;
    const _innerCandidates = [
      (parsed && parsed.canonical_search_string) || '',
      ...((parsed && Array.isArray(parsed.alternatives_array)) ? parsed.alternatives_array : []),
    ];
    const _innerHasBrand = _innerCandidates.some(s => typeof s === 'string' && _V154_BRANDS_INNER.test(s));
    // V.154b — category gate dropped (see _disambigKind block above).
    const _isFamilyVariant = !!(parsed && parsed._v146_family_applied) || _innerHasBrand;
    // V.131 — Curator Protocol detection. When Haiku set specificity='brand_only'
    // OR every meta carries a description+tag (the curator signature), we're
    // in brand-curator mode: pills become category TAGs, not BUDGET/TOP/PREM.
    const _v131CuratorMode = (parsed && parsed.specificity === 'brand_only')
      || (altsMeta.length >= 2 && altsMeta.every(m => m && typeof m.tag === 'string' && m.tag.length > 0));
    const built = altsArr.slice(0, 3).map((name, i) => {
      const meta = altsMeta[i] || {};
      const blurbFromMega = (mega && mega.tier_blurbs && mega.tier_blurbs[i]) || null;
      // V.131 — pill text resolution priority:
      //   1. Curator mode → meta.tag (HEADPHONES / VACUUM / SOUNDBAR)
      //   2. Family variant → null (no pill, internal-tap card)
      //   3. Generic disambig → BUDGET / TOP RATED / PREMIUM
      const _v131PillText = _v131CuratorMode
        ? (meta.tag || null)
        : (_isFamilyVariant ? null : tierPillText[i]);
      return {
        tier:        tierKeys[i],
        pill_text:   _v131PillText,
        name:        name || '',
        retailer:    null,
        price_gbp:   meta.typical_price_gbp || null,
        price_str:   (meta.typical_price_gbp != null) ? `£${Number(meta.typical_price_gbp).toFixed(2)}` : null,
        url:         null,
        // V.131 — blurb priority: mega-synth blurb > Haiku description > rationale.
        // The description field is the V.131 mandate's punchy 12-22-word subtitle.
        blurb:       blurbFromMega || meta.description || meta.rationale || null,
        blurb_basis: i === 1 ? 'review_count' : (i === 0 ? 'price_anchor' : 'premium_signal'),
        review_count: meta.reviews || null,
        review_stars: meta.rating || null,
        image:       null,
        is_placeholder: false,
        is_family_variant: _isFamilyVariant, // V.148
        is_curator:  _v131CuratorMode,        // V.131 — flag for frontend
        tag:         meta.tag || null,         // V.131 — uppercase category tag passthrough
      };
    });

    // Pad to 3 with a non-inventive placeholder pointing at Amazon search.
    if (built.length === 2) {
      const canonForSearch = (parsed && parsed.canonical_search_string) || '';
      built.push({
        tier:        'premium',
        pill_text:   'PREMIUM',
        name:        canonForSearch ? `Premium ${canonForSearch} on Amazon UK` : 'Search Amazon UK for premium options',
        retailer:    'Amazon UK',
        price_gbp:   null,
        price_str:   null,
        url:         canonForSearch
                       ? `https://www.amazon.co.uk/s?k=${encodeURIComponent('premium ' + canonForSearch)}&tag=${encodeURIComponent(AMAZON_TAG)}`
                       : null,
        blurb:       'Couldn’t verify a premium pick — browse the highest-priced UK listings.',
        blurb_basis: 'placeholder_search',
        review_count: null,
        review_stars: null,
        image:       null,
        is_placeholder: true,
      });
    }
    tiers = built;
  }

  // ── Disclosure ────────────────────────────────────────────────────
  const disclosure = {
    affiliate_text: 'Savvey may earn a small commission via the Amazon link. It never changes the price you pay.',
    data_freshness: 'Prices verified within the last 6 hours.',
  };

  // V.148 — top-level disambig_kind tag for the frontend's renderConfirm
  // branching. 'family' = variant disambig (PS5 Slim/Pro/Disc, iPhone 16 base/
  // Plus/Pro), 'generic' = BUDGET/TOP RATED/PREMIUM tiers, null = not disambig.
  // V.154 — Dynamic family detection. The V.146 _v146_family_applied
  // flag handles the 11 hardcoded variant families. But Haiku hallucinations
  // ("Google Nest" for a wireless charger, "Bose" for headphones) produce
  // disambig payloads whose canonical/alternatives are clearly branded
  // electronics — these MUST render with the clean family layout (no
  // BUDGET/TOP/PREMIUM pills, no mug SVGs, internal-loop tap), not the
  // generic mockup. Detection: if canonical OR any alternative contains
  // a known consumer-electronics / appliance / premium-brand signal, OR
  // if category is 'tech'/'home'/'diy', we force disambig_kind='family'.
  const V154_BRAND_SIGNALS = /\b(?:bose|sony|apple|samsung|google|pixel|nest|amazon\s+echo|ring|arlo|jbl|sennheiser|sonos|anker|belkin|mophie|logitech|razer|corsair|hyperx|steelseries|beats|marshall|jabra|skullcandy|airpods|ninja|shark|dyson|bosch|tefal|breville|russell\s*hobbs|kitchenaid|smeg|de\s*longhi|delonghi|kenwood|cuisinart|vitamix|nutribullet|magimix|krups|nespresso|tassimo|dolce\s+gusto|miele|hoover|vax|sebo|black\s*[&+]?\s*decker|dewalt|makita|milwaukee|stanley|einhell|ryobi|festool|hilti|karcher|stihl|husqvarna|playstation|xbox|nintendo|switch|fitbit|garmin|withings|oura|kindle|fire\s+tablet|onepl?us|xiaomi|huawei|motorola|nokia|hp|dell|lenovo|asus|acer|msi|microsoft\s+surface|ghd|babyliss|remington|braun|philips|oral[\s-]?b|colgate|sensodyne|nivea|loreal|l['’]?or[ée]al|aveda|aesop|charlotte\s+tilbury|fenty|nars|estee?\s*lauder|clinique|elemis)\b/i;
  function _v154HasBrandSignal(strings) {
    if (!Array.isArray(strings)) return false;
    for (const s of strings) {
      if (typeof s === 'string' && V154_BRAND_SIGNALS.test(s)) return true;
    }
    return false;
  }
  const _v154Candidates = [
    (parsed && parsed.canonical_search_string) || '',
    ...((parsed && Array.isArray(parsed.alternatives_array)) ? parsed.alternatives_array : []),
  ];
  const _v154HasBrand = _v154HasBrandSignal(_v154Candidates);
  // V.154b — category gate dropped. "Teapot" / "kettle" / "white mug" have
  // category='home' but are genuinely generic. Brand signal is the only
  // discriminator now: if any branded keyword appears in canonical or
  // alternatives, it's a family disambig; otherwise generic.
  // V.131 — Curator Protocol detection at response level. specificity ==='brand_only'
  // takes precedence: bare-brand queries get disambig_kind='brand_curator' so the
  // frontend can switch off BUDGET/TOP/PREMIUM pills and turn on category TAGs +
  // the Brand Glance card.
  const _v131IsBrandOnly = (parsed && parsed.specificity === 'brand_only');
  const _disambigKind = (outcome === 'disambig')
    ? (
        _v131IsBrandOnly ? 'brand_curator'
        : (parsed && parsed._v146_family_applied) ? 'family'
        : _v154HasBrand ? 'family'
        : 'generic'
      )
    : null;
  // V.131 — intent_confidence surfaces Haiku's self-reported confidence
  // for the frontend badge gate. Distinct from the existing `confidence`
  // field (which the verdict layer also reads). brand_only is always 'low'.
  const _v131IntentConfidence = _v131IsBrandOnly
    ? 'low'
    : ((parsed && parsed.confidence) || null);
  return {
    outcome,
    outcome_reason,
    disambig_kind: _disambigKind,
    intent_confidence: _v131IntentConfidence,
    specificity: (parsed && parsed.specificity) || null,
    identity,
    pricing,
    verdict,
    links: links.length > 0 ? links : null,
    tiers,
    disclosure,
    schema_version: 1,
  };
}

// V.202 — Fix J. Internal handler wrapped by the exported handler in a
// top-level try/catch. ANY uncaught exception that bubbles out of the
// internal handler is converted into a clean JSON error envelope so the
// frontend never sees a raw Vercel HTML 500/504 page (which crashed the
// V.201 Dyson Airwrap test with "Unexpected token 'A'... not valid JSON").
async function _v202InnerHandler(req, res) {
  applySecurityHeaders(res, ORIGIN);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  if (rejectIfRateLimited(req, res, 'normalize', RATE_LIMIT_PER_HOUR)) return;

  const t0 = Date.now();
  const body = req.body || {};

  // ─── V.140 OPTION B: SYNTH-ONLY BRANCH (/api/synthesize) ───────
  // Skip identify entirely; run ONLY the Haiku mega-synth on the
  // synthesis_payload the client gathered from a prior /api/identify.
  // Cached separately on canonical+mode for 7 days.
  if (body.synth_only === true) {
    try {
      const sp = body.synthesis_payload || {};
      const canon = sp.canonical && String(sp.canonical).slice(0, 200);
      if (!canon) {
        return res.status(400).json({ error: 'synthesis_payload.canonical required' });
      }
      const mode = (sp.mode === 'tiers') ? 'tiers' : 'pillars';
      const synthKeyRaw = `sav-v173-syn-1|${mode}|${canon.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0,80)}`;
      const synthKey = 'savvey:synth:' + crypto.createHash('sha256').update(synthKeyRaw).digest('hex').slice(0, 32);
      const cached = await kvGet(synthKey);
      if (cached && typeof cached === 'object') {
        return res.status(200).json({
          ...cached,
          _meta: { ...(cached._meta || {}), cache: 'hit', latency_ms: Date.now() - t0, version: VERSION, leg: 'synthesize' }
        });
      }
      const _v160Trace = [];
      const mega = await callHaikuMegaSynthesis({
        canonical:     canon,
        category:      sp.category || null,
        market_status: sp.market_status || null,
        amazon:        (mode === 'pillars') ? (sp.amazon || null) : null,
        retailers:     (mode === 'pillars') ? (sp.retailers || null) : null,
        alternatives:  (mode === 'tiers')   ? (sp.alternatives || null) : null,
        trace:         _v160Trace,
      });
      const pillMap = {
        good_buy:        { text: 'GOOD BUY',        cls: 'v136-verdict-good' },
        fair:            { text: 'FAIR',            cls: 'v136-verdict-fair' },
        wait:            { text: 'WAIT',            cls: 'v136-verdict-wait' },
        check_elsewhere: { text: 'CHECK ELSEWHERE', cls: 'v136-verdict-check' },
      };
      const pill = mega.verdict_label ? pillMap[mega.verdict_label] : null;
      const result = {
        mode,
        category_eyebrow:        mega.category_eyebrow || null,
        verdict_label:           mega.verdict_label || null,
        verdict_summary:         mega.verdict_summary || null,
        verdict_pill_text:       pill ? pill.text : null,
        verdict_pill_color_class: pill ? pill.cls : null,
        tier_blurbs:             mega.tier_blurbs || null,
        _meta: { version: VERSION, latency_ms: Date.now() - t0, cache: 'miss', leg: 'synthesize',
                 trace: _v160Trace }
      };
      // V.160a — 7-day cache, BUT skip cache write when verdict is empty
      // (don't poison the cache with a null result on a transient Haiku
      // hiccup). The next call retries fresh.
      const _v160Empty = !mega.verdict_label && !mega.verdict_summary;
      if (!_v160Empty) {
        kvSet(synthKey, result, 7 * 24 * 60 * 60).catch(() => {});
      } else {
        try { console.log(`[${VERSION}] synth empty for "${canon}" — skipping cache write (trace: ${JSON.stringify(_v160Trace).slice(0, 240)})`); } catch (e) {}
      }
      return res.status(200).json(result);
    } catch (e) {
      console.warn(`[${VERSION}] synth_only error: ${e && e.message}`);
      return res.status(500).json({ error: 'synth_failed', message: String(e && e.message || e).slice(0, 200) });
    }
  }

  const inputType = body.input_type;

  if (!['image','url','text','barcode'].includes(inputType)) {
    return res.status(400).json({ error: 'input_type must be image|url|text|barcode' });
  }

  const cKey = cacheKey(inputType, body);
  const cached = await kvGet(cKey);
  if (cached && typeof cached === 'object' && cached.canonical_search_string) {
    return res.status(200).json({
      ...cached,
      _meta: { ...(cached._meta || {}), cache: 'hit', latency_ms: Date.now() - t0 }
    });
  }

  let rawText;
  try {
    if (inputType === 'image') {
      // Wave FF — prefer image_base64_frames (array, 1-3) for multi-shot ensemble.
      // Falls back to image_base64 (single) for backwards compat with the v3.4.5ee
      // frontend. When both are provided, frames win.
      const framesIn = Array.isArray(body.image_base64_frames) ? body.image_base64_frames : null;
      const single = body.image_base64;
      const mediaType = body.media_type || 'image/jpeg';
      let payload;
      if (framesIn && framesIn.length > 0) {
        payload = framesIn.slice(0, 3).filter(f => typeof f === 'string' && f.length > 100);
        if (payload.length === 0) return res.status(400).json({ error: 'image_base64_frames invalid' });
        const totalBytes = payload.reduce((s, f) => s + f.length * 0.75, 0);
        if (totalBytes > MAX_IMAGE_BYTES * 2) return res.status(413).json({ error: 'frames total too large (>8MB)' });
      } else if (single) {
        const approxBytes = single.length * 0.75;
        if (approxBytes > MAX_IMAGE_BYTES) return res.status(413).json({ error: 'image too large (>4MB)' });
        payload = single;
      } else {
        return res.status(400).json({ error: 'image_base64 or image_base64_frames required' });
      }
      rawText = await withCircuit('anthropic',
        () => callHaikuVision(_buildVisionPromptWithHint(VISION_SYSTEM_PROMPT, body && body.category_hint), payload, mediaType),
        { onOpen: () => null }
      );
    } else if (inputType === 'url') {
      const rawUrl = String(body.url || '').trim();
      if (!rawUrl || !/^https?:\/\//i.test(rawUrl)) return res.status(400).json({ error: 'valid url required' });
      // Wave II.2 — Panel audit (defense-in-depth): strip tracking and analytics
      // params BEFORE sending the URL slug to Haiku. URL_SYSTEM_PROMPT already
      // tells Haiku to ignore non-slug params, but stripping at the source
      // means cleaner inputs and zero risk of Haiku weighting a tracking
      // string as product context.
      let u = rawUrl;
      try {
        const _u = new URL(rawUrl);
        const _drop = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','utm_id','utm_name','utm_referrer','gclid','fbclid','msclkid','dclid','yclid','mc_eid','mc_cid','_ga','_gl','vero_id','vero_conv','wickedid','sm_guid','rb_clickid','referrer','redirected_from'];
        for (const k of _drop) _u.searchParams.delete(k);
        u = _u.toString();
      } catch {}
      rawText = await withCircuit('anthropic',
        () => callHaikuText(URL_SYSTEM_PROMPT, `URL: ${u}`),
        { onOpen: () => null }
      );
    } else if (inputType === 'barcode') {
      const ean = String(body.ean || '').trim().replace(/\D/g, '');
      if (!ean) return res.status(400).json({ error: 'ean required' });
      if (ean.length < 8 || ean.length > 14) return res.status(400).json({ error: 'invalid ean length' });
      // v3.4.5n — Open Food Facts pre-resolution. UK/EU groceries + toiletries
      // are reliably mapped from EAN -> product name BEFORE Haiku sees them.
      // On hit: feed the resolved string through TEXT_SYSTEM_PROMPT so Door 3
      // inherits the higher-accuracy Type-door pipeline. On miss: fall through
      // to the existing barcode-via-Haiku behaviour.
      const resolvedName = await lookupOpenFoodFacts(ean);
      if (resolvedName) {
        rawText = await withCircuit('anthropic',
          () => callHaikuText(TEXT_SYSTEM_PROMPT, `Query: "${resolvedName}"`),
          { onOpen: () => null }
        );
      } else {
        rawText = await withCircuit('anthropic',
          () => callHaikuText(BARCODE_SYSTEM_PROMPT, `EAN/UPC: ${ean}`),
          { onOpen: () => null }
        );
      }
    } else {
      const text = String(body.text || '').trim();
      if (!text) return res.status(400).json({ error: 'text required' });
      if (text.length > 200) return res.status(400).json({ error: 'text too long (>200 chars)' });
      // V.201 — PRE-HAIKU GENERIC SHORT-CIRCUIT. Single-word generic noun
      // input never reaches Haiku. We inject a synthetic canonicalisation
      // payload with 3 hard-coded UK-popular tiers and route straight to
      // Outcome 3 disambig. Saves 2-3s per generic query AND guarantees
      // the safety net fires regardless of Haiku state.
      const _v201GenericTiers = _v200GenericFallback(text);
      if (_v201GenericTiers && _v201GenericTiers.length === 3) {
        try { console.log(`[V.201][pre_haiku_generic] "${text}" → short-circuit to 3-tier disambig (no Haiku call)`); } catch (e) {}
        const _v201SyntheticParsed = {
          canonical_search_string: text.charAt(0).toUpperCase() + text.slice(1).toLowerCase(),
          identity_fingerprint: [],
          confidence: 'low',
          confidence_score: 25,
          alternative_string: null,
          alternatives_array: _v201GenericTiers.slice(),
          alternatives_meta: _v201GenericTiers.map((name, i) => ({
            intent_label: ['Best Value', 'Top Rated', 'Premium Choice'][i],
            rationale:    ['Cheapest reliable option.', 'Most popular UK pick.', 'Top-end build quality.'][i],
            typical_price_gbp: null,
            est_price_range:   null,
            pack_size:         null,
            tier_label:        ['Budget', 'Mid-tier', 'Premium'][i],
          })),
          category: 'generic',
          mpn: null,
          amazon_search_query: text,
          predicted_price_floor_gbp: 0,
          savvey_says: { timing_advice: null, consensus: null, confidence: 'low' },
        };
        const _v201Response = {
          outcome: 'disambig',
          outcome_reason: 'v201_pre_haiku_generic',
          canonical_search_string: _v201SyntheticParsed.canonical_search_string,
          identity_fingerprint: [],
          confidence: 'low',
          alternatives_array: _v201SyntheticParsed.alternatives_array,
          alternatives_meta:  _v201SyntheticParsed.alternatives_meta,
          category: 'generic',
          amazon_search_query: text,
          amazon_search_fallback: 'https://www.amazon.co.uk/s?k=' + encodeURIComponent(text),
          identity: {
            display_name: _v201SyntheticParsed.canonical_search_string,
            category_eyebrow: 'Generic — pick a style',
            thumbnail_url: null,
          },
          pricing: { best_price: null, avg_market: null, price_band: null },
          links: [],
          tiers: _v201SyntheticParsed.alternatives_array.map((name, i) => ({
            name,
            intent_label: ['Best Value', 'Top Rated', 'Premium Choice'][i],
            rationale:    ['Cheapest reliable option.', 'Most popular UK pick.', 'Top-end build quality.'][i],
            tier_label:   ['Budget', 'Mid-tier', 'Premium'][i],
            est_price_range: null,
            typical_price_gbp: null,
            url: 'https://www.amazon.co.uk/s?k=' + encodeURIComponent(name),
          })),
          _meta: {
            version: VERSION,
            input_type: 'text',
            latency_ms: Date.now() - t0,
            cache: 'miss',
            leg: 'identify',
            short_circuit: 'v201_pre_haiku_generic',
          },
        };
        return res.status(200).json(_v201Response);
      }
      rawText = await withCircuit('anthropic',
        () => callHaikuText(TEXT_SYSTEM_PROMPT, `Query: "${text}"`),
        { onOpen: () => null }
      );
    }
  } catch (err) {
    console.error(`[${VERSION}] ${inputType} call failed:`, err.message);
    return res.status(502).json({
      error: 'identification_failed',
      message: err.message.slice(0, 300),
      _meta: { version: VERSION, input_type: inputType, latency_ms: Date.now() - t0 }
    });
  }

  const parsed = parseAndDefault(rawText);
  // V.129b — VISION EJECTOR SEAT. When the user snapped a photo AND
  // Haiku returned low confidence (per the V.129 chain-of-thought
  // prompt), do NOT pipe a guess through the SerpAPI/synthesize chain.
  // Short-circuit with outcome:"unclear" so the frontend can show the
  // V.129e retake overlay (first miss) or pivot to barcode (second miss).
  // We respect either parsed.outcome === 'unclear' (the strict signal
  // Haiku is told to emit) OR parsed.confidence === 'low' as a belt-and-
  // braces fallback in case Haiku skipped the explicit outcome field.
  if (
    inputType === 'image' &&
    parsed &&
    typeof parsed === 'object' &&
    (parsed.outcome === 'unclear' || parsed.confidence === 'low')
  ) {
    try { console.log(`[${VERSION}] V.129 vision ejector seat fired — outcome:${parsed.outcome || '(none)'} confidence:${parsed.confidence || '(none)'}; returning outcome:"unclear" without SerpAPI/synth.`); } catch (e) {}
    return res.status(200).json({
      outcome: 'unclear',
      outcome_reason: 'vision_low_confidence',
      canonical_search_string: parsed.canonical_search_string || null,
      confidence: 'low',
      identity: {
        canonical: parsed.canonical_search_string || null,
        display_title: parsed.canonical_search_string || null,
        category_eyebrow: null,
        mpn: parsed.mpn || null,
        market_status: null,
        image: null,
      },
      pricing: { best_price: null, avg_market: null, price_band: null },
      verdict: { label: null, pill_text: null, pill_color_class: null, summary: null, rating: null },
      links: [],
      tiers: null,
      disclosure: { affiliate_text: '', data_freshness: '' },
      _meta: {
        version: VERSION,
        input_type: inputType,
        latency_ms: Date.now() - t0,
        cache: 'miss',
        source: 'v129_vision_ejector',
      },
    });
  }
  if (!parsed) {
    // V.78.2 — Haiku said "no match", but if the user typed a UK retailer-own
    // brand (Habitat / IKEA / M&S Home / Dunelm / Argos Home / The Range),
    // we know exactly why: those don't sell on Amazon UK. Route to the
    // retailer-own card instead of the generic error screen. Only applies
    // to text input (other doors don't have a clean text seed to match on).
    if (inputType === 'text') {
      const userText = String((body && body.text) || '').trim();
      const ron = detectRetailerOwn(userText);
      if (ron) {
        console.log(`[${VERSION}] no_match -> retailer_own short-circuit for "${userText.slice(0, 80)}"`);
        return res.status(200).json({
          canonical_search_string: userText.slice(0, 200),
          confidence: 'low',
          specificity: 'brand_only',
          category: 'home',
          alternative_string: null,
          alternatives_array: [],
          alternatives_meta: [],
          mpn: null,
          amazon_search_query: userText,
          savvey_says: { typical_price_range: null, live_amazon_price: null, used_amazon_price: null, amazon_rating: null, price_take: null, verdict: null, timing_advice: null, consensus: null, confidence: 'low' },
          verified_amazon_price: null,
          alternative_amazon_price: null,
          retailer_deep_links: null,
          disambig_candidates: null,
          disambig_candidates_meta: null,
          _meta: { version: VERSION, input_type: inputType, latency_ms: Date.now() - t0, cache: 'miss', retailer_own: ron, source: 'no_match_retailer_own_recovery' }
        });
      }
    }
    // V.90 — Image inputs that no_match: try V.87 visual similarity before
    // failing. The blue-pot scenario: user snaps an unbranded item, Haiku
    // can't identify it, but Vision can still describe it well enough to
    // generate a useful similar-products query. Returns synthetic 200 with
    // visual_matches populated so frontend renders "Find similar" instead
    // of bouncing to Type with a vague "couldn't quite catch that" toast.
    if (inputType === 'image') {
      try {
        const framesIn = Array.isArray(body.image_base64_frames) ? body.image_base64_frames : null;
        const reusePayload = framesIn && framesIn.length > 0 ? framesIn.slice(0, 3) : (body.image_base64 || null);
        const mediaType = body.media_type || 'image/jpeg';
        const vm = await describeAndSearchSimilar(reusePayload, mediaType);
        if (vm && vm.matches && Object.keys(vm.matches).length > 0) {
          console.log(`[${VERSION}] no_match -> V.87 visual_similar recovery for image (${Object.keys(vm.matches).length} matches)`);
          return res.status(200).json({
            canonical_search_string: vm.visual_summary || vm.category || 'Similar items',
            confidence: 'low',
            specificity: 'category_only',
            category: vm.category || 'home',
            alternative_string: null,
            alternatives_array: [],
            alternatives_meta: [],
            mpn: null,
            amazon_search_query: vm.search_query,
            savvey_says: { typical_price_range: null, live_amazon_price: null, used_amazon_price: null, amazon_rating: null, price_take: null, verdict: null, timing_advice: null, consensus: null, confidence: 'low' },
            verified_amazon_price: null,
            alternative_amazon_price: null,
            retailer_deep_links: null,
            disambig_candidates: null,
            disambig_candidates_meta: null,
            visual_matches: vm,
            recommendations: null,
            review_synthesis: null,
            _meta: { version: VERSION, input_type: inputType, latency_ms: Date.now() - t0, cache: 'miss', source: 'no_match_visual_similar_recovery' }
          });
        }
      } catch (err) {
        console.warn(`[${VERSION}] V.90 no_match->visual_similar recovery error: ${err.message}`);
      }
    }
    // V.111 — NO DEAD-END no_match. Even when Haiku fails to identify, build
    // an Amazon UK search URL from the user's raw input + affiliate tag.
    // Frontend renders this as primary CTA so user always has next-step.
    const _v111Q = String(
      (body && body.text) ||
      (body && body.url) ||
      (body && body.barcode) ||
      'product'
    ).slice(0, 150).trim() || 'product';
    const _v111Fallback = `https://www.amazon.co.uk/s?k=${encodeURIComponent(_v111Q)}&tag=${encodeURIComponent(AMAZON_TAG)}`;
    return res.status(200).json({
      error: 'no_match',
      amazon_search_fallback: _v111Fallback,
      _v111_input_for_search: _v111Q,
      _meta: { version: VERSION, input_type: inputType, latency_ms: Date.now() - t0 }
    });
  }

  // Wave KK — Layer 2 safety block. Short-circuit before any caching/SerpAPI
  // when canonical matches the blacklist. Frontend handles 'safety_block' as
  // a clean redirect to home with a friendly toast.
  // V.117 — NO DEAD-END on safety_block either. Stanley FatMax utility knife
  // is a legitimate tradesman tool — we don't endorse/verify the listing, but
  // we still hand the user an Amazon UK search URL so they can find it
  // themselves. Crucible Test surfaced this as a true dead-end. Panel mandate.
  if (_shouldSafetyBlock(parsed.canonical_search_string)) {
    console.log(`[${VERSION}] Layer 2 safety block fired: "${(parsed.canonical_search_string||'').slice(0,80)}"`);
    const _v117Q = String(
      (body && body.text) ||
      (body && body.url) ||
      (body && body.barcode) ||
      parsed.canonical_search_string ||
      'product'
    ).slice(0, 150).trim() || 'product';
    const _v117Fallback = `https://www.amazon.co.uk/s?k=${encodeURIComponent(_v117Q)}&tag=${encodeURIComponent(AMAZON_TAG)}`;
    return res.status(200).json({
      error: 'safety_block',
      message: 'We can\'t verify pricing on that category — search Amazon UK directly:',
      amazon_search_fallback: _v117Fallback,
      _v117_input_for_search: _v117Q,
      _meta: { version: VERSION, input_type: inputType, latency_ms: Date.now() - t0 }
    });
  }

  // Wave II — canonical-keyed cache lookup. Different input phrasings that
  // resolve to the SAME canonical hit one shared cache entry, skipping
  // SerpAPI Amazon engine + google_shopping + price_take Haiku call.
  // V.121 — bumped canonical cache key so V.120a soft-match-poisoned payloads
  // (decoy prices that ought to have been null) don't shadow the new strict pipeline.
  const _canonicalKey = `savvey:canonical:v128:${String(parsed.canonical_search_string || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 80)}`;
  if (_canonicalKey.length > 22) {
    const canonHit = await kvGet(_canonicalKey);
    if (canonHit && typeof canonHit === 'object' && canonHit.canonical_search_string) {
      console.log(`[${VERSION}] canonical cache HIT for "${parsed.canonical_search_string}"`);
      kvSet(cKey, canonHit, KV_TTL_SECONDS).catch(() => {});
      return res.status(200).json({
        ...canonHit,
        _meta: { ...(canonHit._meta || {}), cache: 'canonical_hit', latency_ms: Date.now() - t0, version: VERSION, category_hint_received: (body && body.category_hint) || null }
      });
    }
  }

  // Wave FF — parallel SerpAPI fan-out: Amazon engine (price anchor) +
  // google_shopping (non-Amazon retailer PDP deep links). Wall-clock latency
  // unchanged because Promise.all waits for the slowest, and Amazon engine is
  // already the slowest of the two (verified-price gate).
  // V.69 - alternative_amazon_price now rides the existing Promise.all batch
  // (was sequential before; ~600-900ms latency leak on medium-conf queries).
  // Powers disambig-screen thumbnails so users compare visually instead of
  // recalling model numbers (panel mandate 6 May 2026 beta - Logitech M235 vs
  // M185 case). Cost still ONE extra SerpAPI call per disambig (~30% queries).
  let verified_amazon_price = null;
  let retailer_deep_links = null;
  let alternative_amazon_price_v69 = null;
  // V.120a — per-request debug trace. Panel-mandated to surface picker/lexical
  // failure reasons in the JSON response, bypassing Vercel-log truncation.
  const debugTrace = [];
  // V.153 — per-REQUEST diag object. Replaces module-level
  // _lastGoogleShoppingDiag to prevent cross-request state bleed in the
  // Vercel serverless environment where instances handle multiple
  // requests sequentially.
  const _v153LocalDiag = {};
  debugTrace.push({step:'handler.parsed', canonical: String(parsed.canonical_search_string||'').slice(0,120), confidence: parsed.confidence, mpn: parsed.mpn || null});
  if (parsed.canonical_search_string && parsed.confidence !== 'low') {
    const canonicalKey = String(parsed.canonical_search_string).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60);
    const fetchAlt = (parsed.alternative_string && parsed.confidence === 'medium')
      ? fetchVerifiedAmazonPrice(parsed.alternative_string)
      : Promise.resolve(null);
    const [amazonRes, retailersRes, altAmazonRes] = await Promise.all([
      fetchVerifiedAmazonPrice(parsed.canonical_search_string, debugTrace),
      fetchGoogleShoppingDeepLinks(parsed.canonical_search_string, canonicalKey, _v153LocalDiag, false, parsed.identity_fingerprint),
      fetchAlt,
    ]);
    verified_amazon_price = amazonRes;
    retailer_deep_links = retailersRes;
    alternative_amazon_price_v69 = altAmazonRes;
  } else {
    debugTrace.push({step:'handler.skip_serpapi', reason: parsed.confidence === 'low' ? 'low_confidence' : 'no_canonical'});
  }
  debugTrace.push({step:'handler.serpapi_outcome', has_price: !!verified_amazon_price, has_retailers: !!retailer_deep_links});
  // V.69 - alternative_amazon_price now resolved via the parallel batch above.
  const alternative_amazon_price = alternative_amazon_price_v69;


  // V.142 — skip_synth early-exit REMOVED. It referenced variables
  // (_specificity, _retailerOwn, amazon_search_fallback, ...) that are
  // declared LATER in the handler — classic temporal-dead-zone error
  // returning ReferenceError 500s. New approach: gate the synth blocks
  // on !body.skip_synth and add synthesis_payload at the final responseBody.


  // V.138 — Mega-Synthesis Architecture. One Haiku call returning
  // verdict_label + verdict_summary + category_eyebrow + tier_blurbs (the
  // last only used in TIERS mode below). Replaces V.121 callHaikuPriceTake.
  // Panel mandate: NO 5 separate AI calls. JS-math for pricing arithmetic.
  let _megaPillars = { verdict_label: null, verdict_summary: null, category_eyebrow: null, tier_blurbs: null };
  if (!body.skip_synth && verified_amazon_price && parsed.savvey_says) {
    if (Number(verified_amazon_price.price) > 0) {
      parsed.savvey_says.live_amazon_price = verified_amazon_price.price_str
        || `£${Number(verified_amazon_price.price).toFixed(2)}`;
    }
    if (verified_amazon_price.used_price_str) {
      parsed.savvey_says.used_amazon_price = verified_amazon_price.used_price_str;
    }
    if (verified_amazon_price.rating && verified_amazon_price.reviews) {
      const reviewsFmt = verified_amazon_price.reviews >= 1000
        ? (verified_amazon_price.reviews / 1000).toFixed(verified_amazon_price.reviews >= 10000 ? 0 : 1) + 'k'
        : String(verified_amazon_price.reviews);
      parsed.savvey_says.amazon_rating = `${verified_amazon_price.rating}★ · ${reviewsFmt} reviews`;
    } else if (verified_amazon_price.rating) {
      parsed.savvey_says.amazon_rating = `${verified_amazon_price.rating}★`;
    }
    // V.138 slam-dunk shortcut preserved: rating >= 4.6 AND reviews >= 200 AND price > 0
    // -> verdict='good_buy' deterministically, skip the mega Haiku call entirely.
    const _isSlamDunk =
      Number(verified_amazon_price.rating || 0) >= 4.6 &&
      Number(verified_amazon_price.reviews || 0) >= 200 &&
      Number(verified_amazon_price.price || 0) > 0;
    if (_isSlamDunk) {
      parsed.savvey_says.verdict = 'good_buy';
      parsed.savvey_says.price_take = null;
      _megaPillars.verdict_label = 'good_buy';
      console.log(`[${VERSION}] slam-dunk skip mega-synthesis for "${parsed.canonical_search_string}"`);
    } else {
      try {
        // V.179 — STRICT DATA BINDING. The Haiku synth must receive ONLY
        // the retailers and prices that survive the full filter cascade
        // (V.145 median floor → V.159 outlier delete → V.169 reality anchor).
        // Building from raw retailer_deep_links was leaking pre-filter
        // prices into the prompt, which is how the AI hallucinated "EE
        // Store £349" when the UI showed no such row. Source the AI's
        // retailers list from _v138.links — that IS the final UI state.
        const _v179FinalLinks = (_v138 && Array.isArray(_v138.links)) ? _v138.links : [];
        const _v179RetailersForAI = _v179FinalLinks
          .filter(l => l && l.price_gbp != null && !l.is_outlier)
          .map(l => ({
            name:  l.retailer || l.retailer_key || 'Retailer',
            price: l.price_gbp,
          }));
        const ai = await callHaikuMegaSynthesis({
          canonical:     parsed.canonical_search_string,
          category:      parsed.category,
          market_status: parsed.market_status,
          amazon: {
            price:          verified_amazon_price.price,
            price_str:      verified_amazon_price.price_str,
            used_price_str: verified_amazon_price.used_price_str,
            rating:         verified_amazon_price.rating,
            reviews:        verified_amazon_price.reviews,
            title:          verified_amazon_price.title,
          },
          retailers: _v179RetailersForAI.length > 0 ? _v179RetailersForAI : null,
          alternatives: null, // Pillars mode
          trace: debugTrace,
        });
        if (ai) {
          _megaPillars = ai;
          // Legacy savvey_says mirror for back-compat (frontend V.121 path)
          if (ai.verdict_label)   parsed.savvey_says.verdict    = ai.verdict_label;
          if (ai.verdict_summary) parsed.savvey_says.price_take = ai.verdict_summary;
        }
      } catch (e) { /* non-critical */ }
    }
    // v3.4.5d — deterministic fallback. If Haiku didn't recognise the canonical
    // (returned null verdict despite a verified Amazon match), the worst-case
    // is a confident-looking green CTA on a wrong-SKU listing (e.g. Bosch
    // canonical 'UniversalGardenTidy' surfacing a £27.99 Bosch battery as if
    // it were the leaf blower). Force check_elsewhere so the user is warned.
    // Pure stateless guardrail — no prompt tinkering, no extra API call.
    if (!parsed.savvey_says.verdict && verified_amazon_price && Number(verified_amazon_price.price) > 0) {
      parsed.savvey_says.verdict = 'check_elsewhere';
      if (!parsed.savvey_says.price_take) {
        parsed.savvey_says.price_take = "Couldn't fully verify this listing matches the product — confirm details before buying.";
      }
    }
  }

  // v3.4.5n SA panel veto guard (6 May 2026): if no verified Amazon anchor
  // was returned by SerpAPI for this query, NULL any £/$/GBP/€ patterns that
  // may have leaked into savvey_says fields. Defense-in-depth — the existing
  // flow already gates price_take behind verified_amazon_price, but this
  // catches future regressions (a Haiku field accidentally introducing a
  // price claim, a future schema field forgetting to gate). 'Product
  // Identified' state without an invented price band is the panel-mandated
  // pivot until Keepa lands — accuracy over UI completeness.
  if (!verified_amazon_price && parsed.savvey_says && typeof parsed.savvey_says === 'object') {
    const _hasGbp = (s) => typeof s === 'string' && /(?:£|GBP|€|\$)\s*\d/i.test(s);
    for (const k of ['price_take', 'consensus', 'timing_advice', 'review_consensus']) {
      if (_hasGbp(parsed.savvey_says[k])) {
        parsed.savvey_says[k] = null;
      }
    }
  }

  // v3.4.5e — server-side word cap on Savvey Says copy (panel-mandated 5 May
  // 2026 PM, Product Owner ruling). Haiku occasionally returns 25-40 word
  // ramble that breaks the result-card layout on phones and undermines the
  // "brutal honesty in 10 words" brand commitment. Hard cap at 10 words with
  // ellipsis fallback. Applies after all upstream Haiku writes + deterministic
  // fallback so the cap is the final word.
  const _capWords = (s, n = 10) => {
    if (typeof s !== 'string') return s;
    const t = s.trim();
    if (!t) return s;
    const words = t.split(/\s+/);
    if (words.length <= n) return t;
    return words.slice(0, n).join(' ').replace(/[.,;:!?]+$/, '') + '…';
  };
  if (parsed.savvey_says && typeof parsed.savvey_says === 'object') {
    if (parsed.savvey_says.price_take)    parsed.savvey_says.price_take    = _capWords(parsed.savvey_says.price_take);
    if (parsed.savvey_says.timing_advice) parsed.savvey_says.timing_advice = _capWords(parsed.savvey_says.timing_advice);
    // V.113 — fix V.85e typo: was capping `review_consensus` (which doesn't exist)
    // instead of `consensus` (the actual field). Caused PS5 Pro to return 14-word
    // ramble breaking the 10-word brand-honesty promise. Audit-found 10 May 2026.
    if (parsed.savvey_says.consensus)     parsed.savvey_says.consensus     = _capWords(parsed.savvey_says.consensus);
  }

  // Wave FF — emit specificity flag + retailer_deep_links on the response
  // root. specificity drives frontend confidence-gated routing (specific →
  // result page, brand_only → disambig). retailer_deep_links is a
  // hostname → {url,title,price} map, populated from google_shopping when
  // available, null otherwise.
  // Wave HH — build disambig_candidates array (2-4 items). Emitted on
  // response root. Frontend uses this when specificity==='brand_only' OR
  // confidence!=='high' to render dynamic candidate list (replaces legacy
  // 2-option flow). Order: canonical, alternative_string, alternatives_array.
  // Deduped (case-insensitive trim), capped at 4.
  const _specificity = assessSpecificity(parsed.canonical_search_string, parsed.mpn, parsed.confidence);
  let disambig_candidates = null;
  let disambig_candidates_meta = null; // Wave KK — parallel array, [{typical_price_gbp, pack_size, tier_label}|null, ...]
  const _shouldDisambig = (parsed.confidence !== 'high') || (_specificity === 'brand_only');
  if (_shouldDisambig && parsed.canonical_search_string) {
    // Wave HH.2 — when canonical is brand_only AND we have 2+ specific
    // alternatives, drop the canonical from disambig.
    const _altPool = [];
    const _altMetaPool = [];
    if (parsed.alternative_string) {
      _altPool.push(parsed.alternative_string);
      _altMetaPool.push(null); // alternative_string has no meta yet
    }
    if (Array.isArray(parsed.alternatives_array)) {
      for (let i = 0; i < parsed.alternatives_array.length; i++) {
        _altPool.push(parsed.alternatives_array[i]);
        _altMetaPool.push((parsed.alternatives_meta && parsed.alternatives_meta[i]) || null);
      }
    }
    const _specAlts = _altPool.filter(s => assessSpecificity(s, null, 'medium') === 'specific');
    const _skipCanonical = (_specificity === 'brand_only') && (_specAlts.length >= 2);

    const seen = new Set();
    const pool = [];
    const metaPool = [];
    if (!_skipCanonical) {
      pool.push(parsed.canonical_search_string);
      metaPool.push(null); // canonical has no meta in this wave
    }
    for (let i = 0; i < _altPool.length; i++) {
      pool.push(_altPool[i]);
      metaPool.push(_altMetaPool[i]);
    }

    const uniq = [];
    const uniqMeta = [];
    for (let i = 0; i < pool.length; i++) {
      const s = pool[i];
      if (typeof s !== 'string') continue;
      const k = s.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      uniq.push(s.trim().slice(0, 200));
      uniqMeta.push(metaPool[i]);
      if (uniq.length >= 4) break;
    }
    if (uniq.length >= 2) {
      disambig_candidates = uniq;
      // Wave KK — emit meta only if at least one entry has data
      if (uniqMeta.some(m => m !== null)) {
        disambig_candidates_meta = uniqMeta;
      }
    }
  }

  // V.140 — Tier-fallback invocation REMOVED. Strict one-LLM-call.
  // If the primary parse returned <2 alternatives, we let the outcome
  // gate route to no_match below — never chain a second AI call here.

  // V.138/V.139 — TIERS-mode mega-synthesis. Fires when we have 2-4
  // alternatives with meta. Single Haiku call (Panel mandate: NO 5
  // separate AI calls; tier-fallback above is the documented exception).
  // Returns tier_blurbs[] for the disambig render.
  let _megaTiers = { verdict_label: null, verdict_summary: null, category_eyebrow: null, tier_blurbs: null };
  const _altsLenPost = Array.isArray(parsed.alternatives_array) ? parsed.alternatives_array.length : 0;
  if (!body.skip_synth && _altsLenPost >= 2 && _altsLenPost <= 4
      && Array.isArray(parsed.alternatives_meta)
      && parsed.alternatives_meta.length === _altsLenPost) {
    try {
      _megaTiers = await callHaikuMegaSynthesis({
        canonical:     parsed.canonical_search_string,
        category:      parsed.category,
        market_status: parsed.market_status,
        amazon:        null,
        retailers:     null,
        alternatives: parsed.alternatives_array.map((name, i) => {
          const m = parsed.alternatives_meta[i] || {};
          return {
            name,
            typical_price_gbp: m.typical_price_gbp || null,
            rating:            m.rating || null,
            reviews:           m.reviews || null,
            pack_size:         m.pack_size || null,
          };
        }),
        trace: debugTrace,
      }) || _megaTiers;
    } catch (e) {
      console.warn(`[${VERSION}] V.138 tiers mega-synth error: ${e.message}`);
    }
  }

  // V.78 — retailer-own detection. If canonical leads with a UK retailer-own
  // brand (Habitat/IKEA/M&S Home/Dunelm/Argos Home/The Range), stamp _meta
  // so the frontend can short-circuit to a "Sold direct by [Brand]" empty
  // state instead of a frustrating "couldn't find on Amazon UK" message.
  // Only fires when specificity is brand_only — if the canonical has a real
  // model number we still try Amazon first.
  const _retailerOwn = (_specificity === 'brand_only') ? detectRetailerOwn(parsed.canonical_search_string) : null;

  // V.89 — Honest review synthesis. Only when we have a confidently-identified
  // product with rating + reviews. Cost: 1 extra Haiku call. Latency: +500-700ms
  // but parallelisable with other calls in the future. Skipped for low-conf or
  // missing-rating to avoid hallucination.
  let review_synthesis = null;
  if (verified_amazon_price && verified_amazon_price.rating && verified_amazon_price.reviews && parsed.confidence !== 'low') {
    try {
      review_synthesis = await generateReviewSynthesis(
        parsed.canonical_search_string,
        verified_amazon_price.rating,
        verified_amazon_price.reviews
      );
    } catch (err) {
      console.warn(`[${VERSION}] V.89 review-synth error: ${err.message}`);
    }
  }

  // V.88 — Budget recommendation. Detects "under £X" / "below £X" patterns in
  // text input and generates 3-4 ranked specific picks via Haiku. Only fires
  // for text inputs (not image/barcode/url) with a clear budget signal.
  let recommendations = null;
  if (inputType === 'text' && body && typeof body.text === 'string') {
    try {
      const intent = detectBudgetIntent(body.text);
      if (intent) {
        recommendations = await generateBudgetRecommendations(intent.category_query, intent.budget_gbp);
      }
    } catch (err) {
      console.warn(`[${VERSION}] V.88 budget-rec error: ${err.message}`);
    }
  }

  // V.87 — Visual similarity. Originally only fired on confidence=='low'.
  // V.95 broadens the trigger: ALSO fire when an image produced empty
  // retailer_deep_links AND null verified_amazon_price — i.e. Haiku felt
  // confident enough to set medium/high but the downstream lookup found
  // nothing useful (Vincent's garden-storage-box case: Haiku says
  // "garden storage box plastic", SerpAPI returns no Amazon match + no
  // retailer PDP, user gets dead result. Now they get a Find Similar rail).
  let visual_matches = null;
  const _retailerLinkCount = retailer_deep_links && typeof retailer_deep_links === 'object'
    ? Object.keys(retailer_deep_links).length
    : 0;
  const _v87LowConfTrigger = (parsed.confidence === 'low');
  const _v87EmptyResultTrigger = (
    parsed.specificity !== 'specific'
    && verified_amazon_price === null
    && _retailerLinkCount === 0
  );
  if (inputType === 'image' && (_v87LowConfTrigger || _v87EmptyResultTrigger)) {
    try {
      const framesIn = Array.isArray(body.image_base64_frames) ? body.image_base64_frames : null;
      const reusePayload = framesIn && framesIn.length > 0 ? framesIn.slice(0, 3) : (body.image_base64 || null);
      const mediaType = body.media_type || 'image/jpeg';
      visual_matches = await describeAndSearchSimilar(reusePayload, mediaType);
      if (visual_matches && visual_matches.matches && Object.keys(visual_matches.matches).length > 0) {
        console.log(`[${VERSION}] V.95 V.87-broadened recovery fired (lowConf=${_v87LowConfTrigger} emptyResult=${_v87EmptyResultTrigger}, ${Object.keys(visual_matches.matches).length} matches)`);
      }
    } catch (err) {
      console.warn(`[${VERSION}] V.87 visual-similarity error: ${err.message}`);
    }
  }

  // V.103 — amazon_search_fallback: Every response gets a tagged Amazon UK
  // search URL, so the frontend can ALWAYS surface a clickable CTA — even
  // when verified_amazon_price + retailer_deep_links + visual_matches all
  // come back empty. No blank screens, ever. Garden-box no longer dead-ends.
  const _amazonFallbackQ = (parsed.amazon_search_query || parsed.canonical_search_string || '').slice(0, 150);
  const amazon_search_fallback = _amazonFallbackQ
    ? `https://www.amazon.co.uk/s?k=${encodeURIComponent(_amazonFallbackQ)}&tag=${encodeURIComponent(AMAZON_TAG)}`
    : null;

  debugTrace.push({step:'handler.final', verdict: (parsed && parsed.savvey_says && parsed.savvey_says.verdict) || null, has_price: !!verified_amazon_price, latency_ms: Date.now() - t0});

  // V.138 — Build the new schema response block. Single mega-synth result is
  // selected based on flow: Pillars mode uses _megaPillars, Tiers mode uses
  // _megaTiers. _v138BuildResponse produces { outcome, identity, pricing,
  // verdict, links, tiers, disclosure } per the locked V.138 schema. Legacy
  // V.121 fields are preserved alongside for back-compat (existing analytics +
  // older frontend hashes).
  // V.140 — accept 2-4 alternatives for the tiers-mega routing (was strict ===3).
  // V.200 — Ambiguity Catcher. If the user typed a single-word generic
  // noun (e.g. "notebook", "lamp", "pen") AND Haiku returned empty
  // alternatives_array, forcibly inject 3 hard-coded generic-tier
  // candidates so the UI routes to disambig (Outcome 3) instead of
  // dropping into no_match / identification_failed.
  const _v200RawInput = (typeof body.text === 'string') ? body.text : null;
  const _v200CurrentAlts = Array.isArray(parsed.alternatives_array) ? parsed.alternatives_array.length : 0;
  if (_v200RawInput && _v200CurrentAlts === 0) {
    const _v200Tiers = _v200GenericFallback(_v200RawInput);
    if (_v200Tiers && _v200Tiers.length === 3) {
      try { console.log(`[V.200][generic_fallback] "${_v200RawInput}" → injecting 3 hard-coded generic tiers (Budget/Top Rated/Premium)`); } catch (e) {}
      parsed.alternatives_array = _v200Tiers.slice();
      parsed.alternatives_meta = _v200Tiers.map((name, i) => ({
        intent_label: ['Best Value', 'Top Rated', 'Premium Choice'][i],
        rationale:    ['Cheapest reliable option.', 'Most popular UK pick.', 'Top-end build quality.'][i],
        typical_price_gbp: null,
        est_price_range:   null,
        pack_size:         null,
        tier_label:        ['Budget', 'Mid-tier', 'Premium'][i],
      }));
      parsed.confidence = 'low';
      // Force-pivot the canonical so the disambig screen reads cleanly.
      if (!parsed.canonical_search_string || parsed.canonical_search_string.toLowerCase() === _v200RawInput.toLowerCase()) {
        parsed.canonical_search_string = _v200RawInput.charAt(0).toUpperCase() + _v200RawInput.slice(1).toLowerCase();
      }
    }
  }

  const _altsLenFinal = Array.isArray(parsed.alternatives_array) ? parsed.alternatives_array.length : 0;
  const _megaForBuild = (_altsLenFinal >= 2 && _altsLenFinal <= 4)
    ? _megaTiers
    : _megaPillars;
  const _v138 = _v138BuildResponse({
    parsed,
    verified_amazon_price,
    retailer_deep_links,
    alternative_amazon_price,
    mega: _megaForBuild,
    inputType,
    serpapi_status: _lastSerpStatus,
    // V.175 — pass the raw user input so the bare-brand disambig gate
    // can inspect the ORIGINAL query ("PS5") rather than Haiku's resolved
    // canonical ("Sony PlayStation 5 Slim Disc").
    rawInputText: (typeof body.text === 'string') ? body.text
                : (typeof body.url === 'string') ? body.url
                : null,
  });

  const responseBody = {
    ...parsed,
    specificity: _specificity,
    verified_amazon_price,
    alternative_amazon_price,
    retailer_deep_links,
    disambig_candidates, // Wave HH
    disambig_candidates_meta, // Wave KK — parallel array with typical_price_gbp + pack_size + tier_label per candidate
    amazon_search_fallback, // V.103 — never-blank-screens guarantee
    visual_matches, // V.87 - low-conf snap visual similarity, null otherwise
    recommendations, // V.88 - budget-pattern Haiku recommendations, null otherwise
    review_synthesis, // V.89 - honest love/gripe pair, null otherwise
    debug_trace: debugTrace, // V.120a — Panel-mandated pipeline trace
    // V.138 schema (frontend consumes these for the V.137 four-pillar + three-tier UI)
    outcome:         _v138.outcome,
    outcome_reason:  _v138.outcome_reason,
    identity:        _v138.identity,
    pricing:         _v138.pricing,
    verdict:         _v138.verdict,
    links:           _v138.links,
    tiers:           _v138.tiers,
    disclosure:      _v138.disclosure,
    schema_version:  _v138.schema_version,
    // V.169 — surface the AI's reality anchor + the threshold the
    // backend used. Lets the benchmark / Panel verify the AI is emitting
    // sensible floors and that implausibility decisions are auditable.
    predicted_price_floor_gbp: (parsed && typeof parsed.predicted_price_floor_gbp === 'number') ? parsed.predicted_price_floor_gbp : null,
    // V.142 — synthesis_payload emitted whenever skip_synth=true so
    // /api/identify clients can drive /api/synthesize separately.
    synthesis_payload: body.skip_synth ? {
      // V.165 — mode follows the outcome.
      // V.168 — matched_thin ALSO renders the Four Pillars, so it gets
      // pillars synthesis (verdict + summary). Disambig stays tiers.
      // not_found / no_match get nothing renderable, so default to pillars
      // (the synth call will no-op if synthesis_payload.canonical is missing).
      mode: ((_v138.outcome === 'matched') || (_v138.outcome === 'matched_thin'))
            ? 'pillars'
            : ((Array.isArray(parsed.alternatives_array) && parsed.alternatives_array.length >= 2) ? 'tiers' : 'pillars'),
      canonical:     parsed.canonical_search_string || null,
      category:      parsed.category || null,
      market_status: parsed.market_status || null,
      amazon: verified_amazon_price ? {
        price:          verified_amazon_price.price,
        price_str:      verified_amazon_price.price_str,
        rating:         verified_amazon_price.rating,
        reviews:        verified_amazon_price.reviews,
        title:          verified_amazon_price.title,
        used_price_str: verified_amazon_price.used_price_str,
      } : null,
      // V.179 — STRICT DATA BINDING (split-routing path). The
      // synthesis_payload that /api/synthesize replays MUST contain
      // only the retailers + prices that survived V.145/V.159/V.169.
      // Source from _v138.links (the final UI list), not from the raw
      // retailer_deep_links bucket. This is the load-bearing fix for
      // the "AI mentions £349 EE Store but no such row in UI" defect.
      retailers: (function () {
        var finalLinks = (_v138 && Array.isArray(_v138.links)) ? _v138.links : [];
        var arr = finalLinks
          .filter(function (l) { return l && l.price_gbp != null && !l.is_outlier; })
          .map(function (l) {
            return {
              name:  l.retailer || l.retailer_key || 'Retailer',
              price: l.price_gbp,
            };
          });
        return arr.length > 0 ? arr : null;
      })(),
      alternatives: (Array.isArray(parsed.alternatives_array) && Array.isArray(parsed.alternatives_meta))
        ? parsed.alternatives_array.slice(0, 4).map((name, i) => {
            const m = parsed.alternatives_meta[i] || {};
            return {
              name,
              typical_price_gbp: m.typical_price_gbp || null,
              rating:            m.rating || null,
              reviews:           m.reviews || null,
              pack_size:         m.pack_size || null,
            };
          }) : null,
    } : undefined,
    _meta: {
      version: VERSION,
      input_type: inputType,
      latency_ms: Date.now() - t0,
      cache: 'miss',
      retailer_own: _retailerOwn, // V.78 — null or { brand, url }
      serpapi_status: _lastSerpStatus, // V.96.1 - bubble for diagnosis
      serp_diag: _v153LocalDiag, // V.153 — per-request diag, no module-level leak
    }
  };
  // V.97 — Don't cache failure responses when SerpAPI returned 429 (quota).
  // Otherwise we'd serve stale-empty for the full TTL after the quota refills.
  // Empty fail = no verified price, no retailer chips, no visual matches.
  // V.157 — extended cache-skip predicate. Any network-class bail
  // (timeout, network_error, network_timeout, serpapi_http_5xx) means the
  // retailer stack is missing because of transient infra failure, NOT
  // because the item genuinely has no competitors. Caching that would
  // poison subsequent retries (V.156 surfaced this when retries returned
  // cache=hit with BAIL=network_timeout 6 hours later).
  const _v157BailReason = _v153LocalDiag && _v153LocalDiag.bail_reason;
  const _v157NetworkBail = _v157BailReason && (
       _v157BailReason === 'network_timeout'
    || _v157BailReason === 'network_error'
    || _v157BailReason === 'no_apikey'
    || (typeof _v157BailReason === 'string' && _v157BailReason.startsWith('serpapi_http_5'))
  );
  const _isQuotaFail = (_lastSerpStatus === 429 || _lastSerpStatus === 'fetch_error')
                       && !verified_amazon_price
                       && (!retailer_deep_links || Object.keys(retailer_deep_links).length === 0)
                       && !visual_matches;
  if (_v157NetworkBail) {
    console.warn(`[${VERSION}] V.157 skipping cache write — google_shopping ${_v157BailReason} for "${(parsed.canonical_search_string||'').slice(0,60)}". Allowing next request to retry fresh.`);
  }
  if (!_isQuotaFail && !_v157NetworkBail) {
    kvSet(cKey, responseBody, KV_TTL_SECONDS).catch(() => {});
    // Wave II — also write to canonical-keyed cache so different input
    // phrasings resolving to the same canonical share the cached response.
    // V.97 - canonical writes use 7-day TTL since canonical-level data is stable.
    if (_canonicalKey && _canonicalKey.length > 22 && !_v157NetworkBail) {
      kvSet(_canonicalKey, responseBody, CANONICAL_TTL_SECONDS).catch(() => {});
    }
  } else {
    console.warn(`[${VERSION}] V.97 skipping cache write — SerpAPI quota fail (status=${_lastSerpStatus}). Lets next request retry fresh.`);
  }
  return res.status(200).json(responseBody);
}

// V.202 Fix J — JSON ERROR ENVELOPE. Exported handler wraps the internal
// implementation in a top-level try/catch. Any thrown exception that the
// internal handler doesn't catch is converted into a valid JSON response
// so the frontend NEVER sees a raw Vercel HTML 500/504 error page.
export default async function handler(req, res) {
  const _v202T0 = Date.now();
  try {
    return await _v202InnerHandler(req, res);
  } catch (err) {
    const _msg = err && err.message ? String(err.message).slice(0, 240) : String(err).slice(0, 240);
    const _name = err && err.name ? String(err.name).slice(0, 40) : 'Error';
    try {
      console.error(`[${VERSION}] [V.202][envelope] UNCAUGHT ${_name}: ${_msg}`);
      if (err && err.stack) console.error(err.stack.toString().slice(0, 1200));
    } catch (e) {}
    // If headers were already sent (handler wrote a partial response then
    // threw mid-stream) we can't write a new envelope. Just bail.
    if (res.headersSent) {
      try { res.end(); } catch (e2) {}
      return;
    }
    try { applySecurityHeaders(res, ORIGIN); } catch (e) {}
    return res.status(200).json({
      outcome: 'no_match',
      outcome_reason: 'v202_envelope_caught',
      error: 'upstream_exception',
      message: 'Savvey hit an unexpected hiccup — try again in a moment.',
      links: [],
      pricing: { best_price: null, avg_market: null, price_band: null },
      identity: null,
      alternatives_array: [],
      _meta: {
        version: VERSION,
        envelope: 'v202_caught',
        exception_name: _name,
        exception_message: _msg,
        latency_ms: Date.now() - _v202T0,
      },
    });
  }
}
