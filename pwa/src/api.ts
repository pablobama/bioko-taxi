// Cliente de la API. La identidad del cliente es el uuid persistente del
// dispositivo (regla 4.2.4), guardado en localStorage y enviado en la
// cabecera x-dispositivo (o como parámetro en el SSE, que no admite cabeceras).

import { ErrorDeRed, marcarConexionCaida, marcarConexionViva, ErrorDelServidor } from './conexion';

// Solo en localhost: permite fijar la identidad con ?dispositivo=<uuid> para
// poder tener abiertas a la vez la ventana del pasajero y la del taxista
// (localStorage se comparte entre pestañas del mismo navegador).
//
// Fuera de localhost se ignora a propósito. El uuid del dispositivo ES la
// credencial: aceptarlo por URL en producción sería regalar la suplantación de
// cualquiera que comparta un enlace.
export function enPruebasLocales(): boolean {
  return ['localhost', '127.0.0.1'].includes(window.location.hostname);
}

export function uuidDispositivo(): string {
  if (enPruebasLocales()) {
    const forzado = new URLSearchParams(window.location.search).get('dispositivo');
    if (forzado && /^[0-9a-f-]{36}$/i.test(forzado)) {
      localStorage.setItem('dispositivo', forzado.toLowerCase());
      return forzado.toLowerCase();
    }
  }
  let uuid = localStorage.getItem('dispositivo');
  if (!uuid) {
    uuid = crypto.randomUUID();
    localStorage.setItem('dispositivo', uuid);
  }
  return uuid;
}

// El secreto de este dispositivo (migración 069, P15-04). El uuid dice quién
// dices ser; esto es lo que lo demuestra. Se pide una vez y se guarda junto al
// uuid: si se borran los datos del navegador se pierden los dos, y el
// dispositivo vuelve como nuevo, que es lo correcto.
//
// Nota para quien lea esto buscando dónde está el agujero: sigue estando en
// que no es una cuenta. Un teléfono en manos de otro es su sesión, igual que
// su WhatsApp. Esto solo cierra la puerta de «sé tu uuid, luego soy tú».
export function secretoDispositivo(): string | null {
  return localStorage.getItem(`secreto:${uuidDispositivo()}`);
}

// Para las URL de SSE, que no admiten cabeceras. Cadena vacía si no hay
// secreto: la URL queda exactamente como antes.
function sufijoSecreto(): string {
  const secreto = secretoDispositivo();
  return secreto === null ? '' : `&secreto=${encodeURIComponent(secreto)}`;
}

function guardarSecreto(secreto: string): void {
  localStorage.setItem(`secreto:${uuidDispositivo()}`, secreto);
}

// Se llama al arrancar y, por si acaso, antes de cualquier petición que salga
// sin secreto. Si ya hay uno guardado no se pide otro; si el servidor dice que
// ya emitió uno tampoco se insiste: o lo tenemos, o esta sesión se empieza de
// cero.
//
// UNA sola promesa para toda la aplicación. Al abrir salen media docena de
// peticiones a la vez y la emisión tarda su viaje de ida y vuelta: sin esto,
// unas cuantas salían sin secreto contra un servidor que acababa de empezar a
// exigirlo, y se llevaban un 401. Le pasó a la conexión viva del taxista, que
// es la que trae las carreras — se vio probándolo en el navegador.
let emision: Promise<void> | null = null;

// SALIR DEL CALLEJÓN SIN SALIDA DEL SECRETO (migración 069).
//
// Si este navegador lleva un uuid cuyo secreto emitió OTRO —o cuyo secreto
// perdió—, el servidor contesta 401 a TODA petición y la aplicación queda
// muerta. El mensaje decía «vuelve a abrir la aplicación», y volver a abrirla
// no arreglaba nada: el uuid sigue ahí y el secreto sigue sin estar. Era un
// ladrillo con instrucciones falsas.
//
// Se llega ahí sobre todo por el enlace viejo del operador, que metía el uuid
// de otro aparato en este navegador: si aquel uuid ya tenía secreto, éste no
// podía conseguirlo nunca.
//
// La salida es empezar con un uuid nuevo. NO ABRE NINGUNA PUERTA: el uuid
// siempre lo ha puesto el cliente, y borrar los datos del navegador hace
// exactamente esto mismo. Las sanciones no viajan con el uuid sino con el
// teléfono verificado (migraciones 024 y 078), así que esto no sirve para
// quitarse un bloqueo.
//
// Una sola vez por pestaña: si el servidor siguiera contestando 401 después de
// estrenar identidad, el problema es otro y recargar en bucle lo escondería.
const CLAVE_RESCATE = 'secreto:rescatado';

function empezarDeCero(): void {
  try {
    if (sessionStorage.getItem(CLAVE_RESCATE) !== null) return;
    sessionStorage.setItem(CLAVE_RESCATE, '1');
    localStorage.removeItem(`secreto:${uuidDispositivo()}`);
    localStorage.removeItem('dispositivo');
    localStorage.removeItem('ultimaSesion');
    localStorage.removeItem('solicitudActiva');
  } catch {
    // Sin almacenamiento no hay nada que limpiar ni dónde apuntarlo.
    return;
  }
  window.location.replace(window.location.pathname);
}

export function asegurarSecreto(): Promise<void> {
  if (secretoDispositivo() !== null) return Promise.resolve();
  if (emision === null) emision = pedirSecreto();
  return emision;
}

async function pedirSecreto(): Promise<void> {
  try {
    // `fetch` directo y no `pedirJson`: esta es la petición que las demás
    // esperan, y pasar por el mismo sitio sería esperarse a sí misma.
    const respuesta = await fetch('/api/sesion/secreto', {
      method: 'POST',
      headers: { 'x-dispositivo': uuidDispositivo(), 'content-type': 'application/json' },
      body: '{}',
    });
    if (!respuesta.ok) return;
    const { secreto } = await respuesta.json() as { secreto?: string };
    if (secreto) guardarSecreto(secreto);
  } catch {
    // Sin red: se sigue funcionando igual que antes de la migración 069, y se
    // reintenta en la siguiente apertura. Romper el arranque por esto sería
    // dejar a un taxista sin trabajar por una credencial que aún no necesita.
  }
}

interface OpcionesPeticion extends RequestInit {
  // Reintentos extra si la petición muere EN LA RED (nunca si el servidor
  // respondió algo). Los GET reintentan una vez solos; un POST solo si quien
  // lo pide declara que repetirlo es seguro (idempotente en el servidor).
  reintentos?: number;
}

async function pedirJsonUnaVez<T>(ruta: string, opciones: RequestInit): Promise<T> {
  // Si la emisión del secreto está en vuelo, esta petición la espera: salir
  // sin él contra un servidor que ya lo tiene es un 401 seguro.
  if (secretoDispositivo() === null && emision !== null) await emision;
  let respuesta: Response;
  try {
    respuesta = await fetch(ruta, {
      ...opciones,
      headers: {
        'x-dispositivo': uuidDispositivo(),
        // Solo si lo hay: un dispositivo de antes de la migración 069 no
        // tiene, y el servidor no se lo exige.
        ...(secretoDispositivo() !== null ? { 'x-secreto': secretoDispositivo()! } : {}),
        'content-type': 'application/json',
        ...(opciones.headers ?? {}),
      },
    });
  } catch {
    // `fetch` solo lanza cuando la petición NO llegó a ninguna parte: sin
    // cobertura, servidor caído o DNS. Si el servidor contesta —aunque sea con
    // un error— no pasa por aquí. Esa diferencia es la que separa «espera a
    // tener señal» de «esto no se puede hacer», y hasta ahora se perdía: el
    // pasajero acababa leyendo «Failed to fetch».
    marcarConexionCaida();
    throw new ErrorDeRed();
  }
  marcarConexionViva();
  const cuerpo = await respuesta.json().catch(() => ({}));
  if (respuesta.status === 401 && (cuerpo as { codigo?: string }).codigo === 'secreto_invalido') {
    empezarDeCero();
  }
  if (!respuesta.ok) {
    throw new ErrorDelServidor(
      respuesta.status,
      (cuerpo as { error?: string }).error ?? `Error ${respuesta.status}`,
      cuerpo,
    );
  }
  return cuerpo as T;
}

async function pedirJson<T>(ruta: string, opciones: OpcionesPeticion = {}): Promise<T> {
  // Los navegadores reutilizan conexiones dormidas y, cuando una está muerta,
  // reintentan solos los GET — pero JAMÁS un POST. En redes móviles eso se
  // nota muchísimo: rellenas un formulario un minuto, pulsas guardar, y el
  // POST cae en el socket muerto y parece «sin conexión» estando conectado.
  // Aquí se reintenta una vez lo que es seguro reintentar.
  const esGet = !opciones.method || opciones.method === 'GET';
  let restantes = opciones.reintentos ?? (esGet ? 1 : 0);
  for (;;) {
    try {
      return await pedirJsonUnaVez<T>(ruta, opciones);
    } catch (error) {
      if (!(error instanceof ErrorDeRed) || restantes <= 0) throw error;
      restantes -= 1;
      await new Promise((r) => { setTimeout(r, 700); });
    }
  }
}

// Un barrio que sale del buscador sin entrada en el catálogo (28/09).
// Se distingue por `id === null`: antes de poder pedir un taxi hay que darle
// entrada, y eso lo hace `entradaDeZona` al elegirlo.
export interface BarrioSugerido {
  id: null;
  zonaId: number;
  nombre: string;
  zona: string;
  lat: number;
  lng: number;
  categoria: string;
}

export interface ReferenciaSugerida {
  id: number;
  nombre: string;
  zona: string;
  lat: number;
  lng: number;
  categoria: string;
}

// Barrio donde el taxista declara que está trabajando. El centroide sirve para
// ordenarlos por cercanía a donde está de verdad.
export interface Zona {
  id: number;
  nombre: string;
  lat: number;
  lng: number;
}

// Destino que se puede pedir de un toque, sin escribir. `motivo` dice por qué
// se ofrece: si es de los suyos o de los que más se piden desde su zona.
export interface DestinoSugerido extends ReferenciaSugerida {
  motivo: 'tuyo' | 'zona';
}

