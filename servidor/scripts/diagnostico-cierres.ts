// ¿Por qué hay viajes con una duración imposible? (P74-01, 28/09)
//
// EL PROBLEMA. En la última medición de producción, 11 de 50 viajes —el 22 %—
// tenían una duración que no puede ser: 6,5 km cerrados en 30 segundos, 49 km
// en 6 segundos (44.538 km/h), 6,1 km cerrados 168 minutos después. Eso no es
// ruido que se pueda promediar: mientras siga así, NINGÚN número sacado de la
// duración de un viaje es de fiar —ni el tiempo hasta destino, ni la velocidad
// del taxista, ni sus estadísticas—.
//
// LA PREGUNTA QUE RESPONDE, que es una y muy concreta: la duración sale de dos
// sellos de tiempo, RECOGIDO y COMPLETADO, y uno de los dos miente. ¿Cuál?
//
//   - Si el que llega tarde es RECOGIDO, el viaje entero se comprime al final.
//     Es lo que pasa si el taxista conduce con el pasajero dentro y pulsa
//     «recoger» al llegar, justo antes de «terminado». Eso es una costumbre, y
//     se corrige recordándoselo o marcándolo solo por GPS.
//   - Si el que llega pronto es COMPLETADO, el viaje se corta a mitad. Eso sería
//     el cierre automático por separación GPS disparándose antes de tiempo, y
//     eso es un fallo del código.
//
// Las dos explicaciones dan el mismo síntoma y piden arreglos opuestos, así que
// adivinar sale caro. Esto lo mide con lo que ya está guardado:
//
//   1. `transicion` dice QUIÉN provocó cada cambio y por qué (`origen_evento`:
//      `proximidad_gps`, `separacion_gps`, `viaje_caducado`…). Es una tabla que
//      no se puede modificar, así que no miente.
//   2. `rastro` dice POR DÓNDE anduvo el coche. Con eso se puede ver en qué
//      tramo ocurrió de verdad la conducción: si el coche hizo los kilómetros
//      ANTES de que constara la recogida, el sello que llega tarde es RECOGIDO.
//
// SOLO LECTURA: no escribe ni una fila.
//
// USO. Contra la base de desarrollo:
//
//   npx tsx scripts/diagnostico-cierres.ts
//
// Contra PRODUCCIÓN, que es donde están los viajes de verdad:
//
//   cd C:\Users\pablo\red\servidor
//   npx tsx scripts/diagnostico-cierres.ts 30
//
// La URL de producción se coge sola de `servidor/.env`.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';
import { rutaParaLlegar } from '../src/dominio/carreteras.js';
import { distanciaMetros } from '../src/dominio/geo.js';

if (process.env.BD_URL === undefined) {
  const env = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(env)) process.loadEnvFile(env);
}

const DIAS = Number(process.argv[2] ?? 30);

// Los mismos listones que aparta el diagnóstico del tiempo, para que las dos
// medidas hablen de los mismos viajes.
const KMH_MINIMO = 5;
const KMH_MAXIMO = 90;
const MINUTOS_MINIMO = 1;

const minutos = (ms: number) => ms / 60000;

interface Fila {
  viaje_id: number;
  solicitud_id: number;
  conductor_id: number;
  conductor: string;
  origen: string;
  destino: string;
  o_lat: number; o_lng: number;
  d_lat: number; d_lng: number;
}

interface Transicion {
  estado_nuevo: string;
  actor: string;
  origen_evento: string | null;
  cuando: Date;
}

