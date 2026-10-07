// La radio del gremio: el turno de palabra, el reparto y el borrado (075).
//
// Ejecutar: npm run probar
//
// Cada prueba usa SU PROPIO canal. No es un adorno: la base de desarrollo la
// comparten todas las pruebas, y el turno es una fila por canal —si todas
// hablaran por «isla» se quitarían la palabra unas a otras y los fallos serían
// de la vecina, no de lo que se mide. De paso demuestra lo que sostiene el
// diseño: que el canal es un dato y no una constante.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import {
  CANAL_UNICO, audioDeMensaje, canalDe, guardarMensaje, oyentesDe, pedirLaPalabra,
  purgarMensajes, quienHabla, soltarLaPalabra, ultimosMensajes,
} from './radio.js';

let pool: pg.Pool;

// Los taxistas que inventa esta batería se borran al terminar.
//
// No es manía de limpieza. Quedan en `presencia` como DISPONIBLE y en ninguna
// zona, y la base de desarrollo la comparten todas las pruebas: unos cuantos
// taxistas fantasma conectados cambian lo que ven las pruebas del reparto —hay
// ayudas enteras en `ayuda-pruebas.ts` escritas justo por esto— y además se
// acumularían una tanda más en cada pasada.
const inventados: number[] = [];

before(() => { pool = crearPool(); });
after(async () => {
  if (inventados.length > 0) {
    await pool.query('DELETE FROM mensaje_voz WHERE conductor_id = ANY($1)', [inventados]);
    await pool.query('DELETE FROM turno_palabra WHERE conductor_id = ANY($1)', [inventados]);
    await pool.query('DELETE FROM presencia WHERE conductor_id = ANY($1)', [inventados]);
    await pool.query('DELETE FROM vehiculo WHERE conductor_id = ANY($1)', [inventados]);
    await pool.query('DELETE FROM dispositivo WHERE conductor_id = ANY($1)', [inventados]);
    await pool.query('DELETE FROM conductor WHERE id = ANY($1)', [inventados]);
  }
  await pool.end();
});

function canalNuevo(): string {
  return `prueba-${randomUUID()}`;
}

interface Taxista { conductorId: number; dispositivoId: number; nombre: string }

async function taxista(
  { estado = 'DISPONIBLE', nombre = 'Taxi Radio', matricula = false } = {},
): Promise<Taxista> {
  return enTransaccion(pool, async (c) => {
    // Del uuid y no de Math.random: con la base de desarrollo llena de taxistas
    // de pruebas, ocho dígitos al azar chocan de vez en cuando.
    const telefono = `+2406${BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 12)}`) % 100_000_000n}`
      .padEnd(13, '0');
    const conductor = await c.query(
      'INSERT INTO conductor (telefono, nombre) VALUES ($1, $2) RETURNING id',
      [telefono, nombre],
    );
    const conductorId = Number(conductor.rows[0].id);
    const dispositivo = await c.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id)
       VALUES (gen_random_uuid(), 'conductor', $1) RETURNING id`,
      [conductorId],
    );
    await c.query(
      'INSERT INTO presencia (conductor_id, estado) VALUES ($1, $2)',
      [conductorId, estado],
    );
    if (matricula) {
      await c.query(
        'INSERT INTO vehiculo (conductor_id, matricula) VALUES ($1, $2)',
        [conductorId, `R-${randomUUID().slice(0, 8)}`],
      );
    }
    inventados.push(conductorId);
    return { conductorId, dispositivoId: Number(dispositivo.rows[0].id), nombre };
  });
}

const AUDIO = Buffer.from('esto hace de audio, no se reproduce aquí');

test('hoy el canal es uno y es la isla', async () => {
  const yo = await taxista();
  assert.equal(await canalDe(pool, yo.conductorId), CANAL_UNICO);
  assert.equal(CANAL_UNICO, 'isla');
});

