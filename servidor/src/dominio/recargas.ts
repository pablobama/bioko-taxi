// Recargas del monedero (migración 018).
//
// Recordatorio permanente: aquí NO se comprueba ningún pago. Una recarga
// pendiente no toca el saldo. El saldo solo sube cuando una persona confirma
// que ha visto el dinero, y esa confirmación es la que crea el apunte.

import { randomInt } from 'node:crypto';
import type pg from 'pg';
import { ErrorEntidadInexistente } from './errores.js';
import { registrarApunte } from './monedero.js';
import { leerParametroEntero } from './parametros.js';

export type MetodoRecarga = 'muni_dinero' | 'efectivo';

export interface RecargaSolicitada {
  id: number;
  referencia: string;
  importeXaf: number;
  metodo: MetodoRecarga;
  estado: string;
  // Instrucciones concretas de pago, ya resueltas: la app no debe componerlas.
  instrucciones: {
    numero: string | null;
    titular: string | null;
    concepto: string;
    texto: string;
  };
}

// Referencia corta, legible y fácil de dictar por teléfono: sin letras que se
// confundan (I, O) ni ceros.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function nuevaReferencia(): string {
  let texto = '';
  for (let i = 0; i < 6; i += 1) {
    texto += ALFABETO[randomInt(0, ALFABETO.length)];
  }
  return `${texto.slice(0, 3)}-${texto.slice(3)}`;
}

async function leerParametroTexto(
  cliente: pg.ClientBase | pg.Pool,
  clave: string,
): Promise<string> {
  const res = await cliente.query('SELECT valor FROM parametro WHERE clave = $1', [clave]);
  if (res.rowCount === 0) {
    throw new Error(`No existe el parámetro «${clave}».`);
  }
  return res.rows[0].valor;
}

export async function solicitarRecarga(
  cliente: pg.ClientBase,
  conductorId: number,
  importeXaf: number,
  metodo: MetodoRecarga,
): Promise<RecargaSolicitada> {
  const minimo = await leerParametroEntero(cliente, 'recarga_minima_xaf');
  if (!Number.isInteger(importeXaf)) {
    throw new Error(`Importe no válido: «${importeXaf}». El dinero es entero en XAF.`);
  }
  if (importeXaf < minimo) {
    throw new Error(`La recarga mínima son ${minimo} XAF (una semana de suscripción).`);
  }

  const existe = await cliente.query('SELECT 1 FROM conductor WHERE id = $1', [conductorId]);
  if (existe.rowCount === 0) {
    throw new ErrorEntidadInexistente('el conductor', conductorId);
  }

  // Una pendiente a la vez: dos solicitudes abiertas del mismo conductor son
  // dos referencias distintas para el mismo dinero, y el operador no sabría
  // cuál confirmar.
  const pendiente = await cliente.query(
    `SELECT id, referencia, importe_xaf, metodo, estado
     FROM recarga WHERE conductor_id = $1 AND estado = 'pendiente'`,
    [conductorId],
  );
  if ((pendiente.rowCount ?? 0) > 0) {
    const fila = pendiente.rows[0];
    return {
      id: fila.id,
      referencia: fila.referencia,
      importeXaf: Number(fila.importe_xaf),
      metodo: fila.metodo,
      estado: fila.estado,
      instrucciones: await instruccionesDe(cliente, fila.metodo, Number(fila.importe_xaf), fila.referencia),
    };
  }

  // Colisión de referencia: rarísima con 32^6, pero se reintenta.
  let creada;
  for (let intento = 0; intento < 5 && !creada; intento += 1) {
    const referencia = nuevaReferencia();
    const res = await cliente.query(
      `INSERT INTO recarga (conductor_id, importe_xaf, metodo, referencia)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (referencia) DO NOTHING
       RETURNING id, referencia, importe_xaf, metodo, estado`,
      [conductorId, importeXaf, metodo, referencia],
    );
    if ((res.rowCount ?? 0) > 0) creada = res.rows[0];
  }
  if (!creada) {
    throw new Error('No se pudo generar una referencia única para la recarga. Reintenta.');
  }

  return {
    id: creada.id,
    referencia: creada.referencia,
    importeXaf: Number(creada.importe_xaf),
    metodo: creada.metodo,
    estado: creada.estado,
    instrucciones: await instruccionesDe(cliente, creada.metodo, Number(creada.importe_xaf), creada.referencia),
  };
}

