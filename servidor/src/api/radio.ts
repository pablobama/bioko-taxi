// API de la radio del gremio (migración 075).
//
// Cuatro cosas: pedir la palabra, soltarla, mandar el audio y bajarlo. El reparto
// va por la conexión SSE viva de cada taxista, igual que la señalización de las
// llamadas y por el mismo motivo: un mensaje de voz sirve AHORA. Si alguien
// tiene la aplicación cerrada no se le guarda un aviso pendiente —lo verá en la
// lista de los últimos cuando vuelva— porque una radio que te suelta de golpe
// veinte mensajes de hace una hora al abrirla no es una radio, es un castigo.
//
// Lo que falta, dicho aquí para que no se olvide: con la pantalla bloqueada esto
// no suena. El navegador no puede, y por eso existe la app Android (README). El
// aviso por FCM y el botón de volumen como botón de hablar son el paso
// siguiente, y son los que convierten esto en algo que se usa conduciendo.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import {
  audioDeMensaje, canalDe, canalDeLaCentral, guardarMensaje, limitesDeLaRadio,
  oyentesDe, oyentesPorConductor, pedirLaPalabra, quienHabla, radioEncendida,
  soltarLaPalabra, ultimosMensajes,
} from '../dominio/radio.js';
import { esOperadorAhora, permisosDeUuid } from './operador.js';
import type { EmisorEventos } from '../dominio/eventos.js';
import { leerParametroEntero } from '../dominio/parametros.js';
import type { ConexionesSse } from '../eventos/adaptador-sse.js';

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// El tope de verdad lo pone `radio_bytes_max` y se comprueba en el dominio; este
// es el corte bruto para que un cuerpo enorme no se llegue ni a leer en memoria.
const TOPE_CUERPO = 200_000;

function errorHttp(codigo: number, mensaje: string): Error & { statusCode: number } {
  const error = new Error(mensaje) as Error & { statusCode: number };
  error.statusCode = codigo;
  return error;
}

interface SesionConductor {
  dispositivoId: number;
  conductorId: number;
  // El nombre viaja con el aviso de «habla alguien»: sin él, los demás leen
  // «habla otro taxista», que en una radio no sirve de nada.
  nombre: string;
  canal: string;
}

