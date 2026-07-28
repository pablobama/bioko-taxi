// Barrios de Malabo y pueblos de Bioko Norte.
//
// Origen de los datos: OpenStreetMap (nodos `place` y `landuse` con nombre),
// contrastado con Nominatim, GeoNames y es.wikipedia. Cada entrada lleva el
// identificador OSM del que salieron sus coordenadas, para poder volver a la
// fuente. Coordenadas a 5 decimales (~1 m).
//
// Sin efectos secundarios al importar: lo usan importar-barrios.ts e
// importar-pois-reales.ts (que necesita saber cuáles son las zonas reales para
// no mezclarlas con las que deja la batería de pruebas).
//
// Tres cosas que conviene saber antes de tocar esta lista:
//
//   1. OSM tiene los barrios como PUNTOS, no como polígonos. El centroide vale
//      para elegir zona de trabajo y para el reparto por cercanía, pero nadie
//      puede decir todavía si una dirección concreta cae dentro o fuera.
//   2. Varios barrios ya urbanos (Caracolas, Paraíso, Buena Esperanza,
//      Sampaka) siguen etiquetados como `place=village` en OSM. La etiqueta
//      está desfasada; aquí van como barrio.
//   3. El centro histórico se llama SANTA ISABEL. «Malabo Centro» es el nombre
//      con el que nació este sistema y el que usan la semilla y la demo, así
//      que se conserva como nombre de zona y «Santa Isabel» queda de alias.

export interface Barrio {
  nombre: string;
  // Cómo lo llama la gente además de por su nombre: variantes ortográficas,
  // nombres coloniales, castellanizaciones. Alimentan la búsqueda difusa.
  alias?: string[];
  lat: number;
  lng: number;
  // `barrio` = dentro de la ciudad de Malabo.
  // `periferia` = pueblo o núcleo de Bioko Norte fuera de la ciudad.
  tipo: 'barrio' | 'periferia';
  // De dónde salen las coordenadas.
  fuente: string;
}

