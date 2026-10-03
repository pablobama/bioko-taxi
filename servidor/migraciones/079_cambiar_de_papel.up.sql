-- 079 — Cambiar de papel: pasajero a taxista con permiso, taxista a pasajero sin él (03/10).
--
-- EL HUECO. La pantalla de elegir papel avisa de que «cambiar de tipo después
-- requiere hablar con el operador», y era verdad en el peor sentido: no había
-- NINGUNA forma de hacerlo. Ni para la persona ni para el operador. Quien se
-- equivocaba de botón el primer día se quedaba con el papel equivocado para
-- siempre, y un taxista que dejaba de conducir seguía siendo un taxista.
--
-- LA ASIMETRÍA ES DELIBERADA, y es toda la idea:
--
--   · PASAJERO → TAXISTA pasa por el operador. Un taxi recibe carreras, cobra,
--     lleva gente en su coche. Dejar que cualquiera se convierta en uno
--     escribiendo una matrícula es exactamente lo que el alta pendiente de
--     verificación existía para impedir.
--
--   · TAXISTA → PASAJERO es inmediato. Nadie tiene que dar permiso para dejar
--     de trabajar, y pedirlo sería retener a alguien en un papel que ya no
--     quiere. Es renunciar a un privilegio, no pedirlo.
--
-- Y LA VUELTA NO SE VUELVE A APROBAR. Un taxista que pasó a pasajero conserva
-- su ficha —con su monedero, su reputación y su historial— y puede volver
-- cuando quiera: ya fue aprobado una vez, y no conduzco hoy no es lo mismo que
-- no puedo conducir. Lo que decide es si existe una ficha de conductor
-- VERIFICADA con su teléfono; si la hay, no hay nada que aprobar.
--
-- QUÉ ES ESTA TABLA Y QUÉ NO. No guarda los datos del taxi: ésos van donde
-- siempre, en `conductor` y `vehiculo`, creados ya en estado 'pendiente' por el
-- mismo camino que el alta de siempre. Aquí solo vive la COLA: quién pidió,
-- desde qué aparato, y qué se decidió. Duplicar la matrícula aquí sería tener
-- dos sitios donde mirar qué coche es, y acabarían diciendo cosas distintas.

CREATE TABLE peticion_taxista (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Desde qué aparato se pide. Es el que se convertirá en aparato de taxista
  -- si se aprueba, y por eso se guarda: la ficha del conductor no sabe nada de
  -- aparatos, y sin esto el operador aprobaría a una persona sin que nadie
  -- supiera en qué teléfono tiene que aparecer el panel.
  dispositivo_id bigint NOT NULL REFERENCES dispositivo (id) ON DELETE CASCADE,
  -- La ficha que se creó con los datos declarados, en estado 'pendiente'.
  conductor_id   bigint NOT NULL REFERENCES conductor (id),
  estado         text NOT NULL DEFAULT 'pendiente'
                   CHECK (estado IN ('pendiente', 'aprobada', 'rechazada')),
  -- Por qué se rechaza. Obligatorio en la ruta, no en el esquema: una petición
  -- aprobada no lo lleva, y un CHECK condicional por esto sería ruido.
  motivo         text,
  creada_en      timestamptz NOT NULL DEFAULT now(),
  resuelta_por   text,
  resuelta_en    timestamptz
);

-- Una petición viva por aparato. Pedirlo dos veces es la misma petición, no
-- dos: sin esto, tocar el botón con la red lenta llenaba la cola del operador
-- de copias del mismo caso.
CREATE UNIQUE INDEX peticion_taxista_viva
  ON peticion_taxista (dispositivo_id)
  WHERE estado = 'pendiente';

-- La consulta del operador: lo que falta por revisar, lo más viejo primero.
-- Cola y no pila: quien lleva tres días esperando permiso para trabajar tiene
-- más derecho a respuesta que quien lo pidió hace diez minutos.
CREATE INDEX peticion_taxista_cola ON peticion_taxista (creada_en)
  WHERE estado = 'pendiente';

ALTER TABLE peticion_taxista ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE peticion_taxista IS
  'Cola de «quiero ser taxista» (migración 079). Los datos del coche no están '
  'aquí: viven en conductor y vehiculo, creados en estado pendiente. Esto es '
  'quién lo pidió, desde qué aparato y qué se decidió.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('cambio_papel_activado', '1',
   'Interruptor del cambio de papel (migración 079). A 0, ni el pasajero puede '
   'pedir ser taxista ni el taxista puede pasarse a pasajero. Está por si hay '
   'que cerrarlo con el servidor en marcha');
