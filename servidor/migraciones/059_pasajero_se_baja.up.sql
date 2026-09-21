-- 059 — El pasajero puede dar por terminado su viaje: «ya me bajé».
--
-- El botón existía en la aplicación desde el principio, pero solo limpiaba la
-- pantalla del pasajero. El viaje seguía abierto por dentro: el taxista con la
-- plaza ocupada y, con el coche lleno, sin recibir carreras, hasta que se
-- acordaba de pulsar «viaje terminado» o hasta que el GPS notaba la
-- separación, que tarda un par de minutos y necesita que los dos móviles
-- manden posición.
--
-- La máquina de estados no lo permitía, y con razón mientras la plataforma
-- cobraba comisión por viaje: cerrar un viaje era cobrar, y eso no lo podía
-- decidir el pasajero. Hoy el taxista paga una suscripción y el viaje se cobra
-- en efectivo, en mano: cerrarlo no le cuesta dinero a nadie. Lo que sí cuesta
-- es NO cerrarlo.
--
-- Solo desde RECOGIDO: un pasajero que todavía espera en la acera no termina
-- nada, cancela —y cancelar tiene su propia regla de gracia—.

INSERT INTO transicion_valida (ambito, estado_origen, estado_destino, actor, disparador) VALUES
  ('solicitud', 'RECOGIDO', 'COMPLETADO', 'cliente', 'El pasajero pulsa «ya me bajé»');
