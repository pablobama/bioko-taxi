-- 069 — El uuid deja de ser suficiente para ser tú (P15-04).
--
-- Hasta ahora la identidad era el uuid del dispositivo en una cabecera. Quien
-- conociera ese uuid ERA esa persona: podía ver sus viajes, pedir taxis en su
-- nombre, gastar el saldo de un taxista o leer su recorrido. Y el uuid no es
-- un secreto bien guardado: viaja en la URL de la conexión SSE
-- (`?dispositivo=`, porque SSE no admite cabeceras), así que acaba en los
-- registros de cualquier proxy por el que pase.
--
-- Ahora cada dispositivo tiene además un SECRETO: 32 bytes al azar que el
-- servidor entrega UNA vez, guarda solo en forma de hash y exige en cada
-- petición a partir de entonces. Conocer el uuid deja de bastar; hay que
-- tener el secreto, que no se ha escrito en ninguna URL.
--
-- Lo que esto SÍ arregla: suplantar a alguien cuyo uuid se conoce.
-- Lo que NO arregla, y sigue en P15-04: seguir sin ser una cuenta. No hay
-- contraseña, no hay recuperación, y un teléfono robado sigue siendo la
-- sesión de su dueño — como el WhatsApp de ese mismo teléfono. El número está
-- verificado (migración 027) y sirve para recuperar la identidad; el secreto
-- sirve para que nadie se cuele en la sesión que ya existe.
--
-- COMPATIBILIDAD, que aquí es lo delicado: el secreto se exige solo a los
-- dispositivos que TIENEN uno, y solo se emite cuando el cliente lo pide. Una
-- aplicación vieja que no sabe pedirlo sigue funcionando exactamente igual;
-- una nueva lo pide en su primer arranque y queda protegida desde entonces.
-- Así no hay ni un taxista fuera de servicio por un despliegue.

-- EN DESARROLLO, un aviso que cuesta media hora descubrir: las identidades de
-- prueba tienen uuid fijo (`?dispositivo=` en localhost). Si se borra el
-- almacenamiento del navegador, el secreto local se pierde pero el del
-- servidor sigue, y esa identidad queda cerrada para siempre — que es
-- exactamente lo que debe pasarle a un ladrón. Para recuperarla:
--
--   UPDATE dispositivo SET secreto_hash = NULL, secreto_creado_en = NULL
--   WHERE uuid_persistente = '...';
--
-- En producción no se da: el uuid vive en el mismo almacenamiento que el
-- secreto, así que se pierden juntos y el teléfono vuelve como nuevo.

ALTER TABLE dispositivo
  ADD COLUMN secreto_hash text,
  ADD COLUMN secreto_creado_en timestamptz;

COMMENT ON COLUMN dispositivo.secreto_hash IS
  'SHA-256 del secreto de sesión (migración 069). El secreto en claro solo lo '
  'tiene el dispositivo: aquí no se guarda, ni se puede recuperar.';
