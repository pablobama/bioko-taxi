// Panel de operador (PENDIENTES.md P21-01): la mesa de trabajo de quien
// opera la plataforma — el cuadro de mandos con sus alarmas, la central
// telefónica, incidencias por revisar, fichas de conductores y pasajeros,
// pagos por confirmar, el catálogo de sitios y los mandos del sistema.
// Solo en español a propósito: es herramienta interna, no cara al pasajero
// ni al taxista, así que no pasa por i18n.ts.

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  type AccesoOperador, type AparatoOperador,
  type BandaOperador, type CambioOperador, type ConductorOperador, type EstadisticasOperador,
  type FichaConductorOperador, type FichaPasajeroOperador, type FichaPropietarioOperador, type IncidenciaOperador,
  type ParametroOperador, type PasajeroOperador, type PeriodoRecorrido,
  type RecargaOperador, type RecorridoOperador, type ReferenciaOperador,
  type PropietarioFicha, type PropietarioRegistro, type SaludOperador, type SinOfertaViva, type SolicitudCentral,
  type TaxiVivo, type TransicionOperador, type VehiculoRegistro,
  type ViajeVivo,
  type ViajeOperador, type ViajeResumenOperador, type ZonaOperador,
} from './api';
import { abrirEventosOperador, bajarFotoConductor } from './api';
import { ESTILO_CATEGORIA } from './categorias';
import { metrosEntre } from './geo';
import { crearT } from './i18n';
import PanelRadio from './PanelRadio';
import { useRadio } from './radio';
import { ErrorDelServidor } from './conexion';
import Mapa, { colorDeCalor, type Marca } from './Mapa';

// Las categorías que la base acepta (CHECK de la migración 021). Se sacan de
// donde ya estaban —el mismo sitio que dibuja los pictogramas del mapa— para
// que no haya dos listas que se separen.
//
// Fuera «zona»: la reserva el propio barrio cuando se sitúa con el GPS, y no
// es algo que se elija al dar de alta un sitio.
const CATEGORIAS = Object.keys(ESTILO_CATEGORIA).filter((c) => c !== 'zona').sort();

const ETIQUETA_CARROCERIA: Record<string, string> = {
  turismo: 'Turismo', '4x4': '4x4', furgoneta: 'Furgoneta', autobus: 'Autobús',
};

