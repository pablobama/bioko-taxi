// Situar barrios sobre el terreno (migración 025).
//
// Ocho barrios de Malabo no existían para la aplicación porque ninguna fuente
// —ni OSM— sabía dónde están. La única forma de arreglarlo es que alguien vaya
// y lo diga desde allí, con el GPS de su teléfono. Esto es lo que pasa cuando
// pulsa «estoy aquí».
//
// LO QUE NO PUEDE FALTAR: la adyacencia. El reparto extiende la búsqueda a los
// barrios vecinos en la tercera oleada, y un barrio sin vecinos declarados es
// un barrio al que el reparto no llega: devolvería «no hay taxi» teniendo uno
// a cuatrocientos metros. Por eso situar un barrio SIEMPRE recose la
// adyacencia antes de dar la operación por buena.

import type pg from 'pg';

// Las mismas reglas que scripts/importar-barrios.ts, y a propósito: si se
// separan, el mapa quedaría cosido con dos criterios distintos según lo
// cargara el importador o alguien desde la calle.
const VECINDAD_M = 2_500;
const VECINAS_MINIMAS = 3;

// Tope de vecinas por barrio. No lo tiene el importador porque trabaja sobre
// los 47 barrios reales, donde nadie llega a esto; aquí hace falta porque esta
// función corre en producción sobre una tabla que crece. Sin tope, un barrio
// en el centro de una ciudad densa podría acabar declarando vecinas a decenas
// —y la tercera oleada del reparto dejaría de ser «los de al lado» para
// convertirse en «media ciudad», que es justo lo que las oleadas evitan.
const VECINAS_MAXIMAS = 12;

// Distancia en metros dentro de SQL: evita traerse la tabla entera a memoria.
// La primera versión de esto recalculaba TODAS las zonas en JavaScript, y con
// las zonas que dejan las pruebas en la base local eso eran 39 millones de
// pares por cada barrio situado: cuarenta segundos, y con `zona_adyacencia`
// bloqueada entera mientras tanto —la misma tabla que el reparto lee en cada
// carrera—. Se corrige lo que cambia y nada más.
const DISTANCIA_SQL = `
  2 * 6371000 * asin(sqrt(
    power(sin(radians($2 - z.centroide_lat) / 2), 2)
    + cos(radians($2)) * cos(radians(z.centroide_lat))
      * power(sin(radians($3 - z.centroide_lng) / 2), 2)
  ))`;

// Recose la adyacencia de UN barrio: borra sus parejas y las vuelve a calcular
// contra las zonas situadas más cercanas. Devuelve cuántas vecinas le quedan.
//
// Solo entre distritos urbanos (zona_padre_id IS NULL): un barrio/calle
// (migración 031) nunca es candidata a vecina de nadie, aunque tenga
// centroide — el reparto solo conoce distritos urbanos.
async function recoserAdyacencia(
  cliente: pg.ClientBase,
  zonaId: number,
  lat: number,
  lng: number,
): Promise<number> {
  const candidatas = await cliente.query(
    `SELECT z.id, ${DISTANCIA_SQL} AS d
     FROM zona z
     WHERE z.id <> $1 AND z.centroide_lat IS NOT NULL AND z.centroide_lng IS NOT NULL
       AND z.zona_padre_id IS NULL
     ORDER BY d
     LIMIT $4`,
    [zonaId, lat, lng, VECINAS_MAXIMAS],
  );

  // Cerca, o entre las más cercanas aunque esté lejos: ningún barrio puede
  // quedar aislado del reparto.
  const vecinas = candidatas.rows
    .filter((f: { d: number }, i: number) => Number(f.d) <= VECINDAD_M || i < VECINAS_MINIMAS)
    .map((f: { id: number }) => f.id);

  await cliente.query(
    'DELETE FROM zona_adyacencia WHERE zona_id = $1 OR zona_adyacente_id = $1',
    [zonaId],
  );
  if (vecinas.length > 0) {
    // En los dos sentidos: así lo espera la consulta del reparto.
    await cliente.query(
      `INSERT INTO zona_adyacencia (zona_id, zona_adyacente_id)
       SELECT $1, v FROM unnest($2::bigint[]) AS v
       UNION ALL
       SELECT v, $1 FROM unnest($2::bigint[]) AS v
       ON CONFLICT DO NOTHING`,
      [zonaId, vecinas],
    );
  }
  return vecinas.length;
}

// Al recoser un barrio se le quitan sus parejas viejas, y eso puede dejar sin
// vecinas a otro que solo lo tenía a él. Se comprueba únicamente entre los que
// acaban de perder la pareja: son doce como mucho, no hace falta barrer la
// tabla.
async function reconectarAislados(
  cliente: pg.ClientBase,
  sospechosos: number[],
): Promise<void> {
  for (const id of sospechosos) {
    const tiene = await cliente.query(
      'SELECT 1 FROM zona_adyacencia WHERE zona_id = $1 LIMIT 1',
      [id],
    );
    if ((tiene.rowCount ?? 0) > 0) continue;
    const donde = await cliente.query(
      'SELECT centroide_lat AS lat, centroide_lng AS lng FROM zona WHERE id = $1',
      [id],
    );
    if (donde.rowCount === 0 || donde.rows[0].lat === null) continue;
    await recoserAdyacencia(cliente, id, Number(donde.rows[0].lat), Number(donde.rows[0].lng));
  }
}

