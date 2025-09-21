// netlify/functions/market.js
// All-in-one backend: /quote, /since, /candidates, /pick
const https = require('https');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}
function json(body, status=200, headers={}){
  return { statusCode: status, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) };
}
function pct(n){ return (n==null||isNaN(n)) ? null : Number(n); }

async function yahooLast(symbolAX){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolAX)}?interval=1d&range=1d`;
  const y = await fetchJSON(url);
  const close = y?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
  const last = [...close].reverse().find(v=>v!=null);
  return last ?? null;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const fn = q.fn;

  try {
    if (fn === 'quote') {
      const raw = (q.symbol||'').trim().toUpperCase();
      if (!raw) return json({ error: 'Missing symbol' }, 400);
      const ySym = raw.includes('.AX') ? raw : `${raw}.AX`;
      const teSym = raw.includes(':AU') ? raw : `${raw}:AU`;

      try {
        const last = await yahooLast(ySym);
        if (last != null) return json({ source: 'yahoo', symbol: ySym, last });
      } catch {}

      try {
        const teurl = `https://api.tradingeconomics.com/markets/symbol/${encodeURIComponent(teSym)}?c=guest:guest&f=json`;
        const te = await fetchJSON(teurl);
        const last = te?.[0]?.Last ?? te?.[0]?.last;
        if (last != null) return json({ source: 'te', symbol: teSym, last });
      } catch {}

      return json({ error: 'No data for symbol' }, 404);
    }

    if (fn === 'since') {
      const raw = (q.symbol||'').trim().toUpperCase();
      const from = q.from ? new Date(q.from) : null;
      if (!raw) return json({ error: 'Missing symbol' }, 400);
      const ySym = raw.includes('.AX') ? raw : `${raw}.AX`;

      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&range=3mo`;
      const y = await fetchJSON(url);
      const result = y?.chart?.result?.[0];
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const ts = result?.timestamp || [];
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

    if (fn === 'candidates' || fn === 'pick') {
      const url = `https://api.tradingeconomics.com/markets/stocks/country/australia?c=guest:guest&f=json`;
      const data = await fetchJSON(url);
      const rows = (data||[]).map(r => ({
        Symbol: r.Symbol || r.symbol,
        Name: r.Name || r.name,
        Last: r.Last ?? r.last ?? null,
        Daily: pct(r.DailyPercentualChange ?? r.daily_percentual_change),
        Weekly: pct(r.WeeklyPercentualChange ?? r.weekly_percentual_change),
        Monthly: pct(r.MonthlyPercentualChange ?? r.monthly_percentual_change),
        MarketCap: r.MarketCap ?? r.market_cap ?? null,
      })).filter(r => r.Symbol && r.Last != null);

      if (fn === 'candidates') return json({ rows });

      const ranked = rows
        .filter(r => r.Last > 0)
        .filter(r => (r.MarketCap==null) || (r.MarketCap >= 1e8))
        .map(r => {
          const capPenalty = r.MarketCap>5e9 ? 1.25 : (r.MarketCap>1e9 ? 0.5 : 0);
          const score = (r.Daily||0) + 0.5*(r.Weekly||0) + 0.25*(r.Monthly||0) - capPenalty;
          return { ...r, _score: score };
        })
        .sort((a,b)=> (b._score||-1e9)-(a._score||-1e9));

      const top = ranked[0];
      if (!top) return json({ error: 'No candidates found' }, 404);

      const entry = Number(top.Last);
      const target = entry * 1.08;
      const stop = entry * 0.95;
      const reason = `Strong momentum: daily ${top.Daily?.toFixed?.(2)}%, weekly ${top.Weekly?.toFixed?.(2)}%, monthly ${top.Monthly?.toFixed?.(2)}%` +
                     (top.MarketCap ? `; MCAP ~ ${Math.round(top.MarketCap/1e6)}M` : '');

      return json({ symbol: top.Symbol, name: top.Name, last: entry, target, stop, score: top._score, reason });
    }

    return json({ error: 'Unsupported fn. Use fn=quote|since|candidates|pick' }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
