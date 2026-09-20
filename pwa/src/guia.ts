// Guía por voz para el taxista: las maniobras de la ruta, dichas a tiempo.
//
// Es OPCIONAL y viene apagada. Un taxista de Malabo se sabe la ciudad mejor
// que ningún plano, y una voz dando instrucciones sobre calles que conoce de
// memoria no ayuda: molesta. Para lo que sí sirve es para una dirección en un
// barrio nuevo, de noche, con el móvil en el soporte y sin poder mirarlo.
//
// No hay nombres de calle en el plano —el grafo guarda geometría y clase de
// vía, no rótulos—, así que no se dice «gire en la calle Kenia». Se dice el
// giro y la distancia, que es lo que se usa conduciendo: «en doscientos
// metros, gire a la derecha». Un nombre de calle mal dicho por una voz
// sintética es peor que no decirlo.
//
// Este fichero no habla ni sabe de React: convierte una ruta y una posición en
// «qué hay que decir ahora», y eso se puede probar sin navegador.

// El interruptor. Se guarda en el propio móvil: es una preferencia de quien
// conduce, no del taxista —el mismo taxista con dos teléfonos puede querer la
// voz en el del soporte y no en el del bolsillo—, y no tiene por qué viajar al
// servidor.
const CLAVE = 'guia-voz';

export function guiaEncendida(): boolean {
  try {
    return localStorage.getItem(CLAVE) === 'si';
  } catch {
    return false;
  }
}

export function alternarGuia(): boolean {
  const nueva = !guiaEncendida();
  try {
    localStorage.setItem(CLAVE, nueva ? 'si' : 'no');
  } catch {
    // En modo privado no se recuerda entre sesiones; dentro de esta, sí.
  }
  return nueva;
}

export interface Punto {
  lat: number;
  lng: number;
}

export type Giro = 'izquierda' | 'derecha' | 'llegada';

export interface Maniobra {
  // Dónde se gira.
  punto: Punto;
  giro: Giro;
  // Metros desde el principio de la ruta hasta ese punto. Sirve para medir
  // cuánto falta sin volver a recorrer la geometría entera.
  desdeElInicioM: number;
}

export interface Aviso {
  giro: Giro;
  // Redondeados a algo decible: 300, 200, 100, 50. «En ciento ochenta y tres
  // metros» no lo procesa nadie al volante.
  metros: number;
  // Identifica el aviso para no repetirlo: misma maniobra y mismo escalón.
  clave: string;
}

// Un giro por debajo de esto es la calle que hace una curva, no una maniobra.
// Medido sobre la cuadrícula de Malabo: los cruces dan 70-110°, y las curvas
// de la carretera del aeropuerto se quedan en 10-20° por vértice.
const GIRO_MINIMO_GRADOS = 35;

// Los escalones a los que se avisa, en metros. Dos por maniobra: uno con
// tiempo para cambiar de carril y otro justo encima. Tres serían tres veces la
// misma frase en quince segundos.
const ESCALONES_M = [200, 40];

// Distancia a la que se canta la llegada. Cincuenta metros es ver el portal.
const LLEGADA_M = 50;

const RADIO_TIERRA_M = 6_371_000;

export function metros(a: Punto, b: Punto): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_M * Math.asin(Math.sqrt(h));
}

function rumbo(a: Punto, b: Punto): number {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad)
    - Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

// Las maniobras de una ruta: los vértices donde de verdad se gira.
//
// La ruta viene del grafo con un vértice por cada nodo de calle, así que una
// avenida recta trae veinte vértices seguidos con un grado de diferencia. Para
// no convertir eso en veinte «siga recto», se compara el rumbo ANTES y DESPUÉS
// de cada vértice tomando unos metros a cada lado: lo que importa es el cambio
// de dirección del coche, no el de un segmento de ocho metros.
export function maniobrasDeLaRuta(ruta: Punto[]): Maniobra[] {
  if (ruta.length < 3) {
    return ruta.length >= 2
      ? [{ punto: ruta[ruta.length - 1], giro: 'llegada', desdeElInicioM: largoDeLaRuta(ruta) }]
      : [];
  }

  // Distancia acumulada hasta cada vértice.
  const acumulado: number[] = [0];
  for (let i = 1; i < ruta.length; i += 1) {
    acumulado.push(acumulado[i - 1] + metros(ruta[i - 1], ruta[i]));
  }

  const lista: Maniobra[] = [];
  // Ventana de veinte metros a cada lado del vértice para medir el rumbo.
  const VENTANA_M = 20;
  for (let i = 1; i < ruta.length - 1; i += 1) {
    const antes = retroceder(ruta, acumulado, i, VENTANA_M);
    const despues = avanzar(ruta, acumulado, i, VENTANA_M);
    if (antes === null || despues === null) continue;
    let diferencia = rumbo(ruta[i], despues) - rumbo(antes, ruta[i]);
    while (diferencia > 180) diferencia -= 360;
    while (diferencia < -180) diferencia += 360;
    if (Math.abs(diferencia) < GIRO_MINIMO_GRADOS) continue;

    const giro: Giro = diferencia > 0 ? 'derecha' : 'izquierda';
    // Dos vértices seguidos del mismo giro son UN cruce partido en dos, no dos
    // cruces: se queda el primero, que es donde empieza la maniobra.
    const ultima = lista[lista.length - 1];
    if (ultima && ultima.giro === giro && acumulado[i] - ultima.desdeElInicioM < 30) continue;
    lista.push({ punto: ruta[i], giro, desdeElInicioM: acumulado[i] });
  }

  lista.push({
    punto: ruta[ruta.length - 1],
    giro: 'llegada',
    desdeElInicioM: acumulado[acumulado.length - 1],
  });
  return lista;
}