export interface PuntoMapa {
  id: number;
  nombre: string;
  lat: number;
  lng: number;
  zonaId: number;
  usos: number;
  categoria: string;
}

// --- La consola de despacho (03/10) ----------------------------------------
// Lo que está pasando ahora mismo, en una sola petición: el mapa y las listas
// de al lado tienen que contar lo mismo, y tres peticiones sueltas serían tres
// relojes distintos.

export interface VehiculoRegistro {
  matricula: string;
  marca: string | null;
  carroceria: string | null;
  color: string | null;
  plazas: number | null;
  aire_acondicionado: boolean;
  seguro: boolean;
  conductor_id: number;
  conductor: string;
  conductor_apellido: string | null;
  conductor_telefono: string;
  numero_taxi: string | null;
  dueno: string | null;
  dueno_apellido: string | null;
  dueno_dip: string | null;
}

export interface PropietarioRegistro {
  id: number;
  nombre: string;
  apellido: string;
  telefono: string;
  dip: string;
  creado_en: string;
  coches: number;
  matriculas: string[];
}

// La ficha de un propietario: sus datos y toda su flota (09/10), cada coche
// con el taxista que lo conduce.
export interface FichaPropietarioOperador {
  propietario: {
    id: number; nombre: string; apellido: string; telefono: string;
    dip: string; creado_en: string;
  };
  vehiculos: Array<{
    matricula: string; marca: string | null; carroceria: string | null;
    color: string | null; plazas: number | null;
    conductor_id: number; conductor: string; conductor_apellido: string | null;
    numero_taxi: string | null; estado_verificacion: string;
  }>;
}

export interface TaxiVivo {
  conductor_id: number;
  nombre: string;
  // Para que la tarjeta del mapa pueda llamarle sin ir a buscar la ficha.
  telefono: string;
  numero_taxi: string | null;
  matricula: string | null;
  estado: string;
  zona: string | null;
  // Sin posición cuando el taxi está en servicio pero todavía no ha mandado
  // ninguna miga de rastro. Se enseña igual: un taxi en servicio del que no se
  // sabe dónde está es justo el que hay que mirar.
  lat: number | null;
  lng: number | null;
  visto_hace_seg: number | null;
  latido_hace_seg: number | null;
  solicitud_id: number | null;
}

// Dónde se pidió taxi hace poco y murió sin oferta (06/10): los puntos
// apagados del mapa — la demanda que no se está sirviendo.
export interface SinOfertaViva {
  id: number;
  creada_en: string;
  telefono_cliente: string | null;
  hace_seg: number;
  origen: string;
  origen_lat: number;
  origen_lng: number;
  destino: string;
}

export interface ViajeVivo {
  id: number;
  estado: string;
  creada_en: string;
  telefono_cliente: string | null;
  espera_seg: number;
  origen: string;
  origen_lat: number;
  origen_lng: number;
  destino: string;
  destino_lat: number;
  destino_lng: number;
  conductor_id: number | null;
  conductor: string | null;
  matricula: string | null;
}

// Un viaje terminado al que le falta la valoración del pasajero (P7-03).
export interface ValoracionPendiente {
  solicitudId: number;
  conductor: string;
  destino: string;
  cuando: string;
  // Tres importes de un toque, sacados de la banda de esa ruta. Vacío si la
  // ruta no tiene banda: entonces no se pregunta el precio, porque inventarse
  // las cifras sería sugerirle un precio.
  importesSugeridos: number[];
}

export interface Reputacion {
  media: number | null;
  valoraciones: number;
  viajesCompletados: number;
}

export interface DetalleSolicitud {
  solicitudId: number;
  viajeId: number | null;
  estado: string;
  origen: string;
  origenLat: number;
  origenLng: number;
  destino: string;
  destinoLat: number;
  destinoLng: number;
  expiraEn: string | null;
  // Segundos que quedan para cancelar sin que cueste un aviso. Lo calcula el
  // servidor, que es quien decide el plazo, y viene como «cuánto falta» y no
  // como instante de vencimiento: el reloj de un móvil barato se desajusta.
  // null mientras se busca taxi, donde cancelar es gratis siempre.
  graciaCancelacionSeg: number | null;
  // El taxista pulsó «he llegado»: no depende del GPS del pasajero.
  taxiHaLlegado: boolean;
  // Migración 046: si el punto de recogida es la posición real con la que se
  // pidió el taxi, o el sitio del catálogo más cercano, y a cuántos metros
  // queda uno de otro.
  recogidaEnGps: boolean;
  metrosDeLaReferencia: number | null;
  // Posición del coche acercándose y tiempo estimado. null si el conductor no
  // ha enviado posición reciente: el tiempo es aproximado, no una promesa.
  taxi: { lat: number; lng: number; etaMin: number; distanciaM: number; frescuraSeg: number } | null;
  // Ya a bordo: cuánto falta para llegar al destino (migración 053). Va sin
  // coordenadas a propósito — la posición del taxista deja de enviarse al
  // subir— pero el tiempo sí, que es lo que importa a partir de ahí.
  llegada: { etaMin: number; distanciaM: number } | null;
  reputacion: Reputacion | null;
  // El coche que se eligió al pedir (migración 062), si se eligió alguno.
  // Elegir es una preferencia, no una reserva: si el elegido no coge la
  // carrera en veinte segundos empieza el reparto normal. Esto es lo que
  // permite CONTARLO en vez de que aparezca otro coche sin explicación.
  elegido: {
    nombre: string;
    matricula: string | null;
    estado: 'esperando' | 'es_el_tuyo' | 'no_la_cogio';
  } | null;
  conductor: string | null;
  matricula: string | null;
  marca: string | null;
  color: string | null;
  aireAcondicionado: boolean;
  seguro: boolean;
  pin: string | null;
  // Taxi compartido: con cuánta gente vas y por dónde pasa el coche. De los
  // demás pasajeros solo se conoce su parada, nunca quiénes son.
  compartido: {
    pasajerosABordo: number;
    plazas: number;
    ruta: Array<{
      destino: string; esTuya: boolean; estado: string; lat: number; lng: number;
    }>;
  } | null;
}

export interface Perfil {
  telefono: string | null;
  correo: string | null;
  nombre: string | null;
  edad: number | null;
  genero: string | null;
  // Migración 027: false si hay teléfono y no se confirmó por SMS. Sin
  // teléfono (solo correo) siempre es true — no hay nada que verificar.
  telefonoVerificado: boolean;
  // Pasajero con papel de campo (migración 072): puede situar barrios y
  // corregir sitios, igual que un taxista agente. Lo da el operador.
  agente?: boolean;
}

export interface DatosConductor {
  nombre: string;
  telefono: string;
  correo: string | null;
  verificado: boolean;
  telefonoVerificado: boolean;
  estadoVerificacion: string;
  suscritoHasta: string | null;
  suscripcionVigente: boolean;
  saldoXaf: number;
  matricula: string | null;
  marca: string | null;
  color: string | null;
  carroceria: string | null;
  plazas: number | null;
  aireAcondicionado: boolean;
  seguro: boolean;
  // Agente de campo (migración 025): mismo panel de taxi, más las herramientas
  // para situar barrios, corregir sitios y fijar precios.
  agente?: boolean;
  reputacion: Reputacion;
}

export interface Sesion {
  rol: 'cliente' | 'conductor' | 'operador' | null;
  cliente?: Perfil & { bloqueado: boolean };
  conductor?: DatosConductor;
}

// Quién puede entrar al panel. Los de la raíz vienen marcados y sin fecha: no
// son una fila de la base, están en la variable de entorno.
// Los permisos de un operador (migración 090). Bloques acumulables; sin
// ninguno, solo consulta.
export type PermisoOperador = 'despacho' | 'taxistas' | 'suscripciones' | 'catalogo';

export interface AccesoOperador {
  telefono: string;
  nombre: string | null;
  raiz: boolean;
  // Los permisos del operador (migración 090). La raíz los tiene todos. Lo
  // rellena la fase 3 (el panel de accesos); opcional hasta entonces.
  roles?: PermisoOperador[];
  alta_por: string | null;
  creado_en: string | null;
  aparatos: number;
}

export interface AparatoOperador {
  uuid: string;
  creado_en: string;
  visto_en: string | null;
}

export interface ConductorOperador {
  id: number;
  nombre: string;
  telefono: string;
  correo: string | null;
  estado_verificacion: string;
  // El número de flota (migración 084): A013. Para siempre.
  numero_taxi: string | null;
  // Para ordenar la bandeja por antigüedad: la edad de un alta es su fecha.
  fecha_alta: string;
  matricula: string | null;
  marca: string | null;
  color: string | null;
  carroceria: string | null;
  aire_acondicionado: boolean;
  seguro: boolean;
}

export interface EstadisticasOperador {
  conductores: {
    total: number; pendientes: number; verificados: number;
    suspendidos: number; bloqueados: number;
  };
  enServicioAhora: number;
  solicitudes: { total: number; completadas: number; sin_taxi: number; ultimas_24h: number };
  pasajeros: number;
  saldoTotalMonederosXaf: number;
  incidenciasPendientes: number;
  recargasPendientes: number;
}

export interface ViajeResumenOperador {
  id: number;
  estado: string;
  creada_en: string;
  origen: string;
  destino: string;
  conductor?: string | null;
}

export interface PropietarioFicha {
  id: number;
  nombre: string;
  apellido: string;
  telefono: string;
  dip: string;
}

export interface FichaConductorOperador {
  id: number;
  nombre: string;
  // Apellido y DIP (migración 087). Null en fichas de antes.
  apellido: string | null;
  dip: string | null;
  telefono: string;
  correo: string | null;
  estado_verificacion: string;
  numero_taxi: string | null;
  suscrito_hasta: string | null;
  suscripcionVigente: boolean;
  matricula: string | null;
  marca: string | null;
  color: string | null;
  carroceria: string | null;
  plazas: number | null;
  aire_acondicionado: boolean;
  seguro: boolean;
  es_agente: boolean;
  // Migración 048: recibe solicitudes de toda la isla, en la última oleada.
  recibe_en_cualquier_zona: boolean;
  presencia: string | null;
  saldo_xaf: number;
  reputacion: { media: number | null; valoraciones: number };
  viajes: { completados: number; cancelados: number; ausencias: number; aceptados: number };
  ofertas: { recibidas: number; aceptadas: number; rechazadas: number };
  ultimosViajes: ViajeResumenOperador[];
  recargas: Array<{
    id: number; importeXaf: number; metodo: string; referencia: string;
    estado: string; solicitadaEn: string;
  }>;
  // El dueño del coche (migración 087). Null si aún no se ha registrado.
  propietario: PropietarioFicha | null;
  // Si tiene foto subida (migración 088), para decidir si pedirla.
  tiene_foto: boolean;
}

