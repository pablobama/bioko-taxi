-- 049 — El turno dura hasta que el taxista lo termina, no hasta que el móvil
-- pierde la cobertura.
--
-- Lo que pasaba: `caducarPresencias` sacaba de servicio a cualquiera cuyo
-- último latido tuviera más de dos minutos. Dos minutos es NADA. Un túnel, un
-- ascensor, el ahorro de batería de Android durmiendo la aplicación, un
-- iPhone con la pantalla bloqueada (P47-01): en cualquiera de esos casos el
-- taxista salía de servicio sin enterarse, y volvía a la aplicación creyendo
-- que trabajaba mientras el reparto ni le miraba.
--
-- Y no hacía ninguna falta para proteger al pasajero, que era el motivo por el
-- que se hizo así. El reparto YA filtra por latido fresco por su cuenta
-- (`candidatos`, y `taxisCercaDe` para el conteo): a un móvil apagado no se le
-- ofrece una carrera aunque su presencia diga DISPONIBLE. Sacarlo de servicio
-- encima era una segunda cerradura sobre una puerta ya cerrada, y la que se
-- llevaba por delante al taxista.
--
-- Ahora estar en servicio es una DECLARACIÓN del taxista, y solo él la
-- retira. Quedan dos salvaguardas:
--
--   - Un aviso cada hora en su pantalla. Lleva la ubicación encendida, y eso
--     gasta batería y le sigue: tiene derecho a que se lo recuerden en vez de
--     descubrirlo al día siguiente. Es también la ocasión de decir «sí, sigo».
--   - Y una red de seguridad muy larga: a las doce horas sin dar señales se
--     da el turno por abandonado. No es sacarle de servicio, es reconocer que
--     ese móvil no va a volver — un turno no dura medio día— y evitar que el
--     panel del operador cuente taxis que no existen para siempre.

ALTER TABLE presencia
  ADD COLUMN en_servicio_desde timestamptz,
  -- Última vez que se le avisó de que lleva la ubicación encendida. Sin esto,
  -- el aviso saldría en cada latido: cada veinte segundos, para siempre.
  ADD COLUMN avisado_turno_en timestamptz;

COMMENT ON COLUMN presencia.en_servicio_desde IS
  'Cuándo entró en servicio esta vez (migración 049). NULL si está fuera. '
  'De aquí sale el aviso de turno largo y el abandono.';

-- Los que ya estuvieran en servicio al desplegar: se les da por empezados
-- ahora, no en un pasado que nadie sabe. Fingir una hora de entrada
-- inventada dispararía el aviso o el abandono sin motivo.
UPDATE presencia SET en_servicio_desde = now() WHERE estado <> 'DESCONECTADO';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('aviso_turno_horas', '1',
   'Cada cuántas horas se le recuerda al taxista que sigue en servicio y con '
   'la ubicación encendida'),
  ('abandono_servicio_horas', '12',
   'Horas sin un solo latido tras las que se da el turno por abandonado. Es '
   'una red de seguridad contra móviles que no vuelven, no el fin del turno: '
   'de eso se encarga el taxista');
