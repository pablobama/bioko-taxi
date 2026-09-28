// ¿Le conviene al taxi desviarse a por otro pasajero? (taxi compartido)
//
// La pregunta, dicha como se dice en la calle: llevo a alguien dentro y entra
// una petición. ¿La cojo? Hoy el reparto se la ofrece si le queda plaza y el
// destino cae por su zona, y nadie mide lo que le cuesta al que ya va dentro.
// Eso es P13-04: «sin límite de desvío».
//
// Aquí se mide. Y se mide comparando DOS PLANES completos:
//
//   Plan A: lo que le queda por hacer tal como está.
//   Plan B: lo mismo, con la recogida y el destino del nuevo metidos donde
//           mejor caigan.
//
// De la diferencia salen los tres números que importan, y ninguno más:
//
//   - RETRASO del que ya va dentro. Es el precio que paga alguien que no ha
//     pedido nada. Es el número que manda: un pasajero al que se le alarga el
//     viaje diez minutos por recoger a otro no vuelve a usar la aplicación, y
//     tiene razón.
//   - ESPERA del nuevo hasta que lo recojan. Si es peor que buscarle otro
//     taxi, el desvío no le sirve ni a él.
//   - METROS de más del taxista, que es su gasolina.
//
// LO QUE NO HACE: decidir por el taxista. Devuelve el veredicto y los números;
// quien llama decide si filtra la oferta, si se la enseña con el coste escrito
// o si deja que el taxista lo vea y elija. Un algoritmo que reparte trabajo sin
// enseñar sus cuentas es exactamente lo que hace que nadie se fíe del reparto.
//
// Sin base de datos ni HTTP a propósito: el medidor se inyecta, así que esto se
// prueba con un mapa de mentira y se ejecuta con el grafo de calles de verdad.

import { ordenarParadas, type ParadaPendiente, type Punto } from './paradas.js';

// Cuánto hay de un sitio a otro, en metros y en segundos. Dos números y no
// uno: por la avenida se hacen dos kilómetros en el tiempo que cuesta cruzar
// cuatro manzanas del centro, y el desvío se decide por tiempo.
export type MedidorViaje = (desde: Punto, hasta: Punto) => { metros: number; segundos: number };

export interface Limites {
  // Lo que como mucho se le puede alargar el viaje a quien ya va dentro.
  retrasoMaximoSeg: number;
  // Y lo mismo en proporción: cinco minutos sobre un viaje de cuarenta es
  // poco, y sobre uno de seis es doblarlo. Manda el que primero se pase.
  retrasoMaximoPorcentaje: number;
  // Lo que como mucho puede esperar el nuevo a que lo recojan. Más que esto y
  // le sirve más otro taxi, aunque al taxista le venga de paso.
  esperaMaximaNuevoSeg: number;
}

export interface Veredicto {
  conviene: boolean;
  // Por qué no, cuando no. Para poder decírselo a alguien y no solo apuntarlo.
  motivo: 'cabe' | 'retrasa_demasiado' | 'espera_demasiado' | 'sin_sitio';
  // Lo que se le alarga el viaje al pasajero que peor sale parado.
  retrasoMaximoSeg: number;
  // Segundos hasta que el nuevo estaría recogido.
  esperaNuevoSeg: number;
  // Metros de más que hace el taxi respecto a no coger la carrera.
  metrosExtra: number;
  // El orden de paradas del plan B, por si quien llama quiere enseñarlo.
  orden: ParadaPendiente[];
}

interface Recorrido {
  // Cuándo (segundos desde ahora) se llega a cada parada, por solicitud y tipo.
  llegadas: Map<string, number>;
  metros: number;
  segundos: number;
}

const clave = (p: ParadaPendiente) => `${p.solicitudId}:${p.tipo}`;

