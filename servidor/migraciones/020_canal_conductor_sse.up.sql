-- 020 — Los eventos del conductor salen de verdad (decisión de sesión).
--
-- Diagnóstico: el taxista no veía la carrera hasta recargar la página. La
-- causa NO era el sondeo: era que sus eventos estaban enrutados a «noop».
--
-- «noop» se puso a mano en desarrollo para que el servidor no fallara sin
-- credenciales de Firebase. El problema es que noop ENTREGA CON ÉXITO sin
-- hacer nada: el bus lo da por bueno, no escala al canal 2, y el evento se
-- pierde pareciendo que salió. Un adaptador que finge éxito es peor que uno
-- que falla, porque no deja rastro del que se perdió.
--
-- Configuración correcta HOY (sin credenciales FCM, panel web como interfaz
-- del taxista): canal_1 = sse.
--
-- Configuración cuando exista FCM y la app Android esté repartida, con un solo
-- UPDATE y sin desplegar:
--   UPDATE enrutamiento SET canal_1 = 'fcm', canal_2 = 'sse'
--   WHERE rol = 'conductor';
-- Así el aviso llega al móvil aunque tenga la pantalla apagada, y el panel web
-- lo recibe cuando FCM falla.

UPDATE enrutamiento
SET canal_1 = 'sse', canal_2 = NULL
WHERE rol = 'conductor'
  AND canal_1 IN ('noop', 'fcm')
  AND evento IN (
    'D1_broadcast_solicitud',
    'D2_reclamacion_resuelta',
    'D3_viaje_cerrado_comision',
    'D4_saldo_bajo',
    'D5_recarga_confirmada',
    'D7_suscripcion'
  );