// En qué barrio está un punto. Sin polígonos de zona (P1-02) lo único que
// se puede decir con lo que hay es «el barrio cuyo centro queda más cerca»,
// que no es lo mismo que «el barrio que te contiene» pero en una ciudad de
// barrios pequeños acierta casi siempre. Cuando existan los polígonos, esta
// es la función que hay que cambiar, y solo esta.
//
// Solo barrios (zona_padre_id IS NULL): una calle o sub-barrio no es una
// unidad de reparto, así que nadie puede estar «trabajando» en ella.
export async function barrioMasCercano(
  cliente: pg.ClientBase | pg.Pool,
  lat: number,
  lng: number,
): Promise<{ id: number; nombre: string } | null> {
  const res = await cliente.query(
    `SELECT z.id, z.nombre
     FROM zona z
     WHERE z.zona_padre_id IS NULL
       AND z.centroide_lat IS NOT NULL AND z.centroide_lng IS NOT NULL
     ORDER BY 2 * 6371000 * asin(sqrt(
       power(sin(radians($1 - z.centroide_lat) / 2), 2)
       + cos(radians($1)) * cos(radians(z.centroide_lat))
         * power(sin(radians($2 - z.centroide_lng) / 2), 2)
     ))
     LIMIT 1`,
    [lat, lng],
  );
  return res.rowCount === 0
    ? null
    : { id: Number(res.rows[0].id), nombre: res.rows[0].nombre };
}

export interface ZonaSituada {
  zonaId: number;
  nombre: string;
  referenciaId: number;
  vecinas: number;
  // Radio de error en metros que declaró el teléfono. Se devuelve para poder
  // decirlo en pantalla: «situado con ±8 m» da confianza, «±300 m» avisa de
  // que conviene repetirlo.
  precisionM: number | null;
}

// Pone un barrio en el mapa, en la posición desde la que se está llamando.
//
// El barrio entra por partida doble, igual que en el importador: como ZONA
// —donde el taxista declara que trabaja— y como REFERENCIA buscable, porque
// «llévame a Ela Nguema» es como se pide un taxi de verdad, mucho más que
// dando el nombre de un comercio.
export async function situarZona(
  cliente: pg.ClientBase,
  zonaId: number,
  lat: number,
  lng: number,
  // Radio de error del GPS en metros (coords.accuracy). Se guarda además de
  // validarse en la API: sin él no hay forma de saber después qué barrios
  // convendría volver a tomar (P25-02).
  precisionM: number | null = null,
): Promise<ZonaSituada> {
  const zona = await cliente.query(
    `UPDATE zona SET centroide_lat = $2, centroide_lng = $3, precision_gps_m = $4
     WHERE id = $1 RETURNING nombre, zona_padre_id`,
    [zonaId, lat, lng, precisionM],
  );
  if (zona.rowCount === 0) {
    throw new Error(`No existe la zona con identificador ${zonaId}.`);
  }
  const nombre: string = zona.rows[0].nombre;
  // Barrio/calle (migración 031): tiene padre, así que no es unidad de
  // reparto — no calcula ni recibe adyacencia, solo su centroide y su
  // referencia propia.
  const esBarrioOCalle = zona.rows[0].zona_padre_id !== null;

  // La referencia del propio barrio se crea o se recoloca. Clave natural
  // (zona, nombre), como en el resto del gazetteer: mover un barrio no puede
  // dejar dos entradas suyas en el buscador.
  const referencia = await cliente.query(
    `INSERT INTO referencia (zona_id, nombre, lat, lng, categoria)
     VALUES ($1, $2, $3, $4, 'zona')
     ON CONFLICT (zona_id, nombre) DO UPDATE
       SET lat = EXCLUDED.lat, lng = EXCLUDED.lng, activa = true
     RETURNING id`,
    [zonaId, nombre, lat, lng],
  );

  let vecinas = 0;
  if (!esBarrioOCalle) {
    // Quiénes eran sus vecinas ANTES: si alguna se queda sin ninguna al
    // recoser, hay que devolverla al mapa.
    const antiguas = await cliente.query(
      'SELECT zona_adyacente_id AS id FROM zona_adyacencia WHERE zona_id = $1',
      [zonaId],
    );
    vecinas = await recoserAdyacencia(cliente, zonaId, lat, lng);
    await reconectarAislados(cliente, antiguas.rows.map((f: { id: number }) => f.id));
  }

  return { zonaId, nombre, referenciaId: referencia.rows[0].id, vecinas, precisionM };
}

// Crea un barrio que no estaba en ninguna lista y lo sitúa de una vez. Pasa:
// quien va por la calle encuentra barrios que ni OSM ni el censo tenían.
//
// Con zonaPadreId (migración 031): crea un barrio/calle DENTRO de un
// distrito urbano en vez de un distrito urbano nuevo. Solo un nivel de
// hijos — si el padre indicado ya tiene padre él mismo, error explícito en
// vez de dejar crecer una jerarquía que nadie pidió.
export async function crearZonaEnGps(
  cliente: pg.ClientBase,
  nombre: string,
  lat: number,
  lng: number,
  precisionM: number | null = null,
  zonaPadreId: number | null = null,
): Promise<ZonaSituada> {
  if (zonaPadreId !== null) {
    const padre = await cliente.query(
      'SELECT zona_padre_id FROM zona WHERE id = $1',
      [zonaPadreId],
    );
    if (padre.rowCount === 0) {
      throw new Error(`No existe la zona con identificador ${zonaPadreId}.`);
    }
    if (padre.rows[0].zona_padre_id !== null) {
      throw new Error('Ese distrito urbano ya es un barrio/calle: no puede tener barrios/calles dentro.');
    }
  }
  const creada = await cliente.query(
    `INSERT INTO zona (nombre, zona_padre_id) VALUES ($1, $2)
     ON CONFLICT (nombre) DO UPDATE
       SET nombre = EXCLUDED.nombre, zona_padre_id = EXCLUDED.zona_padre_id
     RETURNING id`,
    [nombre, zonaPadreId],
  );
  return situarZona(cliente, creada.rows[0].id, lat, lng, precisionM);
}
