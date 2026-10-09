// Panel de operador (PENDIENTES.md P21-01): verificar altas de conductor y
// ver estadísticas básicas del sistema entero.
//
// Se identifica al operador por el dispositivo, no por contraseña — igual
// que hoy se distingue cliente de conductor por su fila en `dispositivo`.
// La lista de uuids autorizados vive en la variable de entorno
// UUIDS_OPERADOR (separados por comas); no hay tabla propia porque son pocos
// y cambian poco, y así no hace falta una alta con contraseña para esto.

import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { enTransaccion } from '../bd/conexion.js';
import { esAgenteDeCampoPorUuid } from '../dominio/agentes.js';
import { iniciarDespacho, ofrecerAMano } from '../dominio/despacho.js';
import { ErrorEntidadInexistente } from '../dominio/errores.js';
import type { EmisorEventos } from '../dominio/eventos.js';
import {
  anadirAlias, editarReferencia, guardarReferencia, quitarAlias,
} from '../dominio/gazetteer.js';
import {
  apuntarIntento, codigosFallados, codigosPedidos, ultimoCodigoEnviado,
} from '../dominio/cuentas.js';
import type { ServicioVerificacionTelefono } from '../dominio/verificacion-telefono.js';
import {
  aparatosDe, autorizar, dispositivoDeOperador, esRaiz, esTelefonoDeOperador,
  listarOperadores, marcarVisto, revocar, revocarDispositivo, vincularDispositivo,
} from '../dominio/operadores.js';
import { asignarNumeroManual, asignarNumeroSiguiente } from '../dominio/numeros-taxi.js';
import {
  dipValido, dipDeOtroPropietario, editarPropietario,
  propietarioDeVehiculo, registrarOReutilizarPropietario,
} from '../dominio/propietarios.js';
import { leerParametroEntero } from '../dominio/parametros.js';
import { emitirVale } from '../dominio/vales.js';
import { senalesDeTarifa } from '../dominio/precios.js';
import { actividadDe, recorridoDe } from '../dominio/rastro.js';
import { inicioDelDiaEnMalabo } from '../dominio/tiempo.js';
import { confirmarRecarga, rechazarRecarga, recargasDe } from '../dominio/recargas.js';
import { reputacionDe } from '../dominio/reputacion.js';
import { normalizarTelefono } from '../dominio/telefono.js';
import { crearZonaEnGps, situarZona } from '../dominio/zonas.js';
import { crearSolicitud } from '../dominio/transiciones.js';

const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ESTADOS_VALIDOS = ['pendiente', 'verificado', 'suspendido', 'bloqueado'];
// Los tipos de vehículo (migración 087). Informativos: describen el coche.
const CARROCERIAS_VEHICULO = ['turismo', '4x4', 'furgoneta', 'autobus'];

// El tope de plazas POR TIPO (migración 089). La base aguanta hasta 60; esto
// es la regla de negocio: un turismo no lleva más de 4 pasajeros, una
// furgoneta llega a una quincena y un autobús urbano a varias decenas.
const MAX_PLAZAS: Record<string, number> = {
  turismo: 4, '4x4': 4, furgoneta: 16, autobus: 60,
};
const topePlazas = (carroceria: string | null | undefined): number =>
  MAX_PLAZAS[carroceria ?? ''] ?? 4;
const ESTADOS_RECARGA_VALIDOS = ['pendiente', 'confirmada', 'rechazada', 'caducada'];

// Las mismas del CHECK de la migración 021. Se validan aquí para poder decir
// qué se puede poner: sin esto, escribir una categoría que no está en la lista
// llegaba a la base y salía por pantalla el error en crudo del CHECK, que no
// dice cuáles son las válidas ni qué hacer.
const CATEGORIAS_VALIDAS = [
  'mercado', 'iglesia', 'hospital', 'farmacia', 'escuela', 'deporte',
  'gobierno', 'transporte', 'gasolinera', 'plaza', 'otro',
  'hotel', 'banco', 'restaurante', 'zona',
];

function exigirCategoria(categoria: string | undefined): string | undefined {
  const limpia = categoria?.trim();
  if (!limpia) return undefined;
  if (!CATEGORIAS_VALIDAS.includes(limpia)) {
    throw errorHttp(
      400,
      `Categoría «${limpia}» no válida. Elige una de: ${CATEGORIAS_VALIDAS.join(', ')}.`,
    );
  }
  return limpia;
}

// La isla entera, no solo Malabo ciudad. Un GPS que todavía no ha fijado
// devuelve a veces (0, 0) o una posición de hace días en otro país: guardar
// eso como el centro de un barrio dejaría el reparto tocado y nadie sabría
// por qué.
//
// Antes el recuadro era el de Malabo ciudad (3,695–3,815 N / 8,705–8,845 E),
// el mismo con el que se compiló el plano de calles. Pero el catálogo ya
// llega a Luba, Moka, Riaba, Batoicopo y los Basacato: veintiséis de los
// cincuenta barrios situados caían FUERA, así que no se podían situar ni
// corregir desde el panel y había que tocarlos por SQL. Sigue rechazando lo
// que importa —el (0,0), la costa de Bata, Annobón— porque Bioko es una isla
// pequeña y aislada.
const RECUADRO_BIOKO = { sur: 3.18, oeste: 8.38, norte: 3.81, este: 8.99 };

// Cuántos días de CALENDARIO abarca cada periodo del recorrido, contando hoy.
// «dia: 1» es hoy desde las 00:00, no las últimas 24 horas: la pestaña se
// llama «Hoy», y a las diez de la mañana una ventana de 24 h enseñaba también
// el turno de ayer por la tarde. Se vio en producción y no cuadraba.
const DIAS_POR_PERIODO: Record<string, number> = { dia: 1, semana: 7, mes: 30 };

function enBioko(lat: number, lng: number): boolean {
  return lat >= RECUADRO_BIOKO.sur && lat <= RECUADRO_BIOKO.norte
    && lng >= RECUADRO_BIOKO.oeste && lng <= RECUADRO_BIOKO.este;
}

// Lo que el recuadro NO puede detectar: un punto dentro de Malabo pero malo.
// Un teléfono con el GPS sin fijar contesta con la celda de telefonía o la
// wifi —cientos o miles de metros de radio—, y eso cae dentro del recuadro
// tan campante. El centroide decide qué barrios son vecinos y cuál se le
// ofrece antes al taxista: mal situado, manda taxis al sitio equivocado
// durante meses sin que nadie sepa por qué.
async function exigirGpsFiable(
  pool: pg.Pool,
  precision: unknown,
): Promise<number | null> {
  const maxima = await leerParametroEntero(pool, 'gps_precision_maxima_m');
  if (typeof precision !== 'number' || !Number.isFinite(precision) || precision < 0) {
    throw errorHttp(
      400,
      'Falta la precisión del GPS. Hay que tomar la posición con el GPS del '
      + 'teléfono, no escribirla a mano.',
    );
  }
  if (precision > maxima) {
    throw errorHttp(
      400,
      `El GPS solo da ±${Math.round(precision)} m y hacen falta ±${maxima} m o `
      + 'mejor. Sal a cielo abierto, espera unos segundos a que fije y repite.',
    );
  }
  return precision;
}

// La precisión de un LUGAR. A diferencia de un barrio, aquí se permite no
// mandarla: a veces se añade un sitio desde la oficina sabiendo dónde está, y
// prohibirlo dejaría el catálogo sin sitios que alguien conoce de sobra. Pero
// si viene, se valida con la misma vara que la de un barrio, y si no viene se
// guarda NULL — que es lo que el panel enseña como «sin verificar sobre el
// terreno» para poder repasarlo después.
async function precisionDeSitio(pool: pg.Pool, precision: unknown): Promise<number | null> {
  if (precision === undefined || precision === null) return null;
  return exigirGpsFiable(pool, precision);
}

function errorHttp(codigo: number, mensaje: string): Error & { statusCode: number } {
  const error = new Error(mensaje) as Error & { statusCode: number };
  error.statusCode = codigo;
  return error;
}

function uuidsOperador(): Set<string> {
  return new Set(
    (process.env.UUIDS_OPERADOR ?? '')
      .split(',')
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );
}

// La lista vieja de uuids. SIGUE VALIENDO a propósito (migración 080): es el
// camino por el que se entra hoy, y quitarlo el mismo día que se estrena el
// nuevo sería dejar fuera a quien tenga que arreglarlo si el nuevo falla.
export function esOperador(uuid: string): boolean {
  return uuidsOperador().has(uuid.toLowerCase());
}

// Quién es este aparato dentro del panel: si puede entrar, y si además es de
// la raíz —la que reparte y retira accesos—. Devuelve null si no puede entrar.
//
// EL UUID VIEJO CUENTA COMO RAÍZ. No por comodidad: está en una variable de
// entorno igual que `TELEFONOS_OPERADOR`, no se puede revocar desde el panel y
// quien lo tiene ya podía desplegar. Degradarlo a operador normal no quitaría
// poder a nadie y sí podría dejar la plataforma sin nadie que reparta accesos
// el día que la raíz por teléfono esté mal escrita, que es precisamente el
// agujero del que este mecanismo tiene que protegernos.
export async function rangoDeOperador(
  cliente: pg.Pool | pg.ClientBase,
  uuid: string,
): Promise<{ telefono: string | null; raiz: boolean } | null> {
  if (esOperador(uuid)) return { telefono: null, raiz: true };
  const telefono = await dispositivoDeOperador(cliente, uuid);
  if (telefono === null) return null;
  return { telefono, raiz: esRaiz(telefono) };
}

// La pregunta de verdad: ¿este aparato puede entrar al panel? Por el uuid de
// siempre, o porque demostró con un código por SMS ser de un operador.
export async function esOperadorAhora(
  cliente: pg.Pool | pg.ClientBase,
  uuid: string,
): Promise<boolean> {
  return await rangoDeOperador(cliente, uuid) !== null;
}

