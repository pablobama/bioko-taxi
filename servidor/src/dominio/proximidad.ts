// Validación por proximidad GPS (decisión de sesión, migración 011).
//
// Durante el viaje, conductor (app, cada ~30 s) y cliente (PWA, mientras la
// pantalla está encendida) envían su posición. Con posiciones frescas de
// AMBOS:
//   EN_CAMINO y distancia <= gps_umbral_recogida_m  → RECOGIDO (automático)
//   RECOGIDO  y distancia >= gps_umbral_separacion_m → COMPLETADO (automático)
//
// La confirmación manual del conductor sigue existiendo como respaldo: el
// GPS del cliente puede faltar (permiso denegado, pantalla apagada, chip
// perdido) y el sistema jamás depende de él.

import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import { ErrorEntidadInexistente } from './errores.js';
import type { EmisorEventos } from './eventos.js';
import { distanciaMetros } from './geo.js';
import { leerParametroEntero } from './parametros.js';
import { transicionarConductor, transicionarSolicitud } from './transiciones.js';

export type ActorPosicion = 'cliente' | 'conductor';

export async function registrarPosicion(
  cliente: pg.ClientBase,
  viajeId: number,
  actor: ActorPosicion,
  lat: number,
  lng: number,
  ahora: Date = new Date(),
  // Radio de error de esta lectura (migración 047). Opcional para no romper a
  // quien todavía no lo manda; sin él, las decisiones automáticas le suponen
  // el margen de `gps_precision_supuesta_m`.
  precisionM: number | null = null,
): Promise<void> {
  const res = await cliente.query(
    `INSERT INTO posicion (viaje_id, actor, lat, lng, creado_en, precision_m)
     SELECT $1, $2, $3, $4, $5, $6 WHERE EXISTS (SELECT 1 FROM viaje WHERE id = $1)`,
    [viajeId, actor, lat, lng, ahora, precisionM],
  );
  if (res.rowCount === 0) {
    throw new ErrorEntidadInexistente('el viaje', viajeId);
  }
}

interface PosicionFresca { lat: number; lng: number; precisionM: number | null }

interface UltimasPosiciones {
  cliente?: PosicionFresca;
  conductor?: PosicionFresca;
}

async function ultimasPosicionesFrescas(
  cliente: pg.ClientBase,
  viajeId: number,
  frescuraSeg: number,
  ahora: Date,
): Promise<UltimasPosiciones> {
  const res = await cliente.query(
    `SELECT DISTINCT ON (actor) actor, lat, lng, precision_m
     FROM posicion
     WHERE viaje_id = $1
       AND creado_en >= $2::timestamptz - make_interval(secs => $3)
     ORDER BY actor, creado_en DESC`,
    [viajeId, ahora, frescuraSeg],
  );
  const resultado: UltimasPosiciones = {};
  for (const fila of res.rows) {
    resultado[fila.actor as ActorPosicion] = {
      lat: fila.lat,
      lng: fila.lng,
      precisionM: fila.precision_m === null ? null : Number(fila.precision_m),
    };
  }
  return resultado;
}

// Tique del planificador: revisa los viajes activos y aplica la detección.
// Idempotente; con posiciones ausentes o rancias no hace nada.
export async function procesarProximidad(
  pool: pg.Pool,
  emisor: EmisorEventos,
  ahora: Date = new Date(),
): Promise<void> {
  const activos = await pool.query(
    `SELECT s.id AS solicitud_id, v.id AS viaje_id
     FROM solicitud s JOIN viaje v ON v.solicitud_id = s.id
     WHERE s.estado IN ('EN_CAMINO', 'RECOGIDO')
     ORDER BY s.id`,
  );

  for (const activo of activos.rows) {
    // Cada viaje se procesa aislado: un fallo en uno (estado inesperado, dato
    // corrupto) no puede dejar sin detección a los demás.
    try {
      await procesarViaje(pool, emisor, activo.solicitud_id, activo.viaje_id, ahora);
    } catch (error) {
      console.error(
        `Error procesando la proximidad de la solicitud ${activo.solicitud_id}:`,
        error,
      );
    }
  }
}

