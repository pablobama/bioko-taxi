-- 072 — El catálogo deja de ser una lista cerrada, y un pasajero puede
--        arreglarlo (petición del operador, 26/09).
--
-- DOS COSAS que van juntas porque son la misma idea: quien conoce Malabo es
-- quien vive en Malabo, no quien escribió la lista.
--
-- 1. SITIOS QUE PONE LA GENTE. Hasta hoy, si tu destino no estaba en el
--    catálogo no podías pedir el taxi: la lista la rellenaban el importador de
--    OSM y el operador. En una ciudad sin direcciones eso deja fuera lo que
--    todo el mundo usa —«la calle del Rey Boncoro», «la avenida detrás del
--    mercado», la casa de alguien— y no hay lista que pueda preverlo.
--
--    Ahora quien no encuentra su sitio lo escribe y se crea. Con dos cuidados
--    para que el catálogo no se llene de basura y de duplicados:
--
--      · Nace COMO PROPUESTA (`propuesta_en` con fecha). Sirve desde el primer
--        momento para quien lo puso —es su viaje, y su viaje no puede esperar
--        a que nadie apruebe nada— pero no sale en las búsquedas de los demás
--        hasta que el operador o un agente lo aprueba, o hasta que se usa
--        `sitio_propuesto_usos_para_publicar` veces. Si tres personas distintas
--        piden un taxi a ese nombre, el sitio existe: eso no lo discute nadie.
--      · Se guarda QUIÉN lo propuso. Sin eso no se puede ni agradecer ni
--        limpiar lo que uno solo llenó de nombres inventados.
--
--    Lo que NO hace: adivinar duplicados por su cuenta. Eso se decide con el
--    nombre normalizado y la distancia, en el servidor, y si hay uno parecido
--    a menos de `sitio_propuesto_mismo_m` metros se reutiliza en vez de crear.
--
-- 2. PASAJEROS CON PAPEL DE CAMPO. El papel de agente (migración 025) solo lo
--    podía tener un taxista, porque vivía en `conductor.es_agente`. Pero quien
--    mejor sitúa un barrio es a veces alguien que ni conduce: el del mercado,
--    la enfermera del centro de salud. Ahora el operador puede dárselo también
--    a un pasajero, y con él puede situar barrios, corregir sitios y aprobar
--    los propuestos — lo mismo que un agente taxista, ni más ni menos: no toca
--    dinero, ni verificaciones, ni incidencias.

ALTER TABLE referencia
  ADD COLUMN propuesta_en timestamptz,
  ADD COLUMN propuesta_por_dispositivo_id bigint REFERENCES dispositivo (id),
  ADD COLUMN aprobada_en timestamptz;

COMMENT ON COLUMN referencia.propuesta_en IS
  'Cuándo lo propuso alguien desde la aplicación (migración 072). NULL en los '
  'sitios del catálogo de siempre, que no necesitan aprobación.';

COMMENT ON COLUMN referencia.aprobada_en IS
  'Cuándo pasó a ser un sitio como los demás: lo aprobó el operador o un '
  'agente, o se usó las veces suficientes. NULL mientras sigue en propuesta.';

-- Un sitio propuesto y todavía sin aprobar no sale en las búsquedas de los
-- demás. El índice es el que hace barata esa condición en cada búsqueda.
CREATE INDEX referencia_publicas
  ON referencia (zona_id) WHERE activa AND (propuesta_en IS NULL OR aprobada_en IS NOT NULL);

ALTER TABLE perfil_cliente
  ADD COLUMN es_agente boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN perfil_cliente.es_agente IS
  'Pasajero con papel de campo (migración 072): sitúa barrios, corrige sitios '
  'y aprueba los propuestos. No toca dinero ni verificaciones.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('sitio_propuesto_usos_para_publicar', '3',
   'Veces que hay que pedir un taxi a un sitio propuesto para que salga en '
   'las búsquedas de todos sin que nadie lo apruebe (migración 072)'),
  ('sitio_propuesto_mismo_m', '150',
   'Si ya hay un sitio con nombre parecido a menos de estos metros, se '
   'reutiliza en vez de crear otro: es el mismo sitio con otra letra');
