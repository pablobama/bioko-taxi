-- 042 — El recorrido del taxi durante todo el turno.
--
-- Hasta ahora la posición del taxi solo se guardaba llevando un viaje activo
-- (`posicion`, migración 011). El resto del tiempo el móvil la manda cada
-- veinte segundos, el servidor la usa para saber en qué barrio está y la tira.
-- Con eso, el recorrido de un día eran los viajes sueltos y un agujero entre
-- cada dos: no se veía dónde esperó, ni por dónde volvió de vacío, que es
-- justo lo que hace falta para entender por qué un barrio se queda sin taxis.
--
-- Esta tabla guarda el turno entero. Es distinta de `posicion` a propósito:
-- aquélla cuelga de un viaje y es prueba de cómo se hizo un servicio
-- concreto; ésta cuelga del conductor y solo describe por dónde anduvo.
--
-- SOLO EN SERVICIO. Cuando el taxista sale de servicio deja de mandar latidos
-- y aquí deja de haber filas. Su vida fuera del turno no es asunto de nadie.

CREATE TABLE rastro (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conductor_id bigint NOT NULL REFERENCES conductor (id),
  lat          double precision NOT NULL,
  lng          double precision NOT NULL,
  creado_en    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE rastro IS
  'Por dónde anduvo cada taxi mientras estaba en servicio (migración 042). '
  'Se escribe filtrado desde el latido y se borra sola a los N días '
  '(parámetro rastro_retencion_dias).';

-- Todas las consultas son «este conductor, entre estas dos fechas».
CREATE INDEX rastro_conductor_tiempo ON rastro (conductor_id, creado_en);

-- Y la purga es «todo lo anterior a esta fecha», sin conductor.
CREATE INDEX rastro_tiempo ON rastro (creado_en);

-- Guardar un punto cada latido serían 180 filas por hora y taxi: un mes de
-- cien taxis no cabe en el plan que hay contratado, y además no aporta nada
-- —entre dos latidos de un taxi parado solo hay ruido de GPS—. Se filtra al
-- escribir, con tres números que se pueden tocar desde Ajustes sin desplegar:
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('rastro_intervalo_min_seg', '45',
   'Segundos mínimos entre dos puntos del recorrido de un taxi'),
  ('rastro_distancia_min_m', '40',
   'Metros que se tiene que haber movido un taxi para guardar otro punto'),
  ('rastro_anclaje_seg', '300',
   'Aunque no se mueva, se guarda un punto cada tantos segundos: es lo que '
   'distingue «estuvo parado ahí una hora» de «no se sabe»'),
  ('rastro_retencion_dias', '90',
   'Días que se guarda el recorrido de un taxi antes de borrarse solo');
