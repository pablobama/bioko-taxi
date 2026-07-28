// Cálculo de rutas por carretera, en el propio teléfono.
//
// Usa el mismo plano que ya viaja con la aplicación: con las calles
// compiladas se monta un grafo y se busca el camino más corto (A*). Ni
// servicio externo, ni claves, ni una sola petición de red — y funciona sin
// conexión, igual que el mapa.
//
// Límites honestos, porque el plano compilado no los incluye:
//   - No se conocen los sentidos únicos: una ruta puede ir a contramano.
//   - No se conocen giros prohibidos ni semáforos.
//   - Las calles se simplificaron a 8 m, así que la línea corta ligeramente
//     las curvas cerradas.
// Es una guía visual de por dónde va el coche, no una navegación paso a paso.
// Si no hay camino (calles sin conectar en los datos), quien llama dibuja la
// línea recta de siempre.

type Plano = {
  vias: Array<{ c: number; p: number[] }>;
};

export interface Punto {
  lat: number;
  lng: number;
}

// Nodo del grafo: identificado por su coordenada redondeada. El compilador
// redondea a 5 decimales (~1 m) y OSM parte las vías en los cruces, así que
// dos calles que se cruzan comparten exactamente el mismo punto.
type Grafo = {
  // clave → índice
  indices: Map<string, number>;
  lat: Float64Array;
  lng: Float64Array;
  // Lista de adyacencia aplanada: vecinos[inicio[i] … inicio[i+1]).
  inicio: Int32Array;
  vecinos: Int32Array;
  pesos: Float32Array;
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
  const aristas: Array<[number, number, number]> = [];

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
    let anterior = -1;
    for (let i = 0; i < via.p.length; i += 2) {
      const actual = indiceDe(via.p[i], via.p[i + 1]);
      if (anterior >= 0 && anterior !== actual) {
        const d = metros(lats[anterior], lngs[anterior], lats[actual], lngs[actual]);
        // Sin datos de sentido único: el grafo es bidireccional.
        aristas.push([anterior, actual, d]);
        aristas.push([actual, anterior, d]);
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
  for (const [desde, hasta, peso] of aristas) {
    const pos = cursor[desde]++;
    vecinos[pos] = hasta;
    pesos[pos] = peso;
  }

  return {
    indices,
    lat: Float64Array.from(lats),
    lng: Float64Array.from(lngs),
    inicio,
    vecinos,
    pesos,
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

// Nodo más cercano a un punto cualquiera. Búsqueda lineal: con ~11.000 nodos
// son pocos milisegundos y evita traer un índice espacial.
function nodoMasCercano(g: Grafo, punto: Punto): { indice: number; distanciaM: number } {
  let mejor = -1;
  let mejorDistancia = Number.POSITIVE_INFINITY;
  for (let i = 0; i < g.lat.length; i += 1) {
    // Comparación en el plano (sin raíz ni trigonometría) para descartar
    // rápido; solo se afina al final.
    const dLat = g.lat[i] - punto.lat;
    const dLng = (g.lng[i] - punto.lng) * 0.998; // cos(3,75°)
    const d2 = dLat * dLat + dLng * dLng;
    if (d2 < mejorDistancia) {
      mejorDistancia = d2;
      mejor = i;
    }
  }
  return {
    indice: mejor,
    distanciaM: mejor < 0 ? Infinity : metros(g.lat[mejor], g.lng[mejor], punto.lat, punto.lng),
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
  const inicio = nodoMasCercano(g, desde);
  const fin = nodoMasCercano(g, hasta);
  if (inicio.indice < 0 || fin.indice < 0) return null;
  if (inicio.distanciaM > MAXIMO_ENGANCHE_M || fin.distanciaM > MAXIMO_ENGANCHE_M) return null;
  if (inicio.indice === fin.indice) return null;

  const n = g.lat.length;
  const coste = new Float64Array(n).fill(Infinity);
  const previo = new Int32Array(n).fill(-1);
  const cerrado = new Uint8Array(n);
  const cola = new Monticulo();

  const heuristica = (i: number): number =>
    metros(g.lat[i], g.lng[i], g.lat[fin.indice], g.lng[fin.indice]);

  coste[inicio.indice] = 0;
  cola.meter(inicio.indice, heuristica(inicio.indice));

  let encontrado = false;
  while (!cola.vacio) {
    const actual = cola.sacar();
    if (cerrado[actual]) continue;
    cerrado[actual] = 1;
    if (actual === fin.indice) {
      encontrado = true;
      break;
    }
    for (let a = g.inicio[actual]; a < g.inicio[actual + 1]; a += 1) {
      const vecino = g.vecinos[a];
      if (cerrado[vecino]) continue;
      const nuevo = coste[actual] + g.pesos[a];
      if (nuevo < coste[vecino]) {
        coste[vecino] = nuevo;
        previo[vecino] = actual;
        cola.meter(vecino, nuevo + heuristica(vecino));
      }
    }
  }
  if (!encontrado) return null;

  const puntos: Punto[] = [];
  for (let i = fin.indice; i >= 0; i = previo[i]) {
    puntos.push({ lat: g.lat[i], lng: g.lng[i] });
  }
  puntos.reverse();

  // Se cosen los extremos reales: del punto pedido a la calle y viceversa.
  const aproximada = inicio.distanciaM > 25 || fin.distanciaM > 25;
  return {
    puntos: [desde, ...puntos, hasta],
    distanciaM: coste[fin.indice] + inicio.distanciaM + fin.distanciaM,
    aproximada,
  };
}
