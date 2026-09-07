// Presencia del conductor (paso 5, decisión 3.4): un conductor está
// DISPONIBLE si y solo si su estado lo dice Y su heartbeat tiene menos de
// ventana_heartbeat_seg (120 s). La consulta de candidatos del despacho
// aplica ambas condiciones; aquí viven el heartbeat y el ciclo de servicio.
//
// Migración 049: esas dos condiciones son distintas y ahora se tratan como
// tales. El ESTADO es lo que el taxista declaró —«estoy trabajando»— y solo
// él lo retira. El LATIDO es si su móvil se le puede alcanzar ahora mismo, y
// es lo único que decide si se le ofrece una carrera. Antes un latido viejo
// borraba la declaración, y bastaban dos minutos de túnel para dejar a
// alguien fuera de servicio sin que se enterara.

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
  // Desde cuándo lleva el turno: de aquí salen el aviso de la hora y la red
  // de seguridad del abandono (migración 049). Se pone al ENTRAR y no en cada
  // latido, que es lo que lo hace medir el turno y no el último minuto.
  await cliente.query(
    `UPDATE presencia SET en_servicio_desde = $2, avisado_turno_en = NULL
     WHERE conductor_id = $1`,
    [conductorId, ahora],
  );
}

export async function salirDeServicio(
  cliente: pg.ClientBase,
  conductorId: number,
): Promise<void> {
  await transicionarConductor(cliente, conductorId, 'DESCONECTADO', 'conductor', 'salir_de_servicio');
  await cliente.query(
    `UPDATE presencia SET en_servicio_desde = NULL, avisado_turno_en = NULL
     WHERE conductor_id = $1`,
    [conductorId],
  );
}

// ¿Toca recordarle que sigue en servicio y con la ubicación encendida?
//
// Se le avisa cada `aviso_turno_horas`. Lleva el GPS encendido, gasta batería
// y le sigue: tiene derecho a que se lo recuerden mientras pasa, no a
// descubrirlo al día siguiente mirando su recorrido en el panel. Y de paso es
// la ocasión de que diga «sí, sigo» o se salga.
//
// Devuelve las horas que lleva, o null si no toca avisar. Marca el aviso en la
// misma consulta: dos latidos a la vez no pueden avisar dos veces.
export async function avisoDeTurnoLargo(
  cliente: pg.ClientBase,
  conductorId: number,
  ahora: Date = new Date(),
): Promise<number | null> {
  const horas = await leerParametroEntero(cliente, 'aviso_turno_horas');
  const res = await cliente.query(
    `UPDATE presencia
     SET avisado_turno_en = $2
     WHERE conductor_id = $1
       AND estado <> 'DESCONECTADO'
       AND en_servicio_desde IS NOT NULL
       AND en_servicio_desde <= $2::timestamptz - make_interval(hours => $3)
       AND (avisado_turno_en IS NULL
            OR avisado_turno_en <= $2::timestamptz - make_interval(hours => $3))
     RETURNING extract(epoch from ($2::timestamptz - en_servicio_desde)) / 3600 AS horas`,
    [conductorId, ahora, horas],
  );
  return res.rowCount === 0 ? null : Math.floor(Number(res.rows[0].horas));
}

// Red de seguridad, no fin de turno (migración 049).
//
// Antes esto sacaba de servicio a quien llevara dos minutos sin latir, y era
// el motivo de que a un taxista se le cayera el turno por meterse en un
// túnel. Ahora el umbral son DOCE HORAS: a partir de ahí ese móvil no va a
// volver —ningún turno dura medio día— y dejarlo DISPONIBLE para siempre
// llenaría el panel del operador de taxis que no existen.
//
// Que no se le ofrezcan carreras entretanto no depende de esto: de eso se
// encarga el filtro de latido fresco del propio reparto, que sigue en 120 s.
// No toca a los OFERTADO/OCUPADO: su ciclo lo gobierna la oferta o el viaje.
export async function caducarPresencias(
  cliente: pg.ClientBase,
  ahora: Date = new Date(),
): Promise<number> {
  const horas = await leerParametroEntero(cliente, 'abandono_servicio_horas');
  const vencidos = await cliente.query(
    `SELECT conductor_id FROM presencia
     WHERE estado = 'DISPONIBLE'
       AND (ultimo_heartbeat IS NULL OR ultimo_heartbeat < $1::timestamptz - make_interval(hours => $2))
     FOR UPDATE`,
    [ahora, horas],
  );
  for (const fila of vencidos.rows) {
    await transicionarConductor(cliente, fila.conductor_id, 'DESCONECTADO', 'sistema', 'turno_abandonado');
  }
  if (vencidos.rowCount !== 0) {
    await cliente.query(
      `UPDATE presencia SET en_servicio_desde = NULL, avisado_turno_en = NULL
       WHERE conductor_id = ANY($1)`,
      [vencidos.rows.map((f: { conductor_id: number }) => f.conductor_id)],
    );
  }
  return vencidos.rowCount ?? 0;
}