test('la palabra se le da a uno, y al otro se le dice quién habla', async () => {
  // La garantía de fondo de todo esto. Los dos aprietan en el mismo instante y
  // no la puede ganar más que uno, porque no caben dos filas con el mismo canal.
  const canal = canalNuevo();
  const uno = await taxista({ nombre: 'Pablo Ondo' });
  const otro = await taxista({ nombre: 'Juan Nvono' });
  const ahora = new Date();

  const [a, b] = await Promise.all([
    pedirLaPalabra(pool, { canal, ...uno }, ahora),
    pedirLaPalabra(pool, { canal, ...otro }, ahora),
  ]);

  const dadas = [a, b].filter((r) => r.dada);
  assert.equal(dadas.length, 1, 'solo uno puede tener la palabra');

  const negada = [a, b].find((r) => !r.dada)!;
  assert.equal(negada.dada, false);
  assert.equal(negada.motivo, 'ocupado');
  if (negada.motivo === 'ocupado') {
    // Quién habla y cuánto le queda. En una radio eso es la diferencia entre
    // esperar tranquilo y volver a apretar cinco veces seguidas.
    assert.ok(['Pablo Ondo', 'Juan Nvono'].includes(negada.habla), negada.habla);
    assert.ok(negada.quedanSeg > 0 && negada.quedanSeg <= 15, `quedan ${negada.quedanSeg}`);
  }
});

test('el turno caduca solo: un teléfono que se apaga no deja el canal muerto', async () => {
  const canal = canalNuevo();
  const uno = await taxista();
  const otro = await taxista();
  const ahora = new Date();

  assert.equal((await pedirLaPalabra(pool, { canal, ...uno }, ahora)).dada, true);
  // Se le muere la batería con el botón apretado y no suelta nunca.
  const ocupado = await pedirLaPalabra(pool, { canal, ...otro }, new Date(ahora.getTime() + 5_000));
  assert.equal(ocupado.dada, false);

  // Diez de hablar más cinco de margen: pasados esos, el canal es de quien lo
  // pida. Si esto no funcionara, un teléfono apagado dejaría al gremio sin radio
  // hasta que alguien entrara en la base a mano.
  const despues = await pedirLaPalabra(pool, { canal, ...otro }, new Date(ahora.getTime() + 16_000));
  assert.equal(despues.dada, true, 'a los 16 s el turno vencido ya no vale');
});

test('el turno viene con fecha de caducidad, y es la que cumple la pantalla', async () => {
  // Es el contrato del que depende el arreglo del canal que se quedaba
  // «ocupado» para siempre: la pantalla de los demás deja de esperar SOLA en
  // esta fecha, sin necesitar que nadie le avise de que el otro calló. Si esto
  // dejara de venir, volvería el fallo y no lo notaría ninguna prueba.
  const canal = canalNuevo();
  const yo = await taxista();
  const ahora = new Date();
  const r = await pedirLaPalabra(pool, { canal, ...yo }, ahora);
  assert.equal(r.dada, true);
  if (!r.dada) return;
  const dura = (new Date(r.caducaEn).getTime() - ahora.getTime()) / 1000;
  assert.ok(dura > r.segundosMax, `tiene que durar más que lo que se puede hablar (${dura} s)`);
  assert.ok(dura <= r.segundosMax + 10, `y no mucho más, o el canal se queda muerto (${dura} s)`);
});

test('soltar deja el canal libre en el acto', async () => {
  const canal = canalNuevo();
  const uno = await taxista();
  const otro = await taxista();
  const ahora = new Date();

  await pedirLaPalabra(pool, { canal, ...uno }, ahora);
  // Aprieta y se arrepiente. Nadie tiene que esperar quince segundos por eso.
  await soltarLaPalabra(pool, { canal, ...uno }, ahora);

  assert.equal(await quienHabla(pool, canal, ahora), null);
  const segundo = await pedirLaPalabra(pool, { canal, ...otro }, ahora);
  assert.equal(segundo.dada, true);
});

