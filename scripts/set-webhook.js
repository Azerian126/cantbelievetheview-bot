// Uso: TELEGRAM_BOT_TOKEN=... VERCEL_URL=tu-proyecto.vercel.app node scripts/set-webhook.js
// (o definí esas dos variables en tu .env y corré `node -r dotenv/config scripts/set-webhook.js`)
const token = process.env.TELEGRAM_BOT_TOKEN;
const vercelUrl = process.env.VERCEL_URL || process.argv[2];

if (!token || !vercelUrl) {
  console.error('Faltan TELEGRAM_BOT_TOKEN y/o VERCEL_URL.');
  console.error('Uso: TELEGRAM_BOT_TOKEN=xxx VERCEL_URL=tu-proyecto.vercel.app node scripts/set-webhook.js');
  process.exit(1);
}

const webhookUrl = `https://${vercelUrl.replace(/^https?:\/\//, '')}/api/webhook`;

fetch(`https://api.telegram.org/bot${token}/setWebhook?url=${encodeURIComponent(webhookUrl)}`)
  .then((r) => r.json())
  .then((data) => {
    console.log(data);
    if (data.ok) console.log(`\n✅ Webhook seteado a ${webhookUrl}`);
  })
  .catch((err) => console.error('Error:', err));
