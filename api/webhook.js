const { Telegraf, Markup } = require('telegraf');
const { getSession, setSession, clearSession } = require('../lib/session');
const { mainMenu, countryPage, categoryMenu } = require('../lib/keyboards');
const { getSiteData, commitSiteData } = require('../lib/github');
const { uploadFromUrl } = require('../lib/cloudinary');
const { saveCleanUrl } = require('../lib/photoStore');

const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
const ALLOWED_ID = String(process.env.ALLOWED_TELEGRAM_ID || '');

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
    'Mandame una foto y te pregunto a qué país o categoría del sitio pertenece. ' +
      'En un rato queda publicada en cantbelievetheview.com.'
  )
);

// --- 1. llega una foto -------------------------------------------------------
bot.on('photo', async (ctx) => {
  const photos = ctx.message.photo;
  const best = photos[photos.length - 1]; // la de mayor resolución
  await setSession(ctx.chat.id, { step: 'await_target', fileId: best.file_id });
  await ctx.reply('¿A qué corresponde esta foto?', { reply_markup: mainMenu });
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

  if (data === 'menu:main') {
    await ctx.answerCbQuery();
    return ctx.editMessageText('¿A qué corresponde esta foto?', { reply_markup: mainMenu });
  }

  if (data.startsWith('menu:country:')) {
    const page = parseInt(data.split(':')[2], 10) || 0;
    await ctx.answerCbQuery();
    const { json: siteData } = await getSiteData();
    return ctx.editMessageText('Elegí el país:', { reply_markup: countryPage(siteData, page) });
  }

  if (data === 'menu:category') {
    await ctx.answerCbQuery();
    const { json: siteData } = await getSiteData();
    return ctx.editMessageText('Elegí la categoría:', { reply_markup: categoryMenu(siteData) });
  }

  if (data.startsWith('sel:c:') || data.startsWith('sel:g:')) {
    const [, kind, key] = data.split(':');
    await ctx.answerCbQuery();

    if (kind === 'c') {
      const { json: siteData } = await getSiteData();
      const isNew = siteData.visitedEmpty.some((c) => c.key === key);
      const target = { type: isNew ? 'country_new' : 'country_existing', key };
      await setSession(chatId, { ...session, step: 'await_caption', target });
    } else {
      await setSession(chatId, { ...session, step: 'await_caption', target: { type: 'category', key } });
    }

    return ctx.editMessageText('Mandame el título / descripción corta de la foto (en español).');
  }
});

// --- 3. texto (respuestas a las preguntas del flujo) --------------------------
bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = await getSession(chatId);
  if (!session || !session.step || session.step === 'await_target') return; // no está en medio de un flujo

  const text = ctx.message.text.trim();

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
    session.step = 'finalize';
    await setSession(chatId, session);
    return finalize(ctx, session);
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
// si es un país nuevo pide la descripción de intro, si no, finaliza directo.
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
  session.step = 'finalize';
  await setSession(chatId, session);
  await ctx.reply(
    session.lat !== undefined ? 'Ubicación guardada.' : 'Sin ubicación, seguimos.',
    Markup.removeKeyboard()
  );
  return finalize(ctx, session);
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

    const message = `📸 ${session.target.type === 'country_new' ? 'Nuevo país' : 'Nueva foto'}: ${session.caption} — ${label}`;
    await commitSiteData(siteData, sha, message);

    await clearSession(chatId);
    await ctx.reply(
      `✅ Listo — "${session.caption}" agregada a ${label}.\n` +
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
