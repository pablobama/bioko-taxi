-- 078 — Volver a entrar escribiendo solo el teléfono (02/10).
--
-- EL PROBLEMA, dicho como lo vive la gente: quien ya está registrado y vuelve
-- a abrir la aplicación en un teléfono nuevo —o después de reinstalar, o de
-- borrar los datos del navegador— se encuentra con el formulario de alta
-- entero. El taxista tiene que volver a teclear nombre, matrícula, marca y
-- carrocería para una ficha que ya existe desde hace meses, con su monedero y
-- su reputación dentro. Y si teclea algo distinto, lo pisa.
--
-- Encima no es verdad que hiciera falta: el alta del taxista ya reutilizaba la
-- ficha por el teléfono —es su clave natural desde la migración 024— y el
-- perfil del pasajero ya reclamaba su número. Lo único que faltaba era
-- PREGUNTAR PRIMERO. Así que ahora el primer paso de las dos altas pide solo el
-- número, y según esté o no registrado se sigue por un camino o por el otro.
--
-- LO QUE ESTO ES DE VERDAD, y conviene no disimularlo: es recuperar una cuenta.
-- Entregar la ficha de un taxista —con su saldo— a quien escriba nueve dígitos
-- sería regalar cuentas al primero que acierte un número, y los números de
-- Malabo son nueve dígitos que empiezan casi todos igual. Por eso reclamar
-- SIEMPRE pasa por un código por SMS a ese número. El dueño del número es el
-- dueño de la cuenta; quien solo lo conoce, no.
--
-- Y hay un segundo filo, menos obvio: «¿está registrado este número?» es, si se
-- deja abierto, una máquina para saber quién usa la aplicación. Se contesta
-- igual —sin ella no hay forma de hacer el paso previo— pero contando los
-- intentos y cortando al que pregunta demasiado. Esta tabla es ese contador, y
-- de paso el sitio donde el operador puede ver a alguien probando números.

CREATE TABLE intento_cuenta (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Quién pregunta. El uuid y no `dispositivo.id` a propósito: en este momento
  -- el dispositivo puede no existir todavía en la base —es justo el caso de
  -- quien acaba de instalar— y el contador tiene que funcionar antes de eso.
  uuid_dispositivo uuid NOT NULL,
  -- Por qué número. En forma canónica, como en todas partes (migración 024).
  telefono         text NOT NULL,
  -- 'buscar' (¿existe?), 'codigo' (mándame el SMS) o 'reclamar' (aquí está).
  paso             text NOT NULL CHECK (paso IN ('buscar', 'codigo', 'reclamar')),
  -- Si salió bien. En 'reclamar' es lo que distingue un código acertado de uno
  -- fallado, que es lo que hay que contar para que nadie pruebe los mil.
  acertado         boolean NOT NULL,
  momento          timestamptz NOT NULL DEFAULT now()
);

-- Las dos preguntas que se hacen: cuántas veces ha preguntado este aparato en
-- la última hora, y cuántas veces se ha intentado reclamar este número.
CREATE INDEX intento_cuenta_por_dispositivo ON intento_cuenta (uuid_dispositivo, momento DESC);
CREATE INDEX intento_cuenta_por_telefono ON intento_cuenta (telefono, momento DESC);

ALTER TABLE intento_cuenta ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE intento_cuenta IS
  'Intentos de volver a entrar con el teléfono (migración 078): sirve de '
  'contador para frenar a quien prueba números, y de rastro para que el '
  'operador lo vea. Se purga sola a las 24 horas.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('recuperacion_activada', '1',
   'Interruptor del paso previo «¿ya estás registrado?» de las dos altas '
   '(migración 078). A 0, las altas vuelven a pedir todos los datos desde el '
   'principio. Está por si hubiera que apagarlo con el servidor en marcha'),
  ('recuperacion_consultas_hora', '10',
   'Cuántos números distintos puede preguntar un mismo aparato en una hora '
   '(migración 078). Diez es de sobra para alguien que se equivoca al teclear '
   'el suyo, y poquísimo para quien quiere averiguar quién usa la aplicación'),
  ('recuperacion_cooldown_seg', '60',
   'Espera entre dos SMS de recuperación al mismo número (migración 078). '
   'Impide que pulsar «reenviar» le cueste dinero a la plataforma y le llene '
   'el teléfono de mensajes a alguien que no ha pedido nada'),
  ('recuperacion_intentos_codigo', '5',
   'Códigos fallados por hora antes de cerrar la recuperación de un número '
   '(migración 078). Sin este tope, un código de seis cifras se acierta '
   'probando, y lo que se abre con él es la cuenta de otro');
