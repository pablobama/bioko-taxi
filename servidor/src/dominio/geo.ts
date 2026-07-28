// Utilidades geográficas mínimas. Sin librerías: una fórmula de haversine
// basta para distancias de metros a pocos kilómetros dentro de una ciudad.

const RADIO_TIERRA_M = 6_371_000;

export function distanciaMetros(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const aRadianes = Math.PI / 180;
  const dLat = (lat2 - lat1) * aRadianes;
  const dLng = (lng2 - lng1) * aRadianes;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * aRadianes) * Math.cos(lat2 * aRadianes) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * RADIO_TIERRA_M * Math.asin(Math.sqrt(a)));
}
