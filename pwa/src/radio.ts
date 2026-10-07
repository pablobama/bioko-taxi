// La radio del gremio en el teléfono del taxista (migración 075).
//
// Se aprieta, se habla, se suelta. Medio dúplex: mientras uno habla los demás
// escuchan, y el turno lo reparte el servidor —una fila por canal— para que dos
// no hablen encima.
//
// LO QUE CUESTA, que aquí es lo primero: el audio va a 20 kbps, igual que las
// llamadas, así que diez segundos son 25 KB. Lo bueno de que hable uno solo es
// que ese gasto no depende de cuántos sean: con quince conectados o con
// doscientos, tu teléfono baja lo mismo.
//
// LO QUE NO HACE, dicho aquí para que nadie lo descubra en la carretera: con la
// pantalla bloqueada esto NO suena. El navegador congela el JavaScript de la
// página al bloquear, y ni el service worker puede grabar ni reproducir por su
// cuenta. Para que la radio suene conduciendo hace falta la app Android, que es
// donde además el botón de volumen puede hacer de botón de hablar. Eso es el
// paso siguiente; esto de aquí sirve con la aplicación delante.

import { useCallback, useEffect, useRef, useState } from 'react';
import { type PuertaRadio, api, bajarVozRadio, type EstadoRadio, type MensajeRadio } from './api';
import { esFalloDeMicrofono } from './llamada';
import {
  permitirGrabar, reproducirVoz, sonarRadioAdelante, sonarRadioEntra,
  sonarRadioOcupada, volverAReproducir,
} from './sonidos';

// Voz, no música. El mismo caudal que las llamadas y por el mismo motivo: aquí
// los datos son dinero del taxista.
const BITRATE = 20_000;
const RESTRICCIONES: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
};

// Menos que esto no es un mensaje, es un roce del dedo. Se descarta sin mandarlo:
// una radio llena de mensajes de dos décimas es una radio que nadie escucha.
const MINIMO_MS = 400;

function formatoSoportado(): string {
  // Chrome y Firefox dan webm/opus; Safari, mp4. Se pregunta en vez de imponer:
  // pedir un formato que el navegador no sabe grabar es quedarse sin radio.
  for (const tipo of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(tipo)) return tipo;
  }
  return '';
}

// ¿Puede este navegador grabar voz? Y si no, POR QUÉ.
//
// Hacía falta porque esto fallaba en silencio: la función existía y no la
// llamaba nadie, así que en un teléfono que no puede grabar el botón se
// enseñaba igual, pedía el turno, reventaba, y el taxista leía «no se pudo
// pedir la palabra, inténtalo otra vez» — que le manda a repetir algo que no va
// a funcionar nunca.
//
// El caso que lo destapó es de iOS: en la aplicación INSTALADA en la pantalla
// de inicio, `navigator.mediaDevices` no existe en las versiones anteriores a
// la 17.4, así que no hay forma de grabar por mucho permiso que se dé. Abriendo
// la misma página en Safari sí funciona. Eso hay que decirlo, no esconderlo.
export type PuedeGrabar = 'si' | 'sin_micro' | 'sin_grabadora';

// Qué decir cuando el fallo no es ninguno de los conocidos.
//
// Nunca «inténtalo otra vez» a secas. Eso fue lo que se leyó en un iPhone
// durante días mientras el problema era otro —el servidor contestaba que el
// canal estaba ocupado y el cliente lo convertía en un error sin cuerpo—, y un
// mensaje que manda a repetir esconde justo lo que hay que arreglar. Si no se
// sabe qué pasó, se dice lo que contestó el servidor.
// Envuelve un paso para que, si revienta, se sepa CUÁL reventó. El error
// original se conserva entero: solo se le cuelga una etiqueta.
const DONDE: Record<string, string> = {
  turno: 'pidiendo la palabra',
  micro: 'abriendo el micrófono',
  grabadora: 'preparando la grabadora',
  arrancar: 'arrancando la grabación',
};

