// Cálculo de rutas por carretera, en el propio teléfono.
//
// Usa el mismo plano que ya viaja con la aplicación: con las calles
// compiladas se monta un grafo y se busca el camino MÁS RÁPIDO (A*). Ni
// servicio externo, ni claves, ni una sola petición de red — y funciona sin
// conexión, igual que el mapa.
//
// Más rápido, no más corto: cada clase de vía tiene una velocidad típica y
// el coste de una arista son segundos, no metros. Sin esto la ruta se metía
// por callejones de servicio porque ahorraban veinte metros, que es
// exactamente lo que un taxista jamás haría.
//
// Los extremos se enganchan al punto más cercano DE LA CALLE, no al cruce
// más cercano: si el pasajero está a mitad de una calle larga, la ruta sale
// de ahí, no del cruce de doscientos metros atrás.
//
// Los sentidos únicos (etiqueta oneway de OSM, plano versión 3) se
// respetan. Con una salvedad: si el único camino posible va a contramano
// —un hueco en los datos, o un sentido único cortado por el borde del
// recuadro— se prefiere enseñar esa ruta a no enseñar nada.
//
// Límites honestos, porque el plano compilado no los incluye:
//   - No se conocen giros prohibidos ni semáforos.
//   - Las calles se simplificaron a 8 m, así que la línea corta ligeramente
//     las curvas cerradas.
// Es una guía visual de por dónde va el coche, no una navegación paso a paso.
// Si no hay camino (calles sin conectar en los datos), quien llama dibuja la
// línea recta de siempre.

type Plano = {
  // c: clase de vía (1 principal … 4 servicio). s: 1 → sentido único, solo
  // se circula en el orden de los puntos.
  vias: Array<{ c: number; p: number[]; s?: number }>;
};

export interface Punto {
  lat: number;
  lng: number;
}

// Velocidades típicas por clase de vía, en m/s. No son límites legales: son
// lo que de verdad se avanza en Malabo por cada tipo de calle, que es lo que
// decide por dónde conviene ir.
//   1 → avenidas y carreteras (50 km/h)   2 → secundarias (35 km/h)
//   3 → residenciales (20 km/h)           4 → servicio y callejones (10 km/h)
const VELOCIDAD_MS: Record<number, number> = { 1: 13.9, 2: 9.7, 3: 5.6, 4: 2.8 };
const VELOCIDAD_MAXIMA_MS = 13.9;

type Grafo = {
  lat: Float64Array;
  lng: Float64Array;
  // Lista de adyacencia aplanada: vecinos[inicio[i] … inicio[i+1]).
  inicio: Int32Array;
  vecinos: Int32Array;
  // Coste en SEGUNDOS de recorrer la arista.
  pesos: Float32Array;
  // 1 si la arista se puede recorrer respetando el sentido de circulación;
  // 0 si existe solo como marcha atrás de un sentido único (se usa
  // únicamente en el reintento de rescate, cuando no hay camino legal).
  legales: Uint8Array;
  // Los tramos rectos del plano, para enganchar los extremos de la ruta al
  // punto más cercano de una calle (no al cruce más cercano).
  segDesde: Int32Array;
  segHasta: Int32Array;
  segVelocidad: Float32Array;
  // 1 = solo se circula de segDesde a segHasta.
  segUnico: Uint8Array;
};

const clave = (lat: number, lng: number): string => `${lat.toFixed(5)},${lng.toFixed(5)}`;

const RADIO_M = 6_371_000;

function metros(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_M * Math.asin(Math.sqrt(h));
}

