// Panel de operador (PENDIENTES.md P21-01): la mesa de trabajo de quien
// opera la plataforma — el cuadro de mandos con sus alarmas, la central
// telefónica, incidencias por revisar, fichas de conductores y pasajeros,
// pagos por confirmar, el catálogo de sitios y los mandos del sistema.
// Solo en español a propósito: es herramienta interna, no cara al pasajero
// ni al taxista, así que no pasa por i18n.ts.

import { useEffect, useState } from 'react';
import {
  api,
  type BandaOperador, type ConductorOperador, type EstadisticasOperador,
  type FichaConductorOperador, type FichaPasajeroOperador, type IncidenciaOperador,
  type ParametroOperador, type PasajeroOperador, type PeriodoRecorrido,
  type RecargaOperador, type RecorridoOperador, type ReferenciaOperador,
  type SaludOperador, type SolicitudCentral, type TransicionOperador,
  type ViajeResumenOperador, type ZonaOperador,
} from './api';
import { ESTILO_CATEGORIA } from './categorias';
import Mapa from './Mapa';

// Las categorías que la base acepta (CHECK de la migración 021). Se sacan de
// donde ya estaban —el mismo sitio que dibuja los pictogramas del mapa— para
// que no haya dos listas que se separen.
//
// Fuera «zona»: la reserva el propio barrio cuando se sitúa con el GPS, y no
// es algo que se elija al dar de alta un sitio.
const CATEGORIAS = Object.keys(ESTILO_CATEGORIA).filter((c) => c !== 'zona').sort();

const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: 'Pendiente',
  verificado: 'Verificado',
  suspendido: 'Suspendido',
  bloqueado: 'Bloqueado',
};

const ETIQUETA_ESTADO_RECARGA: Record<string, string> = {
  pendiente: 'Pendiente',
  confirmada: 'Confirmada',
  rechazada: 'Rechazada',
  caducada: 'Caducada',
};

const ETIQUETA_METODO: Record<string, string> = {
  muni_dinero: 'Muni Dinero',
  efectivo: 'Efectivo',
};

const ETIQUETA_TIPO_INCIDENCIA: Record<string, string> = {
  no_presentado_dudoso: 'Cliente ausente dudoso',
};

const ETIQUETA_VIAJE: Record<string, string> = {
  SOLICITADO: 'Solicitado',
  EMITIDO: 'Buscando taxi',
  ACEPTADO: 'Taxi asignado',
  EN_CAMINO: 'Taxi en camino',
  RECOGIDO: 'A bordo',
};

