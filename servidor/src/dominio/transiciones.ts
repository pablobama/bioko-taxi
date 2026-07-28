// Núcleo de la máquina de estados (paso 2).
//
// Reglas:
// - La validez de una transición la decide la tabla transicion_valida
//   (sección 5.2), nunca una cadena de if. Lo que no está en la tabla se
//   rechaza con ErrorTransicionInvalida.
// - Todo cambio de estado deja una fila en el log append-only transicion
//   (regla 4.2.3). El estado en solicitud/presencia es una proyección.
// - Estas funciones reciben un cliente ya dentro de una transacción
//   (enTransaccion); no abren transacciones propias.

import type pg from 'pg';
import { ErrorEntidadInexistente, ErrorTransicionInvalida } from './errores.js';

export type Actor = 'cliente' | 'conductor' | 'sistema' | 'operador';
type Ambito = 'solicitud' | 'conductor';

export interface ResultadoTransicion {
  estadoAnterior: string;
  estadoNuevo: string;
}

// Lanza ErrorTransicionInvalida si (origen → destino, actor) no está en la
// tabla. origen NULL representa la creación de la entidad.
async function comprobarTransicion(
  cliente: pg.ClientBase,
  ambito: Ambito,
  estadoOrigen: string | null,
  estadoDestino: string,
  actor: Actor,
): Promise<void> {
  const valida = await cliente.query(
    `SELECT 1 FROM transicion_valida
     WHERE ambito = $1
       AND estado_origen IS NOT DISTINCT FROM $2
       AND estado_destino = $3
       AND actor = $4`,
    [ambito, estadoOrigen, estadoDestino, actor],
  );
  if (valida.rowCount === 0) {
    const permitidas = await cliente.query(
      `SELECT estado_destino, actor FROM transicion_valida
       WHERE ambito = $1 AND estado_origen IS NOT DISTINCT FROM $2
       ORDER BY estado_destino, actor`,
      [ambito, estadoOrigen],
    );
    throw new ErrorTransicionInvalida(ambito, estadoOrigen, estadoDestino, actor, permitidas.rows);
  }
}

