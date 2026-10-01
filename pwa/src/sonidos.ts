// Avisos sonoros.
//
// Se sintetizan con Web Audio en lugar de traer ficheros de audio: cero bytes
// de descarga y ningún problema de formatos entre navegadores.
//
// Los navegadores no permiten sonar antes de que el usuario toque algo, así que
// el contexto se crea (y se reanuda) en la primera interacción. Si el usuario
// nunca toca nada, no habrá sonido: es una limitación del navegador, no un
// fallo. Por eso ningún aviso importante depende SOLO del sonido.

let contexto: AudioContext | null = null;
let silenciado = localStorage.getItem('silenciado') === 'si';

export function estaSilenciado(): boolean {
  return silenciado;
}

export function alternarSilencio(): boolean {
  silenciado = !silenciado;
  localStorage.setItem('silenciado', silenciado ? 'si' : 'no');
  return silenciado;
}

// Debe llamarse desde un gesto del usuario (un clic). Idempotente.
// En iOS, el interruptor físico del lateral CALLA la Web Audio API aunque el
// volumen esté alto. Es la causa más frecuente de «no se oye nada en el iPhone»
// y desde fuera parece un fallo de la aplicación: el taxista ve los mensajes
// entrar y no suena ninguno.
//
// `audioSession` (Safari 16.4+) es la salida: declara que esto es
// REPRODUCCIÓN —como un reproductor de música— y no un pitido de interfaz, y
// entonces iOS lo deja sonar con el interruptor puesto. No está en los tipos de
// TypeScript porque solo existe en Safari, de ahí el acceso a mano.
//
// Se hace una sola vez y no rompe nada donde no existe.
// El tipo de sesión de audio que declara la página ante iOS.
//
// Y ES UN EQUILIBRIO, no una constante. Poner «playback» es lo que hace que los
// avisos suenen con el interruptor de silencio puesto —sin eso, en un iPhone no
// se oye nada y la aplicación parece muda—. Pero una sesión de reproducción NO
// PERMITE GRABAR: `getUserMedia` la rechaza con `InvalidStateError`, que es
// exactamente lo que empezó a pasarle al walkie-talkie el día que se arregló el
// sonido. Un arreglo rompió el otro, y costó tres días verlo porque el nombre
// de la excepción no señalaba aquí.
//
// Así que el tipo cambia según lo que se esté haciendo: reproducción mientras
// solo se escucha, y «play-and-record» mientras se habla por la radio. Se
// vuelve al primero en cuanto se suelta el micrófono, porque ese es el estado
// en el que la aplicación pasa el 99 % del tiempo y es el que no se puede
// perder.
type TipoSesion = 'playback' | 'play-and-record';

let tipoDeseado: TipoSesion = 'playback';

function aplicarTipoDeSesion(): void {
  try {
    const sesion = (navigator as unknown as {
      audioSession?: { type: string };
    }).audioSession;
    if (sesion && sesion.type !== tipoDeseado) sesion.type = tipoDeseado;
  } catch {
    // Navegador que no lo tiene o no deja cambiarlo: se sigue igual.
  }
}

function declararReproduccion(): void {
  aplicarTipoDeSesion();
}

// Antes de abrir el micrófono. Hay que llamarlo DENTRO del mismo gesto que va a
// pedir `getUserMedia`: cambiar el tipo después ya no sirve de nada.
export function permitirGrabar(): void {
  tipoDeseado = 'play-and-record';
  aplicarTipoDeSesion();
}

// Al soltar el micrófono. Volver a «playback» no es cosmética: es lo que
// devuelve el sonido con el interruptor de silencio puesto, que es como está
// casi siempre el teléfono de un taxista.
export function volverAReproducir(): void {
  tipoDeseado = 'playback';
  aplicarTipoDeSesion();
}

// El contexto se queda SUSPENDIDO cuando la aplicación se va al fondo, y al
// volver no se reanuda solo. En una PWA instalada eso pasa todo el rato —se
// bloquea la pantalla, se mira un mensaje, se vuelve— y el resultado es una
// aplicación que sonaba al abrirla y deja de sonar sin motivo aparente.
//
// Se engancha una sola vez, la primera que se prepara el sonido.
let vigilandoVuelta = false;

