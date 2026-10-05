// Quién puede entrar al panel de operador (migración 080).
//
// DOS LISTAS, Y LA DIFERENCIA IMPORTA:
//
//   · LA RAÍZ vive en `TELEFONOS_OPERADOR`, una variable de entorno. No se
//     revoca desde el panel y no se puede quedar vacía por accidente. Es el
//     seguro contra quedarse fuera de casa: si todos los permisos vivieran en
//     la base, un error bastaría para dejar la plataforma sin ningún operador
//     y sin forma de volver a entrar.
//
//   · LOS DEMÁS están en `operador_autorizado`, los da de alta la raíz desde el
//     panel y los puede echar sin desplegar nada.
//
// Y APARTE, LOS APARATOS. Que un teléfono esté autorizado no basta: el aparato
// desde el que se entra tiene que haber demostrado, con un código por SMS, que
// es de esa persona. Eso es lo que convierte «conocer el número» en «tener el
// móvil», que es la diferencia entre un secreto que se puede mirar por encima
// del hombro y uno que no.

import type pg from 'pg';
import { leerParametroEntero } from './parametros.js';
import { normalizarTelefono } from './telefono.js';

type Lector = pg.Pool | pg.ClientBase;

// Los de la variable de entorno, en forma canónica. Se lee en cada llamada y no
// una vez al arrancar: así, cambiarla en Render y reiniciar basta, sin que
// quede una copia vieja en memoria de un proceso que lleva días levantado.
export function telefonosRaiz(): Set<string> {
  const crudos = (process.env.TELEFONOS_OPERADOR ?? '').split(',');
  const canonicos = crudos
    .map((t) => normalizarTelefono(t.trim()))
    .filter((t): t is string => t !== null);
  return new Set(canonicos);
}

export function esRaiz(telefono: string): boolean {
  const canonico = normalizarTelefono(telefono);
  return canonico !== null && telefonosRaiz().has(canonico);
}

// ¿Puede entrar este número? La raíz siempre; los demás, mientras no se les
// haya revocado.
export async function esTelefonoDeOperador(
  cliente: Lector,
  telefono: string,
): Promise<boolean> {
  const canonico = normalizarTelefono(telefono);
  if (canonico === null) return false;
  if (telefonosRaiz().has(canonico)) return true;
  const res = await cliente.query(
    `SELECT 1 FROM operador_autorizado
     WHERE telefono = $1 AND revocado_en IS NULL`,
    [canonico],
  );
  return (res.rowCount ?? 0) > 0;
}

// ¿Es este APARATO de un operador? Es la pregunta que hace cada ruta del panel.
//
// Comprueba las dos cosas a la vez, y las dos importan: que el aparato siga
// vinculado y sin caducar, y que la persona de la que es siga autorizada. Lo
// segundo es lo que hace que revocar a alguien eche también a sus aparatos sin
// tener que ir a buscarlos uno por uno.
export async function dispositivoDeOperador(
  cliente: Lector,
  uuid: string,
): Promise<string | null> {
  const dias = await leerParametroEntero(cliente, 'operador_sesion_dias');
  const res = await cliente.query(
    `SELECT od.telefono
     FROM operador_dispositivo od
     WHERE od.uuid_dispositivo = $1
       AND od.revocado_en IS NULL
       AND od.creado_en > now() - make_interval(days => $2)`,
    [uuid.toLowerCase(), dias],
  );
  if (res.rowCount === 0) return null;
  const telefono: string = res.rows[0].telefono;
  return await esTelefonoDeOperador(cliente, telefono) ? telefono : null;
}

// Este aparato es de este operador. Se llama DESPUÉS de comprobar el código.
export async function vincularDispositivo(
  cliente: Lector,
  uuid: string,
  telefono: string,
): Promise<void> {
  const canonico = normalizarTelefono(telefono);
  if (canonico === null) throw new Error(`Teléfono no válido: ${telefono}`);
  // Volver a entrar con el mismo aparato renueva el reloj en vez de crear otra
  // fila: si no, la lista de aparatos de una persona se llenaría de copias del
  // mismo móvil y no habría forma de saber cuál echar.
  await cliente.query(
    `INSERT INTO operador_dispositivo (uuid_dispositivo, telefono, visto_en)
     VALUES ($1, $2, now())
     ON CONFLICT (uuid_dispositivo) WHERE revocado_en IS NULL
     DO UPDATE SET telefono = EXCLUDED.telefono, creado_en = now(), visto_en = now()`,
    [uuid.toLowerCase(), canonico],
  );
}

