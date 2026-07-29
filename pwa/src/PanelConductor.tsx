// Panel del taxista en la web. Existe para poder ver el sistema completo en
// localhost antes de separar las dos aplicaciones; la app Android nativa
// (carpeta android/) es la que se reparte a los conductores de verdad.
//
// Muestra solo lo que hace falta en cada momento: fuera de servicio, un botón;
// con una oferta, aceptar o rechazar; con pasajeros, un bloque por cada uno.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abrirEventosConductor, api, coordenadasOportunistas, enPruebasLocales,
  type DatosConductor, type EstadoConductor, type PuntoMapa, type Zona,
} from './api';
import { mensajeDeError } from './conexion';
import { porCercaniaA } from './geo';
import { crearT, localeVoz, type Idioma } from './i18n';
import { useLlamada, type SenalRecibida } from './llamada';
import Mapa from './Mapa';
import PanelLlamada from './PanelLlamada';
import Recarga from './Recarga';
import VistaConductor from './VistaConductor';
import { prepararSonido, sonarCarreraCancelada, sonarNuevaCarrera } from './sonidos';

export default function PanelConductor({
  conductor, puntos, idioma, alAbrirAjustes, alAbrirEstadisticas, alRecargarSesion,
}: {
  conductor: DatosConductor;
  puntos: PuntoMapa[];
  idioma: Idioma;
  alAbrirAjustes: () => void;
  alAbrirEstadisticas: () => void;
  // Los datos de sesión (verificación, suscripción) los tiene App: tras
  // pagar la cuota hay que pedirle que los recargue, o el panel seguiría
  // mostrando la situación anterior.
  alRecargarSesion: () => void;
}) {
  const t = crearT(idioma);
  const [estado, setEstado] = useState<EstadoConductor | null>(null);
  const [zonas, setZonas] = useState<Zona[]>([]);
  const [zonaElegida, setZonaElegida] = useState<number | null>(null);
  const [aviso, setAviso] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [enRecarga, setEnRecarga] = useState(false);
  const coordenadas = useRef<{ lat: number; lng: number } | null>(null);
  // La misma posición, pero como estado: es lo que mueve el coche en el mapa.
  // La referencia sola no basta — mutarla no repinta nada, y el mapa del
  // taxista se quedaba con el coche clavado hasta el siguiente latido
  // (20-30 s, más otros 60 de caché del GPS): conduciendo, eso es quedarse
  // quieto en otra calle.
  const [posicionCoche, setPosicionCoche] = useState<{ lat: number; lng: number } | null>(null);
  const ofertasAvisadas = useRef<Set<number>>(new Set());

  // Cambia el estado solo si el coche se ha movido de verdad (~13 m): las
  // lecturas de GPS parado bailan unos metros y repintarían el mapa en balde.
  const moverCoche = useCallback((nueva: { lat: number; lng: number } | null) => {
    if (!nueva) return;
    setPosicionCoche((previa) => {
      if (previa
        && Math.abs(previa.lat - nueva.lat) < 0.00012
        && Math.abs(previa.lng - nueva.lng) < 0.00012) return previa;
      return nueva;
    });
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
      const nuevo = await api.estadoConductor();
      setEstado(nuevo);

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
      setAviso(mensajeDeError(error, t('aviso.sinConexion')));
    }
  }, []);

  // Registro del dispositivo como este conductor y carga de zonas.
  useEffect(() => {
    api.registroConductor(conductor.telefono)
      .then((r) => setZonas(r.zonas))
      .catch(() => undefined);
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

  // Heartbeat y refresco mientras está en servicio. 20 s en primer plano: la
  // ventana del servidor son 120 s, así que sobra margen.
  useEffect(() => {
    const enServicio = estado !== null && estado.estado !== 'DESCONECTADO';
    const latir = async () => {
      // La posición se lee SIEMPRE, esté o no en servicio: el selector de zona
      // la necesita justo cuando está fuera, que es cuando se elige dónde
      // trabajar. Antes solo se leía estando dentro, así que a la hora de
      // elegir zona nunca se sabía dónde estaba el coche.
      coordenadas.current = await coordenadasOportunistas();
      moverCoche(coordenadas.current);
      if (enServicio) {
        try {
          await api.heartbeat(coordenadas.current);
        } catch {
          // Sin red: el siguiente latido reintenta.
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
    if (enPruebasLocales() && new URLSearchParams(window.location.search).has('gps')) return;
    if (!('geolocation' in navigator)) return;
    const vigilante = navigator.geolocation.watchPosition(
      (p) => {
        const nueva = { lat: p.coords.latitude, lng: p.coords.longitude };
        coordenadas.current = nueva;
        moverCoche(nueva);
      },
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => navigator.geolocation.clearWatch(vigilante);
  }, [moverCoche]);

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
      // Los mensajes del servidor son útiles tal cual: «expiró hace N
      // segundos», «quedan N segundos»…
      setAviso(mensajeDeError(error, t('aviso.noSePudo')));
      await refrescar();
    } finally {
      setOcupado(false);
    }
  }

  async function alternarServicio() {
    prepararSonido();
    const enServicio = estado !== null && estado.estado !== 'DESCONECTADO';
    setOcupado(true);
    setAviso('');
    try {
      if (!enServicio && zonaEfectiva === null) {
        setAviso(t('aviso.eligeZona'));
        return;
      }
      await api.servicio(!enServicio, zonaEfectiva ?? undefined);
      await refrescar();
    } catch (error) {
      setAviso(mensajeDeError(error, t('aviso.noSePudoServicio')));
    } finally {
      setOcupado(false);
    }
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

  // Zonas ordenadas por cercanía a donde está el coche. La primera es la que
  // el taxista quiere el 90 % de las veces; el resto está a un arrastre.
  //
  // Sin GPS se quedan en orden alfabético: es lo único honesto que se puede
  // hacer sin saber dónde está.
  const posicion = posicionCoche ?? coordenadas.current;
  const zonasOrdenadas = posicion ? porCercaniaA(posicion, zonas) : zonas;

  // La zona por defecto es la más cercana, no la primera de la lista. Antes se
  // cogía `zonas[0]` —alfabética— y por eso un taxista en Barrio Chino entraba
  // en servicio declarado en «Alcaide», y las carreras de su propia calle le
  // llegaban tarde, por la tercera oleada del reparto.
  const zonaEfectiva = zonaElegida ?? zonasOrdenadas[0]?.id ?? null;

  const pasajeros = estado?.pasajeros ?? [];

  // El mapa del taxista responde a una sola pregunta: ¿a dónde voy ahora?
  //   - Con alguien por recoger: a su punto de recogida, con la ruta desde
  //     donde está el coche (el caso inverso al del pasajero).
  //   - Con todos a bordo: al destino del primero que baja.
  //   - En servicio y sin nadie: su propio barrio, esperando.
  const primerPendiente = pasajeros.find((p) => p.estado !== 'RECOGIDO');
  const primerABordo = pasajeros.find((p) => p.estado === 'RECOGIDO');
  const siguienteParada = primerPendiente
    ? {
      lat: primerPendiente.origenLat,
      lng: primerPendiente.origenLng,
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
        />
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
        conductor={conductor}
        estado={estado}
        zonas={zonasOrdenadas}
        zonaElegida={zonaEfectiva}
        aviso={aviso}
        ocupado={ocupado}
        t={t}
        acciones={{
          alAbrirAjustes,
          alAbrirEstadisticas,
          alAbrirRecarga: () => setEnRecarga(true),
          alSuscribir: suscribir,
          alAlternarServicio: alternarServicio,
          alElegirZona: setZonaElegida,
          alAceptar: (id) => accion(id, 'aceptar'),
          alRechazar: (id) => accion(id, 'rechazar'),
          alSalir: (id) => accion(id, 'salir'),
          alLlegar: (id) => accion(id, 'he-llegado'),
          alRecoger: (id, pin) => accion(id, 'recoger', pin ? { pin } : {}),
          alDeclararAusente: (id) => accion(id, 'cliente-ausente'),
          alCompletar: (id) => accion(id, 'completar'),
          alLlamar: (id) => llamada.llamar(id),
        }}
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
