// Dónde recoger al pasajero (migración 046).
//
// Durante meses el punto de recogida fue la `referencia` del catálogo más
// cercana al pasajero, y solo eso. La coordenada real llegaba en la solicitud,
// se guardaba en `lat_cliente`/`lng_cliente` desde la migración 010, y no la
// leía nadie. Resultado: el taxi iba al supermercado de al lado, a una mediana
// de 78 m de la persona en la parte mejor cubierta de la ciudad y a cientos de
// metros en el resto.
//
// Esto elige entre las dos, y dice cuál eligió.

export interface Recogida {
  lat: number;
  lng: number;
  // De dónde sale el punto. Se expone a propósito: la app del taxista dice
  // «a 40 m de la Farmacia Nueva» cuando es 'gps', y solo el nombre del sitio
  // cuando es 'referencia'. Enseñar un pin en el sitio equivocado sin avisar
  // es peor que enseñar el sitio conocido y que el taxista pregunte.
  origen: 'gps' | 'referencia';
  // Metros entre la posición real y la referencia. null cuando no hay GPS.
  metrosDeLaReferencia: number | null;
}

export interface DatosRecogida {
  referenciaLat: number;
  referenciaLng: number;
  latCliente: number | null;
  lngCliente: number | null;
  precisionClienteM: number | null;
}

function metrosEntre(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function puntoDeRecogida(
  datos: DatosRecogida,
  precisionMaximaM: number,
): Recogida {
  const { referenciaLat, referenciaLng, latCliente, lngCliente, precisionClienteM } = datos;
  const enReferencia: Recogida = {
    lat: referenciaLat, lng: referenciaLng, origen: 'referencia', metrosDeLaReferencia: null,
  };

  // Sin GPS: el catálogo es lo único que hay. Pasa de verdad —permiso
  // denegado, teléfono sin GPS, bajo techo— y no es un error.
  if (latCliente === null || lngCliente === null) return enReferencia;

  const metros = metrosEntre(latCliente, lngCliente, referenciaLat, referenciaLng);

  // Precisión desconocida: son las solicitudes anteriores a la migración 046,
  // tomadas con el GPS flojo de entonces. No se puede saber si esa coordenada
  // vale, así que no se usa. NULL es «no se sabe», no «es buena».
  if (precisionClienteM === null) return { ...enReferencia, metrosDeLaReferencia: metros };

  // Y si el error es mayor que el umbral, la posición dice menos que el
  // catálogo: un punto con ±800 m no es un punto, es un barrio.
  if (precisionClienteM > precisionMaximaM) {
    return { ...enReferencia, metrosDeLaReferencia: metros };
  }

  return { lat: latCliente, lng: lngCliente, origen: 'gps', metrosDeLaReferencia: metros };
}
