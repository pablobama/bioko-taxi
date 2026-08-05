// Trae de OpenStreetMap los sitios de Bioko entera y los propone para el
// gazetteer. El catálogo actual salió de un recorte de 3 × 4 km alrededor del
// centro de Malabo (importar-pois-reales.ts, bbox=8.765,3.745,8.795,3.780);
// por eso Luba, Riaba, Baney y Sácriba están vacíos: nunca se miraron.
//
// NO FIJA NADA. Todo lo que entra por aquí se guarda sin precisión de GPS, o
// sea marcado «⚠ sin verificar sobre el terreno» en el panel (migración 038).
// Un punto de OSM es una pista de dónde está algo, no la prueba: la prueba es
// un agente delante del sitio pulsando «estoy aquí». Lo que esto cambia es
// que el agente deja de tener que descubrir y pasa a confirmar.
//
// Los datos son de OpenStreetMap, bajo ODbL: obligan a citar la fuente allá
// donde se muestren. La app ya lo hace; si algún día deja de hacerlo, esto no
// se puede seguir ejecutando.
//
// Uso:
//   tsx scripts/importar-osm-bioko.ts               ← solo mira y cuenta
//   tsx scripts/importar-osm-bioko.ts --escribir    ← aplica
//   tsx scripts/importar-osm-bioko.ts --desde x.json  ← desde un volcado
//
// Sin --escribir no toca la base de datos: enseña qué haría y por qué.
//
// --desde lee un volcado guardado de Overpass en vez de consultarlo. Los
// espejos públicos limitan por IP y se caen a ratos, y no es plan de que el
// alta de cuatrocientos sitios dependa de que hoy contesten: se guarda la
// respuesta una vez y se trabaja sobre ella las veces que haga falta.

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { urlBaseDatos } from '../src/bd/migrar.js';

// El mismo recuadro que valida el panel (migración 038): Bioko entera, y solo
// Bioko. Deja fuera el continente y Annobón, que no son este servicio.
const BIOKO = { sur: 3.18, oeste: 8.38, norte: 3.81, este: 8.99 };

// Más allá de esto, el sitio está en una parte de la isla donde todavía no hay
// ningún barrio en el catálogo. Colgarlo del barrio «más cercano» a quince
// kilómetros sería mentir: el reparto mandaría taxis desde otro pueblo. Se
// listan aparte para dar de alta antes el barrio que les corresponde.
const DISTANCIA_MAXIMA_M = 6000;

const ESPEJOS_OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Solo lo que alguien pediría en un taxi. Un contenedor de basura y una boca
// de riego también están en OSM y no ayudan a nadie a llegar a ningún sitio.
const CATEGORIA_POR_ETIQUETA: Record<string, string> = {
  'amenity=restaurant': 'restaurante',
  'amenity=fast_food': 'restaurante',
  'amenity=cafe': 'restaurante',
  'amenity=bar': 'restaurante',
  'amenity=pub': 'restaurante',
  'amenity=nightclub': 'restaurante',
  'amenity=marketplace': 'mercado',
  'amenity=bank': 'banco',
  'amenity=bureau_de_change': 'banco',
  'amenity=fuel': 'gasolinera',
  'amenity=pharmacy': 'farmacia',
  'amenity=hospital': 'hospital',
  'amenity=clinic': 'hospital',
  'amenity=doctors': 'hospital',
  'amenity=school': 'escuela',
  'amenity=college': 'escuela',
  'amenity=university': 'escuela',
  'amenity=kindergarten': 'escuela',
  'amenity=place_of_worship': 'iglesia',
  'amenity=police': 'gobierno',
  'amenity=townhall': 'gobierno',
  'amenity=courthouse': 'gobierno',
  'amenity=embassy': 'gobierno',
  'amenity=post_office': 'gobierno',
  'amenity=bus_station': 'transporte',
  'amenity=ferry_terminal': 'transporte',
  'amenity=taxi': 'transporte',
  'tourism=hotel': 'hotel',
  'tourism=guest_house': 'hotel',
  'tourism=hostel': 'hotel',
  'tourism=motel': 'hotel',
  'tourism=attraction': 'plaza',
  'tourism=museum': 'plaza',
  'tourism=viewpoint': 'plaza',
  'leisure=stadium': 'deporte',
  'leisure=sports_centre': 'deporte',
  'leisure=pitch': 'deporte',
  'leisure=park': 'plaza',
  'office=government': 'gobierno',
  'office=diplomatic': 'gobierno',
  'healthcare=hospital': 'hospital',
  'healthcare=clinic': 'hospital',
  'healthcare=pharmacy': 'farmacia',
};

