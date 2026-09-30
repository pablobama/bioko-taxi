// ¿Por qué no le sale «Trabajo de campo» a esta persona? (30/09)
//
// EL LÍO, y es del diseño, no de quien lo usa: el papel de agente de campo vive
// en DOS sitios distintos que no se hablan entre sí.
//
//   - `conductor.es_agente` .......... va por PERSONA (su ficha de taxista)
//   - `perfil_cliente.es_agente` ..... va por DISPOSITIVO (el teléfono)
//
// Así que un mismo número de teléfono dado de alta como cliente Y como taxista
// tiene dos banderas, y marcar una no enciende la otra. Y si además usa dos
// teléfonos, el perfil de cliente de uno no sabe nada del otro.
//
// Esto lo mira y lo dice: qué fichas tiene ese número, qué dispositivos, cuál es
// de qué tipo, y dónde está puesta —o no— la bandera. Con eso se sabe en un
// vistazo si hay que marcar la otra, o si se marcó el teléfono equivocado.
//
// SOLO LECTURA.
//
// USO:  npx tsx scripts/diagnostico-agente.ts 222410986

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';

if (process.env.BD_URL === undefined) {
  const env = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(env)) process.loadEnvFile(env);
}

const BUSCADO = process.argv[2];

// Se compara por los últimos nueve dígitos: da igual que esté guardado con
// prefijo, con espacios o sin nada.
function soloDigitos(t: string | null): string {
  return (t ?? '').replace(/\D/g, '').slice(-9);
}

async function main(): Promise<void> {
  if (!BUSCADO) {
    console.log('Falta el teléfono. Uso: npx tsx scripts/diagnostico-agente.ts 222410986');
    process.exit(1);
  }
  const url = urlBaseDatos();
  const local = /localhost|127\.0\.0\.1/.test(url);
  console.log(`Base: ${local ? 'LOCAL (desarrollo)' : `PRODUCCIÓN (${url.replace(/^[^@]*@/, '').split('/')[0]})`}`);
  console.log(`Buscando el teléfono ${BUSCADO}\n`);

  const pool = new pg.Pool({ connectionString: urlBaseDatos(), keepAlive: true, max: 2 });
  const clave = soloDigitos(BUSCADO);

  // --- Como TAXISTA -------------------------------------------------------
  const conductores = await pool.query(
    `SELECT c.id, c.nombre, c.telefono, c.es_agente, c.estado_verificacion
     FROM conductor c
     WHERE right(regexp_replace(c.telefono, '\\D', '', 'g'), 9) = $1`,
    [clave],
  );
  console.log('='.repeat(62));
  console.log('COMO TAXISTA\n');
  if (conductores.rowCount === 0) {
    console.log('  No hay ninguna ficha de taxista con ese teléfono.');
  }
  for (const c of conductores.rows) {
    console.log(`  Ficha ${c.id} · ${c.nombre} · ${c.telefono} · ${c.estado_verificacion}`);
    console.log(`  Agente de campo: ${c.es_agente ? 'SÍ' : 'NO'}`);
    const suyos = await pool.query(
      `SELECT id, tipo, uuid_persistente, ultimo_heartbeat
       FROM dispositivo WHERE conductor_id = $1 ORDER BY ultimo_heartbeat DESC NULLS LAST`,
      [c.id],
    );
    console.log(`  Sus teléfonos (${suyos.rowCount}):`);
    for (const d of suyos.rows) {
      console.log(`    dispositivo ${d.id} · tipo ${d.tipo}`
        + ` · último uso ${d.ultimo_heartbeat ?? 'nunca'}`);
    }
    if (!c.es_agente) {
      console.log('\n  → Para que le salga en la aplicación del TAXISTA hay que');
      console.log('    marcarlo en su ficha de CONDUCTOR, no en la de pasajero.');
    }
  }

  // --- Como PASAJERO ------------------------------------------------------
  const perfiles = await pool.query(
    `SELECT pc.dispositivo_id, pc.nombre, pc.telefono, pc.es_agente,
            d.tipo, d.uuid_persistente, d.ultimo_heartbeat, d.conductor_id
     FROM perfil_cliente pc
     JOIN dispositivo d ON d.id = pc.dispositivo_id
     WHERE right(regexp_replace(coalesce(pc.telefono, ''), '\\D', '', 'g'), 9) = $1
     ORDER BY d.ultimo_heartbeat DESC NULLS LAST`,
    [clave],
  );
  console.log(`\n${'='.repeat(62)}`);
  console.log('COMO PASAJERO\n');
  if (perfiles.rowCount === 0) {
    console.log('  No hay ningún perfil de pasajero con ese teléfono.');
  }
  for (const p of perfiles.rows) {
    console.log(`  Dispositivo ${p.dispositivo_id} · ${p.nombre ?? 'sin nombre'} · tipo ${p.tipo}`);
    console.log(`  Agente de campo: ${p.es_agente ? 'SÍ' : 'NO'}`
      + ` · último uso ${p.ultimo_heartbeat ?? 'nunca'}`);
    if (p.conductor_id !== null) {
      console.log(`  OJO: este mismo dispositivo está atado al taxista ${p.conductor_id}.`);
    }
  }

  // --- Lo que hay que saber ----------------------------------------------
  console.log(`\n${'='.repeat(62)}`);
  console.log('QUÉ SIGNIFICA\n');
  const taxistaAgente = conductores.rows.some((c) => c.es_agente);
  const pasajeroAgente = perfiles.rows.some((p) => p.es_agente);

  if (!taxistaAgente && !pasajeroAgente) {
    console.log('  La bandera NO está puesta en ninguno de los dos sitios. Por eso');
    console.log('  no le sale el botón: no es un problema de la aplicación.');
  } else if (taxistaAgente && !pasajeroAgente) {
    console.log('  Está puesta SOLO como taxista. Le saldrá abriendo la aplicación');
    console.log('  del TAXISTA (menú flotante o Tus datos), no la del pasajero.');
  } else if (pasajeroAgente && !taxistaAgente) {
    console.log('  Está puesta SOLO como pasajero, y ADEMÁS va por dispositivo:');
    console.log('  le saldrá en el teléfono marcado arriba y en ningún otro.');
  } else {
    console.log('  Está puesta en los dos. Si aun así no le sale, es que la');
    console.log('  aplicación tiene una sesión vieja: se relee al volver a ella o');
    console.log('  cada dos minutos, así que cerrarla y abrirla lo resuelve.');
  }
  console.log('\n  Y en los dos casos hay que estar en la versión desplegada del');
  console.log('  30/09 o posterior: hasta entonces el botón solo estaba en el menú');
  console.log('  flotante de la esquina, no en el perfil.');

  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
