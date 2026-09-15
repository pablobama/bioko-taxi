// Seguir usando la aplicación sin red, y sincronizar al volver (migración 057).
//
// En Malabo la cobertura va y viene, y donde más falta —el portal de una casa,
// un parking, la subida a Basilé— es justo donde se recoge y se deja al
// pasajero. Hasta ahora, sin red, pulsar «pasajero recogido» daba error y no se
// guardaba en ningún sitio: el viaje se quedaba abierto y la hora, perdida. Y
// abrir la aplicación sin red en mitad de un viaje BORRABA el viaje del
// pasajero, con su PIN, justo cuando lo necesitaba para subir.
//
// Dos piezas:
//
// 1. LA BANDEJA DE SALIDA. Una acción que no llega al servidor por falta de red
//    se guarda aquí con la hora en que se pulsó, y se manda sola en cuanto hay
//    conexión, en el mismo orden. El servidor acepta esa hora y trata cada
//    acción como repetible, así que reenviar lo que ya llegó no rompe nada.
//
// 2. EL ÚLTIMO ESTADO CONOCIDO. Se guarda cada vez que llega uno bueno, y sin
//    red se enseña ESE, con su hora. El service worker nunca cachea la API, y
//    con razón: enseñar un viaje viejo como si fuera de ahora es peor que no
//    enseñar nada. Pero enseñarlo diciendo «datos de las 10:32» no es mentir,
//    es lo único útil que se puede hacer sin cobertura.
//
// Lo que NO pasa por la bandeja, a propósito: pedir un taxi, aceptar una
// carrera y cancelar. Valen AHORA; hechas veinte minutos tarde mandarían un
// taxi a quien ya se fue o le quitarían una carrera a otro taxista.

import { useEffect, useState } from 'react';

const BASE = 'taxi-bandeja';
const ALMACEN = 'acciones';

export interface AccionPendiente {
  id?: number;
  ruta: string;
  cuerpo: Record<string, unknown>;
  // Cuándo se pulsó: viaja al servidor como `ocurridoEn`.
  pulsadaEn: string;
  // Para decírselo al usuario si el servidor la rechaza: «Viaje terminado».
  descripcion: string;
}

let base: Promise<IDBDatabase> | null = null;

function abrir(): Promise<IDBDatabase> {
  if (base !== null) return base;
  base = new Promise((resolver, rechazar) => {
    const peticion = indexedDB.open(BASE, 1);
    peticion.onupgradeneeded = () => {
      peticion.result.createObjectStore(ALMACEN, { keyPath: 'id', autoIncrement: true });
    };
    peticion.onsuccess = () => resolver(peticion.result);
    peticion.onerror = () => rechazar(peticion.error);
  });
  base.catch(() => { base = null; });
  return base;
}

