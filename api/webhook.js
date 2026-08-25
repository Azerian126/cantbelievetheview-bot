const { Telegraf, Markup } = require('telegraf');
const { getSession, setSession, clearSession } = require('../lib/session');
const { categoryMenu, categoryTagMenu } = require('../lib/keyboards');
const { getSiteData, commitSiteData } = require('../lib/github');
const { uploadFromUrl } = require('../lib/cloudinary');
const { saveCleanUrl } = require('../lib/photoStore');
const { normalize, findCountryMatches, findCategoryMatch } = require('../lib/matchText');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ALLOWED_ID = String(process.env.ALLOWED_TELEGRAM_ID || '');

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
    'Mandame una foto y te pregunto de qué país es (o "sin ubicación" si no aplica, ej. Modelos). ' +
      'En un rato queda publicada en cantbelievetheview.com.'
  )
);

// --- 1. llega una foto -------------------------------------------------------
// Casi toda foto tiene país (es lo único que preguntamos de entrada). El caso
// sin ubicación (ej. Modelos) es la excepción, no la alternativa por defecto.
bot.on('photo', async (ctx) => {
  const photos = ctx.message.photo;
  const best = photos[photos.length - 1]; // la de mayor resolución
  await setSession(ctx.chat.id, { step: 'await_country', fileId: best.file_id });
  await ctx.reply('¿De qué país es esta foto? Escribí el nombre (si te tipeás, lo busco igual) — o "sin ubicación" si no aplica (ej. Modelos).');
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

  const session = await getSession(chatId);
  if (!session) {
    await ctx.answerCbQuery();
    return ctx.editMessageText('Esta conversación ya expiró — mandame la foto de nuevo.');
  }

  // Confirmación de un país ambiguo (varios candidatos parecidos al texto).
  if (data.startsWith('country:')) {
    const key = data.slice('country:'.length);
    await ctx.answerCbQuery();
    const { json: siteData } = await getSiteData();
    const isNew = siteData.visitedEmpty.some((c) => c.key === key);
    session.target = { type: isNew ? 'country_new' : 'country_existing', key };
    session.step = 'await_caption';
    await setSession(chatId, session);
    return ctx.editMessageText('Mandame el título / descripción corta de la foto (en español).');
  }

  // Elegir categoría cuando la foto no tiene país (ej. Modelos).
  if (data.startsWith('sel:g:')) {
    const key = data.slice('sel:g:'.length);
    await ctx.answerCbQuery();
    session.target = { type: 'category', key };
    session.step = 'await_caption';
    await setSession(chatId, session);
    return ctx.editMessageText('Mandame el título / descripción corta de la foto (en español).');
  }

  // Tag opcional de categoría temática para una foto que SÍ tiene país.
  if (data.startsWith('tag:g:') || data === 'tag:none') {
    await ctx.answerCbQuery();
    session.categoryKey = data === 'tag:none' ? null : data.slice('tag:g:'.length);
    session.step = 'finalize';
    await setSession(chatId, session);
    await ctx.editMessageText(session.categoryKey ? 'Categoría marcada.' : 'Sin categoría temática.');
    return finalize(ctx, session);
  }

  return ctx.answerCbQuery();
});

// --- 3. texto (respuestas a las preguntas del flujo) --------------------------
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = await getSession(chatId);
  if (!session || !session.step) return; // no está en medio de un flujo

  const text = ctx.message.text.trim();

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
      session.step = 'await_caption';
      await setSession(chatId, session);
      return ctx.reply(
        `Categoría: ${catMatch.name} ✅ (sin país)\nMandame el título / descripción corta de la foto (en español).`
      );
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
      session.step = 'await_caption';
      await setSession(chatId, session);
      return ctx.reply(`País: ${matches[0].name} ✅\nMandame el título / descripción corta de la foto (en español).`);
    }
    const rows = matches.map((m) => [{ text: `${m.isNew ? '⚪' : '🟡'} ${m.name}`, callback_data: `country:${m.key}` }]);
    rows.push([{ text: '✖️ Cancelar', callback_data: 'cancel' }]);
    return ctx.reply(`¿A cuál país te referís con "${text}"?`, { reply_markup: { inline_keyboard: rows } });
  }

  if (session.step === 'await_caption') {
    session.caption = text;
    session.step = 'await_location';
    await setSession(chatId, session);
    return ctx.reply(
      '¿Dónde se sacó esta foto? Tocá el botón para compartir la ubicación (elegís el punto en el mapa ' +
        'de Telegram), o mandá "Sin ubicación" si no la tenés.',
      locationKeyboard
    );
  }

  if (session.step === 'await_location' && text === 'Sin ubicación') {
    return afterLocation(ctx, session);
  }

  if (session.step === 'await_desc_es') {
    session.descEs = text;
    session.step = 'await_desc_en';
    await setSession(chatId, session);
    return ctx.reply('Ahora la misma descripción en inglés (o mandá "-" para dejarla igual).', Markup.removeKeyboard());
  }

  if (session.step === 'await_desc_en') {
    session.descEn = text === '-' ? session.descEs : text;
    await setSession(chatId, session);
    return askCategoryTag(ctx, session);
  }
});

