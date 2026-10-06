// Volver a entrar escribiendo solo el teléfono (migración 078).
//
// Lo que resuelve, en una frase: antes de pedirle a alguien todos sus datos,
// preguntarle el número y mirar si ya está. Casi siempre lo está —reinstalar la
// aplicación, cambiar de móvil o borrar los datos del navegador no borra una
// cuenta— y rellenar el formulario entero para una ficha que existe es, además
// de un fastidio, la forma de pisarla con lo que uno recuerde ese día.
//
// AQUÍ SE ENTREGA UNA CUENTA, y es lo que hay que tener delante leyendo este
// fichero. La ficha de un taxista lleva su monedero, su suscripción y su
// reputación; la de un pasajero, sus avisos y su bloqueo. Que se entreguen con
// nueve dígitos que casi todos empiezan igual sería regalarlas al primero que
// acierte. Por eso `devolver*` solo se llama DESPUÉS de un código por SMS
// comprobado, y las funciones de aquí no comprueban el código: lo hace la ruta.
// Este párrafo está para que nadie las llame desde otro sitio creyéndolas
// inofensivas.
//
// Lo que NO viaja con el número, decidido ya en la migración 024 y aquí se
// respeta: el historial de viajes del pasajero se queda en el dispositivo
// viejo. Si viajara, quien conozca tu teléfono vería a dónde sueles ir con solo
// teclearlo. Lo que SÍ viaja son los avisos y el bloqueo, porque si no, borrar
// los datos del navegador sería la puerta de atrás para empezar limpio.

import type pg from 'pg';

type Lector = pg.Pool | pg.ClientBase;

export type Paso = 'buscar' | 'codigo' | 'reclamar';

export interface Hallazgo {
  // Puede ser las dos cosas a la vez: en producción hay números dados de alta
  // como taxista y como pasajero, y son cuentas distintas.
  conductor: boolean;
  cliente: boolean;
}

// ¿Existe algo con este número? Deliberadamente devuelve SOLO dos booleanos:
// ni el nombre ni nada más. Quien esté probando números no debe sacar de aquí a
// quién pertenecen; el nombre se devuelve al acertar el código, que es cuando ya
// se ha demostrado ser el dueño de la línea.
export async function buscarPorTelefono(
  cliente: Lector,
  telefono: string,
): Promise<Hallazgo> {
  const res = await cliente.query(
    `SELECT
       EXISTS (SELECT 1 FROM conductor WHERE telefono = $1) AS conductor,
       EXISTS (
         SELECT 1 FROM perfil_cliente
         WHERE telefono = $1 AND telefono_vigente
       ) AS cliente`,
    [telefono],
  );
  return {
    conductor: res.rows[0].conductor === true,
    cliente: res.rows[0].cliente === true,
  };
}

// --- Contadores contra quien prueba --------------------------------------

export async function apuntarIntento(
  cliente: Lector,
  uuid: string,
  telefono: string,
  paso: Paso,
  acertado: boolean,
  // Por dónde fue el código (migración 082). Solo tiene sentido en el paso
  // 'codigo'; en los demás se queda en 'sms' y no lo mira nadie.
  canal: 'sms' | 'llamada' = 'sms',
): Promise<void> {
  await cliente.query(
    `INSERT INTO intento_cuenta (uuid_dispositivo, telefono, paso, acertado, canal)
     VALUES ($1, $2, $3, $4, $5)`,
    [uuid, telefono, paso, acertado, canal],
  );
}

// Cuántos números DISTINTOS ha preguntado este aparato en la última hora. Se
// cuentan números y no consultas a propósito: equivocarse tres veces
// escribiendo el propio número es normal y no debería gastar el cupo, mientras
// que preguntar por tres números distintos ya no es un error de dedo.
export async function numerosPreguntados(
  cliente: Lector,
  uuid: string,
): Promise<number> {
  const res = await cliente.query(
    `SELECT count(DISTINCT telefono)::int AS cuantos
     FROM intento_cuenta
     WHERE uuid_dispositivo = $1 AND paso = 'buscar'
       AND momento > now() - interval '1 hour'`,
    [uuid],
  );
  return Number(res.rows[0].cuantos);
}

// Cuántos SMS ha hecho mandar este aparato en la última hora, a números
// distintos. El cooldown de abajo protege a UN número de recibir dos mensajes
// seguidos, pero no impide que alguien que ya conoce cincuenta números
// registrados dispare cincuenta mensajes —y cada uno cuesta dinero—. Esto sí.
export async function codigosPedidos(
  cliente: Lector,
  uuid: string,
): Promise<number> {
  const res = await cliente.query(
    `SELECT count(DISTINCT telefono)::int AS cuantos
     FROM intento_cuenta
     WHERE uuid_dispositivo = $1 AND paso = 'codigo'
       AND momento > now() - interval '1 hour'`,
    [uuid],
  );
  return Number(res.rows[0].cuantos);
}

