DELETE FROM mensaje_voz WHERE de_central;
DELETE FROM turno_palabra WHERE uuid_operador IS NOT NULL;
ALTER TABLE mensaje_voz DROP CONSTRAINT IF EXISTS mensaje_voz_con_voz;
ALTER TABLE mensaje_voz DROP COLUMN IF EXISTS de_central;
ALTER TABLE mensaje_voz ALTER COLUMN conductor_id SET NOT NULL;
ALTER TABLE turno_palabra DROP CONSTRAINT IF EXISTS turno_palabra_con_dueno;
ALTER TABLE turno_palabra DROP COLUMN IF EXISTS uuid_operador;
ALTER TABLE turno_palabra ALTER COLUMN conductor_id SET NOT NULL;
ALTER TABLE turno_palabra ALTER COLUMN dispositivo_id SET NOT NULL;
