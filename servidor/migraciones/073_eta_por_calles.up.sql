-- 073 — El tiempo hasta destino deja de dividir por una media que incluye
--        estar parado esperando (diagnóstico del 28/09).
--
-- EL CASO, contado por quien conducía: una carrera de unos 7 km que la
-- aplicación marcaba en 35 minutos al empezar y que se hizo en 15. La
-- aplicación dio por hecho 12 km/h y el taxi fue a 28.
--
-- POR QUÉ PASABA. Desde la 053 el tiempo se calcula con «la velocidad que
-- lleva este taxi», y esa velocidad era kilómetros partido por tiempo
-- TRANSCURRIDO en los últimos minutos. Para un coche en marcha está bien: las
-- paradas del semáforo entran en el número y eso es justo lo que hay que
-- predecir. Pero un taxi no está en marcha todo el rato: espera en la parada
-- del mercado, espera a que salga el pasajero, espera. Y esa espera entraba en
-- la misma media. Un taxista que estuvo diez minutos parado y luego condujo
-- diez a 25 km/h «va a 12,5 km/h», y con eso se le estimaba el viaje entero.
--
-- LO QUE SE HACE AHORA, en dos piezas que ya existían y no se habían juntado:
--
--   1. El PLANO sabe cuánto se tarda. El grafo de calles devuelve, además de
--      la distancia, el tiempo a la velocidad típica de cada clase de vía
--      (`segundosTipicos`): una avenida no es una calle del centro. Eso pasa a
--      ser la base del cálculo en vez de «distancia partido por una velocidad
--      única».
--
--   2. Al taxista se le mide un FACTOR, no una velocidad: cuánto más rápido o
--      más lento va él que lo que supone el plano, contando solo el tiempo EN
--      MARCHA —el mismo que ya separa el informe «al volante» desde la 063,
--      con la velocidad que mide el GPS—. Si en Malabo se va más deprisa que
--      la tabla del enrutador, el factor sale mayor que uno y el tiempo baja
--      para todos los viajes de ese taxista.
--
--   Y al resultado se le suma una holgura explícita por las paradas del
--   camino (`eta_factor_paradas`), que antes entraba de rondón en la media y
--   sin que nadie supiera cuánta era.
--
-- Lo que NO cambia: sigue sin haber servicio de tráfico en vivo, así que un
-- atasco de verdad no se ve hasta que el taxi entra en él. Y el factor es del
-- taxista, no de la ruta: quien acaba de venir por la avenida y se mete en el
-- centro llevará unos minutos con el factor de la avenida.

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('eta_usa_plano', '1',
   'Si a 1, el tiempo hasta destino sale del tiempo típico de las calles del '
   'plano corregido por el factor del taxista (migración 073). A 0 vuelve al '
   'cálculo de antes: distancia partido por una velocidad'),
  ('eta_factor_paradas', '115',
   'Holgura por las paradas del camino, en porcentaje: 115 = el tiempo de '
   'marcha por 1,15. Antes esto entraba escondido en la media y nadie sabía '
   'cuánto era'),
  ('eta_factor_min', '50',
   'Suelo del factor del taxista, en porcentaje. 50 = por mucho que se haya '
   'medido, nunca se le supone menos de la mitad de lo que dice el plano'),
  ('eta_factor_max', '200',
   'Techo del factor del taxista, en porcentaje. Dos veces lo que dice el '
   'plano es ya conducir por una carretera vacía: más, es una medida rota'),
  ('eta_marcha_minima_seg', '60',
   'Segundos EN MARCHA que hacen falta en la ventana para creerse el factor '
   'de un taxista. Con menos manda el plano tal cual. Un minuto es una '
   'muestra fina, pero el factor va acotado entre la mitad y el doble de lo '
   'que dice el plano, así que una muestra pobre no puede hacer mucho daño — '
   'y en el momento de recoger, un minuto o dos es todo lo que suele haber');
