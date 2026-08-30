# cantbelievetheview — el bot de Telegram

La única vía por la que entra contenido al sitio. Mario manda una foto por Telegram y en
uno o dos minutos está publicada: **foto → botones → Cloudinary → `data.json` → Netlify
redespliega**.

**Node 24 · Vercel · despliegue automático en cada push a `main`.** Privado por diseño:
solo responde al `ALLOWED_TELEGRAM_ID` de Mario; a cualquier otro le dice *"Este bot es
privado."*

## ⚠️ Este repositorio es PÚBLICO — nunca commitear credenciales

Todas van en *Vercel → Environment Variables*. Aquí viven el token del bot y un token de
GitHub con permiso de escritura.

## Por qué este repo NO se fusiona con el del sitio

**El bot escribe `data.json` en el repositorio del sitio a través de la API de GitHub.**
Fusionarlos rompería esa integración. Viven agrupados en una carpeta, pero cada uno mantiene
su repo y su despliegue. Es deliberado.

## La regla que costó todo el catálogo: las fotos van como ARCHIVO

Hasta el 26 de agosto de 2026 **el bot nunca guardó el original de ninguna foto**.
`ctx.message.photo` devuelve las **miniaturas** de Telegram, no el archivo enviado — así
que todo lo publicado estaba a 960×1280. En un catálogo que llega a 30×45", eso significaba
vender impresiones visiblemente borrosas.

Ahora el bot acepta la foto **como archivo** y **avisa con botones si llega comprimida**,
nunca más en silencio. Si tocas esta parte, no rompas eso.

## El umbral de 200 dpi

Solo se ofrecen los tamaños que la foto aguanta a **200 dpi**, elegido por Mario
(*"200 vamos"*). Se calcula **por foto desde sus dimensiones reales**, no con una lista
fija: al resubir en mejor resolución, los tamaños se desbloquean solos.

| resolución | máximo a 200 dpi (algodón) |
|---|---|
| 12 MP | 10×20" · $38.50 |
| 24 MP | 20×28" · $45.64 |
| **48 MP ProRAW** | **30×40" · $62.71** |

⚠️ **Telegram no descarga más de 20 MB.** Un ProRAW de 48 MP pesa 75–100 MB y un CR3 de la
Canon 25–32 MB. **Las mejores fotos de Mario no pueden entrar por aquí** — hace falta otra
vía, y está sin resolver.

## Las tres versiones

Por cada foto, el bot sube a Cloudinary **la del sitio, `-algodon` y `-aluminio`**, estas
dos preparadas para el rango de color de cada material con el algoritmo de la skill
`impresion` (portado a Node con `sharp`). Las URLs van a Redis
(`cbtv:photoprint:<id>`), no a `data.json`. La API elige cuál usar según lo comprado.

Mario no cambia nada de lo que hace: manda la foto como siempre.

## Aquí solo suben fotos YA EDITADAS

Son las que se publican y se venden. Los pares original/editada para calibrar la impresión
**van por separado**, copiados a disco en `proyectos/impresion/referencias/`, y **no pasan
por Telegram**. Decisión expresa de Mario: *"eso debemos hacerlo por separado."*

## Estado

El cuello de botella del proyecto **es el contenido, no el código**: el sitio está casi
vacío y Mario tiene miles de fotos sin subir. Esta cañería ya funciona.
