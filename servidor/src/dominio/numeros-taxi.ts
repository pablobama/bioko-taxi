// El número de taxi (migración 084): A000…Z999 y luego dos letras (AA000…).
//
// Es el número de flota: el que se pinta en la puerta del coche y se dicta
// por teléfono. De ahí sus tres reglas, que son las del operador y no mías:
// lo da la secuencia al nacer el conductor; a mano solo se asigna uno POR
// DETRÁS del último generado (para respetar el que un coche ya lleva
// pintado, no para saltar la cola); y es PARA SIEMPRE — no hay función que
// lo cambie, y no la habrá: un número que puede mudarse de coche no sirve
// para pintarlo en una puerta.
//
// El puntero vive en `parametro` ('numero_taxi_siguiente') y se lee con
// FOR UPDATE dentro de la transacción del alta: dos altas a la vez no pueden
// llevarse el mismo número, y un alta que falla no quema ninguno.
//
// Y TODO ELLO DETRÁS DE UN INTERRUPTOR ('numero_taxi_activado', migración
// 085), apagado de serie: el operador decide cuándo la numeración empieza a
// existir, desde el panel y sin desplegar. Apagado, nadie recibe número.

import type pg from 'pg';
import { leerParametroEntero } from './parametros.js';

const LETRAS = 26;
const POR_BLOQUE = 1000;

// índice → número: 0 es A000, 999 es A999, 1000 es B000, 25999 es Z999,
// 26000 es AA000, 27000 es AB000.
export function numeroDeIndice(indice: number): string {
  if (!Number.isInteger(indice) || indice < 0) {
    throw new Error(`Índice de número de taxi no válido: ${indice}.`);
  }
  const bloque = Math.floor(indice / POR_BLOQUE);
  let letras: string;
  if (bloque < LETRAS) {
    letras = String.fromCharCode(65 + bloque);
  } else {
    const resto = bloque - LETRAS;
    const primera = Math.floor(resto / LETRAS);
    if (primera >= LETRAS) {
      // 702 bloques de mil: 702.000 taxis. Si Malabo llega aquí, este error
      // será el menor de los problemas de tráfico.
      throw new Error('Se acabó el abecedario de números de taxi.');
    }
    letras = String.fromCharCode(65 + primera) + String.fromCharCode(65 + (resto % LETRAS));
  }
  return letras + String(indice % POR_BLOQUE).padStart(3, '0');
}

// número → índice, o null si no tiene la forma de un número de taxi. Acepta
// minúsculas y espacios alrededor: se teclea con prisa.
export function indiceDeNumero(crudo: string): number | null {
  const m = /^([A-Z]{1,2})(\d{3})$/.exec(crudo.trim().toUpperCase());
  if (m === null) return null;
  const [, letras, digitos] = m;
  const bloque = letras.length === 1
    ? letras.charCodeAt(0) - 65
    : LETRAS + (letras.charCodeAt(0) - 65) * LETRAS + (letras.charCodeAt(1) - 65);
  return bloque * POR_BLOQUE + Number(digitos);
}

// Para que la ruta conteste con el código correcto sin adivinar: 400 es «eso
// no es un número o no toca», 409 es «ese número ya es de alguien».
export class NumeroNoAsignable extends Error {
  constructor(public readonly statusCode: number, mensaje: string) {
    super(mensaje);
  }
}

async function punteroBloqueado(cliente: pg.ClientBase): Promise<number> {
  const fila = await cliente.query(
    `SELECT valor FROM parametro WHERE clave = 'numero_taxi_siguiente' FOR UPDATE`,
  );
  return Number(fila.rows[0].valor);
}

// El siguiente de la secuencia, para un conductor recién nacido.
export async function asignarNumeroSiguiente(
  cliente: pg.ClientBase,
  conductorId: number,
): Promise<string | null> {
  // Con el interruptor apagado no se asigna NI SE AVANZA el puntero: null y
  // fuera. El que nazca hoy recibirá número el día que... no: no lo recibirá
  // — la numeración empieza para todos cuando se encienda, y ese reparto es
  // una decisión del operador, no un gotero silencioso.
  if (await leerParametroEntero(cliente, 'numero_taxi_activado') !== 1) {
    return null;
  }
  const indice = await punteroBloqueado(cliente);
  const numero = numeroDeIndice(indice);
  await cliente.query(
    `UPDATE parametro SET valor = $1 WHERE clave = 'numero_taxi_siguiente'`,
    [String(indice + 1)],
  );
  await cliente.query(
    'UPDATE conductor SET numero_taxi = $2 WHERE id = $1',
    [conductorId, numero],
  );
  return numero;
}

// Un número concreto, dictado por el operador: el que el coche ya lleva
// pintado. Solo por detrás del último generado y solo si está libre.
export async function asignarNumeroManual(
  cliente: pg.ClientBase,
  conductorId: number,
  crudo: string,
): Promise<string> {
  if (await leerParametroEntero(cliente, 'numero_taxi_activado') !== 1) {
    throw new NumeroNoAsignable(
      400,
      'La numeración de taxis está apagada: enciéndela en Ajustes → '
      + 'parámetros (numero_taxi_activado a 1) y vuelve a intentarlo.',
    );
  }
  const indice = indiceDeNumero(crudo);
  if (indice === null) {
    throw new NumeroNoAsignable(
      400,
      `«${crudo}» no es un número de taxi: una o dos letras y tres cifras, como A013.`,
    );
  }
  const numero = numeroDeIndice(indice);
  const siguiente = await punteroBloqueado(cliente);
  if (indice >= siguiente) {
    throw new NumeroNoAsignable(
      400,
      `A mano solo se dan números ya emitidos. El siguiente automático es `
      + `${numeroDeIndice(siguiente)}: deja la casilla vacía y le tocará solo.`,
    );
  }
  const dueno = await cliente.query(
    'SELECT nombre FROM conductor WHERE numero_taxi = $1',
    [numero],
  );
  if ((dueno.rowCount ?? 0) > 0) {
    throw new NumeroNoAsignable(
      409,
      `El ${numero} ya es de ${dueno.rows[0].nombre}, y un número de taxi no `
      + 'se quita: es para siempre.',
    );
  }
  await cliente.query(
    'UPDATE conductor SET numero_taxi = $2 WHERE id = $1',
    [conductorId, numero],
  );
  return numero;
}
