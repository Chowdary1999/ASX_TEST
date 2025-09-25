// netlify/functions/market.js
// Yahoo-only 90-day history + live quote; universe size & timeout profile aware.
const https = require('https');

const UNIVERSE = [
  "BHP.AX","CBA.AX","CSL.AX","NAB.AX","WBC.AX","ANZ.AX","WES.AX","WDS.AX","FMG.AX","MQG.AX","TLS.AX","WOW.AX","RIO.AX","BXB.AX","GMG.AX","ALL.AX","WHC.AX","MIN.AX","PLS.AX","IGO.AX","XRO.AX","CAR.AX","CPU.AX","RMD.AX","QAN.AX","REA.AX","S32.AX","WTC.AX",
  "TCL.AX","QBE.AX","ORG.AX","WOR.AX","SUN.AX","COH.AX","COL.AX","APA.AX","CWY.AX","DMP.AX","FLT.AX","GPT.AX","IAG.AX","JHX.AX","LLC.AX","MPL.AX","NXT.AX","ORI.AX","PME.AX","SEK.AX","SHL.AX","SXY.AX","TWE.AX","VCX.AX","WTC.AX","WHC.AX","MIN.AX","LTR.AX","LYC.AX","CXO.AX","RMD.AX","PMV.AX","BRG.AX","SUL.AX","SGP.AX","SCG.AX","EVN.AX","NST.AX","NIC.AX","MP1.AX","WEB.AX","ALU.AX","A2M.AX"
];

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
  return { statusCode: status, headers: { 'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':'*' }, body: JSON.stringify(body) };
}
function timeouts(profile){
  if(profile==='large') return { perReq: 7500, chart: 7500, workers: 3, limit: 80 };
  if(profile==='medium') return { perReq: 6000, chart: 6000, workers: 4, limit: 50 };
  return { perReq: 4500, chart: 4500, workers: 4, limit: 24 };
}
async function yahooChart(symbolAX, range='3mo', interval='1d', timeoutMs=5000){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbolAX)}?interval=${interval}&range=${range}`;
  const y = await fetchJSON(url, timeoutMs);
  return y?.chart?.result?.[0] || null;
}
function pctChange(arr, n){ if(!arr||arr.length<=n) return null; const a=arr[arr.length-1], b=arr[arr.length-1-n]; if(!isFinite(a)||!isFinite(b)||b===0) return null; return (a-b)/b*100; }
function stdev(arr){ if(!arr||arr.length<2) return null; const m=arr.reduce((a,b)=>a+b,0)/arr.length; const v=arr.reduce((a,b)=>a+(b-m)*(b-m),0)/(arr.length-1); return Math.sqrt(v); }
function downsample(arr, step=2){ const out=[]; for(let i=Math.max(0,arr.length-90); i<arr.length; i+=step){ const v=arr[i]; if(v!=null) out.push(Number(v.toFixed(4))); } return out; }

async function get90d(symbol, chartTimeout){
  const r = await yahooChart(symbol,'3mo','1d',chartTimeout);
  const closes = r?.indicators?.quote?.[0]?.close || [];
  const vols   = r?.indicators?.quote?.[0]?.volume || [];
  if(closes.length < 45) return null;
  const last = [...closes].reverse().find(v=>v!=null);
  if(!isFinite(last)||last<=0.01) return null;
  const d1=pctChange(closes,1)||0, d5=pctChange(closes,5)||0, d20=pctChange(closes,20)||0;
  const sd20=stdev(closes.slice(-20))||0;
  const vAvg = Math.round((vols.slice(-20).filter(v=>v!=null).reduce((a,b)=>a+b,0) / Math.max(1,vols.slice(-20).filter(v=>v!=null).length)) || 0);
  const ds = downsample(closes,2);
  const score = 0.6*d1 + 0.3*d5 + 0.1*d20;
  return { symbol, name: symbol.replace('.AX',''), entry: last, d1, d5, d20, sd20, vAvg, closes90: ds, score };
}

async function buildCandidates(profile='small'){
  const { chart, workers, limit } = timeouts(profile);
  const pool = UNIVERSE.slice(0, limit);
  const out = [];
  let idx = 0;
  async function worker(){
    while(idx < pool.length && out.length < limit){
      const s = pool[idx++];
      try{ const row = await get90d(s, chart); if(row) out.push(row); }catch{}
    }
  }
  const ws = Array.from({length:workers}, ()=>worker());
  await Promise.all(ws);
  out.sort((a,b)=>(b.score||-1e9)-(a.score||-1e9));
  return out;
}

exports.handler = async (event) => {
  try {
    const q = event.queryStringParameters || {};
    const fn = q.fn || 'candidates';
    if (fn === 'ping') return json({ ok:true, time: Date.now() });
    const profile = (q.profile||q.universe||'small').toLowerCase(); // small|medium|large

    if (fn === 'quote'){
      const sym = (q.symbol||'').trim().toUpperCase();
      const use = sym.includes('.AX')? sym : `${sym}.AX`;
      const r = await yahooChart(use,'1mo','1d',timeouts(profile).perReq);
      const closes = r?.indicators?.quote?.[0]?.close || [];
      const last = [...closes].reverse().find(v=>v!=null);
      return json({ symbol: use, last });
    }
    if (fn === 'history'){
      const sym = (q.symbol||'').trim().toUpperCase();
      const use = sym.includes('.AX')? sym : `${sym}.AX`;
      const r = await yahooChart(use,'3mo','1d',timeouts(profile).chart);
      const closes = r?.indicators?.quote?.[0]?.close || [];
      return json({ symbol: use, closes });
    }
    if (fn === 'candidates'){
      const cands = await buildCandidates(profile);
      return json({ candidates: cands, asOf: new Date().toISOString(), profile });
    }
    if (fn === 'universe'){
      return json({ symbols: UNIVERSE });
    }
    return json({ error: 'Unsupported fn' }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
