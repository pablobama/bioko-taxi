-- 085 — La numeración de taxis nace APAGADA (06/10).
--
-- El operador, el mismo día del estreno: «ponme una opción para activarlo
-- como obligatorio o desactivarlo; por ahora no lo quiero activado». El
-- interruptor es un parámetro, como todos los mandos de esta plataforma: se
-- enciende desde el panel (Ajustes → parámetros), sin desplegar nada.
--
-- Y SE BORRA LO QUE REPARTIÓ LA 084. Parece contradecir el «para siempre»,
-- pero no lo hace: esa regla protege números que alguien USA — dictados por
-- radio, pintados en una puerta. Los de la 084 vivieron unas horas en una
-- columna que ninguna pantalla llegó a enseñar en producción encendida, y
-- conservarlos tendría un coste real: el día que el operador encienda la
-- numeración, los números bajos ya estarían «ocupados para siempre» por un
-- reparto que nadie pidió, y la casilla de «el número que el coche ya lleva
-- pintado» nacería inservible. Se parte de cero: cuando se encienda, el
-- primero será A000 de verdad.

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('numero_taxi_activado', '0',
   'Si vale 1, cada alta de taxista recibe su número de flota (A000, A001…) '
   'y se puede dictar a mano uno ya pintado (migración 084). Con 0, nadie '
   'recibe número. Los ya repartidos no se tocan al apagar: para siempre es '
   'para siempre desde que se enciende');

UPDATE conductor SET numero_taxi = NULL;
UPDATE parametro SET valor = '0' WHERE clave = 'numero_taxi_siguiente';
