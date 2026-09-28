// Los sitios que pone la gente (migración 072).
//
// El catálogo era una lista cerrada: la rellenaban el importador de OSM y el
// operador, y si tu destino no estaba, no podías pedir el taxi. En una ciudad
// sin direcciones eso deja fuera lo que todo el mundo usa —«la calle del Rey
// Boncoro», «la avenida detrás del mercado», la casa de alguien— y no hay
// lista que pueda preverlo.
//
// Ahora quien no encuentra su sitio lo escribe. Lo que hace este módulo es lo
// difícil de eso: NO CREAR EL MISMO SITIO CUATRO VECES. Sin esto, en un mes el
// buscador tiene «Mercado Semu», «mercado semú», «Mercado de SEMU» y «semu
// mercado» apuntando a cuatro puntos a cincuenta metros, y deja de servir.
//
// La regla: mismo nombre normalizado y a menos de X metros, es el mismo sitio.
// Ni más listo ni menos: comparar por parecido difuso aquí juntaría «Calle 3»
// con «Calle 8», y eso es peor que un duplicado.

import type pg from 'pg';
import { leerParametroEntero } from './parametros.js';
import { distanciaRectaM } from './paradas.js';

// Para comparar nombres: sin tildes, sin mayúsculas, sin puntuación y con los
// espacios colapsados. «Avenida  de la  Independencia» y «avenida de la
// independencia.» son el mismo nombre escrito por dos personas con prisa.
export function normalizar(nombre: string): string {
  return nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Palabras que no distinguen un sitio de otro en Malabo: si dos nombres solo
// se diferencian en esto, son el mismo. Se quitan SOLO para comparar; el
// nombre que se guarda es el que escribió la persona, con sus palabras.
const RELLENO = new Set(['calle', 'avenida', 'av', 'c', 'barrio', 'de', 'del', 'la', 'el', 'los', 'las']);

export function clave(nombre: string): string {
  return normalizar(nombre)
    .split(' ')
    .filter((palabra) => !RELLENO.has(palabra))
    .join(' ');
}

export interface SitioPropuesto {
  referenciaId: number;
  // true si se creó ahora; false si se reutilizó uno que ya existía, que es el
  // caso bueno y el que hay que poder contar.
  creada: boolean;
  nombre: string;
}

// Crea el sitio, o devuelve el que ya era ese sitio.
//
// `dispositivoId` queda guardado: sin saber quién propone no se puede ni
// agradecer ni limpiar lo que uno solo llenó de nombres inventados.
export async function proponerSitio(
  cliente: pg.ClientBase,
  datos: {
    nombre: string;
    lat: number;
    lng: number;
    zonaId: number;
    dispositivoId: number;
    categoria?: string;
  },
): Promise<SitioPropuesto> {
  const nombre = datos.nombre.trim().replace(/\s+/g, ' ');
  if (nombre.length < 3) {
    throw new Error(`Nombre demasiado corto: «${datos.nombre}». Escribe al menos tres letras.`);
  }
  if (nombre.length > 80) {
    throw new Error('Ese nombre es demasiado largo para que quepa en la pantalla de un taxista.');
  }

  const cerca = await leerParametroEntero(cliente, 'sitio_propuesto_mismo_m');

  // Los candidatos: sitios de la zona y de las de al lado, por si el punto cae
  // justo en el borde. Se comparan en memoria porque son decenas, no miles, y
  // la comparación es de texto normalizado: eso no se hace en SQL sin
  // arrastrar una extensión más.
  const posibles = await cliente.query(
    `SELECT r.id, r.nombre, r.lat, r.lng
     FROM referencia r
     WHERE r.activa
       AND (r.zona_id = $1 OR r.zona_id IN (
              SELECT zona_adyacente_id FROM zona_adyacencia WHERE zona_id = $1))`,
    [datos.zonaId],
  );
  const suya = clave(nombre);
  for (const fila of posibles.rows) {
    if (clave(fila.nombre) !== suya) continue;
    const metros = distanciaRectaM(
      { lat: datos.lat, lng: datos.lng },
      { lat: Number(fila.lat), lng: Number(fila.lng) },
    );
    if (metros <= cerca) {
      return { referenciaId: Number(fila.id), creada: false, nombre: fila.nombre };
    }
  }

  // El UNIQUE (zona_id, nombre) puede saltar igual si dos personas escriben lo
  // mismo a la vez: entonces gana quien llegó primero y se devuelve el suyo.
  const insercion = await cliente.query(
    `INSERT INTO referencia
       (zona_id, nombre, lat, lng, categoria, propuesta_en, propuesta_por_dispositivo_id)
     VALUES ($1, $2, $3, $4, $5, now(), $6)
     ON CONFLICT (zona_id, nombre) DO UPDATE SET activa = true
     RETURNING id, nombre, (xmax = 0) AS creada`,
    [datos.zonaId, nombre, datos.lat, datos.lng, datos.categoria ?? 'otro', datos.dispositivoId],
  );
  return {
    referenciaId: Number(insercion.rows[0].id),
    creada: insercion.rows[0].creada,
    nombre: insercion.rows[0].nombre,
  };
}

// Un sitio propuesto se publica solo cuando la gente lo usa.
//
// Se llama al pedir un taxi: si el sitio propuesto ya se ha pedido las veces
// que dice el parámetro, deja de estar en cuarentena. Que tres personas
// distintas pidan un taxi a ese nombre es la única prueba que hace falta de
// que el sitio existe.
export async function publicarSiSeUsa(
  cliente: pg.ClientBase,
  referenciaId: number,
): Promise<boolean> {
  const minimo = await leerParametroEntero(cliente, 'sitio_propuesto_usos_para_publicar');
  const res = await cliente.query(
    `UPDATE referencia
     SET aprobada_en = now()
     WHERE id = $1 AND propuesta_en IS NOT NULL AND aprobada_en IS NULL
       AND veces_usada >= $2
     RETURNING id`,
    [referenciaId, minimo],
  );
  return (res.rowCount ?? 0) > 0;
}
