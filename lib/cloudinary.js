const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/** Descarga la foto desde la URL temporal de Telegram y la sube a Cloudinary.
 *  Devuelve la URL pública (https) que va a quedar guardada en data.json. */
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
  return uploaded.secure_url;
}

module.exports = { uploadFromUrl };
