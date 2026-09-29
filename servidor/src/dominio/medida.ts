// Cuánto duró un viaje DE VERDAD, sin preguntarle a ningún botón (29/09).
//
// POR QUÉ. Hasta ahora la duración era la que va de RECOGIDO a COMPLETADO, y
// esos dos sellos los pone alguien pulsando. Medido contra producción, eso está
// mal en uno de cada cuatro viajes: trayectos de 6 km cerrados en 30 segundos,
// de 49 km en 6 segundos, y uno cerrado 168 minutos después. Y hay un motivo de
// fondo que no se va a arreglar pidiendo cuidado: buena parte de esos viajes se
// generaron pulsando botones a propósito, para medir recorridos. Un sello que
// se pulsa para producir un dato no puede ser la fuente de ese dato.
//
// LA IDEA. Un botón es lo que alguien DECLARA; el rastro es lo que el coche
// HIZO. Dentro de la ventana del viaje se busca en el rastro la última vez que
// el coche estuvo junto al origen y la primera vez, después de esa, que estuvo
// junto al destino. Ese intervalo es el viaje, lo pulsara quien lo pulsara y
// cuando lo pulsara.
//
// LO QUE NO HACE, y es a propósito: cuando el rastro no da para saberlo, NO
// devuelve un número. Dice que no se puede medir. Media plataforma de
// estadísticas construida sobre duraciones inventadas es peor que media
// plataforma que reconoce lo que no sabe: el diagnóstico del tiempo hasta
// destino ya se fue una vez a +8 minutos de error por tres filas imposibles.

import type pg from 'pg';
import { distanciaMetros } from './geo.js';

type Lector = pg.Pool | pg.ClientBase;

// Cerca del origen o del destino. Doscientos metros es una manzana larga: lo
// bastante para no exigirle al GPS una precisión que no tiene, y lo bastante
// poco para no confundir «pasó por la calle de al lado» con «estuvo allí».
export const METROS_CERCA = 200;

// Cuánto se mira antes de que conste la recogida y después del cierre. Los dos
// sellos pueden llegar tarde o pronto —eso es justo lo que se está esquivando—
// así que la ventana se abre generosa por los dos lados.
export const MARGEN_MIN = 45;

export type Calidad =
  // Se vio salir del origen y llegar al destino: la duración es de fiar.
  | 'buena'
  // Hay rastro, pero no cuenta el viaje entero (falta el principio o el final).
  | 'parcial'
  // No hay rastro en la ventana del viaje: no se puede decir nada.
  | 'sin_rastro';

export interface Medida {
  calidad: Calidad;
  // Minutos entre salir del origen y llegar al destino. `null` si no se sabe.
  minutos: number | null;
  // Lo que dicen los botones, para poder comparar una cosa con la otra.
  minutosDeclarados: number;
  // La diferencia entre lo declarado y lo real, que es la medida del problema.
  desfaseMin: number | null;
  puntosDeRastro: number;
}

interface Punto { lat: number; lng: number; en: Date }

// La duración real de un viaje ya terminado.
//
// `declarado` son los dos sellos de los botones: se usan solo para centrar la
// ventana de búsqueda, nunca para el resultado.
export async function medirViaje(
  cliente: Lector,
  {
    conductorId, origen, destino, recogidoEn, completadoEn,
  }: {
    conductorId: number;
    origen: { lat: number; lng: number };
    destino: { lat: number; lng: number };
    recogidoEn: Date;
    completadoEn: Date;
  },
  { metrosCerca = METROS_CERCA, margenMin = MARGEN_MIN } = {},
): Promise<Medida> {
  const minutosDeclarados = (completadoEn.getTime() - recogidoEn.getTime()) / 60_000;

  const res = await cliente.query(
    `SELECT lat, lng, creado_en FROM rastro
     WHERE conductor_id = $1
       AND creado_en >= $2::timestamptz - make_interval(mins => $4)
       AND creado_en <= $3::timestamptz + make_interval(mins => $4)
     ORDER BY creado_en`,
    [conductorId, recogidoEn, completadoEn, margenMin],
  );
  const puntos: Punto[] = res.rows.map((f) => ({
    lat: Number(f.lat), lng: Number(f.lng), en: new Date(f.creado_en),
  }));

  if (puntos.length < 2) {
    return {
      calidad: 'sin_rastro',
      minutos: null,
      minutosDeclarados,
      desfaseMin: null,
      puntosDeRastro: puntos.length,
    };
  }

  const cerca = (p: Punto, sitio: { lat: number; lng: number }) =>
    distanciaMetros(p.lat, p.lng, sitio.lat, sitio.lng) <= metrosCerca;

  // La ÚLTIMA vez junto al origen, no la primera: un taxi puede dar vueltas por
  // la zona antes de que suba el pasajero, y lo que cuenta es cuándo se fue de
  // allí. Y a partir de ahí, la PRIMERA vez junto al destino, porque lo que
  // haga después ya no es este viaje.
  let salida = -1;
  for (let i = 0; i < puntos.length; i += 1) {
    if (cerca(puntos[i], origen)) salida = i;
  }
  let llegada = -1;
  for (let i = salida + 1; i < puntos.length; i += 1) {
    if (cerca(puntos[i], destino)) { llegada = i; break; }
  }

  if (salida === -1 || llegada === -1) {
    return {
      calidad: 'parcial',
      minutos: null,
      minutosDeclarados,
      desfaseMin: null,
      puntosDeRastro: puntos.length,
    };
  }

  const minutos = (puntos[llegada].en.getTime() - puntos[salida].en.getTime()) / 60_000;
  return {
    calidad: 'buena',
    minutos,
    minutosDeclarados,
    desfaseMin: minutosDeclarados - minutos,
    puntosDeRastro: puntos.length,
  };
}
