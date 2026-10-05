-- 081 — El vale de entrada que da el operador (05/10).
--
-- POR QUÉ HACE FALTA. El 05/10, el alta de un taxista verificado se quedó
-- parada en la puerta: Twilio mandaba el SMS y GETESA (Orange) lo devolvía como
-- «undelivered 30008», que es lo que hace esa red con los mensajes de remitente
-- alfanumérico internacional. El código salía de aquí y no llegaba a ningún
-- sitio, y la persona se quedaba fuera de su propia cuenta sin nada que poder
-- hacer.
--
-- Contra eso hay dos caminos y los dos se abren a la vez. El primero es la
-- LLAMADA: la misma verificación de Twilio, leída por una voz, que entra por
-- otra puerta de la red. El segundo es este vale, para cuando tampoco entra la
-- llamada —cobertura mala, línea de otro país, teléfono que no es suyo—.
--
-- QUÉ ES. Un número de seis cifras que el operador dicta por teléfono o entrega
-- en mano, y que vale EN LUGAR del código del SMS en la pantalla donde ya se
-- pide uno. Nada más: la persona no ve ninguna puerta nueva.
--
-- Y POR QUÉ ES SEGURO, O MÁS BIEN POR QUÉ NO ES PEOR QUE LO QUE SUSTITUYE:
--
--   · Dura minutos, no días (`vale_minutos`). Un vale olvidado no es una llave
--     olvidada; a los quince minutos no abre nada.
--   · Se gasta UNA vez. Quien lo use después se encuentra con un código malo,
--     y eso incluye al que lo oyó por encima del hombro.
--   · Es para UN número. No sirve para entrar en otra cuenta, aunque se tenga.
--   · Queda escrito quién lo dio y qué aparato lo gastó. Es la diferencia entre
--     una excepción y un agujero: una excepción tiene nombre.
--
-- El código se guarda en resumen (sha-256), como el secreto de dispositivo de
-- la migración 069. Seis cifras resisten poco a quien tenga la tabla delante,
-- pero lo que de verdad lo protege es que caduca, que es de un solo uso y que
-- los intentos están contados; el resumen evita el caso tonto de que quien
-- mire la base por encima pueda entrar en una cuenta leyendo una columna.

CREATE TABLE vale_de_acceso (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- En forma canónica, como en todas partes (migración 024).
  telefono     text NOT NULL,
  codigo_hash  text NOT NULL,
  -- El teléfono del operador que lo dio, o 'entorno' si entró por el enlace
  -- viejo de uuid. Un nombre y no un id: quien abre una excepción tiene que
  -- quedar nombrado de forma que se lea sin cruzar tablas.
  emitido_por  text NOT NULL,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  caduca_en    timestamptz NOT NULL,
  usado_en     timestamptz,
  -- Qué aparato lo gastó. Es lo que convierte el registro en algo que sirve
  -- para investigar: sin esto solo consta que alguien entró.
  usado_por    uuid,
  -- Dar un vale nuevo anula el anterior del mismo número. Que convivan dos
  -- sería tener dos llaves de una puerta de la que solo se quería prestar una.
  anulado_en   timestamptz
);

-- Un vale vivo por número. El índice es el que hace cumplir lo de arriba
-- aunque dos operadores pulsen a la vez.
CREATE UNIQUE INDEX vale_de_acceso_vigente
  ON vale_de_acceso (telefono)
  WHERE usado_en IS NULL AND anulado_en IS NULL;

ALTER TABLE vale_de_acceso ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE vale_de_acceso IS
  'Códigos de entrada que da el operador cuando el SMS no llega (migración '
  '081). Un solo uso, para un solo número, con caducidad corta y con quién lo '
  'dio y qué aparato lo gastó.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('vale_minutos', '15',
   'Cuántos minutos vale el código de entrada que da el operador (migración '
   '081). Quince es lo que se tarda en dictarlo por teléfono y escribirlo sin '
   'prisa, y lo bastante poco para que olvidarse de uno no deje nada abierto');
