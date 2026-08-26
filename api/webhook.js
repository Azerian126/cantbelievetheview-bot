const { Telegraf, Markup } = require('telegraf');
const { getSession, setSession, clearSession } = require('../lib/session');
const { categoryMenu, categoryTagMenu } = require('../lib/keyboards');
const { getSiteData, commitSiteData } = require('../lib/github');
const { uploadFromUrl, uploadPrintDerivatives, downloadBuffer, hashBuffer } = require('../lib/cloudinary');
const {
  saveCleanUrl,
  savePrintUrls,
  findByHash,
  saveHash,
  deleteHash,
  saveLastUpload,
  getLastUpload,
  clearLastUpload,
  resetAllPhotoKeys,
} = require('../lib/photoStore');
const { normalize, findCountryMatches, findCategoryMatch } = require('../lib/matchText');
const { geocodePlaces } = require('../lib/geocode');
const { suggestDescriptions, suggestCountryIntro, translateToEnglish } = require('../lib/grokText');
const { getRemainingCredits } = require('../lib/xaiBilling');

// webhookReply:false — por default Telegraf manda la PRIMERA respuesta
// saliente de cada update (acá, el editMessageText de la confirmación)
// empaquetada en el body de la respuesta HTTP del webhook, en vez de como
// llamada real a la API de Telegram. En Vercel, apenas esa respuesta HTTP
// se cierra, la ejecución se corta — así que todo lo que viene después en el
// mismo handler (subir a Cloudinary, commitear a GitHub, en finalize())
// quedaba truncado a mitad de camino, sin tirar ningún error. Con esto,
// todas las llamadas salen por HTTP real y el handler no termina hasta que
// awaitemos todo, como corresponde.
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { telegram: { webhookReply: false } });
const ALLOWED_ID = String(process.env.ALLOWED_TELEGRAM_ID || '');

// Le avisa a Telegram cuáles son los comandos — así aparecen con
// autocompletado en el botón "/" del cliente, en vez de tener que
// acordarte de memoria cuáles existen. Se llama en cada cold start del
// runtime de Vercel; es idempotente (Telegram simplemente reemplaza la
// lista con la misma), así que no hace falta un script aparte.
bot.telegram
  .setMyCommands([
    { command: 'start', description: 'Cómo funciona el bot' },
    { command: 'back', description: 'Volver un paso atrás' },
    { command: 'cancel', description: 'Cancelar todo' },
    { command: 'undo', description: 'Deshacer la última subida' },
    { command: 'editar', description: 'Editar una foto ya publicada' },
    { command: 'recientes', description: 'Últimas fotos subidas' },
    { command: 'progreso', description: 'Resumen de países y categorías' },
    { command: 'creditos', description: 'Saldo restante en xAI' },
    { command: 'resetcontent', description: 'Borrar en Redis restos de fotos ya eliminadas' },
  ])
  .catch((err) => console.error('No pude registrar los comandos en Telegram:', err));

// Frases que dicen "esta foto no tiene país" (ej. Modelos) — todo normalizado
// (sin acentos, minúscula) porque se compara contra normalize(texto del usuario).
const NO_COUNTRY_WORDS = ['sin ubicacion', 'ninguno', 'ninguna', 'no', 'n/a', 'na'];

// Teclado nativo de Telegram para compartir ubicación con un toque — así la
// coordenada que queda en data.json es la real (la del GPS de tu teléfono al
// sacar la foto, o la que elijas a mano en el mapa), no una inventada.
const locationKeyboard = Markup.keyboard([
  [Markup.button.locationRequest('📍 Compartir ubicación')],
  ['Sin ubicación'],
]).resize().oneTime();

// --- seguridad: solo Mario puede usar este bot -----------------------------
bot.use(async (ctx, next) => {
  const fromId = String(ctx.from && ctx.from.id);
  if (!ALLOWED_ID || fromId !== ALLOWED_ID) {
    if (ctx.chat) await ctx.reply('Este bot es privado.').catch(() => {});
    return;
  }
  return next();
});

bot.start((ctx) =>
  ctx.reply(
    'Mandame una foto (o varias juntas) y te pregunto de qué país es (o "sin ubicación" si no aplica, ' +
      'ej. Modelos). En un rato queda publicada en cantbelievetheview.com.\n\n' +
      '📎 Para que quede lista para imprimir en tamaños grandes, mandala como ARCHIVO (clip 📎 → "Archivo"/"File"), ' +
      'no como foto normal — Telegram comprime toda foto normal a ~1280px sin avisar, sin importar el original.\n\n' +
      'En cualquier momento: /back para volver un paso atrás, /cancel para cortar todo.\n' +
      '/undo deshace la última subida. /editar corrige cualquier foto ya publicada. ' +
      '/recientes y /progreso muestran cómo va el sitio. /creditos muestra el saldo en xAI.'
  )
);

// Cancela desde CUALQUIER paso del proceso, no solo desde las pantallas con
// botones — antes /cancel no estaba registrado como comando, así que
// Telegram lo mandaba como texto plano y el bot lo procesaba como
// respuesta a lo que estuviera preguntando en ese momento (una vez terminó
// buscando "cancel" como si fuera el nombre de un lugar).
bot.command('cancel', async (ctx) => {
  await clearSession(ctx.chat.id);
  return ctx.reply('Cancelado. Mandame otra foto cuando quieras.', Markup.removeKeyboard());
});

// El id de cada foto es "<key>-<timestamp>[-<índice>]" (ver finalize) — de
// ahí se puede sacar cuándo se subió sin necesitar guardar una fecha aparte.
function timestampFromPhotoId(id) {
  const m = id.match(/-(\d{10,})(?:-\d+)?$/);
  return m ? parseInt(m[1], 10) : 0;
}

bot.command('recientes', async (ctx) => {
  const { json: siteData } = await getSiteData();
  const all = [];
  siteData.visited.forEach((c) => (c.photos || []).forEach((p) => all.push({ ...p, place: c.name })));
  siteData.categories.forEach((cat) => (cat.photos || []).forEach((p) => all.push({ ...p, place: cat.name })));
  all.sort((a, b) => timestampFromPhotoId(b.id) - timestampFromPhotoId(a.id));

  if (!all.length) return ctx.reply('Todavía no hay ninguna foto subida.');

  const lines = all.slice(0, 8).map((p) => `• "${p.caption}" — ${p.place}`);
  return ctx.reply(`Últimas ${lines.length} fotos:\n\n` + lines.join('\n'));
});

bot.command('progreso', async (ctx) => {
  const { json: siteData } = await getSiteData();
  const withPhotos = siteData.visited.filter((c) => (c.photos || []).length > 0);
  const totalCountryPhotos = siteData.visited.reduce((n, c) => n + (c.photos || []).length, 0);

  // Una categoría suma sus fotos propias (ej. Modelos, sin país) + las de
  // países que la tengan tageada (categoryKey) — mismo criterio que
  // photosForCategory() en el sitio, para que el número coincida con lo
  // que realmente se ve en la galería de esa categoría.
  const catLines = siteData.categories.map((cat) => {
    const own = (cat.photos || []).length;
    const tagged = siteData.visited.reduce(
      (n, c) => n + (c.photos || []).filter((p) => p.categoryKey === cat.key).length,
      0
    );
    return `  • ${cat.name}: ${own + tagged}`;
  });

  const lines = [
    `🌍 Países con fotos: ${withPhotos.length} / ${siteData.visited.length + siteData.visitedEmpty.length}`,
    `📸 Fotos totales: ${totalCountryPhotos}`,
    '',
    'Por categoría:',
    ...catLines,
  ];
  return ctx.reply(lines.join('\n'));
});

// Saldo prepago de xAI — necesita XAI_MANAGEMENT_KEY y XAI_TEAM_ID cargados
// aparte (no es la misma key que usa el resto del bot para generar texto).
bot.command('creditos', async (ctx) => {
  try {
    const balance = await getRemainingCredits();
    return ctx.reply(`💳 Créditos xAI restantes: $${balance.toFixed(2)}`);
  } catch (err) {
    console.error('Error consultando créditos de xAI:', err);
    return ctx.reply(
      '❌ No pude consultar el saldo — revisá que XAI_MANAGEMENT_KEY y XAI_TEAM_ID estén cargados en Vercel.\n' +
        `(${err.message})`
    );
  }
});

