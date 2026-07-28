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

// Ruta del coche: los destinos de los pasajeros comprometidos, en el orden en
// que subieron. Es lo que se muestra al cliente para que entienda el viaje
// compartido. Solo lugares: ni nombres ni teléfonos de los demás pasajeros.
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
): Promise<ParadaRuta[]> {
  const res = await cliente.query(
    `SELECT s.id, s.estado, rd.nombre AS destino, rd.lat, rd.lng
     FROM solicitud s
     JOIN referencia rd ON rd.id = s.referencia_destino_id
     WHERE s.conductor_id = $1 AND s.estado = ANY($2)
     ORDER BY s.id`,
    [conductorId, ESTADOS_QUE_OCUPAN_PLAZA],
  );
  return res.rows.map((f) => ({
    solicitudId: f.id,
    destino: f.destino,
    estado: f.estado,
    lat: f.lat,
    lng: f.lng,
  }));
}
