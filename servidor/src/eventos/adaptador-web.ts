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
import { enviarADispositivo, enviarAlConductor } from '../dominio/notificaciones.js';
import type { Adaptador, EventoSalida } from './bus.js';

// Lo que la notificación dice según el evento. Texto corto y sin datos de
// nadie: es una pantalla de bloqueo, la puede leer cualquiera que pase.
function texto(evento: EventoSalida): { titulo: string; cuerpo: string } {
  const datos = evento.datos as {
    origen?: string; destino?: string; resultado?: string; zona?: string | null;
  };
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
  // El aviso al pasajero que se quedó sin taxi (migración 076). Es el único
  // que le llega, y por eso puede permitirse ser concreto: si dijera «tienes un
  // aviso» no sabría si merece sacar el teléfono del bolsillo.
  if (evento.tipo === 'C7_taxi_disponible') {
    return {
      titulo: 'Ya hay taxi',
      cuerpo: datos.zona
        ? `Ha entrado un taxi en ${datos.zona}. Vuelve a pedirlo.`
        : 'Ha entrado un taxi en tu barrio. Vuelve a pedirlo.',
    };
  }
  return { titulo: 'Taxi Malabo', cuerpo: 'Tienes un aviso.' };
}

export class AdaptadorWeb implements Adaptador {
  async entregar(evento: EventoSalida, cliente: pg.ClientBase): Promise<string | void> {
    // Al taxista se le busca por su ficha —puede tener dos móviles y la carrera
    // debe sonar en los dos—; al pasajero, por el teléfono con el que pidió,
    // que es el que lleva encima esperando en la calle. No tiene otra cosa.
    const alDispositivo = evento.conductorId === null;
    if (alDispositivo && evento.dispositivoClienteId === null) {
      throw new Error(`El evento ${evento.id} (${evento.tipo}) no tiene a quién avisar.`);
    }
    const { titulo, cuerpo } = texto(evento);
    const carga = {
      tipo: evento.tipo,
      solicitudId: evento.solicitudId === null ? null : String(evento.solicitudId),
      titulo,
      cuerpo,
    };
    const resultado = alDispositivo
      ? await enviarADispositivo(cliente, Number(evento.dispositivoClienteId), carga)
      : await enviarAlConductor(cliente, Number(evento.conductorId), carga);

    if (resultado.entregados > 0) return 'web';

    // Reintentar tiene sentido cuando el fallo puede pasar: el servicio de push
    // no contesta, se cayó la red del servidor. Ahí sí se lanza.
    if (resultado.error !== null) {
      throw new Error(`Notificación web no entregada: ${resultado.error}`);
    }

    // Y no lo tiene cuando no hay a dónde mandarla: quien tenía que recibirla
    // no ha dado permiso de notificaciones, o usa la app de Android, o la
    // desinstaló. Eso
    // no se arregla reintentando diez veces; se deja escrito y se acaba, que
    // es lo que distingue «no se pudo» de «no había a quién».
    return resultado.caducados > 0 ? 'web_suscripcion_caducada' : 'web_sin_suscripcion';
  }
}
