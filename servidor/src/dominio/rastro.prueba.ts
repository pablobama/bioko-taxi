// Pruebas del recorrido del taxi durante el turno (migración 042).
//
// Ejecutar: npm run probar

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { crearPool, enTransaccion } from '../bd/conexion.js';
import {
  actividadDe, purgarRastro, recorridoDe, registrarRastro, registrarRastroDiferido,
} from './rastro.js';
import { caducarPresencias } from './presencia.js';

let pool: pg.Pool;

before(() => {
  pool = crearPool();
});

after(async () => {
  await pool.end();
});

// Ocho dígitos aleatorios, no seis: la base de desarrollo guarda los teléfonos
// de todas las ejecuciones anteriores (P12-03), y con un millón de números
// posibles las colisiones contra ejecuciones viejas dejan de ser raras y
// revientan el UNIQUE del teléfono a mitad de la batería.
let siguienteTelefono = Math.floor(Math.random() * 100_000_000);
function telefonoUnico(): string {
  siguienteTelefono = (siguienteTelefono + 1) % 100_000_000;
  return `+2406${String(siguienteTelefono).padStart(8, '0')}`;
}

// Un conductor con presencia en el estado que se pida. La zona da igual aquí:
// el rastro cuelga del conductor, no del barrio.
async function crearConductor(estado = 'DISPONIBLE'): Promise<number> {
  return enTransaccion(pool, async (c) => {
    const { rows } = await c.query(
      `INSERT INTO conductor (telefono, nombre) VALUES ($1, 'Taxi RAS') RETURNING id`,
      [telefonoUnico()],
    );
    const conductorId: number = rows[0].id;
    await c.query(
      `INSERT INTO presencia (conductor_id, estado, ultimo_heartbeat)
       VALUES ($1, $2, now())`,
      [conductorId, estado],
    );
    return conductorId;
  });
}

const BASE = new Date('2026-08-05T08:00:00Z');
const enSegundo = (s: number) => new Date(BASE.getTime() + s * 1000);
// Un grado de latitud son ~111 km: esto son metros hacia el norte.
const aMetros = (m: number) => ({ lat: 3.75 + m / 111_320, lng: 8.78 });

const guardar = (id: number, m: number, seg: number) =>
  enTransaccion(pool, (c) => {
    const p = aMetros(m);
    return registrarRastro(c, id, p.lat, p.lng, enSegundo(seg));
  });

test('el primer punto del turno siempre se guarda: es por dónde empezó', async () => {
  const id = await crearConductor();
  assert.equal(await guardar(id, 0, 0), true);
});

test('dos latidos seguidos no son dos puntos: entre ellos solo hay ruido de GPS', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  // El latido va cada 20 s y el intervalo mínimo es 45: aunque el coche haya
  // cruzado media ciudad, este punto no entra. Es lo que corta de 180 puntos
  // por hora a 80, y sin ello un mes de cien taxis no cabe en la base.
  assert.equal(await guardar(id, 500, 20), false, 'demasiado pronto, aunque se haya movido');
});

test('pasado el intervalo, moverse guarda punto y no moverse no', async () => {
  const quieto = await crearConductor();
  await guardar(quieto, 0, 0);
  // 10 m es menos que los 40 del parámetro: el coche está parado y lo que se
  // ve entre lectura y lectura es el temblor del GPS.
  assert.equal(await guardar(quieto, 10, 60), false);

  const andando = await crearConductor();
  await guardar(andando, 0, 0);
  assert.equal(await guardar(andando, 300, 60), true);
});

test('el taxi parado deja un punto cada tanto: «estuvo ahí» no es «no se sabe»', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  assert.equal(await guardar(id, 5, 120), false, 'a los dos minutos todavía no');
  // El anclaje son 300 s. Sin él, un taxi que espera dos horas en la parada
  // del mercado sale en el mapa como un punto suelto y un agujero enorme.
  assert.equal(await guardar(id, 5, 400), true, 'a los seis minutos sí, aunque no se haya movido');
});

