-- 092 — VIN del vehículo y tipo de registro del taxi (12/10).
--
-- Dos cosas que la central pidió para el alta y los registros:
--
--   · El VIN (número de bastidor) del coche, para identificarlo más allá de la
--     matrícula. Opcional: muchos coches ya dados de alta no lo tienen apuntado.
--
--   · El TIPO DE REGISTRO del taxi. Hay dos formas de estar al día:
--       - «ayuntamiento»: se paga una cuota ANUAL al Ayuntamiento (30.000 XAF)
--         que SUSTITUYE a la cuota semanal. Al pagarla, el taxi queda al día un
--         año y no se le cobra la semanal.
--       - «recargas»: el modelo de siempre, cuota semanal por el monedero
--         (migración 011/018).
--     Se guarda en el conductor, que es la cuenta operativa de la que cuelgan
--     el monedero y la suscripción.

ALTER TABLE vehiculo ADD COLUMN vin text;

ALTER TABLE conductor ADD COLUMN tipo_registro text NOT NULL DEFAULT 'recargas'
  CHECK (tipo_registro IN ('recargas', 'ayuntamiento'));

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('registro_ayuntamiento_xaf', '30000',
   'Cuota ANUAL del taxi registrado por el Ayuntamiento (XAF). Sustituye la '
   'cuota semanal: al pagarla, el taxi queda al día un año y no se le cobra la '
   'cuota del monedero. Los taxis que no van por Ayuntamiento siguen con la '
   'tarifa de recargas (suscripcion_importe_xaf / suscripcion_dias)');