export interface PasajeroOperador {
  dispositivo_id: number;
  telefono: string | null;
  correo: string | null;
  nombre: string | null;
  strikes: number;
  bloqueado_en: string | null;
  creado_en: string;
  viajes: number;
}

export interface FichaPasajeroOperador {
  dispositivo_id: number;
  // Papel de campo (migración 072): puede situar barrios y corregir sitios.
  es_agente?: boolean;
  telefono: string | null;
  correo: string | null;
  nombre: string | null;
  edad: number | null;
  genero: string | null;
  strikes: number;
  bloqueado_en: string | null;
  creado_en: string;
  viajes: { pedidos: number; completados: number; cancelados: number; ausencias: number };
  ultimosViajes: ViajeResumenOperador[];
}

export interface IncidenciaOperador {
  id: number;
  tipo: string;
  descripcion: string | null;
  creada_en: string;
  resuelta_por: string | null;
  resuelta_en: string | null;
  resolucion: string | null;
  solicitud_id: number;
  estado_viaje: string;
  telefono_cliente: string;
  dispositivo_cliente_id: number;
  strikes: number;
  bloqueado_en: string | null;
  conductor: string;
  origen: string;
  destino: string;
}

export interface TransicionOperador {
  estado_anterior: string | null;
  estado_nuevo: string;
  actor: string;
  creado_en: string;
}

export interface RecargaOperador {
  id: number;
  referencia: string;
  importe_xaf: number;
  metodo: 'muni_dinero' | 'efectivo';
  estado: string;
  solicitada_en: string;
  resuelta_en: string | null;
  resuelta_por: string | null;
  nota: string | null;
  conductor_id: number;
  conductor_nombre: string;
  conductor_telefono: string;
}

export interface AlarmaOperador {
  clave: string;
  nombre: string;
  ambito: string;
  umbral: number | null;
  disparada: boolean;
  detalle: Array<{ nombre: string; muestras: number; tasa: number }>;
}

export interface SaludOperador {
  taxisPorZona: Array<{ zona: string; taxis: number; disponibles: number }>;
  viajesEnCurso: Array<{ estado: string; n: number }>;
  alarmas: AlarmaOperador[];
}

export interface SolicitudCentral {
  id: number;
  estado: string;
  creada_en: string;
  telefono_cliente: string;
  origen: string;
  destino: string;
  conductor: string | null;
  matricula: string | null;
}

// «Mírame llegar» (migración 043). Lo que ve quien sigue el viaje: menos que
// el pasajero a propósito — ni teléfonos, ni PIN de recogida, ni precio.
export interface ViajeSeguido {
  estado: string;
  enMarcha: boolean;
  origen: string;
  destino: string;
  destinoLat: number;
  destinoLng: number;
  posicion: { lat: number; lng: number; de: 'pasajero' | 'taxi'; frescuraSeg: number } | null;
  // Cuánto falta para llegar al destino. null si aún no hay posición o si el
  // viaje terminó.
  etaMin: number | null;
  distanciaM: number | null;
  conductor: string | null;
  matricula: string | null;
  marca: string | null;
  color: string | null;
  expiraEn: string;
}

export interface EstadoSeguimiento {
  activo: boolean;
  expiraEn: string | null;
  visitas: Array<{ telefono: string; primeraEn: string; ultimaEn: string }>;
}

// Por dónde anduvo un taxi (migración 042). Ventanas móviles hacia atrás
// desde ahora, no días de calendario: «el mes» a primera hora del día 1 no
// puede ser una pantalla en blanco.
export type PeriodoRecorrido = 'dia' | 'semana' | 'mes';

export interface RecorridoOperador {
  periodo: PeriodoRecorrido;
  desde: string;
  hasta: string;
  // Puntos que hay de verdad, antes de aligerar para dibujarlos.
  puntos: number;
  metros: number;
  // Cuántos clientes llevó en el periodo: carreras completadas.
  clientesLlevados: number;
  // Tiempo en servicio del periodo. Sale del registro de estados y no del
  // rastro: el rastro tiene agujeros y le quitaría horas trabajadas.
  segundosEnServicio: number;
  // De ese turno, cuánto con el coche andando (migración 051). Las dos cifras
  // juntas son las que dicen si el turno fue de trabajo o de espera.
  segundosEnMovimiento: number;
  // Kilómetros por hora de TURNO, no de conducción: incluye el rato parado
  // esperando. null si el turno es demasiado corto para que la media diga algo.
  velocidadMediaKmh: number | null;
  // Kilómetros por hora de CONDUCCIÓN: los mismos metros entre el tiempo que
  // el coche estuvo moviéndose. Las dos contestan preguntas distintas —si
  // cunde el día, y a qué velocidad se circula por Malabo— y la primera se
  // hunde con cada minuto de espera, que para un taxista es media jornada.
  velocidadAlVolanteKmh: number | null;
  // Tramos, no puntos sueltos: entre dos tramos hay un hueco de verdad.
  // `n` es cuántas veces pasó el taxi por ahí en el periodo: es lo que
  // colorea el mapa de calor, de azul (una vez) a rojo (lo que más repite).
  tramos: Array<Array<{ lat: number; lng: number; n: number }>>;
  maxPasadas: number;
  // Un renglón por salida: el mapa dice POR DÓNDE anduvo, esto dice CUÁNDO y
  // cuánto. Son las dos mitades de la misma pregunta y ninguna sustituye a la
  // otra: con el dibujo no se contrasta una queja con hora, y con la tabla no
  // se ve que todas las salidas pasan por la misma calle.
  salidas: SalidaRecorrido[];
}

export interface SalidaRecorrido {
  desde: string;
  hasta: string;
  segundos: number;
  metros: number;
  // Estuvo ahí pero no se movió: la espera en la parada. No es un hueco —de
  // eso no hay fila— y mezclarlos escondería las esperas, que son media
  // jornada de un taxista.
  parado: boolean;
}

// Una carrera, como se lee en la tabla del operador. Crudo del servidor, en
// snake_case, igual que las incidencias.
export interface ViajeOperador {
  id: number;
  estado: string;
  // Para enlazar con las fichas (08/10): el taxista y el dispositivo del
  // cliente. Nulos si la carrera no llegó a tener taxi, o si quien la pidió
  // fue el operador por teléfono sin dispositivo de cliente detrás.
  conductor_id: number | null;
  dispositivo_id: number | null;
  creada_en: string;
  cerrada_en: string | null;
  // Cuándo subió el cliente y cuándo bajó (06/10). Nulos si la carrera no
  // llegó a ese punto: una cancelada no tiene recogida que contar.
  recogido_en: string | null;
  bajada_en: string | null;
  emitido_en: string | null;
  // La zona del origen y la del destino, del catálogo: cada referencia vive
  // en una. No se guarda aparte porque ya está dicho.
  zona_recogida: string;
  zona_bajada: string;
  telefono_cliente: string | null;
  precio_xaf: number | null;
  origen: string;
  destino: string;
  conductor: string | null;
  matricula: string | null;
}

export interface ZonaOperador {
  id: number;
  nombre: string;
  // Migración 029: agrupación puramente organizativa, no afecta al reparto.
  // null en lo que no se pudo confirmar con una fuente — no es un error.
  distrito: 'Malabo' | 'Baney' | 'Luba' | 'Riaba' | null;
  // Migración 033: distrito urbano oficial, por su nombre de uso. Otra
  // etiqueta organizativa — el reparto sigue siendo por barrio.
  distrito_urbano: string | null;
  // Migración 031: null = esta fila ES un distrito urbano (la zona de
  // siempre, unidad de reparto). Con valor: es un barrio/calle dentro de
  // ese distrito urbano, sin adyacencia propia — solo para clasificar
  // lugares con más precisión.
  zona_padre_id: number | null;
  // Migración 041: la zona que hace de cabecera de su distrito urbano. Solo
  // hay siete, y son las únicas de las que se puede colgar un barrio o una
  // calle — lo demás son barrios, por mucho que estén al primer nivel.
  es_cabecera_urbana: boolean;
  lat: number | null;
  lng: number | null;
  sin_situar: boolean;
  // Radio de error del GPS con el que se situó, en metros. null en las que
  // vinieron del importador: no se sabe con qué precisión se tomaron.
  precision_m: number | null;
  referencias: number;
  vecinas: number;
}

export interface ReferenciaOperador {
  id: number;
  nombre: string;
  lat: number;
  lng: number;
  categoria: string;
  activa: boolean;
  usos: number;
  zona_id: number;
  zona: string;
  alias: string[];
  // Migración 038: metros de radio del GPS con el que se fijó. null = se
  // puso a mano, sin verificar sobre el terreno.
  precision_m: number | null;
}

export interface BandaOperador {
  id: number;
  zona_origen_id: number;
  zona_destino_id: number;
  zona_origen: string;
  zona_destino: string;
  p25: number;
  p50: number;
  p75: number;
  actualizada_en: string;
}

export interface ParametroOperador {
  clave: string;
  valor: string;
  descripcion: string | null;
}

// Un cambio de precio o de parámetro, con nombre y hora (migración 067).
export interface CambioOperador {
  id: number;
  ambito: string;
  clave: string;
  antes: string | null;
  ahora: string | null;
  quien: string;
  cuando: string;
}

// Cobertura agregada (migración 023). Conteos por zona, nunca posiciones.
// Un coche que podría venir, para elegirlo (migración 062). Sin posiciones:
// qué coche es, cómo lo valoran y cuánto tardaría.
export interface TaxiElegible {
  conductorId: number;
  marca: string | null;
  color: string | null;
  carroceria: string | null;
  plazas: number;
  aireAcondicionado: boolean;
  seguro: boolean;
  valoracion: number | null;
  valoraciones: number;
  etaMin: number | null;
  distanciaM: number | null;
  enTuZona: boolean;
}

