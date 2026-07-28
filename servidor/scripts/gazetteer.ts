// Herramienta de administración del gazetteer (paso 4). El catálogo es
// trabajo de campo: se mantiene con estas órdenes contra la base de datos,
// sin desplegar nada. El panel del paso 9 dará interfaz gráfica sobre las
// mismas funciones de dominio.
//
// Uso: tsx scripts/gazetteer.ts <orden> [argumentos]
//
//   zonas                                   lista las zonas
//   listar [zona]                           lista referencias (con id y usos)
//   buscar <texto> [zona]                   búsqueda difusa, como la verá el cliente
//   crear-zona <nombre> [lat lng]           alta de zona
//   adyacencia <zonaA> <zonaB>              declara adyacencia (ambos sentidos)
//   crear <zona> <nombre> <lat> <lng> [alias1|alias2]
//   editar <id> campo=valor ...             campos: nombre, zona, lat, lng
//   alias-anadir <id> <alias>
//   alias-quitar <id> <alias>
//   desactivar <id> | activar <id>
//   importar <fichero.csv>                  alta/actualización masiva
//   exportar <fichero.csv>                  vuelca el catálogo completo
//
// Formato CSV (separador «;», alias separados por «|», cabecera opcional):
//   zona;nombre;lat;lng;alias

import { readFile, writeFile } from 'node:fs/promises';
import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';
import { enTransaccion } from '../src/bd/conexion.js';
import {
  anadirAlias, buscarReferencias, crearZona, declararAdyacencia,
  editarReferencia, guardarReferencia, quitarAlias,
} from '../src/dominio/gazetteer.js';

async function zonaPorNombre(cliente: pg.Pool | pg.ClientBase, nombre: string): Promise<number> {
  const res = await cliente.query('SELECT id FROM zona WHERE nombre = $1', [nombre]);
  if (res.rowCount === 0) {
    const zonas = await cliente.query('SELECT nombre FROM zona ORDER BY nombre');
    throw new Error(
      `No existe la zona «${nombre}». Zonas: ${zonas.rows.map((z) => z.nombre).join(', ') || 'ninguna'}. `
      + 'Créala con: gazetteer crear-zona <nombre> [lat lng]',
    );
  }
  return res.rows[0].id;
}

function numero(texto: string, campo: string): number {
  const valor = Number(texto);
  if (!Number.isFinite(valor)) {
    throw new Error(`El campo ${campo} no es un número: «${texto}»`);
  }
  return valor;
}