function construir(plano: Plano): Grafo {
  const indices = new Map<string, number>();
  const lats: number[] = [];
  const lngs: number[] = [];
  // [desde, hasta, segundos, legal]
  const aristas: Array<[number, number, number, number]> = [];
  const segDesde: number[] = [];
  const segHasta: number[] = [];
  const segVelocidad: number[] = [];
  const segUnico: number[] = [];

  const indiceDe = (lat: number, lng: number): number => {
    const k = clave(lat, lng);
    let i = indices.get(k);
    if (i === undefined) {
      i = lats.length;
      indices.set(k, i);
      lats.push(lat);
      lngs.push(lng);
    }
    return i;
  };

  for (const via of plano.vias) {
    const unico = via.s === 1;
    const velocidad = VELOCIDAD_MS[via.c] ?? VELOCIDAD_MS[4];
    let anterior = -1;
    for (let i = 0; i < via.p.length; i += 2) {
      const actual = indiceDe(via.p[i], via.p[i + 1]);
      if (anterior >= 0 && anterior !== actual) {
        const d = metros(lats[anterior], lngs[anterior], lats[actual], lngs[actual]);
        const coste = d / velocidad;
        // En sentido único la vuelta existe pero marcada como ilegal: solo
        // la usa el reintento de rescate cuando no hay ningún camino legal.
        aristas.push([anterior, actual, coste, 1]);
        aristas.push([actual, anterior, coste, unico ? 0 : 1]);
        segDesde.push(anterior);
        segHasta.push(actual);
        segVelocidad.push(velocidad);
        segUnico.push(unico ? 1 : 0);
      }
      anterior = actual;
    }
  }

  // Adyacencia aplanada: mucho más rápida de recorrer que un array de arrays.
  const n = lats.length;
  const cuenta = new Int32Array(n + 1);
  for (const [desde] of aristas) cuenta[desde + 1] += 1;
  for (let i = 0; i < n; i += 1) cuenta[i + 1] += cuenta[i];

  const inicio = cuenta.slice();
  const cursor = cuenta.slice();
  const vecinos = new Int32Array(aristas.length);
  const pesos = new Float32Array(aristas.length);
  const legales = new Uint8Array(aristas.length);
  for (const [desde, hasta, peso, legal] of aristas) {
    const pos = cursor[desde]++;
    vecinos[pos] = hasta;
    pesos[pos] = peso;
    legales[pos] = legal;
  }

  return {
    lat: Float64Array.from(lats),
    lng: Float64Array.from(lngs),
    inicio,
    vecinos,
    pesos,
    legales,
    segDesde: Int32Array.from(segDesde),
    segHasta: Int32Array.from(segHasta),
    segVelocidad: Float32Array.from(segVelocidad),
    segUnico: Uint8Array.from(segUnico),
  };
}

let grafo: Grafo | null = null;
let construyendo: Promise<Grafo> | null = null;

// Permite montar el grafo con un plano ya cargado. Lo usan las pruebas, que
// corren en Node y no pueden importar el JSON como módulo del empaquetador.
export function cargarPlano(plano: Plano): void {
  grafo = construir(plano);
  construyendo = Promise.resolve(grafo);
}

function obtenerGrafo(): Promise<Grafo> {
  if (grafo) return Promise.resolve(grafo);
  if (!construyendo) {
    construyendo = import('./mapa-malabo.json').then((modulo) => {
      const plano = (modulo.default ?? modulo) as unknown as Plano;
      grafo = construir(plano);
      return grafo;
    });
  }
  return construyendo;
}

// El enganche de un extremo: en qué tramo cae, en qué punto exacto de ese
// tramo, y a cuántos metros queda.
interface Enganche {
  segmento: number;
  // Posición dentro del tramo: 0 = segDesde, 1 = segHasta.
  t: number;
  lat: number;
  lng: number;
  distanciaM: number;
}

// Escala para comparar distancias en grados como si fueran planas. A la
// latitud de Malabo el error es despreciable y ahorra trigonometría en un
// bucle que recorre todos los tramos del plano.
const COS_LAT = Math.cos((3.75 * Math.PI) / 180);

