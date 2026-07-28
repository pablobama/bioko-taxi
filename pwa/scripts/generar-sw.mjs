// Rellena el service worker con la lista de ficheros a precargar.
//
// Vite le pone un hash al nombre de cada fichero en cada publicación, así que
// la lista no se puede escribir a mano: hay que leerla de dist/ después de
// compilar. Se ejecuta solo, enganchado a `npm run construir`.
//
// La versión sale del contenido: si los ficheros no cambian, el nombre de la
// caché tampoco, y los teléfonos no vuelven a descargar nada.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function ficheros(directorio) {
  const encontrados = [];
  for (const entrada of readdirSync(directorio)) {
    const ruta = join(directorio, entrada);
    if (statSync(ruta).isDirectory()) {
      encontrados.push(...ficheros(ruta));
    } else {
      encontrados.push(ruta);
    }
  }
  return encontrados;
}

const todos = ficheros(DIST)
  // El propio service worker no se precarga a sí mismo: lo gestiona el
  // navegador, y meterlo en su propia caché lo dejaría congelado en la versión
  // vieja para siempre.
  .filter((f) => !f.endsWith('sw.js'))
  // La galería de diseños es una herramienta de desarrollo que solo se abre
  // con ?galeria. Precargarla sería gastarle a cada usuario los datos de un
  // trozo que no va a usar nunca, justo lo que este proyecto intenta evitar.
  .filter((f) => !/[\\/]Galeria-[^\\/]+\.js$/.test(f))
  .map((f) => `/${relative(DIST, f).replace(/\\/g, '/')}`)
  .sort();

// Huella del contenido: cambia si cambia cualquier fichero, y solo entonces.
const huella = createHash('sha256');
for (const ruta of todos) {
  huella.update(ruta);
  huella.update(readFileSync(join(DIST, ruta.slice(1))));
}
const version = huella.digest('hex').slice(0, 12);

const destino = join(DIST, 'sw.js');
const plantilla = readFileSync(destino, 'utf8');
const generado = plantilla
  .replace('__VERSION__', version)
  .replace('__RECURSOS__', JSON.stringify(todos, null, 2));

if (generado.includes('__VERSION__') || generado.includes('__RECURSOS__')) {
  throw new Error('El service worker no se pudo rellenar: faltan los marcadores.');
}
writeFileSync(destino, generado);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const peso = todos.reduce((total, r) => total + statSync(join(DIST, r.slice(1))).size, 0);
console.log(`Service worker: versión ${version}, ${todos.length} ficheros precargados (${kb(peso)}).`);
