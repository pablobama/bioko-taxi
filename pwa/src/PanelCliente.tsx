// Panel del pasajero. El plano ocupa la pantalla y toda la interacción vive en
// una hoja inferior. Un solo botón grande por fase.
//
//   destino → esperando (pulso) → taxi en camino (coche + tiempo) → gracias
//
// La ubicación viene del GPS del teléfono. Si no lo tiene activado, elige a
// mano su referencia exacta: ese es el respaldo, no un error.
//
// El estado de verdad vive en el servidor; localStorage solo recuerda qué
// solicitud está activa. El registro lo hace App antes de llegar aquí.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abrirEventos, api, coordenadasOportunistas, enPruebasLocales,
  type DestinoSugerido, type DetalleSolicitud, type EventoSse, type Perfil, type PuntoMapa,
  type ReferenciaSugerida, type TaxisCerca,
} from './api';
import Estadisticas from './Estadisticas';
import { metrosEntre } from './geo';
import { mensajeDeError, ErrorDeRed, useConexion, ErrorDelServidor } from './conexion';
import IconoCategoria from './IconoCategoria';
import { crearT, localeVoz, type Idioma } from './i18n';
import { useLlamada, type SenalRecibida } from './llamada';
import MandosFlotantes from './MandosFlotantes';
import {
  encolar, guardarUltimo, olvidarUltimo, sincronizar, ultimoGuardado, usePendientes,
} from './sinRed';
import Mapa from './Mapa';
import PanelLlamada from './PanelLlamada';
import VistaCliente from './VistaCliente';
import {
  prepararSonido, sonarConductorCancelo, sonarSinTaxi, sonarTaxiEnCamino, sonarTaxiEsperando,
} from './sonidos';

type T = ReturnType<typeof crearT>;

type Fase =
  | 'cargando' | 'destino' | 'esperando'
  | 'sin_taxi' | 'asignado' | 'gracias' | 'ajustes' | 'estadisticas';

export interface PropiedadesPanelCliente {
  perfilInicial: Perfil | null;
  puntos: PuntoMapa[];
  idioma: Idioma;
}

