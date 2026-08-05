# Volcados de OpenStreetMap

`osm-bioko-2026-08-05.json` es la respuesta de Overpass a la consulta que hace
`scripts/importar-osm-bioko.ts` sobre el recuadro de Bioko, tal cual, el 5 de
agosto de 2026. 991 elementos.

Está aquí porque los espejos públicos de Overpass son gratis y se comportan
como tal: limitan por IP y se saturan a ratos. Dar de alta doscientos lugares
en producción no puede depender de que hoy contesten, y sobre todo: **es el
volcado exacto del que salieron los recuentos que se revisaron antes de
aplicar nada**. Ejecutar contra él da el mismo resultado que se aprobó, no lo
que OSM tenga hoy.

```
npx tsx --env-file=.env scripts/importar-osm-bioko.ts --desde datos/osm-bioko-2026-08-05.json
```

Sin `--desde`, el script consulta Overpass en vivo. Eso es lo que hay que
hacer para traer novedades; para repetir una carga ya revisada, el volcado.

Los datos son de OpenStreetMap y están bajo ODbL: se pueden redistribuir
citando la fuente, que es lo que hace este fichero y lo que la aplicación debe
seguir haciendo allá donde los muestre.