function largoDeLaRuta(ruta: Punto[]): number {
  let total = 0;
  for (let i = 1; i < ruta.length; i += 1) total += metros(ruta[i - 1], ruta[i]);
  return total;
}

function retroceder(ruta: Punto[], acumulado: number[], i: number, distancia: number): Punto | null {
  for (let j = i - 1; j >= 0; j -= 1) {
    if (acumulado[i] - acumulado[j] >= distancia) return ruta[j];
  }
  return acumulado[i] > 3 ? ruta[0] : null;
}

function avanzar(ruta: Punto[], acumulado: number[], i: number, distancia: number): Punto | null {
  for (let j = i + 1; j < ruta.length; j += 1) {
    if (acumulado[j] - acumulado[i] >= distancia) return ruta[j];
  }
  const ultimo = ruta.length - 1;
  return acumulado[ultimo] - acumulado[i] > 3 ? ruta[ultimo] : null;
}

// Qué toca decir estando AQUÍ, o null si no toca nada.
//
// `dichas` son las claves ya pronunciadas. Se pasa desde fuera porque quien
// llama es quien sabe cuándo empieza una ruta nueva: al recalcularla, se
// vacía y se vuelve a avisar, que es lo correcto —la ruta cambió—.
export function proximoAviso(
  ruta: Punto[],
  donde: Punto,
  dichas: Set<string>,
): Aviso | null {
  const lista = maniobrasDeLaRuta(ruta);
  if (lista.length === 0) return null;

  // Cuánto se lleva andado: el vértice más cercano manda. Con el GPS saltando
  // de acera a acera esto es más estable que ir contando lo recorrido.
  let mejor = 0;
  let mejorDistancia = Number.POSITIVE_INFINITY;
  const acumulado: number[] = [0];
  for (let i = 1; i < ruta.length; i += 1) {
    acumulado.push(acumulado[i - 1] + metros(ruta[i - 1], ruta[i]));
  }
  for (let i = 0; i < ruta.length; i += 1) {
    const d = metros(donde, ruta[i]);
    if (d < mejorDistancia) { mejorDistancia = d; mejor = i; }
  }
  const andado = acumulado[mejor];

  for (const maniobra of lista) {
    // Cinco metros de margen: justo encima del cruce, el vértice más cercano
    // ya puede ser el siguiente y la maniobra quedaría «pasada» sin decirse.
    const falta = maniobra.desdeElInicioM - andado;
    if (falta < -5) continue;

    if (maniobra.giro === 'llegada') {
      if (falta > LLEGADA_M) return null;
      const clave = `llegada:${Math.round(maniobra.desdeElInicioM)}`;
      return dichas.has(clave) ? null : { giro: 'llegada', metros: 0, clave };
    }

    for (const escalon of ESCALONES_M) {
      if (falta > escalon) continue;
      const clave = `${Math.round(maniobra.desdeElInicioM)}:${escalon}`;
      // `continue` y no `break`: los escalones van de más lejos a más cerca, y
      // encima del cruce el de 200 ya está dicho pero el de 40 no. Con `break`
      // el segundo aviso —el que de verdad hace girar— no llegaba nunca.
      if (dichas.has(clave)) continue;
      return {
        giro: maniobra.giro,
        // En el escalón corto se dice el giro a secas, sin distancia.
        metros: escalon === ESCALONES_M[ESCALONES_M.length - 1] ? 0 : escalon,
        clave,
      };
    }
    return null;
  }
  return null;
}
