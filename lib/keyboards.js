const PAGE_SIZE = 8;

const mainMenu = {
  inline_keyboard: [
    [{ text: '🌍 Es de un país', callback_data: 'menu:country:0' }],
    [{ text: '🖼 Es de una categoría', callback_data: 'menu:category' }],
    [{ text: '✖️ Cancelar', callback_data: 'cancel' }],
  ],
};

/** Lista todos los países (con y sin galería) ordenados alfabéticamente,
 *  paginada de a PAGE_SIZE. 🟡 = ya tiene galería (se le suma una foto más).
 *  ⚪ = todavía no tiene fotos (esta sería su primera → pasa a tener galería). */
function countryPage(siteData, page) {
  const all = [
    ...siteData.visited.map((c) => ({ key: c.key, name: c.name, mark: '🟡' })),
    ...siteData.visitedEmpty.map((c) => ({ key: c.key, name: c.name, mark: '⚪' })),
  ].sort((a, b) => a.name.localeCompare(b.name, 'es'));

  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const slice = all.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const rows = slice.map((c) => [{ text: `${c.mark} ${c.name}`, callback_data: `sel:c:${c.key}` }]);

  const nav = [];
  if (safePage > 0) nav.push({ text: '⬅️', callback_data: `menu:country:${safePage - 1}` });
  nav.push({ text: `${safePage + 1}/${totalPages}`, callback_data: 'noop' });
  if (safePage < totalPages - 1) nav.push({ text: '➡️', callback_data: `menu:country:${safePage + 1}` });
  rows.push(nav);
  rows.push([{ text: '🔙 Volver', callback_data: 'menu:main' }, { text: '✖️ Cancelar', callback_data: 'cancel' }]);

  return { inline_keyboard: rows };
}

function categoryMenu(siteData) {
  const rows = siteData.categories.map((cat) => [{ text: cat.name, callback_data: `sel:g:${cat.key}` }]);
  rows.push([{ text: '🔙 Volver', callback_data: 'menu:main' }, { text: '✖️ Cancelar', callback_data: 'cancel' }]);
  return { inline_keyboard: rows };
}

module.exports = { mainMenu, countryPage, categoryMenu, PAGE_SIZE };
