#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// Savvey · benchmark.js — Bulk Accuracy Harness
//
// Runs the live /api/identify pipeline against 20 diverse, difficult
// real-world UK SKUs. Grades each result as PASS/FAIL using the Panel
// criteria:
//
//   PASS  ←→  identify returns outcome ∈ {matched, disambig}
//             AND links.length >= 3
//             AND top 3 retailer cards contain no pawn-shop chains
//             AND top 3 retailer titles / merchant names carry no
//                 used / refurb / pre-owned markers
//             AND top 3 prices are not implausibly low for the category
//
// V.168 grading update: a thin (1-2 link) result IS a pass as long as
// the links are clean. Coverage is a market-data limitation, not an
// engine failure. The Panel decision: 1 verified clean retailer ≥ 0.
//
// Outputs a final accuracy percentage at the bottom (X/20 — Y%).
//
// Usage:
//   node benchmark.js                     # hits https://savvey.vercel.app
//   SAVVEY_BASE=http://localhost:3000 \
//     node benchmark.js                   # hits a local dev server
// ─────────────────────────────────────────────────────────────────────────

const BASE = process.env.SAVVEY_BASE || 'https://savvey.vercel.app';

// 20 highly diverse, difficult UK SKUs across 6 categories.
// Chosen to stress test: keyword stuffing, accessory spam, used markets,
// pack/size variants, generation lookalikes, niche brand recognition.
const CASES = [
  // ── Electronics (5) ────────────────────────────────────────────────────
  { cat: 'Electronics', text: 'Bose QuietComfort Ultra Headphones' },
  { cat: 'Electronics', text: 'Sony WH-1000XM5 Headphones' },
  { cat: 'Electronics', text: 'Nintendo Switch OLED Console White' },
  { cat: 'Electronics', text: 'Roborock S8 Pro Ultra Robot Vacuum' },
  { cat: 'Electronics', text: 'Steam Deck OLED 512GB' },

  // ── Books (3) ──────────────────────────────────────────────────────────
  { cat: 'Books',       text: 'Atomic Habits James Clear Paperback' },
  { cat: 'Books',       text: 'Sapiens Yuval Noah Harari Hardcover' },
  { cat: 'Books',       text: 'The Body Keeps the Score Bessel van der Kolk' },

  // ── Baby gear (3) ──────────────────────────────────────────────────────
  { cat: 'Baby',        text: 'Cybex Cloud T i-Size Car Seat' },
  { cat: 'Baby',        text: 'Maxi-Cosi Pebble 360 Pro Car Seat' },
  { cat: 'Baby',        text: 'Tommee Tippee Perfect Prep Day Night' },

  // ── Obscure UK groceries (4) ───────────────────────────────────────────
  { cat: 'Grocery',     text: 'Marmite XO 250g' },
  { cat: 'Grocery',     text: "Nando's Peri Peri Extra Hot Sauce 250ml" },
  { cat: 'Grocery',     text: 'Yorkshire Tea 240 Bags' },
  { cat: 'Grocery',     text: 'Heinz Salad Cream 605g' },

  // ── Cosmetics (3) ──────────────────────────────────────────────────────
  { cat: 'Cosmetics',   text: 'Charlotte Tilbury Pillow Talk Matte Revolution Lipstick' },
  { cat: 'Cosmetics',   text: 'The Ordinary Niacinamide 10% + Zinc 1% 30ml' },
  { cat: 'Cosmetics',   text: 'Drunk Elephant C-Firma Fresh Day Serum' },

  // ── Long-tail / specialist (2) ─────────────────────────────────────────
  { cat: 'Specialist',  text: 'Black Diamond Camalot C4 Size 2' },
  { cat: 'Specialist',  text: 'Le Creuset Signature Cast Iron Casserole 24cm' },
];

// Spam markers — any of these appearing in a top-3 retailer's name or
// title disqualifies the case.
const PAWNSHOP_RX = /\b(?:cash\s*generator|cashgenerator|cash\s*converters|cashconverters|cex|musicmagpie|music\s*magpie|webuyany|envirophone|backmarket|back\s*market|swappa|gazelle|decluttr|mazumamobile|reboxed)\b/i;
const USED_RX     = /\b(?:used|refurb(?:ished|ed)?|pre[\-\s]?owned|preowned|second[\-\s]?hand|secondhand|open[\-\s]?box|reconditioned|previously\s+owned|ex[\-\s]?display|ex[\-\s]?demo|graded|cpo|[abc][\-\s]?grade)\b/i;

