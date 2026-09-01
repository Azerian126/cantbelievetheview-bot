// Lista de botones de categorías del sitio. Se usa en dos momentos:
// 1) cuando la foto no tiene país (ej. Modelos) — hay que elegir una.
// 2) como tag opcional para una foto que SÍ tiene país (ver categoryTagMenu).
function categoryMenu(siteData) {
  const rows = siteData.categories.map((cat) => [{ text: cat.name, callback_data: `sel:g:${cat.key}` }]);
  rows.push([{ text: '✖️ Cancelar', callback_data: 'cancel' }]);
  return { inline_keyboard: rows };
}

/** Se pregunta después de elegir país: casi toda foto de un país puede ADEMÁS
 *  pertenecer a una categoría temática del sitio (Blanco y Negro, Retratos,
 *  Paisajes, Edificios...) — no es alternativa a tener país, es un tag extra.
 *  "Sin categoría" es válido y probablemente lo más común.
 *  `prefix` deja reusar el mismo menú desde /editar sin chocar callback_data
 *  con el flujo normal de subida (ver 'editcat' en api/webhook.js). */
function categoryTagMenu(siteData, prefix = 'tag') {
  const rows = siteData.categories.map((cat) => [{ text: cat.name, callback_data: `${prefix}:g:${cat.key}` }]);
  rows.push([{ text: '🚫 Sin categoría temática', callback_data: `${prefix}:none` }]);
  // Una foto puede estar en varias categorías, pero el caso normal es UNA:
  // tocarla ahí arriba elige y sigue, exactamente como siempre. Este botón
  // es la puerta a la selección múltiple, y solo la paga quien la usa —
  // subir es el cuello de botella del proyecto, no se le agrega un toque
  // a las fotos de todos los días para servir al caso raro.
  rows.push([{ text: '➕ Varias categorías', callback_data: `${prefix}:multi` }]);
  return { inline_keyboard: rows };
}

/** Selección múltiple: cada fila alterna una categoría (marcada ✅ o ▫️) y
 *  "Listo" cierra. `selected` es el array de keys ya elegidas. Cerrar sin
 *  ninguna marcada equivale a "sin categoría temática" — no hace falta un
 *  botón aparte para eso. */
function categoryMultiMenu(siteData, selected = [], prefix = 'tag') {
  const rows = siteData.categories.map((cat) => [
    {
      text: `${selected.includes(cat.key) ? '✅' : '▫️'} ${cat.name}`,
      callback_data: `${prefix}:t:${cat.key}`,
    },
  ]);
  rows.push([{ text: `✅ Listo (${selected.length})`, callback_data: `${prefix}:done` }]);
  return { inline_keyboard: rows };
}

module.exports = { categoryMenu, categoryTagMenu, categoryMultiMenu };
