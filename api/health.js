// api/health.js — cheap, fast liveness probe for smoke tests.
//
// Why this exists: the v3.1 smoke test used to hit /api/normalize on every
// push, which burned a real Haiku token (~£0.005 each) and was flaky on
// Anthropic 5xx blips. This endpoint:
//   - returns 200 in <50ms with no upstream calls
//   - reports the deploy version + which env vars are present (without
//     leaking values), so a "key missing" issue is visible at a glance
//   - honours the same security headers the rest of /api uses
//
// Smoke philosophy: this confirms the function runtime + ENV is loaded.
// /api/normalize is then exercised once per push for the real code-path
// check (cache hit on most pushes = effectively free).
//
// Note: filename is `health.js` not `_health.js`. Vercel auto-skips
// underscore-prefixed files in /api as private shared modules (see
// api/_shared.js, _rateLimit.js, _circuitBreaker.js for precedent).
// Using `_health.js` triggered a fast-fail build error on 4 May 2026.

import { applySecurityHeaders } from './_shared.js';

export const config = { runtime: 'nodejs', maxDuration: 5 };

const VERSION = 'health.js v1.2.0';

export default function handler(req, res) {
  applySecurityHeaders(res, '*');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Report which keys are wired (presence only, never the value). A push
  // that lands without one of these will show up here before users hit it.
  const env = {
    anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
    serpapi:   Boolean(process.env.SERPAPI_KEY),
    kv:        Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN),
  };

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    ok: true,
    version: VERSION,
    deploy: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 'unknown',
    env,
    ts: new Date().toISOString(),
  });
}
