// Diagnóstico del taxi compartido sobre el MAPA REAL de Malabo.
//
// La pregunta que contesta, que es la que se hizo en voz alta: «si le entra una
// petición a un taxi mientras lleva a otra persona, ¿le recomiendo desviarse o
// no?». Y la de al lado: «¿hay que pintar los dos recorridos en su pantalla?».
//
// Cómo. Se cogen los sitios de verdad del catálogo (la tabla `referencia`, que
// son mercados, hospitales, barrios y calles de Malabo), se sortean miles de
// escenarios de «taxi con alguien dentro + petición nueva», y cada uno se mide
// por las CALLES con el mismo grafo que usa la aplicación. De ahí salen los
// números que decide `evaluarDesvio`.
//
// Ejecutar desde /servidor:  npx tsx scripts/diagnostico-compartido.ts
// Con la base de desarrollo levantada (npm run bd:dev).

import { crearPool } from '../src/bd/conexion.js';
import { rutaParaLlegar } from '../src/dominio/carreteras.js';
import { evaluarDesvio, type Limites, type MedidorViaje } from '../src/dominio/desvio.js';
import { distanciaRectaM, ordenarParadas, type ParadaPendiente } from '../src/dominio/paradas.js';

const ESCENARIOS = Number(process.argv[2] ?? 400);

// Lo que separa un viaje de un paseo, y lo que separa «de camino» de «al otro
// lado de la ciudad». Sin estos dos filtros el diagnóstico se llena de
// escenarios que no existen: el catálogo tiene doce mil sitios y muchos están
// a cincuenta metros unos de otros, así que la mitad de los «viajes»
// sorteados son cruzar la calle y todo sale conviniendo.
const MINIMO_VIAJE_M = 700;
const MAXIMO_A_POR_EL_M = 4000;

// Los mismos límites que se proponen para producción. Se pueden mover por
// argumento para ver cómo cambia el reparto sin tocar código.
const LIMITES: Limites = {
  retrasoMaximoSeg: Number(process.env.RETRASO_MAX_SEG ?? 300),
  retrasoMaximoPorcentaje: Number(process.env.RETRASO_MAX_PCT ?? 0.5),
  esperaMaximaNuevoSeg: Number(process.env.ESPERA_MAX_SEG ?? 480),
};

// Por las calles, con la recta como red de seguridad: si el grafo no encuentra
// camino creíble (un sitio fuera del plano), se usa la recta y se sigue. Es la
// misma regla que ya usa `rutaDe`.
const medir: MedidorViaje = (a, b) => {
  const porCalles = rutaParaLlegar(a, b);
  const recta = distanciaRectaM(a, b);
  if (porCalles === null || porCalles.distanciaM > recta * 3 + 500) {
    // 25 km/h es la velocidad de ciudad que ya usa el resto del sistema.
    return { metros: recta * 1.3, segundos: (recta * 1.3) / (25 / 3.6) };
  }
  return { metros: porCalles.distanciaM, segundos: porCalles.segundosTipicos };
};

interface Sitio { nombre: string; lat: number; lng: number }

function alAzar<T>(lista: T[]): T {
  return lista[Math.floor(Math.random() * lista.length)];
}

function percentil(valores: number[], fraccion: number): number {
  if (valores.length === 0) return 0;
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.min(ordenados.length - 1, Math.round(fraccion * (ordenados.length - 1)))];
}

const minutos = (seg: number) => (seg / 60).toFixed(1);

