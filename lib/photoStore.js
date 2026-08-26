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

module.exports = {
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
