-- 043 — «Voy en este taxi, mírame llegar».
--
-- El pasajero comparte su viaje con quien quiera —su madre, su pareja, un
-- compañero— y esa persona ve en vivo dónde va y en qué coche, hasta que
-- llega. Es la funcionalidad de seguridad que más se pide en un servicio de
-- taxi, y aquí, donde el pasajero y el taxista se conocen de vista y viven en
-- la misma ciudad, pesa más todavía.
--
-- OJO CON EL NOMBRE: `solicitud.compartido` ya existe y significa otra cosa
-- —taxi compartido, varios pasajeros en un coche—. Esto es SEGUIMIENTO.
--
-- Las dos puertas, por decisión del operador:
--   - Quien comparte tiene que tener su teléfono verificado. Sin eso,
--     cualquiera podría fabricar viajes y repartir enlaces.
--   - Y quien MIRA también verifica el suyo. Cuesta un SMS por persona y es
--     un estorbo real para una madre asustada a las once de la noche, pero
--     convierte «un enlace que anda suelto por un grupo de WhatsApp» en una
--     lista de personas con nombre y número. Que es justo lo que la tabla de
--     visitas de abajo deja ver al pasajero.
--
-- El token NO se guarda: se guarda su hash. Va en una URL, y las URL acaban
-- en historiales, en registros de servidores y en capturas de pantalla. Con
-- el hash, quien lea esta tabla no puede abrir los viajes de nadie.

CREATE TABLE seguimiento (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  solicitud_id    bigint NOT NULL REFERENCES solicitud (id),
  -- sha256 del token en hexadecimal.
  token_hash      text NOT NULL UNIQUE,
  -- Quién lo abrió, para que solo él pueda cortarlo.
  dispositivo_id  bigint NOT NULL REFERENCES dispositivo (id),
  creado_en       timestamptz NOT NULL DEFAULT now(),
  expira_en       timestamptz NOT NULL,
  revocado_en     timestamptz
);

COMMENT ON TABLE seguimiento IS
  'Enlaces «mírame llegar» de un viaje (migración 043). El token se guarda '
  'hasheado: viaja en una URL y las URL se filtran solas.';

CREATE INDEX seguimiento_solicitud ON seguimiento (solicitud_id);

-- Quién ha mirado. No es telemetría: es lo que el pasajero ve en su pantalla
-- mientras va en el taxi. Si aparece un número que no reconoce, sabe que su
-- enlace anda donde no debería y puede cortarlo desde ahí mismo.
CREATE TABLE seguimiento_visita (
  seguimiento_id  bigint NOT NULL REFERENCES seguimiento (id) ON DELETE CASCADE,
  dispositivo_id  bigint NOT NULL REFERENCES dispositivo (id),
  telefono        text NOT NULL,
  primera_en      timestamptz NOT NULL DEFAULT now(),
  ultima_en       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (seguimiento_id, dispositivo_id)
);

COMMENT ON TABLE seguimiento_visita IS
  'Quién ha abierto cada enlace de seguimiento (migración 043). Se le enseña '
  'al pasajero: es su viaje y tiene derecho a saber quién lo está mirando.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('seguimiento_gracia_min', '30',
   'Minutos que el enlace de «mírame llegar» sigue abierto después de '
   'terminar el viaje: el tiempo de que quien seguía vea que llegó bien');
