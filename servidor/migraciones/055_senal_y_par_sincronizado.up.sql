-- 055 — Lo que enseñó el primer informe de turno de producción (14/09).
--
-- 1. EL VIAJE 97 ESTUVO A VEINTICINCO SEGUNDOS DE CERRARSE SOLO.
--
--    El móvil del pasajero dejó de mandar posición a las 09:03:23 —pantalla
--    apagada, lo normal—. Pero una posición cuenta como «fresca» noventa
--    segundos, y durante esos noventa segundos el coche siguió andando. El
--    cierre automático comparaba la ÚLTIMA posición de cada uno: un punto
--    congelado contra un coche en marcha. A 40 km/h, en veinticinco segundos
--    el coche se aleja 280 m de donde se quedó el punto, y a las 09:03:48 el
--    sistema dio al pasajero por separado del coche en el que iba sentado.
--
--    No lo cerró por pura coincidencia de parámetros: la posición congelada
--    caducó a las 09:04:53, veinticinco segundos antes de que se cumplieran los
--    noventa de separación sostenida de la 050. Con una frescura de dos
--    minutos, o con el último punto del pasajero medio minuto más tarde, el
--    viaje se habría cerrado con él dentro. Otra vez.
--
--    La raíz es comparar posiciones de MOMENTOS DISTINTOS. Ahora se compara la
--    del pasajero con la del coche tomada EN EL MISMO INSTANTE (la más cercana
--    en el tiempo, y como mucho a `gps_desfase_par_seg`): «dónde estaba el
--    coche cuando el pasajero estaba ahí». Un pasajero que deja de mandar ya no
--    se aleja del coche, porque su último punto se compara con dónde estaba el
--    coche entonces — a su lado.
--
--    Y la separación sostenida se mide entre LECTURAS, no entre tiques del
--    planificador: hace falta una lectura del pasajero posterior a la que abrió
--    la cuenta, y todavía separada. Una sola lectura, por buena que sea, no
--    cierra un viaje.
--
-- 2. DOS HORAS Y CINCUENTA MINUTOS DE TURNO CON UN SOLO PUNTO, Y NI UNA PISTA
--    DE POR QUÉ.
--
--    El turno de 12:38 a 15:28 tiene un punto del recorrido: el de entrar en
--    servicio. Puede ser que la aplicación no latiera (iPhone con la pantalla
--    bloqueada, P47-01), que latiera sin posición (GPS sin permiso o sin
--    fijación), o que latiera con posición y el servidor no la guardara. Son
--    tres fallos distintos con tres arreglos distintos, y hoy NO HAY FORMA de
--    distinguirlos después: del latido solo se guarda el último.
--
--    `senal` apunta, por minuto y por taxista en servicio, cuántos latidos
--    llegaron y cuántos con posición. Una fila por minuto como mucho —del
--    orden del rastro— y se purga con él. Con esto el informe de turno ya no
--    dice «hay un hueco», dice por qué.

CREATE TABLE senal (
  conductor_id      bigint NOT NULL REFERENCES conductor (id),
  minuto            timestamptz NOT NULL,
  latidos           integer NOT NULL DEFAULT 0,
  con_posicion      integer NOT NULL DEFAULT 0,
  mejor_precision_m real,
  PRIMARY KEY (conductor_id, minuto)
);

COMMENT ON TABLE senal IS
  'Latidos recibidos por minuto de un taxista en servicio (migración 055). '
  'Sirve para saber por qué hay un hueco en el recorrido: sin latidos, la app '
  'no corría; con latidos sin posición, el GPS; con posición y sin rastro, el '
  'servidor.';

CREATE INDEX senal_minuto ON senal (minuto);

-- Como todas las tablas públicas desde la 039: la API de Supabase no la ve.
ALTER TABLE senal ENABLE ROW LEVEL SECURITY;

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('gps_desfase_par_seg', '20',
   'Para decidir si el pasajero se ha separado del coche, las dos posiciones '
   'tienen que ser del mismo momento, como mucho con esta diferencia. Comparar '
   'un punto congelado del pasajero con el coche en marcha lo «aleja» del coche '
   'en el que va sentado');
