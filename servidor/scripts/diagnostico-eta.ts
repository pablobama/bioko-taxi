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
// SOLO LECTURA: no escribe ni una fila. Se puede ejecutar contra producción
// con la tranquilidad de que lo único que hace es mirar.
//
// USO. Contra la base de desarrollo:
//
//   npx tsx scripts/diagnostico-eta.ts
//
// Contra PRODUCCIÓN, que es donde están los viajes de verdad (lo ejecuta el
// operador; aquí no se toca esa base):
//
//   cd C:\Users\pablo\red\servidor
//   npx tsx scripts/diagnostico-eta.ts 7
//
// La URL de producción se coge sola de `servidor/.env`; no hay que escribirla.
// Para forzar otra base: $env:BD_URL = '...' (PowerShell) antes de la orden.
//
// El número son los días hacia atrás que se miran (por defecto 1: hoy).

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearPool } from '../src/bd/conexion.js';
import { urlBaseDatos } from '../src/bd/migrar.js';
import { rutaParaLlegar } from '../src/dominio/carreteras.js';
import {
  estimarLlegada, factorDeMarchaDelTurno, velocidadDelTurnoKmh, velocidadRecienteKmh,
} from '../src/dominio/llegada.js';
import { distanciaMetros } from '../src/dominio/geo.js';

// El `.env` del servidor, se lance desde donde se lance (igual que
// `unificar-conductor.ts`). Sin esto había que escribir la URL a mano, y una
// URL escrita a mano se escribe mal.
if (process.env.BD_URL === undefined) {
  const env = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(env)) process.loadEnvFile(env);
}

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
  // A qué base se está mirando, dicho antes de nada y sin credenciales: un
  // informe sobre la base equivocada es peor que no tener informe.
  const url = urlBaseDatos();
  const local = /localhost|127\.0\.0\.1/.test(url);
  const host = url.replace(/^[^@]*@/, '').split('/')[0];
  console.log(`Base: ${local ? 'LOCAL (desarrollo)' : `PRODUCCIÓN (${host})`}\n`);

  const pool = crearPool();
  // SOLO LECTURA. Este script no escribe ni una fila: se ejecuta contra la
  // base de producción y lo único que hace es mirar.
  const parametros = await leerParametros(pool);
  if (parametros === null) {
    await pool.end();
    process.exit(1);
  }

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
    const caminoAhora = rutaParaLlegar(desde, hasta);
    const rectaAhora = distanciaMetros(desde.lat, desde.lng, hasta.lat, hasta.lng);
    const creible = caminoAhora !== null
      && caminoAhora.distanciaM <= rectaAhora * 3 + 500
      && caminoAhora.distanciaM >= rectaAhora;
    const antes = conCalculoViejo(
      parametros, rectaAhora, creible ? caminoAhora!.distanciaM : null, medida,
    );
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

// El cálculo de antes de la migración 073, reproducido AQUÍ: distancia
// partido por una velocidad.
//
// Se copia en vez de llamar al código real con el interruptor apagado, y es a
// propósito: apagarlo significaba ESCRIBIR en `parametro`, o sea cambiar cómo
// se calcula el tiempo para todo el mundo mientras dura el diagnóstico, y
// dejarlo apagado para siempre si el proceso se corta en medio. Un diagnóstico
// que se ejecuta contra producción no puede tocar producción. Son cuatro
// líneas duplicadas y la duplicación se paga sola.
function conCalculoViejo(
  parametros: Parametros,
  rectaM: number,
  porCallesM: number | null,
  medida: number | null,
): { minutos: number } {
  const km = (porCallesM ?? rectaM * (parametros.factorDesvioDecimas / 10)) / 1000;
  const urbana = medida ?? parametros.urbanaKmh;
  const ciudad = Math.min(km, parametros.tramoUrbanoKm);
  const carretera = Math.max(0, km - parametros.tramoUrbanoKm);
  const horas = ciudad / urbana + carretera / parametros.interurbanaKmh;
  return { minutos: Math.max(1, Math.round(horas * 60)) };
}

interface Parametros {
  urbanaKmh: number;
  interurbanaKmh: number;
  tramoUrbanoKm: number;
  factorDesvioDecimas: number;
}

// Los parámetros, leídos UNA vez. Y de paso la comprobación de que la base
// tiene ya la migración 073: sin ella, el cálculo nuevo ni siquiera arranca y
// más vale decirlo que reventar a mitad de la tabla.
async function leerParametros(pool: ReturnType<typeof crearPool>): Promise<Parametros | null> {
  const res = await pool.query(
    `SELECT clave, valor FROM parametro
     WHERE clave IN ('velocidad_urbana_kmh', 'velocidad_interurbana_kmh',
                     'eta_tramo_urbano_km', 'eta_factor_desvio', 'eta_usa_plano')`,
  );
  const mapa = new Map(res.rows.map((f: { clave: string; valor: string }) => [f.clave, f.valor]));
  if (!mapa.has('eta_usa_plano')) {
    console.error(
      'Esta base todavía no tiene la migración 073 (el cálculo nuevo del tiempo).\n'
      + 'Despliega primero, o ejecuta las migraciones, y vuelve a lanzarlo.',
    );
    return null;
  }
  return {
    urbanaKmh: Number(mapa.get('velocidad_urbana_kmh') ?? 18),
    interurbanaKmh: Number(mapa.get('velocidad_interurbana_kmh') ?? 70),
    tramoUrbanoKm: Number(mapa.get('eta_tramo_urbano_km') ?? 5),
    factorDesvioDecimas: Number(mapa.get('eta_factor_desvio') ?? 13),
  };
}

async function conductorDe(pool: ReturnType<typeof crearPool>, viajeId: number): Promise<number> {
  const res = await pool.query('SELECT conductor_id FROM viaje WHERE id = $1', [viajeId]);
  return Number(res.rows[0].conductor_id);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
