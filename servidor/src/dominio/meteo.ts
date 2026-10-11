// El tiempo de Malabo para la franja de la app (migración 091). Lo trae de
// Open-Meteo —gratis, sin clave, sin registro— y lo cachea en memoria unos
// minutos: así una sola llamada sirve a todos los móviles, el payload que baja
// es diminuto (importa con red cara) y si Open-Meteo falla se sigue sirviendo
// el último valor bueno en vez de romper la pantalla.

import type pg from 'pg';
import { leerParametroEntero } from './parametros.js';
import { enviarATodos } from './notificaciones.js';

// Malabo ciudad. El tiempo de la isla entera es a efectos prácticos el mismo;
// un solo punto basta y evita multiplicar llamadas.
const LAT = 3.75;
const LON = 8.78;

// Cuánto vive un valor cacheado. El tiempo no cambia de minuto a minuto y
// Open-Meteo refresca cada hora; 10 min es de sobra y mantiene las llamadas
// en unas pocas por hora pase lo que pase con el tráfico.
const CACHE_MS = 10 * 60 * 1000;
// Si la red tarda más que esto, no bloqueamos: se sirve lo último que hubiera.
// 8s, no 4: en un arranque en frío de Render el primer handshake TLS saliente
// puede ir lento, y cortar demasiado pronto dejaba la franja vacía.
const TIMEOUT_MS = 8000;

export type Cielo = 'sol' | 'nubes' | 'lluvia' | 'tormenta';
export type AvisoTiempo = 'calor' | 'lluvia' | null;

export interface Tiempo {
  tempC: number;
  sensacionC: number;
  cielo: Cielo;
  aviso: AvisoTiempo;
  // Epoch ms en que el servidor obtuvo este dato. El cliente no lo necesita
  // para nada crítico; va por transparencia y para depurar.
  actualizado: number;
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

// Valor en caché y, cuando hay una petición en vuelo, su promesa: así dos
// peticiones casi simultáneas con la caché vencida comparten una sola llamada.
let cache: Tiempo | null = null;
let enVuelo: Promise<Tiempo | null> | null = null;

// El último error al leer el tiempo, para diagnóstico (ver /api/tiempo?debug).
// No se enseña nunca al usuario; solo lo consulta quien depura producción.
let ultimoError: string | null = null;
export function ultimoErrorTiempo(): string | null { return ultimoError; }

// El tiempo actual más la probabilidad de lluvia de la hora en curso. Esa
// probabilidad decide el aviso de lluvia aunque ahora mismo no esté cayendo.
interface Crudo {
  base: Omit<Tiempo, 'aviso'>;
  probLluvia: number;
}

async function pedirAOpenMeteo(): Promise<Crudo> {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', String(LAT));
  url.searchParams.set('longitude', String(LON));
  url.searchParams.set('current', 'temperature_2m,apparent_temperature,weather_code');
  url.searchParams.set('hourly', 'precipitation_probability');
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('timezone', 'Africa/Malabo');

  const respuesta = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!respuesta.ok) {
    throw new Error(`Open-Meteo respondió ${respuesta.status}`);
  }
  const datos = await respuesta.json() as {
    current?: {
      time?: string;
      temperature_2m?: number;
      apparent_temperature?: number;
      weather_code?: number;
    };
    hourly?: {
      time?: string[];
      precipitation_probability?: Array<number | null>;
    };
  };
  const actual = datos.current;
  if (!actual || typeof actual.temperature_2m !== 'number') {
    throw new Error('Open-Meteo devolvió una respuesta sin tiempo actual.');
  }
  return {
    base: {
      tempC: Math.round(actual.temperature_2m),
      sensacionC: Math.round(actual.apparent_temperature ?? actual.temperature_2m),
      cielo: cieloDesdeCodigo(actual.weather_code ?? 0),
      actualizado: Date.now(),
    },
    probLluvia: probabilidadDeLaHora(datos.hourly, actual.time),
  };
}

// Casa la hora del dato «actual» (p. ej. «2026-10-11T14:00») con la serie
// horaria y devuelve su probabilidad de lluvia. Si no cuadra nada, 0: un dato
// que falta nunca debe inventar un aviso.
function probabilidadDeLaHora(
  hourly: { time?: string[]; precipitation_probability?: Array<number | null> } | undefined,
  horaActual: string | undefined,
): number {
  if (!hourly?.time || !hourly.precipitation_probability || !horaActual) return 0;
  // La hora «actual» trae minutos (…T14:30); la serie horaria va en punto
  // (…T14:00). Comparamos solo hasta la hora.
  const clave = horaActual.slice(0, 13);
  const i = hourly.time.findIndex((t) => t.slice(0, 13) === clave);
  const prob = i >= 0 ? hourly.precipitation_probability[i] : null;
  return typeof prob === 'number' ? prob : 0;
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

// Pega la decisión de aviso a los umbrales vivos de la tabla parametro. Se
// separa del fetch para poder recalcular si cambian los umbrales sin re-pedir.
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

// Punto de entrada. Devuelve el tiempo cacheado si sigue fresco; si no, lo
// renueva. Nunca lanza hacia fuera: ante un fallo sirve lo último (o null la
// primera vez), porque una franja del tiempo jamás debe tumbar la app.
export async function tiempoDeMalabo(pool: pg.Pool): Promise<Tiempo | null> {
  const fresco = cache && Date.now() - cache.actualizado < CACHE_MS;
  if (fresco) return cache;
  if (!enVuelo) {
    enVuelo = (async () => {
      try {
        // Un reintento: un corte puntual de red saliente no debe dejar la
        // franja vacía diez minutos hasta el siguiente ciclo.
        let crudo;
        try {
          crudo = await pedirAOpenMeteo();
        } catch (primerFallo) {
          console.warn('Tiempo: primer intento falló, reintentando:', primerFallo);
          crudo = await pedirAOpenMeteo();
        }
        cache = await conAviso(pool, crudo.base, crudo.probLluvia);
        ultimoError = null;
        return cache;
      } catch (error) {
        const nombre = error instanceof Error ? error.name : 'Error';
        const mensaje = error instanceof Error ? error.message : String(error);
        const causa = (error as { cause?: { code?: string; message?: string } }).cause;
        ultimoError = [nombre, mensaje, causa?.code, causa?.message].filter(Boolean).join(' · ');
        console.error('No se pudo leer el tiempo de Malabo:', error);
        return cache; // el último bueno, o null si nunca hubo
      } finally {
        enVuelo = null;
      }
    })();
  }
  return enVuelo;
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

// Mira el tiempo y, si el aviso acaba de aparecer o cambiar, manda el push.
// Pensada para el planificador (cada pocos minutos); nunca lanza hacia fuera.
export async function avisarSiCambiaElTiempo(pool: pg.Pool): Promise<void> {
  try {
    const tiempo = await tiempoDeMalabo(pool);
    if (!tiempo) return;

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
