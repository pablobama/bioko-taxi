// ¿Qué dice la voz, y cuándo? Un viaje real conducido paso a paso.
//
// La guía por voz no se puede juzgar mirando el código: hay que conducir. Esto
// conduce por la pantalla — coge dos sitios de Malabo, calcula la ruta, avanza
// el coche por ella a velocidad de ciudad y, en cada lectura de GPS, pregunta a
// la guía qué diría. Después imprime cada frase con los metros REALES que
// quedaban hasta el cruce, que es lo único que dice si el aviso llegó a tiempo.
//
// Reproduce lo que hace la aplicación de verdad, incluido lo que más despista:
// el plano REHACE la ruta cada vez que el coche se mueve unos veinte metros,
// así que la guía no ve una ruta fija sino una que se acorta por delante.
//
// Uso:  npx tsx scripts/diagnostico-guia.ts [--semilla 7]

import { readFileSync } from 'node:fs';
import { calcularRuta, cargarPlano, salidasDeRotonda } from '../src/rutas.js';
import { maniobrasDeLaRuta, proximoAviso, metros, type Punto } from '../src/guia.js';

cargarPlano(JSON.parse(readFileSync(new URL('../src/mapa-malabo.json', import.meta.url), 'utf8')));

// Los mismos sitios que usan las pruebas de rutas, más un par de travesías
// largas: las cortas no tienen cruces suficientes para juzgar nada.
const TRAYECTOS: Array<{ nombre: string; desde: Punto; hasta: Punto }> = [
  { nombre: 'Mercado Central → Hospital', desde: { lat: 3.7531, lng: 8.7752 }, hasta: { lat: 3.7508, lng: 8.7711 } },
  { nombre: 'Semu → Catedral', desde: { lat: 3.7580, lng: 8.7660 }, hasta: { lat: 3.7539, lng: 8.7737 } },
  { nombre: 'Centro → Ela Nguema', desde: { lat: 3.7531, lng: 8.7752 }, hasta: { lat: 3.7620, lng: 8.8000 } },
  { nombre: 'Ela Nguema → aeropuerto', desde: { lat: 3.7620, lng: 8.8000 }, hasta: { lat: 3.7550, lng: 8.7100 } },
];

const VELOCIDAD_KMH = 30;
const CADA_SEG = 1.5; // igual que el simulador del panel
const REHACER_CADA_M = 22; // igual que el mapa

// Ruido del GPS: unos metros a cada lado, que es lo que hace que el vértice
// «más cercano» no siempre sea el que toca.
function semillaAleatoria(semilla: number): () => number {
  let s = semilla;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

function interpolar(a: Punto, b: Punto, t: number): Punto {
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
}

// Camina la ruta metro a metro y devuelve las posiciones del coche.
function conducir(ruta: Punto[], azar: () => number): Punto[] {
  const paso = (VELOCIDAD_KMH / 3.6) * CADA_SEG;
  const posiciones: Punto[] = [];
  let i = 0;
  let sobra = 0;
  while (i < ruta.length - 1) {
    const largo = metros(ruta[i], ruta[i + 1]);
    let recorrido = sobra;
    while (recorrido <= largo) {
      const punto = interpolar(ruta[i], ruta[i + 1], largo === 0 ? 0 : recorrido / largo);
      posiciones.push({
        lat: punto.lat + (azar() - 0.5) * 0.00008, // ±4,5 m
        lng: punto.lng + (azar() - 0.5) * 0.00008,
      });
      recorrido += paso;
    }
    sobra = recorrido - largo;
    i += 1;
  }
  return posiciones;
}

const argumentos = process.argv.slice(2);
const semilla = Number(argumentos[argumentos.indexOf('--semilla') + 1]) || 7;

let avisosTotales = 0;
let repetidos = 0;
let tardios = 0;
let sinSegundoAviso = 0;

for (const trayecto of TRAYECTOS) {
  const rutaCompleta = await calcularRuta(trayecto.desde, trayecto.hasta);
  if (rutaCompleta === null) {
    console.log(`\n${trayecto.nombre}: sin ruta (fuera del plano)`);
    continue;
  }
  const azar = semillaAleatoria(semilla);
  const posiciones = conducir(rutaCompleta.puntos, azar);

  // Las maniobras de la ruta ENTERA: la verdad contra la que se juzga.
  const verdad = maniobrasDeLaRuta(rutaCompleta.puntos, salidasDeRotonda(rutaCompleta.puntos));
  console.log(`\n=== ${trayecto.nombre} ===`);
  console.log(`${Math.round(rutaCompleta.distanciaM)} m, ${posiciones.length} lecturas de GPS, `
    + `${verdad.length} maniobras: ${verdad.map((m) => m.giro + (m.salida ? ` (salida ${m.salida})` : '')).join(', ')}`);

  const dichas = new Set<string>();
  let ruta = rutaCompleta.puntos;
  let ultimoCalculo: Punto | null = null;
  const dichos = new Map<string, number[]>();

  for (const donde of posiciones) {
    // El plano rehace la ruta desde donde está el coche, como en la aplicación.
    if (ultimoCalculo === null || metros(ultimoCalculo, donde) > REHACER_CADA_M) {
      ultimoCalculo = donde;
      const nueva = await calcularRuta(donde, trayecto.hasta);
      if (nueva !== null) ruta = nueva.puntos;
    }

    const aviso = proximoAviso(ruta, donde, dichas, salidasDeRotonda(ruta));
    if (aviso === null) continue;
    dichas.add(aviso.clave);
    avisosTotales += 1;

    // ¿A qué distancia REAL del cruce se ha dicho? Se busca la maniobra de la
    // verdad más cercana a la que la guía cree que viene.
    let cerca = verdad[0];
    let mejor = Number.POSITIVE_INFINITY;
    for (const m of verdad) {
      const d = metros(donde, m.punto);
      if (d < mejor) { mejor = d; cerca = m; }
    }
    const etiqueta = `${cerca.giro}@${cerca.punto.lat.toFixed(4)},${cerca.punto.lng.toFixed(4)}`;
    const lista = dichos.get(etiqueta) ?? [];
    lista.push(Math.round(mejor));
    dichos.set(etiqueta, lista);

    const frase = aviso.giro === 'rotonda'
      ? `en la rotonda, salida ${aviso.salida}`
      : aviso.giro === 'llegada'
        ? 'estás llegando'
        : `${aviso.metros > 0 ? `en ${aviso.metros} m, ` : ''}gira a la ${aviso.giro}`;
    console.log(`  «${frase}» — faltaban ${Math.round(mejor)} m para ${cerca.giro}`);
  }

  // Resumen por maniobra: cuántas veces se habló de ella y a qué distancias.
  for (const [maniobra, distancias] of dichos) {
    if (distancias.length > 2) {
      repetidos += distancias.length - 2;
      console.log(`  ⚠ ${maniobra}: ${distancias.length} avisos (${distancias.join(', ')} m)`);
    }
    if (distancias.length === 1 && distancias[0] > 80) {
      sinSegundoAviso += 1;
      console.log(`  ⚠ ${maniobra}: solo un aviso, y a ${distancias[0]} m: nada justo antes del cruce`);
    }
    const primeros = distancias.filter((d) => d > 250);
    if (primeros.length > 0) tardios += primeros.length;
  }
}

console.log('\n--- Resumen ---');
console.log(`Avisos dichos:        ${avisosTotales}`);
console.log(`Repetidos de más:     ${repetidos}`);
console.log(`Sin aviso de cerca:   ${sinSegundoAviso}`);
console.log(`Dichos a más de 250 m: ${tardios}`);