export interface TaxisCerca {
  zona: string;
  zonaId: number;
  disponibles: number;
  enTuZona: number;
  contadoEn: string;
}

export interface ZonaConDemanda {
  zona: string;
  zonaId: number;
  pedidas: number;
  sinTaxi: number;
  taxisAhora: number;
}

export interface AltaConductor {
  nombre: string;
  telefono: string;
  correo?: string;
  matricula: string;
  marca: string;
  carroceria: 'turismo' | '4x4' | 'furgoneta' | 'autobus';
  color?: string;
  aireAcondicionado?: boolean;
  seguro?: boolean;
}

export interface OfertaConductor {
  solicitudId: number;
  origen: string;
  destino: string;
  oleada: number;
  expiraEn: string | null;
  bandaPrecio: { p25: number; p50: number; p75: number } | null;
  // Lo que cuesta el desvío cuando ya se lleva a alguien dentro (migración
  // 071). null con el coche vacío: entonces no hay desvío, hay carrera.
  desvio: { retrasoMin: number; esperaMin: number; metros: number } | null;
}

export interface PasajeroConductor {
  solicitudId: number;
  viajeId: number;
  estado: string;
  origen: string;
  origenLat: number;
  origenLng: number;
  destino: string;
  destinoLat: number;
  destinoLng: number;
  telefonoCliente: string | null;
  llegadoEn: string | null;
  relojEsperaSeg: number;
  // Migración 046: si el punto de recogida es la posición real con la que
  // pidió el taxi (true) o el sitio del catálogo más cercano (false), y a
  // cuántos metros está uno del otro. Sin esto, el taxista veía un pin y no
  // podía saber si era la persona o un supermercado a 90 m.
  recogidaEnGps: boolean;
  metrosDeLaReferencia: number | null;
  // Dónde está el pasajero de verdad mientras espera. null si no comparte
  // ubicación o si ya va a bordo.
  posicionCliente: { lat: number; lng: number; frescuraSeg: number } | null;
  // Cuánto le falta al taxista para llegar a su siguiente punto con este
  // pasajero: a recogerlo, o a su destino si ya va dentro (migración 053).
  // null si no ha mandado posición todavía.
  etaMin: number | null;
  distanciaM: number | null;
}

export interface EstadoConductor {
  estado: string;
  zonaId: number | null;
  zona: string | null;
  saldoXaf: number;
  suscritoHasta: string | null;
  suscripcionVigente: boolean;
  plazas: number;
  plazasLibres: number;
  pasajerosABordo: number;
  ofertas: OfertaConductor[];
  pasajeros: PasajeroConductor[];
}

