// Si hay conexión con el servidor o no.
//
// Por qué hace falta distinguirlo. En Malabo la cobertura va y viene, así que
// «no llego al servidor» es un estado NORMAL, no una avería. Hasta ahora se
// confundía con cualquier otro fallo y el pasajero acababa leyendo «Failed to
// fetch» en mitad de la espera de su taxi. Son cosas distintas y piden cosas
// distintas: ante un error del servidor no hay nada que hacer; sin cobertura,
// esperar unos metros más allá suele bastar.
//
// Cómo se decide. `navigator.onLine` no vale por sí solo: dice que sí en cuanto
// hay wifi, aunque esa wifi no llegue a ninguna parte. Así que se combina con
// lo único que de verdad lo demuestra —si la última petición llegó o no— y el
// aviso del navegador solo sirve para reaccionar antes.

import { useEffect, useState } from 'react';

let hayConexion = typeof navigator === 'undefined' || navigator.onLine;
const suscriptores = new Set<(hay: boolean) => void>();

function anunciar(nuevo: boolean): void {
  if (nuevo === hayConexion) return;
  hayConexion = nuevo;
  for (const avisar of suscriptores) avisar(nuevo);
}

// Las llama api.ts con el resultado de cada petición: es la señal fiable.
export function marcarConexionViva(): void {
  anunciar(true);
}

export function marcarConexionCaida(): void {
  anunciar(false);
}

export function hayConexionAhora(): boolean {
  return hayConexion;
}

if (typeof window !== 'undefined') {
  // El navegador avisa antes de que falle una petición, así que la banda
  // aparece en cuanto se pierde la cobertura y no en el siguiente intento.
  window.addEventListener('offline', () => anunciar(false));
  // Volver a tener wifi no demuestra que se llegue al servidor: eso lo dirá la
  // siguiente petición. Se cree solo lo que se comprueba.
  window.addEventListener('online', () => {
    if (navigator.onLine) anunciar(true);
  });
}

export function useConexion(): boolean {
  const [hay, setHay] = useState(hayConexion);
  useEffect(() => {
    setHay(hayConexion);
    suscriptores.add(setHay);
    return () => { suscriptores.delete(setHay); };
  }, []);
  return hay;
}

// Fallo de red, para distinguirlo de un error que manda el servidor. El
// servidor respondiendo «no puedes cancelar» es información útil que hay que
// enseñar; no haber llegado al servidor no lo es.
export class ErrorDeRed extends Error {
  constructor() {
    super('Sin conexión con el servidor.');
    this.name = 'ErrorDeRed';
  }
}

// Qué enseñar dentro de la hoja cuando algo falla.
//
// Si fue la red, nada: ya lo dice la banda de arriba, y repetirlo dentro
// sería decir dos veces lo mismo tapando lo que la persona estaba mirando.
// Si respondió el servidor, su mensaje tal cual: «expiró hace 7 segundos» o
// «quedan 40 segundos» es justo lo que hay que leer.
export function mensajeDeError(error: unknown, respaldo: string): string {
  if (error instanceof ErrorDeRed) return '';
  return error instanceof Error ? error.message : respaldo;
}
