// Busca coordenadas a partir de un nombre de lugar escrito a mano (ej.
// "Estambul" o "Torres Petronas") — vía Nominatim (OpenStreetMap), gratis y
// sin API key. Sirve como alternativa a compartir la ubicación por GPS,
// para cuando estás subiendo una foto vieja y no estás parado ahí, o el
// cliente de Telegram no te deja elegir un punto distinto en el mapa.
async function geocodePlace(query) {
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      // Nominatim pide identificar la app en el User-Agent — no acepta
      // requests anónimos.
      'User-Agent': 'cantbelievetheview-bot/1.0 (Telegram photo upload bot)',
    },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const results = await res.json();
  if (!results.length) return null;
  const r = results[0];
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), displayName: r.display_name };
}

module.exports = { geocodePlace };
