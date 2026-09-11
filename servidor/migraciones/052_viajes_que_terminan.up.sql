-- 052 — Dos cifras que mentían y un viaje que no terminaba nunca.
--
-- 1. EL TIEMPO DE LLEGADA FUERA DE MALABO. La estimación era línea recta por
--    1,3 y todo a 18 km/h. Dieciocho por hora es la ciudad: semáforos, baches,
--    gente cruzando. Para Malabo–Luba daba 142 minutos cuando se tarda unos
--    cuarenta, y ese número lo vio un pasajero compartiendo su viaje.
--
--    Ahora el trayecto se parte: los primeros kilómetros a velocidad de
--    ciudad, porque salir de Malabo cuesta lo que cuesta, y el resto a
--    velocidad de carretera. Sigue sin haber motor de rutas y sigue siendo una
--    aproximación —se presenta como «unos N minutos»—, pero deja de ser una
--    aproximación absurda en cuanto se sale del casco.
--
-- 2. EL VIAJE SIN FINAL. Un viaje en RECOGIDO no tenía ningún tope. Se cierra
--    de tres maneras: el botón del taxista, el del pasajero, o la separación
--    por GPS; y las tres pueden no ocurrir —el taxista se olvida y el GPS del
--    pasajero deja de mandar en cuanto bloquea la pantalla—. Ahí se queda,
--    para siempre. Quien seguía el viaje por el enlace compartido veía a su
--    familiar «viajando» horas después de haber llegado; el taxista se queda
--    con una plaza ocupada que el reparto nunca le devuelve; y las
--    estadísticas cuentan un viaje abierto que ya no existe.
--
--    Lo mismo con EN_CAMINO: si el taxista no recoge, no declara ausente al
--    pasajero y no cancela, la solicitud se queda colgada igual.
--
--    Se cierran solos pasado un tope generoso. Y con `ocurrio_en` de la 051:
--    el viaje no terminó cuando el sistema se entera, sino en la última señal
--    que hubo: la última posición registrada.

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('velocidad_interurbana_kmh', '70',
   'Velocidad para la parte del trayecto que sale del casco urbano. La '
   'carretera de Luba no es la avenida de la Independencia'),
  ('eta_tramo_urbano_km', '5',
   'Kilómetros del principio de cualquier trayecto que se cuentan a velocidad '
   'de ciudad. Salir de Malabo cuesta lo mismo se vaya donde se vaya'),
  ('viaje_maximo_horas', '4',
   'Un viaje recogido que pase de aquí se cierra solo. En una isla de 70 km '
   'ningún trayecto se acerca; si llega, es que nadie pulsó el botón'),
  ('recogida_maxima_horas', '2',
   'Un taxi de camino que pase de aquí sin recoger se da por no presentado. '
   'No cobra comisión: no hubo viaje');
