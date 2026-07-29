// Panel de operador (PENDIENTES.md P21-01): la mesa de trabajo de quien
// opera la plataforma — incidencias por revisar, fichas de conductores y
// pasajeros con su historial, pagos por confirmar y los números del sistema.
// Solo en español a propósito: es herramienta interna, no cara al pasajero
// ni al taxista, así que no pasa por i18n.ts.

import { useEffect, useState } from 'react';
import {
  api,
  type ConductorOperador, type EstadisticasOperador, type FichaConductorOperador,
  type FichaPasajeroOperador, type IncidenciaOperador, type PasajeroOperador,
  type RecargaOperador, type TransicionOperador, type ViajeResumenOperador,
} from './api';

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

function fecha(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function Dato({ valor, etiqueta }: { valor: number | string; etiqueta: string }) {
  return (
    <div className="dato">
      <span className="dato-valor">{valor}</span>
      <span className="dato-etiqueta">{etiqueta}</span>
    </div>
  );
}

function Buscador({ alBuscar }: { alBuscar: (q: string) => void }) {
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
      placeholder="Buscar por nombre, teléfono o matrícula…"
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

  function cargar() {
    api.fichaConductorOperador(id).then(setFicha).catch((e) => setError(e.message));
  }
  useEffect(cargar, [id]);

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
      </div>
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

const SECCIONES = [
  ['resumen', 'Resumen'], ['incidencias', 'Incidencias'], ['conductores', 'Conductores'],
  ['pasajeros', 'Pasajeros'], ['pagos', 'Pagos'],
] as const;
type Seccion = (typeof SECCIONES)[number][0];

const FILTROS_CONDUCTOR = ['pendiente', 'verificado', 'suspendido', 'bloqueado', 'todos'] as const;
const FILTROS_RECARGA = ['pendiente', 'confirmada', 'rechazada', 'caducada', 'todas'] as const;

export default function PanelOperador() {
  const [seccion, setSeccion] = useState<Seccion>('resumen');
  const [stats, setStats] = useState<EstadisticasOperador | null>(null);
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
  }
  useEffect(cargarStats, []);

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

  return (
    <main className="lienzo">
      <section className="hoja hoja-completa">
        {!enFicha && (
          <>
            <div className="cabecera">
              <h1>Panel de operador</h1>
            </div>
            <div className="selector-idioma">
              {SECCIONES.map(([id, etiqueta]) => (
                <button
                  key={id} type="button"
                  className={id === seccion ? 'idioma-activo' : undefined}
                  onClick={() => { setSeccion(id); setFichaConductor(null); setFichaPasajero(null); }}
                >
                  {etiqueta}
                  {id === 'incidencias' && stats !== null && stats.incidenciasPendientes > 0 && ` (${stats.incidenciasPendientes})`}
                  {id === 'pagos' && stats !== null && stats.recargasPendientes > 0 && ` (${stats.recargasPendientes})`}
                </button>
              ))}
            </div>
          </>
        )}
        {error && <p className="aviso">{error}</p>}

        {seccion === 'resumen' && stats && (
          <div className="rejilla">
            <Dato valor={stats.incidenciasPendientes} etiqueta="Incidencias por revisar" />
            <Dato valor={stats.recargasPendientes} etiqueta="Pagos por confirmar" />
            <Dato valor={stats.conductores.pendientes} etiqueta="Conductores pendientes" />
            <Dato valor={stats.conductores.verificados} etiqueta="Conductores verificados" />
            <Dato valor={stats.enServicioAhora} etiqueta="En servicio ahora" />
            <Dato valor={stats.pasajeros} etiqueta="Pasajeros registrados" />
            <Dato valor={stats.solicitudes.ultimas_24h} etiqueta="Solicitudes (24 h)" />
            <Dato valor={stats.solicitudes.completadas} etiqueta="Viajes completados" />
            <Dato valor={stats.solicitudes.sin_taxi} etiqueta="Se quedaron sin taxi" />
            <Dato valor={`${stats.saldoTotalMonederosXaf.toLocaleString('es')} XAF`} etiqueta="Saldo total monederos" />
          </div>
        )}

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
      </section>
    </main>
  );
}
