// Presencia del conductor (paso 5, decisión 3.4): un conductor está
// DISPONIBLE si y solo si su estado lo dice Y su heartbeat tiene menos de
// ventana_heartbeat_seg (120 s). La consulta de candidatos del despacho
// aplica ambas condiciones; aquí viven el heartbeat y el ciclo de servicio.

import type pg from 'pg';
import { ErrorEntidadInexistente } from './errores.js';
import { leerParametroEntero } from './parametros.js';
import { transicionarConductor } from './transiciones.js';

// Refresca el heartbeat (y opcionalmente la zona) del conductor. No cambia
// el estado: entrar y salir de servicio son transiciones explícitas.
export async function registrarHeartbeat(
  cliente: pg.ClientBase,
  conductorId: number,
  zonaId?: number,
  ahora: Date = new Date(),
): Promise<void> {
  if (zonaId !== undefined) {
    // Único punto donde se escribe presencia.zona_id: aquí se cierra la
    // puerta a que un barrio/calle (migración 031) acabe siendo "donde
    // trabaja" un conductor, aunque la app del taxista solo deje elegir
    // distritos urbanos — esto es lo que de verdad lo impide.
    const zona = await cliente.query('SELECT zona_padre_id FROM zona WHERE id = $1', [zonaId]);
    if (zona.rowCount === 0) {
      throw new ErrorEntidadInexistente('la zona', zonaId);
    }
    if (zona.rows[0].zona_padre_id !== null) {
      throw new Error(`La zona ${zonaId} es un barrio/calle, no un distrito urbano: no se puede trabajar ahí.`);
    }
  }
  const res = await cliente.query(
    `UPDATE presencia
     SET ultimo_heartbeat = $2, zona_id = COALESCE($3, zona_id), actualizada_en = now()
     WHERE conductor_id = $1`,
    [conductorId, ahora, zonaId ?? null],
  );
  if (res.rowCount === 0) {
    throw new ErrorEntidadInexistente('la presencia del conductor', conductorId);
  }
}

export async function entrarEnServicio(
  cliente: pg.ClientBase,
  conductorId: number,
  zonaId: number,
  ahora: Date = new Date(),
): Promise<void> {
  await transicionarConductor(cliente, conductorId, 'DISPONIBLE', 'conductor', 'entrar_en_servicio');
  await registrarHeartbeat(cliente, conductorId, zonaId, ahora);
}

export async function salirDeServicio(
  cliente: pg.ClientBase,
  conductorId: number,
): Promise<void> {
  await transicionarConductor(cliente, conductorId, 'DESCONECTADO', 'conductor', 'salir_de_servicio');
}

// Mantenimiento periódico: los DISPONIBLE con heartbeat vencido pasan a
// DESCONECTADO. No toca a los OFERTADO/OCUPADO: su ciclo lo gobierna la
// oferta o el viaje en curso.
export async function caducarPresencias(
  cliente: pg.ClientBase,
  ahora: Date = new Date(),
): Promise<number> {
  const ventanaSeg = await leerParametroEntero(cliente, 'ventana_heartbeat_seg');
  const vencidos = await cliente.query(
    `SELECT conductor_id FROM presencia
     WHERE estado = 'DISPONIBLE'
       AND (ultimo_heartbeat IS NULL OR ultimo_heartbeat < $1::timestamptz - make_interval(secs => $2))
     FOR UPDATE`,
    [ahora, ventanaSeg],
  );
  for (const fila of vencidos.rows) {
    await transicionarConductor(cliente, fila.conductor_id, 'DESCONECTADO', 'sistema', 'heartbeat_vencido');
  }
  return vencidos.rowCount ?? 0;
}
