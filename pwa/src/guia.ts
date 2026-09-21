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
// metros, gira a la derecha». Un nombre de calle mal dicho por una voz
// sintética es peor que no decirlo.
//
// Este fichero no habla ni sabe de React: convierte una ruta y una posición en
// «qué hay que decir ahora», y eso se puede probar sin navegador.
//
// LO QUE ENSEÑÓ EL DIAGNÓSTICO DEL 20/09 (scripts/diagnostico-guia.ts):
// conduciendo cuatro trayectos de Malabo, la primera versión soltaba 197
// frases para quince cruces. El mismo giro se anunciaba hasta doce veces, y
// siempre con la misma frase —«en doscientos metros»— cuando faltaban treinta.
//
// La causa era cómo se identificaba una maniobra: por su distancia desde el
// principio de la ruta. Y la ruta se REHACE desde el coche cada veinte metros,
// así que esa distancia cambiaba en cada recálculo, el aviso parecía nuevo y
// se repetía. Ahora una maniobra se identifica por DÓNDE ESTÁ —su cruce, que
// no se mueve—, y la distancia que se dice es la que de verdad falta.

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

export type Giro = 'izquierda' | 'derecha' | 'rotonda' | 'llegada';

// Lo que sabe rutas.ts —que es quien tiene el grafo— de cada rotonda por la
// que pasa una ruta. Se declara aquí para no darle la vuelta a la dependencia:
// este fichero no importa nada.
export interface PasoPorRotonda {
  salida: number;
  indiceSalida: number;
}

export interface Maniobra {
  // Dónde se gira. Es también su identidad: un cruce no se mueve, y la ruta
  // que lo contiene se recalcula treinta veces antes de llegar a él.
  punto: Punto;
  giro: Giro;
  // Solo en rotonda: por qué salida se sale, contando como cuenta quien
  // conduce.
  salida?: number;
  // Solo en rotonda: metros desde el principio de la ruta hasta el punto por
  // donde se DEJA el anillo. Una rotonda son dos avisos en dos sitios: uno
  // antes de entrar, para saber la salida, y otro ya dentro, justo antes de
  // la suya. `desdeElInicioM` es el primero y esto es el segundo.
  salidaEnM?: number;
  // Metros desde el principio de la ruta hasta ese punto.
  desdeElInicioM: number;
}

export interface Aviso {
  giro: Giro;
  salida?: number;
  // Los metros que DE VERDAD faltan, redondeados a algo decible. 0 significa
  // «ya, aquí»: en el último aviso la distancia sobra y estorba.
  metros: number;
  // Identifica el aviso para no repetirlo: sitio de la maniobra y escalón.
  clave: string;
}

// Un giro por debajo de esto es la calle que hace una curva, no una maniobra.
// Medido sobre la cuadrícula de Malabo: los cruces dan 70-110°, y las curvas
// de la carretera del aeropuerto se quedan en 10-20° por vértice.
const GIRO_MINIMO_GRADOS = 35;

// Los escalones a los que se avisa, en metros. Dos por maniobra: uno con
// tiempo para cambiar de carril y otro justo encima. Tres serían tres veces la
// misma frase en quince segundos.
// A 30 km/h, sesenta metros son siete segundos: da tiempo a oírlo y a poner
// el intermitente. Cuarenta —lo primero que probé— llegaba justo, y cuando el
// plano rehacía la ruta en ese tramo el aviso se perdía: el diagnóstico contó
// dos cruces con un solo aviso, el de lejos.
const ESCALONES_M = [200, 60];

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

// La identidad de una maniobra: su sitio, con cuatro decimales (~11 m). Dos
// recálculos de la misma ruta dan el mismo cruce y, por tanto, la misma clave;
// dos cruces distintos de Malabo nunca caen tan cerca.
function dondeEsta(punto: Punto): string {
  return `${punto.lat.toFixed(4)},${punto.lng.toFixed(4)}`;
}

function acumulados(ruta: Punto[]): number[] {
  const acumulado: number[] = [0];
  for (let i = 1; i < ruta.length; i += 1) {
    acumulado.push(acumulado[i - 1] + metros(ruta[i - 1], ruta[i]));
  }
  return acumulado;
}

