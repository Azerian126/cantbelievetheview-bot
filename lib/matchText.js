// Matchea lo que Mario escribe en el chat (país o categoría) contra lo que ya
// existe en data.json, tolerando tipeos y acentos — así no hace falta navegar
// una lista de botones paginada, alcanza con escribir el nombre.

function normalize(s) {
  return String(s)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = [];
  for (let i = 0; i <= m; i++) dp.push(new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Hasta `limit` países candidatos para `text`, mejor match primero.
 *  distance === 0 → coincide exacto (ignorando mayúsculas/acentos).
 *  distance === 0.5 → uno es prefijo del otro (ej. "Perú" vs "Peru republic"). */
function findCountryMatches(siteData, text, limit = 4) {
  const q = normalize(text);
  if (!q) return [];
  const all = [
    ...siteData.visited.map((c) => ({ key: c.key, name: c.name, isNew: false })),
    ...siteData.visitedEmpty.map((c) => ({ key: c.key, name: c.name, isNew: true })),
  ];
  const scored = all.map((c) => {
    const n = normalize(c.name);
    let distance;
    if (n === q) distance = 0;
    else if (n.startsWith(q) || q.startsWith(n)) distance = 0.5;
    else distance = levenshtein(n, q);
    return { ...c, distance };
  });
  const threshold = Math.max(2, Math.ceil(q.length * 0.4));
  return scored
    .filter((c) => c.distance <= threshold)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

/** Si el texto es directamente el nombre (o key) de una categoría del sitio
 *  (ej. escribió "modelos"), la devuelve — así una foto sin país se puede
 *  categorizar sin pasar por el menú de botones. */
function findCategoryMatch(siteData, text) {
  const q = normalize(text);
  if (!q) return null;
  return (
    siteData.categories.find((cat) => {
      const candidates = [cat.key, cat.name, cat.nameEn].filter(Boolean).map(normalize);
      return candidates.some((c) => c === q || c.startsWith(q) || q.startsWith(c));
    }) || null
  );
}

module.exports = { normalize, findCountryMatches, findCategoryMatch };
