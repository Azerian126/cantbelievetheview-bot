// Uso: TELEGRAM_BOT_TOKEN=... node scripts/delete-webhook.js
// Útil si algo queda roto y querés que el bot deje de recibir updates.
const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error('Falta TELEGRAM_BOT_TOKEN.');
  process.exit(1);
}

fetch(`https://api.telegram.org/bot${token}/deleteWebhook`)
  .then((r) => r.json())
  .then((data) => console.log(data))
  .catch((err) => console.error('Error:', err));
