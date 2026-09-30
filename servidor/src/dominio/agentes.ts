// Quién puede hacer trabajo de campo, en UN solo sitio (30/09).
//
// La regla estaba escrita dos veces —una al preguntar «quién eres», otra al
// dejar entrar a las herramientas del mapa— y se separaron, que es lo que pasa
// siempre con las reglas duplicadas: al arreglar la primera, la persona veía
// aparecer el botón y al pulsarlo se llevaba un «este dispositivo no puede
// hacer trabajo de campo». Aquí solo hay una.
//
// EL PAPEL ES DE LA PERSONA, NO DEL APARATO. `perfil_cliente` va por
// dispositivo, y una persona acumula un perfil por cada navegador,
// reinstalación o borrado de datos: en producción, un número tenía ocho
// perfiles, tres marcados como agente y el que usaba ese día sin marcar. Así
// que se hereda por el TELÉFONO VERIFICADO, que es lo único que identifica a
// una persona aquí (migración 024).
//
// Sin verificar solo cuenta el dispositivo señalado: escribir el número de otro
// no puede repartir permisos.

import type pg from 'pg';

type Lector = pg.Pool | pg.ClientBase;

export async function esAgenteDeCampo(
  cliente: Lector,
  dispositivoId: number,
): Promise<boolean> {
  const res = await cliente.query(
    `SELECT EXISTS (
       -- Taxista agente (migración 025): va por su ficha, que ya es de la
       -- persona y no del teléfono.
       SELECT 1 FROM dispositivo d
       JOIN conductor c ON c.id = d.conductor_id
       WHERE d.id = $1 AND c.es_agente
     ) OR EXISTS (
       -- Pasajero agente (migración 072): su propio perfil…
       SELECT 1 FROM perfil_cliente p WHERE p.dispositivo_id = $1 AND p.es_agente
     ) OR EXISTS (
       -- …o cualquier otro perfil suyo con el mismo número verificado. Esto es
       -- lo que hace que cambiar de móvil no le quite el papel.
       SELECT 1
       FROM perfil_cliente mio
       JOIN perfil_cliente otro ON otro.telefono = mio.telefono
       WHERE mio.dispositivo_id = $1
         AND mio.telefono IS NOT NULL
         AND mio.telefono_verificado_en IS NOT NULL
         AND otro.telefono_verificado_en IS NOT NULL
         AND otro.es_agente
     ) AS puede`,
    [dispositivoId],
  );
  return res.rows[0]?.puede === true;
}

// La misma pregunta a partir del uuid del dispositivo, que es lo que llega en
// las cabeceras de la API.
export async function esAgenteDeCampoPorUuid(
  cliente: Lector,
  uuid: string,
): Promise<boolean> {
  const res = await cliente.query(
    'SELECT id FROM dispositivo WHERE uuid_persistente = $1',
    [uuid.toLowerCase()],
  );
  if (res.rowCount === 0) return false;
  return esAgenteDeCampo(cliente, Number(res.rows[0].id));
}
