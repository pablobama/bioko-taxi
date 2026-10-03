// ¿Quién se ha registrado el último? (02/10)
//
// SOLO LECTURA. No toca nada. Está para mirar ANTES de desregistrar a nadie,
// porque «el último» es una suposición hasta que se ve el nombre y la hora: en
// esta base conviven taxistas, pasajeros y los restos de las pruebas, y pulsar
// un borrado sobre una suposición es como se borra a la persona equivocada.
//
// Enseña las tres cosas por separado, porque son tres cosas distintas:
//
//   · ALTAS DE TAXISTA ...... fichas de `conductor`, por `fecha_alta`
//   · ALTAS DE PASAJERO ..... filas de `perfil_cliente`, por `creado_en`
//   · APARATOS .............. filas de `dispositivo`, por `creado_en`
//
// Un aparato nuevo sin ficha nueva es alguien que ya existía y ha vuelto a
// entrar; una ficha nueva es alguien que no estaba. Mezclarlos es lo que hace
// que «el último registrado» signifique dos cosas a la vez.
//
// USO:  npx tsx scripts/ultimo-registro.ts        (los 5 últimos de cada cosa)
//       npx tsx scripts/ultimo-registro.ts 10

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';

if (process.env.BD_URL === undefined) {
  const env = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(env)) process.loadEnvFile(env);
}

const CUANTOS = Number(process.argv[2] ?? 5);

function momento(valor: string | null): string {
  if (!valor) return 'nunca';
  return new Date(valor).toISOString().replace('T', ' ').slice(0, 19);
}

async function main(): Promise<void> {
  const url = urlBaseDatos();
  const local = /localhost|127\.0\.0\.1/.test(url);
  console.log(`Base: ${local ? 'LOCAL (desarrollo)' : `PRODUCCIÓN (${url.replace(/^[^@]*@/, '').split('/')[0]})`}`);
  console.log(`Los ${CUANTOS} últimos de cada cosa\n`);

  const pool = new pg.Pool({ connectionString: url, keepAlive: true, max: 2 });

  console.log('='.repeat(70));
  console.log('ALTAS DE TAXISTA (lo más reciente arriba)\n');
  const conductores = await pool.query(
    `SELECT c.id, c.nombre, c.telefono, c.fecha_alta, c.estado_verificacion,
            c.telefono_verificado_en,
            v.matricula,
            (SELECT count(*) FROM solicitud s WHERE s.conductor_id = c.id)::int AS viajes,
            (SELECT count(*) FROM dispositivo d WHERE d.conductor_id = c.id)::int AS aparatos
     FROM conductor c
     LEFT JOIN vehiculo v ON v.conductor_id = c.id
     ORDER BY c.fecha_alta DESC
     LIMIT $1`,
    [CUANTOS],
  );
  for (const c of conductores.rows) {
    console.log(`  conductor ${c.id} · ${c.nombre} · ${c.telefono}`);
    console.log(`    alta ${momento(c.fecha_alta)} · ${c.estado_verificacion}`
      + ` · teléfono ${c.telefono_verificado_en ? 'verificado' : 'SIN verificar'}`);
    console.log(`    matrícula ${c.matricula ?? '—'} · ${c.viajes} viajes · ${c.aparatos} aparatos`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('ALTAS DE PASAJERO (lo más reciente arriba)\n');
  const pasajeros = await pool.query(
    `SELECT p.id, p.dispositivo_id, p.nombre, p.telefono, p.correo, p.creado_en,
            p.telefono_vigente, p.telefono_verificado_en,
            d.strikes, d.bloqueado_en, d.ultimo_heartbeat,
            (SELECT count(*) FROM solicitud s WHERE s.dispositivo_cliente_id = d.id)::int AS viajes
     FROM perfil_cliente p
     JOIN dispositivo d ON d.id = p.dispositivo_id
     ORDER BY p.creado_en DESC
     LIMIT $1`,
    [CUANTOS],
  );
  for (const p of pasajeros.rows) {
    console.log(`  perfil ${p.id} · aparato ${p.dispositivo_id}`
      + ` · ${p.nombre ?? '(sin nombre)'} · ${p.telefono ?? p.correo}`);
    console.log(`    alta ${momento(p.creado_en)} · último uso ${momento(p.ultimo_heartbeat)}`);
    console.log(`    número ${p.telefono_vigente ? 'vigente' : 'NO vigente'}`
      + ` · ${p.telefono_verificado_en ? 'verificado' : 'SIN verificar'}`
      + ` · ${p.viajes} viajes · ${p.strikes} avisos`
      + `${p.bloqueado_en ? ' · BLOQUEADO' : ''}`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('APARATOS NUEVOS (lo más reciente arriba)\n');
  const aparatos = await pool.query(
    `SELECT d.id, d.tipo, d.creado_en, d.ultimo_heartbeat, d.conductor_id,
            c.nombre AS conductor, p.nombre AS pasajero, p.telefono AS tel_pasajero
     FROM dispositivo d
     LEFT JOIN conductor c ON c.id = d.conductor_id
     LEFT JOIN perfil_cliente p ON p.dispositivo_id = d.id
     ORDER BY d.creado_en DESC
     LIMIT $1`,
    [CUANTOS],
  );
  for (const d of aparatos.rows) {
    const quien = d.tipo === 'conductor'
      ? `taxista ${d.conductor ?? '?'} (conductor ${d.conductor_id})`
      : `pasajero ${d.pasajero ?? '(sin perfil)'}${d.tel_pasajero ? ` · ${d.tel_pasajero}` : ''}`;
    console.log(`  aparato ${d.id} · ${d.tipo} · ${quien}`);
    console.log(`    creado ${momento(d.creado_en)} · último uso ${momento(d.ultimo_heartbeat)}`);
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log('Para desregistrar a uno de éstos:');
  console.log('  npx tsx scripts/desregistrar.ts <id del aparato>        (ensayo)');
  console.log('  npx tsx scripts/desregistrar.ts <id del aparato> --hazlo');

  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
