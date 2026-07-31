-- 027 — Verificar el teléfono por SMS (Twilio Verify).
--
-- Revierte la decisión 3.1 (SMS prohibido por coste): probado en producción
-- que Twilio Verify entrega a Guinea Ecuatorial sin registro A2P 10DLC y con
-- un coste asumido, se decide verificar el teléfono de TODOS los usuarios,
-- no solo de los conductores. Ver PENDIENTES.md para el contexto completo:
-- [P15-04] seguía siendo cierto ("el teléfono es una LLAVE, no una PRUEBA")
-- hasta ahora.
--
-- No hay migración retroactiva de datos: toda fila existente queda con
-- telefono_verificado_en NULL, que es exactamente "sin verificar". La app
-- pide verificar en el siguiente uso; no hace falta tocar filas.
--
-- verificacion_enviada_en es solo el cooldown de reenvío (evitar gastar SMS
-- a lo tonto pulsando "reenviar" varias veces seguidas). Twilio Verify ya
-- limita los intentos de comprobación y caduca el código por su cuenta.

ALTER TABLE conductor
  ADD COLUMN telefono_verificado_en timestamptz,
  ADD COLUMN verificacion_enviada_en timestamptz;

ALTER TABLE perfil_cliente
  ADD COLUMN telefono_verificado_en timestamptz,
  ADD COLUMN verificacion_enviada_en timestamptz;

COMMENT ON COLUMN conductor.telefono_verificado_en IS
  'Cuándo se confirmó el código Twilio Verify de este teléfono. NULL = sin verificar.';
COMMENT ON COLUMN perfil_cliente.telefono_verificado_en IS
  'Cuándo se confirmó el código Twilio Verify de este teléfono. NULL = sin '
  'verificar, o pasajero que solo dio correo (no aplica: exento del gate).';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('verificacion_cooldown_seg', '60',
   'Segundos que hay que esperar entre dos envíos de código de verificación al mismo teléfono');