export const BARRIOS: Barrio[] = [
  // --- Ciudad de Malabo -----------------------------------------------------
  {
    nombre: 'Malabo Centro',
    alias: ['Santa Isabel', 'Centro', 'el centro', 'Sainte-Élisabeth'],
    lat: 3.75416, lng: 8.77997, tipo: 'barrio', fuente: 'OSM node/3804151924',
  },
  {
    nombre: 'Ela Nguema',
    alias: ['Elá Nguema', 'San Fernando', 'Ciudad de Ela Nguema', 'ngema'],
    lat: 3.75681, lng: 8.7996, tipo: 'barrio', fuente: 'OSM node/3804151914',
  },
  {
    nombre: 'Semu',
    alias: ['Semú'],
    lat: 3.73785, lng: 8.78375, tipo: 'barrio', fuente: 'OSM node/6130222086',
  },
  {
    nombre: 'Área Presidencial',
    alias: ['Area Presidencial', 'Zona Presidencial'],
    lat: 3.75867, lng: 8.78579, tipo: 'barrio', fuente: 'OSM node/3804151918',
  },
  {
    nombre: 'Santa María',
    alias: ['Santa Maria'],
    lat: 3.73975, lng: 8.76626, tipo: 'barrio', fuente: 'OSM node/12134018604',
  },
  {
    nombre: 'La Begoña',
    alias: ['La Begoña 1', 'Begoña'],
    lat: 3.74479, lng: 8.81239, tipo: 'barrio', fuente: 'OSM node/11137498288',
  },
  {
    nombre: 'Alcaide',
    lat: 3.74517, lng: 8.7883, tipo: 'barrio', fuente: 'OSM node/11617741961',
  },
  {
    nombre: 'Los Ángeles',
    alias: ['Los Angeles'],
    lat: 3.74824, lng: 8.77778, tipo: 'barrio', fuente: 'OSM node/3144381629',
  },
  {
    nombre: 'Caribe',
    lat: 3.75728, lng: 8.73985, tipo: 'barrio', fuente: 'OSM node/12134018603',
  },
  {
    nombre: 'Malabo II',
    alias: ['Malabo 2', 'Nueva Ciudad', 'New Town'],
    lat: 3.7385, lng: 8.74968, tipo: 'barrio', fuente: 'OSM node/2805241502',
  },
  {
    nombre: 'Caracolas',
    lat: 3.7495, lng: 8.77061, tipo: 'barrio', fuente: 'OSM node/3128530820',
  },
  {
    nombre: 'Paraíso',
    alias: ['Paraiso'],
    lat: 3.75023, lng: 8.75492, tipo: 'barrio', fuente: 'OSM node/3128530821',
  },
  {
    nombre: 'Buena Esperanza',
    lat: 3.74042, lng: 8.80772, tipo: 'barrio', fuente: 'OSM node/3124730056',
  },
  {
    nombre: 'Sampaka',
    alias: ['Sampaca'],
    lat: 3.72165, lng: 8.74887, tipo: 'barrio', fuente: 'OSM node/3119810961',
  },
  {
    nombre: 'Banapá',
    alias: ['Banapa'],
    lat: 3.73007, lng: 8.77819, tipo: 'barrio', fuente: 'OSM node/6485996751',
  },
  {
    nombre: 'Barrio Chino',
    lat: 3.74966, lng: 8.77969, tipo: 'barrio', fuente: 'OSM way/1201226804',
  },
  {
    nombre: 'Nuevos Ministerios',
    lat: 3.73588, lng: 8.76103, tipo: 'barrio', fuente: 'OSM way/1202248644',
  },
  {
    nombre: 'Seis Casas',
    lat: 3.73338, lng: 8.77033, tipo: 'barrio', fuente: 'OSM way/1037088190',
  },
  {
    nombre: 'Urbanización San Juan',
    alias: ['San Juan', 'Urbanizacion San Juan'],
    lat: 3.73814, lng: 8.79695, tipo: 'barrio', fuente: 'OSM way/691242651',
  },
  {
    nombre: 'Vitacana Makeda',
    alias: ['Torrejón', 'Torrejon', 'Móstoles', 'Mostoles', 'Vitacana'],
    lat: 3.72576, lng: 8.77698, tipo: 'barrio', fuente: 'OSM way/691240804',
  },
  {
    nombre: 'Puerto Viejo',
    lat: 3.76021, lng: 8.78406, tipo: 'barrio', fuente: 'OSM node/3119810960',
  },
  {
    nombre: 'Puerto Nuevo',
    lat: 3.76091, lng: 8.77782, tipo: 'barrio', fuente: 'OSM node/3119810959',
  },

  // --- Periferia de Bioko Norte --------------------------------------------
  {
    nombre: 'Sipopo',
    lat: 3.76218, lng: 8.89194, tipo: 'periferia', fuente: 'OSM node/2771184355',
  },
  {
    nombre: 'Basupú Fishtown',
    alias: ['Fiston', 'Basupí Fiston', 'Basupu Fishtown', 'Bacipú', 'Fishtown'],
    lat: 3.73266, lng: 8.81177, tipo: 'periferia', fuente: 'OSM node/3124730055',
  },
  {
    nombre: 'Rebola',
    lat: 3.72789, lng: 8.83617, tipo: 'periferia', fuente: 'OSM node/366513007',
  },
  {
    nombre: 'Basilé',
    alias: ['Basile', 'Basilé Radio', 'Basilé Bubi'],
    lat: 3.70127, lng: 8.80739, tipo: 'periferia', fuente: 'OSM node/2886414987',
  },
  {
    nombre: 'Sacriba',
    alias: ['Sácriba', 'Shack-River'],
    lat: 3.71812, lng: 8.71033, tipo: 'periferia', fuente: 'OSM node/12640704114',
  },
  {
    nombre: 'Basupú del Oeste',
    alias: ['Basupu del Oeste', 'Basupú'],
    lat: 3.71835, lng: 8.68558, tipo: 'periferia', fuente: 'OSM node/2886414986',
  },
  {
    nombre: 'Baney',
    alias: ['Santiago de Baney', 'Laka-Baney'],
    lat: 3.70129, lng: 8.91023, tipo: 'periferia', fuente: 'OSM node/2414597604',
  },
  {
    nombre: 'Batoicopo',
    alias: ['Batikopo'],
    lat: 3.64047, lng: 8.63979, tipo: 'periferia', fuente: 'OSM node/3132347946',
  },
  {
    nombre: 'Basacato del Oeste',
    alias: ['Basakato del Oeste', 'Basacato'],
    lat: 3.59454, lng: 8.6238, tipo: 'periferia', fuente: 'OSM node/3132347945',
  },
  {
    nombre: 'Basacato del Este',
    alias: ['Basakato del Este'],
    lat: 3.62393, lng: 8.90034, tipo: 'periferia', fuente: 'OSM node/2414597601',
  },
  {
    nombre: 'Alegría',
    alias: ['Alegria'],
    lat: 3.68659, lng: 8.66064, tipo: 'periferia', fuente: 'OSM node/12635702057',
  },
  {
    nombre: 'Apú',
    alias: ['Apu'],
    lat: 3.69221, lng: 8.66392, tipo: 'periferia', fuente: 'OSM node/12635702056',
  },
  {
    nombre: 'Borriloco',
    lat: 3.70838, lng: 8.67339, tipo: 'periferia', fuente: 'OSM node/12635702058',
  },
  {
    nombre: 'Nale',
    lat: 3.67864, lng: 8.65079, tipo: 'periferia', fuente: 'OSM node/12635702055',
  },
  {
    nombre: 'Basapo',
    alias: ['Basopo'],
    lat: 3.65524, lng: 8.64314, tipo: 'periferia', fuente: 'OSM node/12635702054',
  },
  {
    nombre: 'Balorei',
    lat: 3.67621, lng: 8.6376, tipo: 'periferia', fuente: 'OSM node/3116563087',
  },
  {
    nombre: 'Topé',
    alias: ['Tope'],
    lat: 3.68574, lng: 8.91744, tipo: 'periferia', fuente: 'OSM node/2962017951',
  },
  {
    nombre: 'Cupapa',
    lat: 3.66519, lng: 8.91964, tipo: 'periferia', fuente: 'OSM node/2962017935',
  },
  {
    nombre: 'Baresó',
    alias: ['Bareso'],
    lat: 3.65483, lng: 8.91745, tipo: 'periferia', fuente: 'OSM node/2414597579',
  },
  {
    nombre: 'Basuala',
    alias: ['Basuala Misión'],
    lat: 3.64542, lng: 8.91972, tipo: 'periferia', fuente: 'OSM node/2414597377',
  },
  {
    nombre: 'Baó Basuala',
    alias: ['Bao Basuala', 'Baho Basuala'],
    lat: 3.63901, lng: 8.9117, tipo: 'periferia', fuente: 'OSM node/3132347947',
  },
  {
    nombre: 'Bososo',
    lat: 3.60189, lng: 8.88753, tipo: 'periferia', fuente: 'OSM node/3132347949',
  },
  {
    nombre: 'Bariobe',
    alias: ['Bariobé', 'Bariaobe'],
    lat: 3.58617, lng: 8.86798, tipo: 'periferia', fuente: 'OSM node/3132347944',
  },
  {
    nombre: 'Bacake Grande',
    alias: ['Bacaké Grande'],
    lat: 3.56155, lng: 8.85355, tipo: 'periferia', fuente: 'OSM node/3132347942',
  },
  {
    nombre: 'Bacake Pequeño',
    alias: ['Bacaké Pequeño', 'Bacake Pequeno'],
    lat: 3.57072, lng: 8.85748, tipo: 'periferia', fuente: 'OSM node/3132347943',
  },
];

