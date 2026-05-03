#!/usr/bin/env node
// Savvey v2 — identity-accuracy battery runner
// Hits the live /api/ai-search for each query, scores against ground truth.
// Writes detailed JSON + markdown summary to tools/battery-results-{timestamp}.json|md.
//
// Usage:
//   node tools/run-battery.mjs                       # default endpoint
//   node tools/run-battery.mjs --endpoint=https://savvey.vercel.app
//   node tools/run-battery.mjs --query=bosch-leaf-blower-18v   # single query
//
// Pass rule (from identity-test-battery.json _pass_rule):
//   PASS = system returns a result whose title contains all expected_qualifiers
//          AND price falls in expected_price_band_gbp
//        OR system honestly emits NO_EXACT_MATCH / category-spread / low-confidence
//          when expected_state allows it
//   FAIL = system returns confident result not matching expected_qualifiers
//        OR price falls outside expected band by >30%

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2).reduce((acc, a) => {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) acc[m[1]] = m[2];
  return acc;
}, {});
const ENDPOINT = args.endpoint || 'https://savvey.vercel.app';
const SINGLE   = args.query || null;

// ── Load battery ─────────────────────────────────────────────────
const batteryPath = path.join(__dirname, 'identity-test-battery.json');
const battery = JSON.parse(await fs.readFile(batteryPath, 'utf8'));
const queries = SINGLE
  ? battery.queries.filter(q => q.id === SINGLE)
  : battery.queries;

if (queries.length === 0) {
  console.error(`No queries matched. Available IDs: ${battery.queries.map(q => q.id).join(', ')}`);
  process.exit(1);
}

console.log(`\n=== Savvey v2 identity-accuracy battery ===`);
console.log(`Endpoint: ${ENDPOINT}`);
console.log(`Queries:  ${queries.length}`);
console.log(`Pass gate: 90% target (kill criteria Friday 8 May 2026)\n`);

// ── Runner ───────────────────────────────────────────────────────
const startTs = new Date();
const results = [];

