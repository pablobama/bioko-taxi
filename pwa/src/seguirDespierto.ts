// Que la voz siga sonando con la aplicación en segundo plano (21/09).
//
// Lo pidió el taxista que la probó, y es el caso de todos los días: se abre el
// WhatsApp para contestar al pasajero, o se deja la pantalla apagarse en un
// semáforo, y la guía se calla justo cuando más falta hace.
//
// QUÉ SE PUEDE Y QUÉ NO, sin adornos:
//
//   - Aplicación en segundo plano con la pantalla ENCENDIDA (otra app
//     delante): el navegador congela la página a los pocos minutos… salvo que
//     esté sonando audio. Una página que suena se considera en uso y se la
//     deja viva. Eso es lo que hace esto: un sonido mudo en bucle mientras la
//     guía está encendida, que no se oye pero mantiene la página despierta y
//     con ella el GPS y la voz.
//
//   - Pantalla APAGADA: no hay nada que hacer en una PWA. Android congela el
//     proceso entero y ni el service worker tiene GPS. Es la misma frontera
//     que obligó a hacer la app nativa para grabar el recorrido. Por eso,
//     además del sonido mudo, se pide el bloqueo de pantalla (Wake Lock):
//     conduciendo con el móvil en el soporte, lo que se quiere es justo que
//     la pantalla no se apague.
//
// El sonido mudo no es un truco contra el usuario: la aplicación ESTÁ sonando
// —es una guía por voz— y solo se mantiene mientras la guía está encendida.

// 0,05 s de silencio a 8 kHz, 8 bits. Medio kilobyte en base64, dentro del
// propio código: un fichero suelto sería una petición más y una cosa más que
// puede faltar sin red.
const SILENCIO = 'data:audio/wav;base64,'
  + 'UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgI'
  + 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA'
  + 'gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'
  + 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA'
  + 'gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'
  + 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA'
  + 'gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI'
  + 'CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA'
  + 'gICAgICAgICAgICAgICAgICAgICAgICA';

let sonido: HTMLAudioElement | null = null;
let bloqueo: WakeLockSentinel | null = null;
let queremosSeguirDespiertos = false;

async function pedirBloqueo(): Promise<void> {
  try {
    // `wakeLock` no existe en todos los navegadores y solo se concede con la
    // página VISIBLE. Falla en silencio: sin él, todo lo demás sigue.
    const api = (navigator as Navigator & {
      wakeLock?: { request: (tipo: 'screen') => Promise<WakeLockSentinel> };
    }).wakeLock;
    if (!api || document.visibilityState !== 'visible') return;
    bloqueo = await api.request('screen');
    bloqueo.addEventListener('release', () => { bloqueo = null; });
  } catch {
    bloqueo = null;
  }
}

// Al volver a primer plano, el sistema ya ha soltado el bloqueo: hay que
// volver a pedirlo. El sonido, en cambio, sigue sonando solo.
function alCambiarVisibilidad(): void {
  if (queremosSeguirDespiertos && document.visibilityState === 'visible' && bloqueo === null) {
    void pedirBloqueo();
  }
}

// Enciende o apaga el «no te duermas». Debe llamarse desde un gesto de la
// persona la primera vez —entrar en servicio, encender la guía—: sin gesto
// previo el navegador no deja sonar nada, ni aunque sea silencio.
export function mantenerVivo(encendido: boolean): void {
  queremosSeguirDespiertos = encendido;
  if (encendido) {
    if (sonido === null) {
      sonido = new Audio(SILENCIO);
      sonido.loop = true;
      // Sin esto, iOS abre el reproductor a pantalla completa.
      sonido.setAttribute('playsinline', '');
      // Volumen mínimo y no cero: algunos navegadores tratan un elemento a
      // volumen cero como si no sonara, que es justo lo contrario de lo que se
      // busca. Es silencio grabado, así que no se oye de todas formas.
      sonido.volume = 0.01;
    }
    void sonido.play().catch(() => {
      // Sin gesto previo del usuario. No es grave: se reintenta la próxima vez
      // que toque algo, y mientras tanto la aplicación funciona como siempre.
    });
    document.addEventListener('visibilitychange', alCambiarVisibilidad);
    void pedirBloqueo();
    return;
  }

  document.removeEventListener('visibilitychange', alCambiarVisibilidad);
  if (sonido !== null) {
    sonido.pause();
    sonido.currentTime = 0;
  }
  if (bloqueo !== null) {
    void bloqueo.release().catch(() => undefined);
    bloqueo = null;
  }
}
