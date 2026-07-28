// Adaptador SSE (paso 6): entrega eventos de cliente a la conexión SSE viva
// del dispositivo, si la hay. La PWA del cliente mantiene esa conexión solo
// mientras espera (decisión 3.2).
//
// Si el dispositivo no tiene conexión en ese momento NO es un fallo: la PWA
// recupera el estado con la API al reconectar (el estado vive en la base de
// datos, no en el evento). Se registra como «sse_sin_conexion» para que
// quede rastro, y de paso alimenta la comprobación de R4 (¿tenía sesión
// activa el cliente cuando lo declararon ausente?).

import type pg from 'pg';
import type { Adaptador, EventoSalida } from './bus.js';

export type EnvioSse = (carga: string) => void;

export class ConexionesSse {
  private readonly porDispositivo = new Map<number, Set<EnvioSse>>();

  // El identificador SIEMPRE pasa por aquí antes de tocar el mapa.
  //
  // Los `bigint` de PostgreSQL llegan a Node como CADENA, no como número, para
  // no perder precisión. Así que quien se suscribe pasando `fila.id` registra
  // la clave "2067" y quien entrega pasando `Number(fila.id)` busca 2067: para
  // un Map no son la misma clave, y el mensaje se pierde sin ruido. Costó
  // encontrarlo una vez —las llamadas no sonaban y todo lo demás parecía
  // correcto— y no puede volver a pasar: se normaliza en un solo sitio.
  private static clave(dispositivoId: number | string): number {
    return Number(dispositivoId);
  }

  // Registra una conexión viva; devuelve la función para darla de baja.
  suscribir(dispositivoId: number | string, envio: EnvioSse): () => void {
    const clave = ConexionesSse.clave(dispositivoId);
    let conjunto = this.porDispositivo.get(clave);
    if (!conjunto) {
      conjunto = new Set();
      this.porDispositivo.set(clave, conjunto);
    }
    conjunto.add(envio);
    return () => {
      conjunto.delete(envio);
      if (conjunto.size === 0) {
        this.porDispositivo.delete(clave);
      }
    };
  }

  tieneConexion(dispositivoId: number | string): boolean {
    return this.porDispositivo.has(ConexionesSse.clave(dispositivoId));
  }

  entregarA(dispositivoId: number | string, carga: string): number {
    const conjunto = this.porDispositivo.get(ConexionesSse.clave(dispositivoId));
    if (!conjunto) {
      return 0;
    }
    for (const envio of conjunto) {
      envio(carga);
    }
    return conjunto.size;
  }
}

export class AdaptadorSse implements Adaptador {
  constructor(private readonly conexiones: ConexionesSse) {}

  async entregar(evento: EventoSalida, cliente: pg.ClientBase): Promise<string> {
    // Destinatario: el dispositivo del cliente, o el del conductor cuando el
    // evento es para él. El panel web del taxista usa esta misma vía; la app
    // Android usa FCM, que le llega con la pantalla apagada.
    let dispositivoId = evento.dispositivoClienteId;
    if (dispositivoId === null && evento.conductorId !== null) {
      const res = await cliente.query(
        `SELECT id FROM dispositivo
         WHERE conductor_id = $1 AND tipo = 'conductor'
         ORDER BY COALESCE(ultimo_heartbeat, creado_en) DESC
         LIMIT 1`,
        [evento.conductorId],
      );
      dispositivoId = res.rows[0]?.id ?? null;
    }
    if (dispositivoId === null) {
      throw new Error(`El evento ${evento.id} (${evento.tipo}) no tiene dispositivo destinatario.`);
    }
    const carga = JSON.stringify({
      tipo: evento.tipo,
      solicitudId: evento.solicitudId,
      datos: evento.datos,
    });
    const receptores = this.conexiones.entregarA(dispositivoId, carga);
    return receptores > 0 ? 'sse' : 'sse_sin_conexion';
  }
}
