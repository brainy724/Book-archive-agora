

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
