// La franja del tiempo de Malabo en lo alto de la app (migración 091). La ven
// el pasajero y el taxista. Se pide el dato ella sola y lo refresca cada pocos
// minutos; así App no tiene que enhebrar estado ni relojes por ella. Si no hay
// dato (Open-Meteo caído al arrancar) no pinta nada: una franja del tiempo no
// debe ocupar sitio cuando no tiene nada que decir.

import { useEffect, useState } from 'react';
import { api, type CieloTiempo, type Tiempo } from './api';
import type { T } from './i18n';

// Cada diez minutos de sobra: el servidor cachea igual y el tiempo no cambia
// más deprisa. El primer tiro es inmediato al montar.
const REFRESCO_MS = 10 * 60 * 1000;

// El dibujo de cada cielo. Emojis y no SVG a propósito: pesan cero, se ven en
// cualquier Android viejo y el sistema ya los dibuja a todo color.
const DIBUJO: Record<CieloTiempo, string> = {
  sol: '☀️',
  nubes: '☁️',
  lluvia: '🌧️',
  tormenta: '⛈️',
};

export default function FranjaTiempo({ t }: { t: T }) {
  const [tiempo, setTiempo] = useState<Tiempo | null>(null);

  useEffect(() => {
    let vivo = true;
    async function cargar() {
      try {
        const { tiempo: dato } = await api.tiempo();
        // Un fallo no borra lo que ya se veía: si `dato` es null por una caída
        // puntual, se conserva el último bueno.
        if (vivo && dato) setTiempo(dato);
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
  const textoAviso = tiempo.aviso === 'calor'
    ? t('tiempo.avisoCalor')
    : tiempo.aviso === 'lluvia'
      ? t('tiempo.avisoLluvia')
      : null;

  // El degradado y el realce los decide el CSS por estos data-atributos, no el
  // JS: así el tema vive entero en la hoja de estilos.
  return (
    <div
      className="franja-tiempo"
      data-cielo={tiempo.cielo}
      data-aviso={tiempo.aviso ?? 'no'}
      role="status"
    >
      <span className="franja-tiempo-icono" aria-hidden="true">{DIBUJO[tiempo.cielo]}</span>
      <span className="franja-tiempo-grados">
        {tiempo.tempC}°
        <span className="franja-tiempo-cielo">{nombreCielo}</span>
      </span>
      {textoAviso && <span className="franja-tiempo-aviso">{textoAviso}</span>}
    </div>
  );
}