// Encuentra dónde vive una foto ya subida (país o categoría) — a diferencia
// de /undo, que solo conoce la última subida, esto busca cualquiera por id.
function findPhotoLocation(siteData, photoId) {
  for (const c of siteData.visited) {
    const p = (c.photos || []).find((x) => x.id === photoId);
    if (p) return { photo: p, targetType: 'country', targetKey: c.key, containerName: c.name };
  }
  for (const cat of siteData.categories) {
    const p = (cat.photos || []).find((x) => x.id === photoId);
    if (p) return { photo: p, targetType: 'category', targetKey: cat.key, containerName: cat.name };
  }
  return null;
}

// /editar — a diferencia de /undo (solo la última subida), esto deja
// corregir cualquier foto ya publicada: cambiarle el título, la categoría
// temática, o borrarla. Arranca mostrando las últimas 10 para elegir.
bot.command('editar', async (ctx) => {
  const { json: siteData } = await getSiteData();
  const all = [];
  siteData.visited.forEach((c) => (c.photos || []).forEach((p) => all.push({ ...p, place: c.name })));
  siteData.categories.forEach((cat) => (cat.photos || []).forEach((p) => all.push({ ...p, place: cat.name })));
  all.sort((a, b) => timestampFromPhotoId(b.id) - timestampFromPhotoId(a.id));

  if (!all.length) return ctx.reply('Todavía no hay ninguna foto subida.');

  const recent = all.slice(0, 10);
  const rows = recent.map((p) => [
    { text: shortenPlace(`${p.caption} — ${p.place}`, 60), callback_data: `edit:sel:${p.id}` },
  ]);
  rows.push([{ text: '✖️ Cancelar', callback_data: 'cancel' }]);
  await setSession(ctx.chat.id, { step: 'await_edit_select' });
  return ctx.reply('¿Cuál foto querés editar?', { reply_markup: { inline_keyboard: rows } });
});

// Deshace la última subida (por chat) — saca la(s) foto(s) de data.json, si
// era un país nuevo lo devuelve a "sin fotos", borra el registro de
// duplicados de esos archivos, y listo. Solo funciona sobre lo último que
// se subió (24hs de margen) — no es un historial completo de cambios.
bot.command('undo', async (ctx) => {
  const chatId = ctx.chat.id;
  const last = await getLastUpload(chatId);
  if (!last) {
    return ctx.reply('No tengo ninguna subida reciente para deshacer (o ya pasaron más de 24hs).');
  }

  try {
    const { json: siteData, sha } = await getSiteData();
    let label = '';
    let removed = 0;

    const removeFrom = (arr) => {
      const before = arr.length;
      const kept = arr.filter((p) => !last.photoIds.includes(p.id));
      removed += before - kept.length;
      return kept;
    };

    if (last.targetType === 'category') {
      const cat = siteData.categories.find((c) => c.key === last.targetKey);
      if (cat) {
        cat.photos = removeFrom(cat.photos || []);
        label = cat.name;
      }
    } else {
      // country_existing o country_new — en ambos casos, para cuando se
      // subió, el país ya vive en "visited" (country_new lo mueve ahí en
      // el momento de subir).
      const c = siteData.visited.find((x) => x.key === last.targetKey);
      if (c) {
        c.photos = removeFrom(c.photos || []);
        label = c.name;
        // Si esta subida fue la que creó el país y no le quedan fotos,
        // deshacemos también la creación — vuelve a "sin fotos".
        if (last.wasNewCountry && c.photos.length === 0) {
          siteData.visited = siteData.visited.filter((x) => x.key !== last.targetKey);
          siteData.visitedEmpty.push({ key: c.key, name: c.name, lat: c.lat, lng: c.lng, w: c.w, h: c.h });
          siteData.visitedEmpty.sort((a, b) => a.name.localeCompare(b.name, 'es'));
        }
      }
    }

    if (removed === 0) {
      return ctx.reply('No encontré esa foto en el sitio — puede que ya la hayas borrado a mano.');
    }

    await commitSiteData(siteData, sha, `↩️ Deshecho: ${removed} foto(s) de ${label}`);
    await Promise.all((last.hashes || []).map(deleteHash));
    await clearLastUpload(chatId);

    return ctx.reply(`↩️ Deshecho — se sacaron ${removed} foto(s) de ${label}.`);
  } catch (err) {
    console.error('Error deshaciendo:', err);
    return ctx.reply('❌ No pude deshacerlo: ' + err.message);
  }
});

// Reset de emergencia — borra en Redis todo lo que quedó de fotos ya
// eliminadas de data.json y de Cloudinary a mano (URLs limpias, derivadas
// de impresión, hashes de duplicados, sesiones y "último subido" a
// medias). Uso puntual, no es parte del flujo normal — de ahí la
// confirmación explícita. No toca data.json ni Cloudinary, eso se maneja
// aparte (ver backups/reset-2026-08-26.json en el repo de sitio/).
bot.command('resetcontent', async (ctx) => {
  return ctx.reply(
    '⚠️ Esto borra en Redis TODAS las claves de fotos (URLs limpias, derivadas de impresión, hashes de ' +
      'duplicados) y cualquier sesión o "último subido" a medias — de cualquier foto, no solo de una en ' +
      'particular. No toca data.json ni Cloudinary. No se puede deshacer.\n\n¿Confirmás?',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚠️ Sí, borrar todo en Redis', callback_data: 'resetcontent:confirm' }],
          [{ text: '✖️ Cancelar', callback_data: 'cancel' }],
        ],
      },
    }
  );
});

// --- 1. llega una foto -------------------------------------------------------
// Casi toda foto tiene país (es lo único que preguntamos de entrada). El caso
// sin ubicación (ej. Modelos) es la excepción, no la alternativa por defecto.
// Los nombres que devuelve Nominatim son largos ("Estambul, Fatih,
// İstanbul, Marmara Bölgesi, 34122, Türkiye") — recortamos para que entren
// bien en un botón de Telegram.
function shortenPlace(name, max = 60) {
  return name.length > max ? name.slice(0, max - 1) + '…' : name;
}

// Nota chica con lo que costó esa llamada puntual a Grok — Mario la pidió
// para no tener que ir a mirar la consola de xAI cada vez. costUsd puede
// venir null (ej. si xAI no devolvió el dato) — en ese caso no se muestra
// nada en vez de mostrar "$null".
function costNote(costUsd) {
  return costUsd != null ? `\n\n💰 $${costUsd.toFixed(3)}` : '';
}

const askCountryText =
  '¿De qué país es esta foto? Escribí el nombre (si te tipeás, lo busco igual) — o "sin ubicación" si no aplica (ej. Modelos).';

const locationPrompt =
  '¿Dónde se sacó esta foto? Tocá el botón para compartir la ubicación, escribí el nombre del lugar ' +
  '(ej. "Estambul" o "Torres Petronas") si no estás ahí parado, o mandá "Sin ubicación" si no la tenés.';

// El título SIEMPRE lo escribe Mario a mano — sin sugerencias de IA, sin
// menú. La IA solo se encarga de la descripción corta (ver askDescription).
// Con álbum, se pide un título POR FOTO (no uno solo para todo el lote) —
// session.captionIndex indica cuál toca ahora, y la foto en cuestión se
// reenvía junto con la pregunta para que quede claro de cuál se habla (con
// varias fotos juntas, "el título de la foto" a secas era ambiguo).
async function askTitle(ctx, session) {
  const chatId = ctx.chat.id;
  const idx = session.captionIndex || 0;
  const fileId = session.fileIds[idx];
  const total = session.fileIds.length;
  const label = total > 1 ? `📸 Foto ${idx + 1} de ${total}\n` : '';
  session.step = 'await_title';
  await setSession(chatId, session);
  return ctx.replyWithPhoto(fileId, { caption: `${label}¿Qué título le ponés a esta foto?` });
}

// Guarda el título tipeado y pasa a pedirle a la IA la descripción corta.
async function advanceTitle(ctx, session, title) {
  const chatId = ctx.chat.id;
  session.titles = session.titles || [];
  session.titles[session.captionIndex || 0] = title;
  await setSession(chatId, session);
  return askDescription(ctx, session);
}