export function registrarRutasRadio(
  app: FastifyInstance,
  pool: pg.Pool,
  emisor: EmisorEventos,
  conexionesSse: ConexionesSse,
): void {
  // El audio llega como cuerpo binario y no como formulario ni como base64. En
  // base64 los mismos diez segundos pesarían un tercio más, y aquí eso es dinero
  // del taxista.
  app.addContentTypeParser(
    /^audio\//,
    { parseAs: 'buffer', bodyLimit: TOPE_CUERPO },
    (_req, cuerpo, hecho) => { hecho(null, cuerpo); },
  );

  async function sesionDesde(req: FastifyRequest): Promise<SesionConductor> {
    const uuid = (req.headers['x-dispositivo'] as string | undefined)
      ?? (req.query as Record<string, string | undefined>).dispositivo;
    if (!uuid || !PATRON_UUID.test(uuid)) {
      throw errorHttp(400, 'Falta la cabecera x-dispositivo con un UUID válido.');
    }
    const res = await pool.query(
      `SELECT d.id, d.conductor_id, c.nombre
       FROM dispositivo d JOIN conductor c ON c.id = d.conductor_id
       WHERE d.uuid_persistente = $1 AND d.tipo = 'conductor'
         AND d.conductor_id IS NOT NULL`,
      [uuid.toLowerCase()],
    );
    if (res.rowCount === 0) {
      // La radio es del gremio: aquí no entra un pasajero.
      throw errorHttp(403, 'La radio es solo para taxistas registrados.');
    }
    const conductorId = Number(res.rows[0].conductor_id);
    return {
      dispositivoId: Number(res.rows[0].id),
      conductorId,
      nombre: res.rows[0].nombre,
      canal: await canalDe(pool, conductorId),
    };
  }

  // --- La Central (086) ------------------------------------------------------
  //
  // El operador escucha y emite en el mismo canal que el gremio, con las
  // mismas reglas: pide la palabra, el turno caduca igual, el tope de
  // mensajes por minuto le aplica igual. Su identidad es el uuid de su
  // aparato (080) y su nombre en el canal es «Central» — la voz nunca es
  // anónima, tampoco la suya.
  async function sesionOperador(req: FastifyRequest): Promise<{ uuid: string; canal: string }> {
    const uuid = (req.headers['x-dispositivo'] as string | undefined)
      ?? (req.query as Record<string, string | undefined>).dispositivo;
    if (!uuid || !PATRON_UUID.test(uuid)) {
      throw errorHttp(400, 'Falta la cabecera x-dispositivo con un UUID válido.');
    }
    if (!await esOperadorAhora(pool, uuid)) {
      throw errorHttp(403, 'Este dispositivo no tiene acceso de operador.');
    }
    return { uuid: uuid.toLowerCase(), canal: canalDeLaCentral() };
  }

  // Hablar como la Central es del perfil de DESPACHO (migración 090): escuchar
  // lo puede cualquier operador, pero emitir —pedir la palabra y mandar voz—
  // solo quien despacha. La raíz, que lo tiene todo, también.
  async function sesionCentral(req: FastifyRequest): Promise<{ uuid: string; canal: string }> {
    const yo = await sesionOperador(req);
    if (!(await permisosDeUuid(pool, yo.uuid)).has('despacho')) {
      throw errorHttp(403, 'Hablar como la Central es del perfil de despacho.');
    }
    return yo;
  }

  // La conexión viva de la Central (086): por aquí le llegan «habla X», los
  // mensajes nuevos y el silencio. El uuid puede ir en la query porque
  // EventSource no sabe mandar cabeceras, igual que en el audio de abajo.
  app.get('/api/operador/eventos', async (req, reply) => {
    const yo = await sesionOperador(req);
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write(`data: ${JSON.stringify({ tipo: 'conectado' })}\n\n`);
    const baja = conexionesSse.suscribirOperador(yo.uuid, (carga) => {
      reply.raw.write(`data: ${carga}\n\n`);
    });
    const latido = setInterval(() => {
      reply.raw.write(': latido\n\n');
    }, 25_000);
    req.raw.on('close', () => {
      clearInterval(latido);
      baja();
    });
    return reply; // la respuesta queda abierta
  });

  app.get('/api/operador/radio', async (req) => {
    const yo = await sesionOperador(req);
    const [encendida, limites, hablando, mensajes] = await Promise.all([
      radioEncendida(pool),
      limitesDeLaRadio(pool),
      quienHabla(pool, yo.canal),
      ultimosMensajes(pool, yo.canal),
    ]);
    return {
      encendida,
      canal: yo.canal,
      segundosMax: limites.segundosMax,
      habla: hablando,
      // «Mío» para la Central es lo que dijo la Central: los operadores son
      // una sola voz en el canal, y así se oyen a sí mismos como tal.
      mensajes: mensajes.map((m) => ({ ...m, mio: m.deCentral })),
    };
  });

  app.post('/api/operador/radio/turno', async (req, reply) => {
    const yo = await sesionCentral(req);
    const r = await pedirLaPalabra(pool, { canal: yo.canal, uuidOperador: yo.uuid });
    if (r.dada) {
      avisarATodos(yo.canal, null, yo.uuid, {
        tipo: 'radio_habla',
        datos: { conductorId: null, nombre: 'Central', caducaEn: r.caducaEn },
      });
      return { dada: true, caducaEn: r.caducaEn, segundosMax: r.segundosMax };
    }
    void reply.code(r.motivo === 'apagada' ? 404 : 409);
    return r;
  });

  app.delete('/api/operador/radio/turno', async (req) => {
    const yo = await sesionCentral(req);
    await soltarLaPalabra(pool, { canal: yo.canal, uuidOperador: yo.uuid });
    avisarATodos(yo.canal, null, yo.uuid, {
      tipo: 'radio_calla', datos: { conductorId: null },
    });
    return { soltado: true };
  });

  app.post('/api/operador/radio/mensaje', { bodyLimit: TOPE_CUERPO }, async (req, reply) => {
    const yo = await sesionCentral(req);
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      throw errorHttp(400, 'El cuerpo tiene que ser el audio, con content-type audio/...');
    }
    const duracionMs = Number(req.headers['x-duracion-ms']);
    if (!Number.isFinite(duracionMs) || duracionMs <= 0) {
      throw errorHttp(400, 'Falta la cabecera x-duracion-ms.');
    }
    const r = await guardarMensaje(pool, {
      canal: yo.canal,
      uuidOperador: yo.uuid,
      audio,
      tipoMedio: String(req.headers['content-type'] ?? 'audio/webm'),
      duracionMs,
    });
    if (!r.guardado) {
      void reply.code(r.motivo === 'apagada' ? 404 : r.motivo === 'sin_turno' ? 409 : 413);
      return r;
    }
    // A toda la flota, con la misma regla del despertar que cuando habla un
    // taxista; y a los demás operadores por su conexión viva.
    const carga = JSON.stringify({
      tipo: 'radio_mensaje',
      datos: { mensajeId: r.mensajeId, conductorId: null, duracionMs },
    });
    const avisoPush = (await leerParametroEntero(pool, 'radio_aviso_push')) === 1;
    let entregados = 0;
    for (const oyente of await oyentesPorConductor(pool, yo.canal, null)) {
      const mirando = oyente.dispositivos.some((d) => conexionesSse.hayAlguienMirando(d));
      if (mirando || !avisoPush) {
        for (const d of oyente.dispositivos) entregados += conexionesSse.entregarA(d, carga);
        continue;
      }
      await emisor.emitir({
        tipo: 'D8_radio_mensaje',
        rol: 'conductor',
        conductorId: oyente.conductorId,
        datos: { mensajeId: r.mensajeId, nombre: 'Central', duracionMs },
      }, pool as unknown as Parameters<typeof emisor.emitir>[1]);
      entregados += 1;
    }
    entregados += conexionesSse.entregarAOperadores(carga, yo.uuid);
    return { guardado: true, mensajeId: r.mensajeId, oyentes: entregados };
  });

  app.get('/api/operador/radio/mensaje/:id/audio', async (req, reply) => {
    const yo = await sesionOperador(req);
    const mensajeId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(mensajeId)) throw errorHttp(400, 'Identificador no válido.');
    const m = await audioDeMensaje(pool, mensajeId, yo.canal);
    if (m === null) throw errorHttp(404, 'Ese mensaje ya no está.');
    void reply.header('cache-control', 'private, max-age=7200');
    void reply.type(m.tipoMedio);
    return m.audio;
  });

  // Estado de la radio al abrir la pantalla: si está encendida, quién habla
  // ahora y los últimos mensajes. Sin audio: eso se baja solo si se pulsa.
  app.get('/api/conductor/radio', async (req) => {
    const yo = await sesionDesde(req);
    const [encendida, limites, hablando, mensajes] = await Promise.all([
      radioEncendida(pool),
      limitesDeLaRadio(pool),
      quienHabla(pool, yo.canal),
      ultimosMensajes(pool, yo.canal),
    ]);
    return {
      encendida,
      canal: yo.canal,
      segundosMax: limites.segundosMax,
      habla: hablando,
      mensajes: mensajes.map((m) => ({ ...m, mio: m.conductorId === yo.conductorId })),
    };
  });

  // Apretar el botón. Es lo primero que sale del teléfono, antes de que exista un
  // byte de audio: unos pocos bytes a cambio de saber en el acto si puedes
  // hablar o si le vas a hablar encima a otro.
  app.post('/api/conductor/radio/turno', async (req, reply) => {
    const yo = await sesionDesde(req);
    const r = await pedirLaPalabra(pool, yo);
    if (r.dada) {
      // A los demás se les pinta quién tiene la palabra: sin eso, el que espera
      // no sabe si el canal está ocupado o si su teléfono no va.
      // EL AVISO LLEVA SU PROPIA CADUCIDAD, y ese es el arreglo de un fallo que
      // se vio usándolo: el canal se quedaba «ocupado» para siempre.
      //
      // Antes se avisaba de que alguien empezaba a hablar y se confiaba en que
      // llegaría el aviso de que había callado. Pero ese segundo aviso solo
      // sale cuando se suelta el botón a tiempo: si el turno caduca solo, si
      // el envío del audio falla, o si al que hablaba se le cierra la
      // aplicación, no sale NUNCA, y los demás se quedan mirando un «habla
      // alguien» eterno sin poder apretar.
      //
      // Mandando `caducaEn` no hace falta ningún segundo aviso para el caso
      // malo: el turno tiene un tope que garantiza el servidor —no caben dos
      // filas en `turno_palabra` y esa fila vence—, así que cada pantalla sabe
      // por sí sola cuándo dejar de esperar.
      avisarATodos(yo.canal, yo.conductorId, null, {
        tipo: 'radio_habla',
        datos: { conductorId: yo.conductorId, nombre: yo.nombre, caducaEn: r.caducaEn },
      });
      return { dada: true, caducaEn: r.caducaEn, segundosMax: r.segundosMax };
    }
    // 409 y no 400: no es una petición mal hecha, es que el canal está ocupado.
    // La pantalla necesita distinguirlo para decir «habla Pablo» en vez de «error».
    void reply.code(r.motivo === 'apagada' ? 404 : 409);
    return r;
  });

  app.delete('/api/conductor/radio/turno', async (req) => {
    const yo = await sesionDesde(req);
    await soltarLaPalabra(pool, yo);
    avisarATodos(yo.canal, yo.conductorId, null, {
      tipo: 'radio_calla', datos: { conductorId: yo.conductorId },
    });
    return { soltado: true };
  });

  // El audio. `content-type` dice en qué lo grabó el navegador —Chrome da webm y
  // Safari mp4— y se guarda tal cual, porque es lo que el que escucha necesita
  // para reproducirlo.
  app.post('/api/conductor/radio/mensaje', { bodyLimit: TOPE_CUERPO }, async (req, reply) => {
    const yo = await sesionDesde(req);
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length === 0) {
      throw errorHttp(400, 'El cuerpo tiene que ser el audio, con content-type audio/...');
    }
    const duracionMs = Number(req.headers['x-duracion-ms']);
    if (!Number.isFinite(duracionMs) || duracionMs <= 0) {
      throw errorHttp(400, 'Falta la cabecera x-duracion-ms.');
    }

    const r = await guardarMensaje(pool, {
      ...yo,
      audio,
      tipoMedio: String(req.headers['content-type'] ?? 'audio/webm'),
      duracionMs,
    });
    if (!r.guardado) {
      void reply.code(r.motivo === 'apagada' ? 404 : r.motivo === 'sin_turno' ? 409 : 413);
      return r;
    }

    // A quién le llega, y por dónde. Dos caminos, y la regla que los separa es
    // la misma que la de las carreras (migración 077): el aviso que despierta el
    // teléfono SOLO sale si no hay nadie mirando.
    //
    // Con una pantalla delante, el mensaje ya suena en la propia página; una
    // notificación encima de lo que se está viendo es la forma más rápida de
    // que alguien apague los avisos — y al apagarlos pierde también las
    // carreras, que es lo que de verdad le da de comer.
    const carga = JSON.stringify({
      tipo: 'radio_mensaje',
      datos: { mensajeId: r.mensajeId, conductorId: yo.conductorId, duracionMs },
    });
    const avisoPush = (await leerParametroEntero(pool, 'radio_aviso_push')) === 1;
    let entregados = 0;
    for (const oyente of await oyentesPorConductor(pool, yo.canal, yo.conductorId)) {
      const mirando = oyente.dispositivos.some((d) => conexionesSse.hayAlguienMirando(d));
      if (mirando || !avisoPush) {
        for (const d of oyente.dispositivos) entregados += conexionesSse.entregarA(d, carga);
        continue;
      }
      // Nadie delante: va por la bandeja de eventos, que intenta la conexión
      // abierta y escala a la notificación. El audio NO viaja en el aviso —son
      // 25 KB y la notificación debe pesar lo que pesa un nombre—: dice quién ha
      // hablado y el teléfono lo baja al abrirse.
      await emisor.emitir({
        tipo: 'D8_radio_mensaje',
        rol: 'conductor',
        conductorId: oyente.conductorId,
        datos: { mensajeId: r.mensajeId, nombre: yo.nombre, duracionMs },
      }, pool as unknown as Parameters<typeof emisor.emitir>[1]);
      entregados += 1;
    }
    // La Central también lo oye, por su conexión viva.
    entregados += conexionesSse.entregarAOperadores(carga);
    // Se devuelve a cuántos llegó. Quien habla tiene derecho a saber si le oyó
    // alguien o si habló solo, que es la diferencia entre repetirlo y no.
    return { guardado: true, mensajeId: r.mensajeId, oyentes: entregados };
  });

  app.get('/api/conductor/radio/mensaje/:id/audio', async (req, reply) => {
    const yo = await sesionDesde(req);
    const mensajeId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(mensajeId)) throw errorHttp(400, 'Identificador no válido.');

    const m = await audioDeMensaje(pool, mensajeId, yo.canal);
    if (m === null) {
      // Ya se borró (dos horas) o es de otro canal. No se distingue: quien no
      // está en ese canal no tiene por qué saber si el mensaje existió.
      throw errorHttp(404, 'Ese mensaje ya no está.');
    }
    // Se puede guardar en el navegador: el audio nunca cambia y volver a oírlo
    // no tiene que costar otra bajada. Privado, que es de un canal cerrado.
    void reply.header('cache-control', 'private, max-age=7200');
    void reply.type(m.tipoMedio);
    return m.audio;
  });

  // Avisa a todo el canal por su conexión viva: taxistas Y Central, menos el
  // que habla. Nada de esto se persiste: «habla Pablo» entregado treinta
  // segundos tarde es peor que no entregarlo.
  function avisarATodos(
    canal: string,
    exceptoConductorId: number | null,
    exceptoUuidOperador: string | null,
    carga: { tipo: string; datos: unknown },
  ): void {
    void (async () => {
      try {
        const texto = JSON.stringify(carga);
        for (const dispositivoId of await oyentesDe(pool, canal, exceptoConductorId)) {
          conexionesSse.entregarA(dispositivoId, texto);
        }
        conexionesSse.entregarAOperadores(texto, exceptoUuidOperador);
      } catch {
        // Que no se pinte quién habla no puede tumbar la petición de quien habla.
      }
    })();
  }
}
