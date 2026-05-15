// api/telemetry.js — V.139 silent telemetry sink
//
// Accepts JSON beacons fired via navigator.sendBeacon() from the frontend.
// Logs the payload to Vercel's runtime logs so we can audit scraper health,
// outbound click rates, and no_match patterns. Returns 204 No Content so
// the beacon completes quickly without consuming bandwidth on a body.
//
// Payload shape (frontend wraps in JSON.stringify):
//   {
//     type: 'no_match' | 'outbound_click' | 'fetch_exception' | ...
//     query: '<user_input_first_200_chars>',
//     timestamp: 1715760000000,
//     ...other_diagnostic_fields
//   }
//
// Deliberately accepts any payload shape (we'll evolve the schema as
// more event types are added). No PII beyond the user's search query
// is captured; the query is truncated to 200 chars to cap risk.

import { applySecurityHeaders } from './_shared.js';

export default async function handler(req, res) {
  try { applySecurityHeaders(res, '*'); } catch (e) {}
  // CORS pre-flight + non-POST methods.
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }
  if (req.method !== 'POST') {
    return res.status(204).end();
  }
  try {
    // sendBeacon delivers as Blob/Buffer. Vercel may auto-parse if the
    // content-type is JSON, but we handle the raw case defensively.
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { body = { _raw: String(body).slice(0, 400) }; }
    } else if (body && typeof body === 'object' && Buffer.isBuffer && Buffer.isBuffer(body)) {
      try { body = JSON.parse(body.toString('utf8')); } catch (e) { body = { _raw: body.toString('utf8').slice(0, 400) }; }
    } else if (!body) {
      body = {};
    }
    // Strip any oversized fields.
    if (body && typeof body === 'object') {
      for (const k of Object.keys(body)) {
        const v = body[k];
        if (typeof v === 'string' && v.length > 400) body[k] = v.slice(0, 400);
      }
    }
    // Log to Vercel runtime so the Founder can audit via the MCP get_runtime_logs.
    try {
      const t = (body && body.type) || 'unknown';
      const q = (body && body.query) || '';
      console.log(`[V.139][telemetry] type=${t} query="${String(q).slice(0, 80)}" payload=${JSON.stringify(body).slice(0, 480)}`);
    } catch (e) { /* never break a beacon on a log error */ }
  } catch (e) {
    // Beacon never returns 4xx/5xx — sendBeacon swallows the response.
    try { console.warn('[V.139][telemetry] handler error:', e && e.message); } catch (er) {}
  }
  return res.status(204).end();
}