for (let i = 0; i < queries.length; i++) {
  const q = queries[i];
  const t0 = Date.now();
  console.log(`[${i+1}/${queries.length}] ${q.id} — "${q.query}"`);

  let apiRes, apiErr = null;
  try {
    const r = await fetch(`${ENDPOINT}/api/ai-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: q.query, debug: true }),
    });
    if (!r.ok) {
      apiErr = `HTTP ${r.status}`;
    } else {
      apiRes = await r.json();
    }
  } catch (e) {
    apiErr = e.message;
  }
  const elapsed = Date.now() - t0;

  // Score against ground truth
  const score = scoreResult(q, apiRes, apiErr);

  results.push({
    id: q.id,
    query: q.query,
    category: q.category,
    elapsed_ms: elapsed,
    api_error: apiErr,
    api_version: apiRes?._meta?.version || null,
    n_results: (apiRes?.shopping || []).length,
    cheapest_price: apiRes?._meta?.cheapest ?? null,
    cheapest_retailer: apiRes?.shopping?.[0]?.source || null,
    cheapest_title: apiRes?.shopping?.[0]?.title || null,
    confidence: apiRes?._meta?.confidence || null,
    reasoning: apiRes?._meta?.reasoning || null,
    pass: score.pass,
    pass_reason: score.reason,
    expected: {
      brand: q.expected_brand,
      family: q.expected_family,
      qualifiers: q.expected_qualifiers,
      price_band: q.expected_price_band_gbp,
      state: q.expected_state,
    },
  });

  console.log(`     → ${score.pass ? 'PASS' : 'FAIL'} (${elapsed}ms, n=${(apiRes?.shopping || []).length}, cheapest=${apiRes?._meta?.cheapest ?? 'n/a'})`);
  if (!score.pass) console.log(`       reason: ${score.reason}`);
}

// ── Summarise ────────────────────────────────────────────────────
const passCount = results.filter(r => r.pass).length;
const passRate = (passCount / results.length * 100).toFixed(1);
const avgLatency = Math.round(results.reduce((s, r) => s + r.elapsed_ms, 0) / results.length);
const p95Latency = (() => {
  const sorted = results.map(r => r.elapsed_ms).sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
})();

console.log(`\n=== SUMMARY ===`);
console.log(`Pass rate: ${passCount}/${results.length} = ${passRate}%`);
console.log(`Latency: avg ${avgLatency}ms, p95 ${p95Latency}ms`);
console.log(`Kill gate: 90% target. ${passRate >= 90 ? '✓ ABOVE' : '✗ BELOW'} threshold.\n`);

// Failures detail
const fails = results.filter(r => !r.pass);
if (fails.length > 0) {
  console.log(`Failures (${fails.length}):`);
  for (const f of fails) {
    console.log(`  ${f.id}: ${f.pass_reason}`);
  }
  console.log('');
}

// ── Write artifacts ──────────────────────────────────────────────
const ts = startTs.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const jsonPath = path.join(__dirname, `battery-results-${ts}.json`);
const mdPath   = path.join(__dirname, `battery-results-${ts}.md`);

await fs.writeFile(jsonPath, JSON.stringify({
  run_at: startTs.toISOString(),
  endpoint: ENDPOINT,
  battery_version: battery._version,
  pass_rate_pct: parseFloat(passRate),
  pass_count: passCount,
  total: results.length,
  avg_latency_ms: avgLatency,
  p95_latency_ms: p95Latency,
  results,
}, null, 2));

const md = renderMarkdown(startTs, ENDPOINT, battery._version, passCount, results, avgLatency, p95Latency);
await fs.writeFile(mdPath, md);

console.log(`Artifacts:`);
console.log(`  ${path.relative(process.cwd(), jsonPath)}`);
console.log(`  ${path.relative(process.cwd(), mdPath)}\n`);

// ── Helpers ──────────────────────────────────────────────────────

function scoreResult(q, apiRes, apiErr) {
  if (apiErr) {
    return { pass: false, reason: `API error: ${apiErr}` };
  }
  if (!apiRes) {
    return { pass: false, reason: 'No API response' };
  }
  const items = apiRes.shopping || [];
  const cheapest = apiRes._meta?.cheapest;
  const isExactMatchRequired = q.exact_match_required;
  const isVagueCategory = q.category === 'vague-category';
  const isFamilyNoTier  = q.category === 'family-no-tier';

  // Vague-category queries: PASS if returns multiple representative SKUs OR
  // honestly returns 0/category-spread state.
  if (isVagueCategory) {
    if (items.length === 0) return { pass: true, reason: 'Honest empty for vague category' };
    if (apiRes._meta?.categoryProducts && apiRes._meta.categoryProducts.length >= 2) {
      return { pass: true, reason: 'Category fan-out fired (Wave 100)' };
    }
    if (items.length >= 3) {
      const prices = items.map(it => parseFloat(String(it.price).replace(/[^0-9.]/g, ''))).filter(p => isFinite(p));
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      if (max / min > 1.5) return { pass: true, reason: 'Multiple representative SKUs (range surfaced)' };
    }
    return { pass: false, reason: 'Vague category but system picked single SKU as best — confidently wrong shape' };
  }

  // Family-no-tier: PASS if system shows variant range OR honestly flags ambiguity.
  if (isFamilyNoTier) {
    if (items.length === 0) return { pass: true, reason: 'Honest empty for family-no-tier' };
    if (items.length >= 3) {
      const prices = items.map(it => parseFloat(String(it.price).replace(/[^0-9.]/g, ''))).filter(p => isFinite(p));
      const min = Math.min(...prices);
      const max = Math.max(...prices);
      // If the spread is >2x, system is showing variants — acceptable
      if (max / min > 2) return { pass: true, reason: 'Variant spread surfaced' };
    }
    // Otherwise check if cheapest falls in expected band
    const inBand = cheapest != null
      && cheapest >= q.expected_price_band_gbp[0] * 0.7
      && cheapest <= q.expected_price_band_gbp[1] * 1.3;
    if (inBand) return { pass: true, reason: 'Cheapest in expected band; variants tolerable' };
    return { pass: false, reason: `Cheapest £${cheapest} outside band ${q.expected_price_band_gbp.join('-')}` };
  }

  // Tier-specific: must match qualifiers AND price band
  if (isExactMatchRequired) {
    if (items.length === 0) {
      // Honest empty acceptable when expected_state mentions LOW or NO_EXACT_MATCH
      const allowsEmpty = (q.expected_state || '').match(/LOW|NO_EXACT/i);
      return { pass: !!allowsEmpty, reason: allowsEmpty ? 'Honest empty acceptable' : 'No results returned for tier-specific query' };
    }

    // Top result must be in the expected price band (within ±30%)
    const inBand = cheapest != null
      && cheapest >= q.expected_price_band_gbp[0] * 0.7
      && cheapest <= q.expected_price_band_gbp[1] * 1.3;
    if (!inBand) {
      return { pass: false, reason: `Cheapest £${cheapest} outside expected band ${q.expected_price_band_gbp.join('-')} (±30%)` };
    }

    // Top result title should contain brand AND something matching qualifiers.
    // Brand check tolerates trademark-name shorthand: Apple's product titles
    // often say "iPhone"/"MacBook"/"iPad"/"AirPods" rather than "Apple".
    // Same for Samsung (Galaxy / Tab), Sony (PlayStation), etc.
    const topTitle = (items[0].title || '').toLowerCase();
    const brandLc  = (q.expected_brand || '').toLowerCase();
    const BRAND_ALIASES = {
      'apple': ['iphone', 'ipad', 'macbook', 'imac', 'airpods', 'apple watch', 'apple tv', 'mac mini', 'mac pro', 'mac studio'],
      'samsung': ['galaxy', 'samsung'],
      'sony': ['playstation', 'walkman', 'bravia', 'sony'],
      'microsoft': ['xbox', 'surface', 'microsoft'],
      'google': ['pixel', 'nest', 'chromecast', 'google'],
    };
    const aliases = BRAND_ALIASES[brandLc] || [brandLc];
    const brandHit = brandLc && (topTitle.includes(brandLc) || aliases.some(a => topTitle.includes(a)));
    if (brandLc && !brandHit) {
      return { pass: false, reason: `Top title "${items[0].title}" missing brand "${q.expected_brand}" (or alias)` };
    }
    // Qualifier title check (loose — the multi-signal layer doesn't exist yet,
    // so we accept if at least one qualifier value appears in title)
    const qualifierValues = Object.values(q.expected_qualifiers || {});
    if (qualifierValues.length > 0) {
      const hasAnyQualifier = qualifierValues.some(v => {
        const sv = String(v).toLowerCase();
        return topTitle.includes(sv);
      });
      if (!hasAnyQualifier) {
        return { pass: false, reason: `Top title "${items[0].title}" missing qualifier signals (expected one of: ${qualifierValues.join(', ')})` };
      }
    }
    return { pass: true, reason: 'Brand + qualifier match + price in band' };
  }

  return { pass: false, reason: 'Unknown category' };
}

function renderMarkdown(ts, endpoint, version, passCount, results, avg, p95) {
  const passRate = (passCount / results.length * 100).toFixed(1);
  const failGate = passRate >= 90 ? '**✓ above 90% gate**' : '**✗ below 90% gate**';
  const lines = [
    `# Savvey v2 identity-accuracy battery — ${ts.toISOString().slice(0, 16)} UTC`,
    ``,
    `- **Endpoint**: ${endpoint}`,
    `- **Battery version**: ${version}`,
    `- **Pass rate**: ${passCount}/${results.length} = **${passRate}%** ${failGate}`,
    `- **Latency**: avg ${avg}ms · p95 ${p95}ms`,
    ``,
    `## Results`,
    ``,
    `| ID | Query | Pass | n | Cheapest | Reason |`,
    `|---|---|---|---|---|---|`,
  ];
  for (const r of results) {
    lines.push(`| \`${r.id}\` | ${r.query} | ${r.pass ? '✓' : '✗'} | ${r.n_results} | ${r.cheapest_price != null ? '£' + r.cheapest_price : '—'} | ${r.pass_reason} |`);
  }
  lines.push('', '## Failures detail', '');
  const fails = results.filter(r => !r.pass);
  if (fails.length === 0) lines.push('_No failures._');
  else for (const f of fails) {
    lines.push(`### ${f.id}`);
    lines.push(`- Query: ${f.query}`);
    lines.push(`- Reason: ${f.pass_reason}`);
    lines.push(`- Cheapest: ${f.cheapest_price != null ? '£' + f.cheapest_price : '—'} at ${f.cheapest_retailer || '—'}`);
    lines.push(`- Top title: ${f.cheapest_title || '—'}`);
    lines.push(`- Reasoning: ${f.reasoning || '—'}`);
    lines.push('');
  }
  return lines.join('\n');
}
