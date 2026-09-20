UPDATE enrutamiento
SET canal_2 = NULL
WHERE rol = 'conductor'
  AND canal_2 = 'web';

DROP TABLE suscripcion_web;
DROP TABLE clave_vapid;
