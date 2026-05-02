// api/image.js — Savvey Product Image Lookup v1.0 (Wave 69)
//
// Lightweight Serper Images proxy used by the frontend to lazily hydrate
// recent-search chip avatars and trending-tile imagery for queries that
// didn't get a hero image surfaced during their original search (most
// queries — Serper Images is hit-or-miss on first try).
//
// Why a separate endpoint:
// - /api/ai-search runs Serper Images inline but can fail silently on
//   first try. Once that happens there's no second chance unless the
//   user re-runs the search.
// - This endpoint can be called lazily from the home screen for any
//   recents/trending tile that lacks a cached image, with a cheap
//   per-query budget. Result is cached client-side under the same
//   localStorage key as the inline path, so subsequent visits read
//   from cache.
//
// Cost per call: ~£0.0005. Rate-limited 60/IP/hour to keep the lid on.
// Tries the literal query first; falls back to the first 2-3 words if
// the literal returns nothing (Serper sometimes empties on long
// adjective-heavy queries).

import { applySecurityHeaders } from './_shared.js';
import { rejectIfRateLimited }  from './_rateLimit.js';

const VERSION = 'image.js v1.0';
const ORIGIN  = process.env.ALLOWED_ORIGIN || 'https://savvey.vercel.app';
const TIMEOUT_MS = 2500;
const RATE_LIMIT_PER_HOUR = 60;

async function serperImages(query, key){
  if(!key || !query) return null;
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch('https://google.serper.dev/images', {
      method: 'POST',
      headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query, gl: 'uk', num: 3 }),
      signal: ac.signal,
    });
    if(!r.ok) return null;
    const d = await r.json();
    const img = d && d.images && d.images[0];
    if(!img || !img.imageUrl) return null;
    return { url: img.imageUrl, thumbnail: img.thumbnailUrl || img.imageUrl, source: img.source || null };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export default async function handler(req, res){
  applySecurityHeaders(res, ORIGIN);
  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});

  if(rejectIfRateLimited(req, res, 'image', RATE_LIMIT_PER_HOUR)) return;

  const SERPER_KEY = process.env.SERPER_KEY || process.env.SERPER_API_KEY;
  if(!SERPER_KEY) return res.status(503).json({error:'serper_not_configured'});

  const q = String((req.query && req.query.q) || (req.body && req.body.q) || '').trim().slice(0, 80);
  if(q.length < 2) return res.status(400).json({error:'query_too_short'});

  // Try literal first; fall back to first 3 words if literal returns nothing.
  let img = await serperImages(q + ' product uk', SERPER_KEY);
  if(!img){
    const short = q.split(/\s+/).slice(0, 3).join(' ');
    if(short && short !== q) img = await serperImages(short + ' uk', SERPER_KEY);
  }
  if(!img) return res.status(200).json({ image: null });
  console.log(`[${VERSION}] "${q}" → ${img.url.slice(0, 80)}`);
  return res.status(200).json({ image: img });
}
