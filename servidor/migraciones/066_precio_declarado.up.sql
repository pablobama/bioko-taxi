-- 066 — El precio vuelve, pero solo si el pasajero quiere decirlo
--        (P12-01, P12-02, y la mitad de P7-03).
--
-- La migración 012 quitó el reporte de precio por una razón buena: con el
-- modelo de suscripción la plataforma no necesita saber cuánto se pagó, el
-- dinero nunca pasa por aquí, y obligar a los dos a teclear una cifra al
-- terminar era fricción a cambio de nada. Esa razón sigue en pie y esta
-- migración NO la revierte:
--
--   - El conductor no declara nada. Para él no cambia absolutamente nada.
--   - El pasajero tampoco tiene que escribir: en la pantalla de valoración se
--     le ofrecen tres importes de un toque, sacados de la banda de su ruta, y
--     puede no tocar ninguno. La valoración se envía igual.
--
-- Lo que se gana con lo que sí contesten:
--
--   1. Las bandas dejan de ser una suposición escrita a mano por el operador
--      (P12-01) y se calculan de lo que la gente dice que pagó, en cuanto hay
--      `banda_muestras_minimas` respuestas de ese par de zonas. Con menos, se
--      queda la del operador: es mejor su criterio de campo que tres cifras.
--   2. Vuelve a ser posible mirar el abuso de tarifa (P12-02, regla R5): un
--      taxista al que sus pasajeros le declaran precios sistemáticamente por
--      encima del p75 de la ruta. Y hay una señal más directa, que no
--      necesita ninguna cifra: el pasajero puede marcar «me cobró de más».
--
-- Lo que esto NO es: una tarifa. El precio lo negocian pasajero y conductor,
-- como siempre. La banda es orientativa y sirve para que ninguno de los dos
-- vaya a ciegas.

CREATE TABLE precio_declarado (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  viaje_id     bigint NOT NULL REFERENCES viaje (id),
  -- Hoy solo declara el pasajero. La columna admite 'conductor' porque el día
  -- que se quiera pedir su versión (para casar las dos) el sitio es este.
  emisor       text NOT NULL CHECK (emisor IN ('cliente', 'conductor')),
  importe_xaf  bigint NOT NULL CHECK (importe_xaf >= 0 AND importe_xaf <= 1000000),
  creado_en    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (viaje_id, emisor)
);

COMMENT ON TABLE precio_declarado IS
  'Lo que el pasajero dice que pagó, si quiso decirlo (migración 066). '
  'Voluntario y de un toque: alimenta las bandas y la vigilancia de tarifa.';

-- La señal que no necesita ninguna cifra. Va en la valoración porque es parte
-- de la misma respuesta y llega por el mismo camino, ya probado y con cola
-- sin red.
ALTER TABLE valoracion ADD COLUMN cobro_de_mas boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN valoracion.cobro_de_mas IS
  'El pasajero marcó que le cobraron por encima de lo normal (migración 066).';

-- Una banda calculada se distingue de una escrita a mano por `muestras`: 0 es
-- del operador, mayor que 0 es de lo que la gente declaró. La columna ya
-- existía desde la 005 y se quedó sin uso al quitar el precio en la 012.
COMMENT ON COLUMN banda_precio.muestras IS
  'Respuestas de pasajeros con las que se calculó la banda (migración 066). '
  '0 = la escribió el operador a mano.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('banda_muestras_minimas', '5',
   'Precios declarados que hacen falta en un par de zonas para calcular su '
   'banda. Con menos se respeta la que escribió el operador (migración 066)'),
  ('banda_ventana_dias', '90',
   'Días de precios declarados que entran en el cálculo de una banda. Más '
   'atrás el precio ya no dice lo que se paga hoy'),
  ('valoracion_pendiente_dias', '7',
   'Días que se le sigue pidiendo al pasajero la valoración de un viaje que '
   'cerró sin valorar (P7-03). Pasados, ya no se le pregunta'),
  ('alarma_cobros_de_mas', '3',
   'Veces que un taxista puede ser marcado con «me cobró de más» en 30 días '
   'antes de que salte la alarma del operador (R5, migración 066)');
