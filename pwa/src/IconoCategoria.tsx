// Pictograma de una categoría de sitio.
//
// El mismo dibujo sirve en las listas (buscador, destinos de un toque) y en el
// plano. Los trazados viven en categorias.ts; esto solo los pinta.
//
// Lleva etiqueta de accesibilidad con el nombre de la categoría: un dibujo se
// entiende sin leer, pero un lector de pantalla no ve dibujos.

import { estiloCategoria } from './categorias';
import type { crearT } from './i18n';

type T = ReturnType<typeof crearT>;

export interface PropiedadesIcono {
  categoria: string;
  // Lado en píxeles. Por defecto el de una fila de lista.
  tamano?: number;
  t: T;
}

export default function IconoCategoria({ categoria, tamano = 22, t }: PropiedadesIcono) {
  const { icono, relleno, color, nombre } = estiloCategoria(categoria);
  return (
    <svg
      className="icono-categoria"
      width={tamano}
      height={tamano}
      viewBox="0 0 24 24"
      role="img"
      aria-label={t(`categoria.${nombre}`)}
    >
      <path
        d={icono}
        fill={relleno ? color : 'none'}
        stroke={relleno ? 'none' : color}
        strokeWidth={2.1}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