function operar<T>(modo: IDBTransactionMode, trabajo: (a: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return abrir().then((db) => new Promise<T>((resolver, rechazar) => {
    const peticion = trabajo(db.transaction(ALMACEN, modo).objectStore(ALMACEN));
    peticion.onsuccess = () => resolver(peticion.result);
    peticion.onerror = () => rechazar(peticion.error);
  }));
}

// --- Cuántas hay, para enseñarlo -------------------------------------------

const suscriptores = new Set<(n: number) => void>();
let ultimaCuenta = 0;

async function anunciarCuenta(): Promise<void> {
  try {
    ultimaCuenta = await operar<number>('readonly', (a) => a.count());
  } catch {
    ultimaCuenta = 0;
  }
  for (const avisar of suscriptores) avisar(ultimaCuenta);
}

export function usePendientes(): number {
  const [n, setN] = useState(ultimaCuenta);
  useEffect(() => {
    suscriptores.add(setN);
    void anunciarCuenta();
    return () => { suscriptores.delete(setN); };
  }, []);
  return n;
}

export async function encolar(accion: Omit<AccionPendiente, 'id' | 'pulsadaEn'>): Promise<void> {
  await operar('readwrite', (a) => a.add({
    ...accion, pulsadaEn: new Date().toISOString(),
  }) as IDBRequest<IDBValidKey>);
  await anunciarCuenta();
}

// --- Sincronizar ------------------------------------------------------------

export interface ResultadoSincronizacion {
  enviadas: number;
  // Las que el servidor rechazó y ya no tienen arreglo —el pasajero canceló
  // mientras tanto—, con su mensaje para enseñarlo. Se quitan de la bandeja:
  // reintentarlas para siempre no las haría válidas.
  rechazadas: Array<{ descripcion: string; motivo: string }>;
  // Si quedan porque se volvió a ir la red a mitad.
  quedan: number;
}

let enCurso: Promise<ResultadoSincronizacion> | null = null;

// El corazón de la sincronización, sin IndexedDB para poder probarlo: recorre
// lo pendiente EN ORDEN y dice qué borrar.
//
// Tres salidas por acción:
//   - Llega bien: se borra.
//   - El servidor la rechaza con un 4xx: ya no tiene arreglo (el pasajero
//     canceló mientras tanto). Se borra y se cuenta, para decirlo.
//   - No llega, o el servidor falla (5xx): SE PARA AHÍ. No se salta a la
//     siguiente, porque la siguiente podría ser «viaje terminado» y esta
//     «pasajero recogido»: mandarlas desordenadas sería contar un viaje que
//     termina antes de empezar. Lo que queda sale en el próximo intento.
export async function procesarBandeja(
  pendientes: AccionPendiente[],
  enviar: (ruta: string, cuerpo: Record<string, unknown>) => Promise<unknown>,
  esErrorDeRed: (error: unknown) => boolean,
): Promise<{ borrar: number[]; resultado: ResultadoSincronizacion }> {
  const resultado: ResultadoSincronizacion = { enviadas: 0, rechazadas: [], quedan: 0 };
  const borrar: number[] = [];
  for (let i = 0; i < pendientes.length; i += 1) {
    const accion = pendientes[i];
    try {
      await enviar(accion.ruta, { ...accion.cuerpo, ocurridoEn: accion.pulsadaEn });
      resultado.enviadas += 1;
    } catch (error) {
      const estado = (error as { estado?: number }).estado ?? 0;
      if (esErrorDeRed(error) || estado >= 500 || estado === 0) {
        resultado.quedan = pendientes.length - i;
        break;
      }
      resultado.rechazadas.push({
        descripcion: accion.descripcion,
        motivo: error instanceof Error ? error.message : String(error),
      });
    }
    if (accion.id !== undefined) borrar.push(accion.id);
  }
  return { borrar, resultado };
}

// Manda lo pendiente. Una sola sincronización a la vez: dos latidos seguidos
// no pueden mandar la misma acción dos veces en paralelo.
export function sincronizar(
  enviar: (ruta: string, cuerpo: Record<string, unknown>) => Promise<unknown>,
  esErrorDeRed: (error: unknown) => boolean,
): Promise<ResultadoSincronizacion> {
  if (enCurso !== null) return enCurso;
  enCurso = (async () => {
    let pendientes: AccionPendiente[];
    try {
      pendientes = await operar<AccionPendiente[]>('readonly', (a) => a.getAll() as IDBRequest<AccionPendiente[]>);
    } catch {
      return { enviadas: 0, rechazadas: [], quedan: 0 };
    }
    if (pendientes.length === 0) return { enviadas: 0, rechazadas: [], quedan: 0 };
    const { borrar, resultado } = await procesarBandeja(pendientes, enviar, esErrorDeRed);
    for (const id of borrar) {
      try {
        await operar('readwrite', (a) => a.delete(id) as IDBRequest<undefined>);
      } catch {
        // Si no se puede borrar se reenviará, y el servidor la dará por hecha.
      }
    }
    await anunciarCuenta();
    return resultado;
  })().finally(() => { enCurso = null; });
  return enCurso;
}

// --- Último estado conocido -------------------------------------------------

export interface Guardado<T> {
  valor: T;
  guardadoEn: string;
}

// localStorage y no IndexedDB: es un objeto pequeño, se lee al abrir la
// aplicación —cuando todavía no hay nada en pantalla— y así se lee sin esperar.
export function guardarUltimo<T>(clave: string, valor: T): void {
  try {
    localStorage.setItem(`ultimo:${clave}`, JSON.stringify({ valor, guardadoEn: new Date().toISOString() }));
  } catch {
    // Sin sitio o en modo privado: sin red no habrá nada que enseñar, como antes.
  }
}

export function ultimoGuardado<T>(clave: string): Guardado<T> | null {
  try {
    const crudo = localStorage.getItem(`ultimo:${clave}`);
    return crudo === null ? null : JSON.parse(crudo) as Guardado<T>;
  } catch {
    return null;
  }
}

export function olvidarUltimo(clave: string): void {
  try {
    localStorage.removeItem(`ultimo:${clave}`);
  } catch {
    // Nada.
  }
}

// «10:32»: la hora de un dato guardado, para enseñarlo al lado.
export function horaCorta(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
