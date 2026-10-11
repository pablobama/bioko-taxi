// La franja del tiempo de Malabo en lo alto de la app (migración 091). La ven
// el pasajero y el taxista. Se pide el dato ella sola y lo refresca cada pocos
// minutos; así App no tiene que enhebrar estado ni relojes por ella. Si no hay
// dato (Open-Meteo caído al arrancar) no pinta nada: una franja del tiempo no
// debe ocupar sitio cuando no tiene nada que decir.

import { useEffect, useState } from 'react';
import { api, leerTiempoDeMalabo, type CieloTiempo, type Tiempo } from './api';
import type { T } from './i18n';

// Cada diez minutos de sobra: el tiempo no cambia más deprisa y la caché del
// servidor dura lo mismo. El primer tiro es inmediato al montar.
const REFRESCO_MS = 10 * 60 * 1000;

// Si se ha ocultado la franja, es una preferencia de este móvil: se guarda
// aquí y no viaja al servidor. En modo privado no se recuerda entre sesiones,
// pero dentro de esta sí (el estado de React manda).
const CLAVE_COLAPSADO = 'tiempo-colapsado';
function leerColapsado(): boolean {
  try { return localStorage.getItem(CLAVE_COLAPSADO) === 'si'; } catch { return false; }
}
function guardarColapsado(valor: boolean): void {
  try { localStorage.setItem(CLAVE_COLAPSADO, valor ? 'si' : 'no'); } catch { /* da igual */ }
}

// El dibujo de cada cielo. Emojis y no SVG a propósito: pesan cero, se ven en
// cualquier Android viejo y el sistema ya los dibuja a todo color.
const DIBUJO: Record<CieloTiempo, string> = {
  despejado: '☀️',
  poco_nuboso: '🌤️',
  sol_nubes: '⛅',
  nublado: '☁️',
  niebla: '🌫️',
  chubascos: '🌦️',
  lluvia: '🌧️',
  tormenta: '⛈️',
};

// `variante`: «flotante» es el chip fijo que flota sobre el plano en pasajero y
// taxista; «linea» es el mismo contenido en línea, para meterlo en la cabecera
// del panel del operador sin tapar el título ni las pestañas.
export default function FranjaTiempo({ t, variante = 'flotante' }: {
  t: T;
  variante?: 'flotante' | 'linea';
}) {
  const [tiempo, setTiempo] = useState<Tiempo | null>(null);
  // Plegada = solo el icono; un toque la oculta a lo mínimo, otro la despliega.
  const [colapsado, setColapsado] = useState<boolean>(leerColapsado);

  useEffect(() => {
    let vivo = true;
    async function cargar() {
      try {
        // 1) ¿Tiene el servidor un dato fresco (de otro móvil hace poco)? Si sí,
        //    se usa y este móvil no molesta a Open-Meteo.
        const { tiempo: dato, fresco } = await api.tiempo();
        if (vivo && dato && fresco) { setTiempo(dato); return; }
        // 2) Si no, este móvil lee Open-Meteo (su IP sí tiene cupo) y lo reporta;
        //    el servidor devuelve el cielo y el aviso ya calculados.
        try {
          const reportado = await leerTiempoDeMalabo();
          const { tiempo: masticado } = await api.reportarTiempo(reportado);
          if (vivo && masticado) setTiempo(masticado);
        } catch {
          // Open-Meteo no respondió: al menos se enseña lo que el servidor tenga
          // (aunque sea de hace un rato), mejor que nada.
          if (vivo && dato) setTiempo(dato);
        }
      } catch {
        // Silencio: la franja es un adorno útil, nunca un error que mostrar.
      }
    }
    void cargar();
    const reloj = setInterval(cargar, REFRESCO_MS);
    return () => { vivo = false; clearInterval(reloj); };
  }, []);

  if (!tiempo) return null;

  const nombreCielo = t(`tiempo.${tiempo.cielo}`);
  // El aviso va en dos líneas: el qué arriba, el consejo debajo. Así la franja
  // es más estrecha y cabe mejor en el centro de la zona superior.
  const aviso = tiempo.aviso === 'calor'
    ? { titulo: t('tiempo.avisoCalorTitulo'), nota: t('tiempo.avisoCalorNota') }
    : tiempo.aviso === 'lluvia'
      ? { titulo: t('tiempo.avisoLluviaTitulo'), nota: t('tiempo.avisoLluviaNota') }
      : null;

  function alternar() {
    setColapsado((antes) => { const ahora = !antes; guardarColapsado(ahora); return ahora; });
  }

  // El degradado, el realce y la animación los decide el CSS por estos
  // data-atributos, no el JS: así el tema vive entero en la hoja de estilos.
  // Es un botón: un toque la oculta a solo el icono, otro la vuelve a abrir.
  const clases = ['franja-tiempo'];
  if (variante === 'linea') clases.push('franja-tiempo-linea');
  return (
    <button
      type="button"
      className={clases.join(' ')}
      data-cielo={tiempo.cielo}
      data-aviso={tiempo.aviso ?? 'no'}
      data-colapsado={colapsado ? 'si' : 'no'}
      data-guia={variante === 'flotante' ? 'tiempo' : undefined}
      onClick={alternar}
      aria-label={colapsado ? t('tiempo.mostrar') : t('tiempo.ocultar')}
      title={colapsado ? t('tiempo.mostrar') : t('tiempo.ocultar')}
    >
      <span className="franja-tiempo-icono" aria-hidden="true">{DIBUJO[tiempo.cielo]}</span>
      {!colapsado && (
        <>
          <span className="franja-tiempo-grados">{tiempo.tempC}°</span>
          {aviso ? (
            <span className="franja-tiempo-aviso">
              <strong>{aviso.titulo}</strong>
              <small>{aviso.nota}</small>
            </span>
          ) : (
            <span className="franja-tiempo-cielo">{nombreCielo}</span>
          )}
        </>
      )}
    </button>
  );
}
