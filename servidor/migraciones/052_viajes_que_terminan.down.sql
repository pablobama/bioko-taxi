DELETE FROM parametro
 WHERE clave IN ('velocidad_interurbana_kmh', 'eta_tramo_urbano_km',
                 'viaje_maximo_horas', 'recogida_maxima_horas');
