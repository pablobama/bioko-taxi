// La radio del gremio (migración 075): uno habla, los demás escuchan.
//
// Medio dúplex, como una radio de verdad. Se pide la palabra, se habla hasta
// diez segundos, se suelta, y el mensaje llega a los taxistas conectados. No es
// una llamada y no intenta ser directo: se oye al soltar, uno o dos segundos
// después. Eso es lo que permite que funcione con la red de Malabo, porque quien
// habla sube UNA copia y no una por oyente.
//
// El turno no lo guarda este código, lo guarda la clave primaria de
// `turno_palabra`: una fila por canal. Dos taxistas que aprietan en el mismo
// milisegundo no pueden ganar los dos porque no caben dos filas. Aquí no hay
// ningún candado que se pueda olvidar de soltar.

import type pg from 'pg';
import { leerParametroEntero } from './parametros.js';

// Pool o cliente en transacción, como en el resto del dominio: nada de esto
// necesita participar en la transacción de quien llama.
type Lector = pg.Pool | pg.ClientBase;

// EL CANAL ES UN DATO Y NO UNA CONSTANTE, Y ESTE ES EL ÚNICO SITIO DONDE SE
// DECIDE. Hoy devuelve siempre lo mismo: con cuarenta taxistas en toda la isla,
// partir el canal por barrios da canales de una persona, y una radio donde nadie
// contesta se muere en una semana.
//
// El día que el canal se llene —y eso se sabe mirando `radio_uso`, no
// opinando— esta función pasa a devolver el distrito urbano del taxista
// (`zona.distrito_urbano`, los siete que el operador validó sobre el terreno en
// la migración 040) y no hay que tocar nada más: el turno ya se bloquea por
// canal y los mensajes ya se guardan con el suyo.
//
// Es `async` y recibe el conductor a propósito, aunque hoy no use ninguno de los
// dos: así el día que tenga que consultar la zona no cambia ni una firma de las
// que la llaman.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function canalDe(_cliente: Lector, _conductorId: number): Promise<string> {
  return CANAL_UNICO;
}

// «La isla» y no «la provincia»: Bioko Norte es Malabo y Baney, pero Luba y
// Riaba están en Bioko Sur, y por provincia habría dos canales con el del sur
// vacío. El gremio es el de la isla.
export const CANAL_UNICO = 'isla';

export interface Limites {
  segundosMax: number;
  margenSeg: number;
  bytesMax: number;
  mensajesPorMinuto: number;
  guardadoHoras: number;
}

export async function limitesDeLaRadio(cliente: Lector): Promise<Limites> {
  return {
    segundosMax: await leerParametroEntero(cliente, 'radio_segundos_max'),
    margenSeg: await leerParametroEntero(cliente, 'radio_turno_margen_seg'),
    bytesMax: await leerParametroEntero(cliente, 'radio_bytes_max'),
    mensajesPorMinuto: await leerParametroEntero(cliente, 'radio_mensajes_por_minuto'),
    guardadoHoras: await leerParametroEntero(cliente, 'radio_guardado_horas'),
  };
}

export async function radioEncendida(cliente: Lector): Promise<boolean> {
  return (await leerParametroEntero(cliente, 'radio_activada')) === 1;
}

// Por qué no se puede hablar. Cada motivo pide algo distinto de quien aprieta
// —esperar un momento, esperar un rato largo, o nada— y un único «no» los
// confundiría en el mismo silencio, que es justo lo que hace que la gente
// abandone una radio.
export type Palabra =
  | { dada: true; caducaEn: Date; segundosMax: number }
  | { dada: false; motivo: 'apagada' }
  | { dada: false; motivo: 'ocupado'; habla: string; quedanSeg: number }
  | { dada: false; motivo: 'demasiados'; esperaSeg: number };

