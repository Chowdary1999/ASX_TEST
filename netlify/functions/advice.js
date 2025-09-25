// netlify/functions/advice.js
// Analyst-grade AI: pulls Yahoo 90d candidates + financials + Google News headlines; asks OpenAI for Top 3 with targets & ETA.
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function json(body,status=200){return{statusCode:status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'},body:JSON.stringify(body)}}
async function getJSON(url){const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}});if(!r.ok)throw new Error('Upstream '+r.status+' for '+url);return r.json()}
async function getText(url){const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}});if(!r.ok)throw new Error('Upstream '+r.status+' for '+url);return r.text()}
async function callOpenAI(model,messages){const k=process.env.OPENAI_API_KEY;if(!k)throw new Error('OPENAI_API_KEY not set');const r=await fetch(OPENAI_URL,{method:'POST',headers:{'Authorization':'Bearer '+k,'Content-Type':'application/json'},body:JSON.stringify({model,messages,temperature:0.35,response_format:{type:'json_object'}})});if(!r.ok){const t=await r.text();throw new Error('OpenAI '+r.status+': '+t)}const d=await r.json();return d?.choices?.[0]?.message?.content||'{}'}

async function yahooFinancials(symbol){ // quoteSummary modules (best-effort; sometimes some fields missing)
  const mods = ['incomeStatementHistory','balanceSheetHistory','cashflowStatementHistory','defaultKeyStatistics','price','earnings'];
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${mods.join(',')}`;
  try{
    const j = await getJSON(url);
    const r = j?.quoteSummary?.result?.[0] || {};
    function pick(obj, path, def=null){ try{ return path.split('.').reduce((a,k)=>a&&a[k], obj) ?? def; }catch{return def;} }
    const price = pick(r,'price.regularMarketPrice.raw',null);
    const mcap  = pick(r,'price.marketCap.raw',null);
    const epsTTM= pick(r,'defaultKeyStatistics.trailingEps.raw',null);
    const pe    = (price!=null && epsTTM) ? (price/epsTTM) : pick(r,'defaultKeyStatistics.trailingPE.raw',null);
    const bs0   = pick(r,'balanceSheetHistory.balanceSheetStatements.0',{});
    const totalDebt = pick(bs0,'longTermDebt.raw',0) + pick(bs0,'shortLongTermDebt.raw',0);
    const totalEquity = pick(bs0,'totalStockholderEquity.raw',null);
    const income0 = pick(r,'incomeStatementHistory.incomeStatementHistory.0',{});
    const revenue = pick(income0,'totalRevenue.raw',null);
    const netIncome = pick(income0,'netIncome.raw',null);
    const cf0 = pick(r,'cashflowStatementHistory.cashflowStatements.0',{});
    const opCash = pick(cf0,'totalCashFromOperatingActivities.raw',null);
    return { price, mcap, epsTTM, pe, totalDebt, totalEquity, revenue, netIncome, opCash };
  }catch(e){ return null; }
}

function parseGoogleNewsRSS(xml, limit=5){
  const items = [];
  const parts = xml.split('<item>').slice(1);
  for(const p of parts){
    const title = (p.split('<title>')[1]||'').split('</title>')[0].replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const link = (p.split('<link>')[1]||'').split('</link>')[0].trim();
    const pub = (p.split('<pubDate>')[1]||'').split('</pubDate>')[0].trim();
    const source = (p.split('<source')[1]||'').split('>')[1]||'';
    if(title && link){ items.push({ title, url: link, pubDate: pub, source: source.replace('</source>','').trim() }); }
    if(items.length>=limit) break;
  }
  return items;
}

async function newsFor(symbol){
  const q = encodeURIComponent(symbol.replace('.AX','') + ' site:news.google.com OR site:au.finance.yahoo.com');
  const url = `https://news.google.com/rss/search?q=${q}&hl=en-AU&gl=AU&ceid=AU:en`;
  try{ const xml = await getText(url); return parseGoogleNewsRSS(xml, 6); }catch{ return []; }
}

exports.handler = async (event)=>{try{
  const q = event.queryStringParameters||{};
  const mode = q.mode || 'analyst-weekly';
  if(mode!=='analyst-weekly') return json({error:'Unsupported mode'},400);
  const capital = Number(q.capital||1000);
  const profitPct = Number(q.profitPct||7.5);
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const base = `https://${event.headers.host}`;

  // Step 1: candidates with 90d history from Yahoo
  const candRes = await getJSON(`${base}/.netlify/functions/market?fn=candidates`);
  const all = candRes.candidates||[];
  const short = all.slice(0, 36); // keep token usage sane

  // Step 2: fundamentals + headlines for each candidate (best-effort, bounded)
  async function enrich(row){
    const [fin, news] = await Promise.all([yahooFinancials(row.symbol), newsFor(row.symbol)]);
    return { ...row, financials: fin, news };
  }
  const enriched = [];
  for (let i=0;i<short.length;i++){
    try{ enriched.push(await enrich(short[i])); } catch {}
  }

  // Step 3: Ask OpenAI to act as an analyst and produce Top 3 with target & ETA
  const sys = `You are an experienced ASX equity analyst. Pick the BEST 3 symbols for the NEXT 5 TRADING DAYS from the provided enriched candidates.
Use: 90-day close series, momentum (d1,d5,d20), 20-day stdev, avg volume, PLUS fundamental snapshot (PE, revenue/net income, debt/equity, cashflow), and recent headlines to judge catalysts/risks and sentiment.
The user invests up to A$${capital}. CommSec fees apply on buy+sell. They will set their own net target (e.g., ${profitPct}%), but YOU must also provide your own fair-value target (price) and **timelineDays** to reach it, with a confidence 0–1.
Prefer liquid names. Avoid over-concentration if picks are similar. Return strict JSON only.`;

  const user = `ENRICHED CANDIDATES (trimmed):
${JSON.stringify(enriched)}
Return JSON exactly:
{
  "picks":[{
    "symbol":"...","name":"...","entry":number,
    "aiScore":number,
    "targetPrice":number,
    "timelineDays":number,
    "confidence": number, 
    "rationale":"concise analyst note citing momentum, fundamentals, and news; why this week; key risks",
    "catalysts":["...","..."],
    "risks":["...","..."],
    "news":[{"title":"...","url":"...","source":"..."}]
  },{},{}],
  "asOf":"${new Date().toISOString()}"
}`;

  let content = await callOpenAI(model,[{role:'system',content:sys},{role:'user',content:user}]);
  let parsed; try{ parsed = JSON.parse(content);} catch{ parsed = { raw: content }; }
  return json(parsed);
}catch(e){return json({error:e.message},500)}};