// Punto más cercano DE UNA CALLE, no cruce más cercano. Recorre todos los
// tramos (≈10.000) proyectando el punto sobre cada uno: milisegundos, y es
// lo que hace que la ruta salga de donde está la persona y no del cruce de
// doscientos metros atrás.
function engancharA(g: Grafo, punto: Punto): Enganche | null {
  let mejorSeg = -1;
  let mejorT = 0;
  let mejorD2 = Number.POSITIVE_INFINITY;

  for (let s = 0; s < g.segDesde.length; s += 1) {
    const a = g.segDesde[s];
    const b = g.segHasta[s];
    const ax = (g.lng[a] - punto.lng) * COS_LAT;
    const ay = g.lat[a] - punto.lat;
    const bx = (g.lng[b] - punto.lng) * COS_LAT;
    const by = g.lat[b] - punto.lat;
    const dx = bx - ax;
    const dy = by - ay;
    const largo2 = dx * dx + dy * dy;
    const t = largo2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / largo2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    const d2 = px * px + py * py;
    if (d2 < mejorD2) {
      mejorD2 = d2;
      mejorSeg = s;
      mejorT = t;
    }
  }
  if (mejorSeg < 0) return null;

  const a = g.segDesde[mejorSeg];
  const b = g.segHasta[mejorSeg];
  const lat = g.lat[a] + (g.lat[b] - g.lat[a]) * mejorT;
  const lng = g.lng[a] + (g.lng[b] - g.lng[a]) * mejorT;
  return {
    segmento: mejorSeg,
    t: mejorT,
    lat,
    lng,
    distanciaM: metros(lat, lng, punto.lat, punto.lng),
  };
}

// Montículo binario mínimo: la cola de prioridad de A*.
class Monticulo {
  private nodos: number[] = [];
  private costes: number[] = [];

  get vacio(): boolean {
    return this.nodos.length === 0;
  }

  meter(nodo: number, coste: number): void {
    this.nodos.push(nodo);
    this.costes.push(coste);
    let i = this.nodos.length - 1;
    while (i > 0) {
      const padre = (i - 1) >> 1;
      if (this.costes[padre] <= this.costes[i]) break;
      this.intercambiar(i, padre);
      i = padre;
    }
  }

  sacar(): number {
    const cima = this.nodos[0];
    const ultimoNodo = this.nodos.pop()!;
    const ultimoCoste = this.costes.pop()!;
    if (this.nodos.length > 0) {
      this.nodos[0] = ultimoNodo;
      this.costes[0] = ultimoCoste;
      let i = 0;
      for (;;) {
        const izq = 2 * i + 1;
        const der = izq + 1;
        let menor = i;
        if (izq < this.costes.length && this.costes[izq] < this.costes[menor]) menor = izq;
        if (der < this.costes.length && this.costes[der] < this.costes[menor]) menor = der;
        if (menor === i) break;
        this.intercambiar(i, menor);
        i = menor;
      }
    }
    return cima;
  }

  private intercambiar(a: number, b: number): void {
    [this.nodos[a], this.nodos[b]] = [this.nodos[b], this.nodos[a]];
    [this.costes[a], this.costes[b]] = [this.costes[b], this.costes[a]];
  }
}

export interface Ruta {
  puntos: Punto[];
  distanciaM: number;
  // true si hubo que unir el principio o el final con una línea recta porque
  // el punto no cae sobre ninguna calle conocida.
  aproximada: boolean;
}

// Distancia máxima entre un punto pedido y la calle más cercana. Más allá, se
// entiende que el punto está fuera del plano y no se enruta.
const MAXIMO_ENGANCHE_M = 400;

