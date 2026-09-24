// En qué orden le tocan al taxista sus paradas (taxi compartido).
//
// EL FALLO QUE ARREGLA (24/09, lo vio quien conduce): el orden era el de
// subida. `rutaDe` ordenaba por `solicitud.id`, y la pantalla del taxista
// cogía «el primer pendiente» de esa misma lista. Así que si el último en
// subir se bajaba a doscientos metros y el primero al otro lado de Malabo, la
// guía llevaba al taxista al otro lado de Malabo con el otro pasajero dentro,
// pasando de largo por delante de su puerta.
//
// Lo que hace un taxista de verdad es lo de siempre: de todo lo que le queda
// por hacer, lo siguiente es lo que tiene más a mano. Eso es esto.
//
// Dos reglas y ninguna más:
//
//   1. A nadie se le puede dejar antes de subirlo. La recogida de un pasajero
//      va siempre delante de su destino, aunque su destino esté más cerca.
//   2. Entre lo que queda permitido, la parada más cercana POR LAS CALLES; y
//      desde ella, otra vez la más cercana. Es un voraz, no el óptimo: el
//      óptimo de verdad (el viajante) con cuatro plazas son 40.320 órdenes
//      posibles, y cada una pide medir caminos por el grafo. El voraz acierta
//      en lo que importa —no cruzar la ciudad con alguien dentro que se baja
//      al lado— y se calcula en cuatro medidas.
//
// Sin dependencias de base de datos ni de HTTP a propósito: así se puede
// probar el orden con un mapa de mentira y sin levantar nada.

export interface ParadaPendiente {
  solicitudId: number;
  // 'recogida': hay que ir a por esa persona. 'destino': va dentro y se baja.
  tipo: 'recogida' | 'destino';
  lat: number;
  lng: number;
  // El nombre del sitio, para poder enseñarlo tal cual.
  nombre: string;
}

export interface Punto {
  lat: number;
  lng: number;
}

const RADIO_TIERRA_M = 6_371_000;

export function distanciaRectaM(a: Punto, b: Punto): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * RADIO_TIERRA_M * Math.asin(Math.sqrt(h));
}

// Cuánto hay de un sitio a otro. Se inyecta para que quien llame decida si
// mide por las calles (el grafo) o en línea recta, y para poder probar esto
// con distancias de mentira.
export type Medidor = (desde: Punto, hasta: Punto) => number;

// Las paradas que le quedan, en el orden en que le conviene hacerlas.
//
// `desde` es dónde está el coche. Si no se sabe —no ha mandado posición
// todavía— se devuelve el orden recibido: sin saber de dónde parte no hay
// nada que ordenar, y reordenar por azar sería peor que no tocar nada.
export function ordenarParadas(
  desde: Punto | null,
  paradas: ParadaPendiente[],
  medir: Medidor = distanciaRectaM,
): ParadaPendiente[] {
  if (desde === null || paradas.length <= 1) return [...paradas];

  const quedan = [...paradas];
  const ordenadas: ParadaPendiente[] = [];
  // De quién falta todavía la recogida: su destino no puede ir antes.
  const sinRecoger = new Set(
    quedan.filter((p) => p.tipo === 'recogida').map((p) => p.solicitudId),
  );
  let coche = desde;

  while (quedan.length > 0) {
    let mejor = -1;
    let mejorDistancia = Number.POSITIVE_INFINITY;
    for (let i = 0; i < quedan.length; i += 1) {
      const p = quedan[i];
      // Regla 1: su destino espera a que suba.
      if (p.tipo === 'destino' && sinRecoger.has(p.solicitudId)) continue;
      const d = medir(coche, p);
      if (d < mejorDistancia) {
        mejorDistancia = d;
        mejor = i;
      }
    }
    // Todo lo que queda está bloqueado por su propia recogida: no puede pasar
    // —una recogida nunca se bloquea— pero si pasara, se sigue el orden dado
    // en lugar de quedarse en un bucle infinito.
    if (mejor < 0) {
      ordenadas.push(...quedan);
      break;
    }
    const elegida = quedan.splice(mejor, 1)[0];
    if (elegida.tipo === 'recogida') sinRecoger.delete(elegida.solicitudId);
    ordenadas.push(elegida);
    coche = elegida;
  }
  return ordenadas;
}