// Pide la palabra en el canal. Es lo PRIMERO que sale del teléfono al apretar el
// botón, antes de que exista un solo byte de audio: son unos pocos bytes y a
// cambio quien aprieta sabe en el acto si puede hablar o si le va a hablar
// encima a otro.
export async function pedirLaPalabra(
  cliente: Lector,
  { canal, conductorId, dispositivoId }:
    { canal: string; conductorId: number; dispositivoId: number },
  ahora = new Date(),
): Promise<Palabra> {
  if (!await radioEncendida(cliente)) return { dada: false, motivo: 'apagada' };
  const limites = await limitesDeLaRadio(cliente);

  // El tope por taxista va antes del turno, y no después: el tope del canal
  // frena al gremio pero no frena al que se engancha al botón él solo.
  const seguidos = await cliente.query(
    `SELECT count(*)::int AS n,
            extract(epoch from (min(creado_en) + interval '1 minute' - $3::timestamptz)) AS espera
     FROM mensaje_voz
     WHERE conductor_id = $1 AND canal = $2
       AND creado_en > $3::timestamptz - interval '1 minute'`,
    [conductorId, canal, ahora],
  );
  if (seguidos.rows[0].n >= limites.mensajesPorMinuto) {
    return {
      dada: false,
      motivo: 'demasiados',
      esperaSeg: Math.max(1, Math.ceil(Number(seguidos.rows[0].espera ?? 1))),
    };
  }

  const caducaEn = new Date(ahora.getTime() + (limites.segundosMax + limites.margenSeg) * 1000);

  // Aquí está todo el mecanismo, y cabe en una sentencia. Si no hay fila, se
  // coge el turno; si hay una y ya caducó, se le quita; y si hay una viva, la
  // condición falla, no se actualiza nada y no vuelve ninguna fila. Atómico,
  // sin leer antes de escribir y sin carrera posible.
  const dado = await cliente.query(
    `INSERT INTO turno_palabra (canal, conductor_id, dispositivo_id, pedido_en, caduca_en)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (canal) DO UPDATE
       SET conductor_id = excluded.conductor_id,
           dispositivo_id = excluded.dispositivo_id,
           pedido_en = excluded.pedido_en,
           caduca_en = excluded.caduca_en
       WHERE turno_palabra.caduca_en <= excluded.pedido_en
     RETURNING caduca_en`,
    [canal, conductorId, dispositivoId, ahora, caducaEn],
  );

  if (dado.rowCount === 0) {
    // Ocupado. Se dice QUIÉN habla y cuánto le queda: en una radio eso es la
    // diferencia entre esperar tranquilo y volver a apretar cinco veces.
    const quien = await cliente.query(
      `SELECT c.nombre, extract(epoch from (t.caduca_en - $2::timestamptz)) AS quedan
       FROM turno_palabra t JOIN conductor c ON c.id = t.conductor_id
       WHERE t.canal = $1`,
      [canal, ahora],
    );
    await apuntarUso(cliente, canal, ahora, 'ocupado');
    return {
      dada: false,
      motivo: 'ocupado',
      habla: quien.rows[0]?.nombre ?? 'otro taxista',
      quedanSeg: Math.max(0, Math.ceil(Number(quien.rows[0]?.quedan ?? 0))),
    };
  }

  await apuntarUso(cliente, canal, ahora, 'dado');
  return { dada: true, caducaEn: dado.rows[0].caduca_en, segundosMax: limites.segundosMax };
}

// Suelta el turno sin mandar nada: el que aprieta y se arrepiente, o el que
// habla menos de lo que vale un mensaje. No se borra la fila —sirve de registro
// del último turno, que es lo que permite aceptar un audio que sube lento— solo
// se marca vencida para que el canal quede libre ya.
export async function soltarLaPalabra(
  cliente: Lector,
  { canal, dispositivoId }: { canal: string; dispositivoId: number },
  ahora = new Date(),
): Promise<void> {
  await cliente.query(
    `UPDATE turno_palabra SET caduca_en = $3
     WHERE canal = $1 AND dispositivo_id = $2 AND caduca_en > $3`,
    [canal, dispositivoId, ahora],
  );
}

