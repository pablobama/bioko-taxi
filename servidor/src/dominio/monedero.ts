// Monedero prepago del conductor (paso 3).
//
// Reglas:
// - El saldo es SUM(apunte.importe_xaf); nunca hay columna mutable (4.2.2).
// - Dinero en enteros XAF (4.2.1). Cualquier importe no entero es error.
// - Toda escritura lleva clave de idempotencia: un reintento devuelve el
//   apunte ya existente sin duplicar nada (4.2.5).
// - El monedero jamás queda negativo (R5). El bloqueo operativo va en la
//   emisión (el conductor sin saldo no recibe broadcasts, paso 5, vía
//   tieneSaldoParaComision); este módulo además hace imposible el saldo
//   negativo aunque un cobro se cuele: la transacción se aborta.
// - Estas funciones reciben un cliente ya dentro de una transacción.

import type pg from 'pg';
import { ErrorEntidadInexistente, ErrorSaldoInsuficiente } from './errores.js';
import { leerParametroEntero } from './parametros.js';

export type TipoApunte = 'recarga' | 'comision' | 'ajuste' | 'devolucion' | 'suscripcion';

export interface ResultadoApunte {
  apunteId: number;
  // true si la clave de idempotencia ya existía: reintento, no se creó nada.
  yaExistia: boolean;
  saldoXaf: number;
}

async function saldoDeMonedero(cliente: pg.ClientBase, monederoId: number): Promise<number> {
  const res = await cliente.query(
    'SELECT saldo_xaf FROM saldo_monedero WHERE monedero_id = $1',
    [monederoId],
  );
  return Number(res.rows[0].saldo_xaf);
}

export interface DatosApunte {
  conductorId: number;
  tipo: TipoApunte;
  importeXaf: number;
  viajeId?: number;
  claveIdempotencia: string;
}

export async function registrarApunte(
  cliente: pg.ClientBase,
  datos: DatosApunte,
): Promise<ResultadoApunte> {
  if (!Number.isInteger(datos.importeXaf)) {
    throw new Error(
      `Importe no válido: «${datos.importeXaf}». El dinero es entero en XAF, nunca decimal (4.2.1).`,
    );
  }

  // FOR UPDATE: serializa todos los apuntes de un mismo monedero. Es lo que
  // hace imposible que dos cobros concurrentes lo dejen en negativo.
  const monedero = await cliente.query(
    'SELECT id FROM monedero WHERE conductor_id = $1 FOR UPDATE',
    [datos.conductorId],
  );
  if (monedero.rowCount === 0) {
    throw new ErrorEntidadInexistente('el monedero del conductor', datos.conductorId);
  }
  const monederoId: number = monedero.rows[0].id;

  const insercion = await cliente.query(
    `INSERT INTO apunte (monedero_id, tipo, importe_xaf, viaje_id, clave_idempotencia)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (clave_idempotencia) DO NOTHING
     RETURNING id`,
    [monederoId, datos.tipo, datos.importeXaf, datos.viajeId ?? null, datos.claveIdempotencia],
  );

  if (insercion.rowCount === 0) {
    const previo = await cliente.query(
      'SELECT id FROM apunte WHERE clave_idempotencia = $1',
      [datos.claveIdempotencia],
    );
    return {
      apunteId: previo.rows[0].id,
      yaExistia: true,
      saldoXaf: await saldoDeMonedero(cliente, monederoId),
    };
  }

  const saldo = await saldoDeMonedero(cliente, monederoId);
  if (saldo < 0) {
    // La excepción aborta la transacción: el apunte recién insertado no se
    // confirma jamás.
    throw new ErrorSaldoInsuficiente(datos.conductorId, datos.importeXaf, saldo - datos.importeXaf);
  }

  return { apunteId: insercion.rows[0].id, yaExistia: false, saldoXaf: saldo };
}

export async function recargar(
  cliente: pg.ClientBase,
  conductorId: number,
  importeXaf: number,
  claveIdempotencia: string,
): Promise<ResultadoApunte> {
  return registrarApunte(cliente, { conductorId, tipo: 'recarga', importeXaf, claveIdempotencia });
}

