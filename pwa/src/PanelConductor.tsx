// Panel del taxista en la web. Existe para poder ver el sistema completo en
// localhost antes de separar las dos aplicaciones; la app Android nativa
// (carpeta android/) es la que se reparte a los conductores de verdad.
//
// Muestra solo lo que hace falta en cada momento: fuera de servicio, un botón;
// con una oferta, aceptar o rechazar; con pasajeros, un bloque por cada uno.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abrirEventosConductor, api, coordenadasOportunistas, enPruebasLocales,
  type DatosConductor, type EstadoConductor, type Posicion, type PuntoMapa,
  type Zona, type ZonaConDemanda,
} from './api';
import { mensajeDeError, ErrorDeRed, useConexion, ErrorDelServidor } from './conexion';
import { escucharBrujula, pedirPermisoBrujula } from './brujula';
import { metrosEntre, porCercaniaA, rumboEntre, velocidadKmhEntre } from './geo';
import { crearT, localeVoz, type Idioma } from './i18n';
import { useLlamada, type SenalRecibida } from './llamada';
import Mapa from './Mapa';
import PanelLlamada from './PanelLlamada';
import Recarga from './Recarga';
import MandosFlotantes from './MandosFlotantes';
import { anotarRastro, olvidarRastro, pendientesRastro } from './rastroLocal';
import { alternarGuia, guiaEncendida, proximoAviso } from './guia';
import {
  encolar, guardarUltimo, sincronizar, ultimoGuardado, usePendientes,
} from './sinRed';
import VistaConductor from './VistaConductor';
import {
  hablar, prepararSonido, sonarCarreraCancelada, sonarNuevaCarrera,
} from './sonidos';

// Las acciones de un viaje que se pueden hacer sin red y mandar después. Son
// hechos —ya ocurrieron en la calle—, así que apuntarlos tarde con su hora es
// correcto. Aceptar y rechazar no están: son decisiones que valen ahora.
const SE_PUEDEN_HACER_SIN_RED: Record<string, string> = {
  salir: 'accion.voyDeCamino',
  'he-llegado': 'accion.heLlegado',
  recoger: 'accion.pasajeroRecogido',
  completar: 'accion.viajeTerminado',
  'cliente-ausente': 'accion.noAparece',
};

