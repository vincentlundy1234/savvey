// Savvey v2.9 probe — Federated Extraction feasibility test.
// Fires direct HTTP GETs from Vercel server to a panel of UK retailer
// search URLs. Reports: status code, byte size, time-to-first-byte,
// presence of price markers in HTML, anti-bot-challenge fingerprint.
//
// Used ONCE to answer the panel's question: which retailers respond to
// raw fetches without proxy, which need scraping infrastructure, and
// which are hard-blocked. Drives the v2.9 architecture decision.
//
// NO LLM CALLS. Just HTTP fetches. Cheap to run, expensive answer.

export const config = { maxDuration: 25 };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const PANEL = [
  // Tier 1: open consumer marketplaces
  { name: 'Amazon UK',     url: (q) => `https://www.amazon.co.uk/s?k=${encodeURIComponent(q)}` },
  { name: 'Argos',         url: (q) => `https://www.argos.co.uk/search/${encodeURIComponent(q.replace(/\s+/g,'-'))}/` },
  { name: 'John Lewis',    url: (q) => `https://www.johnlewis.com/search?search-term=${encodeURIComponent(q)}` },
  { name: 'Currys',        url: (q) => `https://www.currys.co.uk/search?q=${encodeURIComponent(q)}` },
  { name: 'Very',          url: (q) => `https://www.very.co.uk/e/q/${encodeURIComponent(q)}.end` },
  { name: 'AO',            url: (q) => `https://ao.com/search/?keywords=${encodeURIComponent(q)}` },
  // Tier 2: specialist DIY / tools
  { name: 'Screwfix',      url: (q) => `https://www.screwfix.com/search?search=${encodeURIComponent(q)}` },
  { name: 'Toolstation',   url: (q) => `https://www.toolstation.com/search?q=${encodeURIComponent(q)}` },
  { name: 'B&Q',           url: (q) => `https://www.diy.com/search?term=${encodeURIComponent(q)}` },
  { name: 'Wickes',        url: (q) => `https://www.wickes.co.uk/search?text=${encodeURIComponent(q)}` },
  // Tier 3: kitchen
  { name: 'Lakeland',      url: (q) => `https://www.lakeland.co.uk/search?q=${encodeURIComponent(q)}` },
  // Tier 4: cycling specialist
  { name: 'Tredz',         url: (q) => `https://www.tredz.co.uk/search?q=${encodeURIComponent(q)}` },
  { name: 'Sigma Sports',  url: (q) => `https://www.sigmasports.com/search/?q=${encodeURIComponent(q)}` },
  // Tier 5: appliance specialists
  { name: 'AppliancesDirect', url: (q) => `https://www.appliancesdirect.co.uk/search/${encodeURIComponent(q)}` },
];

const BOT_FINGERPRINTS = [
  /cloudflare/i,
  /just a moment/i,
  /please verify you are a human/i,
  /access denied/i,
  /perimeterx/i,
  /captcha/i,
  /bot detection/i,
  /datadome/i,
  /imperva/i,
  /akamai/i,
];

const PRICE_FINGERPRINTS = [
  /class="price/i,
  /class='price/i,
  /data-price/i,
  /price-current/i,
  /productprice/i,
  /itemprop="price/i,
  /£\d+\.\d{2}/,
  /£\d+,\d{3}/,
];

async function probeOne(name, urlFn, query) {
  const url = urlFn(query);
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
      signal: ac.signal,
      redirect: 'follow',
    });
    clearTimeout(timer);
    const text = await r.text();
    const bytes = text.length;
    const lat = Date.now() - t0;
    const botBlock = BOT_FINGERPRINTS.find((re) => re.test(text));
    const priceHits = PRICE_FINGERPRINTS.reduce((acc, re) => acc + (re.test(text) ? 1 : 0), 0);
    return {
      name,
      url,
      status: r.status,
      ok: r.ok,
      bytes,
      latency_ms: lat,
      bot_blocked: !!botBlock,
      bot_fingerprint: botBlock ? botBlock.source : null,
      price_marker_count: priceHits,
      verdict: !r.ok ? 'http_error' : (botBlock ? 'bot_blocked' : (priceHits >= 2 ? 'extractable' : (bytes < 5000 ? 'too_small' : 'unclear'))),
    };
  } catch (e) {
    clearTimeout(timer);
    return { name, url, error: e.message, latency_ms: Date.now() - t0, verdict: 'fetch_failed' };
  }
}

export default async function handler(req, res) {
  // Allow GET or POST. Default query: "Dyson V15 Detect" (canonical, has clear UK retail presence).
  const q = (req.method === 'POST' ? (req.body?.q || 'Dyson V15 Detect') : (req.query?.q || 'Dyson V15 Detect'));
  const results = await Promise.all(PANEL.map((p) => probeOne(p.name, p.url, q)));
  const summary = {
    extractable_count: results.filter((r) => r.verdict === 'extractable').length,
    bot_blocked_count: results.filter((r) => r.verdict === 'bot_blocked').length,
    http_error_count: results.filter((r) => r.verdict === 'http_error').length,
    fetch_failed_count: results.filter((r) => r.verdict === 'fetch_failed').length,
    unclear_count: results.filter((r) => r.verdict === 'unclear' || r.verdict === 'too_small').length,
    total: results.length,
  };
  return res.status(200).json({ query: q, summary, results });
}
