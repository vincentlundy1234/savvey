#!/usr/bin/env node
// V.152 — automated QA harness. Calls the LIVE /api/identify and
// /api/synthesize endpoints, asserts the four panel-mandated cases,
// and dumps raw SerpAPI samples on failure so the parser fix can be
// evidence-based rather than guess-driven.
//
// Run with:  node test_suite.js

const BASE = process.env.SAVVEY_BASE || 'https://savvey.vercel.app';

// V.159 — single-product image-extraction audit per Panel mandate.
// Tests the long-tail path (Petzl carabiner — Amazon picker almost never
// verifies these, so identity.image must come from the google_shopping
// fallback added in V.159). Set SAVVEY_SINGLE=1 to force one-case mode.
const CASES = (process.env.SAVVEY_SINGLE === '1') ? [
  { name: 'IMG: text "Petzl Sm\'D Twist-Lock Carabiner"',
    body: { input_type: 'text', text: "Petzl Sm'D Twist-Lock Carabiner" },
    expect: { image_present: true, links_min: 1 } },
] : [
  { name: 'A: text "playstation 5"',
    body: { input_type: 'text', text: 'playstation 5' },
    expect: { outcome: 'disambig' } },
  { name: 'B: text "Sony PlayStation 5 Pro"',
    body: { input_type: 'text', text: 'Sony PlayStation 5 Pro' },
    expect: { links_min: 3 } },
  { name: 'C: text "Ninja Air Fryer MAX PRO AF180UK"',
    body: { input_type: 'text', text: 'Ninja Air Fryer MAX PRO AF180UK' },
    expect: { links_min: 3 } },
  { name: 'D: text "Dyson V15 Detect Absolute"',
    body: { input_type: 'text', text: 'Dyson V15 Detect Absolute' },
    expect: { links_min: 3 } },
];

async function postJSON(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { _raw: text }; }
  return { status: r.status, body: j };
}

function summarise(j) {
  const links = Array.isArray(j.links) ? j.links : [];
  const sd = (j._meta && j._meta.serp_diag) || {};
  const img = j.identity && j.identity.image;
  return {
    version: j._meta && j._meta.version,
    outcome: j.outcome,
    outcome_reason: j.outcome_reason,
    disambig_kind: j.disambig_kind,
    canonical: (j.identity && j.identity.canonical) || j.canonical_search_string,
    image_url:    img ? img.thumbnail_url : null,
    image_source: img ? img.source : null,
    confidence: j.confidence,
    family_applied: j._v146_family_applied,
    best_price: j.pricing && j.pricing.best_price && {
      gbp: j.pricing.best_price.value_gbp,
      retailer: j.pricing.best_price.retailer,
    },
    avg_market: j.pricing && j.pricing.avg_market && {
      gbp: j.pricing.avg_market.value_gbp,
      n: j.pricing.avg_market.retailer_count,
      median: j.pricing.avg_market.median_gbp,
      outliers: j.pricing.avg_market.outliers_rejected,
    },
    links_count: links.length,
    links: links.map(l => `${l.retailer}:${l.price_str || '—'}`).join(' | '),
    serp_diag: {
      examined: sd.examined,
      kept: sd.kept,
      priced: sd.priced,
      dropped_no_url: sd.dropped_no_url,
      dropped_no_price: sd.dropped_no_price,
      dropped_redirector: sd.dropped_redirector,
    },
    serp_samples: sd.samples || [],
    serp_dropped_samples: sd.dropped_samples || [],
    serp_raw_samples: sd.raw_samples || [],
    tiers_count: Array.isArray(j.tiers) ? j.tiers.length : 0,
  };
}

function check(name, expect, j) {
  const links = Array.isArray(j.links) ? j.links.length : 0;
  const results = [];
  if (expect.outcome !== undefined) {
    results.push({
      label: `outcome === '${expect.outcome}'`,
      pass: j.outcome === expect.outcome,
      got: j.outcome,
    });
  }
  if (expect.links_min !== undefined) {
    results.push({
      label: `links.length >= ${expect.links_min}`,
      pass: links >= expect.links_min,
      got: links,
    });
  }
  // V.159 — assert identity.image.thumbnail_url is a valid http(s) URL.
  if (expect.image_present !== undefined) {
    const img = j.identity && j.identity.image;
    const ok = !!(img && typeof img.thumbnail_url === 'string' && /^https?:\/\//.test(img.thumbnail_url));
    results.push({
      label: `identity.image.thumbnail_url is http(s)`,
      pass: ok === !!expect.image_present,
      got: img ? (img.thumbnail_url + ' (source=' + img.source + ')') : 'null',
    });
  }
  const allPass = results.every(r => r.pass);
  return { results, allPass };
}

(async () => {
  console.log('Savvey V.152 test_suite — base:', BASE);
  console.log('Target deployment version expected: v3.4.5v152\n');

  let totalPass = 0, totalFail = 0;
  const failures = [];

  for (const c of CASES) {
    console.log('───────────────────────────────────────────────────────────');
    console.log(c.name);
    console.log('Body:', JSON.stringify(c.body));
    let res;
    try {
      res = await postJSON('/api/identify', c.body);
    } catch (e) {
      console.log('  FETCH FAILED:', e.message);
      totalFail++;
      continue;
    }
    if (res.status !== 200) {
      console.log(`  HTTP ${res.status} —`, JSON.stringify(res.body).slice(0, 400));
      totalFail++;
      continue;
    }
    const s = summarise(res.body);
    console.log('Response summary:');
    console.log(JSON.stringify(s, null, 2));

    const check_ = check(c.name, c.expect, res.body);
    for (const r of check_.results) {
      console.log(`  ${r.pass ? '✅' : '❌'} ${r.label} → got ${r.got}`);
      r.pass ? totalPass++ : totalFail++;
    }
    if (!check_.allPass) failures.push({ case: c.name, summary: s, raw: res.body });
    await new Promise(r => setTimeout(r, 400)); // gentle rate-limit
  }

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('SUMMARY');
  console.log(`Pass: ${totalPass}  Fail: ${totalFail}`);
  if (failures.length > 0) {
    console.log('\nFAILURES detail (raw_samples for parser audit):');
    for (const f of failures) {
      console.log('\n→', f.case);
      console.log('canonical:', f.summary.canonical);
      console.log('outcome:', f.summary.outcome, '/', f.summary.outcome_reason);
      console.log('links_count:', f.summary.links_count);
      console.log('serp_diag:', JSON.stringify(f.summary.serp_diag));
      console.log('serp_raw_samples:');
      console.log(JSON.stringify(f.summary.serp_raw_samples, null, 2));
    }
  }
  process.exit(totalFail > 0 ? 1 : 0);
})();