function fecha(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function porciento(tasa: number): string {
  return `${Math.round(tasa * 100)} %`;
}

function Dato({ valor, etiqueta, rojo }: { valor: number | string; etiqueta: string; rojo?: boolean }) {
  return (
    <div className={rojo ? 'dato dato-rojo' : 'dato'}>
      <span className="dato-valor">{valor}</span>
      <span className="dato-etiqueta">{etiqueta}</span>
    </div>
  );
}

function Buscador({ alBuscar, placeholder }: { alBuscar: (q: string) => void; placeholder?: string }) {
  const [texto, setTexto] = useState('');
  useEffect(() => {
    const t = setTimeout(() => alBuscar(texto.trim()), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texto]);
  return (
    <input
      type="search"
      value={texto}
      placeholder={placeholder ?? 'Buscar por nombre, teléfono o matrícula…'}
      onChange={(e) => setTexto(e.target.value)}
    />
  );
}

function ListaViajes({ viajes }: { viajes: ViajeResumenOperador[] }) {
  if (viajes.length === 0) return <p className="nota">Sin viajes todavía.</p>;
  return (
    <ul className="ruta">
      {viajes.map((v) => (
        <li key={v.id}>
          {fecha(v.creada_en)} · {v.origen} → {v.destino} · {v.estado}
          {v.conductor ? ` · ${v.conductor}` : ''}
        </li>
      ))}
    </ul>
  );
}

// --- Captura de posición con el GPS ------------------------------------------

// Lo usan tanto los barrios como los sitios: se pulsa ESTANDO allí.
//
// Se ESPERA a que el GPS fije, en vez de coger la primera lectura. La primera
// casi siempre viene de la antena de telefonía o de la wifi —cientos o miles
// de metros— y cae dentro de Malabo, así que pasaría cualquier comprobación
// de recuadro y el sitio quedaría guardado donde no está.
//
// El umbral real lo aplica el servidor al situar barrios (parámetro
// gps_precision_maxima_m); aquí se usa el mismo número para no enviar lo que
// va a rechazar, y para avisar en los sitios, donde no hay validación dura
// porque teclear una coordenada a mano sigue siendo legítimo.
const PRECISION_OBJETIVO_M = 50;
const ESPERA_GPS_MS = 30_000;

function capturarGps(
  alTener: (lat: number, lng: number, precision: number) => void,
  alAvisar: (mensaje: string) => void,
  alFallar: (mensaje: string) => void,
): void {
  if (!('geolocation' in navigator)) {
    alFallar('Este teléfono no da la ubicación.');
    return;
  }
  alAvisar('Buscando el GPS…');
  let mejor: GeolocationPosition | null = null;
  let terminado = false;

  const vigilancia = navigator.geolocation.watchPosition(
    (pos) => {
      if (terminado) return;
      if (!mejor || pos.coords.accuracy < mejor.coords.accuracy) mejor = pos;
      const actual = Math.round(mejor.coords.accuracy);
      alAvisar(`Buscando el GPS… ±${actual} m${actual > PRECISION_OBJETIVO_M ? ' (esperando a que mejore)' : ''}`);
      if (mejor.coords.accuracy <= PRECISION_OBJETIVO_M) {
        terminado = true;
        navigator.geolocation.clearWatch(vigilancia);
        clearTimeout(reloj);
        alAvisar('');
        alTener(mejor.coords.latitude, mejor.coords.longitude, mejor.coords.accuracy);
      }
    },
    (e) => {
      if (terminado) return;
      terminado = true;
      navigator.geolocation.clearWatch(vigilancia);
      clearTimeout(reloj);
      alAvisar('');
      alFallar(`No se pudo coger el GPS: ${e.message}. Da permiso de ubicación y sal a cielo abierto.`);
    },
    { enableHighAccuracy: true, timeout: ESPERA_GPS_MS, maximumAge: 0 },
  );

  // Si tras la espera sigue sin fijar, NO se devuelve una posición mala: se
  // dice lo que hay y se deja repetir. Guardar algo mal situado es peor que
  // no guardarlo, porque nadie va a volver a mirarlo.
  const reloj = setTimeout(() => {
    if (terminado) return;
    terminado = true;
    navigator.geolocation.clearWatch(vigilancia);
    alAvisar('');
    const conseguido = mejor ? `±${Math.round(mejor.coords.accuracy)} m` : 'nada';
    alFallar(
      `El GPS no llegó a ±${PRECISION_OBJETIVO_M} m (lo mejor: ${conseguido}). `
      + 'Sal a cielo abierto, apártate de los edificios y vuelve a intentarlo.',
    );
  }, ESPERA_GPS_MS);
}

// --- Resumen: cuadro de mandos (bloque 1) ------------------------------------

function Alarmas({ salud }: { salud: SaludOperador }) {
  const disparadas = salud.alarmas.filter((a) => a.disparada);
  return (
    <>
      {disparadas.length === 0
        ? <p className="nota">Sin alarmas: todo dentro de los umbrales de la sección 11.</p>
        : disparadas.map((a) => (
          <div className="oferta oferta-alarma" key={a.clave}>
            <div className="oferta-ruta">⚠ {a.nombre}</div>
            <div className="nota">{a.ambito} · umbral {a.umbral}</div>
            <ul className="ruta">
              {a.detalle.slice(0, 5).map((d) => (
                <li key={d.nombre}>{d.nombre} · {porciento(d.tasa)} de {d.muestras}</li>
              ))}
            </ul>
          </div>
        ))}
    </>
  );
}

function Resumen({ stats, salud }: { stats: EstadisticasOperador; salud: SaludOperador | null }) {
  const enCurso = salud?.viajesEnCurso.reduce((suma, f) => suma + f.n, 0) ?? 0;
  return (
    <>
      {salud && <Alarmas salud={salud} />}
      <div className="rejilla">
        <Dato valor={stats.incidenciasPendientes} etiqueta="Incidencias por revisar" rojo={stats.incidenciasPendientes > 0} />
        <Dato valor={stats.recargasPendientes} etiqueta="Pagos por confirmar" rojo={stats.recargasPendientes > 0} />
        <Dato valor={enCurso} etiqueta="Viajes en curso ahora" />
        <Dato valor={salud === null ? '—' : salud.taxisPorZona.reduce((s, z) => s + z.taxis, 0)} etiqueta="Taxis en servicio ahora" />
        <Dato valor={stats.conductores.pendientes} etiqueta="Conductores pendientes" />
        <Dato valor={stats.conductores.verificados} etiqueta="Conductores verificados" />
        <Dato valor={stats.pasajeros} etiqueta="Pasajeros registrados" />
        <Dato valor={stats.solicitudes.ultimas_24h} etiqueta="Solicitudes (24 h)" />
        <Dato valor={stats.solicitudes.completadas} etiqueta="Viajes completados" />
        <Dato valor={stats.solicitudes.sin_taxi} etiqueta="Se quedaron sin taxi" />
        <Dato valor={`${stats.saldoTotalMonederosXaf.toLocaleString('es')} XAF`} etiqueta="Saldo total monederos" />
      </div>

      {salud !== null && salud.viajesEnCurso.length > 0 && (
        <>
          <p className="nota">Viajes en curso</p>
          <ul className="ruta">
            {salud.viajesEnCurso.map((f) => (
              <li key={f.estado}>{ETIQUETA_VIAJE[f.estado] ?? f.estado} · {f.n}</li>
            ))}
          </ul>
        </>
      )}

      <p className="nota">Taxis por zona ahora mismo</p>
      {salud === null || salud.taxisPorZona.length === 0
        ? <p className="nota">Ningún taxi en servicio en este momento.</p>
        : (
          <ul className="ruta">
            {salud.taxisPorZona.map((z) => (
              <li key={z.zona}>{z.zona} · {z.taxis} taxi{z.taxis === 1 ? '' : 's'} ({z.disponibles} libre{z.disponibles === 1 ? '' : 's'})</li>
            ))}
          </ul>
        )}
    </>
  );
}

// --- Central telefónica (bloque 4) -------------------------------------------

function SelectorReferencia({
  etiqueta, valor, alElegir,
}: {
  etiqueta: string;
  valor: ReferenciaOperador | null;
  alElegir: (r: ReferenciaOperador | null) => void;
}) {
  const [texto, setTexto] = useState('');
  const [opciones, setOpciones] = useState<ReferenciaOperador[]>([]);

  useEffect(() => {
    if (valor || texto.trim().length < 2) {
      setOpciones([]);
      return;
    }
    const t = setTimeout(() => {
      api.referenciasOperador(texto.trim())
        .then((r) => setOpciones(r.referencias.filter((f) => f.activa).slice(0, 6)))
        .catch(() => setOpciones([]));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [texto, valor]);

  if (valor) {
    return (
      <button type="button" className="elegido" onClick={() => { alElegir(null); setTexto(''); }}>
        <span className="elegido-etiqueta">{etiqueta}</span>
        <span className="elegido-valor">{valor.nombre}</span>
        <span className="elegido-cambiar">cambiar</span>
      </button>
    );
  }
  return (
    <div className="buscador">
      <input
        type="text"
        value={texto}
        placeholder={etiqueta}
        onChange={(e) => setTexto(e.target.value)}
      />
      {opciones.length > 0 && (
        <ul className="sugerencias">
          {opciones.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => alElegir(o)}>
                <span className="fila-sugerencia">
                  <span className="sug-textos">
                    <span className="sug-nombre">{o.nombre}</span>
                    <span className="sug-zona">{o.zona}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Central() {
  const [telefono, setTelefono] = useState('');
  const [origen, setOrigen] = useState<ReferenciaOperador | null>(null);
  const [destino, setDestino] = useState<ReferenciaOperador | null>(null);
  const [resultado, setResultado] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [lista, setLista] = useState<SolicitudCentral[] | null>(null);

  function cargarLista() {
    api.solicitudesCentral().then((r) => setLista(r.solicitudes)).catch(() => undefined);
  }
  useEffect(cargarLista, []);

  // Mientras hay viajes de la central sin terminar, la lista se refresca
  // sola: el operador tiene que poder dictar la matrícula cuando llegue.
  useEffect(() => {
    const vivos = lista?.some((s) => ['SOLICITADO', 'EMITIDO', 'ACEPTADO', 'EN_CAMINO', 'RECOGIDO'].includes(s.estado));
    if (!vivos) return;
    const t = setInterval(cargarLista, 10_000);
    return () => clearInterval(t);
  }, [lista]);

  async function pedir() {
    setOcupado(true);
    setError('');
    setResultado('');
    try {
      const r = await api.crearSolicitudOperador(telefono.trim(), origen!.id, destino!.id);
      setResultado(r.estado === 'SIN_OFERTA'
        ? 'Ahora mismo no hay taxi en esa zona. Díselo y que reintente en unos minutos.'
        : `Solicitud ${r.solicitudId} creada: buscando taxi. La matrícula saldrá abajo al asignarse.`);
      setOrigen(null);
      setDestino(null);
      cargarLista();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear la solicitud.');
    } finally {
      setOcupado(false);
    }
  }

  const listo = telefono.trim().length >= 6 && origen !== null && destino !== null;
  return (
    <>
      <p className="nota">
        Para quien llama por teléfono sin tener la aplicación. El teléfono es al
        que el taxista llamará al llegar.
      </p>
      <input
        type="tel"
        value={telefono}
        placeholder="Teléfono de quien llama"
        onChange={(e) => setTelefono(e.target.value)}
      />
      <SelectorReferencia etiqueta="¿De dónde sale?" valor={origen} alElegir={setOrigen} />
      <SelectorReferencia etiqueta="¿A dónde va?" valor={destino} alElegir={setDestino} />
      {error && <p className="aviso">{error}</p>}
      {resultado && <p className="nota">{resultado}</p>}
      <button type="button" className="principal" disabled={!listo || ocupado} onClick={pedir}>
        Pedir taxi en su nombre
      </button>

      <p className="nota">Últimas solicitudes de la central</p>
      {lista?.length === 0 && <p className="nota">Ninguna todavía.</p>}
      {lista?.map((s) => (
        <div className="oferta" key={s.id}>
          <div className="oferta-ruta">{s.origen} → {s.destino}</div>
          <div className="nota">{fecha(s.creada_en)} · {s.telefono_cliente}</div>
          <div className="nota">
            Estado: <strong>{ETIQUETA_VIAJE[s.estado] ?? s.estado}</strong>
            {s.conductor && ` · ${s.conductor}`}
            {s.matricula && ` · matrícula ${s.matricula}`}
          </div>
        </div>
      ))}
    </>
  );
}

// --- Incidencias -------------------------------------------------------------

function FilaIncidencia({
  incidencia, ocupada, alResolver,
}: {
  incidencia: IncidenciaOperador;
  ocupada: boolean;
  alResolver: (id: number, accion: 'sancionar' | 'perdonar') => void;
}) {
  const [historial, setHistorial] = useState<TransicionOperador[] | null>(null);
  const pendiente = incidencia.resuelta_en === null;

  async function verHistorial() {
    if (historial) {
      setHistorial(null);
      return;
    }
    const r = await api.historialIncidencia(incidencia.id).catch(() => null);
    setHistorial(r?.transiciones ?? []);
  }

  return (
    <div className="oferta">
      <div className="oferta-ruta">
        {ETIQUETA_TIPO_INCIDENCIA[incidencia.tipo] ?? incidencia.tipo} · {fecha(incidencia.creada_en)}
      </div>
      <div className="nota">{incidencia.origen} → {incidencia.destino} · taxista {incidencia.conductor}</div>
      <div className="nota">
        Pasajero {incidencia.telefono_cliente} · {incidencia.strikes} strike{incidencia.strikes === 1 ? '' : 's'}
        {incidencia.bloqueado_en && ' · BLOQUEADO'}
      </div>
      {incidencia.descripcion && <div className="nota">{incidencia.descripcion}</div>}
      {!pendiente && (
        <div className="nota">
          Resuelta: <strong>{incidencia.resolucion}</strong> · {fecha(incidencia.resuelta_en)}
        </div>
      )}
      <div className="fila">
        {pendiente && (
          <>
            <button
              type="button" className="principal" disabled={ocupada}
              onClick={() => alResolver(incidencia.id, 'perdonar')}
            >
              Perdonar
            </button>
            <button
              type="button" className="secundario" disabled={ocupada}
              onClick={() => alResolver(incidencia.id, 'sancionar')}
            >
              Sancionar (strike)
            </button>
          </>
        )}
        <button type="button" className="secundario" onClick={verHistorial}>
          {historial ? 'Ocultar historial' : 'Historial'}
        </button>
      </div>
      {historial && (
        historial.length === 0
          ? <p className="nota">Ese viaje no tiene transiciones registradas.</p>
          : (
            <ul className="ruta">
              {historial.map((t, i) => (
                <li key={i}>
                  {fecha(t.creado_en)} · {t.estado_anterior ?? '∅'} → {t.estado_nuevo} · {t.actor}
                </li>
              ))}
            </ul>
          )
      )}
    </div>
  );
}

// --- Fichas -------------------------------------------------------------------

function FichaConductor({
  id, alVolver, alCambiarEstado, ocupado,
}: {
  id: number;
  alVolver: () => void;
  alCambiarEstado: (id: number, estado: string) => Promise<void>;
  ocupado: boolean;
}) {
  const [ficha, setFicha] = useState<FichaConductorOperador | null>(null);
  const [error, setError] = useState('');
  // Estado propio del formulario de vehículo: la ficha se recarga entera
  // tras guardar (`cargar()`), y este par se resincroniza con ella —no se
  // puede leer `ficha.aire_acondicionado` directamente en un checkbox
  // controlado sin perder lo que el operador esté tecleando a medio camino.
  const [aireAcondicionado, setAireAcondicionado] = useState(false);
  const [seguro, setSeguro] = useState(false);
  const [guardandoVehiculo, setGuardandoVehiculo] = useState(false);

  function cargar() {
    api.fichaConductorOperador(id).then((f) => {
      setFicha(f);
      setAireAcondicionado(f.aire_acondicionado);
      setSeguro(f.seguro);
    }).catch((e) => setError(e.message));
  }
  useEffect(cargar, [id]);

  async function guardarVehiculo() {
    setGuardandoVehiculo(true);
    try {
      await api.editarVehiculoOperador(id, { aireAcondicionado, seguro });
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGuardandoVehiculo(false);
    }
  }

  if (error) return <><p className="aviso">{error}</p><button type="button" className="secundario" onClick={alVolver}>Volver</button></>;
  if (!ficha) return <p className="nota">Cargando…</p>;

  const o = ficha.ofertas;
  return (
    <>
      <div className="cabecera">
        <h1>{ficha.nombre}</h1>
        <button type="button" className="secundario" onClick={alVolver}>Volver</button>
      </div>
      <p className="nota">
        {ficha.telefono}{ficha.correo && ` · ${ficha.correo}`}
        {ficha.matricula && ` · ${ficha.matricula}`}{ficha.marca && ` · ${ficha.marca}`}
        {ficha.carroceria && ` · ${ficha.carroceria}`}
      </p>
      <div className="fila">
        <label className="casilla">
          <input type="checkbox" checked={aireAcondicionado}
            onChange={(e) => setAireAcondicionado(e.target.checked)} />
          Aire acondicionado
        </label>
        <label className="casilla">
          <input type="checkbox" checked={seguro}
            onChange={(e) => setSeguro(e.target.checked)} />
          Seguro
        </label>
        <button type="button" className="secundario" disabled={guardandoVehiculo} onClick={guardarVehiculo}>
          {guardandoVehiculo ? 'Guardando…' : 'Guardar'}
        </button>
      </div>
      <p className="nota">
        Estado: <strong>{ETIQUETA_ESTADO[ficha.estado_verificacion] ?? ficha.estado_verificacion}</strong>
        {' · '}Presencia: <strong>{ficha.presencia ?? '—'}</strong>
        {' · '}Suscripción: <strong>{ficha.suscripcionVigente ? `hasta ${fecha(ficha.suscrito_hasta)}` : 'vencida'}</strong>
      </p>
      <div className="rejilla">
        <Dato valor={`${ficha.saldo_xaf.toLocaleString('es')} XAF`} etiqueta="Saldo del monedero" />
        <Dato
          valor={ficha.reputacion.media === null ? '—' : ficha.reputacion.media.toFixed(1)}
          etiqueta={`Nota (${ficha.reputacion.valoraciones} valoraciones)`}
        />
        <Dato valor={ficha.viajes.completados} etiqueta="Viajes completados" />
        <Dato valor={o.recibidas === 0 ? '—' : `${Math.round((o.aceptadas / o.recibidas) * 100)} %`} etiqueta={`Ofertas aceptadas (de ${o.recibidas})`} />
        <Dato valor={ficha.viajes.cancelados} etiqueta="Cancelados por él" />
        <Dato valor={ficha.viajes.ausencias} etiqueta="Clientes ausentes" />
      </div>
      <div className="fila">
        {ficha.estado_verificacion !== 'verificado' && (
          <button type="button" className="principal" disabled={ocupado} onClick={() => alCambiarEstado(ficha.id, 'verificado').then(cargar)}>Verificar</button>
        )}
        {ficha.estado_verificacion !== 'suspendido' && (
          <button type="button" className="secundario" disabled={ocupado} onClick={() => alCambiarEstado(ficha.id, 'suspendido').then(cargar)}>Suspender</button>
        )}
        {ficha.estado_verificacion !== 'bloqueado' && (
          <button type="button" className="secundario" disabled={ocupado} onClick={() => alCambiarEstado(ficha.id, 'bloqueado').then(cargar)}>Bloquear</button>
        )}
        <button
          type="button" className="secundario" disabled={ocupado}
          onClick={() => api.nombrarAgente(ficha.id, !ficha.es_agente).then(cargar)}
        >
          {ficha.es_agente ? 'Quitar el papel de agente de campo' : 'Nombrar agente de campo'}
        </button>
        {/* Migración 048: recibir carreras de toda la isla. Va en la ÚLTIMA
            oleada, así que no le quita ninguna a quien está cerca del
            pasajero: solo entra cuando nadie más la ha cogido. */}
        <button
          type="button" className="secundario" disabled={ocupado}
          onClick={() => api.recibirEnCualquierZona(
            ficha.id, !ficha.recibe_en_cualquier_zona,
          ).then(cargar)}
        >
          {ficha.recibe_en_cualquier_zona
            ? 'Recibir solo de su barrio'
            : 'Recibir carreras de toda la isla'}
        </button>
      </div>
      <RecorridoConductor id={ficha.id} />
      <p className="nota">Últimos viajes</p>
      <ListaViajes viajes={ficha.ultimosViajes} />
      {ficha.recargas.length > 0 && (
        <>
          <p className="nota">Últimas recargas</p>
          <ul className="ruta">
            {ficha.recargas.map((r) => (
              <li key={r.id}>
                {fecha(r.solicitadaEn)} · {r.importeXaf.toLocaleString('es')} XAF · {ETIQUETA_METODO[r.metodo] ?? r.metodo} · {ETIQUETA_ESTADO_RECARGA[r.estado] ?? r.estado}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

// Por dónde anduvo este taxi (migración 042). Se pide al abrir y al cambiar
// de periodo, no antes: un mes de recorrido son cientos de puntos, y la mayor
// parte de las veces que se abre una ficha de conductor es para verificarlo o
// para mirarle el saldo.
const PERIODOS: Array<[PeriodoRecorrido, string]> = [
  ['dia', 'Hoy'], ['semana', 'Semana'], ['mes', 'Mes'],
];

function RecorridoConductor({ id }: { id: number }) {
  const [periodo, setPeriodo] = useState<PeriodoRecorrido>('dia');
  const [recorrido, setRecorrido] = useState<RecorridoOperador | null>(null);
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setError('');
    api.recorridoConductor(id, periodo)
      .then((r) => { if (vivo) setRecorrido(r); })
      .catch((e) => { if (vivo) setError(e.message); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [id, periodo]);

  const tramos = recorrido?.tramos ?? [];
  const km = ((recorrido?.metros ?? 0) / 1000).toFixed(1);

  return (
    <>
      <p className="nota">Recorrido</p>
      <div className="fila">
        {PERIODOS.map(([clave, etiqueta]) => (
          <button
            key={clave}
            type="button"
            className={periodo === clave ? 'principal' : 'secundario'}
            onClick={() => setPeriodo(clave)}
          >
            {etiqueta}
          </button>
        ))}
      </div>
      {error && <p className="aviso">{error}</p>}
      {cargando && <p className="nota">Cargando el recorrido…</p>}
      {!cargando && !error && tramos.length === 0 && (
        <p className="nota">
          Sin recorrido en este periodo. O no entró en servicio, o el registro
          es anterior a que esto existiera: solo hay datos desde entonces.
        </p>
      )}
      {tramos.length > 0 && (
        <>
          <div className="mapa-recorrido">
            <Mapa puntos={[]} encuadre="recorrido" recorrido={tramos} />
          </div>
          <p className="nota">
            {km} km · {tramos.length} tramo{tramos.length === 1 ? '' : 's'}
            {' · '}{recorrido?.puntos} puntos
            {' · '}<span style={{ color: '#7ee081' }}>●</span> empieza
            {' '}<span style={{ color: '#ff6b6b' }}>●</span> acaba
          </p>
        </>
      )}
    </>
  );
}

function FichaPasajero({
  dispositivoId, alVolver,
}: {
  dispositivoId: number;
  alVolver: () => void;
}) {
  const [ficha, setFicha] = useState<FichaPasajeroOperador | null>(null);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  function cargar() {
    api.fichaPasajeroOperador(dispositivoId).then(setFicha).catch((e) => setError(e.message));
  }
  useEffect(cargar, [dispositivoId]);

  async function desbloquear() {
    setOcupado(true);
    try {
      await api.desbloquearPasajero(dispositivoId);
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo desbloquear.');
    } finally {
      setOcupado(false);
    }
  }

  if (error) return <><p className="aviso">{error}</p><button type="button" className="secundario" onClick={alVolver}>Volver</button></>;
  if (!ficha) return <p className="nota">Cargando…</p>;

  return (
    <>
      <div className="cabecera">
        <h1>{ficha.nombre ?? ficha.telefono ?? 'Pasajero'}</h1>
        <button type="button" className="secundario" onClick={alVolver}>Volver</button>
      </div>
      <p className="nota">
        {ficha.telefono ?? 'sin teléfono'}{ficha.correo && ` · ${ficha.correo}`}
        {' · '}en la plataforma desde {fecha(ficha.creado_en)}
      </p>
      {ficha.bloqueado_en && (
        <p className="aviso">Bloqueado desde {fecha(ficha.bloqueado_en)} por incidencias repetidas.</p>
      )}
      <div className="rejilla">
        <Dato valor={ficha.viajes.completados} etiqueta="Viajes completados" />
        <Dato valor={ficha.viajes.pedidos} etiqueta="Veces que pidió" />
        <Dato valor={ficha.viajes.cancelados} etiqueta="Cancelados por él" />
        <Dato valor={`${ficha.strikes}`} etiqueta="Strikes" />
      </div>
      {(ficha.strikes > 0 || ficha.bloqueado_en) && (
        <button type="button" className="principal" disabled={ocupado} onClick={desbloquear}>
          Perdonar strikes y desbloquear
        </button>
      )}
      <p className="nota">Últimos viajes</p>
      <ListaViajes viajes={ficha.ultimosViajes} />
    </>
  );
}

// --- Lugares: editor del gazetteer (bloque 5) --------------------------------

function EditorReferencia({
  referencia, zonas, alGuardado,
}: {
  referencia: ReferenciaOperador;
  zonas: ZonaOperador[];
  alGuardado: () => void;
}) {
  const [nombre, setNombre] = useState(referencia.nombre);
  const [categoria, setCategoria] = useState(referencia.categoria);
  const [zonaId, setZonaId] = useState(referencia.zona_id);
  const [lat, setLat] = useState(String(referencia.lat));
  const [lng, setLng] = useState(String(referencia.lng));
  const [aliasNuevo, setAliasNuevo] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  async function accion(f: () => Promise<unknown>) {
    setOcupado(true);
    setError('');
    try {
      await f();
      alGuardado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo.');
    } finally {
      setOcupado(false);
    }
  }

  const [precision, setPrecision] = useState<number | null>(null);
  const [avisoGps, setAvisoGps] = useState('');

  // `precision` va con las coordenadas: si se corrigió con el GPS viaja su
  // radio, y si se tecleó a mano no viaja ninguno y el sitio queda marcado
  // como sin verificar sobre el terreno.
  const guardar = () => accion(() => api.editarReferenciaOperador(referencia.id, {
    nombre: nombre.trim() || undefined,
    categoria: categoria.trim() || undefined,
    zonaId: Number(zonaId),
    lat: Number(lat),
    lng: Number(lng),
    precision: precision ?? undefined,
  }));

  return (
    <>
      {error && <p className="aviso">{error}</p>}
      <input type="text" value={nombre} placeholder="Nombre" onChange={(e) => setNombre(e.target.value)} />
      <div className="fila">
        <select value={categoria} onChange={(e) => setCategoria(e.target.value)}>
          <option value="">Categoría…</option>
          {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={zonaId} onChange={(e) => setZonaId(Number(e.target.value))}>
          {opcionesZona(zonas).map((o) => <option key={o.id} value={o.id}>{o.etiqueta}</option>)}
        </select>
      </div>
      {/* Corregir un sitio estando delante: es la mitad del trabajo de campo
          —el catálogo se cargó con coordenadas plausibles, no verificadas
          (P1-03)— y hasta ahora obligaba a teclear la coordenada a mano. */}
      <button
        type="button" className="secundario" disabled={ocupado || avisoGps !== ''}
        onClick={() => capturarGps(
          (nuevaLat, nuevaLng, precision) => {
            setLat(String(nuevaLat.toFixed(6)));
            setLng(String(nuevaLng.toFixed(6)));
            setPrecision(precision);
          },
          setAvisoGps,
          setError,
        )}
      >
        {avisoGps || 'Estoy aquí: corregir con el GPS'}
      </button>
      <div className="fila">
        <input
          type="text" value={lat} placeholder="Latitud"
          onChange={(e) => { setLat(e.target.value); setPrecision(null); }}
        />
        <input
          type="text" value={lng} placeholder="Longitud"
          onChange={(e) => { setLng(e.target.value); setPrecision(null); }}
        />
      </div>
      {precision !== null && (
        <p className="nota">
          Tomado con el GPS: ±{Math.round(precision)} m
          {precision > PRECISION_OBJETIVO_M && ' — conviene repetirlo a cielo abierto'}
        </p>
      )}
      {referencia.alias.length > 0 && (
        <p className="nota">
          Alias: {referencia.alias.map((a) => (
            <button
              key={a} type="button" className="enlace" disabled={ocupado}
              onClick={() => accion(() => api.aliasReferenciaOperador(referencia.id, a, true))}
            >
              {a} ✕
            </button>
          ))}
        </p>
      )}
      <div className="fila">
        <input
          type="text" value={aliasNuevo} placeholder="Alias nuevo (como se dice de palabra)"
          onChange={(e) => setAliasNuevo(e.target.value)}
        />
        <button
          type="button" className="secundario" disabled={ocupado || !aliasNuevo.trim()}
          onClick={() => accion(() => api.aliasReferenciaOperador(referencia.id, aliasNuevo.trim()))
            .then(() => setAliasNuevo(''))}
        >
          Añadir alias
        </button>
      </div>
      <div className="fila">
        <button type="button" className="principal" disabled={ocupado} onClick={guardar}>Guardar cambios</button>
        <button
          type="button" className="secundario" disabled={ocupado}
          onClick={() => accion(() => api.editarReferenciaOperador(referencia.id, { activa: !referencia.activa }))}
        >
          {referencia.activa ? 'Desactivar' : 'Reactivar'}
        </button>
      </div>
    </>
  );
}

// Distrito urbano seguido de sus barrios/calles (migración 031), para poder
// elegir el nivel más preciso que se conozca sin obligar a nada — un lugar
// puede colgar directamente del distrito urbano si no se sabe más.
function opcionesZona(zonas: ZonaOperador[]): Array<{ id: number; etiqueta: string }> {
  const opciones: Array<{ id: number; etiqueta: string }> = [];
  for (const padre of zonas.filter((z) => z.zona_padre_id === null)) {
    opciones.push({ id: padre.id, etiqueta: padre.nombre });
    for (const hijo of zonas.filter((z) => z.zona_padre_id === padre.id)) {
      opciones.push({ id: hijo.id, etiqueta: `— ${hijo.nombre}` });
    }
  }
  return opciones;
}

function Lugares() {
  const [zonas, setZonas] = useState<ZonaOperador[]>([]);
  const [busqueda, setBusqueda] = useState('');
  const [referencias, setReferencias] = useState<ReferenciaOperador[] | null>(null);
  const [abierta, setAbierta] = useState<number | null>(null);
  const [creando, setCreando] = useState(false);
  const [nueva, setNueva] = useState({ nombre: '', categoria: '', zonaId: 0, lat: '', lng: '' });
  // Precisión de la última captura, para poder decir con qué se tomó. null si
  // las coordenadas se escribieron a mano, que sigue siendo legítimo: a veces
  // se añade un sitio desde la oficina, sabiendo dónde está.
  const [precisionNueva, setPrecisionNueva] = useState<number | null>(null);
  const [avisoGps, setAvisoGps] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api.zonasOperador().then((r) => {
      setZonas(r.zonas);
      if (r.zonas.length > 0) setNueva((n) => ({ ...n, zonaId: n.zonaId || r.zonas[0].id }));
    }).catch(() => undefined);
  }, []);

  function cargar() {
    api.referenciasOperador(busqueda || undefined)
      .then((r) => setReferencias(r.referencias))
      .catch((e) => setError(e.message));
  }
  useEffect(cargar, [busqueda]);

  async function crear() {
    setError('');
    try {
      await api.crearReferenciaOperador({
        zonaId: nueva.zonaId,
        nombre: nueva.nombre.trim(),
        lat: Number(nueva.lat),
        lng: Number(nueva.lng),
        categoria: nueva.categoria.trim() || undefined,
        precision: precisionNueva ?? undefined,
      });
      setCreando(false);
      setNueva((n) => ({ ...n, nombre: '', categoria: '', lat: '', lng: '' }));
      setPrecisionNueva(null);
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear.');
    }
  }

  const nuevaLista = nueva.nombre.trim().length > 1
    && Number.isFinite(Number(nueva.lat)) && nueva.lat.trim() !== ''
    && Number.isFinite(Number(nueva.lng)) && nueva.lng.trim() !== ''
    && nueva.zonaId > 0;

  return (
    <>
      <p className="nota">
        El catálogo de sitios que la gente puede pedir. Los alias importan:
        «donde manolo» encuentra el bar aunque se llame de otra manera.
      </p>
      {error && <p className="aviso">{error}</p>}
      <button type="button" className={creando ? 'secundario' : 'principal'} onClick={() => setCreando(!creando)}>
        {creando ? 'Cancelar' : 'Añadir un sitio nuevo'}
      </button>
      {creando && (
        <>
          <input
            type="text" value={nueva.nombre} placeholder="Nombre del sitio"
            onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })}
          />
          <div className="fila">
            <select
              value={nueva.categoria}
              onChange={(e) => setNueva({ ...nueva, categoria: e.target.value })}
            >
              <option value="">Categoría…</option>
              {CATEGORIAS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <select value={nueva.zonaId} onChange={(e) => setNueva({ ...nueva, zonaId: Number(e.target.value) })}>
              {opcionesZona(zonas).map((o) => <option key={o.id} value={o.id}>{o.etiqueta}</option>)}
            </select>
          </div>
          {/* Lo normal es estar delante del sitio: el GPS rellena las
              coordenadas y dice con qué precisión. Escribirlas a mano sigue
              valiendo para añadir algo desde la oficina. */}
          <button
            type="button" className="secundario" disabled={avisoGps !== ''}
            onClick={() => capturarGps(
              (lat, lng, precision) => {
                setNueva((n) => ({ ...n, lat: String(lat.toFixed(6)), lng: String(lng.toFixed(6)) }));
                setPrecisionNueva(precision);
              },
              setAvisoGps,
              setError,
            )}
          >
            {avisoGps || 'Estoy aquí: coger el GPS'}
          </button>
          <div className="fila">
            <input
              type="text" value={nueva.lat} placeholder="Latitud (3.75…)"
              onChange={(e) => { setNueva({ ...nueva, lat: e.target.value }); setPrecisionNueva(null); }}
            />
            <input
              type="text" value={nueva.lng} placeholder="Longitud (8.78…)"
              onChange={(e) => { setNueva({ ...nueva, lng: e.target.value }); setPrecisionNueva(null); }}
            />
          </div>
          {precisionNueva !== null && (
            <p className="nota">
              Tomado con el GPS: ±{Math.round(precisionNueva)} m
              {precisionNueva > PRECISION_OBJETIVO_M && ' — conviene repetirlo a cielo abierto'}
            </p>
          )}
          <button type="button" className="principal" disabled={!nuevaLista} onClick={crear}>
            Crear el sitio
          </button>
        </>
      )}

      <Buscador alBuscar={setBusqueda} placeholder="Buscar sitio por nombre o alias…" />
      {referencias?.length === 0 && <p className="nota">Nada que encaje con esa búsqueda.</p>}
      {referencias?.map((r) => (
        <div className="oferta" key={r.id}>
          <button
            type="button" className="oferta-boton-titulo"
            onClick={() => setAbierta(abierta === r.id ? null : r.id)}
          >
            <span className="oferta-ruta">
              {r.nombre}{!r.activa && ' · DESACTIVADO'}
            </span>
            <span className="nota">
              {r.zona} · {r.categoria} · {r.usos} uso{r.usos === 1 ? '' : 's'}
              {/* Con qué confianza está puesto (migración 038). Sin
                  precisión el sitio se tecleó a mano o vino del importador,
                  y conviene pasar por allí a confirmarlo. */}
              {r.precision_m === null
                ? ' · ⚠ sin verificar sobre el terreno'
                : ` · ±${Math.round(r.precision_m)} m`}
              {r.alias.length > 0 && ` · alias: ${r.alias.join(', ')}`}
            </span>
          </button>
          {abierta === r.id && (
            <EditorReferencia referencia={r} zonas={zonas} alGuardado={cargar} />
          )}
        </div>
      ))}
    </>
  );
}

// --- Ajustes: bandas de precio y parámetros (bloque 6) -----------------------

function Bandas({ zonas }: { zonas: ZonaOperador[] }) {
  const [bandas, setBandas] = useState<BandaOperador[] | null>(null);
  const [origenId, setOrigenId] = useState(0);
  const [destinoId, setDestinoId] = useState(0);
  const [precios, setPrecios] = useState({ p25: '', p50: '', p75: '' });
  const [error, setError] = useState('');

  function cargar() {
    api.bandasOperador().then((r) => setBandas(r.bandas)).catch((e) => setError(e.message));
  }
  useEffect(cargar, []);
  useEffect(() => {
    if (zonas.length > 0) {
      setOrigenId((v) => v || zonas[0].id);
      setDestinoId((v) => v || zonas[Math.min(1, zonas.length - 1)].id);
    }
  }, [zonas]);

  async function guardar(borrar = false) {
    setError('');
    try {
      await api.guardarBandaOperador(borrar
        ? { zonaOrigenId: origenId, zonaDestinoId: destinoId, borrar: true }
        : {
          zonaOrigenId: origenId,
          zonaDestinoId: destinoId,
          p25: Number(precios.p25),
          p50: Number(precios.p50),
          p75: Number(precios.p75),
        });
      setPrecios({ p25: '', p50: '', p75: '' });
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    }
  }

  const listo = [precios.p25, precios.p50, precios.p75]
    .every((v) => v.trim() !== '' && Number.isInteger(Number(v)) && Number(v) >= 0);

  return (
    <>
      <p className="nota">
        Precio orientativo por trayecto entre zonas (barato / normal / caro, en
        XAF). El taxista lo ve al recibir la oferta, para no aceptar a ciegas;
        nunca es tarifa impuesta.
      </p>
      {error && <p className="aviso">{error}</p>}
      <div className="fila">
        <select value={origenId} onChange={(e) => setOrigenId(Number(e.target.value))}>
          {zonas.map((z) => <option key={z.id} value={z.id}>{z.nombre}</option>)}
        </select>
        <select value={destinoId} onChange={(e) => setDestinoId(Number(e.target.value))}>
          {zonas.map((z) => <option key={z.id} value={z.id}>{z.nombre}</option>)}
        </select>
      </div>
      <div className="fila">
        <input type="number" value={precios.p25} placeholder="Barato" onChange={(e) => setPrecios({ ...precios, p25: e.target.value })} />
        <input type="number" value={precios.p50} placeholder="Normal" onChange={(e) => setPrecios({ ...precios, p50: e.target.value })} />
        <input type="number" value={precios.p75} placeholder="Caro" onChange={(e) => setPrecios({ ...precios, p75: e.target.value })} />
      </div>
      <div className="fila">
        <button type="button" className="principal" disabled={!listo || origenId === destinoId} onClick={() => guardar()}>
          Guardar banda
        </button>
        <button type="button" className="secundario" onClick={() => guardar(true)}>
          Borrar la de ese par
        </button>
      </div>
      {bandas?.length === 0 && <p className="nota">Ninguna banda definida todavía: los taxistas ven «sin precio orientativo».</p>}
      {bandas && bandas.length > 0 && (
        <ul className="ruta">
          {bandas.map((b) => (
            <li key={b.id}>
              {b.zona_origen} → {b.zona_destino} · {Number(b.p25).toLocaleString('es')} / {Number(b.p50).toLocaleString('es')} / {Number(b.p75).toLocaleString('es')} XAF
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function FilaParametro({ parametro, alGuardado }: { parametro: ParametroOperador; alGuardado: () => void }) {
  const [valor, setValor] = useState(parametro.valor);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const cambiado = valor.trim() !== parametro.valor;

  async function guardar() {
    setOcupado(true);
    setError('');
    try {
      await api.cambiarParametroOperador(parametro.clave, valor.trim());
      alGuardado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="oferta">
      <div className="oferta-ruta parametro-clave">{parametro.clave}</div>
      {parametro.descripcion && <div className="nota">{parametro.descripcion}</div>}
      {error && <p className="aviso">{error}</p>}
      <div className="fila">
        <input type="text" value={valor} onChange={(e) => setValor(e.target.value)} />
        <button type="button" className="principal" disabled={!cambiado || ocupado || !valor.trim()} onClick={guardar}>
          Guardar
        </button>
      </div>
    </div>
  );
}

function Ajustes() {
  const [zonas, setZonas] = useState<ZonaOperador[]>([]);
  const [parametros, setParametros] = useState<ParametroOperador[] | null>(null);
  const [verParametros, setVerParametros] = useState(false);

  useEffect(() => {
    api.zonasOperador().then((r) => setZonas(r.zonas)).catch(() => undefined);
  }, []);
  function cargarParametros() {
    api.parametrosOperador().then((r) => setParametros(r.parametros)).catch(() => undefined);
  }
  useEffect(cargarParametros, []);

  return (
    <>
      {/* Solo distritos urbanos (migración 031): las bandas de precio son
          entre unidades de reparto, y un barrio/calle no lo es. */}
      <Bandas zonas={zonas.filter((z) => z.zona_padre_id === null)} />
      <button type="button" className="secundario" onClick={() => setVerParametros(!verParametros)}>
        {verParametros ? 'Ocultar parámetros del sistema' : `Parámetros del sistema (${parametros?.length ?? '…'})`}
      </button>
      {verParametros && (
        <>
          <p className="nota">
            Cambian el comportamiento al momento, sin desplegar: tiempos de
            oleada, tarifas, umbrales de alarma… Tócalos sabiendo lo que haces.
          </p>
          {parametros?.map((p) => (
            <FilaParametro key={p.clave} parametro={p} alGuardado={cargarParametros} />
          ))}
        </>
      )}
    </>
  );
}

// --- Listas -------------------------------------------------------------------

function FilaConductor({
  conductor, alAbrir,
}: {
  conductor: ConductorOperador;
  alAbrir: (id: number) => void;
}) {
  const estado = conductor.estado_verificacion;
  return (
    <button type="button" className="oferta oferta-boton" onClick={() => alAbrir(conductor.id)}>
      <span className="oferta-ruta">{conductor.nombre}</span>
      <span className="nota">
        {conductor.telefono}
        {conductor.matricula && ` · ${conductor.matricula}`}
        {conductor.marca && ` · ${conductor.marca}`}
        {' · '}{ETIQUETA_ESTADO[estado] ?? estado}
      </span>
    </button>
  );
}

function Zonas() {
  const [zonas, setZonas] = useState<ZonaOperador[] | null>(null);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [ocupada, setOcupada] = useState<number | 'nueva' | null>(null);
  const [nombreNuevo, setNombreNuevo] = useState('');

  function cargar() {
    api.zonasOperador().then((r) => setZonas(r.zonas)).catch((e) => setError(e.message));
  }
  useEffect(cargar, []);

  function conGps(alTener: (lat: number, lng: number, precision: number) => void) {
    setError('');
    capturarGps(alTener, setAviso, setError);
  }

  async function situar(z: ZonaOperador) {
    conGps(async (lat, lng, precision) => {
      setOcupada(z.id);
      try {
        const r = await api.situarZona(z.id, lat, lng, precision);
        setAviso(`«${r.nombre}» situado aquí con ±${Math.round(precision)} m. Vecinas: ${r.vecinas}.`);
        cargar();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo situar el barrio.');
      } finally {
        setOcupada(null);
      }
    });
  }

  async function crear() {
    const nombre = nombreNuevo.trim();
    if (!nombre) return;
    conGps(async (lat, lng, precision) => {
      setOcupada('nueva');
      try {
        const r = await api.crearZonaEnGps(nombre, lat, lng, precision);
        setAviso(`«${r.nombre}» creado aquí con ±${Math.round(precision)} m. Vecinas: ${r.vecinas}.`);
        setNombreNuevo('');
        cargar();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo crear el barrio.');
      } finally {
        setOcupada(null);
      }
    });
  }

  // Solo distritos urbanos (migración 031): los barrios/calles tienen su
  // propia sección («Barrios»), aparte — aquí mezclarlos confundiría "sin
  // vecinas porque no le tocaba" con "sin vecinas porque algo falla".
  const distritosUrbanos = zonas?.filter((z) => z.zona_padre_id === null) ?? [];
  const pendientes = distritosUrbanos.filter((z) => z.sin_situar);
  const situadas = distritosUrbanos.filter((z) => !z.sin_situar);
  const fueraDeUrbanos = situadas.filter((z) => z.distrito_urbano === null);

  return (
    <>
      {error && <p className="aviso">{error}</p>}
      {aviso && <p className="nota">{aviso}</p>}

      <div className="oferta">
        <div className="oferta-ruta">Añadir un barrio donde estoy</div>
        <div className="nota">
          Para barrios que no están en ninguna lista. Se sitúa con el GPS de
          este teléfono, así que hay que estar allí. Entra sin distrito urbano:
          aparecerá abajo, esperando a que se le asigne uno.
        </div>
        <input
          type="text"
          value={nombreNuevo}
          placeholder="Nombre del barrio"
          onChange={(e) => setNombreNuevo(e.target.value)}
        />
        <button
          type="button" className="principal"
          disabled={!nombreNuevo.trim() || ocupada !== null}
          onClick={crear}
        >
          Estoy aquí: crear barrio
        </button>
      </div>

      {pendientes.length > 0 && (
        <>
          <p className="nota">
            Sin situar ({pendientes.length}). Ninguna fuente sabía dónde están, así
            que para el reparto todavía no existen: hay que ir y pulsar allí.
          </p>
          {pendientes.map((z) => (
            <div className="oferta oferta-alarma" key={z.id}>
              <div className="oferta-ruta">{z.nombre}</div>
              <button
                type="button" className="principal"
                disabled={ocupada !== null}
                onClick={() => situar(z)}
              >
                {ocupada === z.id ? 'Cogiendo GPS…' : 'Estoy aquí'}
              </button>
            </div>
          ))}
        </>
      )}

      <p className="nota">Situados ({situadas.length})</p>
      {/* La lista es la de los siete distritos urbanos (migración 040) y, bajo
          cada uno, sus barrios. Agrupar es puramente organizativo: el reparto
          no mira el distrito urbano, sigue funcionando por barrio y
          adyacencia. */}
      {DISTRITOS_URBANOS.map((urbano) => {
        const barrios = situadas.filter((z) => z.distrito_urbano === urbano);
        if (barrios.length === 0) return null;
        return (
          <div key={urbano}>
            <p className="nota"><strong>{urbano}</strong> ({barrios.length})</p>
            <div style={{ marginLeft: 12 }}>
              {barrios.map((z) => (
                <FichaZona key={z.id} zona={z} ocupada={ocupada} alSituar={situar} />
              ))}
            </div>
          </div>
        );
      })}

      {/* Y lo que no cae en ninguno, al final: separado y contado, no
          escondido. Esconderlo de la única pantalla desde la que se puede
          arreglar es como se quedan las cosas sin arreglar para siempre. */}
      {fueraDeUrbanos.length > 0 && (
        <>
          <p className="nota">
            Fuera de los siete distritos urbanos ({fueraDeUrbanos.length}). Baney,
            Luba y Riaba no tienen; los de Malabo están pendientes de asignar.
          </p>
          {DISTRITOS_ORDEN.map(([clave, etiqueta]) => {
            const delDistrito = fueraDeUrbanos.filter((z) => z.distrito === clave);
            if (delDistrito.length === 0) return null;
            return (
              <div key={clave ?? 'sin-distrito'}>
                <p className="nota"><strong>{etiqueta}</strong> ({delDistrito.length})</p>
                <div style={{ marginLeft: 12 }}>
                  {delDistrito.map((z) => (
                    <FichaZona key={z.id} zona={z} ocupada={ocupada} alSituar={situar} />
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </>
  );
}

function FichaZona({ zona, ocupada, alSituar }: {
  zona: ZonaOperador;
  ocupada: number | 'nueva' | null;
  alSituar: (z: ZonaOperador) => void;
}) {
  return (
    <div className="oferta">
      <div className="oferta-ruta">{zona.nombre}</div>
      <div className="nota">
        {zona.lat?.toFixed(5)}, {zona.lng?.toFixed(5)} · {zona.vecinas} vecina{zona.vecinas === 1 ? '' : 's'}
        {' · '}{zona.referencias} sitio{zona.referencias === 1 ? '' : 's'}
        {zona.precision_m === null
          ? ' · precisión desconocida'
          : ` · ±${Math.round(zona.precision_m)} m`}
        {zona.vecinas === 0 && ' · ⚠ aislado del reparto'}
      </div>
      <button
        type="button" className="secundario"
        disabled={ocupada !== null}
        onClick={() => alSituar(zona)}
      >
        {ocupada === zona.id ? 'Cogiendo GPS…' : 'Corregir: estoy aquí'}
      </button>
    </div>
  );
}

// --- Barrios: el nivel entre el distrito urbano y el lugar (migración 031) -

function Barrios() {
  const [zonas, setZonas] = useState<ZonaOperador[] | null>(null);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [ocupada, setOcupada] = useState<number | 'nueva' | null>(null);
  const [nombreNuevo, setNombreNuevo] = useState('');
  const [padreNuevo, setPadreNuevo] = useState<number | ''>('');

  function cargar() {
    api.zonasOperador().then((r) => setZonas(r.zonas)).catch((e) => setError(e.message));
  }
  useEffect(cargar, []);

  function conGps(alTener: (lat: number, lng: number, precision: number) => void) {
    setError('');
    capturarGps(alTener, setAviso, setError);
  }

  async function situar(z: ZonaOperador) {
    conGps(async (lat, lng, precision) => {
      setOcupada(z.id);
      try {
        const r = await api.situarZona(z.id, lat, lng, precision);
        setAviso(`«${r.nombre}» situado aquí con ±${Math.round(precision)} m.`);
        cargar();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo situar el barrio/calle.');
      } finally {
        setOcupada(null);
      }
    });
  }

  async function crear() {
    const nombre = nombreNuevo.trim();
    if (!nombre || !padreNuevo) return;
    conGps(async (lat, lng, precision) => {
      setOcupada('nueva');
      try {
        const r = await api.crearZonaEnGps(nombre, lat, lng, precision, padreNuevo);
        setAviso(`«${r.nombre}» creado aquí con ±${Math.round(precision)} m.`);
        setNombreNuevo('');
        cargar();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo crear el barrio/calle.');
      } finally {
        setOcupada(null);
      }
    });
  }

  // Solo las siete cabeceras (migración 041). Antes era «toda zona de primer
  // nivel», que son los setenta y pico barrios de la isla: el desplegable
  // ofrecía Abayak o Bar Peaje como si fueran distritos urbanos.
  const cabeceras = (zonas ?? []).filter((z) => z.es_cabecera_urbana);
  const barrios = (zonas ?? []).filter((z) => z.zona_padre_id !== null);
  const nombrePadre = (padreId: number): string =>
    (zonas ?? []).find((d) => d.id === padreId)?.distrito_urbano
    ?? (zonas ?? []).find((d) => d.id === padreId)?.nombre
    ?? `#${padreId}`;

  return (
    <>
      <p className="nota">
        El nivel entre el distrito urbano y el lugar: un barrio o una calle
        dentro de Ela Nguema, Semu, Malabo Centro… No tiene vecinas propias
        —el reparto sigue funcionando por distrito urbano— y no aparece como
        sitio donde un taxista puede trabajar. Solo sirve para clasificar
        lugares con más precisión.
      </p>
      {error && <p className="aviso">{error}</p>}
      {aviso && <p className="nota">{aviso}</p>}

      <div className="oferta">
        <div className="oferta-ruta">Añadir un barrio/calle donde estoy</div>
        <select value={padreNuevo} onChange={(e) => setPadreNuevo(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Distrito urbano…</option>
          {cabeceras.map((d) => (
            <option key={d.id} value={d.id}>{d.distrito_urbano}</option>
          ))}
        </select>
        <input
          type="text"
          value={nombreNuevo}
          placeholder="Nombre del barrio o la calle"
          onChange={(e) => setNombreNuevo(e.target.value)}
        />
        <button
          type="button" className="principal"
          disabled={!nombreNuevo.trim() || !padreNuevo || ocupada !== null}
          onClick={crear}
        >
          Estoy aquí: crear barrio/calle
        </button>
      </div>

      {barrios.filter((z) => z.sin_situar).length > 0 && (
        <>
          <p className="nota">
            Sin situar ({barrios.filter((z) => z.sin_situar).length}). Hay
            que ir y pulsar allí para que tengan coordenadas.
          </p>
          {barrios.filter((z) => z.sin_situar).map((z) => (
            <div className="oferta oferta-alarma" key={z.id}>
              <div className="oferta-ruta">{z.nombre}</div>
              <div className="nota">{nombrePadre(z.zona_padre_id!)}</div>
              <button
                type="button" className="principal"
                disabled={ocupada !== null}
                onClick={() => situar(z)}
              >
                {ocupada === z.id ? 'Cogiendo GPS…' : 'Estoy aquí'}
              </button>
            </div>
          ))}
        </>
      )}

      <p className="nota">Situados ({barrios.filter((z) => !z.sin_situar).length})</p>
      {barrios.filter((z) => !z.sin_situar).map((z) => (
        <div className="oferta" key={z.id}>
          <div className="oferta-ruta">{z.nombre}</div>
          <div className="nota">
            {nombrePadre(z.zona_padre_id!)} · {z.lat?.toFixed(5)}, {z.lng?.toFixed(5)}
            {' · '}{z.referencias} sitio{z.referencias === 1 ? '' : 's'}
            {z.precision_m === null
              ? ' · precisión desconocida'
              : ` · ±${Math.round(z.precision_m)} m`}
          </div>
          <button
            type="button" className="secundario"
            disabled={ocupada !== null}
            onClick={() => situar(z)}
          >
            {ocupada === z.id ? 'Cogiendo GPS…' : 'Corregir: estoy aquí'}
          </button>
        </div>
      ))}
    </>
  );
}

// El orden es a propósito: los cuatro distritos confirmados primero, y al
// final los barrios sin distrito confirmado — no se ocultan, pero tampoco se
// mezclan con lo que sí se sabe.
// Los siete que el operador reconoce sobre el terreno (migración 040). El
// orden no es alfabético: es de dentro hacia fuera de la ciudad, que es como
// se piensa Malabo desde dentro.
const DISTRITOS_URBANOS = [
  'Malabo Centro', 'Ela Nguema', 'Semu', 'Banapá', 'Santa María',
  'Sácriba', 'Alegre',
] as const;

const DISTRITOS_ORDEN: Array<[ZonaOperador['distrito'], string]> = [
  ['Malabo', 'Malabo'],
  ['Baney', 'Baney'],
  ['Luba', 'Luba'],
  ['Riaba', 'Riaba'],
  [null, 'Sin distrito confirmado'],
];

// --- Zonas: situar barrios con el GPS (migración 025) ------------------------

const SECCIONES = [
  ['resumen', 'Resumen'], ['central', 'Central'], ['incidencias', 'Incidencias'],
  ['conductores', 'Conductores'], ['pasajeros', 'Pasajeros'], ['pagos', 'Pagos'],
  ['zonas', 'Distritos Urbanos'], ['barrios', 'Barrios'], ['lugares', 'Lugares'],
  ['ajustes', 'Ajustes'],
] as const;
type Seccion = (typeof SECCIONES)[number][0];

// Lo que ve un agente de campo (migración 025): el mapa y los precios, nada
// de administrar a sus compañeros ni el dinero. El servidor aplica el mismo
// corte —esto solo evita enseñar botones que darían 403.
const SECCIONES_AGENTE: Seccion[] = ['zonas', 'barrios', 'lugares', 'ajustes'];

const FILTROS_CONDUCTOR = ['pendiente', 'verificado', 'suspendido', 'bloqueado', 'todos'] as const;
const FILTROS_RECARGA = ['pendiente', 'confirmada', 'rechazada', 'caducada', 'todas'] as const;

export default function PanelOperador({ modo = 'operador', alVolver }: {
  modo?: 'operador' | 'agente';
  // Solo en modo agente: el agente vuelve a su panel de taxi.
  alVolver?: () => void;
} = {}) {
  const esAgente = modo === 'agente';
  const visibles = esAgente
    ? SECCIONES.filter(([id]) => SECCIONES_AGENTE.includes(id))
    : SECCIONES;
  const [seccion, setSeccion] = useState<Seccion>(esAgente ? 'zonas' : 'resumen');
  const [stats, setStats] = useState<EstadisticasOperador | null>(null);
  const [salud, setSalud] = useState<SaludOperador | null>(null);
  const [error, setError] = useState('');
  const [ocupadoId, setOcupadoId] = useState<number | string | null>(null);

  // Conductores
  const [conductores, setConductores] = useState<ConductorOperador[] | null>(null);
  const [filtroConductor, setFiltroConductor] = useState<(typeof FILTROS_CONDUCTOR)[number]>('pendiente');
  const [busquedaConductor, setBusquedaConductor] = useState('');
  const [fichaConductor, setFichaConductor] = useState<number | null>(null);

  // Pasajeros
  const [pasajeros, setPasajeros] = useState<PasajeroOperador[] | null>(null);
  const [busquedaPasajero, setBusquedaPasajero] = useState('');
  const [fichaPasajero, setFichaPasajero] = useState<number | null>(null);

  // Incidencias
  const [incidencias, setIncidencias] = useState<IncidenciaOperador[] | null>(null);
  const [filtroIncidencias, setFiltroIncidencias] = useState<'pendientes' | 'resueltas'>('pendientes');

  // Pagos
  const [recargas, setRecargas] = useState<RecargaOperador[] | null>(null);
  const [filtroRecarga, setFiltroRecarga] = useState<(typeof FILTROS_RECARGA)[number]>('pendiente');

  function cargarStats() {
    api.estadisticasOperador().then(setStats).catch((e) => setError(e.message));
    api.saludOperador().then(setSalud).catch(() => undefined);
  }
  useEffect(cargarStats, []);

  // El cuadro de mandos se refresca solo mientras se mira: es la pantalla
  // que se deja abierta encima de la mesa.
  useEffect(() => {
    if (seccion !== 'resumen') return;
    const t = setInterval(cargarStats, 30_000);
    return () => clearInterval(t);
  }, [seccion]);

  useEffect(() => {
    // Con búsqueda se ignora el filtro de estado: quien busca quiere
    // encontrar, no encontrar-solo-si-además-está-pendiente.
    api.conductoresOperador(
      busquedaConductor ? undefined : (filtroConductor === 'todos' ? undefined : filtroConductor),
      busquedaConductor || undefined,
    )
      .then((r) => setConductores(r.conductores))
      .catch((e) => setError(e.message));
  }, [filtroConductor, busquedaConductor]);

  useEffect(() => {
    api.pasajerosOperador(busquedaPasajero || undefined)
      .then((r) => setPasajeros(r.pasajeros))
      .catch((e) => setError(e.message));
  }, [busquedaPasajero]);

  function cargarIncidencias() {
    api.incidenciasOperador(filtroIncidencias)
      .then((r) => setIncidencias(r.incidencias))
      .catch((e) => setError(e.message));
  }
  useEffect(cargarIncidencias, [filtroIncidencias]);

  function cargarRecargas() {
    api.recargasOperador(filtroRecarga === 'todas' ? undefined : filtroRecarga)
      .then((r) => setRecargas(r.recargas))
      .catch((e) => setError(e.message));
  }
  useEffect(cargarRecargas, [filtroRecarga]);

  async function cambiarEstadoConductor(id: number, estado: string) {
    setOcupadoId(id);
    setError('');
    try {
      await api.cambiarEstadoConductor(id, estado);
      api.conductoresOperador(
        busquedaConductor ? undefined : (filtroConductor === 'todos' ? undefined : filtroConductor),
        busquedaConductor || undefined,
      ).then((r) => setConductores(r.conductores)).catch(() => undefined);
      cargarStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar el estado.');
    } finally {
      setOcupadoId(null);
    }
  }

  async function resolverIncidencia(id: number, accion: 'sancionar' | 'perdonar') {
    setOcupadoId(id);
    setError('');
    try {
      await api.resolverIncidencia(id, accion);
      cargarIncidencias();
      cargarStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo resolver.');
    } finally {
      setOcupadoId(null);
    }
  }

  async function confirmarPago(referencia: string) {
    setOcupadoId(referencia);
    setError('');
    try {
      await api.confirmarRecarga(referencia);
      cargarRecargas();
      cargarStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo confirmar el pago.');
    } finally {
      setOcupadoId(null);
    }
  }

  async function rechazarPago(referencia: string) {
    const motivo = window.prompt('¿Por qué se rechaza esta recarga?');
    if (!motivo?.trim()) return;
    setOcupadoId(referencia);
    setError('');
    try {
      await api.rechazarRecarga(referencia, motivo.trim());
      cargarRecargas();
      cargarStats();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo rechazar el pago.');
    } finally {
      setOcupadoId(null);
    }
  }

  const enFicha = (seccion === 'conductores' && fichaConductor !== null)
    || (seccion === 'pasajeros' && fichaPasajero !== null);
  const hayAlarma = salud?.alarmas.some((a) => a.disparada) ?? false;

  return (
    <main className="lienzo">
      <section className="hoja hoja-completa">
        {!enFicha && (
          <>
            <div className="cabecera">
              <h1>{esAgente ? 'Trabajo de campo' : 'Panel de operador'}</h1>
              {esAgente && alVolver && (
                <button type="button" className="ajustes" aria-label="Volver a mi taxi" onClick={alVolver}>
                  ←
                </button>
              )}
            </div>
            <div className="selector-idioma">
              {visibles.map(([id, etiqueta]) => (
                <button
                  key={id} type="button"
                  className={id === seccion ? 'idioma-activo' : undefined}
                  onClick={() => { setSeccion(id); setFichaConductor(null); setFichaPasajero(null); }}
                >
                  {etiqueta}
                  {id === 'resumen' && hayAlarma && ' ⚠'}
                  {id === 'incidencias' && stats !== null && stats.incidenciasPendientes > 0 && ` (${stats.incidenciasPendientes})`}
                  {id === 'pagos' && stats !== null && stats.recargasPendientes > 0 && ` (${stats.recargasPendientes})`}
                </button>
              ))}
            </div>
          </>
        )}
        {error && <p className="aviso">{error}</p>}

        {seccion === 'resumen' && stats && <Resumen stats={stats} salud={salud} />}

        {seccion === 'central' && <Central />}

        {seccion === 'incidencias' && (
          <>
            <div className="selector-idioma">
              {(['pendientes', 'resueltas'] as const).map((f) => (
                <button
                  key={f} type="button"
                  className={f === filtroIncidencias ? 'idioma-activo' : undefined}
                  onClick={() => setFiltroIncidencias(f)}
                >
                  {f === 'pendientes' ? 'Por revisar' : 'Resueltas'}
                </button>
              ))}
            </div>
            {incidencias?.length === 0 && (
              <p className="nota">
                {filtroIncidencias === 'pendientes' ? 'Nada por revisar. Todo al día.' : 'Ninguna resuelta todavía.'}
              </p>
            )}
            {incidencias?.map((i) => (
              <FilaIncidencia
                key={i.id} incidencia={i} ocupada={ocupadoId === i.id}
                alResolver={resolverIncidencia}
              />
            ))}
          </>
        )}

        {seccion === 'conductores' && (
          fichaConductor !== null
            ? (
              <FichaConductor
                id={fichaConductor}
                alVolver={() => setFichaConductor(null)}
                alCambiarEstado={cambiarEstadoConductor}
                ocupado={ocupadoId !== null}
              />
            )
            : (
              <>
                <Buscador alBuscar={setBusquedaConductor} />
                {!busquedaConductor && (
                  <div className="selector-idioma">
                    {FILTROS_CONDUCTOR.map((f) => (
                      <button
                        key={f} type="button"
                        className={f === filtroConductor ? 'idioma-activo' : undefined}
                        onClick={() => setFiltroConductor(f)}
                      >
                        {f === 'todos' ? 'Todos' : ETIQUETA_ESTADO[f]}
                      </button>
                    ))}
                  </div>
                )}
                {conductores?.length === 0 && <p className="nota">No hay conductores que encajen.</p>}
                {conductores?.map((c) => (
                  <FilaConductor key={c.id} conductor={c} alAbrir={setFichaConductor} />
                ))}
              </>
            )
        )}

        {seccion === 'pasajeros' && (
          fichaPasajero !== null
            ? <FichaPasajero dispositivoId={fichaPasajero} alVolver={() => setFichaPasajero(null)} />
            : (
              <>
                <Buscador alBuscar={setBusquedaPasajero} />
                {pasajeros?.length === 0 && <p className="nota">No hay pasajeros que encajen.</p>}
                {pasajeros?.map((p) => (
                  <button
                    key={p.dispositivo_id} type="button" className="oferta oferta-boton"
                    onClick={() => setFichaPasajero(p.dispositivo_id)}
                  >
                    <span className="oferta-ruta">{p.nombre ?? p.telefono ?? `Dispositivo ${p.dispositivo_id}`}</span>
                    <span className="nota">
                      {p.telefono ?? 'sin teléfono'} · {p.viajes} viaje{p.viajes === 1 ? '' : 's'}
                      {p.strikes > 0 && ` · ${p.strikes} strike${p.strikes === 1 ? '' : 's'}`}
                      {p.bloqueado_en && ' · BLOQUEADO'}
                    </span>
                  </button>
                ))}
              </>
            )
        )}

        {seccion === 'pagos' && (
          <>
            <div className="selector-idioma">
              {FILTROS_RECARGA.map((f) => (
                <button
                  key={f} type="button"
                  className={f === filtroRecarga ? 'idioma-activo' : undefined}
                  onClick={() => setFiltroRecarga(f)}
                >
                  {f === 'todas' ? 'Todas' : ETIQUETA_ESTADO_RECARGA[f]}
                </button>
              ))}
            </div>
            {recargas?.length === 0 && <p className="nota">No hay recargas en este estado.</p>}
            {recargas?.map((r) => (
              <div className="oferta" key={r.id}>
                <div className="oferta-ruta">
                  {r.importe_xaf.toLocaleString('es')} XAF · {r.referencia}
                </div>
                <div className="nota">{r.conductor_nombre} · {r.conductor_telefono}</div>
                <div className="nota">
                  Pago por <strong>{ETIQUETA_METODO[r.metodo] ?? r.metodo}</strong>
                  {' · '}Estado: <strong>{ETIQUETA_ESTADO_RECARGA[r.estado] ?? r.estado}</strong>
                </div>
                {r.nota && <div className="nota">Nota: {r.nota}</div>}
                {r.estado === 'pendiente' && (
                  <div className="fila">
                    <button
                      type="button" className="principal" disabled={ocupadoId === r.referencia}
                      onClick={() => confirmarPago(r.referencia)}
                    >
                      Confirmar pago
                    </button>
                    <button
                      type="button" className="secundario" disabled={ocupadoId === r.referencia}
                      onClick={() => rechazarPago(r.referencia)}
                    >
                      Rechazar
                    </button>
                  </div>
                )}
              </div>
            ))}
          </>
        )}

        {seccion === 'zonas' && <Zonas />}
        {seccion === 'barrios' && <Barrios />}
        {seccion === 'lugares' && <Lugares />}

        {seccion === 'ajustes' && <Ajustes />}
      </section>
    </main>
  );
}
