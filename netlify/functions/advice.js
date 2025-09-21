// netlify/functions/advice.js
// Includes capital & fees context for AI; adds timelineDays for pick/manual/holding.
const SITE_BASE = process.env.SITE_BASE || "";

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}
async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Upstream ${res.status} for ${url}`);
  return res.json();
}
async function callOpenAI(payload){
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`OpenAI ${resp.status}: ${text}`);
  }
  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content || "";
  return content;
}

function feeFor(capital){
  const c = Number(capital||0);
  if (c <= 1000) return 5.00;
  if (c <= 3000) return 10.00;
  if (c <= 10000) return 19.95;
  if (c <= 25000) return 29.95;
  return 29.95;
}

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const mode = params.mode || "pick";
    const base = SITE_BASE || `https://${event.headers.host}`;
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const capital = Number(params.capital || 1000);
    const buyFee = feeFor(capital);
    const sellFee = feeFor(capital);
    const totalFees = (buyFee + sellFee).toFixed(2);

    if (mode === "pick") {
      const pick = await getJSON(`${base}/.netlify/functions/market?fn=pick`);
      const sys = `You are an ASX swing-trading assistant. Max allocation A$${capital}. Assume CommSec fees: buy A$${buyFee.toFixed(2)}, sell A$${sellFee.toFixed(2)} (total A$${totalFees}). Return JSON only.`;
      const user = `Best candidate:\n${JSON.stringify(pick)}\nReturn JSON: {"symbol": "...", "entry": number, "target": number, "stop": number, "qty": number, "timelineDays": number, "rationale": "..."}`;
      let content;
      try {
        content = await callOpenAI({ model, messages:[{role:"system",content:sys},{role:"user",content:user}], response_format:{type:"json_object"} });
      } catch { content = await callOpenAI({ model, messages:[{role:"system",content:sys},{role:"user",content:user}] }); }
      let parsed; try{ parsed = JSON.parse(content); }catch{ parsed = { raw: content }; }
      return json({ mode, advice: parsed });
    }

    if (mode === "holding") {
      const symbol = (params.symbol || "").toUpperCase();
      const entry = Number(params.entry || 0);
      const purchasedAt = params.purchasedAt || "";
      if (!symbol || !entry || !purchasedAt) return json({ error: "Missing symbol, entry, or purchasedAt" }, 400);
      const since = await getJSON(`${base}/.netlify/functions/market?fn=since&symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(purchasedAt)}`);
      const sys = `You advise HOLD/SELL/TAKE PROFIT. Capital A$${capital}. CommSec fees buy A$${buyFee.toFixed(2)} + sell A$${sellFee.toFixed(2)} (total A$${totalFees}). Use +8% target or trail 1.5% under the highest close since buy. Return JSON only.`;
      const user = `Holding: ${JSON.stringify({symbol, entry, purchasedAt})}\nSince: ${JSON.stringify(since)}\nReturn JSON: {"decision":"HOLD|SELL|TAKE PROFIT","exitPrice":number,"timelineDays": number,"rationale":"...","estNetPL":number}`;
      let content;
      try {
        content = await callOpenAI({ model, messages:[{role:"system",content:sys},{role:"user",content:user}], response_format:{type:"json_object"} });
      } catch { content = await callOpenAI({ model, messages:[{role:"system",content:sys},{role:"user",content:user}] }); }
      let parsed; try{ parsed = JSON.parse(content); }catch{ parsed = { raw: content }; }
      return json({ mode, advice: parsed });
    }

    if (mode === "manual") {
      const symbol = (params.symbol || "").toUpperCase();
      const entry = Number(params.entry || 0);
      const purchasedAt = params.purchasedAt || "";
      if (!symbol || !entry) return json({ error: "Missing symbol or entry" }, 400);
      const chart = await getJSON(`${base}/.netlify/functions/market?fn=chart&symbol=${encodeURIComponent(symbol)}&range=1y&interval=1d`);
      const sys = `You are an ASX swing-trading assistant. Capital A$${capital}. CommSec fees buy A$${buyFee.toFixed(2)} + sell A$${sellFee.toFixed(2)}. Return JSON only.`;
      const user = `Symbol: ${symbol}\nEntry: ${entry}\nPurchaseDate: ${purchasedAt}\nChartSummary: ${JSON.stringify({last:chart.last,high:chart.high,low:chart.low,points:chart.points?.slice(-60)})}\nGuidelines: prefer +8% target, -5% stop; consider trend over last year; keep response concise.\nReturn JSON: {"decision":"HOLD|SELL|TAKE PROFIT","target":number,"stop":number,"timelineDays": number,"rationale":"..."}`;
      let content;
      try {
        content = await callOpenAI({ model, messages:[{role:"system",content:sys},{role:"user",content:user}], response_format:{type:"json_object"} });
      } catch { content = await callOpenAI({ model, messages:[{role:"system",content:sys},{role:"user",content:user}] }); }
      let parsed; try{ parsed = JSON.parse(content); }catch{ parsed = { raw: content }; }
      return json({ mode, advice: parsed });
    }

    return json({ error: "Unsupported mode. Use mode=pick|holding|manual" }, 400);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
