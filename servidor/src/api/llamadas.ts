// Llamadas dentro de la aplicación, por internet (WebRTC).
//
// Por qué existe: pasajero y taxista tienen que poder hablar —en una ciudad sin
// direcciones postales, la llamada ES el mecanismo de encuentro— pero sin que
// ninguno vea el número del otro. Un número de teléfono no se puede retirar una
// vez entregado: queda en el registro de llamadas, se reenvía y se reutiliza
// después del viaje. Por eso aquí nadie da su número.
//
// Cómo funciona: el audio va DIRECTO de un teléfono al otro (WebRTC). Este
// servidor solo pasa el apretón de manos —la descripción de la sesión y los
// candidatos de red— de una punta a la otra. En términos de protección de
// datos, esto significa:
//
//   - El servidor NUNCA ve ni puede ver el audio. No es una promesa de
//     política, es que no pasa por aquí.
//   - No se guarda nada de las llamadas: ni con quién, ni cuándo, ni cuánto.
//     Emparejar a los dos ya consta en el viaje; el resto sería recoger datos
//     sin necesitarlos.
//   - Los mensajes de señalización no se persisten: se entregan a la conexión
//     viva o se pierden, como una llamada que no entra.
//
// Quién puede llamar a quién: SOLO los dos del mismo viaje, y SOLO mientras el
// viaje está vivo. Ni antes de aceptar, ni después de bajarse. Esa ventana es
// la garantía de fondo: fuera de ella el canal no existe.

