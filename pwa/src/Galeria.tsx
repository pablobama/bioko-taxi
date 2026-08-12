// Galería de diseños: todas las pantallas de los dos roles, con datos de
// ejemplo, en marcos del tamaño de un teléfono.
//
// Para qué: revisar el diseño sin tener que recorrer el flujo entero (darse de
// alta, verificar por consola, pagar la cuota, pedir un taxi, aceptarlo…) cada
// vez que se quiere ver una pantalla.
//
// Usa las MISMAS vistas que la aplicación (VistaCliente y VistaConductor), así
// que lo que se ve aquí es lo que se ve de verdad; si el diseño cambia, la
// galería cambia con él. El fondo es un plano estático porque dos docenas de
// mapas de Leaflet a la vez no son sostenibles.
//
// Se abre en http://localhost:8080/?galeria

import { useState } from 'react';
import type {
  DatosConductor, DestinoSugerido, DetalleSolicitud, EstadoConductor, ReferenciaSugerida,
  TaxisCerca, Zona,
} from './api';
import FondoMapa from './FondoMapa';
import { crearT } from './i18n';
import VistaCliente, { type AccionesCliente, type FaseCliente } from './VistaCliente';
import VistaConductor, { type AccionesConductor } from './VistaConductor';

// La galería es una herramienta de desarrollo: se enseña siempre en español,
// aunque la app real respete el idioma elegido.
const t = crearT('es');

// --- Datos de ejemplo ------------------------------------------------------

const NADA = () => undefined;

const accionesCliente: AccionesCliente = {
  alAbrirAjustes: NADA, alAbrirEstadisticas: NADA, alPedir: NADA,
  alCancelar: NADA, alLimpiar: NADA, alValorar: NADA, alQuitarOrigen: NADA, alLlamar: NADA, alElegirDestino: NADA, alEscribirDestino: NADA,
};

const accionesConductor: AccionesConductor = {
  alAbrirAjustes: NADA, alAbrirEstadisticas: NADA, alAbrirRecarga: NADA, alSuscribir: NADA,
  alAlternarServicio: NADA, alAceptar: NADA,
  alRechazar: NADA, alSalir: NADA, alLlegar: NADA, alRecoger: NADA,
  alDeclararAusente: NADA, alCompletar: NADA, alLlamar: NADA,
};

const mercado: ReferenciaSugerida = {
  id: 1, nombre: 'Mercado Central', zona: 'Malabo Centro', lat: 3.7531, lng: 8.7752, categoria: 'mercado',
};
const catedral: ReferenciaSugerida = {
  id: 2, nombre: 'Catedral de Santa Isabel', zona: 'Malabo Centro', lat: 3.7539, lng: 8.7737, categoria: 'iglesia',
};

function solicitud(cambios: Partial<DetalleSolicitud> = {}): DetalleSolicitud {
  return {
    solicitudId: 1234,
    viajeId: 99,
    estado: 'ACEPTADO',
    origen: mercado.nombre,
    origenLat: mercado.lat,
    origenLng: mercado.lng,
    // Migración 046: la galería enseña el caso bueno —posición real, a 90 m
    // del sitio conocido—, que es el que hay que poder mirar de un vistazo.
    recogidaEnGps: true,
    metrosDeLaReferencia: 90,
    destino: catedral.nombre,
    destinoLat: catedral.lat,
    destinoLng: catedral.lng,
    expiraEn: null,
    graciaCancelacionSeg: 47,
    taxiHaLlegado: false,
    taxi: { lat: 3.756, lng: 8.779, etaMin: 4, distanciaM: 1180, frescuraSeg: 12 },
    reputacion: { media: 4.6, valoraciones: 37, viajesCompletados: 52 },
    compartido: {
      pasajerosABordo: 0,
      plazas: 4,
      ruta: [{
        destino: catedral.nombre, esTuya: true, estado: 'ACEPTADO',
        lat: catedral.lat, lng: catedral.lng,
      }],
    },
    conductor: 'María Nchama',
    matricula: 'GE-2317-A',
    marca: 'Hyundai Accent',
    color: 'azul',
    aireAcondicionado: true,
    seguro: true,
    pin: '4394',
    ...cambios,
  };
}

