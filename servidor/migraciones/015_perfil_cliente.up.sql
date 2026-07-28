-- 015 — Registro y perfil del pasajero (decisión de sesión, 2026-07-26).
--
-- ADVERTENCIA IMPORTANTE, no borrar: esto NO es autenticación.
--
-- El registro pide teléfono y/o correo, pero no hay forma de comprobar que
-- son suyos: verificar exigiría SMS o correo saliente, y la decisión 3.1
-- descarta cualquier mensajería de pago. Así que cualquiera puede escribir
-- el teléfono de otro. En consecuencia:
--
--   * La identidad sigue siendo el dispositivo (regla 4.2.4). Los strikes y
--     los bloqueos siguen colgando de dispositivo, NO del perfil: si
--     colgaran del teléfono, bastaría con cambiarlo para limpiar el
--     historial.
--   * El perfil es una comodidad (no reescribir el teléfono en cada viaje) y
--     una cortesía (que el taxista sepa a quién llama), no una credencial.
--
-- Si algún día hace falta identidad de verdad, el camino barato es un código
-- por correo electrónico (SMTP propio, sin coste por mensaje). Queda anotado
-- en PENDIENTES.

CREATE TABLE perfil_cliente (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispositivo_id bigint NOT NULL UNIQUE REFERENCES dispositivo (id),
  -- Al menos uno de los dos: es lo único que se pide para registrarse.
  telefono       text,
  correo         text,
  -- Opcionales, se rellenan en ajustes si el usuario quiere.
  nombre         text,
  edad           smallint CHECK (edad BETWEEN 12 AND 120),
  genero         text CHECK (genero IN ('mujer', 'hombre', 'otro', 'sin_decir')),
  creado_en      timestamptz NOT NULL DEFAULT now(),
  actualizado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT perfil_con_algun_contacto
    CHECK (telefono IS NOT NULL OR correo IS NOT NULL)
);

-- Sin UNIQUE en telefono ni correo a propósito: sin verificación, un índice
-- único solo serviría para que el primero que escriba un teléfono impida a su
-- dueño real usarlo. Además, en Malabo es normal compartir un teléfono.
CREATE INDEX perfil_cliente_telefono ON perfil_cliente (telefono)
  WHERE telefono IS NOT NULL;

COMMENT ON TABLE perfil_cliente IS
  'Datos de contacto del pasajero. NO es autenticación: no hay verificación '
  'de teléfono ni de correo. La identidad y la reputación siguen en dispositivo.';