export async function calcularRuta(desde: Punto, hasta: Punto): Promise<Ruta | null> {
  const g = await obtenerGrafo();
  const inicio = engancharA(g, desde);
  const fin = engancharA(g, hasta);
  if (!inicio || !fin) return null;
  if (inicio.distanciaM > MAXIMO_ENGANCHE_M || fin.distanciaM > MAXIMO_ENGANCHE_M) return null;
  // El mismo punto de la misma calle: no hay nada que enrutar.
  if (inicio.segmento === fin.segmento && Math.abs(inicio.t - fin.t) < 1e-6) return null;

  // Dos nodos virtuales fuera del grafo: el punto de salida y el de llegada,
  // colgados de los extremos de sus tramos. Así el A* no cambia: son dos
  // nodos más, solo que sus aristas se calculan aquí en vez de venir de la
  // adyacencia.
  const n = g.lat.length;
  const V_INICIO = n;
  const V_FIN = n + 1;

  const latDe = (i: number): number => (i === V_INICIO ? inicio.lat : i === V_FIN ? fin.lat : g.lat[i]);
  const lngDe = (i: number): number => (i === V_INICIO ? inicio.lng : i === V_FIN ? fin.lng : g.lng[i]);

  const buscar = (respetarSentido: boolean): number[] | null => {
    const coste = new Float64Array(n + 2).fill(Infinity);
    const previo = new Int32Array(n + 2).fill(-1);
    const cerrado = new Uint8Array(n + 2);
    const cola = new Monticulo();

    const heuristica = (i: number): number =>
      metros(latDe(i), lngDe(i), fin.lat, fin.lng) / VELOCIDAD_MAXIMA_MS;

    const relajar = (desdeN: number, hastaN: number, peso: number): void => {
      if (cerrado[hastaN]) return;
      const nuevo = coste[desdeN] + peso;
      if (nuevo < coste[hastaN]) {
        coste[hastaN] = nuevo;
        previo[hastaN] = desdeN;
        cola.meter(hastaN, nuevo + heuristica(hastaN));
      }
    };

    coste[V_INICIO] = 0;
    cola.meter(V_INICIO, heuristica(V_INICIO));

    while (!cola.vacio) {
      const actual = cola.sacar();
      if (cerrado[actual]) continue;
      cerrado[actual] = 1;
      if (actual === V_FIN) break;

      if (actual === V_INICIO) {
        const s = inicio.segmento;
        const a = g.segDesde[s];
        const b = g.segHasta[s];
        const vel = g.segVelocidad[s];
        // Hacia adelante (el sentido permitido del tramo) siempre; hacia
        // atrás solo si el tramo es de doble sentido o no se respeta.
        relajar(V_INICIO, b, metros(inicio.lat, inicio.lng, g.lat[b], g.lng[b]) / vel);
        if (!respetarSentido || g.segUnico[s] === 0) {
          relajar(V_INICIO, a, metros(inicio.lat, inicio.lng, g.lat[a], g.lng[a]) / vel);
        }
        // Salida y llegada en el MISMO tramo: también se puede ir directo,
        // sin pasar por ningún cruce.
        if (fin.segmento === s) {
          const haciaAdelante = fin.t > inicio.t;
          if (haciaAdelante || !respetarSentido || g.segUnico[s] === 0) {
            relajar(V_INICIO, V_FIN, metros(inicio.lat, inicio.lng, fin.lat, fin.lng) / vel);
          }
        }
        continue;
      }

      for (let arista = g.inicio[actual]; arista < g.inicio[actual + 1]; arista += 1) {
        if (respetarSentido && g.legales[arista] === 0) continue;
        relajar(actual, g.vecinos[arista], g.pesos[arista]);
      }
      // ¿Este nodo es un extremo del tramo de llegada? Entonces desde aquí
      // se puede entrar al punto exacto de destino.
      const s = fin.segmento;
      if (actual === g.segDesde[s]) {
        relajar(actual, V_FIN, metros(g.lat[actual], g.lng[actual], fin.lat, fin.lng) / g.segVelocidad[s]);
      } else if (actual === g.segHasta[s]) {
        if (!respetarSentido || g.segUnico[s] === 0) {
          relajar(actual, V_FIN, metros(g.lat[actual], g.lng[actual], fin.lat, fin.lng) / g.segVelocidad[s]);
        }
      }
    }
    if (!cerrado[V_FIN]) return null;

    const camino: number[] = [];
    for (let i = V_FIN; i >= 0; i = previo[i]) {
      camino.push(i);
      if (i === V_INICIO) break;
    }
    return camino.reverse();
  };

  // Primero respetando los sentidos únicos; si los datos no dejan ningún
  // camino legal, se reintenta ignorándolos: enseñar una ruta a contramano
  // es mejor que no enseñar nada.
  const camino = buscar(true) ?? buscar(false);
  if (!camino) return null;

  const puntos: Punto[] = [desde];
  for (const i of camino) {
    puntos.push({ lat: latDe(i), lng: lngDe(i) });
  }
  puntos.push(hasta);

  let distanciaM = 0;
  for (let i = 1; i < puntos.length; i += 1) {
    distanciaM += metros(puntos[i - 1].lat, puntos[i - 1].lng, puntos[i].lat, puntos[i].lng);
  }

  // Se cosen los extremos reales: del punto pedido a la calle y viceversa.
  const aproximada = inicio.distanciaM > 25 || fin.distanciaM > 25;
  return { puntos, distanciaM, aproximada };
}