const conductorEjemplo: DatosConductor = {
  nombre: 'Pablo Ondo',
  telefono: '+240222700700',
  correo: 'pablo@ejemplo.gq',
  verificado: true,
  telefonoVerificado: true,
  estadoVerificacion: 'verificado',
  suscritoHasta: '2026-08-02T10:00:00Z',
  suscripcionVigente: true,
  saldoXaf: 3500,
  matricula: 'GE-7007-T',
  marca: 'Toyota Land Cruiser',
  color: 'blanco',
  carroceria: '4x4',
  plazas: 4,
  aireAcondicionado: true,
  seguro: true,
  reputacion: { media: 4.8, valoraciones: 61, viajesCompletados: 88 },
};

// Cómo llega la lista del servidor: primero los suyos, luego los de su zona.
const SUGERIDOS: DestinoSugerido[] = [
  { ...catedral, motivo: 'tuyo' },
  {
    id: 3, nombre: 'Hospital Regional de Malabo', zona: 'Ela Nguema',
    lat: 3.75568, lng: 8.78834, categoria: 'hospital', motivo: 'tuyo',
  },
  {
    id: 4, nombre: 'Mercado SEMU', zona: 'Semu',
    lat: 3.7584, lng: 8.7655, categoria: 'mercado', motivo: 'zona',
  },
  {
    id: 5, nombre: 'Universidad Nacional de Guinea Ecuatorial', zona: 'Los Ángeles',
    lat: 3.74764, lng: 8.77484, categoria: 'escuela', motivo: 'zona',
  },
];

// Como llegan del servidor: con centroide, para ordenarlas por cercanía.
const ZONAS: Zona[] = [
  { id: 1, nombre: 'Barrio Chino', lat: 3.74966, lng: 8.77969 },
  { id: 2, nombre: 'Los Ángeles', lat: 3.74824, lng: 8.77778 },
  { id: 3, nombre: 'Malabo Centro', lat: 3.75416, lng: 8.77997 },
  { id: 4, nombre: 'Semu', lat: 3.73785, lng: 8.78375 },
  { id: 5, nombre: 'Alcaide', lat: 3.74517, lng: 8.7883 },
  { id: 6, nombre: 'Ela Nguema', lat: 3.75681, lng: 8.7996 },
];

function estadoConductor(cambios: Partial<EstadoConductor> = {}): EstadoConductor {
  return {
    estado: 'DISPONIBLE',
    zonaId: 1,
    zona: 'Malabo Centro',
    saldoXaf: 3500,
    suscritoHasta: '2026-08-02T10:00:00Z',
    suscripcionVigente: true,
    plazas: 4,
    plazasLibres: 4,
    pasajerosABordo: 0,
    ofertas: [],
    pasajeros: [],
    ...cambios,
  };
}

// El identificador va con un contador, no al azar: con `Math.random()` sobre
// cien valores, dos de los cuatro pasajeros de un mismo coche acababan
// compartiendo número cada dos por tres, y React avisaba de claves repetidas.
let siguienteSolicitud = 1000;

function pasajero(estado: string, cambios: Record<string, unknown> = {}) {
  siguienteSolicitud += 1;
  return {
    solicitudId: siguienteSolicitud,
    viajeId: 500,
    estado,
    origen: mercado.nombre,
    origenLat: mercado.lat,
    origenLng: mercado.lng,
    destino: catedral.nombre,
    destinoLat: catedral.lat,
    destinoLng: catedral.lng,
    telefonoCliente: estado === 'ACEPTADO' ? null : '+240222888999',
    llegadoEn: null,
    relojEsperaSeg: 300,
    ...cambios,
  } as EstadoConductor['pasajeros'][number];
}

// --- Marco de teléfono ----------------------------------------------------

