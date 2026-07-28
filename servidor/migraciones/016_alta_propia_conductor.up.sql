-- 016 — Alta propia del conductor y carrocería (decisión de sesión, 2026-07-26).
--
-- Hasta ahora los conductores los daba de alta el operador. Ahora se registran
-- ellos desde la app: nombre, teléfono, correo, matrícula, marca y carrocería.
--
-- SALVAGUARDA IMPORTANTE: quien se registra queda en estado_verificacion
-- 'pendiente' y NO recibe ofertas (el despacho exige 'verificado'). Si no
-- fuera así, cualquiera se daría de alta como taxi y empezaría a recibir
-- pasajeros sin que nadie haya visto su coche ni sus papeles. La verificación
-- la hace el operador (paso 9); mientras tanto hay una orden de consola.

ALTER TABLE vehiculo
  ADD COLUMN carroceria text
    CHECK (carroceria IN ('turismo', '4x4'));

COMMENT ON COLUMN vehiculo.carroceria IS
  'Turismo o 4x4. En Malabo importa: hay barrios donde solo entra un 4x4.';

-- El correo del conductor: hasta ahora no se guardaba.
ALTER TABLE conductor ADD COLUMN correo text;

-- La matrícula ya era única. El teléfono también, y es la clave natural con la
-- que el conductor vuelve a entrar (recordatorio: sin verificar, igual que el
-- del pasajero; ver PENDIENTES P15-04).
