// Cliente de la API. La identidad del cliente es el uuid persistente del
// dispositivo (regla 4.2.4), guardado en localStorage y enviado en la
// cabecera x-dispositivo (o como parámetro en el SSE, que no admite cabeceras).

import { ErrorDeRed, marcarConexionCaida, marcarConexionViva } from './conexion';

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

async function pedirJson<T>(ruta: string, opciones: RequestInit = {}): Promise<T> {
  let respuesta: Response;
  try {
    respuesta = await fetch(ruta, {
      ...opciones,
      headers: {
        'x-dispositivo': uuidDispositivo(),
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
  if (!respuesta.ok) {
    throw new Error((cuerpo as { error?: string }).error ?? `Error ${respuesta.status}`);
  }
  return cuerpo as T;
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
  // Posición del coche acercándose y tiempo estimado. null si el conductor no
  // ha enviado posición reciente: el tiempo es aproximado, no una promesa.
  taxi: { lat: number; lng: number; etaMin: number; distanciaM: number; frescuraSeg: number } | null;
  reputacion: Reputacion | null;
  conductor: string | null;
  matricula: string | null;
  marca: string | null;
  color: string | null;
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
}

export interface DatosConductor {
  nombre: string;
  telefono: string;
  correo: string | null;
  verificado: boolean;
  estadoVerificacion: string;
  suscritoHasta: string | null;
  suscripcionVigente: boolean;
  saldoXaf: number;
  matricula: string | null;
  marca: string | null;
  color: string | null;
  carroceria: string | null;
  plazas: number | null;
  reputacion: Reputacion;
}

export interface Sesion {
  rol: 'cliente' | 'conductor' | 'operador' | null;
  cliente?: Perfil & { bloqueado: boolean };
  conductor?: DatosConductor;
}

export interface ConductorOperador {
  id: number;
  nombre: string;
  telefono: string;
  correo: string | null;
  estado_verificacion: string;
  matricula: string | null;
  marca: string | null;
  color: string | null;
  carroceria: string | null;
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

export interface AltaConductor {
  nombre: string;
  telefono: string;
  correo?: string;
  matricula: string;
  marca: string;
  carroceria: 'turismo' | '4x4';
  color?: string;
}

export interface OfertaConductor {
  solicitudId: number;
  origen: string;
  destino: string;
  oleada: number;
  expiraEn: string | null;
  bandaPrecio: { p25: number; p50: number; p75: number } | null;
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
  // Dónde está el pasajero de verdad mientras espera. null si no comparte
  // ubicación o si ya va a bordo.
  posicionCliente: { lat: number; lng: number; frescuraSeg: number } | null;
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

  // --- Conductor -----------------------------------------------------------

  registroConductor: (telefono: string) =>
    pedirJson<{ zonas: Zona[] }>('/api/conductor/registro', {
      method: 'POST',
      body: JSON.stringify({ telefono }),
    }),

  estadoConductor: () => pedirJson<EstadoConductor>('/api/conductor/estado'),

  servicio: (enServicio: boolean, zonaId?: number) =>
    pedirJson<{ enServicio: boolean }>('/api/conductor/servicio', {
      method: 'POST',
      body: JSON.stringify({ enServicio, zonaId }),
    }),

  heartbeat: (coordenadas: { lat: number; lng: number } | null) =>
    pedirJson<{ estado: string; saldoXaf: number }>('/api/conductor/heartbeat', {
      method: 'POST',
      body: JSON.stringify(coordenadas ?? {}),
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

  valorar: (solicitudId: number, puntuacion: number) =>
    pedirJson<{ guardada: boolean }>(`/api/solicitudes/${solicitudId}/valoracion`, {
      method: 'POST',
      body: JSON.stringify({ puntuacion }),
    }),

  // El teléfono lo toma el servidor del perfil; no hace falta enviarlo.
  pedirTaxi: (
    origenId: number,
    destinoId: number,
    coordenadas: { lat: number; lng: number } | null,
  ) =>
    pedirJson<{ solicitudId: number; estado: string; yaExistia: boolean }>('/api/solicitudes', {
      method: 'POST',
      body: JSON.stringify({ origenId, destinoId, ...(coordenadas ?? {}) }),
    }),

  estado: (solicitudId: number) =>
    pedirJson<DetalleSolicitud>(`/api/solicitudes/${solicitudId}`),

  cancelar: (solicitudId: number) =>
    pedirJson<{ estado: string; strike: boolean }>(`/api/solicitudes/${solicitudId}/cancelar`, {
      method: 'POST',
      body: '{}',
    }),

  enviarPosicion: (solicitudId: number, coordenadas: { lat: number; lng: number }) =>
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
  conductoresOperador: (estado?: string) =>
    pedirJson<{ conductores: ConductorOperador[] }>(
      `/api/operador/conductores${estado ? `?estado=${estado}` : ''}`,
    ),

  cambiarEstadoConductor: (conductorId: number, estado: string) =>
    pedirJson<{ id: number; nombre: string; estado_verificacion: string }>(
      `/api/operador/conductores/${conductorId}/estado`,
      { method: 'POST', body: JSON.stringify({ estado }) },
    ),

  estadisticasOperador: () =>
    pedirJson<EstadisticasOperador>('/api/operador/estadisticas'),

  recargasOperador: (estado?: string) =>
    pedirJson<{ recargas: RecargaOperador[] }>(
      `/api/operador/recargas${estado ? `?estado=${estado}` : ''}`,
    ),

  confirmarRecarga: (referencia: string) =>
    pedirJson<{ recargaId: number; importeXaf: number; saldoXaf: number; yaEstaba: boolean }>(
      `/api/operador/recargas/${referencia}/confirmar`,
      { method: 'POST', body: '{}' },
    ),

  rechazarRecarga: (referencia: string, motivo: string) =>
    pedirJson<{ rechazada: boolean }>(
      `/api/operador/recargas/${referencia}/rechazar`,
      { method: 'POST', body: JSON.stringify({ motivo }) },
    ),
};

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
export function coordenadasOportunistas(): Promise<{ lat: number; lng: number } | null> {
  return new Promise((resolver) => {
    const fingidas = coordenadasFingidas();
    if (fingidas) {
      resolver(fingidas);
      return;
    }
    if (!('geolocation' in navigator)) {
      resolver(null);
      return;
    }
    const limite = setTimeout(() => resolver(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (posicion) => {
        clearTimeout(limite);
        resolver({ lat: posicion.coords.latitude, lng: posicion.coords.longitude });
      },
      () => {
        clearTimeout(limite);
        resolver(null);
      },
      { timeout: 3500, maximumAge: 60_000 },
    );
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
  const fuente = new EventSource(
    `/api/solicitudes/${solicitudId}/eventos?dispositivo=${uuidDispositivo()}`,
  );
  fuente.onmessage = (mensaje) => {
    try {
      alRecibir(JSON.parse(mensaje.data));
    } catch {
      // Carga malformada: se ignora; el estado real siempre se puede pedir.
    }
  };
  return () => fuente.close();
}

// Conexión viva del taxista: las carreras llegan en el momento, sin esperar al
// siguiente sondeo. EventSource reconecta solo si se cae.
export function abrirEventosConductor(
  alRecibir: (evento: EventoSse) => void,
): () => void {
  const fuente = new EventSource(
    `/api/conductor/eventos?dispositivo=${uuidDispositivo()}`,
  );
  fuente.onmessage = (mensaje) => {
    try {
      alRecibir(JSON.parse(mensaje.data));
    } catch {
      // Carga malformada: el estado real siempre se puede volver a pedir.
    }
  };
  return () => fuente.close();
}
