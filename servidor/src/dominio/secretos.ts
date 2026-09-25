// El secreto de sesión de un dispositivo (migración 069, P15-04).
//
// El uuid del dispositivo dice QUIÉN dice ser; el secreto es lo único que lo
// demuestra. Se entrega una vez, se guarda en hash y se exige después.
//
// Por qué SHA-256 y no bcrypt o argon2, que es lo normal para contraseñas: un
// secreto de 32 bytes aleatorios no se adivina por fuerza bruta ni con toda la
// electricidad del mundo, así que el trabajo extra de un hash lento no compra
// nada. Eso solo hace falta cuando detrás hay una palabra que alguien eligió.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';

export function hashDeSecreto(secreto: string): string {
  return createHash('sha256').update(secreto).digest('hex');
}

// Comparación en tiempo constante. Aquí compara dos hashes, no el secreto, así
// que el riesgo real es mínimo; se hace igual porque comparar credenciales con
// `===` es el tipo de costumbre que un día se copia a un sitio donde sí duele.
export function secretoValido(hashGuardado: string, secretoPresentado: string): boolean {
  const a = Buffer.from(hashGuardado, 'hex');
  const b = Buffer.from(hashDeSecreto(secretoPresentado), 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface SecretoEmitido {
  secreto: string;
  yaTenia: boolean;
}

// Emite el secreto de un dispositivo, si no tenía.
//
// Si ya tenía uno NO se emite otro: eso sería la puerta de atrás entera —
// quien conociera el uuid pediría un secreto nuevo y se quedaría con la
// sesión, que es exactamente lo que esto viene a impedir—. Un dispositivo que
// perdió su secreto (borrar datos del navegador) pierde también su uuid, y
// vuelve como dispositivo nuevo.
export async function emitirSecreto(
  cliente: pg.ClientBase | pg.Pool,
  uuid: string,
): Promise<SecretoEmitido | null> {
  const secreto = randomBytes(32).toString('base64url');
  const res = await cliente.query(
    `UPDATE dispositivo
     SET secreto_hash = $2, secreto_creado_en = now()
     WHERE uuid_persistente = $1 AND secreto_hash IS NULL
     RETURNING id`,
    [uuid.toLowerCase(), hashDeSecreto(secreto)],
  );
  if ((res.rowCount ?? 0) > 0) return { secreto, yaTenia: false };

  const existe = await cliente.query(
    'SELECT 1 FROM dispositivo WHERE uuid_persistente = $1',
    [uuid.toLowerCase()],
  );
  if (existe.rowCount === 0) return null;
  return { secreto: '', yaTenia: true };
}
