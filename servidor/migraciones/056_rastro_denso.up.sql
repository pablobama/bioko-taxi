-- 056 — El recorrido, el doble de denso y la mitad de tiempo guardado.
--
-- Desde el diagnóstico del 15/09 el recorrido se reconstruye por las calles, y
-- el error que queda ya no es de cálculo sino de MUESTREO: con un punto por
-- minuto no se ve la vuelta a la manzana que el coche da entre dos puntos.
-- Medido con `scripts/diagnostico-rastro.ts`, seis simulaciones por calles
-- reales de Malabo:
--
--                           un punto / ~58 s   un punto / ~25 s
--   kilómetros                   −9 %               −4 %
--   velocidad en marcha         −19 %               −8 %
--   tiempo al volante            +4 %                0 %
--
-- EL MÍNIMO VA A 15 s, NO A 20, aunque el latido sea cada 20. El latido no
-- llega exacto: el GPS tarda hasta ocho segundos en fijar y la red suma lo
-- suyo. Con el mínimo en 20, todo latido que llegara a los 19,8 s se tiraría,
-- y se guardaría uno de cada dos: uno cada 40 s, no cada 25. Con 15 aguanta
-- ese desfase y la densidad sale la medida.
--
-- Y LA RETENCIÓN BAJA A 45 DÍAS para que cueste lo mismo. Medido en la base:
-- 219 bytes por fila con sus índices. Un taxi de ocho horas diarias ocupaba
-- ~500 filas al día × 90 días ≈ 9,8 MB; ahora ~1.150 × 45 ≈ 11,3 MB. La vista
-- más larga del panel del operador es de un mes, así que no se pierde nada que
-- se enseñe.
--
-- OJO, no se deshace: en cuanto arranque el servidor con esto, la purga borra
-- el recorrido de hace más de 45 días. Decidido así el 15/09.

UPDATE parametro SET valor = '15',
  descripcion = 'Tiempo mínimo entre dos puntos guardados del recorrido. Por '
    'debajo del latido (20 s) a propósito: el latido no llega exacto y con el '
    'mínimo igual al latido se tiraría uno de cada dos (migración 056)'
WHERE clave = 'rastro_intervalo_min_seg';

UPDATE parametro SET valor = '45',
  descripcion = 'Días que se guarda el recorrido. La vista más larga del panel '
    'del operador es de un mes (migración 056: bajado de 90 para que el '
    'recorrido denso cueste lo mismo)'
WHERE clave = 'rastro_retencion_dias';

-- Si alguna de las dos no existiera, esto no habría hecho nada en silencio y
-- el recorrido seguiría como antes sin que nadie lo supiera.
DO $$
BEGIN
  IF (SELECT count(*) FROM parametro
      WHERE (clave = 'rastro_intervalo_min_seg' AND valor = '15')
         OR (clave = 'rastro_retencion_dias' AND valor = '45')) <> 2 THEN
    RAISE EXCEPTION 'Faltan los parámetros del recorrido: la migración 042 no está aplicada.';
  END IF;
END $$;
