// Si el metro está torcido, no sirve medir nada (29/09).
//
// EL PROBLEMA, visto en los datos de producción: dos viajes «Club Náutico →
// Ventage Mall» de 49,3 km. Los dos sitios están en Malabo, y 49 km es cruzar
// la isla hasta Luba. Y otro «Tesorería General del Estado → Tesorería General»
// de 0,1 km: el mismo sitio con dos fichas.
//
// Eso no es un fallo de la medición del tiempo ni de los cierres: es que LA
// DISTANCIA es falsa. Y con la distancia falsa sale falsa la velocidad, falso
// el error del tiempo hasta destino, y falso el precio orientativo que se le
// enseña al pasajero. Antes de afinar ningún cálculo hay que enderezar el
// metro.
//
// Aquí viven las tres comprobaciones que encuentran eso. Ninguna corrige sola:
// cuál de las dos fichas está bien es cosa de quien conoce Malabo, y esto lo
// que hace es ponerle delante la lista corta.

import type pg from 'pg';
import { distanciaMetros } from './geo.js';
import { clave } from './sitios.js';

type Lector = pg.Pool | pg.ClientBase;

// La isla, con holgura. Todo lo que caiga fuera está mal puesto, sin discusión
// posible: no hay ningún sitio de Malabo en el mar de Guinea ni en Camerún.
export const BIOKO = { latMin: 3.18, latMax: 3.83, lngMin: 8.38, lngMax: 8.98 };

// Dos fichas del mismo sitio. Se busca por CERCANÍA y por NOMBRE a la vez: dos
// tiendas distintas en el mismo edificio están cerca y no son duplicados, y dos
// sucursales del mismo banco tienen el mismo nombre y no lo son tampoco.
export const METROS_DUPLICADO = 150;

export interface Duplicada {
  a: { id: number; nombre: string; usos: number };
  b: { id: number; nombre: string; usos: number };
  metros: number;
}

// Una ficha está contenida en la otra: «Tesorería General» y «Tesorería General
// del Estado». No vale comparar por igualdad —nunca serían iguales— ni por
// parecido suelto, que juntaría «Farmacia Central» con «Mercado Central».
function unoContieneAlOtro(x: string, y: string): boolean {
  if (x.length === 0 || y.length === 0) return false;
  if (x === y) return true;
  const corto = x.length <= y.length ? x : y;
  const largo = x.length <= y.length ? y : x;
  // Y que el corto no sea una sola palabra genérica: «central» dentro de
  // «mercado central» no convierte a los dos en el mismo sitio.
  if (!corto.includes(' ')) return false;
  return largo.startsWith(`${corto} `) || largo.endsWith(` ${corto}`)
    || largo.includes(` ${corto} `);
}

export interface Duplicadas {
  // Las primeras, de más pegadas a menos. Es una lista para que la mire una
  // persona, no un volcado.
  pares: Duplicada[];
  // Cuántas hay en total. Medido en la base de desarrollo: 7,5 MILLONES, casi
  // todas del simulador —miles de referencias llamadas «Origen Conductor» en el
  // mismo punto—. Por eso esto devuelve un tope y un recuento en vez de la
  // lista entera: una lista de siete millones no la lee nadie y no cabe en
  // memoria dos veces.
  total: number;
}

export async function duplicadasCerca(
  cliente: Lector,
  {
    metros = METROS_DUPLICADO,
    limite = 200,
    // Un barrio concreto, para revisarlos de uno en uno en vez de tragarse la
    // ciudad entera. Sin él, todas.
    zonaId = null as number | null,
  } = {},
): Promise<Duplicadas> {
  // Por rejilla y no cruzando la tabla consigo misma.
  //
  // La primera versión lo hacía en SQL con un JOIN y un filtro de caja. Con la
  // base de desarrollo —miles de referencias importadas de OSM— eso se queda
  // sin memoria: son millones de parejas materializadas para quedarse con diez.
  // Aquí se traen las referencias una vez, se reparten en casillas del tamaño
  // del radio, y cada una solo se compara con su casilla y las ocho de
  // alrededor. Eso es lineal y no se puede desbordar.
  const res = await cliente.query(
    `SELECT id, nombre, lat, lng, veces_usada FROM referencia
     WHERE activa AND ($1::bigint IS NULL OR zona_id = $1)`,
    [zonaId],
  );
  const lado = metros / 111_000; // el grado de latitud son ~111 km
  const casillas = new Map<string, Array<{
    id: number; nombre: string; clave: string; usos: number; lat: number; lng: number;
  }>>();
  // La clave del nombre se calcula UNA vez por referencia y no en cada
  // comparación: con miles de sitios cada uno se compara con los de nueve
  // casillas, y normalizar ahí dentro convertía dos segundos en tres minutos.
  const todas = res.rows.map((f) => ({
    id: Number(f.id),
    nombre: f.nombre as string,
    clave: clave(f.nombre as string),
    usos: Number(f.veces_usada),
    lat: Number(f.lat),
    lng: Number(f.lng),
  }));
  for (const r of todas) {
    const c = `${Math.floor(r.lat / lado)}:${Math.floor(r.lng / lado)}`;
    const lista = casillas.get(c);
    if (lista) lista.push(r); else casillas.set(c, [r]);
  }

  const salida: Duplicada[] = [];
  let total = 0;
  for (const r of todas) {
    const fila = Math.floor(r.lat / lado);
    const col = Math.floor(r.lng / lado);
    for (let df = -1; df <= 1; df += 1) {
      for (let dc = -1; dc <= 1; dc += 1) {
        for (const otra of casillas.get(`${fila + df}:${col + dc}`) ?? []) {
          // `otra.id > r.id` basta para no repetir la pareja al revés, y evita
          // tener que llevar un conjunto de vistos de millones de cadenas.
          if (otra.id <= r.id) continue;
          // El nombre primero: es una comparación de cadenas ya normalizadas y
          // descarta casi todo antes de calcular ninguna distancia.
          if (!unoContieneAlOtro(r.clave, otra.clave)) continue;
          const d = distanciaMetros(r.lat, r.lng, otra.lat, otra.lng);
          if (d > metros) continue;
          total += 1;
          if (salida.length < limite) {
            salida.push({
              a: { id: r.id, nombre: r.nombre, usos: r.usos },
              b: { id: otra.id, nombre: otra.nombre, usos: otra.usos },
              metros: Math.round(d),
            });
          }
        }
      }
    }
  }
  return { pares: salida.sort((x, y) => x.metros - y.metros), total };
}