async function main(): Promise<void> {
  const pool = crearPool();
  const res = await pool.query(
    `SELECT nombre, lat, lng FROM referencia
     WHERE activa AND lat IS NOT NULL AND lng IS NOT NULL
       AND lat BETWEEN 3.72 AND 3.80 AND lng BETWEEN 8.73 AND 8.83`,
  );
  await pool.end();
  const sitios: Sitio[] = res.rows.map((f: { nombre: string; lat: string; lng: string }) => ({
    nombre: f.nombre, lat: Number(f.lat), lng: Number(f.lng),
  }));
  if (sitios.length < 4) {
    console.error(`Solo ${sitios.length} sitios en el catálogo: no hay con qué simular.`);
    process.exit(1);
  }
  console.log(`Sitios reales de Malabo en el catálogo: ${sitios.length}`);
  console.log(`Escenarios: ${ESCENARIOS}`);
  console.log(
    `Límites: retraso ≤ ${LIMITES.retrasoMaximoSeg} s y ≤ ${(LIMITES.retrasoMaximoPorcentaje * 100).toFixed(0)} %,`
    + ` espera del nuevo ≤ ${LIMITES.esperaMaximaNuevoSeg} s\n`,
  );

  const retrasos: number[] = [];
  const esperas: number[] = [];
  const extras: number[] = [];
  const motivos = new Map<string, number>();
  let convienen = 0;
  // Cuántas veces el orden bueno NO es «primero el que ya iba dentro»: es la
  // pregunta de si hace falta recalcular el orden o basta con encolar.
  let ordenCambia = 0;
  // Y cuántas veces el desvío mete al coche por calles que no estaban en su
  // camino: eso es lo que decide si hay que pintar dos recorridos o uno.
  let caminoNuevo = 0;

  for (let i = 0; i < ESCENARIOS; i += 1) {
    // Escenarios de VIAJE, no de puntos al azar. Se sortea el coche y a partir
    // de ahí SOLO sitios que tengan sentido: la carrera nueva se le ofrece a
    // un taxi que está cerca (eso hace el reparto), y los dos trayectos tienen
    // que ser viajes de verdad y no cruzar la calle. Sorteando los cuatro
    // puntos sueltos, de ochocientos escenarios se salvaban once.
    const coche = alAzar(sitios);
    const cerca = sitios.filter((p) => {
      const d = distanciaRectaM(coche, p);
      return d >= MINIMO_VIAJE_M && d <= MAXIMO_A_POR_EL_M;
    });
    if (cerca.length < 3) continue;
    const destinoDentro = alAzar(cerca);
    const recogidaNueva = alAzar(cerca);
    const lejosDeLaRecogida = sitios.filter(
      (p) => distanciaRectaM(recogidaNueva, p) >= MINIMO_VIAJE_M
        && distanciaRectaM(coche, p) <= MAXIMO_A_POR_EL_M * 2,
    );
    if (lejosDeLaRecogida.length === 0) continue;
    const destinoNuevo = alAzar(lejosDeLaRecogida);
    if (destinoDentro === coche || recogidaNueva === destinoNuevo) continue;

    const pendientes: ParadaPendiente[] = [{
      solicitudId: 1, tipo: 'destino',
      lat: destinoDentro.lat, lng: destinoDentro.lng, nombre: destinoDentro.nombre,
    }];
    const veredicto = evaluarDesvio(
      coche,
      pendientes,
      { solicitudId: 2, recogida: recogidaNueva, destino: destinoNuevo },
      medir,
      LIMITES,
    );

    retrasos.push(veredicto.retrasoMaximoSeg);
    esperas.push(veredicto.esperaNuevoSeg);
    extras.push(veredicto.metrosExtra);
    motivos.set(veredicto.motivo, (motivos.get(veredicto.motivo) ?? 0) + 1);
    if (veredicto.conviene) convienen += 1;

    // ¿El orden cambia? Si la primera parada del plan B no es la del pasajero
    // que ya iba dentro, el coche hace algo distinto de lo que iba a hacer.
    if (veredicto.orden[0]?.solicitudId !== 1) ordenCambia += 1;
    // ¿Se mete por calles nuevas? Si el retraso del de dentro es mayor que un
    // minuto, el coche se ha salido de su camino de verdad.
    if (veredicto.retrasoMaximoSeg > 60) caminoNuevo += 1;
  }

  const total = retrasos.length;
  console.log(`Escenarios válidos: ${total}`);
  console.log(`Conviene desviarse: ${convienen} (${((convienen / total) * 100).toFixed(1)} %)`);
  console.log('Motivos:');
  for (const [motivo, veces] of [...motivos.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${motivo.padEnd(18)} ${veces} (${((veces / total) * 100).toFixed(1)} %)`);
  }
  console.log('\nRetraso del que ya va dentro (min):');
  console.log(`  mediana ${minutos(percentil(retrasos, 0.5))} · p75 ${minutos(percentil(retrasos, 0.75))}`
    + ` · p90 ${minutos(percentil(retrasos, 0.9))} · peor ${minutos(Math.max(...retrasos))}`);
  console.log('Espera del nuevo hasta que lo recogen (min):');
  console.log(`  mediana ${minutos(percentil(esperas, 0.5))} · p75 ${minutos(percentil(esperas, 0.75))}`
    + ` · p90 ${minutos(percentil(esperas, 0.9))}`);
  console.log('Kilómetros de más del taxista:');
  console.log(`  mediana ${(percentil(extras, 0.5) / 1000).toFixed(2)} km`
    + ` · p90 ${(percentil(extras, 0.9) / 1000).toFixed(2)} km`);
  console.log(`\nEl orden de paradas cambia (no se atiende primero al de dentro): `
    + `${((ordenCambia / total) * 100).toFixed(1)} %`);
  console.log(`El coche se sale de su camino más de un minuto: `
    + `${((caminoNuevo / total) * 100).toFixed(1)} %`);

  // Y la comparación con lo que hay hoy: hoy se acepta SIEMPRE que quede
  // plaza y el destino caiga por su zona. Nadie mira lo que le cuesta al que
  // ya va dentro.
  const pasanTope = retrasos.filter((r) => r > LIMITES.retrasoMaximoSeg).length;
  const rechazados = total - convienen;
  console.log(`\nHoy se acepta siempre que quede plaza. Con los límites de arriba,`);
  console.log(`  ${pasanTope} de ${total} (${((pasanTope / total) * 100).toFixed(1)} %)`
    + ` pasarían del tope absoluto de retraso,`);
  console.log(`  y ${rechazados} (${((rechazados / total) * 100).toFixed(1)} %) no deberían`
    + ` ofrecerse contando también la regla de proporción y la espera del nuevo.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