test('el mensaje va a los conectados y no al que acaba de hablar', async () => {
  const canal = canalNuevo();
  const habla = await taxista();
  const escucha = await taxista();
  const apagado = await taxista({ estado: 'DESCONECTADO' });
  const ahora = new Date();

  await pedirLaPalabra(pool, { canal, ...habla }, ahora);
  const r = await guardarMensaje(pool, {
    canal, ...habla, audio: AUDIO, tipoMedio: 'audio/webm', duracionMs: 4_000,
  }, ahora);
  assert.equal(r.guardado, true);
  if (!r.guardado) return;

  // Se comprueba por pertenencia y no por cuántos son: la base de desarrollo
  // está llena de taxistas de otras pruebas, y contar aquí sería contar los
  // suyos.
  assert.ok(r.oyentes.includes(escucha.dispositivoId), 'el conectado tiene que oírlo');
  assert.ok(!r.oyentes.includes(habla.dispositivoId), 'el que habló no se oye a sí mismo');
  assert.ok(!r.oyentes.includes(apagado.dispositivoId), 'el desconectado no recibe nada');

  // Y el canal queda libre ya, sin esperar a que venza el plazo: cinco segundos
  // de radio muerta después de cada frase se notan.
  assert.equal(await quienHabla(pool, canal, ahora), null);
});

test('un audio que sube lento se acepta aunque el turno ya haya vencido', async () => {
  // Decisión deliberada: hablar diez segundos y tardar en subir 25 KB con mala
  // cobertura es normal aquí, y tirar a la basura algo que alguien ya dijo es el
  // peor resultado posible. Lo que el turno garantiza —que no se le dio la
  // palabra a otro mientras hablaba— se cumple igual.
  const canal = canalNuevo();
  const yo = await taxista();
  const ahora = new Date();

  await pedirLaPalabra(pool, { canal, ...yo }, ahora);
  const tarde = await guardarMensaje(pool, {
    canal, ...yo, audio: AUDIO, tipoMedio: 'audio/webm', duracionMs: 9_000,
  }, new Date(ahora.getTime() + 17_000));
  assert.equal(tarde.guardado, true, 'a los 17 s el turno venció pero el audio vale');

  // Con un límite, eso sí: pasado un tiempo largo ya no es «subió lento», es
  // otra cosa, y se rechaza.
  const canal2 = canalNuevo();
  const otro = await taxista();
  await pedirLaPalabra(pool, { canal: canal2, ...otro }, ahora);
  const muyTarde = await guardarMensaje(pool, {
    canal: canal2, ...otro, audio: AUDIO, tipoMedio: 'audio/webm', duracionMs: 9_000,
  }, new Date(ahora.getTime() + 40_000));
  assert.equal(muyTarde.guardado, false);
  if (!muyTarde.guardado) assert.equal(muyTarde.motivo, 'sin_turno');
});

test('sin pedir la palabra no se puede colar audio', async () => {
  const canal = canalNuevo();
  const yo = await taxista();
  const r = await guardarMensaje(pool, {
    canal, ...yo, audio: AUDIO, tipoMedio: 'audio/webm', duracionMs: 3_000,
  });
  assert.equal(r.guardado, false);
  if (!r.guardado) assert.equal(r.motivo, 'sin_turno');
});

test('los topes de tamaño y de duración se comprueban en el servidor', async () => {
  // El teléfono dice cuánto duró y cuánto pesa, y un teléfono es de quien lo
  // tiene: el tope de la pantalla no es un tope.
  const canal = canalNuevo();
  const yo = await taxista();
  const ahora = new Date();

  await pedirLaPalabra(pool, { canal, ...yo }, ahora);
  const gordo = await guardarMensaje(pool, {
    canal, ...yo, audio: Buffer.alloc(40_001), tipoMedio: 'audio/webm', duracionMs: 5_000,
  }, ahora);
  assert.equal(gordo.guardado, false);
  if (!gordo.guardado) assert.equal(gordo.motivo, 'demasiado_grande');

  const largo = await guardarMensaje(pool, {
    canal, ...yo, audio: AUDIO, tipoMedio: 'audio/webm', duracionMs: 30_000,
  }, ahora);
  assert.equal(largo.guardado, false);
  if (!largo.guardado) assert.equal(largo.motivo, 'demasiado_largo');
});

