// netlify/functions/market.js
// Pick3 with timestamp and no-cache headers. It returns entry price (close) only.
// The client computes dynamic targets from capital & profit %.
const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data=''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); } });
    }).on('error', reject);
  });
}
function json(body, status=200){
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Access-Control-Allow-Origin': '*'
    },
    body: JSON.stringify(body)
  };
}

async function yahooChart(symbolAX, range='6mo', interval='1d'){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolAX)}?interval=${interval}&range=${range}`;
  const y = await fetchJSON(url);
  return y?.chart?.result?.[0] || null;
}
async function getCloses(symbolAX){
  const r = await yahooChart(symbolAX, '6mo', '1d');
  const closes = r?.indicators?.quote?.[0]?.close || [];
  return closes.filter(v => v != null);
}
function changePct(arr, nBack){
  if (!arr || arr.length <= nBack) return null;
  const a = arr[arr.length-1];
  const b = arr[arr.length-1-nBack];
  if (!isFinite(a) || !isFinite(b) || b === 0) return null;
  return (a - b) / b * 100.0;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const fn = q.fn;

  try {
    if (fn === 'pick3') {
      // seed list from TradingEconomics, then rank from Yahoo momentum
      const te = await fetchJSON(`https://api.tradingeconomics.com/markets/stocks/country/australia?c=guest:guest&f=json`);
      const rows = (te||[]).map(r => ({
        symbol: (r.Symbol || r.symbol || '').toUpperCase(),
        name: r.Name || r.name || '',
        mcap: r.MarketCap ?? r.market_cap ?? null,
      })).filter(r => r.symbol && r.symbol.endsWith('.AX'));
      const pool = rows.sort((a,b)=> (b.mcap||0)-(a.mcap||0)).slice(0, 60);

      const scored = [];
      for (const row of pool){
        try{
          const closes = await getCloses(row.symbol);
          if (!closes || closes.length < 40) continue;
          const last = closes[closes.length-1];
          if (!isFinite(last) || last <= 0.05) continue;
          const d1 = changePct(closes, 1)  ?? 0;
          const d5 = changePct(closes, 5)  ?? 0;
          const d20= changePct(closes, 20) ?? 0;
          const score = 0.6*d1 + 0.3*d5 + 0.1*d20 - (row.mcap>5e9?1.25:(row.mcap>1e9?0.5:0));
          scored.push({ rank:null, symbol:row.symbol, name:row.name, entry:last, score });
        }catch{}
      }
      scored.sort((a,b)=> (b.score||-1e9)-(a.score||-1e9));
      const top3 = scored.slice(0,3).map((t,i)=>({ ...t, rank:i+1 }));
      const asOf = new Date().toISOString();
      return json({ picks: top3, asOf });
    }

    if (fn === 'since') {
      const raw = (q.symbol||'').trim().toUpperCase();
      const from = q.from ? new Date(q.from) : null;
      if (!raw) return json({ error: 'Missing symbol' }, 400);
      const ySym = raw.includes('.AX') ? raw : `${raw}.AX`;

      const r = await yahooChart(ySym, '3mo', '1d');
      const closes = r?.indicators?.quote?.[0]?.close || [];
      const ts = r?.timestamp || [];
      let high = null;
      for (let i=0;i<closes.length;i++){
        const c = closes[i];
        if (c==null) continue;
        if (from){
          const t = ts[i] ? new Date(ts[i]*1000) : null;
          if (t && t < from) continue;
        }
        if (high==null || c>high) high=c;
      }
      const last = [...closes].reverse().find(v=>v!=null) ?? null;
      return json({ last, highSince: high });
    }

    return json({ error: 'Unsupported fn. Use fn=pick3|since' }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
