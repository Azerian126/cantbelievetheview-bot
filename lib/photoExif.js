// Lee el GPS que la cámara dejó grabado en la foto.
//
// Por qué importa: hasta ahora la ubicación salía de "compartir ubicación",
// que manda dónde está Mario EN ESE MOMENTO — subir de noche desde el hotel
// geolocalizaba la foto en el hotel. El EXIF es el único dato que sabe dónde
// estaba parado cuando disparó.
//
// Funciona porque las fotos entran como ARCHIVO: Telegram borra el EXIF de las
// que llegan comprimidas, pero el archivo original pasa intacto. Y el buffer
// ya está descargado (se baja para el hash de duplicados), así que esto no
// agrega ni una descarga.
const exifr = require('exifr');

// Cuántos decimales se publican. 4 decimales ≈ 11 metros, suficiente para
// ubicar la foto en un mapa y lo bastante impreciso como para no publicar el
// portal exacto desde donde se disparó — data.json es un repo PÚBLICO.
const DECIMALES_PUBLICADOS = 4;

function redondear(n) {
  const f = Math.pow(10, DECIMALES_PUBLICADOS);
  return Math.round(n * f) / f;
}

/** Coordenadas de la foto, o null si no las trae. Nunca lanza: una foto sin
 *  EXIF, con el EXIF roto o en un formato que no sabemos leer no puede
 *  frenar una subida — se cae al camino manual de siempre. */
async function gpsFromBuffer(buffer) {
  try {
    const gps = await exifr.gps(buffer);
    if (!gps || typeof gps.latitude !== 'number' || typeof gps.longitude !== 'number') return null;
    if (Number.isNaN(gps.latitude) || Number.isNaN(gps.longitude)) return null;
    // Una cámara sin fix de GPS a veces graba 0,0 — que es un punto real en
    // el Atlántico, así que hay que descartarlo a mano.
    if (gps.latitude === 0 && gps.longitude === 0) return null;
    if (Math.abs(gps.latitude) > 90 || Math.abs(gps.longitude) > 180) return null;
    return { lat: redondear(gps.latitude), lng: redondear(gps.longitude) };
  } catch (err) {
    console.error('No pude leer el EXIF:', err.message);
    return null;
  }
}

module.exports = { gpsFromBuffer, redondear, DECIMALES_PUBLICADOS };
