// Saldo de créditos prepagos de xAI — usa la Management API, que es un host
// (management-api.x.ai) y un tipo de key DISTINTOS a la API normal de chat
// (api.x.ai, XAI_API_KEY). La management key se crea aparte en
// console.x.ai -> Settings -> Management Keys, con permiso de facturación.
const TEAM_ID = process.env.XAI_TEAM_ID;

async function getRemainingCredits() {
  const mgmtKey = process.env.XAI_MANAGEMENT_KEY;
  if (!mgmtKey) throw new Error('Falta XAI_MANAGEMENT_KEY');
  if (!TEAM_ID) throw new Error('Falta XAI_TEAM_ID');

  const res = await fetch(`https://management-api.x.ai/v1/billing/teams/${TEAM_ID}/prepaid/balance`, {
    headers: { Authorization: `Bearer ${mgmtKey}` },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`xAI management ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  // "total" es el saldo prepago actual, como string decimal (ej. "12.45").
  const val = json.total && json.total.val;
  if (val === undefined) throw new Error('Respuesta de xAI sin saldo: ' + JSON.stringify(json).slice(0, 300));
  return Number(val);
}

module.exports = { getRemainingCredits };
