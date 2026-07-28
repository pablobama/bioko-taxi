-- 019 — Aviso inmediato al taxista en el panel web (decisión de sesión).
--
-- Problema: el panel web del taxista solo consultaba el estado cada 20 s, así
-- que una carrera podía tardar eso en aparecer. Con una ventana de 90 s, es un
-- cuarto del tiempo perdido y el conductor cree que la app no funciona.
--
-- Solución: los eventos del conductor escalan a SSE. Su canal principal sigue
-- siendo FCM, que es el único que le llega con la pantalla apagada (decisión
-- 3.3); SSE entra cuando FCM falla o no está configurado, que es justo el caso
-- del panel web y el del entorno de desarrollo sin credenciales de Firebase.
--
-- Límite conocido: si FCM funciona, el panel web NO recibe el evento (la
-- escalada solo se dispara si el canal 1 falla). Para el piloto está bien: el
-- panel web es herramienta de pruebas y los taxistas de verdad usan la app
-- Android. Si algún día hubiera que entregar por los dos a la vez, habría que
-- añadir entrega múltiple al bus, no otra escalada.

UPDATE enrutamiento SET canal_2 = 'sse'
WHERE rol = 'conductor' AND evento IN (
  'D1_broadcast_solicitud',
  'D2_reclamacion_resuelta',
  'D3_viaje_cerrado_comision',
  'D4_saldo_bajo',
  'D7_suscripcion'
);
