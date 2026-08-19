-- 048 — El operador también conduce, y quiere que le lleguen carreras.
--
-- Dos cosas que pidió quien opera esto, y que van juntas porque solas no
-- sirven de nada.
--
-- PRIMERA: poder ser taxista desde la misma pestaña. El conmutador de papeles
-- ya cambia entre pasajero, taxista y operador, pero el papel de taxista
-- estrenaba un dispositivo sin conductor detrás, así que caía en la pantalla
-- de alta — y para darse de alta hace falta un teléfono que YA esté dado de
-- alta como conductor, cosa que el operador no tiene. Se quedaba fuera. La
-- ruta `/api/operador/mi-taxi` prepara ese conductor de una vez.
--
-- SEGUNDA: recibir carreras aunque no esté en la zona. El reparto ofrece a
-- quien está DISPONIBLE en el barrio del pasajero (oleadas 1 y 2) y luego en
-- los vecinos (oleada 3). Quien opera esto está en su oficina y quiere probar
-- el flujo entero sin mudarse al barrio de cada solicitud.
--
-- La oleada 4 es la respuesta, y su orden importa: llega DESPUÉS de las tres
-- normales, así que un taxi «de cualquier zona» no le quita nunca una carrera
-- a un taxista que está de verdad al lado del pasajero. Solo entra cuando
-- nadie más la ha cogido, que es justo antes de que la solicitud muera sin
-- oferta. Para el pasajero es mejor que nada; para el taxista de al lado no
-- cambia nada.

ALTER TABLE conductor
  ADD COLUMN recibe_en_cualquier_zona boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN conductor.recibe_en_cualquier_zona IS
  'Recibe solicitudes de toda la isla, no solo de su barrio y los vecinos '
  '(migración 048). Solo en la última oleada, para no quitarle carreras a '
  'quien está cerca. Lo activa el operador; pensado para él y para pruebas.';

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('oleada_4_seg', '45',
   'Segundos desde la emisión para ofrecer a los conductores que reciben en '
   'cualquier zona. Va después de la oleada 3 a propósito'),
  ('oleada_4_max_conductores', '3',
   'Cuántos conductores de «cualquier zona» reciben una solicitud');

-- `oferta.oleada` admitía 1..3 desde la migración 005. La cuarta necesita
-- sitio: sin esto, la primera oferta de «cualquier zona» revienta contra el
-- CHECK en producción, y lo hace dentro del planificador —donde el error se
-- traga en un log y la solicitud se queda sin oferta sin que nadie lo sepa—.
-- Lo cazó la batería antes de salir.
ALTER TABLE oferta DROP CONSTRAINT oferta_oleada_check;
ALTER TABLE oferta ADD CONSTRAINT oferta_oleada_check CHECK (oleada BETWEEN 1 AND 4);
