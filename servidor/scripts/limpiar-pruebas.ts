// Limpieza de la base de DESARROLLO (solo desarrollo).
//
// Por qué existe: las baterías de pruebas y las pruebas manuales comparten la
// misma base, y las pruebas dejan solicitudes a medias (EMITIDO, ACEPTADO…).
// El planificador del servidor recorre TODAS las solicitudes activas, así que
// esas sobras se ofrecen a los conductores reales de la semilla y los dejan
// OFERTADO: la siguiente prueba manual falla con un «no hay taxi» inexplicable.
//
// Esta herramienta cierra lo que quedó a medias y devuelve a los conductores
// de la semilla a un estado limpio. Escribe SQL directo a propósito (salta la
// máquina de estados) porque su trabajo es justamente sacar al sistema de
// estados que el dominio no permitiría abandonar. NO usar en producción.
//
// Uso: npx tsx scripts/limpiar-pruebas.ts

import { crearPool, enTransaccion } from '../src/bd/conexion.js';
import { urlBaseDatos } from '../src/bd/migrar.js';

async function principal(): Promise<void> {
  if (!urlBaseDatos().includes('localhost')) {
    throw new Error(
      'limpiar-pruebas solo funciona contra una base en localhost. '
      + `La configurada no lo es: ${urlBaseDatos()}`,
    );
  }
  const pool = crearPool();
  try {
    const resumen = await enTransaccion(pool, async (cliente) => {
      // Ofertas pendientes fuera.
      const ofertas = await cliente.query(
        `UPDATE oferta SET resultado = 'expirada', respondida_en = now()
         WHERE resultado IS NULL RETURNING id`,
      );

      // Solicitudes a medias a un terminal, con su fila de transición para no
      // romper la regla de que todo cambio deja rastro (4.2.3).
      const solicitudes = await cliente.query(
        `UPDATE solicitud SET estado = 'SIN_OFERTA'
         WHERE estado IN ('SOLICITADO', 'EMITIDO', 'ACEPTADO', 'EN_CAMINO', 'RECOGIDO')
         RETURNING id, estado`,
      );
      for (const fila of solicitudes.rows) {
        await cliente.query(
          `INSERT INTO transicion (ambito, solicitud_id, estado_anterior, estado_nuevo, actor, origen_evento)
           VALUES ('solicitud', $1, $2, 'SIN_OFERTA', 'sistema', 'limpieza_desarrollo')`,
          [fila.id, fila.estado],
        );
      }

      // Conductores de la semilla: fuera de servicio y sin heartbeat.
      const presencias = await cliente.query(
        `UPDATE presencia SET estado = 'DESCONECTADO', ultimo_heartbeat = NULL, actualizada_en = now()
         WHERE estado <> 'DESCONECTADO' RETURNING conductor_id, estado`,
      );
      for (const fila of presencias.rows) {
        await cliente.query(
          `INSERT INTO transicion (ambito, conductor_id, estado_anterior, estado_nuevo, actor, origen_evento)
           VALUES ('conductor', $1, $2, 'DESCONECTADO', 'sistema', 'limpieza_desarrollo')`,
          [fila.conductor_id, fila.estado],
        );
      }

      // Zonas de prueba: las baterías crean las suyas con un UUID en el
      // nombre («Zona A 3f2c…») y nunca las borran, así que la tabla zona
      // crece sin límite en cada `npm run probar`. Todo lo que cuelgue de una
      // zona así es de prueba. Donde una solicitud real referencia esa fila
      // no se puede borrar sin romper la clave foránea, así que esas se
      // desactivan en vez de borrarse (el mapa del cliente no debe mostrarlas).
      const referenciasBorradas = await cliente.query(
        `DELETE FROM referencia
         WHERE zona_id IN (
           SELECT id FROM zona
           WHERE nombre ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
         )
         AND id NOT IN (SELECT referencia_origen_id FROM solicitud)
         AND id NOT IN (SELECT referencia_destino_id FROM solicitud)
         RETURNING id`,
      );
      const referenciasDesactivadas = await cliente.query(
        `UPDATE referencia SET activa = false
         WHERE activa AND zona_id IN (
           SELECT id FROM zona
           WHERE nombre ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
         )
         RETURNING id`,
      );

      // Adyacencias entre zonas de prueba (despacho.prueba.ts las declara):
      // solo enlazan zonas de prueba entre sí, se borran sin miramiento.
      const adyacencias = await cliente.query(
        `DELETE FROM zona_adyacencia
         WHERE zona_id IN (
           SELECT id FROM zona
           WHERE nombre ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
         )
         OR zona_adyacente_id IN (
           SELECT id FROM zona
           WHERE nombre ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
         )
         RETURNING zona_id`,
      );

      // Las zonas en sí: solo las que ya no tienen nada real enganchado
      // (ninguna referencia, presencia, banda de precio ni zona hija). Si
      // queda algo real colgando de una, se deja para la próxima pasada en
      // vez de reventar por la restricción de clave foránea.
      const zonas = await cliente.query(
        `DELETE FROM zona
         WHERE nombre ~* '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
         AND id NOT IN (SELECT zona_id FROM referencia)
         AND id NOT IN (SELECT zona_id FROM presencia WHERE zona_id IS NOT NULL)
         AND id NOT IN (SELECT zona_origen_id FROM banda_precio)
         AND id NOT IN (SELECT zona_destino_id FROM banda_precio)
         AND id NOT IN (SELECT zona_padre_id FROM zona WHERE zona_padre_id IS NOT NULL)
         RETURNING id`,
      );

      // Reglas de enrutamiento inventadas por las pruebas del bus: se llaman
      // PRUEBA_… y se acumulan por centenares, ensuciando la tabla que el
      // operador consulta para ver por dónde sale cada aviso.
      const reglas = await cliente.query(
        `DELETE FROM enrutamiento WHERE evento LIKE 'PRUEBA\\_%' RETURNING evento`,
      );

      // Recorridos de las pruebas (migración 042). Se acumulan rápido —cada
      // ejecución de rastro.prueba.ts deja un centenar de puntos— y la purga
      // de producción no se los lleva: los fabrica con fechas de hoy.
      const rastros = await cliente.query(
        `DELETE FROM rastro WHERE conductor_id IN (
           SELECT id FROM conductor WHERE nombre LIKE 'Taxi RAS%' OR nombre LIKE 'Taxi REC%'
         ) RETURNING id`,
      );

      // Eventos sin entregar: ya no interesan.
      const eventos = await cliente.query(
        `UPDATE evento_salida SET entregado_en = now(), canal_entregado = 'descartado_limpieza'
         WHERE entregado_en IS NULL RETURNING id`,
      );

      return {
        ofertas: ofertas.rowCount ?? 0,
        solicitudes: solicitudes.rowCount ?? 0,
        presencias: presencias.rowCount ?? 0,
        referenciasBorradas: referenciasBorradas.rowCount ?? 0,
        referenciasDesactivadas: referenciasDesactivadas.rowCount ?? 0,
        adyacencias: adyacencias.rowCount ?? 0,
        zonas: zonas.rowCount ?? 0,
        rastros: rastros.rowCount ?? 0,
        reglas: reglas.rowCount ?? 0,
        eventos: eventos.rowCount ?? 0,
      };
    });

    console.log(
      `Limpieza hecha: ${resumen.solicitudes} solicitudes cerradas, `
      + `${resumen.ofertas} ofertas expiradas, ${resumen.presencias} conductores desconectados, `
      + `${resumen.referenciasBorradas} referencias de prueba borradas, `
      + `${resumen.referenciasDesactivadas} referencias de prueba desactivadas (aún ligadas a una solicitud real), `
      + `${resumen.adyacencias} adyacencias de zonas de prueba borradas, `
      + `${resumen.zonas} zonas de prueba borradas, `
      + `${resumen.rastros} puntos de recorrido de prueba borrados, `
      + `${resumen.reglas} reglas de enrutamiento de prueba borradas, `
      + `${resumen.eventos} eventos descartados.`,
    );
    console.log('Vuelve a conectar al conductor con «mantener» antes de probar.');
  } finally {
    await pool.end();
  }
}

principal().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
