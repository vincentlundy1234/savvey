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

// V.155 — Wrap req.body access in try/catch. Vercel's Node runtime lazily
// parses application/json bodies on first access; if the payload is
// malformed (or if some middleware mutates it into something un-parseable)
// the access throws SyntaxError synchronously, escaping into the surface
// Vercel layer and producing a raw 500 BEFORE normalize.js's V.202
// envelope can convert it to a JSON 200. This wrapper catches that case,
// hands the request to the normalize handler anyway (with body=undefined),
// and lets the V.202 envelope take over. Without this, the Founder was
// seeing 500 SyntaxError from /api/identify with no envelope context.
export default async function (req, res) {
  try {
    if (req.method === 'OPTIONS' || req.method === 'POST') {
      let _v155Body = null;
      try { _v155Body = req.body; } catch (parseErr) {
        try { console.error('[V.155][identify] req.body access threw ' + (parseErr && parseErr.name) + ': ' + (parseErr && parseErr.message)); } catch (e) {}
        try {
          return res.status(200).json({
            outcome: 'error',
            outcome_reason: 'v155_body_parse_threw',
            error: 'request_body_parse_failed',
            message: String((parseErr && parseErr.message) || parseErr).slice(0, 240),
            error_name: String((parseErr && parseErr.name) || 'Error').slice(0, 60),
            links: [],
            pricing: { best_price: null, avg_market: null, price_band: null },
            identity: null,
            alternatives_array: [],
            _meta: { envelope: 'v155_identify_pre_handler' }
          });
        } catch (e2) {
          try { res.status(500).end(); } catch (e3) {}
          return;
        }
      }
      if (_v155Body && typeof _v155Body === 'object') {
        req.body = { ..._v155Body, skip_synth: true };
      }
    }
    return handler(req, res);
  } catch (outerErr) {
    try { console.error('[V.155][identify] outer wrapper caught ' + (outerErr && outerErr.name) + ': ' + (outerErr && outerErr.message)); } catch (e) {}
    if (res.headersSent) { try { res.end(); } catch (e) {} return; }
    try {
      return res.status(200).json({
        outcome: 'error',
        outcome_reason: 'v155_identify_outer_caught',
        error: 'identify_wrapper_threw',
        message: String((outerErr && outerErr.message) || outerErr).slice(0, 240),
        error_name: String((outerErr && outerErr.name) || 'Error').slice(0, 60),
        links: [],
        pricing: { best_price: null, avg_market: null, price_band: null },
        identity: null,
        alternatives_array: [],
        _meta: { envelope: 'v155_identify_outer' }
      });
    } catch (e) {
      try { res.status(500).end(); } catch (e2) {}
    }
  }
}
