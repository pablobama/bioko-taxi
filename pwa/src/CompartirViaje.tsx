// «Mírame llegar» (migración 043), la mitad del pasajero.
//
// Mientras va en el taxi, el pasajero abre un enlace y se lo manda a quien
// quiera. Y ve quién lo está mirando: si aparece un número que no reconoce,
// su enlace anda donde no debería, y desde aquí mismo lo corta.

import { useEffect, useState } from 'react';
import { api, type EstadoSeguimiento } from './api';
import type { T } from './i18n';

// El enlace que se manda por WhatsApp. Se construye con el origen actual para
// que en desarrollo apunte a localhost y en producción al dominio de verdad,
// sin una constante que se quede vieja.
const enlaceDe = (token: string) =>
  `${window.location.origin}/?seguir=${encodeURIComponent(token)}`;

export default function CompartirViaje({ solicitudId, t }: { solicitudId: number; t: T }) {
  const [estado, setEstado] = useState<EstadoSeguimiento | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  const [copiado, setCopiado] = useState(false);
  const [error, setError] = useState('');
  // Que el número no esté verificado no es un error de red ni algo que el
  // pasajero haya hecho mal: es un requisito, y se cuenta como tal. Se
  // descubre al intentar compartir, no antes, para no tener que arrastrar el
  // estado de la sesión hasta aquí solo para esconder un botón.
  const [faltaVerificar, setFaltaVerificar] = useState(false);

  // Cada quince segundos, solo para saber quién está mirando. No es el mapa:
  // eso lo lleva el SSE del viaje. Aquí basta con enterarse en un rato.
  useEffect(() => {
    let vivo = true;
    const mirar = () => {
      api.estadoSeguimiento(solicitudId)
        .then((e) => { if (vivo) setEstado(e); })
        .catch(() => undefined);
    };
    mirar();
    const reloj = setInterval(mirar, 15_000);
    return () => { vivo = false; clearInterval(reloj); };
  }, [solicitudId]);

  async function compartir() {
    setOcupado(true);
    setError('');
    try {
      const { token: nuevo } = await api.compartirViaje(solicitudId);
      setToken(nuevo);
      setEstado((e) => (e ? { ...e, activo: true } : e));
      // El menú del sistema es lo que lleva el enlace a WhatsApp de un toque,
      // que es por donde va a viajar de verdad. Si el navegador no lo tiene
      // (o lo cancela), queda el botón de copiar.
      const enlace = enlaceDe(nuevo);
      if (navigator.share) {
        try {
          await navigator.share({ text: `${t('seguir.explicacion')} ${enlace}` });
        } catch {
          // Cancelar el menú de compartir no es un error.
        }
      }
    } catch (e) {
      const mensaje = e instanceof Error ? e.message : String(e);
      if (/[Vv]erifica tu teléfono/.test(mensaje)) setFaltaVerificar(true);
      else setError(mensaje);
    } finally {
      setOcupado(false);
    }
  }

  async function copiar() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(enlaceDe(token));
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2500);
    } catch {
      setError(enlaceDe(token));
    }
  }

  async function cortar() {
    setOcupado(true);
    try {
      await api.cortarSeguimiento(solicitudId);
      setToken(null);
      setEstado({ activo: false, expiraEn: null, visitas: [] });
    } finally {
      setOcupado(false);
    }
  }

  const activo = estado?.activo ?? false;

  return (
    <div className="compartir-viaje">
      {error && <p className="aviso">{error}</p>}
      {faltaVerificar && <p className="aviso">{t('seguir.necesitaVerificar')}</p>}

      {!activo && (
        <>
          <button type="button" className="secundario" disabled={ocupado} onClick={compartir}>
            {t('seguir.compartir')}
          </button>
          <p className="nota">{t('seguir.explicacion')} {t('seguir.soloVerificados')}</p>
        </>
      )}

      {activo && (
        <>
          <p className="nota"><strong>{t('seguir.compartiendo')}</strong></p>
          {/* El botón de copiar solo aparece si este teléfono es el que abrió
              el enlace: el token está hasheado en el servidor y no se puede
              recuperar, así que tras recargar la página ya no se tiene. */}
          {token && (
            <button type="button" className="secundario" onClick={copiar}>
              {copiado ? t('seguir.copiado') : t('seguir.copiar')}
            </button>
          )}
          {(estado?.visitas.length ?? 0) === 0 ? (
            <p className="nota">{t('seguir.nadieMira')}</p>
          ) : (
            <>
              <p className="nota">{t('seguir.mirando')}</p>
              <ul className="ruta">
                {estado?.visitas.map((v) => <li key={v.telefono}>{v.telefono}</li>)}
              </ul>
            </>
          )}
          <button type="button" className="tenue" disabled={ocupado} onClick={cortar}>
            {t('seguir.cortar')}
          </button>
        </>
      )}
    </div>
  );
}
