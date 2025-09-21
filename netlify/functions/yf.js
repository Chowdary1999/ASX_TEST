// netlify/functions/yf.js
// Yahoo Finance proxy (no API key).
// Endpoints:
//  - /.netlify/functions/yf?fn=quote&symbols=PLS.AX,CSL.AX
//  - /.netlify/functions/yf?fn=spark&symbols=PLS.AX,CSL.AX&range=1mo&interval=1d
export async function handler(event, context) {
  const { fn, symbols = "", range = "1mo", interval = "1d" } = event.queryStringParameters || {};
  try {
    let url;
    if (fn === "quote") {
      url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}`;
    } else if (fn === "spark") {
      url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${symbols}&range=${range}&interval=${interval}`;
    } else {
      return json({ error: "Unsupported fn. Use fn=quote|spark" }, 400);
    }
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      const text = await res.text();
      return json({ error: `Upstream error ${res.status}`, body: text }, res.status);
    }
    const data = await res.json();
    return json(data, 200, {
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

function json(body, status = 200, headers = {}) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  };
}