export default function PanelConductor({
  conductor, puntos, idioma, alAbrirAjustes, alAbrirEstadisticas, alAbrirCampo,
  alRecargarSesion,
}: {
  conductor: DatosConductor;
  puntos: PuntoMapa[];
  idioma: Idioma;
  alAbrirAjustes: () => void;
  alAbrirEstadisticas: () => void;
  // Solo para agentes de campo (migración 025): abre las herramientas del mapa.
  alAbrirCampo?: () => void;
  // Los datos de sesión (verificación, suscripción) los tiene App: tras
  // pagar la cuota hay que pedirle que los recargue, o el panel seguiría
  // mostrando la situación anterior.
  alRecargarSesion: () => void;
}) {
  const t = crearT(idioma);
  const [estado, setEstado] = useState<EstadoConductor | null>(null);
  const [aviso, setAviso] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [enRecarga, setEnRecarga] = useState(false);
  // Sin red (migración 057): la hora de los datos que se están enseñando si no
  // son de ahora, y cuántas acciones esperan a la red para salir. null = datos
  // frescos.
  const [datosDe, setDatosDe] = useState<string | null>(null);
  const ultimaFrescura = useRef<string | null>(null);
  const pendientes = usePendientes();
  const enLinea = useConexion();
  // Panel recogido: conduciendo, lo que hace falta es el plano entero.
  const [panelPlegado, setPanelPlegado] = useState(false);
  const [demanda, setDemanda] = useState<{ zonas: ZonaConDemanda[]; ventanaMin: number } | null>(null);
  // Con `precision`: desde la migración 047 el servidor la necesita para no
  // cerrar un viaje por una lectura mala del GPS.
  const coordenadas = useRef<Posicion | null>(null);
  // La misma posición, pero como estado: es lo que mueve el coche en el mapa.
  // La referencia sola no basta — mutarla no repinta nada, y el mapa del
  // taxista se quedaba con el coche clavado hasta el siguiente latido
  // (20-30 s, más otros 60 de caché del GPS): conduciendo, eso es quedarse
  // quieto en otra calle.
  const [posicionCoche, setPosicionCoche] = useState<{ lat: number; lng: number } | null>(null);
  // Horas que lleva en servicio, cuando toca recordárselo (migración 049).
  const [avisoTurno, setAvisoTurno] = useState<number | null>(null);
  // Hacia dónde va el coche, para girar el plano y poner delante arriba. null
  // hasta que se sepa: el mapa se queda con el norte arriba mientras tanto.
  const [rumbo, setRumbo] = useState<number | null>(null);
  const ofertasAvisadas = useRef<Set<number>>(new Set());

  // Guía por voz (20/09). Apagada de fábrica: ver guia.ts.
  const [conVoz, setConVoz] = useState(guiaEncendida());
  // El interruptor, también en una referencia: `guiar` se llama desde el
  // vigilante del GPS, que se monta una sola vez, y sin esto se quedaría con
  // el valor del primer renderizado — apagar la voz no la apagaría.
  const conVozRef = useRef(conVoz);
  conVozRef.current = conVoz;
  // La ruta que el plano ya calculó, y lo que ya se ha dicho de ella. En
  // referencias: cambian con cada lectura del GPS y no pintan nada.
  const rutaViva = useRef<Array<{ lat: number; lng: number }> | null>(null);
  const yaDichas = useRef<Set<string>>(new Set());
  // A dónde se está guiando: cambiar de destino —de ir a recoger a llevar al
  // pasajero— es lo que borra lo ya dicho.
  const destinoGuiado = useRef('');

  // Lo que toca decir estando aquí. Se llama con cada posición —en marcha, una
  // o dos veces por segundo—; `proximoAviso` se encarga de que cada frase
  // suene UNA vez.
  const guiar = useCallback((donde: { lat: number; lng: number }) => {
    if (!conVozRef.current) return;
    const ruta = rutaViva.current;
    if (!ruta || ruta.length < 2) return;
    const aviso = proximoAviso(ruta, donde, yaDichas.current);
    if (aviso === null) return;
    yaDichas.current.add(aviso.clave);
    const frase = aviso.giro === 'llegada'
      ? t('guia.llegando')
      : aviso.metros > 0
        ? t('guia.enMetros', { metros: String(aviso.metros), giro: t(`guia.${aviso.giro}`) })
        : t('guia.ahora', { giro: t(`guia.${aviso.giro}`) });
    hablar(frase, localeVoz(idioma));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idioma]);

  // Cambia el estado solo si el coche se ha movido de verdad (~13 m): las
  // lecturas de GPS parado bailan unos metros y repintarían el mapa en balde.
  const moverCoche = useCallback((nueva: { lat: number; lng: number } | null) => {
    if (!nueva) return;
    guiar(nueva);
    setPosicionCoche((previa) => {
      if (previa
        && Math.abs(previa.lat - nueva.lat) < 0.00012
        && Math.abs(previa.lng - nueva.lng) < 0.00012) return previa;
      return nueva;
    });
  }, [guiar]);

  // Hacia dónde va el coche. Dos fuentes, por este orden:
  //
  //   1. `coords.heading` del GPS, que es el rumbo sobre el terreno y es el
  //      bueno. Pero solo vale con el coche EN MARCHA: parado, el GPS deriva
  //      unos metros al azar y el rumbo que calcula de ahí es ruido puro.
  //   2. Si no lo da —muchos Android baratos devuelven null siempre—, el
  //      rumbo entre esta posición y la última que estuviera lo bastante
  //      lejos. Veinticinco metros son más que el error del GPS y menos que
  //      una manzana.
  //
  // Y si ninguna sirve, NO se toca: el plano se queda como estaba. Volver al
  // norte en cada semáforo marearía más que no girar nunca.
  const VELOCIDAD_MINIMA_MS = 2;
  const DISTANCIA_MINIMA_M = 25;
  const ultimaParaRumbo = useRef<{ lat: number; lng: number } | null>(null);
  // Velocidad en tiempo real, para el marcador del panel.
  const [velocidadKmh, setVelocidadKmh] = useState<number | null>(null);
  // Última velocidad conocida en m/s, para decidir quién manda en el rumbo: la
  // brújula parado o el GPS en marcha. En una referencia y no en el estado
  // porque la lee el escuchador de la brújula, que se monta una sola vez.
  const velocidadMs = useRef(0);
  // Hacia dónde apunta el coche. Se separa del rumbo del PLANO a propósito:
  // parado, girar el móvil gira el coche pero deja el plano quieto —un plano
  // que gira en la mano marea y no orienta a nadie—, y en marcha las dos cosas
  // son lo mismo.
  const [rumboCoche, setRumboCoche] = useState<number | null>(null);
  const ultimaParaVelocidad = useRef<{ lat: number; lng: number; en: number } | null>(null);
  // Velocidad de la lectura, en km/h. `coords.speed` cuando lo hay —lo calcula
  // el chip del GPS por Doppler y es lo fiable—, y si no, la distancia entre
  // dos lecturas: ver `velocidadKmhEntre`, donde están las guardas y el porqué.
  const anotarVelocidad = useCallback((
    donde: { lat: number; lng: number },
    delGps: number | null,
    ahora: number,
  ) => {
    if (delGps !== null && Number.isFinite(delGps) && delGps >= 0) {
      ultimaParaVelocidad.current = { ...donde, en: ahora };
      velocidadMs.current = delGps;
      setVelocidadKmh(Math.round(delGps * 3.6));
      return;
    }
    const previa = ultimaParaVelocidad.current;
    if (previa === null) {
      ultimaParaVelocidad.current = { ...donde, en: ahora };
      return;
    }
    const kmh = velocidadKmhEntre(previa, { ...donde, en: ahora });
    // Con `null` se CONSERVA la lectura anterior como referencia: si se pisara
    // con una demasiado seguida, nunca se acumularía hueco para medir y el
    // velocímetro no marcaría nunca en un teléfono sin `coords.speed`.
    if (kmh === null) return;
    ultimaParaVelocidad.current = { ...donde, en: ahora };
    velocidadMs.current = kmh / 3.6;
    setVelocidadKmh(kmh);
  }, []);

  const anotarRumbo = useCallback((
    donde: { lat: number; lng: number } | null,
    delGps: number | null,
    velocidad: number | null,
  ) => {
    if (!donde) return;
    const enMarcha = velocidad === null || velocidad >= VELOCIDAD_MINIMA_MS;
    if (delGps !== null && Number.isFinite(delGps) && enMarcha) {
      const grados = ((delGps % 360) + 360) % 360;
      setRumbo(grados);
      setRumboCoche(grados);
      ultimaParaRumbo.current = donde;
      return;
    }
    const previa = ultimaParaRumbo.current;
    if (previa === null) {
      ultimaParaRumbo.current = donde;
      return;
    }
    if (metrosEntre(previa, donde) < DISTANCIA_MINIMA_M) return;
    const entrePosiciones = rumboEntre(previa, donde);
    setRumbo(entrePosiciones);
    setRumboCoche(entrePosiciones);
    ultimaParaRumbo.current = donde;
  }, []);

  // La brújula, para cuando el coche está PARADO.
  //
  // El GPS solo sabe hacia dónde va algo que se mueve; girar el móvil en la
  // mano no cambia nada suyo, y por eso el coche del mapa se quedaba clavado.
  // La brújula sí sabe dónde está el norte estando quieto.
  //
  // Y solo parado: dentro de un coche en marcha la brújula miente —carrocería,
  // altavoces y el soporte del móvil son hierro e imanes—, mientras que el
  // rumbo de marcha del GPS ahí es exacto. Cada una manda donde acierta. El
  // umbral es el mismo con el que ya se decidía si una lectura de rumbo del GPS
  // era fiable.
  // En iOS el permiso de la brújula solo se puede pedir desde un gesto de la
  // persona: pedido al arrancar, el navegador lo niega en silencio y ya no
  // vuelve a funcionar en toda la sesión. Así que se engancha al primer toque,
  // sea el que sea — no hace falta un botón que explique nada.
  useEffect(() => {
    let parar: (() => void) | null = null;
    let vivo = true;
    const arrancar = () => {
      window.removeEventListener('pointerdown', arrancar);
      void pedirPermisoBrujula().then((concedido) => {
        if (!concedido || !vivo || parar) return;
        parar = escucharBrujula((grados) => {
          // En marcha manda el GPS: dentro de un coche la brújula miente.
          if (velocidadMs.current >= VELOCIDAD_MINIMA_MS) return;
          setRumboCoche(grados);
        });
      });
    };
    window.addEventListener('pointerdown', arrancar);
    return () => {
      vivo = false;
      window.removeEventListener('pointerdown', arrancar);
      if (parar) parar();
    };
  }, []);

  const llamada = useLlamada({ vivo: true, locale: localeVoz(idioma) });
  const recibirSenal = useRef<((id: number, s: SenalRecibida) => void) | null>(null);
  recibirSenal.current = llamada.alRecibirSenal;

  // Última fotografía de los pasajeros, para saber —cuando llega un aviso de
  // cancelación— si era uno de los suyos o solo una oferta que ni había
  // aceptado. Va en una referencia porque el gestor de eventos se monta una
  // sola vez y necesita ver siempre el valor más reciente, no el del momento
  // en que se creó.
  const pasajerosRef = useRef<EstadoConductor['pasajeros']>([]);
  pasajerosRef.current = estado?.pasajeros ?? [];

  const refrescar = useCallback(async () => {
    try {
      // Lo que se hizo sin red, ANTES de pedir el estado. Si no, el estado de
      // ahora —que todavía no sabe que se pulsó «recogido»— pisaría en pantalla
      // lo que el taxista ya hizo, y el botón volvería atrás un instante.
      await sincronizarBandeja();
      const nuevo = await api.estadoConductor();
      setEstado(nuevo);
      guardarUltimo('conductor', nuevo);
      ultimaFrescura.current = new Date().toISOString();
      setDatosDe(null);

      // Aviso sonoro solo la primera vez que aparece cada oferta: si sonara en
      // cada refresco, el taxista apagaría el sonido en cinco minutos.
      for (const oferta of nuevo.ofertas) {
        if (!ofertasAvisadas.current.has(oferta.solicitudId)) {
          ofertasAvisadas.current.add(oferta.solicitudId);
          sonarNuevaCarrera(oferta.destino, localeVoz(idioma));
        }
      }
      // Las ofertas que ya no están se olvidan, para que vuelvan a avisar si
      // el sistema las reofrece más tarde.
      const vivas = new Set(nuevo.ofertas.map((o) => o.solicitudId));
      for (const id of [...ofertasAvisadas.current]) {
        if (!vivas.has(id)) ofertasAvisadas.current.delete(id);
      }
    } catch (error) {
      if (error instanceof ErrorDeRed || (error instanceof ErrorDelServidor && error.estado >= 500)) {
        // Sin red —o con el servidor caído, que para quien conduce es lo
        // mismo—: se enseña lo último que se supo, CON SU HORA. Si la
        // aplicación acaba de abrirse y no hay nada en pantalla, lo guardado.
        // Sin las ofertas: aceptar necesita red, y una oferta vieja en pantalla
        // solo invita a pulsar algo que no puede salir bien.
        const guardado = ultimoGuardado<EstadoConductor>('conductor');
        setEstado((actual) => actual ?? (guardado ? { ...guardado.valor, ofertas: [] } : null));
        setDatosDe(ultimaFrescura.current ?? guardado?.guardadoEn ?? null);
      }
      setAviso(mensajeDeError(error, t('aviso.sinConexion')));
    }
  }, []);

  // Manda lo que se hizo sin red. Si el servidor rechaza algo que ya no tiene
  // arreglo —el pasajero canceló mientras tanto—, se dice qué y por qué.
  async function sincronizarBandeja() {
    const r = await sincronizar(api.enviarPendiente, (e) => e instanceof ErrorDeRed);
    if (r.rechazadas.length > 0) {
      setAviso(r.rechazadas
        .map((x) => t('sinRed.rechazada', { accion: x.descripcion, motivo: x.motivo }))
        .join(' '));
    }
  }

  // Registro del dispositivo como este conductor.
  useEffect(() => {
    api.registroConductor(conductor.telefono).catch(() => undefined);
    void refrescar();
  }, [conductor.telefono, refrescar]);

  // Conexión viva: las carreras aparecen en el momento en que se emiten. Antes
  // esto dependía del sondeo, y el taxista podía esperar 20 s a ver una oferta
  // que expira en 90. El sondeo se mantiene como red de seguridad por si la
  // conexión se corta sin avisar.
  useEffect(() => {
    const cerrar = abrirEventosConductor((evento) => {
      // Por el mismo canal entra el apretón de manos de las llamadas. Si es una
      // llamada entrante hay que saber de qué pasajero viene antes de poder
      // contestarla.
      if (evento.tipo === 'llamada') {
        const id = Number(evento.solicitudId);
        if (Number.isInteger(id)) {
          recibirSenal.current?.(id, evento.datos as unknown as SenalRecibida);
        }
        return;
      }
      // El pasajero cancela un viaje que el taxista ya tenía aceptado: puede
      // llevar un rato conduciendo hacia un punto de recogida que ya no
      // existe. Se distingue de «perdiste la oferta» (que no requiere aviso
      // sonoro: no había nada comprometido) mirando si esa solicitud estaba
      // de verdad en su lista de pasajeros justo antes de este evento.
      if (evento.tipo === 'D2_reclamacion_resuelta') {
        const datos = evento.datos as { resultado?: string };
        const eraSuyo = pasajerosRef.current.some((p) => p.solicitudId === evento.solicitudId);
        if (datos.resultado === 'cancelada' && eraSuyo) {
          sonarCarreraCancelada(localeVoz(idioma));
        }
      }
      void refrescar();
    });
    return cerrar;
  }, [refrescar]);

  // Estar en servicio, y estarlo sin nada entre manos. Se calculan una sola
  // vez: estaban repetidas en tres sitios, y tres copias de la misma regla es
  // como se separan con el tiempo.
  const enServicio = estado !== null && estado.estado !== 'DESCONECTADO';
  // En un ref además de en una variable: el vigilante del GPS se monta una vez
  // y lee esto desde dentro. Si dependiera del estado habría que rehacerlo en
  // cada cambio, y rehacer un `watchPosition` cuesta una fijación nueva.
  const enServicioRef = useRef(enServicio);
  enServicioRef.current = enServicio;
  const parado = enServicio
    && (estado?.ofertas.length ?? 0) === 0
    && (estado?.pasajeros.length ?? 0) === 0;

  // Vacía la cola de recorrido que se apuntó sin red (migración 051).
  //
  // Se llama después de un latido que ha salido bien, que es la señal más
  // barata y más fiable de que hay cobertura: si el latido llegó, la red está.
  //
  // De cien en cien y en varias vueltas: un apagón de cobertura de una tarde
  // deja unos cientos de puntos, y mandarlos todos de golpe por una red de
  // Malabo es lo que hace que se caiga la petición y no se suba nada. Se borra
  // cada lote SOLO cuando el servidor confirma haberlo recibido; si la
  // respuesta se pierde, el lote se reenvía y el servidor lo descarta por
  // repetido, que para eso está el índice único.
  const vaciarRastroPendiente = async () => {
    for (let vuelta = 0; vuelta < 5; vuelta += 1) {
      const pendientes = await pendientesRastro(100);
      if (pendientes.length === 0) return;
      await api.subirRastro(
        pendientes.map((p) => ({ lat: p.lat, lng: p.lng, en: p.en, precision: p.precision ?? null })),
      );
      await olvidarRastro(pendientes.map((p) => p.id!).filter((id) => id !== undefined));
      // Si venía menos de un lote lleno, ya no queda nada.
      if (pendientes.length < 100) return;
    }
  };

  // En cuanto vuelve la red, lo pendiente sale y el estado se pone al día. No
  // se espera al siguiente latido: pueden ser veinte segundos con el pasajero
  // ya fuera del coche.
  useEffect(() => {
    if (enLinea) void refrescar();
  }, [enLinea, refrescar]);

  // Heartbeat y refresco mientras está en servicio. 20 s en primer plano: la
  // ventana del servidor son 120 s, así que sobra margen.
  useEffect(() => {
    const latir = async () => {
      // La posición se lee SIEMPRE, esté o no en servicio: el selector de zona
      // la necesita justo cuando está fuera, que es cuando se elige dónde
      // trabajar. Antes solo se leía estando dentro, así que a la hora de
      // elegir zona nunca se sabía dónde estaba el coche.
      coordenadas.current = await coordenadasOportunistas();
      moverCoche(coordenadas.current);
      // El latido no trae rumbo del GPS —`coordenadasOportunistas` devuelve
      // solo lat/lng—, pero sí sirve de segunda fuente: entre dos latidos con
      // el coche andando hay más que los veinticinco metros que hacen falta.
      // Es lo que salva a los teléfonos que nunca dan `heading`.
      anotarRumbo(coordenadas.current, null, null);
      if (enServicio) {
        try {
          const respuesta = await api.heartbeat(coordenadas.current);
          // Migración 049: el turno ya no se cae solo por un latido viejo, así
          // que puede durar toda la noche si se olvida. Cada hora se le
          // recuerda que sigue dentro y con la ubicación encendida — con el
          // botón de salir justo debajo, que ya está en pantalla.
          if (respuesta.avisoTurnoHoras !== null) {
            setAvisoTurno(respuesta.avisoTurnoHoras);
          }
          // El latido ha salido: hay red. Primero las acciones —entrar en
          // servicio incluida— y después el recorrido: el servidor solo acepta
          // puntos que caigan dentro de un turno que ya conozca.
          await sincronizarBandeja();
          await vaciarRastroPendiente();
        } catch {
          // Sin red: el siguiente latido reintenta, y el recorrido se sigue
          // apuntando en el móvil mientras tanto.
        }
      }
      void refrescar();
    };
    void latir();
    // Con pasajeros, el latido se acelera: es lo que actualiza la posición
    // del coche que ve el pasajero en su mapa. A 20 s el taxi avanzaba a
    // saltos de dos manzanas; a 10 s se mueve como un coche.
    const conPasajeros = (estado?.pasajeros.length ?? 0) > 0;
    const cadaMs = conPasajeros ? 10_000 : enServicio ? 20_000 : 30_000;
    const temporizador = setInterval(latir, cadaMs);
    return () => clearInterval(temporizador);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estado?.estado, estado?.pasajeros.length, refrescar]);

  // GPS continuo mientras el panel está abierto: cada lectura mueve el coche
  // en el mapa (y deja la posición fresca para el siguiente latido). El
  // latido de 20-30 s sigue siendo quien habla con el servidor; esto solo
  // alimenta la pantalla, que es donde 30 segundos de retraso se notan.
  useEffect(() => {
    // Con ?gps= forzado en localhost manda la posición fingida: el GPS real
    // del ordenador (o su ausencia) no debe pisarla.
    //
    // Y se simula un coche en marcha: avanza desde ese punto al rumbo y a la
    // velocidad que digan `?rumbo=` y `?kmh=`. Existe porque el plano
    // inclinado, la brújula y el velocímetro SOLO aparecen circulando, y un
    // ordenador no circula: sin esto no hay forma de mirar esas tres cosas
    // antes de que las vea un taxista en la calle. Está detrás de
    // `enPruebasLocales`, así que en producción no existe.
    const parametros = new URLSearchParams(window.location.search);
    if (enPruebasLocales() && parametros.has('gps')) {
      // Del propio `?gps=` y no de `coordenadas.current`: esta referencia la
      // rellena OTRO efecto, y montándose los dos a la vez este llegaba antes
      // y se encontraba un null, así que el coche fingido no arrancaba nunca
      // y el modo de pruebas no servía para lo único para lo que existe.
      const [latTexto, lngTexto] = (parametros.get('gps') ?? '').split(',');
      const inicio = { lat: Number(latTexto), lng: Number(lngTexto) };
      const rumboFingido = Number(parametros.get('rumbo') ?? '0');
      const kmh = Number(parametros.get('kmh') ?? '0');
      if (!Number.isFinite(inicio.lat) || !Number.isFinite(inicio.lng) || kmh <= 0) return;
      const rad = (rumboFingido * Math.PI) / 180;
      let metros = 0;
      const reloj = setInterval(() => {
        metros += (kmh / 3.6) * 1.5;
        const donde = {
          lat: inicio.lat + (metros * Math.cos(rad)) / 111_320,
          lng: inicio.lng + (metros * Math.sin(rad)) / (111_320 * Math.cos(inicio.lat * Math.PI / 180)),
          precision: 8,
        };
        coordenadas.current = donde;
        moverCoche(donde);
        anotarRumbo(donde, rumboFingido, kmh / 3.6);
        anotarVelocidad(donde, kmh / 3.6, Date.now());
      }, 1500);
      return () => clearInterval(reloj);
    }
    if (!('geolocation' in navigator)) return;
    const vigilante = navigator.geolocation.watchPosition(
      (p) => {
        const nueva = {
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          precision: p.coords.accuracy,
        };
        coordenadas.current = nueva;
        moverCoche(nueva);
        anotarRumbo(nueva, p.coords.heading, p.coords.speed);
        anotarVelocidad(nueva, p.coords.speed, p.timestamp);
        // Y el recorrido se apunta en el propio móvil, haya red o no
        // (migración 051). Solo en servicio: fuera del turno no se registra
        // por dónde anda, ni aquí ni en el servidor.
        if (enServicioRef.current) void anotarRastro(nueva, new Date(p.timestamp));
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => navigator.geolocation.clearWatch(vigilante);
  }, [moverCoche, anotarRumbo, anotarVelocidad]);

  // Dónde hay trabajo. Va en su propia petición y no pegada al latido para
  // poder pedirla una vez por minuto en vez de tres: el latido va cada 20 s y
  // esto abultaría unos 36 KB por hora en servicio, que en datos prepagados
  // es dinero. Y solo mientras está parado: con una oferta en pantalla o con
  // pasajeros a bordo no sirve para nada, así que no se paga por ella.
  useEffect(() => {
    if (!parado) {
      setDemanda(null);
      return;
    }
    const pedir = () => {
      api.demandaConductor().then(setDemanda).catch(() => setDemanda(null));
    };
    pedir();
    const temporizador = setInterval(pedir, 60_000);
    return () => clearInterval(temporizador);
  }, [parado]);

  async function accion(
    solicitudId: number,
    tipo: Parameters<typeof api.accionPasajero>[1],
    cuerpo: Record<string, unknown> = {},
  ) {
    setOcupado(true);
    setAviso('');
    try {
      const posicion = await coordenadasOportunistas();
      await api.accionPasajero(solicitudId, tipo, {
        ...cuerpo,
        ...(posicion ?? {}),
      });
      await refrescar();
    } catch (error) {
      const etiqueta = SE_PUEDEN_HACER_SIN_RED[tipo];
      if (error instanceof ErrorDeRed && etiqueta !== undefined) {
        // Sin red: se guarda con la hora de ahora y la pantalla avanza como si
        // hubiera llegado. Saldrá sola en cuanto haya conexión.
        const posicion = await coordenadasOportunistas();
        await encolar({
          ruta: `/api/conductor/solicitudes/${solicitudId}/${tipo}`,
          cuerpo: { ...cuerpo, ...(posicion ?? {}) },
          descripcion: t(etiqueta),
        });
        avanzarSinRed(solicitudId, tipo);
        setAviso(t('sinRed.guardada'));
      } else if (error instanceof ErrorDeRed) {
        // Aceptar o rechazar una carrera: valen ahora o nunca.
        setAviso(t('sinRed.necesitaRed'));
      } else {
        // Los mensajes del servidor son útiles tal cual: «expiró hace N
        // segundos», «quedan N segundos»…
        setAviso(mensajeDeError(error, t('aviso.noSePudo')));
        await refrescar();
      }
    } finally {
      setOcupado(false);
    }
  }

  // Lo que la pantalla tiene que enseñar después de una acción que se guardó
  // sin red, sin esperar a que el servidor lo confirme. Se guarda también como
  // último estado: si la aplicación se cierra y se vuelve a abrir sin red, el
  // taxista tiene que ver el viaje como lo dejó, no como estaba antes.
  function avanzarSinRed(solicitudId: number, tipo: string) {
    setEstado((e) => {
      if (!e) return e;
      const ahora = new Date().toISOString();
      let pasajeros = e.pasajeros.map((p) => {
        if (p.solicitudId !== solicitudId) return p;
        // El tiempo de llegada se quita al cambiar de fase: era hasta RECOGER
        // al pasajero, y sin red no hay forma de calcular el nuevo hasta su
        // destino. Dejarlo enseñaba «llegas en 1 min» con el pasajero recién
        // subido a un viaje de veinte.
        const sinTiempo = { etaMin: null, distanciaM: null };
        if (tipo === 'salir') return { ...p, ...sinTiempo, estado: 'EN_CAMINO' };
        if (tipo === 'he-llegado') return { ...p, llegadoEn: p.llegadoEn ?? ahora };
        if (tipo === 'recoger') return { ...p, ...sinTiempo, estado: 'RECOGIDO' };
        return p;
      });
      if (tipo === 'completar' || tipo === 'cliente-ausente') {
        pasajeros = pasajeros.filter((p) => p.solicitudId !== solicitudId);
      }
      const nuevo = {
        ...e,
        pasajeros,
        pasajerosABordo: pasajeros.filter((p) => p.estado === 'RECOGIDO').length,
      };
      guardarUltimo('conductor', nuevo);
      return nuevo;
    });
  }

  async function alternarServicio() {
    prepararSonido();
    setOcupado(true);
    setAviso('');
    try {
      if (!enServicio) {
        // Se pide el GPS en el momento, no se reutiliza el último conocido:
        // entrar en servicio declara dónde estás AHORA, y una lectura de
        // hace media hora puede ser de otro barrio.
        const donde = await coordenadasOportunistas();
        if (!donde) {
          setAviso(t('aviso.sinUbicacionServicio'));
          return;
        }
        try {
          await api.servicio(true, donde);
        } catch (error) {
          if (!(error instanceof ErrorDeRed)) throw error;
          // Sin red también se entra: el GPS funciona igual, así que el
          // recorrido se graba desde AHORA y no desde que vuelva la cobertura.
          // Carreras no llegarán hasta entonces, y se le dice.
          await encolar({
            ruta: '/api/conductor/servicio',
            cuerpo: { enServicio: true, ...donde },
            descripcion: t('accion.entrarServicio'),
          });
          cambiarServicioSinRed(true);
          return;
        }
      } else {
        try {
          await api.servicio(false);
        } catch (error) {
          if (!(error instanceof ErrorDeRed)) throw error;
          await encolar({
            ruta: '/api/conductor/servicio',
            cuerpo: { enServicio: false },
            descripcion: t('accion.salirServicio'),
          });
          cambiarServicioSinRed(false);
          return;
        }
      }
      await refrescar();
    } catch (error) {
      setAviso(mensajeDeError(error, t('aviso.noSePudoServicio')));
    } finally {
      setOcupado(false);
    }
  }

  function cambiarServicioSinRed(dentro: boolean) {
    setEstado((e) => {
      if (!e) return e;
      const nuevo = { ...e, estado: dentro ? 'DISPONIBLE' : 'DESCONECTADO', ofertas: [] };
      guardarUltimo('conductor', nuevo);
      return nuevo;
    });
    setAviso(t(dentro ? 'sinRed.enServicioSinRed' : 'sinRed.guardada'));
  }

  async function suscribir() {
    setOcupado(true);
    try {
      await api.suscribir();
      setAviso('');
      await refrescar();
      alRecargarSesion();
    } catch (error) {
      setAviso(mensajeDeError(error, t('aviso.noSePudoRenovar')));
    } finally {
      setOcupado(false);
    }
  }

  // Dónde está el coche, para pintarlo en el plano.
  const posicion = posicionCoche ?? coordenadas.current;

  const pasajeros = estado?.pasajeros ?? [];

  // El mapa del taxista responde a una sola pregunta: ¿a dónde voy ahora?
  //   - Con alguien por recoger: a su punto de recogida, con la ruta desde
  //     donde está el coche (el caso inverso al del pasajero).
  //   - Con todos a bordo: al destino del primero que baja.
  //   - En servicio y sin nadie: su propio barrio, esperando.
  const primerPendiente = pasajeros.find((p) => p.estado !== 'RECOGIDO');
  const primerABordo = pasajeros.find((p) => p.estado === 'RECOGIDO');
  // Dónde está el pasajero AHORA, si su móvil lo está diciendo (P46-01).
  //
  // El punto de la solicitud es de cuando pidió el taxi: puede llevar diez
  // minutos esperando, y en ese rato la gente se mueve —cruza la calle, se
  // mete a la sombra, sale del portal—. La posición en vivo llegaba al taxista
  // desde la migración 046 y no la usaba nadie: se pintaba el pin donde pidió
  // y punto.
  //
  // Manda la de ahora solo si está FRESCA. Una posición de hace cinco minutos
  // no es mejor que el punto de la solicitud, es peor: mueve el pin sin motivo
  // y el taxista deja de fiarse de él.
  const enVivo = primerPendiente?.posicionCliente ?? null;
  const recogidaEnVivo = enVivo !== null && enVivo.frescuraSeg <= 90 ? enVivo : null;
  const siguienteParada = primerPendiente
    ? {
      lat: recogidaEnVivo?.lat ?? primerPendiente.origenLat,
      lng: recogidaEnVivo?.lng ?? primerPendiente.origenLng,
      nombre: primerPendiente.origen,
    }
    : primerABordo
      ? {
        lat: primerABordo.destinoLat,
        lng: primerABordo.destinoLng,
        nombre: primerABordo.destino,
      }
      : null;

  return (
    <main className="lienzo">
      <div className="capa-mapa">
        <Mapa
          puntos={puntos}
          taxi={posicion}
          origen={siguienteParada}
          destino={primerPendiente
            ? {
              lat: primerPendiente.destinoLat,
              lng: primerPendiente.destinoLng,
              nombre: primerPendiente.destino,
            }
            : null}
          encuadre={siguienteParada ? 'recogida' : 'persona'}
          rumbo={rumbo}
          rumboCoche={rumboCoche}
          origenEnVivo={recogidaEnVivo !== null}
          alCalcularRuta={(puntos) => {
            rutaViva.current = puntos;
            // Ruta nueva, avisos nuevos: la anterior podía ir por otras calles
            // y lo ya dicho no vale. Se vacía solo cuando cambia de verdad el
            // número de puntos o el final, no en cada recálculo por avanzar
            // veinte metros: si no, «en doscientos metros gire» se repetiría
            // cada vez que el coche se mueve.
            const fin = puntos && puntos.length > 0 ? puntos[puntos.length - 1] : null;
            const clave = fin ? `${fin.lat.toFixed(5)},${fin.lng.toFixed(5)}` : '';
            if (clave !== destinoGuiado.current) {
              destinoGuiado.current = clave;
              yaDichas.current = new Set();
            }
          }}
        />
        {/* Velocidad en vivo. Solo en servicio: fuera del turno ni se mide ni
            se enseña, por lo mismo que no se guarda el recorrido.

            Dónde va depende de si la hoja está abierta. Abajo a la izquierda
            —como en cualquier navegador— cuando el plano se ve entero; y
            ARRIBA, en una pastilla centrada, cuando la hoja está desplegada.
            Antes estaba siempre abajo y la hoja se lo comía: con el viaje en
            pantalla, que es casi todo el turno, el taxista solo veía su
            velocidad si escondía el panel. Un velocímetro que hay que
            destapar no es un velocímetro.

            `aria-live="off"`: un número que cambia cada segundo leído en voz
            alta por el lector de pantalla sería insoportable. */}
        {enServicio && velocidadKmh !== null && (
          <div
            className={panelPlegado ? 'velocimetro' : 'velocimetro velocimetro-arriba'}
            aria-live="off"
          >
            <strong>{velocidadKmh}</strong>
            <span>km/h</span>
          </div>
        )}
      </div>


      {enRecarga ? (
        <section className="hoja">
          <Recarga
            saldoXaf={estado?.saldoXaf ?? conductor.saldoXaf}
            t={t}
            idioma={idioma}
            alVolver={() => setEnRecarga(false)}
            alConfirmarPosible={() => { void refrescar(); alRecargarSesion(); }}
          />
        </section>
      ) : (
      <VistaConductor
        plegada={panelPlegado}
        conductor={conductor}
        estado={estado}
        demanda={demanda}
        aviso={aviso}
        avisoTurno={avisoTurno}
        sinRed={datosDe !== null || pendientes > 0 ? { datosDe, pendientes } : null}
        ocupado={ocupado}
        t={t}
        acciones={{
          alAbrirAjustes,
          alAbrirEstadisticas,
          alAbrirCampo,
          alAbrirRecarga: () => setEnRecarga(true),
          alSuscribir: suscribir,
          alAlternarServicio: alternarServicio,
          alAceptar: (id) => accion(id, 'aceptar'),
          alRechazar: (id) => accion(id, 'rechazar'),
          alSalir: (id) => accion(id, 'salir'),
          alLlegar: (id) => accion(id, 'he-llegado'),
          alRecoger: (id, pin) => accion(id, 'recoger', pin ? { pin } : {}),
          alDeclararAusente: (id) => accion(id, 'cliente-ausente'),
          alCompletar: (id) => accion(id, 'completar'),
          alLlamar: (id) => llamada.llamar(id),
          alDescartarAvisoTurno: () => setAvisoTurno(null),
        }}
      />
      )}

      {!enRecarga && (
        <MandosFlotantes
          plegada={panelPlegado}
          alAlternar={() => setPanelPlegado((p) => !p)}
          etiquetaPlegar={t('cabecera.ocultarPanel')}
          etiquetaDesplegar={t('cabecera.mostrarPanel')}
          mandos={[
            // Agente de campo (migración 025): mismo panel de taxi, más las
            // herramientas del mapa. Solo aparece para quien lo es.
            ...(conductor.agente && alAbrirCampo
              ? [{ icono: '🗺', etiqueta: t('campo.abrir'), alPulsar: alAbrirCampo }]
              : []),
            // La guía por voz, a un toque y en el plano: se enciende y se
            // apaga conduciendo, que es cuando se sabe si hace falta. Metida
            // en los ajustes habría que pararse para tocarla.
            {
              icono: conVoz ? '🔊' : '🔈',
              etiqueta: t(conVoz ? 'guia.apagar' : 'guia.encender'),
              alPulsar: () => {
                const nueva = alternarGuia();
                setConVoz(nueva);
                yaDichas.current = new Set();
                if (nueva) hablar(t('guia.encendida'), localeVoz(idioma));
              },
            },
            { icono: '▤', etiqueta: t('cabecera.tusNumeros'), alPulsar: alAbrirEstadisticas },
            { icono: '⚙', etiqueta: t('cabecera.tusDatos'), alPulsar: alAbrirAjustes },
          ]}
        />
      )}

      <PanelLlamada
        estado={llamada.estado}
        motivoFallo={llamada.motivoFallo}
        segundos={llamada.segundos}
        silenciado={llamada.silenciado}
        otroLadoAusente={llamada.otroLadoAusente}
        otro="pasajero"
        t={t}
        alAceptar={llamada.aceptar}
        alColgar={llamada.colgar}
        alAlternarSilencio={llamada.alternarSilencio}
      />
    </main>
  );
}
