const { Redis } = require('@upstash/redis');

// Según cómo Vercel nombre las variables al conectar la integración de Upstash
// (varió con el tiempo), puede ser KV_REST_API_* o UPSTASH_REDIS_REST_*.
// Soportamos las dos para no depender de cuál te toque.
const redis = new Redis({
  url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN,
});
const TTL_SECONDS = 20 * 60; // una conversación abandonada se olvida sola a los 20 min

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
