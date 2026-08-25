const cloudinary = require('cloudinary').v2;

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

/** Descarga la foto desde la URL temporal de Telegram y la sube a Cloudinary.
 *  Devuelve { cleanUrl, displayUrl, publicId } — cleanUrl es el archivo tal
 *  cual (sin marca de agua, para imprimir/entregar después de pagar),
 *  displayUrl es la versión pública con marca de agua (la que va a
 *  data.json, para mostrar gratis en el sitio). */
async function uploadFromUrl(telegramFileUrl, publicIdHint) {
  const res = await fetch(telegramFileUrl);
  if (!res.ok) throw new Error('No pude descargar la foto de Telegram: ' + res.status);
  const buffer = Buffer.from(await res.arrayBuffer());
  const base64 = `data:image/jpeg;base64,${buffer.toString('base64')}`;

  const uploaded = await cloudinary.uploader.upload(base64, {
    folder: 'cantbelievetheview',
    public_id: publicIdHint,
    overwrite: false,
    unique_filename: true,
  });

  const displayUrl = cloudinary.url(uploaded.public_id, {
    secure: true,
    transformation: DISPLAY_TRANSFORMATION,
  });

  return { cleanUrl: uploaded.secure_url, displayUrl, publicId: uploaded.public_id };
}

module.exports = { uploadFromUrl };