// Códigos fallados contra este número en la última hora, VENGAN DE DONDE
// VENGAN. Se cuenta por número y no por aparato porque si no, el tope no sirve
// para nada: quien quiera probar códigos solo tiene que cambiar de uuid, que es
// borrar los datos del navegador. El precio es que alguien puede dejarse la
// propia recuperación cerrada una hora fallando cinco veces, y es un precio que
// se paga: una hora de espera frente a entregar la cuenta de otro.
export async function codigosFallados(
  cliente: Lector,
  telefono: string,
): Promise<number> {
  const res = await cliente.query(
    `SELECT count(*)::int AS cuantos
     FROM intento_cuenta
     WHERE telefono = $1 AND paso = 'reclamar' AND NOT acertado
       AND momento > now() - interval '1 hour'`,
    [telefono],
  );
  return Number(res.rows[0].cuantos);
}

// Cuándo se mandó el último SMS a este número, para el cooldown. Por número y
// no por aparato: lo que se protege es el teléfono de quien recibe los
// mensajes, que puede no tener nada que ver con quien los está pidiendo.
// Por canal (migración 082): el freno entre códigos protege el coste de CADA
// canal, y el SMS que no llega no puede bloquear la llamada que lo salva —la
// salida de emergencia estaría detrás de la misma puerta atascada.
export async function ultimoCodigoEnviado(
  cliente: Lector,
  telefono: string,
  canal: 'sms' | 'llamada' = 'sms',
): Promise<Date | null> {
  const res = await cliente.query(
    `SELECT max(momento) AS cuando
     FROM intento_cuenta
     WHERE telefono = $1 AND paso = 'codigo' AND acertado AND canal = $2`,
    [telefono, canal],
  );
  const cuando = res.rows[0]?.cuando;
  return cuando ? new Date(cuando) : null;
}

// Los intentos no son historia que haya que guardar: son un contador con una
// ventana de una hora. A las 24 se borran, que deja margen de sobra para que el
// operador vea un episodio raro del día anterior.
export async function purgarIntentos(cliente: Lector): Promise<number> {
  const res = await cliente.query(
    "DELETE FROM intento_cuenta WHERE momento < now() - interval '24 hours'",
  );
  return res.rowCount ?? 0;
}

// --- Entregar la cuenta ---------------------------------------------------
//
// LAS DOS FUNCIONES DE ABAJO SOLO SE LLAMAN CON UN CÓDIGO YA COMPROBADO.

export class CuentaNoEntregable extends Error {
  constructor(readonly codigoHttp: number, mensaje: string) {
    super(mensaje);
  }
}

export interface CuentaDevuelta {
  rol: 'conductor' | 'cliente';
  nombre: string | null;
}

