// Proyección y cámara del plano de Malabo.
//
// Proyección plana propia, la misma del prototipo de diseño: la ciudad ocupa
// 3 km, así que no hace falta Mercator ni nada esférico. Basta escalar los
// grados por un factor fijo y corregir la longitud por el coseno de la latitud
// para que las calles no salgan estiradas.
//
//   x = (lng - oeste) · 100000 · cos(latMedia)
//   y = (norte - lat) · 100000            ← y crece hacia el sur, como el SVG
//
// Las unidades son «cien milésimas de grado»: 100.000 por grado de latitud,
// o sea ~1,11 unidades por metro. No son metros a propósito: mantener el
// factor redondo hace que los números del plano se lean fácil al depurar.
//
// El plano se dibuja UNA vez en estas coordenadas y luego solo se mueve el
// `transform` del grupo que lo contiene. En un Android de gama baja eso es un
// cambio de atributo por fotograma, no un redibujado: es la razón de que este
// mapa vaya suelto donde uno de baldosas se arrastra.

export interface Plano {
  recuadro: { sur: number; oeste: number; norte: number; este: number };
  vias: Array<{ c: number; p: number[] }>;
  agua: Array<{ p: number[] }>;
}

export type Punto2D = [number, number];

const UNIDADES_POR_GRADO = 100_000;
const RADIO_M = 6_371_000;

export interface Proyeccion {
  aMundo: (lat: number, lng: number) => Punto2D;
  unidadesPorMetro: number;
}

export function crearProyeccion(recuadro: Plano['recuadro']): Proyeccion {
  const latMedia = (recuadro.sur + recuadro.norte) / 2;
  const cosLat = Math.cos((latMedia * Math.PI) / 180);
  const escalaX = UNIDADES_POR_GRADO * cosLat;
  // Un grado de latitud son ~111,32 km en cualquier parte del planeta.
  const unidadesPorMetro = UNIDADES_POR_GRADO / (2 * Math.PI * RADIO_M / 360);
  return {
    aMundo: (lat, lng) => [(lng - recuadro.oeste) * escalaX, (recuadro.norte - lat) * UNIDADES_POR_GRADO],
    unidadesPorMetro,
  };
}

// --- Trazados del plano ----------------------------------------------------

export interface Trazados {
  // Un único `path` por clase de vía: 3.700 elementos separados irían lentos.
  porClase: Record<number, string>;
  mar: string;
  costa: string;
}

function aPath(puntos: Punto2D[], cerrar = false): string {
  if (puntos.length === 0) return '';
  const partes = puntos.map((p, i) =>
    `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`);
  return partes.join('') + (cerrar ? 'Z' : '');
}

export function construirTrazados(plano: Plano, proy: Proyeccion): Trazados {
  const porClase: Record<number, string[]> = { 1: [], 2: [], 3: [], 4: [] };
  for (const via of plano.vias) {
    const puntos: Punto2D[] = [];
    for (let i = 0; i < via.p.length; i += 2) {
      puntos.push(proy.aMundo(via.p[i], via.p[i + 1]));
    }
    (porClase[via.c] ?? porClase[4]).push(aPath(puntos));
  }

  // Cada banda de agua es un anillo: la costa de ida y su desplazamiento mar
  // adentro de vuelta (ver bandaDeAgua en scripts/compilar-mapa.mjs). Por eso
  // la PRIMERA MITAD del anillo es la línea de costa real, y se puede trazar
  // aparte para marcarla: es la referencia visual más fuerte de Malabo.
  const mar: string[] = [];
  const costa: string[] = [];
  for (const banda of plano.agua) {
    const anillo: Punto2D[] = [];
    for (let i = 0; i < banda.p.length; i += 2) {
      anillo.push(proy.aMundo(banda.p[i], banda.p[i + 1]));
    }
    if (anillo.length < 4) continue;
    mar.push(aPath(anillo, true));
    costa.push(aPath(anillo.slice(0, anillo.length / 2)));
  }

  return {
    porClase: {
      1: porClase[1].join(''),
      2: porClase[2].join(''),
      3: porClase[3].join(''),
      4: porClase[4].join(''),
    },
    mar: mar.join(''),
    costa: costa.join(''),
  };
}

// --- Cámara ----------------------------------------------------------------

export interface Camara {
  cx: number;
  cy: number;
  escala: number;
  // Hacia dónde mira la cámara, en RADIANES desde el norte y en el sentido de
  // las agujas del reloj: 0 (o sin valor) es el norte arriba, como toda la
  // vida; π/2 es el este arriba. Con el rumbo del coche, el plano gira para
  // que lo que el conductor tiene delante del parabrisas esté arriba en la
  // pantalla, que es lo que evita tener que traducir «giro a la derecha del
  // mapa» a «giro a mi izquierda» a sesenta por hora.
  rumbo?: number;
}

