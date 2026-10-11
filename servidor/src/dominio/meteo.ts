// El tiempo de Malabo para la franja de la app (migración 091).
//
// POR QUÉ EL DATO LO TRAE EL MÓVIL Y NO EL SERVIDOR. La idea primera era que el
// servidor leyera Open-Meteo y lo cacheara. En producción no funciona: Open-
// Meteo limita por IP y la IP de salida de Render es compartida y está siempre
// pasada de cupo —responde 429— aunque nuestro uso sea mínimo. El teléfono, en
// cambio, sale por su propia IP (móvil o wifi de casa), que tiene su cupo
// entero: lee Open-Meteo sin problema. Así que el móvil trae el dato crudo y lo
// reporta aquí; el servidor sigue siendo el que manda —calcula el cielo y el
// aviso con sus umbrales, cachea para todos y dispara el push—, pero no
// depende de una salida a Internet que no tiene.
//
// La caché la comparten todos: el primer móvil que la encuentra vieja lee Open-
// Meteo y la refresca; los demás reciben lo ya masticado. Vive en memoria y es
// efímera, no hay fila que guardar.

import type pg from 'pg';
import { leerParametroEntero } from './parametros.js';
import { enviarATodos } from './notificaciones.js';

// Cuánto se considera «fresco» un dato. El tiempo no cambia de minuto a minuto;
// 10 min mantiene las lecturas de Open-Meteo en unas pocas por hora entre todos
// los móviles, pase lo que pase con el tráfico.
const CACHE_MS = 10 * 60 * 1000;

export type Cielo = 'sol' | 'nubes' | 'lluvia' | 'tormenta';
export type AvisoTiempo = 'calor' | 'lluvia' | null;

export interface Tiempo {
  tempC: number;
  sensacionC: number;
  cielo: Cielo;
  aviso: AvisoTiempo;
  // Epoch ms en que se registró este dato. Sirve para saber si sigue fresco.
  actualizado: number;
}

// Lo que el móvil reporta tal cual lo da Open-Meteo. El servidor no se fía a
// ciegas: lo acota a rangos sensatos antes de usarlo (ver registrarTiempo).
export interface TiempoReportado {
  tempC: number;
  sensacionC: number;
  weatherCode: number;
  probLluvia: number;
}

// Códigos WMO de Open-Meteo agrupados en los cuatro dibujos que enseña la app.
// https://open-meteo.com/en/docs — 0 despejado … 99 tormenta con granizo.
export function cieloDesdeCodigo(codigo: number): Cielo {
  if (codigo >= 95) return 'tormenta';
  // 51–67 llovizna/lluvia, 80–82 chubascos, 61–65 lluvia. 71+ es nieve, que
  // en Bioko no ocurre; si llegara, «lluvia» es lo más honesto que mostrar.
  if (codigo >= 51) return 'lluvia';
  // 1–3 algo de nubes, 45/48 niebla.
  if (codigo >= 1) return 'nubes';
  return 'sol';
}

// Decide el aviso a partir del cielo, la sensación térmica, la probabilidad de
// lluvia y los dos umbrales. Pura y sin base de datos a propósito: es la regla
// del negocio y se prueba sin red ni Postgres.
export function decidirAviso(
  cielo: Cielo,
  sensacionC: number,
  probLluvia: number,
  umbralCalor: number,
  umbralLluvia: number,
): AvisoTiempo {
  // La lluvia manda sobre el calor: si va a llover, eso es lo accionable.
  if (cielo === 'tormenta' || cielo === 'lluvia' || probLluvia >= umbralLluvia) {
    return 'lluvia';
  }
  if (sensacionC >= umbralCalor) return 'calor';
  return null;
}

// Acota un número a un rango sensato; si no es un número, cae al valor por
// defecto. El dato viene de un cliente y no se usa crudo: así un móvil que
// mande basura (o malicia) no puede inventar un calor de 300° ni un aviso falso
// fuera de lo físicamente posible en Bioko.
function acotar(valor: unknown, min: number, max: number, pordefecto: number): number {
  const n = typeof valor === 'number' && Number.isFinite(valor) ? valor : pordefecto;
  return Math.min(max, Math.max(min, n));
}

// El tiempo cacheado (último reportado por algún móvil) y si sigue fresco.
let cache: Tiempo | null = null;

export function tiempoCacheado(): { tiempo: Tiempo | null; fresco: boolean } {
  const fresco = cache !== null && Date.now() - cache.actualizado < CACHE_MS;
  return { tiempo: cache, fresco };
}

// Calcula el aviso con los umbrales vivos de la tabla parametro.
async function conAviso(
  pool: pg.Pool,
  base: Omit<Tiempo, 'aviso'>,
  probLluvia: number,
): Promise<Tiempo> {
  const umbralCalor = await leerParametroEntero(pool, 'tiempo_aviso_calor_c');
  const umbralLluvia = await leerParametroEntero(pool, 'tiempo_aviso_lluvia_pct');
  const aviso = decidirAviso(base.cielo, base.sensacionC, probLluvia, umbralCalor, umbralLluvia);
  return { ...base, aviso };
}