// Exportada solo para la reclamación atómica del despacho (R2), que hace su
// propia actualización de estado con UPDATE ... WHERE estado='EMITIDO' y debe
// dejar constancia en el log igualmente. El resto del código usa
// transicionarSolicitud/transicionarConductor.
export async function registrarTransicion(
  cliente: pg.ClientBase,
  ambito: Ambito,
  solicitudId: number | null,
  conductorId: number | null,
  estadoAnterior: string | null,
  estadoNuevo: string,
  actor: Actor,
  origenEvento: string | null,
): Promise<void> {
  await cliente.query(
    `INSERT INTO transicion
       (ambito, solicitud_id, conductor_id, estado_anterior, estado_nuevo, actor, origen_evento)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [ambito, solicitudId, conductorId, estadoAnterior, estadoNuevo, actor, origenEvento],
  );
}

export interface DatosNuevaSolicitud {
  dispositivoClienteId: number;
  telefonoCliente: string;
  referenciaOrigenId: number;
  referenciaDestinoId: number;
  actor: Actor; // 'cliente' o 'operador' (canal de voz, 3.6)
  claveIdempotencia: string;
  origenEvento?: string;
  expiraEn?: Date;
  // Lectura GPS única del cliente al pedir, si dio permiso (señal
  // antifraude, migración 010). Nunca es obligatoria.
  latCliente?: number;
  lngCliente?: number;
}

export interface SolicitudCreada {
  solicitudId: number;
  // true si la clave de idempotencia ya existía: reintento de red, no se creó
  // nada nuevo ni se registró segunda transición (regla 4.2.5).
  yaExistia: boolean;
}

export async function crearSolicitud(
  cliente: pg.ClientBase,
  datos: DatosNuevaSolicitud,
): Promise<SolicitudCreada> {
  await comprobarTransicion(cliente, 'solicitud', null, 'SOLICITADO', datos.actor);

  const insercion = await cliente.query(
    `INSERT INTO solicitud
       (dispositivo_cliente_id, telefono_cliente, referencia_origen_id,
        referencia_destino_id, expira_en, clave_idempotencia, lat_cliente, lng_cliente)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (clave_idempotencia) DO NOTHING
     RETURNING id`,
    [
      datos.dispositivoClienteId,
      datos.telefonoCliente,
      datos.referenciaOrigenId,
      datos.referenciaDestinoId,
      datos.expiraEn ?? null,
      datos.claveIdempotencia,
      datos.latCliente ?? null,
      datos.lngCliente ?? null,
    ],
  );

  if (insercion.rowCount === 0) {
    const existente = await cliente.query(
      'SELECT id FROM solicitud WHERE clave_idempotencia = $1',
      [datos.claveIdempotencia],
    );
    return { solicitudId: existente.rows[0].id, yaExistia: true };
  }

  const solicitudId: number = insercion.rows[0].id;
  await registrarTransicion(
    cliente, 'solicitud', solicitudId, null, null, 'SOLICITADO',
    datos.actor, datos.origenEvento ?? null,
  );
  // El contador de uso del gazetteer (sección 7) sube al confirmar la
  // solicitud; el reintento idempotente de arriba no pasa por aquí.
  await cliente.query(
    'UPDATE referencia SET veces_usada = veces_usada + 1 WHERE id IN ($1, $2)',
    [datos.referenciaOrigenId, datos.referenciaDestinoId],
  );
  return { solicitudId, yaExistia: false };
}

export async function transicionarSolicitud(
  cliente: pg.ClientBase,
  solicitudId: number,
  estadoDestino: string,
  actor: Actor,
  origenEvento?: string,
): Promise<ResultadoTransicion> {
  // FOR UPDATE: dos transiciones concurrentes sobre la misma solicitud se
  // serializan; la segunda ve el estado que dejó la primera.
  const fila = await cliente.query(
    'SELECT estado FROM solicitud WHERE id = $1 FOR UPDATE',
    [solicitudId],
  );
  if (fila.rowCount === 0) {
    throw new ErrorEntidadInexistente('la solicitud', solicitudId);
  }
  const estadoAnterior: string = fila.rows[0].estado;

  await comprobarTransicion(cliente, 'solicitud', estadoAnterior, estadoDestino, actor);
  await cliente.query('UPDATE solicitud SET estado = $1 WHERE id = $2', [estadoDestino, solicitudId]);
  await registrarTransicion(
    cliente, 'solicitud', solicitudId, null, estadoAnterior, estadoDestino,
    actor, origenEvento ?? null,
  );
  return { estadoAnterior, estadoNuevo: estadoDestino };
}

export async function transicionarConductor(
  cliente: pg.ClientBase,
  conductorId: number,
  estadoDestino: string,
  actor: Actor,
  origenEvento?: string,
): Promise<ResultadoTransicion> {
  const fila = await cliente.query(
    'SELECT estado FROM presencia WHERE conductor_id = $1 FOR UPDATE',
    [conductorId],
  );
  if (fila.rowCount === 0) {
    throw new ErrorEntidadInexistente('la presencia del conductor', conductorId);
  }
  const estadoAnterior: string = fila.rows[0].estado;

  await comprobarTransicion(cliente, 'conductor', estadoAnterior, estadoDestino, actor);
  await cliente.query(
    'UPDATE presencia SET estado = $1, actualizada_en = now() WHERE conductor_id = $2',
    [estadoDestino, conductorId],
  );
  await registrarTransicion(
    cliente, 'conductor', null, conductorId, estadoAnterior, estadoDestino,
    actor, origenEvento ?? null,
  );
  return { estadoAnterior, estadoNuevo: estadoDestino };
}
