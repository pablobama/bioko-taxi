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
import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';
import { rutaParaLlegar } from '../src/dominio/carreteras.js';
import {
  estimarLlegada, factorDeMarchaDelTurno, velocidadDelTurnoKmh, velocidadRecienteKmh,
} from '../src/dominio/llegada.js';
import { distanciaMetros } from '../src/dominio/geo.js';
import { medirViaje, type Calidad } from '../src/dominio/medida.js';

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

  // El plano, ANTES de abrir la base. Cargarlo son unos segundos de CPU, y
  // hacerlo con una conexión abierta es lo que el pooler de Supabase entiende
  // como conexión muerta: «Connection terminated unexpectedly» a mitad del
  // informe. Con esto, la pausa larga ocurre antes de que haya nada que
  // cerrar.
  process.stdout.write('Cargando el plano de calles… ');
  rutaParaLlegar({ lat: 3.7531, lng: 8.7752 }, { lat: 3.7553, lng: 8.7789 });
  console.log('listo\n');

  // `keepAlive`: el sistema operativo manda señales de vida por el socket y el
  // pooler deja de dar la conexión por perdida entre dos consultas.
  const pool = new pg.Pool({ connectionString: urlBaseDatos(), keepAlive: true, max: 2 });
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
  let fallados = 0;
  let descartados = 0;
  const relativos: number[] = [];
  // Cuánto se equivocaron los botones frente al rastro, viaje a viaje.
  const desfases: number[] = [];
  // Para los que no se pudieron medir: lo más que se acercó el coche a la punta
  // que falló. Es lo que dice si hay que aflojar el listón o mirar otra cosa.
  const lejos: number[] = [];
  const porCalidad = new Map<Calidad, number>();
  // «Botones» es lo que dicen RECOGIDO y COMPLETADO; «rastro» es lo que tardó
  // el coche de verdad en ir del origen al destino. Cuando no coinciden manda el
  // rastro, porque un sello que alguien pulsa no es una medida.
  console.log('viaje |  km  | antes | nuevo | botones | rastro | error  | factor | de');
  console.log('-'.repeat(78));

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

    // CUÁNTO DURÓ DE VERDAD, por el rastro y no por los botones.
    //
    // Es el cambio de fondo del 29/09: RECOGIDO y COMPLETADO los pulsa alguien,
    // y buena parte de los viajes de producción se generaron pulsándolos para
    // medir recorridos. Un sello que se pulsa para producir un dato no puede ser
    // la fuente de ese dato. Cuando el rastro puede medirlo, manda el rastro; y
    // cuando no puede, este viaje NO entra en ninguna media.
    try {
    const medidaReal = await medirViaje(pool, {
      conductorId: await conductorDe(pool, fila.viaje_id),
      origen: { lat: Number(fila.o_lat), lng: Number(fila.o_lng) },
      destino: { lat: Number(fila.d_lat), lng: Number(fila.d_lng) },
      recogidoEn: recogido,
      completadoEn: new Date(fila.completado_en),
    });
    const duroMin = medidaReal.minutos ?? tardoMin;
    porCalidad.set(medidaReal.calidad, (porCalidad.get(medidaReal.calidad) ?? 0) + 1);
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
    const error = estimacion.minutos - duroMin;
    const errorViejo = antes.minutos - duroMin;
    // Qué viajes entran en la media: SOLO los que el rastro pudo medir.
    //
    // Antes esto era un filtro a ojo —fuera los que van a más de 90 km/h o
    // duran menos de un minuto—, que acertaba por casualidad: lo que delataba a
    // esos viajes no era su velocidad, era que su duración venía de un botón.
    // Ahora el criterio es el correcto y además se puede explicar: si el coche
    // no se vio salir del origen y llegar al destino, no hay medida, y sin
    // medida no hay error que promediar.
    const creibleViaje = medidaReal.calidad === 'buena';
    if (creibleViaje) {
      errores.push(error);
      erroresViejos.push(errorViejo);
      relativos.push(duroMin > 0 ? error / duroMin : 0);
      // Lo que se equivocaron los botones. Es la medida de P74-01, y ahora sale
      // viaje a viaje en vez de por sospecha.
      if (medidaReal.desfaseMin !== null) desfases.push(medidaReal.desfaseMin);
    } else {
      descartados += 1;
      if (medidaReal.calidad === 'parcial') {
        lejos.push(Math.max(
          medidaReal.masCercaDelOrigenM ?? 0, medidaReal.masCercaDelDestinoM ?? 0,
        ));
      }
    }

    const deDonde = delViaje !== null ? 'viaje' : delTurno !== null ? 'turno' : 'tabla';
    console.log(
      `${String(fila.viaje_id).padStart(5)} | `
      + `${(estimacion.distanciaM / 1000).toFixed(1).padStart(4)} | `
      + `${String(antes.minutos).padStart(5)} | `
      + `${String(estimacion.minutos).padStart(5)} | `
      + `${tardoMin.toFixed(1).padStart(7)} | `
      + `${medidaReal.minutos === null ? '    — ' : medidaReal.minutos.toFixed(1).padStart(6)} | `
      + `${(error >= 0 ? '+' : '') + error.toFixed(1)}`.padStart(7) + ' | '
      + `${factor === null ? ' —  ' : factor.toFixed(2)} | ${deDonde}`
      + (creibleViaje
        ? (Math.abs(medidaReal.desfaseMin ?? 0) > 3
          ? `  ← los botones se equivocaron ${(medidaReal.desfaseMin ?? 0).toFixed(0)} min`
          : '')
        : `  ← fuera de la media: ${medidaReal.calidad === 'sin_rastro'
          ? 'no hay rastro del coche'
          : `el coche no pasó cerca del ${
            (medidaReal.masCercaDelOrigenM ?? 0) > (medidaReal.masCercaDelDestinoM ?? 0)
              ? 'ORIGEN' : 'DESTINO'} (origen ${medidaReal.masCercaDelOrigenM} m,`
            + ` destino ${medidaReal.masCercaDelDestinoM} m)`}`),
    );

    // Y a qué velocidad fue de verdad, por las calles: es el número que hay
    // que aprender a predecir.
    const porCalles = rutaParaLlegar(desde, hasta);
    const recta = distanciaMetros(desde.lat, desde.lng, hasta.lat, hasta.lng);
    const km = (porCalles !== null && porCalles.distanciaM <= recta * 3 + 500
      ? porCalles.distanciaM : recta * 1.3) / 1000;
    console.log(
      `      · ${fila.origen} → ${fila.destino}`
      + ` · fue a ${(km / (duroMin / 60)).toFixed(1)} km/h`
      + (porCalles !== null ? ` · el plano suponía ${(km / (porCalles.segundosTipicos / 3600)).toFixed(1)} km/h` : ''),
    );
    } catch (error) {
      // Un viaje que no se puede medir no puede llevarse por delante el
      // informe entero: se dice cuál y se sigue con el siguiente.
      fallados += 1;
      console.log(`${String(fila.viaje_id).padStart(5)} | no se pudo medir:`
        + ` ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (errores.length === 0) {
    // No es «no hay viajes»: es que ninguno se pudo medir con el rastro, y eso
    // es un resultado en sí mismo que hay que decir con su motivo. Promediar
    // los que solo tienen botones sería volver al problema que esto viene a
    // resolver.
    console.log('');
    console.log('='.repeat(60));
    console.log('Ningún viaje se pudo medir por el rastro, así que no hay media');
    console.log('que dar. Lo que había:');
    console.log('');
    for (const [c, n] of porCalidad) {
      console.log(`  ${String(n).padStart(4)} ${{
        buena: 'con el viaje entero en el rastro',
        parcial: 'con rastro incompleto (falta el principio o el final)',
        sin_rastro: 'SIN NADA de rastro del coche',
      }[c]}`);
    }
    console.log('');
    console.log('Sin rastro no hay nada que medir, y eso no se arregla con un');
    console.log('cálculo mejor: se arregla haciendo que el recorrido se grabe.');
    await pool.end();
    return;
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Viajes medidos POR EL RASTRO: ${errores.length}`
    + (descartados > 0 ? ` · ${descartados} sin rastro que los mida` : '')
    + (fallados > 0 ? ` · ${fallados} no se pudieron mirar` : ''));
  console.log('  ' + [...porCalidad.entries()]
    .map(([c, n]) => `${n} ${{
      buena: 'con el viaje entero en el rastro',
      parcial: 'con rastro incompleto',
      sin_rastro: 'SIN NADA de rastro',
    }[c]}`).join(' · '));

  // Lo que se equivocaron los botones. Es la medida de P74-01, y hasta ahora
  // solo se tenía por sospecha: viajes de 6 km «cerrados en 30 segundos». Aquí
  // sale el número, y sale de comparar dos cosas que se midieron aparte.
  if (lejos.length > 0) {
    // «El rastro no cubre el viaje» son tres problemas distintos y sin repartir
    // no se sabe cuál arreglar. Con el listón en 200 m: si el coche pasó a 300
    // el listón está apretado; si pasó a tres kilómetros, o la referencia está
    // mal situada o el recorrido no se grabó.
    const rozando = lejos.filter((m) => m <= 600).length;
    const lejisimos = lejos.filter((m) => m > 2000).length;
    console.log('');
    console.log('De los que el rastro no cubre, lo más que se acercó el coche a la');
    console.log('punta que falló:');
    console.log(`  ${rozando} se quedaron a menos de 600 m — el listón de 200 m es`);
    console.log('    demasiado apretado para un punto cada minuto, y se arregla aflojándolo');
    console.log(`  ${lejisimos} pasaron a más de 2 km — ahí no es el listón: o la`);
    console.log('    referencia está en el sitio equivocado, o no se grabó el recorrido');
    console.log(`  mediana ${percentil(lejos, 0.5).toFixed(0)} m`);
  }

  if (desfases.length > 0) {
    const grandes = desfases.filter((d) => Math.abs(d) > 3).length;
    console.log(`
Los botones frente al rastro: se equivocaron más de 3 minutos en`
      + ` ${grandes} de ${desfases.length} viajes`
      + ` (mediana ${percentil(desfases, 0.5).toFixed(1)} min,`
      + ` el peor ${desfases.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0).toFixed(0)}).`);
    console.log('  Negativo = se cerró ANTES de tiempo; positivo = se cerró tarde.');
  }

  const media = errores.reduce((a, b) => a + b, 0) / errores.length;
  const mediaVieja = erroresViejos.reduce((a, b) => a + b, 0) / erroresViejos.length;
  console.log(`Error medio ANTES: ${mediaVieja >= 0 ? '+' : ''}${mediaVieja.toFixed(1)} min`);
  console.log(`Error medio AHORA: ${media >= 0 ? '+' : ''}${media.toFixed(1)} min`
    + ` (positivo = la aplicación dice MÁS de lo que se tarda)`);
  console.log(`Mediana: ${percentil(errores, 0.5).toFixed(1)} min`
    + ` · p90 ${percentil(errores, 0.9).toFixed(1)} · peor ${Math.max(...errores).toFixed(1)}`);
  // La media de proporciones se la comen los viajes cortos, así que se enseña
  // la mediana: es la que dice cómo va el tiempo en el viaje típico.
  console.log(`En proporción (mediana): ${(percentil(relativos, 0.5) * 100).toFixed(0)} %`);
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
async function leerParametros(pool: pg.Pool): Promise<Parametros | null> {
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

async function conductorDe(pool: pg.Pool, viajeId: number): Promise<number> {
  const res = await pool.query('SELECT conductor_id FROM viaje WHERE id = $1', [viajeId]);
  return Number(res.rows[0].conductor_id);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
