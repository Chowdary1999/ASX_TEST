// netlify/functions/advice.js
// Server-side OpenAI ranking using full 90-day Yahoo history (downsampled) for ~80 ASX symbols.
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

function json(body,status=200){return{statusCode:status,headers:{'Content-Type':'application/json','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'},body:JSON.stringify(body)}}
async function getJSON(url){const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0'}});if(!r.ok)throw new Error('Upstream '+r.status+' for '+url);return r.json()}
async function callOpenAI(model,messages){const k=process.env.OPENAI_API_KEY;if(!k)throw new Error('OPENAI_API_KEY not set');const r=await fetch(OPENAI_URL,{method:'POST',headers:{'Authorization':'Bearer '+k,'Content-Type':'application/json'},body:JSON.stringify({model,messages,temperature:0.3,response_format:{type:'json_object'}})});if(!r.ok){const t=await r.text();throw new Error('OpenAI '+r.status+': '+t)}const d=await r.json();return d?.choices?.[0]?.message?.content||'{}'}

exports.handler = async (event)=>{try{
  const q = event.queryStringParameters||{};
  const mode = q.mode || 'ai-weekly';
  if(mode!=='ai-weekly') return json({error:'Unsupported mode'},400);
  const capital = Number(q.capital||1000);
  const profitPct = Number(q.profitPct||7.5);
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const base = `https://${event.headers.host}`;

  // Pull ~80 candidates with 90-day closes and summary features (Yahoo only)
  const cands = await getJSON(`${base}/.netlify/functions/market?fn=candidates`);

  const sys = `You are an ASX equity swing-trading assistant picking the BEST 3 symbols for the NEXT 5 TRADING DAYS.
Use the provided 90-day close series (downsampled) AND the computed features.
Criteria: positive/persistent momentum without blow-off, volatility that fits a $${capital} retail account, sufficient liquidity (vAvg), and avoid over-concentration by sector if candidates are close. Penalize microcaps/illiquid/whipsaw shapes. Consider risk-adjusted momentum (d20 vs sd20), and if entries are extended.
The user will set target to NET +${profitPct}%% after CommSec buy+sell fees; you just pick the symbols and explain why this week.
Return strict JSON.`;

  const user = `Choose exactly 3 picks from these candidates (each includes 90d closes and features):
${JSON.stringify((cands.candidates||[]).slice(0,80))}
Return JSON:
{
  "picks": [{
    "symbol":"...","name":"...","entry":number,
    "aiScore": number,
    "horizonDays": 5,
    "rationale": "why this is suitable this week; reference momentum features and what the 90d shape suggests; call out liquidity and key risks",
    "riskFlags": ["..."]
  },{},{}
  ],
  "asOf": "${new Date().toISOString()}"
}`;

  let content = await callOpenAI(model,[{role:'system',content:sys},{role:'user',content:user}]);
  let parsed; try{ parsed = JSON.parse(content);} catch{ parsed = { raw: content }; }
  return json(parsed);
}catch(e){return json({error:e.message},500)}};
