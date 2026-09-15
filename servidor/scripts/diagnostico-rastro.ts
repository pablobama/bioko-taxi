// Diagnóstico de la velocidad, los kilómetros y el mapa de calor, contra una
// VERDAD CONOCIDA.
//
// En producción no se sabe por qué calles pasó el coche ni a qué velocidad
// iba, así que no hay con qué comparar lo que calcula el sistema. Aquí se
// fabrica esa verdad:
//
//   1. Una ruta por CALLES REALES de Malabo, con el mismo enrutador y el mismo
//      plano que usa la aplicación.
//   2. Un coche que la recorre con un perfil de ciudad: tramos a 25-45 km/h y
//      paradas de semáforo. Se sabe dónde está cada segundo.
//   3. Un GPS con el error típico de la calle (±6 m) y el latido de la PWA
//      (cada 20 s), pasando por el `registrarRastro` DE VERDAD.
//   4. Tres vueltas a la misma ruta, que es lo que el mapa de calor tiene que
//      pintar como «lo que más repite».
//
// Y se miden, con las funciones DE VERDAD (`recorridoDe`, `actividadDe`,
// `velocidadRecienteKmh`), los kilómetros, el tiempo al volante, las
// velocidades y cómo de bien sigue las calles el mapa de calor.
//
// ESCRIBE EN LA BASE: se niega a correr contra otra que no sea la local.
//
// Uso (desde servidor/): npx tsx scripts/diagnostico-rastro.ts

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';
import { distanciaMetros } from '../src/dominio/geo.js';
import { actividadDe, recorridoDe, registrarRastro } from '../src/dominio/rastro.js';
import { velocidadRecienteKmh } from '../src/dominio/llegada.js';
import { calcularRuta, cargarPlano, type Punto } from '../../pwa/src/rutas.js';

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(urlBaseDatos())) {
  console.error('Este diagnóstico ESCRIBE datos de prueba. Solo contra la base local.');
  process.exit(1);
}

