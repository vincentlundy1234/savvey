// api/_rateLimit.js — Savvey rate limiter v1.0
//
// In-memory IP+endpoint rate limiter. Best-effort across function
// invocations (Vercel cold starts reset state). Stops casual abuse.
// For production scale upgrade to Upstash Redis or Vercel KV.
//
// Defaults: 30 requests/IP/hour per endpoint. Configurable per-call.

const buckets = new Map();
const WINDOW_MS = 60 * 60 * 1000;  // 1 hour
const MAX_BUCKETS_BEFORE_GC = 1000;

function ipFromReq(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Returns { allowed, remaining, resetAt, ip }.
// If !allowed, caller should respond 429 with Retry-After header.
export function checkRateLimit(req, endpoint, limit = 30) {
  const ip  = ipFromReq(req);
  const key = `${ip}|${endpoint}`;
  const now = Date.now();

  // Opportunistic GC of expired buckets when the map grows.
  if (buckets.size > MAX_BUCKETS_BEFORE_GC) {
    for (const [k, v] of buckets.entries()) {
      if (v.windowStart + WINDOW_MS < now) buckets.delete(k);
    }
  }

  const bucket = buckets.get(key);
  if (!bucket || bucket.windowStart + WINDOW_MS < now) {
    buckets.set(key, { windowStart: now, count: 1 });
    return { allowed: true, remaining: limit - 1, resetAt: now + WINDOW_MS, ip };
  }

  if (bucket.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: bucket.windowStart + WINDOW_MS, ip };
  }

  bucket.count++;
  return { allowed: true, remaining: limit - bucket.count, resetAt: bucket.windowStart + WINDOW_MS, ip };
}

// Convenience: respond 429 with the right headers. Returns true if the
// caller should stop processing (response sent).
export function rejectIfRateLimited(req, res, endpoint, limit = 30) {
  const r = checkRateLimit(req, endpoint, limit);
  if (!r.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil((r.resetAt - Date.now()) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    res.setHeader('X-RateLimit-Remaining', '0');
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(r.resetAt / 1000)));
    res.status(429).json({
      error: 'rate_limited',
      message: `Too many requests. Try again in ${retryAfterSec}s.`,
      retryAfter: retryAfterSec,
    });
    console.warn(`[rateLimit] 429 ${endpoint} ip=${r.ip}`);
    return true;
  }
  res.setHeader('X-RateLimit-Remaining', String(r.remaining));
  res.setHeader('X-RateLimit-Reset',     String(Math.ceil(r.resetAt / 1000)));
  return false;
}
