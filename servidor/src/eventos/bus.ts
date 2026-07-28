// Bus de eventos (paso 6, decisión 3.7).
//
// Dos piezas:
// - EmisorSalida: la implementación real de EmisorEventos. Escribe el evento
//   en evento_salida DENTRO de la transacción que lo causa (outbox): si la
//   transacción se deshace, el evento no existió jamás.
// - DespachadorEventos: tras el commit, lee pendientes, consulta la tabla
//   enrutamiento (datos, editable en caliente) y entrega por el adaptador
//   del canal. Fallo de canal_1 → escalada a canal_2. Sin regla o sin
//   adaptador → error ruidoso, reintentos y «abandonado» al agotarlos.

import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import type { EmisorEventos, Evento } from '../dominio/eventos.js';
import { leerParametroEntero } from '../dominio/parametros.js';

export interface EventoSalida {
  id: number;
  tipo: string;
  rol: 'cliente' | 'conductor';
  solicitudId: number | null;
  conductorId: number | null;
  dispositivoClienteId: number | null;
  datos: Record<string, unknown>;
}

export interface Adaptador {
  // Entrega el evento o lanza un error explicando por qué no pudo. Puede
  // devolver un detalle de canal (p. ej. 'sse_sin_conexion') que se guarda
  // en canal_entregado en lugar del nombre del canal.
  entregar(evento: EventoSalida, cliente: pg.ClientBase): Promise<string | void>;
}

export class EmisorSalida implements EmisorEventos {
  async emitir(evento: Evento, cliente: pg.ClientBase): Promise<void> {
    if (!cliente) {
      throw new Error(
        'EmisorSalida.emitir necesita el cliente de la transacción en curso: '
        + 'el evento debe confirmarse o deshacerse junto con lo que lo causó.',
      );
    }
    await cliente.query(
      `INSERT INTO evento_salida (tipo, rol, solicitud_id, conductor_id, dispositivo_cliente_id, datos)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        evento.tipo,
        evento.rol,
        evento.solicitudId ?? null,
        evento.conductorId ?? null,
        evento.dispositivoClienteId ?? null,
        JSON.stringify(evento.datos),
      ],
    );
  }
}

export class DespachadorEventos {
  constructor(
    private readonly pool: pg.Pool,
    private readonly adaptadores: Map<string, Adaptador>,
  ) {}

  // Procesa un lote de eventos pendientes. Idempotente y seguro con varios
  // procesos a la vez (FOR UPDATE SKIP LOCKED). Devuelve cuántos entregó.
  async procesarPendientes(): Promise<number> {
    return enTransaccion(this.pool, async (cliente) => {
      const maxIntentos = await leerParametroEntero(cliente, 'eventos_max_intentos');
      const pendientes = await cliente.query(
        `SELECT id, tipo, rol, solicitud_id, conductor_id, dispositivo_cliente_id, datos, intentos
         FROM evento_salida
         WHERE entregado_en IS NULL
         ORDER BY id
         LIMIT 50
         FOR UPDATE SKIP LOCKED`,
      );

      let entregados = 0;
      for (const fila of pendientes.rows) {
        const evento: EventoSalida = {
          id: fila.id,
          tipo: fila.tipo,
          rol: fila.rol,
          solicitudId: fila.solicitud_id,
          conductorId: fila.conductor_id,
          dispositivoClienteId: fila.dispositivo_cliente_id,
          datos: fila.datos,
        };

        const regla = await cliente.query(
          `SELECT canal_1, canal_2 FROM enrutamiento
           WHERE evento = $1 AND rol = $2 AND activo`,
          [evento.tipo, evento.rol],
        );

        try {
          if (regla.rowCount === 0) {
            throw new Error(`Sin regla de enrutamiento activa para (${evento.tipo}, ${evento.rol}).`);
          }
          const { canal_1: canal1, canal_2: canal2 } = regla.rows[0];

          // Supresión deliberada (caso C1): la regla existe y dice «nada».
          if (canal1 === null) {
            await this.marcarEntregado(cliente, evento.id, 'suprimido');
            continue;
          }

          try {
            const detalle = await this.entregarPor(canal1, evento, cliente);
            await this.marcarEntregado(cliente, evento.id, detalle ?? canal1);
          } catch (errorCanal1) {
            if (canal2 === null) {
              throw errorCanal1;
            }
            // Escalada al canal 2 (p. ej. D6: fcm → llamada del operador).
            const detalle = await this.entregarPor(canal2, evento, cliente);
            await this.marcarEntregado(cliente, evento.id, detalle ?? canal2);
          }
          entregados += 1;
        } catch (error) {
          const mensaje = error instanceof Error ? error.message : String(error);
          const intentos = fila.intentos + 1;
          if (intentos >= maxIntentos) {
            console.error(
              `Evento ${evento.id} (${evento.tipo}) abandonado tras ${intentos} intentos: ${mensaje}`,
            );
            await cliente.query(
              `UPDATE evento_salida
               SET intentos = $2, ultimo_error = $3, entregado_en = now(), canal_entregado = 'abandonado'
               WHERE id = $1`,
              [evento.id, intentos, mensaje],
            );
          } else {
            console.error(`Evento ${evento.id} (${evento.tipo}) sin entregar (intento ${intentos}): ${mensaje}`);
            await cliente.query(
              'UPDATE evento_salida SET intentos = $2, ultimo_error = $3 WHERE id = $1',
              [evento.id, intentos, mensaje],
            );
          }
        }
      }
      return entregados;
    });
  }

  private async entregarPor(
    canal: string,
    evento: EventoSalida,
    cliente: pg.ClientBase,
  ): Promise<string | void> {
    const adaptador = this.adaptadores.get(canal);
    if (!adaptador) {
      throw new Error(
        `No hay adaptador registrado para el canal «${canal}». `
        + `Registrados: ${[...this.adaptadores.keys()].join(', ') || 'ninguno'}.`,
      );
    }
    return adaptador.entregar(evento, cliente);
  }

  private async marcarEntregado(
    cliente: pg.ClientBase,
    eventoId: number,
    canal: string,
  ): Promise<void> {
    await cliente.query(
      `UPDATE evento_salida
       SET entregado_en = now(), canal_entregado = $2, intentos = intentos + 1
       WHERE id = $1`,
      [eventoId, canal],
    );
  }

  // Bucle de producción. Las pruebas llaman a procesarPendientes directamente.
  iniciar(intervaloMs = 2000): () => void {
    const temporizador = setInterval(() => {
      this.procesarPendientes().catch((error) => {
        console.error('Error del despachador de eventos:', error);
      });
    }, intervaloMs);
    return () => clearInterval(temporizador);
  }
}
