// Llamada de voz por internet entre el pasajero y su taxista.
//
// El audio va DIRECTO de un teléfono al otro (WebRTC). El servidor solo pasa el
// apretón de manos. Consecuencias, que son la razón de hacerlo así:
//
//   - Ninguno de los dos ve el número del otro. Un número no se puede retirar
//     una vez dado: queda en el registro de llamadas y se reutiliza después.
//   - El servidor no puede escuchar aunque quisiera: el audio no pasa por él.
//   - Solo se puede llamar a la persona del viaje en curso, y solo mientras
//     dura. Eso lo impone el servidor, no esta pantalla.
//
// Lo que cuesta, dicho claro: una llamada gasta unos 150 KB por minuto de datos
// móviles. La aplicación entera pesa 153 KB. Por eso el audio se limita a 20
// kbps —suficiente para una voz, no para música— y por eso la interfaz dice los
// segundos que llevas hablando: aquí eso es dinero.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api';
import { anunciarLlamadaEntrante, sonarTimbreLlamada, sonarTonoLlamando } from './sonidos';

export type EstadoLlamada =
  // Sin llamada.
  | 'inactiva'
  // He llamado y espera respuesta al otro lado.
  | 'saliente'
  // Me están llamando y aún no he contestado.
  | 'entrante'
  // Aceptada por los dos; montando el canal de audio.
  | 'conectando'
  // Hablando.
  | 'hablando'
  // No se pudo montar el canal. Se distingue de «colgada» a propósito: el
  // usuario tiene que saber si le colgaron o si la red no dio para tanto.
  | 'fallida';

export interface SenalRecibida {
  senal: string;
  carga: unknown;
}

// Voz, no música: 20 kbps bastan y ahorran datos. Además se pide cancelación de
// eco y supresión de ruido, que en una calle o dentro de un coche es la
// diferencia entre entenderse y no.
const BITRATE_MAXIMO = 20_000;
const RESTRICCIONES_AUDIO: MediaStreamConstraints = {
  audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  video: false,
};

// Si nadie contesta en este tiempo, se deja de llamar. Sin esto, quien llama se
// queda mirando un «llamando…» eterno gastando batería.
const ESPERA_MAXIMA_MS = 35_000;

async function servidoresDeRed(solicitudId: number): Promise<RTCIceServer[]> {
  try {
    const config = await api.configuracionLlamadas(solicitudId);
    return config.servidores;
  } catch {
    // Sin configuración del servidor se intenta igualmente: con suerte los dos
    // teléfonos se ven directamente.
    return [];
  }
}

// Distingue «no me dejas usar el micrófono» de cualquier otro fallo. Los
// nombres de error de `getUserMedia` están en la especificación y son estables
// entre navegadores.
export function esFalloDeMicrofono(error: unknown): boolean {
  const nombre = (error as { name?: string } | null)?.name ?? '';
  return ['NotAllowedError', 'PermissionDeniedError', 'NotFoundError',
    'NotReadableError', 'SecurityError', 'AbortError'].includes(nombre);
}

// Limita el caudal del audio ya negociado. Se hace sobre el emisor y no
// retocando la descripción de sesión a mano, que es frágil y se rompe con cada
// versión del navegador.
export async function limitarCaudal(pc: RTCPeerConnection, bits = BITRATE_MAXIMO): Promise<void> {
  for (const emisor of pc.getSenders()) {
    if (!emisor.track || emisor.track.kind !== 'audio') continue;
    const parametros = emisor.getParameters();
    if (!parametros.encodings || parametros.encodings.length === 0) {
      parametros.encodings = [{}];
    }
    parametros.encodings[0].maxBitrate = bits;
    try {
      await emisor.setParameters(parametros);
    } catch {
      // Navegador que no deja ajustarlo: se habla igual, solo gasta más.
    }
  }
}

// Por qué no se pudo hablar. No es un detalle técnico: lo que tiene que hacer
// el usuario es distinto en cada caso. Sin micrófono hay que dar permiso; con
// la red mal, esperar o volver a intentarlo. Un único «no se pudo» dejaría a la
// mitad de la gente tocando el botón una y otra vez sin arreglar nada.
export type MotivoFallo = 'micro' | 'red' | null;

export interface UsoLlamada {
  estado: EstadoLlamada;
  motivoFallo: MotivoFallo;
  // Segundos hablando, para que se vea lo que se está gastando.
  segundos: number;
  silenciado: boolean;
  // El otro lado tiene la aplicación cerrada: no le va a sonar.
  otroLadoAusente: boolean;
  // Con quién se habla. Se pasa en cada llamada y no al montar el enganche
  // porque el taxista puede llevar cuatro pasajeros: «llamar al pasajero» sin
  // decir a cuál sería ambiguo, y esperar a que un render actualice el dato
  // abriría una carrera con el momento en que se manda la oferta.
  llamar: (solicitudId: number) => void;
  aceptar: () => void;
  colgar: () => void;
  alternarSilencio: () => void;
  // Lo conecta el panel con su canal de eventos.
  alRecibirSenal: (solicitudId: number, senal: SenalRecibida) => void;
}