// Cuánto se movió el coche entre dos instantes, por el rastro. Es la medida que
// separa las dos explicaciones: dice en qué tramo ocurrió la conducción de
// verdad, independientemente de lo que digan los botones.
async function metrosRecorridos(
  pool: pg.Pool,
  conductorId: number,
  desde: Date,
  hasta: Date,
): Promise<{ metros: number; puntos: number }> {
  const res = await pool.query(
    `SELECT lat, lng FROM rastro
     WHERE conductor_id = $1 AND creado_en >= $2 AND creado_en <= $3
     ORDER BY creado_en`,
    [conductorId, desde, hasta],
  );
  let metros = 0;
  for (let i = 1; i < res.rows.length; i += 1) {
    const a = res.rows[i - 1];
    const b = res.rows[i];
    const salto = distanciaMetros(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
    // Saltos absurdos del GPS fuera: una lectura mala de 4 km inventaría
    // kilómetros que nadie condujo, que es justo lo que se está investigando.
    if (salto < 2000) metros += salto;
  }
  return { metros, puntos: res.rowCount ?? 0 };
}

// Cómo se llama, en cristiano, lo que provocó el cambio de estado.
function comoOcurrio(t: Transicion | undefined): string {
  if (t === undefined) return 'no consta';
  if (t.origen_evento === 'proximidad_gps') return 'GPS (se acercaron)';
  if (t.origen_evento === 'separacion_gps') return 'GPS (se separaron)';
  if (t.origen_evento === 'viaje_caducado') return 'caducó solo';
  if (t.actor === 'conductor') return 'botón del taxista';
  if (t.actor === 'cliente') return 'botón del pasajero';
  if (t.actor === 'operador') return 'la central';
  return `${t.actor}${t.origen_evento ? ` (${t.origen_evento})` : ''}`;
}

async function main(): Promise<void> {
  const url = urlBaseDatos();
  const local = /localhost|127\.0\.0\.1/.test(url);
  const host = url.replace(/^[^@]*@/, '').split('/')[0];
  console.log(`Base: ${local ? 'LOCAL (desarrollo)' : `PRODUCCIÓN (${host})`}\n`);

  // El plano antes de abrir la base: cargarlo son segundos de CPU, y hacerlo con
  // una conexión abierta es lo que el pooler de Supabase toma por conexión
  // muerta.
  process.stdout.write('Cargando el plano de calles… ');
  rutaParaLlegar({ lat: 3.7531, lng: 8.7752 }, { lat: 3.7553, lng: 8.7789 });
  console.log('listo\n');

  const pool = new pg.Pool({ connectionString: urlBaseDatos(), keepAlive: true, max: 2 });

  // El rastro se borra solo a los N días (migración 042). Un viaje más viejo
  // que eso no es «no se sabe»: es «ya no se puede saber», y mezclar las dos
  // cosas haría creer que falta información que en realidad nunca se va a
  // tener. Con el periodo por defecto de 30 días esto aparta a casi todos.
  const retencion = await pool.query(
    `SELECT valor::int AS dias FROM parametro WHERE clave = 'rastro_retencion_dias'`,
  );
  const diasRastro = retencion.rows[0]?.dias ?? 90;
  const limiteRastro = new Date(Date.now() - diasRastro * 24 * 3600 * 1000);
  console.log(`El rastro se guarda ${diasRastro} días: de los viajes anteriores`
    + ' no se puede saber dónde anduvo el coche.\n');

  const viajes = await pool.query(
    `SELECT v.id AS viaje_id, s.id AS solicitud_id, v.conductor_id, c.nombre AS conductor,
            ro.nombre AS origen, rd.nombre AS destino,
            ro.lat AS o_lat, ro.lng AS o_lng, rd.lat AS d_lat, rd.lng AS d_lng
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
    console.log('Nada que mirar. Prueba con más días.');
    await pool.end();
    return;
  }

  let sanos = 0;
  let fallados = 0;
  const raros: string[] = [];
  // Los recuentos que responden la pregunta.
  const quienRecoge = new Map<string, number>();
  const quienCierra = new Map<string, number>();
  const familias = new Map<string, number>();
  const sumar = (m: Map<string, number>, clave: string) => m.set(clave, (m.get(clave) ?? 0) + 1);

  for (const fila of viajes.rows as Fila[]) {
    try {
      const historia = await pool.query(
        `SELECT estado_nuevo, actor, origen_evento,
                COALESCE(ocurrio_en, creado_en) AS cuando
         FROM transicion
         WHERE solicitud_id = $1 AND ambito = 'solicitud'
         ORDER BY COALESCE(ocurrio_en, creado_en)`,
        [fila.solicitud_id],
      );
      const pasos = historia.rows as Transicion[];
      const primero = (estado: string) => pasos.find((p) => p.estado_nuevo === estado);

      const aceptado = primero('ACEPTADO');
      const recogido = primero('RECOGIDO');
      const completado = primero('COMPLETADO');
      if (recogido === undefined || completado === undefined) {
        // Un viaje COMPLETADO sin esas dos transiciones ya es en sí mismo un
        // hallazgo: se cuenta aparte en vez de romper el informe.
        sumar(familias, 'sin RECOGIDO o sin COMPLETADO en el registro');
        raros.push(`${String(fila.viaje_id).padStart(5)} | falta una transición`
          + ` (${pasos.map((p) => p.estado_nuevo).join(' → ')})`);
        continue;
      }

      const porCalles = rutaParaLlegar(
        { lat: Number(fila.o_lat), lng: Number(fila.o_lng) },
        { lat: Number(fila.d_lat), lng: Number(fila.d_lng) },
      );
      const km = (porCalles?.distanciaM
        ?? distanciaMetros(
          Number(fila.o_lat), Number(fila.o_lng), Number(fila.d_lat), Number(fila.d_lng),
        )) / 1000;

      const aBordoMin = minutos(
        new Date(completado.cuando).getTime() - new Date(recogido.cuando).getTime(),
      );
      const kmh = aBordoMin > 0 ? km / (aBordoMin / 60) : Infinity;
      const creible = kmh >= KMH_MINIMO && kmh <= KMH_MAXIMO && aBordoMin >= MINUTOS_MINIMO;

      sumar(quienRecoge, comoOcurrio(recogido));
      sumar(quienCierra, comoOcurrio(completado));

      if (creible) {
        sanos += 1;
        continue;
      }

      // Aquí está la medida que decide. El coche se movió ANTES de que
      // constara la recogida, o DESPUÉS. Donde estén los kilómetros, está la
      // verdad del viaje.
      const desdeAceptado = aceptado ? new Date(aceptado.cuando) : new Date(recogido.cuando);
      const antes = await metrosRecorridos(
        pool, fila.conductor_id, desdeAceptado, new Date(recogido.cuando),
      );
      const durante = await metrosRecorridos(
        pool, fila.conductor_id, new Date(recogido.cuando), new Date(completado.cuando),
      );
      // Y después de cerrar: si el coche siguió rodando los kilómetros que
      // faltaban, es que se cerró a mitad de viaje.
      const despues = await metrosRecorridos(
        pool, fila.conductor_id, new Date(completado.cuando),
        new Date(new Date(completado.cuando).getTime() + 30 * 60_000),
      );

      let familia: string;
      if (antes.puntos + durante.puntos + despues.puntos < 2) {
        // Sin rastro no se puede decir dónde ocurrió la conducción. Se dice, en
        // vez de inventar una conclusión; y se distingue el viaje al que se le
        // borró el rastro por viejo del que no lo tuvo nunca, que son dos
        // problemas distintos.
        familia = new Date(recogido.cuando) < limiteRastro
          ? `el rastro ya se borró (más de ${diasRastro} días)`
          : 'no hay rastro del coche, y debería haberlo';
      } else if (aBordoMin > 60) {
        familia = 'se cerró tardísimo (nadie pulsó hasta mucho después)';
      } else if (antes.metros > durante.metros * 2 && antes.metros > 500) {
        familia = 'RECOGIDO llegó tarde: el coche ya había hecho el viaje';
      } else if (despues.metros > durante.metros * 2 && despues.metros > 500) {
        familia = 'COMPLETADO llegó pronto: el coche siguió rodando después';
      } else {
        familia = 'no se explica por el rastro';
      }
      // La familia SOLA no basta para decidir qué se arregla: «se cerró antes de
      // tiempo» pide una cosa si lo cerró el GPS y otra muy distinta si lo pulsó
      // el taxista. Se cuentan juntos para no tener que leer viaje por viaje.
      sumar(familias, `${familia}  [cerró: ${comoOcurrio(completado)}]`);

      raros.push(
        `${String(fila.viaje_id).padStart(5)} | ${km.toFixed(1).padStart(5)} km |`
        + ` a bordo ${aBordoMin.toFixed(1).padStart(6)} min = ${kmh.toFixed(0).padStart(6)} km/h\n`
        + `      · ${fila.origen} → ${fila.destino}\n`
        + `      · recogió: ${comoOcurrio(recogido)} · cerró: ${comoOcurrio(completado)}\n`
        + `      · el coche anduvo ${Math.round(antes.metros)} m antes de constar recogido,`
        + ` ${Math.round(durante.metros)} m con él dentro,`
        + ` ${Math.round(despues.metros)} m en la media hora siguiente\n`
        + `      · ${familia.toUpperCase()}`,
      );
    } catch (error) {
      fallados += 1;
      console.log(`${String(fila.viaje_id).padStart(5)} | no se pudo mirar:`
        + ` ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const total = (viajes.rowCount ?? 0);
  console.log('='.repeat(70));
  console.log(`Viajes con la duración creíble: ${sanos} de ${total}`
    + (fallados > 0 ? ` · ${fallados} no se pudieron mirar` : ''));
  console.log(`Viajes con la duración imposible: ${raros.length}`
    + ` (${((raros.length / Math.max(1, total)) * 100).toFixed(0)} %)\n`);

  if (raros.length > 0) {
    console.log('--- Uno por uno ---\n');
    for (const linea of raros) console.log(linea + '\n');

    console.log('--- POR QUÉ, que es lo que se venía a saber ---\n');
    for (const [motivo, n] of [...familias].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)} · ${motivo}`);
    }
  }

  console.log('\n--- Cómo se marca la recogida, en TODOS los viajes ---\n');
  for (const [como, n] of [...quienRecoge].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)} · ${como}`);
  }
  console.log('\n--- Cómo se cierra el viaje, en TODOS ---\n');
  for (const [como, n] of [...quienCierra].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)} · ${como}`);
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
