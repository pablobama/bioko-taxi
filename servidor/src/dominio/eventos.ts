// Eventos de dominio (decisión 3.7): el núcleo emite eventos; unos
// adaptadores intercambiables los entregan. Este fichero define el contrato;
// el bus real (src/eventos/) enruta con la tabla enrutamiento y entrega por
// los adaptadores fcm/sse/noop.

import type pg from 'pg';

export interface Evento {
  // Nombre del evento tal y como aparece en la tabla enrutamiento
  // (p. ej. 'D1_broadcast_solicitud', 'C2_conductor_asignado').
  tipo: string;
  rol: 'cliente' | 'conductor';
  // Ausente en eventos que no nacen de una solicitud (p. ej. suscripción).
  solicitudId?: number;
  // Destinatario según rol: conductor por id, cliente por su dispositivo.
  conductorId?: number;
  dispositivoClienteId?: number;
  datos: Record<string, unknown>;
}

export interface EmisorEventos {
  // El dominio emite siempre dentro de una transacción y pasa su cliente:
  // el emisor real escribe el evento en el buzón de salida DE ESA transacción
  // (patrón outbox); si la transacción se deshace, el evento no existió.
  emitir(evento: Evento, cliente: pg.ClientBase): void | Promise<void>;
}

// Emisor que solo registra en memoria. Lo usan las pruebas de dominio para
// afirmar qué se emitió y a quién; no entrega nada y no finge haberlo hecho.
export class EmisorRegistro implements EmisorEventos {
  eventos: Evento[] = [];

  emitir(evento: Evento, _cliente: pg.ClientBase): void {
    this.eventos.push(evento);
  }

  deTipo(tipo: string): Evento[] {
    return this.eventos.filter((e) => e.tipo === tipo);
  }
}
