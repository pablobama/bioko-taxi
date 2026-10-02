DELETE FROM parametro WHERE clave IN (
  'recuperacion_activada', 'recuperacion_consultas_hora',
  'recuperacion_cooldown_seg', 'recuperacion_intentos_codigo'
);
DROP TABLE IF EXISTS intento_cuenta;