test('el que se engancha al botón tiene su propio tope, y no cuenta como canal lleno', async () => {
  const canal = canalNuevo();
  const yo = await taxista();
  const ahora = new Date();

  // Seis mensajes en el último minuto, que es el tope por taxista.
  await enTransaccion(pool, async (c) => {
    for (let i = 0; i < 6; i += 1) {
      await c.query(
        `INSERT INTO mensaje_voz (canal, conductor_id, audio, tipo_medio, duracion_ms, creado_en)
         VALUES ($1, $2, $3, 'audio/webm', 5000, $4)`,
        [canal, yo.conductorId, AUDIO, new Date(ahora.getTime() - i * 1_000)],
      );
    }
  });

  const no = await pedirLaPalabra(pool, { canal, ...yo }, ahora);
  assert.equal(no.dada, false);
  if (!no.dada && no.motivo === 'demasiados') {
    assert.ok(no.esperaSeg > 0 && no.esperaSeg <= 60, `espera ${no.esperaSeg}`);
  } else {
    assert.fail(`se esperaba «demasiados» y salió ${JSON.stringify(no)}`);
  }

  // Y lo que importa de verdad: esto NO ensucia la medida que decide si el canal
  // hay que partirlo. Uno pasándose no es el canal lleno.
  const uso = await pool.query(
    'SELECT turnos_dados, turnos_ocupados FROM radio_uso WHERE canal = $1',
    [canal],
  );
  assert.equal(uso.rowCount, 0, 'un tope por taxista no es un turno ocupado');
});

test('los dos contadores que deciden si el canal hay que partirlo', async () => {
  const canal = canalNuevo();
  const uno = await taxista();
  const otro = await taxista();
  const ahora = new Date();

  await pedirLaPalabra(pool, { canal, ...uno }, ahora);
  await pedirLaPalabra(pool, { canal, ...otro }, ahora); // ocupado
  await pedirLaPalabra(pool, { canal, ...otro }, ahora); // ocupado otra vez

  const uso = await pool.query(
    'SELECT turnos_dados, turnos_ocupados FROM radio_uso WHERE canal = $1',
    [canal],
  );
  assert.equal(uso.rows[0].turnos_dados, 1);
  assert.equal(uso.rows[0].turnos_ocupados, 2);
  // Dos de cada tres rechazados: así se ve que el canal está lleno sin opinar.
});

test('la lista dice quién habló, con su matrícula, y sin bajar el audio', async () => {
  const canal = canalNuevo();
  const yo = await taxista({ nombre: 'Pablo Ondo', matricula: true });
  const ahora = new Date();

  await pedirLaPalabra(pool, { canal, ...yo }, ahora);
  const r = await guardarMensaje(pool, {
    canal, ...yo, audio: AUDIO, tipoMedio: 'audio/webm', duracionMs: 6_500,
  }, ahora);
  assert.equal(r.guardado, true);

  const lista = await ultimosMensajes(pool, canal);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].nombre, 'Pablo Ondo');
  assert.ok(lista[0].matricula, 'la matrícula identifica al coche, no el nombre');
  assert.equal(lista[0].duracionMs, 6_500);
  assert.equal(lista[0].bytes, AUDIO.length);

  // El audio se baja aparte y solo si se pulsa: en la lista van los datos, no
  // veinte mensajes de 25 KB que nadie pidió.
  const bajado = await audioDeMensaje(pool, lista[0].id, canal);
  assert.ok(bajado !== null);
  assert.deepEqual(bajado!.audio, AUDIO);
  assert.equal(bajado!.tipoMedio, 'audio/webm');

  // Y de otro canal no se baja, ni sabiendo el número.
  assert.equal(await audioDeMensaje(pool, lista[0].id, canalNuevo()), null);
});

