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

// Cerca del origen o del destino.
//
// Empezó en 200 m y se subió a 350 tras medir en producción (30/09): los fallos
// se agrupaban entre 300 y 800 metros, casi todos por el lado del destino, y no
// era mala suerte sino aritmética. El recorrido se guarda un punto cada 60
// segundos: a 40 km/h eso son hasta 660 metros entre dos puntos seguidos, así
// que exigir que ALGUNO caiga a menos de 200 m de un sitio concreto es exigir
// una precisión que el muestreo no puede dar.
//
// LO QUE CUESTA AFLOJARLO, dicho claro: el reloj puede arrancar hasta 350 m
// después de salir y pararse hasta 350 m antes de llegar, así que la duración
// medida sale CORTA. En ciudad son unos cuarenta segundos por punta. Por eso el
// informe enseña a cuántos metros se quedó de verdad en los viajes que sí
// acepta: si esa mediana sube, el número que se está midiendo se está
// ensuciando, y hay que verlo en vez de confiar.
export const METROS_CERCA = 350;

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
  // POR QUÉ no se pudo medir, que es lo que decide qué hay que arreglar.
  //
  // «El rastro no cubre el viaje» puede ser tres problemas muy distintos, y sin
  // estos dos números no se distinguen: si el coche pasó a 350 m del origen, el
  // listón de los 200 m está demasiado apretado; si nunca se acercó a menos de
  // tres kilómetros, o la referencia está mal situada o el recorrido no se
  // grabó. Lo mismo por el lado del destino.
  masCercaDelOrigenM: number | null;
  masCercaDelDestinoM: number | null;
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
      masCercaDelOrigenM: null,
      masCercaDelDestinoM: null,
    };
  }

  // Lo más que se acercó a cada punta, se acabe midiendo o no. Es el dato que
  // convierte un «no se pudo» en algo que se puede arreglar.
  let masCercaDelOrigenM = Infinity;
  let masCercaDelDestinoM = Infinity;
  for (const p of puntos) {
    masCercaDelOrigenM = Math.min(
      masCercaDelOrigenM, distanciaMetros(p.lat, p.lng, origen.lat, origen.lng),
    );
    masCercaDelDestinoM = Math.min(
      masCercaDelDestinoM, distanciaMetros(p.lat, p.lng, destino.lat, destino.lng),
    );
  }

  const cerca = (p: Punto, sitio: { lat: number; lng: number }) =>
    distanciaMetros(p.lat, p.lng, sitio.lat, sitio.lng) <= metrosCerca;

  // Primero se busca la LLEGADA y después la salida, y ese orden es el arreglo
  // de un fallo que se vio en producción (30/09).
  //
  // La primera versión hacía lo contrario: cogía la última vez junto al origen
  // y luego la primera vez junto al destino después de esa. Parece razonable
  // —un taxi da vueltas por la zona antes de que suba el pasajero— pero se
  // rompe con algo que los taxistas hacen todo el rato: VOLVER. La ventana mira
  // 45 minutos después del cierre, así que si el taxista regresa por el barrio
  // del origen al terminar, esa «última vez» se va al final del recorrido y ya
  // no queda ningún paso por el destino detrás. El viaje se descartaba por una
  // vuelta que ocurrió cuando ya había acabado.
  //
  // Se vio porque cuatro viajes de producción tenían las DOS puntas a menos de
  // cien metros del recorrido y aun así salían como «no se puede medir».
  //
  // Así que: la PRIMERA llegada al destino que tenga alguna salida por delante
  // —lo que haga el coche después de llegar ya no es este viaje— y, para esa
  // llegada, la ÚLTIMA vez junto al origen antes de ella.
  let llegada = -1;
  let vistoElOrigen = false;
  for (let i = 0; i < puntos.length; i += 1) {
    if (cerca(puntos[i], origen)) vistoElOrigen = true;
    if (vistoElOrigen && cerca(puntos[i], destino)) { llegada = i; break; }
  }
  let salida = -1;
  for (let i = 0; i < llegada; i += 1) {
    if (cerca(puntos[i], origen)) salida = i;
  }

  if (salida === -1 || llegada === -1) {
    return {
      calidad: 'parcial',
      minutos: null,
      minutosDeclarados,
      desfaseMin: null,
      puntosDeRastro: puntos.length,
      masCercaDelOrigenM: Math.round(masCercaDelOrigenM),
      masCercaDelDestinoM: Math.round(masCercaDelDestinoM),
    };
  }

  const minutos = (puntos[llegada].en.getTime() - puntos[salida].en.getTime()) / 60_000;
  return {
    calidad: 'buena',
    minutos,
    minutosDeclarados,
    desfaseMin: minutosDeclarados - minutos,
    puntosDeRastro: puntos.length,
    masCercaDelOrigenM: Math.round(masCercaDelOrigenM),
    masCercaDelDestinoM: Math.round(masCercaDelDestinoM),
  };
}