async function instruccionesDe(
  cliente: pg.ClientBase | pg.Pool,
  metodo: MetodoRecarga,
  importeXaf: number,
  referencia: string,
): Promise<RecargaSolicitada['instrucciones']> {
  if (metodo === 'muni_dinero') {
    const numero = await leerParametroTexto(cliente, 'muni_dinero_numero');
    const titular = await leerParametroTexto(cliente, 'muni_dinero_titular');
    return {
      numero,
      titular,
      concepto: referencia,
      texto: `Envía ${importeXaf} XAF por Muni Dinero al ${numero} (${titular}) `
        + `poniendo ${referencia} como concepto. Tu saldo sube cuando confirmemos el ingreso.`,
    };
  }
  return {
    numero: null,
    titular: null,
    concepto: referencia,
    texto: `Entrega ${importeXaf} XAF en efectivo al operador y dile la referencia `
      + `${referencia}. Tu saldo sube cuando la registre.`,
  };
}

export interface ResultadoConfirmacion {
  recargaId: number;
  importeXaf: number;
  saldoXaf: number;
  yaEstaba: boolean;
}

// Confirmación por parte del operador: es AQUÍ donde sube el saldo, y solo
// aquí. La clave de idempotencia cuelga de la recarga, así que confirmar dos
// veces la misma no duplica el dinero.
export async function confirmarRecarga(
  cliente: pg.ClientBase,
  referencia: string,
  quienConfirma: string,
): Promise<ResultadoConfirmacion> {
  const fila = await cliente.query(
    `SELECT id, conductor_id, importe_xaf, estado, apunte_id
     FROM recarga WHERE referencia = $1 FOR UPDATE`,
    [referencia.toUpperCase()],
  );
  if (fila.rowCount === 0) {
    throw new ErrorEntidadInexistente('la recarga con referencia', referencia);
  }
  const recarga = fila.rows[0];

  if (recarga.estado === 'confirmada') {
    const saldo = await cliente.query(
      'SELECT saldo_xaf FROM saldo_monedero WHERE conductor_id = $1',
      [recarga.conductor_id],
    );
    return {
      recargaId: recarga.id,
      importeXaf: Number(recarga.importe_xaf),
      saldoXaf: Number(saldo.rows[0].saldo_xaf),
      yaEstaba: true,
    };
  }
  if (recarga.estado !== 'pendiente') {
    throw new Error(`La recarga ${referencia} está ${recarga.estado}: no se puede confirmar.`);
  }

  const apunte = await registrarApunte(cliente, {
    conductorId: recarga.conductor_id,
    tipo: 'recarga',
    importeXaf: Number(recarga.importe_xaf),
    claveIdempotencia: `recarga-${recarga.id}`,
  });

  await cliente.query(
    `UPDATE recarga
     SET estado = 'confirmada', resuelta_en = now(), resuelta_por = $2, apunte_id = $3
     WHERE id = $1`,
    [recarga.id, quienConfirma, apunte.apunteId],
  );

  return {
    recargaId: recarga.id,
    importeXaf: Number(recarga.importe_xaf),
    saldoXaf: apunte.saldoXaf,
    yaEstaba: false,
  };
}

export async function rechazarRecarga(
  cliente: pg.ClientBase,
  referencia: string,
  quienRechaza: string,
  motivo: string,
): Promise<void> {
  const res = await cliente.query(
    `UPDATE recarga
     SET estado = 'rechazada', resuelta_en = now(), resuelta_por = $2, nota = $3
     WHERE referencia = $1 AND estado = 'pendiente'`,
    [referencia.toUpperCase(), quienRechaza, motivo],
  );
  if (res.rowCount === 0) {
    throw new Error(`No hay ninguna recarga pendiente con referencia ${referencia}.`);
  }
}

// Mantenimiento: las pendientes muy viejas se dan por caducadas para que el
// conductor pueda pedir otra y la lista del operador no crezca sin fin.
export async function caducarRecargas(cliente: pg.ClientBase): Promise<number> {
  const horas = await leerParametroEntero(cliente, 'recarga_caducidad_horas');
  const res = await cliente.query(
    `UPDATE recarga SET estado = 'caducada', resuelta_en = now(), resuelta_por = 'sistema'
     WHERE estado = 'pendiente'
       AND solicitada_en < now() - make_interval(hours => $1)`,
    [horas],
  );
  return res.rowCount ?? 0;
}

export async function recargasDe(
  cliente: pg.ClientBase | pg.Pool,
  conductorId: number,
  limite = 10,
): Promise<Array<Record<string, unknown>>> {
  const res = await cliente.query(
    `SELECT id, importe_xaf, metodo, referencia, estado, solicitada_en, resuelta_en, nota
     FROM recarga WHERE conductor_id = $1
     ORDER BY solicitada_en DESC LIMIT $2`,
    [conductorId, limite],
  );
  return res.rows.map((f) => ({
    id: f.id,
    importeXaf: Number(f.importe_xaf),
    metodo: f.metodo,
    referencia: f.referencia,
    estado: f.estado,
    solicitadaEn: f.solicitada_en,
    resueltaEn: f.resuelta_en,
    nota: f.nota,
  }));
}
