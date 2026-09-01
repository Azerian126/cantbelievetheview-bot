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
// Etiqueta corta y legible para un resultado. El display_name de Nominatim va
// de lo más específico a lo más general ("Casco Viejo, Corregimiento de San
// Felipe, Distrito de Panamá, Provincia de Panamá, Panamá") y en un botón de
// Telegram se corta justo donde estaba lo que distinguía una opción de otra.
// Acá se arma "sitio — ciudad, país": lo que diferencia, adelante.
function shortLabelFor(r) {
  const a = r.address || {};
  const sitio = r.name || (r.display_name || '').split(',')[0];
  const zona = a.city || a.town || a.village || a.county || a.state || '';
  const pais = a.country || '';
  const cola = [zona, pais].filter(Boolean).join(', ');
  return cola ? `${sitio} — ${cola}` : sitio;
}

/** `countryHint` es el país que ya se eligió para la foto. Sin él, "Santa Ana"
 *  puede devolver El Salvador, California o Filipinas indistintamente; con él,
 *  Nominatim ordena por lo que de verdad tiene sentido. No se filtra duro (no
 *  se usa countrycodes) para no perder el caso de un lugar cuyo país en OSM no
 *  coincide con el que eligió Mario. */
async function geocodePlaces(query, limit = 4, countryHint) {
  // Sin accept-language, Nominatim devuelve el nombre que tenga cargado en
  // OSM como "principal" para ese lugar — que puede terminar en cualquier
  // idioma (ej. serbio para un sitio en Estambul). Pedimos español con
  // inglés de respaldo para que los botones sean legibles.
  const q = countryHint ? `${query}, ${countryHint}` : query;
  const url =
    'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=' +
    limit +
    '&accept-language=es,en&q=' +
    encodeURIComponent(q);
  const res = await fetch(url, {
    headers: {
      // Nominatim pide identificar la app en el User-Agent — no acepta
      // requests anónimos.
      'User-Agent': 'cantbelievetheview-bot/1.0 (Telegram photo upload bot)',
    },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const results = await res.json();
  return results.map((r) => ({
    lat: parseFloat(r.lat),
    lng: parseFloat(r.lon),
    displayName: r.display_name,
    shortLabel: shortLabelFor(r),
  }));
}

/** Al revés: de coordenadas a nombre de lugar. Se usa para poder mostrar en
 *  palabras un punto que llegó como coordenada (el pin del mapa, o el GPS que
 *  venga en el EXIF de la foto) antes de publicarlo — una coordenada suelta no
 *  se puede revisar de un vistazo, un nombre sí. */
async function reverseGeocode(lat, lng) {
  const url =
    'https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&zoom=16&accept-language=es,en' +
    `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'cantbelievetheview-bot/1.0 (Telegram photo upload bot)' },
  });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const r = await res.json();
  if (!r || r.error) return null;
  return { displayName: r.display_name, shortLabel: shortLabelFor(r) };
}

module.exports = { geocodePlaces, reverseGeocode };