// --- Aleatorio con semilla: el mismo diagnóstico da los mismos números ------
let semilla = Number(process.argv.find((a) => a.startsWith("--semilla="))?.split("=")[1] ?? 20260915);
const azar = () => {
  semilla |= 0; semilla = (semilla + 0x6d2b79f5) | 0;
  let t = Math.imul(semilla ^ (semilla >>> 15), 1 | semilla);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const gauss = () => Math.sqrt(-2 * Math.log(azar() || 1e-9)) * Math.cos(2 * Math.PI * azar());

// --- El plano ------------------------------------------------------------
type Via = { c: number; p: number[] };
const plano = JSON.parse(readFileSync(new URL('../../pwa/src/mapa-malabo.json', import.meta.url), 'utf8')) as { vias: Via[] };
cargarPlano(plano as never);

// Tramos de calle de Malabo, indexados en rejilla, para medir a cuántos metros
// de la calle más cercana cae cada trozo de lo que se dibuja.
const REJILLA = 0.002;
const tramosPorCelda = new Map<string, Array<[number, number, number, number]>>();
for (const via of plano.vias) {
  for (let i = 2; i < via.p.length; i += 2) {
    const [aLat, aLng, bLat, bLng] = [via.p[i - 2], via.p[i - 1], via.p[i], via.p[i + 1]];
    if (aLat < 3.70 || aLat > 3.80 || aLng < 8.70 || aLng > 8.84) continue;
    const celdas = new Set([
      `${Math.floor(aLat / REJILLA)}:${Math.floor(aLng / REJILLA)}`,
      `${Math.floor(bLat / REJILLA)}:${Math.floor(bLng / REJILLA)}`,
    ]);
    for (const c of celdas) {
      if (!tramosPorCelda.has(c)) tramosPorCelda.set(c, []);
      tramosPorCelda.get(c)!.push([aLat, aLng, bLat, bLng]);
    }
  }
}
const COS = Math.cos((3.75 * Math.PI) / 180);
function distanciaASegmento(p: Punto, a: [number, number], b: [number, number]): number {
  const ax = a[1] * COS, ay = a[0], bx = b[1] * COS, by = b[0], px = p.lng * COS, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * 111_320;
}
function aCalleMasCercana(p: Punto): number {
  let mejor = Infinity;
  const fc = Math.floor(p.lat / REJILLA), cc = Math.floor(p.lng / REJILLA);
  for (let i = -1; i <= 1; i += 1) {
    for (let j = -1; j <= 1; j += 1) {
      for (const [aLat, aLng, bLat, bLng] of tramosPorCelda.get(`${fc + i}:${cc + j}`) ?? []) {
        mejor = Math.min(mejor, distanciaASegmento(p, [aLat, aLng], [bLat, bLng]));
      }
    }
  }
  return mejor;
}
function aPolilinea(p: Punto, linea: Punto[]): number {
  let mejor = Infinity;
  for (let i = 1; i < linea.length; i += 1) {
    mejor = Math.min(mejor, distanciaASegmento(p, [linea[i - 1].lat, linea[i - 1].lng], [linea[i].lat, linea[i].lng]));
  }
  return mejor;
}

// --- La ruta verdadera, por calles reales --------------------------------
const PARADAS: Array<[string, Punto]> = [
  ['Mercado Central', { lat: 3.7531, lng: 8.7752 }],
  ['Semu', { lat: 3.7580, lng: 8.7660 }],
  ['Hospital', { lat: 3.7508, lng: 8.7711 }],
  ['Catedral', { lat: 3.7539, lng: 8.7737 }],
  ['Mercado Central', { lat: 3.7531, lng: 8.7752 }],
];

async function rutaVerdadera(): Promise<Punto[]> {
  const linea: Punto[] = [];
  for (let i = 1; i < PARADAS.length; i += 1) {
    const r = await calcularRuta(PARADAS[i - 1][1], PARADAS[i][1]);
    if (r === null) throw new Error(`Sin ruta ${PARADAS[i - 1][0]} → ${PARADAS[i][0]}`);
    linea.push(...(linea.length === 0 ? r.puntos : r.puntos.slice(1)));
  }
  return linea;
}

// Un coche recorriendo la ruta: posición verdadera cada segundo.
interface Instante { t: number; lat: number; lng: number; kmh: number }
function conducir(linea: Punto[]): { instantes: Instante[]; metros: number; seguMovimiento: number } {
  const acumulado = [0];
  for (let i = 1; i < linea.length; i += 1) {
    acumulado.push(acumulado[i - 1] + distanciaMetros(linea[i - 1].lat, linea[i - 1].lng, linea[i].lat, linea[i].lng));
  }
  const total = acumulado[acumulado.length - 1];
  const donde = (m: number): Punto => {
    let i = 1;
    while (i < acumulado.length - 1 && acumulado[i] < m) i += 1;
    const f = (m - acumulado[i - 1]) / Math.max(1e-9, acumulado[i] - acumulado[i - 1]);
    return {
      lat: linea[i - 1].lat + f * (linea[i].lat - linea[i - 1].lat),
      lng: linea[i - 1].lng + f * (linea[i].lng - linea[i - 1].lng),
    };
  };

  const instantes: Instante[] = [];
  let m = 0, t = 0, seguMovimiento = 0;
  let proximaParada = 400 + azar() * 500;
  let crucero = 25 + azar() * 20;
  let paradaHasta = -1;
  while (m < total) {
    let kmh: number;
    if (t < paradaHasta) {
      kmh = 0;
    } else if (m >= proximaParada) {
      paradaHasta = t + 20 + Math.round(azar() * 25); // un semáforo
      proximaParada = m + 400 + azar() * 500;
      crucero = 25 + azar() * 20;
      kmh = 0;
    } else {
      kmh = crucero;
    }
    const p = donde(m);
    instantes.push({ t, lat: p.lat, lng: p.lng, kmh });
    if (kmh > 0) seguMovimiento += 1;
    m += kmh / 3.6;
    t += 1;
  }
  return { instantes, metros: total, seguMovimiento };
}

// --- Datos de prueba --------------------------------------------------------
async function conductorDePrueba(c: pg.Client): Promise<number> {
  // Con Math.random y NO con `azar`: la semilla fija repetiría el teléfono en
  // cada ejecución, y gastar un número de la semilla aquí movería toda la
  // simulación de detrás, que tiene que dar lo mismo para poder comparar.
  const tel = '+2406' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const { rows } = await c.query(`INSERT INTO conductor (telefono, nombre) VALUES ($1, 'Diagnóstico rastro') RETURNING id`, [tel]);
  await c.query(`INSERT INTO presencia (conductor_id, estado, ultimo_heartbeat) VALUES ($1, 'DISPONIBLE', now())`, [rows[0].id]);
  return Number(rows[0].id);
}

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)} %`;
const t0 = new Date('2026-08-20T08:00:00Z');

async function principal(): Promise<void> {
  const c = new pg.Client({ connectionString: urlBaseDatos() });
  await c.connect();
  try {
    const linea = await rutaVerdadera();
    const vuelta = conducir(linea);
    console.log('='.repeat(76));
    console.log('LA VERDAD');
    console.log(`  Ruta por calles reales: ${PARADAS.map((p) => p[0]).join(' → ')}`);
    console.log(`  ${(vuelta.metros / 1000).toFixed(2)} km por vuelta · ${Math.round(vuelta.instantes.length / 60)} min · ${Math.round(vuelta.seguMovimiento / 60)} min en marcha`);
    const kmhMovimiento = (vuelta.metros / 1000) / (vuelta.seguMovimiento / 3600);
    const kmhTotal = (vuelta.metros / 1000) / (vuelta.instantes.length / 3600);
    console.log(`  Velocidad media en marcha: ${kmhMovimiento.toFixed(1)} km/h · contando semáforos: ${kmhTotal.toFixed(1)} km/h`);
    console.log('  Tres vueltas, con el latido empezando en un segundo distinto cada vez.');

    const id = await conductorDePrueba(c);
    const VUELTAS = 3;
    const LATIDO_S = 20;
    let inicioVuelta = t0.getTime();
    let guardados = 0;
    for (let v = 0; v < VUELTAS; v += 1) {
      const fase = [0, 7, 13][v];
      for (const ins of vuelta.instantes) {
        if ((ins.t + fase) % LATIDO_S !== 0) continue;
        const errorM = 6;
        const lat = ins.lat + (gauss() * errorM) / 111_320;
        const lng = ins.lng + (gauss() * errorM) / (111_320 * COS);
        const ok = await registrarRastro(c as unknown as pg.ClientBase, id, lat, lng, new Date(inicioVuelta + ins.t * 1000), errorM);
        if (ok) guardados += 1;
      }
      inicioVuelta += vuelta.instantes.length * 1000 + 15 * 60_000; // quince minutos entre vueltas
    }
    await c.query(
      `INSERT INTO transicion (ambito, conductor_id, estado_anterior, estado_nuevo, actor, origen_evento, creado_en)
       VALUES ('conductor', $1, 'DESCONECTADO', 'DISPONIBLE', 'conductor', 'diag', $2),
              ('conductor', $1, 'DISPONIBLE', 'DESCONECTADO', 'conductor', 'diag', $3)`,
      [id, t0, new Date(inicioVuelta - 15 * 60_000)],
    );

    const desde = new Date(t0.getTime() - 60_000);
    const hasta = new Date(inicioVuelta);
    const rec = await recorridoDe(c, id, desde, hasta, 100_000);
    const act = await actividadDe(c, id, desde, hasta);
    const latidos = Math.floor(vuelta.instantes.length / LATIDO_S) * VUELTAS;

    console.log(`\nLO QUE SE GUARDA: ${guardados} puntos de ${latidos} latidos (1 cada ${Math.round((vuelta.instantes.length * VUELTAS) / guardados)} s)`);
    // Sobre los puntos GUARDADOS, no sobre lo que devuelve `recorridoDe`: eso
    // ahora es el camino por calles, denso, y daría la separación del dibujo.
    const crudos = (await c.query(
      'SELECT lat, lng, creado_en FROM rastro WHERE conductor_id = $1 ORDER BY creado_en', [id],
    )).rows;
    const separacion = [];
    for (let i = 1; i < crudos.length; i += 1) {
      const hueco = new Date(crudos[i].creado_en).getTime() - new Date(crudos[i - 1].creado_en).getTime();
      if (hueco > 10 * 60_000) continue; // entre vueltas
      separacion.push(distanciaMetros(Number(crudos[i - 1].lat), Number(crudos[i - 1].lng), Number(crudos[i].lat), Number(crudos[i].lng)));
    }
    separacion.sort((a, b) => a - b);
    console.log(`  Entre dos puntos guardados: mediana ${separacion[Math.floor(separacion.length / 2)].toFixed(0)} m, máx ${separacion[separacion.length - 1].toFixed(0)} m`);

    // --- 1. Kilómetros ------------------------------------------------------
    const kmVerdad = (vuelta.metros * VUELTAS) / 1000;
    console.log('\n1) KILÓMETROS');
    console.log(`  Verdad ${kmVerdad.toFixed(2)} km · sistema ${(rec.metros / 1000).toFixed(2)} km · error ${pct(rec.metros / 1000 / kmVerdad - 1)}`);
    // Lo RECUPERABLE: del primer al último punto guardado de cada vuelta. Lo de
    // antes del primero y después del último no lo tiene nadie —ni con rectas
    // ni con calles— y en una vuelta de once minutos pesa mucho más que en un
    // turno de ocho horas, así que la cifra de arriba exagera el error real.
    const recorridoHasta = (t: number) => {
      let m = 0;
      for (const ins of vuelta.instantes) { if (ins.t >= t) break; m += ins.kmh / 3.6; }
      return m;
    };
    const guardadosPorVuelta = await c.query(
      `SELECT creado_en FROM rastro WHERE conductor_id = $1 ORDER BY creado_en`, [id],
    );
    let recuperableM = 0;
    let base = t0.getTime();
    for (let v = 0; v < VUELTAS; v += 1) {
      const finVuelta = base + vuelta.instantes.length * 1000;
      const horas = guardadosPorVuelta.rows
        .map((f) => new Date(f.creado_en).getTime())
        .filter((h) => h >= base && h <= finVuelta);
      if (horas.length >= 2) {
        recuperableM += recorridoHasta((horas[horas.length - 1] - base) / 1000) - recorridoHasta((horas[0] - base) / 1000);
      }
      base = finVuelta + 15 * 60_000;
    }
    console.log(`  Recuperable (entre el primer y el último punto de cada vuelta): ${(recuperableM / 1000).toFixed(2)} km · error contra eso ${pct(rec.metros / recuperableM - 1)}`);

    // Salto a salto: de dónde sale el error que queda. Cada salto entre dos
    // puntos guardados se compara con lo que el coche anduvo DE VERDAD entre
    // esas dos horas.
    {
      const { caminoPorCarretera } = await import('../src/dominio/carreteras.js');
      let porCalles = 0, porRecta = 0, verdadCalles = 0, sistemaCalles = 0, verdadRecta = 0, sistemaRecta = 0;
      const peores: Array<{ verdad: number; sistema: number; recta: number }> = [];
      let baseV = t0.getTime();
      for (let v = 0; v < VUELTAS; v += 1) {
        const finV = baseV + vuelta.instantes.length * 1000;
        const puntosV = crudos
          .map((f) => ({ lat: Number(f.lat), lng: Number(f.lng), t: (new Date(f.creado_en).getTime() - baseV) / 1000 }))
          .filter((p) => p.t >= 0 && p.t <= (finV - baseV) / 1000);
        for (let i = 1; i < puntosV.length; i += 1) {
          const a = puntosV[i - 1], b = puntosV[i];
          const recta = distanciaMetros(a.lat, a.lng, b.lat, b.lng);
          if (recta < 25) continue;
          const verdad = recorridoHasta(b.t) - recorridoHasta(a.t);
          const camino = caminoPorCarretera(a, b, recta, b.t - a.t, 180);
          if (camino) {
            porCalles += 1; verdadCalles += verdad; sistemaCalles += camino.distanciaM;
            peores.push({ verdad, sistema: camino.distanciaM, recta });
          } else {
            porRecta += 1; verdadRecta += verdad; sistemaRecta += recta;
          }
        }
        baseV = finV + 15 * 60_000;
      }
      console.log(`  Saltos por calles: ${porCalles} (error ${pct(sistemaCalles / verdadCalles - 1)}) · por recta, sin camino creíble: ${porRecta}${porRecta ? ` (error ${pct(sistemaRecta / verdadRecta - 1)})` : ''}`);
      peores.sort((x, y) => (x.sistema - x.verdad) - (y.sistema - y.verdad));
      console.log('  Los 5 saltos por calles más CORTOS que la verdad (m):');
      for (const p of peores.slice(0, 5)) {
        console.log(`    verdad ${p.verdad.toFixed(0)} · sistema ${p.sistema.toFixed(0)} · recta ${p.recta.toFixed(0)}`);
      }
    }

    // --- 2. Tiempo y velocidad --------------------------------------------
    const movVerdad = vuelta.seguMovimiento * VUELTAS;
    console.log('\n2) TIEMPO AL VOLANTE Y VELOCIDAD');
    console.log(`  Al volante: verdad ${Math.round(movVerdad / 60)} min · sistema ${Math.round(act.segundosEnMovimiento / 60)} min · error ${pct(act.segundosEnMovimiento / movVerdad - 1)}`);
    const kmhSistema = (rec.metros / 1000) / (act.segundosEnMovimiento / 3600);
    console.log(`  Velocidad en marcha: verdad ${kmhMovimiento.toFixed(1)} km/h · sistema ${kmhSistema.toFixed(1)} km/h · error ${pct(kmhSistema / kmhMovimiento - 1)}`);
    const servicioVerdad = (vuelta.instantes.length * VUELTAS + 15 * 60 * (VUELTAS - 1));
    const mediaVerdad = kmVerdad / (servicioVerdad / 3600);
    console.log(`  «De media en servicio»: verdad ${mediaVerdad.toFixed(1)} km/h · sistema ${act.velocidadMediaKmh} km/h`);

    // Velocidad para la ETA: posiciones del viaje cada 10 s, una vuelta.
    const zona = await c.query(`INSERT INTO zona (nombre, distrito) VALUES ($1, 'Malabo') RETURNING id`, [`Diag ${randomUUID()}`]);
    const ref = await c.query(`INSERT INTO referencia (zona_id, nombre, lat, lng) VALUES ($1, 'Diag', 3.75, 8.77) RETURNING id`, [zona.rows[0].id]);
    const disp = await c.query(`INSERT INTO dispositivo (uuid_persistente, tipo) VALUES (gen_random_uuid(), 'cliente') RETURNING id`);
    const sol = await c.query(
      `INSERT INTO solicitud (dispositivo_cliente_id, telefono_cliente, referencia_origen_id, referencia_destino_id, clave_idempotencia)
       VALUES ($1, '+240222999998', $2, $2, $3) RETURNING id`, [disp.rows[0].id, ref.rows[0].id, `diag-${randomUUID()}`]);
    const viaje = await c.query(`INSERT INTO viaje (solicitud_id, conductor_id, pin) VALUES ($1, $2, '1234') RETURNING id`, [sol.rows[0].id, id]);
    const viajeId = Number(viaje.rows[0].id);
    const tv = t0.getTime() + 30 * 86_400_000;
    for (const ins of vuelta.instantes) {
      if (ins.t % 10 !== 0) continue;
      await c.query(`INSERT INTO posicion (viaje_id, actor, lat, lng, creado_en, precision_m) VALUES ($1, 'conductor', $2, $3, $4, 6)`,
        [viajeId, ins.lat + (gauss() * 6) / 111_320, ins.lng + (gauss() * 6) / (111_320 * COS), new Date(tv + ins.t * 1000)]);
    }
    const errores = [];
    for (let s = 400; s < vuelta.instantes.length; s += 60) {
      const medida = await velocidadRecienteKmh(c, viajeId, new Date(tv + s * 1000));
      const ventana = vuelta.instantes.filter((i) => i.t > s - 360 && i.t <= s);
      const verdad = ventana.reduce((a, i) => a + i.kmh / 3.6, 0) / 1000 / (ventana.length / 3600);
      if (medida !== null) errores.push(medida / verdad - 1);
    }
    errores.sort((a, b) => a - b);
    console.log(`  Velocidad de la ETA (últimos 6 min): error mediano ${pct(errores[Math.floor(errores.length / 2)])}, del ${pct(errores[0])} al ${pct(errores[errores.length - 1])}`);

    // --- 3. El mapa de calor ¿sigue las calles? ------------------------------
    console.log('\n3) MAPA DE CALOR: ¿POR DÓNDE PINTA?');
    let largo = 0, fueraCalle = 0, fueraRuta = 0, sumaDesvio = 0;
    const porColor = new Map<number, number>();
    for (const tramo of rec.tramos) {
      for (let i = 1; i < tramo.length; i += 1) {
        const a = tramo[i - 1], b = tramo[i];
        const seg = distanciaMetros(a.lat, a.lng, b.lat, b.lng);
        const color = Math.max(a.pasadas ?? 1, b.pasadas ?? 1);
        porColor.set(color, (porColor.get(color) ?? 0) + seg);
        const pasos = Math.max(1, Math.round(seg / 10));
        for (let k = 0; k <= pasos; k += 1) {
          const p = { lat: a.lat + ((b.lat - a.lat) * k) / pasos, lng: a.lng + ((b.lng - a.lng) * k) / pasos };
          const aRuta = aPolilinea(p, linea);
          sumaDesvio += aRuta;
          if (aCalleMasCercana(p) > 20) fueraCalle += 1;
          if (aRuta > 20) fueraRuta += 1;
          largo += 1;
        }
      }
    }
    console.log(`  Lo dibujado, a más de 20 m de CUALQUIER calle: ${Math.round((100 * fueraCalle) / largo)} % (atraviesa manzanas)`);
    console.log(`  Lo dibujado, a más de 20 m de la calle POR LA QUE IBA: ${Math.round((100 * fueraRuta) / largo)} %`);
    console.log(`  Desvío medio respecto a la ruta verdadera: ${(sumaDesvio / largo).toFixed(0)} m`);

    // --- 4. ¿Cuenta bien las repeticiones? ----------------------------------
    console.log(`\n4) MAPA DE CALOR: LA MISMA RUTA ${VUELTAS} VECES`);
    // La verdad de CADA celda, no «3»: la ruta pasa dos veces por algunas
    // calles en cada vuelta (ida y vuelta por la misma avenida), así que ahí lo
    // correcto son 6. Se cuenta sobre la ruta verdadera, densa, igual que el
    // sistema cuenta sobre la suya: una pasada es entrar en la celda después
    // de haber estado lejos de ella.
    const CELDA = 0.0003;
    const celda = (p: Punto) => `${Math.round(p.lat / CELDA)}:${Math.round(p.lng / CELDA)}`;
    const verdadPorCelda = new Map<string, number>();
    {
      const densa: Punto[] = [];
      for (let i = 1; i < linea.length; i += 1) {
        const d = distanciaMetros(linea[i - 1].lat, linea[i - 1].lng, linea[i].lat, linea[i].lng);
        const pasos = Math.max(1, Math.ceil(d / 5));
        for (let k = 0; k < pasos; k += 1) {
          densa.push({ lat: linea[i - 1].lat + ((linea[i].lat - linea[i - 1].lat) * k) / pasos, lng: linea[i - 1].lng + ((linea[i].lng - linea[i - 1].lng) * k) / pasos });
        }
      }
      // Una pasada por celda si se entra tras recorrer más de 80 m fuera de
      // ella: lo mismo que se le pide al sistema, para que la vara sea igual.
      const visto = new Map<string, number>();
      let andado = 0;
      for (let i = 0; i < densa.length; i += 1) {
        if (i > 0) andado += distanciaMetros(densa[i - 1].lat, densa[i - 1].lng, densa[i].lat, densa[i].lng);
        const k = celda(densa[i]);
        const ultima = visto.get(k);
        if (ultima === undefined || andado - ultima > 80) verdadPorCelda.set(k, (verdadPorCelda.get(k) ?? 0) + VUELTAS);
        visto.set(k, andado);
      }
    }
    const maxVerdad = Math.max(...verdadPorCelda.values());
    console.log(`  Máximo de pasadas: verdad ${maxVerdad} · sistema ${rec.maxPasadas}`);
    let bien = 0, pocas = 0, muchas = 0, sinVerdad = 0, total = 0;
    for (const tramo of rec.tramos) {
      for (const p of tramo) {
        const v = verdadPorCelda.get(celda(p));
        total += 1;
        if (v === undefined) { sinVerdad += 1; continue; }
        if ((p.pasadas ?? 1) === v) bien += 1;
        else if ((p.pasadas ?? 1) < v) pocas += 1;
        else muchas += 1;
      }
    }
    console.log(`  Puntos del mapa con las pasadas EXACTAS de su calle: ${Math.round((100 * bien) / total)} %`);
    console.log(`  Con MENOS de las verdaderas: ${Math.round((100 * pocas) / total)} % · con MÁS: ${Math.round((100 * muchas) / total)} % · fuera de la ruta: ${Math.round((100 * sinVerdad) / total)} %`);

    // Limpieza: nada de esto debe quedarse en la base de desarrollo.
    await c.query('DELETE FROM posicion WHERE viaje_id = $1', [viajeId]);
    console.log('\n' + '='.repeat(76));
  } finally {
    await c.end();
  }
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