// Recorre las paradas EN EL ORDEN DADO y apunta cuándo se llega a cada una.
// Sin tiempos de parada —abrir la puerta, cobrar— a propósito: son los mismos
// en los dos planes menos uno, y meterlos aquí sería inventar precisión.
function recorrer(desde: Punto, orden: ParadaPendiente[], medir: MedidorViaje): Recorrido {
  const llegadas = new Map<string, number>();
  let metros = 0;
  let segundos = 0;
  let actual = desde;
  for (const parada of orden) {
    const tramo = medir(actual, parada);
    metros += tramo.metros;
    segundos += tramo.segundos;
    llegadas.set(clave(parada), segundos);
    actual = parada;
  }
  return { llegadas, metros, segundos };
}

export function evaluarDesvio(
  coche: Punto,
  // Lo que le queda por hacer ahora mismo.
  pendientes: ParadaPendiente[],
  // La carrera nueva: hay que ir a por él y luego dejarlo.
  nueva: { solicitudId: number; recogida: Punto & { nombre?: string }; destino: Punto & { nombre?: string } },
  medir: MedidorViaje,
  limites: Limites,
): Veredicto {
  const paradasNuevas: ParadaPendiente[] = [
    {
      solicitudId: nueva.solicitudId,
      tipo: 'recogida',
      lat: nueva.recogida.lat,
      lng: nueva.recogida.lng,
      nombre: nueva.recogida.nombre ?? 'recogida',
    },
    {
      solicitudId: nueva.solicitudId,
      tipo: 'destino',
      lat: nueva.destino.lat,
      lng: nueva.destino.lng,
      nombre: nueva.destino.nombre ?? 'destino',
    },
  ];

  const soloDistancia = (a: Punto, b: Punto) => medir(a, b).metros;
  const ordenA = ordenarParadas(coche, pendientes, soloDistancia);
  const ordenB = ordenarParadas(coche, [...pendientes, ...paradasNuevas], soloDistancia);

  const planA = recorrer(coche, ordenA, medir);
  const planB = recorrer(coche, ordenB, medir);

  // El retraso se mide SOLO sobre los destinos de quien ya estaba: son los
  // únicos que tenían una promesa que romper. La recogida de alguien a quien
  // todavía no han recogido también se retrasa, y también cuenta — está
  // esperando en la calle.
  let retrasoMaximoSeg = 0;
  for (const parada of pendientes) {
    const antes = planA.llegadas.get(clave(parada));
    const despues = planB.llegadas.get(clave(parada));
    if (antes === undefined || despues === undefined) continue;
    retrasoMaximoSeg = Math.max(retrasoMaximoSeg, despues - antes);
  }

  // Y en proporción a lo que le quedaba de viaje: el mismo retraso duele muy
  // distinto según lo cerca que estuviera de bajarse.
  let excedePorcentaje = false;
  for (const parada of pendientes) {
    const antes = planA.llegadas.get(clave(parada));
    const despues = planB.llegadas.get(clave(parada));
    if (antes === undefined || despues === undefined || antes <= 0) continue;
    if ((despues - antes) / antes > limites.retrasoMaximoPorcentaje) excedePorcentaje = true;
  }

  const esperaNuevoSeg = planB.llegadas.get(`${nueva.solicitudId}:recogida`) ?? Infinity;
  const metrosExtra = Math.max(0, planB.metros - planA.metros);

  if (retrasoMaximoSeg > limites.retrasoMaximoSeg || excedePorcentaje) {
    return {
      conviene: false,
      motivo: 'retrasa_demasiado',
      retrasoMaximoSeg,
      esperaNuevoSeg,
      metrosExtra,
      orden: ordenB,
    };
  }
  if (esperaNuevoSeg > limites.esperaMaximaNuevoSeg) {
    return {
      conviene: false,
      motivo: 'espera_demasiado',
      retrasoMaximoSeg,
      esperaNuevoSeg,
      metrosExtra,
      orden: ordenB,
    };
  }
  return {
    conviene: true,
    motivo: 'cabe',
    retrasoMaximoSeg,
    esperaNuevoSeg,
    metrosExtra,
    orden: ordenB,
  };
}
