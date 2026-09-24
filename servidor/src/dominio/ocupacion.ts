// Ocupación del vehículo (taxi compartido, migración 013).
//
// Un conductor puede llevar varios pasajeros a la vez, cada uno con su propia
// solicitud y su propio viaje. Aquí vive la única pregunta nueva que se hace
// el sistema: ¿le queda plaza?
//
// Cuenta como plaza ocupada todo pasajero comprometido pero no terminado:
// ACEPTADO (voy a recogerlo), EN_CAMINO (voy de camino) y RECOGIDO (va
// dentro). Reservar la plaza desde ACEPTADO evita prometer el mismo asiento
// dos veces.

import type pg from 'pg';
import { ordenarParadas, distanciaRectaM, type ParadaPendiente } from './paradas.js';
import { rutaParaLlegar } from './carreteras.js';

export const ESTADOS_QUE_OCUPAN_PLAZA = ['ACEPTADO', 'EN_CAMINO', 'RECOGIDO'] as const;

export interface Ocupacion {
  plazas: number;
  ocupadas: number;
  libres: number;
  // Pasajeros ya dentro del coche (RECOGIDO). Es lo que ve el cliente.
  aBordo: number;
}

// Plazas del vehículo del conductor. Sin vehículo dado de alta se asume 1:
// prudente, nunca se ofrece más de lo que se sabe que cabe.
async function plazasDe(cliente: pg.ClientBase | pg.Pool, conductorId: number): Promise<number> {
  const res = await cliente.query(
    'SELECT plazas FROM vehiculo WHERE conductor_id = $1 ORDER BY id LIMIT 1',
    [conductorId],
  );
  return res.rowCount === 0 ? 1 : Number(res.rows[0].plazas);
}

export async function ocupacionDe(
  cliente: pg.ClientBase | pg.Pool,
  conductorId: number,
): Promise<Ocupacion> {
  const plazas = await plazasDe(cliente, conductorId);
  const res = await cliente.query(
    `SELECT count(*)::int AS ocupadas,
            count(*) FILTER (WHERE estado = 'RECOGIDO')::int AS a_bordo
     FROM solicitud
     WHERE conductor_id = $1 AND estado = ANY($2)`,
    [conductorId, ESTADOS_QUE_OCUPAN_PLAZA],
  );
  const ocupadas: number = res.rows[0].ocupadas;
  return {
    plazas,
    ocupadas,
    libres: Math.max(0, plazas - ocupadas),
    aBordo: res.rows[0].a_bordo,
  };
}

// Estado de presencia que le corresponde al conductor según su ocupación, para
// después de ganar una reclamación o de cerrar un viaje. Nunca devuelve
// OFERTADO ni DESCONECTADO: esos los deciden la oleada y el heartbeat.
export async function estadoPorOcupacion(
  cliente: pg.ClientBase,
  conductorId: number,
): Promise<'DISPONIBLE' | 'OCUPADO'> {
  const ocupacion = await ocupacionDe(cliente, conductorId);
  return ocupacion.libres > 0 ? 'DISPONIBLE' : 'OCUPADO';
}

// Ruta del coche: los destinos de los pasajeros comprometidos, EN EL ORDEN EN
// QUE SE VAN A BAJAR. Es lo que se muestra al cliente para que entienda el
// viaje compartido y sepa si es el primero o el último. Solo lugares: ni
// nombres ni teléfonos de los demás pasajeros.
//
// Hasta el 24/09 el orden era el de subida (`ORDER BY s.id`), que no es el
// orden en que pasan las cosas: el último en subir puede bajarse primero si su
// destino cae de camino. El pasajero leía una lista que no se correspondía con
// su viaje, y el taxista —que cogía de aquí su siguiente parada— cruzaba la
// ciudad pasando de largo por delante de la puerta de quien llevaba dentro.
export interface ParadaRuta {
  solicitudId: number;
  destino: string;
  estado: string;
  // Coordenadas de la parada, para poder dibujarla en el plano. No añaden
  // información sobre nadie: es el mismo sitio público cuyo nombre ya se ve.
  lat: number;
  lng: number;
}

export async function rutaDe(
  cliente: pg.ClientBase | pg.Pool,
  conductorId: number,
  // Dónde está el coche. Sin ella no hay desde dónde medir y se devuelve el
  // orden de subida, que es lo que había.
  coche: { lat: number; lng: number } | null = null,
): Promise<ParadaRuta[]> {
  const res = await cliente.query(
    `SELECT s.id, s.estado, rd.nombre AS destino, rd.lat, rd.lng
     FROM solicitud s
     JOIN referencia rd ON rd.id = s.referencia_destino_id
     WHERE s.conductor_id = $1 AND s.estado = ANY($2)
     ORDER BY s.id`,
    [conductorId, ESTADOS_QUE_OCUPAN_PLAZA],
  );
  const paradas: ParadaRuta[] = res.rows.map((f) => ({
    solicitudId: f.id,
    destino: f.destino,
    estado: f.estado,
    lat: Number(f.lat),
    lng: Number(f.lng),
  }));
  if (coche === null || paradas.length <= 1) return paradas;

  // Se ordenan los DESTINOS por cercanía desde el coche, midiendo por las
  // calles. A quien todavía no ha subido se le trata igual: su destino no
  // puede ir antes que su recogida, pero esa regla la aplica el taxista con
  // su propia lista (ver `ordenarPasajeros` en api/conductor.ts); aquí lo que
  // se enseña es el orden de bajada, que es la pregunta del pasajero.
  const porCalles = (desde: { lat: number; lng: number }, hasta: { lat: number; lng: number }) => {
    const camino = rutaParaLlegar(desde, hasta);
    const recta = distanciaRectaM(desde, hasta);
    return camino !== null && camino.distanciaM <= recta * 3 + 500 ? camino.distanciaM : recta;
  };
  const comoParadas: ParadaPendiente[] = paradas.map((p) => ({
    solicitudId: Number(p.solicitudId), tipo: 'destino', lat: p.lat, lng: p.lng, nombre: p.destino,
  }));
  const porSolicitud = new Map(paradas.map((p) => [Number(p.solicitudId), p]));
  return ordenarParadas(coche, comoParadas, porCalles)
    .map((p) => porSolicitud.get(p.solicitudId))
    .filter((p): p is ParadaRuta => p !== undefined);
}
