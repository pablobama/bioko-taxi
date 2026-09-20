// Notificaciones web al taxista (migración 058).
//
// El problema que resuelven: los eventos del taxista salían solo por SSE, una
// conexión abierta que muere al cerrar el navegador o bloquear el móvil. Con
// la aplicación cerrada, la carrera le caducaba en veinte segundos sin que la
// viera nunca — y desde fuera parece que la plataforma no reparte.
//
// Aquí vive lo que no es HTTP ni bus de eventos: las claves con las que se
// firma cada envío y los buzones de cada dispositivo.

import pg from 'pg';
import webpush from 'web-push';

export interface ClavesVapid {
  publica: string;
  privada: string;
}

export interface SuscripcionWeb {
  id: number;
  endpoint: string;
  clave_p256dh: string;
  clave_auth: string;
}

// Un identificador de contacto, obligatorio en el protocolo: es a quién avisa
// el servicio de push (Google, Mozilla, Apple) si nuestros envíos dan
// problemas. Tiene que ser un mailto: o una URL nuestros.
const SUJETO = process.env.VAPID_SUJETO ?? 'mailto:soporte@taxi-malabo.example';

// Se lee una vez por proceso: son dos cadenas que no cambian nunca.
let enMemoria: ClavesVapid | null = null;

// Las claves VAPID, generándolas la primera vez.
//
// Generadas por el servidor y guardadas en la base, no puestas a mano en
// variables de entorno. Es deliberado: en variables de entorno hay que
// acordarse de configurarlas en Render, y el día que alguien recree el
// servicio sin ellas las notificaciones se apagan en silencio. Generándolas
// aquí, el sistema funciona recién instalado y las suscripciones siguen
// valiendo entre despliegues, que es lo que importa: una clave nueva invalida
// TODAS las suscripciones existentes.
//
// `ON CONFLICT DO NOTHING` y volver a leer: dos procesos arrancando a la vez
// —Render levanta el nuevo antes de apagar el viejo— generarían dos pares, y
// el que perdiera la carrera firmaría con una clave que nadie aceptó.
export async function clavesVapid(cliente: pg.ClientBase | pg.Pool): Promise<ClavesVapid> {
  if (enMemoria !== null) return enMemoria;
  const hay = await cliente.query('SELECT publica, privada FROM clave_vapid WHERE id');
  if ((hay.rowCount ?? 0) > 0) {
    enMemoria = { publica: hay.rows[0].publica, privada: hay.rows[0].privada };
    return enMemoria;
  }
  const nuevas = webpush.generateVAPIDKeys();
  await cliente.query(
    `INSERT INTO clave_vapid (publica, privada) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [nuevas.publicKey, nuevas.privateKey],
  );
  const leidas = await cliente.query('SELECT publica, privada FROM clave_vapid WHERE id');
  enMemoria = { publica: leidas.rows[0].publica, privada: leidas.rows[0].privada };
  return enMemoria;
}

// Solo para las pruebas, que crean y tiran bases a voluntad.
export function olvidarClavesVapid(): void {
  enMemoria = null;
}

export async function guardarSuscripcion(
  cliente: pg.ClientBase | pg.Pool,
  dispositivoId: number,
  suscripcion: { endpoint: string; p256dh: string; auth: string },
): Promise<void> {
  // El mismo navegador puede reinstalarse en otro dispositivo de la base (un
  // taxista que entra con otro teléfono y luego vuelve): el buzón es el mismo
  // y lo que cambia es de quién es. De ahí el UPDATE del dispositivo.
  await cliente.query(
    `INSERT INTO suscripcion_web (dispositivo_id, endpoint, clave_p256dh, clave_auth)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE
       SET dispositivo_id = EXCLUDED.dispositivo_id,
           clave_p256dh = EXCLUDED.clave_p256dh,
           clave_auth = EXCLUDED.clave_auth,
           ultimo_error = NULL`,
    [dispositivoId, suscripcion.endpoint, suscripcion.p256dh, suscripcion.auth],
  );
}

export async function borrarSuscripcion(
  cliente: pg.ClientBase | pg.Pool,
  endpoint: string,
): Promise<void> {
  await cliente.query('DELETE FROM suscripcion_web WHERE endpoint = $1', [endpoint]);
}

// Los buzones de un conductor: los de TODOS sus dispositivos de taxista.
//
// Todos y no el último: un taxista con el móvil del trabajo y el suyo debe
// oír la carrera en los dos, y no hay forma de saber cuál tiene en la mano.
export async function suscripcionesDelConductor(
  cliente: pg.ClientBase | pg.Pool,
  conductorId: number,
): Promise<SuscripcionWeb[]> {
  const res = await cliente.query(
    `SELECT s.id, s.endpoint, s.clave_p256dh, s.clave_auth
     FROM suscripcion_web s
     JOIN dispositivo d ON d.id = s.dispositivo_id
     WHERE d.conductor_id = $1 AND d.tipo = 'conductor'`,
    [conductorId],
  );
  return res.rows.map((f) => ({
    id: Number(f.id),
    endpoint: f.endpoint,
    clave_p256dh: f.clave_p256dh,
    clave_auth: f.clave_auth,
  }));
}

export interface ResultadoEnvio {
  entregados: number;
  // Buzones que ya no existen (404/410): el navegador se desinstaló o el
  // usuario revocó el permiso. Se borran, no se reintentan.
  caducados: number;
  // Todo lo demás: sin red, servicio de push caído, clave mal. Eso sí se
  // reintenta, así que se devuelve para que el bus lo sepa.
  error: string | null;
}

// Manda una notificación a todos los buzones de un conductor.
//
// El texto va dentro y cifrado —el protocolo lo exige—, así que el servicio de
// push no ve de qué carrera se trata. Se manda lo justo para decidir si merece
// la pena mirar el teléfono: nunca el teléfono del pasajero ni su posición.
export async function enviarAlConductor(
  cliente: pg.ClientBase | pg.Pool,
  conductorId: number,
  carga: Record<string, unknown>,
  ttlSeg = 60,
): Promise<ResultadoEnvio> {
  const buzones = await suscripcionesDelConductor(cliente, conductorId);
  if (buzones.length === 0) return { entregados: 0, caducados: 0, error: null };

  const claves = await clavesVapid(cliente);
  const resultado: ResultadoEnvio = { entregados: 0, caducados: 0, error: null };

  for (const buzon of buzones) {
    try {
      await webpush.sendNotification(
        {
          endpoint: buzon.endpoint,
          keys: { p256dh: buzon.clave_p256dh, auth: buzon.clave_auth },
        },
        JSON.stringify(carga),
        {
          // TTL: cuánto guarda el servicio de push el mensaje si el móvil está
          // apagado. Una carrera caduca en veinte segundos; guardarla una hora
          // solo sirve para que suene cuando ya no existe.
          TTL: ttlSeg,
          urgency: 'high',
          vapidDetails: {
            subject: SUJETO,
            publicKey: claves.publica,
            privateKey: claves.privada,
          },
        },
      );
      resultado.entregados += 1;
      await cliente.query('UPDATE suscripcion_web SET usado_en = now(), ultimo_error = NULL WHERE id = $1', [buzon.id]);
    } catch (error) {
      const estado = (error as { statusCode?: number }).statusCode ?? 0;
      const mensaje = error instanceof Error ? error.message : String(error);
      if (estado === 404 || estado === 410) {
        await borrarSuscripcion(cliente, buzon.endpoint);
        resultado.caducados += 1;
      } else {
        resultado.error = mensaje;
        await cliente.query(
          'UPDATE suscripcion_web SET ultimo_error = $2 WHERE id = $1',
          [buzon.id, mensaje],
        );
      }
    }
  }
  return resultado;
}
