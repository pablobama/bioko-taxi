-- 058 — Que al taxista le suene la carrera con la aplicación cerrada.
--
-- Hasta hoy los eventos del taxista salían SOLO por SSE, que es una conexión
-- abierta: existe mientras la pantalla está encendida y el navegador en
-- primer plano. Un taxista que use la PWA y cierre el navegador —o que
-- simplemente bloquee el móvil— no se enteraba de nada, y la oferta le
-- caducaba en veinte segundos sin que la viera. Desde fuera parece que la
-- aplicación no reparte carreras.
--
-- La app Android ya lo resuelve con FCM, pero no todos los taxistas la tienen
-- (y en iPhone no la habrá). Lo que funciona en los dos sitios son las
-- notificaciones web estándar: VAPID + Push API, que el navegador entrega
-- aunque la página esté cerrada porque las entrega el sistema operativo, no
-- la página.
--
-- Dos tablas y un cambio de enrutamiento:
--
--   suscripcion_web  A qué buzón hay que escribir para llegar a cada
--                    dispositivo. Lo da el navegador y no es un secreto
--                    nuestro, pero sí es un identificador de un dispositivo
--                    concreto: va con RLS como todo lo demás.
--
--   clave_vapid      El par de claves con el que se firman los envíos. Se
--                    genera solo la primera vez que hace falta y se guarda
--                    aquí, NO en la tabla parametro: parametro se enseña
--                    entero en el panel del operador y una clave privada no
--                    se enseña en ninguna pantalla. Tampoco en variables de
--                    entorno, que en Render habría que configurar a mano y
--                    perder en cada proyecto nuevo.

CREATE TABLE clave_vapid (
  -- Una sola fila, y que la base de datos lo garantice.
  id         boolean PRIMARY KEY DEFAULT true CHECK (id),
  publica    text NOT NULL,
  privada    text NOT NULL,
  creado_en  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE clave_vapid ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE clave_vapid IS
  'Par de claves VAPID para firmar las notificaciones web (migración 058). '
  'Una sola fila. La genera el servidor la primera vez que envía.';

CREATE TABLE suscripcion_web (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dispositivo_id bigint NOT NULL REFERENCES dispositivo (id) ON DELETE CASCADE,
  -- La URL del buzón del navegador. Única: si el mismo navegador se vuelve a
  -- suscribir, es la MISMA suscripción y no una segunda.
  endpoint      text NOT NULL UNIQUE,
  clave_p256dh  text NOT NULL,
  clave_auth    text NOT NULL,
  creado_en     timestamptz NOT NULL DEFAULT now(),
  -- Última vez que el buzón aceptó un envío, para poder ver de un vistazo
  -- cuáles están vivos.
  usado_en      timestamptz,
  ultimo_error  text
);

ALTER TABLE suscripcion_web ENABLE ROW LEVEL SECURITY;

CREATE INDEX suscripcion_web_dispositivo ON suscripcion_web (dispositivo_id);

COMMENT ON TABLE suscripcion_web IS
  'Buzones de notificación web por dispositivo (migración 058). Los borra el '
  'servidor cuando el navegador contesta 404 o 410: el buzón ya no existe.';

-- El aviso del taxista pasa a tener DOS canales. Sigue mandando la conexión
-- abierta —es instantánea y no cuesta datos—, y cuando no la hay se escala a
-- la notificación web, que es justo el caso que no estaba cubierto: la
-- aplicación cerrada.
--
-- Solo los eventos que hay que ver AHORA. Un aviso de saldo bajo o de
-- suscripción no justifica encender la pantalla de nadie: esos se quedan en
-- la conexión abierta y se ven al abrir la aplicación.
UPDATE enrutamiento
SET canal_2 = 'web'
WHERE rol = 'conductor'
  AND canal_1 = 'sse'
  AND evento IN ('D1_broadcast_solicitud', 'D2_reclamacion_resuelta');
