// Ejecutor de migraciones. Sin magia: ficheros SQL numerados en /migraciones,
// pares NNN_nombre.up.sql / NNN_nombre.down.sql, registro en la tabla
// _migracion. Cada migración corre en su propia transacción.
//
// Uso:
//   tsx src/bd/migrar.ts aplicar        aplica todas las pendientes
//   tsx src/bd/migrar.ts revertir [n]   revierte las últimas n (por defecto 1; «todo» las revierte todas)
//   tsx src/bd/migrar.ts estado         lista aplicadas y pendientes

import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const DIRECTORIO_MIGRACIONES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'migraciones',
);

// Bloqueo consultivo para que dos procesos no migren a la vez.
const CANDADO_MIGRACIONES = 74_2401;

export function urlBaseDatos(): string {
  return process.env.BD_URL ?? 'postgres://taxi:taxi@localhost:5433/taxi';
}

interface Migracion {
  nombre: string; // p. ej. «001_extensiones_y_utilidades»
  subir: string;  // ruta del .up.sql
  bajar: string;  // ruta del .down.sql
}

async function listarMigraciones(): Promise<Migracion[]> {
  const ficheros = await readdir(DIRECTORIO_MIGRACIONES);
  const nombres = ficheros
    .filter((f) => f.endsWith('.up.sql'))
    .map((f) => f.replace(/\.up\.sql$/, ''))
    .sort();
  return nombres.map((nombre) => {
    const bajar = `${nombre}.down.sql`;
    if (!ficheros.includes(bajar)) {
      throw new Error(`La migración «${nombre}» no tiene fichero de reversión ${bajar}`);
    }
    return {
      nombre,
      subir: path.join(DIRECTORIO_MIGRACIONES, `${nombre}.up.sql`),
      bajar: path.join(DIRECTORIO_MIGRACIONES, bajar),
    };
  });
}

async function asegurarTablaRegistro(cliente: pg.Client): Promise<void> {
  await cliente.query(`
    CREATE TABLE IF NOT EXISTS _migracion (
      nombre      text PRIMARY KEY,
      aplicada_en timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function nombresAplicadas(cliente: pg.Client): Promise<string[]> {
  const res = await cliente.query('SELECT nombre FROM _migracion ORDER BY nombre');
  return res.rows.map((f) => f.nombre as string);
}

async function ejecutarEnTransaccion(cliente: pg.Client, sql: string): Promise<void> {
  await cliente.query('BEGIN');
  try {
    await cliente.query(sql);
    await cliente.query('COMMIT');
  } catch (error) {
    await cliente.query('ROLLBACK');
    throw error;
  }
}

async function aplicar(cliente: pg.Client): Promise<void> {
  const todas = await listarMigraciones();
  const aplicadas = new Set(await nombresAplicadas(cliente));
  const pendientes = todas.filter((m) => !aplicadas.has(m.nombre));
  if (pendientes.length === 0) {
    console.log('No hay migraciones pendientes.');
    return;
  }
  for (const migracion of pendientes) {
    const sql = await readFile(migracion.subir, 'utf8');
    await ejecutarEnTransaccion(
      cliente,
      `${sql}\nINSERT INTO _migracion (nombre) VALUES (${literal(migracion.nombre)});`,
    );
    console.log(`Aplicada  ${migracion.nombre}`);
  }
}

async function revertir(cliente: pg.Client, cuantas: number): Promise<void> {
  const todas = await listarMigraciones();
  const porNombre = new Map(todas.map((m) => [m.nombre, m]));
  const aplicadas = await nombresAplicadas(cliente);
  const objetivo = aplicadas.slice(-cuantas).reverse();
  if (objetivo.length === 0) {
    console.log('No hay migraciones aplicadas que revertir.');
    return;
  }
  for (const nombre of objetivo) {
    const migracion = porNombre.get(nombre);
    if (!migracion) {
      throw new Error(`La migración aplicada «${nombre}» no existe en el directorio de migraciones`);
    }
    const sql = await readFile(migracion.bajar, 'utf8');
    await ejecutarEnTransaccion(
      cliente,
      `${sql}\nDELETE FROM _migracion WHERE nombre = ${literal(nombre)};`,
    );
    console.log(`Revertida ${nombre}`);
  }
}

async function estado(cliente: pg.Client): Promise<void> {
  const todas = await listarMigraciones();
  const aplicadas = new Set(await nombresAplicadas(cliente));
  for (const m of todas) {
    console.log(`${aplicadas.has(m.nombre) ? 'aplicada ' : 'pendiente'}  ${m.nombre}`);
  }
}

// Escapado de literal SQL para el nombre de migración (solo se usa con
// nombres de fichero controlados por nosotros, pero mejor escapar siempre).
function literal(valor: string): string {
  return `'${valor.replace(/'/g, "''")}'`;
}

