// Achica la foto antes de mandársela a la IA que la va a mirar.
//
// El bot le pasaba a xAI la URL de Telegram del ARCHIVO ORIGINAL — en una foto
// de 13MB, eso es 13MB que xAI tiene que descargar y decodificar antes de
// empezar a escribir seis palabras. Para describir una imagen no hace falta
// resolución de impresión: con mil píxeles de lado largo se ve todo lo que hay
// que ver.
//
// Esto NO toca la foto que se publica ni las derivadas de impresión: es una
// copia de usar y tirar que solo existe durante la llamada a la IA.
const sharp = require('sharp');

const LADO_MAXIMO = 1000;

/** Devuelve un data URL con la foto achicada, o null si algo falla — quien
 *  llama se queda entonces con la URL original, que es lo que hacía siempre. */
async function shrinkForVision(buffer) {
  const small = await sharp(buffer)
    // .rotate() sin argumentos aplica la orientación del EXIF: sin esto, una
    // foto vertical de teléfono llega acostada y la IA la describe acostada.
    .rotate()
    .resize({ width: LADO_MAXIMO, height: LADO_MAXIMO, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  return { dataUrl: 'data:image/jpeg;base64,' + small.toString('base64'), bytes: small.length };
}

module.exports = { shrinkForVision, LADO_MAXIMO };
