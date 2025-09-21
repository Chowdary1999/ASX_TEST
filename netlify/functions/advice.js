// netlify/functions/advice.js
// Calls OpenAI server-side. Robust JSON handling (falls back to text if needed).
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

function buildPrompts(mode, base, params, facts){
  if (mode === "pick") {
    const pick = facts.pick;
    const sys = `You are an ASX swing-trading assistant. Single position, max A$1000. Entry=current last. Target=+8%, Stop=-5%. Be concise; return JSON only.`;
    const user = `Top candidate from live screen:\n${JSON.stringify(pick)}\nReturn JSON: {"symbol": "...", "entry": number, "target": number, "stop": number, "qty": number, "rationale": "..."}.`;
    return { sys, user };
  } else {
    const { symbol, entry, purchasedAt, since } = facts;
    const sys = `You advise HOLD/SELL/TAKE PROFIT. Use +8% target or trail 1.5% under the highest close since buy. Consider ~A$10 round-trip fees for a A$1000 allocation. Return JSON only.`;
    const user = `Holding: ${JSON.stringify({symbol, entry, purchasedAt})}\nSince: ${JSON.stringify(since)}\nReturn JSON: {"decision":"HOLD|SELL|TAKE PROFIT","exitPrice":number,"rationale":"...","estNetPL":number}`;
    return { sys, user };
  }
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

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const mode = params.mode || "pick";
    const base = SITE_BASE || `https://${event.headers.host}`;

    let facts = {};
    if (mode === "pick") {
      facts.pick = await getJSON(`${base}/.netlify/functions/market?fn=pick`);
    } else if (mode === "holding") {
      const symbol = (params.symbol || "").toUpperCase();
      const entry = Number(params.entry || 0);
      const purchasedAt = params.purchasedAt || "";
      if (!symbol || !entry || !purchasedAt) return json({ error: "Missing symbol, entry, or purchasedAt" }, 400);
      const since = await getJSON(`${base}/.netlify/functions/market?fn=since&symbol=${encodeURIComponent(symbol)}&from=${encodeURIComponent(purchasedAt)}`);
      facts = { symbol, entry, purchasedAt, since };
    } else {
      return json({ error: "Unsupported mode. Use mode=pick or mode=holding" }, 400);
    }

    const { sys, user } = buildPrompts(mode, base, params, facts);

    // Prefer JSON but allow graceful fallback
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    let content;
    try {
      content = await callOpenAI({
        model,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
        response_format: { type: "json_object" }
      });
    } catch (e) {
      // Retry without forced JSON
      content = await callOpenAI({
        model,
        messages: [{ role: "system", content: sys }, { role: "user", content: user }],
      });
    }

    let parsed;
    try { parsed = JSON.parse(content); }
    catch { parsed = { raw: content }; }

    return json({ mode, facts, advice: parsed });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