// Barrios de Malabo atestiguados en prensa y fuentes escritas, pero que NO
// están en ningún catálogo geográfico: ni OSM, ni Nominatim, ni GeoNames los
// tienen. Se dejan FUERA de la base de datos a propósito.
//
// La tentación es colocarlos en las coordenadas de algún sitio cercano que sí
// esté mapeado (el río Timbabé, las Viviendas Sociales Banapá, el edificio
// Abayak). No se hace: un punto de recogida mal puesto manda un taxi a otro
// sitio, y un dato inventado es peor que un dato ausente. Salen aquí para que
// el operador los levante sobre el terreno con la herramienta del gazetteer.
export const BARRIOS_SIN_COORDENADAS = [
  { nombre: 'Campo Yaundé', alias: ['New Billy', 'New Bili', 'Campo Yaoundé'], donde: 'entre Los Ángeles, la UNGE y la avenida Hasán II' },
  { nombre: 'Comandachina', alias: ['Kumdá Kiná'], donde: 'reasentamiento de la zona Udubuandjolo' },
  { nombre: 'Pérez', donde: 'parroquia junto a Ríocopua, Timbabé y Banapá' },
  { nombre: 'Ríocopua', alias: ['Riocopúa'], donde: 'misma parroquia que Pérez' },
  { nombre: 'Timbabé', donde: 'junto al río Timbabé' },
  { nombre: 'Servicio', donde: 'colinda con Campo Yaundé' },
  { nombre: 'Campamento', alias: ['Cruce Esono Edjo'], donde: 'antiguo límite sur de la ciudad' },
  { nombre: 'Abayak', donde: 'al oeste de Malabo' },
];

// Nombres que circulan como «barrios» y no lo son. Se anotan para que nadie
// vuelva a intentar cargarlos: gastar una hora en descubrirlo dos veces es
// tiempo tirado.
export const NO_SON_BARRIOS = [
  { nombre: 'Ewaiso', queEs: 'una plaza peatonal en Los Ángeles' },
  { nombre: 'Lampert', queEs: 'una comisaría en la avenida de Alcaide' },
  { nombre: 'Balboa', queEs: 'la calle del Alcalde Abilio Balboa' },
  { nombre: 'Punta Europa', queEs: 'el cabo y la zona industrial de gas, no residencial' },
  { nombre: 'Nuevo Bata', queEs: 'sin rastro en ninguna fuente; probable confusión con la ciudad de Bata' },
  { nombre: 'Ela Nguema II', queEs: 'sin rastro como entidad aparte de Ela Nguema' },
  { nombre: 'Pilar Buepoyo', queEs: 'el Centro Integrado Pilar Buepoyo, un colegio' },
];

// Las zonas reales del sistema, por nombre. Sirve para distinguirlas de las
// zonas efímeras que deja la batería de pruebas en la base de desarrollo
// («Zona A <uuid>», «Zona Prueba <uuid>»…).
export const NOMBRES_ZONAS_REALES: string[] = BARRIOS.map((b) => b.nombre);
