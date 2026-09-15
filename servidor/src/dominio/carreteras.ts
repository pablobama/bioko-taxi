// Las calles de Bioko, en el servidor (diagnóstico del 15/09).
//
// El recorrido se guarda como un punto cada ~60 s: unos 300 m de calle entre
// dos puntos. Unirlos con una recta corta las esquinas de la cuadrícula, y el
// diagnóstico contra una ruta verdadera por calles de Malabo lo midió:
// kilómetros un 30 % por debajo, velocidad en marcha la mitad de la real, y un
// cuarto del mapa de calor pintado atravesando manzanas.
//
// Aquí se reconstruye el camino por las calles entre cada dos puntos, con el
// MISMO plano y el MISMO grafo que usa la aplicación para dibujar rutas. No
// hay copia: si se recompila el plano, cambia para los dos a la vez.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cargarPlano, emparejar, type Emparejado } from '../../../pwa/src/rutas.js';

let cargado: boolean | null = null;

// Se carga la primera vez que hace falta, no al arrancar: son 500 KB de JSON
// y unos segundos de grafo que el latido y el reparto no necesitan nunca.
function asegurarPlano(): boolean {
  if (cargado !== null) return cargado;
  try {
    const ruta = fileURLToPath(new URL('../../../pwa/src/mapa-malabo.json', import.meta.url));
    cargarPlano(JSON.parse(readFileSync(ruta, 'utf8')));
    cargado = true;
  } catch (error) {
    // Sin plano el recorrido sigue funcionando con rectas, que es lo que había.
    // Se avisa una vez: es un fallo de despliegue, no algo que deba callarse.
    console.error('No se pudo cargar el plano de calles; el recorrido irá en línea recta:', error);
    cargado = false;
  }
  return cargado;
}

// Los puntos del recorrido no cambian una vez guardados, así que el camino
// entre dos de ellos tampoco. Sin esto, cambiar de «día» a «semana» en el panel
// del operador volvería a emparejar lo mismo miles de veces.
// 20.000 caminos son un mes y medio de un taxi. Medido: un mes entero (14.000
// saltos) se empareja en 1,3 s la primera vez y en milésimas después, y el
// proceso ronda los 170 MB con el grafo cargado. Más memoria no compensa en el
// plan gratuito, que tiene 512.
const MEMORIA_MAXIMA = 20_000;

// Cuánto más rápido que lo típico de sus calles se admite que fuera el coche.
// El doble: un taxi de noche por una residencial vacía va de sobra a 40 donde
// el plano supone 20. Más allá ya no es conducir rápido, es otro camino.
const FACTOR_TIEMPO = 2;
const memoria = new Map<string, Emparejado | null>();

// El camino por calles entre dos puntos seguidos del recorrido, o null si no
// hay uno CREÍBLE. Dos cosas lo hacen increíble, y en las dos manda la recta:
//   - No hay calle cerca: fuera del plano, o el GPS muy desviado.
//   - No da TIEMPO a recorrerlo. Si a la velocidad típica de esas calles se
//     tardaría el doble de lo que pasó entre los dos puntos, el coche no fue
//     por ahí: un punto cayó en la calzada de al lado y el sentido único obliga
//     a un rodeo que nunca existió.
//
// La regla es de tiempo y no de forma a propósito. La primera versión rechazaba
// todo camino de más de 2,5 veces la recta, y el diagnóstico la desmontó: en
// una cuadrícula con sentidos únicos, dar la vuelta a la manzana multiplica la
// recta por cuatro sin ninguna dificultad —724 m en 100 s son 26 km/h—, y cada
// rechazo caía a la recta con la mitad de los metros de verdad.
export function caminoPorCarretera(
  desde: { lat: number; lng: number },
  hasta: { lat: number; lng: number },
  rectaM: number,
  segundos: number,
  velocidadMaximaKmh: number,
): Emparejado | null {
  if (!asegurarPlano()) return null;
  const clave = `${desde.lat},${desde.lng}|${hasta.lat},${hasta.lng}|${Math.round(segundos)}`;
  let camino = memoria.get(clave);
  if (camino === undefined) {
    camino = emparejar(desde, hasta, {
      segundosMaximos: segundos > 0 ? segundos * FACTOR_TIEMPO : Infinity,
    });
    if (memoria.size >= MEMORIA_MAXIMA) memoria.delete(memoria.keys().next().value!);
    memoria.set(clave, camino);
  }
  if (camino === null) return null;
  // Sin tiempo entre los dos no hay con qué juzgar: basta con que no sea un
  // rodeo absurdo respecto a la recta.
  if (segundos <= 0) return camino.distanciaM <= rectaM + 100 ? camino : null;
  if (camino.segundosTipicos > segundos * FACTOR_TIEMPO) return null;
  if ((camino.distanciaM / segundos) * 3.6 > velocidadMaximaKmh) return null;
  return camino;
}