// Cobra la comisión del viaje validado (R5). Idempotente por viaje: la clave
// es fija, así que reintentar el cierre nunca cobra dos veces.
export async function cobrarComision(
  cliente: pg.ClientBase,
  viajeId: number,
): Promise<ResultadoApunte> {
  const viaje = await cliente.query('SELECT conductor_id FROM viaje WHERE id = $1', [viajeId]);
  if (viaje.rowCount === 0) {
    throw new ErrorEntidadInexistente('el viaje', viajeId);
  }
  const comision = await leerParametroEntero(cliente, 'comision_por_viaje_xaf');
  return registrarApunte(cliente, {
    conductorId: viaje.rows[0].conductor_id,
    tipo: 'comision',
    importeXaf: -comision,
    viajeId,
    claveIdempotencia: `comision-viaje-${viajeId}`,
  });
}

// Devuelve al conductor exactamente lo que se le cobró por ese viaje (R4).
// Falla ruidosamente si no hubo comisión que devolver.
export async function devolverComision(
  cliente: pg.ClientBase,
  viajeId: number,
): Promise<ResultadoApunte> {
  const cobro = await cliente.query(
    `SELECT a.importe_xaf, m.conductor_id
     FROM apunte a JOIN monedero m ON m.id = a.monedero_id
     WHERE a.viaje_id = $1 AND a.tipo = 'comision'`,
    [viajeId],
  );
  if (cobro.rowCount === 0) {
    throw new Error(
      `No se puede devolver la comisión del viaje ${viajeId}: no consta ningún cobro de comisión.`,
    );
  }
  return registrarApunte(cliente, {
    conductorId: cobro.rows[0].conductor_id,
    tipo: 'devolucion',
    importeXaf: -Number(cobro.rows[0].importe_xaf),
    viajeId,
    claveIdempotencia: `devolucion-viaje-${viajeId}`,
  });
}

// --- Suscripción (modelo vigente desde la migración 011) ------------------

export interface ResultadoSuscripcion {
  suscritoHasta: Date;
  saldoXaf: number;
  yaExistia: boolean;
}

// Cobra una cuota y extiende la vigencia. La base es el vencimiento actual si
// aún no llegó (renovar antes de tiempo no regala días) o «ahora» si ya
// venció. Si el saldo no llega, ErrorSaldoInsuficiente y nada cambia.
export async function renovarSuscripcion(
  cliente: pg.ClientBase,
  conductorId: number,
  ahora: Date = new Date(),
): Promise<ResultadoSuscripcion> {
  const fila = await cliente.query(
    'SELECT suscrito_hasta FROM conductor WHERE id = $1 FOR UPDATE',
    [conductorId],
  );
  if (fila.rowCount === 0) {
    throw new ErrorEntidadInexistente('el conductor', conductorId);
  }
  const importe = await leerParametroEntero(cliente, 'suscripcion_importe_xaf');
  const dias = await leerParametroEntero(cliente, 'suscripcion_dias');

  const vigenteHasta: Date | null = fila.rows[0].suscrito_hasta;
  const base = vigenteHasta !== null && vigenteHasta > ahora ? vigenteHasta : ahora;

  // La clave incluye la base: un doble toque en el mismo instante es un solo
  // cobro; una renovación posterior (base distinta) es otra cuota.
  const apunte = await registrarApunte(cliente, {
    conductorId,
    tipo: 'suscripcion',
    importeXaf: -importe,
    claveIdempotencia: `suscripcion-${conductorId}-${base.getTime()}`,
  });

  const suscritoHasta = new Date(base.getTime() + dias * 86_400_000);
  if (!apunte.yaExistia) {
    await cliente.query(
      'UPDATE conductor SET suscrito_hasta = $2 WHERE id = $1',
      [conductorId, suscritoHasta],
    );
  }
  return { suscritoHasta, saldoXaf: apunte.saldoXaf, yaExistia: apunte.yaExistia };
}

