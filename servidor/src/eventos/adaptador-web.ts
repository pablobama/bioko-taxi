// Adaptador de notificación web (migración 058): el aviso que suena con la
// aplicación CERRADA.
//
// Es el canal 2 del taxista. El canal 1 sigue siendo la conexión abierta
// —instantánea y sin gastar datos—, y cuando no la hay se llega aquí, que es
// justo el caso que faltaba: el móvil bloqueado en el bolsillo.
//
// Lo entrega el sistema operativo a través del servicio de push del navegador
// (Google, Mozilla, Apple), y por eso funciona sin la página abierta. El
// contenido va cifrado de punta a punta con las claves del propio navegador:
// el servicio de push mueve el sobre sin poder leerlo.

import type pg from 'pg';
import { enviarAlConductor } from '../dominio/notificaciones.js';
import type { Adaptador, EventoSalida } from './bus.js';

// Lo que la notificación dice según el evento. Texto corto y sin datos de
// nadie: es una pantalla de bloqueo, la puede leer cualquiera que pase.
function texto(evento: EventoSalida): { titulo: string; cuerpo: string } {
  const datos = evento.datos as { origen?: string; destino?: string; resultado?: string };
  if (evento.tipo === 'D1_broadcast_solicitud') {
    return {
      titulo: 'Nueva carrera',
      cuerpo: datos.origen && datos.destino
        ? `${datos.origen} → ${datos.destino}`
        : 'Toca para verla antes de que caduque.',
    };
  }
  if (evento.tipo === 'D2_reclamacion_resuelta') {
    return datos.resultado === 'ganada'
      ? { titulo: 'La carrera es tuya', cuerpo: 'Toca para ver dónde recoges.' }
      : { titulo: 'Carrera adjudicada a otro taxista', cuerpo: 'Sigues disponible.' };
  }
  return { titulo: 'Taxi Malabo', cuerpo: 'Tienes un aviso.' };
}

export class AdaptadorWeb implements Adaptador {
  async entregar(evento: EventoSalida, cliente: pg.ClientBase): Promise<string | void> {
    if (evento.conductorId === null) {
      throw new Error(`El evento ${evento.id} (${evento.tipo}) no tiene conductor destinatario.`);
    }
    const { titulo, cuerpo } = texto(evento);
    const resultado = await enviarAlConductor(cliente, Number(evento.conductorId), {
      tipo: evento.tipo,
      solicitudId: evento.solicitudId === null ? null : String(evento.solicitudId),
      titulo,
      cuerpo,
    });

    if (resultado.entregados > 0) return 'web';

    // Reintentar tiene sentido cuando el fallo puede pasar: el servicio de push
    // no contesta, se cayó la red del servidor. Ahí sí se lanza.
    if (resultado.error !== null) {
      throw new Error(`Notificación web no entregada: ${resultado.error}`);
    }

    // Y no lo tiene cuando no hay a dónde mandarla: este taxista no ha dado
    // permiso de notificaciones, o usa la app de Android, o la desinstaló. Eso
    // no se arregla reintentando diez veces; se deja escrito y se acaba, que
    // es lo que distingue «no se pudo» de «no había a quién».
    return resultado.caducados > 0 ? 'web_suscripcion_caducada' : 'web_sin_suscripcion';
  }
}