// Grok mira la foto (con el título ya puesto, como contexto) y sugiere 3
// descripciones cortas — Mario elige una, pide otra tanda más corta/más
// larga, o escribe la suya. Si falla la generación (sin key, sin crédito,
// error de red), cae al modo manual en vez de trabar el flujo.
// `lengthHint` ('shorter'|'longer'|undefined) ajusta el pedido a Grok
// cuando Mario tocó "🔄 Más corta"/"🔄 Más larga" sobre la tanda anterior.
async function askDescription(ctx, session, lengthHint) {
  const chatId = ctx.chat.id;
  const idx = session.captionIndex || 0;
  const fileId = session.fileIds[idx];
  const title = session.titles[idx];

  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const { suggestions, costUsd } = await suggestDescriptions(fileLink.href, title, 3, lengthHint);
    if (!suggestions.length) throw new Error('sin sugerencias');
    session.pendingDescriptions = suggestions;
    session.aiCostUsd = (session.aiCostUsd || 0) + (costUsd || 0);
    session.step = 'await_desc_choice';
    await setSession(chatId, session);
    const rows = suggestions.map((s, i) => [{ text: s, callback_data: `desc:${i}` }]);
    rows.push([
      { text: '🔄 Más corta', callback_data: 'desc:shorter' },
      { text: '🔄 Más larga', callback_data: 'desc:longer' },
    ]);
    rows.push([{ text: '✏️ Escribir la mía', callback_data: 'desc:own' }]);
    return ctx.reply(`Elegí una descripción corta o escribí la tuya:${costNote(costUsd)}`, {
      reply_markup: { inline_keyboard: rows },
    });
  } catch (err) {
    console.error('Error generando descripciones:', err);
    session.step = 'await_desc';
    await setSession(chatId, session);
    return ctx.reply('No pude generar descripciones — mandame una descripción corta de esta foto (en español).');
  }
}

// Guarda la descripción corta elegida, arma el caption final ("Título /
// Descripción" — misma convención que ya separa el sitio en dos líneas,
// ver .photo-title/.photo-desc en index.html) y pasa a la foto siguiente
// del lote, o sigue el flujo normal si ya se completó todo.
async function advanceDescription(ctx, session, description) {
  const chatId = ctx.chat.id;
  const idx = session.captionIndex || 0;
  const title = session.titles[idx];
  session.captions = session.captions || [];
  session.captions[idx] = description ? `${title} / ${description}` : title;
  delete session.pendingDescriptions;
  session.captionIndex = idx + 1;

  if (session.captionIndex < session.fileIds.length) {
    return askTitle(ctx, session);
  }
  session.locationIndex = 0;
  return askLocation(ctx, session);
}

// Igual que askTitle/askDescription pero para la ubicación: con álbum se pregunta UNA POR
// UNA (session.locationIndex), reposteando la foto en cuestión — antes se
// preguntaba una sola vez para todo el lote y esa misma coordenada se le
// pegaba a TODAS las fotos, aunque fueran de lugares distintos dentro del
// mismo país (ej. dos monumentos distintos en Estambul).
async function askLocation(ctx, session) {
  const chatId = ctx.chat.id;
  const idx = session.locationIndex || 0;
  const fileId = session.fileIds[idx];
  const total = session.fileIds.length;
  session.step = 'await_location';
  await setSession(chatId, session);
  if (total > 1) {
    const label = `📍 Foto ${idx + 1} de ${total}\n`;
    return ctx.replyWithPhoto(fileId, { caption: `${label}${locationPrompt}`, ...locationKeyboard });
  }
  return ctx.reply(locationPrompt, locationKeyboard);
}

// Guarda la ubicación (o null, si no aplica) de la foto actual y pasa a la
// siguiente del lote — o sigue el flujo normal si ya se le preguntó a todas.
async function advanceLocation(ctx, session, loc) {
  const chatId = ctx.chat.id;
  session.locations = session.locations || [];
  session.locations[session.locationIndex || 0] = loc;
  session.locationIndex = (session.locationIndex || 0) + 1;

  if (session.locationIndex < session.fileIds.length) {
    return askLocation(ctx, session);
  }
  delete session.pendingPlaces;
  const anyLoc = session.locations.some((l) => l);
  await ctx.reply(anyLoc ? 'Ubicación guardada.' : 'Sin ubicación, seguimos.', Markup.removeKeyboard());
  return afterLocation(ctx, session);
}

// Igual que askTitle/askDescription pero para la intro de un país nuevo — no mira
// ninguna foto, solo el nombre del país.
async function askIntroChoice(ctx, session, countryName) {
  const chatId = ctx.chat.id;
  try {
    const { suggestions, costUsd } = await suggestCountryIntro(countryName, 3);
    if (!suggestions.length) throw new Error('sin sugerencias');
    session.pendingIntros = suggestions;
    session.aiCostUsd = (session.aiCostUsd || 0) + (costUsd || 0);
    session.step = 'await_intro_choice';
    await setSession(chatId, session);
    const rows = suggestions.map((s, i) => [{ text: s.es, callback_data: `intro:${i}` }]);
    rows.push([{ text: '✏️ Escribir la mía', callback_data: 'intro:own' }]);
    return ctx.reply(
      `Este país todavía no tiene galería. Elegí una intro o escribí la tuya:${costNote(costUsd)}`,
      { reply_markup: { inline_keyboard: rows } }
    );
  } catch (err) {
    console.error('Error generando intro:', err);
    session.step = 'await_desc_es';
    await setSession(chatId, session);
    return ctx.reply(
      'Este país todavía no tiene galería — necesito una descripción corta de intro, en español ' +
        '(ej: "Andes, niebla y ruinas incas al amanecer.").'
    );
  }
}

// "/back" retrocede un paso (a diferencia de "/cancel", que corta todo).
// Lo que ya habías puesto en el paso del que volvés se descarta, como en
// cualquier "atrás" — vas a tener que volver a contestarlo.
bot.command('back', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = await getSession(chatId);
  if (!session || !session.step) {
    return ctx.reply('No hay nada para retroceder — mandame una foto para empezar.');
  }

  switch (session.step) {
    case 'await_desc_choice':
    case 'await_desc':
      // Volvés a la pregunta del TÍTULO de esta misma foto — la descripción
      // que se haya sugerido/tipeado se descarta, el título se vuelve a
      // pedir (aunque sea el mismo que ya habías puesto).
      delete session.pendingDescriptions;
      return askTitle(ctx, session);

    case 'await_title': {
      const idx = session.captionIndex || 0;
      if (idx > 0) {
        // Álbum: volvés al título de la foto ANTERIOR del lote.
        session.captionIndex = idx - 1;
        if (session.captions) session.captions.pop();
        if (session.titles) session.titles.pop();
        return askTitle(ctx, session);
      }
      delete session.target;
      delete session.captions;
      delete session.titles;
      delete session.captionIndex;
      session.step = 'await_country';
      await setSession(chatId, session);
      return ctx.reply(askCountryText);
    }

    case 'await_no_country_category':
      session.step = 'await_country';
      await setSession(chatId, session);
      return ctx.reply(askCountryText);

    case 'await_location': {
      const locIdx = session.locationIndex || 0;
      if (locIdx > 0) {
        // Álbum: volvés a la ubicación de la foto ANTERIOR del lote.
        session.locationIndex = locIdx - 1;
        if (session.locations) session.locations.pop();
        return askLocation(ctx, session);
      }
      // Ya estás en la primera foto — volvés a la descripción de la última
      // foto del lote (el título de esa foto se mantiene tal cual).
      delete session.locations;
      delete session.locationIndex;
      const lastIdx = session.fileIds.length - 1;
      session.captionIndex = lastIdx;
      if (session.captions) session.captions.splice(lastIdx, 1);
      return askDescription(ctx, session);
    }

    case 'await_intro_choice':
    case 'await_desc_es': {
      delete session.descEs;
      delete session.descEn;
      delete session.pendingIntros;
      const lastIdx = session.fileIds.length - 1;
      session.locationIndex = lastIdx;
      if (session.locations) session.locations.splice(lastIdx, 1);
      return askLocation(ctx, session);
    }

    case 'await_category_tag': {
      delete session.categoryKey;
      if (session.target.type === 'country_new') {
        delete session.descEs;
        delete session.descEn;
        const { json: siteData } = await getSiteData();
        const country = siteData.visitedEmpty.find((c) => c.key === session.target.key);
        return askIntroChoice(ctx, session, country ? country.name : session.target.key);
      }
      const lastIdx1 = session.fileIds.length - 1;
      session.locationIndex = lastIdx1;
      if (session.locations) session.locations.splice(lastIdx1, 1);
      return askLocation(ctx, session);
    }

    case 'await_final_confirm':
      if (session.target.type === 'category') {
        const lastIdx2 = session.fileIds.length - 1;
        session.locationIndex = lastIdx2;
        if (session.locations) session.locations.splice(lastIdx2, 1);
        return askLocation(ctx, session);
      }
      return askCategoryTag(ctx, session);

    default:
      return ctx.reply('No puedo volver atrás desde acá — usá /cancel si querés arrancar de nuevo.');
  }
});

