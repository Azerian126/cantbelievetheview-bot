const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');
const sharp = require('sharp');
const { prepararParaImprimir, MATERIALES } = require('./printPrep');

// Cloudinary rechaza cualquier imagen que pase de 10 MiB en esta cuenta, y lo
// hace con un error seco que al usuario le llega como "Algo falló": la foto no
// se publica y no hay más explicación. Le pasó a Mario con una de 17,48 MB.
//
// El tope es del plan, no del código: subirlo de verdad cuesta dinero. Pero no
// hace falta, porque lo que llena esos megas es la COMPRESIÓN del JPEG, no la
// cantidad de píxeles — y lo que decide hasta qué tamaño se puede imprimir una
// foto son los píxeles (ver sizeFitsPhoto en sitio/index.html). Reencodando a
// una calidad alta el archivo baja a menos de la mitad, la resolución queda
// intacta y el catálogo de impresión de esa foto no pierde ni un tamaño.
const TOPE_CLOUDINARY = 10 * 1024 * 1024;
const MARGEN = 128 * 1024; // aire para la envoltura de la petición

/** Devuelve el buffer tal cual si ya entra; si no, lo reencoda bajando calidad
 *  hasta que quepa, SIN tocar los píxeles. Solo si ni a calidad 75 entra —una
 *  foto enorme de verdad— reduce el lado largo, y eso se avisa fuerte porque
 *  es lo único que sí le recorta tamaños de impresión a esa foto. */
async function encajarEnElTope(buffer, etiqueta) {
  const limite = TOPE_CLOUDINARY - MARGEN;
  if (buffer.length <= limite) return buffer;

  const meta = await sharp(buffer).metadata();
  for (const quality of [95, 92, 88, 84, 80, 75]) {
    const salida = await sharp(buffer)
      .jpeg({ quality, chromaSubsampling: '4:4:4' })
      .withMetadata()
      .toBuffer();
    if (salida.length <= limite) {
      console.log(
        `[cloudinary] ${etiqueta}: ${(buffer.length / 1e6).toFixed(2)}MB no entraba en el tope de 10 MiB; ` +
        `reencodada a calidad ${quality} -> ${(salida.length / 1e6).toFixed(2)}MB. ` +
        `Resolución intacta: ${meta.width}x${meta.height}px.`
      );
      return salida;
    }
  }

  // Último recurso: reducir píxeles. Se hace en bucle y no de una pasada,
  // porque un solo recorte del 20% no garantiza nada — con una foto muy grande
  // se devolvía un archivo que seguía sin entrar y Cloudinary lo rechazaba
  // igual, que es exactamente el fallo que se venía a arreglar.
  // El primer salto se calcula: el peso de un JPEG va con la cantidad de
  // píxeles, así que la escala que hace falta ronda la raíz de lo que sobra.
  const ladoLargo = Math.max(meta.width, meta.height);
  let salida = null;
  let escala = Math.min(0.9, Math.sqrt(limite / buffer.length));
  for (let intento = 0; intento < 6 && escala > 0.2; intento++) {
    const lado = Math.max(640, Math.round(ladoLargo * escala));
    salida = await sharp(buffer)
      .resize({
        ...(meta.width >= meta.height ? { width: lado } : { height: lado }),
        withoutEnlargement: true,
      })
      .jpeg({ quality: 88, chromaSubsampling: '4:4:4' })
      .withMetadata()
      .toBuffer();
    if (salida.length <= limite) {
      const m = await sharp(salida).metadata();
      console.warn(
        `[ALERTA] ${etiqueta}: ni a calidad 75 entraba en el tope. Se redujo de ` +
        `${meta.width}x${meta.height} a ${m.width}x${m.height} -> ${(salida.length / 1e6).toFixed(2)}MB. ` +
        `ESTA FOTO PIERDE LOS TAMAÑOS DE IMPRESIÓN MÁS GRANDES.`
      );
      return salida;
    }
    escala *= 0.8;
  }
  // Si ni así entra, se devuelve lo último y que falle arriba con su mensaje:
  // mejor un error claro de Cloudinary que un cuelgue silencioso acá.
  console.error(`[ALERTA] ${etiqueta}: no se pudo bajar del tope ni reduciendo seis veces.`);
  return salida || buffer;
}

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
  buffer = await encajarEnElTope(buffer, publicIdHint);
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
  // Telegram una segunda vez. width/height son las dimensiones reales del
  // archivo tal cual se subió (Cloudinary las mide al recibirlo, antes de
  // cualquier transformación) — de ahí sale qué tamaños de impresión puede
  // ofrecer el sitio para esta foto (ver sitio/index.html, sizeFitsPhoto).
  return {
    cleanUrl: uploaded.secure_url,
    displayUrl,
    publicId: uploaded.public_id,
    hash: hashBuffer(buffer),
    buffer,
    width: uploaded.width,
    height: uploaded.height,
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

module.exports = { uploadFromUrl, uploadPrintDerivatives, downloadBuffer, hashBuffer, encajarEnElTope };