// El taxista vuelve. Su ficha no se toca —nombre, vehículo, monedero y
// reputación se quedan como estaban—: lo único que cambia es qué aparato es
// suyo. Es exactamente lo contrario de lo que hacía el formulario de alta, que
// sobrescribía la ficha con lo que se tecleara.
export async function devolverConductor(
  cliente: pg.ClientBase,
  uuid: string,
  telefono: string,
): Promise<CuentaDevuelta> {
  const conductor = await cliente.query(
    'SELECT id, nombre, estado_verificacion FROM conductor WHERE telefono = $1',
    [telefono],
  );
  if (conductor.rowCount === 0) {
    throw new CuentaNoEntregable(404, 'Ese teléfono no está dado de alta como taxista.');
  }
  const fila = conductor.rows[0];
  if (fila.estado_verificacion !== 'verificado') {
    // Suspendido o bloqueado lo decide el operador, y volver a entrar desde
    // otro teléfono no puede servir para saltárselo.
    throw new CuentaNoEntregable(
      403,
      `Tu alta está en estado «${fila.estado_verificacion}». Habla con el operador.`,
    );
  }
  const conductorId: number = fila.id;

  const existente = await cliente.query(
    'SELECT tipo, conductor_id FROM dispositivo WHERE uuid_persistente = $1 FOR UPDATE',
    [uuid],
  );
  if ((existente.rowCount ?? 0) > 0) {
    const d = existente.rows[0];
    if (d.tipo === 'cliente') {
      throw new CuentaNoEntregable(
        409,
        'Este teléfono ya se usa como pasajero. Habla con el operador para cambiarlo.',
      );
    }
    if (d.conductor_id !== null && Number(d.conductor_id) !== conductorId) {
      throw new CuentaNoEntregable(
        409,
        'Este teléfono ya está registrado con otra identidad de taxista. Habla con el operador.',
      );
    }
  }

  await cliente.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, conductor_id, ultimo_heartbeat)
     VALUES ($1, 'conductor', $2, now())
     ON CONFLICT (uuid_persistente) DO UPDATE
       SET tipo = 'conductor', conductor_id = EXCLUDED.conductor_id,
           ultimo_heartbeat = now()`,
    [uuid, conductorId],
  );
  // El código acaba de llegar a ese número, así que el teléfono está
  // verificado. Con COALESCE para no perder la fecha original: quien verificó en
  // julio lleva verificado desde julio, no desde hoy.
  await cliente.query(
    `UPDATE conductor SET telefono_verificado_en = COALESCE(telefono_verificado_en, now())
     WHERE id = $1`,
    [conductorId],
  );
  // Existen desde el alta; se crean si faltan, como hace el registro de
  // siempre. Un monedero que falte deja al taxista sin poder recargar.
  await cliente.query(
    'INSERT INTO monedero (conductor_id) VALUES ($1) ON CONFLICT (conductor_id) DO NOTHING',
    [conductorId],
  );
  await cliente.query(
    `INSERT INTO presencia (conductor_id, estado) VALUES ($1, 'DESCONECTADO')
     ON CONFLICT (conductor_id) DO NOTHING`,
    [conductorId],
  );
  return { rol: 'conductor', nombre: fila.nombre };
}

// El pasajero vuelve. Aquí sí hay que COPIAR, porque `perfil_cliente` es por
// dispositivo: el perfil nuevo nace con los datos de contacto que la persona ya
// había declarado —que es lo que significa «no me los vuelvas a pedir»— y el
// número pasa a estar vigente aquí.
export async function devolverCliente(
  cliente: pg.ClientBase,
  uuid: string,
  telefono: string,
): Promise<CuentaDevuelta> {
  const existente = await cliente.query(
    'SELECT id, tipo FROM dispositivo WHERE uuid_persistente = $1 FOR UPDATE',
    [uuid],
  );
  if ((existente.rowCount ?? 0) > 0 && existente.rows[0].tipo === 'conductor') {
    throw new CuentaNoEntregable(
      409,
      'Este teléfono ya se usa como taxista. Habla con el operador para cambiarlo.',
    );
  }
  const dispositivo = await cliente.query(
    `INSERT INTO dispositivo (uuid_persistente, tipo, ultimo_heartbeat)
     VALUES ($1, 'cliente', now())
     ON CONFLICT (uuid_persistente) DO UPDATE SET ultimo_heartbeat = now()
     RETURNING id`,
    [uuid],
  );
  const dispositivoId = Number(dispositivo.rows[0].id);

  // El perfil que tiene el número vigente, que es el que se viene a recuperar.
  const previo = await cliente.query(
    `SELECT pc.dispositivo_id, pc.correo, pc.nombre, pc.edad, pc.genero,
            d.strikes, d.bloqueado_en
     FROM perfil_cliente pc JOIN dispositivo d ON d.id = pc.dispositivo_id
     WHERE pc.telefono = $1 AND pc.telefono_vigente
     FOR UPDATE OF pc`,
    [telefono],
  );
  if (previo.rowCount === 0) {
    throw new CuentaNoEntregable(404, 'Ese teléfono no está dado de alta como pasajero.');
  }
  const p = previo.rows[0];

  if (Number(p.dispositivo_id) !== dispositivoId) {
    // Un número está vigente en un aparato y solo en uno: lo dice el índice
    // `perfil_cliente_telefono_vigente` (migración 024), así que el anterior
    // tiene que dejar de tenerlo ANTES de insertar o el INSERT choca.
    await cliente.query(
      'UPDATE perfil_cliente SET telefono_vigente = false WHERE dispositivo_id = $1',
      [p.dispositivo_id],
    );
    // Los avisos y el bloqueo siguen a la persona. Se toma el máximo para que
    // recuperar la cuenta no sirva para rebajarse los avisos.
    await cliente.query(
      `UPDATE dispositivo
       SET strikes = GREATEST(strikes, $2), bloqueado_en = COALESCE(bloqueado_en, $3)
       WHERE id = $1`,
      [dispositivoId, p.strikes, p.bloqueado_en],
    );
  }

  await cliente.query(
    `INSERT INTO perfil_cliente
       (dispositivo_id, telefono, correo, nombre, edad, genero,
        telefono_vigente, telefono_verificado_en)
     VALUES ($1, $2, $3, $4, $5, $6, true, now())
     ON CONFLICT (dispositivo_id) DO UPDATE
       SET telefono = EXCLUDED.telefono,
           correo = COALESCE(EXCLUDED.correo, perfil_cliente.correo),
           nombre = COALESCE(EXCLUDED.nombre, perfil_cliente.nombre),
           edad = COALESCE(EXCLUDED.edad, perfil_cliente.edad),
           genero = COALESCE(EXCLUDED.genero, perfil_cliente.genero),
           telefono_vigente = true,
           telefono_verificado_en = now(),
           actualizado_en = now()`,
    [dispositivoId, telefono, p.correo, p.nombre, p.edad, p.genero],
  );
  return { rol: 'cliente', nombre: p.nombre };
}
