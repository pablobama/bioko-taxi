-- 075 — El walkie-talkie del gremio: un canal, y la palabra de uno en uno.
--
-- QUÉ ES. Un taxista aprieta un botón, habla hasta diez segundos, suelta, y lo
-- oyen los demás taxistas conectados. Como una radio de las de siempre: medio
-- dúplex, uno habla y los demás escuchan. No es una llamada.
--
-- POR QUÉ NO ES UNA LLAMADA. La llamada que ya existe (`api/llamadas.ts`) es
-- WebRTC entre dos teléfonos, y no se puede estirar a un grupo: en malla, quien
-- habla manda una copia a CADA uno. Un gremio de quince son catorce copias
-- subiendo a la vez, 280 kbps de subida desde un coche en marcha en Malabo. No
-- se sostiene, y arreglarlo pide un servidor de medios que hay que pagar.
--
-- Aquí quien habla sube UNA copia, el servidor la reparte, y cada uno la baja.
-- Va un segundo o dos por detrás del directo —se oye al soltar, no mientras se
-- habla— y a cambio funciona con esta red: un solo viaje, y si te pilla un
-- hueco sin cobertura sale cuando vuelve en vez de perderse.
--
-- UN SOLO CANAL, Y EL MOTIVO ES EL TAMAÑO DE LA FLOTA. Lo primero que se
-- diseñó fue un canal por barrio, para que te oyera el que puede ayudarte. Con
-- cuarenta taxistas en total (los mismos cuarenta de la migración 064) y viaje
-- y medio al día, un canal de barrio tiene cero personas dentro. Y una radio
-- donde nadie contesta es peor que no tener radio: le enseña a la gente que no
-- funciona, y entonces tampoco la usan el día que hace falta.
--
-- Así que hoy el canal es uno y es la isla. Pero el canal es un DATO y no una
-- constante —la columna está en las tres tablas y el turno se bloquea por
-- canal— para que partirlo el día que estorbe cueste una función y no una
-- reescritura. Cuando toque, los siete distritos urbanos de la migración 040
-- están ya validados sobre el terreno y son la partición natural.
--
-- Y CUÁNDO TOCA NO SE ADIVINA: SE CUENTA. `radio_uso` lleva, por canal y día,
-- cuántas veces se dio la palabra y cuántas se dijo «está ocupado». Uno a la
-- vez por diez segundos son seis mensajes por minuto como techo absoluto, así
-- que el canal se llena de verdad y hay que saberlo antes de que la gente lo
-- abandone. Cuando los rechazos pasen de uno de cada cinco, está lleno.
--
-- LO QUE CUESTA, dicho claro: al mismo caudal que las llamadas (2,5 KB/s), un
-- mensaje de diez segundos son 25 KB. Lo bueno de «uno a la vez» es que ese
-- gasto NO depende de cuántos sean: con quince conectados o con doscientos, lo
-- que baja tu teléfono es lo mismo, y solo mientras alguien tiene el botón
-- apretado. El tope de diez segundos tampoco es solo ahorro: en una radio de
-- verdad es lo que impide que uno se quede con el canal.

-- El turno de palabra. La clave primaria es el canal, y eso NO es decoración:
-- «solo puede hablar uno» pasa a ser una garantía de la base de datos en vez de
-- una comprobación del código. Dos taxistas que aprietan en el mismo
-- milisegundo no pueden ganar los dos, porque no caben dos filas.
--
-- Caduca siempre. Un teléfono que se queda sin batería con el botón apretado no
-- puede dejar el canal bloqueado para los demás, y con una fila por canal un
-- turno eterno es exactamente eso: el canal muerto hasta que alguien entre en
-- la base a mano.
CREATE TABLE turno_palabra (
  canal          text PRIMARY KEY,
  conductor_id   bigint NOT NULL REFERENCES conductor (id),
  -- Qué teléfono tiene la palabra, no solo quién. Un taxista con la aplicación
  -- abierta en dos sitios es un caso real, y el audio que llegue tiene que
  -- venir del mismo aparato que pidió el turno.
  dispositivo_id bigint NOT NULL REFERENCES dispositivo (id),
  pedido_en      timestamptz NOT NULL DEFAULT now(),
  caduca_en      timestamptz NOT NULL
);