// `vivo` es si sigue habiendo viaje en curso. Al dejar de haberlo la llamada se
// corta: el servidor ya no aceptaría más señales, y como el audio va directo
// entre los dos teléfonos, sin esto seguirían hablando después de bajarse.
export function useLlamada({ vivo, locale = 'es-ES' }: { vivo: boolean; locale?: string }): UsoLlamada {
  const [estado, setEstado] = useState<EstadoLlamada>('inactiva');
  const [motivoFallo, setMotivoFallo] = useState<MotivoFallo>(null);
  const [segundos, setSegundos] = useState(0);
  const [silenciado, setSilenciado] = useState(false);
  const [otroLadoAusente, setOtroLadoAusente] = useState(false);

  const conexion = useRef<RTCPeerConnection | null>(null);
  const micro = useRef<MediaStream | null>(null);
  const altavoz = useRef<HTMLAudioElement | null>(null);
  // Candidatos que llegan antes de saber con quién hablamos: hay que guardarlos
  // y aplicarlos después, o se pierden los primeros caminos de red.
  const candidatosEnEspera = useRef<RTCIceCandidateInit[]>([]);
  const ofertaPendiente = useRef<RTCSessionDescriptionInit | null>(null);
  const temporizadorEspera = useRef<number | null>(null);

  // Con quién se está hablando ahora mismo. En una referencia y no en el
  // estado: se fija en el mismo instante en que se pulsa llamar, sin esperar a
  // que React vuelva a pintar.
  const conQuien = useRef<number | null>(null);

  const enviar = useCallback((tipo: string, carga: unknown = null) => {
    const id = conQuien.current;
    if (id === null) return Promise.resolve({ entregada: false });
    return api.enviarSenal(id, tipo, carga).catch(() => ({ entregada: false }));
  }, []);

  const limpiar = useCallback(() => {
    if (temporizadorEspera.current !== null) {
      clearTimeout(temporizadorEspera.current);
      temporizadorEspera.current = null;
    }
    conexion.current?.close();
    conexion.current = null;
    micro.current?.getTracks().forEach((t) => t.stop());
    micro.current = null;
    if (altavoz.current) {
      altavoz.current.srcObject = null;
      altavoz.current.remove();
      altavoz.current = null;
    }
    candidatosEnEspera.current = [];
    ofertaPendiente.current = null;
    setSegundos(0);
    setSilenciado(false);
  }, []);

  const crearConexion = useCallback(async (): Promise<RTCPeerConnection> => {
    const pc = new RTCPeerConnection({
      iceServers: await servidoresDeRed(conQuien.current!),
    });

    pc.onicecandidate = (e) => {
      if (e.candidate) void enviar('candidato', e.candidate.toJSON());
    };
    pc.ontrack = (e) => {
      // El audio del otro necesita un elemento donde sonar. Va fuera de React:
      // no se pinta, y montarlo/desmontarlo con el árbol cortaría la voz.
      if (!altavoz.current) {
        altavoz.current = document.createElement('audio');
        altavoz.current.autoplay = true;
        document.body.appendChild(altavoz.current);
      }
      altavoz.current.srcObject = e.streams[0];
      void altavoz.current.play().catch(() => undefined);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        if (temporizadorEspera.current !== null) {
          clearTimeout(temporizadorEspera.current);
          temporizadorEspera.current = null;
        }
        void limitarCaudal(pc);
        setEstado('hablando');
      } else if (pc.connectionState === 'failed') {
        // Casi siempre es que los dos están detrás del NAT del operador y no
        // hay servidor puente configurado. Se dice que falló, no se deja
        // colgado el «llamando…».
        setMotivoFallo('red');
        setEstado('fallida');
      }
    };

    const flujo = await navigator.mediaDevices.getUserMedia(RESTRICCIONES_AUDIO);
    micro.current = flujo;
    for (const pista of flujo.getTracks()) pc.addTrack(pista, flujo);
    conexion.current = pc;
    return pc;
  }, [enviar]);

  const colgar = useCallback(() => {
    if (estado !== 'inactiva') void enviar('colgar');
    limpiar();
    setMotivoFallo(null);
    setEstado('inactiva');
    setOtroLadoAusente(false);
  }, [estado, enviar, limpiar]);

  const llamar = useCallback((solicitudId: number) => {
    if (estado !== 'inactiva') return;
    conQuien.current = solicitudId;
    setMotivoFallo(null);
    setEstado('saliente');
    setOtroLadoAusente(false);
    void (async () => {
      try {
        const pc = await crearConexion();
        const oferta = await pc.createOffer();
        await pc.setLocalDescription(oferta);
        const { entregada } = await enviar('oferta', oferta);
        // Si no había nadie escuchando al otro lado, decirlo ya: es distinto de
        // «no me lo cogen».
        if (!entregada) setOtroLadoAusente(true);
        temporizadorEspera.current = window.setTimeout(() => {
          setEstado('fallida');
          limpiar();
        }, ESPERA_MAXIMA_MS);
      } catch (error) {
        // `getUserMedia` es lo único de aquí que pide permiso al usuario; si
        // falla, es el micrófono y no la red.
        setMotivoFallo(esFalloDeMicrofono(error) ? 'micro' : 'red');
        setEstado('fallida');
        limpiar();
      }
    })();
  }, [estado, crearConexion, enviar, limpiar]);

  const aceptar = useCallback(() => {
    const oferta = ofertaPendiente.current;
    if (!oferta || estado !== 'entrante') return;
    setEstado('conectando');
    void (async () => {
      try {
        const pc = await crearConexion();
        await pc.setRemoteDescription(new RTCSessionDescription(oferta));
        for (const c of candidatosEnEspera.current) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => undefined);
        }
        candidatosEnEspera.current = [];
        const respuesta = await pc.createAnswer();
        await pc.setLocalDescription(respuesta);
        await enviar('respuesta', respuesta);
      } catch (error) {
        setMotivoFallo(esFalloDeMicrofono(error) ? 'micro' : 'red');
        setEstado('fallida');
        limpiar();
      }
    })();
  }, [estado, crearConexion, enviar, limpiar]);

  const alternarSilencio = useCallback(() => {
    const pistas = micro.current?.getAudioTracks() ?? [];
    const nuevo = !silenciado;
    for (const p of pistas) p.enabled = !nuevo;
    setSilenciado(nuevo);
  }, [silenciado]);

  const alRecibirSenal = useCallback((solicitudId: number, mensaje: SenalRecibida) => {
    const { senal, carga } = mensaje;
    void (async () => {
      if (senal === 'oferta') {
        // Ya estoy en otra llamada: se avisa en vez de dejarlo sonando. Ojo con
        // responder al que llama y no al que ya tenía descolgado.
        if (estado !== 'inactiva') {
          const anterior = conQuien.current;
          conQuien.current = solicitudId;
          void enviar('ocupado').finally(() => { conQuien.current = anterior; });
          return;
        }
        conQuien.current = solicitudId;
        ofertaPendiente.current = carga as RTCSessionDescriptionInit;
        setEstado('entrante');
        return;
      }
      if (senal === 'respuesta') {
        const pc = conexion.current;
        if (!pc) return;
        setEstado('conectando');
        await pc.setRemoteDescription(
          new RTCSessionDescription(carga as RTCSessionDescriptionInit),
        ).catch(() => undefined);
        for (const c of candidatosEnEspera.current) {
          await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => undefined);
        }
        candidatosEnEspera.current = [];
        return;
      }
      if (senal === 'candidato') {
        const pc = conexion.current;
        const candidato = carga as RTCIceCandidateInit;
        if (!pc || !pc.remoteDescription) {
          candidatosEnEspera.current.push(candidato);
          return;
        }
        await pc.addIceCandidate(new RTCIceCandidate(candidato)).catch(() => undefined);
        return;
      }
      if (senal === 'colgar' || senal === 'rechazar' || senal === 'ocupado') {
        limpiar();
        setEstado('inactiva');
      }
    })();
  }, [estado, enviar, limpiar]);

  // Reloj de la conversación. Va aparte del estado de la conexión para que se
  // vea el gasto en tiempo real.
  useEffect(() => {
    if (estado !== 'hablando') return;
    const t = setInterval(() => setSegundos((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [estado]);

  // Timbre de la llamada entrante. Antes de esto, una llamada solo sonaba en
  // el sentido de la voz de verdad —una vez conectada—: mientras sonaba, era
  // silenciosa del todo, un rectángulo que aparece en la pantalla. Con el
  // teléfono en el bolsillo o mirando la carretera, eso equivale a que no
  // suene nunca. El aviso hablado se dice una sola vez, al principio; el tono
  // se repite cada 2,4 s mientras dure, como un teléfono de verdad.
  useEffect(() => {
    if (estado !== 'entrante') return;
    anunciarLlamadaEntrante(locale);
    sonarTimbreLlamada();
    const t = setInterval(sonarTimbreLlamada, 2400);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado]);

  // Tono de retorno para quien llama: el «tuuu… tuuu» de espera. La cadencia
  // clásica es un segundo de tono y unos tres de silencio.
  useEffect(() => {
    if (estado !== 'saliente') return;
    sonarTonoLlamando();
    const t = setInterval(sonarTonoLlamando, 4000);
    return () => clearInterval(t);
  }, [estado]);

  // Si el viaje termina, la llamada se cae con él.
  useEffect(() => {
    if (!vivo && estado !== 'inactiva') {
      limpiar();
      conQuien.current = null;
      setEstado('inactiva');
    }
  }, [vivo, estado, limpiar]);

  useEffect(() => () => limpiar(), [limpiar]);

  return {
    estado,
    motivoFallo,
    segundos,
    silenciado,
    otroLadoAusente,
    llamar,
    aceptar,
    colgar,
    alternarSilencio,
    alRecibirSenal,
  };
}