test('quien no está en servicio no deja rastro, aunque su móvil lo mande', async () => {
  const id = await crearConductor('DESCONECTADO');
  assert.equal(await guardar(id, 0, 0), false);
  const r = await recorridoDe(pool, id, enSegundo(-1000), enSegundo(1000));
  assert.equal(r.puntos, 0, 'ni un punto: su vida fuera del turno no se registra');
});

test('un hueco largo parte el recorrido en dos tramos, sin unirlos por el aire', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  await guardar(id, 300, 60);
  // Media hora después reaparece a tres kilómetros: salió de servicio, o se
  // quedó sin cobertura. Unir esos dos puntos dibujaría una línea recta por
  // encima de la ciudad que nadie recorrió.
  await guardar(id, 3000, 2400);
  await guardar(id, 3300, 2460);

  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(3000));
  assert.equal(r.puntos, 4);
  assert.equal(r.tramos.length, 2, 'dos tramos, no uno atravesando el hueco');
  assert.equal(r.tramos[0].length, 2);
  assert.equal(r.tramos[1].length, 2);
});

test('los metros son los que anduvo de verdad, no los del salto entre tramos', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  await guardar(id, 300, 60);
  await guardar(id, 3000, 2400);
  await guardar(id, 3300, 2460);

  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(3000));
  // 300 m de un tramo y 300 del otro. Los 2.700 m del salto no cuentan:
  // nadie los recorrió, y sumarlos inflaría el kilometraje del taxista.
  assert.ok(Math.abs(r.metros - 600) < 15, `esperaba ~600 m y salieron ${r.metros}`);
});

test('un punto suelto no es un recorrido: no hay línea que dibujar', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(100));
  assert.equal(r.puntos, 1, 'el punto está guardado');
  assert.equal(r.tramos.length, 0, 'pero no se dibuja');
});

test('la ventana del periodo no se lleva lo de al lado', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  await guardar(id, 300, 60);
  const fuera = await recorridoDe(pool, id, enSegundo(600), enSegundo(1200));
  assert.equal(fuera.puntos, 0);
});

test('un recorrido largo se aligera para mandarlo, pero el kilometraje no miente', async () => {
  const id = await crearConductor();
  for (let i = 0; i < 60; i += 1) {
    await guardar(id, i * 300, i * 60);
  }
  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(10_000), 10);
  assert.equal(r.puntos, 60, 'se dice cuántos hay de verdad');
  const dibujados = r.tramos.reduce((n, t) => n + t.length, 0);
  assert.ok(dibujados <= 12, `se mandan ${dibujados}, que es un puñado y no sesenta`);
  // 59 saltos de 300 m. Medido sobre los puntos completos, no sobre los
  // dibujados: si se midiera después de aligerar, un mes saldría más corto
  // que una semana del mismo taxi solo por dibujarse con menos puntos.
  assert.ok(Math.abs(r.metros - 17_700) < 200, `esperaba ~17.700 m y salieron ${r.metros}`);
});

test('la purga se lleva lo viejo y respeta lo de dentro del plazo', async () => {
  const id = await crearConductor();
  const ahora = new Date();
  const hace = (dias: number) => new Date(ahora.getTime() - dias * 86_400_000);
  await pool.query(
    `INSERT INTO rastro (conductor_id, lat, lng, creado_en)
     VALUES ($1, 3.75, 8.78, $2), ($1, 3.75, 8.78, $3)`,
    [id, hace(200), hace(2)],
  );

  await purgarRastro(pool, ahora);

  const quedan = await pool.query(
    'SELECT count(*)::int AS n FROM rastro WHERE conductor_id = $1',
    [id],
  );
  assert.equal(quedan.rows[0].n, 1, 'se va el de hace 200 días, se queda el de anteayer');
});

test('el rastro de un taxi no es el de otro', async () => {
  const uno = await crearConductor();
  const otro = await crearConductor();
  await guardar(uno, 0, 0);
  await guardar(uno, 300, 60);

  const r = await recorridoDe(pool, otro, enSegundo(-100), enSegundo(1000));
  assert.equal(r.puntos, 0, `el conductor ${otro} no hereda el recorrido de ${uno} (${randomUUID().slice(0, 4)})`);
});

