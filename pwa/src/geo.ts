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

// Ordena de más cerca a más lejos de un punto. Devuelve una copia: reordenar la
// lista original sorprendería a quien la pasó.
export function porCercaniaA<T extends Coordenada>(punto: Coordenada, lista: T[]): T[] {
  return [...lista].sort((a, b) => metrosEntre(punto, a) - metrosEntre(punto, b));
}