function despertarAlVolver(): void {
  if (vigilandoVuelta) return;
  vigilandoVuelta = true;
  const despertar = () => {
    if (document.visibilityState !== 'visible') return;
    declararReproduccion();
    if (contexto && contexto.state === 'suspended') void contexto.resume();
  };
  document.addEventListener('visibilitychange', despertar);
  // `pageshow` cubre la vuelta desde la caché de atrás/adelante de Safari, que
  // no dispara `visibilitychange`.
  window.addEventListener('pageshow', despertar);
}

export function prepararSonido(): void {
  try {
    declararReproduccion();
    despertarAlVolver();
    // Un contexto CERRADO no se puede reanudar y todo lo que se le pida lanza
    // `InvalidStateError`. iOS lo cierra solo tras una llamada entrante o un
    // rato en segundo plano. Se tira y se hace otro.
    if (contexto && contexto.state === 'closed') contexto = null;
    if (!contexto) {
      const Constructor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) return;
      contexto = new Constructor();
    }
    if (contexto.state === 'suspended') {
      void contexto.resume();
    }
    prepararReproductor();
  } catch {
    // Sin audio disponible: la app funciona igual, solo sin avisos sonoros.
    contexto = null;
  }
}

// --- Reproducir voz grabada (la radio del gremio) --------------------------
//
// Los mensajes de voz NO van por la Web Audio API: son un fichero de audio, y
// se reproducen con un elemento `<audio>`. Esa es otra vía y tiene su propia
// pega en iOS: un elemento creado FUERA de un gesto del usuario no puede sonar,
// nunca, por mucho que se le llame `play()`. Y un mensaje de radio entra
// precisamente cuando el usuario no está tocando nada.
//
// Por eso hay UN solo elemento, creado y desbloqueado en el primer toque —el
// mismo gesto que arranca el contexto— y reutilizado para todos los mensajes.
// Una vez desbloqueado, ese elemento sí puede sonar sin gesto.
let reproductor: HTMLAudioElement | null = null;

function prepararReproductor(): void {
  if (reproductor !== null) return;
  try {
    const elemento = document.createElement('audio');
    // `playsinline`: sin esto, iOS puede abrir el reproductor a pantalla
    // completa y tapar la pantalla del taxista con un mensaje de cuatro
    // segundos. Como atributo y no como propiedad: en los tipos solo existe
    // para vídeo, aunque Safari lo mira igual en el audio.
    elemento.setAttribute('playsinline', '');
    elemento.preload = 'auto';
    reproductor = elemento;
    // El desbloqueo: se le manda sonar un silencio muy corto dentro del gesto.
    // A partir de aquí el elemento queda «tocado por el usuario» y ya puede
    // reproducir lo que le echen.
    elemento.src = SILENCIO;
    void elemento.play().then(() => {
      elemento.pause();
      elemento.currentTime = 0;
    }).catch(() => {
      // No se pudo desbloquear ahora: se intentará en el siguiente gesto, y
      // mientras tanto reproducir puede fallar. No hay nada que romper.
    });
  } catch {
    reproductor = null;
  }
}

// Un wav mínimo y mudo, en línea. Un fichero aparte serían bytes de descarga y
// una petición más para algo que no se oye.
const SILENCIO = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=';

