export default async function handler(req, res) {
  const { url } = req.query;

  if (!url || !url.includes('data4library.kr')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const response = await fetch(url);
    const text = await response.text();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(text);
  } catch (error) {
    res.status(500).json({ error: 'Proxy fetch failed', detail: error.message });
  }
}
