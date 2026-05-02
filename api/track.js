// api/track.js — Savvey Telemetry v1.0 (Wave 75)
//
// Fire-and-forget telemetry endpoint. The frontend POSTs lightweight
// events here when something interesting happens — search performed,
// scenario rendered, AI estimate fired, image lookup miss, error
// caught — so we have a server-side breadcrumb trail when a user
// reports something feeling wrong.
//
// v1.0 logs to Vercel function logs only (zero-config, queryable in
// the Vercel dashboard). v1.1 will pipe events into a Supabase table
// once the schema's stable enough not to churn weekly.
//
// Privacy: no PII. We log only the event name, scoped properties the
// frontend chose to send (price, retailer count, etc), and a salted
// per-session ID generated client-side. No IP retention beyond what
// Vercel does at the edge.

import { applySecurityHeaders } from './_shared.js';
import { rejectIfRateLimited }  from './_rateLimit.js';

const VERSION = 'track.js v1.0';
const ORIGIN  = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';
const RATE_LIMIT_PER_HOUR = 240; // ~4 events/min/IP — generous for a single user

const ALLOWED_EVENTS = new Set([
  'search_performed',
  'scenario_rendered',
  'ai_estimate_fired',
  'ai_estimate_returned',
  'image_lookup_miss',
  'image_lookup_hit',
  'no_results',
  'share_opened',
  'share_completed',
  'save_added',
  'save_removed',
  'fetch_error',
  'render_error',
]);

export default async function handler(req, res){
  applySecurityHeaders(res, ORIGIN);
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST')    return res.status(405).json({error:'Method not allowed'});

  if(rejectIfRateLimited(req, res, 'track', RATE_LIMIT_PER_HOUR)) return;

  const body = req.body || {};
  const event = String(body.event || '').slice(0, 40);
  if(!ALLOWED_EVENTS.has(event)){
    return res.status(400).json({error:'unknown_event'});
  }

  // Sanitise props — only allow known scalar shapes so we can't be
  // tricked into logging blobs.
  const props = {};
  if(body.props && typeof body.props === 'object'){
    for(const k of Object.keys(body.props)){
      if(k.length > 32) continue;
      const v = body.props[k];
      if(typeof v === 'string')      props[k] = v.slice(0, 80);
      else if(typeof v === 'number') props[k] = Number.isFinite(v) ? v : null;
      else if(typeof v === 'boolean')props[k] = v;
    }
  }
  const sid = typeof body.sid === 'string' ? body.sid.slice(0, 24) : '?';

  // Single-line structured log so it's grep-friendly in Vercel logs.
  console.log(`[track] ${event} sid=${sid} ${JSON.stringify(props)}`);
  return res.status(200).json({ ok: true });
}