export interface OpcionesEncuadre {
  // Margen en píxeles alrededor de lo encuadrado, para que ningún marcador
  // quede pegado al borde.
  margen?: number;
  // Cuánto terreno cabe de ancho, en metros: el mínimo es lo más cerca que
  // llega el zoom, el máximo lo más lejos.
  metrosMinimos?: number;
  metrosMaximos?: number;
  // El mismo rumbo con el que se va a dibujar. Hace falta aquí porque al
  // girar cambia qué cabe: una ruta que en vertical entra justa, en diagonal
  // no. Sin esto, encuadrar con el mapa girado deja medio recorrido fuera.
  rumbo?: number;
}

// El mundo se dibuja con el norte hacia arriba (y crece hacia el sur), así
// que poner el rumbo `r` arriba es girar el mundo `-r`.
function girar([x, y]: Punto2D, radianes: number): Punto2D {
  if (radianes === 0) return [x, y];
  const cos = Math.cos(radianes);
  const sen = Math.sin(radianes);
  return [x * cos - y * sen, x * sen + y * cos];
}

// Encuadra todos los puntos dados dentro de un rectángulo de ancho×alto
// píxeles. Devuelve el centro (en coordenadas de mundo) y la escala en
// píxeles por unidad.
export function encuadrar(
  puntos: Punto2D[],
  ancho: number,
  alto: number,
  proy: Proyeccion,
  opciones: OpcionesEncuadre = {},
): Camara | null {
  if (puntos.length === 0 || ancho <= 0 || alto <= 0) return null;
  const margen = opciones.margen ?? 46;
  const metrosMinimos = opciones.metrosMinimos ?? 420;
  const metrosMaximos = opciones.metrosMaximos ?? 14_000;

  // La caja se mide en el espacio YA GIRADO: es el que se va a ver.
  const rumbo = opciones.rumbo ?? 0;
  const girados = puntos.map((p) => girar(p, -rumbo));
  const xs = girados.map((p) => p[0]);
  const ys = girados.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const utilAncho = Math.max(40, ancho - margen * 2);
  const utilAlto = Math.max(40, alto - margen * 2);
  const anchoMundo = maxX - minX;
  const altoMundo = maxY - minY;

  // Un solo punto (o todos juntos) no define escala: se usa la más cercana.
  const ajuste = Math.min(
    anchoMundo > 0 ? utilAncho / anchoMundo : Infinity,
    altoMundo > 0 ? utilAlto / altoMundo : Infinity,
  );

  const escalaMasCerca = ancho / (metrosMinimos * proy.unidadesPorMetro);
  const escalaMasLejos = ancho / (metrosMaximos * proy.unidadesPorMetro);
  const escala = Math.min(escalaMasCerca, Math.max(escalaMasLejos, ajuste));

  // Y el centro se devuelve otra vez en coordenadas de mundo, que es lo que
  // toda la aplicación entiende: el giro lo vuelve a aplicar quien dibuja.
  const [cx, cy] = girar([(minX + maxX) / 2, (minY + maxY) / 2], rumbo);
  return { cx, cy, escala, rumbo };
}

// Coordenadas de mundo → píxeles del SVG.
export function aPantalla(
  punto: Punto2D,
  camara: Camara,
  ancho: number,
  alto: number,
): Punto2D {
  const [dx, dy] = girar(
    [(punto[0] - camara.cx) * camara.escala, (punto[1] - camara.cy) * camara.escala],
    -(camara.rumbo ?? 0),
  );
  return [dx + ancho / 2, dy + alto / 2];
}

// `transform` del grupo que contiene el plano entero.
export function transformacion(camara: Camara, ancho: number, alto: number): string {
  const { cx, cy, escala } = camara;
  const rumbo = camara.rumbo ?? 0;
  // Sin rumbo se deja la forma corta de siempre: es la que se dibuja el 99 %
  // del tiempo y un `transform` con tres pasos más cuesta en un Android viejo.
  if (rumbo === 0) {
    return `translate(${(ancho / 2 - cx * escala).toFixed(2)},${(alto / 2 - cy * escala).toFixed(2)}) scale(${escala.toFixed(5)})`;
  }
  const grados = (-rumbo * 180) / Math.PI;
  return `translate(${(ancho / 2).toFixed(2)},${(alto / 2).toFixed(2)})`
    + ` rotate(${grados.toFixed(2)})`
    + ` scale(${escala.toFixed(5)})`
    + ` translate(${(-cx).toFixed(2)},${(-cy).toFixed(2)})`;
}

// --- Tema del plano --------------------------------------------------------

// Colores del plano, apagados a propósito: es el telón de fondo, y las rutas
// del viaje en ámbar tienen que destacar sobre él sin competencia.
export const TEMA_MAPA = {
  tierra: '#101015',
  mar: '#0b1a22',
  costa: '#22404d',
  vias: {
    1: { color: '#4a4a57', grosor: 6 },
    2: { color: '#383842', grosor: 3.6 },
    3: { color: '#2a2a33', grosor: 2.2 },
    4: { color: '#212129', grosor: 1.2 },
  } as Record<number, { color: string; grosor: number }>,
};
