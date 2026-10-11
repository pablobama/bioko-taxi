-- 091 — Avisos de tiempo (11/10).
--
-- La app enseña una franja con el tiempo de Malabo: sol, nubes o lluvia, los
-- grados y, cuando toca, un aviso de calor o de lluvia. El tiempo lo trae el
-- servidor de Open-Meteo (gratis, sin clave) y lo cachea unos minutos, así que
-- no hay fila que guardar: el dato es efímero. Lo que SÍ vive aquí son los dos
-- umbrales que deciden cuándo salta cada aviso, para que la central los ajuste
-- desde el panel (Ajustes → parámetros) sin tocar código, como todos los
-- mandos de la plataforma.
--
-- Bioko es ecuatorial: calor húmedo casi todo el año y temporada de lluvias
-- con tormentas. Los umbrales de partida son prudentes y se afinan con el uso.

INSERT INTO parametro (clave, valor, descripcion) VALUES
  ('tiempo_aviso_calor_c', '33',
   'Si la sensación térmica en Malabo alcanza estos grados (°C), la franja del '
   'tiempo muestra aviso de calor. Subirlo hace el aviso más raro'),
  ('tiempo_aviso_lluvia_pct', '60',
   'Si la probabilidad de lluvia en la próxima hora alcanza este porcentaje, la '
   'franja del tiempo muestra aviso de lluvia. Subirlo hace el aviso más raro');
