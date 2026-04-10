export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { url } = req.query;

  if (!url || !url.includes('data4library.kr')) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  try {
    const response = await fetch(url);
    const text = await response.text();

    // JSON 응답이면 그대로 전달
    if (text.trim().startsWith('{') || text.trim().startsWith('[')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(200).send(text);
    }

    // XML 응답이면 파싱해서 JSON으로 변환
    const libs = [];
    const libRegex = /<lib>([\s\S]*?)<\/lib>/g;
    let match;
    while ((match = libRegex.exec(text)) !== null) {
      const block = match[1];
      const get = (tag) => {
        const m = block.match(new RegExp('<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>'));
        if (m) return m[1];
        const m2 = block.match(new RegExp('<' + tag + '>([^<]*)<\\/' + tag + '>'));
        return m2 ? m2[1] : '';
      };
      libs.push({
        lib: {
          libCode: get('libCode'),
          libName: get('libName'),
          address: get('address'),
          tel: get('tel'),
          fax: get('fax'),
          latitude: get('latitude'),
          longitude: get('longitude'),
          homepage: get('homepage'),
          closed: get('closed'),
          operatingTime: get('operatingTime'),
          BookCount: get('BookCount')
        }
      });
    }

    const numFoundMatch = text.match(/<numFound>(\d+)<\/numFound>/);
    const numFound = numFoundMatch ? parseInt(numFoundMatch[1]) : libs.length;

    const result = {
      response: {
        request: {},
        numFound: numFound,
        resultNum: libs.length,
        libs: libs
      }
    };

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(200).send(JSON.stringify(result));
  } catch (error) {
    return res.status(500).json({ error: 'Proxy failed', detail: error.message });
  }
}
