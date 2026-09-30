DELETE FROM parametro WHERE clave = 'aviso_taxi_libre_min';
DELETE FROM enrutamiento WHERE evento = 'C7_taxi_disponible';
DROP TABLE IF EXISTS espera_taxi;