// Buscador de referencias con coincidencia difusa del gazetteer.
function Buscador({
  etiqueta, valor, alElegir, autoFoco, t,
}: {
  etiqueta: string;
  valor: ReferenciaSugerida | null;
  alElegir: (r: ReferenciaSugerida | null) => void;
  autoFoco?: boolean;
  t: T;
}) {
  const [texto, setTexto] = useState('');
  const [sugerencias, setSugerencias] = useState<ReferenciaSugerida[]>([]);
  const [buscando, setBuscando] = useState(false);

  useEffect(() => {
    if (valor || texto.trim().length < 2) {
      setSugerencias([]);
      return;
    }
    setBuscando(true);
    const temporizador = setTimeout(() => {
      api.buscarReferencias(texto)
        .then(setSugerencias)
        .catch(() => setSugerencias([]))
        .finally(() => setBuscando(false));
    }, 280);
    return () => clearTimeout(temporizador);
  }, [texto, valor]);

  if (valor) {
    return (
      <button type="button" className="elegido" onClick={() => { alElegir(null); setTexto(''); }}>
        <span className="elegido-etiqueta">{etiqueta}</span>
        <span className="elegido-valor">{valor.nombre}</span>
        <span className="elegido-cambiar">{t('origen.cambiar')}</span>
      </button>
    );
  }
  return (
    <div className="buscador">
      <input
        type="text"
        value={texto}
        autoFocus={autoFoco}
        placeholder={etiqueta}
        onChange={(e) => setTexto(e.target.value)}
      />
      {sugerencias.length > 0 && (
        <ul className="sugerencias">
          {sugerencias.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => alElegir(s)}>
                <span className="fila-sugerencia">
                  <span className="sug-sigla">
                    <IconoCategoria categoria={s.categoria} t={t} />
                  </span>
                  <span className="sug-textos">
                    <span className="sug-nombre">{s.nombre}</span>
                    <span className="sug-zona">{s.zona}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!buscando && texto.trim().length >= 2 && sugerencias.length === 0 && (
        <p className="nota">{t('buscador.sinResultados')}</p>
      )}
    </div>
  );
}

// Formulario del perfil. En el registro solo pide contacto; en ajustes añade
// los datos opcionales. Nombre, edad y género no se piden nunca para poder
// viajar: solo si el usuario quiere darlos.
function FormularioPerfil({
  inicial, soloContacto, alGuardar, alFallar, t,
}: {
  inicial: Perfil | null;
  soloContacto?: boolean;
  alGuardar: (perfil: Perfil) => void;
  alFallar: (mensaje: string) => void;
  t: T;
}) {
  const [telefono, setTelefono] = useState(inicial?.telefono ?? '');
  const [correo, setCorreo] = useState(inicial?.correo ?? '');
  const [nombre, setNombre] = useState(inicial?.nombre ?? '');
  const [edad, setEdad] = useState(inicial?.edad ? String(inicial.edad) : '');
  const [genero, setGenero] = useState(inicial?.genero ?? '');
  const [guardando, setGuardando] = useState(false);

  const hayContacto = telefono.trim().length > 0 || correo.trim().length > 0;

  async function guardar() {
    if (!hayContacto) {
      alFallar(t('aviso.faltaContacto'));
      return;
    }
    setGuardando(true);
    try {
      const respuesta = await api.guardarPerfil({
        telefono: telefono.trim() || null,
        correo: correo.trim() || null,
        nombre: nombre.trim() || null,
        edad: edad.trim() ? Number(edad) : null,
        genero: genero || null,
      });
      alFallar('');
      alGuardar(respuesta.perfil);
    } catch (error) {
      alFallar(error instanceof Error ? error.message : t('accion.guardar'));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <>
      <input
        type="tel"
        value={telefono}
        placeholder={t('campo.telefono')}
        onChange={(e) => setTelefono(e.target.value)}
      />
      <input
        type="email"
        value={correo}
        placeholder={t('campo.correoOpcional')}
        onChange={(e) => setCorreo(e.target.value)}
      />

      {!soloContacto && (
        <>
          <p className="nota">{t('campo.opcionalesIntro')}</p>
          <input
            type="text"
            value={nombre}
            placeholder={t('campo.tuNombre')}
            onChange={(e) => setNombre(e.target.value)}
          />
          <div className="fila">
            <input
              type="number"
              value={edad}
              placeholder={t('campo.edad')}
              onChange={(e) => setEdad(e.target.value)}
            />
            <select value={genero} onChange={(e) => setGenero(e.target.value)}>
              <option value="">{t('campo.generoPlaceholder')}</option>
              <option value="mujer">{t('genero.mujer')}</option>
              <option value="hombre">{t('genero.hombre')}</option>
              <option value="otro">{t('genero.otro')}</option>
              <option value="sin_decir">{t('genero.sinDecir')}</option>
            </select>
          </div>
        </>
      )}

      <button type="button" className="principal" disabled={!hayContacto || guardando} onClick={guardar}>
        {guardando ? t('accion.guardando') : soloContacto ? t('accion.empezar') : t('accion.guardar')}
      </button>
    </>
  );
}

export default function PanelCliente({ perfilInicial, puntos, idioma }: PropiedadesPanelCliente) {
  const t = crearT(idioma);
  const [fase, setFase] = useState<Fase>('cargando');
  const [perfil, setPerfil] = useState<Perfil | null>(perfilInicial);
  const [origen, setOrigen] = useState<ReferenciaSugerida | null>(null);
  const [destino, setDestino] = useState<ReferenciaSugerida | null>(null);
  const [detalle, setDetalle] = useState<DetalleSolicitud | null>(null);
  const [aviso, setAviso] = useState('');
  const [coordenadas, setCoordenadas] = useState<
    { lat: number; lng: number; precision?: number | null } | null
  >(null);
  // Hoja recogida: el plano se ve entero. Lo manda el botón flotante.
  const [panelPlegado, setPanelPlegado] = useState(false);
  // Sin red (migración 057): de cuándo es el viaje que se está enseñando si no
  // es de ahora. null = fresco.
  const [datosDe, setDatosDe] = useState<string | null>(null);
  const ultimaFrescura = useRef<string | null>(null);
  const pendientes = usePendientes();
  const enLinea = useConexion();
  const [gpsResuelto, setGpsResuelto] = useState(false);
  const [valorada, setValorada] = useState(false);
  // Destinos de un toque y si la persona ha pedido escribir en su lugar.
  const [sugeridos, setSugeridos] = useState<DestinoSugerido[]>([]);
  const [escribiendo, setEscribiendo] = useState(false);
  const [taxisCerca, setTaxisCerca] = useState<TaxisCerca | null>(null);
  // Cuándo se pidió el taxi, para la ventana de «deshacer», y un reloj que
  // late cada segundo mientras hay cuenta atrás que enseñar.
  const [pedidoEn, setPedidoEn] = useState<number | null>(null);
  const [ahora, setAhora] = useState(() => Date.now());
  // El plazo de gracia llega del servidor como «cuántos segundos faltan». Se
  // apunta cuándo llegó para descontarlos con el reloj LOCAL: así un móvil con
  // la hora mal puesta sigue viendo la cuenta atrás correcta.
  const gracia = useRef<{ seg: number; recibidaEn: number } | null>(null);
  const cerrarSse = useRef<(() => void) | null>(null);
  const avisoLlegadaDado = useRef(false);
  // Ver el efecto que deduce el origen por GPS: si se quitó a mano, no se
  // vuelve a deducir hasta el siguiente viaje.
  const origenQuitadoAMano = useRef(false);
  // Avisos sonoros: se disparan al CAMBIAR de estado, no en cada refresco.
  const estadoAnterior = useRef<string | null>(null);

  const solicitudActiva = (): number | null => {
    const guardada = localStorage.getItem('solicitudActiva');
    return guardada ? Number(guardada) : null;
  };

  // Llamada con el taxista, solo mientras hay viaje vivo: la misma ventana que
  // aplica el servidor.
  const hayViajeVivo = detalle !== null
    && ['ACEPTADO', 'EN_CAMINO', 'RECOGIDO'].includes(detalle.estado);
  const llamada = useLlamada({ vivo: hayViajeVivo, locale: localeVoz(idioma) });
  const recibirSenal = useRef<((id: number, s: SenalRecibida) => void) | null>(null);
  recibirSenal.current = llamada.alRecibirSenal;

  const limpiar = useCallback(() => {
    localStorage.removeItem('solicitudActiva');
    // Un viaje terminado no puede volver a salir mañana «sin red» como si
    // siguiera en marcha.
    olvidarUltimo('cliente');
    cerrarSse.current?.();
    cerrarSse.current = null;
    setDetalle(null);
    setDestino(null);
    setValorada(false);
    setEscribiendo(false);
    avisoLlegadaDado.current = false;
    estadoAnterior.current = null;
    gracia.current = null;
    // Viaje nuevo, sitio probablemente nuevo: se vuelve a deducir el origen.
    origenQuitadoAMano.current = false;
    setPedidoEn(null);
    setFase('destino');
  }, []);

  const aplicarEstado = useCallback((estado: DetalleSolicitud) => {
    setDetalle(estado);
    // Lo último que se supo del viaje, para poder enseñarlo sin red: el PIN,
    // el taxista y la matrícula hacen falta justo en la acera, que es donde se
    // va la cobertura.
    guardarUltimo('cliente', estado);
    ultimaFrescura.current = new Date().toISOString();
    setDatosDe(null);
    gracia.current = estado.graciaCancelacionSeg === null
      ? null
      : { seg: estado.graciaCancelacionSeg, recibidaEn: Date.now() };

    const previo = estadoAnterior.current;
    if (previo !== estado.estado) {
      // «Tu taxi va en camino»: al aceptar y al confirmar salida.
      if (estado.estado === 'ACEPTADO' && previo !== 'ACEPTADO') {
        sonarTaxiEnCamino(estado.matricula, localeVoz(idioma));
      }
      // «Ahora no hay taxi»: quien espera de pie en la calle, con el teléfono
      // guardado, necesita saberlo sin tener que mirar. Antes solo cambiaba
      // el texto en pantalla.
      if (estado.estado === 'SIN_OFERTA') {
        sonarSinTaxi(localeVoz(idioma));
      }
      estadoAnterior.current = estado.estado;
    }
    // «Tu taxi te está esperando»: la señal fiable es que el conductor pulse
    // «he llegado», que no depende de que el pasajero comparta ubicación. La
    // proximidad sirve de refuerzo cuando sí la comparte.
    const haLlegado = estado.taxiHaLlegado
      || (estado.estado === 'EN_CAMINO' && estado.taxi !== null && estado.taxi.distanciaM < 150);
    if (haLlegado && !avisoLlegadaDado.current) {
      avisoLlegadaDado.current = true;
      sonarTaxiEsperando(estado.matricula, localeVoz(idioma));
    }

    if (['SOLICITADO', 'EMITIDO'].includes(estado.estado)) {
      setFase('esperando');
    } else if (['ACEPTADO', 'EN_CAMINO', 'RECOGIDO'].includes(estado.estado)) {
      setFase('asignado');
    } else if (estado.estado === 'COMPLETADO') {
      localStorage.removeItem('solicitudActiva');
      cerrarSse.current?.();
      cerrarSse.current = null;
      setFase('gracias');
    } else if (estado.estado === 'SIN_OFERTA') {
      setFase('sin_taxi');
    } else {
      limpiar();
    }
  }, [limpiar]);

  const escuchar = useCallback((solicitudId: number) => {
    cerrarSse.current?.();
    cerrarSse.current = abrirEventos(solicitudId, (evento: EventoSse) => {
      if (evento.tipo === 'estado') {
        aplicarEstado(evento.datos as unknown as DetalleSolicitud);
      } else if (evento.tipo === 'llamada') {
        // Por el mismo canal viaja el apretón de manos de la llamada. Se lee
        // de una referencia y no de la propia función para no reabrir la
        // conexión cada vez que cambia el estado de la llamada.
        recibirSenal.current?.(solicitudId, evento.datos as unknown as SenalRecibida);
      } else if (evento.tipo === 'C3_sin_conductor') {
        sonarSinTaxi(localeVoz(idioma));
        setFase('sin_taxi');
      } else if (evento.tipo === 'C4_conductor_cancelo') {
        sonarConductorCancelo(localeVoz(idioma));
        setAviso(t('aviso.conductorCancelo'));
        limpiar();
      } else {
        api.estado(solicitudId).then(aplicarEstado).catch(() => undefined);
      }
    });
  }, [aplicarEstado, limpiar]);

  // Al abrir: GPS y solicitud activa si la había. El perfil y el plano ya los
  // trae App, que es quien decidió mostrar este panel.
  useEffect(() => {
    void coordenadasOportunistas().then((c) => {
      setCoordenadas(c);
      setGpsResuelto(true);
    });

    const activa = solicitudActiva();
    if (!activa) {
      setFase('destino');
      return;
    }
    let reintento: ReturnType<typeof setTimeout> | undefined;
    let escuchando = false;
    const cargar = () => {
      api.estado(activa)
        .then((estado) => {
          aplicarEstado(estado);
          // También con el taxi ya asignado: por esta conexión entran las
          // llamadas. Antes solo se abría mientras se buscaba taxi, así que al
          // recargar la página en mitad de un viaje el teléfono dejaba de sonar.
          if (!escuchando
            && ['SOLICITADO', 'EMITIDO', 'ACEPTADO', 'EN_CAMINO', 'RECOGIDO'].includes(estado.estado)) {
            escuchando = true;
            escuchar(activa);
          }
        })
        .catch((error) => {
          // Antes, CUALQUIER fallo borraba el viaje activo, y sin red también:
          // quien abría la aplicación en la acera sin cobertura perdía su PIN y
          // los datos de su taxista justo cuando los necesitaba para subir.
          // Ahora el viaje solo se olvida si el SERVIDOR dice que ya no existe
          // (un 4xx). Sin red, o con el servidor fallando —Render devuelve 502
          // mientras despierta y durante cada despliegue—, se enseña el último
          // estado conocido con su hora, y se sigue intentando.
          if (error instanceof ErrorDeRed || (error instanceof ErrorDelServidor && error.estado >= 500)) {
            const guardado = ultimoGuardado<DetalleSolicitud>('cliente');
            // Como texto: el servidor manda los identificadores bigint como
            // cadena y `solicitudActiva` devuelve un número. Comparados tal
            // cual no coinciden nunca, y la pantalla se quedaba en «Cargando…»
            // con el viaje guardado sin enseñar. Pasó al probarlo.
            if (guardado && String(guardado.valor.solicitudId) === String(activa)) {
              // Sin sonidos: al abrir no ha cambiado nada, solo se recuerda.
              estadoAnterior.current = guardado.valor.estado;
              setDetalle(guardado.valor);
              setFase(['SOLICITADO', 'EMITIDO'].includes(guardado.valor.estado) ? 'esperando' : 'asignado');
              setDatosDe(guardado.guardadoEn);
              // Con la fase puesta, el refresco periódico ya se encarga de
              // ponerlo al día en cuanto el servidor conteste.
            } else {
              // Nada guardado que enseñar: «Cargando…» es la verdad, pero no
              // puede quedarse ahí para siempre. Se reintenta solo.
              reintento = setTimeout(cargar, 10_000);
            }
            if (!escuchando) {
              escuchando = true;
              escuchar(activa);
            }
            return;
          }
          limpiar();
        });
    };
    cargar();
    return () => {
      clearTimeout(reintento);
      cerrarSse.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Con GPS y mapa cargados, el origen se deduce: la referencia más cercana.
  //
  // Salvo si la persona acaba de quitarlo a mano: sin esta marca, el botón
  // «cambiar» borraba el origen y este efecto lo volvía a rellenar en el
  // mismo instante con la misma referencia — parecía que el botón no
  // respondía, cuando en realidad respondía y se deshacía solo.
  useEffect(() => {
    if (origen || !coordenadas || puntos.length === 0) return;
    if (origenQuitadoAMano.current) return;
    let mejor: PuntoMapa | null = null;
    let mejorDistancia = Number.POSITIVE_INFINITY;
    for (const punto of puntos) {
      const d = metrosEntre(coordenadas, punto);
      if (d < mejorDistancia) {
        mejorDistancia = d;
        mejor = punto;
      }
    }
    // Más de 3 km del punto conocido más cercano: mejor que lo elija a mano.
    if (mejor && mejorDistancia < 3000) {
      setOrigen({
        id: mejor.id, nombre: mejor.nombre, zona: '', lat: mejor.lat, lng: mejor.lng, categoria: mejor.categoria,
      });
    }
  }, [coordenadas, puntos, origen]);

  // Destinos de un toque. Se piden al saber de dónde sale, porque el origen
  // decide con qué se completa la lista cuando el historial propio no llega.
  // Se dejan de pedir en cuanto hay viaje: durante el viaje no se elige nada.
  useEffect(() => {
    if (fase !== 'destino') return;
    let vivo = true;
    api.destinosSugeridos(origen?.id)
      .then((lista) => { if (vivo) setSugeridos(lista); })
      .catch(() => { if (vivo) setSugeridos([]); });
    return () => { vivo = false; };
  }, [fase, origen?.id]);

  // Cuántos taxis pueden venir. Se pide al saber de dónde sale y se renueva
  // cada minuto mientras elige destino, que es cuando sirve para decidir.
  //
  // Se BORRA al salir de esa pantalla y cuando falla la petición: un conteo de
  // hace diez minutos enseñado como si fuera de ahora es la misma mentira que
  // el código se niega a contar con el estado del viaje. Mejor no decir nada.
  useEffect(() => {
    if (fase !== 'destino' || !origen) {
      setTaxisCerca(null);
      return;
    }
    let vivo = true;
    const contar = () => {
      api.taxisCerca(origen.id)
        .then((c) => { if (vivo) setTaxisCerca(c); })
        .catch(() => { if (vivo) setTaxisCerca(null); });
    };
    contar();
    const temporizador = setInterval(contar, 60_000);
    return () => {
      vivo = false;
      clearInterval(temporizador);
    };
  }, [fase, origen]);

  // Reloj de un segundo. Solo late cuando hay una cuenta atrás en pantalla:
  // el resto del tiempo redibujar cada segundo sería gastar batería para nada.
  useEffect(() => {
    if (fase !== 'esperando' && fase !== 'asignado') return;
    const t = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(t);
  }, [fase]);

  // GPS continuo mientras el viaje está activo (recogida y cierre automáticos).
  useEffect(() => {
    const estadoActual = detalle?.estado ?? '';
    if (!['ACEPTADO', 'EN_CAMINO', 'RECOGIDO'].includes(estadoActual)) return;
    const enviar = () => {
      const activa = solicitudActiva();
      if (!activa) return;
      void coordenadasOportunistas().then((c) => {
        if (c) {
          setCoordenadas(c);
          api.enviarPosicion(activa, c).catch(() => undefined);
        }
      });
    };
    enviar();
    const temporizador = setInterval(enviar, 25_000);
    return () => clearInterval(temporizador);
  }, [detalle?.estado]);

  // Mientras va DENTRO del coche, su punto en el mapa se mueve solo.
  //
  // El envío al servidor sigue siendo cada 25 s —es lo que alimenta el cierre
  // automático y a quien le esté siguiendo, y no hace falta más—, pero para
  // DIBUJAR eso son saltos de casi trescientos metros a velocidad de ciudad:
  // el punto pegaría brincos en vez de avanzar. Esto solo pinta: no manda nada
  // y no cuesta datos.
  //
  // Solo a bordo. El resto del tiempo la posición se lee cuando hace falta, y
  // tener el GPS abierto sin necesidad es batería de alguien que quizá lleva
  // toda la tarde fuera de casa.
  useEffect(() => {
    if (detalle?.estado !== 'RECOGIDO') return;
    if (enPruebasLocales() && new URLSearchParams(window.location.search).has('gps')) return;
    if (!('geolocation' in navigator)) return;
    let vigilancia = 0;
    vigilancia = navigator.geolocation.watchPosition(
      (p) => setCoordenadas({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => undefined,
      { enableHighAccuracy: true, maximumAge: 5000 },
    );
    return () => navigator.geolocation.clearWatch(vigilancia);
  }, [detalle?.estado]);

  // En cuanto vuelve la red: lo pendiente sale, y el viaje se pone al día sin
  // esperar al siguiente refresco.
  useEffect(() => {
    if (!enLinea) return;
    void sincronizar(api.enviarPendiente, (e) => e instanceof ErrorDeRed);
    const activa = solicitudActiva();
    if (activa) api.estado(activa).then(aplicarEstado).catch(() => undefined);
  }, [enLinea, aplicarEstado]);

  // Refresco del estado mientras el taxi viene: mueve el coche y el ETA.
  useEffect(() => {
    if (fase !== 'asignado' && fase !== 'esperando') return;
    const temporizador = setInterval(() => {
      const activa = solicitudActiva();
      if (activa) {
        api.estado(activa).then(aplicarEstado).catch((error) => {
          // Sin red o con el servidor fallando, lo que se ve deja de ser de
          // ahora: se dice de cuándo es.
          if (error instanceof ErrorDeRed || (error instanceof ErrorDelServidor && error.estado >= 500)) {
            setDatosDe(ultimaFrescura.current);
          }
        });
      }
    }, fase === 'asignado' ? 10_000 : 20_000);
    return () => clearInterval(temporizador);
  }, [fase, aplicarEstado]);

  async function pedir() {
    if (!origen || !destino) {
      setAviso(t('aviso.faltaOrigenDestino'));
      return;
    }
    // Este clic es la ocasión para desbloquear el audio: los navegadores no
    // dejan sonar nada sin un gesto previo del usuario.
    prepararSonido();
    setAviso('');
    try {
      const respuesta = await api.pedirTaxi(origen.id, destino.id, coordenadas);
      localStorage.setItem('solicitudActiva', String(respuesta.solicitudId));
      setPedidoEn(Date.now());
      if (respuesta.estado === 'SIN_OFERTA') {
        // Camino distinto al de aplicarEstado/C3_sin_conductor: cuando no hay
        // NINGÚN taxista en la zona, el propio POST de pedir responde ya
        // «SIN_OFERTA», sin pasar por el flujo de eventos. Sin este aviso
        // aquí, ese caso —probablemente el más común de los tres— se quedaba
        // mudo, justo el que descubrí al probarlo: pedí sin ningún taxista en
        // servicio y no sonó nada.
        sonarSinTaxi(localeVoz(idioma));
        setFase('sin_taxi');
        return;
      }
      setFase('esperando');
      escuchar(respuesta.solicitudId);
      api.estado(respuesta.solicitudId).then(aplicarEstado).catch(() => undefined);
    } catch (error) {
      // Sin red no se guarda para después, a propósito: una petición que sale
      // veinte minutos tarde manda un taxi a quien ya se fue. Se dice claro y
      // el destino se queda elegido para pulsar otra vez.
      setAviso(error instanceof ErrorDeRed
        ? t('sinRed.pedirNecesitaRed')
        : mensajeDeError(error, t('aviso.noSePudoPedir')));
    }
  }

  async function cancelar() {
    const activa = solicitudActiva();
    if (!activa) return;
    try {
      const resultado = await api.cancelar(activa);
      setAviso(resultado.strike ? t('aviso.canceladoTarde') : '');
      limpiar();
    } catch (error) {
      // Tampoco se guarda: una cancelación tardía llega con el taxista ya en la
      // puerta. Si el taxi ya viene, lo que sirve es llamarle.
      setAviso(error instanceof ErrorDeRed
        ? t('sinRed.cancelarNecesitaRed')
        : mensajeDeError(error, t('aviso.noSePudoCancelar')));
    }
  }

  async function valorar(puntuacion: number) {
    const solicitudId = detalle?.solicitudId;
    if (!solicitudId) return;
    setValorada(true);
    try {
      await api.valorar(solicitudId, puntuacion);
    } catch (error) {
      if (error instanceof ErrorDeRed) {
        // La valoración sí espera: es una opinión sobre algo que ya pasó, y
        // llegar tarde no cambia nada. Se queda dada.
        await encolar({
          ruta: `/api/solicitudes/${solicitudId}/valoracion`,
          cuerpo: { puntuacion },
          descripcion: t('sinRed.valoracion'),
        });
        return;
      }
      setValorada(false);
      setAviso(t('aviso.noSePudoValorar'));
    }
  }

  // --- Pantalla -----------------------------------------------------------

  // El punto exacto de la persona, si el GPS es lo bastante fino. El mismo
  // umbral que usa el servidor para decidir el punto de recogida
  // (`recogida_precision_maxima_m`): por encima de eso una coordenada no es un
  // punto, es un barrio, y entonces el sitio conocido dice más.
  const PRECISION_MAXIMA_M = 120;
  const gpsFino = coordenadas !== null
    && (coordenadas.precision == null || coordenadas.precision <= PRECISION_MAXIMA_M);

  // Dónde se planta el pin ANTES de pedir. Ya no en el sitio conocido más
  // cercano: ahí es donde la aplicación mentía. El taxi se manda a donde está
  // la persona —el servidor ya lo hacía desde la migración 046— pero el mapa
  // seguía enseñando el pin sobre «Mercado Central», a veces a doscientos
  // metros, y quien lo veía se creía que el taxi iba al mercado.
  //
  // El sitio conocido sigue, pero en su papel: el NOMBRE con el que se
  // entienden un taxista y un pasajero en una ciudad sin direcciones. Punto
  // donde estás, nombre de al lado.
  const marcaOrigen = detalle
    ? { lat: detalle.origenLat, lng: detalle.origenLng, nombre: detalle.origen }
    : gpsFino
      ? { lat: coordenadas!.lat, lng: coordenadas!.lng, nombre: origen?.nombre ?? 'Estás aquí' }
      : origen
        ? { lat: origen.lat, lng: origen.lng, nombre: origen.nombre }
        : coordenadas
          ? { lat: coordenadas.lat, lng: coordenadas.lng, nombre: 'Estás aquí' }
          : null;
  const marcaDestino = detalle
    ? { lat: detalle.destinoLat, lng: detalle.destinoLng, nombre: detalle.destino }
    : destino
      ? { lat: destino.lat, lng: destino.lng, nombre: destino.nombre }
      : null;

  // Ventana de arrepentimiento tras pedir. No retrasa la petición —eso le
  // costaría cinco segundos a TODO el mundo para proteger al que se equivoca—
  // sino que durante ese rato el botón de cancelar se ofrece de otra manera.
  // Mientras se busca taxi, cancelar es gratis siempre: no hay nada que perder.
  const VENTANA_DESHACER_MS = 5_000;
  const puedeDeshacer = pedidoEn !== null && ahora - pedidoEn < VENTANA_DESHACER_MS;

  // Segundos que quedan de cancelación gratuita, descontados con el reloj
  // local desde el último dato del servidor.
  const segundosGracia = gracia.current === null
    ? null
    : Math.max(0, Math.round(gracia.current.seg - (ahora - gracia.current.recibidaEn) / 1000));

  // Qué encuadra el mapa en cada momento:
  //   - Antes de pedir y mientras busca: dónde está ella. Es lo único que hay.
  //   - Taxi asignado: el coche y el recorrido que le queda para llegar.
  //   - Ya a bordo: el trayecto hasta su destino.
  const aBordo = detalle?.estado === 'RECOGIDO';
  const encuadre = fase !== 'asignado' ? 'persona' : aBordo ? 'viaje' : 'recogida';
  // El coche deja de verse en cuanto sube: a partir de ahí dónde está el
  // taxista no es asunto del pasajero. El servidor ya deja de enviar su
  // posición al pasar a RECOGIDO; esto es la segunda cerradura, para que el
  // mapa no dependa de que la primera siga puesta.
  const taxiVisible = aBordo ? null : detalle?.taxi ?? null;
  const paradasCompartidas = aBordo && detalle?.compartido
    && detalle.compartido.ruta.length > 1
    ? detalle.compartido.ruta.map((p) => ({ lat: p.lat, lng: p.lng, esTuya: p.esTuya }))
    : undefined;

  if (fase === 'cargando') {
    return <main className="lienzo"><div className="cargando">{t('app.cargando')}</div></main>;
  }

  // Un solo mapa para todas las fases: si estuviera dentro de cada rama, React
  // lo desmontaría y recrearía en cada cambio de pantalla.
  return (
    <main className="lienzo">
      <div className="capa-mapa">
        <Mapa
          puntos={puntos}
          origen={marcaOrigen}
          destino={marcaDestino}
          taxi={taxiVisible}
          buscando={fase === 'esperando'}
          encuadre={encuadre}
          paradas={paradasCompartidas}
          yo={aBordo ? coordenadas : null}
        />
      </div>

      <PanelLlamada
        estado={llamada.estado}
        motivoFallo={llamada.motivoFallo}
        segundos={llamada.segundos}
        silenciado={llamada.silenciado}
        otroLadoAusente={llamada.otroLadoAusente}
        otro="taxista"
        t={t}
        alAceptar={llamada.aceptar}
        alColgar={llamada.colgar}
        alAlternarSilencio={llamada.alternarSilencio}
      />

      {fase === 'estadisticas' && (
        <section className="hoja">
          <Estadisticas t={t} idioma={idioma} alVolver={() => setFase('destino')} />
        </section>
      )}

      {fase === 'ajustes' && (
        <section className="hoja">
          {aviso && <p className="aviso">{aviso}</p>}
          <h1>{t('ajustesCliente.titulo')}</h1>
          <FormularioPerfil
            inicial={perfil}
            t={t}
            alGuardar={(guardado) => { setPerfil(guardado); setAviso(''); setFase('destino'); }}
            alFallar={setAviso}
          />
          <button type="button" className="secundario" onClick={() => { setAviso(''); setFase('destino'); }}>
            {t('accion.volver')}
          </button>
        </section>
      )}

      {fase !== 'estadisticas' && fase !== 'ajustes' && (
        <MandosFlotantes
          plegada={panelPlegado}
          alAlternar={() => setPanelPlegado((p) => !p)}
          etiquetaPlegar={t('cabecera.ocultarPanel')}
          etiquetaDesplegar={t('cabecera.mostrarPanel')}
          mandos={[
            { icono: '▤', etiqueta: t('cabecera.tusNumeros'), alPulsar: () => setFase('estadisticas') },
            { icono: '⚙', etiqueta: t('cabecera.tusDatos'), alPulsar: () => setFase('ajustes') },
          ]}
        />
      )}

      {fase !== 'estadisticas' && fase !== 'ajustes' && (
        <VistaCliente
          plegada={panelPlegado}
          sinRed={datosDe !== null || pendientes > 0 ? { datosDe, pendientes } : null}
          fase={fase}
          detalle={detalle}
          origen={origen}
          destino={destino}
          gpsResuelto={gpsResuelto}
          origenEnGps={gpsFino}
          taxisCerca={taxisCerca}
          hayCoordenadas={coordenadas !== null}
          valorada={valorada}
          aviso={aviso}
          t={t}
          sugeridos={sugeridos}
          escribiendo={escribiendo}
          puedeDeshacer={puedeDeshacer}
          segundosGracia={segundosGracia}
          buscadorDestino={(
            <Buscador etiqueta={t('buscador.destino')} valor={destino} alElegir={setDestino} autoFoco t={t} />
          )}
          buscadorOrigen={(
            <Buscador etiqueta={t('buscador.origen')} valor={origen} alElegir={setOrigen} t={t} />
          )}
          acciones={{
            alAbrirAjustes: () => setFase('ajustes'),
            alAbrirEstadisticas: () => setFase('estadisticas'),
            alPedir: pedir,
            alCancelar: cancelar,
            alLimpiar: limpiar,
            alValorar: valorar,
            alQuitarOrigen: () => { origenQuitadoAMano.current = true; setOrigen(null); },
            alElegirDestino: (elegido) => { setDestino(elegido); setAviso(''); },
            alEscribirDestino: () => setEscribiendo(true),
            alLlamar: () => { if (detalle) llamada.llamar(detalle.solicitudId); },
          }}
        />
      )}
    </main>
  );
}
