// Pictograma y color por categoría de sitio del gazetteer (columna
// referencia.categoria, servidor/migraciones/017 y 021).
//
// POR QUÉ DIBUJOS Y NO SIGLAS. Esto empezó con siglas —MK, IG, FA, GB— porque
// el encargo las daba explícitamente como marcadores de posición. Y una sigla
// es letra: quien no lee con soltura no saca nada de «FA», mientras que una
// cruz se entiende sin haber ido a la escuela. En un producto pensado para
// gente con prisa, al sol y a veces sin alfabetizar, esa diferencia es el
// producto entero.
//
// POR QUÉ TRAZADOS A MANO. Ni tipografía de iconos ni ficheros de imagen: son
// catorce dibujos que ocupan menos de 2 KB en total y viajan dentro del propio
// código. Traer una librería costaría más datos que todo el plano de Malabo.
//
// Los colores siguen agrupados por familia —misma luminosidad, hue distinto—
// para que el dibujo y el color digan lo mismo dos veces: quien no distinga
// bien los colores tiene la forma, y a tamaño de pin la forma se pierde antes
// que el color.

export interface EstiloCategoria {
  // Trazado en una rejilla de 24×24. Se dibuja con línea gruesa salvo que
  // `relleno` diga lo contrario: a 12 píxeles, una línea de 2,2 aguanta y un
  // relleno fino se convierte en una mancha.
  icono: string;
  relleno?: boolean;
  color: string;
  // Nombre para lectores de pantalla y para depurar. El visible lo pone i18n.
  nombre: string;
}

const COMERCIO = '#D9B27A';
const SALUD = '#6FBFA8';
const INSTITUCION = '#7FA8D8';
const CULTO_HOTEL = '#A895D8';
const NEUTRO = '#8B8B8A';

export const ESTILO_CATEGORIA: Record<string, EstiloCategoria> = {
  // --- Comercio ------------------------------------------------------------
  // Cesta: es como se compra en los mercados de Malabo.
  mercado: {
    nombre: 'mercado',
    color: COMERCIO,
    icono: 'M9 9a3 3 0 0 1 6 0M3.5 9h17l-1.6 11H5.1z',
  },
  // Surtidor con manguera.
  gasolinera: {
    nombre: 'gasolinera',
    color: COMERCIO,
    icono: 'M4 21V5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v16M2.5 21h12M13 10h3.5a1 1 0 0 1 1 1v5a1.7 1.7 0 0 0 3.4 0V9l-2.2-2.6M6.5 7.5h4',
  },
  // Columnas y frontón: el edificio con el que se dibuja un banco en todas
  // partes. El gobierno lleva bandera para no confundirse con este.
  banco: {
    nombre: 'banco',
    color: COMERCIO,
    icono: 'M2.5 9.5 12 4l9.5 5.5M6 11.5v7M12 11.5v7M18 11.5v7M3.5 20.5h17',
  },
  // Tenedor y cuchillo.
  restaurante: {
    nombre: 'restaurante',
    color: COMERCIO,
    icono: 'M6 3v5a2.5 2.5 0 0 0 5 0V3M8.5 10.5V21M17.5 21V3c2.2 2 2.2 7.5 0 9.5h-1.2',
  },

  // --- Salud y espacios abiertos ------------------------------------------
  // Cruz maciza. La farmacia lleva pastilla, no otra cruz: a este tamaño dos
  // cruces —una llena y otra hueca— serían la misma mancha.
  hospital: {
    nombre: 'hospital',
    color: SALUD,
    relleno: true,
    icono: 'M9.6 2.5h4.8v7.1h7.1v4.8h-7.1v7.1H9.6v-7.1H2.5V9.6h7.1z',
  },
  // Cápsula partida en dos mitades.
  farmacia: {
    nombre: 'farmacia',
    color: SALUD,
    icono: 'M14.6 3.6a5 5 0 0 1 7.1 7.1l-11 11a5 5 0 0 1-7.1-7.1zM7.5 10.7l7.1 7.1',
  },
  // Balón: en Guinea Ecuatorial no hace falta explicarlo.
  deporte: {
    nombre: 'deporte',
    color: SALUD,
    icono: 'M12 2.8a9.2 9.2 0 1 1 0 18.4 9.2 9.2 0 0 1 0-18.4zM12 7.6l4.4 3.2-1.7 5.2H9.3l-1.7-5.2z',
  },
  // Árbol: plazas, parques y paseos.
  plaza: {
    nombre: 'plaza',
    color: SALUD,
    icono: 'M12 21v-6M12 15.5a5.5 5.5 0 1 1 0-11 5.5 5.5 0 0 1 0 11z',
  },

  // --- Instituciones -------------------------------------------------------
  // Birrete.
  escuela: {
    nombre: 'escuela',
    color: INSTITUCION,
    icono: 'M2 9.2 12 4.2l10 5-10 5zM6.2 11.4V16c0 1.7 2.8 3 5.8 3s5.8-1.3 5.8-3v-4.6',
  },
  // Autobús. Vale para el puerto y para cualquier parada que se añada luego.
  transporte: {
    nombre: 'transporte',
    color: INSTITUCION,
    icono: 'M4 16V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10M2.8 16h18.4M8 8.5h8M7 19.2a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2zM17 19.2a1.6 1.6 0 1 1 0-3.2 1.6 1.6 0 0 1 0 3.2z',
  },
  // Bandera.
  gobierno: {
    nombre: 'gobierno',
    color: INSTITUCION,
    icono: 'M6 21.5V3M6 3.5h12.5l-2.8 4.4 2.8 4.4H6',
  },

  // --- Culto y alojamiento -------------------------------------------------
  // Cruz sobre el tejado.
  iglesia: {
    nombre: 'iglesia',
    color: CULTO_HOTEL,
    icono: 'M12 2v4.5M10.2 3.7h3.6M4.8 21v-7.6L12 7.8l7.2 5.6V21z',
  },
  // Cama.
  hotel: {
    nombre: 'hotel',
    color: CULTO_HOTEL,
    icono: 'M3 19.5v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 15.5h18M3 13.5V6.5M7.6 11.2a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4z',
  },

  // --- Sin categoría propia ------------------------------------------------
  // Dos casas: un barrio, no un sitio concreto.
  zona: {
    nombre: 'zona',
    color: NEUTRO,
    icono: 'M2.5 20.5v-5.8l4.2-3.2 4.2 3.2v5.8zM13.1 20.5v-7.6l4.2-3.2 4.2 3.2v7.6z',
  },
  otro: {
    nombre: 'otro',
    color: NEUTRO,
    relleno: true,
    icono: 'M12 8.6a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8z',
  },
};

export function estiloCategoria(categoria: string): EstiloCategoria {
  return ESTILO_CATEGORIA[categoria] ?? ESTILO_CATEGORIA.otro;
}