// Quién tiene la palabra ahora mismo, para pintarlo en la pantalla de los demás.
export async function quienHabla(
  cliente: Lector,
  canal: string,
  ahora = new Date(),
): Promise<{ conductorId: number; nombre: string } | null> {
  const res = await cliente.query(
    `SELECT t.conductor_id, c.nombre FROM turno_palabra t
     JOIN conductor c ON c.id = t.conductor_id
     WHERE t.canal = $1 AND t.caduca_en > $2`,
    [canal, ahora],
  );
  if (res.rowCount === 0) return null;
  return { conductorId: Number(res.rows[0].conductor_id), nombre: res.rows[0].nombre };
}

export type Guardado =
  | { guardado: true; mensajeId: number; oyentes: number[] }
  | { guardado: false; motivo: 'apagada' | 'sin_turno' | 'demasiado_grande' | 'demasiado_largo' };

// Guarda el mensaje y dice a qué teléfonos hay que avisar.
//
// NO exige que el turno siga vivo, y es a propósito. Hablar diez segundos y
// subir 25 KB con mala cobertura puede pasarse del plazo, y tirar a la basura
// diez segundos que alguien ya dijo es el peor resultado posible. Basta con que
// el último turno del canal fuera suyo y reciente. Lo que el turno garantiza
// —que no se le dio la palabra a otro mientras él hablaba— se cumple igual.
export async function guardarMensaje(
  cliente: Lector,
  { canal, conductorId, dispositivoId, audio, tipoMedio, duracionMs }: {
    canal: string; conductorId: number; dispositivoId: number;
    audio: Buffer; tipoMedio: string; duracionMs: number;
  },
  ahora = new Date(),
): Promise<Guardado> {
  if (!await radioEncendida(cliente)) return { guardado: false, motivo: 'apagada' };
  const limites = await limitesDeLaRadio(cliente);

  if (audio.length > limites.bytesMax) return { guardado: false, motivo: 'demasiado_grande' };
  // El tope de duración se comprueba aquí y no solo en la pantalla: el teléfono
  // dice cuánto duró, y un teléfono es de quien lo tiene.
  if (duracionMs > (limites.segundosMax + 1) * 1000) {
    return { guardado: false, motivo: 'demasiado_largo' };
  }

  const antiguedadMaxSeg = limites.segundosMax + limites.margenSeg * 2;
  const suyo = await cliente.query(
    `SELECT 1 FROM turno_palabra
     WHERE canal = $1 AND dispositivo_id = $2
       AND pedido_en > $3::timestamptz - make_interval(secs => $4)`,
    [canal, dispositivoId, ahora, antiguedadMaxSeg],
  );
  if (suyo.rowCount === 0) return { guardado: false, motivo: 'sin_turno' };

  const insertado = await cliente.query(
    `INSERT INTO mensaje_voz (canal, conductor_id, audio, tipo_medio, duracion_ms, creado_en)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [canal, conductorId, audio, tipoMedio, duracionMs, ahora],
  );

  // El canal queda libre en el mismo momento en que el mensaje existe: el que
  // habló ya terminó, y esperar a que caduque el plazo serían cinco segundos de
  // radio muerta después de cada frase.
  await cliente.query(
    `UPDATE turno_palabra SET caduca_en = $3 WHERE canal = $1 AND dispositivo_id = $2`,
    [canal, dispositivoId, ahora],
  );

  return {
    guardado: true,
    mensajeId: Number(insertado.rows[0].id),
    oyentes: await oyentesDe(cliente, canal, conductorId),
  };
}

// Los teléfonos a los que hay que avisar: taxistas conectados del canal, menos
// el que acaba de hablar.
//
// Incluye a los que llevan pasajero (estado OCUPADO). Es lo que hace una radio
// —el que está trabajando es justo el que tiene algo que contar y algo que
// oír— pero tiene una consecuencia que conviene tener presente: lo que se dice
// por la radio lo escucha un cliente que va en el asiento de atrás.
export async function oyentesDe(
  cliente: Lector,
  canal: string,
  exceptoConductorId: number | null = null,
): Promise<number[]> {
  // El canal no filtra todavía porque hoy es uno solo; cuando `canalDe` mire la
  // zona, aquí entra el mismo criterio. Se pasa igualmente para que la firma no
  // cambie y para que no se olvide.
  void canal;
  const res = await cliente.query(
    `SELECT DISTINCT ON (d.conductor_id) d.id
     FROM dispositivo d
     JOIN presencia p ON p.conductor_id = d.conductor_id
     WHERE d.tipo = 'conductor'
       AND p.estado <> 'DESCONECTADO'
       AND ($1::bigint IS NULL OR d.conductor_id <> $1)
     ORDER BY d.conductor_id, COALESCE(d.ultimo_heartbeat, d.creado_en) DESC`,
    [exceptoConductorId],
  );
  return res.rows.map((f) => Number(f.id));
}

export interface MensajeListado {
  id: number;
  conductorId: number;
  nombre: string;
  matricula: string | null;
  duracionMs: number;
  bytes: number;
  creadoEn: Date;
}

// Los últimos mensajes del canal, sin el audio: es lo que pinta la lista y el
// botón de volver a oír. El audio se baja uno a uno y solo si se pulsa, que es
// la diferencia entre gastar 25 KB y gastar 250.
export async function ultimosMensajes(
  cliente: Lector,
  canal: string,
  limite = 20,
): Promise<MensajeListado[]> {
  const res = await cliente.query(
    `SELECT m.id, m.conductor_id, c.nombre, m.duracion_ms, m.creado_en,
            octet_length(m.audio) AS bytes,
            (SELECT v.matricula FROM vehiculo v WHERE v.conductor_id = m.conductor_id
             ORDER BY v.id LIMIT 1) AS matricula
     FROM mensaje_voz m JOIN conductor c ON c.id = m.conductor_id
     WHERE m.canal = $1
     ORDER BY m.creado_en DESC
     LIMIT $2`,
    [canal, limite],
  );
  return res.rows.map((f) => ({
    id: Number(f.id),
    conductorId: Number(f.conductor_id),
    nombre: f.nombre,
    matricula: f.matricula ?? null,
    duracionMs: f.duracion_ms,
    bytes: Number(f.bytes),
    creadoEn: f.creado_en,
  }));
}

export async function audioDeMensaje(
  cliente: Lector,
  mensajeId: number,
  canal: string,
): Promise<{ audio: Buffer; tipoMedio: string } | null> {
  const res = await cliente.query(
    'SELECT audio, tipo_medio FROM mensaje_voz WHERE id = $1 AND canal = $2',
    [mensajeId, canal],
  );
  if (res.rowCount === 0) return null;
  return { audio: res.rows[0].audio, tipoMedio: res.rows[0].tipo_medio };
}

// El borrado no es una optimización de espacio, es la protección. Mientras el
// audio existe, existe un archivo de lo que hablan los taxistas entre ellos que
// alguien puede pedir; dos horas después no hay nada que pedir. Se llama desde
// el mismo latido que caduca los viajes colgados.
export async function purgarMensajes(
  cliente: Lector,
  ahora = new Date(),
): Promise<number> {
  const horas = await leerParametroEntero(cliente, 'radio_guardado_horas');
  const res = await cliente.query(
    `DELETE FROM mensaje_voz
     WHERE creado_en < $1::timestamptz - make_interval(hours => $2)`,
    [ahora, horas],
  );
  return res.rowCount ?? 0;
}

// Los dos contadores que deciden si el canal hay que partirlo. `demasiados` —el
// tope por taxista— NO cuenta como ocupado a propósito: eso no es el canal
// lleno, es uno pasándose, y meterlo aquí ensuciaría justo la medida que tiene
// que responder «¿se llena?».
async function apuntarUso(
  cliente: Lector,
  canal: string,
  ahora: Date,
  que: 'dado' | 'ocupado',
): Promise<void> {
  await cliente.query(
    `INSERT INTO radio_uso (canal, dia, turnos_dados, turnos_ocupados)
     VALUES ($1, $2::date, $3, $4)
     ON CONFLICT (canal, dia) DO UPDATE
       SET turnos_dados = radio_uso.turnos_dados + excluded.turnos_dados,
           turnos_ocupados = radio_uso.turnos_ocupados + excluded.turnos_ocupados`,
    [canal, ahora, que === 'dado' ? 1 : 0, que === 'ocupado' ? 1 : 0],
  );
}
