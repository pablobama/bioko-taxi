// El recorrido del turno, apuntado en el propio móvil (migración 051).
//
// Hasta ahora el recorrido era un efecto secundario del latido: si el latido
// no salía —un barrio sin cobertura, la subida a Basilé, los datos agotados a
// mitad de mes— ese trozo del turno no existía. En Malabo eso no es un caso
// raro, y el taxista veía su propio recorrido con agujeros de media tarde.
//
// Ahora el GPS escribe aquí, en el teléfono, funcione la red o no; y cuando
// vuelve la cobertura se sube el lote entero con la hora de cada punto. Lo que
// se guarda es lo mismo que guardaría el servidor —y con la misma regla de
// aclarado, para no llevar en el bolsillo diez veces más puntos de los que se
// van a aceptar—, así que el resultado no depende de si había red o no.
//
// IndexedDB y no localStorage: esto sobrevive a que se cierre la aplicación y
// puede llegar a unos miles de filas. localStorage es síncrono —bloquearía la
// pantalla del taxista mientras conduce— y se queda sin sitio enseguida.

const BASE = 'taxi-rastro';
const ALMACEN = 'puntos';

// Las mismas tres cifras que `rastro_intervalo_min_seg`, `rastro_distancia_min_m`
// y `rastro_anclaje_seg` en el servidor. Están repetidas porque este lado tiene
// que decidir sin red, que es justo cuando no puede preguntarlas; si algún día
// cambian allí, el servidor sigue siendo quien manda: aclara al recibir.
const INTERVALO_MIN_MS = 45_000;
const DISTANCIA_MIN_M = 40;
const ANCLAJE_MS = 300_000;

// Tope de la cola. A un punto cada 45 s son unas 75 horas de turno guardadas
// sin red, más que de sobra para cualquier apagón de cobertura real. Pasado
// eso se tiran los MÁS VIEJOS: si se tiraran los nuevos, un móvil que llenó la
// cola una vez no volvería a apuntar nada nunca.
const TOPE = 6000;

export interface PuntoLocal {
  id?: number;
  lat: number;
  lng: number;
  en: string;
}

let baseAbierta: Promise<IDBDatabase> | null = null;

function abrir(): Promise<IDBDatabase> {
  if (baseAbierta !== null) return baseAbierta;
  baseAbierta = new Promise((resolver, rechazar) => {
    const peticion = indexedDB.open(BASE, 1);
    peticion.onupgradeneeded = () => {
      peticion.result.createObjectStore(ALMACEN, { keyPath: 'id', autoIncrement: true });
    };
    peticion.onsuccess = () => resolver(peticion.result);
    peticion.onerror = () => rechazar(peticion.error);
  });
  // Un fallo al abrir no puede dejar la promesa cacheada para siempre: en modo
  // privado o con el disco lleno, IndexedDB falla y luego vuelve.
  baseAbierta.catch(() => { baseAbierta = null; });
  return baseAbierta;
}

function enAlmacen<T>(
  modo: IDBTransactionMode,
  trabajo: (almacen: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return abrir().then((base) => new Promise<T>((resolver, rechazar) => {
    const transaccion = base.transaction(ALMACEN, modo);
    const peticion = trabajo(transaccion.objectStore(ALMACEN));
    peticion.onsuccess = () => resolver(peticion.result);
    peticion.onerror = () => rechazar(peticion.error);
  }));
}

// El último punto apuntado, para decidir si el siguiente merece guardarse sin
// tener que leer la base en cada lectura del GPS (que llega cada pocos
// segundos). Se rellena solo la primera vez.
let ultimo: { lat: number; lng: number; en: number } | null = null;
let ultimoLeido = false;

function metrosEntre(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const x = dLng * Math.cos(lat);
  return Math.hypot(dLat, x) * R;
}

// Apunta un punto del recorrido, o no. Devuelve si lo apuntó.
//
// Las cuatro reglas son las del servidor: el primero siempre; nada antes del
// intervalo mínimo; si se movió lo bastante, sí; y si no se movió pero hace
// rato del último, también —que es la diferencia entre «estuvo una hora parado
// en la parada del mercado» y «no se sabe»—.
export async function anotarRastro(
  punto: { lat: number; lng: number },
  ahora: Date = new Date(),
): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return false;
  try {
    if (!ultimoLeido) {
      ultimoLeido = true;
      const todos = await enAlmacen<PuntoLocal[]>('readonly', (a) => a.getAll() as IDBRequest<PuntoLocal[]>);
      const final = todos[todos.length - 1];
      if (final !== undefined) {
        ultimo = { lat: final.lat, lng: final.lng, en: new Date(final.en).getTime() };
      }
    }
    if (ultimo !== null) {
      const transcurrido = ahora.getTime() - ultimo.en;
      if (transcurrido < INTERVALO_MIN_MS) return false;
      if (metrosEntre(ultimo, punto) < DISTANCIA_MIN_M && transcurrido < ANCLAJE_MS) {
        return false;
      }
    }
    await enAlmacen('readwrite', (a) => a.add({
      lat: punto.lat, lng: punto.lng, en: ahora.toISOString(),
    }) as IDBRequest<IDBValidKey>);
    ultimo = { lat: punto.lat, lng: punto.lng, en: ahora.getTime() };
    await recortar();
    return true;
  } catch {
    // Sin IndexedDB —modo privado, disco lleno, permisos— el recorrido se
    // pierde, pero el turno del taxista no se interrumpe por eso. Es lo mismo
    // que pasaba antes de todo esto.
    return false;
  }
}

async function recortar(): Promise<void> {
  const cuantos = await enAlmacen<number>('readonly', (a) => a.count());
  if (cuantos <= TOPE) return;
  const sobran = await enAlmacen<PuntoLocal[]>(
    'readonly', (a) => a.getAll(null, cuantos - TOPE) as IDBRequest<PuntoLocal[]>,
  );
  await olvidarRastro(sobran.map((p) => p.id!).filter((id) => id !== undefined));
}

export function pendientesRastro(maximo: number): Promise<PuntoLocal[]> {
  return enAlmacen<PuntoLocal[]>(
    'readonly', (a) => a.getAll(null, maximo) as IDBRequest<PuntoLocal[]>,
  ).catch(() => []);
}

export async function olvidarRastro(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  try {
    const base = await abrir();
    await new Promise<void>((resolver, rechazar) => {
      const transaccion = base.transaction(ALMACEN, 'readwrite');
      const almacen = transaccion.objectStore(ALMACEN);
      for (const id of ids) almacen.delete(id);
      transaccion.oncomplete = () => resolver();
      transaccion.onerror = () => rechazar(transaccion.error);
    });
  } catch {
    // Si no se pueden borrar, se volverán a mandar y el servidor los
    // descartará por repetidos. Molesto, no grave.
  }
}
