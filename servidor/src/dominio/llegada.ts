// Cuánto falta para llegar (migraciones 014, 052 y 053).
//
// Vivía en reputacion.ts, que no era su sitio: lo único que tenían en común
// era haber nacido en la misma migración.
//
// Sigue sin haber motor de rutas: es una línea recta corregida por un factor
// de desvío —las calles no son rectas— dividida por una velocidad. Lo que ha
// ido cambiando es la velocidad:
//
//   014: una sola, 18 km/h, la de Malabo.
//   052: dos, urbana y de carretera, porque 18 aplicado a Malabo–Luba daba
//        142 minutos para un trayecto de unos cuarenta.
//   053: la urbana ya no es una constante de tabla sino lo que el coche ha
//        andado DE VERDAD en los últimos minutos.

import type pg from 'pg';
import { distanciaMetros } from './geo.js';
import { leerParametroEntero } from './parametros.js';

export interface Estimacion {
  distanciaM: number;
  minutos: number;
  // A qué velocidad se ha contado el tramo urbano, y si salió de medir el
  // coche o de la tabla. Se expone para poder enseñarlo o depurarlo: un tiempo
  // de llegada que nadie sabe de dónde sale no se puede discutir cuando falla.
  velocidadUsadaKmh: number;
  medida: boolean;
}

// A qué velocidad va el coche, de su propio rastro de posiciones del viaje.
//
// Es distancia recorrida dividida por tiempo TRANSCURRIDO, no velocidad
// instantánea, y la diferencia es todo: la instantánea vale cero en cada
// semáforo y el tiempo de llegada saltaría a infinito cada dos manzanas.
// Dividiendo por el tiempo transcurrido, las paradas ya están dentro del
// número — que es exactamente lo que hay que predecir.
//
// Devuelve null cuando no hay con qué: pocas posiciones, poco rato, o el coche
// no se ha movido. Ahí manda la velocidad de la tabla, que es lo que había.
export async function velocidadRecienteKmh(
  cliente: pg.ClientBase | pg.Pool,
  viajeId: number,
  ahora: Date = new Date(),
): Promise<number | null> {
  const ventanaMin = await leerParametroEntero(cliente, 'eta_ventana_min');
  const minimoSeg = await leerParametroEntero(cliente, 'eta_muestra_minima_seg');
  const minimoM = await leerParametroEntero(cliente, 'eta_muestra_minima_m');
  const minimaKmh = await leerParametroEntero(cliente, 'eta_velocidad_minima_kmh');
  const maximaKmh = await leerParametroEntero(cliente, 'eta_velocidad_maxima_kmh');
  const ruidoM = await leerParametroEntero(cliente, 'rastro_ruido_m');
  const topeKmh = await leerParametroEntero(cliente, 'rastro_velocidad_maxima_kmh');

  const res = await cliente.query(
    `SELECT lat, lng, creado_en FROM posicion
     WHERE viaje_id = $1 AND actor = 'conductor'
       AND creado_en >= $2::timestamptz - make_interval(mins => $3::int)
     ORDER BY creado_en`,
    [viajeId, ahora, ventanaMin],
  );
  const puntos = res.rows.map((f: { lat: number; lng: number; creado_en: Date }) => ({
    lat: Number(f.lat), lng: Number(f.lng), en: new Date(f.creado_en).getTime(),
  }));
  if (puntos.length < 2) return null;

  const segundos = (puntos[puntos.length - 1].en - puntos[0].en) / 1000;
  if (segundos < minimoSeg) return null;

  // Contra un ANCLA y con suelo de ruido, igual que los kilómetros del
  // recorrido (migración 051): un coche parado tiembla quince o veinte metros
  // entre lecturas, y sumar ese temblor lo pondría a andar sin moverse.
  let metros = 0;
  let ancla = puntos[0];
  for (let i = 1; i < puntos.length; i += 1) {
    const punto = puntos[i];
    const salto = distanciaMetros(ancla.lat, ancla.lng, punto.lat, punto.lng);
    if (salto < ruidoM) continue;
    const hueco = (punto.en - ancla.en) / 1000;
    // Un salto imposible es una fijación disparada, no un coche. El ancla
    // avanza igual: dejarla atrás arrastraría el error el resto de la ventana.
    if (hueco > 0 && (salto / hueco) * 3.6 <= topeKmh) metros += salto;
    ancla = punto;
  }
  if (metros < minimoM) return null;

  const kmh = (metros / 1000) / (segundos / 3600);
  return Math.min(maximaKmh, Math.max(minimaKmh, kmh));
}

// Tiempo estimado hasta un punto.
//
// `velocidadMedidaKmh` sustituye a la velocidad urbana de la tabla, no a la de
// carretera. Es deliberado: si el taxi está parado en un semáforo de Malabo
// camino de Luba, su velocidad de este momento no dice nada de lo que va a
// tardar en la carretera, y usarla para los cincuenta kilómetros que faltan
// daría «llega en cuatro horas» por culpa de un semáforo. En un trayecto
// corto —el caso de cien veces al día— todo el recorrido es urbano, así que
// manda la medida de principio a fin, que es lo que se quería.
export async function estimarLlegada(
  cliente: pg.ClientBase | pg.Pool,
  desde: { lat: number; lng: number },
  hasta: { lat: number; lng: number },
  velocidadMedidaKmh: number | null = null,
): Promise<Estimacion> {
  const urbanaTabla = await leerParametroEntero(cliente, 'velocidad_urbana_kmh');
  const interurbanaKmh = await leerParametroEntero(cliente, 'velocidad_interurbana_kmh');
  const tramoUrbanoKm = await leerParametroEntero(cliente, 'eta_tramo_urbano_km');
  const factorDecimas = await leerParametroEntero(cliente, 'eta_factor_desvio');

  const urbanaKmh = velocidadMedidaKmh ?? urbanaTabla;

  const rectaM = distanciaMetros(desde.lat, desde.lng, hasta.lat, hasta.lng);
  const recorridoKm = (rectaM * (factorDecimas / 10)) / 1000;

  const enCiudadKm = Math.min(recorridoKm, tramoUrbanoKm);
  const enCarreteraKm = Math.max(0, recorridoKm - tramoUrbanoKm);
  const horas = enCiudadKm / urbanaKmh + enCarreteraKm / interurbanaKmh;

  return {
    distanciaM: Math.round(recorridoKm * 1000),
    minutos: Math.max(1, Math.round(horas * 60)),
    velocidadUsadaKmh: Math.round(urbanaKmh),
    medida: velocidadMedidaKmh !== null,
  };
}

// Atajo para el caso de siempre: medir el coche de ESTE viaje y estimar con
// ello. Quien no tenga viaje —no lo hay hasta que alguien acepta— llama a
// `estimarLlegada` a secas.
export async function llegadaDeViaje(
  cliente: pg.ClientBase | pg.Pool,
  viajeId: number,
  desde: { lat: number; lng: number },
  hasta: { lat: number; lng: number },
  ahora: Date = new Date(),
): Promise<Estimacion> {
  const medida = await velocidadRecienteKmh(cliente, viajeId, ahora);
  return estimarLlegada(cliente, desde, hasta, medida);
}
