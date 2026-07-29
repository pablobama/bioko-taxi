// Compila el plano de Malabo dentro de la aplicación.
//
// Descarga de OpenStreetMap (vía Overpass) la geometría de las calles de
// Malabo, la reduce y la escribe en src/mapa-malabo.json. Ese fichero se
// empaqueta con la PWA: el plano viaja DENTRO de la app, se descarga una sola
// vez y funciona sin red. Nada de baldosas en tiempo de ejecución.
//
// Se ejecuta a mano cuando se quiera refrescar el plano, no en cada build:
//   node scripts/compilar-mapa.mjs
//
// Licencia: los datos son de OpenStreetMap, ODbL. La atribución a
// «OpenStreetMap contributors» es obligatoria y está en la interfaz.

import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const RECUADRO = { sur: 3.695, oeste: 8.705, norte: 3.815, este: 8.845 };

// Clases de vía que se conservan, agrupadas por importancia visual. Se dejan
// fuera las sendas, pistas y caminos peatonales: no aportan a orientarse en
// coche y multiplican el tamaño.
const CLASES = {
  motorway: 1, trunk: 1, primary: 1,
  secondary: 2, tertiary: 2,
  residential: 3, unclassified: 3, living_street: 3, road: 3,
  service: 4,
};

const DECIMALES = 5; // ~1 m: de sobra para dibujar un plano de ciudad
const TOLERANCIA_M = 8; // simplificación Douglas-Peucker

// Sentido único, según el etiquetado de OSM. Devuelve:
//   1  → solo se circula en el orden en que vienen los puntos
//   -1 → solo al revés (el compilador lo normaliza dando la vuelta a la vía)
//   0  → en ambos sentidos
// Las rotondas son de sentido único por convención aunque no lleven la
// etiqueta; es la implicación de OSM más relevante en Malabo.
function sentidoUnico(tags) {
  const oneway = tags?.oneway;
  if (oneway === 'yes' || oneway === '1' || oneway === 'true') return 1;
  if (oneway === '-1' || oneway === 'reverse') return -1;
  if (oneway === 'no') return 0;
  if (tags?.junction === 'roundabout' || tags?.junction === 'circular') return 1;
  return 0;
}

function redondear(n) {
  return Number(n.toFixed(DECIMALES));
}

// Distancia perpendicular de un punto al segmento a-b, en grados aproximados
// convertidos a metros (a la latitud de Malabo).
function distanciaPerpendicularM(punto, a, b) {
  const escalaLat = 111_320;
  const escalaLng = 111_320 * Math.cos((3.75 * Math.PI) / 180);
  const px = (punto.lon - a.lon) * escalaLng;
  const py = (punto.lat - a.lat) * escalaLat;
  const bx = (b.lon - a.lon) * escalaLng;
  const by = (b.lat - a.lat) * escalaLat;
  const largo = bx * bx + by * by;
  if (largo === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / largo));
  return Math.hypot(px - t * bx, py - t * by);
}

function simplificar(puntos, tolerancia) {
  if (puntos.length <= 2) return puntos;
  let peor = 0;
  let indice = 0;
  for (let i = 1; i < puntos.length - 1; i += 1) {
    const d = distanciaPerpendicularM(puntos[i], puntos[0], puntos[puntos.length - 1]);
    if (d > peor) {
      peor = d;
      indice = i;
    }
  }
  if (peor <= tolerancia) {
    return [puntos[0], puntos[puntos.length - 1]];
  }
  const izquierda = simplificar(puntos.slice(0, indice + 1), tolerancia);
  const derecha = simplificar(puntos.slice(indice), tolerancia);
  return [...izquierda.slice(0, -1), ...derecha];
}

// Espejos de Overpass: el principal se cae a menudo.
const ESPEJOS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
];

