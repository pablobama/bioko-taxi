// ¿Cuánto se equivoca el tiempo hasta destino? (diagnóstico del 28/09)
//
// EL CASO QUE LO PROVOCA, contado por quien conducía: una carrera de unos 7 km
// que la aplicación marcaba en 35 minutos al empezar y que se hizo en 15. O
// sea, la aplicación dio por hecho que el taxi iría a 12 km/h y fue a 28.
//
// Este script NO adivina: reconstruye. Para cada viaje terminado coge lo que
// de verdad pasó —cuándo recogió, cuándo terminó, por dónde fue— y vuelve a
// calcular el tiempo que la aplicación habría dicho en el momento de la
// recogida, con los mismos datos que tenía entonces. Así se puede comparar
// «lo que dijo» con «lo que tardó» sin haber guardado la predicción.
//
// USO. Contra la base de desarrollo:
//
//   npx tsx scripts/diagnostico-eta.ts
//
// Contra PRODUCCIÓN, que es donde están los viajes de verdad (lo ejecuta el
// operador; aquí no se toca esa base):
//
//   BD_URL='...' npx tsx scripts/diagnostico-eta.ts 7
//
// El número son los días hacia atrás que se miran (por defecto 1: hoy).

import { crearPool } from '../src/bd/conexion.js';
import { rutaParaLlegar } from '../src/dominio/carreteras.js';
import {
  estimarLlegada, factorDeMarchaDelTurno, velocidadDelTurnoKmh, velocidadRecienteKmh,
} from '../src/dominio/llegada.js';
import { distanciaMetros } from '../src/dominio/geo.js';

const DIAS = Number(process.argv[2] ?? 1);

interface Viaje {
  viaje_id: number;
  solicitud_id: number;
  conductor: string;
  origen: string;
  destino: string;
  recogido_en: Date;
  completado_en: Date;
  o_lat: number; o_lng: number;
  d_lat: number; d_lng: number;
}

const minutos = (ms: number) => ms / 60000;

function percentil(valores: number[], fraccion: number): number {
  if (valores.length === 0) return 0;
  const orden = [...valores].sort((a, b) => a - b);
  return orden[Math.min(orden.length - 1, Math.round(fraccion * (orden.length - 1)))];
}

