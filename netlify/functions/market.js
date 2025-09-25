// netlify/functions/market.js
// Robust picker with multi-stage fallbacks: TE -> Yahoo, else Hardcoded ASX basket.
const https = require('https');

function fetchJSON(url, timeoutMs=6000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data=''; res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`Bad JSON from ${url}: ${e.message}`)); } });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('Timeout')); });
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

async function yahooChart(symbolAX, range='6mo', interval='1d', timeoutMs=6000){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolAX)}?interval=${interval}&range=${range}`;
  return fetchJSON(url, timeoutMs).then(y=>y?.chart?.result?.[0]||null);
}
function pctChange(closes, lookback){
  if(!closes || closes.length<=lookback) return null;
  const a = closes[closes.length-1], b = closes[closes.length-1-lookback];
  if(!isFinite(a)||!isFinite(b)||b===0) return null;
  return (a-b)/b*100;
}
async function scoreWithYahoo(symbolAX, mcap, timeoutPer=2500){
  const r = await yahooChart(symbolAX, '6mo', '1d', timeoutPer);
  const closes = r?.indicators?.quote?.[0]?.close || [];
  if (closes.length < 40) return null;
  const last = closes[closes.length-1];
  if (!isFinite(last) || last <= 0.05) return null;
  const d1 = pctChange(closes,1)??0, d5 = pctChange(closes,5)??0, d20 = pctChange(closes,20)??0;
  const score = 0.6*d1 + 0.3*d5 + 0.1*d20 - (mcap>5e9?1.25:(mcap>1e9?0.5:0));
  return { entry:last, score };
}

const HARDCODED = [
  'BHP.AX','CBA.AX','CSL.AX','NAB.AX','WBC.AX','ANZ.AX','WES.AX','WDS.AX','FMG.AX','MQG.AX',
  'TLS.AX','WOW.AX','TCL.AX','QBE.AX','PLS.AX','RIO.AX','ALL.AX','BXB.AX','GMG.AX','ORG.AX'
];

async function buildPoolFromTE(mode){
  try{
    const te = await fetchJSON('https://api.tradingeconomics.com/markets/stocks/country/australia?c=guest:guest&f=json', 6000);
    const rows = (te||[]).map(r => ({
      symbol: (r.Symbol || r.symbol || '').toUpperCase(),
      name: r.Name || r.name || '',
      mcap: r.MarketCap ?? r.market_cap ?? 0,
      last: r.Last ?? r.last ?? null,
      d: {
        day: r.DailyPercentualChange ?? r.daily_percentual_change ?? 0,
        week: r.WeeklyPercentualChange ?? r.weekly_percentual_change ?? 0,
        month: r.MonthlyPercentualChange ?? r.monthly_percentual_change ?? 0,
      }
    })).filter(r => r.symbol && r.symbol.endsWith('.AX'));
    const limit = mode==='full' ? 50 : 20;
    return rows.sort((a,b)=>(b.mcap||0)-(a.mcap||0)).slice(0, limit);
  }catch(e){
    return null; // TE down
  }
}

async function pick3Robust(mode='fast'){
  const deadline = Date.now() + (mode==='full' ? 9000 : 6000);
  let pool = await buildPoolFromTE(mode);
  let note = 'yahoo momentum via TE pool';

  if(!pool){
    // Fallback to hardcoded blue-chip basket if TE is unreachable
    note = 'yahoo momentum via hardcoded basket';
    pool = HARDCODED.map(s => ({ symbol: s, name: s.replace('.AX',''), mcap: 1e9 }));
  }

  const out = [];
  let idx = 0;
  async function worker(){
    while(idx < pool.length && Date.now() < deadline && out.length < 12){
      const row = pool[idx++];
      try{
        const r = await scoreWithYahoo(row.symbol, row.mcap||1e9, 2000);
        if (r) out.push({ symbol:row.symbol, name:row.name, entry:r.entry, score:r.score });
      }catch{}
    }
  }
  await Promise.all([worker(),worker(),worker(),worker()]);

  if (out.length < 3){
    // Fallback to change deltas if available; else last resort: take last prices only
    if (pool[0]?.d){
      const fallback = pool.map(row=>{
        const entry = Number(row.last) || 0;
        const score = (row.d.day||0) + 0.5*(row.d.week||0) + 0.25*(row.d.month||0) - (row.mcap>5e9?1.25:(row.mcap>1e9?0.5:0));
        return { symbol:row.symbol, name:row.name, entry, score };
      }).filter(r => r.entry>0.05);
      fallback.sort((a,b)=> (b.score||-1e9)-(a.score||-1e9));
      const picks = fallback.slice(0,3).map((t,i)=>({ ...t, rank:i+1 }));
      return { picks, asOf:new Date().toISOString(), note: note + ' (fallback: TE deltas)' };
    }else{
      const picks = HARDCODED.slice(0,3).map((s,i)=>({ symbol:s, name:s.replace('.AX',''), entry: 1.00, score: 0, rank:i+1 }));
      return { picks, asOf:new Date().toISOString(), note: note + ' (last resort)' };
    }
  }

  out.sort((a,b)=> (b.score||-1e9)-(a.score||-1e9));
  const picks = out.slice(0,3).map((t,i)=>({ ...t, rank:i+1 }));
  return { picks, asOf:new Date().toISOString(), note };
}

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    if ((q.fn||'') !== 'pick3') return json({ error: 'Unsupported fn. Use fn=pick3' }, 400);
    const mode = q.mode || 'fast';
    const result = await pick3Robust(mode);
    return json(result);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
