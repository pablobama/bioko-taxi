// Suscribirse a las notificaciones que suenan con la aplicación CERRADA
// (migración 058).
//
// Es el hueco que quedaba en el reparto: las carreras llegan por una conexión
// abierta, que existe mientras la pantalla está encendida y el navegador
// delante. Un taxista que bloquea el móvil o cierra el navegador no oía nada y
// la oferta le caducaba en veinte segundos. La app de Android lo resuelve con
// FCM; esto lo resuelve en cualquier navegador, y en el iPhone es la única vía
// que hay.
//
// Cuándo se pide el permiso: al ENTRAR EN SERVICIO, no al abrir la aplicación.
// Dos razones. La del navegador, que solo deja pedirlo desde un gesto de la
// persona. Y la de fondo: un cuadro de permisos en la primera pantalla, antes
// de que nadie sepa para qué es, se cierra con «bloquear» — y bloqueado no se
// vuelve a preguntar nunca más. Entrando en servicio, la pregunta llega justo
// cuando su respuesta se entiende: «avísame de las carreras».

import { api } from './api';

// La clave pública del servidor llega en base64url y la API del navegador
// quiere bytes.
function aBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = `${base64url.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - (base64url.length % 4)) % 4)}`;
  const crudo = atob(base64);
  // El buffer se reserva explícitamente para que el tipo sea `ArrayBuffer` y
  // no `ArrayBufferLike`: `applicationServerKey` no acepta memoria compartida.
  const bytes = new Uint8Array(new ArrayBuffer(crudo.length));
  for (let i = 0; i < crudo.length; i += 1) bytes[i] = crudo.charCodeAt(i);
  return bytes;
}

function aBase64(buffer: ArrayBuffer | null): string {
  if (!buffer) return '';
  let texto = '';
  for (const byte of new Uint8Array(buffer)) texto += String.fromCharCode(byte);
  return btoa(texto).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export type EstadoAviso = 'no_disponible' | 'bloqueado' | 'sin_pedir' | 'activo';

export function estadoAviso(): EstadoAviso {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // Safari en iOS solo lo tiene si la aplicación está INSTALADA en la
    // pantalla de inicio. No es un fallo que haya que enseñar como error: es
    // un motivo para recordarle que la instale.
    return 'no_disponible';
  }
  if (Notification.permission === 'denied') return 'bloqueado';
  return Notification.permission === 'granted' ? 'activo' : 'sin_pedir';
}

// Pide el permiso si hace falta, se suscribe y manda el buzón al servidor.
//
// Devuelve el estado en el que queda. No lanza: esto se llama al entrar en
// servicio y un fallo aquí no puede impedir empezar a trabajar — sin
// notificaciones se sigue recibiendo todo con la aplicación abierta, que es
// como funcionaba hasta ahora.
// ¿El buzón que ya hay se creó con la clave que este servidor usa ahora? El
// navegador guarda la clave con la que se suscribió, así que se puede comparar
// sin preguntarle a nadie.
function esDeEstaClave(suscripcion: PushSubscription, clavePublica: string): boolean {
  try {
    const suya = suscripcion.options?.applicationServerKey;
    // Sin dato no se puede saber. Se da por buena: tirar un buzón que a lo
    // mejor funciona es peor que dejarlo, porque volver a suscribirse puede
    // fallar y entonces no queda ninguno.
    if (!suya) return true;
    return aBase64(suya) === clavePublica.replace(/=+$/, '');
  } catch {
    return true;
  }
}

// `comoCliente`: el mismo mecanismo sirve para los dos, pero el buzón se
// guarda en un sitio distinto —al taxista se le busca por su ficha, al
// pasajero por el teléfono con el que pidió— y se le pregunta en momentos
// distintos: al taxista al entrar en servicio, al pasajero cuando se queda sin
// taxi, que es cuando la pregunta se entiende sola.
export async function activarAvisos(comoCliente = false): Promise<EstadoAviso> {
  if (estadoAviso() === 'no_disponible') return 'no_disponible';
  try {
    if (Notification.permission === 'default') {
      const respuesta = await Notification.requestPermission();
      if (respuesta !== 'granted') return respuesta === 'denied' ? 'bloqueado' : 'sin_pedir';
    } else if (Notification.permission === 'denied') {
      return 'bloqueado';
    }

    const registro = await navigator.serviceWorker.ready;
    const { clavePublica } = comoCliente
      ? await api.clavePushCliente()
      : await api.clavePush();
    // La que ya hubiera vale, y hay que reenviarla igual: el servidor puede
    // haberla borrado —el navegador contestó 410 una vez— mientras el buzón
    // sigue vivo en el teléfono.
    let suscripcion = await registro.pushManager.getSubscription();

    // PERO SOLO SI ES DE ESTE SERVIDOR. Un buzón se crea atado a una clave
    // concreta, y si la del servidor cambió, el servicio de push rechaza todos
    // los envíos con un 403. Reutilizarla sin mirar —que es lo que se hacía—
    // dejaba al taxista sin avisos PARA SIEMPRE: la suscripción existía, se
    // reenviaba tal cual en cada intento, y ninguno llegaba nunca.
    if (suscripcion !== null && !esDeEstaClave(suscripcion, clavePublica)) {
      await suscripcion.unsubscribe().catch(() => undefined);
      suscripcion = null;
    }

    if (suscripcion === null) {
      suscripcion = await registro.pushManager.subscribe({
        // Obligatorio en todos los navegadores: sin esto la suscripción
        // permitiría mandar avisos silenciosos, que es rastreo.
        userVisibleOnly: true,
        applicationServerKey: aBytes(clavePublica),
      });
    }
    const guardar = comoCliente ? api.guardarPushCliente : api.guardarPush;
    await guardar({
      endpoint: suscripcion.endpoint,
      claves: {
        p256dh: aBase64(suscripcion.getKey('p256dh')),
        auth: aBase64(suscripcion.getKey('auth')),
      },
    });
    return 'activo';
  } catch {
    // Permiso concedido pero suscripción fallida (sin red al pedir la clave,
    // un navegador sin servicio de push configurado): se queda como estaba y
    // se volverá a intentar la próxima vez que entre en servicio.
    return estadoAviso();
  }
}

// Baja: al salir de servicio NO se da de baja a propósito —las carreras dejan
// de llegarle igual, y volver a suscribirse cada turno gasta batería y puede
// volver a preguntar—. Esto es para cuando alguien apaga los avisos a mano.
export async function apagarAvisos(): Promise<void> {
  try {
    const registro = await navigator.serviceWorker.ready;
    const suscripcion = await registro.pushManager.getSubscription();
    if (suscripcion === null) return;
    await api.borrarPush(suscripcion.endpoint).catch(() => undefined);
    await suscripcion.unsubscribe();
  } catch {
    // Nada que hacer: sin suscripción no llegan avisos, que es lo pedido.
  }
}
