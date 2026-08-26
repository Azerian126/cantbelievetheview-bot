// Prepara una foto YA EDITADA para imprimir en papel — comprime la saturación
// SOLO donde se pasa de lo que el material puede reproducir (deja intacto lo
// que ya cabía; un desaturado global apagaría toda la foto para arreglar el
// pedazo que sobra) y reencaja el rango tonal al límite real de negro/blanco
// de ese material. No cambia el estilo, no re-edita, no re-encuadra.
//
// Portado de ~/.claude/skills/impresion/motor/preparar_impresion.py — las
// constantes por material salieron de medir fotos reales de Mario, no se
// eligieron a ojo. No tocarlas sin volver a medir.
//
// Por qué hace falta: Mario edita en pantalla (OLED, emite luz) y vende
// impresiones (papel, refleja luz) — un color que se ve perfecto en pantalla
// puede no existir en tinta. Sin esto, esa zona se imprime como una mancha
// plana de un solo tono en vez del detalle real que Mario editó.
const sharp = require('sharp');

const MATERIALES = {
  algodon: { satMax: 0.72, negroMin: 0.055, blancoMax: 0.965 },
  aluminio: { satMax: 0.86, negroMin: 0.022, blancoMax: 0.985 },
};

// Por debajo de rodilla*satMax no se toca nada — la compresión arranca ahí y
// aprieta hasta que el máximo posible aterriza justo en satMax.
const RODILLA = 0.75;

/** Aplica la compresión de saturación + el reencaje de rango tonal sobre un
 *  buffer RGB plano (3 bytes por píxel, 0-255). Devuelve un buffer nuevo del
 *  mismo tamaño. Toda la aritmética es en 0..1, como el original en Python;
 *  la cuantización final trunca (no redondea) para calzar con
 *  `(out*255).astype(np.uint8)` de numpy. */
function comprimirYReencajar(raw, satMax, negroMin, blancoMax) {
  const out = Buffer.alloc(raw.length);
  const inicio = RODILLA * satMax;
  const rango = Math.max(1e-6, 1 - inicio);
  const escala = blancoMax - negroMin;

  for (let i = 0; i < raw.length; i += 3) {
    const r = raw[i] / 255;
    const g = raw[i + 1] / 255;
    const b = raw[i + 2] / 255;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const dr = r - l;
    const dg = g - l;
    const db = b - l;
    const s = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db)) * 2;

    let factor = 1;
    if (s > inicio) {
      const exceso = Math.min(1, Math.max(0, (s - inicio) / rango));
      const sNueva = inicio + (satMax - inicio) * (1 - (1 - exceso) ** 2);
      factor = sNueva / Math.max(s, 1e-6);
    }

    let nr = clamp01(l + dr * factor);
    let ng = clamp01(l + dg * factor);
    let nb = clamp01(l + db * factor);

    // reencaje del rango tonal — después de la saturación, como en Python
    nr = clamp01(nr * escala + negroMin);
    ng = clamp01(ng * escala + negroMin);
    nb = clamp01(nb * escala + negroMin);

    out[i] = Math.floor(nr * 255);
    out[i + 1] = Math.floor(ng * 255);
    out[i + 2] = Math.floor(nb * 255);
  }
  return out;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Recibe el Buffer de una foto ya editada (cualquier formato que sharp lea)
 *  y devuelve un Buffer JPEG listo para imprimir en el material indicado —
 *  calidad 97, sin submuestreo de croma (perdería justo el color que se está
 *  tratando de conservar), 300dpi. Aplica la rotación EXIF antes de tocar
 *  nada (las fotos de iPhone vienen tumbadas con esa etiqueta). */
async function prepararParaImprimir(inputBuffer, material) {
  const m = MATERIALES[material];
  if (!m) throw new Error(`Material desconocido para impresión: ${material}`);

  const { data, info } = await sharp(inputBuffer)
    .rotate() // sin argumentos: aplica la orientación EXIF y la deja limpia
    .removeAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(`Esperaba 3 canales RGB preparando para imprimir, llegaron ${info.channels}`);
  }

  const out = comprimirYReencajar(data, m.satMax, m.negroMin, m.blancoMax);

  return sharp(out, { raw: { width: info.width, height: info.height, channels: 3 } })
    .jpeg({ quality: 97, chromaSubsampling: '4:4:4' })
    .withMetadata({ density: 300 })
    .toBuffer();
}

module.exports = { prepararParaImprimir, comprimirYReencajar, MATERIALES };
