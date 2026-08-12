-- 046 — El taxi va a donde está la persona, no al supermercado de al lado.
--
-- Síntoma que lo destapó: se pidió un taxi de pie en la calle y el sistema
-- situó a la persona en un supermercado cercano. Dos causas, y se multiplican.
--
-- PRIMERA: la coordenada del pasajero se guardaba y no la leía nadie.
-- `lat_cliente`/`lng_cliente` están en `solicitud` desde la migración 010 y
-- ningún código las consultaba —solo una prueba—. El punto de recogida era, y
-- solo era, la `referencia` más cercana del catálogo. Medido sobre la malla de
-- sitios de los distritos urbanos, el vecino más cercano está a una mediana de
-- 78 m y en el 10 % de los casos a más de 264 m. Fuera del centro, kilómetros.
-- Ese era el error MÍNIMO del sistema, antes de contar nada más.
--
-- SEGUNDA: el pasajero usaba el peor GPS de toda la aplicación. Sin
-- `enableHighAccuracy`, con 3,5 s de espera y aceptando una lectura de hasta un
-- minuto. Sin alta precisión Android no enciende el GPS: devuelve una posición
-- por wifi y antena, que se va de cientos de metros, y que aterriza justamente
-- en sitios «conocidos» —como un supermercado—. El agente de campo situando un
-- barrio exigía ±50 m; el pasajero, cuya posición decide a dónde va un coche,
-- no exigía nada.
--
-- Esta columna es la mitad del arreglo: guardar CON QUÉ PRECISIÓN se tomó la
-- posición, para poder decidir si se usa o si se cae a la referencia. La otra
-- mitad está en la PWA (coger bien la posición) y en la API (usarla).
--
-- NULL significa «no se sabe»: las solicitudes anteriores a esto, y las que
-- llegan sin GPS. No es cero.

ALTER TABLE solicitud
  ADD COLUMN precision_cliente_m double precision;

COMMENT ON COLUMN solicitud.precision_cliente_m IS
  'Radio de error del GPS con el que el pasajero pidió el taxi, en metros '
  '(migración 046). NULL: no se sabe o no hubo GPS. Decide si el punto de '
  'recogida es la posición real o la referencia del catálogo.';

-- A partir de cuántos metros de error la posición del pasajero deja de servir
-- como punto de recogida y se usa el lugar del catálogo. 120 m es deliberadamente
-- más flojo que los 50 m que se exigen para situar un barrio: un barrio se sitúa
-- una vez y queda para siempre, y aquí lo que se compara no es contra la
-- perfección, es contra pegar a la persona al sitio conocido más cercano —que
-- está a 78 m de mediana—. Con ±120 m la posición real sigue siendo mejor
-- apuesta que el catálogo; por encima, ya no.
INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('recogida_precision_maxima_m', '120',
   'Error máximo del GPS del pasajero para usar su posición como punto de '
   'recogida; por encima se usa la referencia del catálogo');