// Las maniobras de una ruta: los vértices donde de verdad se gira.
//
// La ruta viene del grafo con un vértice por cada nodo de calle, así que una
// avenida recta trae veinte vértices seguidos con un grado de diferencia. Para
// no convertir eso en veinte «siga recto», se compara el rumbo ANTES y DESPUÉS
// de cada vértice tomando unos metros a cada lado: lo que importa es el cambio
// de dirección del coche, no el de un segmento de ocho metros.
//
// `rotondas` viene de `salidasDeRotonda` (rutas.ts, que es quien tiene el
// grafo): índice del punto donde se entra en el anillo → salida por la que hay
// que salir.
export function maniobrasDeLaRuta(
  ruta: Punto[],
  rotondas: Map<number, PasoPorRotonda> = new Map(),
): Maniobra[] {
  if (ruta.length < 3) {
    return ruta.length >= 2
      ? [{ punto: ruta[ruta.length - 1], giro: 'llegada', desdeElInicioM: largoDeLaRuta(ruta) }]
      : [];
  }

  const acumulado = acumulados(ruta);
  const lista: Maniobra[] = [];

  // Dentro de un anillo no se dan giros: se está girando todo el rato. Los
  // vértices del anillo se tapan para que la detección geométrica no suelte
  // cuatro «gira a la derecha» en una rotonda de cuatro salidas.
  const tapados = new Set<number>();
  for (const [entrada] of rotondas) {
    for (let j = entrada; j < ruta.length; j += 1) {
      tapados.add(j);
      // El anillo acaba donde empieza el siguiente tramo recto; como no se
      // sabe aquí, se tapa hasta el siguiente punto de entrada o hasta que la
      // distancia recorrida supere el largo de una rotonda grande (200 m).
      if (acumulado[j] - acumulado[entrada] > 200) break;
    }
  }

  // Ventana de veinte metros a cada lado del vértice para medir el rumbo.
  const VENTANA_M = 20;
  for (let i = 1; i < ruta.length - 1; i += 1) {
    const paso = rotondas.get(i);
    if (paso !== undefined) {
      lista.push({
        salidaEnM: acumulado[paso.indiceSalida] ?? acumulado[i],
        // El SITIO de la maniobra es la salida del anillo, no la entrada. Es lo
        // que la identifica entre un recálculo y otro: entrando en la rotonda,
        // la ruta se rehace desde dentro y el punto de entrada se mueve con el
        // coche —el diagnóstico lo vio anunciando la misma rotonda cuatro
        // veces, y con un número de salida distinto cada vez, porque desde
        // dentro ya quedaban menos—. La salida no se mueve.
        punto: ruta[paso.indiceSalida] ?? ruta[i],
        giro: 'rotonda',
        salida: paso.salida,
        // Pero se avisa contando desde donde se ENTRA: ahí es donde hay que
        // saberlo, no dentro.
        desdeElInicioM: acumulado[i],
      });
      continue;
    }
    if (tapados.has(i)) continue;
    // Nada de maniobras pegadas al principio de la ruta, y esta es la tercera
    // causa que encontró el diagnóstico —la que más ruido metía—.
    //
    // La ruta no empieza en el coche: empieza en el punto de la CALZADA más
    // cercano al coche, colgado a mitad de calle. Ese primer tramo va de lado,
    // perpendicular a la calle, así que entre él y el siguiente hay un ángulo
    // enorme: un «giro» que no existe. Y como el punto de enganche se mueve
    // con el coche, cada recálculo lo inventaba en un sitio distinto y sonaba
    // otra vez. En la carretera del aeropuerto, recta y sin un solo cruce, la
    // voz soltaba «en cincuenta metros, gira a la derecha» sin parar.
    if (acumulado[i] < 25) continue;

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
  // Sin veinte metros de calle por detrás no se puede medir hacia dónde se
  // venía, y el enganche a la calzada garantiza que los primeros metros mienten.
  // Antes se usaba el primer punto de la ruta y eso era justo el error.
  return null;
}

function avanzar(ruta: Punto[], acumulado: number[], i: number, distancia: number): Punto | null {
  for (let j = i + 1; j < ruta.length; j += 1) {
    if (acumulado[j] - acumulado[i] >= distancia) return ruta[j];
  }
  const ultimo = ruta.length - 1;
  return acumulado[ultimo] - acumulado[i] > 3 ? ruta[ultimo] : null;
}

// Cuánto se lleva andado de la ruta, proyectando la posición SOBRE ella.
//
// No vale quedarse con el vértice más cercano, que es lo que hacía la primera
// versión: entre dos vértices hay a veces cien metros de avenida, y con el GPS
// bailando cuatro metros el vértice «más cercano» salta adelante y atrás. El
// diagnóstico lo vio: avisos dichos con mil trescientos metros de diferencia.
//
// Y tampoco vale quedarse con el segmento más cercano de TODA la ruta, que fue
// el segundo intento. Una ruta de Malabo vuelve a pasar cerca de sí misma
// continuamente —la cuadrícula del centro, la vuelta a una manzana—, así que
// el segmento más cercano podía ser uno de dos kilómetros más adelante; la
// guía se creía allí y anunciaba giros de otro barrio. Salían 288 frases para
// quince cruces.
//
// Lo que sí vale: el PRIMER segmento en el que el coche cabe, recorriendo la
// ruta desde el principio. La ruta se rehace desde el coche cada veinte
// metros, así que el coche está siempre cerca de su comienzo; y ante dos
// tramos igual de cercanos, el de delante es el bueno, porque el de atrás ya
// se pasó.
// Margen con el que un tramo «empata» con el mejor. Cinco metros: menos que
// el error del GPS, así que dos tramos que empatan dentro de eso son
// indistinguibles y hay que elegir por otra cosa.
const EMPATE_M = 5;

function andadoDeLaRuta(ruta: Punto[], acumulado: number[], donde: Punto): number {
  const cosLat = Math.cos((donde.lat * Math.PI) / 180);
  // Distancia del coche a cada tramo, y cuánto se llevaría andado si fuera ese.
  const distancias: number[] = [];
  const andados: number[] = [];
  for (let i = 1; i < ruta.length; i += 1) {
    const a = ruta[i - 1];
    const b = ruta[i];
    // En metros planos: a la escala de una calle, la curvatura no cuenta.
    const bx = (b.lng - a.lng) * 111_320 * cosLat;
    const by = (b.lat - a.lat) * 111_320;
    const px = (donde.lng - a.lng) * 111_320 * cosLat;
    const py = (donde.lat - a.lat) * 111_320;
    const largo = bx * bx + by * by;
    const t = largo === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / largo));
    distancias.push(Math.hypot(px - t * bx, py - t * by));
    andados.push(acumulado[i - 1] + t * Math.sqrt(largo));
  }
  if (distancias.length === 0) return 0;

  // El mejor tramo, y de los que EMPATAN con él, el primero.
  //
  // Lo segundo importa tanto como lo primero. Una ruta de Malabo vuelve a
  // pasar cerca de sí misma continuamente —la cuadrícula del centro, la vuelta
  // a una manzana, el propio anillo de una rotonda al lado de la calle por la
  // que se llega—, así que sin desempatar por orden la guía se creía dos
  // kilómetros más adelante y anunciaba giros de otro barrio.
  let minimo = Number.POSITIVE_INFINITY;
  for (const d of distancias) minimo = Math.min(minimo, d);
  for (let i = 0; i < distancias.length; i += 1) {
    if (distancias[i] <= minimo + EMPATE_M) return andados[i];
  }
  return andados[0];
}