export const api = {
  sesion: () => pedirJson<Sesion>('/api/sesion'),

  altaConductor: (datos: AltaConductor) =>
    pedirJson<{ conductorId: number; estadoVerificacion: string; aviso: string | null }>(
      '/api/conductor/alta',
      { method: 'POST', body: JSON.stringify(datos) },
    ),

  estadisticas: () => pedirJson<Record<string, any>>('/api/estadisticas'),

  // --- Verificación de teléfono (migración 027) -----------------------------

  enviarCodigoVerificacion: (canal: 'sms' | 'llamada' = 'sms') =>
    pedirJson<{ enviado: boolean; motivo?: string }>('/api/verificacion/enviar', {
      method: 'POST',
      body: JSON.stringify({ canal }),
    }),

  comprobarCodigoVerificacion: (codigo: string) =>
    pedirJson<{ verificado: boolean }>('/api/verificacion/comprobar', {
      method: 'POST',
      body: JSON.stringify({ codigo }),
    }),

  // --- Volver a entrar con el teléfono (migración 078) ----------------------
  //
  // El paso previo de las dos altas. `buscar` dice si hay algo con ese número;
  // si lo hay, `pedirCodigo` manda el SMS y `reclamar` devuelve la cuenta. El
  // teléfono se manda crudo: el servidor lo normaliza y devuelve la forma
  // canónica, que es la que se usa en los dos pasos siguientes.

  buscarCuenta: (telefono: string) =>
    pedirJson<{ conductor: boolean; cliente: boolean; telefono: string }>(
      '/api/cuenta/buscar',
      { method: 'POST', body: JSON.stringify({ telefono }) },
    ),

  // `canal`: por dónde llega el código. Por SMS salvo que se pida la llamada,
  // que es lo que salva a las líneas a las que el SMS no llega (migración 081).
  pedirCodigoCuenta: (telefono: string, canal: 'sms' | 'llamada' = 'sms') =>
    pedirJson<{ enviado: boolean; canal: 'sms' | 'llamada' }>('/api/cuenta/codigo', {
      method: 'POST',
      body: JSON.stringify({ telefono, canal }),
    }),

  reclamarCuenta: (telefono: string, codigo: string, rol: 'conductor' | 'cliente') =>
    pedirJson<{ rol: 'conductor' | 'cliente'; nombre: string | null }>('/api/cuenta/reclamar', {
      method: 'POST',
      body: JSON.stringify({ telefono, codigo, rol }),
    }),

  // --- Conductor -----------------------------------------------------------

  registroConductor: (telefono: string) =>
    pedirJson<{ conductorId: number; nombre: string; estado: string }>('/api/conductor/registro', {
      method: 'POST',
      body: JSON.stringify({ telefono }),
    }),

  estadoConductor: () => pedirJson<EstadoConductor>('/api/conductor/estado'),

  // El barrio no se elige: lo decide dónde está el coche. Se mandan las
  // coordenadas y el servidor dice en qué barrio queda.
  servicio: (enServicio: boolean, coordenadas?: { lat: number; lng: number } | null) =>
    pedirJson<{ enServicio: boolean; zonaId: number | null; zona: string | null }>(
      '/api/conductor/servicio',
      { method: 'POST', body: JSON.stringify({ enServicio, ...(coordenadas ?? {}) }) },
    ),

  heartbeat: (coordenadas: Posicion | null) =>
    // `avisoTurnoHoras`: horas que lleva en servicio, cuando toca recordárselo
    // (migración 049). null la mayoría de los latidos.
    pedirJson<{ estado: string; saldoXaf: number; avisoTurnoHoras: number | null }>(
      '/api/conductor/heartbeat',
      { method: 'POST', body: JSON.stringify(coordenadas ?? {}) },
    ),

  // El recorrido apuntado sin cobertura (migración 051). Va aparte del latido:
  // el latido tiene que ser barato y salir cada veinte segundos, y esto es un
  // lote que solo aparece cuando vuelve la red.
  subirRastro: (puntos: Array<{
    lat: number; lng: number; en: string;
    precision: number | null; velocidad?: number | null;
  }>) =>
    pedirJson<{ recibidos: number; guardados: number; descartados: number }>(
      '/api/conductor/rastro',
      { method: 'POST', body: JSON.stringify({ puntos }) },
    ),

  // Notificaciones que suenan con la aplicación cerrada (migración 058).
  // El mismo mecanismo para el PASAJERO (migración 076). Rutas distintas
  // porque a él se le identifica por su teléfono y no por una ficha de
  // taxista, y se le pide el permiso en otro momento: cuando oye «no hay taxi».
  clavePushCliente: () =>
    pedirJson<{ clavePublica: string }>('/api/notificaciones/clave'),

  guardarPushCliente: (suscripcion: {
    endpoint: string; claves: { p256dh: string; auth: string };
  }) =>
    pedirJson<{ guardada: boolean }>('/api/notificaciones', {
      method: 'POST', body: JSON.stringify(suscripcion), reintentos: 1,
    }),

  borrarPushCliente: (endpoint: string) =>
    pedirJson<{ borrada: boolean }>('/api/notificaciones', {
      method: 'DELETE', body: JSON.stringify({ endpoint }), reintentos: 1,
    }),

  clavePush: () =>
    pedirJson<{ clavePublica: string }>('/api/conductor/notificaciones/clave'),

  guardarPush: (suscripcion: {
    endpoint: string; claves: { p256dh: string; auth: string };
  }) =>
    pedirJson<{ guardada: boolean }>('/api/conductor/notificaciones', {
      method: 'POST',
      body: JSON.stringify(suscripcion),
    }),

  borrarPush: (endpoint: string) =>
    pedirJson<{ borrada: boolean }>('/api/conductor/notificaciones', {
      method: 'DELETE',
      body: JSON.stringify({ endpoint }),
    }),

  recargas: () =>
    pedirJson<{
      minimoXaf: number;
      muniDinero: { numero: string; titular: string };
      sugeridos: number[];
      recargas: Array<{
        id: number; importeXaf: number; metodo: string; referencia: string;
        estado: string; solicitadaEn: string; nota: string | null;
      }>;
    }>('/api/conductor/recargas'),

  pedirRecarga: (importeXaf: number, metodo: 'muni_dinero' | 'efectivo') =>
    pedirJson<{
      referencia: string;
      importeXaf: number;
      metodo: string;
      estado: string;
      instrucciones: { numero: string | null; titular: string | null; concepto: string; texto: string };
    }>('/api/conductor/recargas', {
      method: 'POST',
      body: JSON.stringify({ importeXaf, metodo }),
    }),

  suscribir: () =>
    pedirJson<{ suscritoHasta: string; saldoXaf: number }>('/api/conductor/suscripcion', {
      method: 'POST',
      body: '{}',
    }),

  // Una acción que se hizo sin red y se manda ahora (migración 057). Genérica a
  // propósito: la bandeja guarda la ruta y el cuerpo tal cual se iban a mandar.
  enviarPendiente: (ruta: string, cuerpo: Record<string, unknown>) =>
    pedirJson<Record<string, unknown>>(ruta, { method: 'POST', body: JSON.stringify(cuerpo) }),

  accionPasajero: (
    solicitudId: number,
    accion: 'aceptar' | 'rechazar' | 'salir' | 'he-llegado' | 'cliente-ausente' | 'recoger' | 'completar',
    cuerpo: Record<string, unknown> = {},
  ) =>
    pedirJson<Record<string, unknown>>(`/api/conductor/solicitudes/${solicitudId}/${accion}`, {
      method: 'POST',
      body: JSON.stringify(cuerpo),
    }),

  perfil: () =>
    pedirJson<{ registrado: boolean; perfil: Perfil | null; bloqueado: boolean }>('/api/perfil'),

  // --- «Mírame llegar» (migración 043) -------------------------------------
  //
  // El cuerpo vacío va como '{}' y no omitido: `pedirJson` manda siempre
  // content-type JSON, y Fastify rechaza con un 400 un POST que lo declare y
  // llegue sin nada.

  compartirViaje: (solicitudId: number) =>
    pedirJson<{ token: string; expiraEn: string }>(
      `/api/solicitudes/${solicitudId}/seguimiento`,
      { method: 'POST', body: '{}' },
    ),

  cortarSeguimiento: (solicitudId: number) =>
    pedirJson<{ revocado: boolean }>(
      `/api/solicitudes/${solicitudId}/seguimiento/revocar`,
      { method: 'POST', body: '{}' },
    ),

  estadoSeguimiento: (solicitudId: number) =>
    pedirJson<EstadoSeguimiento>(`/api/solicitudes/${solicitudId}/seguimiento`),

  verSeguimiento: (token: string) =>
    pedirJson<ViajeSeguido>(`/api/seguimiento/${encodeURIComponent(token)}`),

  guardarPerfil: (perfil: Partial<Perfil>) =>
    pedirJson<{ registrado: boolean; perfil: Perfil }>('/api/perfil', {
      method: 'PUT',
      body: JSON.stringify(perfil),
    }),

  buscarReferencias: (q: string) =>
    pedirJson<ReferenciaSugerida[]>(`/api/referencias?q=${encodeURIComponent(q)}`),

  // Los destinos de un toque. Con el origen sabido se completan con los más
  // pedidos desde esa zona, que es lo que salva al usuario nuevo.
  destinosSugeridos: (origenId?: number) =>
    pedirJson<DestinoSugerido[]>(
      `/api/destinos-sugeridos${origenId ? `?origenId=${origenId}` : ''}`,
    ),

  mapa: () => pedirJson<{ referencias: PuntoMapa[]; zonas: unknown[] }>('/api/mapa'),

  // `extras` son las dos respuestas voluntarias de la migración 066: lo que
  // pagó y si le cobraron de más. Van con la nota porque son la misma
  // respuesta, y así la cola sin red las arrastra sin código nuevo.
  valorar: (
    solicitudId: number,
    puntuacion: number,
    extras: { importeXaf?: number; cobroDeMas?: boolean } = {},
  ) =>
    pedirJson<{ guardada: boolean }>(`/api/solicitudes/${solicitudId}/valoracion`, {
      method: 'POST',
      body: JSON.stringify({ puntuacion, ...extras }),
    }),

  // El viaje que cerró sin valorar (P7-03). Se pregunta al abrir, porque quien
  // se baja del taxi cierra la aplicación y antes no se le preguntaba nunca.
  valoracionPendiente: () =>
    pedirJson<{ pendiente: ValoracionPendiente | null }>('/api/valoracion-pendiente'),

  // Un sitio que no está en el catálogo (migración 072). En una ciudad sin
  // direcciones la lista nunca está completa: quien no encuentra el suyo lo
  // escribe, sirve para su viaje desde ese momento, y sale para los demás
  // cuando lo usa gente o cuando un agente lo aprueba.
  //
  // `creada` a false significa que ya existía uno igual ahí al lado y se ha
  // reutilizado, que es el caso bueno: el catálogo no se llena de duplicados.
  // Darle entrada en el catálogo a un barrio que no la tenía (28/09).
  // No es una propuesta: un barrio que está en el mapa existe, y el único
  // motivo de que no estuviera en el buscador es que nadie lo había necesitado.
  entradaDeZona: (zonaId: number) =>
    pedirJson<{ referencia: ReferenciaSugerida }>(`/api/zonas/${zonaId}/entrada`, {
      method: 'POST',
      body: '{}',
      reintentos: 1,
    }),

  proponerSitio: (nombre: string, donde: { lat: number; lng: number } | null, zonaId?: number) =>
    pedirJson<{ creada: boolean; referencia: ReferenciaSugerida }>('/api/referencias', {
      method: 'POST',
      body: JSON.stringify({ nombre, ...(donde ?? {}), ...(zonaId ? { zonaId } : {}) }),
    }),

  // El teléfono lo toma el servidor del perfil; no hace falta enviarlo.
  pedirTaxi: (
    origenId: number,
    destinoId: number,
    coordenadas: { lat: number; lng: number } | null,
    // El coche elegido, si eligió uno (migración 062).
    conductorElegidoId?: number | null,
  ) =>
    pedirJson<{ solicitudId: number; estado: string; yaExistia: boolean }>('/api/solicitudes', {
      method: 'POST',
      body: JSON.stringify({
        origenId,
        destinoId,
        ...(coordenadas ?? {}),
        ...(conductorElegidoId ? { conductorElegidoId } : {}),
      }),
    }),

  estado: (solicitudId: number) =>
    pedirJson<DetalleSolicitud>(`/api/solicitudes/${solicitudId}`),

  // «Ya me bajé»: cierra el viaje en el servidor (21/09). Antes el botón solo
  // limpiaba la pantalla y el taxista seguía con el pasajero a bordo.
  heBajado: (solicitudId: number) =>
    pedirJson<{ terminado: boolean }>(`/api/solicitudes/${solicitudId}/he-bajado`, {
      method: 'POST',
      // Con cuerpo aunque no haga falta: la cabecera dice JSON, y Fastify
      // rechaza con un 400 un POST JSON vacío. Lo encontró la primera prueba
      // en el navegador —el botón «no hacía nada», otra vez—.
      body: '{}',
      // Repetirlo es seguro: un viaje ya cerrado contesta «terminado» igual.
      reintentos: 1,
    }),

  cancelar: (solicitudId: number) =>
    pedirJson<{ estado: string; strike: boolean }>(`/api/solicitudes/${solicitudId}/cancelar`, {
      method: 'POST',
      body: '{}',
    }),

  // `Posicion` incluye `precision`, y viaja: desde la migración 047 es lo que
  // impide que una lectura mala cierre un viaje con la persona todavía dentro.
  enviarPosicion: (solicitudId: number, coordenadas: Posicion) =>
    pedirJson<{ guardada: boolean }>(`/api/solicitudes/${solicitudId}/posicion`, {
      method: 'POST',
      body: JSON.stringify(coordenadas),
    }),

  // --- Llamadas dentro de la aplicación -----------------------------------
  // Solo el apretón de manos: el audio va directo de un teléfono al otro y no
  // pasa por el servidor. Ver llamada.ts.
  enviarSenal: (solicitudId: number, tipo: string, carga: unknown) =>
    pedirJson<{ entregada: boolean }>(`/api/solicitudes/${solicitudId}/senal`, {
      method: 'POST',
      body: JSON.stringify({ tipo, carga }),
    }),

  // Se pide por viaje y no una vez al arrancar: trae credenciales del puente
  // que caducan, y solo las da a quien va en ese viaje.
  configuracionLlamadas: (solicitudId: number) =>
    pedirJson<{ servidores: RTCIceServer[]; hayTurn: boolean }>(
      `/api/solicitudes/${solicitudId}/llamada/configuracion`,
    ),

  // --- Panel de operador ---------------------------------------------------
  conductoresOperador: (estado?: string, q?: string) => {
    const partes = [
      estado ? `estado=${estado}` : '',
      q ? `q=${encodeURIComponent(q)}` : '',
    ].filter(Boolean);
    return pedirJson<{ conductores: ConductorOperador[] }>(
      `/api/operador/conductores${partes.length ? `?${partes.join('&')}` : ''}`,
    );
  },

  fichaConductorOperador: (id: number) =>
    pedirJson<FichaConductorOperador>(`/api/operador/conductores/${id}`),

  pasajerosOperador: (q?: string) =>
    pedirJson<{ pasajeros: PasajeroOperador[] }>(
      `/api/operador/pasajeros${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    ),

  fichaPasajeroOperador: (dispositivoId: number) =>
    pedirJson<FichaPasajeroOperador>(`/api/operador/pasajeros/${dispositivoId}`),

  desbloquearPasajero: (dispositivoId: number) =>
    pedirJson<{ dispositivo_id: number; strikes: number; bloqueado_en: string | null }>(
      `/api/operador/pasajeros/${dispositivoId}/desbloquear`,
      { method: 'POST', body: '{}', reintentos: 1 },
    ),

  viajesOperador: (estado?: string, q?: string) => {
    const partes = [
      estado ? `estado=${encodeURIComponent(estado)}` : '',
      q ? `q=${encodeURIComponent(q)}` : '',
    ].filter(Boolean);
    return pedirJson<{ viajes: ViajeOperador[] }>(
      `/api/operador/viajes${partes.length > 0 ? `?${partes.join('&')}` : ''}`,
    );
  },

  // Entrar al panel con el teléfono (migración 080), en vez de con un uuid de
  // 36 caracteres metido en la URL.
  pedirCodigoOperador: (telefono: string, canal: 'sms' | 'llamada' = 'sms') =>
    pedirJson<{ enviado: boolean }>('/api/operador/entrar/codigo', {
      method: 'POST',
      body: JSON.stringify({ telefono, canal }),
    }),

  // Editar los datos del taxista (nombre, apellido, DIP, correo). El teléfono
  // va aparte (cambiarTelefonoConductor).
  editarDatosConductor: (id: number, datos: {
    nombre: string; apellido: string; dip?: string; correo?: string;
  }) =>
    pedirJson<{ guardado: boolean }>(`/api/operador/conductores/${id}/datos`, {
      method: 'POST', body: JSON.stringify(datos),
    }),

  // Subir la foto del taxista (migración 088). La imagen llega YA reducida en
  // el navegador; aquí solo viaja como cuerpo binario.
  subirFotoConductor: (id: number, imagen: Blob) =>
    pedirJson<{ subida: boolean }>(`/api/operador/conductores/${id}/foto`, {
      method: 'POST', body: imagen, headers: { 'content-type': imagen.type || 'image/jpeg' },
    }),

  // El alta de un taxista hecha por el operador (06/10). Nace verificado
  // —lo verificó quien lo dio de alta— y con el teléfono por confirmar.
  darDeAltaTaxista: (datos: {
    // El conductor: nombre, apellido, teléfono y DIP (migración 087).
    nombre: string; apellido: string; telefono: string; dip: string;
    // El propietario: el mismo que conduce (duenoConduce), uno ya registrado
    // (propietarioId) o uno nuevo (propietario).
    duenoConduce: boolean;
    propietarioId?: number;
    propietario?: { nombre: string; apellido: string; telefono: string; dip: string };
    matricula: string; marca: string;
    carroceria: string; color?: string; plazas?: number;
    aireAcondicionado?: boolean; seguro?: boolean;
    // El número que el coche ya lleva pintado; vacío, el siguiente (084).
    numeroTaxi?: string;
  }) =>
    pedirJson<{ conductorId: number; numeroTaxi: string | null }>('/api/operador/conductores', {
      method: 'POST',
      body: JSON.stringify(datos),
    }),

  // Cambiar el número con el que entra alguien (05/10). No es editar un dato
  // de contacto: es cambiarle la llave, y el número nuevo queda sin verificar.
  cambiarTelefonoConductor: (conductorId: number, telefono: string) =>
    pedirJson<{ telefono: string; antes: string | null }>(
      `/api/operador/conductores/${conductorId}/telefono`,
      { method: 'POST', body: JSON.stringify({ telefono }) },
    ),

  cambiarTelefonoPasajero: (dispositivoId: number, telefono: string) =>
    pedirJson<{ telefono: string; antes: string | null }>(
      `/api/operador/pasajeros/${dispositivoId}/telefono`,
      { method: 'POST', body: JSON.stringify({ telefono }) },
    ),

  // El vale de entrada para quien no recibe ni el SMS ni la llamada
  // (migración 081). Devuelve el código UNA vez: no se guarda en claro, así
  // que si se pierde hay que dar otro.
  valeOperador: (telefono: string) =>
    pedirJson<{ codigo: string; caducaEn: string }>('/api/operador/vale', {
      method: 'POST',
      body: JSON.stringify({ telefono }),
    }),

  entrarOperador: (telefono: string, codigo: string) =>
    pedirJson<{ entrado: boolean; raiz: boolean }>('/api/operador/entrar', {
      method: 'POST',
      body: JSON.stringify({ telefono, codigo }),
    }),

  // Dar y quitar accesos (migración 080). El teléfono viaja en el cuerpo
  // incluso cuando solo se lee: en la URL acabaría en el registro de peticiones
  // del servidor.
  // Qué puede hacer quien mira (migración 090): el panel enseña solo lo que su
  // perfil permite. `admin` es la raíz (lo puede todo y reparte accesos).
  yoOperador: () =>
    pedirJson<{ admin: boolean; permisos: PermisoOperador[]; telefono: string | null }>(
      '/api/operador/yo',
    ),

  accesosOperador: () =>
    pedirJson<{ yo: { telefono: string | null; raiz: boolean } | null; operadores: AccesoOperador[] }>(
      '/api/operador/accesos',
    ),

  aparatosOperador: (telefono: string) =>
    pedirJson<{ aparatos: AparatoOperador[] }>('/api/operador/accesos/aparatos', {
      method: 'POST',
      body: JSON.stringify({ telefono }),
    }),

  darAccesoOperador: (telefono: string, nombre?: string) =>
    pedirJson<{ autorizado: boolean; yaEstaba: boolean }>('/api/operador/accesos', {
      method: 'POST',
      body: JSON.stringify({ telefono, nombre }),
    }),

  quitarAccesoOperador: (telefono: string) =>
    pedirJson<{ revocado: boolean }>('/api/operador/accesos/quitar', {
      method: 'POST',
      body: JSON.stringify({ telefono }),
    }),

  quitarAparatoOperador: (uuid: string) =>
    pedirJson<{ revocado: boolean }>('/api/operador/accesos/aparatos/quitar', {
      method: 'POST',
      body: JSON.stringify({ uuid }),
    }),

  // Registros de vehículos y propietarios (migración 087).
  vehiculosOperador: () =>
    pedirJson<{ vehiculos: VehiculoRegistro[] }>('/api/operador/vehiculos'),
  propietariosOperador: () =>
    pedirJson<{ propietarios: PropietarioRegistro[] }>('/api/operador/propietarios'),

  // La ficha de un propietario: sus datos y toda su flota (09/10). Entrar por
  // el dueño para ver sus varios coches y conductores.
  fichaPropietarioOperador: (id: number) =>
    pedirJson<FichaPropietarioOperador>(`/api/operador/propietarios/${id}`),

  vivoOperador: () =>
    pedirJson<{
      taxis: TaxiVivo[]; viajes: ViajeVivo[]; sinOferta: SinOfertaViva[]; momento: string;
    }>('/api/operador/vivo'),

  // La traza de una carrera: por dónde fue de verdad, del rastro del taxi.
  trazaViaje: (viajeId: number) =>
    pedirJson<{
      origen: { nombre: string; lat: number; lng: number };
      destino: { nombre: string; lat: number; lng: number };
      tramos: Array<Array<{ lat: number; lng: number }>>;
    }>(`/api/operador/viajes/${viajeId}/traza`),

  // La oferta dirigida (06/10): mandarle ESTA carrera a ESTE taxi. Él decide.
  ofrecerViaje: (viajeId: number, conductorId: number) =>
    pedirJson<{ ofrecida: boolean }>(`/api/operador/viajes/${viajeId}/ofrecer`, {
      method: 'POST',
      body: JSON.stringify({ conductorId }),
    }),

  incidenciasOperador: (estado?: 'pendientes' | 'resueltas') =>
    pedirJson<{ incidencias: IncidenciaOperador[] }>(
      `/api/operador/incidencias${estado === 'resueltas' ? '?estado=resueltas' : ''}`,
    ),

  historialIncidencia: (id: number) =>
    pedirJson<{ transiciones: TransicionOperador[] }>(`/api/operador/incidencias/${id}/historial`),

  resolverIncidencia: (id: number, accion: 'sancionar' | 'perdonar') =>
    pedirJson<{ incidenciaId: number; resolucion: string; strikes: number | null; bloqueado: boolean }>(
      `/api/operador/incidencias/${id}/resolver`,
      { method: 'POST', body: JSON.stringify({ accion }), reintentos: 1 },
    ),

  cambiarEstadoConductor: (conductorId: number, estado: string) =>
    pedirJson<{ id: number; nombre: string; estado_verificacion: string }>(
      `/api/operador/conductores/${conductorId}/estado`,
      { method: 'POST', body: JSON.stringify({ estado }), reintentos: 1 },
    ),

  estadisticasOperador: () =>
    pedirJson<EstadisticasOperador>('/api/operador/estadisticas'),

  recargasOperador: (estado?: string) =>
    pedirJson<{ recargas: RecargaOperador[] }>(
      `/api/operador/recargas${estado ? `?estado=${encodeURIComponent(estado)}` : ''}`,
    ),

  // `comprobante`: el identificador del pago que el operador dice haber visto
  // (migración 068). Sin él el servidor no confirma: dar saldo de palabra era
  // exactamente lo que P18-01 señalaba.
  confirmarRecarga: (referencia: string, comprobante: string) =>
    pedirJson<{ recargaId: number; importeXaf: number; saldoXaf: number; yaEstaba: boolean }>(
      `/api/operador/recargas/${referencia}/confirmar`,
      { method: 'POST', body: JSON.stringify({ comprobante }), reintentos: 1 },
    ),

  rechazarRecarga: (referencia: string, motivo: string) =>
    pedirJson<{ rechazada: boolean }>(
      `/api/operador/recargas/${referencia}/rechazar`,
      { method: 'POST', body: JSON.stringify({ motivo }), reintentos: 1 },
    ),

  // --- Cobertura agregada --------------------------------------------------
  // Cuántos taxis podrían venir, para poder decidir ANTES de pedir y esperar
  // 90 s. Nunca dónde está ninguno.
  taxisCerca: (origenId: number) =>
    pedirJson<TaxisCerca>(`/api/taxis-cerca?origenId=${origenId}`),

  taxisElegibles: (origenId: number) =>
    pedirJson<{ taxis: TaxiElegible[] }>(`/api/taxis-elegibles?origenId=${origenId}`),

  // Dónde se está pidiendo taxi, por barrio. Solo en servicio.
  demandaConductor: () =>
    pedirJson<{ zonas: ZonaConDemanda[]; ventanaMin: number }>('/api/conductor/demanda'),

  saludOperador: () => pedirJson<SaludOperador>('/api/operador/salud'),

  crearSolicitudOperador: (telefono: string, origenId: number, destinoId: number) =>
    pedirJson<{ solicitudId: number; estado: string; yaExistia: boolean }>(
      '/api/operador/solicitudes',
      { method: 'POST', body: JSON.stringify({ telefono, origenId, destinoId }), reintentos: 1 },
    ),

  solicitudesCentral: () =>
    pedirJson<{ solicitudes: SolicitudCentral[] }>('/api/operador/solicitudes'),

  zonasOperador: () => pedirJson<{ zonas: ZonaOperador[] }>('/api/operador/zonas'),

  // «Estoy aquí»: sitúa un barrio con el GPS de quien lo pulsa.
  // La precisión viaja siempre: el servidor la exige, porque un punto dentro
  // de Malabo pero tomado con la antena de telefonía sitúa el barrio a medio
  // kilómetro y nadie se entera.
  situarZona: (zonaId: number, lat: number, lng: number, precision: number) =>
    pedirJson<{ zonaId: number; nombre: string; vecinas: number; precisionM: number | null }>(
      `/api/operador/zonas/${zonaId}/situar`,
      { method: 'POST', body: JSON.stringify({ lat, lng, precision }), reintentos: 1 },
    ),

  // zonaPadreId (migración 031): con él, crea un barrio/calle dentro de ese
  // distrito urbano en vez de un distrito urbano nuevo.
  crearZonaEnGps: (nombre: string, lat: number, lng: number, precision: number, zonaPadreId?: number) =>
    pedirJson<{ zonaId: number; nombre: string; vecinas: number; precisionM: number | null }>(
      '/api/operador/zonas',
      { method: 'POST', body: JSON.stringify({ nombre, lat, lng, precision, zonaPadreId }), reintentos: 1 },
    ),

  // Migración 048: recibir carreras de toda la isla, en la última oleada.
  recibirEnCualquierZona: (conductorId: number, activo: boolean) =>
    pedirJson<{ id: number; nombre: string; recibe_en_cualquier_zona: boolean }>(
      `/api/operador/conductores/${conductorId}/cualquier-zona`,
      { method: 'POST', body: JSON.stringify({ activo }), reintentos: 1 },
    ),

  // Prepara el taxi del propio operador sobre el dispositivo que se pase, para
  // poder cambiar a «Taxista» desde el conmutador sin pasar por el alta.
  prepararMiTaxi: (uuid: string) =>
    pedirJson<{ conductorId: number; telefono: string }>('/api/operador/mi-taxi', {
      method: 'POST',
      body: JSON.stringify({ uuid }),
      reintentos: 1,
    }),

  // El mismo papel para un pasajero (migración 072). Quien mejor sitúa un
  // barrio es a veces alguien que ni conduce.
  nombrarAgentePasajero: (dispositivoId: number, agente: boolean) =>
    pedirJson<{ dispositivo_id: number; nombre: string | null; es_agente: boolean }>(
      `/api/operador/pasajeros/${dispositivoId}/agente`,
      { method: 'POST', body: JSON.stringify({ agente }) },
    ),

  nombrarAgente: (conductorId: number, agente: boolean) =>
    pedirJson<{ id: number; nombre: string; es_agente: boolean }>(
      `/api/operador/conductores/${conductorId}/agente`,
      { method: 'POST', body: JSON.stringify({ agente }), reintentos: 1 },
    ),

  // Editar el vehículo (08/10): aire y seguro siempre; color y plazas también;
  // matrícula, marca y tipo solo si el coche aún no está validado —el servidor
  // lo rechaza con 409 si lo está—. Los campos de identidad son opcionales:
  // solo se mandan cuando el coche no está validado.
  editarVehiculoOperador: (conductorId: number, datos: {
    aireAcondicionado: boolean; seguro: boolean;
    color?: string | null; plazas?: number | null;
    matricula?: string; marca?: string; carroceria?: string;
  }) =>
    pedirJson<{
      conductor_id: number; aire_acondicionado: boolean; seguro: boolean;
      color: string | null; plazas: number | null;
      matricula: string | null; marca: string | null; carroceria: string | null;
    }>(
      `/api/operador/conductores/${conductorId}/vehiculo`,
      { method: 'POST', body: JSON.stringify(datos), reintentos: 1 },
    ),

  // Editar los datos del dueño del coche (08/10). El DIP es su identidad: el
  // servidor rechaza con 409 el DIP de otro propietario.
  editarPropietario: (id: number, datos: {
    nombre: string; apellido: string; telefono: string; dip: string;
  }) =>
    pedirJson<{ guardado: boolean }>(`/api/operador/propietarios/${id}/datos`, {
      method: 'POST', body: JSON.stringify(datos),
    }),

  // Hacer dueño del coche al propio taxista (09/10): usa su identidad (nombre,
  // apellido, teléfono, DIP) como propietario. Necesita que tenga DIP y
  // apellido ya guardados.
  hacerDuenoAlConductor: (conductorId: number) =>
    pedirJson<{ hecho: boolean }>(`/api/operador/conductores/${conductorId}/dueno-es-el-conductor`, {
      method: 'POST', body: '{}',
    }),

  recorridoConductor: (conductorId: number, periodo: PeriodoRecorrido) =>
    pedirJson<RecorridoOperador>(
      `/api/operador/conductores/${conductorId}/recorrido?periodo=${periodo}`,
    ),

  referenciasOperador: (q?: string, zonaId?: number) => {
    const partes = [
      q ? `q=${encodeURIComponent(q)}` : '',
      zonaId ? `zonaId=${zonaId}` : '',
    ].filter(Boolean);
    return pedirJson<{ referencias: ReferenciaOperador[] }>(
      `/api/operador/referencias${partes.length ? `?${partes.join('&')}` : ''}`,
    );
  },

  // `precision` es la del GPS, en metros. Sin ella el sitio queda marcado
  // como puesto a mano y sin verificar sobre el terreno (migración 038).
  crearReferenciaOperador: (datos: {
    zonaId: number; nombre: string; lat: number; lng: number;
    categoria?: string; precision?: number;
    // Con `sustituir` se acepta pisar las coordenadas de un sitio que ya tenía
    // ese nombre en esa zona. Sin él, el servidor contesta 409 y dice cuál es
    // —antes lo machacaba en silencio.
    sustituir?: boolean;
  }) =>
    pedirJson<{ referenciaId: number; creada: boolean }>(
      '/api/operador/referencias',
      { method: 'POST', body: JSON.stringify(datos), reintentos: 1 },
    ),

  editarReferenciaOperador: (id: number, cambios: {
    nombre?: string; zonaId?: number; lat?: number; lng?: number;
    activa?: boolean; categoria?: string; precision?: number;
  }) =>
    pedirJson<{ editada: boolean }>(
      `/api/operador/referencias/${id}`,
      { method: 'POST', body: JSON.stringify(cambios), reintentos: 1 },
    ),

  aliasReferenciaOperador: (id: number, alias: string, quitar = false) =>
    pedirJson<{ hecho: boolean }>(
      `/api/operador/referencias/${id}/alias`,
      { method: 'POST', body: JSON.stringify({ alias, quitar }), reintentos: 1 },
    ),

  bandasOperador: () => pedirJson<{ bandas: BandaOperador[] }>('/api/operador/bandas'),

  guardarBandaOperador: (datos: {
    zonaOrigenId: number; zonaDestinoId: number;
    p25?: number; p50?: number; p75?: number; borrar?: boolean;
  }) =>
    pedirJson<{ bandaId?: number; borrada?: boolean }>(
      '/api/operador/bandas',
      { method: 'POST', body: JSON.stringify(datos), reintentos: 1 },
    ),

  cambiosOperador: () =>
    pedirJson<{ cambios: CambioOperador[] }>('/api/operador/cambios'),

  parametrosOperador: () =>
    pedirJson<{ parametros: ParametroOperador[] }>('/api/operador/parametros'),

  cambiarParametroOperador: (clave: string, valor: string) =>
    pedirJson<{ clave: string; valor: string }>(
      `/api/operador/parametros/${encodeURIComponent(clave)}`,
      { method: 'POST', body: JSON.stringify({ valor }), reintentos: 1 },
    ),

  // «Estoy mirando la pantalla» / «me he ido». Es lo que decide si una carrera
  // se queda en la conexión abierta o despierta el teléfono con una
  // notificación. Sin reintentos: si se pierde, el siguiente cambio lo corrige,
  // y reintentar un estado viejo sería decir una mentira con retraso.
  marcarVisibilidad: (visible: boolean) =>
    pedirJson<{ visible: boolean }>('/api/conductor/visibilidad', {
      method: 'POST',
      body: JSON.stringify({ visible }),
      // `keepalive`: el aviso de «me voy» se manda justo cuando el navegador
      // está guardando la página, y una petición normal ahí se cancela a
      // medias. Con esto el navegador se compromete a terminarla aunque la
      // pestaña desaparezca —es lo mismo que hace `sendBeacon`, pero
      // conservando las cabeceras, así que el secreto del dispositivo no tiene
      // que viajar por la URL.
      keepalive: true,
    }),

  // La radio del gremio (migración 075). Con dos puertas desde la 086: la
  // del taxista y la de la Central — mismas rutas, mismo contrato, distinto
  // guardián. La puerta se pasa en cada llamada para que el gancho `useRadio`
  // sirva tal cual en los dos paneles.
  radio: (puerta: PuertaRadio = 'conductor') =>
    pedirJson<EstadoRadio>(`${RUTA_RADIO[puerta]}`),

  // Apretar el botón. Sin reintentos a propósito: si la petición se pierde en la
  // red, repetirla llegaría tarde —el turno dura diez segundos— y podría pisarle
  // la palabra a otro que ya empezó a hablar.
  // «Ocupado» y «apagada» NO son errores: son la respuesta. El servidor las
  // manda con 409 y 404 porque eso es lo correcto en HTTP, y aquí se vuelven a
  // convertir en lo que la pantalla necesita. Sin esto saltaban al camino de los
  // fallos y el taxista leía «no se pudo pedir la palabra, inténtalo otra vez»
  // cada vez que otro estaba hablando.
  pedirTurnoRadio: async (puerta: PuertaRadio = 'conductor'): Promise<RespuestaTurno> => {
    try {
      return await pedirJson<RespuestaTurno>(
        `${RUTA_RADIO[puerta]}/turno`, { method: 'POST', body: '{}' },
      );
    } catch (error) {
      if (error instanceof ErrorDelServidor && (error.estado === 409 || error.estado === 404)) {
        const cuerpo = error.datos as RespuestaTurno | undefined;
        if (cuerpo && cuerpo.dada === false) return cuerpo;
        return { dada: false, motivo: error.estado === 404 ? 'apagada' : 'ocupado', habla: '', quedanSeg: 0 };
      }
      throw error;
    }
  },

  soltarTurnoRadio: (puerta: PuertaRadio = 'conductor') =>
    pedirJson<{ soltado: boolean }>(`${RUTA_RADIO[puerta]}/turno`, { method: 'DELETE' }),

  // El audio va como cuerpo binario, no en base64: los mismos diez segundos
  // pesarían un tercio más, y aquí eso es dinero del taxista.
  mandarVozRadio: (audio: Blob, duracionMs: number, puerta: PuertaRadio = 'conductor') =>
    pedirJson<{ guardado: boolean; mensajeId: number; oyentes: number }>(
      `${RUTA_RADIO[puerta]}/mensaje`,
      {
        method: 'POST',
        body: audio,
        headers: {
          'content-type': audio.type || 'audio/webm',
          'x-duracion-ms': String(Math.round(duracionMs)),
        },
      },
    ),
};

// Por qué puerta se habla con la radio (086).
export type PuertaRadio = 'conductor' | 'operador';
const RUTA_RADIO: Record<PuertaRadio, string> = {
  conductor: '/api/conductor/radio',
  operador: '/api/operador/radio',
};

export interface MensajeRadio {
  id: number;
  // null cuando habló la Central (086).
  conductorId: number | null;
  nombre: string;
  matricula: string | null;
  duracionMs: number;
  bytes: number;
  creadoEn: string;
  mio: boolean;
}

export interface EstadoRadio {
  encendida: boolean;
  canal: string;
  segundosMax: number;
  habla: { conductorId: number | null; nombre: string } | null;
  mensajes: MensajeRadio[];
}

export type RespuestaTurno =
  | { dada: true; caducaEn: string; segundosMax: number }
  | { dada: false; motivo: 'apagada' }
  | { dada: false; motivo: 'ocupado'; habla: string; quedanSeg: number }
  | { dada: false; motivo: 'demasiados'; esperaSeg: number };

// Baja el audio de un mensaje. Va aparte de `pedirJson` porque lo que vuelve no
// es JSON, y con las cabeceras y no con el secreto en la URL: una URL se comparte
// sin pensar, y esto es la voz de alguien.
export async function bajarVozRadio(
  mensajeId: number,
  puerta: PuertaRadio = 'conductor',
): Promise<Blob | null> {
  await asegurarSecreto();
  const respuesta = await fetch(`${RUTA_RADIO[puerta]}/mensaje/${mensajeId}/audio`, {
    headers: {
      'x-dispositivo': uuidDispositivo(),
      ...(secretoDispositivo() !== null ? { 'x-secreto': secretoDispositivo()! } : {}),
    },
  });
  // Un 404 es lo normal pasadas dos horas: el mensaje se borró. No es un fallo.
  if (!respuesta.ok) return null;
  return respuesta.blob();
}

// Baja la foto del taxista como blob, con las cabeceras de siempre (no por
// URL: una foto de carnet no se comparte pegando un enlace). Null si no tiene.
export async function bajarFotoConductor(id: number): Promise<Blob | null> {
  await asegurarSecreto();
  const respuesta = await fetch(`/api/operador/conductores/${id}/foto`, {
    headers: {
      'x-dispositivo': uuidDispositivo(),
      ...(secretoDispositivo() !== null ? { 'x-secreto': secretoDispositivo()! } : {}),
    },
  });
  if (!respuesta.ok) return null;
  return respuesta.blob();
}

// Solo en localhost: ?gps=<lat>,<lng> finge la ubicación del dispositivo.
//
// Un ordenador no tiene GPS, así que sin esto no se puede ver en local lo que
// más importa del producto: el coche acercándose por el plano y el tiempo que
// falta. Con dos ventanas —pasajera y taxista, cada una con su ?dispositivo= y
// su ?gps=— se recorre el viaje entero sin salir del escritorio.
//
// Fuera de localhost se ignora, igual que ?dispositivo=: la posición es una
// señal antifraude, y dejar que el cliente la dicte en producción sería
// regalarle al defraudador justo la palanca que se quiere vigilar.
function coordenadasFingidas(): { lat: number; lng: number } | null {
  if (!enPruebasLocales()) return null;
  const crudo = new URLSearchParams(window.location.search).get('gps');
  if (!crudo) return null;
  const [lat, lng] = crudo.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

// Lectura GPS única y voluntaria al pedir (señal antifraude del servidor).
// Si no hay permiso, no hay señal o tarda más de 4 s, se pide sin ella:
// la ubicación jamás es requisito.
// La posición de quien usa la app, con la precisión que traiga.
//
// Antes esto pedía la posición sin `enableHighAccuracy`, con 3,5 s de espera y
// aceptando una lectura de hasta un minuto. Tres decisiones que parecían
// prudentes —no gastar batería, no hacer esperar— y que juntas producían el
// fallo por el que se reescribió: sin alta precisión Android no enciende el
// GPS, devuelve una posición por wifi y antena que se va de cientos de metros,
// y ESA aterriza en sitios «conocidos». De ahí el pasajero situado en un
// supermercado en vez de en la acera donde estaba.
//
// Ahora se pide bien y se espera: se coge la mejor lectura que llegue en
// `esperaMs`, y se corta antes en cuanto una baja de `objetivoM`. Y se
// devuelve `precision`, que es lo que permite decidir después si la posición
// vale como punto de recogida o no. Sin ese número no se puede distinguir
// «estoy aquí» de «estoy en algún sitio de este barrio».
export interface Posicion {
  lat: number;
  lng: number;
  // Radio de error en metros, tal cual lo da el navegador. null si el GPS va
  // fingido por la URL en pruebas locales.
  precision: number | null;
  // Cuándo se TOMÓ, en ISO (migración 054). El servidor se la cree dentro de
  // un margen; sin ella pone la hora de llegada, que llega hasta ocho segundos
  // tarde y estropea la velocidad de cada tramo.
  en?: string;
  // Velocidad MEDIDA por el receptor, ya en km/h (migración 063). El navegador
  // la da en metros por segundo y a veces no la da: null entonces. Se manda
  // para no tener que deducirla después restando dos posiciones, que es lo que
  // hacía que el tiempo al volante saliera largo.
  velocidad?: number | null;
}

// `coords.speed` viene en m/s, o null si el receptor no la sabe. Un NaN o un
// negativo es un dato roto, no un coche parado.
export function velocidadEnKmh(metrosPorSegundo: number | null | undefined): number | null {
  if (typeof metrosPorSegundo !== 'number' || !Number.isFinite(metrosPorSegundo)) return null;
  if (metrosPorSegundo < 0) return null;
  return Math.round(metrosPorSegundo * 3.6 * 10) / 10;
}

export function coordenadasOportunistas(
  { objetivoM = 40, esperaMs = 8000 } = {},
): Promise<Posicion | null> {
  return new Promise((resolver) => {
    const fingidas = coordenadasFingidas();
    if (fingidas) {
      resolver({ ...fingidas, precision: null });
      return;
    }
    if (!('geolocation' in navigator)) {
      resolver(null);
      return;
    }

    let mejor: GeolocationPosition | null = null;
    let terminado = false;
    // Los dos identificadores, declarados antes de usarlos: `acabar` los
    // limpia, y `acabar` puede ejecutarse dentro de la propia llamada que los
    // crea (ver la nota de abajo).
    let vigilancia = 0;
    let reloj: ReturnType<typeof setTimeout> | undefined;
    const acabar = () => {
      if (terminado) return;
      terminado = true;
      navigator.geolocation.clearWatch(vigilancia);
      clearTimeout(reloj);
      resolver(mejor === null ? null : {
        lat: mejor.coords.latitude,
        lng: mejor.coords.longitude,
        precision: mejor.coords.accuracy,
        en: new Date(mejor.timestamp).toISOString(),
        velocidad: velocidadEnKmh(mejor.coords.speed),
      });
    };

    // `watchPosition` y no `getCurrentPosition`: el primer aviso del sistema
    // suele ser la posición gruesa de la red, y la del GPS llega unos segundos
    // después. Con getCurrentPosition se cogía la primera y se descartaba la
    // buena sin llegar a verla.
    // `let` declarado ANTES, no `const` en la misma línea de la llamada: si el
    // navegador entrega la primera posición de forma síncrona —tiene una
    // fijación cacheada y contesta antes de devolver el identificador—, el
    // callback se ejecuta con la variable todavía sin inicializar y todo
    // revienta con «Cannot access before initialization». Pasó en pruebas.
    vigilancia = navigator.geolocation.watchPosition(
      (p) => {
        if (mejor === null || p.coords.accuracy < mejor.coords.accuracy) mejor = p;
        if (mejor.coords.accuracy <= objetivoM) acabar();
      },
      () => acabar(),
      { enableHighAccuracy: true, maximumAge: 0, timeout: esperaMs },
    );
    reloj = setTimeout(acabar, esperaMs);
  });
}

export interface EventoSse {
  tipo: string;
  solicitudId?: number;
  datos: Record<string, unknown>;
}

// Conexión SSE mientras se espera (decisión 3.2). Devuelve la función de cierre.
export function abrirEventos(
  solicitudId: number,
  alRecibir: (evento: EventoSse) => void,
): () => void {
  return abrirFlujo(
    () => `/api/solicitudes/${solicitudId}/eventos?dispositivo=${uuidDispositivo()}${sufijoSecreto()}`,
    alRecibir,
  );
}

// El trozo común de las dos conexiones vivas. Espera al secreto antes de
// abrir: la URL se compone con él dentro, y si se compusiera antes de tenerlo
// el servidor cerraría la conexión con un 401 y el taxista se quedaría sin
// enterarse de las carreras hasta recargar.
function abrirFlujo(
  url: () => string,
  alRecibir: (evento: EventoSse) => void,
): () => void {
  let fuente: EventSource | null = null;
  let cerrado = false;
  void asegurarSecreto().then(() => {
    if (cerrado) return;
    fuente = new EventSource(url());
    fuente.onmessage = (mensaje) => {
      try {
        alRecibir(JSON.parse(mensaje.data));
      } catch {
        // Carga malformada: se ignora; el estado real siempre se puede pedir.
      }
    };
  });
  return () => {
    cerrado = true;
    fuente?.close();
  };
}

// Conexión viva de la Central (086): por aquí le llega la radio — quién
// habla, los mensajes nuevos, el silencio.
export function abrirEventosOperador(
  alRecibir: (evento: EventoSse) => void,
): () => void {
  return abrirFlujo(
    () => `/api/operador/eventos?dispositivo=${uuidDispositivo()}${sufijoSecreto()}`,
    alRecibir,
  );
}

// Conexión viva del taxista: las carreras llegan en el momento, sin esperar al
// siguiente sondeo. EventSource reconecta solo si se cae.
export function abrirEventosConductor(
  alRecibir: (evento: EventoSse) => void,
): () => void {
  return abrirFlujo(
    () => `/api/conductor/eventos?dispositivo=${uuidDispositivo()}${sufijoSecreto()}`,
    alRecibir,
  );
}