import { createHmac, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { ConexionesSse } from '../eventos/adaptador-sse.js';

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mientras el taxi viene o lleva al pasajero dentro. Fuera de estos estados no
// hay nada que coordinar y el canal se cierra.
const ESTADOS_CON_VIAJE_VIVO = ['ACEPTADO', 'EN_CAMINO', 'RECOGIDO'];

// Lo único que se acepta reenviar. Una lista cerrada, no un buzón libre: sin
// esto el canal sería un servicio de mensajería anónima entre desconocidos.
const SENALES = ['oferta', 'respuesta', 'candidato', 'colgar', 'rechazar', 'ocupado'] as const;
type Senal = (typeof SENALES)[number];

// Tope de tamaño. Una descripción de sesión ronda los 4 KB; el resto es mucho
// menos. Con esto un cliente manipulado no puede usar el canal para colar
// contenido arbitrario al otro.
const MAXIMO_CARGA = 16_000;

function errorHttp(codigo: number, mensaje: string): Error & { statusCode: number } {
  const error = new Error(mensaje) as Error & { statusCode: number };
  error.statusCode = codigo;
  return error;
}

// Cuánto valen las credenciales del TURN. Lo justo para montar una llamada y
// que dure: pasado el plazo, la llamada en curso sigue —la autorización se
// comprueba al abrir el canal, no todo el rato— pero la credencial ya no sirve
// para abrir uno nuevo.
const VIDA_CREDENCIAL_SEG = 900;

// Credenciales de un solo uso para el TURN, con el esquema de secreto
// compartido de coturn (`use-auth-secret`).
//
// La alternativa sería un usuario y una contraseña fijos, y eso en una PWA es
// lo mismo que publicarlos: cualquiera abre las herramientas del navegador, los
// copia y usa el puente para su propio tráfico, que pagas tú. Aquí el servidor
// firma un usuario que caduca y la clave se deduce del secreto, que nunca sale
// de este proceso.
//
// El identificador es aleatorio, no el del dispositivo ni el del viaje: el TURN
// registra los usuarios en su log, y no hay razón para que ese log sepa quién
// viajaba con quién. Contra el abuso ya está el plazo corto y que solo se
// entregan a quien va en un viaje en curso.
export function credencialesEfimeras(
  secreto: string,
  ahoraSeg = Math.floor(Date.now() / 1000),
): { username: string; credential: string } {
  const caduca = ahoraSeg + VIDA_CREDENCIAL_SEG;
  const username = `${caduca}:${randomBytes(6).toString('hex')}`;
  const credential = createHmac('sha1', secreto).update(username).digest('base64');
  return { username, credential };
}

export interface Participantes {
  estado: string;
  dispositivoCliente: number;
  dispositivoConductor: number | null;
}

async function participantesDe(pool: pg.Pool, solicitudId: number): Promise<Participantes> {
  const res = await pool.query(
    `SELECT s.estado, s.dispositivo_cliente_id,
            (SELECT d.id FROM dispositivo d
             WHERE d.conductor_id = s.conductor_id AND d.tipo = 'conductor'
             ORDER BY COALESCE(d.ultimo_heartbeat, d.creado_en) DESC
             LIMIT 1) AS dispositivo_conductor
     FROM solicitud s WHERE s.id = $1`,
    [solicitudId],
  );
  if (res.rowCount === 0) {
    throw errorHttp(404, `No existe la solicitud ${solicitudId}.`);
  }
  const fila = res.rows[0];
  return {
    estado: fila.estado,
    dispositivoCliente: Number(fila.dispositivo_cliente_id),
    dispositivoConductor: fila.dispositivo_conductor === null
      ? null
      : Number(fila.dispositivo_conductor),
  };
}

// El dispositivo que llama, sea del rol que sea. A diferencia del resto de la
// API, aquí no se puede exigir un tipo concreto: por este canal pasan los dos.
async function dispositivoDeLaPeticion(pool: pg.Pool, req: FastifyRequest): Promise<number> {
  const uuid = (req.headers['x-dispositivo'] as string | undefined)
    ?? (req.query as Record<string, string | undefined>).dispositivo;
  if (!uuid || !PATRON_UUID.test(uuid)) {
    throw errorHttp(400, 'Falta la cabecera x-dispositivo con un UUID válido.');
  }
  const res = await pool.query(
    'SELECT id FROM dispositivo WHERE uuid_persistente = $1',
    [uuid.toLowerCase()],
  );
  if (res.rowCount === 0) {
    throw errorHttp(404, 'Dispositivo no registrado.');
  }
  return Number(res.rows[0].id);
}

export function registrarRutasLlamadas(
  app: FastifyInstance,
  pool: pg.Pool,
  conexionesSse: ConexionesSse,
): void {
  // Reenvía una señal al OTRO del viaje. Deliberadamente no pasa por la bandeja
  // de salida de eventos: los candidatos de red llegan a decenas por llamada y
  // solo sirven en el instante. Persistirlos y reintentarlos sería guardar
  // basura y entregar tarde lo que ya no vale.
  app.post('/api/solicitudes/:id/senal', async (req, reply) => {
    const solicitudId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(solicitudId)) {
      throw errorHttp(400, 'Identificador de solicitud no válido.');
    }
    const cuerpo = (req.body ?? {}) as { tipo?: string; carga?: unknown };
    if (!cuerpo.tipo || !SENALES.includes(cuerpo.tipo as Senal)) {
      throw errorHttp(400, `Señal desconocida: «${cuerpo.tipo}».`);
    }
    const serializada = JSON.stringify(cuerpo.carga ?? null);
    if (serializada.length > MAXIMO_CARGA) {
      throw errorHttp(413, 'Señal demasiado grande.');
    }

    const yo = await dispositivoDeLaPeticion(pool, req);
    const partes = await participantesDe(pool, solicitudId);

    const soyCliente = yo === partes.dispositivoCliente;
    const soyConductor = partes.dispositivoConductor !== null
      && yo === partes.dispositivoConductor;
    if (!soyCliente && !soyConductor) {
      // Ni «no existe» ni detalles: quien no es parte del viaje no merece saber
      // siquiera si el viaje existe.
      throw errorHttp(403, 'Este viaje no es tuyo.');
    }
    if (!ESTADOS_CON_VIAJE_VIVO.includes(partes.estado)) {
      throw errorHttp(409, 'Solo se puede llamar mientras el viaje está en curso.');
    }

    const destino = soyCliente ? partes.dispositivoConductor : partes.dispositivoCliente;
    if (destino === null) {
      throw errorHttp(409, 'El otro lado todavía no tiene aplicación abierta.');
    }

    const entregada = conexionesSse.entregarA(destino, JSON.stringify({
      tipo: 'llamada',
      solicitudId,
      datos: { senal: cuerpo.tipo, carga: cuerpo.carga ?? null, deConductor: soyConductor },
    })) > 0;

    // Se responde si llegó o no: quien llama necesita distinguir «está sonando»
    // de «tiene la aplicación cerrada», que para el usuario son cosas muy
    // distintas y hoy se confundirían en un mismo silencio.
    void reply.code(200);
    return { entregada };
  });

  // Configuración de red para atravesar el NAT del operador móvil.
  //
  // STUN basta cuando los dos teléfonos pueden verse. Con el NAT compartido que
  // usan casi todos los operadores móviles a menudo no pueden, y hace falta un
  // TURN que haga de puente: todo el audio pasa por él y lo paga quien lo
  // aloja. Por eso esto NO es una configuración pública.
  //
  // Va colgado de la solicitud y exige ser uno de los dos del viaje, igual que
  // la señalización. Un TURN cuyas credenciales se reparten a quien las pida es
  // ancho de banda gratis para cualquiera que encuentre la URL.
  app.get('/api/solicitudes/:id/llamada/configuracion', async (req, reply) => {
    const solicitudId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(solicitudId)) {
      throw errorHttp(400, 'Identificador de solicitud no válido.');
    }
    const yo = await dispositivoDeLaPeticion(pool, req);
    const partes = await participantesDe(pool, solicitudId);
    const esParte = yo === partes.dispositivoCliente
      || (partes.dispositivoConductor !== null && yo === partes.dispositivoConductor);
    if (!esParte) {
      throw errorHttp(403, 'Este viaje no es tuyo.');
    }
    if (!ESTADOS_CON_VIAJE_VIVO.includes(partes.estado)) {
      throw errorHttp(409, 'Solo se puede llamar mientras el viaje está en curso.');
    }

    const servidores: Array<{ urls: string | string[]; username?: string; credential?: string }> = [
      { urls: process.env.STUN_URL ?? 'stun:stun.l.google.com:19302' },
    ];
    // Dos maneras de tener puente, excluyentes:
    //   - TURN_SECRETO: coturn propio con credenciales efímeras (HMAC), la
    //     opción buena para producción (ver infraestructura/turn/LEEME.md).
    //   - TURN_USUARIO + TURN_CLAVE: credenciales fijas de un TURN alquilado
    //     (Metered, Twilio…). Peor —usuario y clave son eternos y un tercero
    //     ve los metadatos— pero se monta en cinco minutos y sin máquina
    //     propia. Para el piloto vale; el LEEME explica el paso a coturn.
    // TURN_URL admite varias URLs separadas por comas (los alquilados dan
    // udp, tcp y tls a la vez, y cada red deja pasar una distinta).
    if (process.env.TURN_URL) {
      const urls = process.env.TURN_URL.split(',').map((u) => u.trim()).filter(Boolean);
      if (process.env.TURN_SECRETO) {
        servidores.push({ urls, ...credencialesEfimeras(process.env.TURN_SECRETO) });
      } else if (process.env.TURN_USUARIO && process.env.TURN_CLAVE) {
        servidores.push({
          urls,
          username: process.env.TURN_USUARIO,
          credential: process.env.TURN_CLAVE,
        });
      }
    }
    const hayTurn = servidores.length > 1;
    // Sin caché: cada llamada recibe credenciales nuevas y caducas.
    void reply.header('cache-control', 'no-store');
    return { servidores, hayTurn };
  });
}