// --- Actividad: kilómetros y tiempo en servicio -----------------------------

async function transicion(
  conductorId: number, anterior: string | null, nuevo: string, cuando: Date,
): Promise<void> {
  await pool.query(
    `INSERT INTO transicion (ambito, conductor_id, estado_anterior, estado_nuevo, actor, creado_en)
     VALUES ('conductor', $1, $2, $3, 'conductor', $4)`,
    [conductorId, anterior, nuevo, cuando],
  );
}

test('actividad: el tiempo sale del registro de estados, no de los puntos del rastro', async () => {
  const id = await crearConductor();
  // Turno de dos horas. Dentro solo hay puntos de la primera media hora: se
  // quedó sin cobertura, o es un iPhone que suspendió la app al bloquearse
  // (P47-01). Contar solo lo que tiene puntos le quitaría hora y media
  // trabajada.
  await transicion(id, 'DESCONECTADO', 'DISPONIBLE', enSegundo(0));
  await transicion(id, 'DISPONIBLE', 'DESCONECTADO', enSegundo(7200));
  await guardar(id, 0, 0);
  await guardar(id, 600, 60);

  const a = await actividadDe(pool, id, enSegundo(-100), enSegundo(8000));
  assert.equal(a.segundosEnServicio, 7200, 'las dos horas enteras');
  assert.ok(Math.abs(a.metros - 600) < 15, `esperaba ~600 m y salieron ${a.metros}`);
});

test('actividad: un turno abierto se corta al final del periodo, no en «ahora»', async () => {
  const id = await crearConductor();
  // Entró y sigue dentro: no hay transición de salida.
  await transicion(id, 'DESCONECTADO', 'DISPONIBLE', enSegundo(0));

  const a = await actividadDe(pool, id, enSegundo(-100), enSegundo(3600));
  assert.equal(a.segundosEnServicio, 3600, 'hasta el borde del periodo y ni un segundo más');
});

test('actividad: solo cuenta lo que cae dentro del periodo', async () => {
  const id = await crearConductor();
  // Turno de ayer, entero fuera de la ventana que se pide.
  await transicion(id, 'DESCONECTADO', 'DISPONIBLE', enSegundo(-20_000));
  await transicion(id, 'DISPONIBLE', 'DESCONECTADO', enSegundo(-10_000));
  // Y otro que empieza antes de la ventana y termina dentro: solo el trozo.
  await transicion(id, 'DESCONECTADO', 'DISPONIBLE', enSegundo(-600));
  await transicion(id, 'DISPONIBLE', 'DESCONECTADO', enSegundo(600));

  const a = await actividadDe(pool, id, enSegundo(0), enSegundo(5000));
  assert.equal(a.segundosEnServicio, 600, 'del turno a caballo, solo lo de dentro');
});

test('actividad: quien no entró en servicio no acumula tiempo ni kilómetros', async () => {
  const id = await crearConductor('DESCONECTADO');
  const a = await actividadDe(pool, id, enSegundo(-1000), enSegundo(1000));
  assert.equal(a.segundosEnServicio, 0);
  assert.equal(a.metros, 0);
});

// --- Intensidad: la ruta que más se repite ---------------------------------

test('intensidad: la calle que repite tres veces pesa más que la que hizo una', async () => {
  const id = await crearConductor();
  // Tres pasadas por el mismo tramo, cada una en su turno (separadas más de
  // los diez minutos que parten los tramos), y una escapada a otro sitio.
  for (const vuelta of [0, 1, 2]) {
    const base = vuelta * 3600;
    await guardar(id, 0, base);
    await guardar(id, 300, base + 60);
    await guardar(id, 600, base + 120);
  }
  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(20_000));

  assert.equal(r.maxPasadas, 3, 'tres vueltas por la misma calle son tres pasadas');
  const alPrincipio = r.tramos[0][0];
  assert.equal(alPrincipio.pasadas, 3, 'y cada punto de ahí lo sabe');
});

