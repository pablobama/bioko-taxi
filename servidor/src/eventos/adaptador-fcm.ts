// Adaptador FCM (paso 6, decisión 3.3): mensajes de datos con prioridad alta
// al dispositivo del conductor. La prioridad alta los exime de Doze.
//
// Requiere el JSON de cuenta de servicio de Firebase (variable de entorno
// FCM_CREDENCIALES_RUTA). Sin credenciales, el constructor falla ruidosamente:
// en desarrollo se registra el canal «fcm» solo si está configurado, y la
// tabla enrutamiento permite desviar a «noop» sin desplegar.

import { readFileSync } from 'node:fs';
import { cert, initializeApp, type App } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type pg from 'pg';
import type { Adaptador, EventoSalida } from './bus.js';

export class AdaptadorFcm implements Adaptador {
  private readonly app: App;

  constructor(rutaCredenciales: string | undefined = process.env.FCM_CREDENCIALES_RUTA) {
    if (!rutaCredenciales) {
      throw new Error(
        'AdaptadorFcm sin configurar: define FCM_CREDENCIALES_RUTA con la ruta del JSON '
        + 'de cuenta de servicio de Firebase. En desarrollo, enruta a «noop» en la tabla enrutamiento.',
      );
    }
    const credenciales = JSON.parse(readFileSync(rutaCredenciales, 'utf8'));
    this.app = initializeApp({ credential: cert(credenciales) }, 'taxi-fcm');
  }

  async entregar(evento: EventoSalida, cliente: pg.ClientBase): Promise<void> {
    if (evento.conductorId === null) {
      throw new Error(`El evento ${evento.id} (${evento.tipo}) no tiene conductor destinatario.`);
    }
    const dispositivo = await cliente.query(
      `SELECT fcm_token FROM dispositivo
       WHERE conductor_id = $1 AND tipo = 'conductor' AND fcm_token IS NOT NULL
       ORDER BY COALESCE(ultimo_heartbeat, creado_en) DESC
       LIMIT 1`,
      [evento.conductorId],
    );
    if (dispositivo.rowCount === 0) {
      throw new Error(`El conductor ${evento.conductorId} no tiene dispositivo con token FCM.`);
    }

    // Mensaje de datos (sin notification): la app del conductor decide qué
    // mostrar. Los valores de data deben ser cadenas.
    await getMessaging(this.app).send({
      token: dispositivo.rows[0].fcm_token,
      android: { priority: 'high' },
      data: {
        tipo: evento.tipo,
        solicitudId: String(evento.solicitudId ?? ''),
        datos: JSON.stringify(evento.datos),
      },
    });
  }
}
