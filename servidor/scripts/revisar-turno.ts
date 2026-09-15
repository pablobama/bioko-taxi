// Radiografía de un turno: ¿recogió el sistema bien lo que pasó?
//
// SOLO LECTURA. No escribe ni una fila: está pensado para poder lanzarlo
// contra producción sin pensárselo dos veces.
//
// Uso:
//   npx tsx scripts/revisar-turno.ts                      # taxi del operador, ayer
//   npx tsx scripts/revisar-turno.ts --dia=2026-09-11
//   npx tsx scripts/revisar-turno.ts --conductor=12 --dia=2026-09-11
//   npx tsx scripts/revisar-turno.ts --matricula=GE-OP5
//
// Contra producción, con BD_URL delante. La credencial no se pega en ningún
// sitio del repositorio: la pone quien ejecuta.
//
// Cómo está hecho y por qué importa: los kilómetros, el tiempo y el recorrido
// NO se recalculan a mano aquí. Se le piden a las MISMAS funciones del dominio
// que alimentan el panel del operador y las estadísticas del taxista
// (`recorridoDe`, `actividadDe`). Es la única forma de que este informe
// responda a la pregunta que se le hace —«¿lo recogió bien el sistema?»— y no
// a otra parecida. Al lado de cada cifra se pone el dato crudo con el que
// compararla, para poder discutirla.

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';
import { actividadDe, recorridoDe } from '../src/dominio/rastro.js';
import { distanciaMetros } from '../src/dominio/geo.js';

// El `.env` del servidor, se lance desde donde se lance. Con `--env-file=.env`
// Node lo busca en la carpeta ACTUAL, y lanzarlo desde la raíz del repositorio
// fallaba con «.env: not found» aunque el fichero estuviera en su sitio. Aquí
// se busca junto al propio script. Si BD_URL ya viene puesta, manda esa.
if (process.env.BD_URL === undefined) {
  const env = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
  if (existsSync(env)) process.loadEnvFile(env);
}

const HORAS_MALABO = 1;

function argumento(nombre: string): string | null {
  const encontrado = process.argv.find((a) => a.startsWith(`--${nombre}=`));
  return encontrado === undefined ? null : encontrado.split('=').slice(1).join('=');
}

// El día de MALABO, no el del servidor (que corre en UTC, en Fráncfort).
function diaDeMalabo(iso: string | null): { desde: Date; hasta: Date; etiqueta: string } {
  let medianocheLocal: number;
  if (iso !== null) {
    const [a, m, d] = iso.split('-').map(Number);
    medianocheLocal = Date.UTC(a, m - 1, d);
  } else {
    const local = new Date(Date.now() + HORAS_MALABO * 3_600_000);
    medianocheLocal = Date.UTC(
      local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - 1,
    );
  }
  const desde = new Date(medianocheLocal - HORAS_MALABO * 3_600_000);
  return {
    desde,
    hasta: new Date(desde.getTime() + 24 * 3_600_000),
    etiqueta: new Date(medianocheLocal).toISOString().slice(0, 10),
  };
}

const hora = (d: Date | string | null) => (d === null || d === undefined
  ? '—'
  : new Date(new Date(d).getTime() + HORAS_MALABO * 3_600_000)
    .toISOString().slice(11, 19));

// Con día delante. Hace falta en todo lo que pueda caer fuera del día pedido:
// sin él, un cambio de estado de ayer se lee como de hoy, y el informe parece
// contradecirse —«turno de tres horas» arriba y «0 min en servicio» abajo—.
// Pasó con el primer informe de producción.
const fechaHora = (d: Date | string | null) => (d === null || d === undefined
  ? '—'
  : (() => {
    const iso = new Date(new Date(d).getTime() + HORAS_MALABO * 3_600_000).toISOString();
    return `${iso.slice(8, 10)}/${iso.slice(5, 7)} ${iso.slice(11, 19)}`;
  })());