// Tope real de la Bot API de Telegram para descargar un archivo por
// getFile/getFileLink — arriba de esto, ni lo intentamos (tira un error
// críptico de Telegram si lo intentamos igual).
const TELEGRAM_MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const LOWRES_WARNING =
  '⚠️ Esta foto llegó comprimida por Telegram — SIEMPRE reduce a ~1280px de lado largo, ' +
  'sin importar la resolución del original. Sirve para vender copias chicas, pero en tamaños ' +
  'grandes de impresión puede no alcanzar.\n\n' +
  'Si tenés el archivo original, cancelá y reenviala como ARCHIVO en vez de foto: ' +
  'clip 📎 → "Archivo" (o "File") → elegí la foto → mandar SIN que Telegram la comprima.';

// Punto de entrada único para "ya tengo un file_id, ¿qué hago con él?" — lo
// usan tanto bot.on('photo') (siempre llega comprimida) como el manejo de
// documentos-imagen (llega tal cual el original). `compressed` decide si
// más adelante, antes de pedir el país, se avisa del límite de resolución.
async function handleIncomingFile(ctx, fileId, compressed) {
  const chatId = ctx.chat.id;
  const groupId = ctx.message.media_group_id || null;

  // Varias fotos mandadas juntas (álbum de Telegram) comparten media_group_id
  // y llegan como updates SEPARADOS, sin ningún evento de "fin de álbum" —
  // así que las vamos juntando en la sesión hasta que Mario toca "Listo".
  // Un álbum puede mezclar fotos comprimidas y archivos sueltos — si
  // CUALQUIERA de las dos llegó comprimida, se avisa al terminar de juntar.
  // (Nota: si dos fotos del mismo álbum llegan a webhooks casi simultáneos,
  // hay una ventana chica de condición de carrera al leer/escribir la
  // sesión — aceptable para un bot de un solo usuario, no se resuelve acá.)
  if (groupId) {
    const existingSession = await getSession(chatId);
    if (existingSession && existingSession.step === 'await_album_more' && existingSession.albumGroupId === groupId) {
      existingSession.fileIds.push(fileId);
      if (compressed) existingSession.hasCompressedSource = true;
      await setSession(chatId, existingSession);
      return; // no respondemos de nuevo por cada foto — spamearía el chat
    }
    await setSession(chatId, {
      step: 'await_album_more',
      albumGroupId: groupId,
      fileIds: [fileId],
      hasCompressedSource: !!compressed,
    });
    return ctx.reply(
      '📸 Detecté varias fotos juntas — te las voy juntando. Tocá "✅ Listo" cuando termines de mandarlas.',
      { reply_markup: { inline_keyboard: [[{ text: '✅ Listo, continuar', callback_data: 'album:done' }]] } }
    );
  }

  // Detección de duplicados: mismo archivo (hash) ya subido antes, sin
  // importar cuándo ni a qué país/categoría. Si falla el chequeo (ej. la
  // API de Telegram no responde) seguimos igual — no bloqueamos por esto.
  // Solo aplica a fotos sueltas — para un álbum sería un chequeo por foto,
  // se simplifica dejándolo afuera por ahora.
  let hash = null;
  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    hash = hashBuffer(await downloadBuffer(fileLink.href));
    const existing = await findByHash(hash);
    if (existing) {
      await setSession(chatId, {
        step: 'await_duplicate_confirm',
        fileIds: [fileId],
        hash,
        hasCompressedSource: !!compressed,
      });
      return ctx.reply(
        `⚠️ Esta foto ya está subida — en ${existing.label}.\n¿La subís igual (ej. para otro país o categoría) o cancelamos?`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Subir igual', callback_data: 'dup:continue' }],
              [{ text: '✖️ Cancelar', callback_data: 'cancel' }],
            ],
          },
        }
      );
    }
  } catch (err) {
    console.error('Error chequeando duplicado:', err);
  }

  const session = { step: 'await_country', fileIds: [fileId], hash, hasCompressedSource: !!compressed };
  if (compressed) return askLowresConfirm(ctx, session);
  await setSession(chatId, session);
  await ctx.reply(askCountryText);
}

// Se muestra antes de pedir el país cuando la(s) foto(s) en la sesión
// llegaron comprimidas — nunca en silencio, para que no vuelva a pasar lo
// de las 4 fotos publicadas a 960x1280 sin que nadie lo notara.
async function askLowresConfirm(ctx, session) {
  const chatId = ctx.chat.id;
  session.step = 'await_lowres_confirm';
  await setSession(chatId, session);
  return ctx.reply(LOWRES_WARNING, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Subir igual, comprimida', callback_data: 'lowres:continue' }],
        [{ text: '✖️ Cancelar, la reenvío como archivo', callback_data: 'lowres:cancel' }],
      ],
    },
  });
}

