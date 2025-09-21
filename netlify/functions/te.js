export async function handler(event, context) {
  const TE_API_KEY = process.env.TE_API_KEY;
  if (!TE_API_KEY) {
    return json({ error: 'TE_API_KEY not set' }, 500);
  }
  const { fn, country = 'australia', symbol, limit = '20' } = event.queryStringParameters || {};

  try {
    let url;
    switch (fn) {
      case 'country':
        url = `https://api.tradingeconomics.com/markets/stocks/country/${encodeURIComponent(country)}?c=${TE_API_KEY}&f=json`;
        break;
      case 'symbol':
        if (!symbol) return json({ error: 'Missing symbol' }, 400);
        url = `https://api.tradingeconomics.com/markets/symbol/${encodeURIComponent(symbol)}?c=${TE_API_KEY}&f=json`;
        break;
      case 'news':
        url = `https://api.tradingeconomics.com/news?c=${TE_API_KEY}&f=json&limit=${encodeURIComponent(limit)}`;
        break;
      default:
        return json({ error: 'Unsupported fn. Use fn=country|symbol|news' }, 400);
    }

    const res = await fetch(url);
    const data = await res.json();

    return json(data, 200, {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function json(body, status = 200, headers = {}) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}