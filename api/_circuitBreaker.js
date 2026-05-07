// api/_circuitBreaker.js — Savvey circuit breaker v1.0
//
// Per-provider failure tracking. Trips open after N consecutive 5xx /
// network errors. Stays open for COOLDOWN_MS, then auto-half-opens
// (one probe attempt allowed). Prevents runaway cost when a provider
// has an incident.

const breakers = new Map();
const FAIL_THRESHOLD = 3;
const COOLDOWN_MS    = 5 * 60 * 1000; // 5 minutes

// Returns { open, retryAfterMs }. If open, caller should skip the
// upstream call and fall back to a degraded path or return cached data.
export function checkCircuit(provider) {
  const b = breakers.get(provider);
  if (!b)                                  return { open: false };
  if (b.openedAt + COOLDOWN_MS < Date.now()) {
    breakers.delete(provider);
    return { open: false };
  }
  if (b.failures >= FAIL_THRESHOLD) {
    return { open: true, retryAfterMs: (b.openedAt + COOLDOWN_MS) - Date.now() };
  }
  return { open: false };
}

export function recordSuccess(provider) {
  breakers.delete(provider);
}

export function recordFailure(provider) {
  const b = breakers.get(provider) || { failures: 0, openedAt: 0 };
  b.failures++;
  if (b.failures >= FAIL_THRESHOLD && !b.openedAt) {
    b.openedAt = Date.now();
    console.warn(`[circuitBreaker] ${provider} TRIPPED — bypassing for ${COOLDOWN_MS/1000}s`);
  }
  breakers.set(provider, b);
}

// Wrap any async function call with circuit-breaker logic.
//   fn       — async function returning the response
//   provider — name string used as the circuit key
//   options.onOpen — optional callback if circuit is open (returns the
//                    fallback value to use instead of calling fn)
export async function withCircuit(provider, fn, options = {}) {
  const c = checkCircuit(provider);
  if (c.open) {
    console.warn(`[circuitBreaker] ${provider} OPEN — skipping upstream`);
    if (options.onOpen) return options.onOpen(c);
    throw Object.assign(new Error('circuit_open'), { provider, retryAfterMs: c.retryAfterMs });
  }
  try {
    const result = await fn();
    recordSuccess(provider);
    return result;
  } catch (e) {
    // Only count 5xx and network errors as "failures" for the breaker.
    // 4xx (bad request, auth) doesn't indicate provider health.
    const isUpstreamFailure =
      (e && (e.status === undefined || e.status >= 500)) ||
      (e && (e.name === 'AbortError' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT'));
    if (isUpstreamFailure) recordFailure(provider);
    throw e;
  }
}
