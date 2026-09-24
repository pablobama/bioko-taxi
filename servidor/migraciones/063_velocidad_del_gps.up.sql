-- 063 — Guardar la velocidad que MIDE el GPS, en vez de suponerla (P56-02).
--
-- El informe «al volante» dice cuánto tiempo estuvo el taxi circulando y a qué
-- velocidad. Hasta ahora eso se deducía: entre dos puntos separados un minuto
-- no se sabe cuánto de ese minuto fue un semáforo, así que el tiempo en marcha
-- se estimaba con la velocidad típica de cada clase de calle del enrutador. Si
-- en Malabo se va más deprisa que esa tabla, el tiempo al volante sale largo y
-- la velocidad, corta.
--
-- Pero el móvil no lo deduce: lo MIDE. `coords.speed` en el navegador y
-- `Location.getSpeed()` en Android vienen del propio receptor —del efecto
-- Doppler sobre la señal, no de restar dos posiciones— y son mucho mejores que
-- cualquier cuenta a posteriori. Sobre todo para lo que peor se deduce: saber
-- si el coche estaba PARADO en el instante de la lectura.
--
-- Va como columna opcional a propósito:
--   - Un teléfono sin fijación buena no la da (`speed` llega a null o NaN).
--   - Las versiones de la aplicación que ya están en la calle no la mandan, y
--     tienen que poder seguir subiendo su recorrido sin cambiar nada.
--   - El recorrido viejo no la tiene y no se puede inventar.
-- Por eso el cálculo la USA cuando está y sigue estimando cuando no.
--
-- `real` y no `numeric`: son cuatro bytes por fila en la tabla que más crece de
-- la base, y medio kilómetro por hora de resolución sobra para esto.

ALTER TABLE rastro ADD COLUMN velocidad_kmh real
  CHECK (velocidad_kmh >= 0 AND velocidad_kmh <= 300);

COMMENT ON COLUMN rastro.velocidad_kmh IS
  'Velocidad que midió el GPS en el instante de la lectura, en km/h '
  '(migración 063). NULL si el teléfono no la dio o es una app antigua.';