export async function suscripcionVigente(
  cliente: pg.ClientBase | pg.Pool,
  conductorId: number,
  ahora: Date = new Date(),
): Promise<boolean> {
  const res = await cliente.query(
    'SELECT suscrito_hasta FROM conductor WHERE id = $1',
    [conductorId],
  );
  if (res.rowCount === 0) {
    throw new ErrorEntidadInexistente('el conductor', conductorId);
  }
  const hasta: Date | null = res.rows[0].suscrito_hasta;
  return hasta !== null && hasta > ahora;
}

// Predicado del modelo de comisión (previo a la migración 011). El filtro de
// emisión ya no lo usa (ahora filtra por suscripción vigente); se conserva
// junto a cobrarComision/devolverComision como primitiva contable por si
// vuelve un modelo híbrido. Ver PENDIENTES.md.
export async function tieneSaldoParaComision(
  cliente: pg.ClientBase,
  conductorId: number,
): Promise<boolean> {
  const comision = await leerParametroEntero(cliente, 'comision_por_viaje_xaf');
  const res = await cliente.query(
    'SELECT saldo_xaf FROM saldo_monedero WHERE conductor_id = $1',
    [conductorId],
  );
  if (res.rowCount === 0) {
    throw new ErrorEntidadInexistente('el monedero del conductor', conductorId);
  }
  return Number(res.rows[0].saldo_xaf) >= comision;
}

export interface ResultadoClienteAusente {
  // true si se aplicó strike al dispositivo; false si quedó en revisión manual.
  strikeAplicado: boolean;
  strikesActuales: number;
  dispositivoBloqueado: boolean;
}

// Efectos económicos y de reputación del cliente ausente (R4): devolución de
// la comisión al conductor y strike al dispositivo del cliente. Si el
// dispositivo tenía sesión SSE activa en ese momento, NUNCA se sanciona
// automáticamente: se abre incidencia para revisión manual.
export async function procesarClienteAusente(
  cliente: pg.ClientBase,
  viajeId: number,
  dispositivoConSesionActiva: boolean,
): Promise<ResultadoClienteAusente> {
  // Con el modelo de suscripción (migración 011) no hay comisión por viaje
  // que devolver: el efecto económico desapareció y queda el reputacional
  // (strike al dispositivo del cliente, o revisión manual si tenía sesión).
  const viaje = await cliente.query('SELECT 1 FROM viaje WHERE id = $1', [viajeId]);
  if (viaje.rowCount === 0) {
    throw new ErrorEntidadInexistente('el viaje', viajeId);
  }

  const fila = await cliente.query(
    `SELECT s.dispositivo_cliente_id
     FROM viaje v JOIN solicitud s ON s.id = v.solicitud_id
     WHERE v.id = $1`,
    [viajeId],
  );
  const dispositivoId: number = fila.rows[0].dispositivo_cliente_id;

  if (dispositivoConSesionActiva) {
    // Falso «no presentado» posible: el cliente estaba mirando la pantalla.
    await cliente.query(
      `INSERT INTO incidencia (viaje_id, tipo, descripcion)
       VALUES ($1, 'no_presentado_dudoso',
               'Declaración de cliente ausente con sesión SSE activa: revisar antes de sancionar (R4).')`,
      [viajeId],
    );
    return {
      strikeAplicado: false,
      strikesActuales: 0,
      dispositivoBloqueado: false,
    };
  }

  const limite = await leerParametroEntero(cliente, 'strikes_para_bloqueo');
  const strike = await cliente.query(
    `UPDATE dispositivo
     SET strikes = strikes + 1,
         bloqueado_en = CASE WHEN strikes + 1 >= $2 THEN COALESCE(bloqueado_en, now())
                             ELSE bloqueado_en END
     WHERE id = $1
     RETURNING strikes, bloqueado_en`,
    [dispositivoId, limite],
  );
  return {
    strikeAplicado: true,
    strikesActuales: strike.rows[0].strikes,
    dispositivoBloqueado: strike.rows[0].bloqueado_en !== null,
  };
}
