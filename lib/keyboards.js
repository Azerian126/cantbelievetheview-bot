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
 *  "Sin categoría" es válido y probablemente lo más común. */
function categoryTagMenu(siteData) {
  const rows = siteData.categories.map((cat) => [{ text: cat.name, callback_data: `tag:g:${cat.key}` }]);
  rows.push([{ text: '🚫 Sin categoría temática', callback_data: 'tag:none' }]);
  return { inline_keyboard: rows };
}

module.exports = { categoryMenu, categoryTagMenu };
