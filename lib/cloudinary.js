const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');
const { prepararParaImprimir, MATERIALES } = require('./printPrep');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// La versión que se ve gratis en el sitio: más chica, calidad más baja, y
// con el nombre del sitio superpuesto — así la "compra digital" entrega
// algo que de verdad no tenías antes. El archivo limpio (cleanUrl) nunca
// se guarda en data.json (es público) — lo guarda aparte quien nos llama.
const DISPLAY_TRANSFORMATION = [
  { width: 1400, crop: 'limit', quality: 'auto:eco', fetch_format: 'auto' },
  {
    overlay: { font_family: 'Arial', font_size: 60, font_weight: 'bold', text: 'cantbelievetheview.com' },
    color: 'white',
    opacity: 30,
    gravity: 'center',
    angle: -30,
  },
];

async function downloadBuffer(telegramFileUrl) {
  const res = await fetch(telegramFileUrl);
  if (!res.ok) throw new Error('No pude descargar la foto de Telegram: ' + res.status);
  return Buffer.from(await res.arrayBuffer());
}

// Hash del contenido del archivo — sirve para detectar si esta misma foto
// (mismo binario) ya se subió antes, sin importar cuándo ni a qué país.
function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Descarga la foto desde la URL temporal de Telegram y la sube a Cloudinary.
 *  Devuelve { cleanUrl, displayUrl, publicId, hash } — cleanUrl es el archivo
 *  tal cual (sin marca de agua, para imprimir/entregar después de pagar),
 *  displayUrl es la versión pública con marca de agua (la que va a
 *  data.json, para mostrar gratis en el sitio), hash es el sha256 del
 *  archivo (para detección de duplicados, ver lib/photoStore.js). */
async function uploadBufferToCloudinary(buffer, publicIdHint) {
  const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;
  return cloudinary.uploader.upload(base64, {
    folder: 'cantbelievetheview',
    public_id: publicIdHint,
    overwrite: false,
    unique_filename: true,
  });
}

async function uploadFromUrl(telegramFileUrl, publicIdHint) {
  const buffer = await downloadBuffer(telegramFileUrl);
  const uploaded = await uploadBufferToCloudinary(buffer, publicIdHint);

  const displayUrl = cloudinary.url(uploaded.public_id, {
    secure: true,
    transformation: DISPLAY_TRANSFORMATION,
  });

  // Se devuelve también el buffer original (sin marca de agua, sin ninguna
  // transformación) — quien llama lo reusa para generar las derivadas de
  // impresión (ver uploadPrintDerivatives) sin tener que descargarlo de
  // Telegram una segunda vez.
  return {
    cleanUrl: uploaded.secure_url,
    displayUrl,
    publicId: uploaded.public_id,
    hash: hashBuffer(buffer),
    buffer,
  };
}

/** Genera y sube UNA derivada de impresión por material (ver
 *  lib/printPrep.js — comprime la saturación y reencaja el rango tonal al
 *  límite real de cada material) a partir del buffer YA DESCARGADO de la
 *  foto original — nunca desde displayUrl, que tiene marca de agua y menos
 *  resolución. Si alguna falla, no bloquea la subida: se loguea y esa
 *  derivada en particular simplemente no existe — el backend de checkout
 *  cae a la foto limpia sin preparar al armar el pedido a Prodigi. */
async function uploadPrintDerivatives(buffer, publicIdHint) {
  const urls = {};
  for (const material of Object.keys(MATERIALES)) {
    try {
      const prepared = await prepararParaImprimir(buffer, material);
      const uploaded = await uploadBufferToCloudinary(prepared, `${publicIdHint}-${material}`);
      urls[material] = uploaded.secure_url;
    } catch (err) {
      console.error(
        `[ALERTA] No pude preparar/subir la derivada de impresión (${material}) para ${publicIdHint}:`,
        err.message
      );
    }
  }
  return urls;
}

module.exports = { uploadFromUrl, uploadPrintDerivatives, downloadBuffer, hashBuffer };