// Un pueblo o un barrio de OSM no es un lugar: sería una ZONA, y crear zonas
// cambia la topología del reparto (vecinas, oleadas). Eso no lo decide un
// script: se listan al final para que el operador diga cuáles son de verdad.
const ETIQUETAS_DE_SITIO = ['place=city', 'place=town', 'place=village',
  'place=hamlet', 'place=suburb', 'place=neighbourhood', 'place=quarter',
  'place=locality'];

interface Elemento {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const CONSULTA = `[out:json][timeout:170];
(
  nwr["amenity"](${BIOKO.sur},${BIOKO.oeste},${BIOKO.norte},${BIOKO.este});
  nwr["shop"](${BIOKO.sur},${BIOKO.oeste},${BIOKO.norte},${BIOKO.este});
  nwr["tourism"](${BIOKO.sur},${BIOKO.oeste},${BIOKO.norte},${BIOKO.este});
  nwr["office"](${BIOKO.sur},${BIOKO.oeste},${BIOKO.norte},${BIOKO.este});
  nwr["healthcare"](${BIOKO.sur},${BIOKO.oeste},${BIOKO.norte},${BIOKO.este});
  nwr["leisure"](${BIOKO.sur},${BIOKO.oeste},${BIOKO.norte},${BIOKO.este});
  nwr["place"](${BIOKO.sur},${BIOKO.oeste},${BIOKO.norte},${BIOKO.este});
);
out center tags;`;

const esperar = (ms: number) => new Promise((listo) => { setTimeout(listo, ms); });

// Los espejos públicos de Overpass son gratis y se comportan como tal: se
// saturan a ratos, y contestan el error en HTML con código 200 en vez de un
// código de error. Se prueban por turno y se reintenta con calma antes de
// rendirse. No se acelera: el 429 es suyo, y insistir más rápido lo empeora.
async function traerDeOverpass(): Promise<Elemento[]> {
  let ultimoError = '';
  for (let ronda = 0; ronda < 3; ronda += 1) {
    if (ronda > 0) {
      process.stderr.write(`Esperando 60 s antes de reintentar (${ultimoError})…\n`);
      await esperar(60_000);
    }
    for (const espejo of ESPEJOS_OVERPASS) {
      const abortar = new AbortController();
      const reloj = setTimeout(() => abortar.abort(), 180_000);
      try {
        process.stderr.write(`Consultando ${new URL(espejo).host}…\n`);
        const respuesta = await fetch(espejo, {
          method: 'POST',
          body: new URLSearchParams({ data: CONSULTA }),
          signal: abortar.signal,
        });
        const texto = await respuesta.text();
        if (respuesta.status === 429) {
          ultimoError = 'demasiadas consultas seguidas desde esta IP';
          continue;
        }
        if (!texto.trimStart().startsWith('{')) {
          ultimoError = texto.includes('too busy') || texto.includes('timeout')
            ? 'el espejo está saturado'
            : `respuesta inesperada (${respuesta.status})`;
          continue;
        }
        return JSON.parse(texto).elements as Elemento[];
      } catch (error) {
        ultimoError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(reloj);
      }
    }
  }
  throw new Error(
    `Ningún espejo de Overpass contestó: ${ultimoError}. `
    + 'Vuelve a intentarlo dentro de un rato.',
  );
}

function categoriaDe(tags: Record<string, string>): string | null {
  for (const [clave, valor] of Object.entries(tags)) {
    const categoria = CATEGORIA_POR_ETIQUETA[`${clave}=${valor}`];
    if (categoria !== undefined) return categoria;
  }
  // Cualquier tienda con nombre vale como referencia aunque no se sepa de qué
  // tipo: «déjame en Casa Pedro» funciona igual sin saber que vende zapatos.
  if (tags.shop !== undefined) return 'otro';
  return null;
}

function esSitio(tags: Record<string, string>): boolean {
  return ETIQUETAS_DE_SITIO.includes(`place=${tags.place}`);
}

// «Área Presidencial» se escribe de dos maneras que se ven idénticas: con la
// Á de una pieza (lo que teclea cualquiera, y lo que hay en la base) o con una
// A y un acento aparte, que es como llegan algunos nombres de OSM. Sin
// normalizar, el mismo sitio entra por duplicado y un pueblo que ya es zona se
// anuncia como nuevo.
const clave = (nombre: string) => nombre.normalize('NFC').toLocaleLowerCase('es');

function metrosEntre(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

async function main() {
  const escribir = process.argv.includes('--escribir');
  let volcado: string | null = null;
  if (process.argv.includes('--desde')) {
    volcado = process.argv[process.argv.indexOf('--desde') + 1] ?? '';
    if (volcado === '' || volcado.startsWith('--')) {
      throw new Error('--desde necesita la ruta de un volcado JSON de Overpass.');
    }
  }
  const pool = new pg.Pool({ connectionString: urlBaseDatos() });

  try {
    // Los barrios reales y situados: son los únicos de los que puede colgar un
    // lugar. `distrito IS NOT NULL` deja fuera las miles de zonas efímeras que
    // acumula la base de desarrollo con la batería de pruebas — las reales
    // tienen distrito desde la migración 029.
    const barrios = (await pool.query(
      `SELECT id, nombre, centroide_lat AS lat, centroide_lng AS lng
       FROM zona
       WHERE zona_padre_id IS NULL AND distrito IS NOT NULL
         AND centroide_lat IS NOT NULL AND centroide_lng IS NOT NULL`,
    )).rows as Array<{ id: number; nombre: string; lat: number; lng: number }>;
    if (barrios.length === 0) {
      throw new Error('No hay barrios situados. Ejecuta antes npm run bd:migrar.');
    }

    const elementos = volcado !== null
      ? (JSON.parse(readFileSync(volcado, 'utf8')).elements as Elemento[])
      : await traerDeOverpass();
    process.stderr.write(
      `OSM ${volcado !== null ? `(volcado ${volcado})` : ''} devolvió ${elementos.length} elementos.\n\n`,
    );

    const candidatos: Array<{
      nombre: string; lat: number; lng: number; categoria: string;
      barrio: { id: number; nombre: string }; metros: number;
    }> = [];
    const sitios: string[] = [];
    let sinNombre = 0;
    let sinCoordenadas = 0;
    let sinCategoria = 0;
    let lejos = 0;
    const lejanos: string[] = [];
    const vistos = new Set<string>();

    for (const elemento of elementos) {
      const tags = elemento.tags ?? {};
      const lat = elemento.lat ?? elemento.center?.lat;
      const lng = elemento.lon ?? elemento.center?.lon;
      if (lat === undefined || lng === undefined) { sinCoordenadas += 1; continue; }

      // Un nombre es lo único que hace útil a una referencia: nadie escribe
      // «cajero sin rótulo» en el buscador.
      const nombre = (tags['name:es'] ?? tags.name ?? '').trim().normalize('NFC');
      if (nombre === '') { sinNombre += 1; continue; }

      if (esSitio(tags)) { sitios.push(nombre); continue; }

      const categoria = categoriaDe(tags);
      if (categoria === null) { sinCategoria += 1; continue; }

      // OSM tiene el mismo sitio como nodo y como edificio con frecuencia.
      if (vistos.has(clave(nombre))) continue;
      vistos.add(clave(nombre));

      let barrio = barrios[0];
      let metros = Infinity;
      for (const b of barrios) {
        const d = metrosEntre(lat, lng, b.lat, b.lng);
        if (d < metros) { metros = d; barrio = b; }
      }
      if (metros > DISTANCIA_MAXIMA_M) {
        lejos += 1;
        if (lejanos.length < 15) lejanos.push(`${nombre} (${Math.round(metros / 1000)} km)`);
        continue;
      }
      candidatos.push({ nombre, lat, lng, categoria, barrio, metros });
    }

    // Qué es nuevo de verdad. La identidad de un sitio es su NOMBRE, no su
    // pareja (zona, nombre): el Mercado Central sigue siendo el mismo aunque
    // al redibujar los barrios cambie de zona. Reinsertarlo lo duplicaría en
    // el buscador y la copia nueva empezaría con el contador de usos a cero.
    const yaEstan = new Set(
      // Se traen todos y se comparan aquí, no con un WHERE: el `lower()` de
      // Postgres no normaliza los acentos, y filtrar allí dejaría pasar como
      // nuevo lo que ya está escrito de la otra manera.
      (await pool.query('SELECT nombre FROM referencia')).rows
        .map((f: { nombre: string }) => clave(f.nombre)),
    );
    const nuevos = candidatos.filter((c) => !yaEstan.has(clave(c.nombre)));

    const porCategoria = new Map<string, number>();
    const porBarrio = new Map<string, number>();
    for (const c of nuevos) {
      porCategoria.set(c.categoria, (porCategoria.get(c.categoria) ?? 0) + 1);
      porBarrio.set(c.barrio.nombre, (porBarrio.get(c.barrio.nombre) ?? 0) + 1);
    }
    const ordenados = (m: Map<string, number>) =>
      [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join('  ');

    // Un volcado pedido con «out tags» en vez de «out center tags» no trae
    // geometría, y sin ella todo se cae por el mismo sitio: el resultado sería
    // «0 nuevos», que se lee como «no hay nada que hacer» en vez de como «este
    // fichero no sirve». Se dice.
    if (sinCoordenadas > elementos.length / 2) {
      throw new Error(
        `${sinCoordenadas} de ${elementos.length} elementos vienen sin coordenadas. `
        + 'El volcado se pidió sin geometría: hace falta «out center tags;».',
      );
    }

    console.log(`Descartados: ${sinNombre} sin nombre, ${sinCategoria} que nadie pediría`
      + ` en un taxi, ${lejos} lejos de todo barrio conocido`
      + `${sinCoordenadas > 0 ? `, ${sinCoordenadas} sin coordenadas` : ''}.`);
    console.log(`Ya en el catálogo: ${candidatos.length - nuevos.length}.`);
    console.log(`\nNUEVOS: ${nuevos.length}`);
    console.log(`  por categoría: ${ordenados(porCategoria)}`);
    console.log(`  por barrio:    ${ordenados(porBarrio)}`);

    if (lejanos.length > 0) {
      console.log('\nSin barrio cerca (hay que dar de alta el barrio primero):');
      console.log(`  ${lejanos.join(', ')}${lejos > lejanos.length ? `, y ${lejos - lejanos.length} más` : ''}`);
    }

    // La mitad de los pueblos de OSM ya son zona aquí: sacarlos convierte una
    // lista de setenta y nueve nombres, casi toda ruido, en la de los que
    // faltan de verdad.
    const conocidos = new Set(
      (await pool.query('SELECT nombre FROM zona')).rows
        .map((f: { nombre: string }) => clave(f.nombre)),
    );
    const sitiosNuevos = [...new Set(sitios)]
      .filter((s) => !conocidos.has(clave(s)))
      .sort((a, b) => a.localeCompare(b, 'es'));

    if (sitiosNuevos.length > 0) {
      console.log(`\nPueblos y barrios que OSM conoce y aquí no son zona (${sitiosNuevos.length}).`);
      console.log('  NO se dan de alta: crear una zona cambia el reparto, y eso lo decides tú.');
      console.log(`  ${sitiosNuevos.join(', ')}`);
    }

    if (!escribir) {
      console.log('\n(Nada escrito. Repite con --escribir para aplicarlo.)');
      return;
    }

    for (const c of nuevos) {
      // precision_gps_m se queda NULL a propósito: sale marcado «sin verificar
      // sobre el terreno» hasta que alguien vaya y lo confirme.
      await pool.query(
        `INSERT INTO referencia (zona_id, nombre, lat, lng, categoria)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (zona_id, nombre) DO NOTHING`,
        [c.barrio.id, c.nombre, c.lat, c.lng, c.categoria],
      );
    }
    console.log(`\n${nuevos.length} lugares dados de alta, todos sin verificar sobre el terreno.`);
    console.log('Datos de OpenStreetMap, bajo ODbL.');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