// ¿Hay algún OTRO pasajero aún sin recoger de este mismo conductor cuya última
// posición fresca también caiga dentro del umbral? Si lo hay, la señal es
// ambigua: el coche está cerca de dos personas y no sabemos a quién ha subido.
async function hayOtroPasajeroPendienteCerca(
  cliente: pg.ClientBase,
  conductorId: number,
  viajeIdActual: number,
  posicionConductor: { lat: number; lng: number },
  umbralM: number,
  frescuraSeg: number,
  ahora: Date,
): Promise<boolean> {
  const otros = await cliente.query(
    `SELECT DISTINCT ON (p.viaje_id) p.viaje_id, p.lat, p.lng
     FROM posicion p
     JOIN viaje v ON v.id = p.viaje_id
     JOIN solicitud s ON s.id = v.solicitud_id
     WHERE s.conductor_id = $1
       AND s.estado = 'EN_CAMINO'
       AND p.viaje_id <> $2
       AND p.actor = 'cliente'
       AND p.creado_en >= $3::timestamptz - make_interval(secs => $4)
     ORDER BY p.viaje_id, p.creado_en DESC`,
    [conductorId, viajeIdActual, ahora, frescuraSeg],
  );
  return otros.rows.some((otro) => distanciaMetros(
    posicionConductor.lat, posicionConductor.lng, otro.lat, otro.lng,
  ) <= umbralM);
}