// Una distancia que se pueda decir y oír conduciendo. «En ciento ochenta y
// tres metros» no lo procesa nadie al volante.
function decible(m: number): number {
  if (m >= 250) return Math.round(m / 100) * 100;
  if (m >= 150) return 200;
  if (m >= 80) return 100;
  return 50;
}

// Qué toca decir estando AQUÍ, o null si no toca nada.
//
// `dichas` son las claves ya pronunciadas. Se pasa desde fuera porque quien
// llama es quien sabe cuándo empieza una ruta NUEVA —otro destino—, y entonces
// se vacía. Ojo: no se vacía al recalcular la misma ruta, que es lo que pasa
// cada veinte metros; si se vaciara, cada maniobra se volvería a anunciar
// entera y eso es justo lo que sonaba mal.
export function proximoAviso(
  ruta: Punto[],
  donde: Punto,
  dichas: Set<string>,
  rotondas: Map<number, PasoPorRotonda> = new Map(),
): Aviso | null {
  const lista = maniobrasDeLaRuta(ruta, rotondas);
  if (lista.length === 0) return null;

  const acumulado = acumulados(ruta);
  const andado = andadoDeLaRuta(ruta, acumulado, donde);

  for (const maniobra of lista) {
    // Una rotonda no se acaba al entrar: sigue siendo la maniobra en curso
    // hasta que se sale del anillo. Por eso, para saber si ya se pasó, se mira
    // su SALIDA y no su entrada.
    const finM = maniobra.giro === 'rotonda'
      ? maniobra.salidaEnM ?? maniobra.desdeElInicioM
      : maniobra.desdeElInicioM;
    // Cinco metros de margen: justo encima del cruce, la proyección ya puede
    // haberlo pasado y la maniobra quedaría sin decirse.
    const falta = maniobra.desdeElInicioM - andado;
    if (finM - andado < -5) continue;

    const sitio = dondeEsta(maniobra.punto);

    // Las rotondas llevan su propio par de avisos, en dos SITIOS distintos:
    //
    //   - Antes de entrar, con el número: «en doscientos metros, en la
    //     rotonda toma la salida 2». Es lo que hay que saber para elegir el
    //     carril.
    //   - Ya DENTRO, justo antes de la suya: «sal aquí». Es lo que pidió el
    //     taxista que lo probó, y tiene razón: dentro de un anillo se pierde
    //     la cuenta, y un aviso dado solo antes de entrar no sirve de nada
    //     treinta segundos después, dando vueltas.
    if (maniobra.giro === 'rotonda') {
      const claveEntrada = `${sitio}:rotonda-entrada`;
      if (falta > 0 && falta <= ESCALONES_M[0] && !dichas.has(claveEntrada)) {
        return {
          giro: 'rotonda', salida: maniobra.salida, metros: decible(falta), clave: claveEntrada,
        };
      }
      // Treinta metros antes de la salida: a la velocidad a la que se anda
      // dentro de una rotonda son unos cuatro segundos, el tiempo justo de
      // poner el intermitente y salir.
      const claveSalida = `${sitio}:rotonda-salida`;
      if (finM - andado <= 30 && !dichas.has(claveSalida)) {
        return { giro: 'rotonda', salida: maniobra.salida, metros: 0, clave: claveSalida };
      }
      return null;
    }

    if (maniobra.giro === 'llegada') {
      if (falta > LLEGADA_M) return null;
      const clave = `${sitio}:llegada`;
      return dichas.has(clave) ? null : { giro: 'llegada', metros: 0, clave };
    }

    for (const escalon of ESCALONES_M) {
      if (falta > escalon) continue;
      const clave = `${sitio}:${escalon}`;
      // `continue` y no `break`: los escalones van de más lejos a más cerca, y
      // encima del cruce el de 200 ya está dicho pero el de 40 no. Con `break`
      // el segundo aviso —el que de verdad hace girar— no llegaba nunca.
      if (dichas.has(clave)) continue;
      return {
        giro: maniobra.giro,
        salida: maniobra.salida,
        // En el escalón corto, el giro a secas. En el largo, lo que DE VERDAD
        // falta: si el aviso llega cuando quedan ciento treinta metros porque
        // el coche venía rápido, se dicen ciento, no doscientos.
        metros: escalon === ESCALONES_M[ESCALONES_M.length - 1] ? 0 : decible(falta),
        clave,
      };
    }
    return null;
  }
  return null;
}
