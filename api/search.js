export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const SERPER_KEY = process.env.SERPER_KEY;
  if (!SERPER_KEY) {
    return res.status(500).json({ error: 'SERPER_KEY not configured' });
  }

  const { q, type = 'shopping' } = req.body;
  if (!q) return res.status(400).json({ error: 'Missing query' });

  const endpoint = type === 'search'
    ? 'https://google.serper.dev/search'
    : 'https://google.serper.dev/shopping';

  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q, gl: 'uk', hl: 'en', num: 10 }),
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'Serper error', status: upstream.status });
    }

    const data = await upstream.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