async function consultar(consulta) {
  let ultimoError = 'sin intentos';
  for (const url of ESPEJOS) {
    try {
      const respuesta = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'taxi-malabo/0.1 (compilacion del plano)',
        },
        body: `data=${encodeURIComponent(consulta)}`,
        signal: AbortSignal.timeout(180_000),
      });
      if (!respuesta.ok) {
        ultimoError = `${url} respondió ${respuesta.status}`;
        continue;
      }
      const datos = await respuesta.json();
      // Un espejo saturado puede responder 200 con la lista vacía. Eso no es
      // una respuesta válida: se prueba el siguiente en lugar de dar por buena
      // una consulta sin resultados (que fue lo que dejó el plano sin calles).
      if (!Array.isArray(datos.elements) || datos.elements.length === 0) {
        ultimoError = `${url} devolvió una respuesta vacía`;
        continue;
      }
      return datos;
    } catch (error) {
      ultimoError = `${url}: ${error.message}`;
    }
  }
  throw new Error(`Ningún espejo de Overpass respondió. Último: ${ultimoError}`);
}

// El mar, a partir de la línea de costa.
//
// OSM da la costa como líneas abiertas, no como polígono, y convertirla en «el
// mar» exige recortar contra el recuadro visible. En vez de eso se usa la
// convención de OSM —la costa va dirigida con la TIERRA a la izquierda y el
// AGUA a la derecha— y se genera una banda ancha hacia la derecha de cada
// tramo. Se pinta bajo las calles, se extiende más allá de lo visible y no hace
// falta recortar nada. No es el mar de verdad: es una franja que lo representa
// pegada a la costa, y con el ancho suficiente llena todo el agua visible.
const ANCHO_MAR_GRADOS = 0.06; // ~6,6 km: de sobra para el recuadro de Malabo

function bandaDeAgua(puntos) {
  const cosLat = Math.cos((3.75 * Math.PI) / 180);
  const derecha = [];
  for (let i = 0; i < puntos.length; i += 1) {
    const anterior = puntos[Math.max(0, i - 1)];
    const siguiente = puntos[Math.min(puntos.length - 1, i + 1)];
    // Dirección del avance, en grados corregidos para que el ángulo sea real.
    const dx = (siguiente.lon - anterior.lon) * cosLat;
    const dy = siguiente.lat - anterior.lat;
    const largo = Math.hypot(dx, dy) || 1;
    // Normal a la derecha del avance: (dy, -dx).
    const nx = (dy / largo) * ANCHO_MAR_GRADOS;
    const ny = (-dx / largo) * ANCHO_MAR_GRADOS;
    derecha.push({
      lat: puntos[i].lat + ny,
      lon: puntos[i].lon + nx / cosLat,
    });
  }
  // Polígono: la costa de ida, la banda desplazada de vuelta.
  const anillo = [...puntos, ...derecha.reverse()];
  const planas = [];
  for (const p of anillo) {
    planas.push(redondear(p.lat), redondear(p.lon));
  }
  return planas;
}

