// Viajes que se quedan colgados (migración 052).
//
// Un viaje en RECOGIDO no tenía ningún tope. Se cierra de tres maneras —el
// botón del taxista, el del pasajero, o la separación por GPS— y las tres
// pueden no ocurrir: el taxista se olvida, y el GPS del pasajero deja de
// mandar en cuanto bloquea la pantalla, con lo que la detección automática se
// queda sin una de las dos posiciones que necesita. Ahí se quedaba, para
// siempre.
//
// No es un detalle de contabilidad. Se vio en la calle: quien seguía el viaje
// por el enlace compartido veía a su familiar «viajando» horas después de
// haber llegado a su casa. Y por debajo pasan dos cosas más: el taxista se
// queda con una plaza ocupada que el reparto no le devuelve nunca, y las
// estadísticas cuentan un viaje abierto que ya terminó.
//
// Lo mismo con EN_CAMINO, aunque se note menos: si el taxista no recoge, no
// declara ausente al pasajero y no cancela, la solicitud se queda colgada
// igual y el pasajero espera un taxi que no va a venir.

import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import type { EmisorEventos } from './eventos.js';
import { leerParametroEntero } from './parametros.js';
import { transicionarConductor, transicionarSolicitud } from './transiciones.js';

export interface Caducados {
  completados: number;
  noPresentados: number;
}

// Última señal de vida de un viaje: la posición más reciente de cualquiera de
// los dos. Es la hora a la que el viaje terminó DE VERDAD, y no la de dentro
// de unas horas, cuando esta barrida se entere. Va a `ocurrio_en` (migración
// 051) para que las estadísticas y el tiempo de servicio no se inflen.
async function ultimaSenal(
  cliente: pg.ClientBase,
  viajeId: number | null,
): Promise<Date | null> {
  if (viajeId === null) return null;
  const res = await cliente.query(
    'SELECT max(creado_en) AS ultima FROM posicion WHERE viaje_id = $1',
    [viajeId],
  );
  const ultima = res.rows[0]?.ultima;
  return ultima === null || ultima === undefined ? null : new Date(ultima);
}

// Si el coche se queda sin pasajeros, vuelve a estar libre. Si le quedan
// otros, no hay nada que mover: con taxi compartido puede seguir ocupado.
async function liberarSiVacio(
  cliente: pg.ClientBase,
  conductorId: number | null,
  motivo: string,
): Promise<void> {
  if (conductorId === null) return;
  const quedan = await cliente.query(
    `SELECT 1 FROM solicitud
     WHERE conductor_id = $1 AND estado IN ('ACEPTADO', 'EN_CAMINO', 'RECOGIDO') LIMIT 1`,
    [conductorId],
  );
  if (quedan.rowCount !== 0) return;
  const presencia = await cliente.query(
    'SELECT estado FROM presencia WHERE conductor_id = $1 FOR UPDATE',
    [conductorId],
  );
  if (presencia.rows[0]?.estado === 'OCUPADO') {
    await transicionarConductor(cliente, conductorId, 'DISPONIBLE', 'sistema', motivo);
  }
}

export async function caducarViajesColgados(
  pool: pg.Pool,
  emisor: EmisorEventos,
  ahora: Date = new Date(),
): Promise<Caducados> {
  const horasViaje = await leerParametroEntero(pool, 'viaje_maximo_horas');
  const horasRecogida = await leerParametroEntero(pool, 'recogida_maxima_horas');

  // La antigüedad se mide desde que ENTRÓ en el estado, no desde que se pidió
  // el taxi: una solicitud que tardó media hora en encontrar coche no puede
  // empezar el reloj del viaje media hora antes de subirse nadie.
  const colgados = await pool.query(
    `SELECT s.id AS solicitud_id, s.estado, s.conductor_id, v.id AS viaje_id,
            t.desde
     FROM solicitud s
     LEFT JOIN viaje v ON v.solicitud_id = s.id
     JOIN LATERAL (
       SELECT max(COALESCE(ocurrio_en, creado_en)) AS desde
       FROM transicion
       WHERE solicitud_id = s.id AND estado_nuevo = s.estado
     ) t ON true
     WHERE s.estado IN ('EN_CAMINO', 'RECOGIDO')
       AND t.desde < $1::timestamptz - make_interval(hours => CASE
             WHEN s.estado = 'RECOGIDO' THEN $2::int ELSE $3::int END)
     ORDER BY s.id`,
    [ahora, horasViaje, horasRecogida],
  );

  const cuenta: Caducados = { completados: 0, noPresentados: 0 };

  for (const fila of colgados.rows) {
    // Cada uno aislado: uno con un estado raro no puede dejar colgados a los
    // demás, que es justo el problema que esto viene a resolver.
    try {
      await enTransaccion(pool, async (cliente) => {
        const actual = await cliente.query(
          'SELECT estado, conductor_id FROM solicitud WHERE id = $1 FOR UPDATE',
          [fila.solicitud_id],
        );
        const estado: string | undefined = actual.rows[0]?.estado;
        if (estado !== fila.estado) return; // alguien lo cerró entretanto

        const senal = await ultimaSenal(cliente, fila.viaje_id);

        if (estado === 'RECOGIDO') {
          // El pasajero subió: el viaje ocurrió y el taxista cobra su
          // comisión. Cerrarlo como incidencia sería castigar al taxista por
          // no haber pulsado un botón.
          await transicionarSolicitud(
            cliente, fila.solicitud_id, 'COMPLETADO', 'sistema', 'viaje_caducado',
          );
          await cliente.query(
            'UPDATE viaje SET completado_en = COALESCE($2, now()) WHERE id = $1',
            [fila.viaje_id, senal],
          );
          await liberarSiVacio(cliente, fila.conductor_id, 'viaje_caducado');
          await emisor.emitir({
            tipo: 'D3_viaje_cerrado_comision',
            rol: 'conductor',
            solicitudId: fila.solicitud_id,
            conductorId: fila.conductor_id,
            datos: { motivo: 'viaje_caducado' },
          }, cliente);
          cuenta.completados += 1;
          return;
        }

        // EN_CAMINO: nadie subió al coche. No hubo viaje, así que no hay
        // comisión que cobrar — por eso NO_PRESENTADO y no COMPLETADO.
        await transicionarSolicitud(
          cliente, fila.solicitud_id, 'NO_PRESENTADO', 'sistema', 'recogida_caducada',
        );
        await liberarSiVacio(cliente, fila.conductor_id, 'recogida_caducada');
        cuenta.noPresentados += 1;
      });
    } catch (error) {
      console.error(`Error caducando la solicitud ${fila.solicitud_id}:`, error);
    }
  }

  return cuenta;
}
