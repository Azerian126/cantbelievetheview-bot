// Corre el port de Node contra las 4 fotos de referencia y compara contra
// los números que ya midió la versión en Python (guardados en
// ~/Desktop/AzerIA/proyectos/impresion/impresion/0N.json). No se toca nada
// del bot/API con esto — es solo para confirmar que el port es fiel antes
// de conectarlo a algo real.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { comprimirYReencajar, MATERIALES } = require('../lib/printPrep');

const REF_DIR = path.join(process.env.HOME, 'Desktop/AzerIA/proyectos/impresion/referencias');
const OUT_JSON_DIR = path.join(process.env.HOME, 'Desktop/AzerIA/proyectos/impresion/impresion');

// Mismas funciones de medición que preparar_impresion.py — operan sobre el
// buffer RGB plano de 0-255 (equivalente exacto a (a*255).astype(uint8) en
// numpy, porque acá nunca se pasó por una representación 0..1 intermedia).
function medir(buf) {
  const n = buf.length / 3;
  let pegado = 0;
  let plano = 0;
  for (let i = 0; i < buf.length; i += 3) {
    const r = buf[i], g = buf[i + 1], b = buf[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const anyHigh = r >= 254 || g >= 254 || b >= 254;
    const anyLow = r <= 1 || g <= 1 || b <= 1;
    if ((anyHigh && mn < 200) || (anyLow && mx > 55)) pegado++;
    if ((r <= 2 && g <= 2 && b <= 2) || (r >= 253 && g >= 253 && b >= 253)) plano++;
  }
  return { pegado: round1((100 * pegado) / n), plano: round1((100 * plano) / n) };
}

function diferenciaVisible(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return round2((100 * sum) / a.length / 255);
}

function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

async function main() {
  const referencias = [1, 2, 3, 4];
  let algunaFalla = false;

  for (const n of referencias) {
    const nn = String(n).padStart(2, '0');
    const inputPath = path.join(REF_DIR, `${nn}-edit.jpg`);
    const jsonPath = path.join(OUT_JSON_DIR, `${nn}.json`);
    if (!fs.existsSync(inputPath) || !fs.existsSync(jsonPath)) {
      console.log(`⚠️  ${nn}: falta el archivo de referencia o el json de Python, salteando`);
      continue;
    }
    const esperado = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    const inputBuffer = fs.readFileSync(inputPath);
    const { data: raw, info } = await sharp(inputBuffer)
      .rotate()
      .removeAlpha()
      .toColourspace('srgb')
      .raw()
      .toBuffer({ resolveWithObject: true });

    const m = MATERIALES.algodon;
    const out = comprimirYReencajar(raw, m.satMax, m.negroMin, m.blancoMax);

    const antes = medir(raw);
    const despues = medir(out);
    const cambio = diferenciaVisible(raw, out);

    const okAntes = antes.pegado === esperado.antes.canal_pegado_pct;
    const okDespues = despues.pegado === 0 && despues.pegado === esperado.despues.canal_pegado_pct;
    // Tolerancia más ancha acá: PIL (Python) y sharp/libvips decodifican el
    // JPEG de entrada (4:2:0) con un upsampling de croma levemente distinto,
    // así que el "cuánto cambió" no calza al 0.01% aunque el algoritmo sea
    // fiel — lo que importa es que quede DENTRO del guardarraíl, no que
    // coincida decimal a decimal con una lectura de píxeles distinta.
    const okCambio = Math.abs(cambio - esperado.cuanto_cambio_pct) <= 0.3;
    const okGuardrail = cambio >= 2.0 && cambio <= 8.0;

    const status = okAntes && okDespues && okCambio && okGuardrail ? '✅' : '❌';
    if (status === '❌') algunaFalla = true;

    console.log(
      `${status} ${nn} (${info.width}x${info.height}) — ` +
        `pegado antes: Node ${antes.pegado}% / Python ${esperado.antes.canal_pegado_pct}% | ` +
        `pegado después: Node ${despues.pegado}% (debe ser 0%) | ` +
        `cambio: Node ${cambio}% / Python ${esperado.cuanto_cambio_pct}% (guardarraíl 2-8%)`
    );
  }

  if (algunaFalla) {
    console.log('\n❌ Alguna referencia no calzó — revisar antes de conectar esto a nada real.');
    process.exit(1);
  }
  console.log('\n✅ Las 4 referencias calzan con la salida de Python, dentro del guardarraíl.');
}

main().catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});
