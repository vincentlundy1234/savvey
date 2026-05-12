// api/identify.js — Savvey V.140 Option B (Split Routing)
//
// THIN WRAPPER. Reuses the /api/normalize handler with body.skip_synth=true
// so the pipeline runs Vision/Text/URL/Barcode → SerpAPI → V.138 schema
// builder but DOES NOT make the Haiku mega-synth call. Response carries
// pricing, names, ratings, identity, and a `synthesis_payload` for the
// frontend to feed into /api/synthesize.
//
// Target p95: <6s. Vercel 15s ceiling has plenty of headroom now.

import handler from './normalize.js';

export default async function (req, res) {
  if (req.method === 'OPTIONS' || req.method === 'POST') {
    if (req.body && typeof req.body === 'object') {
      req.body = { ...req.body, skip_synth: true };
    }
  }
  return handler(req, res);
}