test('el borrado se lleva lo de hace tres horas y deja lo de ahora', async () => {
  // Esto no es limpieza de espacio, es la protección: mientras el audio existe,
  // existe un archivo de lo que hablan los taxistas y alguien puede pedirlo.
  const canal = canalNuevo();
  const yo = await taxista();
  const ahora = new Date();

  await enTransaccion(pool, async (c) => {
    for (const hace of [3 * 3600, 60]) {
      await c.query(
        `INSERT INTO mensaje_voz (canal, conductor_id, audio, tipo_medio, duracion_ms, creado_en)
         VALUES ($1, $2, $3, 'audio/webm', 5000, $4)`,
        [canal, yo.conductorId, AUDIO, new Date(ahora.getTime() - hace * 1_000)],
      );
    }
  });

  assert.equal((await ultimosMensajes(pool, canal)).length, 2);
  assert.ok(await purgarMensajes(pool, ahora) >= 1);
  const quedan = await ultimosMensajes(pool, canal);
  assert.equal(quedan.length, 1, 'se va el de tres horas y se queda el de hace un minuto');
});

test('con el interruptor apagado la radio no existe', async () => {
  const canal = canalNuevo();
  const yo = await taxista();
  const previo = await pool.query(`SELECT valor FROM parametro WHERE clave = 'radio_activada'`);
  await pool.query(`UPDATE parametro SET valor = '0' WHERE clave = 'radio_activada'`);
  try {
    const palabra = await pedirLaPalabra(pool, { canal, ...yo });
    assert.equal(palabra.dada, false);
    if (!palabra.dada) assert.equal(palabra.motivo, 'apagada');

    const mensaje = await guardarMensaje(pool, {
      canal, ...yo, audio: AUDIO, tipoMedio: 'audio/webm', duracionMs: 3_000,
    });
    assert.equal(mensaje.guardado, false);
    if (!mensaje.guardado) assert.equal(mensaje.motivo, 'apagada');
  } finally {
    await pool.query(
      `UPDATE parametro SET valor = $1 WHERE clave = 'radio_activada'`,
      [previo.rows[0]?.valor ?? '1'],
    );
  }
});

test('los oyentes se agrupan por PERSONA, con todas sus pantallas', async () => {
  // Hace falta para la regla del aviso con la aplicación cerrada (migración
  // 077): solo se despierta el teléfono si NINGUNA pantalla de ese taxista
  // tiene a alguien delante. Para saberlo hay que tenerlas todas, no una.
  const canal = canalNuevo();
  const yo = await taxista();
  const escucha = await taxista();
  const segundo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id, ultimo_heartbeat)
     VALUES (gen_random_uuid(), 'conductor', $1, now()) RETURNING id`,
    [escucha.conductorId],
  );

  const { oyentesPorConductor } = await import('./radio.js');
  const grupos = await oyentesPorConductor(pool, canal, yo.conductorId);
  const suyo = grupos.find((g) => g.conductorId === escucha.conductorId);
  assert.ok(suyo, 'el que escucha tiene que salir');
  assert.ok(suyo!.dispositivos.includes(escucha.dispositivoId));
  assert.ok(suyo!.dispositivos.includes(Number(segundo.rows[0].id)),
    'y con sus DOS pantallas, que es de lo que se trata');
  assert.ok(!grupos.some((g) => g.conductorId === yo.conductorId),
    'el que habló no se oye a sí mismo');
});

test('el oyente se cuenta una vez aunque tenga la aplicación en dos teléfonos', async () => {
  const canal = canalNuevo();
  const yo = await taxista();
  const escucha = await taxista();
  // Se cambia de teléfono y el viejo se queda registrado. Avisar a los dos sería
  // que el mensaje le suene dos veces, y gastar dos veces los datos.
  const segundo = await pool.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id, ultimo_heartbeat)
     VALUES (gen_random_uuid(), 'conductor', $1, now()) RETURNING id`,
    [escucha.conductorId],
  );
  const oyentes = await oyentesDe(pool, canal, yo.conductorId);
  const suyos = [escucha.dispositivoId, Number(segundo.rows[0].id)]
    .filter((d) => oyentes.includes(d));
  assert.equal(suyos.length, 1, 'un taxista, un aviso');
  assert.equal(suyos[0], Number(segundo.rows[0].id), 'y al teléfono que usa ahora');
});
