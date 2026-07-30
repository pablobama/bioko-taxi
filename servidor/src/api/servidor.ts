// API HTTP del cliente (paso 7). Payloads mínimos, errores explícitos.
//
// Identidad del cliente: el uuid persistente de su dispositivo (regla 4.2.4),
// en la cabecera «x-dispositivo» (o el parámetro ?dispositivo= para SSE, que
// no admite cabeceras). No hay cuentas ni contraseñas en esta fase.

import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import { iniciarDespacho } from '../dominio/despacho.js';
import { ErrorTransicionInvalida } from '../dominio/errores.js';
import type { EmisorEventos } from '../dominio/eventos.js';
import { buscarReferencias, referenciasMasUsadas } from '../dominio/gazetteer.js';
import { ocupacionDe, rutaDe } from '../dominio/ocupacion.js';
import { leerParametroEntero } from '../dominio/parametros.js';
import { registrarPosicion } from '../dominio/proximidad.js';
import { estimarLlegada, reputacionDe, valorarViaje } from '../dominio/reputacion.js';
import { crearSolicitud, transicionarConductor, transicionarSolicitud } from '../dominio/transiciones.js';
import type { ConexionesSse } from '../eventos/adaptador-sse.js';
import { registrarRutasConductor } from './conductor.js';
import { registrarRutasLlamadas } from './llamadas.js';
import { registrarRutasOperador } from './operador.js';
import { registrarRutasSesion } from './sesion.js';