-- Los mensajes de voz. Duran horas, no meses.
--
-- EL AUDIO VA EN LA BASE, y es una decisión, no una pereza. Con cuarenta
-- taxistas, mensajes de 25 KB y dos horas de guardado, todo lo que hay vivo a
-- la vez cabe en unos megabytes. Meter almacenamiento de objetos por eso serían
-- otra credencial, otro servicio que se cae aparte y otra copia de seguridad
-- que llevar. Si algún día el volumen lo pide, se mueve; hoy pedirlo sería
-- pagar por adelantado un problema que no existe.
--
-- QUE ESTO EXISTA YA ES UNA DECISIÓN. La llamada de hoy presume, con razón, de
-- que el servidor NO PUEDE escuchar: el audio no pasa por él, y eso no es una
-- promesa de política sino un hecho técnico. Esto es lo contrario, y hay que
-- decirlo en voz alta: el audio pasa y se queda guardado un rato. Sirve para
-- volver a oír lo que te perdiste, y sirve para tener prueba si alguien amenaza
-- a otro. Y crea lo incómodo: existe un archivo de lo que hablan los taxistas
-- entre ellos, y alguien puede pedirlo. La única protección de verdad contra
-- eso es que el rato sea CORTO, y por eso `radio_guardado_horas` son dos y el
-- borrado no es opcional.
CREATE TABLE mensaje_voz (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canal        text NOT NULL,
  -- Quién habla se sabe siempre. Un canal de voz anónimo entre desconocidos se
  -- envenena en una semana: quien habla lo hace con su nombre y su matrícula.
  conductor_id bigint NOT NULL REFERENCES conductor (id),
  audio        bytea NOT NULL,
  -- El navegador graba en lo que sabe y no en lo que le pidas: Chrome da
  -- `audio/webm;codecs=opus` y Safari `audio/mp4`. Se guarda lo que dijo el que
  -- grabó, porque es lo que el que escucha necesita para reproducirlo.
  tipo_medio   text NOT NULL,
  duracion_ms  integer NOT NULL CHECK (duracion_ms > 0),
  creado_en    timestamptz NOT NULL DEFAULT now()
);

-- Los últimos del canal, que es la única consulta que se hace: para repartirlos
-- y para el botón de volver a oír. Sirve igual para el borrado por edad.
CREATE INDEX mensaje_voz_canal_reciente ON mensaje_voz (canal, creado_en DESC);

-- La medida que decide si el canal hay que partirlo. Agregada por día y no fila
-- por intento: la pregunta es «¿se llena?», y para eso dos contadores bastan y
-- no crecen. Esto no se borra —son dos números al día— porque es lo que permite
-- mirar la tendencia dentro de seis meses.
CREATE TABLE radio_uso (
  canal           text NOT NULL,
  dia             date NOT NULL,
  turnos_dados    integer NOT NULL DEFAULT 0,
  turnos_ocupados integer NOT NULL DEFAULT 0,
  PRIMARY KEY (canal, dia)
);

-- Regla permanente desde la migración 045: una tabla nace abierta a la API
-- pública de Supabase, y estas tres son la voz de la gente y quién habló. La
-- prueba de `servidor.prueba.ts` es la que lo vigila.
ALTER TABLE turno_palabra ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensaje_voz ENABLE ROW LEVEL SECURITY;
ALTER TABLE radio_uso ENABLE ROW LEVEL SECURITY;

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('radio_activada', '1',
   'Interruptor del walkie-talkie del gremio (migración 075). A 0 no existe: '
   'ni se da la palabra ni se acepta audio, sin tocar código'),
  ('radio_segundos_max', '10',
   'Lo que se puede hablar de una vez. No es solo ahorro de datos: es lo que '
   'impide que uno se quede con el canal'),
  ('radio_turno_margen_seg', '5',
   'Margen que se le da al turno por encima de lo que se puede hablar, para '
   'que subir el audio con mala red no llegue con el turno ya caducado'),
  ('radio_guardado_horas', '2',
   'Lo que vive un mensaje de voz antes de borrarse. Corto a propósito: es la '
   'única protección real contra que exista un archivo de lo que se habla'),
  ('radio_bytes_max', '40000',
   'Tope de tamaño de un mensaje. Diez segundos a 20 kbps son 25 KB; lo que '
   'pase de aquí no es voz, es un cliente manipulado'),
  ('radio_mensajes_por_minuto', '6',
   'Cuántos mensajes seguidos puede mandar UN taxista por minuto. Contra el '
   'que se engancha al botón: el tope del canal no le sirve de freno a él');
