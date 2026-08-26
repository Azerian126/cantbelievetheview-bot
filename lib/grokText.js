// Sugerencias de texto con Grok (xAI) — Mario elige una opción en vez de
// escribir todo a mano. Se usa para:
// - el título/caption de cada foto (mira la imagen, sugiere 3 opciones)
// - la intro de un país nuevo (sugiere 3 frases, en español + inglés)
const MODEL = 'grok-4.6';

async function askGrok(input) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('Falta XAI_API_KEY');
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`xAI ${res.status}: ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const item = json.output && json.output[0];
  const text = item && item.content && item.content[0] && item.content[0].text;
  if (!text) throw new Error('Respuesta de xAI sin texto: ' + JSON.stringify(json).slice(0, 300));
  return text;
}

// Limpia numeración/comillas/guiones que el modelo a veces agrega aunque se
// le pida que no lo haga.
function stripDecoration(line) {
  return line.replace(/^[\s\-*\d.)]+/, '').replace(/^["“]|["”]\s*$/g, '').trim();
}

async function suggestCaptions(imageUrl, count = 3) {
  const prompt =
    `Mirá esta foto y escribí ${count} títulos cortos y evocadores en español para una galería de ` +
    'fotografía de viajes, en este estilo: "Templos y niebla.", "Andes, niebla y ruinas incas al amanecer.". ' +
    `Máximo 8 palabras cada uno. Sin comillas, sin numerar, sin explicaciones — una idea por línea, ` +
    `exactamente ${count} líneas y nada más.`;
  const text = await askGrok([
    {
      role: 'user',
      content: [
        { type: 'input_image', image_url: imageUrl },
        { type: 'input_text', text: prompt },
      ],
    },
  ]);
  return text
    .split('\n')
    .map(stripDecoration)
    .filter(Boolean)
    .slice(0, count);
}

async function suggestCountryIntro(countryName, count = 3) {
  const prompt =
    `Escribí ${count} frases cortas de introducción para la galería de fotos de ${countryName} en un ` +
    'sitio de fotografía de viajes, en este estilo: "Andes, niebla y ruinas incas al amanecer." (para Perú), ' +
    '"Glaciares, auroras y una luz que no se apaga." (para Islandia). Para cada una dame también la ' +
    `traducción al inglés. Devolvé EXACTAMENTE este formato, ${count} bloques separados por "---", sin ` +
    'numerar ni agregar nada más:\n\nES: <frase en español>\nEN: <frase en inglés>';
  const text = await askGrok(prompt);
  const blocks = text.split('---').map((b) => b.trim()).filter(Boolean);
  const results = [];
  for (const block of blocks) {
    const es = block.match(/ES:\s*(.+)/i);
    const en = block.match(/EN:\s*(.+)/i);
    if (es && en) results.push({ es: stripDecoration(es[1]), en: stripDecoration(en[1]) });
  }
  return results.slice(0, count);
}

// Traduce un texto corto ya elegido/escrito (título de foto o descripción de
// país) al inglés — se llama sola, sin agregar ningún paso al flujo (nada de
// pedir que lo escribas dos veces, ni el truco de mandar "-" para copiarlo
// tal cual, que no traducía nada). Si falla, quien llama simplemente no
// guarda la versión en inglés y el sitio cae al texto en español también en
// la versión inglesa (mejor eso que trabar la subida por un problema de
// traducción).
async function translateToEnglish(text) {
  const prompt =
    `Traducí este texto corto de una galería de fotografía de viajes al inglés, manteniendo el mismo ` +
    `tono evocador (no literal palabra por palabra si suena mejor natural). Devolvé SOLO la ` +
    `traducción, sin comillas ni explicaciones:\n\n${text}`;
  const result = await askGrok(prompt);
  return stripDecoration(result.split('\n')[0]);
}

module.exports = { suggestCaptions, suggestCountryIntro, translateToEnglish };
