DELETE FROM parametro
 WHERE clave IN ('eta_ventana_min', 'eta_muestra_minima_seg', 'eta_muestra_minima_m',
                 'eta_velocidad_minima_kmh', 'eta_velocidad_maxima_kmh');
