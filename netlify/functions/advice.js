// netlify/functions/advice.js
// Analyst-grade AI with universe-size aware batching to avoid 504.
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function json(body,status=200){return{statusCode:status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'},body:JSON.stringify(body)}}
function originFromEvent(event){
  try{
    if(process.env.SITE_BASE) return process.env.SITE_BASE;
    if(event.rawUrl){const u=new URL(event.rawUrl);return u.origin;}
    const host = event.headers && (event.headers['x-forwarded-host']||event.headers.host);
    const proto = (event.headers && (event.headers['x-forwarded-proto']||event.headers['x-forwarded-protocol'])) || 'https';
    return `${proto}://${host}`;
  }catch{return ''}
}
async function getJSON(url, timeoutMs=7000){
  const ctrl = new AbortController(); const id = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{ const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}, signal:ctrl.signal}); if(!r.ok) throw new Error('Upstream '+r.status+' for '+url); return r.json(); } finally{ clearTimeout(id); }
}
async function getText(url, timeoutMs=6000){
  const ctrl = new AbortController(); const id = setTimeout(()=>ctrl.abort(), timeoutMs);
  try{ const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}, signal:ctrl.signal}); if(!r.ok) throw new Error('Upstream '+r.status+' for '+url); return r.text(); } finally{ clearTimeout(id); }
}
async function callOpenAI(model,messages){
  const k=process.env.OPENAI_API_KEY; if(!k) throw new Error('OPENAI_API_KEY not set');
  const r=await fetch(OPENAI_URL,{method:'POST',headers:{'Authorization':'Bearer '+k,'Content-Type':'application/json'},body:JSON.stringify({model,messages,temperature:0.35,response_format:{type:'json_object'}})});
  if(!r.ok){const t=await r.text();throw new Error('OpenAI '+r.status+': '+t)} const d=await r.json(); return d?.choices?.[0]?.message?.content||'{}';
}

async function yahooFinancials(symbol){
  try{
    const mods=['incomeStatementHistory','balanceSheetHistory','cashflowStatementHistory','defaultKeyStatistics','price','earnings'];
    const url=`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${mods.join(',')}`;
    const r=await getJSON(url,6000);
    const pick=(o,p,d=null)=>{try{return p.split('.').reduce((a,k)=>a&&a[k],o)??d}catch{return d}};
    const price=pick(r,'quoteSummary.result.0.price.regularMarketPrice.raw',null);
    const mcap=pick(r,'quoteSummary.result.0.price.marketCap.raw',null);
    const eps=pick(r,'quoteSummary.result.0.defaultKeyStatistics.trailingEps.raw',null);
    const pe=(price!=null&&eps)?(price/eps):pick(r,'quoteSummary.result.0.defaultKeyStatistics.trailingPE.raw',null);
    const bs=pick(r,'quoteSummary.result.0.balanceSheetHistory.balanceSheetStatements.0',{});
    const debt=(pick(bs,'longTermDebt.raw',0)+pick(bs,'shortLongTermDebt.raw',0))||0;
    const equity=pick(bs,'totalStockholderEquity.raw',null);
    const inc=pick(r,'quoteSummary.result.0.incomeStatementHistory.incomeStatementHistory.0',{});
    const revenue=pick(inc,'totalRevenue.raw',null);
    const netIncome=pick(inc,'netIncome.raw',null);
    const cf=pick(r,'quoteSummary.result.0.cashflowStatementHistory.cashflowStatements.0',{});
    const opCash=pick(cf,'totalCashFromOperatingActivities.raw',null);
    return { price,mcap,pe,revenue,netIncome,debt,equity,opCash };
  }catch{return null}
}
function parseGoogleNewsRSS(xml,limit=3){
  const items=[]; const parts=xml.split('<item>').slice(1);
  for(const p of parts){
    const title=(p.split('<title>')[1]||'').split('</title>')[0].replace(/<!\[CDATA\[|\]\]>/g,'').trim();
    const link=(p.split('<link>')[1]||'').split('</link>')[0].trim();
    const source=((p.split('<source')[1]||'').split('>')[1]||'').replace('</source>','').trim();
    if(title&&link){items.push({title,url:link,source}); if(items.length>=limit)break;}
  }
  return items;
}
async function newsFor(symbol){
  const raw = symbol.replace('.AX','') + ' site:au.finance.yahoo.com OR site:news.google.com';
  const q = encodeURIComponent(raw);
  const url=`https://news.google.com/rss/search?q=${q}&hl=en-AU&gl=AU&ceid=AU:en`;
  try{ const xml=await getText(url,5000); return parseGoogleNewsRSS(xml,3);}catch{return []}
}

exports.handler = async (event)=>{try{
  const q = event.queryStringParameters||{};
  const mode = q.mode||'';
  if(mode==='ping') return { statusCode:200, headers:{'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'}, body:'ok' };
  if(mode!=='analyst-weekly') return json({error:'Unsupported mode'},400);

  const capital=Number(q.capital||1000), profitPct=Number(q.profitPct||7.5);
  const universe=(q.universe||'small').toLowerCase();
  const model=process.env.OPENAI_MODEL||'gpt-4o-mini';
  const base=originFromEvent(event)||'';

  // Map universe size to candidate pool and enrichment caps
  const profiles={small:{limit:24,enrich:9},medium:{limit:50,enrich:12},large:{limit:80,enrich:15}};
  const prof=profiles[universe]||profiles.small;

  // Step 1: candidates with profile
  const candRes=await getJSON(`${base}/.netlify/functions/market?fn=candidates&profile=${encodeURIComponent(universe)}`, universe==='large'?9000:7000);
  const pool=(candRes.candidates||[]).slice(0,prof.limit);

  // Step 2: enrich in controlled batches
  async function enrich(row){ const [fin,news]=await Promise.all([yahooFinancials(row.symbol),newsFor(row.symbol)]); return {...row,financials:fin,news}; }
  const enriched=[]; const batchSize=3;
  for(let i=0;i<pool.length && enriched.length<prof.enrich;i+=batchSize){
    const slice=pool.slice(i,i+batchSize);
    const part=await Promise.all(slice.map(enrich));
    enriched.push(...part);
  }

  // Step 3: ask OpenAI
  const sys=`You are an experienced ASX equity analyst. Pick exactly 3 symbols for the NEXT 5 TRADING DAYS.
Use: 90-day trend (closes90), momentum (d1,d5,d20), 20d stdev, avg volume, fundamentals (PE, revenue, income, debt/equity, cashflow), and recent headlines for catalysts & risks.
The user can invest about A$${capital}. They will set a net +${profitPct}%% target after fees; you must also provide **targetPrice**, **timelineDays**, **confidence** (0–1). Prefer liquid names and avoid over-concentration.`;

  const user=`ENRICHED CANDIDATES (trimmed to ${prof.enrich} out of ${prof.limit}):\n${JSON.stringify(enriched)}\nReturn JSON exactly:\n{"picks":[{"symbol":"...","name":"...","entry":0,"aiScore":0,"targetPrice":0,"timelineDays":0,"confidence":0,"rationale":"...","catalysts":["..."],"risks":["..."],"news":[{"title":"...","url":"...","source":"..."}]},{},{}],"asOf":"${new Date().toISOString()}"}`;

  const content=await callOpenAI(model,[{role:'system',content:sys},{role:'user',content:user}]);
  let parsed; try{ parsed=JSON.parse(content);}catch{ parsed={ raw: content }; }
  return json(parsed);
}catch(e){return json({error:e.message},500)}};
