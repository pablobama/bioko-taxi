// Service worker: que la aplicación abra sin cobertura.
//
// El plano de Malabo ya viajaba dentro del paquete, pero eso no servía de nada
// si la aplicación misma no llegaba a arrancar. Sin esto, un teléfono al que
// Android le haya vaciado la caché se queda mirando la pantalla de error del
// navegador justo cuando hace falta pedir un taxi.
//
// Escrito a mano y no con Workbox a propósito: la política de caché de esta
// aplicación cabe en una pantalla y una librería pesaría más que ella. Lo que
// hay que decidir es poco, pero hay que decidirlo bien.
//
// LA REGLA IMPORTANTE: la API NUNCA se cachea.
//
// Servir un estado de viaje guardado sería mentir sobre algo que cambia solo:
// enseñar «tu taxi llega en 4 minutos» de un viaje que terminó hace media hora
// es peor que no enseñar nada. Sin red, esas peticiones fallan, y la aplicación
// ya sabe distinguir ese fallo y avisar («Sin conexión · reintentando») sin
// borrar lo que hubiera en pantalla.

// La lista de ficheros y la versión las inyecta scripts/generar-sw.mjs después
// de compilar, porque Vite les pone un hash al nombre en cada publicación.
const VERSION = '__VERSION__';
const RECURSOS = __RECURSOS__;

const CACHE = `taxi-malabo-${VERSION}`;

// Al instalar se guarda TODO lo que la aplicación necesita para arrancar. Es
// una descarga única y ya está hecha (son los mismos ficheros que el navegador
// acaba de pedir), así que no cuesta datos de más.
self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(RECURSOS)),
  );
});

// Al activar se tiran las versiones viejas. Sin esto cada publicación dejaría
// su copia entera en el teléfono para siempre.
self.addEventListener('activate', (evento) => {
  evento.waitUntil(
    caches.keys()
      .then((claves) => Promise.all(
        claves.filter((c) => c.startsWith('taxi-malabo-') && c !== CACHE)
          .map((c) => caches.delete(c)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;
  if (peticion.method !== 'GET') return;

  const url = new URL(peticion.url);
  if (url.origin !== self.location.origin) return;

  // La API y el flujo de eventos, siempre a la red. Ver arriba: un estado de
  // viaje guardado es peor que ninguno.
  if (url.pathname.startsWith('/api/')) return;

  // Navegación: cualquier dirección devuelve la misma página, que es lo que
  // hace que la aplicación abra sin red. Se intenta la red primero para no
  // servir una versión vieja a quien sí tiene cobertura.
  if (peticion.mode === 'navigate') {
    evento.respondWith(
      fetch(peticion).catch(() => caches.match('/index.html').then(
        (guardada) => guardada ?? Response.error(),
      )),
    );
    return;
  }

  // El resto —código, estilos, el plano, el icono— de la caché primero: llevan
  // hash en el nombre, así que un fichero guardado no puede estar obsoleto. Si
  // no estuviera, se busca en la red y se guarda para la próxima.
  evento.respondWith(
    caches.match(peticion).then((guardada) => guardada ?? fetch(peticion).then((respuesta) => {
      if (respuesta.ok) {
        const copia = respuesta.clone();
        void caches.open(CACHE).then((cache) => cache.put(peticion, copia));
      }
      return respuesta;
    })),
  );
});

// --- Notificaciones web (migración 058) ------------------------------------
//
// Esto es lo único de la aplicación que funciona con la página CERRADA: el
// navegador despierta al service worker para entregar el aviso. De ahí que
// viva aquí y no en el código de React, que no existe hasta que alguien abre
// la aplicación.
//
// Solo lo usa el taxista: una carrera caduca en veinte segundos y hasta ahora,
// con el móvil bloqueado, se perdía sin que la viera.

self.addEventListener('push', (evento) => {
  // Sin datos no se enseña nada. Un servicio de push puede mandar un aviso
  // vacío para comprobar que la suscripción vive, y «Taxi Malabo» a secas en
  // la pantalla de bloqueo no informa de nada.
  if (!evento.data) return;

  let carga;
  try {
    carga = evento.data.json();
  } catch {
    return;
  }
  if (!carga || !carga.titulo) return;

  evento.waitUntil(
    self.registration.showNotification(carga.titulo, {
      body: carga.cuerpo ?? '',
      icon: '/icono-192.png',
      badge: '/favicon-32.png',
      // Vibración: es lo que se nota con el móvil en el soporte y la radio
      // puesta. Dos toques cortos, el mismo patrón que el aviso de carrera
      // dentro de la aplicación.
      vibrate: [120, 80, 120],
      // Que no se apile una notificación por oleada de la misma carrera: la
      // segunda sustituye a la primera.
      tag: carga.solicitudId ? `solicitud-${carga.solicitudId}` : carga.tipo,
      renotify: true,
      // Se queda en pantalla hasta que se toca. Una carrera que desaparece
      // sola a los cinco segundos no sirve para nada.
      requireInteraction: true,
      data: carga,
    }),
  );
});

// Al tocarla, a la aplicación. Si ya estaba abierta en alguna pestaña se trae
// esa al frente en lugar de abrir otra: dos paneles del mismo taxista mandando
// latidos a la vez es justo lo que no se quiere.
self.addEventListener('notificationclick', (evento) => {
  evento.notification.close();
  evento.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ventanas) => {
      for (const ventana of ventanas) {
        if (new URL(ventana.url).origin === self.location.origin) {
          return ventana.focus();
        }
      }
      return self.clients.openWindow('/');
    }),
  );
});
