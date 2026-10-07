-- 086 — La Central entra en la radio (07/10).
--
-- El operador lo pidió con exclamación: «¡tiene que poder escuchar y emitir
-- en la radio!». Y tiene razón dos veces: una central que oye el canal sabe
-- lo que pasa en la calle sin llamar a nadie, y una que habla llega a toda la
-- flota de una vez — «el A013 al aeropuerto, hay cola» es exactamente para lo
-- que existe una radio de taxis.
--
-- Las dos tablas de la 075 daban por hecho que quien habla es un conductor
-- (conductor_id NOT NULL, dispositivo_id NOT NULL). La Central no tiene ni lo
-- uno ni lo otro: su identidad es el uuid de su aparato de operador (080).
-- Se les hace sitio SIN perder la regla de oro de la radio: la voz nunca es
-- anónima — o es de un conductor con nombre, o es de la Central, y los CHECK
-- de abajo son los que lo garantizan.

ALTER TABLE turno_palabra ALTER COLUMN conductor_id DROP NOT NULL;
ALTER TABLE turno_palabra ALTER COLUMN dispositivo_id DROP NOT NULL;
ALTER TABLE turno_palabra ADD COLUMN uuid_operador uuid;
ALTER TABLE turno_palabra ADD CONSTRAINT turno_palabra_con_dueno CHECK (
  (conductor_id IS NOT NULL AND dispositivo_id IS NOT NULL AND uuid_operador IS NULL)
  OR (conductor_id IS NULL AND dispositivo_id IS NULL AND uuid_operador IS NOT NULL)
);

ALTER TABLE mensaje_voz ALTER COLUMN conductor_id DROP NOT NULL;
ALTER TABLE mensaje_voz ADD COLUMN de_central boolean NOT NULL DEFAULT false;
ALTER TABLE mensaje_voz ADD CONSTRAINT mensaje_voz_con_voz CHECK (
  conductor_id IS NOT NULL OR de_central
);

COMMENT ON COLUMN turno_palabra.uuid_operador IS
  'El aparato de operador que tiene la palabra cuando habla la Central '
  '(migración 086). O esto, o conductor+dispositivo: nunca ambos, nunca nadie.';

COMMENT ON COLUMN mensaje_voz.de_central IS
  'true si el mensaje lo emitió la Central (migración 086). La voz nunca es '
  'anónima: o hay conductor, o es de la Central.';
