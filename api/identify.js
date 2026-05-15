// api/identify.js — Savvey V.157 raw body bypass
//
// V.157 — DISABLE VERCEL'S AUTO BODY-PARSER.
// Field evidence: 500 FUNCTION_INVOCATION_FAILED text/plain with
// "SyntaxError: Unexpected tok..." in runtime logs. V.156 process-level
// handlers never fired; V.202 envelope never fired; V.155 try/catch
// never fired. Conclusion: Vercel's auto JSON body-parser throws into
// their middleware layer BEFORE our handler closure executes.
//
// Defence: opt out via config export, read raw body ourselves with a
// wrapped JSON.parse, assign to req.body before calling the inner handler.

export const config = {
  api: { bodyParser: false }
};

import handler from './normalize.js';

function _v157ReadRawBody(req) {
  return new Promise((resolve, reject) => {
    try {
      let data = '';
      let bytes = 0;
      const MAX_BYTES = 6 * 1024 * 1024;
      req.setEncoding && req.setEncoding('utf8');
      req.on('data', (chunk) => {
        try {
          bytes += (typeof chunk === 'string') ? chunk.length : (chunk.byteLength || 0);
          if (bytes > MAX_BYTES) {
            req.destroy && req.destroy();
            return reject(Object.assign(new Error('payload_too_large'), { code: 'PAYLOAD_TOO_LARGE', bytes }));
          }
          data += (typeof chunk === 'string') ? chunk : chunk.toString('utf8');
        } catch (chunkErr) { reject(chunkErr); }
      });
      req.on('end', () => resolve(data));
      req.on('error', (e) => reject(e));
      req.on('aborted', () => reject(new Error('client_aborted')));
    } catch (outer) { reject(outer); }
  });
}

function _v157EnvelopeFromError(reason, parseErr, rawSample) {
  return {
    outcome: 'error',
    outcome_reason: reason,
    error: 'request_body_parse_failed',
    message: String((parseErr && parseErr.message) || parseErr).slice(0, 240),
    error_name: String((parseErr && parseErr.name) || 'Error').slice(0, 60),
    raw_sample: String(rawSample || '').slice(0, 200),
    links: [],
    pricing: { best_price: null, avg_market: null, price_band: null },
    identity: null,
    alternatives_array: [],
    _meta: { envelope: 'v157_identify_raw_body' }
  };
}

export default async function (req, res) {
  try {
    if (req.method === 'OPTIONS') {
      try { res.statusCode = 204; } catch (e) {}
      try { return res.end(); } catch (e) {}
      return;
    }
    if (req.method !== 'POST') {
      try {
        res.statusCode = 405;
        res.setHeader && res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ error: 'Method not allowed', method: req.method }));
      } catch (e) { try { res.end(); } catch (e2) {} return; }
    }

    let raw = '';
    try {
      raw = await _v157ReadRawBody(req);
    } catch (streamErr) {
      try { console.error('[V.157][identify] raw body stream failed: ' + (streamErr && streamErr.name) + ': ' + (streamErr && streamErr.message)); } catch (e) {}
      try {
        res.statusCode = 200;
        res.setHeader && res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(_v157EnvelopeFromError('v157_stream_failed', streamErr, '')));
      } catch (e) { try { res.end(); } catch (e2) {} return; }
    }

    let parsed = null;
    if (raw && raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch (parseErr) {
        try { console.error('[V.157][identify] JSON.parse threw ' + (parseErr && parseErr.name) + ': ' + (parseErr && parseErr.message) + ' raw_len=' + raw.length + ' first_200="' + raw.slice(0, 200).replace(/\n/g, '\\n') + '"'); } catch (e) {}
        try {
          res.statusCode = 200;
          res.setHeader && res.setHeader('Content-Type', 'application/json');
          return res.end(JSON.stringify(_v157EnvelopeFromError('v157_json_parse_threw', parseErr, raw)));
        } catch (e) { try { res.end(); } catch (e2) {} return; }
      }
    }

    if (parsed && typeof parsed === 'object') {
      req.body = Object.assign({}, parsed, { skip_synth: true });
    } else {
      req.body = { skip_synth: true };
    }

    return handler(req, res);
  } catch (outerErr) {
    try { console.error('[V.157][identify] outer wrapper caught ' + (outerErr && outerErr.name) + ': ' + (outerErr && outerErr.message)); } catch (e) {}
    if (res.headersSent) { try { res.end(); } catch (e) {} return; }
    try {
      res.statusCode = 200;
      res.setHeader && res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({
        outcome: 'error',
        outcome_reason: 'v157_identify_outer_caught',
        error: 'identify_wrapper_threw',
        message: String((outerErr && outerErr.message) || outerErr).slice(0, 240),
        error_name: String((outerErr && outerErr.name) || 'Error').slice(0, 60),
        links: [],
        pricing: { best_price: null, avg_market: null, price_band: null },
        identity: null,
        alternatives_array: [],
        _meta: { envelope: 'v157_identify_outer' }
      }));
    } catch (e) {
      try { res.statusCode = 500; res.end(); } catch (e2) {}
    }
  }
}
