// netlify/functions/yf.js (CommonJS)
const https = require('https');

async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

module.exports.handler = async (event, context) => {
  const params = event.queryStringParameters || {};
  const fn = params.fn;
  const symbols = params.symbols || '';
  const range = params.range || '1mo';
  const interval = params.interval || '1d';

  try {
    let url;
    if (fn === 'quote') {
      url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols)}`;
    } else if (fn === 'spark') {
      url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(symbols)}&range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;
    } else {
      return json({ error: 'Unsupported fn. Use fn=quote|spark' }, 400);
    }
    const data = await fetchJSON(url);
    return json(data, 200, {
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};

function json(body, status = 200, headers = {}) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}