// Reproduce un audio recibido y avisa cuando termina. Devuelve en cuanto acaba
// —o en cuanto falla— para que quien llama pueda encadenar el siguiente sin
// que se pisen dos voces.
export async function reproducirVoz(audio: Blob): Promise<void> {
  if (silenciado) return;
  prepararSonido();
  const elemento = reproductor;
  if (elemento === null) return;
  const url = URL.createObjectURL(audio);
  try {
    elemento.src = url;
    await new Promise<void>((listo) => {
      const acabar = () => {
        elemento.onended = null;
        elemento.onerror = null;
        listo();
      };
      elemento.onended = acabar;
      elemento.onerror = acabar;
      void elemento.play().catch(acabar);
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface Nota {
  hz: number;
  desdeSeg: number;
  duracionSeg: number;
  volumen?: number;
}

// UN PITIDO NO PUEDE ROMPER NADA. Esto no es una precaución teórica: en un
// iPhone, `createOscillator()` lanza `InvalidStateError` cuando el contexto de
// audio se quedó cerrado —una llamada entrante, la página al fondo—, y ese
// error salía disparado hacia arriba. Como el pitido de «adelante, habla» se
// toca dentro del mismo bloque que abre el micrófono, un pitido fallido
// abortaba el habla ENTERA: el taxista veía «no se pudo pedir la palabra» con
// el turno ya concedido y la grabadora ya en marcha.
//
// El sonido es un adorno; lo que no puede es llevarse por delante la función.
function tocar(notas: Nota[]): void {
  if (silenciado) return;
  try {
    tocarDeVerdad(notas);
  } catch {
    // Sin sonido se sigue: la pantalla y la vibración ya lo dicen.
  }
}

function tocarDeVerdad(notas: Nota[]): void {
  prepararSonido();
  if (!contexto) return;
  const ahora = contexto.currentTime;

  for (const nota of notas) {
    const oscilador = contexto.createOscillator();
    const ganancia = contexto.createGain();
    oscilador.type = 'sine';
    oscilador.frequency.value = nota.hz;

    const inicio = ahora + nota.desdeSeg;
    const fin = inicio + nota.duracionSeg;
    const pico = nota.volumen ?? 0.22;
    // Ataque y caída suaves: sin ellos se oye un chasquido.
    ganancia.gain.setValueAtTime(0, inicio);
    ganancia.gain.linearRampToValueAtTime(pico, inicio + 0.02);
    ganancia.gain.exponentialRampToValueAtTime(0.0001, fin);

    oscilador.connect(ganancia).connect(contexto.destination);
    oscilador.start(inicio);
    oscilador.stop(fin + 0.02);
  }
}

// Vibración como refuerzo: en un bolsillo, con ruido de calle, el sonido solo
// no basta. No todos los navegadores la tienen.
function vibrar(patron: number[]): void {
  if (silenciado) return;
  try {
    navigator.vibrate?.(patron);
  } catch {
    // Sin vibración: nada que hacer.
  }
}

// Voz del navegador. Cuesta cero bytes de descarga y permite decir el destino,
// que es la información que el taxista necesita sin soltar el volante.
//
// No siempre hay voz en español instalada. Si no la hay, se usa la que haya; si
// no hay ninguna, no se dice nada. Por eso el tono suena SIEMPRE antes de
// hablar: el aviso no puede depender de que el teléfono sepa hablar español.
// Exportada desde la guía por voz (20/09): las instrucciones de giro
// son texto sin tono previo —un «gire a la derecha» no necesita anunciarse— y
// necesitan este mismo trato con las voces que falten.
// Nombres de voz masculina de los motores que se ven en la calle: Android
// (Google), iOS/macOS (Apple) y Windows (Microsoft). No hay forma estándar de
// preguntarle a una voz si es de hombre o de mujer —`SpeechSynthesisVoice` no
// lo dice—, así que se va por el nombre, que es lo único que hay.
//
// Y se mira el nombre ENTERO en minúsculas: en Android las voces se llaman
// «español de España» sin más, y ahí no hay nada que elegir; en iOS sí hay
// «Jorge» y «Diego», y en Windows «Pablo» y «Raul».
const VOCES_DE_HOMBRE = [
  'jorge', 'diego', 'carlos', 'juan', 'pablo', 'raul', 'raúl', 'miguel', 'enrique',
  'thomas', 'nicolas', 'daniel', 'male', 'hombre', 'masculin',
];

// Elige la mejor voz para un idioma: del idioma pedido, de hombre si la hay y
// preferiblemente instalada en el teléfono (`localService`), que es la que
// suena sin red y sin retraso.
function mejorVoz(voces: SpeechSynthesisVoice[], locale: string): SpeechSynthesisVoice | null {
  const prefijo = locale.split('-')[0].toLowerCase();
  const delIdioma = voces.filter((v) => v.lang.toLowerCase().startsWith(prefijo));
  if (delIdioma.length === 0) return null;
  const puntos = (v: SpeechSynthesisVoice): number => {
    const nombre = v.name.toLowerCase();
    let total = 0;
    if (VOCES_DE_HOMBRE.some((n) => nombre.includes(n))) total += 4;
    // Las «neural», «natural» o «enhanced» son las que no suenan a robot.
    if (/neural|natural|enhanced|premium/.test(nombre)) total += 2;
    if (v.localService) total += 1;
    // Exactamente el locale pedido antes que otro español cualquiera.
    if (v.lang.toLowerCase().replace('_', '-') === locale.toLowerCase()) total += 1;
    return total;
  };
  return delIdioma.reduce((mejor, v) => (puntos(v) > puntos(mejor) ? v : mejor), delIdioma[0]);
}

export function hablar(texto: string, locale: string): void {
  if (silenciado) return;
  try {
    const sintesis = window.speechSynthesis;
    if (!sintesis) return;
    // Sin esto, dos avisos seguidos se encolan y el segundo llega tarde.
    sintesis.cancel();
    const frase = new SpeechSynthesisUtterance(texto);
    frase.lang = locale;
    // Más despacio y más grave que la voz de fábrica. Probado conduciendo: a
    // velocidad normal (1) y tono normal la frase se atropella con el ruido
    // del coche y hay que adivinar si dijo «derecha» o «izquierda», que son
    // las dos palabras que importan. 0,85 en las dos cosas es lo que hace que
    // se entienda a la primera sin sonar a cámara lenta.
    frase.rate = 0.85;
    frase.pitch = 0.85;
    const elegida = mejorVoz(sintesis.getVoices(), locale);
    if (elegida) frase.voice = elegida;
    sintesis.speak(frase);
  } catch {
    // Sin voz: queda el tono y la vibración.
  }
}

// --- Avisos del pasajero --------------------------------------------------

interface Frases {
  enCamino: (m: string) => string;
  enCaminoSinMatricula: string;
  esperando: (m: string) => string;
  esperandoSinMatricula: string;
  nuevoServicio: (d: string) => string;
  servicio: string;
  // Antes solo se avisaba de las dos noticias buenas —taxi asignado, taxi
  // esperando—. Las dos malas —no hay taxi, el taxista canceló— se quedaban
  // calladas: solo un texto en pantalla, que no sirve de nada si el teléfono
  // está en el bolsillo. Para alguien de pie en la calle esperando, esa es la
  // información que más falta hace: saber que hay que volver a pedir, sin
  // tener que mirar.
  sinTaxi: string;
  conductorCancelo: string;
  // El taxista, cuando el pasajero cancela un viaje ya aceptado: puede llevar
  // un rato conduciendo hacia un punto de recogida que ya no existe.
  carreraCancelada: string;
  // Llamada entrante: un texto genérico a propósito. La pantalla ya dice de
  // quién es («Tu taxista» / «Tu pasajero»); la voz solo tiene que hacer que
  // se mire el teléfono.
  llamadaEntrante: string;
}

const FRASES: Record<string, Frases> = {
  'es-ES': {
    enCamino: (m) => `Tu taxi va en camino. Matrícula ${m}.`,
    enCaminoSinMatricula: 'Tu taxi va en camino.',
    esperando: (m) => `Tu taxi te está esperando. Matrícula ${m}.`,
    esperandoSinMatricula: 'Tu taxi te está esperando.',
    nuevoServicio: (d) => `Tienes un servicio hacia ${d}.`,
    servicio: 'Tienes un servicio.',
    sinTaxi: 'Ahora no hay taxi. Vuelve a intentarlo en unos minutos.',
    conductorCancelo: 'El taxista canceló. Vuelve a pedir.',
    carreraCancelada: 'El pasajero canceló. Sigues disponible.',
    llamadaEntrante: 'Tienes una llamada.',
  },
  'fr-FR': {
    enCamino: (m) => `Ton taxi est en route. Plaque ${m}.`,
    enCaminoSinMatricula: 'Ton taxi est en route.',
    esperando: (m) => `Ton taxi t'attend. Plaque ${m}.`,
    esperandoSinMatricula: 'Ton taxi t’attend.',
    nuevoServicio: (d) => `Tu as une course vers ${d}.`,
    servicio: 'Tu as une course.',
    sinTaxi: 'Pas de taxi pour l’instant. Réessaie dans quelques minutes.',
    conductorCancelo: 'Le chauffeur a annulé. Commande à nouveau.',
    carreraCancelada: 'Le passager a annulé. Tu es de nouveau disponible.',
    llamadaEntrante: 'Tu as un appel.',
  },
  'en-US': {
    enCamino: (m) => `Your taxi is on its way. Plate ${m}.`,
    enCaminoSinMatricula: 'Your taxi is on its way.',
    esperando: (m) => `Your taxi is waiting for you. Plate ${m}.`,
    esperandoSinMatricula: 'Your taxi is waiting for you.',
    nuevoServicio: (d) => `You have a ride to ${d}.`,
    servicio: 'You have a ride.',
    sinTaxi: 'No taxi right now. Try again in a few minutes.',
    conductorCancelo: 'The driver cancelled. Order again.',
    carreraCancelada: 'The passenger cancelled. You’re available again.',
    llamadaEntrante: 'You have a call.',
  },
};

// El taxi ha aceptado y viene de camino: dos notas ascendentes, tranquilas.
export function sonarTaxiEnCamino(matricula?: string | null, locale = 'es-ES'): void {
  tocar([
    { hz: 587.33, desdeSeg: 0, duracionSeg: 0.18 },
    { hz: 880.0, desdeSeg: 0.16, duracionSeg: 0.3 },
  ]);
  vibrar([120]);
  const f = FRASES[locale] ?? FRASES['es-ES'];
  hablar(matricula ? f.enCamino(deletrearMatricula(matricula)) : f.enCaminoSinMatricula, locale);
}

// El taxi ya está en el punto de recogida: más brillante y repetido, porque es
// el momento de salir a la calle.
export function sonarTaxiEsperando(matricula?: string | null, locale = 'es-ES'): void {
  tocar([
    { hz: 880.0, desdeSeg: 0, duracionSeg: 0.16, volumen: 0.26 },
    { hz: 1174.66, desdeSeg: 0.15, duracionSeg: 0.16, volumen: 0.26 },
    { hz: 1318.51, desdeSeg: 0.3, duracionSeg: 0.42, volumen: 0.26 },
    { hz: 880.0, desdeSeg: 0.85, duracionSeg: 0.16, volumen: 0.2 },
    { hz: 1318.51, desdeSeg: 1.0, duracionSeg: 0.36, volumen: 0.2 },
  ]);
  vibrar([180, 90, 180]);
  const f = FRASES[locale] ?? FRASES['es-ES'];
  hablar(matricula ? f.esperando(deletrearMatricula(matricula)) : f.esperandoSinMatricula, locale);
}

// Las matrículas se leen fatal de corrido: «GE-7007-T» sonaría «ge siete mil
// siete te». Separada, se entiende.
function deletrearMatricula(matricula: string): string {
  return matricula.replace(/-/g, ' ').split('').join(' ');
}

// Dos notas descendentes: lo contrario del «taxi en camino» (que sube). No
// hace falta oír la voz para saber si la noticia es buena o mala; el tono ya
// lo dice, igual que el clásico «no va a poder ser» de un teléfono de verdad.
function tocarNegativo(): void {
  tocar([
    { hz: 587.33, desdeSeg: 0, duracionSeg: 0.2, volumen: 0.22 },
    { hz: 392.0, desdeSeg: 0.22, duracionSeg: 0.36, volumen: 0.22 },
  ]);
  vibrar([250]);
}

// No hay taxi disponible ahora mismo. El pasajero suele estar de pie en la
// calle con el teléfono guardado; sin este aviso no sabe que tiene que volver
// a pedir hasta que mira la pantalla por su cuenta.
export function sonarSinTaxi(locale = 'es-ES'): void {
  tocarNegativo();
  const f = FRASES[locale] ?? FRASES['es-ES'];
  hablar(f.sinTaxi, locale);
}

// El taxista canceló un viaje ya aceptado.
export function sonarConductorCancelo(locale = 'es-ES'): void {
  tocarNegativo();
  const f = FRASES[locale] ?? FRASES['es-ES'];
  hablar(f.conductorCancelo, locale);
}

// --- Aviso del taxista ----------------------------------------------------

// Nueva carrera. Suena mientras conduce, así que el tono tiene que
// reconocerse sin mirar, y la voz dice a dónde va sin que suelte el volante.
export function sonarNuevaCarrera(destino?: string | null, locale = 'es-ES'): void {
  tocar([
    { hz: 1046.5, desdeSeg: 0, duracionSeg: 0.13, volumen: 0.3 },
    { hz: 1046.5, desdeSeg: 0.2, duracionSeg: 0.13, volumen: 0.3 },
    { hz: 1396.91, desdeSeg: 0.4, duracionSeg: 0.34, volumen: 0.3 },
  ]);
  vibrar([200, 100, 200, 100, 300]);
  const f = FRASES[locale] ?? FRASES['es-ES'];
  hablar(destino ? f.nuevoServicio(destino) : f.servicio, locale);
}

// El pasajero canceló un viaje que el taxista ya tenía aceptado: puede llevar
// un rato conduciendo hacia una recogida que ya no existe.
export function sonarCarreraCancelada(locale = 'es-ES'): void {
  tocarNegativo();
  const f = FRASES[locale] ?? FRASES['es-ES'];
  hablar(f.carreraCancelada, locale);
}

// --- Llamada entrante (los dos roles) --------------------------------------

// Solo el tono, para el timbre que se repite mientras suena: la voz se dice
// una vez al principio, no en cada repetición.
export function sonarTimbreLlamada(): void {
  tocar([
    { hz: 740.0, desdeSeg: 0, duracionSeg: 0.28, volumen: 0.24 },
    { hz: 740.0, desdeSeg: 0.36, duracionSeg: 0.28, volumen: 0.24 },
  ]);
  vibrar([160, 90, 160]);
}

// El anuncio hablado, una sola vez al empezar a sonar: con el teléfono en el
// bolsillo o mirando la carretera, es lo único que avisa de que está entrando
// una llamada.
export function anunciarLlamadaEntrante(locale = 'es-ES'): void {
  const f = FRASES[locale] ?? FRASES['es-ES'];
  hablar(f.llamadaEntrante, locale);
}

// Tono de retorno para quien LLAMA, mientras espera respuesta. Sin él, llamar
// era mirar un «Llamando…» en silencio absoluto: imposible saber si la
// llamada va, y de hecho la gente colgaba pensando que no funcionaba. Un
// zumbido largo y grave, como el de un teléfono de verdad; se repite desde
// llamada.ts mientras dure la espera. Sin vibración: quien llama ya tiene el
// teléfono en la mano.
export function sonarTonoLlamando(): void {
  tocar([
    { hz: 425.0, desdeSeg: 0, duracionSeg: 1.0, volumen: 0.14 },
  ]);
}

// --- La radio del gremio (migración 075) ------------------------------------

// En una radio de verdad el pitido es lo que te dice que puedes hablar sin tener
// que mirar nada. Aquí eso no es un adorno: el taxista está conduciendo, y si
// para saber si tiene la palabra hay que leer la pantalla, entonces la radio
// obliga a apartar la vista de la carretera. Dos notas subiendo: adelante.
export function sonarRadioAdelante(): void {
  tocar([
    { hz: 880.0, desdeSeg: 0, duracionSeg: 0.07, volumen: 0.2 },
    { hz: 1320.0, desdeSeg: 0.08, duracionSeg: 0.09, volumen: 0.2 },
  ]);
  vibrar([40]);
}

// Y dos bajando: está ocupado, espera. Distinto del de arriba a propósito —no
// basta con «un pitido»— porque lo que hay que hacer en cada caso es lo
// contrario.
export function sonarRadioOcupada(): void {
  tocar([
    { hz: 440.0, desdeSeg: 0, duracionSeg: 0.1, volumen: 0.18 },
    { hz: 294.0, desdeSeg: 0.12, duracionSeg: 0.16, volumen: 0.18 },
  ]);
  vibrar([90, 60, 90]);
}

// El aviso de que entra alguien hablando, el «clic» de antes de la voz. Corto y
// seco: va pegado al mensaje, y alargarlo sería comerse la primera palabra.
export function sonarRadioEntra(): void {
  tocar([
    { hz: 1046.0, desdeSeg: 0, duracionSeg: 0.06, volumen: 0.16 },
  ]);
}