function Marco({
  titulo, descripcion, children,
}: { titulo: string; descripcion: string; children: React.ReactNode }) {
  return (
    <figure className="marco">
      <figcaption>
        <span className="marco-titulo">{titulo}</span>
        <span className="marco-descripcion">{descripcion}</span>
      </figcaption>
      <div className="pantalla-telefono">
        <div className="capa-mapa"><FondoMapa /></div>
        {children}
      </div>
    </figure>
  );
}

// Pantallas que no son ninguna de las dos vistas (registro, ajustes…). Se
// escriben aquí porque en la aplicación las dibuja App, no las vistas.
function HojaSuelta({ children }: { children: React.ReactNode }) {
  return <section className="hoja">{children}</section>;
}

// --- Galería ---------------------------------------------------------------

export default function Galeria() {
  const [rol, setRol] = useState<'todos' | 'cliente' | 'conductor'>('todos');

  const cliente = (fase: FaseCliente, props: Partial<PropiedadesGaleriaCliente> = {}) => (
    <VistaCliente
      fase={fase}
      detalle={props.detalle ?? null}
      origen={props.origen ?? null}
      destino={props.destino ?? null}
      gpsResuelto={props.gpsResuelto ?? true}
      hayCoordenadas={props.hayCoordenadas ?? true}
      valorada={props.valorada ?? false}
      aviso={props.aviso}
      t={t}
      sugeridos={props.sugeridos ?? []}
      escribiendo={props.escribiendo ?? false}
      puedeDeshacer={props.puedeDeshacer ?? false}
      segundosGracia={props.segundosGracia ?? null}
      buscadorDestino={<CampoFalso etiqueta="Escribe tu destino" valor={props.destino?.nombre} />}
      buscadorOrigen={<CampoFalso etiqueta="¿Dónde estás ahora?" />}
      taxisCerca={props.taxisCerca ?? null}
      acciones={accionesCliente}
    />
  );

  // Demanda de ejemplo, para poder ver el bloque sin depender de que haya
  // solicitudes reales en la base.
  const DEMANDA_EJEMPLO = {
    ventanaMin: 30,
    zonas: [
      { zona: 'Semu', zonaId: 3, pedidas: 7, sinTaxi: 5, taxisAhora: 0 },
      { zona: 'Ela Nguema', zonaId: 2, pedidas: 5, sinTaxi: 2, taxisAhora: 1 },
      { zona: 'Malabo Centro', zonaId: 1, pedidas: 9, sinTaxi: 1, taxisAhora: 4 },
    ],
  };

  const conductor = (
    estado: EstadoConductor | null,
    datos: Partial<DatosConductor> = {},
    aviso?: string,
    demanda: typeof DEMANDA_EJEMPLO | null = null,
  ) => (
    <VistaConductor
      conductor={{ ...conductorEjemplo, ...datos }}
      estado={estado}
      demanda={demanda}
      aviso={aviso}
      t={t}
      acciones={accionesConductor}
    />
  );

  return (
    <main className="galeria">
      <header className="galeria-cabecera">
        <div>
          <h1>Diseños de Taxi Malabo</h1>
          <p>
            Las mismas vistas que usa la aplicación, con datos de ejemplo. El
            plano de fondo es estático; en la app es un mapa con el que se puede
            interactuar.
          </p>
        </div>
        <nav className="galeria-filtros">
          {(['todos', 'cliente', 'conductor'] as const).map((valor) => (
            <button
              key={valor}
              type="button"
              className={rol === valor ? 'activo' : undefined}
              onClick={() => setRol(valor)}
            >
              {valor === 'todos' ? 'Todo' : valor === 'cliente' ? 'Pasajero' : 'Taxista'}
            </button>
          ))}
        </nav>
      </header>

      {rol !== 'conductor' && (
        <section className="galeria-grupo">
          <h2>Común · primera apertura</h2>
          <div className="galeria-rejilla">
            <Marco titulo="Elección de rol" descripcion="Lo primero que se ve. Decide qué aplicación usará.">
              <HojaSuelta>
                <h1>Taxi Malabo</h1>
                <p className="nota">¿Cómo vas a usar la aplicación?</p>
                <button type="button" className="principal grande">Quiero pedir taxis</button>
                <button type="button" className="secundario">Soy taxista</button>
                <p className="nota pie">
                  Elige con cuidado: cambiar de tipo después requiere hablar con
                  el operador, porque tu historial queda ligado a este teléfono.
                </p>
              </HojaSuelta>
            </Marco>
          </div>
        </section>
      )}

      {rol !== 'conductor' && (
        <section className="galeria-grupo">
          <h2>Pasajero</h2>
          <div className="galeria-rejilla">
            <Marco titulo="Alta" descripcion="Teléfono y/o correo. Nada más: no hay contraseña porque no hay verificación posible.">
              <HojaSuelta>
                <h1>Tus datos</h1>
                <p className="nota">
                  Solo necesitamos cómo avisarte. El taxista te llamará por
                  teléfono cuando llegue.
                </p>
                <CampoFalso etiqueta="Teléfono (+240…)" valor="+240 222 555 777" />
                <CampoFalso etiqueta="Correo (si no diste teléfono)" />
                <button type="button" className="principal grande">Empezar</button>
                <button type="button" className="secundario">Volver</button>
              </HojaSuelta>
            </Marco>

            <Marco titulo="Pedir · de un toque" descripcion="Lo primero que se ve: sus destinos de siempre. Dos toques y cero letras.">
              {cliente('destino', { origen: mercado, sugeridos: SUGERIDOS })}
            </Marco>

            <Marco titulo="Pedir · escribiendo" descripcion="Quien sabe a dónde va y escribe rápido, pulsa «escribir otro destino».">
              {cliente('destino', { origen: mercado, destino: catedral, escribiendo: true })}
            </Marco>

            <Marco
              titulo="Pedir · con taxis cerca"
              descripcion="Un conteo por zona, nunca posiciones: contesta «¿voy a conseguir taxi?» antes de pedir, que hoy cuesta 90 s de espera. Nada de puntos que seguir en un mapa."
            >
              {cliente('destino', {
                origen: mercado,
                sugeridos: SUGERIDOS,
                taxisCerca: {
                  zona: 'Malabo Centro', zonaId: 1, disponibles: 4, enTuZona: 2,
                  contadoEn: new Date().toISOString(),
                },
              })}
            </Marco>

            <Marco
              titulo="Pedir · sin ningún taxi"
              descripcion="Se dice antes de pulsar, no después de 90 segundos esperando. Y se deja pedir igual: la decisión es suya."
            >
              {cliente('destino', {
                origen: mercado,
                sugeridos: SUGERIDOS,
                taxisCerca: {
                  zona: 'Malabo Centro', zonaId: 1, disponibles: 0, enTuZona: 0,
                  contadoEn: new Date().toISOString(),
                },
              })}
            </Marco>

            <Marco titulo="Pedir · sin GPS" descripcion="Si no hay ubicación, pide la referencia exacta. Es el respaldo, no un error.">
              {cliente('destino', { destino: catedral, hayCoordenadas: false })}
            </Marco>

            <Marco titulo="Buscando · recién pedido" descripcion="Los primeros segundos, salir se llama «deshacer» y se ve. Un toque sin querer no cuesta nada.">
              {cliente('esperando', { detalle: solicitud({ estado: 'EMITIDO' }), puedeDeshacer: true })}
            </Marco>

            <Marco titulo="Buscando" descripcion="Pasado ese rato, cancelar vuelve a ser discreto para no competir con la espera.">
              {cliente('esperando', { detalle: solicitud({ estado: 'EMITIDO' }) })}
            </Marco>

            <Marco titulo="Sin taxi" descripcion="Respuesta en menos de 5 s si no hay nadie conectado en la zona.">
              {cliente('sin_taxi')}
            </Marco>

            <Marco titulo="Taxi asignado" descripcion="Matrícula grande, coche, nombre y nota. Abajo, los segundos que quedan para cancelar gratis.">
              {cliente('asignado', { detalle: solicitud(), segundosGracia: 47 })}
            </Marco>

            <Marco titulo="Pasado el minuto" descripcion="Cuando la gracia vence se dice lo que cuesta cancelar, en vez de callarlo.">
              {cliente('asignado', { detalle: solicitud({ graciaCancelacionSeg: 0 }), segundosGracia: 0 })}
            </Marco>

            <Marco titulo="De camino" descripcion="El taxista ya salió. Le queda 1 minuto.">
              {cliente('asignado', {
                detalle: solicitud({
                  estado: 'EN_CAMINO',
                  taxi: { lat: 3.7535, lng: 8.7748, etaMin: 1, distanciaM: 210, frescuraSeg: 8 },
                }),
              })}
            </Marco>

            <Marco titulo="A bordo · compartido" descripcion="Ya dentro, con otras dos personas. Ve la ruta y su parada marcada.">
              {cliente('asignado', {
                detalle: solicitud({
                  estado: 'RECOGIDO',
                  taxi: { lat: 3.7548, lng: 8.7741, etaMin: 6, distanciaM: 1450, frescuraSeg: 10 },
                  compartido: {
                    pasajerosABordo: 3,
                    plazas: 4,
                    ruta: [
                      {
                        destino: 'Hospital General de Malabo', esTuya: false, estado: 'RECOGIDO',
                        lat: 3.7556, lng: 8.7883,
                      },
                      {
                        destino: catedral.nombre, esTuya: true, estado: 'RECOGIDO',
                        lat: catedral.lat, lng: catedral.lng,
                      },
                      {
                        destino: 'Mercado SEMU', esTuya: false, estado: 'RECOGIDO',
                        lat: 3.7584, lng: 8.7655,
                      },
                    ],
                  },
                }),
              })}
            </Marco>

            <Marco titulo="Fin y valoración" descripcion="Se cierra solo al bajarse. Cinco estrellas de un toque; no se pide precio.">
              {cliente('gracias', { detalle: solicitud({ estado: 'COMPLETADO' }) })}
            </Marco>

            <Marco titulo="Cancelado tarde" descripcion="Pasado el minuto de gracia, cancelar deja un aviso.">
              {cliente('destino', {
                origen: mercado,
                aviso: 'Cancelado. Cancelar tarde a menudo bloquea el servicio.',
              })}
            </Marco>

            <Marco titulo="Ajustes" descripcion="Nombre, edad y género: opcionales, nunca hacen falta para viajar.">
              <HojaSuelta>
                <h1>Tus datos</h1>
                <CampoFalso etiqueta="Teléfono (+240…)" valor="+240 222 555 777" />
                <CampoFalso etiqueta="Correo" valor="ana@ejemplo.gq" />
                <p className="nota">Estos son opcionales:</p>
                <CampoFalso etiqueta="Tu nombre" valor="Ana Bindang" />
                <div className="fila">
                  <CampoFalso etiqueta="Edad" valor="34" />
                  <CampoFalso etiqueta="Género…" valor="Mujer" />
                </div>
                <button type="button" className="principal">Guardar</button>
                <button type="button" className="secundario">Volver</button>
              </HojaSuelta>
            </Marco>

            <Marco titulo="Tus números" descripcion="Historial real: nada estimado.">
              <HojaSuelta>
                <h1>Tus números</h1>
                <div className="rejilla">
                  <Dato valor="12" etiqueta="viajes hechos" />
                  <Dato valor="14" etiqueta="veces que pediste" />
                  <Dato valor="1" etiqueta="sin taxi libre" />
                  <Dato valor="1" etiqueta="cancelaste" />
                </div>
                <p className="nota">A dónde vas más:</p>
                <ul className="ruta">
                  <li>Catedral de Santa Isabel · 5</li>
                  <li>Mercado Central · 4</li>
                  <li>Hospital General de Malabo · 2</li>
                </ul>
                <button type="button" className="secundario">Volver</button>
              </HojaSuelta>
            </Marco>
          </div>
        </section>
      )}

      {rol !== 'cliente' && (
        <section className="galeria-grupo">
          <h2>Taxista</h2>
          <div className="galeria-rejilla">
            <Marco titulo="Alta" descripcion="Nombre, teléfono, correo, matrícula, marca y carrocería.">
              <HojaSuelta>
                <h1>Alta de taxista</h1>
                <p className="nota">
                  El operador comprobará tus datos antes de que empieces a
                  recibir carreras.
                </p>
                <CampoFalso etiqueta="Tu nombre y apellidos" valor="Pablo Ondo" />
                <CampoFalso etiqueta="Teléfono (+240…)" valor="+240 222 700 700" />
                <CampoFalso etiqueta="Matrícula" valor="GE-7007-T" />
                <CampoFalso etiqueta="Marca y modelo" valor="Toyota Land Cruiser" />
                <div className="fila">
                  <button type="button" className="secundario">Turismo</button>
                  <button type="button" className="principal">4x4</button>
                </div>
                <button type="button" className="principal grande">Darme de alta</button>
              </HojaSuelta>
            </Marco>

            <Marco titulo="Pendiente" descripcion="Recién dado de alta: no recibe nada hasta que lo verifiquen.">
              {conductor(null, { verificado: false, estadoVerificacion: 'pendiente', suscripcionVigente: false, saldoXaf: 0 })}
            </Marco>

            <Marco titulo="Sin suscripción" descripcion="Verificado, pero sin cuota al día no entra en el reparto.">
              {conductor(
                estadoConductor({ estado: 'DESCONECTADO', suscripcionVigente: false, saldoXaf: 5000 }),
                { suscripcionVigente: false, saldoXaf: 5000 },
              )}
            </Marco>

            <Marco titulo="Fuera de servicio" descripcion="Todo en orden. Elige zona y entra a trabajar.">
              {conductor(estadoConductor({ estado: 'DESCONECTADO' }))}
            </Marco>

            <Marco titulo="En servicio" descripcion="Esperando carreras. La tira de abajo dice zona, plazas y saldo.">
              {conductor(estadoConductor())}
            </Marco>

            <Marco
              titulo="En servicio, con demanda"
              descripcion="Dónde se está pidiendo taxi, por barrio y nunca por persona: para conducir hacia el trabajo en vez de dar vueltas. Solo aparece estando parado, y se pide una vez por minuto para no gastar datos."
            >
              {conductor(estadoConductor(), {}, undefined, DEMANDA_EJEMPLO)}
            </Marco>

            <Marco titulo="Carrera entrante" descripcion="Origen, destino y precio orientativo antes de decidir. Suena y vibra.">
              {conductor(estadoConductor({
                ofertas: [{
                  solicitudId: 1234,
                  origen: mercado.nombre,
                  destino: catedral.nombre,
                  oleada: 1,
                  expiraEn: null,
                  bandaPrecio: { p25: 1000, p50: 1500, p75: 2000 },
                }],
              }))}
            </Marco>

            <Marco titulo="Voy a recogerlo" descripcion="Aceptada. Aún no ve el teléfono del pasajero.">
              {conductor(estadoConductor({
                plazasLibres: 3,
                pasajeros: [pasajero('ACEPTADO')],
              }))}
            </Marco>

            <Marco titulo="De camino" descripcion="Confirmada la salida: ya puede llamar, y comprobar el número si hay dudas.">
              {conductor(estadoConductor({
                plazasLibres: 3,
                pasajeros: [pasajero('EN_CAMINO')],
              }))}
            </Marco>

            <Marco titulo="Esperando al pasajero" descripcion="Pulsó «he llegado»: reloj en marcha y opción de declarar ausencia.">
              {conductor(estadoConductor({
                plazasLibres: 3,
                pasajeros: [pasajero('EN_CAMINO', {
                  llegadoEn: '2026-07-26T12:00:00Z', relojEsperaSeg: 300,
                })],
              }))}
            </Marco>

            <Marco titulo="Compartido · 3 a bordo" descripcion="Un bloque por pasajero. Con plazas libres sigue recibiendo carreras.">
              {conductor(estadoConductor({
                plazasLibres: 1,
                pasajerosABordo: 3,
                pasajeros: [
                  pasajero('RECOGIDO'),
                  pasajero('RECOGIDO', { destino: 'Hospital General de Malabo' }),
                  pasajero('EN_CAMINO', { destino: 'Mercado SEMU' }),
                ],
              }))}
            </Marco>

            <Marco titulo="Coche lleno" descripcion="Cuatro plazas ocupadas: deja de recibir ofertas hasta que alguien baje.">
              {conductor(estadoConductor({
                estado: 'OCUPADO',
                plazasLibres: 0,
                pasajerosABordo: 4,
                pasajeros: [
                  pasajero('RECOGIDO'),
                  pasajero('RECOGIDO', { destino: 'Hospital General de Malabo' }),
                  pasajero('RECOGIDO', { destino: 'Mercado SEMU' }),
                  pasajero('RECOGIDO', { destino: 'Iglesia de Ela Nguema' }),
                ],
              }))}
            </Marco>

            <Marco titulo="Oferta expirada" descripcion="Los errores del servidor se muestran tal cual: dicen qué pasó.">
              {conductor(
                estadoConductor(),
                {},
                'La solicitud 1234 ya no está disponible: expiró hace 7 segundos.',
              )}
            </Marco>

            <Marco titulo="Recargar · elegir" descripcion="Importes en semanas de suscripción, no en cifras sueltas.">
              <HojaSuelta>
                <h1>Recargar monedero</h1>
                <p className="nota">
                  Tienes <strong>4.500 XAF</strong>. Cada semana de suscripción
                  cuesta 1500 XAF.
                </p>
                <span className="pago-etiqueta">¿Cuánto quieres recargar?</span>
                <div className="importes">
                  {[[1500, 1], [3000, 2], [6000, 4], [12000, 8]].map(([xaf, semanas]) => (
                    <div key={xaf} className={xaf === 3000 ? 'importe elegido-importe' : 'importe'}>
                      <span className="importe-cifra">{xaf.toLocaleString('es-ES')}</span>
                      <span className="importe-semanas">{semanas} semana{semanas === 1 ? '' : 's'}</span>
                    </div>
                  ))}
                </div>
                <span className="pago-etiqueta">¿Cómo vas a pagar?</span>
                <div className="fila">
                  <button type="button" className="principal">Muni Dinero</button>
                  <button type="button" className="secundario">Efectivo</button>
                </div>
                <p className="nota">Enviarás al <strong>555926804</strong> (Taxi Malabo).</p>
                <button type="button" className="principal grande">Continuar</button>
              </HojaSuelta>
            </Marco>

            <Marco titulo="Recargar · pagar" descripcion="Número y referencia grandes, para copiar o dictar. Dice claro que el saldo aún no ha subido.">
              <HojaSuelta>
                <h1>Paga 3000 XAF</h1>
                <div className="pago">
                  <span className="pago-etiqueta">Muni Dinero</span>
                  <span className="pago-numero">555926804</span>
                  <span className="pago-titular">Taxi Malabo</span>
                </div>
                <div className="pago referencia">
                  <span className="pago-etiqueta">Pon esta referencia como concepto</span>
                  <span className="pago-numero">NER-Z8Y</span>
                </div>
                <div className="bloqueo">
                  <span className="bloqueo-titulo">Tu saldo aún no ha subido</span>
                  <p className="nota">
                    Sube cuando comprobemos el ingreso, no al enviarlo. Si
                    tardamos, llama al operador con tu referencia a mano.
                  </p>
                </div>
                <button type="button" className="principal">Ya he pagado</button>
                <button type="button" className="tenue">Volver</button>
              </HojaSuelta>
            </Marco>

            <Marco titulo="Recargar · en efectivo" descripcion="La otra vía: pagar al operador en mano con la misma referencia.">
              <HojaSuelta>
                <h1>Paga 3000 XAF</h1>
                <div className="pago">
                  <span className="pago-etiqueta">En efectivo</span>
                  <span className="pago-titular">
                    Entrega el dinero al operador y dile la referencia.
                  </span>
                </div>
                <div className="pago referencia">
                  <span className="pago-etiqueta">Pon esta referencia como concepto</span>
                  <span className="pago-numero">KTP-4M9</span>
                </div>
                <div className="bloqueo">
                  <span className="bloqueo-titulo">Tu saldo aún no ha subido</span>
                  <p className="nota">Sube cuando el operador registre el dinero.</p>
                </div>
                <button type="button" className="principal">Ya he pagado</button>
              </HojaSuelta>
            </Marco>

            <Marco titulo="Ajustes" descripcion="Puede cambiar coche y carrocería; el teléfono es su identidad y no se toca aquí.">
              <HojaSuelta>
                <h1>Tus datos</h1>
                <p className="nota">
                  Teléfono: +240 222 700 700 (no se puede cambiar aquí: es tu
                  identidad en el sistema).
                </p>
                <CampoFalso etiqueta="Nombre" valor="Pablo Ondo" />
                <CampoFalso etiqueta="Correo" valor="pablo@ejemplo.gq" />
                <CampoFalso etiqueta="Matrícula" valor="GE-7007-T" />
                <CampoFalso etiqueta="Marca y modelo" valor="Toyota Land Cruiser" />
                <div className="fila">
                  <button type="button" className="secundario">Turismo</button>
                  <button type="button" className="principal">4x4</button>
                </div>
                <button type="button" className="secundario">🔔 Avisos sonoros encendidos</button>
                <button type="button" className="principal">Guardar</button>
              </HojaSuelta>
            </Marco>

            <Marco titulo="Tus números" descripcion="Aceptación, nota y monedero. Sin comisiones: solo cuota.">
              <HojaSuelta>
                <h1>Tus números</h1>
                <div className="rejilla">
                  <Dato valor="88" etiqueta="viajes hechos" />
                  <Dato valor="104" etiqueta="carreras ofrecidas" />
                  <Dato valor="85 %" etiqueta="aceptadas" />
                  <Dato valor="4.8" etiqueta="nota (61)" />
                  <Dato valor="2" etiqueta="cancelados por ti" />
                  <Dato valor="3" etiqueta="pasajeros ausentes" />
                </div>
                <p className="nota">
                  Monedero: has recargado 20.000 XAF y pagado 16.500 XAF de
                  suscripción.
                </p>
                <p className="nota">Dónde recoges más:</p>
                <ul className="ruta">
                  <li>Malabo Centro · 41</li>
                  <li>Ela Nguema · 28</li>
                  <li>Semu · 19</li>
                </ul>
                <button type="button" className="secundario">Volver</button>
              </HojaSuelta>
            </Marco>
          </div>
        </section>
      )}
    </main>
  );
}

interface PropiedadesGaleriaCliente {
  sugeridos?: DestinoSugerido[];
  taxisCerca?: TaxisCerca | null;
  escribiendo?: boolean;
  puedeDeshacer?: boolean;
  segundosGracia?: number | null;
  detalle: DetalleSolicitud | null;
  origen: ReferenciaSugerida | null;
  destino: ReferenciaSugerida | null;
  gpsResuelto: boolean;
  hayCoordenadas: boolean;
  valorada: boolean;
  aviso?: string;
}

// Campo de texto solo para mirar: la galería no debe reaccionar a nada.
function CampoFalso({ etiqueta, valor }: { etiqueta: string; valor?: string }) {
  if (valor) {
    return (
      <div className="elegido">
        <span className="elegido-etiqueta">{etiqueta}</span>
        <span className="elegido-valor">{valor}</span>
      </div>
    );
  }
  return <div className="campo-falso">{etiqueta}</div>;
}

function Dato({ valor, etiqueta }: { valor: string; etiqueta: string }) {
  return (
    <div className="dato">
      <span className="dato-valor">{valor}</span>
      <span className="dato-etiqueta">{etiqueta}</span>
    </div>
  );
}
