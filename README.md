# cantbelievetheview-bot

Bot de Telegram para subir fotos a [cantbelievetheview.com](https://cantbelievetheview.com) sin tocar código.

Le mandás una foto al bot, elegís con botones a qué país o categoría corresponde,
escribís un título — y el bot sube la foto a Cloudinary, actualiza `data.json` en
el repo de [Azerian126/Cantbelievetheview](https://github.com/Azerian126/Cantbelievetheview)
y Netlify redeploya solo. En 1-2 minutos está publicada.

## Cómo funciona (resumen)

```
Vos → Telegram (foto)
   → Bot te pregunta: ¿país o categoría? (botones)
   → Bot te pregunta: título/descripción de la foto
   → [si el país no tenía galería todavía] Bot pide una descripción de intro (ES + EN)
   → Bot sube la foto a Cloudinary
   → Bot edita data.json y hace commit + push a GitHub
   → Netlify detecta el push y redeploya
```

## Setup — hacé esto en orden

### 1. Crear el bot en Telegram
Hablale a **[@BotFather](https://t.me/BotFather)** en Telegram:
```
/newbot
```
Elegí un nombre y un username (tiene que terminar en `bot`, ej. `cantbelievetheview_bot`).
BotFather te da un **token** — guardalo, es el `TELEGRAM_BOT_TOKEN`.

### 2. Conseguir tu ID de Telegram
Hablale a **[@userinfobot](https://t.me/userinfobot)** — te devuelve tu ID numérico.
Ese es el `ALLOWED_TELEGRAM_ID` (así el bot solo te responde a vos).

### 3. Crear cuenta en Cloudinary
[cloudinary.com](https://cloudinary.com) → plan gratis. En el Dashboard vas a ver:
- **Cloud name** → `CLOUDINARY_CLOUD_NAME`
- **API Key** → `CLOUDINARY_API_KEY`
- **API Secret** → `CLOUDINARY_API_SECRET` (click en el ojito para verlo)

### 4. Generar un token de GitHub
En [github.com/settings/tokens](https://github.com/settings/tokens) → "Fine-grained tokens" → "Generate new token":
- **Repository access**: Only select repositories → `Azerian126/Cantbelievetheview`
- **Permissions** → Repository permissions → **Contents: Read and write**
- Generá y guardá el token → `GITHUB_TOKEN`

### 5. Subir este proyecto a GitHub
Igual que hicimos con el sitio: creá un repo vacío en GitHub (ej. `cantbelievetheview-bot`),
y desde esta carpeta:
```bash
git init
git add -A
git commit -m "Bot inicial"
git branch -M main
git remote add origin https://github.com/Azerian126/cantbelievetheview-bot.git
git push -u origin main
```

### 6. Deployar en Vercel
[vercel.com](https://vercel.com) → **Add New Project** → importá el repo `cantbelievetheview-bot`.
No hace falta tocar nada del build (Vercel detecta `api/*.js` solo).

Antes de darle "Deploy", o después en **Project Settings → Environment Variables**,
cargá todas las variables de `.env.example` (menos `KV_REST_API_URL`/`KV_REST_API_TOKEN`,
esas las agrega Vercel solo en el paso siguiente).

### 7. Conectar Upstash Redis (memoria de la conversación)
Dentro del proyecto en Vercel → pestaña **Storage** → **Create Database** → **Upstash
for Redis** (plan gratis) → conectalo a este proyecto. Vercel agrega `KV_REST_API_URL`
y `KV_REST_API_TOKEN` solo — no hace falta copiarlas a mano. Volvé a deployar (Vercel
te lo va a pedir) para que las tome.

### 8. Activar el webhook de Telegram
Una vez deployado, Vercel te da una URL tipo `cantbelievetheview-bot.vercel.app`.
Corré (con tu token real, en tu terminal — nunca lo pegues en el chat):
```bash
curl "https://api.telegram.org/bot<TU_TOKEN>/setWebhook?url=https://<TU-PROYECTO>.vercel.app/api/webhook"
```
Debería responder `{"ok":true,"result":true,...}`.

### 9. Probarlo
Abrí una conversación con tu bot en Telegram, mandale `/start`, después mandale una foto.

## Variables de entorno — resumen

| Variable | De dónde sale |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather |
| `ALLOWED_TELEGRAM_ID` | @userinfobot |
| `GITHUB_OWNER` | `Azerian126` |
| `GITHUB_REPO` | `Cantbelievetheview` |
| `GITHUB_BRANCH` | `main` |
| `GITHUB_TOKEN` | github.com/settings/tokens (fine-grained, Contents: Read and write) |
| `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | Dashboard de Cloudinary |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | Las agrega Vercel al conectar Upstash (Storage tab) |

## Si algo se traba

- **El bot no responde nada**: revisá que el webhook esté seteado (`scripts/set-webhook.js`)
  y que las env vars estén cargadas en Vercel (Project Settings → Environment Variables →
  redeployá después de cambiarlas).
- **"Este bot es privado"**: tu `ALLOWED_TELEGRAM_ID` no coincide con tu ID real de Telegram.
- **Falla al subir a Cloudinary**: revisá `CLOUDINARY_API_SECRET` (es el que más se tipea mal).
- **Falla el commit a GitHub**: el token no tiene permiso de escritura sobre el repo, o expiró.
- **Querés frenar el bot de golpe**: `node scripts/delete-webhook.js` (con `TELEGRAM_BOT_TOKEN`
  en el entorno) — deja de recibir mensajes hasta que vuelvas a correr `set-webhook.js`.
