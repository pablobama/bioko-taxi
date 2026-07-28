// Adaptador «noop» (paso 6): entrega con éxito sin hacer nada, a propósito.
// Sirve para pruebas y para desactivar temporalmente un canal desde la tabla
// enrutamiento sin desplegar. No finge nada: su nombre queda registrado en
// evento_salida.canal_entregado.

import type { Adaptador, EventoSalida } from './bus.js';

export class AdaptadorNoop implements Adaptador {
  async entregar(_evento: EventoSalida): Promise<void> {
    // Nada, deliberadamente.
  }
}