// --- ubicación (respuesta al paso "await_location") --------------------------
bot.on('location', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = await getSession(chatId);
  if (!session || session.step !== 'await_location') return;

  session.lat = ctx.message.location.latitude;
  session.lng = ctx.message.location.longitude;
  return afterLocation(ctx, session);
});

// Después de la ubicación (compartida o saltada), sigue el flujo normal:
// - país nuevo: pide la descripción de intro, y después la categoría (opcional).
// - país existente: pregunta directo la categoría (opcional).
// - sin país (ej. Modelos): finaliza directo, no aplica el tag de categoría
//   porque ya está implícito en la categoría elegida al principio.
async function afterLocation(ctx, session) {
  const chatId = ctx.chat.id;
  if (session.target.type === 'country_new') {
    session.step = 'await_desc_es';
    await setSession(chatId, session);
    return ctx.reply(
      'Este país todavía no tiene galería — necesito una descripción corta de intro, en español ' +
        '(ej: "Andes, niebla y ruinas incas al amanecer.").',
      Markup.removeKeyboard()
    );
  }
  await ctx.reply(
    session.lat !== undefined ? 'Ubicación guardada.' : 'Sin ubicación, seguimos.',
    Markup.removeKeyboard()
  );
  if (session.target.type === 'country_existing') {
    return askCategoryTag(ctx, session);
  }
  session.step = 'finalize';
  await setSession(chatId, session);
  return finalize(ctx, session);
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

// --- 4. subir la foto y commitear data.json ------------------------------------
async function finalize(ctx, session) {
  const chatId = ctx.chat.id;
  try {
    await ctx.reply('Subiendo la foto y actualizando el sitio…');

    const fileLink = await ctx.telegram.getFileLink(session.fileId);
    const publicIdHint = `${session.target.key}-${Date.now()}`;
    const { cleanUrl, displayUrl } = await uploadFromUrl(fileLink.href, publicIdHint);
    const photoId = publicIdHint;

    // La URL limpia (sin marca de agua) va aparte, en Redis — nunca a
    // data.json, que es público. data.json solo se entera del id y de la
    // versión con marca de agua.
    await saveCleanUrl(photoId, cleanUrl);

    // Solo le agregamos lat/lng a la foto si de verdad la compartiste — así
    // el sitio sabe que es una coordenada real (si no, la galería se la
    // inventa aproximada a partir del país/categoría, como venía haciendo).
    const photoEntry = { id: photoId, displayUrl, caption: session.caption };
    if (session.lat !== undefined) {
      photoEntry.lat = session.lat;
      photoEntry.lng = session.lng;
    }
    // Tag opcional de categoría temática — solo aplica a fotos de país (la
    // rama "category" de abajo, ej. Modelos, ya está tagueada por estar bajo
    // esa categoría directamente). La galería de la categoría en el sitio
    // suma esta foto sin duplicarla en data.json (ver photosForCategory en
    // index.html).
    if (session.categoryKey) {
      photoEntry.categoryKey = session.categoryKey;
    }

    const { json: siteData, sha } = await getSiteData();
    let label = '';

    if (session.target.type === 'category') {
      const cat = siteData.categories.find((c) => c.key === session.target.key);
      if (!cat) throw new Error(`No encontré la categoría "${session.target.key}" en data.json`);
      cat.photos = cat.photos || [];
      cat.photos.push(photoEntry);
      label = cat.name;
    } else if (session.target.type === 'country_existing') {
      const c = siteData.visited.find((x) => x.key === session.target.key);
      if (!c) throw new Error(`No encontré el país "${session.target.key}" en visited`);
      c.photos = c.photos || [];
      c.photos.push(photoEntry);
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
        photos: [photoEntry],
      });
      label = c.name;
    }

    const tagCat = photoEntry.categoryKey
      ? siteData.categories.find((c) => c.key === photoEntry.categoryKey)
      : null;
    const fullLabel = tagCat ? `${label} + ${tagCat.name}` : label;

    const message = `📸 ${session.target.type === 'country_new' ? 'Nuevo país' : 'Nueva foto'}: ${session.caption} — ${fullLabel}`;
    await commitSiteData(siteData, sha, message);

    await clearSession(chatId);
    await ctx.reply(
      `✅ Listo — "${session.caption}" agregada a ${fullLabel}.\n` +
        `Netlify va a redeployar solo, en 1-2 min debería verse en cantbelievetheview.com.`
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
