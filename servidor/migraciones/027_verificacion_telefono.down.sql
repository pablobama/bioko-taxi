-- 027 — Revertir la verificación de teléfono por SMS.

DELETE FROM parametro WHERE clave = 'verificacion_cooldown_seg';

ALTER TABLE conductor
  DROP COLUMN IF EXISTS telefono_verificado_en,
  DROP COLUMN IF EXISTS verificacion_enviada_en;

ALTER TABLE perfil_cliente
  DROP COLUMN IF EXISTS telefono_verificado_en,
  DROP COLUMN IF EXISTS verificacion_enviada_en;
