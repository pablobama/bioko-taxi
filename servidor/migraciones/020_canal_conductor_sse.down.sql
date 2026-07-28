-- 020 — Devolver los eventos del conductor a FCM como canal principal

UPDATE enrutamiento
SET canal_1 = 'fcm', canal_2 = NULL
WHERE rol = 'conductor' AND canal_1 = 'sse';