// Registra lo que un móvil leyó de Open-Meteo: lo acota, calcula cielo y aviso,
// lo cachea para todos y, si el aviso acaba de aparecer o cambiar, dispara el
// push. Devuelve el tiempo ya masticado para pintar la franja de ese móvil.
export async function registrarTiempo(pool: pg.Pool, reportado: TiempoReportado): Promise<Tiempo> {
  const tempC = Math.round(acotar(reportado.tempC, -20, 60, 0));
  const sensacionC = Math.round(acotar(reportado.sensacionC, -20, 70, tempC));
  const weatherCode = Math.round(acotar(reportado.weatherCode, 0, 99, 0));
  const probLluvia = acotar(reportado.probLluvia, 0, 100, 0);
  const base: Omit<Tiempo, 'aviso'> = {
    tempC,
    sensacionC,
    cielo: cieloDesdeCodigo(weatherCode),
    actualizado: Date.now(),
  };
  cache = await conAviso(pool, base, probLluvia);
  // Con el dato recién fresco, mira si toca avisar. El flanco y el dedup de
  // abajo evitan que varios móviles reportando a la vez disparen varios push.
  await avisarSiCambiaElTiempo(pool);
  return cache;
}

// --- Aviso push del tiempo (migración 091) ---------------------------------
//
// Cuando el tiempo CAMBIA a calor o lluvia, se avisa una vez a todos los
// móviles con buzón de push, estén o no con la aplicación abierta. El disparo
// es por FLANCO: no se repite mientras el aviso sigue siendo el mismo, para no
// convertir una tarde de lluvia en veinte notificaciones. Si el aviso cambia
// de tipo (de calor a lluvia) o vuelve tras despejar, se avisa de nuevo. Y si
// un mismo aviso se mantiene muchas horas, se recuerda una sola vez pasado el
// plazo largo, para que una tormenta de todo el día no quede en silencio.
//
// El estado vive en memoria: tras un reinicio (un despliegue) puede repetirse
// un aviso que estuviera activo, que es un coste de una notificación y no se
// persiste para no añadir una tabla por algo tan menor.
const RE_AVISO_MS = 6 * 60 * 60 * 1000;
let avisoActivo: { tipo: 'calor' | 'lluvia'; desde: number } | null = null;

// El texto del push, en español como el resto de avisos del servidor (es la
// lengua de Malabo y la notificación la pinta el service worker, que no sabe
// de idiomas). Corto y accionable, sin datos de nadie.
function textoDelAviso(tipo: 'calor' | 'lluvia', tempC: number): { titulo: string; cuerpo: string } {
  if (tipo === 'calor') {
    return { titulo: `Mucho calor en Malabo · ${tempC}°`, cuerpo: 'Bebe agua y evita el sol del mediodía.' };
  }
  return { titulo: 'Lluvia en camino en Malabo', cuerpo: 'Lleva paraguas: buen momento para pedir taxi.' };
}

// Mira el tiempo cacheado y, si el aviso acaba de aparecer o cambiar, manda el
// push. La llaman tanto registrarTiempo (dato recién llegado) como el
// planificador cada pocos minutos. Nunca lanza hacia fuera.
export async function avisarSiCambiaElTiempo(pool: pg.Pool): Promise<void> {
  try {
    const { tiempo, fresco } = tiempoCacheado();
    // Sin dato, o con uno viejo (hace rato que nadie abre la app), no se avisa:
    // mejor callar que avisar de un tiempo de hace una hora.
    if (!tiempo || !fresco) return;

    if (tiempo.aviso === null) {
      // Despejó: se olvida el activo para que la próxima vez que vuelva a saltar
      // se avise de nuevo.
      avisoActivo = null;
      return;
    }

    const ahora = Date.now();
    const mismoYReciente = avisoActivo
      && avisoActivo.tipo === tiempo.aviso
      && ahora - avisoActivo.desde < RE_AVISO_MS;
    if (mismoYReciente) return;

    const { titulo, cuerpo } = textoDelAviso(tiempo.aviso, tiempo.tempC);
    const resultado = await enviarATodos(pool, {
      tipo: 'tiempo',
      solicitudId: null,
      titulo,
      cuerpo,
      // El tiempo es informativo, no una carrera que caduca: la notificación no
      // tiene por qué quedarse fija hasta que se toque.
      persistente: false,
    }, 15 * 60);
    avisoActivo = { tipo: tiempo.aviso, desde: ahora };
    if (resultado.entregados > 0 || resultado.caducados > 0) {
      console.log(
        `Tiempo: aviso de ${tiempo.aviso} enviado a ${resultado.entregados} buzones `
        + `(${resultado.caducados} caducados).`,
      );
    }
  } catch (error) {
    console.error('No se pudo avisar del tiempo:', error);
  }
}
