-- 076 — Avisar al que se quedó sin taxi cuando entra uno en su barrio (30/09).
--
-- DE DÓNDE SALE. Preguntando si al entrar un taxi en servicio habría que
-- avisar a los usuarios. A TODOS no: el 99 % de quien reciba ese aviso no está
-- pidiendo taxi en ese momento, y las notificaciones que no sirven se
-- silencian —y al silenciarlas se pierden también las que sí importan—. Eso ya
-- ha pasado en esta plataforma por el otro lado: cuatro de seis taxistas tenían
-- los avisos apagados y ninguna carrera les sonaba.
--
-- Pero hay UNA persona a la que ese aviso le importa mucho: la que acaba de
-- pedir un taxi, ha oído «no hay taxi» y sigue esperando en la calle. Para esa,
-- que entre uno en su barrio es exactamente la noticia que quiere. Es raro, es
-- útil, y llega en el único momento en que se agradece.
--
-- CÓMO. Cuando una solicitud se cierra con SIN_OFERTA se anota aquí que ese
-- teléfono está esperando en ese barrio. Cuando un taxista entra en servicio se
-- mira quién está esperando en el suyo y se le avisa. Y se avisa UNA vez: un
-- segundo taxista entrando no vuelve a sonar, porque lo que se está diciendo es
-- «ya hay taxis», no «ha entrado alguien».
--
-- La espera caduca sola. Nadie sigue esperando un taxi media hora después de
-- haberse ido andando, y un aviso que llega tarde es peor que ninguno: manda a
-- la calle a alguien que ya resolvió lo suyo.

CREATE TABLE espera_taxi (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- A qué teléfono avisar. Es el dispositivo y no la persona: quien pidió es
  -- quien está esperando, y puede no tener cuenta de nada.
  dispositivo_cliente_id bigint NOT NULL REFERENCES dispositivo (id) ON DELETE CASCADE,
  -- La solicitud que se quedó sin taxi, para poder contar la historia después.
  solicitud_id           bigint NOT NULL REFERENCES solicitud (id),
  -- Dónde esperaba. El barrio del ORIGEN, que es donde hay que recogerle.
  zona_id                bigint NOT NULL REFERENCES zona (id),
  creada_en              timestamptz NOT NULL DEFAULT now(),
  caduca_en              timestamptz NOT NULL,
  -- Cuándo se le avisó. Mientras sea NULL sigue esperando; una vez puesto, ya
  -- no se le vuelve a molestar por el mismo plantón.
  avisada_en             timestamptz,
  -- Un teléfono espera en un sitio a la vez. Si vuelve a pedir y vuelve a
  -- quedarse sin taxi, es la misma espera con el reloj puesto a cero, no dos.
  UNIQUE (dispositivo_cliente_id)
);

-- La consulta que se hace al entrar un taxi: quién espera en este barrio, sin
-- avisar todavía y sin caducar.
CREATE INDEX espera_taxi_pendientes ON espera_taxi (zona_id, caduca_en)
  WHERE avisada_en IS NULL;

ALTER TABLE espera_taxi ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE espera_taxi IS
  'Quién se quedó sin taxi y sigue esperando, para avisarle cuando entre uno '
  'en su barrio (migración 076). Se borra sola al caducar.';

-- El aviso. Canal 1 la conexión abierta; canal 2 la notificación web, que es
-- la que suena con el teléfono en el bolsillo — y es justo donde está el
-- teléfono de quien lleva diez minutos esperando en la calle.
--
-- `ttl_seg` corto: este aviso solo vale AHORA. Entregarlo diez minutos tarde es
-- mandar a la acera a alguien que ya se fue en otra cosa.
INSERT INTO enrutamiento (evento, rol, canal_1, canal_2, condicion_escalada, ttl_seg) VALUES
  ('C7_taxi_disponible', 'cliente', 'sse', 'web', NULL, 300);

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('aviso_taxi_libre_min', '20',
   'Cuánto sigue esperando alguien a quien se le dijo «no hay taxi», antes de '
   'dejar de avisarle si entra uno en su barrio (migración 076). Pasado ese '
   'rato ya resolvió lo suyo y el aviso estorba');