test('intensidad: esperar parado NO cuenta como recorrer', async () => {
  const id = await crearConductor();
  // Una hora quieto en el mismo sitio: el anclaje escribe un punto cada cinco
  // minutos, así que son doce puntos en la misma celda. Si se contaran puntos
  // en vez de pasadas, esa parada sería lo más «recorrido» del periodo por
  // goleada y el resto del mapa saldría azul.
  for (let i = 0; i < 12; i += 1) {
    await pool.query(
      `INSERT INTO rastro (conductor_id, lat, lng, creado_en) VALUES ($1, $2, $3, $4)`,
      [id, aMetros(0).lat, aMetros(0).lng, enSegundo(i * 300)],
    );
  }
  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(20_000));
  assert.equal(r.maxPasadas, 1, 'doce puntos parados siguen siendo una sola pasada');
});

test('intensidad: sin repetir nada, no hay nada rojo que enseñar', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  await guardar(id, 300, 60);
  await guardar(id, 600, 120);
  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(5000));
  assert.equal(r.maxPasadas, 1, 'un recorrido hecho una vez no es «su ruta de siempre»');
});


// --- Kilómetros de verdad y tiempo de verdad (migración 051) ---------------

test('el coche parado no suma kilómetros: entre dos anclajes solo hay temblor', async () => {
  const id = await crearConductor();
  // Ocho anclajes de un taxi esperando en la parada. Cada uno cae a quince
  // metros del anterior, que es el temblor del chip, no un desplazamiento.
  // Antes esto sumaba más de cien metros por hora de espera.
  for (let i = 0; i < 8; i += 1) {
    await guardar(id, i % 2 === 0 ? 0 : 15, i * 300);
  }
  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(3000));
  assert.ok(r.tramos.length > 0, 'los puntos están guardados, que es lo suyo');
  assert.equal(r.metros, 0, 'y ni un metro de recorrido');
  assert.equal(r.segundosEnMovimiento, 0, 'ni un segundo al volante');
});

test('un atasco sí cuenta: los avances pequeños se acumulan contra el ancla', async () => {
  const id = await crearConductor();
  // Avanza de veinte en veinte metros. Ninguno de esos saltos llega por sí
  // solo al mínimo, pero el coche recorre 160 m de verdad y tienen que contar:
  // un filtro que mirara solo el salto anterior le dejaría el atasco a cero.
  for (let i = 0; i <= 8; i += 1) await guardar(id, i * 20, i * 60);

  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(3000));
  assert.ok(r.metros >= 120 && r.metros <= 165, `esperaba ~160 m y salieron ${r.metros}`);
});

test('una fijación disparada no mete kilómetros de la nada', async () => {
  const id = await crearConductor();
  await guardar(id, 0, 0);
  // Diez kilómetros en un minuto: 600 km/h. No hay coche que lo haga.
  await guardar(id, 10_000, 60);
  await guardar(id, 300, 120);

  const r = await recorridoDe(pool, id, enSegundo(-100), enSegundo(3000));
  assert.ok(r.metros < 1000, `la fijación no puede contar; salieron ${r.metros} m`);
});

test('el turno abandonado no regala las doce horas que tarda en cerrarse', async () => {
  const id = await crearConductor();
  await transicion(id, 'DESCONECTADO', 'DISPONIBLE', enSegundo(0));
  // Última señal a las dos horas: ahí dejó de trabajar de verdad.
  const ultimaSenal = enSegundo(7200);
  await pool.query(
    'UPDATE presencia SET ultimo_heartbeat = $2 WHERE conductor_id = $1',
    [id, ultimaSenal],
  );
  // Y el sistema lo cierra doce horas más tarde, que es cuando se entera.
  await enTransaccion(pool, (c) => caducarPresencias(c, enSegundo(7200 + 13 * 3600)));

  const a = await actividadDe(pool, id, enSegundo(-100), enSegundo(7200 + 20 * 3600));
  assert.equal(a.segundosEnServicio, 7200, 'las dos horas que trabajó, no las catorce');
});

