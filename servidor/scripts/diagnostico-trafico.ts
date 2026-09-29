// ¿Se puede pintar el tráfico en el mapa? (29/09)
//
// LA IDEA: los taxis ya van diciendo dónde están cada minuto, y el plano de
// calles ya sabe lo que se TARDA normalmente en cada tramo. Comparando las dos
// cosas sale, sin instalar nada y sin pagar a nadie, dónde se circula más lento
// de lo normal. Eso es el atasco, y es lo que se pintaría de rojo.
//
// LA PREGUNTA QUE DECIDE SI ESO EXISTE O NO, y por eso este script va antes que
// el código: hacen falta COCHES PASANDO. Con cuarenta taxistas en toda la isla,
// una calle cualquiera puede no ver un solo taxi en media hora, y de un solo
// coche no se puede decir si hay atasco o si ese taxista iba despacio porque
// buscaba un portal. Pintar un mapa con eso sería inventar.
//
// Así que aquí no se construye nada: se mide si los datos dan. Tres respuestas:
//
//   1. EN VIVO. Partiendo el tiempo en ventanas de media hora, ¿cuántos trozos
//      de ciudad tienen al menos tres pasadas? Esos son los que se podrían
//      pintar AHORA. Si salen dos, no hay mapa de tráfico en vivo.
//   2. POR COSTUMBRE. Acumulando semanas, ¿cuántos trozos tienen datos de
//      sobra? Aunque no haya suficientes coches para el directo, sí puede
//      haberlos para «esta calle SUELE ir lenta a las siete», que para avisar
//      al taxista y para calcular el tiempo sirve casi igual.
//   3. ¿HAY ATASCOS SIQUIERA? Si resulta que casi nadie circula por debajo de
//      lo que el plano supone, no hay nada que pintar y la respuesta correcta
//      es no hacer esto.
//
// CÓMO SE MIDE CADA PASADA: entre dos puntos seguidos del recorrido de un taxi
// se reconstruye el camino por las calles (el mismo grafo que dibuja las rutas)
// y se compara lo que el plano dice que se tarda con lo que se tardó de verdad.
// Un factor de 1 es ir a lo normal; 0,5 es ir a la mitad de rápido.
//
// SOLO LECTURA: no escribe ni una fila.
//
// USO. Contra desarrollo:  npx tsx scripts/diagnostico-trafico.ts
//      Contra producción:  npx tsx scripts/diagnostico-trafico.ts 45

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';
import { cargarPlano, emparejar } from '../../pwa/src/rutas.js';
import { distanciaMetros } from '../src/dominio/geo.js';

if (process.env.BD_URL === undefined) {
  const env = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(env)) process.loadEnvFile(env);
}

const DIAS = Number(process.argv[2] ?? 30);

// El trozo de ciudad del que se habla. 0,0015° son unos 165 m: más pequeño y
// cada tramo se queda sin pasadas; más grande y una avenida atascada se mezcla
// con la calle de al lado que va bien.
const CELDA = 0.0015;

// Qué salto entre dos puntos sirve. Muy corto no dice nada (el GPS tiene ruido)
// y muy largo puede llevar dentro una parada a comer.
const SEG_MINIMO = 20;
const SEG_MAXIMO = 180;
const METROS_MINIMO = 40;

// Cuántas pasadas hacen falta para decir algo de un trozo. Con una, lo que se
// mide es a ese taxista, no a la calle.
const PASADAS_EN_VIVO = 3;
const PASADAS_POR_COSTUMBRE = 20;

// Ventana del «ahora» del mapa.
const VENTANA_MIN = 30;

// Tope de trabajo: emparejar es caro y esto es un diagnóstico, no un proceso.
const PASADAS_MAXIMAS = 40_000;

interface Pasada {
  celda: string;
  factor: number;
  cuando: Date;
  lat: number;
  lng: number;
}

function celdaDe(lat: number, lng: number): string {
  return `${Math.floor(lat / CELDA)}:${Math.floor(lng / CELDA)}`;
}

function mediana(valores: number[]): number {
  if (valores.length === 0) return 0;
  const o = [...valores].sort((a, b) => a - b);
  return o[Math.floor(o.length / 2)];
}

function percentil(valores: number[], f: number): number {
  if (valores.length === 0) return 0;
  const o = [...valores].sort((a, b) => a - b);
  return o[Math.min(o.length - 1, Math.round(f * (o.length - 1)))];
}