export interface FueraDeSitio {
  id: number;
  nombre: string;
  zona: string;
  lat: number;
  lng: number;
  motivo: 'fuera de la isla' | 'lejísimos de su barrio';
  metrosDelBarrio: number | null;
}

// Cuánto puede alejarse una referencia del centro de su barrio antes de que
// haya que mirarla. Malabo entero mide unos 8 km de punta a punta, así que a
// seis kilómetros de su barrio ya no está en su barrio.
export const METROS_DEL_BARRIO = 6_000;

export async function fueraDeSitio(
  cliente: Lector,
  metrosDelBarrio = METROS_DEL_BARRIO,
): Promise<FueraDeSitio[]> {
  const res = await cliente.query(
    `SELECT r.id, r.nombre, r.lat, r.lng, z.nombre AS zona,
            z.centroide_lat, z.centroide_lng
     FROM referencia r JOIN zona z ON z.id = r.zona_id
     WHERE r.activa`,
  );
  const salida: FueraDeSitio[] = [];
  for (const f of res.rows) {
    const lat = Number(f.lat);
    const lng = Number(f.lng);
    if (lat < BIOKO.latMin || lat > BIOKO.latMax
      || lng < BIOKO.lngMin || lng > BIOKO.lngMax) {
      salida.push({
        id: Number(f.id), nombre: f.nombre, zona: f.zona, lat, lng,
        motivo: 'fuera de la isla', metrosDelBarrio: null,
      });
      continue;
    }
    // El barrio sin situar no acusa a nadie: el que no sabe dónde está no puede
    // decir que otro está lejos (migración 025).
    if (f.centroide_lat === null || f.centroide_lng === null) continue;
    const d = distanciaMetros(lat, lng, Number(f.centroide_lat), Number(f.centroide_lng));
    if (d > metrosDelBarrio) {
      salida.push({
        id: Number(f.id), nombre: f.nombre, zona: f.zona, lat, lng,
        motivo: 'lejísimos de su barrio', metrosDelBarrio: Math.round(d),
      });
    }
  }
  return salida.sort((a, b) => (b.metrosDelBarrio ?? Infinity) - (a.metrosDelBarrio ?? Infinity));
}

export interface ParSospechoso {
  origen: string;
  destino: string;
  km: number;
  viajes: number;
}

// Pares de sitios entre los que la distancia no puede ser la que sale. No mira
// el plano ni el rastro: solo la recta entre las dos fichas, que es la cota
// mínima. Si en línea recta ya son cuarenta kilómetros y los dos sitios se
// anuncian como de Malabo, una de las dos fichas está en otro sitio.
export async function paresImposibles(
  cliente: Lector,
  kmMaximo = 20,
): Promise<ParSospechoso[]> {
  const res = await cliente.query(
    `SELECT ro.nombre AS origen, rd.nombre AS destino,
            ro.lat AS o_lat, ro.lng AS o_lng, rd.lat AS d_lat, rd.lng AS d_lng,
            count(*)::int AS viajes
     FROM solicitud s
     JOIN referencia ro ON ro.id = s.referencia_origen_id
     JOIN referencia rd ON rd.id = s.referencia_destino_id
     GROUP BY 1, 2, 3, 4, 5, 6`,
  );
  const salida: ParSospechoso[] = [];
  for (const f of res.rows) {
    const km = distanciaMetros(
      Number(f.o_lat), Number(f.o_lng), Number(f.d_lat), Number(f.d_lng),
    ) / 1000;
    if (km <= kmMaximo) continue;
    salida.push({
      origen: f.origen, destino: f.destino, km: Math.round(km * 10) / 10, viajes: f.viajes,
    });
  }
  return salida.sort((a, b) => b.km - a.km);
}
