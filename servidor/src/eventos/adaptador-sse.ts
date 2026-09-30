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
import type { Adaptador, EventoSalida, OpcionesEntrega } from './bus.js';

export type EnvioSse = (carga: string) => void;

// Una conexión viva y si quien la abrió está MIRANDO la pantalla.
//
// La diferencia importa y costó verla (29/09). Tener la aplicación abierta no
// es lo mismo que enterarse: con el teléfono bloqueado en el bolsillo, o con el
// navegador detrás de otra cosa, el aviso llega por el socket y no lo ve nadie
// —no sale notificación del sistema, y el sonido de la página lo puede callar
// el interruptor de silencio o el propio navegador al ralentizar la pestaña—.
// Medido en producción: 32 de 33 carreras se dieron por entregadas «por la
// conexión abierta», así que la notificación que sí suena no se usó ni una vez.
interface Conexion {
  envio: EnvioSse;
  // HASTA CUÁNDO vale el «estoy mirando», no un sí o un no.
  //
  // La primera versión guardaba un booleano y confiaba en que la pantalla
  // avisaría al irse a segundo plano. No siempre avisa: cuando el teléfono se
  // bloquea, el navegador puede congelar la página antes de que salga ese
  // último mensaje, y entonces el servidor se queda creyendo para siempre que
  // hay alguien delante — y no manda la notificación que habría sonado. Es
  // justo el caso que se venía a arreglar.
  //
  // Con una caducidad no hace falta que llegue ninguna despedida: si la
  // pantalla no vuelve a decir «sigo aquí», a los noventa segundos deja de
  // contar sola. Se cura sin depender de nadie.
  mirandoHasta: number;
}

// Cuánto vale un «estoy mirando» sin repetirlo. La pantalla lo renueva cada
// treinta segundos, así que noventa da margen para perder dos seguidos por mala
// cobertura sin dejar de sonar por la cara.
export const MIRANDO_VALE_MS = 90_000;

export class ConexionesSse {
  private readonly porDispositivo = new Map<number, Set<Conexion>>();

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
    // Quien acaba de abrir la conexión está delante. Si el cliente nunca dice
    // nada más, a los noventa segundos deja de contar, que es lo correcto: una
    // pantalla que no da señales no es una pantalla que alguien esté mirando.
    const conexion: Conexion = { envio, mirandoHasta: Date.now() + MIRANDO_VALE_MS };
    conjunto.add(conexion);
    return () => {
      conjunto.delete(conexion);
      if (conjunto.size === 0) {
        this.porDispositivo.delete(clave);
      }
    };
  }

  // Lo dice la propia pantalla cuando pasa a segundo plano o vuelve. Vale para
  // todas las conexiones del dispositivo: son la misma persona mirando o no.
  marcarVisibilidad(
    dispositivoId: number | string,
    visible: boolean,
    ahora = Date.now(),
  ): void {
    for (const c of this.porDispositivo.get(ConexionesSse.clave(dispositivoId)) ?? []) {
      c.mirandoHasta = visible ? ahora + MIRANDO_VALE_MS : 0;
    }
  }

  // ¿Hay alguien delante de la pantalla? Es la pregunta que decide si el aviso
  // se queda en el socket o hay que despertar el teléfono.
  hayAlguienMirando(dispositivoId: number | string, ahora = Date.now()): boolean {
    const conjunto = this.porDispositivo.get(ConexionesSse.clave(dispositivoId));
    if (!conjunto) return false;
    for (const c of conjunto) if (c.mirandoHasta > ahora) return true;
    return false;
  }

  tieneConexion(dispositivoId: number | string): boolean {
    return this.porDispositivo.has(ConexionesSse.clave(dispositivoId));
  }

  entregarA(dispositivoId: number | string, carga: string): number {
    const conjunto = this.porDispositivo.get(ConexionesSse.clave(dispositivoId));
    if (!conjunto) {
      return 0;
    }
    for (const c of conjunto) {
      c.envio(carga);
    }
    return conjunto.size;
  }
}

export class AdaptadorSse implements Adaptador {
  constructor(private readonly conexiones: ConexionesSse) {}

  async entregar(
    evento: EventoSalida,
    cliente: pg.ClientBase,
    opciones: OpcionesEntrega = { hayAlternativa: false },
  ): Promise<string> {
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
    // Entregado Y con alguien delante: ahí se acaba, que es lo instantáneo y lo
    // que no gasta datos.
    if (receptores > 0 && this.conexiones.hayAlguienMirando(dispositivoId)) return 'sse';

    // Entregado, pero a una pantalla que nadie está mirando. Hasta ahora esto
    // contaba como entregado y era el agujero: el taxista con el teléfono
    // bloqueado en el bolsillo tiene la aplicación «abierta», recibe el aviso
    // por el socket, y no se entera de nada. Se trata igual que no tener
    // conexión: si hay a dónde escalar, se escala.
    if (receptores > 0) {
      if (evento.rol === 'conductor' && opciones.hayAlternativa) {
        throw new Error(
          `El conductor ${evento.conductorId} tiene la aplicación en segundo `
          + `plano (evento ${evento.id}, ${evento.tipo}).`,
        );
      }
      return 'sse_oculto';
    }

    // Sin conexión viva. Para el PASAJERO no es un fallo y nunca lo fue: su
    // pantalla pregunta el estado cada diez o veinte segundos, así que se
    // enterará solo.
    //
    // Para el TAXISTA sí lo es, y hasta la migración 058 se daba por bueno.
    // Su aplicación cerrada no pregunta nada, y la carrera caducaba en veinte
    // segundos sin que la viera. Fallando aquí, el bus escala al canal 2 —la
    // notificación web—, que es lo único que suena con la aplicación cerrada.
    // Si no hay canal 2 configurado el evento queda como antes: sin entregar y
    // con su motivo escrito.
    //
    // Pero SOLO si hay a dónde escalar (21/09). La primera versión fallaba
    // siempre con el taxista desconectado, también en los avisos que no tienen
    // canal 2 —saldo bajo, viaje cerrado—, y esos acababan reintentándose diez
    // veces y marcados «abandonado» por la única razón de que la aplicación
    // estaba cerrada. Sin alternativa, no llegar es un dato y no un fallo:
    // se ven al abrir la aplicación, que es para lo que están.
    if (evento.rol === 'conductor' && opciones.hayAlternativa) {
      throw new Error(
        `El conductor ${evento.conductorId} no tiene la aplicación abierta `
        + `(evento ${evento.id}, ${evento.tipo}).`,
      );
    }
    return 'sse_sin_conexion';
  }
}