async function main(): Promise<void> {
  const url = urlBaseDatos();
  const local = /localhost|127\.0\.0\.1/.test(url);
  const host = url.replace(/^[^@]*@/, '').split('/')[0];
  console.log(`Base: ${local ? 'LOCAL (desarrollo)' : `PRODUCCIÓN (${host})`}\n`);

  process.stdout.write('Cargando el plano de calles… ');
  const plano = fileURLToPath(new URL('../../pwa/src/mapa-malabo.json', import.meta.url));
  cargarPlano(JSON.parse(readFileSync(plano, 'utf8')));
  console.log('listo\n');

  const pool = new pg.Pool({ connectionString: urlBaseDatos(), keepAlive: true, max: 2 });

  const puntos = await pool.query(
    `SELECT conductor_id, lat, lng, creado_en
     FROM rastro
     WHERE creado_en >= now() - make_interval(days => $1)
     ORDER BY conductor_id, creado_en`,
    [DIAS],
  );
  console.log(`Puntos de recorrido en ${DIAS} día(s): ${puntos.rowCount}\n`);
  if ((puntos.rowCount ?? 0) < 2) {
    console.log('No hay recorrido que mirar.');
    await pool.end();
    return;
  }

  const pasadas: Pasada[] = [];
  let saltos = 0;
  let sinCamino = 0;
  const filas = puntos.rows as Array<{
    conductor_id: string; lat: number; lng: number; creado_en: Date;
  }>;

  for (let i = 1; i < filas.length && pasadas.length < PASADAS_MAXIMAS; i += 1) {
    const a = filas[i - 1];
    const b = filas[i];
    // Cambio de taxista: el salto entre el último punto de uno y el primero del
    // siguiente no es un trayecto de nadie.
    if (a.conductor_id !== b.conductor_id) continue;

    const seg = (new Date(b.creado_en).getTime() - new Date(a.creado_en).getTime()) / 1000;
    if (seg < SEG_MINIMO || seg > SEG_MAXIMO) continue;
    const metros = distanciaMetros(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
    if (metros < METROS_MINIMO) continue;
    saltos += 1;

    const camino = emparejar(
      { lat: Number(a.lat), lng: Number(a.lng) },
      { lat: Number(b.lat), lng: Number(b.lng) },
      // Sin tope de tiempo: aquí interesa justamente el caso en que se tardó
      // MÁS de lo que el plano supone, que es lo que se está buscando.
      { segundosMaximos: Infinity },
    );
    if (camino === null || camino.segundosTipicos <= 0) {
      sinCamino += 1;
      continue;
    }

    // El punto del que se habla: la mitad del camino recorrido.
    const medio = camino.puntos[Math.floor(camino.puntos.length / 2)];
    pasadas.push({
      celda: celdaDe(medio.lat, medio.lng),
      // 1 = a lo normal. Menos de 1 = más lento de lo que el plano supone.
      factor: camino.segundosTipicos / seg,
      cuando: new Date(b.creado_en),
      lat: medio.lat,
      lng: medio.lng,
    });
  }

  console.log(`Saltos aprovechables: ${saltos} · con camino por calles: ${pasadas.length}`
    + (sinCamino > 0 ? ` · ${sinCamino} sin camino en el plano` : '')
    + (pasadas.length >= PASADAS_MAXIMAS ? ' (tope alcanzado)' : '') + '\n');
  if (pasadas.length === 0) {
    console.log('Nada que medir.');
    await pool.end();
    return;
  }

  // --- 3. ¿Hay atascos siquiera? -------------------------------------------
  const factores = pasadas.map((p) => p.factor);
  console.log('='.repeat(64));
  console.log('¿HAY ATASCOS QUE PINTAR?\n');
  console.log(`  A lo normal iría un factor de 1. Lo medido:`);
  console.log(`    el 10 % más lento .... ${percentil(factores, 0.1).toFixed(2)}`);
  console.log(`    la mitad ............. ${mediana(factores).toFixed(2)}`);
  console.log(`    el 10 % más rápido ... ${percentil(factores, 0.9).toFixed(2)}`);
  const lentas = factores.filter((f) => f < 0.6).length;
  console.log(`\n  Pasadas a menos de la mitad de velocidad de lo normal:`
    + ` ${lentas} (${((lentas / factores.length) * 100).toFixed(0)} %)`);

  // --- 1. En vivo ----------------------------------------------------------
  const ventanas = new Map<number, Map<string, number>>();
  for (const p of pasadas) {
    const v = Math.floor(p.cuando.getTime() / (VENTANA_MIN * 60_000));
    let celdas = ventanas.get(v);
    if (!celdas) { celdas = new Map(); ventanas.set(v, celdas); }
    celdas.set(p.celda, (celdas.get(p.celda) ?? 0) + 1);
  }
  const pintables = [...ventanas.values()]
    .map((celdas) => [...celdas.values()].filter((n) => n >= PASADAS_EN_VIVO).length);
  const conAlgo = pintables.filter((n) => n > 0).length;

  console.log(`\n${'='.repeat(64)}`);
  console.log(`EN VIVO: ¿cuánto mapa se podría pintar en una ventana de ${VENTANA_MIN} min?\n`);
  console.log(`  Ventanas con recorrido: ${ventanas.size}`);
  console.log(`  Trozos pintables por ventana (hacen falta ${PASADAS_EN_VIVO} pasadas):`);
  console.log(`    la mitad de las veces ... ${mediana(pintables)}`);
  console.log(`    en el mejor momento .... ${Math.max(0, ...pintables)}`);
  console.log(`  Ventanas en las que se podría pintar ALGO: ${conAlgo} de ${ventanas.size}`
    + ` (${((conAlgo / Math.max(1, ventanas.size)) * 100).toFixed(0)} %)`);

  // --- 2. Por costumbre ----------------------------------------------------
  const porCelda = new Map<string, Pasada[]>();
  for (const p of pasadas) {
    const lista = porCelda.get(p.celda);
    if (lista) lista.push(p); else porCelda.set(p.celda, [p]);
  }
  const conocidas = [...porCelda.entries()].filter(([, l]) => l.length >= PASADAS_POR_COSTUMBRE);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`POR COSTUMBRE: acumulando los ${DIAS} días\n`);
  console.log(`  Trozos de ciudad con recorrido: ${porCelda.size}`);
  console.log(`  Con datos de sobra (${PASADAS_POR_COSTUMBRE}+ pasadas): ${conocidas.length}`);

  if (conocidas.length > 0) {
    // Los peores, con el sitio conocido más cercano para poder nombrarlos.
    const peores = conocidas
      .map(([celda, l]) => ({
        celda,
        n: l.length,
        factor: mediana(l.map((p) => p.factor)),
        lat: l[0].lat,
        lng: l[0].lng,
      }))
      .sort((a, b) => a.factor - b.factor)
      .slice(0, 12);

    console.log('\n  Los trozos donde MÁS se circula por debajo de lo normal:\n');
    for (const t of peores) {
      const cerca = await pool.query(
        `SELECT nombre FROM referencia
         ORDER BY (lat - $1) * (lat - $1) + (lng - $2) * (lng - $2)
         LIMIT 1`,
        [t.lat, t.lng],
      );
      const donde = cerca.rows[0]?.nombre ?? `${t.lat.toFixed(4)}, ${t.lng.toFixed(4)}`;
      const porCiento = Math.round((1 - t.factor) * 100);
      console.log(`    ${t.factor.toFixed(2)}  ${String(t.n).padStart(4)} pasadas`
        + `  ·  ${porCiento > 0 ? `${porCiento} % más lento` : 'normal'}  ·  cerca de ${donde}`);
    }

    // Y a qué horas. Si el atasco tiene hora, se puede avisar antes de llegar.
    const peor = peores[0];
    const suyas = porCelda.get(peor.celda)!;
    const porHora = new Map<number, number[]>();
    for (const p of suyas) {
      const h = p.cuando.getHours();
      const l = porHora.get(h);
      if (l) l.push(p.factor); else porHora.set(h, [p.factor]);
    }
    console.log(`\n  El peor trozo, hora a hora (factor y nº de pasadas):\n`);
    for (const h of [...porHora.keys()].sort((a, b) => a - b)) {
      const l = porHora.get(h)!;
      const barra = '█'.repeat(Math.max(1, Math.round((1 - mediana(l)) * 20)));
      console.log(`    ${String(h).padStart(2, '0')}:00  ${mediana(l).toFixed(2)}`
        + `  ${String(l.length).padStart(3)}  ${barra}`);
    }
  }

  console.log(`\n${'='.repeat(64)}`);
  console.log('QUÉ SIGNIFICA ESTO\n');
  console.log(`  Si «trozos pintables por ventana» sale en 0 o 1, no hay mapa de`);
  console.log(`  tráfico en vivo: no es un problema de código, es que no pasan`);
  console.log(`  bastantes taxis. Si «con datos de sobra» sale en decenas, sí hay`);
  console.log(`  mapa de costumbre —«esto suele ir lento a estas horas»—, que para`);
  console.log(`  el tiempo hasta destino y para avisar al taxista sirve igual.`);

  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