// --- El recorrido que sube después, sin haber tenido red -------------------

test('el recorrido sin cobertura se sube después y queda con SU hora', async () => {
  const id = await crearConductor();
  await transicion(id, 'DESCONECTADO', 'DISPONIBLE', enSegundo(0));
  await transicion(id, 'DISPONIBLE', 'DESCONECTADO', enSegundo(3600));

  // Lo que el móvil apuntó sin red durante el turno, subido al día siguiente.
  const puntos = [0, 60, 120, 180].map((seg) => ({
    ...aMetros(seg * 5), en: enSegundo(seg),
  }));
  const r = await enTransaccion(pool, (c) =>
    registrarRastroDiferido(c, id, puntos, enSegundo(90_000)));
  assert.equal(r.guardados, 4, 'los cuatro, aunque ya no esté en servicio');

  const rec = await recorridoDe(pool, id, enSegundo(-100), enSegundo(3600));
  assert.equal(rec.puntos, 4, 'y con la hora del móvil, dentro del turno de ayer');
  assert.ok(rec.metros > 800, `esperaba ~900 m y salieron ${rec.metros}`);
});

test('subir el mismo lote dos veces no duplica el recorrido', async () => {
  const id = await crearConductor();
  await transicion(id, 'DESCONECTADO', 'DISPONIBLE', enSegundo(0));
  const puntos = [0, 60, 120].map((seg) => ({ ...aMetros(seg * 5), en: enSegundo(seg) }));

  const primera = await enTransaccion(pool, (c) =>
    registrarRastroDiferido(c, id, puntos, enSegundo(9000)));
  const segunda = await enTransaccion(pool, (c) =>
    registrarRastroDiferido(c, id, puntos, enSegundo(9000)));

  assert.equal(primera.guardados, 3);
  assert.equal(segunda.guardados, 0, 'el reenvío no añade nada');
  const rec = await recorridoDe(pool, id, enSegundo(-100), enSegundo(3600));
  assert.equal(rec.puntos, 3);
});

test('lo que se apuntó fuera del turno no se sube: el móvil no decide eso', async () => {
  const id = await crearConductor();
  // Turno de la primera media hora y nada más.
  await transicion(id, 'DESCONECTADO', 'DISPONIBLE', enSegundo(0));
  await transicion(id, 'DISPONIBLE', 'DESCONECTADO', enSegundo(1800));

  const r = await enTransaccion(pool, (c) => registrarRastroDiferido(c, id, [
    { ...aMetros(0), en: enSegundo(60) },       // dentro
    { ...aMetros(500), en: enSegundo(5000) },   // fuera: ya había salido
    { ...aMetros(900), en: enSegundo(-5000) },  // fuera: antes de entrar
  ], enSegundo(9000)));

  assert.equal(r.guardados, 1, 'solo el del turno');
});

test('un lote demasiado apretado se aclara al recibirlo', async () => {
  const id = await crearConductor();
  await transicion(id, 'DESCONECTADO', 'DISPONIBLE', enSegundo(0));
  // Un punto por segundo durante un minuto: un cliente modificado podría
  // mandar esto y llenar la tabla que más crece de la base.
  const puntos = Array.from({ length: 60 }, (_, i) => ({
    ...aMetros(i * 50), en: enSegundo(i),
  }));

  const r = await enTransaccion(pool, (c) =>
    registrarRastroDiferido(c, id, puntos, enSegundo(9000)));
  assert.ok(r.guardados <= 3, `con 45 s de intervalo caben dos o tres, no ${r.guardados}`);
});

test('una hora del futuro no se guarda: el reloj del móvil no es la verdad', async () => {
  const id = await crearConductor();
  await transicion(id, 'DESCONECTADO', 'DISPONIBLE', enSegundo(0));

  const r = await enTransaccion(pool, (c) => registrarRastroDiferido(c, id, [
    { ...aMetros(0), en: enSegundo(100_000) },
  ], enSegundo(1000)));
  assert.equal(r.guardados, 0);
});
