DELETE FROM transicion_valida
WHERE ambito = 'solicitud' AND estado_origen = 'RECOGIDO'
  AND estado_destino = 'COMPLETADO' AND actor = 'cliente';