async function paso<T>(cual: string, hacer: () => Promise<T> | T): Promise<T> {
  try {
    return await hacer();
  } catch (error) {
    if (error && typeof error === 'object') {
      (error as { pasoRadio?: string }).pasoRadio = cual;
    }
    throw error;
  }
}

function mensajeDeFallo(error: unknown): string {
  const e = error as {
    name?: string; estado?: number; message?: string; pasoRadio?: string;
  } | null;
  const donde = e?.pasoRadio ? ` ${DONDE[e.pasoRadio] ?? e.pasoRadio}` : '';
  if (e?.name === 'ErrorDelServidor') {
    return `El servidor no dio la palabra (${e.estado}). ${e.message ?? ''}`.trim();
  }
  if (e?.name === 'NotSupportedError') {
    return 'Este navegador no sabe grabar voz en ningún formato.';
  }
  return `Falló${donde}${e?.name ? ` (${e.name})` : ''}.`;
}

// ¿Está corriendo dentro de la aplicación INSTALADA, y no en el navegador?
//
// Importa porque ahí es donde iOS no deja grabar: `navigator.mediaDevices`
// existe y `getUserMedia` hasta pide el permiso, pero luego rechaza con
// `InvalidStateError`. Medido en un iPhone el 30/09, con el mensaje por pasos
// que se puso justo para esto: «falló abriendo el micrófono». Abriendo la misma
// página en Safari sí funciona.
export function esAplicacionInstalada(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches
      || (navigator as unknown as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

// Un aparato que ya demostró que no puede grabar se recuerda: volver a
// preguntárselo es quitarle el turno al gremio para fallar igual.
// La clave lleva versión a propósito, y ésta es la tercera. Cada vez que cambia
// QUÉ se estaba apuntando, los apuntes viejos dejan de significar lo que decían
// y hay que darle otra oportunidad a todo el mundo; estrenar clave es más limpio
// que ir borrando.
//
//   v2 — se apuntó mientras la aplicación declaraba una sesión de audio que no
//        permitía grabar, así que marcaba teléfonos que sí podían.
//   v3 — se apuntaba ante CUALQUIER fallo del micrófono, así que marcaba a quien
//        dijo que no al permiso una vez, o a quien apretó mientras hablaba por
//        teléfono. Todos esos apuntes son falsos y tienen que caer.
const CLAVE_NO_PUEDE = 'radio:sinMicrofono3';

// QUÉ FALLOS SIGNIFICAN «AQUÍ NO SE PUEDE» Y CUÁLES NO. Esta distinción es todo
// el arreglo del 02/10, y nació de que la radio «se deshizo» en un iPhone donde
// llevaba días funcionando.
//
// Antes se apuntaba el aparato como mudo ante CUALQUIER fallo al abrir el
// micrófono. Pero casi ninguno de esos fallos quiere decir que el aparato no
// pueda:
//
//   · NotAllowedError ..... dijo que NO al permiso. Puede decir que sí mañana.
//   · NotReadableError .... el micrófono está cogido AHORA. Un taxista recibe
//     llamadas: durante una llamada, el micrófono es del teléfono. Al colgar
//     vuelve a estar libre.
//   · AbortError / NotFoundError … lo mismo, mala suerte momentánea.
//
// Y el apunte no caducaba ni se podía quitar desde ningún sitio. Así que una
// llamada entrante en el momento de apretar, o un «no» al permiso, convertía la
// aplicación instalada en un receptor para siempre. Eso no es un diagnóstico,
// es una condena.
//
// InvalidStateError sí lo es: es el fallo medido el 30/09 en la aplicación
// instalada de iOS, donde `getUserMedia` pide el permiso y después rechaza pase
// lo que pase. Solo ése se apunta — y aun así se puede deshacer, porque iOS
// cambia con cada versión y una medida de un día no puede valer para siempre.
const FALLOS_DEFINITIVOS = ['InvalidStateError', 'NotSupportedError'];

export function esFalloDefinitivo(error: unknown): boolean {
  const nombre = (error as { name?: string } | null)?.name;
  return nombre !== undefined && FALLOS_DEFINITIVOS.includes(nombre);
}

export function recordarQueNoPuedeGrabar(): void {
  try {
    localStorage.setItem(CLAVE_NO_PUEDE, esAplicacionInstalada() ? 'instalada' : 'si');
  } catch {
    // Sin almacenamiento se vuelve a intentar la próxima vez.
  }
}

// La vuelta atrás. La pide la persona desde el botón «volver a probar», que es
// lo que faltaba: sin ella, el único camino conocido para recuperar la radio
// era desinstalar la aplicación y volver a instalarla.
export function olvidarQueNoPuedeGrabar(): void {
  try {
    localStorage.removeItem(CLAVE_NO_PUEDE);
  } catch {
    // Si no se puede escribir, tampoco se pudo apuntar: no hay nada que quitar.
  }
}

export function radioDisponible(): PuedeGrabar {
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') return 'sin_micro';
  if (typeof MediaRecorder === 'undefined') return 'sin_grabadora';
  try {
    // Lo que ya se sabe de este aparato, y solo mientras siga en la aplicación
    // instalada: el mismo teléfono abierto en el navegador SÍ puede.
    if (localStorage.getItem(CLAVE_NO_PUEDE) === 'instalada' && esAplicacionInstalada()) {
      return 'sin_micro';
    }
  } catch {
    // Sin almacenamiento, se intenta.
  }
  return 'si';
}

export type EstadoBoton =
  // Se puede hablar.
  | 'libre'
  // Se pidió la palabra y no ha contestado el servidor todavía.
  | 'pidiendo'
  // Tengo la palabra y estoy grabando.
  | 'hablando'
  // Solté y se está subiendo.
  | 'enviando'
  // Habla otro.
  | 'ocupado';

export interface UsoRadio {
  estado: EstadoBoton;
  encendida: boolean;
  // Si este navegador puede grabar. Cuando no puede, el botón no se enseña
  // como si fuera a funcionar.
  puedeGrabar: PuedeGrabar;
  // Quién tiene la palabra ahora, sea yo o sea otro.
  habla: string | null;
  // Segundos que me quedan de mi turno, para que se vea que se acaba.
  quedan: number;
  segundosMax: number;
  mensajes: MensajeRadio[];
  // El último aviso que hay que enseñar: «habla Pablo», «no hay micrófono»…
  aviso: string | null;
  // A cuántos llegó lo último que dije. Hablar solo y no saberlo es lo peor que
  // le puede pasar a una radio.
  oyentes: number | null;
  apretar: () => void;
  soltar: () => void;
  volverAOir: (mensajeId: number) => void;
  alRecibirEvento: (tipo: string, datos: unknown) => void;
}

export function useRadio(
  { activa, puerta = 'conductor' }: { activa: boolean; puerta?: PuertaRadio },
): UsoRadio {
  const [estado, setEstado] = useState<EstadoBoton>('libre');
  // Se mira una vez: no cambia mientras la página está abierta.
  const [puedeGrabar, setPuedeGrabar] = useState<PuedeGrabar>(() => radioDisponible());
  const [encendida, setEncendida] = useState(false);
  const [habla, setHabla] = useState<string | null>(null);
  const [quedan, setQuedan] = useState(0);
  const [segundosMax, setSegundosMax] = useState(10);
  const [mensajes, setMensajes] = useState<MensajeRadio[]>([]);
  const [aviso, setAviso] = useState<string | null>(null);
  const [oyentes, setOyentes] = useState<number | null>(null);

  const grabadora = useRef<MediaRecorder | null>(null);
  const micro = useRef<MediaStream | null>(null);
  const trozos = useRef<Blob[]>([]);
  const empezoEn = useRef<number>(0);
  const corte = useRef<number | null>(null);
  // Hay una prueba de micrófono en marcha. Sin esto, apretar tres veces mientras
  // iOS enseña el diálogo del permiso lanza tres pruebas.
  const probando = useRef(false);
  // Si se suelta el botón antes de que conteste el servidor, no hay que
  // empezar a grabar cuando llegue el permiso: el taxista ya no está hablando.
  const soltado = useRef(false);
  // Una cosa suena a la vez. Con un solo hablante se solapan poco, pero el
  // botón de volver a oír sí puede pisar a un mensaje que entra.
  const cola = useRef<number[]>([]);
  const sonando = useRef(false);
  // Cuándo dejar de creer que habla otro.
  //
  // EL FALLO QUE ARREGLA, visto usándolo: el canal se quedaba «ocupado» para
  // siempre sin que nadie tuviera el botón apretado. El aviso de que alguien
  // empieza a hablar llegaba siempre; el de que ha callado solo sale si suelta
  // el botón a tiempo, y no sale si el turno caduca solo, si falla el envío o
  // si al que hablaba se le cierra la aplicación. Esta pantalla se quedaba
  // esperando un aviso que ya no iba a llegar nunca.
  //
  // Ahora el aviso trae su propia caducidad y esto es el reloj que la cumple.
  // No hace falta que nadie avise del caso malo: el turno tiene un tope que
  // garantiza el servidor, así que cada pantalla sabe sola cuándo soltarlo.
  const relojOcupado = useRef<number | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r: EstadoRadio = await api.radio(puerta);
      setEncendida(r.encendida);
      setSegundosMax(r.segundosMax);
      setMensajes(r.mensajes);
      setHabla(r.habla?.nombre ?? null);
    } catch {
      // Sin red no se puede saber el estado de la radio. Se deja como está: la
      // pantalla del taxista ya avisa de que no hay conexión.
    }
  }, []);

  useEffect(() => { if (activa) void cargar(); }, [activa, cargar]);

  const dejarDeEsperar = useCallback(() => {
    if (relojOcupado.current !== null) {
      clearTimeout(relojOcupado.current);
      relojOcupado.current = null;
    }
    setHabla(null);
    setEstado((e) => (e === 'ocupado' ? 'libre' : e));
  }, []);

  const soltarMicro = useCallback(() => {
    if (corte.current !== null) {
      clearTimeout(corte.current);
      corte.current = null;
    }
    micro.current?.getTracks().forEach((t) => t.stop());
    micro.current = null;
    // Se devuelve la sesión de audio a «reproducción»: es lo que hace que los
    // avisos suenen con el interruptor de silencio, y es el estado en el que la
    // aplicación pasa casi todo el tiempo.
    volverAReproducir();
    grabadora.current = null;
    trozos.current = [];
  }, []);

  // Reproduce lo que haya en la cola, de uno en uno.
  const sonarCola = useCallback(() => {
    if (sonando.current) return;
    const siguiente = cola.current.shift();
    if (siguiente === undefined) return;
    sonando.current = true;
    void (async () => {
      try {
        const audio = await bajarVozRadio(siguiente, puerta);
        // `null` es lo normal pasadas dos horas: el mensaje se borró. No es un
        // fallo y no se le dice nada al taxista.
        if (audio !== null) {
          sonarRadioEntra();
          // Por el reproductor compartido de `sonidos.ts` y no con un `Audio`
          // nuevo: en iOS un elemento creado fuera de un gesto del usuario no
          // puede sonar NUNCA, y un mensaje de radio entra justo cuando el
          // taxista no está tocando nada. Aquel se desbloqueó en el primer
          // toque y sirve para todos.
          await reproducirVoz(audio);
        }
      } catch {
        // Un mensaje que no se pudo bajar no puede dejar la cola atascada.
      } finally {
        sonando.current = false;
        sonarCola();
      }
    })();
  }, []);

  const encolar = useCallback((mensajeId: number) => {
    cola.current.push(mensajeId);
    sonarCola();
  }, [sonarCola]);

  const mandar = useCallback((audio: Blob, duracionMs: number) => {
    setEstado('enviando');
    void (async () => {
      try {
        const r = await api.mandarVozRadio(audio, duracionMs, puerta);
        setOyentes(r.oyentes);
        setAviso(r.oyentes === 0
          ? 'No había nadie conectado: no te ha oído nadie.'
          : null);
        void cargar();
      } catch {
        // El audio ya existía y se ha perdido al subirlo. Se dice, porque el
        // taxista cree haber avisado a su gremio y no ha avisado a nadie.
        setAviso('No se pudo mandar. Vuelve a decirlo.');
        // El servidor libera el canal al GUARDAR el mensaje; si el mensaje no
        // llegó, el turno sigue siendo suyo y hay que devolverlo a mano.
        void api.soltarTurnoRadio(puerta).catch(() => undefined);
      } finally {
        setEstado('libre');
        setHabla(null);
        setQuedan(0);
      }
    })();
  }, [cargar]);

  const detener = useCallback(() => {
    const g = grabadora.current;
    if (g === null || g.state === 'inactive') {
      soltarMicro();
      setEstado('libre');
      return;
    }
    const duracionMs = Date.now() - empezoEn.current;
    g.onstop = () => {
      const audio = new Blob(trozos.current, { type: g.mimeType || 'audio/webm' });
      soltarMicro();
      if (duracionMs < MINIMO_MS || audio.size === 0) {
        // Un toque no es un mensaje: se suelta el turno para que el canal no
        // quede pillado esos segundos.
        void api.soltarTurnoRadio(puerta).catch(() => undefined);
        setEstado('libre');
        setHabla(null);
        setQuedan(0);
        return;
      }
      mandar(audio, duracionMs);
    };
    g.stop();
  }, [mandar, soltarMicro]);

  const apretar = useCallback(() => {
    if (estado !== 'libre') return;
    // Si este teléfono no puede grabar, ni se pide el turno: cogerlo para
    // fallar acto seguido deja el canal pillado para el resto del gremio por
    // alguien que no iba a poder hablar.
    if (puedeGrabar !== 'si') {
      // Sin grabadora no hay nada que probar: falta una pieza del navegador, no
      // un permiso que se pueda volver a pedir.
      if (puedeGrabar === 'sin_grabadora') {
        setAviso('Este navegador no sabe grabar voz.');
        return;
      }
      // APRETAR ESTANDO MUDO ES VOLVER A PROBAR. No hace falta un segundo botón:
      // el gesto de querer hablar ya es apretar éste, y quien ve «solo escuchar»
      // y aprieta está pidiendo exactamente esto.
      //
      // Y se prueba SOLO EL MICRÓFONO, sin pedir el turno. Es la precaución que
      // da sentido a todo lo demás: pedir el turno y fallar después deja el canal
      // pillado para el gremio entero por alguien que no iba a poder hablar, que
      // es justo el daño que este apunte existía para evitar.
      if (probando.current) return;
      probando.current = true;
      setAviso('Espera…');
      void (async () => {
        try {
          permitirGrabar();
          const prueba = await paso(
            'micro', () => navigator.mediaDevices.getUserMedia(RESTRICCIONES),
          );
          prueba.getTracks().forEach((t) => t.stop());
          volverAReproducir();
          olvidarQueNoPuedeGrabar();
          setPuedeGrabar('si');
          // No se encadena con la grabación: para cuando el permiso se concede,
          // el dedo lleva rato fuera del botón. Se dice que ya está, y el
          // siguiente apretón es el de siempre.
          setAviso('Listo. Aprieta para hablar.');
        } catch (error) {
          if (esFalloDefinitivo(error)) {
            recordarQueNoPuedeGrabar();
            setPuedeGrabar('sin_micro');
            setAviso('Aquí no se puede grabar. Ábrela en el navegador.');
          } else {
            // Un «no» al permiso, o el micrófono cogido por una llamada. Ni
            // condena al aparato ni se queda escondido: se dice qué pasó y que
            // se puede volver a apretar.
            setAviso(`${mensajeDeFallo(error)} Aprieta otra vez.`);
          }
        } finally {
          probando.current = false;
        }
      })();
      return;
    }
    soltado.current = false;
    setAviso(null);
    setOyentes(null);
    setEstado('pidiendo');
    void (async () => {
      let flujo: MediaStream | null = null;
      try {
        // El turno y el micrófono a la vez: pedirlos en fila sumaría las dos
        // esperas, y lo que se está midiendo es el tiempo que pasa entre
        // apretar y poder hablar.
        // ANTES de pedir el micrófono: declarar que esta página va a grabar.
        //
        // iOS no deja grabar desde una sesión de audio de tipo «playback», y
        // «playback» es justo lo que se declara para que los avisos suenen con
        // el interruptor de silencio puesto. Sin esta línea, `getUserMedia`
        // rechaza con `InvalidStateError` en la aplicación instalada — que es
        // el fallo que se estuvo persiguiendo tres días.
        //
        // Va aquí, dentro del mismo gesto que abre el micrófono: cambiar el
        // tipo después ya no sirve.
        permitirGrabar();

        // Cada paso, etiquetado. El nombre de una excepción no dice dónde
        // ocurrió, y `InvalidStateError` puede salir de tres sitios muy
        // distintos: la petición del turno, el permiso del micrófono o la
        // grabadora. Sin saber cuál, se arregla a ciegas.
        const [turno, media] = await Promise.all([
          paso('turno', () => api.pedirTurnoRadio(puerta)),
          paso('micro', () => navigator.mediaDevices.getUserMedia(RESTRICCIONES)),
        ]);
        flujo = media;

        if (!turno.dada) {
          flujo.getTracks().forEach((t) => t.stop());
          sonarRadioOcupada();
          setEstado('libre');
          if (turno.motivo === 'ocupado') {
            setHabla(turno.habla);
            setAviso(`Habla ${turno.habla}. Espera ${turno.quedanSeg} s.`);
          } else if (turno.motivo === 'demasiados') {
            setAviso(`Has hablado mucho seguido. Espera ${turno.esperaSeg} s.`);
          } else {
            setAviso('La radio está apagada.');
            setEncendida(false);
          }
          return;
        }

        // Se soltó el botón mientras el servidor contestaba: no se graba nada y
        // se devuelve el turno.
        if (soltado.current) {
          flujo.getTracks().forEach((t) => t.stop());
          void api.soltarTurnoRadio(puerta).catch(() => undefined);
          setEstado('libre');
          return;
        }

        micro.current = flujo;
        // La grabadora, con red de seguridad. `isTypeSupported` miente en
        // algunos navegadores —dice que sí y luego el constructor revienta— y
        // en otros no existe. Si falla con el formato elegido, se intenta sin
        // pedir nada y que el navegador use el suyo, que es lo que sabe hacer.
        const tipo = formatoSoportado();
        let g: MediaRecorder;
        try {
          g = new MediaRecorder(flujo, {
            audioBitsPerSecond: BITRATE,
            ...(tipo ? { mimeType: tipo } : {}),
          });
        } catch {
          g = await paso('grabadora', async () => new MediaRecorder(flujo!));
        }
        trozos.current = [];
        g.ondataavailable = (e) => { if (e.data.size > 0) trozos.current.push(e.data); };
        grabadora.current = g;
        empezoEn.current = Date.now();
        await paso('arrancar', async () => g.start());

        sonarRadioAdelante();
        setSegundosMax(turno.segundosMax);
        setQuedan(turno.segundosMax);
        setEstado('hablando');

        // Se corta solo. No es solo ahorro: es lo que impide que uno se quede
        // con el canal, y tiene que cumplirse aunque el dedo no se levante.
        corte.current = window.setTimeout(() => detener(), turno.segundosMax * 1000);
      } catch (error) {
        flujo?.getTracks().forEach((t) => t.stop());
        soltarMicro();
        setEstado('libre');
        // Si lo que falló fue ABRIR EL MICRÓFONO dentro de la aplicación
        // instalada, no es un tropiezo: ahí no se puede, y reintentarlo solo
        // sirve para volver a quitarle el turno al gremio. Se apunta, y el
        // botón pasa a «solo escuchar» con su explicación.
        const paso = (error as { pasoRadio?: string } | null)?.pasoRadio;
        if (paso === 'micro' && esAplicacionInstalada() && esFalloDefinitivo(error)) {
          recordarQueNoPuedeGrabar();
          setPuedeGrabar('sin_micro');
        }
        // El turno y el micrófono se piden a la vez, así que el micrófono puede
        // fallar con el turno YA concedido. Si no se devuelve, el gremio se
        // queda sin radio hasta que caduque, y encima por alguien que ni
        // siquiera ha llegado a hablar.
        void api.soltarTurnoRadio(puerta).catch(() => undefined);
        // Cada fallo pide algo distinto del taxista, así que se distinguen. Un
        // único «inténtalo otra vez» le manda a repetir lo que no va a
        // funcionar nunca, que es lo que pasaba.
        const nombre = (error as { name?: string } | null)?.name ?? '';
        setAviso(
          nombre === 'NotAllowedError' || nombre === 'PermissionDeniedError'
            ? 'Hace falta dar permiso al micrófono para hablar por la radio.'
            : nombre === 'NotFoundError' || nombre === 'NotReadableError'
              ? 'No se encuentra el micrófono de este teléfono.'
              : esFalloDeMicrofono(error)
                ? 'El navegador no deja usar el micrófono aquí. Prueba a abrir la'
                  + ' página en el navegador en vez de la aplicación instalada.'
                : mensajeDeFallo(error),
        );
      }
    })();
  }, [estado, detener, soltarMicro, puedeGrabar]);

  const soltar = useCallback(() => {
    soltado.current = true;
    if (estado === 'hablando') detener();
  }, [estado, detener]);

  const volverAOir = useCallback((mensajeId: number) => {
    encolar(mensajeId);
  }, [encolar]);

  const alRecibirEvento = useCallback((tipo: string, datos: unknown) => {
    const d = (datos ?? {}) as {
      mensajeId?: number; conductorId?: number; nombre?: string; caducaEn?: string;
    };
    if ((tipo === 'radio_mensaje' || tipo === 'D8_radio_mensaje')
      && typeof d.mensajeId === 'number') {
      encolar(d.mensajeId);
      dejarDeEsperar();
      void cargar();
      return;
    }
    if (tipo === 'radio_habla') {
      // Se pinta quién habla para que nadie apriete en vano, y se programa el
      // momento de dejar de creerlo. Sin ese reloj, un turno que no se cierra
      // bien deja la radio muda para todos los demás.
      setHabla(d.nombre ?? null);
      setEstado((e) => (e === 'libre' ? 'ocupado' : e));
      if (relojOcupado.current !== null) clearTimeout(relojOcupado.current);
      const queda = d.caducaEn !== undefined
        ? new Date(d.caducaEn).getTime() - Date.now()
        : (segundosMax + 5) * 1000;
      // Con topes: ni fiarse de un reloj mal puesto en el otro teléfono, ni
      // quedarse esperando más de lo que puede durar un turno.
      const espera = Math.min(30_000, Math.max(1_000, queda + 500));
      relojOcupado.current = window.setTimeout(() => {
        dejarDeEsperar();
        // Y se confirma con el servidor, que es el que sabe: puede que hable
        // otro ya, o que haya un mensaje nuevo en la lista.
        void cargar();
      }, espera);
      return;
    }
    if (tipo === 'radio_calla') {
      dejarDeEsperar();
    }
  }, [encolar, cargar, dejarDeEsperar, segundosMax]);

  // La cuenta atrás del turno. Aparte del estado de la grabadora para que se vea
  // bajar: diez segundos sin ninguna señal de que se acaban son diez segundos en
  // los que te cortan a media frase sin avisar.
  useEffect(() => {
    if (estado !== 'hablando') return;
    const t = setInterval(() => setQuedan((q) => Math.max(0, q - 1)), 1000);
    return () => clearInterval(t);
  }, [estado]);

  useEffect(() => () => {
    soltarMicro();
    if (relojOcupado.current !== null) clearTimeout(relojOcupado.current);
  }, [soltarMicro]);

  return {
    estado,
    encendida,
    puedeGrabar,
    habla,
    quedan,
    segundosMax,
    mensajes,
    aviso,
    oyentes,
    apretar,
    soltar,
    volverAOir,
    alRecibirEvento,
  };
}
