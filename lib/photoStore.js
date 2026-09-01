// Guarda la URL "limpia" (sin marca de agua) de cada foto en Redis — nunca
// en data.json, que es público (se lee sin auth desde GitHub y se sirve tal
// cual en el sitio). El backend de checkout (cantbelievetheview-api) lee de
// acá al momento de imprimir o mandar el email de confirmación, usando el
// mismo Upstash Redis (prefijo "cbtv:photo:", separado de "cbtv:session:"
// que ya usa session.js y "cbtv:edition:" que usa el backend).
const { Redis } = require('@upstash/redis');

let redis = null;
function getRedis() {
  if (!redis) {
    // Mismo prefijo "BOT_" que session.js — ver el comentario ahí.
    redis = new Redis({
      url:
        process.env.BOT_KV_REST_API_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
      token:
        process.env.BOT_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
    });
  }
  return redis;
}

function key(photoId) {
  return `cbtv:photo:${photoId}`;
}

async function saveCleanUrl(photoId, cleanUrl) {
  await getRedis().set(key(photoId), cleanUrl);
}

// Derivadas de impresión (una por material — ver lib/printPrep.js), en el
// mismo Redis, clave aparte. Igual que la URL limpia: nunca a data.json, que
// es público. El backend de checkout (cantbelievetheview-api) las lee al
// armar el pedido a Prodigi, y cae a la foto limpia si no encuentra nada acá.
function printKey(photoId) {
  return `cbtv:photoprint:${photoId}`;
}

async function savePrintUrls(photoId, urls) {
  await getRedis().set(printKey(photoId), urls);
}

// Detección de duplicados: sha256 del archivo -> dónde ya está subida esa
// foto. No vence (a diferencia de la sesión) — el registro sirve mientras
// exista el sitio.
function hashKey(hash) {
  return `cbtv:photohash:${hash}`;
}

async function findByHash(hash) {
  return (await getRedis().get(hashKey(hash))) || null;
}

async function saveHash(hash, photoId, label) {
  await getRedis().set(hashKey(hash), { photoId, label });
}

async function deleteHash(hash) {
  if (hash) await getRedis().del(hashKey(hash));
}

// "/undo" — guarda qué fue lo último que subió CADA chat, para poder
// revertirlo. Vence solo (24hs): deshacer tiene sentido poco después de
// subir, no semanas más tarde.
function lastUploadKey(chatId) {
  return `cbtv:lastupload:${chatId}`;
}

async function saveLastUpload(chatId, data) {
  await getRedis().set(lastUploadKey(chatId), data, { ex: 24 * 60 * 60 });
}

async function getLastUpload(chatId) {
  return (await getRedis().get(lastUploadKey(chatId))) || null;
}

async function clearLastUpload(chatId) {
  await getRedis().del(lastUploadKey(chatId));
}

// "Empezar limpios" (reset completo del contenido subido) — borra TODAS las
// claves de fotos en Redis: URLs limpias, derivadas de impresión, hashes de
// duplicados, sesiones y "último subido" a medias. No toca "cbtv:edition:"
// (contadores de numeración de impresiones vendidas — no es contenido
// subido por el bot, y no hay pedidos reales todavía, pero por las dudas
// no se mezcla con esto). No toca Cloudinary ni data.json — eso se maneja
// aparte. Usado por /resetcontent, con confirmación explícita antes.
async function resetAllPhotoKeys() {
  const patterns = ['cbtv:photo:*', 'cbtv:photoprint:*', 'cbtv:photohash:*', 'cbtv:session:*', 'cbtv:lastupload:*'];
  const redis = getRedis();
  let total = 0;
  const perPattern = {};
  for (const pattern of patterns) {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
    perPattern[pattern] = keys.length;
    total += keys.length;
  }
  return { total, perPattern };
}

// --- gasto de IA acumulado por mes -------------------------------------------
// El bot informaba solo lo que costó ESA subida, redondeado a 3 decimales: como
// cada llamada sale muy por debajo del medio milésimo, siempre decía $0.000. Un
// contador que siempre dice cero deja de mirarse. El acumulado del mes sí es un
// número que sirve para decidir.
function costKey(date) {
  const d = date || new Date();
  const mes = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `cbtv:aicost:${d.getUTCFullYear()}-${mes}`;
}

async function addMonthlyCost(usd) {
  if (!usd) return;
  // Nunca frenar una subida por no poder anotar el gasto.
  try {
    await getRedis().incrbyfloat(costKey(), usd);
  } catch (err) {
    console.error('No pude registrar el costo de IA:', err.message);
  }
}

async function getMonthlyCost() {
  try {
    const v = await getRedis().get(costKey());
    return v == null ? 0 : Number(v);
  } catch (err) {
    console.error('No pude leer el costo acumulado:', err.message);
    return null;
  }
}

module.exports = {
  addMonthlyCost,
  getMonthlyCost,
  saveCleanUrl,
  savePrintUrls,
  findByHash,
  saveHash,
  deleteHash,
  saveLastUpload,
  getLastUpload,
  clearLastUpload,
  resetAllPhotoKeys,
};