interface DispositivoCliente {
  id: number;
  bloqueado: boolean;
}

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function crearServidor(
  pool: pg.Pool,
  emisor: EmisorEventos,
  conexionesSse: ConexionesSse,
): FastifyInstance {
  const app = Fastify({ logger: false });

  // Compresión gzip a mano. El plano compilado son 216 KB de JSON que sin esto
  // viajan enteros: con gzip son 55 KB. En una red cara la diferencia importa
  // más que el poco código que cuesta. Se hace aquí y no con un complemento
  // porque @fastify/compress no instala en esta máquina (arquitectura de CPU).
  app.addHook('onSend', async (peticion, respuesta, carga) => {
    const acepta = String(peticion.headers['accept-encoding'] ?? '');
    if (!acepta.includes('gzip') || respuesta.getHeader('content-encoding')) {
      return carga;
    }
    const tipo = String(respuesta.getHeader('content-type') ?? '');
    const comprimible = /^(application\/json|application\/javascript|text\/)/.test(tipo);
    if (!comprimible) {
      return carga;
    }
    // Los flujos (SSE) no se comprimen: hay que entregarlos a trozos.
    if (typeof carga !== 'string' && !Buffer.isBuffer(carga)) {
      return carga;
    }
    const original = Buffer.isBuffer(carga) ? carga : Buffer.from(carga);
    // Por debajo de 1 KB comprimir cuesta más de lo que ahorra.
    if (original.length < 1024) {
      return carga;
    }
    const comprimido = gzipSync(original);
    void respuesta.header('content-encoding', 'gzip');
    void respuesta.header('content-length', comprimido.length);
    void respuesta.header('vary', 'accept-encoding');
    return comprimido;
  });

  registrarRutasSesion(app, pool);
  registrarRutasConductor(app, pool, emisor, conexionesSse);
  registrarRutasLlamadas(app, pool, conexionesSse);
  registrarRutasOperador(app, pool, emisor);

  // Resuelve (y da de alta si es nuevo) el dispositivo del cliente.
  async function dispositivoDesde(req: FastifyRequest): Promise<DispositivoCliente> {
    const uuid = (req.headers['x-dispositivo'] as string | undefined)
      ?? (req.query as Record<string, string | undefined>).dispositivo;
    if (!uuid || !PATRON_UUID.test(uuid)) {
      throw errorHttp(400, 'Falta la cabecera x-dispositivo con un UUID válido.');
    }
    const res = await pool.query(
      `INSERT INTO dispositivo (uuid_persistente, tipo)
       VALUES ($1, 'cliente')
       ON CONFLICT (uuid_persistente) DO UPDATE SET ultimo_heartbeat = now()
       RETURNING id, tipo, bloqueado_en`,
      [uuid.toLowerCase()],
    );
    const fila = res.rows[0];
    if (fila.tipo !== 'cliente') {
      throw errorHttp(400, 'Este dispositivo está registrado como dispositivo de conductor.');
    }
    return { id: fila.id, bloqueado: fila.bloqueado_en !== null };
  }

  function errorHttp(codigo: number, mensaje: string): Error & { statusCode: number } {
    const error = new Error(mensaje) as Error & { statusCode: number };
    error.statusCode = codigo;
    return error;
  }

  app.setErrorHandler((error: unknown, _req, reply) => {
    const codigo = (error as { statusCode?: number }).statusCode ?? 500;
    const mensaje = error instanceof Error ? error.message : String(error);
    if (codigo >= 500) {
      console.error('Error de la API:', error);
    }
    void reply.status(codigo).send({ error: mensaje });
  });

  // Señal de vida para el hosting (healthCheckPath en render.yaml). Dice si el
  // PROCESO responde, y a propósito no toca la base de datos: si el sondeo
  // dependiera de Supabase, un pooler lento haría que el hosting matara y
  // reiniciara un servidor que está perfectamente sano — y con él las
  // conexiones SSE de todos los viajes en curso. Sin cabeceras ni permisos:
  // no revela nada que no se sepa por el propio dominio respondiendo.
  app.get('/api/vivo', async () => ({ vivo: true }));

  // --- Gazetteer ----------------------------------------------------------

  app.get('/api/referencias', async (req) => {
    const { q, zonaId } = req.query as { q?: string; zonaId?: string };
    if (!q || q.trim().length < 2) {
      throw errorHttp(400, 'Parámetro q obligatorio, mínimo 2 caracteres.');
    }
    const resultados = await buscarReferencias(pool, q, {
      zonaId: zonaId ? Number(zonaId) : undefined,
      limite: 5,
    });
    return resultados.map((r) => ({
      id: r.id, nombre: r.nombre, zona: r.zona, lat: r.lat, lng: r.lng, categoria: r.categoria,
    }));
  });

  // Puntos del mapa esquemático (migración 014). Son las referencias reales
  // del gazetteer con sus coordenadas: la PWA dibuja el mapa en SVG a partir
  // de esto. No hay baldosas ni cartografía de calles; el payload son unos
  // pocos KB y se cachea en el cliente.
  app.get('/api/mapa', async (_req, reply) => {
    // Tope explícito: el catálogo previsto son 300-800 referencias (sección 7)
    // y a 800 el payload ronda los 12 KB comprimidos. Si algún día se pasa de
    // ahí, se envían las más usadas y se avisa en el log: nunca se recorta en
    // silencio.
    const LIMITE_MAPA = 800;
    const res = await pool.query(
      `SELECT r.id, r.nombre, r.lat, r.lng, r.zona_id, z.nombre AS zona,
              r.veces_usada::int AS usos, r.categoria
       FROM referencia r JOIN zona z ON z.id = r.zona_id
       WHERE r.activa
       ORDER BY r.veces_usada DESC, r.id
       LIMIT $1`,
      [LIMITE_MAPA],
    );
    if (res.rowCount === LIMITE_MAPA) {
      const total = await pool.query('SELECT count(*)::int AS n FROM referencia WHERE activa');
      if (total.rows[0].n > LIMITE_MAPA) {
        console.warn(
          `/api/mapa recortado: ${total.rows[0].n} referencias activas, se envían las `
          + `${LIMITE_MAPA} más usadas. Revisa si el catálogo debe depurarse.`,
        );
      }
    }
    const zonas = await pool.query(
      `SELECT id, nombre, centroide_lat AS lat, centroide_lng AS lng FROM zona
       WHERE centroide_lat IS NOT NULL ORDER BY nombre`,
    );
    // 10 minutos: ahorra casi todos los datos en sesiones repetidas sin que
    // una referencia recién añadida por el operador tarde una hora en verse.
    void reply.header('cache-control', 'public, max-age=600');
    return {
      referencias: res.rows.map((f) => ({
        id: f.id,
        nombre: f.nombre,
        lat: f.lat,
        lng: f.lng,
        zonaId: f.zona_id,
        usos: f.usos,
        categoria: f.categoria,
      })),
      zonas: zonas.rows.map((z) => ({ id: z.id, nombre: z.nombre, lat: z.lat, lng: z.lng })),
    };
  });

  // Respaldo de R1: las 5 más usadas de una zona.
  app.get('/api/zonas/:zonaId/referencias-frecuentes', async (req) => {
    const zonaId = Number((req.params as { zonaId: string }).zonaId);
    const resultados = await referenciasMasUsadas(pool, zonaId, 5);
    return resultados.map((r) => ({
      id: r.id, nombre: r.nombre, zona: r.zona, categoria: r.categoria, lat: r.lat, lng: r.lng,
    }));
  });

  // Destinos para pedir taxi SIN ESCRIBIR.
  //
  // Escribir es la barrera más alta de la aplicación: quien no escribe con
  // soltura —o no escribe— no puede pedir un taxi por muy bien que funcione
  // todo lo demás. Y el caso normal ni siquiera necesita el teclado: la gente
  // repite trayectos (casa, trabajo, mercado), así que con cuatro botones se
  // cubre la mayoría de los viajes.
  //
  // Se mezclan dos fuentes, en este orden:
  //   1. A dónde ha ido ESTE dispositivo. Es la señal fuerte.
  //   2. A dónde va la gente desde la zona en la que está. Es lo que salva al
  //      usuario nuevo, que no tiene historial y es justo el que más ayuda
  //      necesita.
  app.get('/api/destinos-sugeridos', async (req) => {
    const dispositivo = await dispositivoDesde(req);
    const { origenId } = req.query as { origenId?: string };
    const TOPE = 6;

    const propios = await pool.query(
      `SELECT r.id, r.nombre, r.lat, r.lng, r.categoria, z.nombre AS zona,
              count(*)::int AS veces
       FROM solicitud s
       JOIN referencia r ON r.id = s.referencia_destino_id
       JOIN zona z ON z.id = r.zona_id
       WHERE s.dispositivo_cliente_id = $1 AND r.activa
       GROUP BY r.id, z.nombre
       ORDER BY count(*) DESC, max(s.creada_en) DESC
       LIMIT $2`,
      [dispositivo.id, TOPE],
    );

    // `motivo` sirve para que la pantalla pueda decir POR QUÉ ofrece cada
    // sitio: «vas a menudo» no es lo mismo que «de aquí se va a».
    interface DestinoSugerido {
      id: number;
      nombre: string;
      zona: string;
      lat: number;
      lng: number;
      categoria: string;
      motivo: 'tuyo' | 'zona';
    }

    const sugeridos: DestinoSugerido[] = propios.rows.map((f) => ({
      id: f.id,
      nombre: f.nombre,
      zona: f.zona,
      lat: f.lat,
      lng: f.lng,
      categoria: f.categoria,
      motivo: 'tuyo',
    }));

    // Se completa con los de la zona hasta llenar el hueco. Si el usuario ya
    // tiene seis sitios suyos, no hace falta enseñarle los de nadie más.
    if (sugeridos.length < TOPE && origenId) {
      const zona = await pool.query(
        'SELECT zona_id FROM referencia WHERE id = $1',
        [Number(origenId)],
      );
      if ((zona.rowCount ?? 0) > 0) {
        const populares = await referenciasMasUsadas(pool, zona.rows[0].zona_id, TOPE + 2);
        const yaEstan = new Set(sugeridos.map((s) => String(s.id)));
        for (const p of populares) {
          if (sugeridos.length >= TOPE) break;
          // Ni repetidos, ni ofrecer como destino el sitio donde ya está.
          if (yaEstan.has(String(p.id)) || String(p.id) === String(origenId)) continue;
          yaEstan.add(String(p.id));
          sugeridos.push({
            id: p.id,
            nombre: p.nombre,
            zona: p.zona,
            lat: p.lat,
            lng: p.lng,
            categoria: p.categoria,
            motivo: 'zona',
          });
        }
      }
    }

    return sugeridos.filter((s) => String(s.id) !== String(origenId ?? ''));
  });

  // --- Perfil del pasajero (migración 015) --------------------------------
  //
  // Recordatorio: no es autenticación. Sin verificación de teléfono ni de
  // correo, esto son datos de contacto que el usuario declara. La identidad
  // sigue siendo el dispositivo.

  const GENEROS = ['mujer', 'hombre', 'otro', 'sin_decir'];

  app.get('/api/perfil', async (req) => {
    const dispositivo = await dispositivoDesde(req);
    const res = await pool.query(
      'SELECT telefono, correo, nombre, edad, genero FROM perfil_cliente WHERE dispositivo_id = $1',
      [dispositivo.id],
    );
    if (res.rowCount === 0) {
      return { registrado: false, perfil: null, bloqueado: dispositivo.bloqueado };
    }
    return { registrado: true, perfil: res.rows[0], bloqueado: dispositivo.bloqueado };
  });

  app.put('/api/perfil', async (req) => {
    const dispositivo = await dispositivoDesde(req);
    const cuerpo = (req.body ?? {}) as {
      telefono?: string; correo?: string; nombre?: string; edad?: number; genero?: string;
    };

    const telefono = cuerpo.telefono?.trim() || null;
    const correo = cuerpo.correo?.trim().toLowerCase() || null;
    if (!telefono && !correo) {
      throw errorHttp(400, 'Necesitamos al menos un teléfono o un correo para poder avisarte.');
    }
    if (telefono && !/^\+?[0-9\s-]{6,20}$/.test(telefono)) {
      throw errorHttp(400, `Teléfono no válido: «${telefono}».`);
    }
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) {
      throw errorHttp(400, `Correo no válido: «${correo}».`);
    }
    if (cuerpo.edad !== undefined && cuerpo.edad !== null
      && (!Number.isInteger(cuerpo.edad) || cuerpo.edad < 12 || cuerpo.edad > 120)) {
      throw errorHttp(400, 'La edad debe ser un número entre 12 y 120, o dejarse vacía.');
    }
    if (cuerpo.genero !== undefined && cuerpo.genero !== null && cuerpo.genero !== ''
      && !GENEROS.includes(cuerpo.genero)) {
      throw errorHttp(400, `Género no válido. Opciones: ${GENEROS.join(', ')}.`);
    }

    const res = await pool.query(
      `INSERT INTO perfil_cliente (dispositivo_id, telefono, correo, nombre, edad, genero)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (dispositivo_id) DO UPDATE
         SET telefono = EXCLUDED.telefono,
             correo = EXCLUDED.correo,
             nombre = EXCLUDED.nombre,
             edad = EXCLUDED.edad,
             genero = EXCLUDED.genero,
             actualizado_en = now()
       RETURNING telefono, correo, nombre, edad, genero`,
      [
        dispositivo.id, telefono, correo,
        cuerpo.nombre?.trim() || null,
        cuerpo.edad ?? null,
        cuerpo.genero || null,
      ],
    );
    return { registrado: true, perfil: res.rows[0] };
  });

  // --- Solicitudes --------------------------------------------------------

  app.post('/api/solicitudes', async (req, reply) => {
    const dispositivo = await dispositivoDesde(req);
    if (dispositivo.bloqueado) {
      throw errorHttp(403, 'Este dispositivo está bloqueado por incidencias repetidas. Llama al número de atención.');
    }
    const cuerpo = req.body as {
      telefono?: string; origenId?: number; destinoId?: number; lat?: number; lng?: number;
    };
    if (!cuerpo?.origenId || !cuerpo.destinoId) {
      throw errorHttp(400, 'Faltan campos: origenId y destinoId son obligatorios.');
    }
    // El teléfono sale del perfil (migración 015) y solo se pide en el cuerpo
    // si no hay perfil. El conductor necesita un número al que llamar (R4).
    let telefono = cuerpo.telefono?.trim();
    if (!telefono) {
      const perfil = await pool.query(
        'SELECT telefono FROM perfil_cliente WHERE dispositivo_id = $1',
        [dispositivo.id],
      );
      telefono = perfil.rows[0]?.telefono ?? undefined;
    }
    if (!telefono) {
      throw errorHttp(400, 'Hace falta un teléfono para que el taxista pueda llamarte.');
    }
    if (cuerpo.origenId === cuerpo.destinoId) {
      throw errorHttp(400, 'El origen y el destino no pueden ser la misma referencia.');
    }

    // Idempotencia R1: hash(dispositivo, origen, destino, ventana de 60 s).
    const ventana = Math.floor(Date.now() / 60_000);
    const clave = createHash('sha256')
      .update(`${dispositivo.id}|${cuerpo.origenId}|${cuerpo.destinoId}|${ventana}`)
      .digest('hex');

    const creada = await enTransaccion(pool, (c) => crearSolicitud(c, {
      dispositivoClienteId: dispositivo.id,
      telefonoCliente: telefono,
      referenciaOrigenId: cuerpo.origenId!,
      referenciaDestinoId: cuerpo.destinoId!,
      actor: 'cliente',
      claveIdempotencia: clave,
      origenEvento: 'pwa',
      // Lectura GPS única y voluntaria (señal antifraude, migración 010).
      latCliente: typeof cuerpo.lat === 'number' ? cuerpo.lat : undefined,
      lngCliente: typeof cuerpo.lng === 'number' ? cuerpo.lng : undefined,
    }));

    if (!creada.yaExistia) {
      const despacho = await iniciarDespacho(pool, emisor, creada.solicitudId);
      return reply.status(201).send({
        solicitudId: creada.solicitudId,
        estado: despacho.resultado,
        yaExistia: false,
      });
    }
    const actual = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [creada.solicitudId]);
    return reply.send({
      solicitudId: creada.solicitudId,
      estado: actual.rows[0].estado,
      yaExistia: true,
    });
  });

  async function solicitudPropia(
    solicitudId: number,
    dispositivoId: number,
  ): Promise<Record<string, unknown>> {
    const res = await pool.query(
      `SELECT s.id, s.estado, s.expira_en, s.conductor_id,
              ro.nombre AS origen, ro.lat AS origen_lat, ro.lng AS origen_lng,
              rd.nombre AS destino, rd.lat AS destino_lat, rd.lng AS destino_lng,
              v.id AS viaje_id, v.pin, v.llegado_en,
              c.nombre AS conductor, ve.matricula, ve.marca, ve.color
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       LEFT JOIN viaje v ON v.solicitud_id = s.id
       LEFT JOIN conductor c ON c.id = s.conductor_id
       LEFT JOIN vehiculo ve ON ve.conductor_id = c.id
       WHERE s.id = $1 AND s.dispositivo_cliente_id = $2`,
      [solicitudId, dispositivoId],
    );
    if (res.rowCount === 0) {
      throw errorHttp(404, `No existe la solicitud ${solicitudId} para este dispositivo.`);
    }
    const fila = res.rows[0];

    // Taxi compartido (migración 013): el pasajero ve con cuánta gente va y
    // por dónde pasa el coche. Solo lugares y su propia parada marcada: de los
    // demás pasajeros no se revela nombre ni teléfono.
    let compartido: {
      pasajerosABordo: number;
      plazas: number;
      ruta: Array<{
        destino: string; esTuya: boolean; estado: string; lat: number; lng: number;
      }>;
    } | null = null;
    if (fila.conductor_id !== null) {
      const ocupacion = await ocupacionDe(pool, fila.conductor_id);
      const ruta = await rutaDe(pool, fila.conductor_id);
      compartido = {
        pasajerosABordo: ocupacion.aBordo,
        plazas: ocupacion.plazas,
        ruta: ruta.map((parada) => ({
          destino: parada.destino,
          esTuya: parada.solicitudId === fila.id,
          estado: parada.estado,
          lat: parada.lat,
          lng: parada.lng,
        })),
      };
    }

    // Posición del coche acercándose y tiempo estimado (migración 014). Solo
    // mientras viene a por el cliente o lo lleva dentro, y solo si el conductor
    // ha enviado posición reciente.
    let taxi: {
      lat: number; lng: number; etaMin: number; distanciaM: number; frescuraSeg: number;
    } | null = null;
    let reputacion: Awaited<ReturnType<typeof reputacionDe>> | null = null;
    if (fila.conductor_id !== null) {
      reputacion = await reputacionDe(pool, fila.conductor_id);
      // Solo mientras el taxi VIENE a por él. Una vez dentro (RECOGIDO) se deja
      // de enviar: van en el mismo coche, así que sería mostrarle su propia
      // posición, y cuanto menos se comparta la ubicación, mejor.
      if (['ACEPTADO', 'EN_CAMINO'].includes(fila.estado) && fila.viaje_id !== null) {
        const posicion = await pool.query(
          `SELECT lat, lng, extract(epoch from (now() - creado_en))::int AS antiguedad
           FROM posicion
           WHERE viaje_id = $1 AND actor = 'conductor'
           ORDER BY creado_en DESC LIMIT 1`,
          [fila.viaje_id],
        );
        if ((posicion.rowCount ?? 0) > 0) {
          const p = posicion.rows[0];
          const estimacion = await estimarLlegada(
            pool,
            { lat: Number(p.lat), lng: Number(p.lng) },
            { lat: Number(fila.origen_lat), lng: Number(fila.origen_lng) },
          );
          taxi = {
            lat: Number(p.lat),
            lng: Number(p.lng),
            etaMin: estimacion.minutos,
            distanciaM: estimacion.distanciaM,
            frescuraSeg: p.antiguedad,
          };
        }
      }
    }

    // Segundos que quedan para poder cancelar sin que cueste un aviso.
    //
    // Se calcula aquí y no en el teléfono a propósito: el reloj de un móvil
    // barato se desajusta, y el plazo lo decide este servidor. Se manda cuánto
    // FALTA, no el instante en que vence, para que un reloj mal puesto no
    // convierta un minuto en media hora ni al revés.
    //
    // Solo tiene sentido con taxi ya asignado: mientras se busca, cancelar es
    // gratis siempre y no hay cuenta atrás que enseñar.
    let graciaCancelacionSeg: number | null = null;
    if (fila.estado === 'ACEPTADO') {
      const aceptado = await pool.query(
        `SELECT max(creado_en) AS momento FROM transicion
         WHERE solicitud_id = $1 AND estado_nuevo = 'ACEPTADO'`,
        [fila.id],
      );
      if (aceptado.rows[0].momento !== null) {
        const graciaSeg = await leerParametroEntero(pool, 'gracia_cancelacion_cliente_seg');
        const transcurrido = (Date.now() - new Date(aceptado.rows[0].momento).getTime()) / 1000;
        graciaCancelacionSeg = Math.max(0, Math.round(graciaSeg - transcurrido));
      }
    }

    return {
      solicitudId: fila.id,
      estado: fila.estado,
      origen: fila.origen,
      origenLat: Number(fila.origen_lat),
      origenLng: Number(fila.origen_lng),
      destino: fila.destino,
      destinoLat: Number(fila.destino_lat),
      destinoLng: Number(fila.destino_lng),
      expiraEn: fila.expira_en,
      graciaCancelacionSeg,
      // El taxista pulsó «he llegado»: señal fiable de que está en el punto de
      // recogida, no dependa o no del GPS del pasajero.
      taxiHaLlegado: fila.llegado_en !== null,
      compartido,
      taxi,
      reputacion,
      viajeId: fila.viaje_id,
      // El teléfono del conductor no se expone jamás al cliente: es el
      // conductor quien llama (C5). La matrícula identifica el coche (R4).
      conductor: fila.conductor,
      matricula: fila.matricula,
      marca: fila.marca,
      color: fila.color,
      pin: fila.pin,
    };
  }

  app.get('/api/solicitudes/:id', async (req) => {
    const dispositivo = await dispositivoDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    return solicitudPropia(solicitudId, dispositivo.id);
  });

  // SSE: la conexión viva del cliente mientras espera (decisión 3.2).
  app.get('/api/solicitudes/:id/eventos', async (req, reply) => {
    const dispositivo = await dispositivoDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    const instantanea = await solicitudPropia(solicitudId, dispositivo.id);

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Instantánea inicial: si el evento se perdió mientras no había conexión,
    // el estado real de la base de datos manda.
    reply.raw.write(`data: ${JSON.stringify({ tipo: 'estado', datos: instantanea })}\n\n`);

    const baja = conexionesSse.suscribir(dispositivo.id, (carga) => {
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

  app.post('/api/solicitudes/:id/cancelar', async (req) => {
    const dispositivo = await dispositivoDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    await solicitudPropia(solicitudId, dispositivo.id); // propiedad

    return enTransaccion(pool, async (cliente) => {
      const fila = await cliente.query(
        'SELECT estado, conductor_id FROM solicitud WHERE id = $1 FOR UPDATE',
        [solicitudId],
      );
      const estado: string = fila.rows[0].estado;
      const conductorId: number | null = fila.rows[0].conductor_id;

      let strike = false;
      if (estado === 'ACEPTADO') {
        // Gracia de 60 s (R3): después, la cancelación cuesta un strike.
        const aceptado = await cliente.query(
          `SELECT max(creado_en) AS momento FROM transicion
           WHERE solicitud_id = $1 AND estado_nuevo = 'ACEPTADO'`,
          [solicitudId],
        );
        const graciaSeg = await leerParametroEntero(cliente, 'gracia_cancelacion_cliente_seg');
        const transcurrido = (Date.now() - new Date(aceptado.rows[0].momento).getTime()) / 1000;
        strike = transcurrido > graciaSeg;
      }

      try {
        await transicionarSolicitud(cliente, solicitudId, 'CANCELADO_CLIENTE', 'cliente', 'pwa');
      } catch (error) {
        if (error instanceof ErrorTransicionInvalida) {
          throw errorHttp(409, `No se puede cancelar: la solicitud está en ${estado}.`);
        }
        throw error;
      }

      // Ofertas pendientes fuera y conductores liberados.
      const pendientes = await cliente.query(
        `UPDATE oferta SET resultado = 'expirada'
         WHERE solicitud_id = $1 AND resultado IS NULL RETURNING conductor_id`,
        [solicitudId],
      );
      for (const oferta of pendientes.rows) {
        await transicionarConductor(cliente, oferta.conductor_id, 'DISPONIBLE', 'sistema', 'solicitud_cancelada');
        await emisor.emitir({
          tipo: 'D2_reclamacion_resuelta',
          rol: 'conductor',
          solicitudId,
          conductorId: oferta.conductor_id,
          datos: { resultado: 'cancelada' },
        }, cliente);
      }
      // Si ya estaba aceptada, se libera la plaza. Con taxi compartido el
      // conductor puede seguir llevando a otros: solo se mueve la presencia si
      // el coche estaba lleno.
      if (estado === 'ACEPTADO' && conductorId !== null) {
        const presencia = await cliente.query(
          'SELECT estado FROM presencia WHERE conductor_id = $1 FOR UPDATE',
          [conductorId],
        );
        if (presencia.rows[0]?.estado === 'OCUPADO') {
          await transicionarConductor(cliente, conductorId, 'DISPONIBLE', 'sistema', 'cancelacion_cliente');
        }
        await emisor.emitir({
          tipo: 'D2_reclamacion_resuelta',
          rol: 'conductor',
          solicitudId,
          conductorId,
          datos: { resultado: 'cancelada' },
        }, cliente);
      }

      if (strike) {
        const limite = await leerParametroEntero(cliente, 'strikes_para_bloqueo');
        await cliente.query(
          `UPDATE dispositivo
           SET strikes = strikes + 1,
               bloqueado_en = CASE WHEN strikes + 1 >= $2 THEN COALESCE(bloqueado_en, now())
                                   ELSE bloqueado_en END
           WHERE id = $1`,
          [dispositivo.id, limite],
        );
      }
      return { estado: 'CANCELADO_CLIENTE', strike };
    });
  });

  // GPS continuo del cliente (migración 011): la PWA envía su posición
  // mientras la pantalla está encendida y el viaje está activo. Si el viaje
  // no está activo no es un error: la lectura llega tarde y se ignora.
  app.post('/api/solicitudes/:id/posicion', async (req) => {
    const dispositivo = await dispositivoDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    const cuerpo = req.body as { lat?: number; lng?: number };
    if (typeof cuerpo?.lat !== 'number' || typeof cuerpo?.lng !== 'number') {
      throw errorHttp(400, 'Faltan lat y lng numéricos.');
    }
    const detalle = await solicitudPropia(solicitudId, dispositivo.id);
    if (!['ACEPTADO', 'EN_CAMINO', 'RECOGIDO'].includes(detalle.estado as string)) {
      return { guardada: false };
    }
    const viaje = await pool.query('SELECT id FROM viaje WHERE solicitud_id = $1', [solicitudId]);
    if (viaje.rowCount === 0) {
      return { guardada: false };
    }
    await enTransaccion(pool, (c) =>
      registrarPosicion(c, viaje.rows[0].id, 'cliente', cuerpo.lat!, cuerpo.lng!));
    return { guardada: true };
  });

  // El cliente no reporta precio (migración 012): su sesión termina cuando
  // se baja del taxi. No hay endpoint de precio.

  // Valoración del conductor (migración 014). Un solo toque en la PWA.
  app.post('/api/solicitudes/:id/valoracion', async (req) => {
    const dispositivo = await dispositivoDesde(req);
    const solicitudId = Number((req.params as { id: string }).id);
    const detalle = await solicitudPropia(solicitudId, dispositivo.id);
    const cuerpo = req.body as { puntuacion?: number; motivo?: string };

    if (detalle.viajeId === null) {
      throw errorHttp(409, 'Esta solicitud no llegó a tener viaje: no hay nada que valorar.');
    }
    if (!['RECOGIDO', 'COMPLETADO', 'INCIDENCIA'].includes(detalle.estado as string)) {
      throw errorHttp(409, `Aún no puedes valorar: la solicitud está en ${detalle.estado}.`);
    }
    try {
      const resultado = await enTransaccion(pool, (c) => valorarViaje(
        c, detalle.viajeId as number, 'cliente',
        { puntuacion: cuerpo?.puntuacion as number, motivo: cuerpo?.motivo },
      ));
      return { guardada: resultado.guardada, repetida: !resultado.guardada };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Puntuación no válida')) {
        throw errorHttp(400, error.message);
      }
      throw error;
    }
  });

  return app;
}
