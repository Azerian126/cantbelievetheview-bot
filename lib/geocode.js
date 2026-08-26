// Busca coordenadas a partir de un nombre de lugar escrito a mano (ej.
// "Estambul" o "Torres Petronas") — vía Nominatim (OpenStreetMap), gratis y
// sin API key. Sirve como alternativa a compartir la ubicación por GPS,
// para cuando estás subiendo una foto vieja y no estás parado ahí, o el
// cliente de Telegram no te deja elegir un punto distinto en el mapa.
//
// Devuelve varios candidatos (no solo el primero) — se muestran como
// botones para elegir, en vez de aceptar a ciegas lo que Nominatim
// devuelva primero (eso fue justo lo que pasó cuando "/cancel" se procesó
// como texto y Nominatim encontró una localidad real llamada "Cancel" en
// Francia).
async function geocodePlaces(query, limit = 4) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=' + limit + '&q=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      // Nominatim pide identificar la app en el User-Agent — no acepta
      // requests anónimos.
      'User-Agent': 'cantbelievetheview-bot/1.0 (Telegram photo upload bot)',
    },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const results = await res.json();
  return results.map((r) => ({ lat: parseFloat(r.lat), lng: parseFloat(r.lon), displayName: r.display_name }));
}

module.exports = { geocodePlaces };