export function registrarRutasOperador(
  app: FastifyInstance,
  pool: pg.Pool,
  emisor: EmisorEventos,
  servicioVerificacion?: ServicioVerificacionTelefono,
): void {
  function uuidDesde(req: FastifyRequest): string {
    const uuid = req.headers['x-dispositivo'] as string | undefined;
    if (!uuid || !PATRON_UUID.test(uuid)) {
      throw errorHttp(400, 'Falta la cabecera x-dispositivo con un UUID válido.');
    }
    return uuid.toLowerCase();
  }

  // Asíncrona desde la migración 080: ahora un aparato puede ser de operador
  // porque lo demostró con un código, y eso hay que mirarlo en la base. Las
  // veintisiete rutas que la usan llevan su `await`.
  async function exigirOperador(req: FastifyRequest): Promise<void> {
    if (!await esOperadorAhora(pool, uuidDesde(req))) {
      throw errorHttp(403, 'Este dispositivo no tiene acceso de operador.');
    }
  }

  // Trabajo de campo: situar barrios, corregir sitios y fijar precios. Lo
  // pueden hacer el operador y los conductores nombrados agentes (migracion
  // 025). Es mas ancho que `exigirOperador` a proposito: el trabajo de campo
  // se hace en la calle, y quien esta en la calle es el taxista.
  //
  // Lo que NO abre: verificar conductores, confirmar pagos, resolver
  // incidencias ni tocar parametros. Un agente corrige el mapa, no administra
  // a sus companeros ni el dinero.
  async function exigirCampo(req: FastifyRequest): Promise<void> {
    const uuid = uuidDesde(req);
    // `esOperadorAhora` y no `esOperador` (06/10): este guardián se quedó
    // mirando solo la lista vieja de uuids cuando la migración 080 estrenó la
    // entrada por teléfono, y el operador que entraba por SMS recibía 403 al
    // guardar una banda de precios desde su ordenador. El otro guardián
    // (`exigirOperador`) sí se actualizó aquel día; este se escapó porque su
    // camino feliz —el uuid del entorno— seguía funcionando para quien lo
    // probó.
    if (await esOperadorAhora(pool, uuid)) return;
    // Taxista agente (migración 025) o PASAJERO agente (migración 072). Quien
    // mejor sitúa un barrio es a veces alguien que ni conduce: el del mercado,
    // la enfermera del centro de salud. Lo que puede hacer es lo mismo en los
    // dos casos — mapa sí, dinero y verificaciones no.
    // La regla vive en `dominio/agentes.ts` y no aquí. Estaba escrita dos
    // veces —una al preguntar «quién eres» y otra en este guardián— y se
    // separaron: al arreglar la primera, a la persona le aparecía el botón de
    // trabajo de campo y al pulsarlo se llevaba este mismo 403.
    if (!await esAgenteDeCampoPorUuid(pool, uuid)) {
      throw errorHttp(403, 'Este dispositivo no puede hacer trabajo de campo.');
    }
  }

  // Quién está haciendo el cambio, para el registro de la migración 067. El
  // operador no tiene fila de conductor y el agente sí: los dos se apuntan
  // como son, y no hace falta adivinarlo después leyendo la fila.
  async function quienCambia(req: FastifyRequest): Promise<{
    dispositivoId: number | null; conductorId: number | null; esOperador: boolean;
  }> {
    const uuid = uuidDesde(req);
    const fila = await pool.query(
      'SELECT id, conductor_id FROM dispositivo WHERE uuid_persistente = $1',
      [uuid],
    );
    return {
      dispositivoId: fila.rowCount === 0 ? null : Number(fila.rows[0].id),
      conductorId: fila.rowCount === 0 || fila.rows[0].conductor_id === null
        ? null : Number(fila.rows[0].conductor_id),
      // El mismo olvido de la migración 080 que `exigirCampo`: con la lista
      // vieja, los cambios del operador por teléfono quedaban apuntados como
      // «ni operador ni conductor» — un registro que decía que nadie hizo lo
      // que alguien hizo.
      esOperador: await esOperadorAhora(pool, uuid),
    };
  }

  // Apunta un cambio en el registro append-only (P25-01). Se llama DESPUÉS de
  // hacer el cambio y con el valor que había: si el cambio falla, no hay nada
  // que apuntar, y un registro que miente es peor que no tenerlo.
  async function apuntarCambio(
    req: FastifyRequest,
    ambito: string,
    clave: string,
    valorAnterior: string | null,
    valorNuevo: string | null,
  ): Promise<void> {
    const quien = await quienCambia(req);
    await pool.query(
      `INSERT INTO cambio_ajuste
         (ambito, clave, valor_anterior, valor_nuevo, dispositivo_id, conductor_id, es_operador)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ambito, clave, valorAnterior, valorNuevo,
        quien.dispositivoId, quien.conductorId, quien.esOperador,
      ],
    );
  }

  // Lista de conductores: filtrada por estado, o buscada por nombre,
  // teléfono o matrícula (q). El caso principal sigue siendo «pendiente»:
  // los que esperan revisión.
  // --- Entrar al panel con el teléfono (migración 080) ---------------------
  //
  // Dos pasos y ningún uuid: se pide el código y se comprueba. Lo que hace
  // falta para entrar son DOS cosas —estar en la lista y tener el móvil en la
  // mano—, y es justo lo que no pasaba con el enlace de antes, que era la llave
  // entera metida en una URL.
  //
  // NO ESTÁN PROTEGIDAS por `exigirOperador`, obviamente: son la puerta. Lo que
  // las protege es que el código llega a un teléfono que tiene que estar ya en
  // la lista.

  if (servicioVerificacion) {
    app.post('/api/operador/entrar/codigo', async (req) => {
      const uuid = uuidDesde(req);
      const cuerpo = (req.body ?? {}) as { telefono?: string; canal?: string };
      const crudo = cuerpo.telefono?.trim();
      const telefono = normalizarTelefono(crudo);
      if (!telefono) throw errorHttp(400, 'Falta el teléfono, o no se entiende.');

      // El tope del aparato, prestado de la migración 078: sin él, esta ruta es
      // una forma de mandar SMS a desconocidos a costa de la plataforma.
      if (await codigosPedidos(pool, uuid)
        >= await leerParametroEntero(pool, 'recuperacion_consultas_hora')) {
        throw errorHttp(429, 'Has pedido demasiados códigos. Prueba dentro de un rato.');
      }

      // SE CONTESTA LO MISMO SEA O NO OPERADOR, y solo se manda el SMS si lo
      // es. Contestar «ese número no es de operador» convertiría esta puerta en
      // una forma de averiguar quién manda en la plataforma, que es
      // exactamente a quién hay que ir a buscar para entrar.
      if (await esTelefonoDeOperador(pool, telefono)) {
        // El operador también está en Malabo: si a su línea no le llega el
        // SMS, puede pedir que le llamen (migración 081). Y el freno entre
        // códigos es POR CANAL (082): el SMS que no llegó no bloquea la
        // llamada que lo salva.
        const canal = cuerpo.canal === 'llamada' ? 'llamada' as const : 'sms' as const;
        const ultimo = await ultimoCodigoEnviado(pool, telefono, canal);
        const esperaSeg = await leerParametroEntero(pool, 'recuperacion_cooldown_seg');
        const esperado = ultimo !== null
          && (Date.now() - ultimo.getTime()) / 1000 < esperaSeg;
        if (!esperado) {
          await servicioVerificacion.enviarCodigo(telefono, canal);
          await apuntarIntento(pool, uuid, telefono, 'codigo', true, canal);
        }
      }
      return { enviado: true };
    });

    app.post('/api/operador/entrar', async (req) => {
      const uuid = uuidDesde(req);
      const cuerpo = (req.body ?? {}) as { telefono?: string; codigo?: string };
      const telefono = normalizarTelefono(cuerpo.telefono?.trim());
      const codigo = cuerpo.codigo?.trim();
      if (!telefono || !codigo) throw errorHttp(400, 'Faltan el teléfono y el código.');

      if (await codigosFallados(pool, telefono)
        >= await leerParametroEntero(pool, 'recuperacion_intentos_codigo')) {
        throw errorHttp(429, 'Demasiados códigos fallados. Prueba dentro de una hora.');
      }
      // Se comprueba el código ANTES de mirar si el número es de operador, y da
      // igual el orden para el que acierta: lo que importa es que quien falla
      // reciba siempre la misma respuesta, sea su número de la casa o no.
      const correcto = await servicioVerificacion.comprobarCodigo(telefono, codigo);
      const autorizado = await esTelefonoDeOperador(pool, telefono);
      if (!correcto || !autorizado) {
        await apuntarIntento(pool, uuid, telefono, 'reclamar', false);
        throw errorHttp(400, 'Código incorrecto.');
      }
      await enTransaccion(pool, (cliente) => vincularDispositivo(cliente, uuid, telefono));
      await apuntarIntento(pool, uuid, telefono, 'reclamar', true);
      return { entrado: true, raiz: esRaiz(telefono) };
    });
  }

  // --- Dar y quitar accesos (migración 080) --------------------------------
  //
  // SOLO LA RAÍZ. No es una jerarquía por gusto: si cualquier operador pudiera
  // dar accesos, echar a alguien no serviría de nada —antes de salir se nombra
  // a sí mismo con otro número— y la lista dejaría de significar nada. Un
  // operador normal ve la lista (saber con quién trabajas no es un secreto)
  // pero no la toca.
  async function exigirRaiz(req: FastifyRequest): Promise<string> {
    const rango = await rangoDeOperador(pool, uuidDesde(req));
    if (rango === null) throw errorHttp(403, 'Este dispositivo no tiene acceso de operador.');
    if (!rango.raiz) {
      throw errorHttp(
        403,
        'Solo quien tiene el teléfono principal puede dar y quitar accesos.',
      );
    }
    // Con quién se firma el alta. El uuid viejo no tiene teléfono: se firma
    // como «entorno», que es exactamente lo que es y se lee después sin
    // tener que adivinar quién fue.
    return rango.telefono ?? 'entorno';
  }

  app.get('/api/operador/accesos', async (req) => {
    await exigirOperador(req);
    const rango = await rangoDeOperador(pool, uuidDesde(req));
    const operadores = await listarOperadores(pool);
    return { yo: rango, operadores };
  });

  // Los aparatos de una persona se piden con POST aunque solo se lea, y las
  // bajas también: en la URL, el número acabaría escrito en el registro de
  // peticiones del servidor, y el teléfono de quien manda en la plataforma no
  // tiene por qué quedar en un fichero de texto que se lee entero cada vez que
  // se mira un error.
  app.post('/api/operador/accesos/aparatos', async (req) => {
    await exigirOperador(req);
    const { telefono } = (req.body ?? {}) as { telefono?: string };
    const canonico = normalizarTelefono(telefono?.trim());
    if (!canonico) throw errorHttp(400, 'Falta el teléfono, o no se entiende.');
    return { aparatos: await aparatosDe(pool, canonico) };
  });

  app.post('/api/operador/accesos', async (req) => {
    const quien = await exigirRaiz(req);
    const cuerpo = (req.body ?? {}) as { telefono?: string; nombre?: string };
    const telefono = normalizarTelefono(cuerpo.telefono?.trim());
    if (!telefono) {
      throw errorHttp(400, 'Falta el teléfono, o no se entiende. Son nueve cifras.');
    }
    // Dar de alta a la raíz sería una fila que no hace nada —ya entra por el
    // entorno— y que al revocarla daría la falsa sensación de haberla echado.
    if (esRaiz(telefono)) {
      throw errorHttp(409, 'Ese número ya es el principal: entra siempre y no se le quita aquí.');
    }
    const nombre = cuerpo.nombre?.trim();
    const alta = await autorizar(pool, telefono, nombre ? nombre : null, quien);
    return { autorizado: true, yaEstaba: !alta };
  });

  app.post('/api/operador/accesos/quitar', async (req) => {
    const quien = await exigirRaiz(req);
    const { telefono } = (req.body ?? {}) as { telefono?: string };
    const canonico = normalizarTelefono(telefono?.trim());
    if (!canonico) throw errorHttp(400, 'Falta el teléfono, o no se entiende.');
    if (esRaiz(canonico)) {
      throw errorHttp(
        409,
        'Al teléfono principal no se le quita el acceso desde aquí: hay que '
        + 'sacarlo de TELEFONOS_OPERADOR y reiniciar el servidor.',
      );
    }
    const habia = await enTransaccion(pool, (cliente) => revocar(cliente, canonico, quien));
    if (!habia) throw errorHttp(404, 'Ese número no tenía acceso.');
    return { revocado: true };
  });

  // Echar a UN aparato: el móvil que se perdió. La persona sigue entrando
  // desde los demás, y desde ése tendrá que volver a pedir el código.
  app.post('/api/operador/accesos/aparatos/quitar', async (req) => {
    const quien = await exigirRaiz(req);
    const { uuid } = (req.body ?? {}) as { uuid?: string };
    if (!uuid || !PATRON_UUID.test(uuid)) throw errorHttp(400, 'Falta el aparato.');
    const habia = await revocarDispositivo(pool, uuid, quien);
    if (!habia) throw errorHttp(404, 'Ese aparato ya no estaba vinculado.');
    return { revocado: true };
  });

  // --- El vale de entrada (migración 081) ----------------------------------
  //
  // Para cuando a una línea no llega ni el SMS ni la llamada y una persona
  // verificada se queda fuera de su propia cuenta. El operador dicta seis
  // cifras y la persona las escribe donde escribiría el código del SMS.
  //
  // LO PUEDE DAR CUALQUIER OPERADOR, no solo la raíz. Es trabajo del turno —el
  // taxista llama porque no puede entrar— y reservarlo a una sola persona
  // significaría que fuera de su horario nadie entra. Lo que lo sujeta no es
  // quién puede darlo, sino que dura minutos, se gasta una vez, es para un solo
  // número y queda escrito quién lo dio.
  app.post('/api/operador/vale', async (req) => {
    await exigirOperador(req);
    const rango = await rangoDeOperador(pool, uuidDesde(req));
    const crudo = ((req.body ?? {}) as { telefono?: string }).telefono?.trim();
    const telefono = normalizarTelefono(crudo);
    if (!telefono) throw errorHttp(400, 'Falta el teléfono, o no se entiende.');

    // Solo para números que existen. Un vale para un número sin cuenta no
    // abriría nada —`reclamar` no tendría qué entregar— y dejaría al operador
    // dictando un código que no sirve mientras la persona espera.
    const quien = await pool.query(
      `SELECT 1 FROM conductor WHERE telefono = $1
       UNION ALL
       SELECT 1 FROM perfil_cliente WHERE telefono = $1`,
      [telefono],
    );
    if ((quien.rowCount ?? 0) === 0) {
      throw errorHttp(404, 'Ese número no está registrado: no hay ninguna cuenta que devolverle.');
    }

    const vale = await enTransaccion(pool, (cliente) => (
      emitirVale(cliente, telefono, rango?.telefono ?? 'entorno')
    ));
    return { codigo: vale.codigo, caducaEn: vale.caducaEn };
  });

  // --- Cambiar el número de alguien (05/10) --------------------------------
  //
  // Hasta hoy esto era un UPDATE a mano en producción. Hizo falta el día que
  // GETESA dejó de entregar los SMS: la salida para un taxista atrapado era
  // pasarlo a una línea de la otra operadora, y eso no puede depender de que
  // alguien sepa escribir SQL contra la base de verdad.
  //
  // EL TELÉFONO ES LA IDENTIDAD (migración 024), no un dato de contacto. Por
  // eso esto no va en «editar la ficha» con el nombre y el color del coche:
  // cambiarlo es cambiar con qué llave entra esa persona a partir de ahora, y
  // la pantalla tiene que decirlo con esas palabras.
  //
  // Y POR ESO EL NÚMERO NUEVO QUEDA SIN VERIFICAR. Lo que estaba demostrado es
  // que la línea vieja era suya; de la nueva no sabemos nada todavía. Dejarla
  // heredar la verificación sería que una cuenta verificada apuntara a un
  // número que nadie ha probado. Si a la nueva línea tampoco le llegan los
  // SMS, el operador tiene el vale (migración 081), que sirve también para
  // verificar.
  async function cambiarTelefono(
    req: FastifyRequest,
    tabla: 'conductor' | 'perfil_cliente',
    id: number,
    crudo: string | undefined,
  ): Promise<{ telefono: string; antes: string | null }> {
    const nuevo = normalizarTelefono(crudo?.trim());
    if (!nuevo) {
      throw errorHttp(400, 'Falta el número nuevo, o no se entiende. Son nueve cifras.');
    }
    const antes = await pool.query(
      `SELECT telefono FROM ${tabla} WHERE id = $1`,
      [id],
    );
    if (antes.rowCount === 0) throw errorHttp(404, 'No existe esa ficha.');
    const anterior: string | null = antes.rows[0].telefono;
    if (anterior === nuevo) {
      throw errorHttp(409, 'Ese ya es su número: no hay nada que cambiar.');
    }

    // Se mira antes de escribir para poder decir de quién es. El índice único
    // lo impediría igual, pero con un error de la base que no dice nada.
    const ocupado = tabla === 'conductor'
      ? await pool.query('SELECT nombre FROM conductor WHERE telefono = $1', [nuevo])
      : await pool.query(
        `SELECT nombre FROM perfil_cliente
         WHERE telefono = $1 AND telefono_vigente`,
        [nuevo],
      );
    if ((ocupado.rowCount ?? 0) > 0) {
      const nombre: string | null = ocupado.rows[0].nombre;
      throw errorHttp(
        409,
        `Ese número ya es de ${nombre ?? 'otra cuenta'}. Dos cuentas no pueden `
        + 'compartir número: es con lo que se entra.',
      );
    }

    await pool.query(
      `UPDATE ${tabla} SET telefono = $2, telefono_verificado_en = NULL WHERE id = $1`,
      [id, nuevo],
    );
    await apuntarCambio(req, tabla === 'conductor' ? 'conductor' : 'pasajero',
      `${id}.telefono`, anterior, nuevo);
    return { telefono: nuevo, antes: anterior };
  }

  // Editar los datos del taxista: nombre, apellido, DIP y correo (migración
  // 087). El teléfono NO —ese se cambia aparte, porque es con lo que entra—.
  app.post('/api/operador/conductores/:id/datos', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    const cuerpo = (req.body ?? {}) as {
      nombre?: string; apellido?: string; dip?: string; correo?: string;
    };
    const nombre = cuerpo.nombre?.trim();
    const apellido = cuerpo.apellido?.trim();
    if (!nombre || !apellido) {
      throw errorHttp(400, 'El nombre y el apellido son obligatorios.');
    }
    const dip = dipValido(cuerpo.dip);
    if (cuerpo.dip && dip === null) {
      throw errorHttp(400, 'El DIP tiene que ser nueve dígitos.');
    }
    const correo = cuerpo.correo?.trim().toLowerCase() || null;
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) {
      throw errorHttp(400, `Correo no válido: «${correo}».`);
    }
    // El DIP, único entre conductores: si lo cambia por el de otro, 409.
    if (dip !== null) {
      const ajeno = await pool.query(
        'SELECT nombre FROM conductor WHERE dip = $1 AND id <> $2',
        [dip, id],
      );
      if ((ajeno.rowCount ?? 0) > 0) {
        throw errorHttp(409, `Ese DIP ya es de otro conductor (${ajeno.rows[0].nombre}).`);
      }
    }
    const res = await pool.query(
      `UPDATE conductor
       SET nombre = $2, apellido = $3,
           dip = COALESCE($4, dip),
           correo = $5
       WHERE id = $1`,
      [id, nombre, apellido, dip, correo],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Conductor no encontrado.');
    return { guardado: true };
  });

  app.post('/api/operador/conductores/:id/telefono', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    const crudo = ((req.body ?? {}) as { telefono?: string }).telefono;
    return cambiarTelefono(req, 'conductor', id, crudo);
  });

  // Editar los datos del dueño del coche desde su pestaña en la ficha (08/10).
  // El DIP es su identidad: nueve dígitos, y no el de otro propietario.
  app.post('/api/operador/propietarios/:id/datos', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de propietario no válido.');
    const cuerpo = (req.body ?? {}) as {
      nombre?: string; apellido?: string; telefono?: string; dip?: string;
    };
    const nombre = cuerpo.nombre?.trim();
    const apellido = cuerpo.apellido?.trim();
    const telefono = normalizarTelefono(cuerpo.telefono?.trim());
    if (!nombre || !apellido) {
      throw errorHttp(400, 'El nombre y el apellido del dueño son obligatorios.');
    }
    if (telefono === null) {
      throw errorHttp(400, 'El teléfono del dueño no se entiende.');
    }
    const dip = dipValido(cuerpo.dip);
    if (dip === null) {
      throw errorHttp(400, 'El DIP del dueño tiene que ser nueve dígitos.');
    }
    const ajeno = await dipDeOtroPropietario(pool, dip, id);
    if (ajeno !== null) {
      throw errorHttp(409, `Ese DIP ya es de otro dueño (${ajeno}).`);
    }
    const guardado = await enTransaccion(pool, (cliente) => editarPropietario(
      cliente, id, { nombre, apellido, telefono, dip },
    ));
    if (!guardado) throw errorHttp(404, 'No existe ese propietario.');
    return { guardado: true };
  });

  // Hacer dueño del coche al propio taxista (09/10): el caso más común —el
  // taxista es el dueño— con un botón, sin reteclear sus datos. Se registra (o
  // se reutiliza por DIP) un propietario con la identidad del conductor y se le
  // cuelga su coche. Necesita que el taxista tenga DIP y apellido: son la
  // identidad del propietario (migración 087).
  app.post('/api/operador/conductores/:id/dueno-es-el-conductor', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    return enTransaccion(pool, async (cliente) => {
      const c = await cliente.query(
        'SELECT nombre, apellido, telefono, dip FROM conductor WHERE id = $1',
        [id],
      );
      if (c.rowCount === 0) throw errorHttp(404, 'No existe ese conductor.');
      const { nombre, apellido, telefono, dip } = c.rows[0];
      if (!dip) {
        throw errorHttp(400, 'Este taxista no tiene DIP todavía. Añádeselo primero: '
          + 'el dueño se identifica por su documento.');
      }
      if (!apellido) {
        throw errorHttp(400, 'Este taxista no tiene apellido todavía. Añádeselo primero.');
      }
      const propietarioId = await registrarOReutilizarPropietario(
        cliente, { nombre, apellido, telefono, dip },
      );
      const v = await cliente.query(
        'UPDATE vehiculo SET propietario_id = $2 WHERE conductor_id = $1',
        [id, propietarioId],
      );
      if (v.rowCount === 0) throw errorHttp(404, 'Este conductor no tiene vehículo.');
      return { hecho: true };
    });
  });

  // Del pasajero se recibe el id del DISPOSITIVO, que es con lo que trabaja su
  // ficha; la fila del perfil cuelga de él.
  app.post('/api/operador/pasajeros/:id/telefono', async (req) => {
    await exigirOperador(req);
    const dispositivoId = Number((req.params as { id: string }).id);
    if (!Number.isInteger(dispositivoId)) throw errorHttp(400, 'Id de dispositivo no válido.');
    const perfil = await pool.query(
      'SELECT id FROM perfil_cliente WHERE dispositivo_id = $1',
      [dispositivoId],
    );
    if (perfil.rowCount === 0) throw errorHttp(404, 'Ese dispositivo no tiene perfil de pasajero.');
    const crudo = ((req.body ?? {}) as { telefono?: string }).telefono;
    return cambiarTelefono(req, 'perfil_cliente', Number(perfil.rows[0].id), crudo);
  });

  // El alta de un taxista hecha desde el panel (06/10). Hasta hoy el alta
  // era siempre del propio taxista desde su móvil; ahora el operador, con el
  // coche delante o el papeleo en la mano, lo da de alta él.
  //
  // Nace VERIFICADO: lo verificó el operador al darlo de alta, que es más de
  // lo que hace la auto-aceptación del alta propia. Lo que NO nace es el
  // teléfono confirmado: de esa línea no ha demostrado nada nadie, y la
  // confirma el propio taxista con un código —o con el vale del operador— la
  // primera vez que entra. Y a propósito NO se toca `dispositivo`: el aparato
  // del operador no puede quedarse vinculado como si fuera el taxi.
  // La foto del taxista (migración 088). El cuerpo es la imagen YA reducida en
  // el navegador (un lado de 400 px); aquí solo se guarda tal cual.
  app.addContentTypeParser(
    /^image\//,
    { parseAs: 'buffer', bodyLimit: 2_000_000 },
    (_req, cuerpo, hecho) => { hecho(null, cuerpo); },
  );

  app.post('/api/operador/conductores/:id/foto', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    const foto = req.body;
    if (!Buffer.isBuffer(foto) || foto.length === 0) {
      throw errorHttp(400, 'El cuerpo tiene que ser la imagen, con content-type image/...');
    }
    const tipo = String(req.headers['content-type'] ?? 'image/jpeg');
    const res = await pool.query(
      'UPDATE conductor SET foto = $2, foto_tipo = $3 WHERE id = $1',
      [id, foto, tipo],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Conductor no encontrado.');
    return { subida: true };
  });

  app.get('/api/operador/conductores/:id/foto', async (req, reply) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    const res = await pool.query(
      'SELECT foto, foto_tipo FROM conductor WHERE id = $1',
      [id],
    );
    if (res.rowCount === 0 || res.rows[0].foto === null) {
      throw errorHttp(404, 'Ese taxista no tiene foto.');
    }
    // Se puede cachear en el navegador un rato: una foto de carnet no cambia
    // cada minuto, y volver a abrir la ficha no tiene que bajarla otra vez.
    void reply.header('cache-control', 'private, max-age=600');
    void reply.type(res.rows[0].foto_tipo ?? 'image/jpeg');
    return res.rows[0].foto;
  });

  app.post('/api/operador/conductores', async (req) => {
    await exigirOperador(req);
    const cuerpo = (req.body ?? {}) as {
      // El conductor: la cuenta operativa. Nombre, apellido, teléfono y DIP.
      nombre?: string; apellido?: string; telefono?: string; dip?: string;
      // El propietario. Si `duenoConduce`, es la misma persona que el
      // conductor y no hace falta repetir sus datos.
      duenoConduce?: boolean;
      propietario?: {
        nombre?: string; apellido?: string; telefono?: string; dip?: string;
      };
      // El vehículo.
      matricula?: string; marca?: string; carroceria?: string; color?: string;
      plazas?: number;
      aireAcondicionado?: boolean; seguro?: boolean;
      // El número que el coche ya lleva pintado, si lo lleva. Vacío: el
      // siguiente de la secuencia (migración 084).
      numeroTaxi?: string;
    };
    const nombre = cuerpo.nombre?.trim();
    const apellido = cuerpo.apellido?.trim();
    const telefono = normalizarTelefono(cuerpo.telefono?.trim());
    const dip = dipValido(cuerpo.dip);
    const matricula = cuerpo.matricula?.trim().toUpperCase();
    const marca = cuerpo.marca?.trim();
    const carroceria = cuerpo.carroceria;
    if (!nombre || !apellido || !telefono || !matricula || !marca || !carroceria) {
      throw errorHttp(400, 'Faltan datos del conductor o del coche: nombre, apellido, '
        + 'teléfono, matrícula, marca y carrocería son obligatorios.');
    }
    if (dip === null) {
      throw errorHttp(400, 'El DIP del conductor tiene que ser nueve dígitos.');
    }
    if (!CARROCERIAS_VEHICULO.includes(carroceria)) {
      throw errorHttp(400, `Carrocería no válida. Opciones: ${CARROCERIAS_VEHICULO.join(', ')}.`);
    }
    // Las plazas (migración 089): opcionales en el alta —si no vienen, la base
    // pone 4—, con el tope del tipo de coche.
    let plazasAlta: number | null = null;
    if (cuerpo.plazas !== undefined && cuerpo.plazas !== null) {
      const tope = topePlazas(carroceria);
      if (!Number.isInteger(cuerpo.plazas) || cuerpo.plazas < 1 || cuerpo.plazas > tope) {
        throw errorHttp(400, `Las plazas tienen que ser un número entre 1 y ${tope} para este tipo de vehículo.`);
      }
      plazasAlta = cuerpo.plazas;
    }

    // El propietario: o es el propio conductor (duenoConduce), o se validan sus
    // datos aparte. Su identidad es el DIP (migración 087).
    const prop = cuerpo.duenoConduce
      ? { nombre, apellido, telefono, dip }
      : (() => {
        const p = cuerpo.propietario ?? {};
        const pNombre = p.nombre?.trim();
        const pApellido = p.apellido?.trim();
        const pTelefono = normalizarTelefono(p.telefono?.trim());
        const pDip = dipValido(p.dip);
        if (!pNombre || !pApellido || !pTelefono) {
          throw errorHttp(400, 'Faltan datos del propietario: nombre, apellido y teléfono. '
            + '¿O es el mismo que conduce? Marca «el dueño también conduce».');
        }
        if (pDip === null) {
          throw errorHttp(400, 'El DIP del propietario tiene que ser nueve dígitos.');
        }
        return { nombre: pNombre, apellido: pApellido, telefono: pTelefono, dip: pDip };
      })();

    const resultado = await enTransaccion(pool, async (cliente) => {
      const yaConductor = await cliente.query(
        'SELECT id, nombre FROM conductor WHERE telefono = $1',
        [telefono],
      );
      if ((yaConductor.rowCount ?? 0) > 0) {
        throw errorHttp(
          409,
          `Ese teléfono ya es de ${yaConductor.rows[0].nombre}. `
          + 'Búscalo en la lista: puede que solo haya que verificarlo o cambiarle el coche.',
        );
      }
      const dipAjeno = await cliente.query(
        'SELECT nombre FROM conductor WHERE dip = $1',
        [dip],
      );
      if ((dipAjeno.rowCount ?? 0) > 0) {
        throw errorHttp(409, `Ese DIP ya es de otro conductor (${dipAjeno.rows[0].nombre}).`);
      }
      const matriculaAjena = await cliente.query(
        'SELECT conductor_id FROM vehiculo WHERE matricula = $1',
        [matricula],
      );
      if ((matriculaAjena.rowCount ?? 0) > 0) {
        throw errorHttp(409, `La matrícula ${matricula} ya está registrada por otro conductor.`);
      }

      // El propietario primero: se reutiliza por DIP si ya tenía otro coche.
      const propietarioId = await registrarOReutilizarPropietario(cliente, prop);

      const creado = await cliente.query(
        `INSERT INTO conductor (telefono, nombre, apellido, dip, estado_verificacion)
         VALUES ($1, $2, $3, $4, 'verificado') RETURNING id`,
        [telefono, nombre, apellido, dip],
      );
      const conductorId: number = Number(creado.rows[0].id);
      // El número de flota (084): el de la secuencia, o el que el coche ya
      // lleva pintado si el operador lo dicta — ese, solo por detrás del
      // último generado y solo si está libre.
      const numero = cuerpo.numeroTaxi?.trim()
        ? await asignarNumeroManual(cliente, conductorId, cuerpo.numeroTaxi)
        : await asignarNumeroSiguiente(cliente, conductorId);
      await cliente.query(
        `INSERT INTO vehiculo
           (conductor_id, propietario_id, matricula, marca, carroceria, color, plazas, aire_acondicionado, seguro)
         VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 4), $8, $9)`,
        [
          conductorId, propietarioId, matricula, marca, carroceria,
          cuerpo.color?.trim() || null, plazasAlta,
          cuerpo.aireAcondicionado ?? false, cuerpo.seguro ?? false,
        ],
      );
      await cliente.query(
        'INSERT INTO monedero (conductor_id) VALUES ($1) ON CONFLICT (conductor_id) DO NOTHING',
        [conductorId],
      );
      await cliente.query(
        `INSERT INTO presencia (conductor_id, estado) VALUES ($1, 'DESCONECTADO')
         ON CONFLICT (conductor_id) DO NOTHING`,
        [conductorId],
      );
      return { conductorId, numero };
    });
    // Quién lo dio de alta, en el registro de siempre (067).
    await apuntarCambio(
      req, 'conductor', `${resultado.conductorId}.alta`, null,
      [resultado.numero, nombre, telefono, matricula].filter(Boolean).join(' · '),
    );
    return { conductorId: resultado.conductorId, numeroTaxi: resultado.numero };
  });

  // Registro de vehículos (migración 087): todos los coches con sus datos,
  // su conductor y su dueño. Para el panel de registros.
  app.get('/api/operador/vehiculos', async (req) => {
    await exigirOperador(req);
    const res = await pool.query(
      `SELECT v.matricula, v.marca, v.carroceria, v.color, v.plazas,
              v.aire_acondicionado, v.seguro,
              c.id::int AS conductor_id, c.nombre AS conductor, c.apellido AS conductor_apellido,
              c.telefono AS conductor_telefono, c.numero_taxi,
              p.nombre AS dueno, p.apellido AS dueno_apellido, p.dip AS dueno_dip
       FROM vehiculo v
       JOIN conductor c ON c.id = v.conductor_id
       LEFT JOIN propietario p ON p.id = v.propietario_id
       ORDER BY c.numero_taxi NULLS LAST, v.matricula
       LIMIT 500`,
    );
    return { vehiculos: res.rows };
  });

  // Registro de propietarios (migración 087): cada dueño con sus datos y los
  // coches que tiene (la flota).
  app.get('/api/operador/propietarios', async (req) => {
    await exigirOperador(req);
    const res = await pool.query(
      `SELECT p.id::int AS id, p.nombre, p.apellido, p.telefono, p.dip, p.creado_en,
              count(v.id)::int AS coches,
              array_remove(array_agg(v.matricula ORDER BY v.matricula), NULL) AS matriculas
       FROM propietario p
       LEFT JOIN vehiculo v ON v.propietario_id = p.id
       GROUP BY p.id
       ORDER BY p.creado_en DESC
       LIMIT 500`,
    );
    return { propietarios: res.rows };
  });

  // La ficha de UN propietario (09/10): sus datos y TODA su flota —cada coche
  // con el taxista que lo conduce—. Es la vista «entrar por el dueño»: un
  // dueño puede tener varios coches y, por tanto, varios conductores, y por el
  // conductor solo se ve uno.
  app.get('/api/operador/propietarios/:id', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de propietario no válido.');
    const p = await pool.query(
      'SELECT id::int AS id, nombre, apellido, telefono, dip, creado_en FROM propietario WHERE id = $1',
      [id],
    );
    if (p.rowCount === 0) throw errorHttp(404, 'No existe ese propietario.');
    const v = await pool.query(
      `SELECT v.matricula, v.marca, v.carroceria, v.color, v.plazas,
              c.id::int AS conductor_id, c.nombre AS conductor, c.apellido AS conductor_apellido,
              c.numero_taxi, c.estado_verificacion
       FROM vehiculo v JOIN conductor c ON c.id = v.conductor_id
       WHERE v.propietario_id = $1
       ORDER BY c.numero_taxi NULLS LAST, v.matricula`,
      [id],
    );
    return { propietario: p.rows[0], vehiculos: v.rows };
  });

  app.get('/api/operador/conductores', async (req) => {
    await exigirOperador(req);
    const { estado, q } = (req.query ?? {}) as { estado?: string; q?: string };
    if (estado && !ESTADOS_VALIDOS.includes(estado)) {
      throw errorHttp(400, `Estado no válido. Opciones: ${ESTADOS_VALIDOS.join(', ')}.`);
    }
    // Sin paginación de verdad todavía (lista corta en la práctica); el tope
    // es solo para no reventar la pantalla si algún día deja de serlo.
    const filas = await pool.query(
      `SELECT c.id, c.nombre, c.telefono, c.correo, c.estado_verificacion,
              c.numero_taxi,
              -- Para la bandeja (06/10): lo pendiente se ordena por
              -- antigüedad, y la edad de un alta es su fecha.
              c.fecha_alta,
              v.matricula, v.marca, v.color, v.carroceria,
              v.aire_acondicionado, v.seguro
       FROM conductor c
       LEFT JOIN vehiculo v ON v.conductor_id = c.id
       WHERE ($1::text IS NULL OR c.estado_verificacion = $1)
         AND ($2::text IS NULL
              OR c.nombre ILIKE '%' || $2 || '%'
              OR c.telefono LIKE '%' || $2 || '%'
              OR v.matricula ILIKE '%' || $2 || '%')
       ORDER BY c.id DESC
       LIMIT 200`,
      [estado ?? null, q?.trim() || null],
    );
    return { conductores: filas.rows };
  });

  // La ficha completa de un conductor: todo lo que el operador necesita para
  // decidir con conocimiento — vehículo, dinero, reputación e historial — en
  // una sola pantalla, sin ir a mirar la base de datos.
  app.get('/api/operador/conductores/:id', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');

    const ficha = await pool.query(
      `SELECT c.id, c.nombre, c.apellido, c.dip, c.telefono, c.correo, c.estado_verificacion,
              (c.foto IS NOT NULL) AS tiene_foto,
              c.numero_taxi, c.suscrito_hasta, c.es_agente, c.recibe_en_cualquier_zona,
              v.matricula, v.marca, v.color, v.carroceria, v.plazas,
              v.aire_acondicionado, v.seguro,
              p.estado AS presencia,
              COALESCE(sm.saldo_xaf, 0)::int AS saldo_xaf
       FROM conductor c
       LEFT JOIN vehiculo v ON v.conductor_id = c.id
       LEFT JOIN presencia p ON p.conductor_id = c.id
       LEFT JOIN saldo_monedero sm ON sm.conductor_id = c.id
       WHERE c.id = $1`,
      [id],
    );
    if (ficha.rowCount === 0) throw errorHttp(404, 'Conductor no encontrado.');

    const viajes = await pool.query(
      `SELECT count(*) FILTER (WHERE estado = 'COMPLETADO')::int AS completados,
              count(*) FILTER (WHERE estado = 'CANCELADO_CONDUCTOR')::int AS cancelados,
              count(*) FILTER (WHERE estado = 'CLIENTE_AUSENTE')::int AS ausencias,
              count(*)::int AS aceptados
       FROM solicitud WHERE conductor_id = $1`,
      [id],
    );
    const ofertas = await pool.query(
      `SELECT count(*)::int AS recibidas,
              count(*) FILTER (WHERE resultado = 'aceptada')::int AS aceptadas,
              count(*) FILTER (WHERE resultado = 'rechazada')::int AS rechazadas
       FROM oferta WHERE conductor_id = $1`,
      [id],
    );
    const ultimos = await pool.query(
      `SELECT s.id, s.estado, s.creada_en,
              ro.nombre AS origen, rd.nombre AS destino
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       WHERE s.conductor_id = $1
       ORDER BY s.creada_en DESC LIMIT 10`,
      [id],
    );
    const reputacion = await reputacionDe(pool, id);
    const recargas = await recargasDe(pool, id, 10);
    const propietario = await propietarioDeVehiculo(pool, id);
    return {
      ...ficha.rows[0],
      propietario,
      suscripcionVigente: ficha.rows[0].suscrito_hasta !== null
        && new Date(ficha.rows[0].suscrito_hasta) > new Date(),
      reputacion,
      viajes: viajes.rows[0],
      ofertas: ofertas.rows[0],
      ultimosViajes: ultimos.rows,
      recargas,
    };
  });

  // Cambia el estado de verificación de un conductor: verificar, pero
  // también suspender o bloquear si hace falta echar a alguien atrás.
  app.post('/api/operador/conductores/:id/estado', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    const { estado } = (req.body ?? {}) as { estado?: string };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    if (!estado || !ESTADOS_VALIDOS.includes(estado)) {
      throw errorHttp(400, `Estado no válido. Opciones: ${ESTADOS_VALIDOS.join(', ')}.`);
    }
    const res = await pool.query(
      `UPDATE conductor SET estado_verificacion = $2 WHERE id = $1
       RETURNING id, nombre, estado_verificacion`,
      [id, estado],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Conductor no encontrado.');
    return res.rows[0];
  });

  // Lo mismo para un PASAJERO (migración 072). El papel es el mismo y se
  // retira igual de fácil, que es lo que lo hace asumible: el daño de un
  // agente que se pasa se corta quitándoselo, y lo que tocó queda apuntado
  // desde la migración 067.
  app.post('/api/operador/pasajeros/:id/agente', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    const { agente } = (req.body ?? {}) as { agente?: boolean };
    if (typeof agente !== 'boolean') throw errorHttp(400, 'Falta agente (true/false).');
    // Se marcan TODOS los perfiles de esa persona, no solo el dispositivo que
    // el operador tiene delante (30/09).
    //
    // `perfil_cliente` va por dispositivo, y una misma persona acumula uno por
    // cada navegador, reinstalación o borrado de datos. Marcando uno solo, el
    // operador veía «agente» en su panel y la persona no tenía el botón,
    // porque estaba usando otro de sus teléfonos. Se vio con un número que
    // tenía ocho perfiles: tres marcados y el de ese día sin marcar.
    //
    // Por teléfono VERIFICADO, que es lo único que identifica a una persona
    // aquí. Sin verificar solo se toca el dispositivo señalado: escribir el
    // número de otro no puede repartir permisos.
    const res = await pool.query(
      `UPDATE perfil_cliente SET es_agente = $2
       WHERE dispositivo_id = $1
          OR (telefono IS NOT NULL
              AND telefono_verificado_en IS NOT NULL
              AND telefono = (SELECT telefono FROM perfil_cliente
                              WHERE dispositivo_id = $1
                                AND telefono_verificado_en IS NOT NULL))
       RETURNING dispositivo_id, nombre, telefono, es_agente`,
      [id, agente],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Ese pasajero no tiene perfil.');
    // El del operador va primero: es la ficha que tiene abierta.
    const suyo = res.rows.find((f) => Number(f.dispositivo_id) === id) ?? res.rows[0];
    return { ...suyo, perfilesTocados: res.rowCount };
  });

  // Nombrar agente de campo a un conductor, o retirarle el papel. Solo el
  // operador: es quien conoce a la gente y quien responde de lo que toquen.
  app.post('/api/operador/conductores/:id/agente', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    const { agente } = (req.body ?? {}) as { agente?: boolean };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    if (typeof agente !== 'boolean') throw errorHttp(400, 'Falta agente (true/false).');
    const res = await pool.query(
      'UPDATE conductor SET es_agente = $2 WHERE id = $1 RETURNING id, nombre, es_agente',
      [id, agente],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Conductor no encontrado.');
    return res.rows[0];
  });

  // Corregir aire acondicionado y seguro (migración 028): lo declara el
  // conductor en su alta, pero el operador puede corregirlo si ve mal el
  // dato (o si el conductor nunca lo llegó a marcar).
  app.post('/api/operador/conductores/:id/vehiculo', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    const cuerpo = (req.body ?? {}) as {
      aireAcondicionado?: boolean; seguro?: boolean;
      color?: string; plazas?: number;
      matricula?: string; marca?: string; carroceria?: string;
    };
    if (typeof cuerpo.aireAcondicionado !== 'boolean' || typeof cuerpo.seguro !== 'boolean') {
      throw errorHttp(400, 'Faltan aireAcondicionado y seguro (true/false).');
    }
    // El color y las plazas se pueden tocar siempre; la matrícula, la marca y
    // el tipo solo mientras el coche NO esté validado —una vez la central dio
    // el visto bueno, cambiarlos sería describir otro coche (como en el alta
    // del propio taxista, sesion.ts)—. Se mira el estado y se decide aquí.
    // Estado del conductor (para el candado del coche validado) y tipo actual
    // del coche (para el tope de plazas de su tipo).
    const actual = await pool.query(
      `SELECT c.estado_verificacion, v.carroceria
       FROM conductor c LEFT JOIN vehiculo v ON v.conductor_id = c.id
       WHERE c.id = $1`,
      [id],
    );
    if (actual.rowCount === 0) throw errorHttp(404, 'No existe ese conductor.');
    const validado = actual.rows[0].estado_verificacion === 'verificado';

    const color = cuerpo.color?.trim() || null;

    // Identidad del coche: solo si llega y solo si aún se puede.
    let matricula: string | null = null;
    let marca: string | null = null;
    let carroceria: string | null = null;
    const tocaIdentidad = cuerpo.matricula !== undefined
      || cuerpo.marca !== undefined || cuerpo.carroceria !== undefined;
    if (tocaIdentidad) {
      if (validado) {
        throw errorHttp(409, 'El coche está validado: la matrícula, la marca y el '
          + 'tipo ya no se cambian desde aquí.');
      }
      matricula = cuerpo.matricula?.trim() || null;
      if (!matricula) throw errorHttp(400, 'La matrícula no puede quedar vacía.');
      marca = cuerpo.marca?.trim() || null;
      carroceria = cuerpo.carroceria?.trim() || null;
      if (carroceria !== null && !CARROCERIAS_VEHICULO.includes(carroceria)) {
        throw errorHttp(400, `Tipo de vehículo no válido. Opciones: ${CARROCERIAS_VEHICULO.join(', ')}.`);
      }
    }

    // Las plazas, con el tope del tipo que va a tener el coche (migración 089):
    // el nuevo si se está cambiando, o el que ya tiene.
    const tipoEfectivo = carroceria ?? actual.rows[0].carroceria;
    let plazas: number | null = null;
    if (cuerpo.plazas !== undefined && cuerpo.plazas !== null) {
      const tope = topePlazas(tipoEfectivo);
      if (!Number.isInteger(cuerpo.plazas) || cuerpo.plazas < 1 || cuerpo.plazas > tope) {
        throw errorHttp(400, `Las plazas tienen que ser un número entre 1 y ${tope} para este tipo de vehículo.`);
      }
      plazas = cuerpo.plazas;
    }

    // El color y las plazas se fijan directo —el formulario de edición manda
    // siempre su valor actual, así que vaciarlos es querer vaciarlos—; la
    // matrícula, la marca y el tipo con COALESCE, que solo cambian cuando se
    // tocó la identidad y entonces viajan con valor.
    const res = await pool.query(
      `UPDATE vehiculo SET
         aire_acondicionado = $2, seguro = $3,
         color = $4,
         plazas = COALESCE($5, plazas),
         matricula = COALESCE($6, matricula),
         marca = COALESCE($7, marca),
         carroceria = COALESCE($8, carroceria)
       WHERE conductor_id = $1
       RETURNING conductor_id, aire_acondicionado, seguro, color, plazas,
                 matricula, marca, carroceria`,
      [id, cuerpo.aireAcondicionado, cuerpo.seguro, color, plazas,
        matricula, marca, carroceria],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Este conductor no tiene vehículo dado de alta.');
    return res.rows[0];
  });

  // Recibir carreras de toda la isla, no solo del barrio propio (migración
  // 048). Lo pidió quien opera esto para poder probar el flujo del taxista sin
  // mudarse al barrio de cada solicitud. Va en la última oleada, así que no le
  // quita trabajo a nadie que esté cerca del pasajero.
  app.post('/api/operador/conductores/:id/cualquier-zona', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    const { activo } = (req.body ?? {}) as { activo?: boolean };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    if (typeof activo !== 'boolean') throw errorHttp(400, 'Falta activo (true/false).');
    const res = await pool.query(
      `UPDATE conductor SET recibe_en_cualquier_zona = $2
       WHERE id = $1 RETURNING id, nombre, recibe_en_cualquier_zona`,
      [id, activo],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'No existe ese conductor.');
    return res.rows[0];
  });

  // El taxi del propio operador (migración 048).
  //
  // El conmutador de papeles ya cambia entre pasajero, taxista y operador,
  // pero el papel de taxista estrenaba un dispositivo sin conductor detrás y
  // caía en la pantalla de alta — que pide un teléfono ya dado de alta como
  // conductor, cosa que el operador no tiene—. Esto lo prepara de una vez:
  // conductor verificado, con vehículo, con cuota al día y con saldo, atado al
  // dispositivo que se pase.
  //
  // Es idempotente: llamarlo dos veces no crea dos taxis ni resetea el saldo.
  app.post('/api/operador/mi-taxi', async (req) => {
    await exigirOperador(req);
    const { uuid, nombre, telefono, matricula } = (req.body ?? {}) as {
      uuid?: string; nombre?: string; telefono?: string; matricula?: string;
    };
    if (!uuid || !PATRON_UUID.test(uuid)) {
      throw errorHttp(400, 'Falta el uuid del dispositivo que va a ser el taxi.');
    }
    const telefonoTaxi = normalizarTelefono(telefono) ?? `+2406${String(
      Math.abs(hashNumerico(uuid)) % 100_000_000,
    ).padStart(8, '0')}`;

    return enTransaccion(pool, async (cliente) => {
      const existente = await cliente.query(
        'SELECT id, unificado_en FROM conductor WHERE telefono = $1',
        [telefonoTaxi],
      );
      let conductorId: number;
      // Unificado con otro taxista (migración 061): el papel de taxista pasa a
      // ser ESE, con sus datos tal como estén. Sin esto, cada vez que se pulsaba
      // «Taxista» en el conmutador se volvía a enganchar el dispositivo al taxi
      // viejo y la unificación se deshacía sola. Y no se le toca nada —ni la
      // suscripción ni la verificación—: es un taxista de verdad con lo suyo,
      // no el taxi de pruebas que este mismo endpoint se inventa.
      const unificadoEn = existente.rows[0]?.unificado_en ?? null;
      if (unificadoEn !== null) {
        conductorId = Number(unificadoEn);
        await cliente.query(
          `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id, ultimo_heartbeat)
           VALUES ($1, 'conductor', $2, now())
           ON CONFLICT (uuid_persistente) DO UPDATE
             SET tipo = 'conductor', conductor_id = EXCLUDED.conductor_id`,
          [uuid.toLowerCase(), conductorId],
        );
        const destino = await cliente.query('SELECT telefono FROM conductor WHERE id = $1', [conductorId]);
        return { conductorId, telefono: destino.rows[0].telefono as string };
      }
      if (existente.rowCount !== 0) {
        conductorId = Number(existente.rows[0].id);
        await cliente.query(
          `UPDATE conductor
           SET estado_verificacion = 'verificado',
               telefono_verificado_en = COALESCE(telefono_verificado_en, now()),
               suscrito_hasta = GREATEST(COALESCE(suscrito_hasta, now()), now() + interval '365 days'),
               recibe_en_cualquier_zona = true
           WHERE id = $1`,
          [conductorId],
        );
      } else {
        const creado = await cliente.query(
          `INSERT INTO conductor
             (telefono, nombre, estado_verificacion, telefono_verificado_en,
              suscrito_hasta, recibe_en_cualquier_zona)
           VALUES ($1, $2, 'verificado', now(), now() + interval '365 days', true)
           RETURNING id`,
          [telefonoTaxi, nombre?.trim() || 'Taxi del operador'],
        );
        conductorId = Number(creado.rows[0].id);
        // También el taxi del operador lleva su número (migración 084).
        await asignarNumeroSiguiente(cliente, conductorId);
      }

      // Sin vehículo el reparto ni lo mira: la matrícula es lo que identifica
      // el coche para el pasajero (R4).
      await cliente.query(
        `INSERT INTO vehiculo (conductor_id, matricula, marca, color)
         SELECT $1, $2, 'Taxi', 'ámbar'
         WHERE NOT EXISTS (SELECT 1 FROM vehiculo WHERE conductor_id = $1)`,
        [conductorId, matricula?.trim() || `GE-OP${conductorId}`],
      );
      await cliente.query(
        'INSERT INTO monedero (conductor_id) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM monedero WHERE conductor_id = $1)',
        [conductorId],
      );
      await cliente.query(
        `INSERT INTO presencia (conductor_id, estado) VALUES ($1, 'DESCONECTADO')
         ON CONFLICT (conductor_id) DO NOTHING`,
        [conductorId],
      );
      // El dispositivo pasa a ser de conductor. Si ya era de otro conductor se
      // le reengancha a este: es el mismo teléfono cambiando de papel, no un
      // robo de identidad —solo el operador puede llamar aquí—.
      await cliente.query(
        `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id, ultimo_heartbeat)
         VALUES ($1, 'conductor', $2, now())
         ON CONFLICT (uuid_persistente) DO UPDATE
           SET tipo = 'conductor', conductor_id = EXCLUDED.conductor_id`,
        [uuid.toLowerCase(), conductorId],
      );
      return { conductorId, telefono: telefonoTaxi };
    });
  });

  // Por dónde anduvo un taxi (migración 042). `exigirOperador`, no
  // `exigirCampo`: un agente de campo sitúa barrios, no vigila a sus
  // compañeros.
  app.get('/api/operador/conductores/:id/recorrido', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de conductor no válido.');
    const { periodo } = (req.query ?? {}) as { periodo?: string };
    const dias = DIAS_POR_PERIODO[periodo ?? 'dia'];
    if (dias === undefined) {
      throw errorHttp(400, 'periodo tiene que ser dia, semana o mes.');
    }
    const hasta = new Date();
    const desde = inicioDelDiaEnMalabo(dias, hasta);
    const recorrido = await recorridoDe(pool, id, desde, hasta);
    const actividad = await actividadDe(pool, id, desde, hasta);
    return {
      periodo: periodo ?? 'dia',
      desde: recorrido.desde.toISOString(),
      hasta: recorrido.hasta.toISOString(),
      puntos: recorrido.puntos,
      metros: recorrido.metros,
      // Tiempo en servicio del periodo. Sale del registro de estados y no del
      // rastro: el rastro tiene agujeros y le quitaría horas trabajadas.
      segundosEnServicio: actividad.segundosEnServicio,
      // Y de esas horas, cuántas con el coche andando (migración 051). Las dos
      // juntas son las que dicen si el turno fue de trabajo o de espera.
      segundosEnMovimiento: actividad.segundosEnMovimiento,
      velocidadMediaKmh: actividad.velocidadMediaKmh,
      // La de conducción: los mismos metros entre el tiempo que el coche se
      // movió de verdad. Es la que no se hunde con las esperas.
      velocidadAlVolanteKmh: actividad.velocidadAlVolanteKmh,
      // Sin las horas: al operador le importa el dibujo y cuánto anduvo, y
      // mandar la marca de tiempo de cada punto dobla el tamaño de la
      // respuesta para nada.
      // `n` es cuántas veces pasó por ahí: lo que colorea el mapa de calor.
      // Nombre corto a propósito — va una vez por punto y son hasta mil
      // quinientos, en una red que se paga por megabyte.
      maxPasadas: recorrido.maxPasadas,
      tramos: recorrido.tramos.map(
        (t) => t.map((p) => ({ lat: p.lat, lng: p.lng, n: p.pasadas ?? 1 })),
      ),
      // Un renglón por salida, para poder LEER el recorrido además de verlo.
      // Aquí sí van las horas: son pocas filas —las salidas de un día— y son
      // justo el dato que no se puede sacar mirando el dibujo.
      salidas: recorrido.resumenTramos.map((t) => ({
        desde: t.desde.toISOString(),
        hasta: t.hasta.toISOString(),
        segundos: t.segundos,
        metros: t.metros,
        parado: t.parado,
      })),
    };
  });

  // Números gruesos del sistema entero: para ver de un vistazo si algo va
  // mal (por ejemplo, muchas solicitudes SIN_OFERTA seguidas).
  app.get('/api/operador/estadisticas', async (req) => {
    await exigirOperador(req);
    const conductores = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE estado_verificacion = 'pendiente')::int AS pendientes,
              count(*) FILTER (WHERE estado_verificacion = 'verificado')::int AS verificados,
              count(*) FILTER (WHERE estado_verificacion = 'suspendido')::int AS suspendidos,
              count(*) FILTER (WHERE estado_verificacion = 'bloqueado')::int AS bloqueados
       FROM conductor`,
    );
    const enServicio = await pool.query(
      `SELECT count(*)::int AS n FROM presencia WHERE estado != 'DESCONECTADO'`,
    );
    const solicitudes = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE estado = 'COMPLETADO')::int AS completadas,
              count(*) FILTER (WHERE estado = 'SIN_OFERTA')::int AS sin_taxi,
              count(*) FILTER (WHERE creada_en >= now() - interval '24 hours')::int AS ultimas_24h
       FROM solicitud`,
    );
    const pasajeros = await pool.query(
      `SELECT count(*)::int AS n FROM dispositivo WHERE tipo = 'cliente'`,
    );
    const saldo = await pool.query(
      `SELECT COALESCE(sum(saldo_xaf), 0)::int AS n FROM saldo_monedero`,
    );
    const incidencias = await pool.query(
      `SELECT count(*)::int AS n FROM incidencia WHERE resuelta_en IS NULL`,
    );
    const recargasPendientes = await pool.query(
      `SELECT count(*)::int AS n FROM recarga WHERE estado = 'pendiente'`,
    );
    return {
      conductores: conductores.rows[0],
      enServicioAhora: enServicio.rows[0].n,
      solicitudes: solicitudes.rows[0],
      pasajeros: pasajeros.rows[0].n,
      saldoTotalMonederosXaf: saldo.rows[0].n,
      incidenciasPendientes: incidencias.rows[0].n,
      recargasPendientes: recargasPendientes.rows[0].n,
    };
  });

  // --- Verificar pagos (migración 018) -------------------------------------
  // Recordatorio del propio dominio: la plataforma NO comprueba ningún pago
  // sola. Esto es la cola de recargas que un conductor dice haber pagado
  // (Muni Dinero o efectivo) y que alguien tiene que mirar y confirmar —o
  // rechazar— a mano antes de que el saldo suba.

  app.get('/api/operador/recargas', async (req) => {
    await exigirOperador(req);
    const { estado } = (req.query ?? {}) as { estado?: string };
    if (estado && !ESTADOS_RECARGA_VALIDOS.includes(estado)) {
      throw errorHttp(400, `Estado no válido. Opciones: ${ESTADOS_RECARGA_VALIDOS.join(', ')}.`);
    }
    const filas = await pool.query(
      `SELECT r.id, r.referencia, r.importe_xaf, r.metodo, r.estado,
              r.solicitada_en, r.resuelta_en, r.resuelta_por, r.nota,
              c.id AS conductor_id, c.nombre AS conductor_nombre, c.telefono AS conductor_telefono
       FROM recarga r
       JOIN conductor c ON c.id = r.conductor_id
       WHERE $1::text IS NULL OR r.estado = $1
       ORDER BY r.solicitada_en DESC
       LIMIT 200`,
      [estado ?? 'pendiente'],
    );
    return { recargas: filas.rows };
  });

  app.post('/api/operador/recargas/:referencia/confirmar', async (req) => {
    const uuid = uuidDesde(req);
    await exigirOperador(req);
    const { referencia } = req.params as { referencia: string };
    const { comprobante } = (req.body ?? {}) as { comprobante?: string };
    try {
      const resultado = await enTransaccion(
        pool,
        (cliente) => confirmarRecarga(cliente, referencia, uuid, comprobante ?? null),
      );
      return resultado;
    } catch (error) {
      if (error instanceof ErrorEntidadInexistente) throw errorHttp(404, error.message);
      if (error instanceof Error) throw errorHttp(409, error.message);
      throw error;
    }
  });

  app.post('/api/operador/recargas/:referencia/rechazar', async (req) => {
    const uuid = uuidDesde(req);
    await exigirOperador(req);
    const { referencia } = req.params as { referencia: string };
    const { motivo } = (req.body ?? {}) as { motivo?: string };
    if (!motivo?.trim()) throw errorHttp(400, 'Hace falta un motivo para rechazar la recarga.');
    try {
      await enTransaccion(pool, (cliente) => rechazarRecarga(cliente, referencia, uuid, motivo.trim()));
      return { rechazada: true };
    } catch (error) {
      if (error instanceof Error) throw errorHttp(409, error.message);
      throw error;
    }
  });

  // --- Pasajeros ------------------------------------------------------------
  // Hasta ahora los pasajeros eran invisibles para el operador: no había ni
  // forma de buscar a la persona que llama quejándose de un bloqueo.

  app.get('/api/operador/pasajeros', async (req) => {
    await exigirOperador(req);
    const { q } = (req.query ?? {}) as { q?: string };
    const filas = await pool.query(
      `SELECT d.id AS dispositivo_id, d.strikes, d.bloqueado_en, d.creado_en,
              pc.telefono, pc.correo, pc.nombre,
              (SELECT count(*)::int FROM solicitud s WHERE s.dispositivo_cliente_id = d.id) AS viajes
       FROM dispositivo d
       JOIN perfil_cliente pc ON pc.dispositivo_id = d.id
       WHERE d.tipo = 'cliente'
         AND ($1::text IS NULL
              OR pc.telefono LIKE '%' || $1 || '%'
              OR pc.nombre ILIKE '%' || $1 || '%'
              OR pc.correo ILIKE '%' || $1 || '%')
       ORDER BY d.bloqueado_en IS NOT NULL DESC, d.creado_en DESC
       LIMIT 100`,
      [q?.trim() || null],
    );
    return { pasajeros: filas.rows };
  });

  app.get('/api/operador/pasajeros/:dispositivoId', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { dispositivoId: string }).dispositivoId);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de dispositivo no válido.');
    const ficha = await pool.query(
      `SELECT d.id AS dispositivo_id, d.strikes, d.bloqueado_en, d.creado_en,
              pc.telefono, pc.correo, pc.nombre, pc.edad, pc.genero, pc.es_agente
       FROM dispositivo d
       JOIN perfil_cliente pc ON pc.dispositivo_id = d.id
       WHERE d.id = $1 AND d.tipo = 'cliente'`,
      [id],
    );
    if (ficha.rowCount === 0) throw errorHttp(404, 'Pasajero no encontrado.');
    const resumen = await pool.query(
      `SELECT count(*)::int AS pedidos,
              count(*) FILTER (WHERE estado = 'COMPLETADO')::int AS completados,
              count(*) FILTER (WHERE estado = 'CANCELADO_CLIENTE')::int AS cancelados,
              count(*) FILTER (WHERE estado IN ('NO_PRESENTADO', 'CLIENTE_AUSENTE'))::int AS ausencias
       FROM solicitud WHERE dispositivo_cliente_id = $1`,
      [id],
    );
    const ultimos = await pool.query(
      `SELECT s.id, s.estado, s.creada_en, c.nombre AS conductor,
              ro.nombre AS origen, rd.nombre AS destino
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       LEFT JOIN conductor c ON c.id = s.conductor_id
       WHERE s.dispositivo_cliente_id = $1
       ORDER BY s.creada_en DESC LIMIT 10`,
      [id],
    );
    return { ...ficha.rows[0], viajes: resumen.rows[0], ultimosViajes: ultimos.rows };
  });

  // Perdón del operador: strikes a cero y bloqueo levantado. Es la válvula
  // del sistema de strikes automático — sin ella, un bloqueo injusto (o tres
  // ausencias con excusa razonable) no tenía más salida que el SQL a mano.
  app.post('/api/operador/pasajeros/:dispositivoId/desbloquear', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { dispositivoId: string }).dispositivoId);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de dispositivo no válido.');
    const res = await pool.query(
      `UPDATE dispositivo SET strikes = 0, bloqueado_en = NULL
       WHERE id = $1 AND tipo = 'cliente'
       RETURNING id AS dispositivo_id, strikes, bloqueado_en`,
      [id],
    );
    if (res.rowCount === 0) throw errorHttp(404, 'Pasajero no encontrado.');
    return res.rows[0];
  });

  // --- Incidencias -----------------------------------------------------------
  // La cola de revisión manual. Hoy la alimenta el «cliente ausente con
  // sesión activa» (R4: nunca se sanciona automáticamente a alguien que
  // estaba mirando la pantalla); cualquier incidencia futura cae aquí igual.

  app.get('/api/operador/incidencias', async (req) => {
    await exigirOperador(req);
    const { estado } = (req.query ?? {}) as { estado?: string };
    const soloPendientes = estado !== 'resueltas';
    const filas = await pool.query(
      `SELECT i.id, i.tipo, i.descripcion, i.creada_en,
              i.resuelta_por, i.resuelta_en, i.resolucion,
              s.id AS solicitud_id, s.estado AS estado_viaje, s.telefono_cliente,
              s.dispositivo_cliente_id, d.strikes, d.bloqueado_en,
              c.nombre AS conductor,
              ro.nombre AS origen, rd.nombre AS destino
       FROM incidencia i
       JOIN viaje v ON v.id = i.viaje_id
       JOIN solicitud s ON s.id = v.solicitud_id
       JOIN dispositivo d ON d.id = s.dispositivo_cliente_id
       JOIN conductor c ON c.id = v.conductor_id
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       WHERE ($1 AND i.resuelta_en IS NULL) OR (NOT $1 AND i.resuelta_en IS NOT NULL)
       ORDER BY i.creada_en ${soloPendientes ? 'ASC' : 'DESC'}
       LIMIT 100`,
      [soloPendientes],
    );
    return { incidencias: filas.rows };
  });

  // El historial del viaje de una incidencia: el log de transiciones dice
  // quién hizo qué y cuándo, que es justo lo que hace falta para juzgar.
  app.get('/api/operador/incidencias/:id/historial', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de incidencia no válido.');
    // Dos preguntas distintas: si la incidencia existe (si no, 404) y qué
    // transiciones tiene su viaje (que pueden ser cero sin que sea un error).
    const incidencia = await pool.query(
      `SELECT v.solicitud_id FROM incidencia i JOIN viaje v ON v.id = i.viaje_id
       WHERE i.id = $1`,
      [id],
    );
    if (incidencia.rowCount === 0) throw errorHttp(404, 'Incidencia no encontrada.');
    const filas = await pool.query(
      `SELECT t.estado_anterior, t.estado_nuevo, t.actor, t.creado_en
       FROM transicion t
       WHERE t.solicitud_id = $1
       ORDER BY t.id`,
      [incidencia.rows[0].solicitud_id],
    );
    return { transiciones: filas.rows };
  });

  app.post('/api/operador/incidencias/:id/resolver', async (req) => {
    const uuid = uuidDesde(req);
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    const { accion } = (req.body ?? {}) as { accion?: string };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de incidencia no válido.');
    if (accion !== 'sancionar' && accion !== 'perdonar') {
      throw errorHttp(400, 'Acción no válida: sancionar o perdonar.');
    }
    return enTransaccion(pool, async (cliente) => {
      const fila = await cliente.query(
        `SELECT i.id, i.resuelta_en, s.dispositivo_cliente_id
         FROM incidencia i
         JOIN viaje v ON v.id = i.viaje_id
         JOIN solicitud s ON s.id = v.solicitud_id
         WHERE i.id = $1 FOR UPDATE OF i`,
        [id],
      );
      if (fila.rowCount === 0) throw errorHttp(404, 'Incidencia no encontrada.');
      if (fila.rows[0].resuelta_en !== null) {
        throw errorHttp(409, 'Esta incidencia ya está resuelta.');
      }

      let strikes = null;
      let bloqueado = false;
      if (accion === 'sancionar') {
        // El mismo strike que habría aplicado el sistema (R4), solo que con
        // una persona delante que ha mirado el caso.
        const limite = await leerParametroEntero(cliente, 'strikes_para_bloqueo');
        const strike = await cliente.query(
          `UPDATE dispositivo
           SET strikes = strikes + 1,
               bloqueado_en = CASE WHEN strikes + 1 >= $2 THEN COALESCE(bloqueado_en, now())
                                   ELSE bloqueado_en END
           WHERE id = $1
           RETURNING strikes, bloqueado_en`,
          [fila.rows[0].dispositivo_cliente_id, limite],
        );
        strikes = strike.rows[0].strikes;
        bloqueado = strike.rows[0].bloqueado_en !== null;
      }

      await cliente.query(
        `UPDATE incidencia
         SET resuelta_por = $2, resuelta_en = now(),
             resolucion = $3
         WHERE id = $1`,
        [id, uuid, accion === 'sancionar' ? 'sancionado' : 'perdonado'],
      );
      return { incidenciaId: id, resolucion: accion === 'sancionar' ? 'sancionado' : 'perdonado', strikes, bloqueado };
    });
  });

  // --- Cuadro de mandos (bloque 1) -------------------------------------------
  // La salud del sistema de un vistazo, y las alarmas de la sección 11 de la
  // especificación evaluadas de verdad: los umbrales `alarma_*` llevaban en
  // la tabla parametro desde el paso 1 sin que nadie los consumiera.

  app.get('/api/operador/salud', async (req) => {
    await exigirOperador(req);

    const umbralesRes = await pool.query(
      `SELECT clave, valor FROM parametro WHERE clave LIKE 'alarma%'`,
    );
    const umbral = new Map<string, number>(
      umbralesRes.rows.map((f: { clave: string; valor: string }) => [f.clave, Number(f.valor)]),
    );

    const taxisPorZona = await pool.query(
      `SELECT z.nombre AS zona, count(*)::int AS taxis,
              count(*) FILTER (WHERE p.estado = 'DISPONIBLE')::int AS disponibles
       FROM presencia p JOIN zona z ON z.id = p.zona_id
       WHERE p.estado != 'DESCONECTADO'
       GROUP BY z.nombre ORDER BY taxis DESC, z.nombre`,
    );
    const enCurso = await pool.query(
      `SELECT estado, count(*)::int AS n FROM solicitud
       WHERE estado IN ('SOLICITADO', 'EMITIDO', 'ACEPTADO', 'EN_CAMINO', 'RECOGIDO')
       GROUP BY estado`,
    );

    // Tasa de «sin oferta» por zona, últimas 24 horas. Con menos de 5
    // peticiones no se opina: dos solicitudes fallidas de madrugada no son
    // una alarma, son madrugada.
    const MUESTRA_MINIMA = 5;
    const sinOferta = await pool.query(
      `SELECT z.nombre AS zona, count(*)::int AS pedidas,
              count(*) FILTER (WHERE s.estado = 'SIN_OFERTA')::int AS sin_taxi
       FROM solicitud s
       JOIN referencia r ON r.id = s.referencia_origen_id
       JOIN zona z ON z.id = r.zona_id
       WHERE s.creada_en >= now() - interval '24 hours'
       GROUP BY z.nombre HAVING count(*) >= ${MUESTRA_MINIMA}`,
    );
    const zonasSinTaxi = sinOferta.rows
      .map((f: { zona: string; pedidas: number; sin_taxi: number }) => ({
        nombre: f.zona, muestras: f.pedidas, tasa: f.sin_taxi / f.pedidas,
      }))
      .filter((f) => f.tasa >= (umbral.get('alarma_tasa_sin_oferta_max') ?? 1))
      .sort((a, b) => b.tasa - a.tasa);

    // Por conductor, últimos 30 días: ausencias declaradas y cancelaciones
    // tras aceptar. Son las dos formas de quemar pasajeros.
    const porConductor = await pool.query(
      `SELECT c.nombre, count(*)::int AS asignados,
              count(*) FILTER (WHERE s.estado IN ('NO_PRESENTADO', 'CLIENTE_AUSENTE'))::int AS ausencias,
              count(*) FILTER (WHERE s.estado = 'CANCELADO_CONDUCTOR')::int AS cancelados
       FROM solicitud s JOIN conductor c ON c.id = s.conductor_id
       WHERE s.creada_en >= now() - interval '30 days'
       GROUP BY c.id, c.nombre HAVING count(*) >= ${MUESTRA_MINIMA}`,
    );
    const filaConductor = (f: { nombre: string; asignados: number; ausencias: number; cancelados: number }) => f;
    const conductoresAusencias = porConductor.rows
      .map(filaConductor)
      .map((f) => ({ nombre: f.nombre, muestras: f.asignados, tasa: f.ausencias / f.asignados }))
      .filter((f) => f.tasa >= (umbral.get('alarma_tasa_no_presentado_max') ?? 1))
      .sort((a, b) => b.tasa - a.tasa);
    const conductoresCancelan = porConductor.rows
      .map(filaConductor)
      .map((f) => ({ nombre: f.nombre, muestras: f.asignados, tasa: f.cancelados / f.asignados }))
      .filter((f) => f.tasa >= (umbral.get('alarma_tasa_acept_cancel_max') ?? 1))
      .sort((a, b) => b.tasa - a.tasa);

    // Validación de recogidas (R5): viajes completados cuya recogida quedó
    // validada (PIN o proximidad GPS). Si baja, la comisión se está cobrando
    // a ciegas o no se está cobrando.
    const validacion = await pool.query(
      `SELECT count(*)::int AS completados,
              count(*) FILTER (WHERE v.validado_en IS NOT NULL)::int AS validados
       FROM solicitud s JOIN viaje v ON v.solicitud_id = s.id
       WHERE s.estado = 'COMPLETADO' AND s.creada_en >= now() - interval '7 days'`,
    );
    const completados = validacion.rows[0].completados as number;
    const tasaValidacion = completados >= MUESTRA_MINIMA
      ? validacion.rows[0].validados / completados
      : null;

    // Abuso de tarifa (R5, P12-02). Volvió a ser posible con la migración 066:
    // el pasajero puede marcar «me cobró de más» y decir lo que pagó.
    const tarifa = await senalesDeTarifa(pool);

    const alarmas = [
      {
        clave: 'alarma_tasa_sin_oferta_max',
        nombre: 'Zonas que se quedan sin taxi',
        ambito: 'por zona, últimas 24 h',
        umbral: umbral.get('alarma_tasa_sin_oferta_max') ?? null,
        disparada: zonasSinTaxi.length > 0,
        detalle: zonasSinTaxi,
      },
      {
        clave: 'alarma_tasa_no_presentado_max',
        nombre: 'Conductores con demasiadas ausencias',
        ambito: 'por conductor, últimos 30 días',
        umbral: umbral.get('alarma_tasa_no_presentado_max') ?? null,
        disparada: conductoresAusencias.length > 0,
        detalle: conductoresAusencias,
      },
      {
        clave: 'alarma_tasa_acept_cancel_max',
        nombre: 'Conductores que aceptan y cancelan',
        ambito: 'por conductor, últimos 30 días',
        umbral: umbral.get('alarma_tasa_acept_cancel_max') ?? null,
        disparada: conductoresCancelan.length > 0,
        detalle: conductoresCancelan,
      },
      {
        clave: 'alarma_tasa_validacion_min',
        nombre: 'Recogidas sin validar',
        ambito: 'global, últimos 7 días',
        umbral: umbral.get('alarma_tasa_validacion_min') ?? null,
        // Sin muestra suficiente no hay opinión, y sin opinión no hay alarma.
        disparada: tasaValidacion !== null
          && tasaValidacion < (umbral.get('alarma_tasa_validacion_min') ?? 0),
        detalle: tasaValidacion === null
          ? []
          : [{ nombre: 'validadas', muestras: completados, tasa: tasaValidacion }],
      },
      {
        clave: 'alarma_cobros_de_mas',
        nombre: 'Taxistas marcados por cobrar de más',
        ambito: 'por conductor, últimos 30 días',
        umbral: umbral.get('alarma_cobros_de_mas') ?? null,
        disparada: tarifa.length > 0,
        // `tasa` es la proporción de sus viajes con marca, que es lo que
        // distingue a quien tuvo tres quejas en trescientos viajes de quien
        // las tuvo en cinco.
        detalle: tarifa.map((t) => ({
          nombre: `${t.nombre} · ${t.marcas} marcas, ${t.porEncimaDelP75} por encima del p75`,
          muestras: t.viajes,
          tasa: t.viajes === 0 ? 0 : t.marcas / t.viajes,
        })),
      },
      {
        clave: 'alarma_coste_mensajeria_xaf',
        nombre: 'Coste de mensajería por viaje',
        ambito: 'sin fuente de datos: no hay mensajería de pago contratada',
        umbral: umbral.get('alarma_coste_mensajeria_xaf') ?? null,
        disparada: false,
        detalle: [],
      },
    ];

    return {
      taxisPorZona: taxisPorZona.rows,
      viajesEnCurso: enCurso.rows,
      alarmas,
    };
  });

  // --- Central telefónica (bloque 4, canal de voz 3.6) -----------------------
  // Quien no tiene la aplicación llama por teléfono y el operador pide por
  // él. El dominio lo soporta desde el paso 1 (actor 'operador'); esto solo
  // le pone puerta. Cada teléfono que llama tiene su propio «dispositivo»
  // sintético, así conserva historial y strikes como cualquier usuario.

  app.post('/api/operador/solicitudes', async (req, reply) => {
    await exigirOperador(req);
    const cuerpo = (req.body ?? {}) as { telefono?: string; origenId?: number; destinoId?: number };
    // Canónico también aquí: si no, quien llama dos veces con el número escrito
    // de dos formas tendría dos identidades y dos historiales (migración 024).
    const telefono = normalizarTelefono(cuerpo.telefono);
    if (!telefono) {
      throw errorHttp(400, `Hace falta el teléfono de quien llama (recibido: «${cuerpo.telefono ?? ''}»).`);
    }
    if (!cuerpo.origenId || !cuerpo.destinoId) {
      throw errorHttp(400, 'Faltan campos: origenId y destinoId son obligatorios.');
    }
    if (cuerpo.origenId === cuerpo.destinoId) {
      throw errorHttp(400, 'El origen y el destino no pueden ser la misma referencia.');
    }

    const dispositivoId = await enTransaccion(pool, async (cliente) => {
      // El mismo teléfono que ya llamó otras veces reutiliza su dispositivo
      // sintético (el más reciente si hubiera varios perfiles con el número).
      const existente = await cliente.query(
        `SELECT d.id, d.bloqueado_en
         FROM perfil_cliente pc JOIN dispositivo d ON d.id = pc.dispositivo_id
         WHERE pc.telefono = $1 AND pc.telefono_vigente AND d.tipo = 'cliente'
         ORDER BY d.id DESC LIMIT 1`,
        [telefono],
      );
      if ((existente.rowCount ?? 0) > 0) {
        if (existente.rows[0].bloqueado_en !== null) {
          throw errorHttp(403, 'Ese teléfono está bloqueado por incidencias repetidas. Revisa su ficha en Pasajeros.');
        }
        return existente.rows[0].id as number;
      }
      const dispositivo = await cliente.query(
        `INSERT INTO dispositivo (uuid_persistente, tipo) VALUES ($1, 'cliente') RETURNING id`,
        [randomUUID()],
      );
      await cliente.query(
        `INSERT INTO perfil_cliente (dispositivo_id, telefono) VALUES ($1, $2)`,
        [dispositivo.rows[0].id, telefono],
      );
      return dispositivo.rows[0].id as number;
    });

    // La misma idempotencia que la app (R1): si el operador pulsa dos veces,
    // no se piden dos taxis.
    const ventana = Math.floor(Date.now() / 60_000);
    const clave = createHash('sha256')
      .update(`${dispositivoId}|${cuerpo.origenId}|${cuerpo.destinoId}|${ventana}`)
      .digest('hex');

    const creada = await enTransaccion(pool, (c) => crearSolicitud(c, {
      dispositivoClienteId: dispositivoId,
      telefonoCliente: telefono,
      referenciaOrigenId: cuerpo.origenId!,
      referenciaDestinoId: cuerpo.destinoId!,
      actor: 'operador',
      claveIdempotencia: clave,
      origenEvento: 'llamada_voz',
    }));

    if (!creada.yaExistia) {
      const despacho = await iniciarDespacho(pool, emisor, creada.solicitudId);
      return reply.status(201).send({
        solicitudId: creada.solicitudId, estado: despacho.resultado, yaExistia: false,
      });
    }
    const actual = await pool.query('SELECT estado FROM solicitud WHERE id = $1', [creada.solicitudId]);
    return reply.send({
      solicitudId: creada.solicitudId, estado: actual.rows[0].estado, yaExistia: true,
    });
  });

  // --- La consola de despacho: qué está pasando AHORA MISMO (03/10) ---------
  //
  // Una sola petición, porque es para pintar una pantalla que se refresca sola
  // cada pocos segundos y quien la mira está sentado delante del ordenador todo
  // el día. Tres consultas sueltas serían tres relojes desincronizados: el mapa
  // enseñando un taxi que la lista de al lado ya da por ocupado.
  //
  // POR QUÉ ESTO NO EXISTÍA. Hasta ahora el panel servía para revisar cosas
  // —incidencias, pagos, fichas—, que es trabajo de «cuando puedas». Despachar
  // es lo contrario: es saber dónde hay un taxi libre cerca de quien acaba de
  // llamar, y eso no se puede hacer con una lista ordenada por fecha.
  app.get('/api/operador/vivo', async (req) => {
    await exigirOperador(req);

    // Dónde está cada taxi. La última miga de `rastro` por conductor (migración
    // 042), con LATERAL para que el índice (conductor_id, creado_en) haga el
    // trabajo: sin él esto sería leer el rastro entero y quedarse con la última
    // fila de cada grupo, y el rastro son millones de filas.
    //
    // Se piden TODOS los que no están desconectados, incluidos los que no tienen
    // ni una posición: un taxi en servicio del que no sabemos dónde está es
    // justo el que hay que mirar, y esconderlo del mapa lo haría invisible.
    const taxis = await pool.query(
      `SELECT c.id::int AS conductor_id, c.nombre, c.telefono, c.numero_taxi,
              v.matricula, p.estado, z.nombre AS zona,
              r.lat, r.lng,
              EXTRACT(EPOCH FROM (now() - r.creado_en))::int AS visto_hace_seg,
              EXTRACT(EPOCH FROM (now() - p.ultimo_heartbeat))::int AS latido_hace_seg,
              s.id AS solicitud_id
       FROM presencia p
       JOIN conductor c ON c.id = p.conductor_id
       LEFT JOIN vehiculo v ON v.conductor_id = c.id
       LEFT JOIN zona z ON z.id = p.zona_id
       LEFT JOIN LATERAL (
         SELECT lat, lng, creado_en FROM rastro
         WHERE conductor_id = c.id
         ORDER BY creado_en DESC LIMIT 1
       ) r ON true
       LEFT JOIN LATERAL (
         SELECT id FROM solicitud
         WHERE conductor_id = c.id
           AND estado IN ('ACEPTADO', 'EN_CAMINO', 'RECOGIDO')
         ORDER BY creada_en DESC LIMIT 1
       ) s ON true
       WHERE p.estado <> 'DESCONECTADO'
         -- Y con el latido vivo. Que la presencia no diga DESCONECTADO no basta:
         -- quien la apaga es un reloj que corre cada pocos segundos y que puede
         -- llevar parado un rato, así que en la tabla hay taxis «en servicio»
         -- cuyo último latido es de hace días. Para despachar eso es peor que un
         -- hueco: manda al operador a llamar a alguien que apagó el móvil el
         -- martes. Quince minutos es flojo a propósito —un taxi que pierde un
         -- latido por un túnel no debe desaparecer del mapa— pero corta en seco
         -- a los fantasmas.
         AND p.ultimo_heartbeat > now() - interval '15 minutes'
       ORDER BY c.nombre`,
    );

    // Los viajes vivos. `SOLICITADO` y `EMITIDO` son los que todavía no tienen
    // taxi: son los que de verdad importan, y por eso van con los segundos que
    // llevan esperando — un pasajero que lleva tres minutos sin taxi es una
    // llamada que el operador puede hacer antes de que cuelgue y se vaya.
    const viajes = await pool.query(
      `SELECT s.id::int AS id, s.estado, s.creada_en, s.telefono_cliente,
              EXTRACT(EPOCH FROM (now() - s.creada_en))::int AS espera_seg,
              ro.nombre AS origen, ro.lat AS origen_lat, ro.lng AS origen_lng,
              rd.nombre AS destino, rd.lat AS destino_lat, rd.lng AS destino_lng,
              c.id::int AS conductor_id, c.nombre AS conductor, v.matricula
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       LEFT JOIN conductor c ON c.id = s.conductor_id
       LEFT JOIN vehiculo v ON v.conductor_id = c.id
       WHERE s.estado IN ('SOLICITADO', 'EMITIDO', 'ACEPTADO', 'EN_CAMINO', 'RECOGIDO')
       -- Los que ESPERAN van primero, pase lo que pase con el tope: el día
       -- que haya sesenta viajes en marcha, lo que no puede quedarse fuera de
       -- la lista es el pasajero sin taxi. Con el orden de antes (solo por
       -- antigüedad), bastaban sesenta zombis viejos para esconderlo.
       ORDER BY (s.estado IN ('SOLICITADO', 'EMITIDO')) DESC, s.creada_en ASC
       LIMIT 60`,
    );

    // La demanda que NO se sirvió (06/10): dónde se pidió taxi hace poco y
    // murió sin oferta. En el mapa son los puntos apagados — el operador ve
    // dónde se está perdiendo trabajo, que es lo que ninguna tabla enseña.
    const sinOferta = await pool.query(
      `SELECT s.id::int AS id, s.creada_en, s.telefono_cliente,
              EXTRACT(EPOCH FROM (now() - s.creada_en))::int AS hace_seg,
              ro.nombre AS origen, ro.lat AS origen_lat, ro.lng AS origen_lng,
              rd.nombre AS destino
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       WHERE s.estado = 'SIN_OFERTA'
         AND s.creada_en > now() - interval '60 minutes'
       ORDER BY s.creada_en DESC
       LIMIT 40`,
    );

    return {
      taxis: taxis.rows,
      viajes: viajes.rows,
      sinOferta: sinOferta.rows,
      momento: new Date().toISOString(),
    };
  });

  // La oferta dirigida, desde el mapa de la mesa (06/10). El taxista la
  // recibe como cualquier otra y decide él; aquí solo se elige a quién avisar.
  app.post('/api/operador/viajes/:id/ofrecer', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    const conductorId = Number(((req.body ?? {}) as { conductorId?: number }).conductorId);
    if (!Number.isInteger(id) || !Number.isInteger(conductorId)) {
      throw errorHttp(400, 'Faltan la carrera y el taxi.');
    }
    const r = await ofrecerAMano(pool, emisor, id, conductorId);
    if (!r.ofrecida) {
      throw errorHttp(409, r.motivo === 'estado'
        ? 'Esa carrera ya no está esperando: alguien la cogió o se cerró.'
        : 'Ese taxi no puede recibirla ahora: ya tiene esta oferta delante, '
          + 'va lleno, o lleva un rato sin dar señales.');
    }
    return { ofrecida: true };
  });

  // Todas las carreras, no solo las que dictó el operador (03/10).
  //
  // La lista de la Central solo enseña las que nacieron de una llamada —tiene
  // su propio `EXISTS` sobre la transición del operador— y eso dejaba fuera el
  // 95 % de lo que pasa en la plataforma. Para mirar un día entero, contrastar
  // una queja o ver cuántas se quedaron sin taxi hacía falta entrar en la base.
  //
  // Se devuelve en crudo y en tabla: aquí no se decide nada, se lee. Por eso
  // lleva las dos cosas que se buscan de verdad —un teléfono y un estado— y
  // nada más: un buscador por sitio sonaría bien y sería otra consulta lenta
  // sobre una tabla que crece todos los días.
  app.get('/api/operador/viajes', async (req) => {
    await exigirOperador(req);
    const { estado, q } = (req.query ?? {}) as { estado?: string; q?: string };
    const buscado = q?.trim() || null;
    const filas = await pool.query(
      `SELECT s.id::int AS id, s.estado, s.creada_en, s.telefono_cliente,
              -- Para enlazar la carrera con sus fichas (08/10): el taxista y el
              -- cliente que la pidió. El dispositivo del cliente es la clave de
              -- su ficha de pasajero.
              s.conductor_id, s.dispositivo_cliente_id AS dispositivo_id,
              -- Lo que el pasajero dijo que pagó, si lo dijo (migración 066).
              -- Vive en su propia tabla y cuelga del viaje, no de la solicitud.
              (SELECT pd.importe_xaf FROM viaje vi
               JOIN precio_declarado pd ON pd.viaje_id = vi.id AND pd.emisor = 'cliente'
               WHERE vi.solicitud_id = s.id)::int AS precio_xaf,
              ro.nombre AS origen, rd.nombre AS destino,
              c.nombre AS conductor, v.matricula,
              (SELECT max(t.creado_en) FROM transicion t
               WHERE t.solicitud_id = s.id) AS cerrada_en,
              -- Cuándo subió el cliente y cuándo bajó (06/10). De la tabla de
              -- transiciones, que es la que no miente: min() porque a un
              -- estado solo se llega una vez, y si algún día se llegara dos,
              -- la primera es la de verdad.
              (SELECT min(t.creado_en) FROM transicion t
               WHERE t.solicitud_id = s.id AND t.estado_nuevo = 'RECOGIDO') AS recogido_en,
              (SELECT min(t.creado_en) FROM transicion t
               WHERE t.solicitud_id = s.id AND t.estado_nuevo = 'COMPLETADO') AS bajada_en,
              (SELECT min(t.creado_en) FROM transicion t
               WHERE t.solicitud_id = s.id AND t.estado_nuevo = 'EMITIDO') AS emitido_en,
              -- La zona de recogida y la de bajada (06/10). No hace falta
              -- guardar nada: el origen y el destino son referencias del
              -- catálogo, y cada referencia vive en una zona. Si algún día un
              -- sitio se muda de zona, el registro dirá la zona de HOY — se
              -- asume: mudar un sitio de zona es corregir un error, y el
              -- registro corregido es mejor que el equivocado.
              zro.nombre AS zona_recogida, zrd.nombre AS zona_bajada
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       JOIN zona zro ON zro.id = ro.zona_id
       JOIN zona zrd ON zrd.id = rd.zona_id
       LEFT JOIN conductor c ON c.id = s.conductor_id
       LEFT JOIN vehiculo v ON v.conductor_id = c.id
       WHERE ($1::text IS NULL OR s.estado = $1)
         AND ($2::text IS NULL OR s.telefono_cliente LIKE '%' || $2 || '%')
       ORDER BY s.creada_en DESC
       LIMIT 200`,
      [estado?.trim() || null, buscado],
    );
    return { viajes: filas.rows };
  });

  // La traza de UNA carrera sobre el plano (06/10): por dónde fue de verdad,
  // sacada del rastro del conductor entre que la aceptó y que se cerró. Dos
  // tramos: la ida a por el cliente y el viaje con él dentro — el mapa los
  // pinta separados porque el hueco entre ambos es la recogida.
  app.get('/api/operador/viajes/:id/traza', async (req) => {
    await exigirOperador(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de carrera no válido.');

    const cabecera = await pool.query(
      `SELECT s.conductor_id,
              ro.nombre AS origen, ro.lat AS origen_lat, ro.lng AS origen_lng,
              rd.nombre AS destino, rd.lat AS destino_lat, rd.lng AS destino_lng,
              (SELECT min(t.creado_en) FROM transicion t
               WHERE t.solicitud_id = s.id AND t.estado_nuevo = 'ACEPTADO') AS desde,
              (SELECT min(t.creado_en) FROM transicion t
               WHERE t.solicitud_id = s.id AND t.estado_nuevo = 'RECOGIDO') AS recogido_en,
              (SELECT max(t.creado_en) FROM transicion t
               WHERE t.solicitud_id = s.id) AS hasta
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       WHERE s.id = $1`,
      [id],
    );
    if (cabecera.rowCount === 0) throw errorHttp(404, 'No existe esa carrera.');
    const c = cabecera.rows[0];
    const extremos = {
      origen: { nombre: c.origen, lat: c.origen_lat, lng: c.origen_lng },
      destino: { nombre: c.destino, lat: c.destino_lat, lng: c.destino_lng },
    };
    if (c.conductor_id === null || c.desde === null) {
      // Sin taxi no hay rastro que enseñar; los extremos sí, que algo dicen.
      return { ...extremos, tramos: [] };
    }

    // Con tope: una carrera son minutos de migas, pero el rastro no sabe de
    // carreras y un reloj parado podría dejar una ventana de horas.
    const migas = await pool.query(
      `SELECT lat, lng, creado_en FROM rastro
       WHERE conductor_id = $1
         AND creado_en BETWEEN $2 AND COALESCE($3, $2::timestamptz + interval '3 hours')
       ORDER BY creado_en
       LIMIT 3000`,
      [c.conductor_id, c.desde, c.hasta],
    );
    const recogida = c.recogido_en === null ? null : new Date(c.recogido_en).getTime();
    const ida: Array<{ lat: number; lng: number }> = [];
    const conCliente: Array<{ lat: number; lng: number }> = [];
    for (const m of migas.rows) {
      const punto = { lat: m.lat, lng: m.lng };
      if (recogida === null || new Date(m.creado_en).getTime() < recogida) ida.push(punto);
      else conCliente.push(punto);
    }
    return {
      ...extremos,
      tramos: [ida, conCliente].filter((t) => t.length > 1),
    };
  });

  // Las últimas solicitudes de la central, con lo que el operador tiene que
  // dictar por teléfono: estado, y matrícula cuando hay taxi asignado.
  app.get('/api/operador/solicitudes', async (req) => {
    await exigirOperador(req);
    const filas = await pool.query(
      `SELECT s.id, s.estado, s.creada_en, s.telefono_cliente,
              ro.nombre AS origen, rd.nombre AS destino,
              c.nombre AS conductor, v.matricula
       FROM solicitud s
       JOIN referencia ro ON ro.id = s.referencia_origen_id
       JOIN referencia rd ON rd.id = s.referencia_destino_id
       LEFT JOIN conductor c ON c.id = s.conductor_id
       LEFT JOIN vehiculo v ON v.conductor_id = c.id
       WHERE EXISTS (
         SELECT 1 FROM transicion t
         WHERE t.solicitud_id = s.id AND t.actor = 'operador' AND t.estado_nuevo = 'SOLICITADO'
       )
       ORDER BY s.creada_en DESC LIMIT 20`,
    );
    return { solicitudes: filas.rows };
  });

  // --- Editor del gazetteer (bloque 5) ---------------------------------------
  // El catálogo de sitios es trabajo de campo continuo (P1-03): un nombre
  // nuevo, un alias como se dice de palabra, unas coordenadas corregidas.
  // Hasta ahora todo eso era SQL a mano.

  app.get('/api/operador/zonas', async (req) => {
    await exigirCampo(req);
    // Las no situadas primero: son la cola de trabajo. Ocho barrios de Malabo
    // entraron sin coordenadas porque ninguna fuente sabía dónde están
    // (migración 025), y hasta que alguien vaya, no existen para el reparto.
    const filas = await pool.query(
      `SELECT z.id, z.nombre, z.distrito, z.distrito_urbano, z.zona_padre_id,
              z.es_cabecera_urbana,
              z.centroide_lat AS lat, z.centroide_lng AS lng,
              z.precision_gps_m AS precision_m,
              (z.centroide_lat IS NULL) AS sin_situar,
              (SELECT count(*)::int FROM referencia r WHERE r.zona_id = z.id AND r.activa) AS referencias,
              (SELECT count(*)::int FROM zona_adyacencia a WHERE a.zona_id = z.id) AS vecinas
       FROM zona z ORDER BY (z.centroide_lat IS NULL) DESC, z.nombre`,
    );
    return { zonas: filas.rows };
  });

  // «Estoy aquí»: sitúa un barrio con el GPS de quien lo pulsa. Recalcula la
  // adyacencia entera, porque un barrio sin vecinos es un barrio al que el
  // reparto no llega en la tercera oleada.
  app.post('/api/operador/zonas/:id/situar', async (req) => {
    await exigirCampo(req);
    const id = Number((req.params as { id: string }).id);
    const { lat, lng, precision } = (req.body ?? {}) as {
      lat?: number; lng?: number; precision?: number;
    };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de zona no válido.');
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw errorHttp(400, 'Faltan las coordenadas (lat, lng).');
    }
    if (!enBioko(lat, lng)) {
      throw errorHttp(400, 'Esas coordenadas caen fuera de Bioko. ¿Se cogió el GPS de verdad?');
    }
    const precisionM = await exigirGpsFiable(pool, precision);
    try {
      return await enTransaccion(pool, (cliente) => situarZona(cliente, id, lat, lng, precisionM));
    } catch (error) {
      if (error instanceof Error && /No existe la zona/.test(error.message)) {
        throw errorHttp(404, error.message);
      }
      throw error;
    }
  });

  // Un barrio que no estaba en ninguna lista. Pasa: quien va por la calle
  // encuentra barrios que ni OSM ni el censo tenían.
  //
  // Con zonaPadreId (migración 031): en vez de un distrito urbano nuevo,
  // crea un barrio/calle dentro de uno existente — mismo botón «estoy
  // aquí», sin adyacencia propia (crearZonaEnGps se encarga).
  app.post('/api/operador/zonas', async (req) => {
    await exigirCampo(req);
    const { nombre, lat, lng, precision, zonaPadreId } = (req.body ?? {}) as {
      nombre?: string; lat?: number; lng?: number; precision?: number; zonaPadreId?: number;
    };
    const limpio = nombre?.trim();
    if (!limpio) throw errorHttp(400, 'Falta el nombre del barrio.');
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      throw errorHttp(400, 'Faltan las coordenadas (lat, lng).');
    }
    if (!enBioko(lat, lng)) {
      throw errorHttp(400, 'Esas coordenadas caen fuera de Bioko. ¿Se cogió el GPS de verdad?');
    }
    const precisionM = await exigirGpsFiable(pool, precision);
    try {
      return await enTransaccion(pool, (cliente) => crearZonaEnGps(
        cliente, limpio, lat, lng, precisionM, zonaPadreId ?? null,
      ));
    } catch (error) {
      if (error instanceof Error && /No existe la zona|ya es un barrio\/calle|Ya existe/.test(error.message)) {
        throw errorHttp(400, error.message);
      }
      throw error;
    }
  });

  app.get('/api/operador/referencias', async (req) => {
    await exigirCampo(req);
    const { q, zonaId } = (req.query ?? {}) as { q?: string; zonaId?: string };
    // A diferencia del buscador de los pasajeros, este ve TODO: inactivas
    // incluidas, porque para reactivar algo primero hay que encontrarlo.
    const filas = await pool.query(
      `SELECT r.id, r.nombre, r.lat, r.lng, r.categoria, r.activa,
              r.veces_usada AS usos, r.precision_gps_m AS precision_m,
              z.id AS zona_id, z.nombre AS zona,
              COALESCE((SELECT array_agg(a.alias ORDER BY a.alias)
                        FROM referencia_alias a WHERE a.referencia_id = r.id), '{}') AS alias
       FROM referencia r JOIN zona z ON z.id = r.zona_id
       WHERE ($1::text IS NULL OR r.nombre ILIKE '%' || $1 || '%'
              OR EXISTS (SELECT 1 FROM referencia_alias a
                         WHERE a.referencia_id = r.id AND a.alias ILIKE '%' || $1 || '%'))
         AND ($2::bigint IS NULL OR r.zona_id = $2)
       ORDER BY r.veces_usada DESC, r.nombre
       LIMIT 50`,
      [q?.trim() || null, zonaId ? Number(zonaId) : null],
    );
    return { referencias: filas.rows };
  });

  app.post('/api/operador/referencias', async (req) => {
    await exigirCampo(req);
    const cuerpo = (req.body ?? {}) as {
      zonaId?: number; nombre?: string; lat?: number; lng?: number;
      categoria?: string; precision?: number; sustituir?: boolean;
    };
    if (!cuerpo.zonaId || !cuerpo.nombre?.trim()
      || typeof cuerpo.lat !== 'number' || typeof cuerpo.lng !== 'number') {
      throw errorHttp(400, 'Faltan campos: zonaId, nombre, lat y lng son obligatorios.');
    }
    if (!enBioko(cuerpo.lat, cuerpo.lng)) {
      throw errorHttp(400, 'Esas coordenadas caen fuera de Bioko. ¿Se cogió el GPS de verdad?');
    }
    const categoria = exigirCategoria(cuerpo.categoria);

    // AVISAR ANTES DE MACHACAR (05/10). `guardarReferencia` hace un upsert por
    // (zona, nombre): crear un sitio con un nombre que ya existía en esa zona
    // le cambiaba las coordenadas EN SILENCIO y lo reactivaba. Quien creía
    // estar añadiendo un sitio nuevo estaba moviendo uno viejo, y el único
    // rastro era que el taxi empezaba a ir a otro sitio.
    //
    // Ahora se contesta 409 con lo que ya hay, y sustituir es un acto aparte y
    // declarado. El upsert se queda —es lo correcto cuando la intención SÍ es
    // actualizar, y es de lo que vive el importador del gazetteer.
    const yaHay = await pool.query(
      `SELECT r.id, r.nombre, r.lat, r.lng, r.activa, z.nombre AS zona
       FROM referencia r JOIN zona z ON z.id = r.zona_id
       WHERE r.zona_id = $1 AND lower(r.nombre) = lower($2)`,
      [cuerpo.zonaId, cuerpo.nombre.trim()],
    );
    if ((yaHay.rowCount ?? 0) > 0 && cuerpo.sustituir !== true) {
      const existente = yaHay.rows[0];
      const error = errorHttp(
        409,
        `Ya hay un sitio llamado «${existente.nombre}» en ${existente.zona}.`,
      ) as Error & { statusCode: number; existente?: unknown };
      error.existente = existente;
      throw error;
    }

    const precisionM = await precisionDeSitio(pool, cuerpo.precision);
    const resultado = await enTransaccion(pool, async (cliente) => {
      const r = await guardarReferencia(cliente, {
        zonaId: cuerpo.zonaId!, nombre: cuerpo.nombre!.trim(), lat: cuerpo.lat!, lng: cuerpo.lng!,
      });
      await editarReferencia(cliente, r.referenciaId, { categoria, precisionM });
      return r;
    });
    return resultado;
  });

  app.post('/api/operador/referencias/:id', async (req) => {
    await exigirCampo(req);
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de referencia no válido.');
    const cambios = (req.body ?? {}) as {
      nombre?: string; zonaId?: number; lat?: number; lng?: number;
      activa?: boolean; categoria?: string; precision?: number;
    };
    // Al corregir vale la misma regla que al crear: una categoría inventada
    // llegaba a la base y salía el error del CHECK en crudo.
    if (cambios.categoria !== undefined) exigirCategoria(cambios.categoria);
    if (typeof cambios.lat === 'number' && typeof cambios.lng === 'number'
      && !enBioko(cambios.lat, cambios.lng)) {
      throw errorHttp(400, 'Esas coordenadas caen fuera de Bioko. ¿Se cogió el GPS de verdad?');
    }
    // Mover un sitio reescribe con qué confianza está puesto: si se corrige
    // con el GPS queda su precisión, y si se teclea a mano queda sin
    // verificar. Dejar la precisión vieja pegada a unas coordenadas nuevas
    // sería mentir sobre el dato.
    const { precision, ...resto } = cambios;
    const conPrecision = (typeof cambios.lat === 'number' || typeof cambios.lng === 'number')
      ? { ...resto, precisionM: await precisionDeSitio(pool, precision) }
      : resto;
    try {
      await enTransaccion(pool, (cliente) => editarReferencia(cliente, id, conPrecision));
    } catch (error) {
      if (error instanceof ErrorEntidadInexistente) throw errorHttp(404, error.message);
      throw error;
    }
    return { editada: true };
  });

  app.post('/api/operador/referencias/:id/alias', async (req) => {
    await exigirCampo(req);
    const id = Number((req.params as { id: string }).id);
    const { alias, quitar } = (req.body ?? {}) as { alias?: string; quitar?: boolean };
    if (!Number.isInteger(id)) throw errorHttp(400, 'Id de referencia no válido.');
    if (!alias?.trim()) throw errorHttp(400, 'Falta el alias.');
    try {
      await enTransaccion(pool, (cliente) => (quitar
        ? quitarAlias(cliente, id, alias.trim())
        : anadirAlias(cliente, id, alias.trim())));
    } catch (error) {
      if (error instanceof ErrorEntidadInexistente) throw errorHttp(404, error.message);
      if (error instanceof Error) throw errorHttp(409, error.message);
      throw error;
    }
    return { hecho: true };
  });

  // Lo que se ha tocado últimamente (P25-01). Solo el operador: un agente
  // puede fijar precios, pero quién vigila a los agentes no es un agente.
  app.get('/api/operador/cambios', async (req) => {
    await exigirOperador(req);
    const filas = await pool.query(
      `SELECT ca.id, ca.ambito, ca.clave, ca.valor_anterior, ca.valor_nuevo,
              ca.es_operador, ca.creado_en, c.nombre AS conductor
       FROM cambio_ajuste ca
       LEFT JOIN conductor c ON c.id = ca.conductor_id
       ORDER BY ca.creado_en DESC
       LIMIT 200`,
    );
    return {
      cambios: filas.rows.map((f: {
        id: string; ambito: string; clave: string;
        valor_anterior: string | null; valor_nuevo: string | null;
        es_operador: boolean; creado_en: Date; conductor: string | null;
      }) => ({
        id: Number(f.id),
        ambito: f.ambito,
        clave: f.clave,
        antes: f.valor_anterior,
        ahora: f.valor_nuevo,
        // Quién, en una línea: el nombre del agente, «operador», o «alguien»
        // si el dispositivo ya no existe. Nunca se inventa un nombre.
        quien: f.conductor ?? (f.es_operador ? 'operador' : 'alguien'),
        cuando: f.creado_en,
      })),
    };
  });

  // --- Bandas de precio y parámetros (bloque 6) ------------------------------
  // Desde la migración 066 una banda puede venir de dos sitios: de lo que los
  // pasajeros dicen que pagaron (`muestras` > 0, se recalcula sola) o de la
  // mano del operador (`muestras` = 0). Manda el dato cuando hay bastante
  // —`banda_muestras_minimas`— y el criterio del operador cuando no, que es lo
  // que había desde la 012. El taxista las ve en el broadcast para no aceptar
  // a ciegas (R2), y nunca son una tarifa: el precio se negocia.

  app.get('/api/operador/bandas', async (req) => {
    await exigirCampo(req);
    const filas = await pool.query(
      `SELECT b.id, b.zona_origen_id, b.zona_destino_id, b.p25, b.p50, b.p75,
              b.actualizada_en, zo.nombre AS zona_origen, zd.nombre AS zona_destino
       FROM banda_precio b
       JOIN zona zo ON zo.id = b.zona_origen_id
       JOIN zona zd ON zd.id = b.zona_destino_id
       ORDER BY zo.nombre, zd.nombre`,
    );
    return { bandas: filas.rows };
  });

  app.post('/api/operador/bandas', async (req) => {
    await exigirCampo(req);
    const cuerpo = (req.body ?? {}) as {
      zonaOrigenId?: number; zonaDestinoId?: number;
      p25?: number; p50?: number; p75?: number; borrar?: boolean;
    };
    if (!cuerpo.zonaOrigenId || !cuerpo.zonaDestinoId) {
      throw errorHttp(400, 'Faltan las zonas de origen y destino.');
    }
    const previa = await pool.query(
      `SELECT p25, p50, p75 FROM banda_precio
       WHERE zona_origen_id = $1 AND zona_destino_id = $2`,
      [cuerpo.zonaOrigenId, cuerpo.zonaDestinoId],
    );
    const comoEstaba = previa.rowCount === 0
      ? null
      : `${previa.rows[0].p25}/${previa.rows[0].p50}/${previa.rows[0].p75}`;
    const cual = `${cuerpo.zonaOrigenId}→${cuerpo.zonaDestinoId}`;

    if (cuerpo.borrar) {
      await pool.query(
        `DELETE FROM banda_precio WHERE zona_origen_id = $1 AND zona_destino_id = $2`,
        [cuerpo.zonaOrigenId, cuerpo.zonaDestinoId],
      );
      await apuntarCambio(req, 'banda_precio', cual, comoEstaba, null);
      return { borrada: true };
    }
    const { p25, p50, p75 } = cuerpo;
    if (![p25, p50, p75].every((v) => Number.isInteger(v) && (v as number) >= 0)) {
      throw errorHttp(400, 'p25, p50 y p75 tienen que ser XAF enteros (el dinero es entero).');
    }
    if (!(p25! <= p50! && p50! <= p75!)) {
      throw errorHttp(400, 'La banda tiene que ir ordenada: p25 ≤ p50 ≤ p75.');
    }
    const res = await pool.query(
      `INSERT INTO banda_precio (zona_origen_id, zona_destino_id, p25, p50, p75)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (zona_origen_id, zona_destino_id)
         DO UPDATE SET p25 = EXCLUDED.p25, p50 = EXCLUDED.p50, p75 = EXCLUDED.p75,
                       actualizada_en = now()
       RETURNING id`,
      [cuerpo.zonaOrigenId, cuerpo.zonaDestinoId, p25, p50, p75],
    );
    await apuntarCambio(req, 'banda_precio', cual, comoEstaba, `${p25}/${p50}/${p75}`);
    return { bandaId: res.rows[0].id };
  });

  // Los parámetros del sistema: tiempos de oleada, tarifas, umbrales de
  // alarma… Cambian el comportamiento SIN desplegar, que es exactamente su
  // razón de existir — y también la razón de tratarlos con respeto.
  app.get('/api/operador/parametros', async (req) => {
    await exigirOperador(req);
    const filas = await pool.query(
      'SELECT clave, valor, descripcion FROM parametro ORDER BY clave',
    );
    return { parametros: filas.rows };
  });

  app.post('/api/operador/parametros/:clave', async (req) => {
    await exigirOperador(req);
    const { clave } = req.params as { clave: string };
    const { valor } = (req.body ?? {}) as { valor?: string };
    if (typeof valor !== 'string' || !valor.trim()) {
      throw errorHttp(400, 'Falta el valor.');
    }
    // Solo se actualizan claves que existen: crear parámetros nuevos desde
    // el panel sería inventarse configuración que ningún código lee.
    const antes = await pool.query('SELECT valor FROM parametro WHERE clave = $1', [clave]);
    const res = await pool.query(
      `UPDATE parametro SET valor = $2 WHERE clave = $1 RETURNING clave, valor`,
      [clave, valor.trim()],
    );
    if (res.rowCount === 0) throw errorHttp(404, `No existe el parámetro «${clave}».`);
    // Un parámetro cambia el comportamiento entero sin desplegar: si algún día
    // el reparto se porta raro, «quién cambió qué y cuándo» es la primera
    // pregunta (migración 067).
    await apuntarCambio(
      req, 'parametro', clave, antes.rows[0]?.valor ?? null, res.rows[0].valor,
    );
    return res.rows[0];
  });
}

// Número estable a partir de un texto. Se usa para fabricar un teléfono de
// pruebas a partir del uuid del dispositivo: así el mismo dispositivo siempre
// recupera SU taxi en vez de crear uno nuevo cada vez.
function hashNumerico(texto: string): number {
  let h = 0;
  for (let i = 0; i < texto.length; i += 1) {
    h = Math.imul(31, h) + texto.charCodeAt(i) | 0;
  }
  return h;
}
