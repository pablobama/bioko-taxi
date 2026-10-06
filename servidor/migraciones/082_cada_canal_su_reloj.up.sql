-- 082 — La llamada no espera al reloj del SMS (06/10).
--
-- LO QUE PASÓ. La llamada de verificación (081) existe para cuando el SMS no
-- llega. Pero el freno de sesenta segundos entre códigos era UNO por número,
-- sin distinguir el canal: quien pedía el SMS, veía que no llegaba y pulsaba
-- «llamadme», se encontraba con «espera 40 segundos» — o con un botón apagado.
-- La salida de emergencia estaba detrás de la misma puerta atascada de la que
-- se huía. Se estrenó por la tarde y por la noche ya estaba reportado: «la
-- nueva funcionalidad de llamarme no está funcionando».
--
-- EL ARREGLO: cada canal lleva su propio reloj. Pedir el SMS no bloquea la
-- primera llamada; pedir dos llamadas seguidas sí espera. El coste que el
-- freno protege también es por canal —un SMS no se encarece porque luego haya
-- una llamada— y los topes por hora y por aparato (078) siguen contando los
-- dos canales juntos, que es lo que para al que abusa.

ALTER TABLE intento_cuenta
  ADD COLUMN canal text NOT NULL DEFAULT 'sms'
    CHECK (canal IN ('sms', 'llamada'));

COMMENT ON COLUMN intento_cuenta.canal IS
  'Por dónde se mandó el código (migración 082). El cooldown entre códigos es '
  'por canal: el SMS que no llega no puede bloquear la llamada que lo salva.';

-- Lo mismo en la verificación del alta (migración 027), que lleva su reloj en
-- la propia fila en vez de en intento_cuenta: una columna hermana para la
-- llamada, y la que había se queda para el SMS.
ALTER TABLE conductor ADD COLUMN llamada_verificacion_en timestamptz;
ALTER TABLE perfil_cliente ADD COLUMN llamada_verificacion_en timestamptz;

COMMENT ON COLUMN conductor.llamada_verificacion_en IS
  'Última llamada de verificación (migración 082). Separada de '
  'verificacion_enviada_en por lo mismo que en intento_cuenta: cada canal, su '
  'reloj.';

COMMENT ON COLUMN perfil_cliente.llamada_verificacion_en IS
  'Última llamada de verificación (migración 082). Separada de '
  'verificacion_enviada_en por lo mismo que en intento_cuenta: cada canal, su '
  'reloj.';
