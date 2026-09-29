// ¿Por qué no le suena al taxista que hay una carrera? (29/09)
//
// El aviso ya existe desde la migración 058 y tiene DOS caminos: la conexión
// abierta —instantánea y sin gastar datos— y, cuando no la hay, la notificación
// web, que es la que suena con la aplicación cerrada y el móvil en el bolsillo.
//
// Cuando alguien dice «no me avisa», la causa es una de estas cuatro, y las
// cuatro están guardadas en la base. No hace falta adivinar:
//
//   1. NO HABÍA A QUIÉN AVISAR. El reparto va por oleadas: el barrio, luego los
//      vecinos, luego la isla. Si no hay taxistas conectados, no se emite nada
//      y el pasajero oye «no hay taxi». Eso no es un fallo del aviso.
//   2. NO HAY BUZÓN. El aviso con la aplicación cerrada necesita que el taxista
//      haya dado permiso de notificaciones, cosa que se le pide al entrar en
//      servicio. Sin buzón guardado no hay a dónde mandarlo.
//   3. SE MANDÓ POR LA CONEXIÓN ABIERTA, y esa es la trampa: si el navegador
//      tiene la conexión registrada pero muerta —el teléfono se bloqueó y nadie
//      avisó de que se cayó—, el servidor la da por entregada y NO escala al
//      aviso que sí habría sonado.
//   4. SE MANDÓ Y FALLÓ. Sale en el último error del evento.
//
// SOLO LECTURA.
//
// USO:  npx tsx scripts/diagnostico-avisos.ts 7

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';

if (process.env.BD_URL === undefined) {
  const env = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(env)) process.loadEnvFile(env);
}

const DIAS = Number(process.argv[2] ?? 7);

async function main(): Promise<void> {
  const url = urlBaseDatos();
  const local = /localhost|127\.0\.0\.1/.test(url);
  console.log(`Base: ${local ? 'LOCAL (desarrollo)' : `PRODUCCIÓN (${url.replace(/^[^@]*@/, '').split('/')[0]})`}\n`);

  const pool = new pg.Pool({ connectionString: urlBaseDatos(), keepAlive: true, max: 2 });

  // 2. ¿Quién tiene buzón para el aviso con la aplicación cerrada?
  const buzones = await pool.query(
    `SELECT count(DISTINCT d.conductor_id)::int AS con_buzon,
            (SELECT count(*)::int FROM conductor
             WHERE estado_verificacion = 'verificado') AS verificados
     FROM suscripcion_web s
     JOIN dispositivo d ON d.id = s.dispositivo_id
     WHERE d.tipo = 'conductor' AND d.conductor_id IS NOT NULL`,
  );
  const { con_buzon: conBuzon, verificados } = buzones.rows[0];
  console.log('='.repeat(62));
  console.log('¿QUIÉN PUEDE RECIBIR EL AVISO CON LA APLICACIÓN CERRADA?\n');
  console.log(`  Taxistas verificados .................. ${verificados}`);
  console.log(`  De ellos, con el permiso concedido .... ${conBuzon}`);
  if (conBuzon === 0) {
    console.log('\n  ⚠ NINGUNO. El permiso se pide al entrar en servicio; si se');
    console.log('    rechazó una vez, el navegador no lo vuelve a preguntar solo.');
  }

  // 1, 3 y 4. Qué pasó con los avisos de carrera emitidos.
  const avisos = await pool.query(
    `SELECT canal_entregado, count(*)::int AS n
     FROM evento_salida
     WHERE tipo = 'D1_broadcast_solicitud'
       AND creado_en >= now() - make_interval(days => $1)
     GROUP BY 1 ORDER BY 2 DESC`,
    [DIAS],
  );
  const total = avisos.rows.reduce((a, f) => a + f.n, 0);
  console.log(`\n${'='.repeat(62)}`);
  console.log(`AVISOS DE CARRERA EMITIDOS EN ${DIAS} DÍA(S): ${total}\n`);
  if (total === 0) {
    console.log('  No se emitió ninguno. O no hubo peticiones, o no había ningún');
    console.log('  taxista conectado a quien ofrecérselas: eso se ve en `solicitud`,');
    console.log('  no aquí.');
  }
  for (const f of avisos.rows) {
    const como = {
      sse: 'por la conexión abierta (la aplicación estaba abierta)',
      web: 'por notificación web (sonó con la aplicación cerrada)',
      fcm: 'por FCM (app Android)',
      sse_sin_conexion: 'NO se entregó: no había conexión abierta',
      abandonado: 'NO se entregó: se agotaron los reintentos',
      web_sin_suscripcion: 'NO sonó: el taxista no tiene el permiso concedido',
      web_suscripcion_caducada: 'NO sonó: el buzón del navegador ya no existe',
    }[f.canal_entregado as string] ?? f.canal_entregado ?? 'sin entregar todavía';
    console.log(`  ${String(f.n).padStart(5)}  ${como}`);
  }

  const fallados = await pool.query(
    `SELECT ultimo_error, count(*)::int AS n
     FROM evento_salida
     WHERE tipo = 'D1_broadcast_solicitud' AND ultimo_error IS NOT NULL
       AND creado_en >= now() - make_interval(days => $1)
     GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
    [DIAS],
  );
  if ((fallados.rowCount ?? 0) > 0) {
    console.log('\n  Errores al entregar:\n');
    for (const f of fallados.rows) {
      console.log(`    ${String(f.n).padStart(4)} · ${String(f.ultimo_error).slice(0, 90)}`);
    }
  }

  // Y la trampa del punto 3, dicha con números: cuántos se dieron por
  // entregados por la conexión abierta sin que el taxista contestara nada.
  const mudos = await pool.query(
    `SELECT count(*)::int AS n
     FROM evento_salida e
     WHERE e.tipo = 'D1_broadcast_solicitud'
       AND e.canal_entregado = 'sse'
       AND e.creado_en >= now() - make_interval(days => $1)
       AND NOT EXISTS (
         SELECT 1 FROM oferta o
         WHERE o.conductor_id = e.conductor_id
           AND o.respondida_en IS NOT NULL
           AND o.enviada_en BETWEEN e.creado_en - interval '1 minute'
                              AND e.creado_en + interval '3 minutes')`,
    [DIAS],
  );
  console.log(`\n${'='.repeat(62)}`);
  console.log('LA TRAMPA: entregado por conexión abierta, y nadie contestó\n');
  console.log(`  ${mudos.rows[0].n} de los entregados «por la conexión abierta» no`);
  console.log('  tuvieron ninguna respuesta del taxista. Si ese número es alto, la');
  console.log('  conexión estaba registrada pero muerta —el teléfono se bloqueó y');
  console.log('  nadie avisó de que se cayó—, el servidor la dio por buena y NO');
  console.log('  escaló al aviso que sí habría sonado. Ese es el arreglo que hay');
  console.log('  que hacer, y este número dice si hace falta.');

  await pool.end();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
