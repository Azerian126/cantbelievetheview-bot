const { Redis } = require('@upstash/redis');

// Esta base es la MISMA que usa el backend de checkout (cantbelievetheview-api)
// — la conectamos acá con el prefijo "BOT_" (así Vercel no choca con el
// registro interno de la integración cuando la misma base se conecta a dos
// proyectos distintos). Sin el prefijo BOT_ funcionaría igual si no fuera
// por esa limitación — dejamos también los nombres sin prefijo como fallback
// por si en algún momento se conecta sin prefijo.
const redis = new Redis({
  url:
    process.env.BOT_KV_REST_API_URL || process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token:
    process.env.BOT_KV_REST_API_TOKEN || process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
const TTL_SECONDS = 45 * 60; // una conversación abandonada se olvida sola a los 45 min — 20 cortaba a mitad de camino si tardabas pensando un caption o mandando un álbum grande

function key(chatId) {
  return `cbtv:session:${chatId}`;
}

async function getSession(chatId) {
  return (await redis.get(key(chatId))) || null;
}

async function setSession(chatId, data) {
  await redis.set(key(chatId), data, { ex: TTL_SECONDS });
}

async function clearSession(chatId) {
  await redis.del(key(chatId));
}

module.exports = { getSession, setSession, clearSession };
