// api/synthesize.js — Savvey V.140 Option B (Split Routing)
//
// THIN WRAPPER. Reuses the /api/normalize handler with body.synth_only=true
// so it skips Vision/Text/SerpAPI entirely and runs ONLY the Haiku
// mega-synth on a precomputed synthesis_payload sent by the client.
//
// Cache key: canonical+mode (7-day TTL, synthesis is canonical-stable).
// Target p95: <3s.

import handler from './normalize.js';

export default async function (req, res) {
  if (req.method === 'OPTIONS' || req.method === 'POST') {
    if (req.body && typeof req.body === 'object') {
      req.body = { ...req.body, synth_only: true };
    }
  }
  return handler(req, res);
}
