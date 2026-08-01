-- 028 — Aire acondicionado y seguro: check del conductor en su alta.
--
-- El conductor declara si su vehículo tiene aire acondicionado y si está
-- asegurado. El pasajero lo ve como información en la ficha del taxi ya
-- asignado (no es un filtro de búsqueda); el operador puede verlo y
-- corregirlo en la ficha del conductor.
--
-- DEFAULT false: los vehículos ya dados de alta no pasan a declarar que
-- tienen ninguna de las dos cosas solo por existir la columna — hasta que su
-- conductor vuelva a guardar el formulario (o el operador lo marque a mano)
-- no hay dato, y "no hay dato" se representa igual que "no la tiene" a
-- propósito: no hay manera honesta de distinguirlos con lo que se sabe hoy.

ALTER TABLE vehiculo
  ADD COLUMN aire_acondicionado boolean NOT NULL DEFAULT false,
  ADD COLUMN seguro boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN vehiculo.aire_acondicionado IS
  'Declarado por el conductor en su alta. false también significa "no se sabe".';
COMMENT ON COLUMN vehiculo.seguro IS
  'Declarado por el conductor en su alta. false también significa "no se sabe".';
