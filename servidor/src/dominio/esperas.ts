// Avisar al que se quedó sin taxi cuando entra uno en su barrio (076).
//
// La regla, en una frase: solo se avisa a quien está esperando, solo en su
// barrio, y una sola vez.
//
// Cada una de las tres tiene su motivo. A TODOS los usuarios no, porque casi
// ninguno está pidiendo taxi en ese momento y las notificaciones que no sirven
// se silencian —y al silenciarlas se pierden también las que sí—. SOLO SU
// BARRIO, porque un taxi que entra al otro lado de Malabo no le resuelve nada.
// Y UNA VEZ, porque lo que se está diciendo es «ya hay taxis», no «ha entrado
// alguien»: el segundo taxista no es una noticia nueva.

import type pg from 'pg';
import type { EmisorEventos } from './eventos.js';
import { leerParametroEntero } from './parametros.js';

type Lector = pg.Pool | pg.ClientBase;

// Se anota cuando una solicitud se cierra sin taxi.
//
// El barrio sale de la referencia de ORIGEN, que es donde hay que ir a
// recogerle: el destino no importa para esto.
export async function anotarEspera(
  cliente: pg.ClientBase,
  solicitudId: number,
  ahora = new Date(),
): Promise<void> {
  const minutos = await leerParametroEntero(cliente, 'aviso_taxi_libre_min');
  await cliente.query(
    `INSERT INTO espera_taxi (dispositivo_cliente_id, solicitud_id, zona_id, creada_en, caduca_en)
     SELECT s.dispositivo_cliente_id, s.id, r.zona_id, $2,
            $2::timestamptz + make_interval(mins => $3)
     FROM solicitud s JOIN referencia r ON r.id = s.referencia_origen_id
     WHERE s.id = $1
     ON CONFLICT (dispositivo_cliente_id) DO UPDATE
       SET solicitud_id = excluded.solicitud_id,
           zona_id = excluded.zona_id,
           creada_en = excluded.creada_en,
           caduca_en = excluded.caduca_en,
           -- Vuelve a esperar: el reloj se pone a cero y se le puede volver a
           -- avisar. Es una espera nueva, no la de antes.
           avisada_en = NULL`,
    [solicitudId, ahora, minutos],
  );
}

// Se llama cuando un taxista entra en servicio. Devuelve a cuántos se avisó.
export async function avisarTaxiLibre(
  cliente: pg.ClientBase,
  emisor: EmisorEventos,
  zonaId: number,
  ahora = new Date(),
): Promise<number> {
  // `FOR UPDATE SKIP LOCKED`: dos taxistas entrando a la vez en el mismo barrio
  // no pueden avisar dos veces a la misma persona. El primero se lleva las
  // filas y el segundo no ve ninguna, que es exactamente lo que se quiere.
  const esperando = await cliente.query(
    `SELECT id, dispositivo_cliente_id, solicitud_id
     FROM espera_taxi
     WHERE zona_id = $1 AND avisada_en IS NULL AND caduca_en > $2
     FOR UPDATE SKIP LOCKED`,
    [zonaId, ahora],
  );
  if (esperando.rowCount === 0) return 0;

  const zona = await cliente.query('SELECT nombre FROM zona WHERE id = $1', [zonaId]);
  for (const fila of esperando.rows) {
    await emisor.emitir({
      tipo: 'C7_taxi_disponible',
      rol: 'cliente',
      solicitudId: Number(fila.solicitud_id),
      dispositivoClienteId: Number(fila.dispositivo_cliente_id),
      datos: { zona: zona.rows[0]?.nombre ?? null },
    }, cliente);
  }
  await cliente.query(
    'UPDATE espera_taxi SET avisada_en = $2 WHERE id = ANY($1)',
    [esperando.rows.map((f) => Number(f.id)), ahora],
  );
  return esperando.rowCount ?? 0;
}

// Quien consigue taxi deja de esperar. Sin esto, alguien que pidió, se quedó
// sin taxi y volvió a pedir con suerte seguiría recibiendo el aviso de que
// «ya hay taxis» mientras va montado en uno.
export async function dejarDeEsperar(
  cliente: pg.ClientBase,
  dispositivoClienteId: number,
): Promise<void> {
  await cliente.query(
    'DELETE FROM espera_taxi WHERE dispositivo_cliente_id = $1',
    [dispositivoClienteId],
  );
}

// Las esperas vencidas se borran. No es limpieza: una espera vieja que se
// quedara ahí volvería a avisar a alguien que hace horas que resolvió lo suyo.
export async function purgarEsperas(cliente: Lector, ahora = new Date()): Promise<number> {
  const res = await cliente.query('DELETE FROM espera_taxi WHERE caduca_en < $1', [ahora]);
  return res.rowCount ?? 0;
}