const duracion = (seg: number) => {
  const m = Math.round(seg / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};

async function principal(): Promise<void> {
  const { desde, hasta, etiqueta } = diaDeMalabo(argumento('dia'));
  const cliente = new pg.Client({ connectionString: urlBaseDatos() });
  await cliente.connect();
  try {
    // --- Quién -------------------------------------------------------------
    const idPedido = argumento('conductor');
    const matriculaPedida = argumento('matricula');
    let conductor: { id: number; nombre: string; matricula: string | null };

    if (idPedido !== null) {
      const r = await cliente.query(
        `SELECT c.id, c.nombre, v.matricula FROM conductor c
         LEFT JOIN vehiculo v ON v.conductor_id = c.id WHERE c.id = $1`,
        [Number(idPedido)],
      );
      if (r.rowCount === 0) throw new Error(`No hay ningún conductor ${idPedido}.`);
      conductor = r.rows[0];
    } else {
      // Por defecto, el taxi del operador: es el que se usa para probar.
      const r = await cliente.query(
        `SELECT c.id, c.nombre, v.matricula FROM conductor c
         LEFT JOIN vehiculo v ON v.conductor_id = c.id
         WHERE ($1::text IS NOT NULL AND v.matricula ILIKE $1)
            OR ($1::text IS NULL AND (c.nombre ILIKE '%operador%' OR v.matricula ILIKE 'GE-OP%'))
         -- El nombre manda sobre la matrícula: en la base de desarrollo hay
         -- fixtures con matrículas GE-OP… que no son el taxi del operador.
         ORDER BY (c.nombre ILIKE '%operador%') DESC, c.id DESC
         LIMIT 1`,
        [matriculaPedida],
      );
      if (r.rowCount === 0) {
        const todos = await cliente.query(
          `SELECT c.id, c.nombre, v.matricula FROM conductor c
           LEFT JOIN vehiculo v ON v.conductor_id = c.id ORDER BY c.id DESC LIMIT 15`,
        );
        console.log('No encontré el taxi del operador. Los últimos conductores son:');
        console.table(todos.rows);
        throw new Error('Vuelve a lanzarlo con --conductor=<id> o --matricula=<placa>.');
      }
      conductor = r.rows[0];
      if (matriculaPedida === null) {
        console.log(`(elegido por nombre/matrícula; si no es este, relánzalo con --conductor=<id>)`);
      }
    }

    console.log('='.repeat(72));
    // Solo si es local o no, nunca la cadena: lleva la contraseña. Pero hay que
    // decirlo, porque un informe vacío de la base de desarrollo se parece
    // demasiado a un turno que no se grabó.
    const esLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(urlBaseDatos());
    console.log(`Base de datos: ${esLocal ? 'LOCAL (desarrollo)' : 'remota (producción)'}`);
    console.log(`TURNO DEL ${etiqueta} (hora de Malabo)`);
    console.log(`Conductor ${conductor.id} · ${conductor.nombre} · ${conductor.matricula ?? 'sin vehículo'}`);
    console.log('='.repeat(72));

    // --- 1. El turno: ¿se abrió y se cerró bien? ---------------------------
    console.log('\n1) TURNO — cambios de estado del conductor');
    const transiciones = await cliente.query(
      `SELECT estado_anterior, estado_nuevo, actor, origen_evento, creado_en, ocurrio_en
       FROM transicion
       WHERE ambito = 'conductor' AND conductor_id = $1
         AND COALESCE(ocurrio_en, creado_en) >= $2::timestamptz - interval '1 day'
         AND COALESCE(ocurrio_en, creado_en) < $3
       ORDER BY creado_en`,
      [conductor.id, desde, hasta],
    );
    if (transiciones.rowCount === 0) {
      console.log('   NADA. No entró en servicio ese día (ni el anterior).');
    } else {
      // Se miran también las del día anterior, para no cortar un turno que
      // empezó antes de medianoche. Pero se MARCAN: son contexto, no el día.
      console.table(transiciones.rows.map((t) => ({
        cuando: fechaHora(t.ocurrio_en ?? t.creado_en),
        dia: new Date(t.ocurrio_en ?? t.creado_en) < desde ? 'ANTERIOR' : 'este',
        de: t.estado_anterior, a: t.estado_nuevo, actor: t.actor,
        motivo: t.origen_evento ?? '',
        // Solo se separan en el turno dado por abandonado (migración 051).
        apuntado: t.ocurrio_en === null ? '=' : fechaHora(t.creado_en),
      })));
      const delDia = transiciones.rows.filter(
        (t) => new Date(t.ocurrio_en ?? t.creado_en) >= desde,
      );
      if (delDia.length === 0) {
        console.log(`   AVISO: todos estos cambios son del DÍA ANTERIOR. El ${etiqueta} no`);
        console.log('   hubo ningún cambio de estado: lo de abajo saldrá a cero, y es');
        console.log('   correcto — no es que no se grabara, es que no hubo turno.');
      }
      const abandonados = transiciones.rows.filter((t) => t.origen_evento === 'turno_abandonado');
      if (abandonados.length > 0) {
        console.log(`   AVISO: ${abandonados.length} turno(s) dados por ABANDONADO.`);
        console.log('   Significa que nadie pulsó «salir de servicio» y el sistema lo cerró');
        console.log('   12 h después de la última señal. El tiempo que se cuenta es hasta');
        console.log('   la señal (columna «ocurrio»), no hasta el cierre.');
      }
    }

    // --- 2. Lo que el sistema dice del turno -------------------------------
    console.log('\n2) LO QUE CALCULA EL SISTEMA (las mismas funciones que ve el operador)');
    const actividad = await actividadDe(cliente, conductor.id, desde, hasta);
    const recorrido = await recorridoDe(cliente, conductor.id, desde, hasta, 100_000);
    console.table([{
      'en servicio': duracion(actividad.segundosEnServicio),
      'al volante': duracion(actividad.segundosEnMovimiento),
      km: (actividad.metros / 1000).toFixed(2),
      'media km/h': actividad.velocidadMediaKmh ?? '—',
      puntos: recorrido.puntos,
      tramos: recorrido.tramos.length,
    }]);

    // --- 3. El rastro crudo, para poder discutir lo de arriba --------------
    console.log('\n3) RASTRO CRUDO');
    const puntos = await cliente.query(
      `SELECT lat, lng, creado_en FROM rastro
       WHERE conductor_id = $1 AND creado_en >= $2 AND creado_en < $3
       ORDER BY creado_en`,
      [conductor.id, desde, hasta],
    );
    if (puntos.rowCount === 0) {
      // Cero puntos significa dos cosas muy distintas, y antes se decían igual:
      // si no hubo turno, es lo correcto; si lo hubo, es un fallo de recogida.
      if (actividad.segundosEnServicio === 0) {
        console.log('   Ningún punto, y es lo esperado: ese día no estuvo en servicio.');
      } else {
        console.log(`   NINGÚN PUNTO en ${duracion(actividad.segundosEnServicio)} de servicio. ESTO SÍ ES UN FALLO:`);
        console.log('   el móvil no mandó posición. Permiso de ubicación denegado, iPhone con');
        console.log('   la pantalla bloqueada (P47-01), o la app nativa sin instalar.');
      }
    } else {
      const filas = puntos.rows.map((f) => ({
        lat: Number(f.lat), lng: Number(f.lng), en: new Date(f.creado_en),
      }));
      console.log(`   ${filas.length} puntos, de ${hora(filas[0].en)} a ${hora(filas[filas.length - 1].en)}`);

      // Suma ingenua contra la del sistema: la diferencia es el temblor del
      // GPS parado y los saltos imposibles, que es lo que inflaba los
      // kilómetros antes de la migración 051.
      let ingenua = 0;
      for (let i = 1; i < filas.length; i += 1) {
        ingenua += distanciaMetros(filas[i - 1].lat, filas[i - 1].lng, filas[i].lat, filas[i].lng);
      }
      console.log(`   Suma ingenua punto a punto: ${(ingenua / 1000).toFixed(2)} km`);
      console.log(`   Lo que cuenta el sistema:   ${(actividad.metros / 1000).toFixed(2)} km`);
      console.log(`   Descartado (temblor y saltos): ${((ingenua - actividad.metros) / 1000).toFixed(2)} km`);

      // Huecos: cada uno es un trozo del turno que no se grabó.
      const huecos: Array<{ desde: string; hasta: string; falta: string }> = [];
      let masRapido = { kmh: 0, en: filas[0].en };
      const intervalos: number[] = [];
      for (let i = 1; i < filas.length; i += 1) {
        const seg = (filas[i].en.getTime() - filas[i - 1].en.getTime()) / 1000;
        intervalos.push(seg);
        if (seg > 600) {
          huecos.push({
            desde: hora(filas[i - 1].en), hasta: hora(filas[i].en), falta: duracion(seg),
          });
        }
        const m = distanciaMetros(filas[i - 1].lat, filas[i - 1].lng, filas[i].lat, filas[i].lng);
        const kmh = seg > 0 ? (m / seg) * 3.6 : 0;
        if (kmh > masRapido.kmh) masRapido = { kmh, en: filas[i].en };
      }
      if (huecos.length > 0) {
        console.log(`   ${huecos.length} hueco(s) de más de 10 min — trozos NO grabados:`);
        console.table(huecos);
      } else {
        console.log('   Sin huecos de más de 10 min: el recorrido está entero.');
      }
      console.log(`   Salto más rápido entre dos puntos: ${masRapido.kmh.toFixed(0)} km/h a las ${hora(masRapido.en)}`);
      if (masRapido.kmh > 180) {
        console.log('   AVISO: por encima de 180 km/h eso es una fijación disparada del GPS.');
        console.log('   El sistema ya no la cuenta como distancia (migración 051).');
      }
      intervalos.sort((a, b) => a - b);
      const mediana = intervalos[Math.floor(intervalos.length / 2)] ?? 0;
      console.log(`   Intervalo mediano entre puntos: ${mediana.toFixed(0)} s (lo normal, 45-60)`);

      // Calidad de cada punto (migración 054). Los puntos de antes de la 054
      // salen todos «sin precisión»: no es que fueran buenos, es que no se
      // sabía. A partir de la 054, lo peor de 50 m ya no debería aparecer.
      const calidad = await cliente.query(
        `SELECT count(*)::int AS total,
                count(precision_m)::int AS con,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY precision_m) AS mediana,
                percentile_cont(0.9) WITHIN GROUP (ORDER BY precision_m) AS p90,
                count(*) FILTER (WHERE precision_m > 50)::int AS malos
         FROM rastro WHERE conductor_id = $1 AND creado_en >= $2 AND creado_en < $3`,
        [conductor.id, desde, hasta],
      );
      const q = calidad.rows[0];
      if (q.con === 0) {
        console.log('   Precisión: NINGÚN punto la trae. O son de antes de la migración 054,');
        console.log('   o el móvil usa una versión vieja de la app.');
      } else {
        console.log(`   Precisión: ${q.con}/${q.total} puntos la traen · mediana ±${Number(q.mediana).toFixed(0)} m · 9 de cada 10 por debajo de ±${Number(q.p90).toFixed(0)} m`);
        if (q.malos > 0) {
          console.log(`   AVISO: ${q.malos} punto(s) con más de ±50 m. No debería haber: revisa la versión.`);
        }
      }

      // Puntos fuera de turno: no debería haber ni uno.
      const fuera = await cliente.query(
        `WITH marcas AS (
           SELECT estado_nuevo, COALESCE(ocurrio_en, creado_en) AS en, id
           FROM transicion WHERE ambito = 'conductor' AND conductor_id = $1
         ), turnos AS (
           SELECT estado_nuevo, en AS inicio, lead(en) OVER (ORDER BY en, id) AS fin
           FROM marcas
         )
         SELECT count(*)::int AS n FROM rastro r
         WHERE r.conductor_id = $1 AND r.creado_en >= $2 AND r.creado_en < $3
           AND NOT EXISTS (
             SELECT 1 FROM turnos t
             WHERE t.estado_nuevo <> 'DESCONECTADO'
               AND r.creado_en >= t.inicio AND (t.fin IS NULL OR r.creado_en <= t.fin)
           )`,
        [conductor.id, desde, hasta],
      );
      const n = fuera.rows[0].n;
      console.log(n === 0
        ? '   Ningún punto fuera de turno, como debe ser.'
        : `   AVISO: ${n} punto(s) grabados FUERA de turno. Eso no debería poder pasar.`);
    }

    // --- 4. Los viajes -----------------------------------------------------
    console.log('\n4) VIAJES');
    const viajes = await cliente.query(
      `SELECT s.id, s.estado, s.creada_en, v.id AS viaje_id,
              v.validado_en, v.completado_en, v.separado_desde,
              s.lat_cliente, s.lng_cliente, s.precision_cliente_m,
              ro.nombre AS origen, ro.lat AS ref_lat, ro.lng AS ref_lng,
              rd.nombre AS destino,
              (SELECT t.actor || '/' || COALESCE(t.origen_evento, '?')
               FROM transicion t JOIN estado e ON e.nombre = t.estado_nuevo
               WHERE t.solicitud_id = s.id AND e.es_terminal
               ORDER BY t.creado_en DESC LIMIT 1) AS cerro
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       LEFT JOIN viaje v ON v.solicitud_id = s.id
       WHERE s.conductor_id = $1 AND s.creada_en >= $2 AND s.creada_en < $3
       ORDER BY s.creada_en`,
      [conductor.id, desde, hasta],
    );
    if (viajes.rowCount === 0) {
      console.log('   Ninguna carrera ese día.');
    } else {
      console.table(viajes.rows.map((v) => ({
        id: v.id,
        estado: v.estado,
        pedida: hora(v.creada_en),
        recogido: hora(v.validado_en),
        cerrado: hora(v.completado_en),
        cerro: v.cerro ?? '—',
        dur: v.validado_en && v.completado_en
          ? duracion((new Date(v.completado_en).getTime() - new Date(v.validado_en).getTime()) / 1000)
          : '—',
        destino: v.destino,
      })));

      for (const v of viajes.rows) {
        console.log(`\n   Viaje ${v.id}: ${v.origen} → ${v.destino}`);
        // ¿Se usó la posición real del pasajero, o el sitio del catálogo?
        if (v.lat_cliente === null) {
          console.log('     Recogida: SIN GPS del pasajero, se usó la referencia del catálogo.');
        } else {
          const m = distanciaMetros(
            Number(v.lat_cliente), Number(v.lng_cliente), Number(v.ref_lat), Number(v.ref_lng),
          );
          const prec = v.precision_cliente_m === null ? null : Number(v.precision_cliente_m);
          console.log(`     Recogida: GPS a ${m.toFixed(0)} m de «${v.origen}», precisión ${prec === null ? 'DESCONOCIDA' : `±${prec.toFixed(0)} m`}`);
          if (prec === null) {
            console.log('       -> precisión desconocida: el sistema NO usó el GPS, y hace bien.');
          } else if (prec > 120) {
            console.log('       -> por encima de 120 m: el sistema usó la referencia, no el GPS.');
          } else {
            console.log('       -> el taxista vio el punto exacto del pasajero.');
          }
        }
        if (v.separado_desde !== null) {
          console.log(`     AVISO: separado_desde = ${hora(v.separado_desde)} con el viaje aún abierto.`);
        }
        if (v.cerro !== null && String(v.cerro).includes('separacion_gps')) {
          console.log('     Lo cerró el SISTEMA por separación GPS, no el taxista.');
        }
        if (v.cerro !== null && String(v.cerro).includes('caducado')) {
          console.log('     Lo cerró el sistema por caducidad: nadie lo terminó a mano.');
        }
        if (v.viaje_id === null) continue;

        const posiciones = await cliente.query(
          `SELECT actor, count(*)::int AS n,
                  min(creado_en) AS primera, max(creado_en) AS ultima,
                  round(avg(precision_m)) AS precision_media,
                  count(precision_m)::int AS con_precision
           FROM posicion WHERE viaje_id = $1 GROUP BY actor ORDER BY actor`,
          [v.viaje_id],
        );
        console.table(posiciones.rows.map((p) => ({
          actor: p.actor,
          puntos: p.n,
          de: hora(p.primera),
          a: hora(p.ultima),
          'precision media': p.precision_media ?? '—',
          'con precision': `${p.con_precision}/${p.n}`,
        })));
        if (posiciones.rows.every((p) => p.actor !== 'cliente')) {
          console.log('     El pasajero no mandó ni una posición: el cierre automático no');
          console.log('     podía funcionar, y el taxista no vio dónde estaba de verdad.');
        }
      }
    }

    // Si el día pedido salió vacío, decir cuál es el que tiene datos. Es lo
    // primero que hace falta saber, y sin esto había que ir probando fechas.
    if (actividad.segundosEnServicio === 0) {
      const ultimo = await cliente.query(
        `SELECT to_char(max(COALESCE(ocurrio_en, creado_en)) + interval '1 hour', 'YYYY-MM-DD') AS dia
         FROM transicion
         WHERE ambito = 'conductor' AND conductor_id = $1 AND estado_nuevo <> 'DESCONECTADO'`,
        [conductor.id],
      );
      const dia = ultimo.rows[0]?.dia ?? null;
      console.log('');
      console.log(dia === null
        ? 'Este conductor no ha entrado en servicio NUNCA.'
        : `El último día que entró en servicio fue el ${dia}. Para verlo:\n   --dia=${dia}`);
    }

    console.log(`\n${'='.repeat(72)}`);
  } finally {
    await cliente.end();
  }
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