// El tope de plazas por tipo (migración 089). Lo decide el servidor; esto es
// solo para la pista y el maxLength del formulario.
const MAX_PLAZAS_UI: Record<string, number> = {
  turismo: 4, '4x4': 4, furgoneta: 16, autobus: 60,
};
const topePlazasUI = (carroceria: string): number => MAX_PLAZAS_UI[carroceria] ?? 4;

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
  let vigilancia = 0;
  let reloj: ReturnType<typeof setTimeout> | undefined;

  // `let` declarado ANTES, no `const` en la misma línea de la llamada: si el
  // navegador entrega la primera posición de forma síncrona —tiene una
  // fijación cacheada y contesta antes de devolver el identificador—, el
  // callback se ejecuta con la variable todavía sin inicializar y todo
  // revienta con «Cannot access before initialization». Pasó en pruebas.
  vigilancia = navigator.geolocation.watchPosition(
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
  reloj = setTimeout(() => {
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

// El alta de un taxista hecha por el operador (06/10). Plegada tras un botón:
// darla es un acto de vez en cuando, y un formulario siempre abierto empuja
// la lista que se usa a todas horas.
//
// Lo que promete el texto de después de guardar es exactamente lo que pasa:
// nace verificado (lo verificó quien lo dio de alta) y el TELÉFONO queda por
// confirmar — lo confirma el taxista con el código, o con el vale, la primera
// vez que entra. Sin eso, dar de alta sería regalar la cuenta de un número a
// quien lo dicte primero.
function AltaDeTaxista({ alCreada, duenoFijado, abiertaInicial = false, alCerrar }: {
  alCreada: (conductorId: number) => void;
  // Con un dueño fijado (desde su ficha, para añadirle otro coche), el alta
  // no pregunta por el dueño: ese coche es suyo y se registra otro taxista.
  duenoFijado?: { id: number; nombre: string; apellido: string };
  abiertaInicial?: boolean;
  // Avisa a quien lo monta de que se cerró, para que recoja su botón.
  alCerrar?: () => void;
}) {
  const [abierta, setAbierta] = useState(abiertaInicial);
  // Conductor
  const [nombre, setNombre] = useState('');
  const [apellido, setApellido] = useState('');
  const [telefono, setTelefono] = useState('');
  const [dip, setDip] = useState('');
  // Propietario: el que conduce, uno ya registrado (elegido), o uno nuevo.
  const [duenoConduce, setDuenoConduce] = useState(duenoFijado === undefined);
  const [modoDueno, setModoDueno] = useState<'existente' | 'nuevo'>('existente');
  const [propietarioElegido, setPropietarioElegido] = useState<number | ''>(duenoFijado?.id ?? '');
  const [propietarios, setPropietarios] = useState<PropietarioRegistro[] | null>(null);
  const [pNombre, setPNombre] = useState('');
  const [pApellido, setPApellido] = useState('');
  const [pTelefono, setPTelefono] = useState('');
  const [pDip, setPDip] = useState('');
  // Vehículo
  const [matricula, setMatricula] = useState('');
  const [marca, setMarca] = useState('');
  const [numeroTaxi, setNumeroTaxi] = useState('');
  const [carroceria, setCarroceria] = useState('turismo');
  const [color, setColor] = useState('');
  const [plazas, setPlazas] = useState('');
  const [aire, setAire] = useState(false);
  const [seguro, setSeguro] = useState(false);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  // La lista de dueños para elegir uno ya registrado. Se pide al abrir el alta,
  // salvo que el dueño ya venga fijado (entonces no hay nada que elegir).
  useEffect(() => {
    if (!abierta || duenoFijado !== undefined || propietarios !== null) return;
    api.propietariosOperador()
      .then((r) => setPropietarios(r.propietarios))
      .catch(() => setPropietarios([]));
  }, [abierta, duenoFijado, propietarios]);

  if (!abierta) {
    return (
      <button type="button" className="secundario" onClick={() => setAbierta(true)}>
        Dar de alta un taxista
      </button>
    );
  }

  // Un DIP válido son nueve dígitos, ni uno más. Solo cifras al escribir.
  const esDip = (v: string) => /^\d{9}$/.test(v.trim());
  const conductorOk = nombre.trim() !== '' && apellido.trim() !== ''
    && telefono.trim().length >= 6 && esDip(dip);
  const nuevoDuenoOk = pNombre.trim() !== '' && pApellido.trim() !== ''
    && pTelefono.trim().length >= 6 && esDip(pDip);
  const propietarioOk = duenoFijado !== undefined || duenoConduce
    || (modoDueno === 'existente' ? propietarioElegido !== '' : nuevoDuenoOk);
  const vehiculoOk = matricula.trim() !== '' && marca.trim() !== '';
  const completo = conductorOk && propietarioOk && vehiculoOk;

  // La parte del dueño, por uno de los tres caminos.
  function datosDelDueno(): {
    duenoConduce: boolean; propietarioId?: number;
    propietario?: { nombre: string; apellido: string; telefono: string; dip: string };
  } {
    if (duenoFijado !== undefined) return { duenoConduce: false, propietarioId: duenoFijado.id };
    if (duenoConduce) return { duenoConduce: true };
    if (modoDueno === 'existente') return { duenoConduce: false, propietarioId: Number(propietarioElegido) };
    return {
      duenoConduce: false,
      propietario: {
        nombre: pNombre.trim(), apellido: pApellido.trim(),
        telefono: pTelefono.trim(), dip: pDip.trim(),
      },
    };
  }

  async function guardar() {
    setError('');
    setOcupado(true);
    try {
      const r = await api.darDeAltaTaxista({
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        telefono: telefono.trim(),
        dip: dip.trim(),
        ...datosDelDueno(),
        matricula: matricula.trim(),
        marca: marca.trim(),
        carroceria,
        color: color.trim() || undefined,
        plazas: plazas.trim() === '' ? undefined : Number(plazas),
        aireAcondicionado: aire,
        seguro,
        numeroTaxi: numeroTaxi.trim() || undefined,
      });
      setAbierta(false);
      alCreada(r.conductorId);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo dar el alta.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      <p className="nota">
        Nace verificado —lo estás verificando tú— y con el número por
        confirmar: la primera vez que entre, el código del SMS (o tu vale) es
        lo que demuestra que esa línea es suya.
      </p>
      {error && <p className="aviso">{error}</p>}

      <h4 className="alta-titulo">Quién conduce</h4>
      <div className="fila">
        <input value={nombre} placeholder="Nombre" onChange={(e) => setNombre(e.target.value)} />
        <input value={apellido} placeholder="Apellido" onChange={(e) => setApellido(e.target.value)} />
      </div>
      <div className="fila">
        <input
          value={telefono} inputMode="tel" placeholder="Teléfono"
          onChange={(e) => setTelefono(e.target.value)}
        />
        <input
          value={dip} inputMode="numeric" placeholder="DIP (9 dígitos)" maxLength={9}
          onChange={(e) => setDip(e.target.value.replace(/\D/g, '').slice(0, 9))}
        />
      </div>

      {/* El dueño del coche. Casi siempre es el mismo que conduce; cuando no,
          se ELIGE uno ya registrado —así se arma la flota de un dueño— o se
          teclea uno nuevo. Con el dueño fijado (añadir coche desde su ficha),
          no se pregunta. */}
      {duenoFijado !== undefined ? (
        <p className="nota">
          El coche será de <strong>{duenoFijado.nombre} {duenoFijado.apellido}</strong>, conducido por el taxista de arriba.
        </p>
      ) : (
        <>
          <label className="casilla">
            <input
              type="checkbox" checked={duenoConduce}
              onChange={(e) => setDuenoConduce(e.target.checked)}
            />
            El dueño del coche es quien conduce
          </label>
          {!duenoConduce && (
            <>
              <h4 className="alta-titulo">De quién es el coche</h4>
              <div className="selector-idioma">
                <button
                  type="button" className={modoDueno === 'existente' ? 'idioma-activo' : undefined}
                  onClick={() => setModoDueno('existente')}
                >
                  Ya registrado
                </button>
                <button
                  type="button" className={modoDueno === 'nuevo' ? 'idioma-activo' : undefined}
                  onClick={() => setModoDueno('nuevo')}
                >
                  Dueño nuevo
                </button>
              </div>
              {modoDueno === 'existente' ? (
                (propietarios?.length ?? 0) === 0 ? (
                  <p className="nota">
                    {propietarios === null ? 'Cargando dueños…' : 'No hay dueños registrados todavía. Elige «Dueño nuevo».'}
                  </p>
                ) : (
                  <select
                    value={propietarioElegido}
                    onChange={(e) => setPropietarioElegido(e.target.value ? Number(e.target.value) : '')}
                  >
                    <option value="">Elige un dueño…</option>
                    {(propietarios ?? []).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nombre} {p.apellido} · DIP {p.dip} · {p.coches} coche{p.coches === 1 ? '' : 's'}
                      </option>
                    ))}
                  </select>
                )
              ) : (
                <>
                  <div className="fila">
                    <input value={pNombre} placeholder="Nombre del dueño" onChange={(e) => setPNombre(e.target.value)} />
                    <input value={pApellido} placeholder="Apellido del dueño" onChange={(e) => setPApellido(e.target.value)} />
                  </div>
                  <div className="fila">
                    <input
                      value={pTelefono} inputMode="tel" placeholder="Teléfono del dueño"
                      onChange={(e) => setPTelefono(e.target.value)}
                    />
                    <input
                      value={pDip} inputMode="numeric" placeholder="DIP del dueño (9 dígitos)" maxLength={9}
                      onChange={(e) => setPDip(e.target.value.replace(/\D/g, '').slice(0, 9))}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      <h4 className="alta-titulo">El coche</h4>
      <div className="fila">
        <input
          value={matricula} placeholder="Matrícula"
          onChange={(e) => setMatricula(e.target.value)}
        />
        <input value={marca} placeholder="Marca" onChange={(e) => setMarca(e.target.value)} />
        <select value={carroceria} onChange={(e) => setCarroceria(e.target.value)}>
          <option value="turismo">Turismo</option>
          <option value="4x4">4x4</option>
          <option value="furgoneta">Furgoneta</option>
          <option value="autobus">Autobús</option>
        </select>
      </div>
      <div className="fila">
        <input value={color} placeholder="Color (opcional)" onChange={(e) => setColor(e.target.value)} />
        {/* Las plazas (089): vacío, la base pone 4. Para furgoneta y autobús
            conviene ponerlas, que 4 se les queda corto. */}
        <input
          value={plazas} inputMode="numeric" placeholder={`Plazas (vacío: 4, máx ${topePlazasUI(carroceria)})`}
          maxLength={2}
          onChange={(e) => setPlazas(e.target.value.replace(/\D/g, '').slice(0, 2))}
        />
      </div>
      <div className="fila">
        {/* El número de flota (084). Vacío, le toca el siguiente; se rellena
            solo cuando el coche YA lleva uno pintado, y el servidor no deja
            dar ninguno por delante de la secuencia. */}
        <input
          value={numeroTaxi} placeholder="Nº de taxi (vacío: el siguiente)"
          onChange={(e) => setNumeroTaxi(e.target.value)}
        />
        <label className="casilla">
          <input type="checkbox" checked={aire} onChange={(e) => setAire(e.target.checked)} />
          Aire acondicionado
        </label>
        <label className="casilla">
          <input type="checkbox" checked={seguro} onChange={(e) => setSeguro(e.target.checked)} />
          Seguro en regla
        </label>
      </div>
      <div className="fila">
        <button
          type="button" className="principal"
          disabled={!completo || ocupado} onClick={guardar}
        >
          Darlo de alta
        </button>
        <button type="button" className="secundario" onClick={() => { setAbierta(false); alCerrar?.(); }}>
          Dejarlo
        </button>
      </div>
    </>
  );
}

// Cambiar el número con el que entra alguien (05/10).
//
// Va detrás de una confirmación y con el número escrito dos veces mal contado:
// una sola errata deja a la persona fuera de su cuenta y con la llave en un
// número que no es de nadie. Y se dice lo que de verdad pasa —que el nuevo
// queda sin verificar— antes de pulsar, no después.
function CambiarTelefono({ actual, alCambiar }: {
  actual: string | null;
  alCambiar: (telefono: string) => Promise<unknown>;
}) {
  const [abierto, setAbierto] = useState(false);
  const [nuevo, setNuevo] = useState('');
  const [error, setError] = useState('');
  const [hecho, setHecho] = useState('');
  const [ocupado, setOcupado] = useState(false);

  async function guardar() {
    setError(''); setOcupado(true);
    try {
      const r = await alCambiar(nuevo.trim()) as { telefono: string };
      setHecho(`Ahora entra con el ${r.telefono}. Tendrá que verificarlo.`);
      setAbierto(false);
      setNuevo('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cambiar el número.');
    } finally {
      setOcupado(false);
    }
  }

  if (!abierto) {
    return (
      <>
        <button type="button" className="secundario" onClick={() => { setAbierto(true); setHecho(''); }}>
          Cambiar su número de teléfono
        </button>
        {hecho && <p className="nota">{hecho}</p>}
      </>
    );
  }

  return (
    <>
      <p className="nota">
        Con este número entra a su cuenta. Si lo cambias, el viejo deja de
        servir y el nuevo queda sin verificar: tendrá que confirmarlo con un
        código —o con el código de entrada que le des tú—. Ahora es
        {' '}{actual ?? 'ninguno'}.
      </p>
      <div className="fila">
        <input
          value={nuevo} inputMode="tel" placeholder="Número nuevo"
          onChange={(e) => setNuevo(e.target.value)}
        />
      </div>
      {error && <p className="aviso">{error}</p>}
      <div className="fila">
        <button
          type="button" className="principal"
          disabled={ocupado || nuevo.trim().length < 6} onClick={guardar}
        >
          Sí, cambiárselo
        </button>
        <button
          type="button" className="secundario"
          onClick={() => { setAbierto(false); setNuevo(''); setError(''); }}
        >
          Dejarlo como está
        </button>
      </div>
    </>
  );
}

// El código de entrada para quien no recibe ni el SMS ni la llamada
// (migración 081). El 05/10, GETESA devolvía los SMS de Twilio como «no
// entregados» y un taxista verificado no podía entrar en su propia cuenta: esto
// es la salida de ese callejón.
//
// SE ENSEÑA UNA VEZ Y NO SE GUARDA. En la base solo queda su resumen, así que
// no hay forma de volver a verlo: si se pierde, se da otro, y el anterior deja
// de valer en ese mismo momento.
function ValeDeEntrada({ telefono }: { telefono: string | null }) {
  const [vale, setVale] = useState<{ codigo: string; caducaEn: string } | null>(null);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  if (!telefono) return null;

  async function pedir() {
    setError(''); setOcupado(true);
    try {
      setVale(await api.valeOperador(telefono as string));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo dar el código.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      <button type="button" className="secundario" disabled={ocupado} onClick={pedir}>
        {vale ? 'Dar otro código de entrada' : 'No le llegan los SMS: darle un código de entrada'}
      </button>
      {error && <p className="aviso">{error}</p>}
      {vale && (
        <>
          <p className="dato-valor">{vale.codigo}</p>
          <p className="nota">
            Díctaselo por teléfono. Lo escribe donde escribiría el código del
            SMS, y caduca a las {soloHora(vale.caducaEn)}. Vale una sola vez: si
            se equivoca al teclearlo, dale otro.
          </p>
        </>
      )}
    </>
  );
}

// Reduce una imagen a un lado máximo y la devuelve como JPEG. En el navegador
// y no en el servidor: así lo que viaja ya es pequeño y el servidor no necesita
// una librería de imágenes (migración 088).
async function reducirImagen(archivo: File, lado = 400): Promise<Blob> {
  const img = await createImageBitmap(archivo);
  const escala = Math.min(1, lado / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * escala));
  const h = Math.max(1, Math.round(img.height * escala));
  const lienzo = document.createElement('canvas');
  lienzo.width = w;
  lienzo.height = h;
  lienzo.getContext('2d')!.drawImage(img, 0, 0, w, h);
  return new Promise((res, rej) => {
    lienzo.toBlob((b) => (b ? res(b) : rej(new Error('no se pudo'))), 'image/jpeg', 0.82);
  });
}

// La foto del taxista: la enseña y deja cambiarla. El operador la saca con la
// cámara (en el móvil, el input abre la cámara) o elige un archivo.
function FotoTaxista({ id, tieneFoto, alCambiar }: {
  id: number; tieneFoto: boolean; alCambiar: () => void;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let vivo = true;
    let actual: string | null = null;
    if (tieneFoto) {
      bajarFotoConductor(id).then((blob) => {
        if (!vivo || blob === null) return;
        actual = URL.createObjectURL(blob);
        setUrl(actual);
      }).catch(() => undefined);
    } else {
      setUrl(null);
    }
    return () => { vivo = false; if (actual) URL.revokeObjectURL(actual); };
  }, [id, tieneFoto]);

  async function elegir(e: React.ChangeEvent<HTMLInputElement>) {
    const archivo = e.target.files?.[0];
    e.target.value = '';
    if (!archivo) return;
    setError('');
    setSubiendo(true);
    try {
      const reducida = await reducirImagen(archivo);
      await api.subirFotoConductor(id, reducida);
      alCambiar();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir la foto.');
    } finally {
      setSubiendo(false);
    }
  }

  return (
    <div className="foto-taxista">
      {url !== null
        ? <img src={url} alt="Foto del taxista" className="foto-taxista-img" />
        : <div className="foto-taxista-hueco" aria-hidden="true">👤</div>}
      <label className="secundario foto-taxista-boton">
        {subiendo ? 'Subiendo…' : url !== null ? 'Cambiar foto' : 'Añadir foto'}
        <input
          type="file" accept="image/*" capture="environment"
          disabled={subiendo} onChange={elegir} hidden
        />
      </label>
      {error !== '' && <p className="aviso">{error}</p>}
    </div>
  );
}

// Editar los datos del taxista: nombre, apellido, DIP y correo.
function EditarDatosTaxista({ ficha, alGuardado, alCancelar }: {
  ficha: FichaConductorOperador;
  alGuardado: () => void;
  alCancelar: () => void;
}) {
  const [nombre, setNombre] = useState(ficha.nombre);
  const [apellido, setApellido] = useState(ficha.apellido ?? '');
  const [dip, setDip] = useState(ficha.dip ?? '');
  const [correo, setCorreo] = useState(ficha.correo ?? '');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const completo = nombre.trim() !== '' && apellido.trim() !== ''
    && (dip.trim() === '' || /^\d{9}$/.test(dip.trim()));
  // Hacer dueño al taxista necesita su identidad completa: el propietario se
  // registra con nombre, apellido y DIP (migración 087).
  const puedeSerDueno = nombre.trim() !== '' && apellido.trim() !== ''
    && /^\d{9}$/.test(dip.trim());
  const yaEsDueno = ficha.propietario !== null
    && ficha.dip !== null && ficha.propietario.dip === ficha.dip;

  async function guardar() {
    setError('');
    setOcupado(true);
    try {
      await api.editarDatosConductor(ficha.id, {
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        dip: dip.trim() || undefined,
        correo: correo.trim() || undefined,
      });
      alGuardado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  }

  // Guarda primero lo que hay en pantalla —para que el dueño use estos datos— y
  // luego hace dueño del coche al taxista.
  async function hacerDueno() {
    setError('');
    setOcupado(true);
    try {
      await api.editarDatosConductor(ficha.id, {
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        dip: dip.trim() || undefined,
        correo: correo.trim() || undefined,
      });
      await api.hacerDuenoAlConductor(ficha.id);
      alGuardado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo hacer dueño al taxista.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      {error !== '' && <p className="aviso">{error}</p>}
      <div className="fila">
        <input value={nombre} placeholder="Nombre" onChange={(e) => setNombre(e.target.value)} />
        <input value={apellido} placeholder="Apellido" onChange={(e) => setApellido(e.target.value)} />
      </div>
      <div className="fila">
        <input
          value={dip} inputMode="numeric" placeholder="DIP (9 dígitos)" maxLength={9}
          onChange={(e) => setDip(e.target.value.replace(/\D/g, '').slice(0, 9))}
        />
        <input value={correo} inputMode="email" placeholder="Correo (opcional)" onChange={(e) => setCorreo(e.target.value)} />
      </div>
      <div className="fila">
        <button type="button" className="principal" disabled={!completo || ocupado} onClick={guardar}>
          Guardar datos
        </button>
        <button type="button" className="secundario" onClick={alCancelar}>Cancelar</button>
      </div>
      {/* El caso más común: el taxista es el dueño del coche. Un botón, en vez
          de ir a la pestaña del dueño a reteclear sus datos. */}
      {!yaEsDueno && (
        <>
          <button
            type="button" className="secundario"
            disabled={!puedeSerDueno || ocupado} onClick={hacerDueno}
          >
            Este taxista es el dueño del coche
          </button>
          {!puedeSerDueno && (
            <p className="nota">Para hacerlo dueño hace falta su nombre, apellido y DIP.</p>
          )}
        </>
      )}
    </>
  );
}

// La tarjeta de identidad: una foto (si la hay) al lado de los datos bien
// puestos. La misma para el taxista, el dueño y el vehículo, para que las tres
// pestañas se lean igual. Un dato que falta se enseña con dignidad —en gris y
// con su nombre— en vez de dejar un hueco: una ficha a medias sigue pareciendo
// una ficha.
function TarjetaIdentidad({ foto, titulo, insignia, datos }: {
  foto?: React.ReactNode;
  titulo: React.ReactNode;
  insignia?: React.ReactNode;
  datos: Array<{ k: string; v: React.ReactNode; falta?: boolean }>;
}) {
  return (
    <div className="tarjeta-identidad">
      {foto !== undefined && foto !== null && (
        <div className="tarjeta-foto">{foto}</div>
      )}
      <div className="tarjeta-cuerpo">
        <div className="tarjeta-cabeza">
          <h2 className="tarjeta-titulo">{titulo}</h2>
          {insignia}
        </div>
        <dl className="tarjeta-datos">
          {datos.map(({ k, v, falta }) => (
            <div className="tarjeta-dato" key={k}>
              <dt>{k}</dt>
              <dd className={falta ? 'tarjeta-falta' : undefined}>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

// Editar el vehículo en su pestaña (08/10): color, plazas, aire y seguro
// siempre; matrícula, marca y tipo solo si el coche no está validado —una vez
// la central lo validó, describen OTRO coche, así que se bloquean, igual que en
// el alta del propio taxista—.
const TIPOS_VEHICULO = Object.entries(ETIQUETA_CARROCERIA);

function EditarVehiculo({ ficha, alGuardado, alCancelar }: {
  ficha: FichaConductorOperador;
  alGuardado: () => void;
  alCancelar: () => void;
}) {
  const validado = ficha.estado_verificacion === 'verificado';
  const [matricula, setMatricula] = useState(ficha.matricula ?? '');
  const [marca, setMarca] = useState(ficha.marca ?? '');
  const [carroceria, setCarroceria] = useState(ficha.carroceria ?? 'turismo');
  const [color, setColor] = useState(ficha.color ?? '');
  const [plazas, setPlazas] = useState(ficha.plazas !== null ? String(ficha.plazas) : '');
  const [aire, setAire] = useState(ficha.aire_acondicionado);
  const [seguro, setSeguro] = useState(ficha.seguro);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const matriculaValida = validado || matricula.trim() !== '';

  async function guardar() {
    setError('');
    setOcupado(true);
    try {
      const datos: Parameters<typeof api.editarVehiculoOperador>[1] = {
        aireAcondicionado: aire,
        seguro,
        color: color.trim() || null,
        plazas: plazas.trim() === '' ? null : Number(plazas),
      };
      if (!validado) {
        datos.matricula = matricula.trim();
        datos.marca = marca.trim() || undefined;
        datos.carroceria = carroceria;
      }
      await api.editarVehiculoOperador(ficha.id, datos);
      alGuardado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="ficha-editar">
      {error !== '' && <p className="aviso">{error}</p>}
      {validado && (
        <p className="nota">
          El coche lo validó la central. La matrícula, la marca y el tipo ya no
          se cambian aquí; el color, las plazas y los extras, sí.
        </p>
      )}
      <div className="fila">
        <input
          value={matricula} placeholder="Matrícula" disabled={validado}
          onChange={(e) => setMatricula(e.target.value.toUpperCase())}
        />
        <input
          value={marca} placeholder="Marca" disabled={validado}
          onChange={(e) => setMarca(e.target.value)}
        />
      </div>
      <div className="fila">
        <select value={carroceria} disabled={validado} onChange={(e) => setCarroceria(e.target.value)}>
          {TIPOS_VEHICULO.map(([clave, etiqueta]) => (
            <option key={clave} value={clave}>{etiqueta}</option>
          ))}
        </select>
        <input value={color} placeholder="Color" onChange={(e) => setColor(e.target.value)} />
        <input
          value={plazas} inputMode="numeric" placeholder={`Plazas (1-${topePlazasUI(carroceria)})`} maxLength={2}
          onChange={(e) => setPlazas(e.target.value.replace(/\D/g, '').slice(0, 2))}
        />
      </div>
      <div className="fila">
        <label className="casilla">
          <input type="checkbox" checked={aire} onChange={(e) => setAire(e.target.checked)} />
          Aire acondicionado
        </label>
        <label className="casilla">
          <input type="checkbox" checked={seguro} onChange={(e) => setSeguro(e.target.checked)} />
          Seguro
        </label>
      </div>
      <div className="fila">
        <button type="button" className="principal" disabled={!matriculaValida || ocupado} onClick={guardar}>
          Guardar
        </button>
        <button type="button" className="secundario" onClick={alCancelar}>Cancelar</button>
      </div>
    </div>
  );
}

// Editar los datos del dueño del coche en su pestaña (08/10). El DIP es
// obligatorio (es su identidad); el teléfono, el nombre y el apellido también.
function EditarDueno({ propietario, alGuardado, alCancelar }: {
  propietario: PropietarioFicha;
  alGuardado: () => void;
  alCancelar: () => void;
}) {
  const [nombre, setNombre] = useState(propietario.nombre);
  const [apellido, setApellido] = useState(propietario.apellido);
  const [telefono, setTelefono] = useState(propietario.telefono);
  const [dip, setDip] = useState(propietario.dip);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const completo = nombre.trim() !== '' && apellido.trim() !== ''
    && telefono.trim() !== '' && /^\d{9}$/.test(dip.trim());

  async function guardar() {
    setError('');
    setOcupado(true);
    try {
      await api.editarPropietario(propietario.id, {
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        telefono: telefono.trim(),
        dip: dip.trim(),
      });
      alGuardado();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="ficha-editar">
      {error !== '' && <p className="aviso">{error}</p>}
      <div className="fila">
        <input value={nombre} placeholder="Nombre" onChange={(e) => setNombre(e.target.value)} />
        <input value={apellido} placeholder="Apellido" onChange={(e) => setApellido(e.target.value)} />
      </div>
      <div className="fila">
        <input value={telefono} inputMode="tel" placeholder="Teléfono (+240…)" onChange={(e) => setTelefono(e.target.value)} />
        <input
          value={dip} inputMode="numeric" placeholder="DIP (9 dígitos)" maxLength={9}
          onChange={(e) => setDip(e.target.value.replace(/\D/g, '').slice(0, 9))}
        />
      </div>
      <div className="fila">
        <button type="button" className="principal" disabled={!completo || ocupado} onClick={guardar}>
          Guardar datos del dueño
        </button>
        <button type="button" className="secundario" onClick={alCancelar}>Cancelar</button>
      </div>
    </div>
  );
}

type CarpetaFicha = 'taxista' | 'dueno' | 'vehiculo' | 'servicio';
const CARPETAS_FICHA: Array<[CarpetaFicha, string]> = [
  ['taxista', 'Taxista'], ['dueno', 'Dueño'], ['vehiculo', 'Vehículo'], ['servicio', 'Servicio'],
];

function FichaConductor({
  id, alVolver, alCambiarEstado, ocupado, alVerRecorrido, alVerFichaPropietario,
}: {
  id: number;
  alVolver: () => void;
  alCambiarEstado: (id: number, estado: string) => Promise<void>;
  ocupado: boolean;
  // Lleva el recorrido del taxista al mapa del despacho. Solo en la mesa.
  alVerRecorrido?: (id: number) => void;
  // Abre la ficha del dueño del coche (su flota entera).
  alVerFichaPropietario?: (id: number) => void;
}) {
  const [ficha, setFicha] = useState<FichaConductorOperador | null>(null);
  const [error, setError] = useState('');
  const [carpeta, setCarpeta] = useState<CarpetaFicha>('taxista');
  // Qué pestaña se está editando (o ninguna). Editar es «donde estás»: cada
  // pestaña abre su propio formulario en su sitio, no uno común arriba.
  const [editando, setEditando] = useState<CarpetaFicha | null>(null);
  const [accionesAbiertas, setAccionesAbiertas] = useState(false);

  function cargar() {
    api.fichaConductorOperador(id).then(setFicha).catch((e) => setError(e.message));
  }
  useEffect(cargar, [id]);

  if (error) return <><p className="aviso">{error}</p><button type="button" className="secundario" onClick={alVolver}>Volver</button></>;
  if (!ficha) return <p className="nota">Cargando…</p>;

  const o = ficha.ofertas;
  const prop = ficha.propietario;
  const esDuenoElConductor = prop !== null && prop.dip === ficha.dip;
  const dejarDeEditar = () => setEditando(null);
  const trasGuardar = () => { dejarDeEditar(); cargar(); };
  const insigniaEstado = (
    <span className={`insignia insignia-${ficha.estado_verificacion}`}>
      {ETIQUETA_ESTADO[ficha.estado_verificacion] ?? ficha.estado_verificacion}
    </span>
  );

  return (
    <>
      <div className="cabecera">
        <h1>
          {ficha.numero_taxi !== null && (
            <span className="numero-taxi">{ficha.numero_taxi}</span>
          )}
          {ficha.nombre}{ficha.apellido && ` ${ficha.apellido}`}
        </h1>
        <button type="button" className="secundario" onClick={alVolver}>Volver</button>
      </div>

      {/* Las acciones: un desplegable con lo que cambia el estado del taxista,
          y el salto al recorrido. Editar ya no vive aquí: cada pestaña trae su
          propio botón de editar, donde están los datos. */}
      <div className="fila ficha-acciones">
        <button
          type="button" className="secundario"
          onClick={() => setAccionesAbiertas((v) => !v)}
        >
          Acciones {accionesAbiertas ? '▾' : '▸'}
        </button>
        {alVerRecorrido !== undefined && (
          <button type="button" className="secundario" onClick={() => alVerRecorrido(ficha.id)}>
            Ver recorrido en el mapa
          </button>
        )}
      </div>
      {accionesAbiertas && (
        <div className="fila ficha-menu-acciones">
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
            {ficha.es_agente ? 'Quitar agente de campo' : 'Nombrar agente de campo'}
          </button>
          <button
            type="button" className="secundario" disabled={ocupado}
            onClick={() => api.recibirEnCualquierZona(ficha.id, !ficha.recibe_en_cualquier_zona).then(cargar)}
          >
            {ficha.recibe_en_cualquier_zona ? 'Recibir solo de su barrio' : 'Recibir de toda la isla'}
          </button>
          <ValeDeEntrada telefono={ficha.telefono} />
          <CambiarTelefono
            actual={ficha.telefono}
            alCambiar={(t) => api.cambiarTelefonoConductor(ficha.id, t).then(cargar)}
          />
        </div>
      )}

      {/* Las carpetas: cada dato donde toca, no todo en una lista larga. */}
      <div className="selector-idioma">
        {CARPETAS_FICHA.map(([clave, etiqueta]) => (
          <button
            key={clave} type="button"
            className={clave === carpeta ? 'idioma-activo' : undefined}
            onClick={() => { setCarpeta(clave); dejarDeEditar(); }}
          >
            {etiqueta}
          </button>
        ))}
      </div>

      {carpeta === 'taxista' && (
        <div className="ficha-carpeta">
          {editando === 'taxista' ? (
            <>
              <FotoTaxista id={ficha.id} tieneFoto={ficha.tiene_foto} alCambiar={cargar} />
              <EditarDatosTaxista ficha={ficha} alGuardado={trasGuardar} alCancelar={dejarDeEditar} />
            </>
          ) : (
            <>
              <TarjetaIdentidad
                foto={<FotoTaxista id={ficha.id} tieneFoto={ficha.tiene_foto} alCambiar={cargar} />}
                titulo={<>
                  {ficha.numero_taxi !== null && <span className="numero-taxi">{ficha.numero_taxi}</span>}
                  {ficha.nombre}{ficha.apellido && ` ${ficha.apellido}`}
                </>}
                insignia={insigniaEstado}
                datos={[
                  { k: 'DIP', v: ficha.dip ?? 'Sin DIP', falta: !ficha.dip },
                  { k: 'Teléfono', v: ficha.telefono },
                  { k: 'Correo', v: ficha.correo ?? 'Sin correo', falta: !ficha.correo },
                  { k: 'Presencia', v: ficha.presencia ?? 'Desconocida', falta: !ficha.presencia },
                ]}
              />
              <button type="button" className="secundario ficha-editar-boton" onClick={() => setEditando('taxista')}>
                Editar datos
              </button>
            </>
          )}
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
        </div>
      )}

      {carpeta === 'dueno' && (
        <div className="ficha-carpeta">
          {prop === null ? (
            <p className="nota">Sin dueño registrado todavía. Se añade al dar de alta el coche.</p>
          ) : editando === 'dueno' ? (
            <EditarDueno propietario={prop} alGuardado={trasGuardar} alCancelar={dejarDeEditar} />
          ) : (
            <>
              <TarjetaIdentidad
                foto={<div className="tarjeta-glifo" aria-hidden="true">{esDuenoElConductor ? '🧑‍✈️' : '👤'}</div>}
                titulo={`${prop.nombre} ${prop.apellido}`.trim()}
                insignia={esDuenoElConductor
                  ? <span className="insignia insignia-suave">Conduce</span> : undefined}
                datos={[
                  { k: 'DIP', v: prop.dip },
                  { k: 'Teléfono', v: prop.telefono },
                ]}
              />
              <p className="nota">
                {esDuenoElConductor
                  ? 'El dueño del coche es el mismo que lo conduce.'
                  : 'El dueño no conduce: no lleva foto.'}
              </p>
              <div className="fila ficha-acciones">
                <button type="button" className="secundario ficha-editar-boton" onClick={() => setEditando('dueno')}>
                  Editar datos del dueño
                </button>
                {alVerFichaPropietario !== undefined && (
                  <button type="button" className="secundario" onClick={() => alVerFichaPropietario(prop.id)}>
                    Ver la flota de este dueño →
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {carpeta === 'vehiculo' && (
        <div className="ficha-carpeta">
          {editando === 'vehiculo' ? (
            <EditarVehiculo ficha={ficha} alGuardado={trasGuardar} alCancelar={dejarDeEditar} />
          ) : (
            <>
              <TarjetaIdentidad
                foto={<div className="tarjeta-glifo" aria-hidden="true">🚕</div>}
                titulo={ficha.matricula ?? 'Sin matrícula'}
                datos={[
                  { k: 'Marca', v: ficha.marca ?? 'Sin marca', falta: !ficha.marca },
                  { k: 'Tipo', v: ficha.carroceria ? (ETIQUETA_CARROCERIA[ficha.carroceria] ?? ficha.carroceria) : 'Sin tipo', falta: !ficha.carroceria },
                  { k: 'Color', v: ficha.color ?? 'Sin color', falta: !ficha.color },
                  { k: 'Plazas', v: ficha.plazas ?? '—', falta: ficha.plazas === null },
                  {
                    k: 'Extras',
                    v: [ficha.aire_acondicionado ? 'aire' : null, ficha.seguro ? 'seguro' : null].filter(Boolean).join(' · ') || 'Ninguno',
                    falta: !ficha.aire_acondicionado && !ficha.seguro,
                  },
                ]}
              />
              <button type="button" className="secundario ficha-editar-boton" onClick={() => setEditando('vehiculo')}>
                Editar vehículo
              </button>
            </>
          )}
        </div>
      )}

      {carpeta === 'servicio' && (
        <div className="ficha-carpeta">
          <p className="nota">
            Nº de taxi: <strong>{ficha.numero_taxi ?? '—'}</strong>
            {' · '}Suscripción: <strong>{ficha.suscripcionVigente ? `hasta ${fecha(ficha.suscrito_hasta)}` : 'vencida'}</strong>
          </p>
          <p className="nota">
            Recibe: <strong>{ficha.recibe_en_cualquier_zona ? 'de toda la isla' : 'solo de su barrio'}</strong>
            {ficha.es_agente && ' · es agente de campo'}
          </p>
          {alVerRecorrido === undefined && <RecorridoConductor id={ficha.id} />}
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
        </div>
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
  const [pantallaCompleta, setPantallaCompleta] = useState(false);
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

  // Con el plano abierto a pantalla completa, la tecla de escape lo cierra: es
  // lo que hace todo el mundo con algo que ocupa la pantalla entera, y sin eso
  // hay que buscar una aspa con el pulgar.
  useEffect(() => {
    if (!pantallaCompleta) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPantallaCompleta(false);
    };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [pantallaCompleta]);

  const tramos = recorrido?.tramos ?? [];
  const salidas = recorrido?.salidas ?? [];
  const km = ((recorrido?.metros ?? 0) / 1000).toFixed(1);
  const horas = duracion(recorrido?.segundosEnServicio ?? 0);
  const alVolante = duracion(recorrido?.segundosEnMovimiento ?? 0);

  return (
    <section className="movimiento">
      <header className="movimiento-cabecera">
        <h2>Movimiento</h2>
        {/* Pestañas, no botones de acción: elegir el periodo no «hace» nada,
            solo cambia lo que se mira. Con dos botones grandes en ámbar
            parecía que uno de ellos iba a ejecutar algo. */}
        <div className="periodos" role="tablist">
          {PERIODOS.map(([clave, etiqueta]) => (
            <button
              key={clave}
              type="button"
              role="tab"
              aria-selected={periodo === clave}
              className={periodo === clave ? 'periodo-activo' : undefined}
              onClick={() => setPeriodo(clave)}
            >
              {etiqueta}
            </button>
          ))}
        </div>
      </header>

      {/* Los números SIEMPRE ocupan su sitio, aunque estén cargando: si
          aparecieran y desaparecieran, el mapa de abajo daría un salto en cada
          cambio de periodo y habría que volver a buscarlo con la vista. */}
      <div className="rejilla">
        <Dato valor={cargando ? '—' : `${km} km`} etiqueta="Recorridos" />
        <Dato valor={cargando ? '—' : horas} etiqueta="En servicio" />
        {/* «En servicio» y «al volante» son cosas distintas y hacen falta las
            dos: ocho horas de turno con una de volante es un día de espera, y
            ocho con seis es un día de trabajo. Con una sola cifra no se
            distinguen. */}
        <Dato valor={cargando ? '—' : alVolante} etiqueta="Al volante" />
        {/* Las dos medias, y en este orden. La de conducción primero porque es
            la que contesta a «¿a qué velocidad se circula?»: la otra se hunde
            con cada minuto de espera —que para un taxista es media jornada— y
            leída como velocidad engaña. Juntas dicen algo que ninguna dice
            sola: 28 al volante y 7 en servicio es un día de esperar; 28 y 24
            es un día sin parar. */}
        <Dato
          valor={cargando || recorrido?.velocidadAlVolanteKmh == null
            ? '—'
            : `${recorrido.velocidadAlVolanteKmh.toFixed(1)} km/h`}
          etiqueta="De media al volante"
        />
        <Dato
          valor={cargando || recorrido?.velocidadMediaKmh == null
            ? '—'
            : `${recorrido.velocidadMediaKmh.toFixed(1)} km/h`}
          etiqueta="Contando las esperas"
        />
      </div>

      {error && <p className="aviso">{error}</p>}
      {!cargando && !error && tramos.length === 0 && (
        <p className="nota">
          Sin recorrido en este periodo. O no entró en servicio, o su móvil no
          mandó posición — en iPhone solo la manda con la aplicación abierta.
        </p>
      )}

      {tramos.length > 0 && (
        <div className={pantallaCompleta ? 'mapa-recorrido a-pantalla' : 'mapa-recorrido'}>
          <Mapa
            puntos={[]} encuadre="recorrido" recorrido={tramos}
            maxPasadas={recorrido?.maxPasadas ?? 1}
          />
          {/* Trescientos píxeles de alto bastan para saber si anduvo por el
              centro o por Semu, y no bastan para nada más: un mes de recorrido
              son cientos de calles superpuestas. Esto lo abre a la pantalla
              entera, donde sí se distingue una calle de la de al lado. */}
          <button
            type="button"
            className="mapa-ampliar"
            onClick={() => setPantallaCompleta((abierto) => !abierto)}
            aria-label={pantallaCompleta ? 'Cerrar el plano' : 'Ver el plano a pantalla completa'}
          >
            {pantallaCompleta ? '✕' : '⤢'}
          </button>
          {/* La leyenda va ENCIMA del plano y en pequeño, no en tres párrafos
              debajo: ahí competía con los números y empujaba el mapa fuera de
              la pantalla en un móvil. */}
          <div className="mapa-leyenda">
            <span><i style={{ background: '#7ee081' }} />empieza</span>
            <span><i style={{ background: '#ff6b6b' }} />acaba</span>
            {(recorrido?.maxPasadas ?? 1) > 1 && (
              <span className="leyenda-calor">
                <i style={{ background: colorDeCalor(1, recorrido!.maxPasadas) }} />1
                <i style={{ background: colorDeCalor(
                  Math.ceil(recorrido!.maxPasadas / 2), recorrido!.maxPasadas,
                ) }} />
                <i style={{ background: colorDeCalor(recorrido!.maxPasadas, recorrido!.maxPasadas) }} />
                {recorrido!.maxPasadas} veces por el mismo sitio
              </span>
            )}
          </div>
        </div>
      )}

      {/* El mismo recorrido, leído en vez de mirado. Las dos mitades de la
          misma pregunta: el dibujo dice POR DÓNDE anduvo y no dice a qué hora,
          y con una queja del tipo «a las once y media no apareció» el dibujo no
          sirve de nada. Aquí cada fila es una salida —un trozo continuo de
          rastro, que es lo que separa dos tramos— con su hora, su duración y
          sus kilómetros.

          Las paradas se marcan en vez de esconderse: estuvo ahí y no se movió,
          que para un taxista es media jornada y es lo que explica un turno de
          ocho horas con cuarenta kilómetros. */}
      {salidas.length > 0 && (
        <>
          <h3 className="tabla-titulo">
            Salidas del periodo ({salidas.length})
          </h3>
          <Tabla cabeceras={['Empieza', 'Acaba', 'Duración', 'Km', '']}>
            {salidas.map((t) => (
              <tr key={t.desde} className={t.parado ? 'tabla-tenue' : undefined}>
                <td>{soloHora(t.desde)}</td>
                <td>{soloHora(t.hasta)}</td>
                <td className="tabla-numero">{duracion(t.segundos)}</td>
                <td className="tabla-numero">
                  {t.metros < 100 ? '—' : (t.metros / 1000).toFixed(1)}
                </td>
                <td className="tabla-tenue">{t.parado ? 'parado' : ''}</td>
              </tr>
            ))}
          </Tabla>
        </>
      )}
    </section>
  );
}

// La ficha del pasajero, en carpetas como la del taxista. Un pasajero tiene
// menos que un taxista —ni coche, ni dueño, ni servicio— así que son dos: sus
// datos con el resumen de su actividad, y sus viajes. Las acciones van juntas
// en un desplegable, igual que en la del taxista.
type CarpetaPasajero = 'pasajero' | 'viajes';
const CARPETAS_PASAJERO: Array<[CarpetaPasajero, string]> = [
  ['pasajero', 'Pasajero'], ['viajes', 'Viajes'],
];

function FichaPasajero({
  dispositivoId, alVolver,
}: {
  dispositivoId: number;
  alVolver: () => void;
}) {
  const [ficha, setFicha] = useState<FichaPasajeroOperador | null>(null);
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [carpeta, setCarpeta] = useState<CarpetaPasajero>('pasajero');
  const [accionesAbiertas, setAccionesAbiertas] = useState(false);

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

      {/* Las acciones, todas juntas en un desplegable. */}
      <div className="fila ficha-acciones">
        <button
          type="button" className="secundario"
          onClick={() => setAccionesAbiertas((v) => !v)}
        >
          Acciones {accionesAbiertas ? '▾' : '▸'}
        </button>
      </div>
      {accionesAbiertas && (
        <div className="fila ficha-menu-acciones">
          {(ficha.strikes > 0 || ficha.bloqueado_en) && (
            <button type="button" className="principal" disabled={ocupado} onClick={desbloquear}>
              Perdonar strikes y desbloquear
            </button>
          )}
          {/* Papel de campo para un pasajero (migración 072): sitúa barrios,
              corrige sitios y aprueba los que propone la gente. No toca dinero,
              ni verificaciones, ni incidencias — lo mismo que un taxista
              agente. Se quita igual de fácil, y lo que toque queda apuntado
              (migración 067). */}
          <button
            type="button"
            className="secundario"
            disabled={ocupado}
            onClick={async () => {
              setOcupado(true);
              try {
                await api.nombrarAgentePasajero(dispositivoId, !ficha.es_agente);
                cargar();
              } catch (e) {
                setError(e instanceof Error ? e.message : 'No se pudo cambiar el papel.');
              } finally {
                setOcupado(false);
              }
            }}
          >
            {ficha.es_agente ? 'Quitar el papel de agente de campo' : 'Nombrar agente de campo'}
          </button>
          <ValeDeEntrada telefono={ficha.telefono} />
          <CambiarTelefono
            actual={ficha.telefono}
            alCambiar={(t) => api.cambiarTelefonoPasajero(dispositivoId, t).then(cargar)}
          />
        </div>
      )}

      {/* Las carpetas: cada dato donde toca, no todo en una lista larga. */}
      <div className="selector-idioma">
        {CARPETAS_PASAJERO.map(([clave, etiqueta]) => (
          <button
            key={clave} type="button"
            className={clave === carpeta ? 'idioma-activo' : undefined}
            onClick={() => setCarpeta(clave)}
          >
            {etiqueta}
          </button>
        ))}
      </div>

      {carpeta === 'pasajero' && (
        <div className="ficha-carpeta">
          <p className="nota">
            {ficha.telefono ?? 'sin teléfono'}{ficha.correo && ` · ${ficha.correo}`}
            {ficha.edad !== null && ` · ${ficha.edad} años`}
            {ficha.genero && ` · ${ficha.genero}`}
          </p>
          <p className="nota">
            En la plataforma desde {fecha(ficha.creado_en)}
            {ficha.es_agente && ' · es agente de campo'}
          </p>
          {ficha.bloqueado_en && (
            <p className="aviso">Bloqueado desde {fecha(ficha.bloqueado_en)} por incidencias repetidas.</p>
          )}
          <div className="rejilla">
            <Dato valor={ficha.viajes.completados} etiqueta="Viajes completados" />
            <Dato valor={ficha.viajes.pedidos} etiqueta="Veces que pidió" />
            <Dato valor={ficha.viajes.cancelados} etiqueta="Cancelados por él" />
            <Dato valor={ficha.viajes.ausencias} etiqueta="No se presentó" />
            <Dato valor={`${ficha.strikes}`} etiqueta="Strikes" />
          </div>
        </div>
      )}

      {carpeta === 'viajes' && (
        <div className="ficha-carpeta">
          <p className="nota">Últimos viajes</p>
          <ListaViajes viajes={ficha.ultimosViajes} />
        </div>
      )}
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
  // Colocarlo con el dedo: se mueve el plano bajo una cruz quieta y se pulsa
  // «ponerlo aquí». Lo de debajo de la cruz se guarda en una REFERENCIA y no en
  // el estado: si no, cada píxel de arrastre repintaría el plano entero y el
  // gesto iría a tirones en un teléfono de gama baja.
  const [conElDedo, setConElDedo] = useState(false);
  const bajoLaCruz = useRef<{ lat: number; lng: number } | null>(null);
  const alMoverCentro = useCallback((la: number, ln: number) => {
    bajoLaCruz.current = { lat: la, lng: ln };
  }, []);

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
      {/* Colocar un sitio sin estar delante. Hasta ahora había dos caminos: ir
          allí y coger el GPS, o teclear la latitud y la longitud a mano —que es
          pedirle a alguien que sepa que 3,7531 está al norte de 3,7520—. Esto
          es el tercero y el que se usa en la calle: mover el plano bajo la cruz
          y pulsar. */}
      <button
        type="button"
        className={conElDedo ? 'principal' : 'secundario'}
        disabled={ocupado}
        onClick={() => setConElDedo((abierto) => !abierto)}
      >
        {conElDedo ? 'Dejar de colocarlo' : 'Colocarlo con el dedo'}
      </button>
      {conElDedo && (
        <>
          <div className="mapa-colocar">
            <Mapa
              puntos={[]}
              origen={{ lat: Number(lat), lng: Number(lng), nombre: referencia.nombre }}
              encuadre="persona"
              mira
              alMoverCentro={alMoverCentro}
            />
          </div>
          <p className="nota">
            Mueve el plano hasta que la cruz quede encima del sitio. El punto
            ámbar es dónde está puesto ahora.
          </p>
          <button
            type="button" className="principal" disabled={ocupado}
            onClick={() => {
              const donde = bajoLaCruz.current;
              if (!donde) return;
              // Solo rellena las casillas; guardar sigue siendo un acto
              // aparte. Mover un sitio del catálogo cambia a dónde van los
              // taxis, y no puede pasar por rozar el plano sin querer.
              setLat(donde.lat.toFixed(6));
              setLng(donde.lng.toFixed(6));
              setConElDedo(false);
            }}
          >
            Ponerlo aquí
          </button>
        </>
      )}
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
  // Sitios que YA se llaman así. Se buscan mientras se escribe, antes de
  // pulsar nada: enterarse de que el sitio ya existía DESPUÉS de crearlo es
  // enterarse tarde, y además el nombre repetido en la misma zona no creaba
  // nada — le cambiaba las coordenadas al que ya estaba.
  const [parecidos, setParecidos] = useState<ReferenciaOperador[]>([]);
  // El que va a quedar pisado si se sigue adelante, tal como lo devuelve el
  // servidor al contestar 409.
  const [choque, setChoque] = useState<{ id: number; nombre: string; zona: string } | null>(null);

  useEffect(() => {
    const nombre = nueva.nombre.trim();
    if (nombre.length < 3) { setParecidos([]); return; }
    // Con freno: se escribe letra a letra y cada letra sería una consulta
    // contra una tabla de dieciséis mil sitios.
    const reloj = setTimeout(() => {
      api.referenciasOperador(nombre)
        .then((r) => setParecidos(r.referencias.slice(0, 5)))
        .catch(() => setParecidos([]));
    }, 350);
    return () => clearTimeout(reloj);
  }, [nueva.nombre]);

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

  async function crear(sustituir = false) {
    setError('');
    try {
      await api.crearReferenciaOperador({
        zonaId: nueva.zonaId,
        nombre: nueva.nombre.trim(),
        lat: Number(nueva.lat),
        lng: Number(nueva.lng),
        categoria: nueva.categoria.trim() || undefined,
        precision: precisionNueva ?? undefined,
        ...(sustituir ? { sustituir: true } : {}),
      });
      setCreando(false);
      setChoque(null);
      setNueva((n) => ({ ...n, nombre: '', categoria: '', lat: '', lng: '' }));
      setPrecisionNueva(null);
      cargar();
    } catch (e) {
      // 409 con cuerpo: el servidor dice CUÁL es el sitio que ya hay, y
      // entonces esto no es un error sino una pregunta.
      if (e instanceof ErrorDelServidor && e.estado === 409) {
        const existente = (e.datos as { existente?: { id: number; nombre: string; zona: string } })
          ?.existente;
        if (existente) { setChoque(existente); return; }
      }
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
          {/* Lo que ya se llama así, mientras se escribe. Antes de pulsar nada:
              enterarse después de crearlo es enterarse tarde. */}
          {parecidos.length > 0 && choque === null && (
            <>
              <p className="nota">
                Ya hay {parecidos.length === 1 ? 'un sitio' : `${parecidos.length} sitios`} con
                ese nombre. Mira si es alguno de éstos antes de crear otro:
              </p>
              {parecidos.map((p) => (
                <button
                  key={p.id} type="button" className="oferta oferta-boton"
                  onClick={() => { setCreando(false); setBusqueda(p.nombre); }}
                >
                  <span className="oferta-ruta">{p.nombre}{!p.activa && ' · DESACTIVADO'}</span>
                  <span className="nota">
                    {p.zona} · {p.categoria} · {p.usos} uso{p.usos === 1 ? '' : 's'}
                    {p.zona_id === nueva.zonaId && ' · EN LA MISMA ZONA que vas a crear'}
                  </span>
                </button>
              ))}
            </>
          )}

          {/* El choque de verdad: mismo nombre y misma zona. Aquí no se avisa,
              se pregunta — y se dice exactamente qué pasa si dice que sí,
              porque «sustituir» suena a reemplazar la ficha y lo que hace es
              mover el sitio que ya existe. */}
          {choque !== null && (
            <>
              <p className="aviso">
                «{choque.nombre}» ya existe en {choque.zona}. Si sigues, NO se crea
                otro: se le cambian las coordenadas al que ya está, y todos los
                taxis empezarán a ir al sitio nuevo.
              </p>
              <div className="fila">
                <button type="button" className="principal" onClick={() => void crear(true)}>
                  Sí, moverlo ahí
                </button>
                <button
                  type="button" className="secundario"
                  onClick={() => { setChoque(null); setCreando(false); setBusqueda(choque.nombre); }}
                >
                  Mejor abrirlo
                </button>
                <button type="button" className="secundario" onClick={() => setChoque(null)}>
                  Cambiar el nombre
                </button>
              </div>
            </>
          )}

          {choque === null && (
            <button
              type="button" className="principal" disabled={!nuevaLista}
              onClick={() => void crear()}
            >
              Crear el sitio
            </button>
          )}
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

// --- Las tres tablas del operador (03/10) -----------------------------------
//
// Tres registros que ya existían y se leían mal: el de cambios escondido tras
// un botón dentro de Ajustes, el recorrido solo como dibujo, y las carreras sin
// ninguna lista que no fuera la de la propia central. Lo que tienen en común es
// que son REGISTROS: filas que se recorren con la vista comparando columnas, y
// eso una tarjeta apilada no lo deja hacer — hay que leer cada una entera para
// saber si te interesa.
//
// Mismo armazón para las tres: `<table className="tabla">`. Con scroll propio,
// porque cualquiera de ellas puede traer doscientas filas y no puede empujar la
// página entera.

function Tabla({ cabeceras, children }: { cabeceras: string[]; children: React.ReactNode }) {
  return (
    <div className="tabla-marco">
      <table className="tabla">
        <thead>
          <tr>{cabeceras.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

// Fecha y hora cortas. Sin el año: en un registro que se mira para saber qué
// pasó esta semana, «2026» en cada fila es ruido que empuja lo que importa.
function cuando(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')} `
    + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function soloHora(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// El registro de quién tocó los precios y los parámetros (migración 067).
// Inmutable por diseño: no hay nada que pulsar, solo que leer.
// Eran dos —parámetros y bandas— y daba igual escribirlo con un condicional.
// Desde que se pueden cambiar teléfonos son cuatro, y aquel condicional
// enseñaba «banda» en todo lo que no fuera un parámetro: un registro que miente
// es peor que no tenerlo.
const ETIQUETA_AMBITO: Record<string, string> = {
  parametro: 'parámetro',
  banda: 'banda',
  conductor: 'taxista',
  pasajero: 'pasajero',
};

function Cambios() {
  const [cambios, setCambios] = useState<CambioOperador[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.cambiosOperador()
      .then((r) => setCambios(r.cambios))
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar.'));
  }, []);

  return (
    <>
      <p className="nota">
        Últimos cambios de precios y parámetros. No se puede editar ni borrar:
        un registro que se puede tocar no sirve de registro.
      </p>
      {error && <p className="aviso">{error}</p>}
      {cambios?.length === 0 && <p className="nota">Nadie ha tocado nada todavía.</p>}
      {cambios !== null && cambios.length > 0 && (
        <Tabla cabeceras={['Cuándo', 'Ámbito', 'Clave', 'Antes', 'Ahora', 'Quién']}>
          {cambios.map((c) => (
            <tr key={c.id}>
              <td className="tabla-tenue">{cuando(c.cuando)}</td>
              <td>{ETIQUETA_AMBITO[c.ambito] ?? c.ambito}</td>
              <td className="tabla-clave">{c.clave}</td>
              <td className="tabla-tenue">{c.antes ?? '—'}</td>
              <td>{c.ahora ?? 'borrada'}</td>
              <td>{c.quien}</td>
            </tr>
          ))}
        </Tabla>
      )}
    </>
  );
}

// Todas las carreras. Es el registro que no existía: la lista de la Central
// solo enseña las que nacieron de una llamada al operador.
const ESTADOS_VIAJE = [
  'todos', 'SOLICITADO', 'EMITIDO', 'ACEPTADO', 'EN_CAMINO', 'RECOGIDO',
  'COMPLETADO', 'SIN_OFERTA', 'CANCELADO_CLIENTE', 'CANCELADO_CONDUCTOR',
  'CLIENTE_AUSENTE', 'NO_PRESENTADO', 'INCIDENCIA',
] as const;

function Viajes({ alVerEnMapa, alVerFichaConductor, alVerFichaPasajero }: {
  alVerEnMapa?: (viaje: ViajeOperador) => void;
  alVerFichaConductor?: (id: number) => void;
  alVerFichaPasajero?: (dispositivoId: number) => void;
}) {
  const [viajes, setViajes] = useState<ViajeOperador[] | null>(null);
  const [estado, setEstado] = useState<string>('todos');
  const [busqueda, setBusqueda] = useState('');
  const [error, setError] = useState('');
  // Las filas desplegadas. Varias a la vez a propósito: comparar dos carreras
  // es exactamente abrir las dos.
  const [abiertos, setAbiertos] = useState<Set<number>>(new Set());

  function alternar(id: number) {
    setAbiertos((antes) => {
      const ahora = new Set(antes);
      if (ahora.has(id)) ahora.delete(id);
      else ahora.add(id);
      return ahora;
    });
  }

  useEffect(() => {
    setViajes(null);
    api.viajesOperador(estado === 'todos' ? undefined : estado, busqueda || undefined)
      .then((r) => setViajes(r.viajes))
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar.'));
  }, [estado, busqueda]);

  return (
    <>
      <Buscador alBuscar={setBusqueda} />
      <div className="selector-idioma">
        {ESTADOS_VIAJE.map((e) => (
          <button
            key={e} type="button"
            className={e === estado ? 'idioma-activo' : undefined}
            onClick={() => setEstado(e)}
          >
            {e === 'todos' ? 'Todos' : e.toLowerCase().replace(/_/g, ' ')}
          </button>
        ))}
      </div>
      {error && <p className="aviso">{error}</p>}
      {alVerEnMapa !== undefined && viajes !== null && viajes.length > 0 && (
        <p className="nota">Pulsa una carrera para verla en el mapa; «detalles» para el teléfono y el precio.</p>
      )}
      {viajes?.length === 0 && <p className="nota">Ninguna carrera con ese filtro.</p>}
      {/* Cuatro columnas arriba y el resto DENTRO (06/10, pedido con estas
          palabras): la tabla se recorre comparando horas y rutas, y ocho
          columnas obligaban a leer en diagonal. Lo que se consulta de una
          carrera concreta —teléfono, zonas, precio— sale al desplegarla. */}
      {viajes !== null && viajes.length > 0 && (
        <Tabla cabeceras={['Cuándo', 'Emitido', 'Origen → Destino', 'Taxi', '']}>
          {viajes.map((v) => (
            <Fragment key={v.id}>
              {/* La fila entera lleva la carrera al mapa del despacho (pedido
                  el 08/10). El teléfono y el precio, que no se comparan de un
                  vistazo, salen con «detalles», sin salir del listado. Fuera
                  de la consola —sin mapa— la fila despliega los detalles. */}
              <tr
                className="tabla-desplegable"
                onClick={() => (alVerEnMapa ? alVerEnMapa(v) : alternar(v.id))}
              >
                <td className="tabla-tenue">{cuando(v.creada_en)}</td>
                {/* Solo la hora: el día ya lo dice «Cuándo», y una carrera no
                    cruza la medianoche en una isla de veinte minutos. */}
                <td className="tabla-tenue">{v.emitido_en === null ? '—' : soloHora(v.emitido_en)}</td>
                <td>{v.origen} → {v.destino}</td>
                <td>{v.matricula ?? v.conductor ?? '—'}</td>
                <td className="tabla-tenue">
                  <button
                    type="button" className="tabla-enlace"
                    onClick={(e) => { e.stopPropagation(); alternar(v.id); }}
                  >
                    {abiertos.has(v.id) ? 'detalles ▾' : 'detalles ▸'}
                  </button>
                </td>
              </tr>
              {abiertos.has(v.id) && (
                <tr className="tabla-detalle">
                  <td colSpan={5}>
                    <div className="tabla-detalle-datos">
                      <span><b>Estado</b> {v.estado.toLowerCase().replace(/_/g, ' ')}</span>
                      <span><b>Teléfono</b> {v.telefono_cliente ?? '—'}</span>
                      <span>
                        <b>Recogida</b> {v.zona_recogida}
                        {v.recogido_en !== null && ` · ${soloHora(v.recogido_en)}`}
                      </span>
                      <span>
                        <b>Bajada</b> {v.zona_bajada}
                        {v.bajada_en !== null && ` · ${soloHora(v.bajada_en)}`}
                      </span>
                      <span>
                        <b>Precio</b>{' '}
                        {v.precio_xaf === null ? '—' : `${v.precio_xaf.toLocaleString('es')} XAF`}
                      </span>
                      {/* Enlaces a las fichas de quienes hicieron la carrera. */}
                      {alVerFichaConductor !== undefined && v.conductor_id !== null && (
                        <button
                          type="button" className="tabla-enlace"
                          onClick={(e) => { e.stopPropagation(); alVerFichaConductor(v.conductor_id!); }}
                        >
                          Ficha del taxista →
                        </button>
                      )}
                      {alVerFichaPasajero !== undefined && v.dispositivo_id !== null && (
                        <button
                          type="button" className="tabla-enlace"
                          onClick={(e) => { e.stopPropagation(); alVerFichaPasajero(v.dispositivo_id!); }}
                        >
                          Ficha del cliente →
                        </button>
                      )}
                      {alVerEnMapa !== undefined && (
                        <button
                          type="button" className="secundario"
                          onClick={(e) => { e.stopPropagation(); alVerEnMapa(v); }}
                        >
                          Ver en el mapa
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </Tabla>
      )}
    </>
  );
}

// Los taxis que hay en cada zona AHORA, con nombre y apellido. El resumen de
// salud ya decía «Ela Nguema · 4 taxis (2 libres)», que sirve para saber dónde
// falta cobertura y no sirve para nada más: no se puede llamar a «4 taxis». Al
// abrir una zona salen los de dentro, que es lo que hace falta para mandar a
// uno concreto a recoger a alguien.
function TaxisPorZona() {
  const [taxis, setTaxis] = useState<TaxiVivo[] | null>(null);
  const [abierta, setAbierta] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const cargar = () => {
      api.vivoOperador()
        .then((r) => setTaxis(r.taxis))
        .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar.'));
    };
    cargar();
    const reloj = setInterval(cargar, 10000);
    return () => clearInterval(reloj);
  }, []);

  // Agrupadas aquí y no en el servidor: los taxis ya vienen con su zona para el
  // mapa, y pedir lo mismo otra vez agrupado sería una consulta más diciendo lo
  // que ya se sabe.
  const porZona = new Map<string, TaxiVivo[]>();
  for (const t of taxis ?? []) {
    const zona = t.zona ?? 'Sin zona';
    const lista = porZona.get(zona);
    if (lista) lista.push(t); else porZona.set(zona, [t]);
  }
  const zonas = [...porZona.entries()].sort((a, b) => b[1].length - a[1].length);

  if (error) return <p className="aviso">{error}</p>;
  if (taxis === null) return <p className="nota">…</p>;
  if (zonas.length === 0) return <p className="nota">Ningún taxi en servicio ahora mismo.</p>;

  if (abierta !== null) {
    const dentro = porZona.get(abierta) ?? [];
    return (
      <>
        <button type="button" className="secundario" onClick={() => setAbierta(null)}>
          ← Todas las zonas
        </button>
        <h3 className="tabla-titulo">{abierta} · {dentro.length}</h3>
        <Tabla cabeceras={['Taxi', 'Matrícula', 'Estado', 'Visto hace']}>
          {dentro.map((t) => (
            <tr key={t.conductor_id}>
              <td>{t.nombre}</td>
              <td className="tabla-clave">{t.matricula ?? '—'}</td>
              <td className={t.estado === 'DISPONIBLE' ? undefined : 'tabla-tenue'}>
                {t.estado.toLowerCase()}
              </td>
              <td className="tabla-numero tabla-tenue">
                {t.latido_hace_seg === null ? '—' : hace(t.latido_hace_seg)}
              </td>
            </tr>
          ))}
        </Tabla>
      </>
    );
  }

  return (
    <>
      <p className="nota">
        Dónde está la flota ahora mismo. Al abrir una zona salen los taxis que
        hay dentro, con su matrícula.
      </p>
      <Tabla cabeceras={['Zona', 'Taxis', 'Libres', '']}>
        {zonas.map(([zona, lista]) => (
          <tr key={zona}>
            <td>{zona}</td>
            <td className="tabla-numero">{lista.length}</td>
            <td className="tabla-numero">
              {lista.filter((t) => t.estado === 'DISPONIBLE').length}
            </td>
            <td>
              <button type="button" className="tabla-enlace" onClick={() => setAbierta(zona)}>
                ver los {lista.length}
              </button>
            </td>
          </tr>
        ))}
      </Tabla>
    </>
  );
}

// El único sitio donde están los registros. Se elige cuál y se lee; no hay
// nada que pulsar dentro de ninguno, que es lo que los hace registros.
const TIPOS_REGISTRO = [
  ['carreras', 'Carreras'],
  ['vehiculos', 'Vehículos'],
  ['propietarios', 'Propietarios'],
  ['flota', 'Taxis por zona'],
  ['cambios', 'Quién tocó qué'],
] as const;

// El registro de todos los vehículos (migración 087): el coche, de quién es y
// quién lo conduce, en una tabla que se recorre comparando.
function RegistroVehiculos({ alVerFichaConductor }: {
  alVerFichaConductor?: (id: number) => void;
}) {
  const [lista, setLista] = useState<VehiculoRegistro[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.vehiculosOperador().then((r) => setLista(r.vehiculos))
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar.'));
  }, []);
  if (error) return <p className="aviso">{error}</p>;
  if (lista === null) return <p className="nota">Cargando…</p>;
  if (lista.length === 0) return <p className="nota">Ningún vehículo todavía.</p>;
  return (
    <Tabla cabeceras={['Nº', 'Matrícula', 'Tipo', 'Marca', 'Conductor', 'Dueño', 'Extras']}>
      {lista.map((v) => (
        <tr key={v.matricula}>
          <td className="tabla-clave">{v.numero_taxi ?? '—'}</td>
          <td className="tabla-clave">{v.matricula}</td>
          <td>{v.carroceria ? (ETIQUETA_CARROCERIA[v.carroceria] ?? v.carroceria) : '—'}</td>
          <td>{v.marca ?? '—'}{v.color ? ` · ${v.color}` : ''}</td>
          <td>
            {/* El taxista enlaza con su ficha (08/10): desde el coche se llega
                a quién lo conduce sin ir a buscarlo a Gente. */}
            {alVerFichaConductor !== undefined ? (
              <button type="button" className="tabla-enlace" onClick={() => alVerFichaConductor(v.conductor_id)}>
                {v.conductor}{v.conductor_apellido ? ` ${v.conductor_apellido}` : ''}
              </button>
            ) : (
              <>{v.conductor}{v.conductor_apellido ? ` ${v.conductor_apellido}` : ''}</>
            )}
            <span className="tabla-tenue"> · {v.conductor_telefono}</span>
          </td>
          <td>{v.dueno === null ? '—' : `${v.dueno} ${v.dueno_apellido ?? ''}`.trim()}</td>
          <td className="tabla-tenue">
            {[v.aire_acondicionado ? 'aire' : null, v.seguro ? 'seguro' : null,
              v.plazas ? `${v.plazas} pl.` : null].filter(Boolean).join(' · ') || '—'}
          </td>
        </tr>
      ))}
    </Tabla>
  );
}

// El registro de propietarios (migración 087): cada dueño con su flota.
function RegistroPropietarios({ alAbrir }: { alAbrir?: (id: number) => void }) {
  const [lista, setLista] = useState<PropietarioRegistro[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.propietariosOperador().then((r) => setLista(r.propietarios))
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar.'));
  }, []);
  if (error) return <p className="aviso">{error}</p>;
  if (lista === null) return <p className="nota">Cargando…</p>;
  if (lista.length === 0) return <p className="nota">Ningún propietario todavía.</p>;
  return (
    <>
      {alAbrir !== undefined && (
        <p className="nota">Pulsa un dueño para ver toda su flota y sus taxistas.</p>
      )}
      <Tabla cabeceras={['Nombre', 'Teléfono', 'DIP', 'Coches', 'Matrículas']}>
        {lista.map((p) => (
          <tr
            key={p.id}
            className={alAbrir !== undefined ? 'tabla-desplegable' : undefined}
            onClick={alAbrir !== undefined ? () => alAbrir(p.id) : undefined}
          >
            <td>{p.nombre} {p.apellido}</td>
            <td className="tabla-tenue">{p.telefono}</td>
            <td className="tabla-clave">{p.dip}</td>
            <td className="tabla-numero">{p.coches}</td>
            <td className="tabla-tenue">{p.matriculas.join(', ') || '—'}</td>
          </tr>
        ))}
      </Tabla>
    </>
  );
}

// La ficha del propietario (09/10): sus datos y TODA su flota, cada coche con
// el taxista que lo conduce. Es «entrar por el dueño»: por el conductor solo se
// ve un coche; aquí se ven todos, y cada taxista enlaza con su ficha.
function FichaPropietario({ id, alVolver, alVerFichaConductor }: {
  id: number;
  alVolver: () => void;
  alVerFichaConductor?: (id: number) => void;
}) {
  const [ficha, setFicha] = useState<FichaPropietarioOperador | null>(null);
  const [error, setError] = useState('');
  const [anadiendo, setAnadiendo] = useState(false);
  function cargar() {
    api.fichaPropietarioOperador(id).then(setFicha).catch((e) => setError(e.message));
  }
  useEffect(cargar, [id]);
  if (error) return <><p className="aviso">{error}</p><button type="button" className="secundario" onClick={alVolver}>Volver</button></>;
  if (!ficha) return <p className="nota">Cargando…</p>;
  const p = ficha.propietario;
  return (
    <>
      <div className="cabecera">
        <h1>{p.nombre} {p.apellido}</h1>
        <button type="button" className="secundario" onClick={alVolver}>Volver</button>
      </div>
      <TarjetaIdentidad
        foto={<div className="tarjeta-glifo" aria-hidden="true">👤</div>}
        titulo={`${p.nombre} ${p.apellido}`.trim()}
        datos={[
          { k: 'DIP', v: p.dip },
          { k: 'Teléfono', v: p.telefono },
          { k: 'Coches', v: ficha.vehiculos.length },
        ]}
      />
      <p className="nota">Su flota ({ficha.vehiculos.length})</p>
      {ficha.vehiculos.length === 0 ? (
        <p className="nota">No tiene coches registrados ahora mismo.</p>
      ) : (
        <Tabla cabeceras={['Nº', 'Matrícula', 'Tipo', 'Conductor', 'Estado']}>
          {ficha.vehiculos.map((v) => (
            <tr key={v.matricula}>
              <td className="tabla-clave">{v.numero_taxi ?? '—'}</td>
              <td className="tabla-clave">{v.matricula}</td>
              <td>
                {v.carroceria ? (ETIQUETA_CARROCERIA[v.carroceria] ?? v.carroceria) : '—'}
                {v.plazas ? ` · ${v.plazas} pl.` : ''}
              </td>
              <td>
                {alVerFichaConductor !== undefined ? (
                  <button type="button" className="tabla-enlace" onClick={() => alVerFichaConductor(v.conductor_id)}>
                    {v.conductor}{v.conductor_apellido ? ` ${v.conductor_apellido}` : ''}
                  </button>
                ) : (
                  <>{v.conductor}{v.conductor_apellido ? ` ${v.conductor_apellido}` : ''}</>
                )}
              </td>
              <td className="tabla-tenue">{ETIQUETA_ESTADO[v.estado_verificacion] ?? v.estado_verificacion}</td>
            </tr>
          ))}
        </Tabla>
      )}
      {/* Ampliar la flota: otro coche de este mismo dueño, con otro taxista.
          El dueño ya va fijado, así que el alta no vuelve a preguntarlo. */}
      {anadiendo ? (
        <AltaDeTaxista
          abiertaInicial
          duenoFijado={{ id: p.id, nombre: p.nombre, apellido: p.apellido }}
          alCreada={() => { setAnadiendo(false); cargar(); }}
          alCerrar={() => setAnadiendo(false)}
        />
      ) : (
        <button type="button" className="principal ficha-editar-boton" onClick={() => setAnadiendo(true)}>
          ➕ Añadir otro coche a este dueño
        </button>
      )}
    </>
  );
}

function Registros({
  alVerViaje, alVerFichaConductor, alVerFichaPasajero, alVerFichaPropietario,
}: {
  alVerViaje?: (viaje: ViajeOperador) => void;
  alVerFichaConductor?: (id: number) => void;
  alVerFichaPasajero?: (dispositivoId: number) => void;
  alVerFichaPropietario?: (id: number) => void;
}) {
  const [tipo, setTipo] = useState<(typeof TIPOS_REGISTRO)[number][0]>('carreras');
  return (
    <>
      <div className="selector-idioma">
        {TIPOS_REGISTRO.map(([id, etiqueta]) => (
          <button
            key={id} type="button"
            className={id === tipo ? 'idioma-activo' : undefined}
            onClick={() => setTipo(id)}
          >
            {etiqueta}
          </button>
        ))}
      </div>
      {tipo === 'carreras' && (
        <Viajes
          alVerEnMapa={alVerViaje}
          alVerFichaConductor={alVerFichaConductor}
          alVerFichaPasajero={alVerFichaPasajero}
        />
      )}
      {tipo === 'vehiculos' && <RegistroVehiculos alVerFichaConductor={alVerFichaConductor} />}
      {tipo === 'propietarios' && <RegistroPropietarios alAbrir={alVerFichaPropietario} />}
      {tipo === 'flota' && <TaxisPorZona />}
      {tipo === 'cambios' && <Cambios />}
    </>
  );
}

// Quién puede entrar al panel (migración 080). La lista la ve cualquier
// operador —saber con quién trabajas no es un secreto— y solo la toca la raíz.
//
// SE ENSEÑA EL TELÉFONO ENTERO, a propósito. Es el dato con el que se da y se
// quita el acceso: taparlo a medias dejaría a quien mira sin poder comprobar
// que el número que va a echar es el que cree.
function Accesos() {
  const [lista, setLista] = useState<AccesoOperador[] | null>(null);
  const [raiz, setRaiz] = useState(false);
  const [yo, setYo] = useState<string | null>(null);
  const [telefono, setTelefono] = useState('');
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [ocupado, setOcupado] = useState(false);
  // A quién se está a punto de echar. Quitar un acceso no se deshace —la
  // persona se queda fuera hasta que alguien se lo devuelva— así que va con una
  // pregunta de por medio y no con un solo toque.
  const [quitando, setQuitando] = useState<string | null>(null);
  // De quién se están mirando los aparatos, y cuáles.
  const [abierto, setAbierto] = useState<string | null>(null);
  const [aparatos, setAparatos] = useState<AparatoOperador[] | null>(null);

  const cargar = useCallback(() => {
    api.accesosOperador()
      .then((r) => {
        setLista(r.operadores);
        setRaiz(r.yo?.raiz ?? false);
        setYo(r.yo?.telefono ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar.'));
  }, []);
  useEffect(cargar, [cargar]);

  const cargarAparatos = useCallback((tel: string) => {
    setAparatos(null);
    api.aparatosOperador(tel)
      .then((r) => setAparatos(r.aparatos))
      .catch((e) => setError(e instanceof Error ? e.message : 'No se pudo cargar.'));
  }, []);

  function verAparatos(tel: string) {
    if (abierto === tel) { setAbierto(null); return; }
    setAbierto(tel);
    cargarAparatos(tel);
  }

  async function dar() {
    const tel = telefono.trim();
    setError(''); setAviso(''); setOcupado(true);
    try {
      const r = await api.darAccesoOperador(tel, nombre.trim() || undefined);
      setAviso(r.yaEstaba
        ? `El ${tel} ya tenía acceso; no he cambiado nada.`
        : `Listo. El ${tel} ya puede entrar con su teléfono.`);
      setTelefono(''); setNombre('');
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo dar el acceso.');
    } finally {
      setOcupado(false);
    }
  }

  async function quitar(tel: string) {
    setError(''); setAviso(''); setOcupado(true);
    try {
      await api.quitarAccesoOperador(tel);
      setAviso(`El ${tel} ya no entra, y sus aparatos tampoco.`);
      setQuitando(null);
      if (abierto === tel) setAbierto(null);
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo quitar el acceso.');
    } finally {
      setOcupado(false);
    }
  }

  async function echarAparato(uuid: string) {
    setError(''); setAviso(''); setOcupado(true);
    try {
      await api.quitarAparatoOperador(uuid);
      setAviso('Ese aparato tendrá que volver a pedir el código para entrar.');
      if (abierto !== null) cargarAparatos(abierto);
      cargar();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo echar el aparato.');
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      <h3>Quién entra al panel</h3>
      <p className="nota">
        Se entra con el teléfono y un código por SMS. Hacen falta las dos cosas:
        estar en esta lista y tener el móvil en la mano.
      </p>
      {error && <p className="aviso">{error}</p>}
      {aviso && <p className="nota">{aviso}</p>}

      {raiz ? (
        <>
          <div className="fila">
            <input
              value={telefono} inputMode="tel" placeholder="Teléfono (222410986)"
              onChange={(e) => setTelefono(e.target.value)}
            />
            <input
              value={nombre} placeholder="Nombre, para reconocerlo"
              onChange={(e) => setNombre(e.target.value)}
            />
          </div>
          <div className="fila">
            <button
              type="button" className="principal"
              disabled={ocupado || telefono.trim().length < 6} onClick={dar}
            >
              Dar acceso de operador
            </button>
          </div>
        </>
      ) : (
        <p className="nota">
          Solo el teléfono principal da y quita accesos. Si hace falta cambiar
          esta lista, pídeselo a quien lo tenga.
        </p>
      )}

      {lista !== null && (
        <Tabla cabeceras={['Teléfono', 'Nombre', 'Aparatos', 'Desde', 'Quién lo dio', '']}>
          {lista.map((o) => (
            <tr key={o.telefono}>
              <td className="tabla-clave">
                {o.telefono}
                {o.telefono === yo && <span className="tabla-tenue"> (tú)</span>}
                {o.raiz && <span className="tabla-tenue"> · principal</span>}
              </td>
              <td>{o.nombre ?? '—'}</td>
              <td>
                <button type="button" className="enlace" onClick={() => verAparatos(o.telefono)}>
                  {o.aparatos}
                </button>
              </td>
              <td className="tabla-tenue">
                {o.creado_en === null ? 'siempre' : cuando(o.creado_en)}
              </td>
              <td className="tabla-tenue">{o.alta_por ?? 'entorno'}</td>
              <td>
                {/* A la raíz no se la echa desde aquí: hay que sacarla de la
                    variable de entorno. Es el seguro contra quedarse todos
                    fuera, así que el botón no existe en vez de existir y
                    contestar que no. */}
                {raiz && !o.raiz && (
                  quitando === o.telefono ? (
                    <>
                      <button
                        type="button" className="principal" disabled={ocupado}
                        onClick={() => quitar(o.telefono)}
                      >
                        Sí, echarle
                      </button>
                      <button
                        type="button" className="secundario"
                        onClick={() => setQuitando(null)}
                      >
                        No
                      </button>
                    </>
                  ) : (
                    <button
                      type="button" className="secundario"
                      onClick={() => setQuitando(o.telefono)}
                    >
                      Quitar acceso
                    </button>
                  )
                )}
              </td>
            </tr>
          ))}
        </Tabla>
      )}

      {abierto !== null && (
        <>
          <h4>Aparatos de {abierto}</h4>
          <p className="nota">
            Cada uno es un navegador que demostró con un código ser de ese
            teléfono. Echa el que se haya perdido: la persona sigue entrando
            desde los demás.
          </p>
          {aparatos === null && <p className="nota">Cargando…</p>}
          {aparatos?.length === 0 && (
            <p className="nota">Ninguno todavía: no ha entrado desde ningún sitio.</p>
          )}
          {aparatos !== null && aparatos.length > 0 && (
            <Tabla cabeceras={['Aparato', 'Vinculado', 'Visto', '']}>
              {aparatos.map((a) => (
                <tr key={a.uuid}>
                  {/* Los ocho primeros caracteres bastan para distinguir dos
                      aparatos, y el uuid entero no dice nada más a quien mira. */}
                  <td className="tabla-clave">{a.uuid.slice(0, 8)}</td>
                  <td className="tabla-tenue">{cuando(a.creado_en)}</td>
                  <td className="tabla-tenue">{a.visto_en === null ? '—' : cuando(a.visto_en)}</td>
                  <td>
                    {raiz && (
                      <button
                        type="button" className="secundario" disabled={ocupado}
                        onClick={() => echarAparato(a.uuid)}
                      >
                        Echarlo
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </Tabla>
          )}
        </>
      )}
    </>
  );
}

// Una recarga, como tarjeta con sus botones. Vivía pegada dentro de la
// pestaña de pagos; al pasar los pagos a la bandeja hizo falta nombrarla,
// porque ahora se pinta en dos sitios: pendiente en la bandeja y decidida en
// el archivo. El propio estado dice si lleva botones.
function TarjetaRecarga({ recarga: r, ocupada, alConfirmar, alRechazar }: {
  recarga: RecargaOperador;
  ocupada: boolean;
  alConfirmar: (referencia: string) => void;
  alRechazar: (referencia: string) => void;
}) {
  return (
    <div className="oferta">
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
            type="button" className="principal" disabled={ocupada}
            onClick={() => alConfirmar(r.referencia)}
          >
            Confirmar pago
          </button>
          <button
            type="button" className="secundario" disabled={ocupada}
            onClick={() => alRechazar(r.referencia)}
          >
            Rechazar
          </button>
        </div>
      )}
    </div>
  );
}

// Cuánto hace de una fecha, con la palabra ya puesta.
function haceDesde(iso: string): string {
  return hace(Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)));
}

// Una fila por decisión pendiente, venga de donde venga.
type Pendiente =
  | { clase: 'incidencia'; cuando: string; incidencia: IncidenciaOperador }
  | { clase: 'pago'; cuando: string; recarga: RecargaOperador }
  | { clase: 'alta'; cuando: string; conductor: ConductorOperador };

const ETIQUETA_PENDIENTE: Record<Pendiente['clase'], string> = {
  incidencia: 'Incidencia',
  pago: 'Pago',
  alta: 'Alta de taxista',
};

// La tarjeta del mapa (06/10): lo que se toca, contesta. Un taxi dice quién
// es y abre su ficha; una espera viva ofrece mandársela a un taxi concreto —
// la oferta dirigida—; una apagada dice cuándo murió y deja llamar al
// cliente. Vive abajo a la izquierda para no pelearse ni con las cifras ni
// con el dique.
function TarjetaDelMapa({
  foco, taxis, viajes, sinOferta, alCerrar, alAbrirFicha,
}: {
  foco: { tipo: 'taxi' | 'viva' | 'apagada'; id: number };
  taxis: TaxiVivo[] | null;
  viajes: ViajeVivo[] | null;
  sinOferta: SinOfertaViva[] | null;
  alCerrar: () => void;
  alAbrirFicha: (conductorId: number) => void;
}) {
  const [mensaje, setMensaje] = useState('');
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  async function ofrecer(viajeId: number, conductorId: number, etiqueta: string) {
    setOcupado(true);
    setError('');
    try {
      await api.ofrecerViaje(viajeId, conductorId);
      setMensaje(`Oferta mandada a ${etiqueta}. Decide él; si acepta, lo verás aquí.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo mandar la oferta.');
    } finally {
      setOcupado(false);
    }
  }

  let cuerpo: React.ReactNode;
  if (foco.tipo === 'taxi') {
    const t = (taxis ?? []).find((x) => x.conductor_id === foco.id);
    cuerpo = t === undefined
      ? <p className="nota">Ese taxi ya no está en servicio.</p>
      : (
        <>
          <h3>
            {t.numero_taxi !== null && `${t.numero_taxi} · `}
            {t.matricula ?? t.nombre}
          </h3>
          <p className="nota">
            {t.nombre} · {t.estado === 'DISPONIBLE' ? 'libre' : 'con pasajero'}
            {t.zona !== null && ` · ${t.zona}`}
          </p>
          <p className="nota">
            {t.visto_hace_seg === null
              ? 'Sin posición todavía'
              : `Última posición hace ${hace(t.visto_hace_seg)}`}
            {' · '}
            <a className="consola-tel" href={`tel:${t.telefono}`}>{t.telefono}</a>
          </p>
          <button type="button" className="secundario" onClick={() => alAbrirFicha(foco.id)}>
            Ver su ficha
          </button>
        </>
      );
  } else if (foco.tipo === 'viva') {
    const v = (viajes ?? []).find((x) => x.id === foco.id);
    if (v === undefined || !VIVO_SIN_TAXI.includes(v.estado)) {
      cuerpo = <p className="nota">Ya no está esperando: alguien la cogió o se cerró.</p>;
    } else {
      // Los taxis libres más cercanos al punto de recogida, que son los que
      // tiene sentido mandar. Cinco: más es una lista, no una decisión.
      const cercanos = (taxis ?? [])
        .filter((t): t is TaxiVivo & { lat: number; lng: number } => (
          t.estado === 'DISPONIBLE' && t.lat !== null && t.lng !== null
        ))
        .map((t) => ({
          t,
          metros: metrosEntre({ lat: v.origen_lat, lng: v.origen_lng }, { lat: t.lat, lng: t.lng }),
        }))
        .sort((a, b) => a.metros - b.metros)
        .slice(0, 5);
      cuerpo = (
        <>
          <h3>{v.origen} → {v.destino}</h3>
          <p className="nota">
            Esperando desde hace {hace(v.espera_seg)}
            {v.telefono_cliente !== null && (
              <>
                {' · '}
                <a className="consola-tel" href={`tel:${v.telefono_cliente}`}>
                  {v.telefono_cliente}
                </a>
              </>
            )}
          </p>
          {mensaje !== '' && <p className="nota">{mensaje}</p>}
          {error !== '' && <p className="aviso">{error}</p>}
          {cercanos.length === 0 && (
            <p className="nota">Ningún taxi libre con posición a quien mandársela.</p>
          )}
          {cercanos.length > 0 && (
            <>
              <p className="mesa-tarjeta-titulo">Mandársela a un taxi</p>
              {cercanos.map(({ t, metros }) => (
                <button
                  key={t.conductor_id} type="button" className="secundario mesa-ofrecer"
                  disabled={ocupado}
                  onClick={() => ofrecer(
                    v.id, t.conductor_id, t.matricula ?? t.nombre,
                  )}
                >
                  {t.matricula ?? t.nombre}
                  <span>
                    {metros < 1000 ? `${Math.round(metros)} m` : `${(metros / 1000).toFixed(1)} km`}
                  </span>
                </button>
              ))}
            </>
          )}
        </>
      );
    }
  } else {
    const q = (sinOferta ?? []).find((x) => x.id === foco.id);
    cuerpo = q === undefined
      ? <p className="nota">Ya no está en la última hora.</p>
      : (
        <>
          <h3>{q.origen} → {q.destino}</h3>
          <p className="nota">
            Se quedó sin taxi hace {hace(q.hace_seg)}.
            {q.telefono_cliente !== null && (
              <>
                {' '}
                <a className="consola-tel" href={`tel:${q.telefono_cliente}`}>
                  {q.telefono_cliente}
                </a>
              </>
            )}
          </p>
          <p className="nota">
            Si sigue esperando, llámale y crea la solicitud de nuevo desde
            «Nueva solicitud»: con un taxi ya libre, esta vez saldrá.
          </p>
        </>
      );
  }

  return (
    <div className="mesa-tarjeta">
      <button type="button" className="mesa-tarjeta-cerrar" aria-label="Cerrar" onClick={alCerrar}>
        ✕
      </button>
      {cuerpo}
    </div>
  );
}

// La bandeja (06/10): todo lo que espera una decisión del operador, en UNA
// lista y con la más vieja arriba. La regla es la misma que en «esperando
// taxi»: lo urgente es lo viejo, porque detrás de cada fila hay alguien que
// no puede cobrar, trabajar o cerrar su queja hasta que alguien decida.
function Bandeja({
  incidencias, recargas, altas, ocupadoId,
  alResolver, alConfirmarPago, alRechazarPago, alAbrirAlta,
}: {
  incidencias: IncidenciaOperador[] | null;
  recargas: RecargaOperador[] | null;
  altas: ConductorOperador[] | null;
  ocupadoId: number | string | null;
  alResolver: (id: number, accion: 'sancionar' | 'perdonar') => void;
  alConfirmarPago: (referencia: string) => void;
  alRechazarPago: (referencia: string) => void;
  alAbrirAlta: (id: number) => void;
}) {
  // Hasta que estén las tres listas no se pinta nada: una bandeja a medias
  // dice «no queda nada» cuando sí queda, que es el peor mensaje posible.
  if (incidencias === null || recargas === null || altas === null) {
    return <p className="nota">Cargando…</p>;
  }
  const pendientes: Pendiente[] = [
    ...incidencias.map((i) => ({ clase: 'incidencia' as const, cuando: i.creada_en, incidencia: i })),
    ...recargas.map((r) => ({ clase: 'pago' as const, cuando: r.solicitada_en, recarga: r })),
    ...altas.map((c) => ({ clase: 'alta' as const, cuando: c.fecha_alta, conductor: c })),
  ].sort((a, b) => new Date(a.cuando).getTime() - new Date(b.cuando).getTime());

  if (pendientes.length === 0) {
    return <p className="nota">Nada pendiente. Todo decidido.</p>;
  }
  // Con tope. En producción aquí habrá docenas; pero una base con miles de
  // pendientes atascados no puede colgar el navegador del operador, que es
  // exactamente el día en que más lo necesita. Se enseñan los cien más
  // viejos: decididos esos, entran los siguientes solos.
  const visibles = pendientes.slice(0, 100);
  return (
    <>
      {visibles.map((p) => (
        <div
          key={`${p.clase}-${p.clase === 'incidencia' ? p.incidencia.id : p.clase === 'pago' ? p.recarga.id : p.conductor.id}`}
          className="pendiente"
        >
          <p className="pendiente-cabecera">
            <span className={`pendiente-clase pendiente-${p.clase}`}>
              {ETIQUETA_PENDIENTE[p.clase]}
            </span>
            <span className="pendiente-hace">hace {haceDesde(p.cuando)}</span>
          </p>
          {p.clase === 'incidencia' && (
            <FilaIncidencia
              incidencia={p.incidencia}
              ocupada={ocupadoId === p.incidencia.id}
              alResolver={alResolver}
            />
          )}
          {p.clase === 'pago' && (
            <TarjetaRecarga
              recarga={p.recarga}
              ocupada={ocupadoId === p.recarga.referencia}
              alConfirmar={alConfirmarPago}
              alRechazar={alRechazarPago}
            />
          )}
          {p.clase === 'alta' && (
            <FilaConductor conductor={p.conductor} alAbrir={alAbrirAlta} />
          )}
        </div>
      ))}
      {pendientes.length > visibles.length && (
        <p className="nota">
          Y {pendientes.length - visibles.length} más, esperando detrás de
          estos. Decide estos primero: la lista se rellena sola.
        </p>
      )}
    </>
  );
}

// Seis entradas, agrupadas por LO QUE SE ESTÁ HACIENDO y no por qué tabla es.
//
// Eran once, ordenadas como está hecha la base de datos. Pero quien opera no
// piensa en tablas: piensa «tengo que resolver lo que hay pendiente», «me están
// llamando», «busco a una persona», «quiero consultar algo». Once entradas
// obligan a recordar en cuál metió cada cosa quien lo programó.
//
// El orden es el del día: primero lo que hay que decidir hoy, luego lo que pasa
// en directo, luego buscar gente, luego consultar, y al fondo lo que casi nunca
// se toca.
//
// `resumen` ya no está: sus alarmas y sus cifras viven en la columna de la
// izquierda, que se ve SIEMPRE. Repetirlas en una pestaña obligaba a mirar en
// dos sitios para saber una cosa. Lo que quedaba se fue a Ajustes.
const SECCIONES = [
  ['porhacer', 'Por hacer'],
  ['central', 'Central'],
  ['gente', 'Gente'],
  ['registros', 'Registros'],
  ['sitios', 'Sitios'],
  ['ajustes', 'Ajustes'],
] as const;
type Seccion = (typeof SECCIONES)[number][0];

// Lo que ve un agente de campo (migración 025): el mapa y los precios, nada
// de administrar a sus compañeros ni el dinero. El servidor aplica el mismo
// corte —esto solo evita enseñar botones que darían 403.
const SECCIONES_AGENTE: Seccion[] = ['sitios', 'ajustes'];

const FILTROS_CONDUCTOR = ['pendiente', 'verificado', 'suspendido', 'bloqueado', 'todos'] as const;

export default function PanelOperador({ modo = 'operador', alVolver }: {
  modo?: 'operador' | 'agente';
  // Solo en modo agente: el agente vuelve a su panel de taxi.
  alVolver?: () => void;
} = {}) {
  const esAgente = modo === 'agente';
  // La radio de la Central (086): el operador escucha y emite en el canal del
  // gremio, con el mismo botón flotante que el taxista. Un agente de campo
  // no: la radio del gremio no es parte del trabajo de mapa.
  const radio = useRadio({ activa: !esAgente, puerta: 'operador' });
  const recibirRadio = useRef<((tipo: string, datos: unknown) => void) | null>(null);
  recibirRadio.current = radio.alRecibirEvento;
  useEffect(() => {
    if (esAgente) return;
    return abrirEventosOperador((evento) => {
      if (evento.tipo.startsWith('radio_')) {
        recibirRadio.current?.(evento.tipo, evento.datos);
      }
    });
  }, [esAgente]);
  // El panel es solo en español; la radio comparte textos con la del taxista.
  const tRadio = crearT('es');
  const visibles = esAgente
    ? SECCIONES.filter(([id]) => SECCIONES_AGENTE.includes(id))
    : SECCIONES;
  // Se abre en la bandeja, no en un resumen: lo primero que hace quien se
  // sienta es mirar qué hay pendiente de decidir.
  const [seccion, setSeccion] = useState<Seccion>(esAgente ? 'sitios' : 'porhacer');
  // Qué pestaña dentro de cada grupo. Separadas para que cambiar de grupo y
  // volver te devuelva donde estabas.
  const [enGente, setEnGente] = useState<'conductores' | 'pasajeros'>('conductores');
  // El archivo de la bandeja: lo ya decidido. Cerrado por defecto, porque a
  // la bandeja se viene a decidir, no a releer.
  const [verResueltas, setVerResueltas] = useState(false);
  // Las altas pendientes tienen su propia lista: la de Gente obedece al
  // filtro que el operador deje puesto allí, y la bandeja no puede depender
  // de en qué se quedó mirando otro día.
  const [altas, setAltas] = useState<ConductorOperador[] | null>(null);
  const [enSitios, setEnSitios] = useState<'zonas' | 'barrios' | 'lugares'>('zonas');
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

  // El propietario abierto en los registros (09/10): entrar por el dueño para
  // ver su flota. Vive aquí porque se abre tanto desde el registro de
  // propietarios como desde la pestaña Dueño de la ficha de un taxista.
  const [fichaPropietario, setFichaPropietario] = useState<number | null>(null);

  // Incidencias y pagos PENDIENTES: son la bandeja. Lo resuelto vive aparte
  // y se pide solo si alguien abre el archivo.
  const [incidencias, setIncidencias] = useState<IncidenciaOperador[] | null>(null);
  const [recargas, setRecargas] = useState<RecargaOperador[] | null>(null);
  const [archivoIncidencias, setArchivoIncidencias] = useState<IncidenciaOperador[] | null>(null);
  const [archivoRecargas, setArchivoRecargas] = useState<RecargaOperador[] | null>(null);

  function cargarStats() {
    api.estadisticasOperador().then(setStats).catch((e) => setError(e.message));
    api.saludOperador().then(setSalud).catch(() => undefined);
  }
  useEffect(cargarStats, []);

  // Las cifras se refrescan solas: alimentan el contador de «Por hacer», que
  // está siempre a la vista en el menú, y un contador que miente es peor que
  // no tenerlo. Antes solo corrían con la pestaña de Resumen abierta.
  useEffect(() => {
    const t = setInterval(cargarStats, 30_000);
    return () => clearInterval(t);
  }, []);

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
    api.incidenciasOperador('pendientes')
      .then((r) => setIncidencias(r.incidencias))
      .catch((e) => setError(e.message));
  }
  useEffect(cargarIncidencias, []);

  function cargarRecargas() {
    api.recargasOperador('pendiente')
      .then((r) => setRecargas(r.recargas))
      .catch((e) => setError(e.message));
  }
  useEffect(cargarRecargas, []);

  function cargarAltas() {
    api.conductoresOperador('pendiente')
      .then((r) => setAltas(r.conductores))
      .catch((e) => setError(e.message));
  }
  useEffect(cargarAltas, []);

  // El archivo se pide al abrirlo, no antes: es lectura de consulta, y
  // cargarlo siempre sería pedir doscientas filas para una pestaña cerrada.
  useEffect(() => {
    if (!verResueltas) return;
    api.incidenciasOperador('resueltas')
      .then((r) => setArchivoIncidencias(r.incidencias))
      .catch(() => undefined);
    api.recargasOperador()
      .then((r) => setArchivoRecargas(r.recargas.filter((x) => x.estado !== 'pendiente')))
      .catch(() => undefined);
  }, [verResueltas]);

  async function cambiarEstadoConductor(id: number, estado: string) {
    setOcupadoId(id);
    setError('');
    try {
      await api.cambiarEstadoConductor(id, estado);
      api.conductoresOperador(
        busquedaConductor ? undefined : (filtroConductor === 'todos' ? undefined : filtroConductor),
        busquedaConductor || undefined,
      ).then((r) => setConductores(r.conductores)).catch(() => undefined);
      cargarAltas();
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
    // El identificador del pago, antes de tocar el saldo (migración 068). No
    // demuestra que el dinero entró —eso solo lo diría una API de Muni Dinero,
    // que no existe— pero deja la afirmación cotejable contra el extracto, y
    // el mismo comprobante no puede dar saldo dos veces.
    const comprobante = window.prompt(
      'Identificador del pago (transferencia de Muni Dinero, o número del recibo):',
    );
    if (!comprobante?.trim()) return;
    setOcupadoId(referencia);
    setError('');
    try {
      await api.confirmarRecarga(referencia, comprobante.trim());
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

  const enFicha = seccion === 'gente'
    && ((enGente === 'conductores' && fichaConductor !== null)
      || (enGente === 'pasajeros' && fichaPasajero !== null));
  const hayAlarma = salud?.alarmas.some((a) => a.disparada) ?? false;
  // Todo lo que espera una decisión del operador, en un número.
  const porHacer = stats === null ? 0
    : stats.incidenciasPendientes + stats.recargasPendientes + stats.conductores.pendientes;

  // --- Lo que está pasando ahora mismo, solo en la consola ----------------
  //
  // Se sondea cada seis segundos. No por SSE: el operador no necesita el
  // instante exacto, necesita no tener que refrescar, y una petición cada seis
  // segundos desde UN navegador no es carga. El día que haya diez operadores
  // esto se convierte en una conexión abierta como la del taxista.
  //
  // Solo si la pantalla es ancha y no es el modo agente: en el teléfono esta
  // vista no se enseña, así que pedir sus datos sería gastar batería y datos
  // de alguien que no los va a ver.
  const enOrdenador = useEsOrdenador();
  const enConsola = enOrdenador && !esAgente;
  // LA HOJA (06/10): lo que se consulta —Gente, Registros, Sitios, Ajustes—
  // se abre encima del mapa y se cierra con Esc, que te devuelve al despacho.
  // Cerrada, la consola ES el mapa con lo vivo alrededor: una sola
  // distribución que aprender, y láminas que se le ponen encima.
  const [hojaAbierta, setHojaAbierta] = useState(false);
  // El dique de lo vivo se pliega para ver el plano entero, pero no se
  // redimensiona: un tamaño que se puede dejar mal puesto es un ajuste más
  // que recordar, y aquí el ancho lo decide el contenido.
  const [dockPlegado, setDockPlegado] = useState(false);
  const [taxisVivos, setTaxisVivos] = useState<TaxiVivo[] | null>(null);
  const [viajesVivos, setViajesVivos] = useState<ViajeVivo[] | null>(null);
  const [sinOfertaVivas, setSinOfertaVivas] = useState<SinOfertaViva[] | null>(null);
  // Lo que está tocado en el mapa: un taxi, una espera viva o una apagada.
  const [foco, setFoco] = useState<{ tipo: 'taxi' | 'viva' | 'apagada'; id: number } | null>(null);
  // Las carreras dibujadas sobre el plano (06/10): id → tramos de su traza.
  // Un Map y no una sola: comparar dos viajes es verlos JUNTOS.
  const [trazas, setTrazas] = useState<Map<number, Array<Array<{ lat: number; lng: number }>>>>(new Map());
  const [avisoTraza, setAvisoTraza] = useState('');
  // El recorrido de UN taxista sobre el mapa del despacho (pedido el 08/10):
  // se abre desde su ficha y trae su propio filtro de tiempo —Hoy, Semana,
  // Mes— y un botón para quitarlo, en vez de un mapa pequeño dentro de la
  // ficha.
  const [recorridoMapa, setRecorridoMapa] = useState<{
    conductorId: number; periodo: PeriodoRecorrido;
    tramos: Array<Array<{ lat: number; lng: number }>>;
  } | null>(null);
  // UNA carrera, enfocada en el mapa del despacho (08/10): al pulsarla en los
  // registros, el plano se queda solo con ese viaje —su recorrido, y los
  // extremos con la hora y el barrio de salida y de llegada—, sin la flota
  // viva que, mezclada, lo volvería ilegible. Un chip la quita.
  const [viajeEnMapa, setViajeEnMapa] = useState<{
    viaje: ViajeOperador;
    origen: Marca; destino: Marca;
    tramos: Array<Array<{ lat: number; lng: number }>>;
  } | null>(null);

  async function verRecorridoConductor(id: number, periodo: PeriodoRecorrido = 'dia') {
    try {
      const r = await api.recorridoConductor(id, periodo);
      setRecorridoMapa({ conductorId: id, periodo, tramos: r.tramos });
      setAvisoTraza(r.tramos.length === 0
        ? 'Ese taxista no tiene recorrido en ese periodo.' : '');
      setHojaAbierta(false);
    } catch (e) {
      setAvisoTraza(e instanceof Error ? e.message : 'No se pudo cargar el recorrido.');
    }
  }

  async function verViajeEnMapa(viaje: ViajeOperador) {
    try {
      const t = await api.trazaViaje(viaje.id);
      // Los extremos salen siempre, aunque no haya rastro: dónde empezó y
      // acabó la carrera dice algo aunque no sepamos por dónde fue.
      setViajeEnMapa({
        viaje,
        origen: { lat: t.origen.lat, lng: t.origen.lng, nombre: t.origen.nombre },
        destino: { lat: t.destino.lat, lng: t.destino.lng, nombre: t.destino.nombre },
        tramos: t.tramos,
      });
      setAvisoTraza(t.tramos.length === 0
        ? 'Esa carrera no tiene recorrido guardado: o no llegó a tener taxi, o su rastro no se grabó. Se ven los extremos.'
        : '');
      setHojaAbierta(false);
    } catch (e) {
      setAvisoTraza(e instanceof Error ? e.message : 'No se pudo cargar la carrera.');
    }
  }

  // Saltar a una ficha desde los registros (08/10): el taxista o el cliente de
  // una carrera, o el taxista de un vehículo, abren su ficha en Gente. En la
  // consola la hoja se queda abierta sobre Gente; en la vista estrecha cambia
  // de sección.
  function abrirFichaConductor(id: number) {
    setEnGente('conductores');
    setFichaPasajero(null);
    setFichaConductor(id);
    setSeccion('gente');
    setHojaAbierta(true);
  }
  function abrirFichaPasajero(dispositivoId: number) {
    setEnGente('pasajeros');
    setFichaConductor(null);
    setFichaPasajero(dispositivoId);
    setSeccion('gente');
    setHojaAbierta(true);
  }
  function abrirFichaPropietario(id: number) {
    setFichaPropietario(id);
    setSeccion('registros');
    setHojaAbierta(true);
  }
  // Los barrios situados, para que el encuadre arranque en Malabo y no en la
  // isla entera. Se piden una vez: los barrios no se mueven a lo largo del día.
  const [ciudad, setCiudad] = useState<Array<{ lat: number; lng: number }>>([]);

  useEffect(() => {
    if (!enConsola) return;
    api.zonasOperador()
      .then((r) => setCiudad(
        r.zonas
          .filter((z): z is typeof z & { lat: number; lng: number } => z.lat !== null && z.lng !== null)
          // Solo lo que está en Bioko. Una zona con el centroide fuera de la
          // isla —en la base de desarrollo las hay en mitad del Pacífico, de
          // las pruebas de «fuera de Bioko se rechaza»— estiraría el encuadre
          // a medio planeta y el plano saldría negro.
          .filter((z) => z.lat > 3.2 && z.lat < 3.9 && z.lng > 8.3 && z.lng < 9.1)
          .map((z) => ({ lat: z.lat, lng: z.lng })),
      ))
      .catch(() => undefined);
  }, [enConsola]);

  useEffect(() => {
    if (!enConsola) return;
    let vivo = true;
    const cargar = () => {
      api.vivoOperador()
        .then((r) => {
          if (!vivo) return;
          setTaxisVivos(r.taxis);
          setViajesVivos(r.viajes);
          setSinOfertaVivas(r.sinOferta);
        })
        // En silencio: esta vista se repinta sola cada seis segundos, y un
        // cartel de error por un corte de un segundo taparía el trabajo. Lo que
        // se ve es que los datos dejan de moverse.
        .catch(() => undefined);
    };
    cargar();
    const reloj = setInterval(cargar, 6000);
    return () => { vivo = false; clearInterval(reloj); };
  }, [enConsola]);

  // Esc cierra la hoja desde cualquier sitio. Es el gesto de «quita esto de
  // en medio», y tener que buscar la cruz con el ratón en mitad de una
  // llamada es justo lo que la mesa quiere evitar.
  useEffect(() => {
    if (!enConsola) return;
    const alTeclear = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHojaAbierta(false);
    };
    window.addEventListener('keydown', alTeclear);
    return () => window.removeEventListener('keydown', alTeclear);
  }, [enConsola]);

  // Los taxis que el mapa puede pintar: los que han mandado alguna posición.
  const taxisEnMapa = (taxisVivos ?? [])
    .filter((t): t is TaxiVivo & { lat: number; lng: number } => t.lat !== null && t.lng !== null)
    .map((t) => ({
      id: t.conductor_id,
      lat: t.lat,
      lng: t.lng,
      matricula: t.matricula,
      libre: t.estado === 'DISPONIBLE',
    }));

  // Las mismas piezas montadas de dos maneras. Se nombran aquí en vez de
  // repetirlas en los dos armazones: duplicar la lista de secciones es la forma
  // segura de que dentro de un mes el teléfono y el ordenador tengan secciones
  // distintas sin que nadie se dé cuenta.
  const barraSecciones = (
    <div className="selector-idioma">
      {visibles.map(([id, etiqueta]) => (
        <button
          key={id} type="button"
          className={id === seccion ? 'idioma-activo' : undefined}
          onClick={() => { setSeccion(id); setFichaConductor(null); setFichaPasajero(null); setFichaPropietario(null); }}
        >
          {etiqueta}
          {/* UN solo número para todo el grupo. Tres contadores repartidos
              obligan a sumarlos con la vista para saber si hay trabajo; uno
              dice de un vistazo si hoy hay papeleo o no. */}
          {id === 'porhacer' && porHacer > 0 && ` (${porHacer})`}
          {id === 'ajustes' && hayAlarma && ' ⚠'}
        </button>
      ))}
    </div>
  );

  const contenido = (
    <>
      {error && <p className="aviso">{error}</p>}

        {seccion === 'central' && <Central />}

        {/* LA BANDEJA (06/10). Una sola lista: cada cosa que espera una
            decisión —una incidencia, un pago, un alta— es una fila, con la
            más vieja arriba. La regla es la de «esperando taxi»: lo urgente
            es lo viejo. Eran tres pestañas, y había que entrar en las tres
            para saber si quedaba algo. */}
        {seccion === 'porhacer' && (
          fichaConductor !== null
            ? (
              <FichaConductor
                id={fichaConductor}
                alVolver={() => setFichaConductor(null)}
                alCambiarEstado={cambiarEstadoConductor}
                ocupado={ocupadoId !== null}
                alVerRecorrido={enConsola ? (cid) => verRecorridoConductor(cid) : undefined}
                alVerFichaPropietario={abrirFichaPropietario}
              />
            )
            : (
              <>
                <Bandeja
                  incidencias={incidencias}
                  recargas={recargas}
                  altas={altas}
                  ocupadoId={ocupadoId}
                  alResolver={resolverIncidencia}
                  alConfirmarPago={confirmarPago}
                  alRechazarPago={rechazarPago}
                  alAbrirAlta={setFichaConductor}
                />
                <button
                  type="button" className="secundario"
                  onClick={() => setVerResueltas(!verResueltas)}
                >
                  {verResueltas ? 'Ocultar lo ya decidido' : 'Ver lo ya decidido'}
                </button>
                {verResueltas && (
                  <>
                    <h3 className="bandeja-titulo">Incidencias resueltas</h3>
                    {archivoIncidencias?.length === 0 && <p className="nota">Ninguna todavía.</p>}
                    {archivoIncidencias?.map((i) => (
                      <FilaIncidencia
                        key={i.id} incidencia={i} ocupada={false}
                        alResolver={resolverIncidencia}
                      />
                    ))}
                    <h3 className="bandeja-titulo">Pagos decididos</h3>
                    {archivoRecargas?.length === 0 && <p className="nota">Ninguno todavía.</p>}
                    {archivoRecargas?.map((r) => (
                      <TarjetaRecarga
                        key={r.id} recarga={r} ocupada={false}
                        alConfirmar={confirmarPago} alRechazar={rechazarPago}
                      />
                    ))}
                  </>
                )}
              </>
            )
        )}

        {seccion === 'gente' && !enFicha && (
          <div className="selector-idioma">
            {([['conductores', 'Taxistas'], ['pasajeros', 'Pasajeros']] as const).map(([id, etiqueta]) => (
              <button
                key={id} type="button"
                className={id === enGente ? 'idioma-activo' : undefined}
                onClick={() => setEnGente(id)}
              >
                {etiqueta}
              </button>
            ))}
          </div>
        )}

        {seccion === 'gente' && enGente === 'conductores' && (
          fichaConductor !== null
            ? (
              <FichaConductor
                id={fichaConductor}
                alVolver={() => setFichaConductor(null)}
                alCambiarEstado={cambiarEstadoConductor}
                ocupado={ocupadoId !== null}
                alVerRecorrido={enConsola ? (cid) => verRecorridoConductor(cid) : undefined}
                alVerFichaPropietario={abrirFichaPropietario}
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
                {/* En el ordenador, tabla (06/10): una lista de cincuenta
                    taxistas se recorre bajando por UNA columna —la matrícula,
                    el estado— y las tarjetas obligaban a leer cada una
                    entera. En el teléfono siguen las tarjetas, que con el
                    pulgar son más fáciles de acertar. */}
                {enConsola && conductores !== null && conductores.length > 0 && (
                  <Tabla cabeceras={['Nº', 'Taxi', 'Nombre', 'Teléfono', 'Estado', 'Alta']}>
                    {conductores.map((c) => (
                      <tr
                        key={c.id} className="tabla-desplegable"
                        onClick={() => setFichaConductor(c.id)}
                      >
                        <td className="tabla-clave">{c.numero_taxi ?? '—'}</td>
                        <td className="tabla-clave">{c.matricula ?? '—'}</td>
                        <td>{c.nombre}</td>
                        <td className="tabla-tenue">{c.telefono}</td>
                        <td>{ETIQUETA_ESTADO[c.estado_verificacion] ?? c.estado_verificacion}</td>
                        <td className="tabla-tenue">{cuando(c.fecha_alta)}</td>
                      </tr>
                    ))}
                  </Tabla>
                )}
                {!enConsola && conductores?.map((c) => (
                  <FilaConductor key={c.id} conductor={c} alAbrir={setFichaConductor} />
                ))}
                {/* El alta hecha por el operador (06/10): con el coche
                    delante, en vez de esperar a que el taxista se registre
                    solo desde su móvil. */}
                <AltaDeTaxista alCreada={(id) => { cargarStats(); setFichaConductor(id); }} />
              </>
            )
        )}

        {seccion === 'gente' && enGente === 'pasajeros' && (
          fichaPasajero !== null
            ? <FichaPasajero dispositivoId={fichaPasajero} alVolver={() => setFichaPasajero(null)} />
            : (
              <>
                <Buscador alBuscar={setBusquedaPasajero} />
                {pasajeros?.length === 0 && <p className="nota">No hay pasajeros que encajen.</p>}
                {enConsola && pasajeros !== null && pasajeros.length > 0 && (
                  <Tabla cabeceras={['Nombre', 'Teléfono', 'Viajes', 'Strikes', 'Estado']}>
                    {pasajeros.map((p) => (
                      <tr
                        key={p.dispositivo_id} className="tabla-desplegable"
                        onClick={() => setFichaPasajero(p.dispositivo_id)}
                      >
                        <td>{p.nombre ?? `Dispositivo ${p.dispositivo_id}`}</td>
                        <td className="tabla-tenue">{p.telefono ?? '—'}</td>
                        <td className="tabla-numero">{p.viajes}</td>
                        <td className="tabla-numero">{p.strikes > 0 ? p.strikes : '—'}</td>
                        <td>{p.bloqueado_en ? 'BLOQUEADO' : '—'}</td>
                      </tr>
                    ))}
                  </Tabla>
                )}
                {!enConsola && pasajeros?.map((p) => (
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

        {seccion === 'registros' && (
          fichaPropietario !== null
            ? (
              <FichaPropietario
                id={fichaPropietario}
                alVolver={() => setFichaPropietario(null)}
                alVerFichaConductor={abrirFichaConductor}
              />
            )
            : (
              <Registros
                alVerViaje={enConsola ? verViajeEnMapa : undefined}
                alVerFichaConductor={abrirFichaConductor}
                alVerFichaPasajero={abrirFichaPasajero}
                alVerFichaPropietario={abrirFichaPropietario}
              />
            )
        )}

        {/* Distritos, barrios y lugares eran tres entradas de once para la
            MISMA tarea: mantener el catálogo de sitios. Una, con tres
            pestañas. */}
        {seccion === 'sitios' && (
          <div className="selector-idioma">
            {([
              ['zonas', 'Distritos Urbanos'], ['barrios', 'Barrios'], ['lugares', 'Lugares'],
            ] as const).map(([id, etiqueta]) => (
              <button
                key={id} type="button"
                className={id === enSitios ? 'idioma-activo' : undefined}
                onClick={() => setEnSitios(id)}
              >
                {etiqueta}
              </button>
            ))}
          </div>
        )}
        {seccion === 'sitios' && enSitios === 'zonas' && <Zonas />}
        {seccion === 'sitios' && enSitios === 'barrios' && <Barrios />}
        {seccion === 'sitios' && enSitios === 'lugares' && <Lugares />}

        {seccion === 'ajustes' && (
          <>
            {/* Fuera del modo agente: un agente de campo no administra a sus
                compañeros, y el servidor le contestaría 403 al pedir la lista. */}
            {!esAgente && <Accesos />}
            <Ajustes />
            {/* La salud del sistema, que era la pestaña «Resumen». Aquí y no
                arriba: las alarmas que hay que ver sin falta ya salen en la
                columna de la izquierda, y esto es el detalle de cada una, que
                se mira cuando algo chirría. */}
            {stats && <Resumen stats={stats} salud={salud} />}
          </>
        )}
    </>
  );

  // --- La consola, en pantalla ancha: la mesa (06/10) ---------------------
  //
  // El mapa ES la pantalla. Encima, tres cosas y solo tres: las cifras-botón,
  // el dique derecho con lo vivo, y la hoja con lo que se consulta. No hay
  // «Resumen» ni columna de avisos: cada dato aparece UNA vez, y donde
  // aparece es donde se arregla.
  if (enConsola) {
    const esperando = (viajesVivos ?? []).filter((v) => VIVO_SIN_TAXI.includes(v.estado));
    const libres = (taxisVivos ?? []).filter((t) => t.estado === 'DISPONIBLE').length;
    const abrirHoja = (id: Seccion) => {
      setSeccion(id);
      setHojaAbierta(true);
      setFichaConductor(null);
      setFichaPasajero(null);
      setFichaPropietario(null);
    };
    const tituloHoja = seccion === 'central'
      ? 'Nueva solicitud'
      : SECCIONES.find(([id]) => id === seccion)?.[1] ?? '';
    return (
      <main className="mesa">
        <nav className="mesa-rail">
          <button
            type="button"
            className={!hojaAbierta ? 'mesa-rail-activo' : undefined}
            onClick={() => setHojaAbierta(false)}
          >
            <i>🗺️</i>Despacho
          </button>
          {/* Central no está en el raíl: su botón es «Nueva solicitud», en el
              dique, que es donde están los ojos cuando suena el teléfono. */}
          {visibles.filter(([id]) => id !== 'central').map(([id, etiqueta]) => (
            <button
              key={id} type="button"
              className={hojaAbierta && id === seccion ? 'mesa-rail-activo' : undefined}
              onClick={() => abrirHoja(id)}
            >
              <i>{ICONO[id]}</i>{etiqueta}
              {/* Con tope: el globo dice «hay mucho», no lleva la cuenta.
                  Cuatro cifras no caben en él y tampoco dicen nada más. */}
              {id === 'porhacer' && porHacer > 0 && (
                <span className="mesa-globo">{porHacer > 99 ? '+99' : porHacer}</span>
              )}
              {id === 'ajustes' && hayAlarma && <span className="mesa-globo">⚠</span>}
            </button>
          ))}
        </nav>
        <div className={dockPlegado ? 'mesa-escena mesa-escena-ancha' : 'mesa-escena'}>
          <div className="mesa-mapa">
            {/* Sin referencias: en una pantalla con treinta taxis, los cientos
                de puntos del gazetteer convierten el plano en una sopa y lo
                que se viene a mirar aquí es dónde están los coches. */}
            {viajeEnMapa !== null ? (
              // Enfocado en UNA carrera: su recorrido y sus extremos, sin la
              // flota viva que lo taparía. Los extremos llevan la hora y el
              // barrio de salida y de llegada.
              <Mapa
                puntos={[]}
                encuadre="viaje"
                ciudad={ciudad}
                origen={viajeEnMapa.origen}
                destino={viajeEnMapa.destino}
                etiquetasExtremos={{
                  origen: {
                    titulo: `Salida ${soloHora(viajeEnMapa.viaje.emitido_en ?? viajeEnMapa.viaje.creada_en)}`,
                    sub: viajeEnMapa.viaje.zona_recogida,
                  },
                  destino: {
                    titulo: viajeEnMapa.viaje.bajada_en !== null
                      ? `Llegada ${soloHora(viajeEnMapa.viaje.bajada_en)}` : 'Destino',
                    sub: viajeEnMapa.viaje.zona_bajada,
                  },
                }}
                recorrido={viajeEnMapa.tramos.length > 0 ? viajeEnMapa.tramos : undefined}
              />
            ) : (
            <Mapa
              puntos={[]}
              taxis={taxisEnMapa}
              encuadre="flota"
              ciudad={ciudad}
              esperas={[
                // Las apagadas primero: lo que se pinta después queda ENCIMA,
                // y cuando una espera viva y una muerta caen en el mismo
                // cruce, el dedo tiene que encontrar a la que aún espera.
                ...(sinOfertaVivas ?? []).map((q) => ({
                  id: q.id, lat: q.origen_lat, lng: q.origen_lng, viva: false,
                })),
                ...esperando.map((v) => ({
                  id: v.id, lat: v.origen_lat, lng: v.origen_lng,
                  viva: true, etiqueta: hace(v.espera_seg),
                })),
              ]}
              alTocarTaxi={(id) => setFoco({ tipo: 'taxi', id })}
              alTocarEspera={(id, viva) => setFoco({ tipo: viva ? 'viva' : 'apagada', id })}
              recorrido={(() => {
                const dibujos = [
                  ...(trazas.size > 0 ? [...trazas.values()].flat() : []),
                  ...(recorridoMapa?.tramos ?? []),
                ];
                return dibujos.length > 0 ? dibujos : undefined;
              })()}
            />
            )}
            {viajeEnMapa === null && taxisVivos !== null && taxisEnMapa.length === 0 && (
              <p className="mesa-mapa-vacio">
                {taxisVivos.length === 0
                  ? 'Ningún taxi en servicio ahora mismo.'
                  : `${taxisVivos.length} en servicio, ninguno ha mandado su posición todavía.`}
              </p>
            )}
          </div>

          {/* Las cifras son BOTONES: cada número abre lo que cuenta. Un
              número que no lleva a ningún sitio obliga a recordar dónde se
              arregla lo que dice. */}
          <div className={dockPlegado ? 'mesa-chips mesa-chips-anchas' : 'mesa-chips'}>
            <button type="button" className="mesa-chip" onClick={() => abrirHoja('registros')}>
              <b>{libres}</b><small>libres</small>
            </button>
            <button type="button" className="mesa-chip" onClick={() => abrirHoja('registros')}>
              <b>{(taxisVivos ?? []).length}</b><small>en servicio</small>
            </button>
            <button
              type="button"
              className={esperando.length > 0 ? 'mesa-chip mesa-chip-urgente' : 'mesa-chip'}
              onClick={() => { setHojaAbierta(false); setDockPlegado(false); }}
            >
              <b>{esperando.length}</b><small>esperando taxi</small>
            </button>
            {porHacer > 0 && (
              <button
                type="button" className="mesa-chip mesa-chip-aviso"
                onClick={() => abrirHoja('porhacer')}
              >
                <b>{porHacer}</b><small>por hacer</small>
              </button>
            )}
            {hayAlarma && (
              <button
                type="button" className="mesa-chip mesa-chip-urgente"
                onClick={() => abrirHoja('ajustes')}
              >
                <b>⚠</b><small>salud</small>
              </button>
            )}
            {trazas.size > 0 && (
              <button
                type="button" className="mesa-chip"
                onClick={() => setTrazas(new Map())}
              >
                <b>{trazas.size}</b>
                <small>{trazas.size === 1 ? 'viaje dibujado · quitar' : 'viajes dibujados · quitar'}</small>
              </button>
            )}
            {recorridoMapa !== null && (
              <span className="mesa-chip mesa-chip-recorrido">
                <small>Recorrido</small>
                {(['dia', 'semana', 'mes'] as const).map((per) => (
                  <button
                    key={per} type="button"
                    className={per === recorridoMapa.periodo ? 'recorrido-per activo' : 'recorrido-per'}
                    onClick={() => verRecorridoConductor(recorridoMapa.conductorId, per)}
                  >
                    {per === 'dia' ? 'Hoy' : per === 'semana' ? 'Semana' : 'Mes'}
                  </button>
                ))}
                <button
                  type="button" className="recorrido-quitar"
                  onClick={() => setRecorridoMapa(null)}
                >
                  quitar ✕
                </button>
              </span>
            )}
            {viajeEnMapa !== null && (
              <span className="mesa-chip mesa-chip-recorrido">
                <small>
                  {viajeEnMapa.viaje.zona_recogida} → {viajeEnMapa.viaje.zona_bajada}
                </small>
                <button
                  type="button" className="recorrido-quitar"
                  onClick={() => { setViajeEnMapa(null); setAvisoTraza(''); }}
                >
                  volver a la flota ✕
                </button>
              </span>
            )}
            {avisoTraza !== '' && (
              <button type="button" className="mesa-chip" onClick={() => setAvisoTraza('')}>
                <small>{avisoTraza} ✕</small>
              </button>
            )}
          </div>

          {foco !== null && (
            <TarjetaDelMapa
              key={`${foco.tipo}-${foco.id}`}
              foco={foco}
              taxis={taxisVivos}
              viajes={viajesVivos}
              sinOferta={sinOfertaVivas}
              alCerrar={() => setFoco(null)}
              alAbrirFicha={(conductorId) => {
                setEnGente('conductores');
                setFichaConductor(conductorId);
                setSeccion('gente');
                setHojaAbierta(true);
              }}
            />
          )}

          {!dockPlegado && (
            <aside className="mesa-dock">
              <button
                type="button" className="principal mesa-llamada"
                onClick={() => abrirHoja('central')}
              >
                📞 Nueva solicitud
              </button>
              <DockVivo viajes={viajesVivos} />
            </aside>
          )}
          <button
            type="button"
            className={dockPlegado ? 'mesa-plegar mesa-plegar-suelto' : 'mesa-plegar'}
            aria-label={dockPlegado ? 'Abrir lo vivo' : 'Plegar lo vivo'}
            onClick={() => setDockPlegado(!dockPlegado)}
          >
            {dockPlegado ? '⟨' : '⟩'}
          </button>

      {!esAgente && (
        <PanelRadio
          estado={radio.estado}
          encendida={radio.encendida}
          puedeGrabar={radio.puedeGrabar}
          habla={radio.habla}
          quedan={radio.quedan}
          segundosMax={radio.segundosMax}
          mensajes={radio.mensajes}
          aviso={radio.aviso}
          oyentes={radio.oyentes}
          t={tRadio}
          alApretar={radio.apretar}
          alSoltar={radio.soltar}
          alVolverAOir={radio.volverAOir}
        />
      )}

          {hojaAbierta && (
            <div className={dockPlegado ? 'mesa-hoja mesa-hoja-ancha' : 'mesa-hoja'}>
              <header className="mesa-hoja-cabecera">
                <h2>{tituloHoja}</h2>
                <button type="button" className="mesa-cerrar" onClick={() => setHojaAbierta(false)}>
                  Cerrar ✕ <small>Esc</small>
                </button>
              </header>
              <section className="consola-trabajo">{contenido}</section>
            </div>
          )}
        </div>
      </main>
    );
  }

  // --- El teléfono, igual que siempre ------------------------------------
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
            {barraSecciones}
          </>
        )}
        {contenido}
      </section>
      {!esAgente && (
        <PanelRadio
          estado={radio.estado}
          encendida={radio.encendida}
          puedeGrabar={radio.puedeGrabar}
          habla={radio.habla}
          quedan={radio.quedan}
          segundosMax={radio.segundosMax}
          mensajes={radio.mensajes}
          aviso={radio.aviso}
          oyentes={radio.oyentes}
          t={tRadio}
          alApretar={radio.apretar}
          alSoltar={radio.soltar}
          alVolverAOir={radio.volverAOir}
        />
      )}
    </main>
  );
}

// --- La mesa de despacho (03/10; rehecha el 06/10) --------------------------
//
// El panel se escribió para el teléfono, que es donde se usa casi todo esto.
// Pero despachar no se hace de pie con el móvil: se hace sentado, con el
// teléfono sonando y los ojos en el plano.
//
// La primera consola repartía la pantalla en cuatro zonas fijas con fronteras
// arrastrables, y se quedó corta por lo de siempre: las mismas cosas acababan
// dichas en dos sitios —los taxis en el mapa Y en una columna de cifras, la
// salud en los avisos Y en una pestaña— y cada repetición es un sitio más
// donde mirar para saber lo mismo. Ahora el mapa ES la pantalla, lo vivo
// flota encima y lo que se consulta se abre como una hoja que se cierra con
// Esc. En el teléfono no cambia absolutamente nada.

const ANCHO_CONSOLA = 1100;

// Los pictogramas del raíl. Emoji del sistema y no SVG a propósito: esto es
// una herramienta interna de escritorio, y seis dibujos que ya vienen con el
// ordenador dicen lo mismo sin añadir un byte al paquete.
const ICONO: Record<string, string> = {
  porhacer: '📥',
  gente: '👤',
  registros: '📒',
  sitios: '📍',
  ajustes: '⚙️',
};

function useEsOrdenador(): boolean {
  const [ancha, setAncha] = useState(
    () => typeof window !== 'undefined'
      && window.matchMedia(`(min-width: ${ANCHO_CONSOLA}px)`).matches,
  );
  useEffect(() => {
    const consulta = window.matchMedia(`(min-width: ${ANCHO_CONSOLA}px)`);
    const alCambiar = () => setAncha(consulta.matches);
    consulta.addEventListener('change', alCambiar);
    return () => consulta.removeEventListener('change', alCambiar);
  }, []);
  return ancha;
}

// Cuánto lleva esperando, dicho corto. Los segundos importan aquí: la
// diferencia entre «hace 40 s» y «hace 4 min» es la diferencia entre dejarlo
// correr y coger el teléfono.
function hace(segundos: number): string {
  if (segundos < 60) return `${segundos} s`;
  const min = Math.floor(segundos / 60);
  if (min < 60) return `${min} min`;
  const horas = Math.floor(min / 60);
  // A partir de dos días, en días: «1704 h 5 min» obliga a dividir de cabeza,
  // y en la bandeja hay pendientes que llevan semanas.
  if (horas >= 48) return `${Math.floor(horas / 24)} días`;
  return `${horas} h ${min % 60} min`;
}

const VIVO_SIN_TAXI = ['SOLICITADO', 'EMITIDO'];

// El dique de lo vivo. Lo que NO puede esperar a que alguien entre en una
// sección: quién está pidiendo taxi y no lo tiene todavía. Las cifras que
// vivían aquí arriba son ahora los botones sobre el mapa; esto es la lista.
//
// Ordenada por quién lleva más esperando, y no por lo más reciente, que sería
// lo natural en un registro: aquí lo urgente es lo viejo. Quien lleva cuatro
// minutos sin taxi está a punto de colgar e irse andando.
function DockVivo({ viajes }: { viajes: ViajeVivo[] | null }) {
  const sinTaxi = (viajes ?? []).filter((v) => VIVO_SIN_TAXI.includes(v.estado));
  const enMarcha = (viajes ?? []).filter((v) => !VIVO_SIN_TAXI.includes(v.estado));

  return (
    <div className="consola-ahora">
      <h3>Esperando taxi</h3>
      {viajes === null && <p className="nota">…</p>}
      {viajes !== null && sinTaxi.length === 0 && (
        <p className="nota">Nadie esperando. Todo el mundo tiene taxi.</p>
      )}
      {sinTaxi
        .slice()
        .sort((a, b) => b.espera_seg - a.espera_seg)
        .map((v) => (
          <div key={v.id} className="consola-fila consola-fila-urgente">
            <span className="consola-espera">{hace(v.espera_seg)}</span>
            <span className="consola-ruta">{v.origen} → {v.destino}</span>
            {v.telefono_cliente !== null && (
              <a className="consola-tel" href={`tel:${v.telefono_cliente}`}>
                {v.telefono_cliente}
              </a>
            )}
          </div>
        ))}

      <h3>En marcha</h3>
      {viajes !== null && enMarcha.length === 0 && (
        <p className="nota">Ningún viaje en curso.</p>
      )}
      {enMarcha.map((v) => (
        <div key={v.id} className="consola-fila">
          <span className="consola-estado">{v.estado.toLowerCase()}</span>
          <span className="consola-ruta">{v.origen} → {v.destino}</span>
          <span className="consola-quien">
            {v.matricula ?? v.conductor ?? '—'}
          </span>
        </div>
      ))}
    </div>
  );
}

// Segundos a «4 h 20 min». En horas y minutos y no en decimales: «4,3 h» hay
// que traducirlo mentalmente, y esto se lee de un vistazo.
function duracion(segundos: number): string {
  if (segundos < 60) return '0 min';
  const minutos = Math.round(segundos / 60);
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return h === 0 ? `${m} min` : `${h} h ${m} min`;
}