async function ejecutarOrden(cliente: pg.Client, orden: string | undefined): Promise<void> {
  // Si el candado lo retiene una sesión muerta (el pooler mata conexiones
  // sin avisar), mejor cortar y reintentar que esperar para siempre: fue
  // exactamente lo que dejó una migración colgada contra Supabase.
  await cliente.query(`SET lock_timeout = '20s'`);
  await cliente.query('SELECT pg_advisory_lock($1)', [CANDADO_MIGRACIONES]);
  await asegurarTablaRegistro(cliente);
  if (orden === 'aplicar') {
    await aplicar(cliente);
  } else if (orden === 'revertir') {
    const argumento = process.argv[3] ?? '1';
    const cuantas = argumento === 'todo' ? Number.MAX_SAFE_INTEGER : Number.parseInt(argumento, 10);
    if (!Number.isInteger(cuantas) || cuantas < 1) {
      throw new Error(`Argumento de revertir no válido: «${argumento}» (usa un número o «todo»)`);
    }
    await revertir(cliente, cuantas);
  } else if (orden === 'estado') {
    await estado(cliente);
  } else {
    throw new Error(`Orden desconocida: «${orden ?? ''}». Usa: aplicar | revertir [n|todo] | estado`);
  }
}

async function principal(): Promise<void> {
  const orden = process.argv[2];
  // Reintentos contra cortes transitorios. El pooler de Supabase mata
  // conexiones a mitad de trabajo («Connection terminated unexpectedly»);
  // cada migración va en su propia transacción, así que retomar desde donde
  // se quedó es seguro. Sin esto, un despliegue entero se cae por un corte
  // de un segundo.
  const INTENTOS = 5;
  for (let intento = 1; ; intento += 1) {
    const cliente = new pg.Client({ connectionString: urlBaseDatos() });
    // Sin oyente, el corte emite 'error' y tumba el proceso entero antes de
    // poder reintentar; la consulta en curso ya rechaza su promesa igual.
    cliente.on('error', () => {});
    try {
      await cliente.connect();
      await ejecutarOrden(cliente, orden);
      return;
    } catch (error) {
      const mensaje = error instanceof Error ? error.message : String(error);
      const transitorio = /connection terminated|econnreset|server closed|lock timeout/i.test(mensaje);
      if (!transitorio || intento >= INTENTOS) throw error;
      console.error(`Conexión cortada (intento ${intento}/${INTENTOS}): ${mensaje}. Reintentando…`);
      await new Promise((r) => { setTimeout(r, 2000); });
    } finally {
      await cliente.end().catch(() => undefined);
    }
  }
}

// Solo actúa como CLI si este fichero es el punto de entrada; otros módulos
// importan urlBaseDatos() sin disparar ninguna orden.
//
// La comparación usa pathToFileURL y no una URL montada a mano: la versión
// manual (`file:///${argv[1]}`) cuadraba en Windows pero en Linux producía
// file:////ruta —cuatro barras—, la comparación daba false y `bd:migrar` se
// convertía en un no-op QUE SALÍA CON ÉXITO. Consecuencia real: en Render
// las migraciones nunca corrieron y cada despliegue con migración nueva
// arrancaba contra un esquema viejo.
const esPuntoDeEntrada =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (esPuntoDeEntrada) {
  principal().catch((error) => {
    // Un AggregateError de conexión (prueba ::1 y 127.0.0.1) trae message
    // vacío: imprimir el objeto entero antes que una línea en blanco.
    console.error(error instanceof Error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}