export async function marcarVisto(cliente: Lector, uuid: string): Promise<void> {
  await cliente.query(
    `UPDATE operador_dispositivo SET visto_en = now()
     WHERE uuid_dispositivo = $1 AND revocado_en IS NULL`,
    [uuid.toLowerCase()],
  );
}

// --- Lo que hace la raíz desde el panel -----------------------------------

export interface OperadorListado {
  telefono: string;
  nombre: string | null;
  raiz: boolean;
  alta_por: string | null;
  creado_en: string | null;
  aparatos: number;
}

export async function listarOperadores(cliente: Lector): Promise<OperadorListado[]> {
  const res = await cliente.query(
    `SELECT a.telefono, a.nombre, a.alta_por, a.creado_en,
            (SELECT count(*) FROM operador_dispositivo d
             WHERE d.telefono = a.telefono AND d.revocado_en IS NULL)::int AS aparatos
     FROM operador_autorizado a
     WHERE a.revocado_en IS NULL
     ORDER BY a.creado_en`,
  );
  const dados: OperadorListado[] = res.rows.map((f) => ({
    telefono: f.telefono,
    nombre: f.nombre,
    raiz: false,
    alta_por: f.alta_por,
    creado_en: f.creado_en,
    aparatos: f.aparatos,
  }));
  // La raíz va primero y marcada: quien mire la lista tiene que ver de un
  // vistazo a quién no puede echar desde ahí.
  const raices: OperadorListado[] = [...telefonosRaiz()].map((telefono) => ({
    telefono,
    nombre: null,
    raiz: true,
    alta_por: null,
    creado_en: null,
    aparatos: 0,
  }));
  return [...raices, ...dados];
}

export async function autorizar(
  cliente: Lector,
  telefono: string,
  nombre: string | null,
  altaPor: string,
): Promise<void> {
  const canonico = normalizarTelefono(telefono);
  if (canonico === null) throw new Error(`Teléfono no válido: ${telefono}`);
  await cliente.query(
    `INSERT INTO operador_autorizado (telefono, nombre, alta_por)
     VALUES ($1, $2, $3)
     ON CONFLICT (telefono) WHERE revocado_en IS NULL DO NOTHING`,
    [canonico, nombre, altaPor],
  );
}

// Echar a alguien. Se le quita el permiso Y se le caen los aparatos en la misma
// transacción: dejar los aparatos vivos un rato más sería dejarle entrar
// después de haberle echado, que es justo lo que no puede pasar cuando se
// revoca a alguien con prisa.
export async function revocar(
  cliente: Lector,
  telefono: string,
  revocadoPor: string,
): Promise<boolean> {
  const canonico = normalizarTelefono(telefono);
  if (canonico === null) return false;
  if (telefonosRaiz().has(canonico)) {
    throw new Error('A la raíz no se la echa desde el panel: quítala de TELEFONOS_OPERADOR.');
  }
  const res = await cliente.query(
    `UPDATE operador_autorizado SET revocado_en = now(), revocado_por = $2
     WHERE telefono = $1 AND revocado_en IS NULL`,
    [canonico, revocadoPor],
  );
  await cliente.query(
    `UPDATE operador_dispositivo SET revocado_en = now(), revocado_por = $2
     WHERE telefono = $1 AND revocado_en IS NULL`,
    [canonico, revocadoPor],
  );
  return (res.rowCount ?? 0) > 0;
}

// Echar a UN aparato: el móvil que se perdió. La persona sigue entrando desde
// los demás, y desde ése habrá que volver a pedir el código.
export async function revocarDispositivo(
  cliente: Lector,
  uuid: string,
  revocadoPor: string,
): Promise<boolean> {
  const res = await cliente.query(
    `UPDATE operador_dispositivo SET revocado_en = now(), revocado_por = $2
     WHERE uuid_dispositivo = $1 AND revocado_en IS NULL`,
    [uuid.toLowerCase(), revocadoPor],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function aparatosDe(
  cliente: Lector,
  telefono: string,
): Promise<Array<{ uuid: string; creado_en: string; visto_en: string | null }>> {
  const canonico = normalizarTelefono(telefono);
  if (canonico === null) return [];
  const res = await cliente.query(
    `SELECT uuid_dispositivo AS uuid, creado_en, visto_en
     FROM operador_dispositivo
     WHERE telefono = $1 AND revocado_en IS NULL
     ORDER BY visto_en DESC NULLS LAST`,
    [canonico],
  );
  return res.rows;
}
