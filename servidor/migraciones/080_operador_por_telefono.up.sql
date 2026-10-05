-- 080 — Entrar como operador con el teléfono, no con un uuid (04/10).
--
-- CÓMO SE ENTRABA HASTA HOY. La lista de operadores era `UUIDS_OPERADOR`, una
-- variable de entorno con uuids de dispositivo separados por comas, y para
-- entrar había que abrir `https://…/?operador=<36 caracteres al azar>`. Eso
-- obliga a sacar el valor de Render o de un fichero `.env` y pegarlo a mano, y
-- desde un móvil es directamente impracticable.
--
-- Y ADEMÁS ERA LO MENOS SEGURO QUE HAY, aunque no lo pareciera: ese enlace ES
-- la llave. Quien lo vea por encima del hombro, lo reciba reenviado o lo
-- encuentre en un historial de navegación es operador para siempre en su
-- navegador, sin que nadie se entere y sin forma de echarle que no sea cambiar
-- la variable y volver a desplegar.
--
-- LO QUE SE PONE EN SU LUGAR: el número de teléfono y un código por SMS. Hacen
-- falta DOS cosas y no una — estar en la lista Y tener el móvil en la mano—,
-- que es exactamente lo que faltaba. La maquinaria del SMS ya estaba (migración
-- 078), incluidos los topes contra quien prueba números.
--
-- LA RAÍZ VIVE EN EL ENTORNO, A PROPÓSITO. `TELEFONOS_OPERADOR` sigue siendo
-- una variable, y quien está ahí no se puede revocar desde el panel. Es el
-- seguro contra quedarse fuera de casa: si el permiso de todos viviera en la
-- base, un error —o alguien con prisa— podría dejar la plataforma sin ningún
-- operador y sin manera de volver a entrar.
--
-- Los de esta tabla son los demás: los que la raíz da de alta desde el panel,
-- y a los que puede echar sin desplegar nada.

CREATE TABLE operador_autorizado (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- En forma canónica, como en todas partes (migración 024).
  telefono     text NOT NULL,
  nombre       text,
  -- Quién lo dio de alta, por su teléfono. No un id: quien reparte permisos
  -- tiene que quedar nombrado de forma que se lea sin cruzar tablas.
  alta_por     text NOT NULL,
  creado_en    timestamptz NOT NULL DEFAULT now(),
  -- Revocar no borra la fila: se apunta cuándo y quién. Un permiso retirado es
  -- justo lo que interesa poder mirar después, y una fila borrada no cuenta
  -- nada.
  revocado_en  timestamptz,
  revocado_por text
);

-- Un número autorizado a la vez. Volver a darle de alta después de revocarlo
-- es una fila nueva, que es como debe leerse: dos permisos distintos.
CREATE UNIQUE INDEX operador_autorizado_vigente
  ON operador_autorizado (telefono)
  WHERE revocado_en IS NULL;

-- Qué aparatos han demostrado ser de un operador. Es lo que evita pedir el
-- código en cada visita, y lo que permite echar a UN teléfono perdido sin
-- tocar a la persona ni a sus otros aparatos.
CREATE TABLE operador_dispositivo (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- El uuid y no `dispositivo.id`: el operador no tiene fila en `dispositivo`
  -- —nunca la ha tenido, es una lista aparte— y este aparato puede no existir
  -- allí.
  uuid_dispositivo uuid NOT NULL,
  telefono         text NOT NULL,
  creado_en        timestamptz NOT NULL DEFAULT now(),
  -- Última vez que se le vio. Sirve para reconocer en la lista cuál es el
  -- teléfono que uno lleva encima y cuál es el que perdió el mes pasado.
  visto_en         timestamptz,
  revocado_en      timestamptz,
  revocado_por     text
);

CREATE UNIQUE INDEX operador_dispositivo_vigente
  ON operador_dispositivo (uuid_dispositivo)
  WHERE revocado_en IS NULL;

CREATE INDEX operador_dispositivo_por_telefono
  ON operador_dispositivo (telefono)
  WHERE revocado_en IS NULL;

ALTER TABLE operador_autorizado ENABLE ROW LEVEL SECURITY;
ALTER TABLE operador_dispositivo ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE operador_autorizado IS
  'Quién puede entrar al panel, además de los de TELEFONOS_OPERADOR '
  '(migración 080). Los del entorno son la raíz y no se revocan desde aquí: '
  'es el seguro contra quedarse sin ningún operador.';

COMMENT ON TABLE operador_dispositivo IS
  'Aparatos que demostraron por SMS ser de un operador (migración 080). Evita '
  'pedir el código en cada visita y permite echar a un teléfono perdido.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('operador_sesion_dias', '30',
   'Cuántos días vale el aparato de un operador antes de volver a pedirle el '
   'código (migración 080). Treinta es el equilibrio entre no dar la lata a '
   'diario y que un portátil olvidado en una oficina no sirva para siempre');
