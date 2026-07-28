-- 019 — Revertir la escalada a SSE de los eventos del conductor

UPDATE enrutamiento SET canal_2 = NULL
WHERE rol = 'conductor' AND evento IN (
  'D1_broadcast_solicitud',
  'D2_reclamacion_resuelta',
  'D3_viaje_cerrado_comision',
  'D4_saldo_bajo',
  'D7_suscripcion'
);