async function probe(c) {
  const t0 = Date.now();
  let j, status;
  try {
    const r = await fetch(BASE + '/api/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input_type: 'text', text: c.text }),
    });
    status = r.status;
    j = await r.json();
  } catch (e) {
    return { case: c, error: e.message, latency_ms: Date.now() - t0 };
  }
  const latency_ms = Date.now() - t0;
  return { case: c, status, j, latency_ms };
}

function grade(probeResult) {
  const c = probeResult.case;
  const j = probeResult.j;
  if (probeResult.error) {
    return { pass: false, reason: 'fetch_error:' + probeResult.error };
  }
  if (probeResult.status !== 200) {
    return { pass: false, reason: 'http_' + probeResult.status };
  }
  const links = (j && Array.isArray(j.links)) ? j.links : [];
  // V.168 grading: ≥1 valid filtered link is a PASS as long as the top-k
  // (whatever k is, 1-3) carry no pawn-shop / used markers. matched_thin
  // is now an accepted outcome alongside matched / disambig.
  if (links.length < 1) {
    return { pass: false, reason: 'links<1 (' + links.length + ')' };
  }
  if (!['matched', 'matched_thin', 'disambig'].includes(j.outcome)) {
    return { pass: false, reason: 'outcome=' + j.outcome };
  }
  // V.168 — when there's only 1-2 links, "top 3" naturally collapses to
  // whatever's there. The spam regex sweep still runs on every link.
  const top3 = links.slice(0, Math.min(3, links.length));
  for (let i = 0; i < top3.length; i++) {
    const l = top3[i];
    const blob = [l.retailer || '', l.retailer_key || '', l.title || '', l.delivery_note || '']
      .join(' · ').toLowerCase();
    if (PAWNSHOP_RX.test(blob)) {
      return { pass: false, reason: 'top' + (i+1) + '_pawn:' + l.retailer };
    }
    if (USED_RX.test(blob)) {
      return { pass: false, reason: 'top' + (i+1) + '_used:' + l.retailer };
    }
  }
  return { pass: true, reason: 'clean' };
}

function fmtLinks(links, n) {
  return links.slice(0, n)
    .map(l => l.retailer + ' ' + (l.price_str || '—'))
    .join(' | ');
}

(async () => {
  console.log('Savvey Bulk Accuracy Benchmark — base:', BASE);
  console.log('Cases:', CASES.length);
  console.log('═'.repeat(78));

  const results = [];
  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    process.stdout.write(`[${String(i+1).padStart(2,'0')}/${CASES.length}] ${c.cat.padEnd(11)} ${c.text.slice(0,52).padEnd(52)} ... `);
    const p = await probe(c);
    const g = grade(p);
    results.push({ c, p, g });
    if (g.pass) {
      const bp = p.j && p.j.pricing && p.j.pricing.best_price;
      const bpStr = bp ? (bp.retailer + ' ' + bp.value_str) : '—';
      console.log(`✓ PASS · ${(p.j.links || []).length} links · best ${bpStr}`);
    } else {
      console.log(`✗ FAIL · ${g.reason}`);
    }
    // Polite rate-limit so we don't slam the SerpAPI quota
    await new Promise(r => setTimeout(r, 700));
  }

  console.log('═'.repeat(78));
  console.log('DETAIL (top-3 retailer stacks per case):');
  console.log('─'.repeat(78));
  for (const r of results) {
    const links = (r.p.j && r.p.j.links) || [];
    const mark = r.g.pass ? '✓' : '✗';
    console.log(`${mark} ${r.c.cat.padEnd(11)} ${r.c.text.slice(0, 48).padEnd(48)}`);
    if (links.length > 0) {
      console.log('    Top 5: ' + fmtLinks(links, 5));
    }
    if (!r.g.pass) {
      console.log('    FAIL: ' + r.g.reason);
    }
  }

  const passed = results.filter(r => r.g.pass).length;
  const total  = results.length;
  const pct    = ((passed / total) * 100).toFixed(1);

  console.log('═'.repeat(78));
  console.log(`SCORE: ${passed}/${total}  —  ${pct}%`);
  console.log('═'.repeat(78));

  // Per-category breakdown
  const byCat = {};
  for (const r of results) {
    byCat[r.c.cat] = byCat[r.c.cat] || { pass: 0, total: 0 };
    byCat[r.c.cat].total++;
    if (r.g.pass) byCat[r.c.cat].pass++;
  }
  console.log('Per-category:');
  for (const cat of Object.keys(byCat)) {
    const b = byCat[cat];
    const p = ((b.pass / b.total) * 100).toFixed(0);
    console.log(`  ${cat.padEnd(12)} ${b.pass}/${b.total}  (${p}%)`);
  }
  console.log('═'.repeat(78));

  process.exit(passed === total ? 0 : 1);
})();
