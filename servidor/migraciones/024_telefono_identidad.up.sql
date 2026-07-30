-- 024 — El teléfono como clave de identidad (decisión de sesión, 2026-07-30).
--
-- QUÉ CAMBIA. Un número, una identidad, y el número queda unido al
-- dispositivo que lo tiene ahora. Antes:
--
--   - El conductor ya tenía UNIQUE en el teléfono, pero SIN normalizar: la
--     misma persona podía acabar con dos fichas —cada una con su monedero y su
--     reputación— según si tecleó «+240222410986» o «222410986».
--   - El pasajero no tenía ninguna unicidad, y sus sanciones colgaban solo del
--     dispositivo. Borrar los datos del navegador daba un uuid nuevo y una
--     identidad limpia: tres avisos y un bloqueo se esquivaban reinstalando.
--
-- LO QUE SIGUE SIENDO VERDAD, Y HAY QUE DECIRLO (P15-04): el número NO se
-- verifica. Nadie manda un código. Así que el teléfono es una LLAVE, no una
-- prueba de identidad: sirve para que tu propia reinstalación te devuelva tu
-- cuenta, no para demostrar que el número es tuyo. Quien teclee el número de
-- otro se lleva sus sanciones —que es un castigo, no un premio, y por eso no
-- hay incentivo para hacerlo— pero también puede hacer que bloqueen a un
-- inocente. El operador puede desbloquear, así que el daño es reversible.
--
-- LO QUE A PROPÓSITO **NO** SE HEREDA AL RECLAMAR UN NÚMERO: el historial de
-- viajes. Las sanciones sí, el historial no. Si el historial viajara con el
-- número, cualquiera que conozca tu teléfono podría ver a dónde sueles ir con
-- solo teclearlo, y eso es una fuga de privacidad mucho peor que el problema
-- que esta migración resuelve. Consecuencia asumida y honesta: al reinstalar,
-- «tus destinos de siempre» empiezan de cero aunque el bloqueo te siga.
--
-- COMPARTIR UN TELÉFONO. La migración 015 no puso UNIQUE en parte porque en
-- Malabo es normal compartir un número, y eso sigue siendo cierto: a partir
-- de ahora, el segundo teléfono que declare el mismo número se queda con él y
-- el primero pasa a `telefono_vigente = false`. No se pierde nada (la fila y
-- su historial siguen ahí), pero la cuenta se la queda quien lo declaró
-- último. Si eso resulta ser un problema real en el piloto, la salida es dar
-- al operador una pantalla para separar los dos.

-- --- Conductores: normalizar sin merged automático ------------------------
--
-- Se comprueba ANTES de tocar nada: si dos fichas de conductor colapsaran en
-- el mismo número, fusionarlas significaría decidir qué monedero y qué
-- reputación sobreviven, y eso no lo puede decidir una migración a ciegas.
-- Mejor parar y que una persona lo mire.
DO $$
DECLARE
  colisiones int;
BEGIN
  SELECT count(*) INTO colisiones FROM (
    SELECT regexp_replace(regexp_replace(telefono, '[^0-9]', '', 'g'), '^(00240|240)', '')
    FROM conductor
    GROUP BY 1 HAVING count(*) > 1
  ) c;
  IF colisiones > 0 THEN
    RAISE EXCEPTION
      'Hay % número(s) de conductor que colapsan al normalizar. Fusionar fichas '
      'implica decidir qué monedero y qué reputación sobreviven: hazlo a mano '
      'antes de aplicar esta migración.', colisiones;
  END IF;
END $$;

-- Forma canónica +240XXXXXXXXX, la misma que produce normalizarTelefono() en
-- src/dominio/telefono.ts. Los números de fuera se quedan con sus dígitos.
UPDATE conductor SET telefono = CASE
  WHEN length(regexp_replace(regexp_replace(telefono, '[^0-9]', '', 'g'), '^(00240|240)', '')) = 9
    THEN '+240' || regexp_replace(regexp_replace(telefono, '[^0-9]', '', 'g'), '^(00240|240)', '')
  ELSE '+' || regexp_replace(regexp_replace(telefono, '[^0-9]', '', 'g'), '^00', '')
END;

-- --- Pasajeros: un número, un dispositivo vigente ------------------------

ALTER TABLE perfil_cliente
  ADD COLUMN telefono_vigente boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN perfil_cliente.telefono_vigente IS
  'true si este dispositivo es el que tiene AHORA ese número. Al reclamar el '
  'número desde otro dispositivo, el anterior pasa a false: no se borra nada, '
  'pero solo uno puede tenerlo vigente.';

UPDATE perfil_cliente SET telefono = CASE
  WHEN length(regexp_replace(regexp_replace(telefono, '[^0-9]', '', 'g'), '^(00240|240)', '')) = 9
    THEN '+240' || regexp_replace(regexp_replace(telefono, '[^0-9]', '', 'g'), '^(00240|240)', '')
  ELSE '+' || regexp_replace(regexp_replace(telefono, '[^0-9]', '', 'g'), '^00', '')
END
WHERE telefono IS NOT NULL;

-- Los duplicados que ya existían: se queda el número el dispositivo con
-- actividad más reciente (y a falta de viajes, el creado más tarde). Los demás
-- conservan su fila, su historial y su teléfono, pero dejan de ser los
-- vigentes de ese número.
WITH ordenados AS (
  SELECT pc.id,
         row_number() OVER (
           PARTITION BY pc.telefono
           ORDER BY (
             SELECT max(s.creada_en) FROM solicitud s
             WHERE s.dispositivo_cliente_id = pc.dispositivo_id
           ) DESC NULLS LAST,
           pc.dispositivo_id DESC
         ) AS puesto
  FROM perfil_cliente pc
  WHERE pc.telefono IS NOT NULL
)
UPDATE perfil_cliente pc SET telefono_vigente = false
FROM ordenados o
WHERE o.id = pc.id AND o.puesto > 1;

-- La unicidad de verdad: un número no puede estar vigente en dos sitios.
CREATE UNIQUE INDEX perfil_cliente_telefono_vigente
  ON perfil_cliente (telefono)
  WHERE telefono IS NOT NULL AND telefono_vigente;
