// Unifica dos taxistas que son la misma persona (migración 061).
//
// El caso que lo pidió: quien opera esto tiene su taxista de verdad —Pablo,
// con su teléfono y su coche— y el «taxi del operador» que prepara
// `/api/operador/mi-taxi` para conducir desde la pestaña del operador. Los
// viajes, el recorrido y las horas de servicio estaban repartidos entre los
// dos, y ninguno tenía los números de verdad.
//
// Uso (desde /servidor, con el .env de la base a la que se apunta):
//
//   npx tsx scripts/unificar-conductor.ts
//       Lista los taxistas, para saber qué número es cada uno. Solo lee.
//
//   npx tsx scripts/unificar-conductor.ts --de 12 --a 3
//       SIMULA la unificación del 12 en el 3: hace todo dentro de una
//       transacción, cuenta lo que ha hecho y la DESHACE. No cambia nada.
//
//   npx tsx scripts/unificar-conductor.ts --de 12 --a 3 --aplicar
//       Lo hace de verdad. Mismo informe; esta vez se queda.
//
// Contra PRODUCCIÓN hay que añadir además --produccion a cada orden: sin él
// el script se niega a tocar una base remota.
//
// QUÉ SE PASA Y CÓMO, y por qué no es un «UPDATE conductor_id» a secas:
//
//   - Viajes y solicitudes: tal cual. Son suyos.
//   - Recorrido (`rastro`) y minutos con señal (`senal`): los puntos se pasan,
//     SALVO los que caen en un rato en que el destino también estaba en
//     servicio. Dos móviles grabando a la vez son dos recorridos; mezclarlos
//     en uno salta de un teléfono a otro cada quince segundos y se inventa
//     kilómetros. Esos se dejan donde estaban y se cuentan.
//   - Horas de servicio: el historial de estados es de SOLO INSERCIÓN (un
//     disparador lo impide todo lo demás, y con razón: es la auditoría). No se
//     puede mover; se AÑADE al destino. Y solo lo que el destino no tenía: los
//     ratos en servicio del origen, menos los que ya cubría el destino. Así las
//     horas suman la unión de los dos turnos, nunca el doble.
//   - Monedero: también de solo inserción. Si al origen le queda saldo, se
//     traspasa con dos apuntes de ajuste —uno resta, el otro suma— con la
//     misma clave de idempotencia de base, para que repetir el script no lo
//     traspase dos veces.
//   - Dispositivos: pasan al destino. El móvil o la pestaña del operador
//     quedan siendo el taxista de destino.
//   - «Recibir de toda la isla»: si el origen lo tenía, lo hereda el destino,
//     porque es el taxi con el que el operador prueba desde su oficina.
//   - El origen NO se borra —el historial y el monedero lo referencian— y se
//     marca `unificado_en`, que es lo que impide que el conmutador de papeles
//     lo resucite.
//
// No se unifica un taxista en servicio o con un viaje abierto: mover un turno
// o un viaje vivos a mitad es buscarse un estado imposible. Se dice qué falta y
// no se toca nada.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { crearPool } from '../src/bd/conexion.js';
import { urlBaseDatos } from '../src/bd/migrar.js';

// El `.env` del servidor, se lance desde donde se lance (como revisar-turno).
if (process.env.BD_URL === undefined) {
  const env = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(env)) process.loadEnvFile(env);
}

