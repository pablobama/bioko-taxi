// Distancia entre dos coordenadas.
//
// Estaba copiada en varios sitios de la aplicación. Es la misma cuenta siempre,
// así que vive aquí una sola vez.

const RADIO_M = 6_371_000;

export interface Coordenada {
  lat: number;
  lng: number;
}

// Metros en línea recta. Fórmula del semiverseno: exacta de sobra a escala de
// ciudad y sin depender de nada.
export function metrosEntre(a: Coordenada, b: Coordenada): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_M * Math.asin(Math.sqrt(h));
}

// Hacia dónde se fue, en grados desde el norte y en el sentido de las agujas
// del reloj: 0 norte, 90 este, 180 sur, 270 oeste. Es lo mismo que da el GPS
// en `coords.heading`, y sirve para cuando NO lo da —muchos Android baratos
// devuelven null— o para cuando lo da con el coche parado, que es cuando el
// valor es basura.
//
// A escala de ciudad no hace falta la fórmula del rumbo inicial sobre la
// esfera: basta con corregir la longitud por el coseno de la latitud, que en
// Malabo (3,75° N) es prácticamente 1.
export function rumboEntre(desde: Coordenada, hasta: Coordenada): number {
  const rad = Math.PI / 180;
  const norte = hasta.lat - desde.lat;
  const este = (hasta.lng - desde.lng) * Math.cos(desde.lat * rad);
  const grados = (Math.atan2(este, norte) * 180) / Math.PI;
  return (grados + 360) % 360;
}

// Ordena de más cerca a más lejos de un punto. Devuelve una copia: reordenar la
// lista original sorprendería a quien la pasó.
export function porCercaniaA<T extends Coordenada>(punto: Coordenada, lista: T[]): T[] {
  return [...lista].sort((a, b) => metrosEntre(punto, a) - metrosEntre(punto, b));
}

// Velocidad entre dos lecturas de GPS, en km/h. null cuando el número no
// significaría nada.
//
// Es el respaldo de `coords.speed`, que es lo bueno cuando lo hay —el chip del
// GPS la calcula por Doppler, sin comparar posiciones— pero que muchos Android
// baratos devuelven siempre null.
//
// Las dos guardas son el motivo de que esto sea una función y no dos líneas:
//
//   - Hueco mínimo. Entre dos fijaciones separadas un segundo, el temblor del
//     GPS con el coche PARADO son diez metros, y diez metros en un segundo son
//     treinta y seis por hora. El velocímetro marcaría eso en un semáforo.
//   - Tope. Un salto del GPS —un rebote entre edificios— da cientos de
//     kilómetros por hora. En Malabo no se pasa de sesenta ni bajando de
//     Basilé, así que por encima del tope la lectura se descarta en vez de
//     enseñar un número absurdo.
export function velocidadKmhEntre(
  desde: Coordenada & { en: number },
  hasta: Coordenada & { en: number },
  { huecoMinimoMs = 3000, topeKmh = 200 } = {},
): number | null {
  const ms = hasta.en - desde.en;
  if (ms < huecoMinimoMs) return null;
  const kmh = (metrosEntre(desde, hasta) / (ms / 1000)) * 3.6;
  return kmh > topeKmh ? null : Math.round(kmh);
}