async function main(): Promise<void> {
  const pool = crearPool();

  // Los viajes terminados del periodo, con la hora REAL de recogida y de
  // cierre sacadas del registro de transiciones, que es el que no miente.
  const viajes = await pool.query(
    `SELECT v.id AS viaje_id, s.id AS solicitud_id, c.nombre AS conductor,
            ro.nombre AS origen, rd.nombre AS destino,
            ro.lat AS o_lat, ro.lng AS o_lng, rd.lat AS d_lat, rd.lng AS d_lng,
            (SELECT min(COALESCE(t.ocurrio_en, t.creado_en)) FROM transicion t
             WHERE t.solicitud_id = s.id AND t.estado_nuevo = 'RECOGIDO') AS recogido_en,
            (SELECT min(COALESCE(t.ocurrio_en, t.creado_en)) FROM transicion t
             WHERE t.solicitud_id = s.id AND t.estado_nuevo = 'COMPLETADO') AS completado_en
     FROM viaje v
     JOIN solicitud s ON s.id = v.solicitud_id
     JOIN conductor c ON c.id = v.conductor_id
     JOIN referencia ro ON ro.id = s.referencia_origen_id
     JOIN referencia rd ON rd.id = s.referencia_destino_id
     WHERE s.estado = 'COMPLETADO'
       AND s.creada_en >= now() - make_interval(days => $1)
     ORDER BY s.creada_en`,
    [DIAS],
  );

  console.log(`Viajes completados en los últimos ${DIAS} día(s): ${viajes.rowCount}\n`);
  if (viajes.rowCount === 0) {
    console.log('Nada que medir. Prueba con más días.');
    await pool.end();
    return;
  }

  const errores: number[] = [];
  const erroresViejos: number[] = [];
  const relativos: number[] = [];
  console.log('viaje |  km  | antes | nuevo | tardó | error  | factor | velocidad de');
  console.log('-'.repeat(72));

  for (const fila of viajes.rows as Viaje[]) {
    if (fila.recogido_en === null || fila.completado_en === null) continue;
    const recogido = new Date(fila.recogido_en);
    const tardoMin = minutos(new Date(fila.completado_en).getTime() - recogido.getTime());
    if (tardoMin <= 0 || tardoMin > 180) continue;

    // Desde dónde salió de verdad: la última posición del conductor ANTES de
    // recoger. Si no hay, el punto de recogida del catálogo.
    const posicion = await pool.query(
      `SELECT lat, lng FROM posicion
       WHERE viaje_id = $1 AND actor = 'conductor' AND creado_en <= $2
       ORDER BY creado_en DESC LIMIT 1`,
      [fila.viaje_id, recogido],
    );
    const desde = posicion.rowCount === 0
      ? { lat: Number(fila.o_lat), lng: Number(fila.o_lng) }
      : { lat: Number(posicion.rows[0].lat), lng: Number(posicion.rows[0].lng) };
    const hasta = { lat: Number(fila.d_lat), lng: Number(fila.d_lng) };

    // La velocidad que la aplicación habría tenido a mano EN ESE MOMENTO: la
    // del viaje si ya había posiciones, y si no la del turno.
    const delViaje = await velocidadRecienteKmh(pool, fila.viaje_id, recogido);
    const delTurno = delViaje !== null
      ? null
      : await velocidadDelTurnoKmh(pool, await conductorDe(pool, fila.viaje_id), recogido);
    const medida = delViaje ?? delTurno;

    // El cálculo de ANTES (velocidad media, incluyendo esperas) y el NUEVO
    // (tiempo del plano corregido por el factor en marcha). Se enseñan los dos
    // para poder decidir con números y no por corazonada.
    const conductorId = await conductorDe(pool, fila.viaje_id);
    const factor = await factorDeMarchaDelTurno(pool, conductorId, recogido);
    const antes = await conCalculoViejo(pool, desde, hasta, medida);
    const estimacion = await estimarLlegada(pool, desde, hasta, medida, factor);
    const error = estimacion.minutos - tardoMin;
    const errorViejo = antes.minutos - tardoMin;
    errores.push(error);
    erroresViejos.push(errorViejo);
    relativos.push(tardoMin > 0 ? error / tardoMin : 0);

    const deDonde = delViaje !== null ? 'viaje' : delTurno !== null ? 'turno' : 'tabla';
    console.log(
      `${String(fila.viaje_id).padStart(5)} | `
      + `${(estimacion.distanciaM / 1000).toFixed(1).padStart(4)} | `
      + `${String(antes.minutos).padStart(5)} | `
      + `${String(estimacion.minutos).padStart(5)} | `
      + `${tardoMin.toFixed(1).padStart(5)} | `
      + `${(error >= 0 ? '+' : '') + error.toFixed(1)}`.padStart(7) + ' | '
      + `${factor === null ? ' —  ' : factor.toFixed(2)} | ${deDonde}`,
    );

    // Y a qué velocidad fue de verdad, por las calles: es el número que hay
    // que aprender a predecir.
    const porCalles = rutaParaLlegar(desde, hasta);
    const recta = distanciaMetros(desde.lat, desde.lng, hasta.lat, hasta.lng);
    const km = (porCalles !== null && porCalles.distanciaM <= recta * 3 + 500
      ? porCalles.distanciaM : recta * 1.3) / 1000;
    console.log(
      `      · ${fila.origen} → ${fila.destino}`
      + ` · fue a ${(km / (tardoMin / 60)).toFixed(1)} km/h`
      + (porCalles !== null ? ` · el plano suponía ${(km / (porCalles.segundosTipicos / 3600)).toFixed(1)} km/h` : ''),
    );
  }

  if (errores.length === 0) {
    console.log('\nNingún viaje con recogida y cierre en el registro.');
    await pool.end();
    return;
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Viajes medidos: ${errores.length}`);
  const media = errores.reduce((a, b) => a + b, 0) / errores.length;
  const mediaVieja = erroresViejos.reduce((a, b) => a + b, 0) / erroresViejos.length;
  console.log(`Error medio ANTES: ${mediaVieja >= 0 ? '+' : ''}${mediaVieja.toFixed(1)} min`);
  console.log(`Error medio AHORA: ${media >= 0 ? '+' : ''}${media.toFixed(1)} min`
    + ` (positivo = la aplicación dice MÁS de lo que se tarda)`);
  console.log(`Mediana: ${percentil(errores, 0.5).toFixed(1)} min`
    + ` · p90 ${percentil(errores, 0.9).toFixed(1)} · peor ${Math.max(...errores).toFixed(1)}`);
  const mediaRel = relativos.reduce((a, b) => a + b, 0) / relativos.length;
  console.log(`En proporción: ${(mediaRel * 100).toFixed(0)} % de más de media`);
  const largos = errores.filter((e) => e > 5).length;
  console.log(`Viajes con más de 5 min de exceso: ${largos} de ${errores.length}`);

  await pool.end();
}

// El cálculo de antes de la migración 073: distancia partido por una
// velocidad. Se fuerza apagando el interruptor solo para esta llamada.
async function conCalculoViejo(
  pool: ReturnType<typeof crearPool>,
  desde: { lat: number; lng: number },
  hasta: { lat: number; lng: number },
  medida: number | null,
): Promise<{ minutos: number }> {
  const previo = await pool.query(`SELECT valor FROM parametro WHERE clave = 'eta_usa_plano'`);
  await pool.query(`UPDATE parametro SET valor = '0' WHERE clave = 'eta_usa_plano'`);
  try {
    return await estimarLlegada(pool, desde, hasta, medida);
  } finally {
    await pool.query(
      `UPDATE parametro SET valor = $1 WHERE clave = 'eta_usa_plano'`,
      [previo.rows[0]?.valor ?? '1'],
    );
  }
}

async function conductorDe(pool: ReturnType<typeof crearPool>, viajeId: number): Promise<number> {
  const res = await pool.query('SELECT conductor_id FROM viaje WHERE id = $1', [viajeId]);
  return Number(res.rows[0].conductor_id);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