async function principal() {
  const tipos = Object.keys(CLASES).join('|');
  const consulta = `[out:json][timeout:180];`
    + `(way["highway"~"^(${tipos})$"]`
    + `(${RECUADRO.sur},${RECUADRO.oeste},${RECUADRO.norte},${RECUADRO.este}););`
    + `out geom;`;

  console.log('Descargando las calles de Malabo…');
  const datos = await consultar(consulta);

  console.log('Descargando la línea de costa…');
  const costa = await consultar(
    `[out:json][timeout:120];way["natural"="coastline"]`
    + `(${RECUADRO.sur - 0.02},${RECUADRO.oeste - 0.02},`
    + `${RECUADRO.norte + 0.02},${RECUADRO.este + 0.02});out geom;`,
  );

  // Las coordenadas se redondean ANTES de nada: así dos calles que se cruzan
  // comparten exactamente la misma clave y el cruce es detectable.
  const trazados = [];
  for (const elemento of datos.elements) {
    if (elemento.type !== 'way' || !elemento.geometry) continue;
    const crudos = elemento.geometry
      .filter(Boolean)
      .map((p) => ({ lat: redondear(p.lat), lon: redondear(p.lon) }));
    if (crudos.length < 2) continue;
    // oneway=-1 (contra el orden de los puntos) se normaliza aquí dando la
    // vuelta a la vía: el fichero final solo conoce «único» o «ambos».
    const sentido = sentidoUnico(elemento.tags);
    if (sentido === -1) crudos.reverse();
    trazados.push({
      clase: CLASES[elemento.tags?.highway] ?? 4,
      puntos: crudos,
      unico: sentido !== 0,
    });
  }

  // Cruces: todo punto que aparece en más de un sitio. Hay que conservarlos
  // sí o sí, porque son los que unen unas calles con otras.
  //
  // Esto es lo que faltaba y dejaba el plano en 1.493 trozos inconexos: la
  // simplificación borraba puntos intermedios de una calle larga, y con ellos
  // el nudo donde desembocaba otra. Al enrutar no había camino de ningún sitio
  // a ningún sitio.
  const apariciones = new Map();
  for (const { puntos } of trazados) {
    for (const p of puntos) {
      const k = `${p.lat},${p.lon}`;
      apariciones.set(k, (apariciones.get(k) ?? 0) + 1);
    }
  }
  const esCruce = (p) => (apariciones.get(`${p.lat},${p.lon}`) ?? 0) > 1;

  const vias = [];
  let puntosOriginales = 0;
  let puntosFinales = 0;
  let cruces = 0;
  let deSentidoUnico = 0;
  for (const { clase, puntos, unico } of trazados) {
    puntosOriginales += puntos.length;

    // Se simplifica por tramos entre cruces: como Douglas-Peucker respeta los
    // extremos de lo que recibe, ningún cruce puede desaparecer.
    const simples = [];
    let tramo = [puntos[0]];
    for (let i = 1; i < puntos.length; i += 1) {
      tramo.push(puntos[i]);
      const ultimo = i === puntos.length - 1;
      if (esCruce(puntos[i]) || ultimo) {
        const reducido = simplificar(tramo, TOLERANCIA_M);
        // El primer punto del tramo ya está en la lista salvo al principio.
        simples.push(...(simples.length === 0 ? reducido : reducido.slice(1)));
        tramo = [puntos[i]];
      }
    }
    puntosFinales += simples.length;

    // Coordenadas en una lista plana [lat, lng, lat, lng…]: bastante más
    // pequeño en JSON que una lista de pares.
    const planas = [];
    for (const p of simples) {
      planas.push(p.lat, p.lon);
      if (esCruce(p)) cruces += 1;
    }
    // «s: 1» solo en las de sentido único: omitir el campo en el resto ahorra
    // unos KB y deja el formato compatible con lo que ya había.
    if (unico) deSentidoUnico += 1;
    vias.push(unico ? { c: clase, p: planas, s: 1 } : { c: clase, p: planas });
  }

  const agua = [];
  let puntosCosta = 0;
  for (const elemento of costa.elements) {
    if (elemento.type !== 'way' || !elemento.geometry) continue;
    const crudos = elemento.geometry.filter(Boolean);
    if (crudos.length < 2) continue;
    puntosCosta += crudos.length;
    agua.push({ p: bandaDeAgua(simplificar(crudos, TOLERANCIA_M)) });
  }

  const salida = {
    version: 3,
    fuente: 'OpenStreetMap contributors (ODbL)',
    recuadro: RECUADRO,
    vias,
    agua,
  };

  // Red de seguridad: nunca sustituir un plano bueno por uno vacío. Malabo
  // tiene miles de vías; si salen cuatro, algo falló aguas arriba y es mejor
  // quedarse con el fichero anterior.
  const MINIMO_VIAS = 1000;
  if (vias.length < MINIMO_VIAS) {
    throw new Error(
      `Solo se obtuvieron ${vias.length} vías (mínimo esperado ${MINIMO_VIAS}). `
      + 'No se sobrescribe el plano existente. Reintenta más tarde.',
    );
  }

  const json = JSON.stringify(salida);
  const ruta = new URL('../src/mapa-malabo.json', import.meta.url);
  writeFileSync(ruta, json);

  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
  console.log(`Vías: ${vias.length} (${deSentidoUnico} de sentido único)`);
  console.log(`Costa: ${agua.length} tramos (${puntosCosta} puntos originales)`);
  console.log(`Puntos: ${puntosOriginales} → ${puntosFinales} (simplificado a ${TOLERANCIA_M} m)`);
  console.log(`Cruces conservados: ${cruces}`);
  console.log(`Tamaño: ${kb(json.length)} sin comprimir, ${kb(gzipSync(json).length)} comprimido`);
  console.log('Escrito en src/mapa-malabo.json');
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
