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
export function prepararSonido(): void {
  try {
    if (!contexto) {
      const Constructor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) return;
      contexto = new Constructor();
    }
    if (contexto.state === 'suspended') {
      void contexto.resume();
    }
  } catch {
    // Sin audio disponible: la app funciona igual, solo sin avisos sonoros.
    contexto = null;
  }
}

interface Nota {
  hz: number;
  desdeSeg: number;
  duracionSeg: number;
  volumen?: number;
}

function tocar(notas: Nota[]): void {
  if (silenciado) return;
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
function hablar(texto: string, locale: string): void {
  if (silenciado) return;
  try {
    const sintesis = window.speechSynthesis;
    if (!sintesis) return;
    // Sin esto, dos avisos seguidos se encolan y el segundo llega tarde.
    sintesis.cancel();
    const frase = new SpeechSynthesisUtterance(texto);
    frase.lang = locale;
    frase.rate = 0.95;
    const voces = sintesis.getVoices();
    const prefijo = locale.split('-')[0].toLowerCase();
    const enElIdioma = voces.find((v) => v.lang.toLowerCase().startsWith(prefijo));
    if (enElIdioma) frase.voice = enElIdioma;
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