// Punto de entrada común una vez que terminó de juntar las fotos de un
// álbum (con o sin pasar antes por el aviso de baja resolución) — decide
// si hace falta preguntar "¿mismo país o varios?" o si con una sola foto
// alcanza con ir directo a país.
async function proceedAfterAlbumCollected(ctx, session) {
  const chatId = ctx.chat.id;
  if (session.fileIds.length === 1) {
    session.step = 'await_country';
    await setSession(chatId, session);
    await ctx.reply('📸 1 foto ✅');
    return ctx.reply(askCountryText);
  }
  // Con más de una foto, hay que saber si van todas al mismo país o no
  // antes de preguntar nada más — si no, asumíamos "mismo país" siempre,
  // y un álbum de varios lugares distintos quedaba mal etiquetado.
  session.step = 'await_album_scope';
  await setSession(chatId, session);
  return ctx.reply(
    `📸 ${session.fileIds.length} fotos juntadas ✅\n¿Son todas del mismo país, o hay de varios países distintos?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌍 Mismo país para todas', callback_data: 'album:same' }],
          [{ text: '🌎 Son de varios países', callback_data: 'album:multi' }],
        ],
      },
    }
  );
}

bot.on('photo', async (ctx) => {
  const photos = ctx.message.photo;
  const best = photos[photos.length - 1]; // la de mayor resolución (igual, nunca es el original)
  await handleIncomingFile(ctx, best.file_id, true);
});

// --- 2. botones ---------------------------------------------------------------
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chatId = ctx.chat.id;

  if (data === 'noop') return ctx.answerCbQuery();

  if (data === 'cancel') {
    await clearSession(chatId);
    await ctx.answerCbQuery('Cancelado');
    return ctx.editMessageText('Cancelado. Mandame otra foto cuando quieras.');
  }

  // Confirmación de /resetcontent — no depende de ninguna sesión de subida
  // en curso (de hecho, la borra), así que se resuelve ANTES del chequeo
  // de sesión de acá abajo, igual que 'cancel'.
  if (data === 'resetcontent:confirm') {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Borrando…');
    try {
      const { total, perPattern } = await resetAllPhotoKeys();
      const detail = Object.entries(perPattern)
        .map(([p, n]) => `${p} → ${n}`)
        .join('\n');
      return ctx.reply(`✅ Listo — ${total} claves borradas en Redis:\n${detail}`);
    } catch (err) {
      console.error('Error en /resetcontent:', err);
      return ctx.reply('❌ Algo falló borrando Redis: ' + err.message);
    }
  }

  const session = await getSession(chatId);
  if (!session) {
    await ctx.answerCbQuery();
    return ctx.editMessageText('Esta conversación ya expiró — mandame la foto de nuevo.');
  }

  // --- /editar: eligió qué foto tocar, y qué hacerle -------------------------
  if (data.startsWith('edit:sel:')) {
    const photoId = data.slice('edit:sel:'.length);
    await ctx.answerCbQuery();
    const { json: siteData } = await getSiteData();
    const loc = findPhotoLocation(siteData, photoId);
    if (!loc) return ctx.editMessageText('No encontré esa foto — puede que ya se haya borrado.');
    session.editPhotoId = photoId;
    session.step = 'await_edit_action';
    await setSession(chatId, session);
    return ctx.editMessageText(`"${loc.photo.caption}" — ${loc.containerName}\n¿Qué querés hacer?`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: '✏️ Cambiar título', callback_data: 'edit:caption' }],
          [{ text: '🏷 Cambiar categoría', callback_data: 'edit:category' }],
          [{ text: '🗑 Borrar', callback_data: 'edit:delete' }],
          [{ text: '✖️ Cancelar', callback_data: 'cancel' }],
        ],
      },
    });
  }

  if (data === 'edit:caption') {
    await ctx.answerCbQuery();
    session.step = 'await_edit_caption';
    await setSession(chatId, session);
    return ctx.editMessageText('Mandame el nuevo título / descripción corta.');
  }

  if (data === 'edit:category') {
    await ctx.answerCbQuery();
    const { json: siteData } = await getSiteData();
    return ctx.editMessageText('¿A qué categoría pertenece ahora?', {
      reply_markup: categoryTagMenu(siteData, 'editcat'),
    });
  }

  if (data.startsWith('editcat:g:') || data === 'editcat:none') {
    await ctx.answerCbQuery();
    const newCategoryKey = data === 'editcat:none' ? null : data.slice('editcat:g:'.length);
    try {
      const { json: siteData, sha } = await getSiteData();
      const loc = findPhotoLocation(siteData, session.editPhotoId);
      if (!loc) throw new Error('Ya no encuentro esa foto.');
      if (newCategoryKey) loc.photo.categoryKey = newCategoryKey;
      else delete loc.photo.categoryKey;
      await commitSiteData(siteData, sha, `✏️ Editado: categoría de "${loc.photo.caption}"`);
      await clearSession(chatId);
      return ctx.editMessageText('✅ Categoría actualizada.');
    } catch (err) {
      console.error('Error editando categoría:', err);
      return ctx.editMessageText('❌ No pude actualizarlo: ' + err.message);
    }
  }

  if (data === 'edit:delete') {
    await ctx.answerCbQuery();
    return ctx.editMessageText('¿Seguro que querés borrar esta foto del sitio?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🗑 Sí, borrar', callback_data: 'edit:delete:yes' }],
          [{ text: '✖️ No, cancelar', callback_data: 'cancel' }],
        ],
      },
    });
  }

  if (data === 'edit:delete:yes') {
    await ctx.answerCbQuery();
    try {
      const { json: siteData, sha } = await getSiteData();
      const loc = findPhotoLocation(siteData, session.editPhotoId);
      if (!loc) throw new Error('Ya no encuentro esa foto.');
      const caption = loc.photo.caption;
      let label = loc.containerName;
      if (loc.targetType === 'country') {
        const c = siteData.visited.find((x) => x.key === loc.targetKey);
        c.photos = (c.photos || []).filter((p) => p.id !== session.editPhotoId);
        // Si era la última foto de un país, vuelve a "sin fotos" — mismo
        // criterio que /undo.
        if (c.photos.length === 0) {
          siteData.visited = siteData.visited.filter((x) => x.key !== loc.targetKey);
          siteData.visitedEmpty.push({ key: c.key, name: c.name, lat: c.lat, lng: c.lng, w: c.w, h: c.h });
          siteData.visitedEmpty.sort((a, b) => a.name.localeCompare(b.name, 'es'));
        }
      } else {
        const cat = siteData.categories.find((x) => x.key === loc.targetKey);
        cat.photos = (cat.photos || []).filter((p) => p.id !== session.editPhotoId);
      }
      await commitSiteData(siteData, sha, `🗑 Borrado: "${caption}" de ${label}`);
      await clearSession(chatId);
      return ctx.editMessageText(`🗑 Borrado — "${caption}" ya no está en ${label}.`);
    } catch (err) {
      console.error('Error borrando:', err);
      return ctx.editMessageText('❌ No pude borrarlo: ' + err.message);
    }
  }

  // Terminó de mandar las fotos del álbum — arranca el flujo normal
  // (país/categoría/etc.) una sola vez para todo el lote junto. Si alguna
  // llegó comprimida, se avisa ACÁ, antes de seguir — no en silencio.
  if (data === 'album:done') {
    await ctx.answerCbQuery();
    if (session.hasCompressedSource) {
      await ctx.editMessageText(`📸 ${session.fileIds.length === 1 ? '1 foto' : session.fileIds.length + ' fotos'} juntadas.`);
      return askLowresConfirm(ctx, session);
    }
    return proceedAfterAlbumCollected(ctx, session);
  }

  if (data === 'album:same') {
    await ctx.answerCbQuery();
    session.step = 'await_country';
    await setSession(chatId, session);
    await ctx.editMessageText(`Dale, un solo país para las ${session.fileIds.length} fotos.`);
    return ctx.reply(askCountryText);
  }

  // Aceptó subir igual, en baja resolución — retoma justo donde el aviso
  // interrumpió: una foto sola va directo a país, un álbum vuelve a
  // preguntar (mismo país / varios países).
  if (data === 'lowres:continue') {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Dale, sigo con la comprimida.');
    if (session.fileIds.length === 1 && !session.albumGroupId) {
      session.step = 'await_country';
      await setSession(chatId, session);
      return ctx.reply(askCountryText);
    }
    return proceedAfterAlbumCollected(ctx, session);
  }

  if (data === 'lowres:cancel') {
    await clearSession(chatId);
    await ctx.answerCbQuery('Cancelado');
    return ctx.editMessageText(
      'Cancelado. Reenviala como archivo: clip 📎 → "Archivo" (o "File") → elegí la foto → mandar SIN comprimir.'
    );
  }

  // Son de países distintos — en vez de un target único para el lote, las
  // procesamos una por una, de punta a punta (país, título, ubicación,
  // categoría, confirmar, subir), encadenadas solas — ver startNextAlbumItem.
  if (data === 'album:multi') {
    await ctx.answerCbQuery();
    const total = session.fileIds.length;
    const [firstFileId, ...rest] = session.fileIds;
    await ctx.editMessageText(`Dale, las voy procesando una por una (${total} en total).`);
    return startNextAlbumItem(ctx, chatId, firstFileId, rest, total);
  }

  // Confirmación de un país ambiguo (varios candidatos parecidos al texto).
  if (data.startsWith('country:')) {
    const key = data.slice('country:'.length);
    await ctx.answerCbQuery();
    const { json: siteData } = await getSiteData();
    const isNew = siteData.visitedEmpty.some((c) => c.key === key);
    const country = (isNew ? siteData.visitedEmpty : siteData.visited).find((c) => c.key === key);
    session.target = { type: isNew ? 'country_new' : 'country_existing', key };
    await ctx.editMessageText(`País: ${country ? country.name : key} ✅`);
    return askTitle(ctx, session);
  }

  // Elegir categoría cuando la foto no tiene país (ej. Modelos).
  if (data.startsWith('sel:g:')) {
    const key = data.slice('sel:g:'.length);
    await ctx.answerCbQuery();
    session.target = { type: 'category', key };
    await ctx.editMessageText('Categoría marcada ✅ (sin país)');
    return askTitle(ctx, session);
  }

  // Tag opcional de categoría temática para una foto que SÍ tiene país.
  if (data.startsWith('tag:g:') || data === 'tag:none') {
    await ctx.answerCbQuery();
    session.categoryKey = data === 'tag:none' ? null : data.slice('tag:g:'.length);
    await ctx.editMessageText(session.categoryKey ? 'Categoría marcada.' : 'Sin categoría temática.');
    return askFinalConfirm(ctx, session);
  }

  // Confirmó el resumen final — recién ahí se sube de verdad.
  if (data === 'confirm:yes') {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Dale, subiendo…');
    return finalize(ctx, session);
  }

  // Confirmó que quiere subir la foto igual aunque ya exista (ej. la misma
  // toma sirve para dos países fronterizos, o la quiere en otra categoría).
  if (data === 'dup:continue') {
    await ctx.answerCbQuery();
    await ctx.editMessageText('Dale, seguimos.');
    if (session.hasCompressedSource) return askLowresConfirm(ctx, session);
    session.step = 'await_country';
    await setSession(chatId, session);
    return ctx.reply(askCountryText);
  }

  // Ninguna de las opciones de geocoding matcheaba — no es un cancelar
  // general, solo volver a pedir el nombre del lugar sin tocar el resto
  // de la sesión (foto, país, título ya elegidos siguen en pie).
  if (data === 'loc:retry') {
    delete session.pendingPlaces;
    await ctx.answerCbQuery();
    await ctx.editMessageText('Ok, probemos de nuevo.');
    return askLocation(ctx, session);
  }

  // Eligió una de las opciones de lugar que encontró el geocoding.
  if (data.startsWith('loc:')) {
    const idx = parseInt(data.slice('loc:'.length), 10);
    const place = session.pendingPlaces && session.pendingPlaces[idx];
    await ctx.answerCbQuery();
    if (!place) {
      return ctx.editMessageText('Esa opción ya venció — escribí el lugar de nuevo.');
    }
    delete session.pendingPlaces;
    await ctx.editMessageText(`Ubicación: ${place.displayName} ✅`);
    return advanceLocation(ctx, session, { lat: place.lat, lng: place.lng });
  }

  // Eligió una de las descripciones cortas que sugirió Grok, pidió otra
  // tanda más corta/más larga, o prefiere escribir la suya.
  if (data.startsWith('desc:')) {
    await ctx.answerCbQuery();
    if (data === 'desc:own') {
      delete session.pendingDescriptions;
      session.step = 'await_desc';
      await setSession(chatId, session);
      return ctx.editMessageText('Mandame una descripción corta de esta foto (en español).');
    }
    if (data === 'desc:shorter' || data === 'desc:longer') {
      await ctx.editMessageText(data === 'desc:shorter' ? 'Dale, más corta...' : 'Dale, más larga...');
      return askDescription(ctx, session, data === 'desc:shorter' ? 'shorter' : 'longer');
    }
    const idx = parseInt(data.slice('desc:'.length), 10);
    const description = session.pendingDescriptions && session.pendingDescriptions[idx];
    if (!description) return ctx.editMessageText('Esa opción ya venció — escribí la descripción a mano.');
    delete session.pendingDescriptions;
    await ctx.editMessageText(`Descripción: "${description}" ✅`);
    return advanceDescription(ctx, session, description);
  }

  // Eligió una de las intros que sugirió Grok para el país nuevo.
  if (data.startsWith('intro:')) {
    await ctx.answerCbQuery();
    if (data === 'intro:own') {
      delete session.pendingIntros;
      session.step = 'await_desc_es';
      await setSession(chatId, session);
      return ctx.editMessageText(
        'Necesito una descripción corta de intro, en español (ej: "Andes, niebla y ruinas incas al amanecer.").'
      );
    }
    const idx = parseInt(data.slice('intro:'.length), 10);
    const intro = session.pendingIntros && session.pendingIntros[idx];
    if (!intro) return ctx.editMessageText('Esa opción ya venció — escribí la intro a mano.');
    session.descEs = intro.es;
    session.descEn = intro.en;
    delete session.pendingIntros;
    await setSession(chatId, session);
    await ctx.editMessageText(`Intro: "${intro.es}" ✅`);
    return askCategoryTag(ctx, session);
  }

  return ctx.answerCbQuery();
});

// --- 3. texto (respuestas a las preguntas del flujo) --------------------------
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = await getSession(chatId);
  if (!session || !session.step) return; // no está en medio de un flujo

  const text = ctx.message.text.trim();

  if (session.step === 'await_duplicate_confirm') {
    return ctx.reply('Tocá uno de los botones de arriba (✅ Subir igual / ✖️ Cancelar) para seguir.');
  }

  if (session.step === 'await_album_more') {
    return ctx.reply('Mandame más fotos del álbum, o tocá "✅ Listo, continuar" cuando termines.');
  }

  if (session.step === 'await_album_scope') {
    return ctx.reply('Tocá una de las dos opciones de arriba (mismo país / varios países).');
  }

  if (session.step === 'await_final_confirm') {
    return ctx.reply('Tocá "✅ Confirmar y subir", o /back si algo está mal.');
  }

  if (session.step === 'await_desc_choice') {
    return ctx.reply('Tocá una de las descripciones de arriba, o "✏️ Escribir la mía" para escribir la tuya.');
  }

  if (session.step === 'await_edit_select' || session.step === 'await_edit_action') {
    return ctx.reply('Tocá uno de los botones de arriba (o /cancel).');
  }

  if (session.step === 'await_edit_caption') {
    try {
      const { json: siteData, sha } = await getSiteData();
      const loc = findPhotoLocation(siteData, session.editPhotoId);
      if (!loc) throw new Error('Ya no encuentro esa foto.');
      loc.photo.caption = text;
      let costUsd = null;
      try {
        const translated = await translateToEnglish(text);
        costUsd = translated.costUsd;
        if (translated.text) loc.photo.captionEn = translated.text;
        else delete loc.photo.captionEn;
      } catch (err) {
        console.error('Error traduciendo caption editado:', err);
        delete loc.photo.captionEn; // mejor sin traducción que con una vieja desactualizada
      }
      await commitSiteData(siteData, sha, `✏️ Editado: título -> "${text}"`);
      await clearSession(chatId);
      return ctx.reply(`✅ Título actualizado.${costNote(costUsd)}`);
    } catch (err) {
      console.error('Error editando título:', err);
      return ctx.reply('❌ No pude actualizarlo: ' + err.message);
    }
  }

  if (session.step === 'await_intro_choice') {
    return ctx.reply('Tocá una de las intros de arriba, o "✏️ Escribir la mía" para escribir la tuya.');
  }

  if (session.step === 'await_country') {
    const { json: siteData } = await getSiteData();
    const norm = normalize(text);

    // 1) dijo explícitamente que no tiene país (ej. "sin ubicación")
    if (NO_COUNTRY_WORDS.includes(norm)) {
      session.step = 'await_no_country_category';
      await setSession(chatId, session);
      return ctx.reply('¿A qué categoría pertenece?', { reply_markup: categoryMenu(siteData) });
    }

    // 2) escribió directamente el nombre de una categoría (ej. "modelos") —
    //    equivale a "sin país" + esa categoría, en un solo paso.
    const catMatch = findCategoryMatch(siteData, text);
    if (catMatch) {
      session.target = { type: 'category', key: catMatch.key };
      await ctx.reply(`Categoría: ${catMatch.name} ✅ (sin país)`);
      return askTitle(ctx, session);
    }

    // 3) nombre de país, tolerando errores de tipeo/acentos.
    const matches = findCountryMatches(siteData, text);
    if (matches.length === 0) {
      return ctx.reply(
        `No encontré "${text}" ni como país ni como categoría — revisá cómo lo escribiste y probá de nuevo ` +
          '(o mandá "sin ubicación" si no aplica).'
      );
    }
    if (matches.length === 1 && matches[0].distance === 0) {
      session.target = { type: matches[0].isNew ? 'country_new' : 'country_existing', key: matches[0].key };
      await ctx.reply(`País: ${matches[0].name} ✅`);
      return askTitle(ctx, session);
    }
    const rows = matches.map((m) => [{ text: `${m.isNew ? '⚪' : '🟡'} ${m.name}`, callback_data: `country:${m.key}` }]);
    rows.push([{ text: '✖️ Cancelar', callback_data: 'cancel' }]);
    return ctx.reply(`¿A cuál país te referís con "${text}"?`, { reply_markup: { inline_keyboard: rows } });
  }

  if (session.step === 'await_title') {
    return advanceTitle(ctx, session, text);
  }

  if (session.step === 'await_desc') {
    return advanceDescription(ctx, session, text);
  }

  if (session.step === 'await_location') {
    if (text === 'Sin ubicación') return advanceLocation(ctx, session, null);

    // No es el botón de GPS ni "Sin ubicación" — probamos buscarlo como
    // nombre de lugar (geocoding) antes de rendirnos. Cubre el caso de
    // subir una foto vieja de un viaje pasado, donde compartir el GPS
    // actual no tiene sentido. Mostramos las opciones como botones en vez
    // de aceptar la primera a ciegas — así elegís cuál es, en vez de
    // confiar en que Nominatim adivinó bien (ver bug de "/cancel").
    try {
      const places = await geocodePlaces(text, 4);
      if (!places.length) {
        return ctx.reply(
          `No encontré "${text}" como lugar. Probá con otro nombre (ej. "Estambul" en vez de "el puente ese"), ` +
            'tocá "📍 Compartir ubicación", o mandá "Sin ubicación" si no aplica.',
          locationKeyboard
        );
      }
      session.pendingPlaces = places;
      await setSession(chatId, session);
      const rows = places.map((p, i) => [{ text: shortenPlace(p.displayName), callback_data: `loc:${i}` }]);
      // "Ninguna de estas" en vez de 'cancel' — no querés perder la foto y el
      // país que ya elegiste solo porque el lugar no matcheó bien.
      rows.push([{ text: '✖️ Ninguna de estas', callback_data: 'loc:retry' }]);
      return ctx.reply(`¿Cuál de estos es "${text}"?`, { reply_markup: { inline_keyboard: rows } });
    } catch (err) {
      console.error('Error geocodificando:', err);
      return ctx.reply(
        'No pude buscar ese lugar (falló el servicio de mapas) — probá de nuevo, tocá "📍 Compartir ' +
          'ubicación", o mandá "Sin ubicación".',
        locationKeyboard
      );
    }
  }

  if (session.step === 'await_desc_es') {
    session.descEs = text;
    // Traducción automática — antes se pedía escribirla dos veces, y mandar
    // "-" para "dejarla igual" literalmente copiaba el español sin traducir
    // nada (así quedó "Templos y neblina." también en la versión inglesa).
    try {
      const translated = await translateToEnglish(text);
      session.descEn = translated.text;
      session.aiCostUsd = (session.aiCostUsd || 0) + (translated.costUsd || 0);
    } catch (err) {
      console.error('Error traduciendo descripción de país:', err);
      session.descEn = text; // mejor mostrar el español que romper el flujo
    }
    await setSession(chatId, session);
    return askCategoryTag(ctx, session);
  }
});

// --- ubicación (respuesta al paso "await_location") --------------------------
bot.on('location', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = await getSession(chatId);
  if (!session || session.step !== 'await_location') return;

  return advanceLocation(ctx, session, {
    lat: ctx.message.location.latitude,
    lng: ctx.message.location.longitude,
  });
});

// Foto mandada "como archivo" (clip 📎 → Archivo/File) — ESTE es el único
// camino por el que Telegram entrega el original tal cual, sin comprimir a
// ~1280px como hace bot.on('photo'). Antes esto se rechazaba explícitamente;
// ahora es el camino recomendado para todo lo que se vaya a imprimir grande.
bot.on('document', async (ctx) => {
  const doc = ctx.message.document;
  const isImage = /^image\//.test(doc.mime_type || '');
  if (!isImage) {
    return ctx.reply('Por ahora solo puedo procesar fotos (y su ubicación/texto de respuesta) — mandame una foto para empezar.');
  }

  // Chequeo del tamaño ANTES de intentar descargar — si se le pega directo
  // a getFileLink/getFile con un archivo de más de 20MB, Telegram tira un
  // error críptico ("file is too big") en vez de esto. file_size viene casi
  // siempre en el documento; si faltara (raro), seguimos igual y, en el peor
  // caso, falla más adelante con un error genérico al subir — no bloqueamos
  // por una ausencia de dato que casi nunca pasa.
  if (doc.file_size && doc.file_size > TELEGRAM_MAX_DOWNLOAD_BYTES) {
    const mb = (doc.file_size / (1024 * 1024)).toFixed(1);
    return ctx.reply(
      `📎 Este archivo pesa ${mb}MB — Telegram no me deja descargar más de 20MB a través del bot ` +
        '(es un límite de la Bot API de Telegram, no mío). Si es un RAW de cámara (.CR3, .NEF, etc.), ' +
        'exportalo primero a JPEG de buena calidad (queda bien debajo de 20MB) y reenvialo así — ' +
        'alcanza de sobra para imprimir en cualquier tamaño del catálogo.'
    );
  }

  await handleIncomingFile(ctx, doc.file_id, false);
});

// Video, sticker, audio, etc. — no hay nada que hacer con esto todavía.
bot.on(['video', 'video_note', 'animation', 'sticker', 'voice', 'audio'], async (ctx) => {
  return ctx.reply('Por ahora solo puedo procesar fotos (y su ubicación/texto de respuesta) — mandame una foto para empezar.');
});

// Después de la ubicación (compartida o saltada), sigue el flujo normal:
// - país nuevo: pide la descripción de intro, y después la categoría (opcional).
// - país existente: pregunta directo la categoría (opcional).
// - sin país (ej. Modelos): finaliza directo, no aplica el tag de categoría
//   porque ya está implícito en la categoría elegida al principio.
async function afterLocation(ctx, session) {
  if (session.target.type === 'country_new') {
    const { json: siteData } = await getSiteData();
    const country = siteData.visitedEmpty.find((c) => c.key === session.target.key);
    return askIntroChoice(ctx, session, country ? country.name : session.target.key);
  }
  if (session.target.type === 'country_existing') {
    return askCategoryTag(ctx, session);
  }
  return askFinalConfirm(ctx, session);
}

// Arranca (o continúa) el flujo de país/título/etc. para UNA foto de un
// álbum "de varios países" — cada una pasa por todo el proceso normal de
// punta a punta, encadenadas solas sin que haga falta reenviarlas.
async function startNextAlbumItem(ctx, chatId, fileId, queue, total) {
  const position = total - queue.length;
  await setSession(chatId, { step: 'await_country', fileIds: [fileId], albumQueue: queue, albumTotal: total });
  return ctx.reply(`📸 Foto ${position} de ${total} — ${askCountryText}`);
}

// Casi toda foto de un país puede pertenecer ADEMÁS a una categoría temática
// (no es alternativa a tener país — es un tag extra, opcional).
async function askCategoryTag(ctx, session) {
  const chatId = ctx.chat.id;
  session.step = 'await_category_tag';
  await setSession(chatId, session);
  const { json: siteData } = await getSiteData();
  return ctx.reply('¿Pertenece también a alguna categoría temática del sitio? (opcional)', {
    reply_markup: categoryTagMenu(siteData),
  });
}

// Resumen antes de subir de verdad — junta todo lo que se acumuló en la
// sesión para poder pescar un error (país equivocado, caption con typo)
// antes de commitear, no después. /back desde acá vuelve al paso de
// categoría (o ubicación, si no hay país).
async function askFinalConfirm(ctx, session) {
  const chatId = ctx.chat.id;
  const { json: siteData } = await getSiteData();

  let placeLabel = session.target.key;
  if (session.target.type === 'category') {
    const cat = siteData.categories.find((c) => c.key === session.target.key);
    if (cat) placeLabel = cat.name;
  } else {
    const arr = session.target.type === 'country_new' ? siteData.visitedEmpty : siteData.visited;
    const c = arr.find((x) => x.key === session.target.key);
    if (c) placeLabel = c.name;
  }
  const tagCat = session.categoryKey ? siteData.categories.find((c) => c.key === session.categoryKey) : null;

  const lines = [`📍 ${placeLabel}${tagCat ? ' + ' + tagCat.name : ''}`];
  if (session.captions.length > 1) {
    lines.push(`📝 ${session.captions.length} fotos:`);
    session.captions.forEach((c, i) => lines.push(`   ${i + 1}. "${c}"`));
  } else {
    lines.push(`📝 "${session.captions[0]}"`);
  }
  if (session.locations && session.locations.some((l) => l)) {
    if (session.captions.length > 1) {
      session.locations.forEach((l, i) => {
        if (l) lines.push(`🗺 Foto ${i + 1}: ${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}`);
      });
    } else {
      const l = session.locations[0];
      lines.push(`🗺 ${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}`);
    }
  }
  if (session.descEs) lines.push(`✍️ Intro del país: "${session.descEs}"`);
  lines.push('', '¿Confirmás?');

  session.step = 'await_final_confirm';
  await setSession(chatId, session);
  return ctx.reply(lines.join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Confirmar y subir', callback_data: 'confirm:yes' }],
        [{ text: '✖️ Cancelar', callback_data: 'cancel' }],
      ],
    },
  });
}

// --- 4. subir la(s) foto(s) y commitear data.json ------------------------------
// session.fileIds siempre es un array — una foto sola es un array de 1
// (así no hace falta duplicar esta lógica para álbumes).
async function finalize(ctx, session) {
  const chatId = ctx.chat.id;
  const fileIds = session.fileIds;
  try {
    await ctx.reply(
      fileIds.length > 1 ? `Subiendo ${fileIds.length} fotos y actualizando el sitio…` : 'Subiendo la foto y actualizando el sitio…'
    );

    // Se sube cada archivo antes de tocar data.json — si algo falla acá
    // (ej. la 2ª de 3 fotos), no queda un commit a medio hacer.
    const photoEntries = [];
    const uploaded = []; // {hash, photoId} de cada una, para registrar duplicados después
    for (let i = 0; i < fileIds.length; i++) {
      const fileLink = await ctx.telegram.getFileLink(fileIds[i]);
      const publicIdHint = fileIds.length > 1 ? `${session.target.key}-${Date.now()}-${i}` : `${session.target.key}-${Date.now()}`;
      const { cleanUrl, displayUrl, hash, buffer, width, height } = await uploadFromUrl(fileLink.href, publicIdHint);
      const photoId = publicIdHint;

      // La URL limpia (sin marca de agua) va aparte, en Redis — nunca a
      // data.json, que es público. data.json solo se entera del id y de la
      // versión con marca de agua.
      await saveCleanUrl(photoId, cleanUrl);

      // Derivadas de impresión: la edición de Mario (pantalla, emite luz)
      // satura más de lo que el papel/aluminio (reflejan luz) pueden
      // reproducir — sin esto, esa zona se imprime como una mancha plana en
      // vez del detalle real. Se generan a partir del buffer ORIGINAL (no
      // de displayUrl, que ya tiene marca de agua y menos resolución) y se
      // guardan aparte, igual que cleanUrl — el checkout las usa al armar
      // el pedido a Prodigi según el material comprado (ver
      // cantbelievetheview-api/api/stripe-webhook.js). Si falla, no bloquea
      // la subida — el checkout cae a la foto limpia sin preparar.
      try {
        const printUrls = await uploadPrintDerivatives(buffer, photoId);
        if (Object.keys(printUrls).length) await savePrintUrls(photoId, printUrls);
      } catch (err) {
        console.error('Error generando derivadas de impresión:', err);
      }

      const photoEntry = { id: photoId, displayUrl, caption: session.captions[i] };
      // Dimensiones reales del archivo subido (px) — de acá el sitio calcula
      // qué tamaños de impresión puede ofrecer para esta foto sin quedar
      // blanda (ver dpiParaTamaño en sitio/index.html). No son sensibles —
      // van directo a data.json, que ya es público.
      if (width && height) {
        photoEntry.w = width;
        photoEntry.h = height;
      }
      // Traducción al inglés del título — sin esto, el sitio en inglés
      // mostraba el título en español tal cual (nunca había campo para el
      // inglés). Si falla la traducción no bloqueamos la subida — el sitio
      // ya cae solo al español si no encuentra captionEn.
      try {
        const translated = await translateToEnglish(session.captions[i]);
        if (translated.text) photoEntry.captionEn = translated.text;
        session.aiCostUsd = (session.aiCostUsd || 0) + (translated.costUsd || 0);
      } catch (err) {
        console.error('Error traduciendo caption:', err);
      }
      // Solo le agregamos lat/lng a la foto si de verdad la compartiste —
      // así el sitio sabe que es una coordenada real (si no, la galería se
      // la inventa aproximada a partir del país/categoría, como ya hacía).
      // Es POR FOTO — no se le pega la misma ubicación a todo el lote.
      const loc = session.locations && session.locations[i];
      if (loc) {
        photoEntry.lat = loc.lat;
        photoEntry.lng = loc.lng;
      }
      // Tag opcional de categoría temática — solo aplica a fotos de país
      // (la rama "category" de abajo, ej. Modelos, ya está tagueada por
      // estar bajo esa categoría directamente). La galería de la categoría
      // en el sitio suma esta foto sin duplicarla en data.json (ver
      // photosForCategory en index.html).
      if (session.categoryKey) photoEntry.categoryKey = session.categoryKey;

      photoEntries.push(photoEntry);
      uploaded.push({ hash, photoId });
    }

    const { json: siteData, sha } = await getSiteData();
    let label = '';

    if (session.target.type === 'category') {
      const cat = siteData.categories.find((c) => c.key === session.target.key);
      if (!cat) throw new Error(`No encontré la categoría "${session.target.key}" en data.json`);
      cat.photos = cat.photos || [];
      cat.photos.push(...photoEntries);
      label = cat.name;
    } else if (session.target.type === 'country_existing') {
      const c = siteData.visited.find((x) => x.key === session.target.key);
      if (!c) throw new Error(`No encontré el país "${session.target.key}" en visited`);
      c.photos = c.photos || [];
      c.photos.push(...photoEntries);
      label = c.name;
    } else if (session.target.type === 'country_new') {
      const idx = siteData.visitedEmpty.findIndex((x) => x.key === session.target.key);
      if (idx === -1) throw new Error(`No encontré el país "${session.target.key}" en visitedEmpty`);
      const [c] = siteData.visitedEmpty.splice(idx, 1);
      siteData.visited.push({
        key: c.key,
        name: c.name,
        lat: c.lat,
        lng: c.lng,
        w: c.w,
        h: c.h,
        desc: session.descEs,
        descEn: session.descEn,
        photos: photoEntries,
      });
      label = c.name;
    }

    const tagCat = session.categoryKey ? siteData.categories.find((c) => c.key === session.categoryKey) : null;
    const fullLabel = tagCat ? `${label} + ${tagCat.name}` : label;
    const countLabel = photoEntries.length > 1 ? `${photoEntries.length} fotos` : `"${session.captions[0]}"`;

    const message = `📸 ${session.target.type === 'country_new' ? 'Nuevo país' : 'Nueva foto'}: ${countLabel} — ${fullLabel}`;
    await commitSiteData(siteData, sha, message);

    // Registrar el hash de cada archivo — así, si alguna se vuelve a mandar
    // más adelante, el bot avisa antes de subirla de nuevo.
    await Promise.all(uploaded.map(({ hash, photoId }) => saveHash(hash, photoId, fullLabel)));

    // Para poder deshacer con /undo — qué se subió y a dónde.
    await saveLastUpload(chatId, {
      photoIds: photoEntries.map((p) => p.id),
      hashes: uploaded.map((u) => u.hash),
      targetType: session.target.type,
      targetKey: session.target.key,
      wasNewCountry: session.target.type === 'country_new',
    });

    // Álbum "de varios países": si quedan más fotos en la cola, encadenamos
    // con la siguiente en vez de cerrar acá — el usuario no tiene que
    // reenviar nada, sigue solo.
    if (session.albumQueue && session.albumQueue.length > 0) {
      await ctx.reply(`✅ ${countLabel} agregada${photoEntries.length > 1 ? 's' : ''} a ${fullLabel}.${costNote(session.aiCostUsd)}`);
      const [nextFileId, ...rest] = session.albumQueue;
      return startNextAlbumItem(ctx, chatId, nextFileId, rest, session.albumTotal);
    }

    await clearSession(chatId);
    const albumDone = session.albumTotal ? `\n🎉 Terminaste las ${session.albumTotal} fotos del álbum.` : '';
    await ctx.reply(
      `✅ Listo — ${countLabel} agregada${photoEntries.length > 1 ? 's' : ''} a ${fullLabel}.${albumDone}\n` +
        `Netlify va a redeployar solo, en 1-2 min debería verse en cantbelievetheview.com.\n\n` +
        `(¿Te equivocaste? Mandá /undo para deshacerlo${session.albumTotal ? ' de esta última' : ''}.)` +
        `${costNote(session.aiCostUsd)}`
    );
  } catch (err) {
    console.error(err);
    await clearSession(chatId);
    await ctx.reply('❌ Algo falló: ' + err.message + '\nMandá la foto de nuevo para reintentar.');
  }
}

// --- handler de Vercel ---------------------------------------------------------
module.exports = async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error('Error procesando update de Telegram:', err);
  }
  if (!res.headersSent) res.status(200).end();
};
