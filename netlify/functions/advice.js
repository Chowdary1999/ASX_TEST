// netlify/functions/advice.js
const SITE_BASE = process.env.SITE_BASE || "";

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Upstream ${res.status} for ${url}`);
  return res.json();
}

function json(body, status = 200) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  try {
    const params = event.queryStringParameters || {};
    const mode = params.mode || "pick";
    const base = SITE_BASE || `https://${event.headers.host}`;

    let systemPrompt = `You are an ASX swing-trading assistant.`;
    let userPrompt = "";
    let facts = {};

    if (mode === "pick") {
      const pick = await getJSON(`${base}/.netlify/functions/market?fn=pick`);
      facts = { pick };
      userPrompt = `Here is the top candidate:\n${JSON.stringify(pick)}\nAdvise whether to buy.`;
    } else if (mode === "holding") {
      const symbol = (params.symbol || "").toUpperCase();
      const entry = Number(params.entry || 0);
      const purchasedAt = params.purchasedAt || "";
      const since = await getJSON(`${base}/.netlify/functions/market?fn=since&symbol=${symbol}&from=${purchasedAt}`);
      facts = { symbol, entry, purchasedAt, since };
      userPrompt = `Current holding:\n${JSON.stringify(facts)}\nAdvise HOLD/SELL/TP.`;
    } else {
      return json({ error: "Unsupported mode" }, 400);
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return json({ error: "OPENAI_API_KEY not set" }, 500);

    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], response_format: { type: "json_object" } }),
    });
    const data = await res.json();
    const content = data?.output?.[0]?.content?.[0]?.text || "";
    let parsed;
    try { parsed = JSON.parse(content); } catch { parsed = { raw: content }; }
    return json({ mode, facts, advice: parsed });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