async function procesarViaje(
  pool: pg.Pool,
  emisor: EmisorEventos,
  solicitudId: number,
  viajeId: number,
  ahora: Date,
): Promise<void> {
  const activo = { solicitud_id: solicitudId, viaje_id: viajeId };
  await enTransaccion(pool, async (cliente) => {
      const fila = await cliente.query(
        'SELECT estado, conductor_id, dispositivo_cliente_id FROM solicitud WHERE id = $1 FOR UPDATE',
        [activo.solicitud_id],
      );
      const estado: string = fila.rows[0].estado;
      if (estado !== 'EN_CAMINO' && estado !== 'RECOGIDO') {
        return; // alguien lo movió entre la lista y el bloqueo
      }

      const frescuraSeg = await leerParametroEntero(cliente, 'gps_frescura_seg');
      const posiciones = await ultimasPosicionesFrescas(
        cliente, activo.viaje_id, frescuraSeg, ahora,
      );
      if (!posiciones.cliente || !posiciones.conductor) {
        return; // sin las dos posiciones frescas no se decide nada
      }
      const distancia = distanciaMetros(
        posiciones.conductor.lat, posiciones.conductor.lng,
        posiciones.cliente.lat, posiciones.cliente.lng,
      );

      // Margen de error de las dos medidas juntas (migración 047). Sin esto se
      // comparaban dos PUNTOS, y un punto con ±400 m no es un punto: hoy en
      // producción hubo viajes cerrándose solos porque una lectura mala del
      // GPS «alejó» al pasajero del coche en el que iba sentado.
      const supuesta = await leerParametroEntero(cliente, 'gps_precision_supuesta_m');
      const maximaDecision = await leerParametroEntero(cliente, 'gps_precision_maxima_decision_m');
      // Una precisión desconocida se trata distinto según lo que esté en juego,
      // y la asimetría es deliberada:
      //
      //   - Para CERRAR un viaje cuenta como `gps_precision_supuesta_m`. Cerrar
      //     de más es el daño que se vio hoy en producción: el pasajero sigue
      //     dentro del coche y el servicio ya consta como terminado. Ante la
      //     duda, no se cierra.
      //   - Para RECOGER cuenta como cero, es decir, no estorba. Recoger de más
      //     lo arregla el taxista con un botón —la confirmación manual es el
      //     camino de todos los días—, mientras que exigir margen aquí rompería
      //     la recogida automática para todo cliente que aún no mande el dato:
      //     dos posiciones sin precisión sumarían 120 m de margen contra un
      //     umbral de 75, y no se recogería a nadie jamás.
      const errorCierre = (posiciones.cliente.precisionM ?? supuesta)
        + (posiciones.conductor.precisionM ?? supuesta);
      const errorRecogida = (posiciones.cliente.precisionM ?? 0)
        + (posiciones.conductor.precisionM ?? 0);

      // Una lectura demasiado mala no decide nada por sí sola. Se sigue
      // pintando en el mapa —algo es mejor que nada para orientarse— pero no
      // mueve el estado de un viaje, que es dinero y es la palabra de dos
      // personas.
      // Esto sí vale para las dos: una lectura que se sabe malísima no decide
      // nada en ninguna dirección.
      const peor = Math.max(
        posiciones.cliente.precisionM ?? 0, posiciones.conductor.precisionM ?? 0,
      );
      if (peor > maximaDecision) return;

      if (estado === 'EN_CAMINO') {
        const umbral = await leerParametroEntero(cliente, 'gps_umbral_recogida_m');
        // Con el margen SUMADO: solo se da por recogido si están cerca aunque
        // las dos medidas fallen en su contra. Al revés marcaría como recogido
        // a quien sigue esperando en la acera.
        if (distancia + errorRecogida <= umbral) {
          // Taxi compartido: con varios pasajeros pendientes cerca del coche,
          // la proximidad no identifica a NINGUNO en concreto. Si hay
          // ambigüedad no se marca a nadie y decide el botón del conductor.
          if (await hayOtroPasajeroPendienteCerca(
            cliente, fila.rows[0].conductor_id, activo.viaje_id,
            posiciones.conductor, umbral, frescuraSeg, ahora,
          )) {
            return;
          }
          await transicionarSolicitud(
            cliente, activo.solicitud_id, 'RECOGIDO', 'sistema', 'proximidad_gps',
          );
          await cliente.query(
            `UPDATE viaje SET validado_en = now(),
                              lat_validacion = $2, lng_validacion = $3, distancia_validacion_m = $4
             WHERE id = $1`,
            [activo.viaje_id, posiciones.conductor.lat, posiciones.conductor.lng, distancia],
          );
        }
        return;
      }

      // RECOGIDO: la separación tras la recogida cierra el servicio.
      const umbralSeparacion = await leerParametroEntero(cliente, 'gps_umbral_separacion_m');
      // Con el margen RESTADO: solo se cierra el viaje si la separación es real
      // más allá del error de las dos medidas. Es la mitad que faltaba.
      if (distancia - errorCierre >= umbralSeparacion) {
        await transicionarSolicitud(
          cliente, activo.solicitud_id, 'COMPLETADO', 'sistema', 'separacion_gps',
        );
        await cliente.query(
          'UPDATE viaje SET completado_en = now() WHERE id = $1',
          [activo.viaje_id],
        );
        // Se libera una plaza. Si el coche estaba lleno vuelve a DISPONIBLE;
        // si ya lo estaba (llevaba a otros con hueco) no hay nada que mover.
        const presencia = await cliente.query(
          'SELECT estado FROM presencia WHERE conductor_id = $1 FOR UPDATE',
          [fila.rows[0].conductor_id],
        );
        if (presencia.rows[0]?.estado === 'OCUPADO') {
          await transicionarConductor(
            cliente, fila.rows[0].conductor_id, 'DISPONIBLE', 'sistema', 'separacion_gps',
          );
        }
        await emisor.emitir({
          tipo: 'D3_viaje_cerrado_comision',
          rol: 'conductor',
          solicitudId: activo.solicitud_id,
          conductorId: fila.rows[0].conductor_id,
          datos: { motivo: 'separacion_gps' },
        }, cliente);
      }
    });
}