const argumentos = process.argv.slice(2);
const valor = (nombre: string): number | null => {
  const i = argumentos.indexOf(nombre);
  if (i < 0) return null;
  const n = Number(argumentos[i + 1]);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const deId = valor('--de');
const aId = valor('--a');
const aplicar = argumentos.includes('--aplicar');

const url = urlBaseDatos();
const local = /localhost|127\.0\.0\.1/.test(url);
console.log(`Base de datos: ${local ? 'LOCAL (desarrollo)' : 'REMOTA (producción)'}`);

// A una base remota solo con `--produccion`, escrito a mano. El `.env` del
// servidor apunta a producción y se carga solo si no hay otra base indicada;
// sin este cerrojo, lanzar el script para probarlo en local sin acordarse de
// BD_URL lo lanza contra producción —pasó al escribirlo, en modo simulación y
// sin llegar a cambiar nada, pero pasó—. Un informe de solo lectura se puede
// permitir ese despiste; algo que mueve datos, no.
if (!local && !argumentos.includes('--produccion')) {
  console.error(
    '\nEsta es la base de PRODUCCIÓN. Para usarla, añade --produccion a la orden.\n'
    + 'Para probar en local: BD_URL=postgres://taxi:taxi@localhost:5433/taxi npx tsx scripts/unificar-conductor.ts …',
  );
  process.exit(1);
}

// La misma conexión que usa el servidor, con lo que diga su BD_URL.
const pool = crearPool();

interface Tramo { inicio: Date; fin: Date }

// Los ratos en servicio de un taxista, del historial de estados. La misma
// cuenta que usan las estadísticas (rastro.ts): de cada cambio al siguiente,
// todo lo que no sea DESCONECTADO.
async function tramosEnServicio(cliente: pg.ClientBase, conductorId: number): Promise<Tramo[]> {
  const res = await cliente.query(
    `WITH marcas AS (
       SELECT estado_nuevo, COALESCE(ocurrio_en, creado_en) AS en, id
       FROM transicion WHERE ambito = 'conductor' AND conductor_id = $1
     )
     SELECT inicio, COALESCE(fin, now()) AS fin FROM (
       SELECT estado_nuevo, en AS inicio, lead(en) OVER (ORDER BY en, id) AS fin FROM marcas
     ) t
     WHERE estado_nuevo <> 'DESCONECTADO'
     ORDER BY inicio`,
    [conductorId],
  );
  // Tramos seguidos (DISPONIBLE → OCUPADO → DISPONIBLE…) se funden en uno.
  const unidos: Tramo[] = [];
  for (const f of res.rows) {
    const t = { inicio: new Date(f.inicio), fin: new Date(f.fin) };
    const ultimo = unidos[unidos.length - 1];
    if (ultimo && t.inicio.getTime() <= ultimo.fin.getTime()) {
      if (t.fin > ultimo.fin) ultimo.fin = t.fin;
    } else {
      unidos.push(t);
    }
  }
  return unidos;
}

// Lo de `a` que no cubre `b`: la resta de dos listas de intervalos.
function restar(a: Tramo[], b: Tramo[]): Tramo[] {
  const resultado: Tramo[] = [];
  for (const t of a) {
    let trozos: Tramo[] = [{ ...t }];
    for (const quitar of b) {
      const siguientes: Tramo[] = [];
      for (const p of trozos) {
        if (quitar.fin <= p.inicio || quitar.inicio >= p.fin) {
          siguientes.push(p);
          continue;
        }
        if (quitar.inicio > p.inicio) siguientes.push({ inicio: p.inicio, fin: quitar.inicio });
        if (quitar.fin < p.fin) siguientes.push({ inicio: quitar.fin, fin: p.fin });
      }
      trozos = siguientes;
    }
    resultado.push(...trozos.filter((p) => p.fin.getTime() - p.inicio.getTime() >= 1000));
  }
  return resultado;
}

const horas = (tramos: Tramo[]) =>
  (tramos.reduce((s, t) => s + (t.fin.getTime() - t.inicio.getTime()), 0) / 3_600_000).toFixed(1);

async function listar(): Promise<void> {
  const res = await pool.query(
    `SELECT c.id, c.nombre, c.telefono, c.recibe_en_cualquier_zona AS toda_isla,
            c.unificado_en,
            (SELECT string_agg(matricula, ', ') FROM vehiculo v WHERE v.conductor_id = c.id) AS coche,
            (SELECT count(*) FROM viaje v WHERE v.conductor_id = c.id)::int AS viajes,
            (SELECT count(*) FROM rastro r WHERE r.conductor_id = c.id)::int AS puntos
     FROM conductor c
     ORDER BY viajes DESC, c.id
     LIMIT 40`,
  );
  console.log('\nTaxistas (los 40 con más viajes). El «taxi del operador» suele llamarse');
  console.log('así y tener «toda_isla» en true.\n');
  console.table(res.rows);
  console.log('Después: npx tsx scripts/unificar-conductor.ts --de <operador> --a <pablo>');
}

async function unificar(de: number, a: number): Promise<void> {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');

    const ambos = await cliente.query(
      `SELECT id, nombre, telefono, recibe_en_cualquier_zona, unificado_en
       FROM conductor WHERE id = ANY($1) FOR UPDATE`,
      [[de, a]],
    );
    const origen = ambos.rows.find((f) => Number(f.id) === de);
    const destino = ambos.rows.find((f) => Number(f.id) === a);
    if (!origen || !destino) throw new Error(`No existe el taxista ${!origen ? de : a}.`);
    if (destino.unificado_en !== null) {
      throw new Error(`El destino (${a}) ya está unificado en ${destino.unificado_en}: unifica en ese.`);
    }
    if (origen.unificado_en !== null && Number(origen.unificado_en) !== a) {
      throw new Error(`El origen (${de}) ya está unificado en ${origen.unificado_en}.`);
    }
    console.log(`\nDe:  ${origen.id} · ${origen.nombre} · ${origen.telefono}`);
    console.log(`A:   ${destino.id} · ${destino.nombre} · ${destino.telefono}\n`);

    // Nada vivo en el origen.
    const vivo = await cliente.query(
      `SELECT (SELECT estado FROM presencia WHERE conductor_id = $1) AS presencia,
              (SELECT count(*) FROM solicitud WHERE conductor_id = $1
                 AND estado IN ('ACEPTADO', 'EN_CAMINO', 'RECOGIDO'))::int AS abiertos`,
      [de],
    );
    const presencia = vivo.rows[0].presencia as string | null;
    if (presencia !== null && presencia !== 'DESCONECTADO') {
      throw new Error(`El taxista ${de} está en servicio (${presencia}). Sal de servicio con él primero.`);
    }
    if (vivo.rows[0].abiertos > 0) {
      throw new Error(`El taxista ${de} tiene ${vivo.rows[0].abiertos} viaje(s) abierto(s). Ciérralos primero.`);
    }

    // --- Horas de servicio ------------------------------------------------
    const suyos = await tramosEnServicio(cliente, de);
    const deDestino = await tramosEnServicio(cliente, a);
    const nuevos = restar(suyos, deDestino);
    for (const t of nuevos) {
      await cliente.query(
        `INSERT INTO transicion (ambito, conductor_id, estado_anterior, estado_nuevo, actor, origen_evento, ocurrio_en)
         VALUES ('conductor', $1, 'DESCONECTADO', 'DISPONIBLE', 'operador', $3, $2)`,
        [a, t.inicio, `unificacion_desde_${de}`],
      );
      await cliente.query(
        `INSERT INTO transicion (ambito, conductor_id, estado_anterior, estado_nuevo, actor, origen_evento, ocurrio_en)
         VALUES ('conductor', $1, 'DISPONIBLE', 'DESCONECTADO', 'operador', $3, $2)`,
        [a, t.fin, `unificacion_desde_${de}`],
      );
    }
    console.log(`Horas de servicio del origen:        ${horas(suyos)} h en ${suyos.length} turno(s)`);
    console.log(`  de ellas, ya cubiertas por destino: ${(Number(horas(suyos)) - Number(horas(nuevos))).toFixed(1)} h (no se duplican)`);
    console.log(`  añadidas al destino:                ${horas(nuevos)} h en ${nuevos.length} tramo(s)`);

    // --- Viajes, solicitudes y ofertas -------------------------------------
    const solicitudes = await cliente.query('UPDATE solicitud SET conductor_id = $2 WHERE conductor_id = $1', [de, a]);
    const viajes = await cliente.query('UPDATE viaje SET conductor_id = $2 WHERE conductor_id = $1', [de, a]);
    const ofertas = await cliente.query(
      `UPDATE oferta o SET conductor_id = $2
       WHERE o.conductor_id = $1
         AND NOT EXISTS (SELECT 1 FROM oferta x WHERE x.solicitud_id = o.solicitud_id AND x.conductor_id = $2)`,
      [de, a],
    );
    console.log(`Viajes:                              ${viajes.rowCount}`);
    console.log(`Solicitudes:                         ${solicitudes.rowCount}`);
    console.log(`Ofertas:                             ${ofertas.rowCount}`);

    // --- Recorrido y señal --------------------------------------------------
    // Fuera de los ratos en que el destino ya estaba en servicio: ahí había
    // DOS teléfonos grabando.
    const tramosDestino = JSON.stringify(deDestino.map((t) => [t.inicio.toISOString(), t.fin.toISOString()]));
    const puntos = await cliente.query(
      `UPDATE rastro r SET conductor_id = $2
       WHERE r.conductor_id = $1
         AND NOT EXISTS (SELECT 1 FROM rastro x WHERE x.conductor_id = $2 AND x.creado_en = r.creado_en)
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements($3::jsonb) t
           WHERE r.creado_en BETWEEN (t->>0)::timestamptz AND (t->>1)::timestamptz
         )`,
      [de, a, tramosDestino],
    );
    const quedan = await cliente.query('SELECT count(*)::int AS n FROM rastro WHERE conductor_id = $1', [de]);
    console.log(`Puntos de recorrido pasados:         ${puntos.rowCount}`);
    console.log(`  dejados en el origen (solapados):  ${quedan.rows[0].n}`);

    // Los minutos de los ratos solapados se quedan en el origen por lo mismo
    // que sus puntos: son del otro teléfono.
    const senal = await cliente.query(
      `INSERT INTO senal (conductor_id, minuto, latidos, con_posicion, mejor_precision_m)
       SELECT $2, s.minuto, s.latidos, s.con_posicion, s.mejor_precision_m
       FROM senal s
       WHERE s.conductor_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements($3::jsonb) t
           WHERE s.minuto BETWEEN (t->>0)::timestamptz AND (t->>1)::timestamptz
         )
       ON CONFLICT DO NOTHING`,
      [de, a, tramosDestino],
    );
    console.log(`Minutos con señal:                   ${senal.rowCount}`);

    // --- Monedero -----------------------------------------------------------
    const saldo = await cliente.query(
      'SELECT COALESCE(saldo_xaf, 0)::bigint AS saldo FROM saldo_monedero WHERE conductor_id = $1', [de],
    );
    const saldoOrigen = Number(saldo.rows[0]?.saldo ?? 0);
    if (saldoOrigen !== 0) {
      const monederos = await cliente.query(
        'SELECT conductor_id, id FROM monedero WHERE conductor_id = ANY($1)', [[de, a]],
      );
      const monOrigen = monederos.rows.find((f) => Number(f.conductor_id) === de)?.id;
      let monDestino = monederos.rows.find((f) => Number(f.conductor_id) === a)?.id;
      if (!monDestino) {
        monDestino = (await cliente.query(
          'INSERT INTO monedero (conductor_id) VALUES ($1) RETURNING id', [a],
        )).rows[0].id;
      }
      await cliente.query(
        `INSERT INTO apunte (monedero_id, tipo, importe_xaf, clave_idempotencia)
         VALUES ($1, 'ajuste', $2, $3) ON CONFLICT (clave_idempotencia) DO NOTHING`,
        [monOrigen, -saldoOrigen, `unificacion-${de}-${a}-sale`],
      );
      await cliente.query(
        `INSERT INTO apunte (monedero_id, tipo, importe_xaf, clave_idempotencia)
         VALUES ($1, 'ajuste', $2, $3) ON CONFLICT (clave_idempotencia) DO NOTHING`,
        [monDestino, saldoOrigen, `unificacion-${de}-${a}-entra`],
      );
    }
    console.log(`Saldo traspasado:                    ${saldoOrigen} XAF`);

    // --- Dispositivos, ajustes y la marca -----------------------------------
    const dispositivos = await cliente.query(
      "UPDATE dispositivo SET conductor_id = $2 WHERE conductor_id = $1 AND tipo = 'conductor'", [de, a],
    );
    console.log(`Dispositivos (móvil/pestaña):        ${dispositivos.rowCount}`);
    if (origen.recibe_en_cualquier_zona) {
      await cliente.query('UPDATE conductor SET recibe_en_cualquier_zona = true WHERE id = $1', [a]);
      console.log('«Recibir de toda la isla»:           heredado por el destino');
    }
    await cliente.query(
      'UPDATE conductor SET unificado_en = $2, recibe_en_cualquier_zona = false WHERE id = $1', [de, a],
    );

    if (aplicar) {
      await cliente.query('COMMIT');
      console.log(`\nHECHO. El taxista ${de} queda unificado en ${a}.`);
    } else {
      await cliente.query('ROLLBACK');
      console.log('\nSIMULACIÓN: no se ha cambiado nada. Para hacerlo, repite con --aplicar.');
    }
  } catch (error) {
    await cliente.query('ROLLBACK').catch(() => undefined);
    console.error(`\nNo se ha cambiado nada: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    cliente.release();
  }
}

try {
  if (deId === null || aId === null) {
    await listar();
  } else if (deId === aId) {
    console.error('Origen y destino son el mismo taxista.');
    process.exitCode = 1;
  } else {
    await unificar(deId, aId);
  }
} finally {
  await pool.end();
}
