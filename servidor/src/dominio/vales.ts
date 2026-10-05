// El vale de entrada que da el operador (migración 081).
//
// Existe para un caso y solo uno: el código por SMS no llega y la llamada
// tampoco, y una persona verificada se queda fuera de su cuenta. Entonces el
// operador dicta seis cifras que valen en lugar del código, una vez y durante
// unos minutos.
//
// LO QUE ESTE FICHERO NO HACE, a propósito: decidir QUIÉN puede dar un vale.
// Eso vive en la ruta, que es donde está la identidad de quien llama. Aquí solo
// se emite, se gasta y se cuenta lo que pasó.

import { createHash, randomInt } from 'node:crypto';
import type pg from 'pg';
import { leerParametroEntero } from './parametros.js';
import { normalizarTelefono } from './telefono.js';

type Lector = pg.Pool | pg.ClientBase;

// Mismo resumen que el secreto de dispositivo (migración 069). Sin sal: el
// contenido es un número de seis cifras con caducidad de minutos, y una sal no
// cambiaría nada frente a quien se moleste en probar un millón de combinaciones
// contra una fila que para entonces ya no vale.
function resumir(codigo: string): string {
  return createHash('sha256').update(codigo).digest('hex');
}

export interface ValeEmitido {
  codigo: string;
  caducaEn: Date;
}

// Seis cifras al azar de verdad (`randomInt`, no `Math.random`): esto abre una
// cuenta, y lo que abre una cuenta no se genera con el generador de los dados.
export async function emitirVale(
  cliente: Lector,
  telefono: string,
  emitidoPor: string,
): Promise<ValeEmitido> {
  const canonico = normalizarTelefono(telefono);
  if (canonico === null) throw new Error(`Teléfono no válido: ${telefono}`);
  const minutos = await leerParametroEntero(cliente, 'vale_minutos');

  // El anterior se anula ANTES de crear el nuevo, en la misma transacción: si
  // se hiciera al revés, el índice de «un vale vivo por número» rechazaría el
  // segundo y el operador vería un error donde quería dar un código.
  await cliente.query(
    `UPDATE vale_de_acceso SET anulado_en = now()
     WHERE telefono = $1 AND usado_en IS NULL AND anulado_en IS NULL`,
    [canonico],
  );
  const codigo = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const fila = await cliente.query(
    `INSERT INTO vale_de_acceso (telefono, codigo_hash, emitido_por, caduca_en)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))
     RETURNING caduca_en`,
    [canonico, resumir(codigo), emitidoPor, minutos],
  );
  return { codigo, caducaEn: fila.rows[0].caduca_en };
}

// ¿Es este el vale de este número? Si lo es, se gasta aquí mismo y no vuelve a
// valer.
//
// El gasto va en el mismo UPDATE que la comprobación, y no en un SELECT seguido
// de un UPDATE: dos peticiones con el mismo código llegando a la vez pasarían
// las dos por el SELECT, y entonces «un solo uso» sería un decir.
export async function gastarVale(
  cliente: Lector,
  telefono: string,
  codigo: string,
  uuidDispositivo: string,
): Promise<boolean> {
  const canonico = normalizarTelefono(telefono);
  if (canonico === null) return false;
  const limpio = codigo.trim();
  if (!/^\d{6}$/.test(limpio)) return false;
  const res = await cliente.query(
    `UPDATE vale_de_acceso
     SET usado_en = now(), usado_por = $3
     WHERE telefono = $1
       AND codigo_hash = $2
       AND usado_en IS NULL
       AND anulado_en IS NULL
       AND caduca_en > now()`,
    [canonico, resumir(limpio), uuidDispositivo.toLowerCase()],
  );
  return (res.rowCount ?? 0) > 0;
}

export interface ValeVigente {
  caducaEn: string;
  emitidoPor: string;
}

// Si hay uno sin gastar, para que el panel pueda decir «ya le diste uno, le
// caduca a las 14:32» en vez de dejar al operador dictando códigos nuevos cada
// vez que la persona no acierta a escribirlo.
//
// NO devuelve el código: no está guardado. Se enseña una vez, cuando se emite,
// y si se pierde se emite otro.
export async function valeVigente(
  cliente: Lector,
  telefono: string,
): Promise<ValeVigente | null> {
  const canonico = normalizarTelefono(telefono);
  if (canonico === null) return null;
  const res = await cliente.query(
    `SELECT caduca_en, emitido_por FROM vale_de_acceso
     WHERE telefono = $1 AND usado_en IS NULL AND anulado_en IS NULL
       AND caduca_en > now()`,
    [canonico],
  );
  if (res.rowCount === 0) return null;
  return { caducaEn: res.rows[0].caduca_en, emitidoPor: res.rows[0].emitido_por };
}
