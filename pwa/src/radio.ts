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
import { api, bajarVozRadio, type EstadoRadio, type MensajeRadio } from './api';
import { esFalloDeMicrofono } from './llamada';
import { sonarRadioAdelante, sonarRadioEntra, sonarRadioOcupada } from './sonidos';

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

export function radioDisponible(): boolean {
  return typeof MediaRecorder !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function';
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

export function useRadio({ activa }: { activa: boolean }): UsoRadio {
  const [estado, setEstado] = useState<EstadoBoton>('libre');
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
  // Si se suelta el botón antes de que conteste el servidor, no hay que
  // empezar a grabar cuando llegue el permiso: el taxista ya no está hablando.
  const soltado = useRef(false);
  // Una cosa suena a la vez. Con un solo hablante se solapan poco, pero el
  // botón de volver a oír sí puede pisar a un mensaje que entra.
  const cola = useRef<number[]>([]);
  const sonando = useRef(false);

  const cargar = useCallback(async () => {
    try {
      const r: EstadoRadio = await api.radio();
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

  const soltarMicro = useCallback(() => {
    if (corte.current !== null) {
      clearTimeout(corte.current);
      corte.current = null;
    }
    micro.current?.getTracks().forEach((t) => t.stop());
    micro.current = null;
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
      let url: string | null = null;
      try {
        const audio = await bajarVozRadio(siguiente);
        // `null` es lo normal pasadas dos horas: el mensaje se borró. No es un
        // fallo y no se le dice nada al taxista.
        if (audio !== null) {
          sonarRadioEntra();
          url = URL.createObjectURL(audio);
          const elemento = new Audio(url);
          await new Promise<void>((listo) => {
            elemento.onended = () => listo();
            elemento.onerror = () => listo();
            void elemento.play().catch(() => listo());
          });
        }
      } catch {
        // Un mensaje que no se pudo bajar no puede dejar la cola atascada.
      } finally {
        if (url !== null) URL.revokeObjectURL(url);
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
        const r = await api.mandarVozRadio(audio, duracionMs);
        setOyentes(r.oyentes);
        setAviso(r.oyentes === 0
          ? 'No había nadie conectado: no te ha oído nadie.'
          : null);
        void cargar();
      } catch {
        // El audio ya existía y se ha perdido al subirlo. Se dice, porque el
        // taxista cree haber avisado a su gremio y no ha avisado a nadie.
        setAviso('No se pudo mandar. Vuelve a decirlo.');
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
        void api.soltarTurnoRadio().catch(() => undefined);
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
        const [turno, media] = await Promise.all([
          api.pedirTurnoRadio(),
          navigator.mediaDevices.getUserMedia(RESTRICCIONES),
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
          void api.soltarTurnoRadio().catch(() => undefined);
          setEstado('libre');
          return;
        }

        micro.current = flujo;
        const tipo = formatoSoportado();
        const g = new MediaRecorder(flujo, {
          audioBitsPerSecond: BITRATE,
          ...(tipo ? { mimeType: tipo } : {}),
        });
        trozos.current = [];
        g.ondataavailable = (e) => { if (e.data.size > 0) trozos.current.push(e.data); };
        grabadora.current = g;
        empezoEn.current = Date.now();
        g.start();

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
        setAviso(esFalloDeMicrofono(error)
          ? 'Hace falta dar permiso al micrófono para hablar por la radio.'
          : 'No se pudo pedir la palabra. Inténtalo otra vez.');
      }
    })();
  }, [estado, detener, soltarMicro]);

  const soltar = useCallback(() => {
    soltado.current = true;
    if (estado === 'hablando') detener();
  }, [estado, detener]);

  const volverAOir = useCallback((mensajeId: number) => {
    encolar(mensajeId);
  }, [encolar]);

  const alRecibirEvento = useCallback((tipo: string, datos: unknown) => {
    const d = (datos ?? {}) as { mensajeId?: number; conductorId?: number };
    if (tipo === 'radio_mensaje' && typeof d.mensajeId === 'number') {
      encolar(d.mensajeId);
      setHabla(null);
      setEstado((e) => (e === 'ocupado' ? 'libre' : e));
      void cargar();
      return;
    }
    if (tipo === 'radio_habla') {
      // Se pinta que habla otro para que nadie apriete en vano. El nombre llega
      // con la lista; aquí basta con saber que el canal está pillado.
      setEstado((e) => (e === 'libre' ? 'ocupado' : e));
      return;
    }
    if (tipo === 'radio_calla') {
      setHabla(null);
      setEstado((e) => (e === 'ocupado' ? 'libre' : e));
    }
  }, [encolar, cargar]);

  // La cuenta atrás del turno. Aparte del estado de la grabadora para que se vea
  // bajar: diez segundos sin ninguna señal de que se acaban son diez segundos en
  // los que te cortan a media frase sin avisar.
  useEffect(() => {
    if (estado !== 'hablando') return;
    const t = setInterval(() => setQuedan((q) => Math.max(0, q - 1)), 1000);
    return () => clearInterval(t);
  }, [estado]);

  useEffect(() => () => soltarMicro(), [soltarMicro]);

  return {
    estado,
    encendida,
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
