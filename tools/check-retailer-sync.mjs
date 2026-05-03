#!/usr/bin/env node
// tools/check-retailer-sync.mjs — Wave 92
//
// Verifies that the frontend UK_RETAILERS map (in index.html) is in sync
// with the backend UK_RETAILERS list (in api/_shared.js). Drift here is
// what caused Lakeland £40 to be invisible to users for several waves
// — the backend returned it but the frontend's matchRetailer rejected
// it because the host wasn't in the frontend table.
//
// Run BEFORE every push:   node tools/check-retailer-sync.mjs
// Exits 0 on success, 1 on drift (so it can gate a CI step later).
//
// Limitation: this is a string-match script, not a JS parser. If the
// retailer list format changes substantially the regexes here may need
// adjusting. Designed for the current shape of both files.

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const sharedJs = fs.readFileSync(path.join(repoRoot, 'api', '_shared.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

// Extract hosts from api/_shared.js — `{ host: 'amazon.co.uk', ... }`
const backendHosts = new Set();
const backendRe = /host:\s*['"]([^'"]+)['"]/g;
let m;
while ((m = backendRe.exec(sharedJs)) !== null) {
  backendHosts.add(m[1].toLowerCase());
}

// Extract hosts from index.html UK_RETAILERS map.
// Find the `const UK_RETAILERS={` block and parse keys until the closing `};`.
const frontendHosts = new Set();
const ukRetIdx = indexHtml.indexOf('const UK_RETAILERS={');
if (ukRetIdx === -1) {
  console.error('FATAL: could not find `const UK_RETAILERS={` in index.html');
  process.exit(1);
}
const ukRetEnd = indexHtml.indexOf('};', ukRetIdx);
const ukRetBlock = indexHtml.slice(ukRetIdx, ukRetEnd);
const frontendRe = /['"]([a-z0-9.-]+\.[a-z.]+)['"]\s*:\s*\{name:/gi;
while ((m = frontendRe.exec(ukRetBlock)) !== null) {
  frontendHosts.add(m[1].toLowerCase());
}

const onlyInBackend = [...backendHosts].filter(h => !frontendHosts.has(h));
const onlyInFrontend = [...frontendHosts].filter(h => !backendHosts.has(h));

console.log(`Backend retailers:  ${backendHosts.size}`);
console.log(`Frontend retailers: ${frontendHosts.size}`);

let drift = false;
if (onlyInBackend.length) {
  console.error('\nDRIFT — hosts in backend but NOT frontend (will be invisible to users):');
  onlyInBackend.forEach(h => console.error(`  - ${h}`));
  drift = true;
}
if (onlyInFrontend.length) {
  console.error('\nDRIFT — hosts in frontend but NOT backend (will never match):');
  onlyInFrontend.forEach(h => console.error(`  - ${h}`));
  drift = true;
}

if (drift) {
  console.error('\nFix the drift before pushing.');
  process.exit(1);
}

console.log('\n✓ frontend ↔ backend retailer lists are in sync');
process.exit(0);
