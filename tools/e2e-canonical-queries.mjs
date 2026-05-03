#!/usr/bin/env node
// tools/e2e-canonical-queries.mjs — Wave 94
//
// End-to-end smoke test for Savvey's price API. Hits production with 20
// canonical queries that exercise different paths (specific products,
// generic categories, books, home, future-products) and asserts:
//   - At least 1 retailer returned (not zero — that's the Wave 86 regression)
//   - Cheapest is in plausible range for known products
//
// Run BEFORE every push:   node tools/e2e-canonical-queries.mjs
// Or against staging:      BASE=https://savvey-staging.vercel.app node tools/e2e-canonical-queries.mjs
// Exits 0 on success, 1 on regression.
//
// Started as the response to the Wave 86 regression — cordless vacuum
// cleaner returned zero for 30+ minutes in production because nobody
// re-ran the canonical queries after the deploy.

const BASE = process.env.BASE || 'https://savvey.vercel.app';

// Canonical queries with optional plausible-price ranges. Where range is
// set, the cheapest result must fall within it (or test fails).
// `minRetailers` is the minimum acceptable result count.
const TESTS = [
  // Specific tech (high-confidence price ranges)
  { q: 'AirPods Pro 2',          minRetailers: 1, plausible: [150, 280] },
  { q: 'Sony WH-1000XM5',        minRetailers: 1, plausible: [200, 380] },
  { q: 'iPhone 17',              minRetailers: 1, plausible: [700, 1000] },
  { q: 'Nintendo Switch',        minRetailers: 1, plausible: [180, 320] },
  { q: 'PS5',                    minRetailers: 1, plausible: [350, 600] },
  // Generic categories (full-spread retailer surfacing)
  { q: 'kettle',                 minRetailers: 3 },
  { q: 'cordless vacuum cleaner',minRetailers: 3 },  // The Wave 86 regression target
  { q: 'air fryer',              minRetailers: 3 },
  { q: 'electric toothbrush',    minRetailers: 3 },
  { q: 'hair dryer',             minRetailers: 3 },
  { q: 'lawn mower',             minRetailers: 3 },
  // Home / kitchen
  { q: 'Le Creuset casserole',   minRetailers: 2 },
  { q: 'memory foam mattress',   minRetailers: 2 },
  { q: 'Dyson V15 Detect',       minRetailers: 1, plausible: [400, 800] },
  // DIY
  { q: 'Makita cordless drill',  minRetailers: 2 },
  // Books
  { q: 'Atomic Habits book',     minRetailers: 1, plausible: [5, 30] },
  // Beauty
  { q: 'Olaplex No 3',           minRetailers: 1, plausible: [15, 35] },
  // Fashion
  { q: 'Adidas Samba',           minRetailers: 1 },
  { q: 'Levi 501 jeans',         minRetailers: 1, plausible: [30, 200] },
  // Toys
  { q: 'Lego Millennium Falcon', minRetailers: 1 },
];

async function fetchJson(url, body){
  const r = await fetch(url, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  if(!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function searchSavvey(q){
  // Mirror the frontend tier-1/tier-2 logic: prefer Tier 1 (ai-search) when
  // it has 2+ results, otherwise fall through to Tier 2 (search.js).
  const ai = await fetchJson(`${BASE}/api/ai-search`, { q, region: 'uk' }).catch(() => null);
  const aiCount = ai && ai.shopping ? ai.shopping.length : 0;
  if(aiCount >= 2){
    return { tier: 1, items: ai.shopping, meta: ai._meta };
  }
  const s2 = await fetchJson(`${BASE}/api/search`, { q: q + ' buy UK price', type: 'shopping' }).catch(() => null);
  if(!s2 || !s2.shopping){
    return { tier: 2, items: [], meta: { error: 'tier-2 failed' } };
  }
  return { tier: 2, items: s2.shopping, meta: s2._meta };
}

function priceFromString(s){
  const n = parseFloat(String(s).replace(/[^0-9.]/g,''));
  return Number.isFinite(n) ? n : null;
}

(async () => {
  console.log(`E2E canonical queries against ${BASE}\n`);
  let pass = 0, fail = 0;
  const failures = [];
  for(const test of TESTS){
    let result;
    try {
      result = await searchSavvey(test.q);
    } catch (e) {
      failures.push({ q: test.q, reason: 'fetch error: ' + e.message });
      fail++;
      console.log(`  ✗ ${test.q.padEnd(30)} fetch error: ${e.message}`);
      continue;
    }
    const cnt = result.items.length;
    if(cnt < test.minRetailers){
      failures.push({ q: test.q, reason: `expected ≥${test.minRetailers} retailers, got ${cnt}` });
      fail++;
      console.log(`  ✗ ${test.q.padEnd(30)} ${cnt} retailers (need ≥${test.minRetailers}) [tier ${result.tier}]`);
      continue;
    }
    if(test.plausible){
      const cheapest = priceFromString(result.items[0].price);
      const [lo, hi] = test.plausible;
      if(cheapest === null || cheapest < lo || cheapest > hi){
        failures.push({ q: test.q, reason: `cheapest £${cheapest} outside plausible £${lo}-£${hi}` });
        fail++;
        console.log(`  ✗ ${test.q.padEnd(30)} £${cheapest} outside £${lo}-£${hi} [tier ${result.tier}]`);
        continue;
      }
    }
    const cheapest = priceFromString(result.items[0].price);
    console.log(`  ✓ ${test.q.padEnd(30)} ${cnt} retailers, cheapest £${cheapest} [tier ${result.tier}]`);
    pass++;
  }
  console.log(`\n${pass}/${pass+fail} passed`);
  if(fail > 0){
    console.log(`\nFailures:`);
    for(const f of failures) console.log(`  - ${f.q}: ${f.reason}`);
    process.exit(1);
  }
  process.exit(0);
})();