async function principal(): Promise<void> {
  const [orden, ...args] = process.argv.slice(2);
  const pool = new pg.Pool({ connectionString: urlBaseDatos() });
  try {
    switch (orden) {
      case 'zonas': {
        const res = await pool.query(
          `SELECT z.id, z.nombre, z.centroide_lat AS lat, z.centroide_lng AS lng,
                  (SELECT count(*) FROM referencia r WHERE r.zona_id = z.id)::int AS referencias,
                  (SELECT string_agg(z2.nombre, ', ') FROM zona_adyacencia ad
                   JOIN zona z2 ON z2.id = ad.zona_adyacente_id
                   WHERE ad.zona_id = z.id) AS adyacentes
           FROM zona z ORDER BY z.nombre`,
        );
        console.table(res.rows);
        break;
      }
      case 'listar': {
        const filtroZona = args[0]
          ? 'WHERE z.nombre = $1'
          : '';
        const res = await pool.query(
          `SELECT r.id, z.nombre AS zona, r.nombre, r.lat, r.lng,
                  r.veces_usada::int AS usos, r.activa,
                  (SELECT string_agg(a.alias, ' | ') FROM referencia_alias a
                   WHERE a.referencia_id = r.id) AS alias
           FROM referencia r JOIN zona z ON z.id = r.zona_id
           ${filtroZona}
           ORDER BY z.nombre, r.nombre`,
          args[0] ? [args[0]] : [],
        );
        console.table(res.rows);
        break;
      }
      case 'buscar': {
        if (!args[0]) throw new Error('Uso: buscar <texto> [zona]');
        const zonaId = args[1] ? await zonaPorNombre(pool, args[1]) : undefined;
        const resultados = await buscarReferencias(pool, args[0], { zonaId });
        console.table(resultados.map((r) => ({
          id: r.id, zona: r.zona, nombre: r.nombre,
          similitud: r.similitud.toFixed(2), usos: r.vecesUsada,
          alias: r.alias.join(' | '),
        })));
        break;
      }
      case 'crear-zona': {
        if (!args[0]) throw new Error('Uso: crear-zona <nombre> [lat lng]');
        const resultado = await enTransaccion(pool, (c) => crearZona(
          c, args[0],
          args[1] !== undefined ? numero(args[1], 'lat') : undefined,
          args[2] !== undefined ? numero(args[2], 'lng') : undefined,
        ));
        console.log(resultado.yaExistia
          ? `La zona «${args[0]}» ya existía (id ${resultado.zonaId}).`
          : `Zona «${args[0]}» creada (id ${resultado.zonaId}).`);
        break;
      }
      case 'adyacencia': {
        if (!args[0] || !args[1]) throw new Error('Uso: adyacencia <zonaA> <zonaB>');
        await enTransaccion(pool, async (c) => {
          const a = await zonaPorNombre(c, args[0]);
          const b = await zonaPorNombre(c, args[1]);
          await declararAdyacencia(c, a, b);
        });
        console.log(`Adyacencia declarada: «${args[0]}» ↔ «${args[1]}».`);
        break;
      }
      case 'crear': {
        if (args.length < 4) throw new Error('Uso: crear <zona> <nombre> <lat> <lng> [alias1|alias2]');
        const resultado = await enTransaccion(pool, async (c) => {
          const zonaId = await zonaPorNombre(c, args[0]);
          return guardarReferencia(c, {
            zonaId,
            nombre: args[1],
            lat: numero(args[2], 'lat'),
            lng: numero(args[3], 'lng'),
            alias: args[4] ? args[4].split('|').map((a) => a.trim()).filter(Boolean) : [],
          });
        });
        console.log(resultado.creada
          ? `Referencia «${args[1]}» creada (id ${resultado.referenciaId}).`
          : `Referencia «${args[1]}» actualizada (id ${resultado.referenciaId}).`);
        break;
      }
      case 'editar': {
        if (args.length < 2) throw new Error('Uso: editar <id> campo=valor ... (campos: nombre, zona, lat, lng)');
        const id = numero(args[0], 'id');
        await enTransaccion(pool, async (c) => {
          const cambios: Record<string, unknown> = {};
          for (const par of args.slice(1)) {
            const [campo, ...resto] = par.split('=');
            const valor = resto.join('=');
            if (campo === 'nombre') cambios.nombre = valor;
            else if (campo === 'zona') cambios.zonaId = await zonaPorNombre(c, valor);
            else if (campo === 'lat') cambios.lat = numero(valor, 'lat');
            else if (campo === 'lng') cambios.lng = numero(valor, 'lng');
            else throw new Error(`Campo desconocido: «${campo}». Válidos: nombre, zona, lat, lng.`);
          }
          await editarReferencia(c, id, cambios);
        });
        console.log(`Referencia ${id} editada.`);
        break;
      }
      case 'alias-anadir': {
        if (args.length < 2) throw new Error('Uso: alias-anadir <id> <alias>');
        await enTransaccion(pool, (c) => anadirAlias(c, numero(args[0], 'id'), args[1]));
        console.log(`Alias «${args[1]}» añadido a la referencia ${args[0]}.`);
        break;
      }
      case 'alias-quitar': {
        if (args.length < 2) throw new Error('Uso: alias-quitar <id> <alias>');
        await enTransaccion(pool, (c) => quitarAlias(c, numero(args[0], 'id'), args[1]));
        console.log(`Alias «${args[1]}» quitado de la referencia ${args[0]}.`);
        break;
      }
      case 'desactivar':
      case 'activar': {
        if (!args[0]) throw new Error(`Uso: ${orden} <id>`);
        await enTransaccion(pool, (c) =>
          editarReferencia(c, numero(args[0], 'id'), { activa: orden === 'activar' }));
        console.log(`Referencia ${args[0]} ${orden === 'activar' ? 'activada' : 'desactivada'}.`);
        break;
      }
      case 'importar': {
        if (!args[0]) throw new Error('Uso: importar <fichero.csv>');
        const contenido = await readFile(args[0], 'utf8');
        const lineas = contenido.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        let creadas = 0;
        let actualizadas = 0;
        await enTransaccion(pool, async (c) => {
          for (const [indice, linea] of lineas.entries()) {
            if (indice === 0 && linea.toLowerCase().startsWith('zona;')) continue; // cabecera
            const campos = linea.split(';');
            if (campos.length < 4) {
              throw new Error(`Línea ${indice + 1} mal formada (se esperan zona;nombre;lat;lng[;alias]): «${linea}»`);
            }
            const zonaId = await zonaPorNombre(c, campos[0].trim());
            const resultado = await guardarReferencia(c, {
              zonaId,
              nombre: campos[1].trim(),
              lat: numero(campos[2], `lat (línea ${indice + 1})`),
              lng: numero(campos[3], `lng (línea ${indice + 1})`),
              alias: (campos[4] ?? '').split('|').map((a) => a.trim()).filter(Boolean),
            });
            if (resultado.creada) creadas += 1; else actualizadas += 1;
          }
        });
        console.log(`Importación completada: ${creadas} creadas, ${actualizadas} actualizadas.`);
        break;
      }
      case 'exportar': {
        if (!args[0]) throw new Error('Uso: exportar <fichero.csv>');
        const res = await pool.query(
          `SELECT z.nombre AS zona, r.nombre, r.lat, r.lng,
                  COALESCE((SELECT string_agg(a.alias, '|') FROM referencia_alias a
                            WHERE a.referencia_id = r.id), '') AS alias
           FROM referencia r JOIN zona z ON z.id = r.zona_id
           WHERE r.activa
           ORDER BY z.nombre, r.nombre`,
        );
        const lineas = ['zona;nombre;lat;lng;alias'];
        for (const fila of res.rows) {
          lineas.push(`${fila.zona};${fila.nombre};${fila.lat};${fila.lng};${fila.alias}`);
        }
        await writeFile(args[0], `${lineas.join('\n')}\n`, 'utf8');
        console.log(`Exportadas ${res.rows.length} referencias a ${args[0]}.`);
        break;
      }
      default:
        throw new Error(
          `Orden desconocida: «${orden ?? ''}». `
          + 'Órdenes: zonas, listar, buscar, crear-zona, adyacencia, crear, editar, '
          + 'alias-anadir, alias-quitar, desactivar, activar, importar, exportar.',
        );
    }
  } finally {
    await pool.end();
  }
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
