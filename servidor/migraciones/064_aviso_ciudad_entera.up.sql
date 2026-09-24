-- 064 — La oleada 5: avisar a TODOS los taxis cuando nadie la ha cogido (P58-01).
--
-- El reparto es por oleadas y a propósito: el barrio primero, después los
-- vecinos, después los que reciben de toda la isla. Avisar a los cuarenta
-- móviles de la ciudad en cada petición tiene un precio —teléfonos sonando por
-- una carrera a doce kilómetros, y carrera por pulsar primero— y estropearía
-- justo lo que el orden protege: que la coja quien está al lado.
--
-- Pero hay un caso en el que ese precio no existe, y es el que esta migración
-- resuelve: cuando NADIE tiene la carrera en la mano. El barrio está vacío,
-- los vecinos también, los de toda la isla no han contestado, y lo único que
-- va a pasar en los próximos segundos es «no hay taxi». Ahí un móvil que suena
-- en la otra punta de Malabo no le quita la carrera a nadie: es la carrera o
-- nada.
--
-- Por eso la oleada 5 no es «avisar a todos», es «avisar a todos ANTES DE
-- RENDIRSE», y solo se dispara si se cumplen las dos cosas:
--
--   1. Han pasado `oleada_5_seg` desde la emisión (75 s, con la expiración en
--      90: quedan quince segundos para aceptar, suficientes para pulsar).
--   2. No hay NI UNA oferta viva. Si alguien la tiene delante sin contestar
--      todavía, no se convoca a nadie más: su respuesta puede llegar.
--
-- Y una consecuencia que va en la misma dirección: el corte de R1 —el que
-- cierra la petición en el acto cuando la zona está vacía, para que el
-- pasajero no espere noventa segundos en vano— ahora mira la ciudad entera
-- cuando esto está encendido. Cortar a los cero segundos teniendo un taxi
-- libre en Semu sería exactamente el «no hay taxi» que esto viene a evitar.
--
-- LO QUE CUESTA, dicho claro:
--
--   - El pasajero de una zona vacía ya no oye «no hay taxi» a los cero
--     segundos: espera hasta 75 para que le pregunten al resto de la ciudad.
--     Es el cambio, no un efecto secundario — antes esa espera no servía para
--     nada y ahora puede acabar en un taxi.
--   - Durante esos últimos quince segundos, los taxis convocados quedan
--     OFERTADO, y un taxista solo puede tener una oferta delante (P8-03). Si
--     justo entonces entra otra petición, se queda sin a quién ofrecérsela.
--     Con la flota de hoy es un caso raro y dura poco; si algún día hay
--     muchas peticiones a la vez, esto se nota y hay que revisarlo.
--
-- `aviso_ciudad_entera` es el interruptor: a 0 todo esto no existe y el
-- reparto es el de antes, sin tocar código.

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('aviso_ciudad_entera', '1',
   'Si a 1, una carrera que nadie ha cogido se ofrece a todos los taxis en '
   'servicio de la ciudad antes de darla por perdida (migración 064)'),
  ('oleada_5_seg', '75',
   'Segundos desde la emisión tras los cuales, si no hay ninguna oferta viva, '
   'la carrera se ofrece a toda la ciudad (migración 064)'),
  ('oleada_5_max_conductores', '25',
   'Tope de taxis avisados en la oleada 5. Es un tope de cordura, no un '
   'reparto: a estas alturas lo que se busca es que alguien la coja');

-- La oleada 5 necesita sitio en el CHECK, que admitía 0..4 desde la 062.
ALTER TABLE oferta DROP CONSTRAINT oferta_oleada_check;
ALTER TABLE oferta ADD CONSTRAINT oferta_oleada_check CHECK (oleada BETWEEN 0 AND 5);
